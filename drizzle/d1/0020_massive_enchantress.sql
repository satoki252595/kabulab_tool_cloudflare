CREATE TABLE `ir_disclosure_texts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`disclosure_id` integer NOT NULL,
	`tdnet_id` text NOT NULL,
	`text` text NOT NULL,
	`char_count` integer NOT NULL,
	FOREIGN KEY (`disclosure_id`) REFERENCES `ir_disclosures`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ir_texts_disclosure_uq` ON `ir_disclosure_texts` (`disclosure_id`);--> statement-breakpoint
CREATE INDEX `ir_texts_tdnet_idx` ON `ir_disclosure_texts` (`tdnet_id`);--> statement-breakpoint
ALTER TABLE `ir_disclosures` ADD `pdf_text_status` text;