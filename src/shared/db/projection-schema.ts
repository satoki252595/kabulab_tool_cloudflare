/**
 * L2 投影層（`p_*`）— 画面が読む断面。**暫定の置き場**。
 *
 * ## なぜ表を 1 本足すのか
 *
 * `/financial-math/emh?type=momentum` は 1 表示で `swing_daily_ohlcv` を
 * 全走査していた。**本番実測 (kabulab-cf, 2026-09-13): 集計クエリ単体で
 * 647,628 rows_read / 306,865 行返却 / 669〜725 ms**、1 リクエスト合計で
 * 651,494（= 3,715 + 1 + 647,628 + 150）。TTFB 0.86〜1.01 秒で、他 13 経路は
 * 42〜195 ms。D1 は走査行課金なので、これは訪問者 1 人ごとに払う継続コストである。
 *
 * 内訳は「索引エントリ + TEMP B-TREE ソータへ流れた行」であって、
 * **テーブル行フェッチではない**。同じ計画・同じ WHERE で `o.close`（索引外）を
 * SELECT 句から抜いた場合と入れた場合の rows_read は**どちらも 674,097** で完全に
 * 同値だった（本番対照実験 2026-09-13）。`WHERE o.close IS NOT NULL` を付けると
 * 647,628 に下がるのは、ソータへ入る行が 334,213 → 306,865 に減るからである。
 * つまり **D1 は被覆されない列のテーブル行フェッチを rows_read に計上しない**
 * （CLAUDE.md の前提どおり。`SEARCH ... USING INDEX` の計画でも同じ）ので、
 * 被覆索引 `(stock_id, date, close)` を足しても 0% しか減らない。
 * 日付条件も効かない（`idx_swing_ohlcv_date` が `ORDER BY stock_id, date` に負ける）。
 *
 * 残る手は**事前集計（投影）**だけ。銘柄ごとに 1 行へ畳んでおけば、画面の走査は
 * 336,169 行 → **is_active な銘柄数（実測 3,715）**になる。
 * （`swing_daily_ohlcv` の `DISTINCT stock_id` は 3,764 だが、投影は
 * `core_stocks.is_active` で絞るので行数は 3,715 が上限。）
 *
 * ## なぜ「指標値」ではなく「終値列」を持つのか
 *
 * `/emh` の window は UI で可変（20〜100、`step=5`）。保持が 90 営業日なので
 * 実効上限は約 89 で、100 本以上あるのは 4 銘柄だけ — それでも可変であること自体が
 * 画面の機能である。
 *
 * 採らなかった案:
 *   - **window 20/60 の 2 列に固定**: 走査行は同じだけ減るが、UI の可変 window が
 *     消える。「実データが 89 本しかないから 100 は要らない」は正しいが、
 *     20〜89 の任意値が要らない理由にはならない。
 *   - **(stock_id, window) を行に展開**: window を 5 刻み 17 通りにしても
 *     17 × 3,715 = 約 63,000 行/日の書き込みになる（現状の日次書込 ~3 万行の 2 倍超）。
 *     読み取りは同じく約 3,715 行に落ちるが、書込を倍増させて読取を同量下げるのは
 *     このレーンの制約（継続コストを増やさない）に反する。
 *   - **終値列を R2 へ置く**: `docs/TARGET-ARCHITECTURE.md §4.4` の本来の形だが、
 *     R2 系列（`facts/price_daily/{code}/{yyyy}.ndjson.gz`）はまだ無い。
 *     R2 を新設すればオブジェクト数と総バイトが増える。
 *
 * 採った案は「**保持されている終値列そのものを 1 行に畳む**」。`calcMomentum` は
 * 終値配列と window を受ける純関数のままで、window 可変性は完全に保たれ、
 * 表示される数値は投影の前後で**一致する**（同じ入力・同じ関数）。
 * 1 行あたり約 90 個の終値 ≒ 700 B、全体で約 2.6 MB。
 *
 * ## 恒久化しないための条件（これを満たすまで暫定）
 *
 * この表は「D1 に長い時系列を置かない」という最も強い制約（§4.4）の**例外**である。
 * 1 銘柄 1 行なので全走査しても 3,715 行だが、中身は時系列であることに変わりない。
 * 次の 3 つが揃った時点でこの表は**消す**こと:
 *
 *   1. `facts/price_daily/{code}/{yyyy}.ndjson.gz` が R2 に存在し、横断集計の
 *      入力として読める
 *   2. `packages/derive`（純関数層）と L2 の commit gate が入り、投影の生成が
 *      cron のフェーズではなく宣言（`defineProjection`）になっている
 *   3. `/emh` が「window 可変」をやめる、または derive 側で window ごとの
 *      指標列を持てる（= 終値列を画面へ運ばなくて済む）
 *
 * それまでの間、この表に**列を足さない**。足したくなったらそれは
 * 「投影が第 2 の真実になり始めた」合図で、上の 3 条件を先に片付ける方が安い。
 *
 * ## 置き場の選択理由
 *
 * `finmath_*`（004 所有）には置かない。writer は共有の日次 cron
 * (`src/cron/daily.ts`、Node 実行) で、004 の Worker ではない。
 * `core_*` にも置かない（あちらは「取得した生に近い一次情報」）。
 * §4.1 が定めた接頭辞 `p_` をそのまま使い、宣言をここへ独立させる。
 * commit gate が無いので接頭辞は現時点では**規約に過ぎない**。
 */
import { sql } from "drizzle-orm";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

/**
 * モメンタム投影 — 1 銘柄 1 行。
 *
 * L2 の契約（§4.1）に従い、キーは (stock_id) のみ・`as_of` / `source_max_date` は
 * NOT NULL・原本への外部キー参照は持たない（`core_stocks` への FK を張ると
 * 「投影が原本を参照する」ことになり、全消し再生成の順序制約が生まれる）。
 */
export const momentumProjection = sqliteTable("p_momentum", {
  /** `core_stocks.id`。FK は張らない（上のコメント参照）。 */
  stockId: integer("stock_id").primaryKey(),
  /** この銘柄の最新バー日付 'YYYY-MM-DD'。銘柄単位の鮮度。 */
  asOf: text("as_of").notNull(),
  /**
   * 生成時の `MAX(swing_daily_ohlcv.date)` 'YYYY-MM-DD'。データセット全体の鮮度。
   * `as_of` との差が「この銘柄だけ取得が止まっている」ことを示す。
   */
  sourceMaxDate: text("source_max_date").notNull(),
  /**
   * `closes` の要素数。window の実効上限を画面へ出すために持つ
   * (`closes` を数えれば同じだが、`MAX(bars)` を 1 クエリで取れる方が安い)。
   */
  bars: integer("bars").notNull(),
  /**
   * 終値 CSV（**古い順**）。`null` 終値と非活動銘柄は生成時に落とすので、
   * ここには有効な正の終値だけが並ぶ。`calcMomentum` の入力そのもの。
   */
  closes: text("closes").notNull(),
  /**
   * 生成時刻（epoch 秒）。「今回の run で書き直されなかった行」= 母集団から
   * 落ちた銘柄を 1 文の DELETE で掃除するために使う（全消し→全挿入の 2 倍の
   * 書き込みを避けるため）。
   */
  computedAt: integer("computed_at", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .notNull(),
});

export type MomentumProjection = typeof momentumProjection.$inferSelect;
