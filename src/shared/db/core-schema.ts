/**
 * 共有 core スキーマ（Cloudflare D1 / SQLite 版） — ADR-0001。
 *
 * Neon PostgreSQL の `core` スキーマ（services/rsi-screening/src/db/core-schema.ts）を
 * D1(SQLite) へ移行したもの。D1 は 1 DB = 1 SQLite で名前空間が無いため、旧
 * スキーマ名を接頭辞 `core_` に降ろしてテーブル名衝突を避ける。
 *
 * 所有権: 銘柄マスタ・財務の一次情報。Neon 版と同じく「Yahoo Finance 等から
 * 取得した生に近いデータ」のみ。テクニカル指標やスコアは各サービス側に置く。
 *
 * 方言マッピング（PostgreSQL → SQLite, ADR-0001 §4）:
 *   serial                         → integer primaryKey autoIncrement
 *   timestamp(withTimezone)+now()  → integer({mode:'timestamp'}) default unixepoch()
 *   date                           → text（'YYYY-MM-DD' 文字列のまま）
 *   boolean                        → integer({mode:'boolean'})
 *   real / doublePrecision         → real
 */
import { sql, relations } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * 銘柄マスタ（共有）
 *
 * ⚠️ **ライセンス境界**: `market` / `sector17` / `sector33` / `instrument_type` /
 * `license_tag` / `src_source` / `quality` は `personal-only`。公開面 (HTML /
 * JSON API) へ新たに出してはいけない。drizzle の既定 select は**全列返し**なので、
 * `db.select().from(stocks)` (列指定なし) はこれらを必ず含んだ行を返す。
 * 公開面で列指定なし select を使う場合は、必要フィールドだけを詰め替えること
 * (行の spread / JSON.stringify はしない)。
 * この約束は src/shared/db/core-stocks-license-boundary.test.ts が機械的に見ている。
 */
export const stocks = sqliteTable(
  "core_stocks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    market: text("market").notNull(),
    /**
     * **JPX 33業種の正本**。src/cron/universe.ts が JPX 東証上場銘柄一覧の
     * 33業種区分をこの列へ書いており (`sector: r.sector33`)、全サービスの
     * 読み出し口もここを見ている。
     *
     * 下の `sector33` は stockStock 側 (移行 P4a) が同じ 33業種を別名で足した列で、
     * **2026-09-12 時点で本番は全行 NULL**。値の置き場が 2 つあるので、
     * 「読むのは `sector`・書くのは `sector`」を守ること。詳細は `sector33` 側の
     * コメント。
     */
    sector: text("sector"),
    isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),
    /**
     * 株主優待を実施している銘柄か。母集団は東証内国普通株 (~3,700) だが、
     * 002 otakara-yutai は is_yutai=true のみを母集団とする。
     */
    isYutai: integer("is_yutai", { mode: "boolean" }).default(false).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),

    // -------------------------------------------------------------------------
    // 以下 12 列は stockStock 側の移行 P4a (2026-09-12) が本番 D1 へ直接 ALTER で
    // 足したもの。**本番の PRAGMA に合わせて全列 nullable / default なし**。
    // 型を勝手に notNull や default 付きにすると、この宣言から生成した DDL で
    // 作った非本番 DB だけが本番と違う形になる。
    // 2026-09-12 時点ではいずれも本番で全行 NULL (値を入れるのは P4b)。
    // -------------------------------------------------------------------------

    /** `personal-only`。内国普通株 / ETF / REIT 等の区分。 */
    instrumentType: text("instrument_type"),
    /**
     * `personal-only`。JPX 33業種。**正本は上の `sector`** で、こちらは P4b が
     * 埋めるまで全行 NULL。読む側は `sector` を見ること。両方に書く実装を足すと
     * 同じ値の置き場が 2 つになり、片方だけ更新された行を誰も検知できない。
     * 将来 `sector` をこちらへ寄せるなら、universe.ts の書き込みと全サービスの
     * 読み出しを同じ PR で移し、`sector` を落とすところまでやる。
     */
    sector33: text("sector33"),
    /** `personal-only`。JPX 17業種。33業種と違い `sector` に相当する既存列は無い。 */
    sector17: text("sector17"),
    /** EDINET コード。部分索引 idx_core_stocks_edinet が NOT NULL 行のみを張る。 */
    edinetCode: text("edinet_code"),
    /** 上場状態 (上場 / 上場廃止 等)。`is_active` とは別で、JPX 側の区分を保つ。 */
    listingStatus: text("listing_status"),
    /** 上場日 'YYYY-MM-DD'。ADR-0001 §4 に従い date は text。 */
    listingDate: text("listing_date"),
    /** 上場廃止日 'YYYY-MM-DD'。 */
    delistingDate: text("delisting_date"),
    /** `personal-only`。出所のライセンス区分。公開可否の判断そのものなので公開面に出さない。 */
    licenseTag: text("license_tag"),
    /** `personal-only`。取得元の識別子。 */
    srcSource: text("src_source"),
    /** 出所データの基準日 'YYYY-MM-DD'。 */
    srcDataDate: text("src_data_date"),
    /**
     * 取得時刻。本番は **epoch 秒** の INTEGER なので `mode: "timestamp"`。
     * `timestamp_ms` にすると読み書きが 1000 倍ずれる (1970年台 / 遠未来の日付になる)。
     */
    srcFetchedAt: integer("src_fetched_at", { mode: "timestamp" }),
    /** `personal-only`。行の品質区分。 */
    quality: text("quality"),
  },
  (table) => [
    // 本番に実在する 2 索引。以前は「drizzle 管理外」として宣言していなかったが、
    // それだと snapshot が索引 1 本のままで、ドリフト検査 (CI の db:generate:d1 +
    // git status) が「列は合っているが索引は嘘」の状態を緑と判定してしまう。
    index("idx_core_stocks_active_market").on(table.isActive, table.market),
    // 部分索引。本番の定義は `WHERE edinet_code IS NOT NULL`。
    index("idx_core_stocks_edinet")
      .on(table.edinetCode)
      .where(sql`${table.edinetCode} is not null`),
  ]
);

/** 最新ファンダメンタルズ（共有） */
export const stockFinancials = sqliteTable(
  "core_stock_financials",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    stockId: integer("stock_id")
      .references(() => stocks.id, { onDelete: "cascade" })
      .notNull()
      .unique(),
    price: real("price"),
    per: real("per"),
    pbr: real("pbr"),
    dividendYield: real("dividend_yield"),
    eps: real("eps"),
    bps: real("bps"),
    roe: real("roe"),
    roa: real("roa"),
    marketCap: real("market_cap"),
    /** 営業利益率 TTM。Yahoo `financialData.operatingMargins` の生値 (0.1234=12.34%) */
    operatingMargin: real("operating_margin"),
    dataDate: text("data_date").notNull(),
    fetchedAt: integer("fetched_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (table) => [index("idx_core_financials_stock_id").on(table.stockId)]
);

/**
 * 年度財務（共有） — 売上高の年度推移。
 * Yahoo が無料 API から operatingIncome を削除したため revenue のみ保持。
 *
 * この表には Yahoo 由来の既知の欠陥が 2 つ埋まっている (どちらも列では直していない)。
 *
 * 1. `revenue` は**連結と単体が混在**する。Yahoo の
 *    `incomeStatementHistory[].totalRevenue` をそのまま入れているが、Yahoo は期ごとに
 *    連結 (売上収益) と親会社単体の売上高を混ぜて返す。持株会社では単体が連結の
 *    2〜10% しかないため、同一銘柄の系列内に 10〜40 倍の段差が生まれる。
 *    → この列で売上トレンドを判定する側は
 *      `src/shared/indicators/blue-chip.ts` の `hasDefinitionBreak` で降りること。
 *
 * 2. `fiscal_year` は**銘柄間で意味が違う**。期末日 (endDate) を
 *    `getUTCFullYear()` で暦年に丸めているだけなので、3 月期企業の 2025 は
 *    和暦 2024 年度、12 月期企業の 2025 は 2025 年度を指す。
 *    → 銘柄をまたいだ「同じ fiscal_year 同士の比較」は成立しない。
 *      同一銘柄内の時系列としてのみ使う。
 *
 * どちらも列追加 (連結/単体フラグ・期末日) で直せるが、この表は
 * 「現状維持のまま、既存消費者を新しい正本へ向け終えたら DROP する」方針なので、
 * 寿命の短い表にスキーマ変更を積まない。
 */
export const stockAnnualFinancials = sqliteTable(
  "core_stock_annual_financials",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    stockId: integer("stock_id")
      .references(() => stocks.id, { onDelete: "cascade" })
      .notNull(),
    fiscalYear: integer("fiscal_year").notNull(),
    revenue: real("revenue"),
  },
  (table) => [
    uniqueIndex("idx_core_annual_stock_year").on(table.stockId, table.fiscalYear),
  ]
);

// --- Relations（dialect 非依存。Neon 版と同一） ---

export const stocksRelations = relations(stocks, ({ one, many }) => ({
  annualFinancials: many(stockAnnualFinancials),
  financials: one(stockFinancials, {
    fields: [stocks.id],
    references: [stockFinancials.stockId],
  }),
}));

export const stockFinancialsRelations = relations(stockFinancials, ({ one }) => ({
  stock: one(stocks, {
    fields: [stockFinancials.stockId],
    references: [stocks.id],
  }),
}));

export const stockAnnualFinancialsRelations = relations(
  stockAnnualFinancials,
  ({ one }) => ({
    stock: one(stocks, {
      fields: [stockAnnualFinancials.stockId],
      references: [stocks.id],
    }),
  })
);
