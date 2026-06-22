/**
 * 【Part B】金額表記なし自社商品の実勢価格を「楽天市場 API + ローカル LLM」で
 * 推定し、推定不能 (estimated_value=null) を一部救済する (パイプライン step3.5)。
 *
 * 位置づけ:
 *   3. interpret-benefits.ts        → data/interpreted/chunk-*.jsonl
 *   3.5 ★ enrich-from-web.ts        ← 本スクリプト → data/web-enriched/web-*.jsonl
 *   4. apply-benefit-interpretations.ts (web 推定も key 結合で反映)
 *
 * 対象は「interpret が null にした & 割引/販促ポイントでない & 物販系の自社商品」
 * のみ。チケット/招待/抽選/施設利用/会員権などの非換金特典は対象外 (CLAUDE.md
 * ルール1/2: 利回り算定に不適な特典に額を付けない)。
 *
 * 処理 (1 件ずつ。楽天 API のレート ~1req/s を守るため逐次):
 *   a. ローカル LLM で「物販として価格付け可能か (priceable) + 検索クエリ +
 *      数量」を判定。priceable=false は null のまま据え置き (再クエリ防止に記録)。
 *   b. 楽天 Ichiba Item Search API でクエリ検索 → 上位商品 (名前/価格/URL)。
 *   c. ローカル LLM で「優待品に妥当に対応する商品か」を判定し、1 単位あたりの
 *      代表価格 (× 数量) を整数円で返す。妥当な対応が無ければ null。
 *   d. 決定論ガード: 推定額は実際に取得した商品価格の範囲内 (×数量) に grounding
 *      されていなければ null へ落とす (LLM の根拠なき高額を弾く)。
 *
 * ルール1: web 推定値は企業公表額と必ず区別する。出力に
 *   estimateValueSource:"web" / estimateSourceUrl を持たせ、apply が
 *   yutai_benefits.estimate_value_source / estimate_source_url に保存。UI は
 *   「WEB推定」バッジを必ず付ける。
 * ルール2: 確信が持てなければ捏造せず null。LLM 応答が schema 不一致なら retry、
 *   上限超過は throw (黙って埋めない)。
 * ルール3: RAKUTEN_APP_ID は .env のみが正。未設定は起動時に throw。
 * ルール6: バッチ確定 JSONL を Notion 一次データ DB へ実体記録。
 *
 * 冪等・再開可能: 既存 web-*.jsonl の key はスキップ (null 据え置きも記録するので
 * 再クエリしない)。途中失敗しても完了分は残り再実行で続きから。
 *
 * 実行: pnpm exec tsx services/otakara-yutai/data-scripts/enrich-from-web.ts
 *   オプション: ENRICH_LIMIT=20 で件数上限 (試走用)、ENRICH_DRY_RUN=1 で
 *   楽天 API のみ叩いて DB 反映用ファイルは書かず標準出力に出す。
 */
import "dotenv/config";
import { z } from "zod";
import {
  getLlama,
  resolveModelFile,
  LlamaChatSession,
  type Llama,
  type LlamaModel,
  type LlamaContext,
  type LlamaContextSequence,
} from "node-llama-cpp";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { benefitKey } from "./benefit-key.js";
import { recordPrimaryData } from "../../../src/shared/notion-archive/index.js";

// --- パス ---
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(SCRIPT_DIR, "data");
const SOURCE_PATH = join(DATA_DIR, "benefit-descriptions.jsonl");
const INTERPRETED_DIR = join(DATA_DIR, "interpreted");
const WEB_DIR = join(DATA_DIR, "web-enriched");
const MODELS_DIR = join(SCRIPT_DIR, "models");

// --- env アクセサ (ルール3) ---
function requiredEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.trim() === "") {
    throw new Error(
      `環境変数 ${key} が設定されていません。.env を確認してください (楽天 API の Application ID)。`
    );
  }
  return v.trim();
}

// --- パラメータ ---
const MODEL_URI =
  process.env.OTAKARA_LLM_MODEL ?? "hf:elyza/Llama-3-ELYZA-JP-8B-GGUF:Q4_K_M";
const MAX_ATTEMPTS = 4;
/** 楽天 API の最小呼び出し間隔 (ms)。公称 ~1req/s を尊重し余裕をみる。 */
const RAKUTEN_MIN_INTERVAL_MS = 1200;
/** 検索で取得する上位件数。中央値の安定と過大値除去のため 10 件。 */
const RAKUTEN_HITS = 10;
/** 試走用の件数上限 (ENRICH_LIMIT)。未指定なら全件。 */
const LIMIT = (() => {
  const raw = process.env.ENRICH_LIMIT;
  if (!raw) return Infinity;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`ENRICH_LIMIT は 1 以上の整数で指定してください: ${raw}`);
  return n;
})();
const DRY_RUN = (process.env.ENRICH_DRY_RUN ?? "") === "1";

// --- 入出力スキーマ ---
interface SourceEntry {
  key: string;
  stockCode: string;
  stockName: string;
  description: string;
  minSharesList: number[];
}

/** web-*.jsonl に永続化する 1 件 (apply が読む)。 */
interface WebEnrichEntry {
  key: string;
  /** 推定できた円 (整数)。できなければ null (再クエリ防止に null も記録)。 */
  estimatedValue: number | null;
  /** 値があるときは必ず "web"。null のときは null。 */
  estimateValueSource: "web" | null;
  /** 採用した楽天商品ページ URL (値があるとき)。 */
  estimateSourceUrl: string | null;
  /** 監査用: 採用商品名・使用クエリ・判定理由。 */
  matchedName: string | null;
  query: string | null;
  note: string;
}

// LLM 応答 1: 価格付け可能か + クエリ
const ClassifySchema = z.object({
  priceable: z
    .boolean()
    .describe("物販 (現物商品) として実勢価格を引けるなら true"),
  query: z.string().describe("楽天市場で代表商品を探す日本語検索キーワード"),
  quantity: z
    .number()
    .int()
    .min(1)
    .describe("優待で受け取る個数 (枚/個/kg数でなく『商品の個数』)"),
  reason: z.string().describe("判定理由 (短く)"),
});
type Classify = z.infer<typeof ClassifySchema>;

// LLM 応答 2: 楽天結果から代表単価を判定
const JudgeSchema = z.object({
  unitPrice: z
    .number()
    .int()
    .nullable()
    .describe("優待品 1 単位の代表価格 (円, 整数)。妥当な対応商品が無ければ null"),
  matchedIndex: z
    .number()
    .int()
    .nullable()
    .describe("採用した商品の 0 始まり index。null なら不採用"),
  reason: z.string().describe("判定理由 (短く)"),
});
type Judge = z.infer<typeof JudgeSchema>;

const CLASSIFY_SYSTEM = `あなたは日本株の株主優待を整理するアナリストです。
与えられた優待 description が「現物の商品 (食品・飲料・米・日用品・自社製品の
詰め合わせ等) で、一般的な EC で同等品の実勢価格を調べられるもの」かを判定します。

priceable=true にするもの: 米・水・飲料・菓子・食品詰め合わせ・調味料・化粧品・
日用品・自社物販の現物。
priceable=false にするもの (これらは価格を付けない):
- 割引券・優待価格・値引き (受け取る金銭ではない)
- 食事券・利用券・入場券・チケット・ご招待・抽選・くじ
- 施設利用・宿泊・プレー・体験・レッスン・見学・会員権・VIP
- 自社サービスの利用権、ポイント付与・還元
- 寄付・社会貢献

priceable=true のときだけ query を作る。query は楽天市場で代表的な同等商品が
ヒットする簡潔な日本語キーワード (商品の一般名 + 数量/規格)。固有のブランド名が
あれば含める。例: "南魚沼産コシヒカリ 5kg" / "ミネラルウォーター 2L 12本" /
"焼き菓子 詰め合わせ"。
quantity は優待で受け取る『商品の個数』(セット数・ケース数・冊数等)。単一なら 1。

JSON のみ出力。形式: {"priceable":<bool>,"query":"...","quantity":<int>,"reason":"..."}`;

const JUDGE_SYSTEM = `あなたは日本株の株主優待を整理するアナリストです。
優待品の説明と、楽天市場の検索結果 (商品名・価格) の一覧が与えられます。
優待品 1 単位に妥当に対応する商品を 1 つ選び、その代表価格 (円, 整数) を
unitPrice として返します。

ルール:
- 優待品と明らかに異なる商品 (容量違い・無関係) しか無ければ unitPrice=null。
- 単一の極端に高い/安い外れ値は採らない。中位の妥当な価格を選ぶ。
- 送料・セット販売で単価が歪むものは避ける。
- 確信が持てなければ null (捏造しない)。
- matchedIndex は採用した商品の 0 始まり index。null なら不採用。

JSON のみ出力。形式: {"unitPrice":<int or null>,"matchedIndex":<int or null>,"reason":"..."}`;

// --- 楽天 Ichiba Item Search API ---
interface RakutenItem {
  name: string;
  price: number;
  url: string;
}
const RakutenResponseSchema = z.object({
  Items: z.array(
    z.object({
      Item: z.object({
        itemName: z.string(),
        itemPrice: z.number(),
        itemUrl: z.string(),
      }),
    })
  ),
});

let lastRakutenCall = 0;
async function rakutenSearch(query: string): Promise<RakutenItem[]> {
  // レート制御: 前回呼び出しから最小間隔を空ける。
  const now = Date.now();
  const wait = lastRakutenCall + RAKUTEN_MIN_INTERVAL_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRakutenCall = Date.now();

  const url = new URL(
    "https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601"
  );
  url.searchParams.set("applicationId", requiredEnv("RAKUTEN_APP_ID"));
  url.searchParams.set("keyword", query);
  url.searchParams.set("hits", String(RAKUTEN_HITS));
  url.searchParams.set("sort", "standard");
  url.searchParams.set("formatVersion", "2");

  const res = await fetch(url, {
    headers: { "User-Agent": "kabulab-otakara-yutai/1.0" },
  });
  if (res.status === 429) {
    // レート超過。Retry-After を尊重し 1 度だけ待って再試行。
    const ra = Number(res.headers.get("retry-after") ?? "5");
    await new Promise((r) => setTimeout(r, Math.max(1, ra) * 1000));
    lastRakutenCall = Date.now();
    return rakutenSearch(query);
  }
  if (!res.ok) {
    throw new Error(`楽天 API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  // formatVersion=2 では Items は {itemName,itemPrice,itemUrl} の配列
  const json = (await res.json()) as unknown;
  const flat = z
    .object({
      Items: z.array(
        z.object({
          itemName: z.string(),
          itemPrice: z.number(),
          itemUrl: z.string(),
        })
      ),
    })
    .safeParse(json);
  if (!flat.success) {
    // formatVersion 既定 (ネスト) のケースも許容
    const nested = RakutenResponseSchema.safeParse(json);
    if (!nested.success) {
      throw new Error(
        `楽天 API 応答が想定形式でない: ${JSON.stringify(json).slice(0, 200)}`
      );
    }
    return nested.data.Items.map((i) => ({
      name: i.Item.itemName,
      price: i.Item.itemPrice,
      url: i.Item.itemUrl,
    }));
  }
  return flat.data.Items.map((i) => ({
    name: i.itemName,
    price: i.itemPrice,
    url: i.itemUrl,
  }));
}

// --- ローカル LLM ---
interface LlmHandle {
  llama: Llama;
  model: LlamaModel;
  context: LlamaContext;
  sequence: LlamaContextSequence;
}
async function initLlm(): Promise<LlmHandle> {
  if (!existsSync(MODELS_DIR)) mkdirSync(MODELS_DIR, { recursive: true });
  const llama = await getLlama();
  const modelPath = await resolveModelFile(MODEL_URI, MODELS_DIR);
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext({
    contextSize: { max: 8192 },
    sequences: 1,
  });
  return { llama, model, context, sequence: context.getSequence() };
}

/** 1 プロンプトを実行し JSON を抽出して zod 検証。失敗は retry、上限超過は throw。 */
async function promptJson<T>(
  llm: LlmHandle,
  system: string,
  user: string,
  schema: z.ZodType<T>
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await llm.sequence.clearHistory();
    const session = new LlamaChatSession({
      contextSequence: llm.sequence,
      systemPrompt: system,
    });
    try {
      const opts =
        attempt === 1 ? {} : { temperature: 0.3, topP: 0.9, seed: attempt };
      const raw = await session.prompt(user, opts);
      const first = raw.indexOf("{");
      const last = raw.lastIndexOf("}");
      if (first === -1 || last <= first)
        throw new Error(`JSON が見つからない: ${raw.slice(0, 120)}`);
      const obj = JSON.parse(raw.slice(first, last + 1));
      const parsed = schema.safeParse(obj);
      if (!parsed.success)
        throw new Error(`schema 不一致: ${parsed.error.message.slice(0, 160)}`);
      return parsed.data;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS)
        await new Promise((r) => setTimeout(r, 500 * attempt));
    } finally {
      session.dispose();
    }
  }
  throw new Error(`LLM 応答が ${MAX_ATTEMPTS} 回失敗: ${(lastErr as Error).message}`);
}

// --- 候補抽出 (interpret が null にしたもののうち物販候補) ---
function loadSource(): Map<string, SourceEntry> {
  const map = new Map<string, SourceEntry>();
  for (const line of readFileSync(SOURCE_PATH, "utf-8").trim().split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as Omit<SourceEntry, "key">;
    const key = benefitKey(e.stockCode, e.description);
    map.set(key, { ...e, key });
  }
  return map;
}

/** interpret 出力 (chunk-*.jsonl) から key->estimatedValue を読む。 */
function loadInterpreted(): Map<string, number | null> {
  const map = new Map<string, number | null>();
  if (!existsSync(INTERPRETED_DIR)) return map;
  for (const f of readdirSync(INTERPRETED_DIR).filter(
    (f) => f.startsWith("chunk-") && f.endsWith(".jsonl")
  )) {
    for (const line of readFileSync(join(INTERPRETED_DIR, f), "utf-8")
      .trim()
      .split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line) as { key?: string; estimatedValue: number | null };
      if (typeof e.key === "string") map.set(e.key, e.estimatedValue);
    }
  }
  return map;
}

/** 既存 web-*.jsonl の key (再開用。null 据え置きも含む)。 */
function loadDoneWebKeys(): Set<string> {
  const done = new Set<string>();
  if (!existsSync(WEB_DIR)) {
    mkdirSync(WEB_DIR, { recursive: true });
    return done;
  }
  for (const f of readdirSync(WEB_DIR).filter(
    (f) => f.startsWith("web-") && f.endsWith(".jsonl")
  )) {
    for (const line of readFileSync(join(WEB_DIR, f), "utf-8").trim().split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line) as { key?: string };
      if (typeof e.key === "string") done.add(e.key);
    }
  }
  return done;
}

/** 割引/販促ポイントの決定論除外 (LLM に回す前に明確なものを落とす)。 */
function isClearlyNonProduct(desc: string): boolean {
  return /割引|値引|優待価格|[%％]\s*(?:off|オフ)?|\boff\b|ポイント.{0,8}(還元|付与|倍)/i.test(
    desc
  );
}

/**
 * 決定論ガード: LLM の unitPrice を、実際に取得した商品価格 (×quantity) の
 * 妥当域に grounding する。範囲外なら null (根拠なき値を採らない)。
 */
function groundPrice(
  unitPrice: number | null,
  quantity: number,
  items: RakutenItem[]
): number | null {
  if (unitPrice === null) return null;
  if (unitPrice <= 0) return null;
  const prices = items.map((i) => i.price).filter((p) => p > 0).sort((a, b) => a - b);
  if (prices.length === 0) return null;
  const lo = prices[0];
  const hi = prices[prices.length - 1];
  // unitPrice は「優待品 1 単位 × quantity」想定。1 単位価格を商品価格域と照合。
  const perUnit = quantity > 0 ? unitPrice / quantity : unitPrice;
  // 商品価格域の [0.5倍, 1.5倍] に 1 単位価格が収まることを要求 (外れ値除去)。
  if (perUnit < lo * 0.5 || perUnit > hi * 1.5) return null;
  return Math.round(unitPrice);
}

async function main(): Promise<void> {
  // 起動時に鍵の存在を確認 (ルール3: 未設定なら即 throw)
  requiredEnv("RAKUTEN_APP_ID");

  const source = loadSource();
  const interpreted = loadInterpreted();
  const doneWeb = loadDoneWebKeys();

  // 候補: interpret が null & 既に web 処理済みでない & 決定論的に非物販でない
  const candidates: SourceEntry[] = [];
  for (const [key, entry] of source) {
    if (doneWeb.has(key)) continue;
    const v = interpreted.get(key);
    if (v !== null && v !== undefined) continue; // 既に額がある
    if (!interpreted.has(key)) continue; // interpret 未処理 (先に interpret を)
    if (isClearlyNonProduct(entry.description)) continue;
    candidates.push(entry);
  }
  const targets = candidates.slice(0, LIMIT === Infinity ? candidates.length : LIMIT);
  console.info(
    `[enrich] 候補 ${candidates.length} 件 (今回処理 ${targets.length}${
      DRY_RUN ? ", DRY_RUN" : ""
    })`
  );
  if (targets.length === 0) {
    console.info("[enrich] 処理対象なし。終了。");
    return;
  }

  const llm = await initLlm();
  const written: WebEnrichEntry[] = [];
  let recovered = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const tag = `[${t.stockName} ${t.stockCode}]`;
      let result: WebEnrichEntry;
      try {
        // a. 価格付け可能か + クエリ
        const cls = await promptJson<Classify>(
          llm,
          CLASSIFY_SYSTEM,
          `優待品の説明:\n${t.description}\n\nJSON で判定してください。`,
          ClassifySchema
        );
        if (!cls.priceable) {
          result = mkNull(t.key, `非物販と判定: ${cls.reason}`.slice(0, 120), cls.query);
        } else {
          // b. 楽天検索
          const items = await rakutenSearch(cls.query);
          if (items.length === 0) {
            result = mkNull(t.key, `楽天ヒット 0: ${cls.query}`, cls.query);
          } else {
            // c. 代表単価を判定
            const itemList = items
              .map((it, idx) => `${idx}: ${it.name.slice(0, 60)} / ${it.price}円`)
              .join("\n");
            const judge = await promptJson<Judge>(
              llm,
              JUDGE_SYSTEM,
              `優待品:\n${t.description}\n\n優待で受け取る個数: ${cls.quantity}\n\n楽天検索結果:\n${itemList}\n\nJSON で判定してください。`,
              JudgeSchema
            );
            // d. grounding
            const grounded = groundPrice(judge.unitPrice, cls.quantity, items);
            if (grounded === null) {
              result = mkNull(
                t.key,
                `採用不可/根拠不足: ${judge.reason}`.slice(0, 120),
                cls.query
              );
            } else {
              const idx =
                judge.matchedIndex !== null &&
                judge.matchedIndex >= 0 &&
                judge.matchedIndex < items.length
                  ? judge.matchedIndex
                  : 0;
              result = {
                key: t.key,
                estimatedValue: grounded,
                estimateValueSource: "web",
                estimateSourceUrl: items[idx].url,
                matchedName: items[idx].name.slice(0, 120),
                query: cls.query,
                note: `web推定 ${grounded}円 (q=${cls.quantity}): ${judge.reason}`.slice(0, 160),
              };
              recovered++;
            }
          }
        }
      } catch (e) {
        // ルール2: 1 件の失敗で全体を止めず、その件は null 据え置き (理由を残す)。
        // ただし「黙って埋める」ではなく null のまま正直に記録し再実行で再挑戦可。
        result = mkNull(t.key, `処理失敗: ${(e as Error).message}`.slice(0, 140), null);
      }

      if (DRY_RUN) {
        console.info(`${tag} ${JSON.stringify(result)}`);
      } else {
        const fname = `web-${t.key}.jsonl`;
        writeFileSync(join(WEB_DIR, fname), JSON.stringify(result) + "\n", "utf-8");
      }
      written.push(result);
      if ((i + 1) % 20 === 0)
        console.info(`[enrich] 進捗 ${i + 1}/${targets.length} (救済 ${recovered})`);
    }
  } finally {
    await llm.context.dispose();
    await llm.model.dispose();
    await llm.llama.dispose();
  }

  console.info(
    `[enrich] 完了。処理 ${written.length} / web 推定で救済 ${recovered} / 据え置き null ${
      written.length - recovered
    }`
  );

  if (!DRY_RUN && written.length > 0) {
    // ルール6: バッチ確定 JSONL を Notion 一次データ DB に実体記録。
    const day = new Date().toISOString().slice(0, 10);
    const bytes = Buffer.from(
      written.map((w) => JSON.stringify(w)).join("\n") + "\n",
      "utf-8"
    );
    await recordPrimaryData({
      service: "otakara-yutai",
      key: `web-enriched-${day}`,
      source:
        "otakara-yutai/data-scripts/enrich-from-web.ts (楽天市場API+ローカルLLM 推定バッチ)",
      metadata: {
        day,
        processed: written.length,
        recovered,
        rakutenHits: RAKUTEN_HITS,
      },
      files: [
        {
          bytes: new Uint8Array(bytes),
          filename: `web-enriched-${day}.jsonl`,
          contentType: "application/x-ndjson",
        },
      ],
    });
    console.info(`[enrich] Notion: web-enriched-${day} を一次データ DB に記録`);
  }
  console.info(
    "[enrich] 次は: apply-benefit-interpretations.ts で estimate_value_source/url ごと DB 反映"
  );
}

/** null 据え置きエントリ (再クエリ防止のため理由付きで記録する)。 */
function mkNull(key: string, note: string, query: string | null): WebEnrichEntry {
  return {
    key,
    estimatedValue: null,
    estimateValueSource: null,
    estimateSourceUrl: null,
    matchedName: null,
    query,
    note,
  };
}

main().catch((e) => {
  console.error("[enrich] エラー:", e);
  process.exit(1);
});
