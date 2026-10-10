-- 銘柄 → Notion 会社ページの写し。既存表は変更しない。
-- 適用はコードデプロイより先（wrangler d1 execute --file。migrations apply ではない）。
CREATE TABLE `ir_notion_stock_pages` (
	`service` text NOT NULL,
	`ticker` text NOT NULL,
	`stock_page_id` text NOT NULL,
	`child_db_id` text NOT NULL,
	`schema_version` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`service`, `ticker`)
);
