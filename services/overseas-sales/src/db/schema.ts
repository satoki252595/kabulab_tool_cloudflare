/**
 * 008 overseas-sales 固有スキーマ（Cloudflare D1 / SQLite）。
 *
 * EDINET の有価証券報告書から構造化した「海外（地域別）売上高」を保持する。
 * 銘柄マスタ core は 001 が所有するため **読み取り専用で参照** し、ここでは
 * 再宣言せず共有 core スキーマ（src/shared/db/core-schema）を import する。
 *
 * D1 は 1 DB = 1 SQLite で名前空間が無いため、接頭辞 `oseas_` を付ける。
 *
 * 設計原則（CLAUDE.md）:
 *   - ルール1: 構造化できなかった有報も parse_status で事実を記録し、架空の
 *     数値で埋めない。海外売上高は「開示された海外地域行の合計」のみ採り、
 *     total−国内で非地域分を混入させない。
 *   - ルール2: 金額欠損（有報で「－」）は NULL のまま保存する（0 で代替しない）。
 *     is_consolidated / ratio_pct も判定/開示が無ければ NULL。
 *
 * 注: 有報の物理 ZIP の Notion 一次アーカイブ（ルール6）は 005 yuho-quant が
 * docId キーで全有報を既に実施済み。008 は同一物理ファイルを重複アップロード
 * しない（ルール6 が課す冪等/レート遵守の帰結）。008 は派生構造化のみを持つ。
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
export const overseasDocuments = sqliteTable(
  "oseas_documents",
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
     * 海外売上高 構造化の結果。ok_geo_rows|ok_geo_cols|
     * geo_present_unstructured|no_overseas_table|parse_error。UI はこれを根拠に
     * 「データなし」「未対応」を正直に表示する (架空値で埋めない)。
     */
    parseStatus: text("parse_status").notNull(),
    /** 抽出元の本文 iXBRL ファイル名 (調査・監査用) */
    honbunFile: text("honbun_file"),
    ingestedAt: integer("ingested_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (t) => [index("oseas_documents_stock_idx").on(t.stockId)]
);

/**
 * 海外売上ファクト = (有報, 会計期末, 地域) 粒度。
 * region_kind:
 *   - domestic       : 日本/本邦 向け売上高
 *   - overseas       : 個別の海外地域 (北米/欧州/アジア/中国/その他…)
 *   - overseas_total : 海外売上高合計 (= 開示された overseas 行の合計)
 *   - total          : 連結売上高 (外部顧客への売上高/連結) = 比率の分母
 * 金額は「表の単位のまま raw」と「円換算」を両方保持し、欠損は NULL。
 */
export const overseasSalesFacts = sqliteTable(
  "oseas_sales_facts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentId: integer("document_id")
      .references(() => overseasDocuments.id, { onDelete: "cascade" })
      .notNull(),
    /** 高速クエリ用の非正規化 (チャートは stock 単位で引く) */
    stockId: integer("stock_id")
      .references(() => stocks.id, { onDelete: "cascade" })
      .notNull(),
    /** この行が属する会計期末 */
    fiscalYearEnd: text("fiscal_year_end").notNull(),
    /** 表記そのままの地域名 (合計含む) */
    regionName: text("region_name").notNull(),
    /** domestic | overseas | overseas_total | total */
    regionKind: text("region_kind").notNull(),
    /** 連結=true / 個別=false / 判定不能=NULL (推測しない) */
    isConsolidated: integer("is_consolidated", { mode: "boolean" }),
    /** 金額単位ラベル (例: 百万円) */
    unitLabel: text("unit_label").notNull(),
    /** 売上高 (表の単位のまま, 欠損=NULL) */
    salesRaw: real("sales_raw"),
    /** 売上高 (円換算, 欠損=NULL)。SQLite INTEGER は 64bit、円は 2^53 未満で安全 */
    salesYen: integer("sales_yen", { mode: "number" }),
    /** 連結売上高に占める割合 (%)。開示/算出があるときのみ。無ければ NULL */
    ratioPct: real("ratio_pct"),
    /** geo_rows | geo_cols | none */
    pattern: text("pattern").notNull(),
  },
  (t) => [
    uniqueIndex("oseas_facts_doc_period_region_uq").on(
      t.documentId,
      t.fiscalYearEnd,
      t.regionName
    ),
    index("oseas_facts_stock_period_idx").on(t.stockId, t.fiscalYearEnd),
    // スクリーニングは region_kind IN ('overseas_total','total') を全銘柄走査する。
    // region_kind 先頭の複合インデックスで対象 2 種だけをシークし全表スキャンを避ける。
    index("oseas_facts_kind_stock_idx").on(
      t.regionKind,
      t.stockId,
      t.fiscalYearEnd
    ),
  ]
);
