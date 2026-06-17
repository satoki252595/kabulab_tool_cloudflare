-- 006 ir-catalog 固有スキーマ (ir_catalog)。手書き・冪等。
-- 適用: node scripts/db/apply-migration.mjs drizzle/create-ir-catalog.sql
-- core スキーマ (core.stocks) は 001 が所有済みで既存前提。

CREATE SCHEMA IF NOT EXISTS "ir_catalog";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ir_catalog"."disclosures" (
  "id" serial PRIMARY KEY,
  "stock_id" integer NOT NULL REFERENCES "core"."stocks"("id") ON DELETE CASCADE,
  "tdnet_id" text NOT NULL,
  "company_code" text NOT NULL,
  "company_name" text NOT NULL,
  "title" text NOT NULL,
  "pubdate" timestamptz NOT NULL,
  "document_url" text NOT NULL,
  "xbrl_url" text,
  "markets_string" text,
  "tags" text[] NOT NULL,
  "primary_tag" text,
  "ingested_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ir_disclosures_tdnet_uq" ON "ir_catalog"."disclosures" ("tdnet_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ir_disclosures_stock_pubdate_idx" ON "ir_catalog"."disclosures" ("stock_id", "pubdate");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ir_disclosures_pubdate_idx" ON "ir_catalog"."disclosures" ("pubdate");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ir_disclosures_primary_tag_idx" ON "ir_catalog"."disclosures" ("primary_tag");
--> statement-breakpoint
-- 既に NOT NULL で適用済みの環境向け冪等マイグレーション
-- (ETF/投信/上場廃止通知等は markets_string が欠落する。捏造せず NULL 許容)
ALTER TABLE "ir_catalog"."disclosures" ALTER COLUMN "markets_string" DROP NOT NULL;
--> statement-breakpoint
-- ファイルプロキシ用に Notion 子DB上の page id を保持 (冪等)
ALTER TABLE "ir_catalog"."disclosures" ADD COLUMN IF NOT EXISTS "notion_page_id" text;
