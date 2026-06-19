/**
 * 005 yuho-quant 固有スキーマ（Cloudflare D1 / SQLite 版 — ADR-0001）。
 *
 * EDINET の有価証券報告書から構造化した「受注高 / 受注残高」を保持する。
 * 銘柄マスタ core は 001 が所有するため **読み取り専用で参照** し、ここでは
 * 再宣言せず共有 core スキーマ（src/shared/db/core-schema）を import する。
 *
 * D1 は 1 DB = 1 SQLite で名前空間が無いため、旧 `yuho_quant` スキーマ名を
 * 接頭辞 `yuho_` に降ろす（documents → yuho_documents 等）。export 名は
 * 不変（yuhoDocuments / orderFacts）なので参照側は変更不要。
 *
 * 設計原則（CLAUDE.md）:
 *   - ルール1: 構造化できなかった有報も parse_status で事実を記録し、架空の
 *     数値で埋めない。
 *   - ルール2: 金額欠損（有報で「－」）は NULL のまま保存する（0 で代替しない）。
 *     is_consolidated も判定不能なら NULL。
 *
 * 方言マッピング（PostgreSQL → SQLite, ADR-0001 §4）:
 *   serial → integer autoIncrement / date → text / boolean → integer(boolean) /
 *   bigint(number) → integer(number) / doublePrecision → real /
 *   timestamp(tz) → integer({mode:'timestamp'})（JS Date を保ち比較が可能）
 */
import { sql } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { stocks } from "../../../../src/shared/db/core-schema.js";

/**
 * 取り込んだ有価証券報告書 1 通 = 1 行。docId が EDINET 上の一意キーで、
 * これを unique にして冪等な再取り込みを保証する。
 */
export const yuhoDocuments = sqliteTable(
  "yuho_documents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
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
    periodStart: text("period_start"),
    /** 会計期末 (YYYY-MM-DD) */
    periodEnd: text("period_end").notNull(),
    submittedAt: integer("submitted_at", { mode: "timestamp" }).notNull(),
    /**
     * 受注構造化の結果。ok_pattern_a|ok_pattern_b|orders_only|
     * table_unrecognized|no_order_table。UI はこれを根拠に
     * 「データなし」「未対応」を正直に表示する (架空値で埋めない)。
     */
    parseStatus: text("parse_status").notNull(),
    /** 抽出元の本文 iXBRL ファイル名 (調査・監査用) */
    honbunFile: text("honbun_file"),
    ingestedAt: integer("ingested_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (t) => [index("yuho_documents_stock_idx").on(t.stockId)]
);

/**
 * 受注ファクト = (有報, 会計期末, セグメント) 粒度。セグメント別 + 全社合計
 * (segment_kind で区別)。金額は「表の単位そのままの raw」と「円換算」を両方
 * 保持し、欠損は NULL。
 */
export const orderFacts = sqliteTable(
  "yuho_order_facts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentId: integer("document_id")
      .references(() => yuhoDocuments.id, { onDelete: "cascade" })
      .notNull(),
    /** 高速クエリ用の非正規化 (チャートは stock 単位で引く) */
    stockId: integer("stock_id")
      .references(() => stocks.id, { onDelete: "cascade" })
      .notNull(),
    /** この行が属する会計期末 */
    fiscalYearEnd: text("fiscal_year_end").notNull(),
    /** 表記そのままのセグメント名 (合計含む) */
    segmentName: text("segment_name").notNull(),
    /** segment | subtotal | total | elimination */
    segmentKind: text("segment_kind").notNull(),
    /** 連結=true / 個別=false / 判定不能=NULL (推測しない) */
    isConsolidated: integer("is_consolidated", { mode: "boolean" }),
    /** 金額単位ラベル (例: 百万円) */
    unitLabel: text("unit_label").notNull(),
    /** 受注高 (表の単位のまま, 欠損=NULL) */
    ordersReceivedRaw: real("orders_received_raw"),
    /** 受注残高/期末繰越高 (表の単位のまま, 欠損=NULL) */
    orderBacklogRaw: real("order_backlog_raw"),
    /** 受注高 (円換算, 欠損=NULL)。SQLite INTEGER は 64bit、円は 2^53 未満で安全 */
    ordersReceivedYen: integer("orders_received_yen", { mode: "number" }),
    /** 受注残高 (円換算, 欠損=NULL) */
    orderBacklogYen: integer("order_backlog_yen", { mode: "number" }),
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
