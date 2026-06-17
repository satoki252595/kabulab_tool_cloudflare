-- 004 Financial Math: 初期マイグレーション
-- ---------------------------------------------------------------------------
-- 目的:
--   このサービス専用のスキーマ `finmath` を作成し、Yahoo クライアントを
--   二次利用した価格スナップショットを保持する。core.stocks (otakara-yutai
--   が writer) に縛られず、1414 のような優待なし銘柄も DCF/CAPM/EMH/BS で
--   扱えるようにする。
--
-- 適用方法:
--   psql "$DATABASE_URL" -f services/financial-math/drizzle/0000_create_finmath.sql
--
-- 安全性:
--   - スキーマ + テーブル + インデックスの「追加のみ」。既存テーブルは触らない。
--   - 全 statement に IF NOT EXISTS を付けて冪等化済。
-- ---------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS "finmath";

CREATE TABLE IF NOT EXISTS "finmath"."price_snapshot" (
    "id"                    serial PRIMARY KEY,
    "code"                  text NOT NULL,
    "name"                  text,
    "price"                 real,
    "per"                   real,
    "pbr"                   real,
    "dividend_yield"        real,
    "eps"                   real,
    "bps"                   real,
    "roe"                   real,
    "roa"                   real,
    "market_cap"            real,
    "operating_margin_ttm"  real,
    "data_date"             date NOT NULL,
    "fetched_at"            timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_finmath_price_code"
    ON "finmath"."price_snapshot" ("code");
