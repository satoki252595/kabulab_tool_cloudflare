/**
 * 006 ir-catalog 固有スキーマ（Cloudflare D1 / SQLite 版 — ADR-0001）。
 *
 * TDnet (適時開示) の 1 開示 = 1 行。`tdnet_id` が yanoshin TDnet WebAPI 上の
 * 一意キーで、これを unique にして冪等な再取り込みを保証する。
 *
 * 銘柄マスタ core は 001 が所有するため **読み取り専用で参照** し、共有 core
 * スキーマ（src/shared/db/core-schema）を import する。D1 は 1 DB = 1 SQLite で
 * 名前空間が無いため、旧 `ir_catalog` スキーマ名を接頭辞 `ir_` に降ろす
 * （disclosures → ir_disclosures）。export 名は不変。
 *
 * 設計原則 (CLAUDE.md ルール1/2): タイトルからタグを決定論的に分類。当てはまら
 * ない開示は tags=[] / primary_tag=NULL のまま保存し「未分類」と正直に表示する。
 *
 * 方言マッピング（ADR-0001 §4）: serial→integer autoIncrement /
 * text[]→text({mode:'json'}) / timestamp(tz)→integer({mode:'timestamp'}) /
 * real→real。
 */
import { sql } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  real,
  index,
} from "drizzle-orm/sqlite-core";
import { stocks } from "../../../../src/shared/db/core-schema.js";
import { HIGH_SIGNAL_TAG_LIST_SQL } from "../services/classify.js";

export const disclosures = sqliteTable(
  "ir_disclosures",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** 高速クエリ用 (タイムラインは銘柄単位で引く) */
    stockId: integer("stock_id")
      .references(() => stocks.id, { onDelete: "cascade" })
      .notNull(),
    /** yanoshin TDnet WebAPI の開示 ID — 冪等キー */
    tdnetId: text("tdnet_id").notNull().unique(),
    /** TDnet 表記の 5 桁証券コード */
    companyCode: text("company_code").notNull(),
    /** TDnet 表記の会社名 (原文 provenance として保持。core.stocks の複製ではない) */
    companyName: text("company_name").notNull(),
    /** 開示表題 (原文) */
    title: text("title").notNull(),
    /** 開示日時 (適時開示の pubdate) */
    pubdate: integer("pubdate", { mode: "timestamp" }).notNull(),
    /** 開示資料 (PDF) への yanoshin リダイレクト URL */
    documentUrl: text("document_url").notNull(),
    /** XBRL ZIP の URL (提供されない開示は NULL — 捏造しない) */
    xbrlUrl: text("xbrl_url"),
    /** 上場市場文字列。ETF/投信等で欠落=NULL (捏造しない) */
    marketsString: text("markets_string"),
    /** 決定論的に分類したタグ群（JSON 配列）。0 件可 (= 未分類)。架空タグで埋めない。 */
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
    /** 色分け用の代表タグ。highSignal 優先で1つ。無ければ NULL (UIは「未分類」) */
    primaryTag: text("primary_tag"),
    /** Notion 子DB「適時開示｜<ticker>」上のこの開示行の page id。未投入は NULL */
    notionPageId: text("notion_page_id"),
    /** PDF 本文センチメント判定。positive/negative/mixed/unknown/skipped、未判定=NULL */
    pdfSentiment: text("pdf_sentiment"),
    /** 判定エンジン世代 (rule_v1 / dict_v1)。未判定=NULL */
    pdfSentimentMethod: text("pdf_sentiment_method"),
    /** 集計スコア。rule_v1=1.0/NULL、dict_v1=-1.0〜+1.0 */
    pdfSentimentScore: real("pdf_sentiment_score"),
    /** 判定時刻 (再判定/version 移行検出用) */
    pdfSentimentAt: integer("pdf_sentiment_at", { mode: "timestamp" }),
    ingestedAt: integer("ingested_at", { mode: "timestamp" })
      .default(sql`(unixepoch())`)
      .notNull(),
  },
  (t) => [
    // tdnet_id の列宣言 (.unique()) が自動索引を作るので、 named な重複は持たない (L-45)。
    index("ir_disclosures_stock_pubdate_idx").on(t.stockId, t.pubdate),
    // primary_tag の単独索引は持たない。recentHighSignal 以外に primary_tag で
    // 絞る SQL は無く、残すと planner がそちら + TEMP B-TREE を選び続けて
    // 部分索引が使われない (本番 EXPLAIN で確認。L-50 の後日談)。
    // home/signals の「高シグナル最新 N 件」を引く部分索引 (L-50)。
    // 述語は HIGH_SIGNAL_TAG_LIST_SQL と同じ文字列であること (classify.ts)。
    // 束縛パラメータの IN では planner が部分索引を選ばないので、
    // クエリ側も同じリテラル列で書く。
    index("ir_disclosures_high_signal_pubdate")
      .on(sql`"pubdate" DESC`)
      .where(sql.raw(`"primary_tag" IN (${HIGH_SIGNAL_TAG_LIST_SQL})`)),
  ]
);
