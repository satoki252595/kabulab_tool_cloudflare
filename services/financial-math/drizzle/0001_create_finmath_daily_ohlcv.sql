-- 004 Financial Math: 第 2 マイグレーション
-- ---------------------------------------------------------------------------
-- 目的:
--   finmath.daily_ohlcv を追加。
--   - 日本株 4 桁コード ("1414", "7203" など) と指数シンボル ("^N225") を
--     1 本のテーブルで持つ (symbol カラム)。
--   - swing.daily_ohlcv からは独立。母集団は core.stocks に縛られない。
--   - 鮮度は同一 symbol の MAX(fetched_at) で判定する (per-row TTL)。
--
-- 用途:
--   - CAPM β 自動推定 (対象銘柄 OHLCV + ^N225 OHLCV)
--   - Black-Scholes ヒストリカルボラ (対象銘柄 OHLCV)
--
-- 適用方法:
--   psql "$DATABASE_URL" -f services/financial-math/drizzle/0001_create_finmath_daily_ohlcv.sql
--
-- 安全性: 「追加のみ」+ IF NOT EXISTS。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "finmath"."daily_ohlcv" (
    "id"          serial PRIMARY KEY,
    "symbol"      text NOT NULL,
    "date"        date NOT NULL,
    "open"        real,
    "high"        real,
    "low"         real,
    "close"       real,
    "volume"      real,
    "fetched_at"  timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_finmath_ohlcv_symbol_date"
    ON "finmath"."daily_ohlcv" ("symbol", "date");

CREATE INDEX IF NOT EXISTS "idx_finmath_ohlcv_symbol"
    ON "finmath"."daily_ohlcv" ("symbol");
