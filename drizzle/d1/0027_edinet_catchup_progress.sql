CREATE TABLE `yuho_edinet_catchup_progress` (
	`scope` text NOT NULL,
	`date` text NOT NULL,
	`snapshot` text,
	`completed_ids` text DEFAULT '[]' NOT NULL,
	`pending_ids` text DEFAULT '[]' NOT NULL,
	`finished` integer DEFAULT false NOT NULL,
	`sealed` integer DEFAULT false NOT NULL,
	`in_flight_doc_id` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`pending_checked_date` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`scope`, `date`)
);
--> statement-breakpoint
CREATE INDEX `yuho_edinet_progress_queue_idx` ON `yuho_edinet_catchup_progress` (`scope`,`finished`,`sealed`,`date`);