-- 001 RSI Screening: 営業利益率 historical → TTM への切り替え
--
-- Yahoo Finance が 2025 年頃に無料 quoteSummary API から
-- `incomeStatementHistory.incomeStatementHistory[].operatingIncome` を削除した。
-- これにより historical な営業利益率は計算不能になったため、
-- TTM 単一値 (`financialData.operatingMargins`) を使う方式に変更する。
--
-- 影響を受けるカラムは全て NULL のままだったため、データ損失は無い。
--
-- 1. core.stock_financials に operating_margin (TTM) を追加
ALTER TABLE "core"."stock_financials" ADD COLUMN "operating_margin" real;
--> statement-breakpoint
-- 2. core.stock_annual_financials から operating_income / operating_margin を削除
--    (歴史的トレンドは計算不能になったため不要)
ALTER TABLE "core"."stock_annual_financials" DROP COLUMN IF EXISTS "operating_income";
--> statement-breakpoint
ALTER TABLE "core"."stock_annual_financials" DROP COLUMN IF EXISTS "operating_margin";
--> statement-breakpoint
-- 3. rsi.stock_rsi_percentile.operating_margin_trend (integer) を
--    operating_margin_ttm (real) に置き換え
ALTER TABLE "rsi"."stock_rsi_percentile" DROP COLUMN IF EXISTS "operating_margin_trend";
--> statement-breakpoint
ALTER TABLE "rsi"."stock_rsi_percentile" ADD COLUMN "operating_margin_ttm" real;
