/**
 * 優待の全量取込 (fetch-yutai-full.ts の Phase 3) の D1 への書き込み。
 *
 * CLI の fetch-yutai-full.ts は import すると main() が走るので、値では試せない。
 * 書き込みはここに集めて db を注入し、src/tests/yutai-full-import.test.ts がローカル
 * SQLite で値を見る。
 *
 * ## 書き換えるのは母集団の銘柄の優待だけ
 *
 * 母集団は core_stocks の active かつ equity (日次・公開面と同じ。
 * src/shared/db/active-equity.ts)。
 *
 * - 母集団の銘柄: 優待行を消して、今回の取得結果で作り直す。退避した解釈は内容キーで
 *   戻す。優待行を持っていたのに今回取得できなかった銘柄は、優待行を消して is_yutai を
 *   false に落とす (優待の廃止)。
 * - 母集団外の銘柄 (is_active=0 = 東証の上場銘柄一覧に無い。地域取引所にだけ上場を続ける
 *   会社を含む / 非普通株 / 区分が NULL): 取得結果に載っていても取り込まず、既存の
 *   優待行と is_yutai にも触らない。
 *
 * 母集団外を消さないのは、short_summary / estimated_value が作り直せないから。どちらも
 * クラウド LLM の要約を import-summary-results.ts で取り込んだものでしか作れず、この取込の
 * 退避は実行中のメモリにしか無い。母集団外まで消すと、みんかぶに載り続けている銘柄の
 * 解釈も、区分の充填が一部だけ消えた銘柄の解釈も、次の実行で戻らない。母集団外の優待を
 * 消すかどうかは、この取込の副作用にしない。
 *
 * ## 削除の前に止める条件
 *
 * - 取り込み先の銘柄が 0 件 (is_active の一括対象外化など、母集団側の異常)。
 * - 優待行を持つ母集団の銘柄のうち、今回も取得できた割合が
 *   `MIN_YUTAI_COVERAGE_PERCENT` 未満。取得できなかった銘柄は廃止として優待行と解釈を
 *   消すので、個別ページの取得の大量失敗 (HTTP 429 等) や一覧ページ走査の打ち切りを
 *   削除の前に拒否する (src/cron/universe.ts の MIN_EXISTING_COVERAGE と同じ考え方)。
 *
 * D1 HTTP クライアントはトランザクション非対応 (src/shared/db/d1-http-client.ts)。
 * is_yutai は「事前に全 false → ループで true」にせず、立て終えた後に、今回取り込めな
 * かった銘柄だけを false へ落とす (CLAUDE.md ルール2)。
 *
 * ## 書き込みの終わりの利回り・スコア追随
 *
 * write/end・write-error/end に、実際の post-image から 1 回だけ再計算する
 * (fetchYieldInputs → computeYieldEntries → snapshotStockPreimages →
 * applyYieldRecomputeAtomically。既存の共有 builders のみ)。
 * scope は「優待行を持っていた銘柄 ∪ 今回取得 ∪ 利回りが残る銘柄」で、
 * 廃止・中断再入の stale 利回りを直す。書き込み前の STOP では走らせない。
 * 書くのは yield + fetched_at / score3 だけ (price・data_date 等は不変)。
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { activeEquityCondition } from "../../../src/shared/db/active-equity.js";
import { stockFinancials, stocks, yutaiBenefits, yutaiGenres } from "../src/db/schema.js";
import { type AtomicBatchSender, snapshotStockPreimages } from "./atomic-apply.js";
import { benefitKey } from "./benefit-key.js";
import { qualifyCompanyPerGrantValue } from "./estimated-value-guard.js";
import {
  applyYieldRecomputeAtomically,
  computeYieldEntries,
  fetchYieldInputs,
  formatRecomputeReport,
} from "./recompute-yields.js";

export type BenefitDetail = {
  minShares: number;
  description: string;
  notes: string;
};

/** 個別ページ 1 銘柄ぶんの取得結果 (fetch-yutai-full.ts の Phase 2)。 */
export type StockYutaiData = {
  code: string;
  name: string;
  market: string;
  recordMonths: number[];
  category: string;
  benefits: BenefitDetail[];
};

/**
 * `core_stocks` と優待の表を読み書きできれば足りる drizzle db 型。Node の D1 HTTP 版
 * (sqlite-proxy) もテストのローカル SQLite も渡せる (src/shared/db/active-equity.ts と同じ形)。
 */
export type YutaiFullImportDb = BaseSQLiteDatabase<"async", unknown, Record<string, unknown>>;

/**
 * 優待行を持つ母集団の銘柄のうち、今回も取得できていなければならない割合 (%)。
 *
 * 平常の月の差は優待の廃止と個別ページの一時的な失敗だけで、数十銘柄 (約 1,600 の数 %)
 * に収まる。これを割るのは取得側の異常とみなす。
 */
export const MIN_YUTAI_COVERAGE_PERCENT = 95;

/** D1 の bind 上限 (100/文) に収める IN リストの長さ。 */
const ID_CHUNK = 80;

// ジャンルマッピング（minkabuのカテゴリ名→slug）
export const GENRE_SLUG_MAP: Record<string, string> = {
  "食事券": "dining", "食品": "food", "飲料": "food", "お米": "rice",
  "交通・旅行": "travel", "旅行": "travel", "交通": "travel",
  "スポーツ": "leisure", "レジャー施設": "leisure", "娯楽": "leisure", "映画": "leisure",
  "美容": "beauty", "ファッション": "beauty", "化粧品": "beauty",
  "暮らし": "living", "日用品": "living", "住まい": "living",
  "ギフトカード": "gift-card", "ギフト券": "gift-card",
  "QUOカード": "quo-card", "クオカード": "quo-card",
  "金券": "voucher", "商品券": "voucher",
  "カタログギフト": "catalog", "特産品": "catalog",
  "ポイント": "point",
  "金融": "financial", "銀行": "financial", "保険": "financial", "証券": "financial",
  "クレジット": "financial", "リース": "financial", "FX": "financial", "信託": "financial",
  "医療": "medical", "介護": "medical", "ヘルスケア": "medical",
  "社会貢献": "social", "寄付": "social",
};

export function guessGenreSlug(title: string, description: string): string {
  const text = title + " " + description;
  for (const [keyword, slug] of Object.entries(GENRE_SLUG_MAP)) {
    if (text.includes(keyword)) return slug;
  }
  if (text.match(/食|グルメ|弁当|菓子/)) return "food";
  if (text.match(/割引券|優待券|施設利用/)) return "voucher";
  if (text.match(/自社製品|自社商品/)) return "living";
  return "other";
}

/** ジャンル。slug で upsert する (消さない)。 */
export const YUTAI_GENRES: { name: string; slug: string; description: string }[] = [
  { name: "食品・飲料", slug: "food", description: "食品、飲料、食料品" },
  { name: "食事券・外食", slug: "dining", description: "食事券、外食割引、レストラン" },
  { name: "お米", slug: "rice", description: "お米、米関連" },
  { name: "交通・旅行", slug: "travel", description: "交通、旅行、航空、鉄道" },
  { name: "レジャー・娯楽", slug: "leisure", description: "スポーツ、レジャー、映画、娯楽" },
  { name: "美容・ファッション", slug: "beauty", description: "化粧品、衣料品、ファッション" },
  { name: "暮らし・住まい", slug: "living", description: "日用品、住居関連、自社製品" },
  { name: "ギフトカード", slug: "gift-card", description: "ギフトカード" },
  { name: "QUOカード", slug: "quo-card", description: "QUOカード" },
  { name: "金券・商品券", slug: "voucher", description: "金券、商品券、割引券" },
  { name: "カタログギフト", slug: "catalog", description: "カタログギフト、特産品" },
  { name: "ポイント", slug: "point", description: "ポイントサービス" },
  { name: "金融サービス", slug: "financial", description: "銀行、証券、保険、金融サービス" },
  { name: "医療・介護", slug: "medical", description: "医療、介護、ヘルスケア" },
  { name: "社会貢献", slug: "social", description: "社会貢献、寄付" },
  { name: "その他", slug: "other", description: "その他の株主優待" },
];

/** 退避した解釈 (要約取り込みの産物)。key は銘柄コード + 文言 + 株数 + 権利月。 */
type CarriedInterpretation = {
  shortSummary: string | null;
  estimatedValue: number | null;
  estimateValueSource: string | null;
};

/**
 * 解釈の退避キー。[description, minShares, recordMonth] の contextつき。
 * 文言だけの旧キーだと別 tier の解釈が混ざる。旧 context と新 context の
 * 両方が一致した行にだけ同じ proof の解釈を戻す。
 */
export function carryKey(code: string, description: string, minShares: number, recordMonth: number): string {
  return `${benefitKey(code, description)}:${minShares}:${recordMonth}`;
}

/** `planCarry` への入力行 (DB  select の必要分だけ)。 */
export type CarrySourceRow = {
  code: string;
  description: string;
  minShares: number;
  recordMonth: number;
  shortSummary: string | null;
  estimatedValue: number | null;
  estimateValueSource: string | null;
};

/** `planCarry` の結果。副作用なし。 */
export type CarryPlan = {
  carried: Map<string, CarriedInterpretation>;
  /** 厳密判定に落ちて値ごと null で戻すキー (要約は保持)。 */
  nulledKeys: Set<string>;
  /** qualifier 通過で legacy-null から company に上がるキー。 */
  promotedKeys: Set<string>;
};

/**
 * 解釈の退避計画 (純関数。副作用なし、DB を触らない)。
 *
 * company / legacy-null の非 null 値は、要約取込と同じ共有厳密判定
 * (`qualifyCompanyPerGrantValue`) で company 適格を見る。不認定の値は
 * source を null に付け替えて値を温存したりしない — 値ごと null で戻す
 * (provenance だけ隠して経済値・利回りを残すのは guard bypass のため)。
 * 通過した legacy-null は company に上げる。会社四季報由来などの
 * web/未知 role は扱いを発明せず、削除の前に STOP する (throw)。
 *
 * 同一 context キーの重複は解釈が同一なら 1 つに畳み、食い違えば STOP
 * (黙って上書きしない。削除の前なので何も書かずに止まる)。
 */
export function planCarry(rows: readonly CarrySourceRow[]): CarryPlan {
  const carried = new Map<string, CarriedInterpretation>();
  const nulledKeys = new Set<string>();
  const promotedKeys = new Set<string>();
  for (const row of rows) {
    if (row.shortSummary == null && row.estimatedValue == null) continue;
    const key = carryKey(row.code, row.description, row.minShares, row.recordMonth);
    let estimatedValue = row.estimatedValue;
    let estimateValueSource = row.estimateValueSource;
    if (estimatedValue !== null) {
      if (estimateValueSource !== "company" && estimateValueSource !== null) {
        throw new Error(
          `未対応の出典の値は持ち越さず STOP (code=${row.code} ` +
            `minShares=${row.minShares} recordMonth=${row.recordMonth} ` +
            `source=${estimateValueSource} value=${estimatedValue}。` +
            `role の扱いを決めるまで削除も再 INSERT もしない)`
        );
      }
      const verdict = qualifyCompanyPerGrantValue(row.description, estimatedValue, {
        minShares: [row.minShares],
        recordMonths: [row.recordMonth],
      });
      if (!verdict.qualified) {
        estimatedValue = null;
        estimateValueSource = null;
        nulledKeys.add(key);
      } else if (estimateValueSource === null) {
        estimateValueSource = "company";
        promotedKeys.add(key);
      }
    }
    const prev = carried.get(key);
    if (prev !== undefined) {
      if (
        prev.shortSummary !== row.shortSummary ||
        prev.estimatedValue !== estimatedValue ||
        prev.estimateValueSource !== estimateValueSource
      ) {
        throw new Error(
          `同一 context の解釈が食い違うため STOP (code=${row.code} ` +
            `minShares=${row.minShares} recordMonth=${row.recordMonth} ` +
            `values=${String(prev.estimatedValue)}/${String(estimatedValue)} ` +
            `sources=${String(prev.estimateValueSource)}/${String(estimateValueSource)})`
        );
      }
      continue;
    }
    carried.set(key, {
      shortSummary: row.shortSummary,
      estimatedValue,
      estimateValueSource,
    });
  }
  return { carried, nulledKeys, promotedKeys };
}

export type YutaiFullImportResult = {
  /** 取り込んだ母集団の銘柄数。 */
  stockCount: number;
  /** 作った優待行の数。 */
  benefitCount: number;
  /** 取得したが母集団に無く、取り込まなかったコード (既存の優待行には触っていない)。 */
  outOfUniverse: string[];
  /** 優待行を持っていたのに今回取得できず、優待行を消した母集団の銘柄数。 */
  abolishedCount: number;
  /** 退避した解釈 (内容キー) のうち、今回の行に戻せず消えた数。 */
  droppedInterpretations: number;
  /** 取り込みに失敗したコード。 */
  failedCodes: string[];
  /** post-image の利回り・スコア再計算 (write/end・write-error/end に 1 回だけ)。 */
  recompute: {
    updated: number;
    scoresUpdated: number;
    /** 財務行が無く対象外 (counts explicit)。 */
    skippedNoRow: number[];
    /** スコア行が無くスコアだけ対象外。 */
    skippedNoScore: number[];
  };
};

/**
 * 1 銘柄の取得結果から作る優待行 (権利月 × 株数条件)。掲載文は全文保存する。
 *
 * 旧 notes[:200]/desc[:500] の切り詰めは 3447 の 3 群で末尾の tier 条件を
 * 落とした (保存文が文の途中で切断。要約の根拠消失)。D1 の description 列は
 * TEXT 型で長さ制限が無いため、切り詰める理由は無い。以降の similar source も
 * この共通経路 (切り詰め無し) を使うこと。
 */
export function benefitRowsOf(
  data: StockYutaiData,
): { recordMonth: number; minShares: number; description: string }[] {
  const rows: { recordMonth: number; minShares: number; description: string }[] = [];
  for (const month of data.recordMonths) {
    for (const benefit of data.benefits) {
      const desc = benefit.notes ? `${benefit.description}\n${benefit.notes}` : benefit.description;
      rows.push({ recordMonth: month, minShares: benefit.minShares, description: desc });
    }
  }
  return rows;
}

/**
 * 取得結果で、母集団の銘柄の優待を作り直す。母集団外の銘柄の優待には触らない。
 * 止める条件はファイル先頭のコメント。
 *
 * 書き込みの終わり (write/end) と書き込み失敗時 (write-error/end) に、実際の
 * post-image から利回り・スコアを 1 回だけ再計算して追随させる (既存の共有
 * builders のみ。新規の financial SQL/計算は持たない)。書き込み前の STOP
 * (coverage・carry preflight 等) では走らせない。`sender` は必須の 1 注入
 * (本番は `createD1HttpBatchSender()`。省略時の silent skip はしない)。
 * 個別銘柄の失敗が残れば、再計算の適用後に明示の部分失敗を投げる
 * (成功結果は返さない)。銘柄は全行の成功でのみ imported に数える。
 */
export async function importYutaiFull(
  db: YutaiFullImportDb,
  allData: StockYutaiData[],
  sender: AtomicBatchSender,
): Promise<YutaiFullImportResult> {
  // ---- 読み取り (ここから「書き込み」までは D1 に書かない) ----

  // 母集団と is_yutai を 1 回で引く。1 コードずつ引く形 (約 1,600 往復) にしない。
  // rows_read は is_active の索引で母集団の行数ぶん (本番 2026-09-14 で 3,700)。
  const universe = await db
    .select({ id: stocks.id, code: stocks.code, isYutai: stocks.isYutai })
    .from(stocks)
    .where(activeEquityCondition());
  const universeByCode = new Map(universe.map((s) => [s.code, s]));

  const targets: { data: StockYutaiData; stockId: number; wasYutai: boolean }[] = [];
  const outOfUniverse: string[] = [];
  for (const data of allData) {
    const stock = universeByCode.get(data.code);
    if (stock === undefined) outOfUniverse.push(data.code);
    else targets.push({ data, stockId: stock.id, wasYutai: stock.isYutai });
  }
  console.info(
    `  取り込み先の銘柄: ${targets.length}件 / 母集団 (active かつ equity) に無く飛ばす: ${outOfUniverse.length}件`,
  );
  if (outOfUniverse.length > 0) {
    console.warn(
      `  飛ばすコード (既存の優待行には触らない): ${outOfUniverse.slice(0, 30).join(", ")}${outOfUniverse.length > 30 ? " ..." : ""}`,
    );
  }
  if (targets.length === 0) {
    throw new Error(
      `取り込み先の銘柄が 1 件もありません (取得 ${allData.length} 件がすべて core_stocks の` +
        ` active かつ equity に無い)。優待データは削除していません。` +
        ` core_stocks の is_active / instrument_type を確認してください。`,
    );
  }

  // 母集団の銘柄の既存の優待行。消すのはこの行だけで、解釈もこの行から退避する。
  const existing = await db
    .select({
      stockId: yutaiBenefits.stockId,
      code: stocks.code,
      description: yutaiBenefits.description,
      minShares: yutaiBenefits.minShares,
      recordMonth: yutaiBenefits.recordMonth,
      shortSummary: yutaiBenefits.shortSummary,
      estimatedValue: yutaiBenefits.estimatedValue,
      estimateValueSource: yutaiBenefits.estimateValueSource,
    })
    .from(yutaiBenefits)
    .innerJoin(stocks, eq(stocks.id, yutaiBenefits.stockId))
    .where(activeEquityCondition());

  const heldIds = new Set(existing.map((r) => r.stockId));
  const targetIds = new Set(targets.map((t) => t.stockId));
  const retained = [...heldIds].filter((id) => targetIds.has(id)).length;
  const abolishedCount = heldIds.size - retained;
  console.info(
    `  優待行を持つ母集団の銘柄: ${heldIds.size}件 / うち今回も取得: ${retained}件 / 取得できず優待行を消す: ${abolishedCount}件`,
  );
  // 整数で比べる (retained / held < 0.95 を浮動小数で比べない)。
  if (retained * 100 < heldIds.size * MIN_YUTAI_COVERAGE_PERCENT) {
    throw new Error(
      `優待行を持つ母集団の銘柄 ${heldIds.size} 件のうち、今回取得できたのは ${retained} 件で` +
        ` ${MIN_YUTAI_COVERAGE_PERCENT}% 未満です。取得の大量失敗とみなし、優待データは削除していません。` +
        ` 個別ページの取得失敗 (HTTP 429 等) と一覧ページの走査を確認してください。`,
    );
  }

  // 作り直せない解釈を退避する。short_summary / estimated_value はクラウド LLM 要約の
  // 取り込み (import-summary-results.ts) の産物で、この取込の INSERT では値を作れない
  // (掲載文 description は公開面に出せないため代わりが無い)。キーは (銘柄コード,
  // description, 株数, 権利月) の内容アドレスなので、context が変わらない限り
  // 作り直した行に戻せる。計画は純関数 `planCarry` (要約取込と同じ共有厳密判定)。
  const { carried, nulledKeys, promotedKeys } = planCarry(existing);

  const planned = targets.map((t) => ({
    ...t,
    genreSlug: guessGenreSlug(t.data.category, t.data.benefits.map((b) => b.description).join(" ")),
    rows: benefitRowsOf(t.data),
  }));
  const plannedKeys = new Set(
    planned.flatMap((p) => p.rows.map((r) => carryKey(p.data.code, r.description, r.minShares, r.recordMonth))),
  );
  const droppedInterpretations = [...carried.keys()].filter((k) => !plannedKeys.has(k)).length;
  console.info(`  既存の解釈を退避: ${carried.size}件`);
  if (nulledKeys.size > 0) {
    // 共有厳密判定に落ちた値 (tier-pick・選択肢・概算・根拠なし等) は要約だけ
    // 戻し、値ごと null で戻す (source 付け替えで値を温存しない)。
    // null は有効な終端状態なので再 task 化は要らない。
    console.warn(`  不認定の推定値を null で戻す (要約は保持): ${nulledKeys.size}件`);
  }
  if (promotedKeys.size > 0) {
    console.info(`  厳密判定を通過した legacy-null を company に昇格: ${promotedKeys.size}件`);
  }
  if (droppedInterpretations > 0) {
    // 掲載文が変わった行と、優待行を消す銘柄の分。前者は未解釈で入り、次の要約タスク
    // 書き出し (export-summary-tasks.ts) の対象になる。
    console.warn(`  戻せない解釈 (掲載文の変更・優待行を消す銘柄): ${droppedInterpretations}件`);
  }

  // post-image の利回り・スコア追随 (write/end・write-error/end に 1 回だけ呼ぶ)。
  // scope は「優待行を持っていた銘柄 ∪ 今回取得 ∪ 利回りが残る銘柄」。
  // 廃止・中断再入の stale 利回りを直す。全銘柄には広げない。
  // 計算・ガード・適用は同一読取 (fetch → compute → snapshot → apply)。
  // 書くのは yield + fetched_at / score3 だけで、price・data_date 等は触らない
  // (buildYieldScoreStatements の既存契約)。
  const codeById = new Map(universe.map((s) => [s.id, s.code]));
  const runPostImageRecompute = async (): Promise<YutaiFullImportResult["recompute"]> => {
    const withYield = await db
      .select({ stockId: stockFinancials.stockId })
      .from(stockFinancials)
      .where(isNotNull(stockFinancials.yutaiYield));
    const scope = [
      ...new Set([
        ...heldIds,
        ...targetIds,
        ...withYield.map((r) => r.stockId).filter((id) => codeById.has(id)),
      ]),
    ].sort((a, b) => a - b);
    const inputs = await fetchYieldInputs(db, scope);
    const plan = computeYieldEntries(scope, inputs);
    const codeOf = (stockId: number): string => codeById.get(stockId) ?? `stock:${stockId}`;
    for (const line of formatRecomputeReport(plan, codeOf)) console.info(`  ${line}`);
    const { updated, scoresUpdated } = await applyYieldRecomputeAtomically(
      sender,
      plan,
      snapshotStockPreimages(inputs, scope)
    );
    console.info(`  利回り再計算を適用: ${updated}銘柄 / スコア: ${scoresUpdated}銘柄`);
    return { updated, scoresUpdated, skippedNoRow: plan.skippedNoRow, skippedNoScore: plan.skippedNoScore };
  };

  // ---- 書き込み (この中の失敗は post-image 再計算の後、元の失敗を投げ直す) ----

  let benefitCount = 0;
  const importedIds = new Set<number>();
  const failedCodes: string[] = [];
  try {
    // ジャンルは slug で upsert し、消さない。母集団外の優待行が genre_id で参照しており
    // (外部キー ON DELETE no action)、id も変えない。
    const genreIds = new Map<string, number>();
    for (const g of YUTAI_GENRES) {
      const [row] = await db
        .insert(yutaiGenres)
        .values(g)
        .onConflictDoUpdate({
          target: yutaiGenres.slug,
          set: { name: g.name, description: g.description },
        })
        .returning({ id: yutaiGenres.id });
      genreIds.set(g.slug, row.id);
    }

    console.info(
      `  母集団の銘柄の優待行を削除中 (${heldIds.size}銘柄。母集団外の優待行と core_stocks は保持)...`,
    );
    const deleteIds = [...heldIds];
    for (let i = 0; i < deleteIds.length; i += ID_CHUNK) {
      await db
        .delete(yutaiBenefits)
        .where(inArray(yutaiBenefits.stockId, deleteIds.slice(i, i + ID_CHUNK)));
    }

    for (const p of planned) {
      try {
        const genreId = genreIds.get(p.genreSlug);
        if (genreId === undefined) {
          throw new Error(`ジャンル ${p.genreSlug} が YUTAI_GENRES にありません`);
        }

        // 各権利月 × 各株数条件で優待レコードを作成
        for (const r of p.rows) {
          // 同じ (銘柄, 文言, 株数, 権利月) なら退避した解釈をそのまま戻す。
          // 新規/文言変更/context 変更は未解釈のまま入り、次の要約タスク書き出し
          // (export-summary-tasks.ts) の対象になる。
          const previous = carried.get(carryKey(p.data.code, r.description, r.minShares, r.recordMonth));
          await db.insert(yutaiBenefits).values({
            stockId: p.stockId,
            genreId,
            description: r.description,
            shortSummary: previous === undefined ? null : previous.shortSummary,
            minShares: r.minShares,
            recordMonth: r.recordMonth,
            estimatedValue: previous === undefined ? null : previous.estimatedValue,
            estimateValueSource: previous === undefined ? null : previous.estimateValueSource,
          });
          benefitCount++;
        }
        // 全行の成功でのみ imported に数える (INSERT 失敗銘柄の imported 混入は
        // 全件失敗ガードの回避になる)。is_yutai も成功銘柄だけ立てる。
        // name / market は書かない (core_stocks の同期 src/cron/universe.ts が書く列で、
        // 優待の取込が上書きするものではない)。
        if (!p.wasYutai) {
          await db
            .update(stocks)
            .set({ isYutai: true, updatedAt: sql`(unixepoch())` })
            .where(and(eq(stocks.id, p.stockId), eq(stocks.isYutai, false)));
        }
        importedIds.add(p.stockId);
      } catch (e) {
        // 個別銘柄の失敗は握り潰さず記録する (CLAUDE.md ルール2: オペレータ通知)
        failedCodes.push(p.data.code);
        console.error(`  [warn] ${p.data.code} の取り込み失敗:`, e instanceof Error ? e.message : e);
      }
    }

    // 全件失敗 = DB が壊れている。後処理で優待銘柄を false に落とすと otakara が全滅する
    // ので早期 throw する (ルール2: 早期失敗)。
    if (importedIds.size === 0) {
      throw new Error(
        `優待銘柄を 1 件も取り込めませんでした (失敗 ${failedCodes.length} 件)。` +
          `DB 接続を確認してください。`,
      );
    }

    // 後処理: 今回取り込めなかった母集団の優待銘柄を is_yutai=false へ (優待の廃止。
    // core_stocks の行は残す)。母集団外は触らない。読み直さず、先頭で引いた母集団の
    // is_yutai を使う (今回立てた銘柄は importedIds に入っている)。
    const toFalseIds = universe.filter((s) => s.isYutai && !importedIds.has(s.id)).map((s) => s.id);
    for (let i = 0; i < toFalseIds.length; i += ID_CHUNK) {
      await db
        .update(stocks)
        .set({ isYutai: false, updatedAt: sql`(unixepoch())` })
        .where(inArray(stocks.id, toFalseIds.slice(i, i + ID_CHUNK)));
    }

    if (failedCodes.length > 0) {
      console.warn(
        `  取り込み失敗 ${failedCodes.length} 件: ${failedCodes.slice(0, 30).join(", ")}${
          failedCodes.length > 30 ? " ..." : ""
        }`,
      );
    }

  } catch (e) {
    // write-error/end: 部分書き込みの実像で再計算を 1 回だけ試みる。
    // 回復も失敗したら両方を保つ。成功完了はログしない (throw のみ)。
    try {
      await runPostImageRecompute();
    } catch (recomputeError) {
      throw new AggregateError(
        [e, recomputeError],
        "書き込み失敗後の利回り再計算も失敗しました (両方を確認してください)",
        { cause: recomputeError }
      );
    }
    throw e;
  }

  // write/end: 実際の post-image から利回り・スコアを 1 回だけ追随させる。
  // ここでの失敗はそのまま throw し (再試行しない)、成功結果も成功ログも出さない。
  const recompute = await runPostImageRecompute();

  // 部分失敗は成功完了にしない。再計算は適用済みなので、失敗銘柄の確認と
  // 再実行を促して明示的に落とす (再計算の再試行はしない。scope は attempted
  // のまま保持し、失敗銘柄も post-image 修復の対象に含めている)。
  if (failedCodes.length > 0) {
    throw new Error(
      `優待の取り込みに ${failedCodes.length} 件失敗しました ` +
        `(${failedCodes.slice(0, 30).join(", ")}${failedCodes.length > 30 ? " ..." : ""})。` +
        `利回り再計算は post-image に適用済みです。失敗銘柄を確認して再実行してください。`
    );
  }

  return {
    stockCount: importedIds.size,
    benefitCount,
    outOfUniverse,
    abolishedCount,
    droppedInterpretations,
    failedCodes,
    recompute,
  };
}
