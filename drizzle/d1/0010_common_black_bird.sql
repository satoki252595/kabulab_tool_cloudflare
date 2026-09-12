-- ⚠️ 本番 (kabulab-cf) には流さない。**既に適用済み**。
--
-- この 12 列と 2 索引は stockStock 側の移行 P4a (2026-09-12) が本番 D1 へ直接
-- ALTER / CREATE INDEX で入れたもので、drizzle のスナップショットだけが 9 列・
-- 索引 1 本のまま取り残されていた。core-schema.ts に宣言を足した結果として
-- 生成されたのがこのファイルで、**本番との差分ではなく snapshot との差分**である。
--
-- 本番へ流すと 1 文目の ALTER が `duplicate column name: instrument_type` で落ちる
-- (SQLite に ADD COLUMN IF NOT EXISTS は無い)。落ちるのは正しい挙動なので、
-- 文を消して「流しても無害」にはしない。本番に d1_migrations 表は無いため、
-- 誰かが手で流す以外にこのファイルが本番へ届く経路は無い。
--
-- 逆に、**新規に作る DB (ローカル / preview) では必ず流す**。0000 が作る
-- core_stocks は 9 列なので、このファイルを飛ばすと snapshot と食い違う DB が
-- できる。運用は drizzle/d1/README.md を読むこと。

ALTER TABLE `core_stocks` ADD `instrument_type` text;--> statement-breakpoint
ALTER TABLE `core_stocks` ADD `sector33` text;--> statement-breakpoint
ALTER TABLE `core_stocks` ADD `sector17` text;--> statement-breakpoint
ALTER TABLE `core_stocks` ADD `edinet_code` text;--> statement-breakpoint
ALTER TABLE `core_stocks` ADD `listing_status` text;--> statement-breakpoint
ALTER TABLE `core_stocks` ADD `listing_date` text;--> statement-breakpoint
ALTER TABLE `core_stocks` ADD `delisting_date` text;--> statement-breakpoint
ALTER TABLE `core_stocks` ADD `license_tag` text;--> statement-breakpoint
ALTER TABLE `core_stocks` ADD `src_source` text;--> statement-breakpoint
ALTER TABLE `core_stocks` ADD `src_data_date` text;--> statement-breakpoint
ALTER TABLE `core_stocks` ADD `src_fetched_at` integer;--> statement-breakpoint
ALTER TABLE `core_stocks` ADD `quality` text;--> statement-breakpoint
CREATE INDEX `idx_core_stocks_active_market` ON `core_stocks` (`is_active`,`market`);--> statement-breakpoint
CREATE INDEX `idx_core_stocks_edinet` ON `core_stocks` (`edinet_code`) WHERE "core_stocks"."edinet_code" is not null;
