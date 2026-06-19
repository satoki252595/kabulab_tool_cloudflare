CREATE TABLE `core_stock_annual_financials` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`stock_id` integer NOT NULL,
	`fiscal_year` integer NOT NULL,
	`revenue` real,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_core_annual_stock_year` ON `core_stock_annual_financials` (`stock_id`,`fiscal_year`);--> statement-breakpoint
CREATE TABLE `core_stock_financials` (
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
	`operating_margin` real,
	`data_date` text NOT NULL,
	`fetched_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `core_stock_financials_stock_id_unique` ON `core_stock_financials` (`stock_id`);--> statement-breakpoint
CREATE INDEX `idx_core_financials_stock_id` ON `core_stock_financials` (`stock_id`);--> statement-breakpoint
CREATE TABLE `core_stocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`market` text NOT NULL,
	`sector` text,
	`is_active` integer DEFAULT true NOT NULL,
	`is_yutai` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `core_stocks_code_unique` ON `core_stocks` (`code`);--> statement-breakpoint
CREATE TABLE `yuho_order_facts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` integer NOT NULL,
	`stock_id` integer NOT NULL,
	`fiscal_year_end` text NOT NULL,
	`segment_name` text NOT NULL,
	`segment_kind` text NOT NULL,
	`is_consolidated` integer,
	`unit_label` text NOT NULL,
	`orders_received_raw` real,
	`order_backlog_raw` real,
	`orders_received_yen` integer,
	`order_backlog_yen` integer,
	`pattern` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `yuho_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_facts_doc_period_seg_uq` ON `yuho_order_facts` (`document_id`,`fiscal_year_end`,`segment_name`);--> statement-breakpoint
CREATE INDEX `order_facts_stock_period_idx` ON `yuho_order_facts` (`stock_id`,`fiscal_year_end`);--> statement-breakpoint
CREATE TABLE `yuho_documents` (
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
CREATE UNIQUE INDEX `yuho_documents_doc_id_unique` ON `yuho_documents` (`doc_id`);--> statement-breakpoint
CREATE INDEX `yuho_documents_stock_idx` ON `yuho_documents` (`stock_id`);