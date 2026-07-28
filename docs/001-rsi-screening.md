# 001 RSI Screening — kabulab

過去 5 年間で RSI（10/40/120 営業日）が最も低水準にある優良株を発見するスクリーニングサービス。

> kabulab mono-repo (`services/rsi-screening/`) として配置され、`https://kabulab-cf.satoki252595.workers.dev/rsi-screening/*` で公開される (Cloudflare Workers にデプロイ)。

## コンセプト

- RSI の **パーセンタイル順位** で「今が 5 年間で何%の底値水準か」を定量化
- 3 期間 (短期 10 日 / 中期 40 日 / 長期 120 日) の RSI を同時に評価
- 優良株フィルタ: 売上高増加（過去 3 年）AND 営業利益率 TTM ≥ 5% を満たす銘柄のみ

## ディレクトリ構成

```
services/rsi-screening/
├── app.ts                     # Hono サブアプリ公開エントリ (export default app)
├── base-path.ts               # export const BASE_PATH = "/rsi-screening"
├── src/
│   ├── index.ts               # Hono アプリ本体 (API + SSR 配線、onError)
│   ├── db/
│   │   ├── client.ts          # createDb(c.env.DB) — D1 + Drizzle (drizzle-orm/d1)
│   │   ├── core-schema.ts     # core_* (共有テーブル)
│   │   └── schema.ts          # rsi_percentile (固有テーブル)
│   ├── routes/
│   │   ├── screening.ts       # GET /api/screening
│   │   ├── stocks.ts          # GET /api/stocks/:code
│   │   └── pages.ts           # SSR: /, /screening, /stocks/:code
│   ├── services/
│   │   ├── screening-service.ts     # スクリーニングクエリ (UI)
│   │   └── stock-detail-service.ts  # 個別銘柄クエリ (UI)
│   ├── views/                 # template literal を返す .ts 関数 (layout/home/screening/stock-detail)
│   ├── validators/            # Zod スキーマ
│   ├── middleware/            # error-handler
│   └── tests/unit/            # ユニットテスト (shared/indicators 配下を参照)
├── drizzle/                   # drizzle-kit 生成の migration
├── CLAUDE.md
└── README.md
```

**過去から変わった点**: 2026-04 の sync 統一化で本サービス固有の `yahoo-finance.ts` / `sync-service.ts` / `rsi-calculator.ts` / `percentile-engine.ts` / `blue-chip-filter.ts` / `scripts/sync-daily.ts` / `scripts/seed-stocks.ts` / `validators/yahoo-finance.ts` は **削除**。計算ロジックは `src/shared/indicators/` (root 直下) に移動し、日次 sync は `scripts/sync/daily.ts` の全サービス共通オーケストレータを Node (GitHub Actions) から実行する。

ルート Hono アプリ (`src/index.ts`) は次のようにマウントする:

```ts
import { rsiScreeningApp, BASE_PATH as RSI_BASE_PATH } from "../services/rsi-screening/app.js";
app.route(RSI_BASE_PATH, rsiScreeningApp);
```

**Cron は本サービス内には無い**。日次同期は **GitHub Actions** (`.github/workflows/stock-sync.yml`) が Node から D1 REST 経由で全サービス分を一括実行し、本サービスのテーブルも更新される (Workers Cron / Workers Paid は不使用)。母集団は 2026-05 に「優待縛り ~1,600」から **東証プライム／スタンダード／グロースの内国株式（共有4文字コード、約3,700）** へ拡張済み。本サービスは全 active 銘柄を対象とする (is_yutai は 002 専用フラグで RSI 判定には無関係)。

## DB スキーマ

### core_* (共有 — 日次 sync が更新)

D1(SQLite) 版の型表記 (ADR-0001): `serial`→`integer PK autoincrement`、`boolean`→`integer(mode:boolean)`、`date`→`text('YYYY-MM-DD')`、`timestamptz`→`integer(mode:timestamp)`。

```
core_stocks
├── id          integer PK (autoincrement)
├── code        text UNIQUE          # 4 桁銘柄コード
├── name        text
├── market      text
├── sector      text?                # 月次 sync で JPX 33 業種を backfill
├── is_active   integer(boolean)     # Yahoo 404 時に false に更新
├── is_yutai    integer(boolean)     # 002 専用の母集団フラグ
└── created_at / updated_at

core_stock_financials
├── id                 integer PK (autoincrement)
├── stock_id           FK → core_stocks (CASCADE, UNIQUE)
├── price / per / pbr / dividend_yield      real?
├── eps / bps / roe / roa / market_cap      real?
├── operating_margin   real?          # TTM (financialData.operatingMargins の生値)
├── data_date          text           # 'YYYY-MM-DD'
└── fetched_at         integer(timestamp)

core_stock_annual_financials
├── id           integer PK (autoincrement)
├── stock_id     FK → core_stocks (CASCADE)
├── fiscal_year  integer              # UNIQUE(stock_id, fiscal_year)
└── revenue      real?
```

> 過去には `core_stock_price_history` (5 年分の OHLCV) も持っていたが、
> RSI 計算がメモリ上で完結し DB を読み返さないため 2026-04 に削除した。
> Yahoo の `incomeStatementHistory.operatingIncome` も 2025 年頃に空オブジェクトを返すように
> なったため、年度別の営業利益は `core_stock_annual_financials` に保持していない。

### rsi_percentile (001 固有)

```
rsi_percentile
├── id                       integer PK (autoincrement)
├── stock_id                 FK → core_stocks (CASCADE, UNIQUE)
├── rsi_10 / rsi_10_percentile          real?
├── rsi_40 / rsi_40_percentile          real?
├── rsi_120 / rsi_120_percentile        real?
├── rsi_min_percentile       real?      # 3 期間の最小パーセンタイル
├── is_blue_chip             integer(boolean)   # 優良株フラグ
├── operating_margin_ttm     real?      # 営業利益率 TTM
├── revenue_trend            integer?   # +1=上昇 / 0=横ばい / -1=下降
└── computed_at              integer(timestamp)
```

> 過去には `rsi_stock_rsi_history` (5 年分の日次 RSI 時系列) も持っていたが、
> パーセンタイル算出がメモリ上で完結するため 2026-04 に削除した。

## スクリーニング API

```
GET /api/screening
  ?period=min          # "10" | "40" | "120" | "min"
  &percentileMax=10    # パーセンタイル上限 (0-100)
  &blueChip=true       # 優良株のみ
  &sort=percentile     # "percentile" | "rsi" | "marketCap"
  &limit=50&offset=0
```

## データ更新フロー

本サービスは独自の sync を持たない。**統一日次 sync** ([scripts/sync/daily.ts](../scripts/sync/daily.ts)) を Node (GitHub Actions) から実行し、1 銘柄あたり Yahoo Chart(5y) + QuoteSummary を 1 回ずつ叩いて、以下を in-memory で計算し D1 REST 経由で書き込む (Yahoo 取得は Worker エッジ `/api/ingest/yahoo` = `YAHOO_PROXY_BASE` 経由で 429 を回避):

1. `calculateAllRsiSeries(closes)` ([src/shared/indicators/rsi.ts](../src/shared/indicators/rsi.ts)) で RSI(10/40/120) 時系列
2. `computeRsiPercentileSnapshot` ([src/shared/indicators/percentile.ts](../src/shared/indicators/percentile.ts)) で最新値のパーセンタイル順位
3. `evaluateBlueChip` ([src/shared/indicators/blue-chip.ts](../src/shared/indicators/blue-chip.ts)) で優良株判定
4. `core_stock_annual_financials` / `core_stock_financials` / `rsi_percentile` へ upsert

起動:

```bash
pnpm sync:daily:core # core/rsi/swing 単体の手動実行
```

自動実行: GitHub Actions (`.github/workflows/stock-sync.yml`) が日次で `pnpm sync:daily:core` を実行し、全 active を一括処理する (Workers Cron / Workers Paid は不使用)。`pnpm sync:daily` はこれに VWAP 3 工程を加えたローカル手動フル実行。

## 優良株判定ロジック

[src/shared/indicators/blue-chip.ts](../src/shared/indicators/blue-chip.ts) の実装:

- `judgeTrend(values)`: 全期間変化率 > +5% かつ 各年 YoY 下落が -5% 以下 → 上昇トレンド (+1)
- `evaluateBlueChip`: 売上高トレンド=上昇 AND 営業利益率 TTM ≥ 5% → `isBlueChip: true`
- 売上高の判定には 3 年分のデータが必要（不足時は `isBlueChip: false`）
