DROP INDEX `idx_core_financials_stock_id`;--> statement-breakpoint
DROP INDEX `ir_disclosures_tdnet_uq`;--> statement-breakpoint
DROP INDEX `ir_disclosures_pubdate_idx`;--> statement-breakpoint
DROP INDEX `ir_disclosures_pdf_sentiment_idx`;--> statement-breakpoint
CREATE INDEX `ir_disclosures_high_signal_pubdate` ON `ir_disclosures` ("pubdate" DESC) WHERE "primary_tag" IN ('上方修正','下方修正','増配','減配・無配','配当政策の変更','自社株買い','自己株式の消却');--> statement-breakpoint
DROP INDEX `idx_otakara_financials_stock_id`;--> statement-breakpoint
DROP INDEX `idx_otakara_scores_stock_id`;