/**
 * 005 yuho-quant 固有スキーマ (`yuho_quant`)。
 *
 * EDINET の有価証券報告書から構造化した「受注高 / 受注残高」を保持する。
 * 銘柄マスタ core.stocks は 001 が所有するため **読み取り専用で参照** し、
 * ここでは再宣言せず rsi-screening の core-schema を import する
 * (src/cron/monthly.ts と同じ単一 source of truth 方針)。
 *
 * 設計原則 (CLAUDE.md):
 *   - ルール1: 構造化できなかった有報も parse_status で事実を記録し、
 *     架空の数値で埋めない。
 *   - ルール2: 金額が欠損 (有報で「－」) の場合は NULL のまま保存する
 *     (0 で代替しない)。is_consolidated も判定不能なら NULL。
 */
import {
  pgSchema,
  serial,
  integer,
  text,
  date,
  boolean,
  bigint,
  doublePrecision,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { stocks } from "../../../rsi-screening/src/db/core-schema.js";

export const yuhoSchema = pgSchema("yuho_quant");

/**
 * 取り込んだ有価証券報告書 1 通 = 1 行。docId が EDINET 上の一意キーで、
 * これを unique にして冪等な再取り込みを保証する。
 */
export const yuhoDocuments = yuhoSchema.table(
  "documents",
  {
    id: serial("id").primaryKey(),
    stockId: integer("stock_id")
      .references(() => stocks.id, { onDelete: "cascade" })
      .notNull(),
    /** 提出者 EDINET コード (例 E02126) */
    edinetCode: text("edinet_code").notNull(),
    /** EDINET 書類 ID (例 S100W6XE) — 冪等キー */
    docId: text("doc_id").notNull().unique(),
    /** 120=有価証券報告書 / 130=訂正有価証券報告書 */
    docTypeCode: text("doc_type_code").notNull(),
    filerName: text("filer_name").notNull(),
    periodStart: date("period_start"),
    /** 会計期末 (YYYY-MM-DD) */
    periodEnd: date("period_end").notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
    /**
     * 受注構造化の結果。ok_pattern_a|ok_pattern_b|orders_only|
     * table_unrecognized|no_order_table。UI はこれを根拠に
     * 「データなし」「未対応」を正直に表示する (架空値で埋めない)。
     */
    parseStatus: text("parse_status").notNull(),
    /** 抽出元の本文 iXBRL ファイル名 (調査・監査用) */
    honbunFile: text("honbun_file"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("yuho_documents_stock_idx").on(t.stockId)]
);

/**
 * 受注ファクト = (有報, 会計期末, セグメント) 粒度。セグメント別 + 全社合計
 * (segment_kind で区別)。金額は「表の単位そのままの raw」と「円換算」を両方
 * 保持し、欠損は NULL。
 */
export const orderFacts = yuhoSchema.table(
  "order_facts",
  {
    id: serial("id").primaryKey(),
    documentId: integer("document_id")
      .references(() => yuhoDocuments.id, { onDelete: "cascade" })
      .notNull(),
    /** 高速クエリ用の非正規化 (チャートは stock 単位で引く) */
    stockId: integer("stock_id")
      .references(() => stocks.id, { onDelete: "cascade" })
      .notNull(),
    /** この行が属する会計期末 */
    fiscalYearEnd: date("fiscal_year_end").notNull(),
    /** 表記そのままのセグメント名 (合計含む) */
    segmentName: text("segment_name").notNull(),
    /** segment | subtotal | total | elimination */
    segmentKind: text("segment_kind").notNull(),
    /** 連結=true / 個別=false / 判定不能=NULL (推測しない) */
    isConsolidated: boolean("is_consolidated"),
    /** 金額単位ラベル (例: 百万円) */
    unitLabel: text("unit_label").notNull(),
    /** 受注高 (表の単位のまま, 欠損=NULL) */
    ordersReceivedRaw: doublePrecision("orders_received_raw"),
    /** 受注残高/期末繰越高 (表の単位のまま, 欠損=NULL) */
    orderBacklogRaw: doublePrecision("order_backlog_raw"),
    /** 受注高 (円換算, 欠損=NULL) */
    ordersReceivedYen: bigint("orders_received_yen", { mode: "number" }),
    /** 受注残高 (円換算, 欠損=NULL) */
    orderBacklogYen: bigint("order_backlog_yen", { mode: "number" }),
    /** pattern_a | pattern_b */
    pattern: text("pattern").notNull(),
  },
  (t) => [
    uniqueIndex("order_facts_doc_period_seg_uq").on(
      t.documentId,
      t.fiscalYearEnd,
      t.segmentName
    ),
    index("order_facts_stock_period_idx").on(t.stockId, t.fiscalYearEnd),
  ]
);
