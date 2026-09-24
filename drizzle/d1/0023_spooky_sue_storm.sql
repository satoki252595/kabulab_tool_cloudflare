-- `core_stocks.sector17` (JPX 17業種) を DROP する。
--
-- 本番 D1 実測 (2026-09-24, core_stocks 3,810 行): sector17 の非 NULL は 0 件。
-- 書込経路 (writer) は無く、公開面・取込・集計のどこからも読んでいない
-- (grep で src/ services/ 配下に参照ゼロを確認済み)。専用の索引も無い。
-- 33業種 (`sector33`) と違い `sector` に相当する既存の JPX 列も無く、
-- 移行 P4a (2026-09-12) が ALTER で足したまま一度も使われなかった列。

ALTER TABLE `core_stocks` DROP COLUMN `sector17`;
