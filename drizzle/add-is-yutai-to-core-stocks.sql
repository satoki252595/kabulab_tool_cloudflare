-- core.stocks に is_yutai 列を追加する。
--
-- 母集団を全 JPX 上場内国株 (~4,000) に拡張した一方、002 otakara-yutai は
-- 優待銘柄のみを母集団とするため is_yutai フラグで切り分ける。
--
-- 非破壊・冪等: 追加列のみ。DEFAULT false で既存行は全て false 埋め。
-- IF NOT EXISTS により再適用しても安全。
ALTER TABLE "core"."stocks"
  ADD COLUMN IF NOT EXISTS "is_yutai" boolean DEFAULT false NOT NULL;
