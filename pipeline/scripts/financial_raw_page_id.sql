-- Python-owned jss schema: run once after verifying the column is absent.
-- Adds only the original Notion page relation; existing 33 columns remain intact.
ALTER TABLE jss_financials ADD COLUMN raw_page_id TEXT;
