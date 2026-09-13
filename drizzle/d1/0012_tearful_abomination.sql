-- 本番へ流すのは **stockStock の地図の変更がマージされた後**、手順を読んでから。
--
-- 旧 004 financial-math の遅延キャッシュ 2 表を消す。PR #23 で読み取り面を
-- core_stock_financials / swing_daily_ohlcv / swing_market_context へ振り替え、
-- src/ services/ worker/ scripts/ から読み書きが無くなった。索引
-- (idx_finmath_price_code / idx_finmath_ohlcv_symbol / idx_finmath_ohlcv_symbol_date)
-- と sqlite_sequence の行は DROP TABLE と一緒に消える。
--
-- 退避: 本番の全行 (3,759 行 / 3,490 行、2026-09-13 取得) と CREATE 文は
-- ~/kabulab-cf-backup-20260913/d1-finmath/ にあり、復元手順は同ディレクトリの
-- README.md。流す前に行数と MAX(fetched_at) が退避時と同じか確かめること
-- (変わっていたらまだ書いている経路がある = 流さない)。手順は drizzle/d1/README.md。

DROP TABLE `finmath_daily_ohlcv`;--> statement-breakpoint
DROP TABLE `finmath_price_snapshot`;
