CREATE TABLE `yuho_edinet_reported_resolutions` (
	`source_page_id` text NOT NULL,
	`seq_number` integer NOT NULL,
	`source_raw_sha256` text NOT NULL,
	`observation_json` text NOT NULL,
	`doc_id` text NOT NULL,
	`metadata_sha256` text NOT NULL,
	`proof_json` text NOT NULL,
	`resolved_at` integer NOT NULL,
	PRIMARY KEY(`source_page_id`, `seq_number`)
);
--> statement-breakpoint
CREATE INDEX `yuho_edinet_resolution_input_idx` ON `yuho_edinet_reported_resolutions` (`doc_id`,`metadata_sha256`);