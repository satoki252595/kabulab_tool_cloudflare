/**
 * 日次取込と公開面の一覧が共有する**母集団の述語** —
 * `core_stocks` の「上場中 (`is_active = 1`) かつ内国普通株 (`instrument_type = 'equity'`)」。
 *
 * ## 1. 母集団は何か
 *
 * 次の 2 つが**同じ集合**を見るための述語である。
 *
 * - **日次取込**: src/cron/daily.ts の処理対象 (`loadDailyTargets`)、業種集計の
 *   分母と分子 (`aggregateSectorDaily`)、`p_momentum` の母集団
 *   (`rebuildMomentumProjection`)。日次の値を再利用する月次の otakara 再構築
 *   (src/cron/monthly.ts Phase 2) も含む。
 * - **それを読む公開面の一覧・検索・件数**: rsi-screening / swing-trading /
 *   financial-math / otakara-yutai / yuho-quant。
 * - **優待の取込** (2026-09-14 に追加): services/otakara-yutai の 3 経路。下の
 *   `findActiveEquityStockId` と、全量取込 (data-scripts/yutai-full-import.ts) の
 *   `activeEquityCondition()` を使う。優待の取込は、コードが `core_stocks` に無ければ
 *   行を足していた (区分が NULL の active 行になり、日次からも公開面からも外れたまま残る)。
 *
 * **TDnet 開示・EDINET 有報の取込は、この述語を使わない。** 使うのは下の
 * `ingestUniverseCondition()` / `loadIngestCodeToId()` で、非普通株と、区分が NULL の
 * active 行だけを除き、`is_active = 0` の銘柄は取り込む (理由はそちらの docstring)。
 *
 * 片方だけを絞ると分母と分子が別の集合になる。日次だけを絞って公開面を
 * `is_active` のままにすると、日次が更新しなくなった非普通株の凍結値が
 * 「今日の一覧」に並び続ける。業種集計の分母を `is_active` のまま P4b (+725 行)
 * を迎えると 3,700 / 4,434 = 83.4% で 90% カバレッジを割り、毎日スキップされる。
 *
 * 2026-09-13 のユーザー決定: P4b 第 2 段の前提として、日次の処理対象を普通株に
 * 絞る。絞らないと P4b の +725 行 (ETF/ETN 477・PRO 187・REIT 等 54・外国株 5 など)
 * で Actions の時間と D1 の書込が約 1.2 倍になる。
 *
 * ## 2. personal-only の `instrument_type` を述語に使ってよい理由 (ライセンス判断)
 *
 * - `instrument_type` は JPX data_j 由来で、**personal-only のまま変えない**。
 * - src/shared/db/public-columns.ts の方針は「personal-only の値を Worker に載せず、
 *   レスポンスにも出さない」である (例: `market` は SQL の `NULL` に潰し、列を
 *   select しない)。
 * - WHERE / ON は D1 の中で評価され、**値は Worker に返らない**。したがって
 *   この方針に反しない。
 * - 外から観測できるのは「その銘柄が一覧に載るかどうか」の 1 bit だけ。
 * - 公開面は既に `is_active` を述語に使っているが、**これはライセンス判断の前例では
 *   ない**。`is_active` は stockStock の列地図 (tests/fixtures/contracts/
 *   d1-license-map.json) に宣言が無い列で (cloud_store/schema.py が「派生元の判断が
 *   要る」として宣言を保留している)、地図の `$undeclared_policy` では「公開してよいと
 *   決まっていない」扱いである。
 * - 結論 (暫定): 述語としての利用は、**この helper 1 箇所を経由する場合に限って**
 *   認める。personal-only の列を公開面の母集団の述語に使うこと自体は、2026-09-14
 *   時点で**ユーザーの承認待ち** (PR #30 の「マージ前にユーザー判断が要るもの」)で、
 *   ライセンスの正本 (stockStock) にはまだ記録していない。
 *   src/shared/db/core-stocks-license-boundary.test.ts が、`instrumentType` を
 *   修飾つきで参照するファイルを src/cron/universe.ts (唯一の書き手) とこの
 *   ファイルだけに固定している。
 * - 引き続き禁止: 値を select すること。`market` / `sector` / `sector17` を
 *   述語に使うこと。
 *
 * ## 3. 使ってよいのは WHERE と JOIN の ON だけ
 *
 * `select` / `orderBy` / `groupBy` / 関係クエリ (`db.query.stocks.find*`) の
 * `columns` に `instrument_type` を出さないこと。select すれば値が Worker に載り、
 * 並び順やグループのキーにすれば区分ごとの内訳がレスポンスから読めてしまい、
 * 上の「1 bit だけ」が成り立たなくなる。
 *
 * ## 4. 「公開面も普通株だけ」はユーザー未回答の暫定前提
 *
 * スクリーニングや銘柄検索に ETF / REIT を出すかは、2026-09-13 時点でユーザーが
 * **まだ答えていない**。日次データが普通株だけになるので、公開面の一覧も普通株
 * だけにする (出さない) ことを暫定の前提にしている。前提が覆ったら、該当する
 * 呼び出し元をこの helper から `is_active` 単独へ戻すだけでなく、非普通株へ日次
 * データを供給する方法も決めること。一覧だけを戻すと、凍結した値が今日の値として
 * 並ぶ。
 *
 * ## 実装上の約束
 *
 * - 値は bind のまま (`sql.raw` にしない)。どの呼び出し元でも bind は +1 個だけで、
 *   D1 の上限 (100/文) には遠い。
 * - 呼ぶたびに新しい SQL を返す。モジュール定数の SQL インスタンスを全呼び出し元で
 *   共有しない (`inlineParams()` などインスタンスを書き換える API が他の呼び出し元へ
 *   波及するため)。
 * - D1 の rows_read は SELECT する列には依存しないが、クエリの形 (JOIN の順序・
 *   外側ループの選び方) で桁が変わる。src/cron/daily.ts の
 *   `rebuildMomentumProjection` の表のとおり、`core_stocks` を JOIN すると
 *   `is_active` の covering index を外側ループに選ばれて 1,190 万行を読んだ実例がある。
 *   新しい呼び出し元を足すときは、実際に発行される SQL で rows_read を測ること。
 */
import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { INSTRUMENT_TYPE_EQUITY } from "../jpx/instrument-type.js";
import { stocks } from "./core-schema.js";

/** `core_stocks.is_active = 1 AND core_stocks.instrument_type = 'equity'` (値は bind)。 */
export function activeEquityCondition(): SQL {
  return and(
    eq(stocks.isActive, true),
    eq(stocks.instrumentType, INSTRUMENT_TYPE_EQUITY)
  ) as SQL;
}

/**
 * `core_stocks` にアクセスできれば足りる最小の drizzle db 型。Worker のバインディング版
 * (DrizzleD1Database) と Node の D1 HTTP 版 (sqlite-proxy) のどちらも渡せる
 * (src/shared/db/core-repo.ts と同じ形)。
 */
type CoreDb = BaseSQLiteDatabase<"async", unknown, Record<string, unknown>>;

/**
 * **取込の母集団**の述語。TDnet 開示・EDINET 有報の取込が、証券コードから `stock_id` を
 * 引くときに使う。`instrument_type = 'equity' OR (is_active = 0 AND instrument_type IS NULL)`
 * (値は bind。呼ぶたびに新しい SQL を返すのは `activeEquityCondition()` と同じ)。
 *
 * ## `activeEquityCondition()` と分けた理由
 *
 * 2026-09-13 のユーザー決定は、日次取込と公開面から非普通株 (ETF・REIT・出資証券など) を
 * 外すことだけで、開示・有報の取込を上場中の銘柄に絞る決定ではない。
 *
 * `activeEquityCondition()` で引くと、`is_active = 0` の銘柄の開示・有報も入らなくなる。
 * `is_active = 0` は「東証の上場銘柄一覧に無い」行で、東証の上場廃止に加えて、地域取引所
 * (名証・札証・福証) にだけ上場を続ける会社も入る (src/shared/jpx/sectors.ts の
 * `isListedEquity` と src/cron/universe.ts の対象外化)。本番 2026-09-14 の実測で、直近 30 日に
 * そうした会社 15 社の、上場廃止に関係しないタイトルの開示が 22 件あった。ir-catalog の読み手
 * (一覧・検索・コード指定のタイムライン) はどの述語でも絞っていないので、その会社の既存の
 * 開示は表に出たまま、更新だけが止まる。
 *
 * だから取込は、変更前 (`core_stocks` の全行) の挙動を保ったまま、非普通株だけを除く。
 *
 * ## 取り込む行と取り込まない行
 *
 * | `is_active` | `instrument_type` | 取り込むか | どんな行か |
 * |---|---|---|---|
 * | 1 | `equity` | する | 上場中の内国普通株 |
 * | 0 | `equity` | する | 区分を書いた後に対象外化された普通株 |
 * | 0 | NULL | する | 区分を書く前に対象外化された行 (上場廃止・地域取引所の単独上場)。区分を NULL に書き換えられた後に対象外化された非普通株も入る (下記) |
 * | 1 | NULL | しない | 区分が未分類の active 行 (日次にも公開面にも居ない) |
 * | 1 / 0 | `equity` 以外 | しない | 非普通株 |
 *
 * - 区分の充填 (P4b 第 1 段) は active の行にだけ書いたので、区分が NULL の inactive 行が
 *   普通株かどうかは、この列からは分からない。変更前と同じく取り込む。
 * - 今の本番 (2026-09-14、非普通株 9 行の削除後) では、active の行はすべて `equity`、
 *   inactive の行はすべて NULL なので、変更前の全行 (3,810) と同じ集合になる。
 * - P4b 第 2 段が非普通株 (区分が非 NULL) を INSERT しても、その開示・有報は取り込まない。
 *   区分を持ったまま対象外化された非普通株も取り込まない。
 * - **既知の限界**: universe sync は、JPX の区分の表記が変わって分類できなくなった既存
 *   active の非普通株の区分を NULL (未分類) に書き換える (src/cron/universe.ts の
 *   `planInstrumentTypeUpdates`)。対象外化の書込は `instrument_type` に触らないので、その行が
 *   後で上場廃止などで対象外化されると `is_active = 0 AND instrument_type IS NULL` になり、
 *   取り込む側へ戻る。active の間は取り込まない。区分の表記変化は
 *   `countUnclassifiedCategories` が数える。塞ぐなら universe sync が「非 NULL → NULL」の
 *   書き換えをしない形にする (universe.ts の挙動変更で、この述語の範囲外)。
 * - 優待の取込は `activeEquityCondition()` のまま (`findActiveEquityStockId` と
 *   services/otakara-yutai/data-scripts/yutai-full-import.ts)。
 * - `is_active = 0` の開示・有報も止めるなら、`loadIngestCodeToId` の WHERE を
 *   `activeEquityCondition()` に替える 1 行で戻せる (そのときは ir-catalog の読み手を
 *   同じ述語で絞るかも決めること)。
 */
export function ingestUniverseCondition(): SQL {
  return or(
    eq(stocks.instrumentType, INSTRUMENT_TYPE_EQUITY),
    and(eq(stocks.isActive, false), isNull(stocks.instrumentType))
  ) as SQL;
}

/**
 * 取込 (TDnet 開示・EDINET 有報) 用の code → `stock_id` 表。母集団は
 * `ingestUniverseCondition()`。
 *
 * 表に無いコード (非普通株・区分が NULL の active 行・`core_stocks` に無い) は、
 * 呼び出し側でユニバース外として飛ばす。
 *
 * rows_read (本番 2026-09-14 実測、非普通株 9 行の削除後): 3,810 (`SCAN core_stocks`)。
 * 変更前の全行 SELECT も 3,810 (`core_stocks_code_unique` の covering index) で、増えない。
 * active かつ equity で絞る形 (3,700) より、inactive の行数ぶん多い。P4b の後も
 * 全行版と同じく `core_stocks` の行数ぶんを読む (非普通株の行も読むが、取り込まない)。
 */
export async function loadIngestCodeToId(db: CoreDb): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: stocks.id, code: stocks.code })
    .from(stocks)
    .where(ingestUniverseCondition());
  return new Map(rows.map((r) => [r.code, r.id]));
}

/**
 * 1 コードぶんの `stock_id`。母集団 (active かつ equity) に無ければ `null`。
 *
 * **`core_stocks` に行を足さない。** 以前の優待取込は、見つからなければ INSERT
 * していた。ここで `null` を返し、呼び出し側が件数を記録して飛ばす。
 *
 * rows_read (本番 2026-09-14 実測): 1。`code` の一意索引で引くので、絞らない形と同じ。
 */
export async function findActiveEquityStockId(db: CoreDb, code: string): Promise<number | null> {
  const rows = await db
    .select({ id: stocks.id })
    .from(stocks)
    .where(and(eq(stocks.code, code), activeEquityCondition()));
  return rows[0]?.id ?? null;
}
