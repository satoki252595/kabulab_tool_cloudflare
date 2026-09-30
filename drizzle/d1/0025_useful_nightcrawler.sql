CREATE TABLE `universe_official_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`kind` text NOT NULL,
	`effective_date` text NOT NULL,
	`name` text,
	`market_from` text,
	`market_to` text,
	`source_url` text NOT NULL,
	`fetched_at` text NOT NULL,
	`raw_sha` text NOT NULL,
	`archive_key` text NOT NULL,
	`last_seen_fetched_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_universe_official_events_code_kind_date` ON `universe_official_events` (`code`,`kind`,`effective_date`);--> statement-breakpoint
CREATE INDEX `idx_universe_official_events_kind_date` ON `universe_official_events` (`kind`,`effective_date`);--> statement-breakpoint
CREATE TABLE `universe_overlay_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`base_as_of` text,
	`events_fetched_at` text,
	`events_sha` text,
	`eligibility_as_of` text,
	`applied_at` text,
	`applied_delist` integer DEFAULT 0 NOT NULL,
	`applied_listing` integer DEFAULT 0 NOT NULL,
	`applied_transfer` integer DEFAULT 0 NOT NULL,
	`held_listing_codes` text
);
