-- `core_stocks` の 9 列 (+ 部分索引 `idx_core_stocks_edinet`) と
-- `yutai_benefits.estimate_source_url` を DROP する。
--
-- 本番実測 (2026-09-25):
--   core_stocks 3,810 行: edinet_code / listing_status / listing_date /
--     delisting_date / license_tag / src_source / src_data_date /
--     src_fetched_at / quality はすべて非 NULL 0 件。書込経路も参照経路も無い
--     (D-14-1 で P4b〜P8 の充填計画自体が中止済み)。sector17 の DROP (0023) と
--     同じ理由。
--   yutai_benefits 8,295 行: estimate_source_url は非 NULL 0 件。唯一の書き手
--     data-scripts/import-summary-results.ts (経由 summary-import.ts) は常に
--     null を書くだけで、実質書込経路が無い。
--
-- ⚠️ `estimate_value_source` (X-01 が言及するもう1列) は DROP **しない**。
-- 本番実測で 8,295 行中 50 行が非 NULL ("company") で、summary-import.ts が
-- 今も条件付きで書き込む現役の列だったため (HANDOFF の「本番 0 行」は古い)。
--
-- pipeline 側 (`pipeline/src/jp_stock_pipeline/cloud_store/core_stocks.py` の
-- `NEW_COLUMNS` / `NEW_INDEXES`, `schema.py` の
-- `MIXED_LICENSE_COLUMNS["core_stocks"]`) はこの PR で**同時に**追随済み
-- （9列とも宣言から削除、関連テスト・共有契約ファイル
-- `tests/fixtures/contracts/d1-license-map.json` も更新済み）。
--
-- ⚠️ `core_stocks_migrate.py --verify` (E7) は「本番にあって定義に無い列」も
-- 「定義にあって本番に無い列」も両方向 failure にするため、**この SQL の適用と
-- pipeline 側のマージは同じタイミングで行うこと**（sector17 のときと同じ
-- 運用: 適用してから直後にコードを合わせる。次の daily ops_check(14:30 UTC)
-- より前に両方揃っていれば失敗しない。揃うまでの間に 1 回 ops_check の
-- タイミングを跨いでも、揃った次の実行で自動的に緑へ戻る）。
--
-- 適用手順:
--   1. このブランチをマージする
--   2. wrangler d1 execute kabulab-cf --remote --file=drizzle/d1/0024_careless_cammi.sql
--   3. sqlite_master / PRAGMA table_info(core_stocks) で列が消えたことを確認
--      （11列: id/code/name/market/sector/is_active/is_yutai/created_at/
--      updated_at/instrument_type/sector33 になっていること）
DROP INDEX `idx_core_stocks_edinet`;--> statement-breakpoint
ALTER TABLE `core_stocks` DROP COLUMN `edinet_code`;--> statement-breakpoint
ALTER TABLE `core_stocks` DROP COLUMN `listing_status`;--> statement-breakpoint
ALTER TABLE `core_stocks` DROP COLUMN `listing_date`;--> statement-breakpoint
ALTER TABLE `core_stocks` DROP COLUMN `delisting_date`;--> statement-breakpoint
ALTER TABLE `core_stocks` DROP COLUMN `license_tag`;--> statement-breakpoint
ALTER TABLE `core_stocks` DROP COLUMN `src_source`;--> statement-breakpoint
ALTER TABLE `core_stocks` DROP COLUMN `src_data_date`;--> statement-breakpoint
ALTER TABLE `core_stocks` DROP COLUMN `src_fetched_at`;--> statement-breakpoint
ALTER TABLE `core_stocks` DROP COLUMN `quality`;--> statement-breakpoint
ALTER TABLE `yutai_benefits` DROP COLUMN `estimate_source_url`;