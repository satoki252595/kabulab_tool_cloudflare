/**
 * 母集団所有者の公式イベント台帳 (Issue #196)。
 *
 * 月末 JPX XLS (base) だけでは追えない日付付き公式イベント
 * (上場廃止 / 新規上場 / 市場区分変更) を日付順 overlay で適用するための
 * 最小永続化。汎用イベント基盤ではなく 3 固定 kind のみ。
 *
 * - `universe_official_events`: JPX 公式 3 頁由来の確定イベント。
 *   精度は primary custody (Notion service universe) の原文+manifest が正本で、
 *   ここは適用用の索引。行の追加は月次 universe 所有者のみ。
 * - `universe_overlay_state`: id=1 の単一行。`sourceAsOf` /
 *   `eventsFetchedAt` / `eventSHA` / `eligibilityAsOf` / `actualRunAt`
 *   の分離記録。`updatedAt` の進行は freshness 証拠にしない。
 */
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const LISTING_EVENT_KINDS = ["delist", "listing", "transfer"] as const;
export type ListingEventKind = (typeof LISTING_EVENT_KINDS)[number];

export const listingOfficialEvents = sqliteTable(
  "universe_official_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 共有 4 文字コード。 */
    code: text("code").notNull(),
    /** 'delist' | 'listing' | 'transfer'。 */
    kind: text("kind").notNull(),
    /** 発効日 (JST 暦日 `YYYY-MM-DD`)。 */
    effectiveDate: text("effective_date").notNull(),
    /** 社名 (listing 必須)。 */
    name: text("name"),
    /** 変更前市場区分セル原文 (transfer 必須)。 */
    marketFrom: text("market_from"),
    /** 市場区分セル原文 (listing/transfer 必須。bare segment)。 */
    marketTo: text("market_to"),
    sourceUrl: text("source_url").notNull(),
    fetchedAt: text("fetched_at").notNull(),
    rawSha: text("raw_sha").notNull(),
    archiveKey: text("archive_key").notNull(),
    /**
     * 直近に公式表で確認された refresh の fetchedAt。延期/取消で表から消えた
     * 旧予定行を overlay が勝手に発効させないための世代管理。
     * 現世代は singleton universe_overlay_state.events_fetched_at が唯一の正本
     * (完全一致で判定。旧 MAX 集計は使わない)。append-only で削除しない。
     */
    lastSeenFetchedAt: text("last_seen_fetched_at"),
  },
  (table) => [
    uniqueIndex("uq_universe_official_events_code_kind_date").on(
      table.code,
      table.kind,
      table.effectiveDate
    ),
    index("idx_universe_official_events_kind_date").on(
      table.kind,
      table.effectiveDate
    ),
  ]
);

export type ListingOfficialEvent = typeof listingOfficialEvents.$inferSelect;

export const universeOverlayState = sqliteTable("universe_overlay_state", {
  /** 単一行 (常に id=1 の upsert)。 */
  id: integer("id").primaryKey(),
  /** 直近に適用した月末 base の asOf (`YYYY-MM-DD`, 未適用は NULL)。 */
  baseAsOf: text("base_as_of"),
  eventsFetchedAt: text("events_fetched_at"),
  eventsSha: text("events_sha"),
  eligibilityAsOf: text("eligibility_as_of"),
  /** 直近適用の実行日時 (ISO)。 */
  appliedAt: text("applied_at"),
  appliedDelist: integer("applied_delist").notNull().default(0),
  appliedListing: integer("applied_listing").notNull().default(0),
  appliedTransfer: integer("applied_transfer").notNull().default(0),
  /**
   * HOLD 中 IPO の per-code UNKNOWN (JSON 配列)。NULL/空 = 完全適用。
   * 未知を除いた母数での正常完了宣言を禁止するための明示記録。
   */
  heldListingCodes: text("held_listing_codes"),
});

export type UniverseOverlayState = typeof universeOverlayState.$inferSelect;
