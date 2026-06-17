-- public.stocks → core.stocks 統一マイグレーション
--
-- 目的:
--   銘柄マスタを core.stocks に 1 本化する。
--   public.stock_financials / public.stock_scores / public.yutai_benefits の
--   stock_id FK を public.stocks(id) から core.stocks(id) に付け替える。
--
-- 前提:
--   public.stocks と core.stocks の全行が code で 1:1 対応すること
--   (移行前に手動確認済み: 1625 行)
--
-- 単一トランザクションで実行する。失敗したら ROLLBACK。

BEGIN;

-- public.stock_financials -----------------------------------------------------
ALTER TABLE public.stock_financials ADD COLUMN new_stock_id integer;
UPDATE public.stock_financials sf
  SET new_stock_id = cs.id
  FROM public.stocks ps, core.stocks cs
  WHERE sf.stock_id = ps.id AND ps.code = cs.code;
-- すべての行が remap できたか検証 (失敗したら ROLLBACK)
DO $$
DECLARE
  missing_count integer;
BEGIN
  SELECT COUNT(*) INTO missing_count FROM public.stock_financials WHERE new_stock_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'public.stock_financials: new_stock_id が NULL の行が % 件', missing_count;
  END IF;
END $$;
ALTER TABLE public.stock_financials DROP CONSTRAINT stock_financials_stock_id_stocks_id_fk;
-- 旧ユニーク制約 (DrizzleのuniqueIndex命名) があれば drop
ALTER TABLE public.stock_financials DROP CONSTRAINT IF EXISTS stock_financials_stock_id_unique;
DROP INDEX IF EXISTS public.stock_financials_stock_id_unique;
ALTER TABLE public.stock_financials DROP COLUMN stock_id;
ALTER TABLE public.stock_financials RENAME COLUMN new_stock_id TO stock_id;
ALTER TABLE public.stock_financials ALTER COLUMN stock_id SET NOT NULL;
ALTER TABLE public.stock_financials
  ADD CONSTRAINT stock_financials_stock_id_core_fk
  FOREIGN KEY (stock_id) REFERENCES core.stocks(id);
ALTER TABLE public.stock_financials
  ADD CONSTRAINT stock_financials_stock_id_unique UNIQUE (stock_id);

-- public.stock_scores ---------------------------------------------------------
ALTER TABLE public.stock_scores ADD COLUMN new_stock_id integer;
UPDATE public.stock_scores ss
  SET new_stock_id = cs.id
  FROM public.stocks ps, core.stocks cs
  WHERE ss.stock_id = ps.id AND ps.code = cs.code;
DO $$
DECLARE
  missing_count integer;
BEGIN
  SELECT COUNT(*) INTO missing_count FROM public.stock_scores WHERE new_stock_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'public.stock_scores: new_stock_id が NULL の行が % 件', missing_count;
  END IF;
END $$;
ALTER TABLE public.stock_scores DROP CONSTRAINT stock_scores_stock_id_stocks_id_fk;
ALTER TABLE public.stock_scores DROP CONSTRAINT IF EXISTS stock_scores_stock_id_unique;
DROP INDEX IF EXISTS public.stock_scores_stock_id_unique;
ALTER TABLE public.stock_scores DROP COLUMN stock_id;
ALTER TABLE public.stock_scores RENAME COLUMN new_stock_id TO stock_id;
ALTER TABLE public.stock_scores ALTER COLUMN stock_id SET NOT NULL;
ALTER TABLE public.stock_scores
  ADD CONSTRAINT stock_scores_stock_id_core_fk
  FOREIGN KEY (stock_id) REFERENCES core.stocks(id);
ALTER TABLE public.stock_scores
  ADD CONSTRAINT stock_scores_stock_id_unique UNIQUE (stock_id);

-- public.yutai_benefits -------------------------------------------------------
ALTER TABLE public.yutai_benefits ADD COLUMN new_stock_id integer;
UPDATE public.yutai_benefits yb
  SET new_stock_id = cs.id
  FROM public.stocks ps, core.stocks cs
  WHERE yb.stock_id = ps.id AND ps.code = cs.code;
DO $$
DECLARE
  missing_count integer;
BEGIN
  SELECT COUNT(*) INTO missing_count FROM public.yutai_benefits WHERE new_stock_id IS NULL;
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'public.yutai_benefits: new_stock_id が NULL の行が % 件', missing_count;
  END IF;
END $$;
ALTER TABLE public.yutai_benefits DROP CONSTRAINT yutai_benefits_stock_id_stocks_id_fk;
DROP INDEX IF EXISTS public.idx_yutai_benefits_stock_id;
ALTER TABLE public.yutai_benefits DROP COLUMN stock_id;
ALTER TABLE public.yutai_benefits RENAME COLUMN new_stock_id TO stock_id;
ALTER TABLE public.yutai_benefits ALTER COLUMN stock_id SET NOT NULL;
ALTER TABLE public.yutai_benefits
  ADD CONSTRAINT yutai_benefits_stock_id_core_fk
  FOREIGN KEY (stock_id) REFERENCES core.stocks(id);
CREATE INDEX idx_yutai_benefits_stock_id ON public.yutai_benefits(stock_id);

-- 最後に public.stocks を drop
DROP TABLE public.stocks;

COMMIT;
