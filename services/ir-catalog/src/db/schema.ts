/**
 * 006 ir-catalog 固有スキーマ (`ir_catalog`)。
 *
 * TDnet (適時開示) の 1 開示 = 1 行。`tdnet_id` が yanoshin TDnet WebAPI 上の
 * 一意キーで、これを unique にして冪等な再取り込みを保証する (全履歴
 * バックフィルが再開可能)。
 *
 * 銘柄マスタ core.stocks は 001 が所有するため **読み取り専用で参照** し、
 * ここでは再宣言せず rsi-screening の core-schema を import する
 * (src/cron/monthly.ts / 005 yuho-quant と同じ単一 source of truth 方針)。
 *
 * 設計原則 (CLAUDE.md):
 *   - ルール1/2: タイトルからタグを **決定論的に** 分類する。どの規則にも
 *     当てはまらない開示は `tags=[]` / `primary_tag=NULL` のまま保存し、
 *     UI では「未分類」と正直に表示する (それっぽいタグを捏造しない)。
 *   - core.stocks に居ない銘柄コード (ETF/REIT/非上場/上場廃止 等) の開示は
 *     取り込まない (我々の個別株ユニバース外であることを正直に切り捨てる)。
 */
import {
  pgSchema,
  serial,
  integer,
  text,
  timestamp,
  index,
  uniqueIndex,
  real,
} from "drizzle-orm/pg-core";
import { stocks } from "../../../rsi-screening/src/db/core-schema.js";

export const irSchema = pgSchema("ir_catalog");

export const disclosures = irSchema.table(
  "disclosures",
  {
    id: serial("id").primaryKey(),
    /** 高速クエリ用 (タイムラインは銘柄単位で引く) */
    stockId: integer("stock_id")
      .references(() => stocks.id, { onDelete: "cascade" })
      .notNull(),
    /** yanoshin TDnet WebAPI の開示 ID (例 "1253766") — 冪等キー */
    tdnetId: text("tdnet_id").notNull().unique(),
    /** TDnet 表記の 5 桁証券コード (例 "72030") */
    companyCode: text("company_code").notNull(),
    /** TDnet 表記の会社名 (core.stocks.name とは別に原文も保持) */
    companyName: text("company_name").notNull(),
    /** 開示表題 (原文) */
    title: text("title").notNull(),
    /** 開示日時 (適時開示の pubdate) */
    pubdate: timestamp("pubdate", { withTimezone: true }).notNull(),
    /** 開示資料 (PDF) への yanoshin リダイレクト URL */
    documentUrl: text("document_url").notNull(),
    /** XBRL ZIP の URL (提供されない開示は NULL — 捏造しない) */
    xbrlUrl: text("xbrl_url"),
    /** 上場市場文字列 (例 "東" / "東名")。ETF/投信等で欠落=NULL (捏造しない) */
    marketsString: text("markets_string"),
    /**
     * 決定論的に分類したタグ群。0 件可 (= 未分類)。架空のタグで埋めない。
     */
    tags: text("tags").array().notNull(),
    /**
     * 色分け用の代表タグ。highSignal タグ優先で 1 つ選ぶ。どのタグも付か
     * なければ NULL (UI は「未分類」と表示)。
     */
    primaryTag: text("primary_tag"),
    /**
     * Notion 子DB「適時開示｜<ticker>」上のこの開示行の page id。
     * TDnet `document_url` は ~31日で purge されるため、UI のファイル
     * リンクはサーバ側でこの page_id 経由で Notion の signed URL を毎回
     * 取得し直して 302 リダイレクトする (signed URL は ~1h で失効するが
     * 取得時点で新規発行される)。未投入 / Notion 失敗の行は NULL。
     */
    notionPageId: text("notion_page_id"),
    /**
     * PDF 本文を解析したセンチメント判定結果。
     * - `positive` / `negative` : 株主視点の方向が確信できた
     * - `mixed`                 : 売上+/利益− など指標で方向不一致
     * - `unknown`               : テキスト抽出 0 文字 / 数値抽出失敗
     * - `skipped`               : 判定対象外タグ (決算短信・人事等) または既存タグで方向確定
     * - NULL                    : まだ判定処理に到達していない
     */
    pdfSentiment: text("pdf_sentiment"),
    /**
     * どのエンジンで判定したかの世代管理用。
     * `rule_v1` = 数値テーブル抽出 (業績予想・配当予想・特別損益)
     * `dict_v1` = 東北大『日本語評価極性辞書』ベース (配当政策の変更等)
     * NULL      = 未判定 or method 不明 (skipped 含む)
     */
    pdfSentimentMethod: text("pdf_sentiment_method"),
    /**
     * 集計スコア。
     * `rule_v1`: 1.0 (確定) or NULL。
     * `dict_v1`: -1.0 〜 +1.0 (辞書マッチ数を正規化)。
     */
    pdfSentimentScore: real("pdf_sentiment_score"),
    /** 判定時刻 (再判定検出 / version 移行検出用) */
    pdfSentimentAt: timestamp("pdf_sentiment_at", { withTimezone: true }),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("ir_disclosures_tdnet_uq").on(t.tdnetId),
    index("ir_disclosures_stock_pubdate_idx").on(t.stockId, t.pubdate),
    index("ir_disclosures_pubdate_idx").on(t.pubdate),
    index("ir_disclosures_primary_tag_idx").on(t.primaryTag),
    // pdf_sentiment は部分 index (NULL 多数のため。SQL 側で WHERE 付き)
    index("ir_disclosures_pdf_sentiment_idx").on(t.pdfSentiment),
  ]
);
