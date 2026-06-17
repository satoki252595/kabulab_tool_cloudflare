CREATE SCHEMA "core";
--> statement-breakpoint
CREATE SCHEMA "rsi";
--> statement-breakpoint
CREATE TABLE "core"."stock_annual_financials" (
	"id" serial PRIMARY KEY NOT NULL,
	"stock_id" integer NOT NULL,
	"fiscal_year" integer NOT NULL,
	"revenue" real,
	"operating_income" real,
	"operating_margin" real
);
--> statement-breakpoint
CREATE TABLE "core"."stock_financials" (
	"id" serial PRIMARY KEY NOT NULL,
	"stock_id" integer NOT NULL,
	"price" real,
	"per" real,
	"pbr" real,
	"dividend_yield" real,
	"eps" real,
	"bps" real,
	"roe" real,
	"roa" real,
	"market_cap" real,
	"data_date" date NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_financials_stock_id_unique" UNIQUE("stock_id")
);
--> statement-breakpoint
CREATE TABLE "core"."stock_price_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"stock_id" integer NOT NULL,
	"date" date NOT NULL,
	"open" real,
	"high" real,
	"low" real,
	"close" real,
	"volume" real
);
--> statement-breakpoint
CREATE TABLE "core"."stocks" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"market" text NOT NULL,
	"sector" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stocks_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "rsi"."stock_rsi_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"stock_id" integer NOT NULL,
	"date" date NOT NULL,
	"rsi_10" real,
	"rsi_40" real,
	"rsi_120" real
);
--> statement-breakpoint
CREATE TABLE "rsi"."stock_rsi_percentile" (
	"id" serial PRIMARY KEY NOT NULL,
	"stock_id" integer NOT NULL,
	"rsi_10" real,
	"rsi_10_percentile" real,
	"rsi_40" real,
	"rsi_40_percentile" real,
	"rsi_120" real,
	"rsi_120_percentile" real,
	"rsi_min_percentile" real,
	"is_blue_chip" boolean DEFAULT false NOT NULL,
	"operating_margin_trend" integer,
	"revenue_trend" integer,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_rsi_percentile_stock_id_unique" UNIQUE("stock_id")
);
--> statement-breakpoint
ALTER TABLE "core"."stock_annual_financials" ADD CONSTRAINT "stock_annual_financials_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "core"."stocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."stock_financials" ADD CONSTRAINT "stock_financials_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "core"."stocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."stock_price_history" ADD CONSTRAINT "stock_price_history_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "core"."stocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsi"."stock_rsi_history" ADD CONSTRAINT "stock_rsi_history_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "core"."stocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rsi"."stock_rsi_percentile" ADD CONSTRAINT "stock_rsi_percentile_stock_id_stocks_id_fk" FOREIGN KEY ("stock_id") REFERENCES "core"."stocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_core_annual_stock_year" ON "core"."stock_annual_financials" USING btree ("stock_id","fiscal_year");--> statement-breakpoint
CREATE INDEX "idx_core_financials_stock_id" ON "core"."stock_financials" USING btree ("stock_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_core_price_stock_date" ON "core"."stock_price_history" USING btree ("stock_id","date");--> statement-breakpoint
CREATE INDEX "idx_core_price_date" ON "core"."stock_price_history" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_rsi_history_stock_date" ON "rsi"."stock_rsi_history" USING btree ("stock_id","date");--> statement-breakpoint
CREATE INDEX "idx_rsi_history_date" ON "rsi"."stock_rsi_history" USING btree ("date");--> statement-breakpoint
CREATE INDEX "idx_rsi_percentile_min" ON "rsi"."stock_rsi_percentile" USING btree ("rsi_min_percentile");--> statement-breakpoint
CREATE INDEX "idx_rsi_percentile_blue_chip" ON "rsi"."stock_rsi_percentile" USING btree ("is_blue_chip");