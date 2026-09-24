/**
 * 共有 core スキーマ (D1/SQLite)。銘柄マスタ・財務の一次情報
 * (「Yahoo Finance 等から取得した生に近いデータ」のみ。指標やスコアは各サービス側)。
 *
 * 方言マッピング (PostgreSQL → SQLite):
 *   serial / timestamp(tz)+now() / date / boolean → integer PK autoincrement /
 *   integer({mode:'timestamp'}) default unixepoch() / text / integer({mode:'boolean'})
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
 * ⚠️ **ライセンス境界**: `market` / `sector` / `instrument_type` /
 * `license_tag` / `src_source` / `quality` は `personal-only`。公開面 (HTML /
 * JSON API) へ出してはいけない。drizzle の既定 select は**全列返し**なので、
 * `db.select().from(stocks)` (列指定なし) はこれらを必ず含んだ行を返す。
 * 公開面で列指定なし select を使う場合は、必要フィールドだけを詰め替えること
 * (行の spread / JSON.stringify はしない)。
 * この約束は src/shared/db/core-stocks-license-boundary.test.ts が機械的に見ている。
 *
 * `sector` は JPX 由来 (personal-only)。`sector33` 列は EDINET の「提出者業種」で
 * 別物。公開面が読むのは `sector33` 側で、切替は public-columns.ts が 1 箇所で決める。
 */
export const stocks = sqliteTable(
  "core_stocks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    market: text("market").notNull(),
    /**
     * `personal-only`。**JPX 33業種区分の置き場**。src/cron/universe.ts が JPX
     * 東証上場銘柄一覧 (data_j.xls) の 33業種区分をこの列へ書いている
     * (`sector: r.sector33`)。
     *
     * ⚠️ 2026-09-13 以降、**公開面はこの列を読まない**。data_j.xls の再配布可否が
     * 未判断なので、公開面の業種は下の `sector33` (EDINET 提出者業種) へ
     * 切り替えた (src/shared/db/public-columns.ts)。取込・集計 (src/cron) が
     * この列を読むのは従来どおり構わない。
     *
     * 「読むのは `sector`」だった旧方針をここに書いていたが、それは
     * **公開面については誤り**になったので消した。取込側の書き込み先は `sector`
     * のままで、`sector33` へ JPX の値を書き足してはいけない (下参照)。
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
    // 以下 11 列は stockStock 側の移行 P4a (2026-09-12) が本番 D1 へ直接 ALTER で
    // 足したもの。**本番の PRAGMA に合わせて全列 nullable / default なし**。
    // 型を勝手に notNull や default 付きにすると、この宣言から生成した DDL で
    // 作った非本番 DB だけが本番と違う形になる。
    // 2026-09-24 時点: instrument_type は src/cron/universe.ts (JPX, #27〜)、
    // sector33 は stockStock の master_sync (EDINET, 2026-09-13〜) が充填済み
    // (sector33 は現役普通株 3,700 件で NULL 0 件)。
    // edinet_code / listing_status / listing_date / delisting_date / license_tag /
    // src_source / src_data_date / src_fetched_at / quality はまだ全行 NULL。
    // -------------------------------------------------------------------------

    /** `personal-only`。内国普通株 / ETF / REIT 等の区分。 */
    instrumentType: text("instrument_type"),
    /**
     * **公開面が業種として読む列** (src/shared/db/public-columns.ts)。値を書くのは
     * stockStock の `collectors/edinet_codelist.py` だけで、そこは EDINET
     * コードリストの「提出者業種」を `license_tag=commercial-ok` として取る。
     * 2026-09-24 時点: stockStock の master_sync (2026-09-13〜) が充填済み
     * (現役普通株 3,700 件で NULL 0 件、全体 3,810 件中 3,757 件が非 NULL)。
     *
     * ⚠️ **この列へ JPX (data_j.xls) の 33業種区分を書いてはいけない。** 名前が
     * `sector33` なので上の `sector` と同じ値を入れたくなるが、この列は公開面に
     * 出ているため、JPX の値を入れると無認証の HTML / JSON が personal-only を
     * 返す状態に**テストが全部緑のまま**戻る。この禁止は
     * src/shared/db/core-stocks-license-boundary.test.ts が機械的に見ている。
     */
    sector33: text("sector33"),
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

/** 最新ファンダメンタルズ（共有）。1 銘柄 1 行のため stock_id が PK (L-53) */
export const stockFinancials = sqliteTable(
  "core_stock_financials",
  {
    stockId: integer("stock_id")
      .primaryKey()
      .references(() => stocks.id, { onDelete: "cascade" }),
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
  }
  // stock_id の列宣言 (.unique()) が自動索引を作るので、named な重複は持たない (L-45)。
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
