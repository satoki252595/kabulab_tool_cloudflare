CREATE TABLE `yuho_text_sections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` integer NOT NULL,
	`stock_id` integer NOT NULL,
	`fiscal_year_end` text NOT NULL,
	`section_key` text NOT NULL,
	`text` text NOT NULL,
	`element_id` text NOT NULL,
	`item_name` text NOT NULL,
	`context_id` text NOT NULL,
	`char_count` integer NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `yuho_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`stock_id`) REFERENCES `core_stocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `text_sections_doc_section_uq` ON `yuho_text_sections` (`document_id`,`section_key`);--> statement-breakpoint
CREATE INDEX `text_sections_stock_section_period_idx` ON `yuho_text_sections` (`stock_id`,`section_key`,`fiscal_year_end`);--> statement-breakpoint
ALTER TABLE `yuho_documents` ADD `text_parse_status` text;