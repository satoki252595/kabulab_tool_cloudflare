PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_core_stock_financials` (
	`stock_id` integer PRIMARY KEY NOT NULL,
	`price` real,
	`per` real,
	`pbr` real,
	`dividend_yield` real,
	`eps` real,
	`bps` real,
	`roe` real,
	`roa` real,
	`market_cap` real,
	`operating_margin` real,
	`data_date` text NOT NULL,
	`fetched_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_core_stock_financials`("stock_id", "price", "per", "pbr", "dividend_yield", "eps", "bps", "roe", "roa", "market_cap", "operating_margin", "data_date", "fetched_at") SELECT "stock_id", "price", "per", "pbr", "dividend_yield", "eps", "bps", "roe", "roa", "market_cap", "operating_margin", "data_date", "fetched_at" FROM `core_stock_financials`;--> statement-breakpoint
DROP TABLE `core_stock_financials`;--> statement-breakpoint
ALTER TABLE `__new_core_stock_financials` RENAME TO `core_stock_financials`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_rsi_percentile` (
	`stock_id` integer PRIMARY KEY NOT NULL,
	`rsi_10` real,
	`rsi_10_percentile` real,
	`rsi_40` real,
	`rsi_40_percentile` real,
	`rsi_120` real,
	`rsi_120_percentile` real,
	`rsi_min_percentile` real,
	`is_blue_chip` integer DEFAULT false NOT NULL,
	`revenue_trend` integer,
	`percentile_sample_bars` integer,
	`computed_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_rsi_percentile`("stock_id", "rsi_10", "rsi_10_percentile", "rsi_40", "rsi_40_percentile", "rsi_120", "rsi_120_percentile", "rsi_min_percentile", "is_blue_chip", "revenue_trend", "percentile_sample_bars", "computed_at") SELECT "stock_id", "rsi_10", "rsi_10_percentile", "rsi_40", "rsi_40_percentile", "rsi_120", "rsi_120_percentile", "rsi_min_percentile", "is_blue_chip", "revenue_trend", "percentile_sample_bars", "computed_at" FROM `rsi_percentile`;--> statement-breakpoint
DROP TABLE `rsi_percentile`;--> statement-breakpoint
ALTER TABLE `__new_rsi_percentile` RENAME TO `rsi_percentile`;--> statement-breakpoint
CREATE INDEX `idx_rsi_percentile_min` ON `rsi_percentile` (`rsi_min_percentile`);--> statement-breakpoint
CREATE INDEX `idx_rsi_percentile_blue_chip` ON `rsi_percentile` (`is_blue_chip`);--> statement-breakpoint
CREATE TABLE `__new_otakara_stock_financials` (
	`stock_id` integer PRIMARY KEY NOT NULL,
	`price` real,
	`per` real,
	`pbr` real,
	`dividend_yield` real,
	`eps` real,
	`bps` real,
	`roe` real,
	`roa` real,
	`market_cap` real,
	`ma_5` real,
	`ma_25` real,
	`ma_75` real,
	`rsi_14` real,
	`macd` real,
	`macd_signal` real,
	`yutai_yield` real,
	`fetched_at` integer DEFAULT (unixepoch()) NOT NULL,
	`data_date` text NOT NULL,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_otakara_stock_financials`("stock_id", "price", "per", "pbr", "dividend_yield", "eps", "bps", "roe", "roa", "market_cap", "ma_5", "ma_25", "ma_75", "rsi_14", "macd", "macd_signal", "yutai_yield", "fetched_at", "data_date") SELECT "stock_id", "price", "per", "pbr", "dividend_yield", "eps", "bps", "roe", "roa", "market_cap", "ma_5", "ma_25", "ma_75", "rsi_14", "macd", "macd_signal", "yutai_yield", "fetched_at", "data_date" FROM `otakara_stock_financials`;--> statement-breakpoint
DROP TABLE `otakara_stock_financials`;--> statement-breakpoint
ALTER TABLE `__new_otakara_stock_financials` RENAME TO `otakara_stock_financials`;--> statement-breakpoint
CREATE TABLE `__new_otakara_stock_scores` (
	`stock_id` integer PRIMARY KEY NOT NULL,
	`fundamental_score` real NOT NULL,
	`technical_score` real NOT NULL,
	`total_score` real NOT NULL,
	`yutai_months` text,
	`yutai_genre_ids` text,
	`scored_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_otakara_stock_scores`("stock_id", "fundamental_score", "technical_score", "total_score", "yutai_months", "yutai_genre_ids", "scored_at") SELECT "stock_id", "fundamental_score", "technical_score", "total_score", "yutai_months", "yutai_genre_ids", "scored_at" FROM `otakara_stock_scores`;--> statement-breakpoint
DROP TABLE `otakara_stock_scores`;--> statement-breakpoint
ALTER TABLE `__new_otakara_stock_scores` RENAME TO `otakara_stock_scores`;--> statement-breakpoint
ALTER TABLE `swing_sector_daily` DROP COLUMN `pct_5d`;