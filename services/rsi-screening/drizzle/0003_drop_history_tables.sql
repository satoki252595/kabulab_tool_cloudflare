-- 001 RSI Screening: 未使用の OHLCV / 日次 RSI 履歴テーブルを完全削除
--
-- これらの 2 テーブルは sync が定期的に upsert していたが、UI 側からは
-- 一切参照されていなかった (旧 stock-detail-service が priceHistory/rsiHistory
-- フィールドを返していたが view 側で render されておらず、リファクタで
-- 既にクエリ側を撤去済み)。
-- RSI パーセンタイル算出はメモリ上の計算で完結するため、永続化は不要。
--
-- 関連の移行履歴:
--   0002_truncate_history.sql で TRUNCATE して 473 MB → 21 MB に縮小
--   0003 (本ファイル) で DROP TABLE して完全削除
DROP TABLE IF EXISTS "core"."stock_price_history" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "rsi"."stock_rsi_history" CASCADE;
