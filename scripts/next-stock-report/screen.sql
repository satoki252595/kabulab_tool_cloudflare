-- 次来る銘柄レポート 一次スクリーニング (D1 kabulab-cf / 読取専用)
-- 使い方: /*EXCLUDE*/ を過去紹介銘柄コードの SQL リスト ('6524','372A',...) に置換して
--   Cloudflare MCP d1_database_query (database_id は wrangler.toml の DB) で実行する。
-- 条件: 本決算3期の増収 + 営業利益率の連続上昇 + 会社予想も増収増益
--       + 上昇トレンド (25日線>75日線, 終値>75日線) + RSI 40〜75 + 流動性
-- 需給 (日証金 loan_bal) は選定の参考値のみ。jss_supply_latest は personal-only
-- のためレポート本文へ数値を転記しない。
WITH fy AS (
  SELECT code, fiscal_period_end, consolidated, net_sales, operating_income,
    ROW_NUMBER() OVER (PARTITION BY code ORDER BY fiscal_period_end DESC,
      CASE consolidated WHEN '連結' THEN 0 ELSE 1 END) rn
  FROM jss_financials WHERE disclosure_type = '本決算' AND net_sales > 0
), basis AS (
  SELECT code, consolidated FROM fy WHERE rn = 1
), r AS (
  SELECT f.code, f.fiscal_period_end, f.net_sales s, f.operating_income o,
    ROW_NUMBER() OVER (PARTITION BY f.code ORDER BY f.fiscal_period_end DESC) k
  FROM fy f JOIN basis b ON b.code = f.code AND b.consolidated = f.consolidated
), w AS (
  SELECT code,
    MAX(CASE WHEN k = 1 THEN fiscal_period_end END) fy1,
    MAX(CASE WHEN k = 1 THEN s END) s1, MAX(CASE WHEN k = 2 THEN s END) s2,
    MAX(CASE WHEN k = 3 THEN s END) s3, MAX(CASE WHEN k = 4 THEN s END) s4,
    MAX(CASE WHEN k = 1 THEN o END) o1, MAX(CASE WHEN k = 2 THEN o END) o2,
    MAX(CASE WHEN k = 3 THEN o END) o3
  FROM r WHERE k <= 4 GROUP BY code
), fc AS (
  -- 最新開示 (本決算/四半期) の会社予想。予想が無い銘柄は NULL のまま残す
  SELECT j.code, j.forecast_net_sales fs, j.forecast_operating_income fo, j.fiscal_period_end fc_period,
    ROW_NUMBER() OVER (PARTITION BY j.code ORDER BY j.fiscal_period_end DESC, j.disclosed_at DESC) rn
  FROM jss_financials j JOIN basis b ON b.code = j.code AND b.consolidated = j.consolidated
  WHERE j.forecast_net_sales IS NOT NULL
)
SELECT s.code, s.name, s.market, s.sector33 sec,
  round(f.market_cap / 1e8) mcap_oku, round(f.per, 1) per, round(f.pbr, 2) pbr,
  w.fy1, round(w.s3 / 1e8) s3, round(w.s2 / 1e8) s2, round(w.s1 / 1e8) s1, round(fc.fs / 1e8) fs,
  round(100.0 * w.o3 / w.s3, 1) m3, round(100.0 * w.o2 / w.s2, 1) m2,
  round(100.0 * w.o1 / w.s1, 1) m1, round(100.0 * fc.fo / fc.fs, 1) mf,
  i.latest_date, round(i.latest_close) px, round(i.rsi_14) rsi, i.perfect_order_long po,
  round(100.0 * (i.latest_close / i.sma_25 - 1), 1) dev25,
  round(100.0 * (i.latest_close / i.sma_75 - 1), 1) dev75,
  round(i.avg_turnover_20d / 1e8, 2) turnover_oku, round(i.volume_20d) vol20,
  round(1.0 * sl.loan_bal / i.volume_20d, 2) jsf_loan_days, sl.ratio jsf_ratio
FROM w
JOIN core_stocks s ON s.code = w.code AND s.is_active = 1 AND s.instrument_type = 'equity'
JOIN core_stock_financials f ON f.stock_id = s.id
JOIN swing_stock_indicators i ON i.stock_id = s.id
LEFT JOIN fc ON fc.code = w.code AND fc.rn = 1
LEFT JOIN jss_supply_latest sl ON sl.code = s.code
WHERE w.fy1 >= date('now', '-15 months')
  AND w.o3 > 0
  AND w.s1 > w.s2 AND w.s2 > w.s3 AND (w.s4 IS NULL OR w.s3 > w.s4)
  AND w.s1 >= 1.2 * w.s3
  AND 1.0 * w.o1 / w.s1 > 1.0 * w.o2 / w.s2
  AND 1.0 * w.o2 / w.s2 > 1.0 * w.o3 / w.s3
  AND 1.0 * w.o1 / w.s1 >= 0.08
  AND (fc.fs IS NULL OR fc.fc_period < w.fy1 OR (fc.fs > w.s1 AND fc.fo >= w.o1))
  AND i.latest_close > i.sma_75 AND i.sma_25 > i.sma_75
  AND i.latest_close <= i.sma_75 * 1.30
  AND i.rsi_14 BETWEEN 40 AND 75
  AND i.avg_turnover_20d >= 3e7
  AND f.market_cap BETWEEN 5e9 AND 5e11
  AND s.code NOT IN (/*EXCLUDE*/)
ORDER BY (1.0 * w.o1 / w.s1 - 1.0 * w.o3 / w.s3) DESC
LIMIT 40;
