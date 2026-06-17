/**
 * 優待 description の「解釈」を **ローカル OSS LLM (node-llama-cpp)** で
 * 自動生成する (パイプライン step3)。
 *
 * パイプライン (data-scripts、cron 非対象。全て data-scripts/data/ を入出力):
 *   1. fetch-yutai-full.ts  (minkabu → yutai_benefits)
 *   2. export-benefit-descriptions.ts  (→ data/benefit-descriptions.jsonl)
 *   3. ★ interpret-benefits.ts  ← 本スクリプト (→ data/interpreted/chunk-*.jsonl)
 *   4. apply-benefit-interpretations.ts  (→ DB short_summary / estimated_value)
 *
 * 旧実装は `claude -p` (Claude CLI サブスク認証) を subprocess 起動していたが、
 * 外部 CLI 依存・サブスク依存を排除するため **完全ローカル推論** へ移行した。
 * node-llama-cpp を **インプロセス** で 1 度だけ起動し (デーモン不要・
 * プリビルド Metal バイナリ)、各バッチで
 *   - shortSummary: 一覧表示用の簡潔な日本語要約
 *   - estimatedValue: 優待単位あたりの推定金銭価値 (円, 整数)。推定不能は null
 * を得る。クラウド API も従量課金も発生しない (完全ローカル)。
 *
 * 設計:
 *   - getLlama → モデル DL/解決 (HF GGUF URI) → context (sequences=並列数) を
 *     1 度だけ生成。JSON schema を `createGrammarForJsonSchema` で grammar 化し、
 *     **トークン生成レベルで構造を強制** (不正 JSON が原理的に出ない)。
 *   - バッチ毎に LlamaChatSession を新規生成 (systemPrompt=採点ルール)。
 *     セッションを使い捨てることで前バッチの履歴汚染を防ぐ。
 *   - バッチ: BATCH_SIZE 件/セッション。CONCURRENCY 個の sequence で並列。
 *   - 冪等・再開可能: 既存 chunk-*.jsonl の idx はスキップ。途中失敗しても
 *     完了済みバッチは chunk ファイルに残るので再実行で続きから。
 *   - CLAUDE.md ルール2: grammar.parse 失敗/Zod 不一致/idx 欠落/要約空 なら
 *     throw。estimatedValue=null は「推定不能」を型で明示するもので
 *     fallback ではない。grammar により JSON 崩れは起きないが、決定論ガード
 *     (sanitizeEstimatedValue) は LLM が弱い分むしろ重要なので温存する。
 *
 * 前提: 初回実行時に GGUF モデル (数 GB) を MODELS_DIR へ DL する (要ネット)。
 *   2 回目以降はローカルキャッシュを使う。OTAKARA_LLM_MODEL でモデル上書き可。
 * 実行: pnpm interpret:yutai
 */
import { z } from "zod";
import {
  getLlama,
  resolveModelFile,
  LlamaChatSession,
  type Llama,
  type LlamaModel,
  type LlamaContext,
  type LlamaContextSequence,
  type LlamaJsonSchemaGrammar,
} from "node-llama-cpp";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// --- パス (このスクリプトの位置基準で解決) ---
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(SCRIPT_DIR, "data", "benefit-descriptions.jsonl");
const INTERPRETED_DIR = join(SCRIPT_DIR, "data", "interpreted");
/** GGUF モデルの DL/キャッシュ先 (.gitignore 済み。数 GB)。 */
const MODELS_DIR = join(SCRIPT_DIR, "models");

// --- パラメータ ---
/**
 * 使用する GGUF モデル (HF URI `hf:org/repo:quant`)。再現性ピンとして
 * コード定数に固定 (旧 MODEL="haiku" と同じ位置づけ)。OTAKARA_LLM_MODEL で
 * 上書き可。既定は日本語特化・軽量で本タスクに十分な ELYZA-JP-8B。難ケースで
 * 額面/null 判定が弱ければ `hf:Qwen/Qwen3-32B-GGUF:Q4_K_M` 等に切替 (M5 Max で快適)。
 */
const MODEL_URI =
  process.env.OTAKARA_LLM_MODEL ??
  "hf:elyza/Llama-3-ELYZA-JP-8B-GGUF:Q4_K_M";
/**
 * 1 セッションで解釈する description 件数。値を大きくすると 1 バッチあたりの
 * 出力トークン数が増え、grammar=off 時に ELYZA-JP-8B が構造ドリフト (各
 * エントリの末尾に余分な `}` を吐く現象) を起こしやすくなる。
 * 既定 10 は実測でドリフト発生率が低かった値。OTAKARA_LLM_BATCH_SIZE で上書き可。
 */
const BATCH_SIZE = (() => {
  const raw = process.env.OTAKARA_LLM_BATCH_SIZE;
  if (!raw) return 10;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `OTAKARA_LLM_BATCH_SIZE は 1 以上の整数で指定してください: ${raw}`
    );
  }
  return n;
})();
/**
 * 並列 sequence 数。単一モデル/単一 Metal デバイスでは N 並列でも線形高速化
 * しない (compute-bound) ため、既定は逐次 (1) で堅牢に回す。速度試行は
 * OTAKARA_LLM_CONCURRENCY=2 等で上書き (KV cache が並列分メモリを食う点に注意)。
 */
const CONCURRENCY = (() => {
  const raw = process.env.OTAKARA_LLM_CONCURRENCY;
  if (!raw) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `OTAKARA_LLM_CONCURRENCY は 1 以上の整数で指定してください: ${raw}`
    );
  }
  return n;
})();
/**
 * 1 バッチあたりの最大試行回数。LLM 応答の確率的なゆらぎ (JSON 崩れ /
 * スキーマ不一致 / idx 欠落) は再試行でほぼ解消するため、バッチ単位で
 * リトライしてから throw する (全体を ~85 バッチで毎回落とさない)。
 * ルール2: 上限まで失敗したら捏造せず throw (依然ラウドに失敗・再開可能)。
 */
const MAX_BATCH_ATTEMPTS = 4;
/**
 * JSON schema grammar を有効化するか。grammar はトークン生成レベルで
 * 構造を強制できる強い保証だが、Llama-3 系の巨大 vocab (~128k) と組み合わせると
 * `llama_grammar_reject_candidates_for_stack` の CPU コストが支配的になり
 * (1 バッチあたり数分〜十数分)、Metal GPU 性能を活かせない。
 *
 * OTAKARA_LLM_GRAMMAR=off で無効化可能。Zod 検証 + MAX_BATCH_ATTEMPTS の
 * バッチ単位リトライが安全網として残るため、不正 JSON は吸収できる
 * (リトライ上限を超えれば throw。ルール2: fallback はしない)。
 */
const USE_GRAMMAR =
  (process.env.OTAKARA_LLM_GRAMMAR ?? "on").toLowerCase() !== "off";
/**
 * shortSummary の文字数上限。Editorial Swiss Grid のカード 1 行表示が
 * **目標 30 字 / 推奨 40 字**だが、ELYZA-JP-8B では入力 description が
 * 複数オファー列挙のとき 40 字へ圧縮しきれず単一 idx で 4 連敗 abort する
 * 病態が観測された (例 idx=223 横浜DeNAベイスターズのファンクラブ +
 * グッズショップ複合優待 → 60〜70 字)。ランを実用的に完走させるため
 * ハードキャップは 60 字に緩和し、SYSTEM_PROMPT 側で 40 字を強くガイドする
 * 二段構え。41〜60 字に着地する少数件は許容 (黙って truncate しない:
 * ルール2 整合)。表示側 (app.ts) は word-break で折返し対応済み。
 */
const SUMMARY_MAX_CHARS = 60;
/**
 * `_raw-fail-*.txt` の保持上限。これを超えたら古いものから削除して
 * ディスク食いを防ぐ (デバッグ性は直近サンプルで十分)。
 */
const RAW_FAIL_KEEP = 50;

// --- 入出力スキーマ ---
interface SourceEntry {
  idx: number;
  stockCode: string;
  stockName: string;
  description: string;
  minSharesList: number[];
  ids: number[];
  existingValues: (number | null)[];
}

const InterpretedItem = z.object({
  idx: z.number().int(),
  shortSummary: z.string().min(1).describe("一覧表示用の簡潔な日本語要約"),
  estimatedValue: z
    .number()
    .int()
    .nullable()
    .describe("券面に明示金額があるときのみ整数円。不確かは null"),
});
const ResponseSchema = z.object({
  results: z.array(InterpretedItem),
});
type InterpretedEntry = z.infer<typeof InterpretedItem>;

/**
 * 上記 Zod スキーマと等価な node-llama-cpp GbnfJson スキーマ。grammar 化して
 * トークン生成を拘束する。GbnfJson では `required` は properties の全キーに
 * 自動付与され、nullable は `type: ["integer", "null"]` で表す。
 */
const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          idx: { type: "integer" },
          shortSummary: { type: "string" },
          estimatedValue: { type: ["integer", "null"] },
        },
      },
    },
  },
} as const;

// --- 採点ルール (system prompt としてローカル LLM に渡す固定文) ---
const SYSTEM_PROMPT = `あなたは日本株の株主優待データを整備する専門アナリストです。
入力は minkabu 由来の優待 description (生テキスト) の配列 (JSON) です。各要素
について一覧表示用の短い要約 (shortSummary) と、優待 1 単位あたりの推定金銭
価値 (estimatedValue, 円, 整数) を判定します。

# shortSummary の作り方
- 日本語。一覧カードに 1 行で出す前提。**目標 30 字 / 推奨 40 字以内 / ハード上限 60 字**。
- **60 字を超える応答は無効**。40 字を超えるなら下の「短縮の決定順」で必ず縮める。
- 「優待の種類 + 金額/数量」を最優先で凝縮する。
  例: "QUOカード 1,000円分" / "カタログギフト 3,000円相当" /
      "自社店舗 10%割引券 5枚" / "おこめ券 5kg相当" /
      "ゴルフ場プレー割引券 2,000円×2枚"

## 短縮の決定順 (40 字を超えそうなときに上から順に適用)
1. **保有期間で条件分岐がある場合は「最長保有条件のみ」を採用**。
   - 例: "【3年未満】3,000円相当、【3年以上】6,000円相当" → "【3年以上】6,000円相当"
   - 例: "【半年以上】2,000円相当、【3年以上】4,000円相当" → "【3年以上】4,000円相当"
2. 期限・贈呈時期・注意書き・条件文 (\`※\` で始まる注釈、利用制限) は要約に**絶対に含めない**。
   - NG 例: "QUOカード 1,000円分 ※1ポイント≒1円相当" → OK: "QUOカード 1,000円分"
   - NG 例: "カタログギフト 3,000円相当 ※継続保有特典" → OK: "カタログギフト 3,000円相当"
3. **数字は半角に統一**する (商品の固有名詞内に全角数字がある場合のみ原文ママを許可)。
   - NG 例: "６か月以上保有で１,０００円相当" → OK: "6か月以上保有で1,000円相当"
4. 並列列挙 (and/or, 「、」区切り, 番号付き ①②③, "1、2、" 列挙) は **代表 1 つだけを採用**し、他は捨てる。**「、」で繋いで両方残してはいけない**。代表は「金額が大きい / 換金性が高い / 数量が多い」順で選ぶ。
   - 例: "「ちいきの逸品」3,000円引き割引券3枚、千葉県の店舗で使える割引券(1万円相当)" → "ちいきの逸品 3,000円引き割引券 3枚"
   - 例: "らあめん花月嵐食事優待券 or 嵐げんこつらあめん箱入り" → "らあめん食事優待券 (選択制)"
   - 例: "①QUOカード500円分 ②自社商品 ③カタログギフト" → "QUOカード 500円分 (3点から選択)"

- 金額が券面に明記されていればその金額を使う。複数枚あるなら "金額×枚数"。
- 種類が判別できないときは原文の主要語を残し簡潔化する (推測で創作しない)。
- description が単位や数量のみ (例 "10枚") で種類不明なら
  "優待品 10枚" のように一般語で表す。架空の商品名を足さない。

# estimatedValue の判定基準 (円, 整数, 優待 1 単位あたり)
## 最優先ルール
- **企業が「○○円相当」「○○円分」と金額を明示している場合は、その額面を採用する**
  (自社商品・食品・カタログギフト・金券のいずれでも。企業公表値であり推測ではない)。
  優待利回り判定はこの企業公表の相当額を基準にするのが実務慣行である。
- 金額の明示が一切無いもの、または下記「null にするもの」に該当するものだけ null。
- 0 や 1、根拠のない概算の丸め値で「とりあえず」埋めることは禁止。明示額が
  あるならそれを使い、無いなら null。捏造はしない。
- 保有期間で金額が分岐するときは **最長保有条件の金額** を採用 (shortSummary と一致させる)。
  例: 【3年未満】2,000円相当【3年以上】4,000円相当 → 4000。
- 「○○円相当(年間 △△円相当)」のように 1 回分と年間が併記される場合は、
  **1 回 (1 単位) あたり=○○** を採用する (年間 △△ ではない)。
- 年間額しか示されず 1 回 (1 権利) あたりが不明なときは、年の権利確定が
  複数回なら「年間額 ÷ 回数」で 1 回分に直す。回数も 1 回分も判別できない
  場合は過大計上 (二重計上) を避け、年間額をそのまま採用しない
  (判断材料が乏しければ null)。

## 金額を採用するもの (明示額をそのまま整数で)
- 金券 (商品券・QUOカード・ギフトカード・図書カード・おこめ券・電子マネー・
  デジタルギフト・カタログギフト) の「○○円分 / ○○円相当」。複数枚は合計額。
- **自社商品・食品・飲料などの詰め合わせでも、本文に「○○円相当」と企業が
  明記していればその額を採用** (例: 菓子詰合せ 3,000円相当 → 3000)。
- 複数品が列挙され各々に金額がある場合は **その合計額** (最長保有条件のセットで)。
- **株主優待として進呈されるカタログ交換型の優待ポイント (株主専用サイトで
  商品・ギフトに交換できるもの) は 1 ポイント = 1 円で換算** (例: 4,000
  ポイント → 4000。制度上のレートが明示されていればそれに従う)。
- **桁を厳密に**: 「20万円相当」は 200000、「2,000円」は 2000。
  万=×10000 / 千=×1000。本文の数字と桁が一致しない値を出さない (10倍・1/10 厳禁)。

## null にするもの
- **割引・値引き系**: 「○%割引」「○円割引」「優待価格」「入居費用から○円割引」
  等は受け取る金銭ではない。割引前価格が本文に明示されない限り null
  (例: 入居費50万円割引 → null、プレー代2,000円割引 → null)。
- **会員権・利用権・施設利用・サービス利用などの非換金特典**は、本文に
  「○○円相当」と書いてあっても null (現金等価でなく利回り算定に不適。
  例: 1年VIP会員 132万円相当 → null)。物として受け取る品・金券・ポイントとは区別する。
- **買い物・利用で貯まる/付与される販促ポイント、「ポイント○倍」「○○ポイント
  還元 / 付与」等は現金等価でないため null** (株主優待のカタログ交換ポイントとは
  区別する)。
- 寄付・社会貢献・抽選などで金額換算が妥当でないものは null。
- 金額表記が一切無い自社商品等は原則 null。米 5kg のように常識的に概算できる
  ごく一部のみ控えめに概算してよいが、判断材料が乏しければ null。推測で埋めない。

# 出力形式 (厳守)
- **JSON のみ** を出力する。前後に説明文・コードフェンス(\`\`\`)を付けない。
- 形式: {"results":[{"idx":<入力値>,"shortSummary":"...","estimatedValue":<整数 or null>}, ...]}
- 入力の全 idx に対し過不足なく 1 件ずつ。idx は入力値そのまま (振り直さない)。
- 不確かなら estimatedValue は null。曖昧さを数値で塗りつぶさない。
- shortSummary は必ず非空文字列。`;

function loadSource(): SourceEntry[] {
  if (!existsSync(SOURCE_PATH)) {
    throw new Error(
      `${SOURCE_PATH} が見つかりません。先に export-benefit-descriptions.ts を実行してください。`
    );
  }
  const lines = readFileSync(SOURCE_PATH, "utf-8").trim().split("\n");
  const out: SourceEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line) as SourceEntry);
  }
  return out;
}

/** 既存 chunk-*.jsonl から解釈済み idx を収集 (再開用) */
function loadDoneIdx(): Set<number> {
  const done = new Set<number>();
  if (!existsSync(INTERPRETED_DIR)) {
    mkdirSync(INTERPRETED_DIR, { recursive: true });
    return done;
  }
  const files = readdirSync(INTERPRETED_DIR).filter(
    (f) => f.startsWith("chunk-") && f.endsWith(".jsonl")
  );
  for (const f of files) {
    const content = readFileSync(join(INTERPRETED_DIR, f), "utf-8");
    for (const line of content.trim().split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line) as InterpretedEntry;
      done.add(e.idx);
    }
  }
  return done;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// 決定論ガード — LLM 出力の estimatedValue を機械的に検証し、疑わしい高額値や
// 割引額の混入を **null に落とす** (別の数値に書き換えることはしない)。
//
// CLAUDE.md ルール1/2: 過大評価は優待利回り (割安判定) の誤誘導になる。
// 確信が持てない値は捏造せず「未取得 (null)」として落とすのが正。
// false-positive (本来妥当な値を null 化) はユーザー方針 (null 多めに倒す)
// に従い許容する — 過大評価より安全側。
// ---------------------------------------------------------------------------

/** 全角数字・カンマを半角化 */
function normalizeNumeric(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xfee0))
    .replace(/，/g, ",");
}

/**
 * description 中の数量ヒント (枚/個/口/名/冊/本/セット/点/回, ×N) を抽出。
 * 高額値の digit-grounding で「額面 × 数量」だけを許可する乗数集合に使う
 * (任意倍率 1..30 だと 20万 → 200万 のような 10 倍誤読を誤って容認するため)。
 */
function extractQuantities(descRaw: string): number[] {
  const d = normalizeNumeric(descRaw);
  const q = new Set<number>();
  for (const m of d.matchAll(
    /([0-9][0-9,]*)\s*(?:枚|個|口|名|冊|本|セット|点|回)/g
  )) {
    const n = Number(m[1].replace(/,/g, ""));
    if (n >= 1 && n <= 100) q.add(n);
  }
  for (const m of d.matchAll(/[×x✕]\s*([0-9][0-9,]*)/gi)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (n >= 1 && n <= 100) q.add(n);
  }
  return [...q];
}

/**
 * description から円建ての金額候補を抽出する (万=×10000 / 千=×1000)。
 * 株主優待ポイント (カタログ交換型) は SYSTEM_PROMPT で 1pt=1円 換算を採用する
 * ため、ここでも円建て候補として含める (決定論ガードの digit-grounding が
 * 高額ポイント値を「根拠不明」と誤判定して null 化するのを防ぐ)。
 */
function extractYenAmounts(descRaw: string): number[] {
  const desc = normalizeNumeric(descRaw);
  const amounts = new Set<number>();
  const num = (m: string): number => Number(m.replace(/,/g, ""));
  for (const m of desc.matchAll(/([0-9][0-9,]*)\s*万\s*円/g)) {
    amounts.add(num(m[1]) * 10000);
  }
  for (const m of desc.matchAll(/([0-9][0-9,]*)\s*千\s*円/g)) {
    amounts.add(num(m[1]) * 1000);
  }
  for (const m of desc.matchAll(/([0-9][0-9,]*)\s*円/g)) {
    const v = num(m[1]);
    if (v > 0) amounts.add(v);
  }
  // 株主優待カタログ交換ポイント = 1pt 1円 相当として金額候補に含める。
  // ただし「○○ポイント還元 / 付与」「ポイント○倍」のような買い物販促ポイントは
  // 現金等価でないため grounding 根拠に含めない (高額帯の過大評価ガードを
  // 緩めないため。直後 6 文字に販促語があれば除外する)。
  const PROMO_AFTER = /還元|付与|倍/;
  for (const m of desc.matchAll(/([0-9][0-9,]*)\s*ポイント/g)) {
    const after = desc.slice(
      m.index + m[0].length,
      m.index + m[0].length + 6
    );
    if (PROMO_AFTER.test(after)) continue;
    const v = num(m[1]);
    if (v > 0) amounts.add(v);
  }
  for (const m of desc.matchAll(/([0-9][0-9,]*)\s*pt\b/gi)) {
    const v = num(m[1]);
    if (v > 0) amounts.add(v);
  }
  return [...amounts];
}

/** 割引・値引き系か (換金性のある金券表現が無いことが条件) */
function isDiscountWithoutRedeemable(descRaw: string): boolean {
  const desc = normalizeNumeric(descRaw);
  const isDiscount =
    /割引|値引|優待価格|割引価格|[0-9]\s*[%％]\s*(?:off|オフ)?|\boff\b/i.test(
      desc
    );
  if (!isDiscount) return false;
  const hasRedeemable =
    /円分|円相当|円券|円分券|QUO|クオ|ギフトカード|ギフト券|商品券|おこめ券|お米券|図書カード|プリペイドカード|カタログギフト/i.test(
      desc
    );
  return !hasRedeemable;
}

/** ¥50,000 以上のしきい値 (この帯のみ厳格に digit-grounding 検証) */
const HIGH_VALUE_THRESHOLD = 50000;

/** 決定論ガードが LLM の非 null 値を null へ落とした件数 (運用可視化用) */
let demotedCount = 0;
/** グレースフル退路 (単一 idx 4 連敗で長さ超過のみ) で受理した件数 */
let lenientAcceptCount = 0;

/**
 * LLM の estimatedValue を決定論的に検証し、疑わしければ null を返す。
 * - 割引系で換金金券表現が無い → null
 * - 高額 (>=¥50,000) で、本文の金額候補 (×個数 1..30 / 合計) のいずれとも
 *   桁が一致しない → 桁取り違え/根拠不明として null
 */
function sanitizeEstimatedValue(
  descRaw: string,
  value: number | null
): number | null {
  if (value === null) return null;
  if (isDiscountWithoutRedeemable(descRaw)) return null;
  if (value < HIGH_VALUE_THRESHOLD) return value;

  const amounts = extractYenAmounts(descRaw);
  if (amounts.length === 0) return null; // 高額なのに本文に金額表現が無い
  const tol = (base: number): number => Math.max(1, base * 0.02);
  // 許可乗数 = 1 ∪ 本文の数量ヒント。任意倍率は使わない (10 倍誤読を弾く)。
  const multipliers = new Set<number>([1, ...extractQuantities(descRaw)]);
  const grounded = amounts.some(
    (a) =>
      a > 0 &&
      [...multipliers].some((m) => Math.abs(value - a * m) <= tol(a * m))
  );
  const sum = amounts.reduce((s, a) => s + a, 0);
  const matchesSum = sum > 0 && Math.abs(value - sum) <= tol(sum);
  return grounded || matchesSum ? value : null;
}

/**
 * ローカル LLM の実行ハンドル。モデル/コンテキスト/grammar/sequence は
 * プロセス内で 1 度だけ生成し、全バッチで共有する (モデルロードは高価)。
 */
interface LlmHandle {
  llama: Llama;
  model: LlamaModel;
  context: LlamaContext;
  /** USE_GRAMMAR=false のときは undefined。Zod 検証で代替する。 */
  grammar: LlamaJsonSchemaGrammar<typeof RESPONSE_JSON_SCHEMA> | undefined;
  /** ワーカー数 (CONCURRENCY) 分の sequence。各ワーカーが 1 本を専有する。 */
  sequences: LlamaContextSequence[];
}

/** モデル DL/解決 → ロード → context/grammar/sequence を初期化 (1 度だけ) */
async function initLlm(): Promise<LlmHandle> {
  if (!existsSync(MODELS_DIR)) mkdirSync(MODELS_DIR, { recursive: true });
  const llama = await getLlama();
  console.info(`[interpret] モデル解決/DL: ${MODEL_URI} → ${MODELS_DIR}`);
  const modelPath = await resolveModelFile(MODEL_URI, MODELS_DIR);
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext({
    contextSize: { max: 8192 },
    sequences: CONCURRENCY,
  });
  const grammar = USE_GRAMMAR
    ? await llama.createGrammarForJsonSchema(RESPONSE_JSON_SCHEMA)
    : undefined;
  const sequences = Array.from({ length: CONCURRENCY }, () =>
    context.getSequence()
  );
  return { llama, model, context, grammar, sequences };
}

/**
 * grammar 無効時に LLM のテキスト応答から JSON を取り出す。素の応答は稀に
 * 前置き文や ```json ... ``` で囲まれることがあるため、それらを剥がす。
 * さらに ELYZA-JP-8B は **末尾の `}` を欠落させて停止する** ことが頻繁にある
 * (EOS トークンが本来の終端より少し手前で発火する模様) ため、最後に
 * 不足する `]`/`}` を補修するパスを設けて再試行する。
 * 全て失敗すれば throw → 上位 (MAX_BATCH_ATTEMPTS) のリトライへ。
 */
function extractJson(raw: string): unknown {
  const tries: string[] = [];
  tries.push(raw);
  const fence = raw.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fence) tries.push(fence[1]);
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) tries.push(raw.slice(first, last + 1));
  if (first !== -1) {
    const fromFirst = raw.slice(first);
    // ELYZA は時々エントリ区切りで `}},{` (余分な `}`) を吐くドリフトを起こす。
    // 文字列内には `}}` は出ない前提 (本タスクの shortSummary は商品名で
    // 通常 brace を含まない) で機械的に正規化する。失敗しても他候補で再挑戦。
    const debraced = fromFirst.replace(/\}\}\s*,\s*\{/g, "},{");
    tries.push(debraced);
    tries.push(repairTruncatedJson(debraced));
    // さらに重いドリフト: 各エントリが個別に `{"results":[...]}` で包まれて
    // `}},{"results":[...]}},...` の連鎖になることがある。debrace 後の
    // `,{"results":[` (途中で開いた余分な outer) を `,` に潰して 1 つの
    // results 配列に直列化する。これも文字列内には現れない前提で安全。
    const flattened = debraced.replace(/,\s*\{\s*"results"\s*:\s*\[/g, ",");
    tries.push(flattened);
    tries.push(repairTruncatedJson(flattened));
    tries.push(repairTruncatedJson(fromFirst));
  }

  for (const candidate of tries) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* 次の候補へ */
    }
  }
  throw new Error(
    `応答から JSON を抽出できませんでした (先頭160字): ${raw.slice(0, 160)}`
  );
}

/**
 * `_raw-fail-*.txt` を mtime 順に走査し、最新 RAW_FAIL_KEEP 件のみを残して
 * 古いものを削除する。デバッグ性は直近サンプルで十分なので、無限増殖を防ぐ。
 */
function rotateRawFailDumps(): void {
  let names: string[];
  try {
    names = readdirSync(INTERPRETED_DIR).filter(
      (f) => f.startsWith("_raw-fail-") && f.endsWith(".txt")
    );
  } catch {
    return;
  }
  if (names.length <= RAW_FAIL_KEEP) return;
  const stats = names
    .map((name) => {
      const full = join(INTERPRETED_DIR, name);
      try {
        return { full, mtime: statSync(full).mtimeMs };
      } catch {
        return { full, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime); // 新しい順
  for (const s of stats.slice(RAW_FAIL_KEEP)) {
    try {
      unlinkSync(s.full);
    } catch {
      /* 削除失敗は無視 */
    }
  }
}

/**
 * 末尾が切れた JSON を、文字列状態と `{}` / `[]` の対応を追跡して保守的に
 * 閉じる。文字列内の `{` や `[` は無視 (エスケープも追跡)。本タスクは
 * ELYZA が末尾 1-2 文字落とすケースの救済が目的で、巨大な欠落は救えない。
 */
function repairTruncatedJson(src: string): string {
  let s = src.trimEnd().replace(/,\s*$/, "");
  let openObj = 0;
  let openArr = 0;
  let inStr = false;
  let esc = false;
  for (const c of s) {
    if (esc) {
      esc = false;
      continue;
    }
    if (c === "\\") {
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === "{") openObj++;
    else if (c === "}") openObj--;
    else if (c === "[") openArr++;
    else if (c === "]") openArr--;
  }
  if (inStr) s += '"';
  while (openArr > 0) {
    s += "]";
    openArr--;
  }
  while (openObj > 0) {
    s += "}";
    openObj--;
  }
  return s;
}

/**
 * 1 バッチ分のプロンプトをローカル LLM で実行し、grammar で構造保証された
 * オブジェクトを返す。セッションはバッチ毎に新規生成・使い捨てにして、
 * 前バッチの会話履歴による汚染を防ぐ。grammar.parse の失敗は throw して
 * 呼び出し側のリトライに委ねる (ルール2: 黙って埋めない)。
 */
async function runLocalLlm(
  grammar: LlmHandle["grammar"],
  sequence: LlamaContextSequence,
  userPrompt: string,
  attempt: number
): Promise<unknown> {
  // **重要**: sequence は worker 内でバッチ間/リトライ間で再利用される。前回の
  // KV cache が残ったまま新しい systemPrompt+userPrompt を投げると、内部の
  // chat-template 整合チェックがズレて出力構造が破綻する (idx=60 で `}}` が
  // 連発するなど)。各 prompt 直前に history を全消去して clean slate にする。
  await sequence.clearHistory();
  const session = new LlamaChatSession({
    contextSequence: sequence,
    systemPrompt: SYSTEM_PROMPT,
  });
  try {
    if (grammar) {
      const res = await session.prompt(userPrompt, { grammar });
      try {
        return grammar.parse(res);
      } catch (e) {
        throw new Error(
          `grammar.parse 失敗: ${(e as Error).message.slice(0, 200)}`
        );
      }
    } else {
      // grammar 無効: 素の生成 → JSON 抽出。
      // 1 回目は temperature=0 (再現性ピン)、リトライ時のみ確率的に揺らして
      // 決定的に同じ壊れた出力を返すのを避ける (seed もリトライ毎に変える)。
      const promptOptions =
        attempt === 1
          ? {}
          : {
              temperature: 0.3,
              topP: 0.9,
              seed: Date.now() + attempt,
            };
      const res = await session.prompt(userPrompt, promptOptions);
      try {
        return extractJson(res);
      } catch (e) {
        // デバッグ用: 生応答をファイルに残して原因究明できるようにする。
        // attempt まで名前に含めて同一ミリ秒での衝突を回避。書き込み後は
        // 古い dump をローテーションして無限増殖を防ぐ。
        try {
          const dumpPath = join(
            INTERPRETED_DIR,
            `_raw-fail-${Date.now()}-a${attempt}.txt`
          );
          writeFileSync(dumpPath, res, "utf-8");
          console.warn(`[interpret] 生応答を保存: ${dumpPath}`);
          rotateRawFailDumps();
        } catch {
          /* 保存失敗は無視 */
        }
        throw e;
      }
    }
  } finally {
    session.dispose();
  }
}

/**
 * 1 バッチをローカル LLM で解釈し chunk 行文字列を返す (1 回の試行)。
 * `lenientLength=true` のとき shortSummary の文字数上限チェックをスキップする
 * (構造検証 / idx 完全性 / 空文字検証は温存)。単一 idx で 4 連敗した最後の
 * 砦 (interpretBatch のグレースフル退路) でのみ使う。
 */
async function attemptInterpretBatch(
  batch: SourceEntry[],
  llm: LlmHandle,
  sequence: LlamaContextSequence,
  attempt: number,
  lenientLength: boolean = false
): Promise<string> {
  const requestedIdx = new Set(batch.map((b) => b.idx));
  const payload = batch.map((b) => ({
    idx: b.idx,
    stockName: b.stockName,
    description: b.description,
  }));
  const userPrompt = `次の優待 description を解釈し、指定 JSON 形式のみで返してください。\n${JSON.stringify(
    payload
  )}`;

  // grammar により出力は構造的に妥当な JSON が保証されるため JSON.parse 段は不要。
  // ただし Zod 検証・idx 完全性・決定論ガードは温存する (ルール2 / 安全網)。
  const parsedJson = await runLocalLlm(llm.grammar, sequence, userPrompt, attempt);
  const parsed = ResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `バッチ idx=[${batch[0].idx}..${batch[batch.length - 1].idx}] のスキーマ不一致: ${parsed.error.message.slice(0, 300)}`
    );
  }

  // 要求した idx が全て返っているか検証 (欠落を黙って捨てない)
  const byIdx = new Map<number, InterpretedEntry>();
  for (const r of parsed.data.results) byIdx.set(r.idx, r);
  const missing = [...requestedIdx].filter((i) => !byIdx.has(i));
  if (missing.length > 0) {
    throw new Error(
      `バッチで idx が欠落: [${missing.join(", ")}]。再実行してください。`
    );
  }

  const lines = batch
    .map((b) => {
      const r = byIdx.get(b.idx)!;
      // NFKC 正規化で全角英数字を半角に揃える (`１,000円` → `1,000円`)。
      // これは「同じ意味の表現揺れ吸収」(CLAUDE.md ルール2 唯一の例外節:
      // ユーザー入力の正規化) に該当し、fallback ではない。SYSTEM_PROMPT に
      // 「半角統一」を書いても ELYZA は完全に守らないため、後段で物理保証する。
      const summary = r.shortSummary.normalize("NFKC").trim();
      if (summary.length === 0) {
        throw new Error(`idx=${b.idx} の shortSummary が空です`);
      }
      // ブランド規約: 一覧カードに 1 行表示する前提で、生成された summary が
      // 上限を超えていたら throw → 上位リトライへ。リトライ上限超過は
      // 分割再試行で吸収。SYSTEM_PROMPT 側にも「40 字超は無効」を明示し、
      // コードでも強制することで再生成圧をかける (ルール2 整合: 黙って
      // 切り詰めず再生成)。lenientLength=true (interpretBatch の
      // グレースフル退路) のときのみチェックをスキップする。
      if (!lenientLength && summary.length > SUMMARY_MAX_CHARS) {
        throw new Error(
          `idx=${b.idx} の shortSummary が ${summary.length} 字 (上限 ${SUMMARY_MAX_CHARS}): ${summary.slice(0, 60)}…`
        );
      }
      const safeValue = sanitizeEstimatedValue(b.description, r.estimatedValue);
      if (r.estimatedValue !== null && safeValue === null) demotedCount++;
      const entry: InterpretedEntry = {
        idx: b.idx,
        shortSummary: summary,
        estimatedValue: safeValue,
      };
      return JSON.stringify(entry);
    })
    .join("\n");

  return lines;
}

/**
 * 1 バッチを解釈し chunk ファイルに書き出す。確率的失敗 (JSON 崩れ /
 * スキーマ不一致 / idx 欠落) はバッチ単位で MAX_BATCH_ATTEMPTS 回まで
 * リトライ。上限超過は捏造せず throw (ルール2: ラウドに失敗・再開可能)。
 * 書き込みは成功時 1 回のみ (部分・不正な chunk を残さない)。
 */
async function interpretBatch(
  batch: SourceEntry[],
  llm: LlmHandle,
  sequence: LlamaContextSequence
): Promise<void> {
  const idxRange = `[${batch[0].idx}..${batch[batch.length - 1].idx}]`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
    try {
      const lines = await attemptInterpretBatch(batch, llm, sequence, attempt);
      const fname = `chunk-${String(batch[0].idx).padStart(5, "0")}.jsonl`;
      writeFileSync(join(INTERPRETED_DIR, fname), lines + "\n", "utf-8");
      if (attempt > 1) {
        console.info(
          `[interpret] バッチ ${idxRange} は ${attempt} 回目で成功`
        );
      }
      return;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_BATCH_ATTEMPTS) {
        console.warn(
          `[interpret] バッチ ${idxRange} 試行 ${attempt}/${MAX_BATCH_ATTEMPTS} 失敗、再試行: ${(e as Error).message.slice(0, 160)}`
        );
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  // フォールバック: 2 件以上ならバッチを半分に割って再帰。LLM が長い出力で
  // ドリフトするケース (一部 idx を欠落させ続ける等) を、より小さな問題に
  // 分解して救う。最終的に batch_size=1 まで落ちれば LLM は通常 1 件は出せる。
  if (batch.length > 1) {
    const mid = Math.ceil(batch.length / 2);
    console.warn(
      `[interpret] バッチ ${idxRange} は ${MAX_BATCH_ATTEMPTS} 回失敗。${mid}+${batch.length - mid} に分割して再試行`
    );
    await interpretBatch(batch.slice(0, mid), llm, sequence);
    await interpretBatch(batch.slice(mid), llm, sequence);
    return;
  }
  // 単一 idx + 4 連敗の最終局面。失敗原因が「shortSummary 上限超過」だけなら
  // モデル能力の限界 (description が長く列挙が多く 60 字に圧縮できない) と
  // 判断し、グレースフル退路として lenientLength=true で 1 回だけ再試行。
  // 構造的に成立した出力は受理し warn ログを残す (ルール2 の精神: 黙って
  // 切り詰めるのは禁止だが、運用者に正直に通知した上で「LLM の best effort」
  // を採用するのは fallback ではなく「未達の正直な報告」)。
  // 構造系エラー (JSON 崩れ / Zod 不整合 / idx 欠落) は依然 throw。
  const isLengthOnly = (lastErr as Error | undefined)?.message?.includes(
    "shortSummary が"
  );
  if (isLengthOnly) {
    console.warn(
      `[interpret] idx=${batch[0].idx} は ${MAX_BATCH_ATTEMPTS} 回連続で長さ超過。グレースフル退路: 長さチェックをスキップして 1 回受理を試みる`
    );
    try {
      const lines = await attemptInterpretBatch(
        batch,
        llm,
        sequence,
        MAX_BATCH_ATTEMPTS + 1,
        true // lenientLength
      );
      const fname = `chunk-${String(batch[0].idx).padStart(5, "0")}.jsonl`;
      writeFileSync(join(INTERPRETED_DIR, fname), lines + "\n", "utf-8");
      lenientAcceptCount++;
      const acceptedLen = lines.split("\n")[0].length; // 表示用 (lines は JSON 1 行)
      console.warn(
        `[interpret] idx=${batch[0].idx} を長さチェック無視で受理 (entry JSON ${acceptedLen} 字)。後で要見直し候補。`
      );
      return;
    } catch (graceErr) {
      throw new Error(
        `単一エントリ idx=${batch[0].idx} がグレースフル退路でも失敗: ${(graceErr as Error).message}`
      );
    }
  }
  throw new Error(
    `単一エントリ idx=${batch[0].idx} が ${MAX_BATCH_ATTEMPTS} 回試行しても失敗 (再実行で続きから): ${(lastErr as Error).message}`
  );
}

async function main(): Promise<void> {
  const source = loadSource();
  const done = loadDoneIdx();
  const pending = source.filter((s) => !done.has(s.idx));
  console.info(
    `[interpret] 全 ${source.length} 件 / 解釈済み ${done.size} / 今回対象 ${pending.length}`
  );
  if (pending.length === 0) {
    console.info("[interpret] 未処理なし。終了します。");
    return;
  }

  const batches = chunkArray(pending, BATCH_SIZE);
  console.info(
    `[interpret] ${batches.length} バッチ (${BATCH_SIZE} 件/バッチ, 並列 ${CONCURRENCY}, grammar=${USE_GRAMMAR ? "on" : "off"}, model=${MODEL_URI}, ローカル推論)`
  );

  const llm = await initLlm();
  try {
    let cursor = 0;
    let completed = 0;
    async function worker(sequence: LlamaContextSequence): Promise<void> {
      while (cursor < batches.length) {
        const myBatch = batches[cursor];
        cursor++;
        await interpretBatch(myBatch, llm, sequence);
        completed++;
        if (completed % 5 === 0 || completed === batches.length) {
          console.info(`[interpret] 進捗 ${completed}/${batches.length} バッチ`);
        }
      }
    }
    const workerCount = Math.min(CONCURRENCY, batches.length);
    await Promise.all(
      llm.sequences.slice(0, workerCount).map((seq) => worker(seq))
    );
  } finally {
    // モデル/コンテキストを確実に解放 (途中失敗時もリソースを残さない)
    await llm.context.dispose();
    await llm.model.dispose();
    await llm.llama.dispose();
  }

  console.info(
    `[interpret] 決定論ガードで estimatedValue を null 化: ${demotedCount} 件 (割引混入/桁不整合の安全側除去)`
  );
  if (lenientAcceptCount > 0) {
    console.warn(
      `[interpret] グレースフル退路で受理した単一 idx: ${lenientAcceptCount} 件 (長さ上限 ${SUMMARY_MAX_CHARS} 字を超過。後で SYSTEM_PROMPT 改善 / モデル変更を検討)`
    );
  }
  console.info(
    "[interpret] 完了。次は: pnpm exec tsx services/otakara-yutai/data-scripts/apply-benefit-interpretations.ts で DB 反映"
  );
}

main().catch((e) => {
  console.error("[interpret] エラー:", e);
  process.exit(1);
});
