CREATE TABLE `rsi_percentile` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stock_id` integer NOT NULL,
	`rsi_10` real,
	`rsi_10_percentile` real,
	`rsi_40` real,
	`rsi_40_percentile` real,
	`rsi_120` real,
	`rsi_120_percentile` real,
	`rsi_min_percentile` real,
	`is_blue_chip` integer DEFAULT false NOT NULL,
	`operating_margin_ttm` real,
	`revenue_trend` integer,
	`computed_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rsi_percentile_stock_id_unique` ON `rsi_percentile` (`stock_id`);--> statement-breakpoint
CREATE INDEX `idx_rsi_percentile_min` ON `rsi_percentile` (`rsi_min_percentile`);--> statement-breakpoint
CREATE INDEX `idx_rsi_percentile_blue_chip` ON `rsi_percentile` (`is_blue_chip`);--> statement-breakpoint
CREATE TABLE `swing_daily_ohlcv` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stock_id` integer NOT NULL,
	`date` text NOT NULL,
	`open` real,
	`high` real,
	`low` real,
	`close` real,
	`volume` real,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_swing_ohlcv_stock_date` ON `swing_daily_ohlcv` (`stock_id`,`date`);--> statement-breakpoint
CREATE INDEX `idx_swing_ohlcv_date` ON `swing_daily_ohlcv` (`date`);--> statement-breakpoint
CREATE TABLE `swing_entry_signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stock_id` integer NOT NULL,
	`pattern` text NOT NULL,
	`direction` text NOT NULL,
	`entry_price` real NOT NULL,
	`stop_loss` real NOT NULL,
	`target_1` real,
	`target_2` real,
	`risk_reward_ratio` real,
	`signal_strength` real,
	`note` text,
	`computed_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_swing_signals_pattern_strength` ON `swing_entry_signals` (`pattern`,`signal_strength`);--> statement-breakpoint
CREATE INDEX `idx_swing_signals_stock` ON `swing_entry_signals` (`stock_id`);--> statement-breakpoint
CREATE INDEX `idx_swing_signals_computed` ON `swing_entry_signals` (`computed_at`);--> statement-breakpoint
CREATE TABLE `swing_market_context` (
	`date` text PRIMARY KEY NOT NULL,
	`nikkei_close` real,
	`nikkei_pct` real,
	`nikkei_vi` real,
	`topix_turnover_ratio` real,
	`futures_gap` real,
	`vix` real,
	`sp500_pct` real,
	`judgment` text NOT NULL,
	`judgment_reason` text NOT NULL,
	`computed_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `swing_sector_daily` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`sector` text NOT NULL,
	`pct_1d` real,
	`pct_5d` real,
	`stock_count` integer NOT NULL,
	`rank_1d` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_swing_sector_date_sector` ON `swing_sector_daily` (`date`,`sector`);--> statement-breakpoint
CREATE INDEX `idx_swing_sector_date_rank` ON `swing_sector_daily` (`date`,`rank_1d`);--> statement-breakpoint
CREATE TABLE `swing_stock_indicators` (
	`stock_id` integer PRIMARY KEY NOT NULL,
	`avg_turnover_20d` real,
	`volume_20d` real,
	`volume_ratio` real,
	`atr_14` real,
	`atr_pct` real,
	`sma_5` real,
	`sma_20` real,
	`sma_25` real,
	`sma_60` real,
	`sma_75` real,
	`trend_long` integer DEFAULT false NOT NULL,
	`trend_short` integer DEFAULT false NOT NULL,
	`perfect_order_long` integer DEFAULT false NOT NULL,
	`perfect_order_short` integer DEFAULT false NOT NULL,
	`rsi_14` real,
	`macd` real,
	`macd_signal` real,
	`macd_hist` real,
	`range_20d_high` real,
	`range_20d_low` real,
	`range_width` real,
	`fib_high` real,
	`fib_low` real,
	`fib_382` real,
	`fib_500` real,
	`fib_618` real,
	`latest_close` real,
	`latest_volume` real,
	`latest_date` text,
	`pct_change_1d` real,
	`computed_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_swing_indicators_trend_long` ON `swing_stock_indicators` (`trend_long`);--> statement-breakpoint
CREATE INDEX `idx_swing_indicators_turnover` ON `swing_stock_indicators` (`avg_turnover_20d`);--> statement-breakpoint
CREATE TABLE `swing_stock_screening` (
	`stock_id` integer PRIMARY KEY NOT NULL,
	`liquidity_ok` integer DEFAULT false NOT NULL,
	`volatility_ok` integer DEFAULT false NOT NULL,
	`trend_ok_long` integer DEFAULT false NOT NULL,
	`trend_ok_short` integer DEFAULT false NOT NULL,
	`supply_note` text DEFAULT '外部データ未対応' NOT NULL,
	`catalyst_note` text DEFAULT '外部データ未対応' NOT NULL,
	`all_passed_long` integer DEFAULT false NOT NULL,
	`all_passed_short` integer DEFAULT false NOT NULL,
	`computed_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_swing_screening_long` ON `swing_stock_screening` (`all_passed_long`);--> statement-breakpoint
CREATE INDEX `idx_swing_screening_short` ON `swing_stock_screening` (`all_passed_short`);--> statement-breakpoint
CREATE TABLE `otakara_stock_financials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stock_id` integer NOT NULL,
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
CREATE UNIQUE INDEX `otakara_stock_financials_stock_id_unique` ON `otakara_stock_financials` (`stock_id`);--> statement-breakpoint
CREATE INDEX `idx_otakara_financials_stock_id` ON `otakara_stock_financials` (`stock_id`);--> statement-breakpoint
CREATE TABLE `otakara_stock_scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stock_id` integer NOT NULL,
	`fundamental_score` real NOT NULL,
	`technical_score` real NOT NULL,
	`total_score` real NOT NULL,
	`scored_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `otakara_stock_scores_stock_id_unique` ON `otakara_stock_scores` (`stock_id`);--> statement-breakpoint
CREATE INDEX `idx_otakara_scores_stock_id` ON `otakara_stock_scores` (`stock_id`);--> statement-breakpoint
CREATE TABLE `yutai_benefits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stock_id` integer NOT NULL,
	`genre_id` integer NOT NULL,
	`description` text NOT NULL,
	`short_summary` text,
	`min_shares` integer NOT NULL,
	`record_month` integer NOT NULL,
	`estimated_value` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`genre_id`) REFERENCES `yutai_genres`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_yutai_benefits_stock_id` ON `yutai_benefits` (`stock_id`);--> statement-breakpoint
CREATE INDEX `idx_yutai_benefits_genre_id` ON `yutai_benefits` (`genre_id`);--> statement-breakpoint
CREATE TABLE `yutai_genres` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `yutai_genres_name_unique` ON `yutai_genres` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `yutai_genres_slug_unique` ON `yutai_genres` (`slug`);--> statement-breakpoint
CREATE TABLE `finmath_daily_ohlcv` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`date` text NOT NULL,
	`open` real,
	`high` real,
	`low` real,
	`close` real,
	`volume` real,
	`fetched_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finmath_ohlcv_symbol_date` ON `finmath_daily_ohlcv` (`symbol`,`date`);--> statement-breakpoint
CREATE INDEX `idx_finmath_ohlcv_symbol` ON `finmath_daily_ohlcv` (`symbol`);--> statement-breakpoint
CREATE TABLE `finmath_price_snapshot` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text,
	`price` real,
	`per` real,
	`pbr` real,
	`dividend_yield` real,
	`eps` real,
	`bps` real,
	`roe` real,
	`roa` real,
	`market_cap` real,
	`operating_margin_ttm` real,
	`data_date` text NOT NULL,
	`fetched_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_finmath_price_code` ON `finmath_price_snapshot` (`code`);