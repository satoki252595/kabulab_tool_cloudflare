-- 005 yuho-quant スキーマ作成 (手書きマイグレーション)
-- 適用: node scripts/db/apply-migration.mjs drizzle/create-yuho-quant.sql
--
-- core.stocks は 001 が所有する既存テーブル。ここでは FK 参照のみ
-- (再作成しない)。冪等に再実行できるよう IF NOT EXISTS を徹底する。

CREATE SCHEMA IF NOT EXISTS "yuho_quant";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "yuho_quant"."documents" (
  "id" serial PRIMARY KEY NOT NULL,
  "stock_id" integer NOT NULL REFERENCES "core"."stocks"("id") ON DELETE CASCADE,
  "edinet_code" text NOT NULL,
  "doc_id" text NOT NULL,
  "doc_type_code" text NOT NULL,
  "filer_name" text NOT NULL,
  "period_start" date,
  "period_end" date NOT NULL,
  "submitted_at" timestamp with time zone NOT NULL,
  "parse_status" text NOT NULL,
  "honbun_file" text,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "yuho_documents_doc_id_unique" UNIQUE ("doc_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "yuho_documents_stock_idx"
  ON "yuho_quant"."documents" ("stock_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "yuho_quant"."order_facts" (
  "id" serial PRIMARY KEY NOT NULL,
  "document_id" integer NOT NULL REFERENCES "yuho_quant"."documents"("id") ON DELETE CASCADE,
  "stock_id" integer NOT NULL REFERENCES "core"."stocks"("id") ON DELETE CASCADE,
  "fiscal_year_end" date NOT NULL,
  "segment_name" text NOT NULL,
  "segment_kind" text NOT NULL,
  "is_consolidated" boolean,
  "unit_label" text NOT NULL,
  "orders_received_raw" double precision,
  "order_backlog_raw" double precision,
  "orders_received_yen" bigint,
  "order_backlog_yen" bigint,
  "pattern" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "order_facts_doc_period_seg_uq"
  ON "yuho_quant"."order_facts" ("document_id", "fiscal_year_end", "segment_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_facts_stock_period_idx"
  ON "yuho_quant"."order_facts" ("stock_id", "fiscal_year_end");
