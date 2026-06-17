-- Add sma25 column to swing.stock_indicators
--
-- otakara-yutai の MA25 乖離率スコアリングで参照するために、
-- swing の日次インジケータ計算パスで SMA(25) も一緒に算出・保存する。
-- 既存行は NULL のまま (次回 sync:daily 実行時に埋まる)。

ALTER TABLE swing.stock_indicators
  ADD COLUMN IF NOT EXISTS sma_25 double precision;
