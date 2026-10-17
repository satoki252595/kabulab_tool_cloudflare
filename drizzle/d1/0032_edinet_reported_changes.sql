CREATE TABLE `yuho_edinet_reported_changes` (
	`source_page_id` text NOT NULL,
	`seq_number` integer NOT NULL,
	`source_raw_sha256` text NOT NULL,
	`doc_id` text NOT NULL,
	`parent_doc_id` text,
	`reported_state` text NOT NULL,
	`observation_json` text NOT NULL,
	`stock_id` integer,
	`period_end` text,
	`submitted_at` integer,
	PRIMARY KEY(`source_page_id`, `seq_number`)
);
--> statement-breakpoint
CREATE INDEX `yuho_edinet_reported_doc_idx` ON `yuho_edinet_reported_changes` (`doc_id`);--> statement-breakpoint
CREATE INDEX `yuho_edinet_reported_stock_period_idx` ON `yuho_edinet_reported_changes` (`stock_id`,`period_end`,`submitted_at`);