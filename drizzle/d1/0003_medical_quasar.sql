CREATE TABLE `oseas_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stock_id` integer NOT NULL,
	`edinet_code` text NOT NULL,
	`doc_id` text NOT NULL,
	`doc_type_code` text NOT NULL,
	`filer_name` text NOT NULL,
	`period_start` text,
	`period_end` text NOT NULL,
	`submitted_at` integer NOT NULL,
	`parse_status` text NOT NULL,
	`honbun_file` text,
	`ingested_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oseas_documents_doc_id_unique` ON `oseas_documents` (`doc_id`);--> statement-breakpoint
CREATE INDEX `oseas_documents_stock_idx` ON `oseas_documents` (`stock_id`);--> statement-breakpoint
CREATE TABLE `oseas_sales_facts` (
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
	FOREIGN KEY (`document_id`) REFERENCES `oseas_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oseas_facts_doc_period_region_uq` ON `oseas_sales_facts` (`document_id`,`fiscal_year_end`,`region_name`);--> statement-breakpoint
CREATE INDEX `oseas_facts_stock_period_idx` ON `oseas_sales_facts` (`stock_id`,`fiscal_year_end`);