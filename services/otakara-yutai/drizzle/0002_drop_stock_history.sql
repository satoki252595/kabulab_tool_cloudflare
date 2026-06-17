-- 002 お宝優待: 未使用の月次 PER/PBR 推移テーブルを完全削除
--
-- public.stock_history はスキーマ定義 (drizzle) には存在していたが、
-- アプリ側からは一切 import / select / insert されていなかった。
-- 過去のスクリプトで投入された 1260 行のデータも含めて DROP する。
DROP TABLE IF EXISTS "public"."stock_history" CASCADE;
