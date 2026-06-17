-- is_yutai を public.yutai_benefits から導出してバックフィルする。
--
-- is_yutai 列追加 (default false) + 母集団 ~4,000 への再 seed 直後は
-- 全 false で otakara が空になる。優待スクレイパーを再実行しなくても、
-- 既存の yutai_benefits (優待がある銘柄に行が存在) から一意に導出できる。
-- 月次 sync (src/cron/monthly.ts Phase 1.5) が今後毎月同じ導出を行うため、
-- これは「次回月次を待たず今すぐ otakara を復旧する」ための一回適用。
--
-- 非破壊・冪等: boolean フラグを差分のある行だけ反転。再適用しても安全。
UPDATE core.stocks s
SET is_yutai = EXISTS (
      SELECT 1 FROM public.yutai_benefits yb WHERE yb.stock_id = s.id
    ),
    updated_at = now()
WHERE s.is_yutai <> EXISTS (
      SELECT 1 FROM public.yutai_benefits yb WHERE yb.stock_id = s.id
    );
