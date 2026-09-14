DROP TABLE `swing_stock_screening`;--> statement-breakpoint
DROP INDEX `idx_swing_indicators_trend_long`;--> statement-breakpoint
DROP INDEX `idx_swing_indicators_turnover`;--> statement-breakpoint
ALTER TABLE `swing_stock_indicators` ADD `liquidity_ok` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `swing_stock_indicators` ADD `volatility_ok` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `swing_stock_indicators` ADD `trend_ok_long` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `swing_stock_indicators` ADD `trend_ok_short` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `swing_stock_indicators` ADD `all_passed_long` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `swing_stock_indicators` ADD `all_passed_short` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_swing_indicators_all_passed_long` ON `swing_stock_indicators` (`all_passed_long`);--> statement-breakpoint
CREATE INDEX `idx_swing_indicators_all_passed_short` ON `swing_stock_indicators` (`all_passed_short`);