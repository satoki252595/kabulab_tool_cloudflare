-- 001 RSI Screening: 5 年分の OHLCV と RSI 履歴を truncate
--
-- これらの大きな履歴テーブルは production の view では現在使われていない
-- (stock-detail-service.ts は priceHistory / rsiHistory フィールドを返していたが、
--  view 側で何も render していなかった)。
--
-- Neon free tier が 512 MB を超えていたため truncate する。
-- sync-service は HISTORY_RETENTION_DAYS = 60 営業日のみを維持する仕様に変更済みのため、
-- 次の sync 完了後にこれら 2 テーブルは ~60 日 × ~1500 銘柄 = 約 90K 行に縮む。
TRUNCATE TABLE "core"."stock_price_history" RESTART IDENTITY CASCADE;
--> statement-breakpoint
TRUNCATE TABLE "rsi"."stock_rsi_history" RESTART IDENTITY CASCADE;
