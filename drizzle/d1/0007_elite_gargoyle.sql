CREATE TABLE `yuho_overseas_facts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` integer NOT NULL,
	`stock_id` integer NOT NULL,
	`fiscal_year_end` text NOT NULL,
	`region_name` text NOT NULL,
	`region_kind` text NOT NULL,
	`is_consolidated` integer,
	`unit_label` text NOT NULL,
	`sales_raw` real,
	`sales_yen` integer,
	`ratio_pct` real,
	`pattern` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `yuho_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `overseas_facts_doc_period_region_uq` ON `yuho_overseas_facts` (`document_id`,`fiscal_year_end`,`region_name`);--> statement-breakpoint
CREATE INDEX `overseas_facts_stock_period_idx` ON `yuho_overseas_facts` (`stock_id`,`fiscal_year_end`);--> statement-breakpoint
CREATE INDEX `overseas_facts_kind_stock_idx` ON `yuho_overseas_facts` (`region_kind`,`stock_id`,`fiscal_year_end`);--> statement-breakpoint
ALTER TABLE `yuho_documents` ADD `overseas_parse_status` text;--> statement-breakpoint
ALTER TABLE `yuho_documents` ADD `overseas_honbun_file` text;