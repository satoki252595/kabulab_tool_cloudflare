CREATE TABLE `ir_disclosures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stock_id` integer NOT NULL,
	`tdnet_id` text NOT NULL,
	`company_code` text NOT NULL,
	`company_name` text NOT NULL,
	`title` text NOT NULL,
	`pubdate` integer NOT NULL,
	`document_url` text NOT NULL,
	`xbrl_url` text,
	`markets_string` text,
	`tags` text NOT NULL,
	`primary_tag` text,
	`notion_page_id` text,
	`pdf_sentiment` text,
	`pdf_sentiment_method` text,
	`pdf_sentiment_score` real,
	`pdf_sentiment_at` integer,
	`ingested_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ir_disclosures_tdnet_id_unique` ON `ir_disclosures` (`tdnet_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ir_disclosures_tdnet_uq` ON `ir_disclosures` (`tdnet_id`);--> statement-breakpoint
CREATE INDEX `ir_disclosures_stock_pubdate_idx` ON `ir_disclosures` (`stock_id`,`pubdate`);--> statement-breakpoint
CREATE INDEX `ir_disclosures_pubdate_idx` ON `ir_disclosures` (`pubdate`);--> statement-breakpoint
CREATE INDEX `ir_disclosures_primary_tag_idx` ON `ir_disclosures` (`primary_tag`);--> statement-breakpoint
CREATE INDEX `ir_disclosures_pdf_sentiment_idx` ON `ir_disclosures` (`pdf_sentiment`);