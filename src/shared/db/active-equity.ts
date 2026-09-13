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
 * - 外から観測できるのは「その銘柄が一覧に載るかどうか」の 1 bit だけ。同じ
 *   JPX 由来の `is_active` は既に公開面の述語に使っており、同じ種類の情報である。
 * - 結論: 述語としての利用は、**この helper 1 箇所を経由する場合に限って**認める。
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
import { and, eq, type SQL } from "drizzle-orm";
import { INSTRUMENT_TYPE_EQUITY } from "../jpx/instrument-type.js";
import { stocks } from "./core-schema.js";

/** `core_stocks.is_active = 1 AND core_stocks.instrument_type = 'equity'` (値は bind)。 */
export function activeEquityCondition(): SQL {
  return and(
    eq(stocks.isActive, true),
    eq(stocks.instrumentType, INSTRUMENT_TYPE_EQUITY)
  ) as SQL;
}
