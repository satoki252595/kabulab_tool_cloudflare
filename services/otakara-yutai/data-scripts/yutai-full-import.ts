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
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { activeEquityCondition } from "../../../src/shared/db/active-equity.js";
import { stocks, yutaiBenefits, yutaiGenres } from "../src/db/schema.js";
import { benefitKey } from "./benefit-key.js";

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

/** 退避した解釈 (要約取り込みの産物)。key は benefitKey(銘柄コード, description)。 */
type CarriedInterpretation = {
  shortSummary: string | null;
  estimatedValue: number | null;
};

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
};

/** 1 銘柄の取得結果から作る優待行 (権利月 × 株数条件)。掲載文の組み立てと切り詰めは以前のまま。 */
function benefitRowsOf(
  data: StockYutaiData,
): { recordMonth: number; minShares: number; description: string }[] {
  const rows: { recordMonth: number; minShares: number; description: string }[] = [];
  for (const month of data.recordMonths) {
    for (const benefit of data.benefits) {
      const desc = benefit.notes
        ? `${benefit.description}\n${benefit.notes.substring(0, 200)}`
        : benefit.description;
      rows.push({ recordMonth: month, minShares: benefit.minShares, description: desc.substring(0, 500) });
    }
  }
  return rows;
}

/**
 * 取得結果で、母集団の銘柄の優待を作り直す。母集団外の銘柄の優待には触らない。
 * 止める条件はファイル先頭のコメント。
 */
export async function importYutaiFull(
  db: YutaiFullImportDb,
  allData: StockYutaiData[],
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
      shortSummary: yutaiBenefits.shortSummary,
      estimatedValue: yutaiBenefits.estimatedValue,
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
  // description) の内容アドレスなので、文言が変わらない限り作り直した行に戻せる。
  const carried = new Map<string, CarriedInterpretation>();
  for (const row of existing) {
    if (row.shortSummary == null && row.estimatedValue == null) continue;
    // 同一キーが複数行 (権利月違い) ある。解釈は文言単位なのでどれでも同じ。
    carried.set(benefitKey(row.code, row.description), {
      shortSummary: row.shortSummary,
      estimatedValue: row.estimatedValue,
    });
  }

  const planned = targets.map((t) => ({
    ...t,
    genreSlug: guessGenreSlug(t.data.category, t.data.benefits.map((b) => b.description).join(" ")),
    rows: benefitRowsOf(t.data),
  }));
  const plannedKeys = new Set(
    planned.flatMap((p) => p.rows.map((r) => benefitKey(p.data.code, r.description))),
  );
  const droppedInterpretations = [...carried.keys()].filter((k) => !plannedKeys.has(k)).length;
  console.info(`  既存の解釈を退避: ${carried.size}件`);
  if (droppedInterpretations > 0) {
    // 掲載文が変わった行と、優待行を消す銘柄の分。前者は未解釈で入り、次の要約タスク
    // 書き出し (export-summary-tasks.ts) の対象になる。
    console.warn(`  戻せない解釈 (掲載文の変更・優待行を消す銘柄): ${droppedInterpretations}件`);
  }

  // ---- 書き込み ----

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

  let benefitCount = 0;
  const importedIds = new Set<number>();
  const failedCodes: string[] = [];

  for (const p of planned) {
    try {
      const genreId = genreIds.get(p.genreSlug);
      if (genreId === undefined) {
        throw new Error(`ジャンル ${p.genreSlug} が YUTAI_GENRES にありません`);
      }
      // is_yutai だけを、値が変わる銘柄だけ立てる。name / market は書かない
      // (core_stocks の同期 src/cron/universe.ts が書く列で、優待の取込が上書きするものではない)。
      if (!p.wasYutai) {
        await db
          .update(stocks)
          .set({ isYutai: true, updatedAt: sql`(unixepoch())` })
          .where(and(eq(stocks.id, p.stockId), eq(stocks.isYutai, false)));
      }
      importedIds.add(p.stockId);

      // 各権利月 × 各株数条件で優待レコードを作成
      for (const r of p.rows) {
        // 同じ (銘柄, 文言) なら退避した解釈をそのまま戻す。新規/文言変更は
        // 未解釈のまま入り、次の要約タスク書き出し (export-summary-tasks.ts) の対象になる。
        const previous = carried.get(benefitKey(p.data.code, r.description));
        await db.insert(yutaiBenefits).values({
          stockId: p.stockId,
          genreId,
          description: r.description,
          shortSummary: previous === undefined ? null : previous.shortSummary,
          minShares: r.minShares,
          recordMonth: r.recordMonth,
          estimatedValue: previous === undefined ? null : previous.estimatedValue,
        });
        benefitCount++;
      }
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

  return {
    stockCount: importedIds.size,
    benefitCount,
    outOfUniverse,
    abolishedCount,
    droppedInterpretations,
    failedCodes,
  };
}
