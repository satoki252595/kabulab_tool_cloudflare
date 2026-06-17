-- 002 お宝優待: stock_financials / stock_scores の重複行を除去し UNIQUE 制約を追加
--
-- 元のスキーマには UNIQUE(stock_id) が無く、sync が ON CONFLICT 無しで insert していたため、
-- 同期実行のたびに同じ stock_id の行が重複していた。
--
-- 各 stock_id について最新の fetched_at / scored_at の行のみを残す。
--
-- 1. stock_financials の重複削除 (各 stock_id について最新の fetched_at だけ残す)
DELETE FROM "public"."stock_financials" sf
USING (
  SELECT id, stock_id,
         ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY fetched_at DESC, id DESC) AS rn
  FROM "public"."stock_financials"
) ranked
WHERE sf.id = ranked.id AND ranked.rn > 1;
--> statement-breakpoint
-- 2. stock_scores の重複削除 (同様)
DELETE FROM "public"."stock_scores" ss
USING (
  SELECT id, stock_id,
         ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY scored_at DESC, id DESC) AS rn
  FROM "public"."stock_scores"
) ranked
WHERE ss.id = ranked.id AND ranked.rn > 1;
--> statement-breakpoint
-- 3. UNIQUE 制約を追加して以後の重複を防ぐ
ALTER TABLE "public"."stock_financials"
  ADD CONSTRAINT "stock_financials_stock_id_unique" UNIQUE ("stock_id");
--> statement-breakpoint
ALTER TABLE "public"."stock_scores"
  ADD CONSTRAINT "stock_scores_stock_id_unique" UNIQUE ("stock_id");
