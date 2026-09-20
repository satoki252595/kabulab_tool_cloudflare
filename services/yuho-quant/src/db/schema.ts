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
    /**
     * 海外（地域別）売上 構造化の結果。ok_geo_rows|ok_geo_cols|
     * geo_present_unstructured|no_overseas_table|parse_error。受注とは独立に同じ
     * 有報 1 通から構造化する（取込は XBRL を 1 回だけ取得し両方を解く）。未取込は
     * NULL（後方互換: 受注のみ取込済みの旧レコードは NULL のまま）。
     */
    overseasParseStatus: text("overseas_parse_status"),
    /** 海外売上 抽出元の本文 iXBRL ファイル名（調査・監査用）。未取込は NULL */
    overseasHonbunFile: text("overseas_honbun_file"),
    /**
     * 定性セクション (事業の内容・リスク等) の抽出結果。ok |
     * no_text_sections | parse_error。CSV (type=5) のみから抽出するので
     * XBRL の有無に依らない。未取込は NULL（後方互換: 既存レコードは
     * バックフィルまで NULL のまま）。
     */
    textParseStatus: text("text_parse_status"),
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

/**
 * 海外売上ファクト = (有報, 会計期末, 地域) 粒度。受注ファクトと同じ
 * yuho_documents を親に持つ（同一有報を 1 回取得して受注・海外売上を両方構造化）。
 * region_kind:
 *   - domestic       : 日本/本邦 向け売上高
 *   - overseas       : 個別の海外地域 (北米/欧州/アジア/中国/その他…)
 *   - overseas_total : 海外売上高合計 (= 開示された overseas 行の合計)
 *   - total          : 連結売上高 (外部顧客への売上高/連結) = 比率の分母
 * 金額は raw + 円換算を両方保持し、欠損は NULL（0 で埋めない・ルール2）。
 */
export const overseasSalesFacts = sqliteTable(
  "yuho_overseas_facts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentId: integer("document_id")
      .references(() => yuhoDocuments.id, { onDelete: "cascade" })
      .notNull(),
    stockId: integer("stock_id")
      .references(() => stocks.id, { onDelete: "cascade" })
      .notNull(),
    fiscalYearEnd: text("fiscal_year_end").notNull(),
    /** 表記そのままの地域名 (合計含む) */
    regionName: text("region_name").notNull(),
    /** domestic | overseas | overseas_total | total */
    regionKind: text("region_kind").notNull(),
    /** 連結=true / 個別=false / 判定不能=NULL (推測しない) */
    isConsolidated: integer("is_consolidated", { mode: "boolean" }),
    unitLabel: text("unit_label").notNull(),
    /** 売上高 (表の単位のまま, 欠損=NULL) */
    salesRaw: real("sales_raw"),
    /** 売上高 (円換算, 欠損=NULL) */
    salesYen: integer("sales_yen", { mode: "number" }),
    /** 連結売上高に占める割合 (%)。開示/算出があるときのみ。無ければ NULL */
    ratioPct: real("ratio_pct"),
    /** geo_rows | geo_cols | none */
    pattern: text("pattern").notNull(),
  },
  (t) => [
    uniqueIndex("overseas_facts_doc_period_region_uq").on(
      t.documentId,
      t.fiscalYearEnd,
      t.regionName
    ),
    index("overseas_facts_stock_period_idx").on(t.stockId, t.fiscalYearEnd),
    // スクリーニングは region_kind IN ('overseas_total','total'[,'overseas']) を
    // 全銘柄走査する。region_kind 先頭の複合インデックスで対象種だけをシーク。
    index("overseas_facts_kind_stock_idx").on(
      t.regionKind,
      t.stockId,
      t.fiscalYearEnd
    ),
  ]
);

/**
 * 定性セクション = (有報, セクション) 粒度。有報の開示テキスト項目
 * (39 項目。TEXT_SECTIONS が正本) の本文テキストを保持する。
 * 抽出は CSV (type=5) のみ・追加ダウンロードなし。原文の語句は変えず
 * HTML タグ除去・実体参照復号・空白畳み込みだけを行う（要約・言い換えは
 * しない。ルール1）。
 * セクション種の追加は TEXT_SECTIONS に 1 行足すだけで DDL 不要。
 */
export const textSections = sqliteTable(
  "yuho_text_sections",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    documentId: integer("document_id")
      .references(() => yuhoDocuments.id, { onDelete: "cascade" })
      .notNull(),
    /** 高速クエリ用の非正規化 (銘柄単位で最新期を引く) */
    stockId: integer("stock_id")
      .references(() => stocks.id, { onDelete: "cascade" })
      .notNull(),
    /** この行が属する会計期末 */
    fiscalYearEnd: text("fiscal_year_end").notNull(),
    /** TextSectionKey (39 項目。edinet/text-sections.ts の TEXT_SECTIONS が正本) */
    sectionKey: text("section_key").notNull(),
    /** プレーンテキスト化した本文 (欠損セクションは行自体を作らない) */
    text: text("text").notNull(),
    /** 抽出元の要素 ID (例 jpcrp_cor:BusinessRisksTextBlock。監査用) */
    elementId: text("element_id").notNull(),
    /** 抽出元の項目名 (表記ゆれ前の原文ラベル。監査用) */
    itemName: text("item_name").notNull(),
    /** 抽出元のコンテキスト ID (当期・連結の来歴。監査用) */
    contextId: text("context_id").notNull(),
    /** text の文字数 (UTF-16 単位) */
    charCount: integer("char_count").notNull(),
  },
  (t) => [
    uniqueIndex("text_sections_doc_section_uq").on(
      t.documentId,
      t.sectionKey
    ),
    index("text_sections_stock_section_period_idx").on(
      t.stockId,
      t.sectionKey,
      t.fiscalYearEnd
    ),
  ]
);
