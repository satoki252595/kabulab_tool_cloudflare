/**
 * L2 投影層 (`p_*`) — 画面が読む断面。**暫定の置き場** (経緯は git 履歴)。
 * 画面の全走査を cron の事前集計へ移し、1 銘柄 1 行に畳む。終値列そのものを
 * 持つのは `/emh` の window 可変を保つため (指標値に固定しない)。
 * writer は共有の日次 cron (Node)。`core_*` でも `finmath_*` でもなく宣言を独立させる。
 *
 * ## 恒久化しないための条件 (これを満たすまで暫定。残す)
 *
 * この表は「D1 に長い時系列を置かない」という最も強い制約の**例外**である。
 * 次の 3 つが揃った時点でこの表は**消す**こと:
 *   1. `facts/price_daily/{code}/{yyyy}.ndjson.gz` が R2 に存在し読める
 *   2. 純関数層と L2 の commit gate が入り、生成が宣言になっている
 *   3. `/emh` が window 可変をやめる、または derive 側で指標列を持てる
 * それまでの間、この表に**列を足さない**。
 */
import { sql } from "drizzle-orm";
import { sqliteTable, integer, real, text } from "drizzle-orm/sqlite-core";

/**
 * モメンタム投影 — 1 銘柄 1 行。
 *
 * L2 の契約に従い、キーは (stock_id) のみ・`as_of` / `source_max_date` は
 * NOT NULL・原本への FK は持たない (全消し再生成の順序制約を避ける)。
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

/**
 * 有報成長性投影 — 1 銘柄 1 行 (L-51/K4b)。
 *
 * 訂正対応の畳み込みを EDINET catchup の末尾で事前集計し、画面はこの表を引く。
 *
 * 不変条件 (地域窓の一致): 地域選択時の年窓は「合計行だけの窓」と一致する。
 * パーサ (overseas-parser.ts の 2 経路) は地域行と合計行 (overseas_total /
 * total) を同一 parse の成功時に原子的に出し、失敗時は行を出さない。
 * よって最新提出に地域行がある会計期末は必ず合計行を持ち、地域指定の有無で
 * 年窓も first/last も変わらない (本番実測: 合計行の無い (stock, fy) の
 * 地域行は 0 件)。地域比率は末端 fy の地域円貨 4 列と last_total から
 * 読み側で `+(yen/total*100).toFixed(1)` 復元し、従来式と一致する。
 */
export const yuhoGrowthProjection = sqliteTable("p_yuho_growth", {
  /** `core_stocks.id`。FK は張らない (p_momentum と同じ理由)。 */
  stockId: integer("stock_id").primaryKey(),
  // ---- 受注 (segment_kind='total' の全社合計) ----
  /** 直近 5 年窓の会計期末数。minYears の判定に使う */
  ordYears: integer("ord_years").notNull(),
  ordFirstFy: text("ord_first_fy").notNull(),
  ordLastFy: text("ord_last_fy").notNull(),
  ordFirstOrdersYen: integer("ord_first_orders_yen", { mode: "number" }),
  ordLastOrdersYen: integer("ord_last_orders_yen", { mode: "number" }),
  ordFirstBacklogYen: integer("ord_first_backlog_yen", { mode: "number" }),
  ordLastBacklogYen: integer("ord_last_backlog_yen", { mode: "number" }),
  /** 年平均成長率 (小数)。基準<=0 や暦年差 0 は null */
  ordOrdersCagr: real("ord_orders_cagr"),
  ordBacklogCagr: real("ord_backlog_cagr"),
  /** 直近前年比 (小数) */
  ordOrdersYoy: real("ord_orders_yoy"),
  ordBacklogYoy: real("ord_backlog_yoy"),
  /** データ点数 < 暦年差+1 (=途中年が欠落) */
  ordHasYearGap: integer("ord_has_year_gap", { mode: "boolean" }).notNull(),
  // ---- 海外売上 (overseas_total / total + 地域バケット) ----
  ovsYears: integer("ovs_years").notNull(),
  ovsFirstFy: text("ovs_first_fy").notNull(),
  ovsLastFy: text("ovs_last_fy").notNull(),
  ovsFirstOverseasYen: integer("ovs_first_overseas_yen", { mode: "number" }),
  ovsLastOverseasYen: integer("ovs_last_overseas_yen", { mode: "number" }),
  ovsLastTotalYen: integer("ovs_last_total_yen", { mode: "number" }),
  /** 海外売上高比率 (%)。toFixed(1) 済みの値をそのまま持つ */
  ovsFirstRatioPct: real("ovs_first_ratio_pct"),
  ovsLatestRatioPct: real("ovs_latest_ratio_pct"),
  ovsOverseasCagr: real("ovs_overseas_cagr"),
  ovsOverseasYoy: real("ovs_overseas_yoy"),
  ovsHasYearGap: integer("ovs_has_year_gap", { mode: "boolean" }).notNull(),
  /** overseas_total 行を持つ (プルダウンの母集団。total 行だけの銘柄と区別) */
  ovsHasOverseasTotal: integer("ovs_has_overseas_total", { mode: "boolean" }).notNull(),
  /** 末端 fy の地域バケット円貨 (単独合致行のみ合計。未開示は null) */
  ovsRegionChinaYen: integer("ovs_region_china_yen", { mode: "number" }),
  ovsRegionAmericasYen: integer("ovs_region_americas_yen", { mode: "number" }),
  ovsRegionEuropeYen: integer("ovs_region_europe_yen", { mode: "number" }),
  ovsRegionAsiaYen: integer("ovs_region_asia_yen", { mode: "number" }),
  // ---- 来歴 (p_momentum と同じ規約) ----
  /** 再生成日 'YYYY-MM-DD' */
  asOf: text("as_of").notNull(),
  /** 生成時の `MAX(yuho_documents.submitted_at)` 日付 'YYYY-MM-DD' */
  sourceMaxDate: text("source_max_date").notNull(),
  /**
   * 生成時刻 (epoch 秒)。「今回の run で書き直されなかった行」を 1 文の
   * DELETE で掃除するために使う。
   */
  computedAt: integer("computed_at", { mode: "timestamp" })
    .default(sql`(unixepoch())`)
    .notNull(),
});

export type YuhoGrowthProjection = typeof yuhoGrowthProjection.$inferSelect;
