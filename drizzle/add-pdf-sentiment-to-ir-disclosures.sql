-- PDF 本文から判定したポジ/ネガを保持する 4 列を追加 (冪等)
-- (CLAUDE.md ルール6: 一次データ Notion / 二次 Notion 子DB と独立に、
--  PG 側でも判定結果を正本として保持し UI クエリで使う)
--
-- pdf_sentiment        : positive / negative / mixed / unknown / skipped (NULL=未判定)
-- pdf_sentiment_method : rule_v1 (数値テーブル) / dict_v1 (極性辞書) / null
-- pdf_sentiment_score  : -1.0 to +1.0 (rule_v1 は 1.0 か NULL、dict_v1 は集計スコア)
-- pdf_sentiment_at     : 判定時刻 (再判定検出用)
ALTER TABLE "ir_catalog"."disclosures"
  ADD COLUMN IF NOT EXISTS "pdf_sentiment" text;
--> statement-breakpoint
ALTER TABLE "ir_catalog"."disclosures"
  ADD COLUMN IF NOT EXISTS "pdf_sentiment_method" text;
--> statement-breakpoint
ALTER TABLE "ir_catalog"."disclosures"
  ADD COLUMN IF NOT EXISTS "pdf_sentiment_score" real;
--> statement-breakpoint
ALTER TABLE "ir_catalog"."disclosures"
  ADD COLUMN IF NOT EXISTS "pdf_sentiment_at" timestamptz;
--> statement-breakpoint
-- UI で「PDF 判定がポジの開示だけ抽出」「期間内 + sentiment 別集計」等を
-- 効かせるため、pdf_sentiment 単独 index を作成 (sparse=NULL多のため部分 index)
CREATE INDEX IF NOT EXISTS "ir_disclosures_pdf_sentiment_idx"
  ON "ir_catalog"."disclosures" ("pdf_sentiment")
  WHERE "pdf_sentiment" IS NOT NULL;
