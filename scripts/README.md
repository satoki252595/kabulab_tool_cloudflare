# scripts/

ルートレベルのスクリプト一覧。kabulab mono-repo 横断で使うエントリポイントだけをここに置く。

サービス内部の細かなユーティリティ (ファイル変換・1 回限りのインポート等) は
`services/<slug>/src/scripts/` または `services/<slug>/data-scripts/` に置く。

```
scripts/
├── README.md                         # このファイル
├── sync/                             # データ取得エントリポイント (定常運用は daily / monthly の 2 本)
│   ├── daily.ts                      # pnpm sync:daily   — 全サービスの日次取得 (Phase 0 で sync:universe 相当の母集団同期を内包)
│   ├── monthly.ts                    # pnpm sync:monthly — JPX セクター + otakara scoring
│   └── universe.ts                   # pnpm sync:universe — 明示 seed/復旧用 CLI (通常不要・毎日は叩かない)
└── db/                               # DB 整備・運用ユーティリティ
    ├── apply-migration.mjs           # drizzle 生成 SQL を Neon HTTP で直接適用 (--> statement-breakpoint 区切り)
    ├── apply-unify-migration.mjs     # public.stocks → core.stocks 統一移行 (2026-04 に 1 回限りで実行済み)
    └── check-db.mjs                  # 各スキーマの行数確認
```

`scripts/sync/daily.ts` と `scripts/sync/monthly.ts` はいずれも薄い CLI ラッパ。
実装本体は [`src/cron/daily.ts`](../src/cron/daily.ts) / [`src/cron/monthly.ts`](../src/cron/monthly.ts) にあり、
Vercel cron エンドポイント (`/api/cron/sync-daily`, `/api/cron/sync-monthly`) からも同じ関数が呼ばれる。

## 運用サマリ (定点ジョブ)

| ジョブ | 頻度 | 自動/手動 | コマンド or エンドポイント |
|---|---|---|---|
| 日次同期 | 平日毎日 | 自動 (Vercel cron) | `/api/cron/sync-daily` @ 20:00 UTC / ローカルは `pnpm sync:daily` |
| 月次再スコア | 月 1 回 | 自動 (Vercel cron) | `/api/cron/sync-monthly` @ 22:00 UTC 1日 / ローカルは `pnpm sync:monthly` |

詳細は root の [`README.md`](../README.md#運用--定点ジョブ) を参照。

## データ取得 — `scripts/sync/`

### 日次 — `sync:daily`

| 項目 | 値 |
|---|---|
| エントリ | [`scripts/sync/daily.ts`](./sync/daily.ts) |
| オーケストレータ | [`src/cron/daily.ts`](../src/cron/daily.ts) |
| 起動 | `pnpm sync:daily` |
| 母集団同期 | Phase 0 で JPX `data_j.xls` → `core.stocks` upsert (旧 `sync:universe` を内包。shard 分割時は shard 0 のみ。失敗時は警告 + 既存 core.stocks で続行) |
| 対象 | `core.stocks` の `is_active=true` 銘柄 (全 JPX 上場内国株 ~4,000 件。2026-05 に優待縛り ~1,600 から全内国株へ拡張) |
| Yahoo 呼び出し | 1 銘柄につき Chart(5y) + QuoteSummary を 1 回ずつ + マクロ指数 5 シンボル + 日経VI scrape 1 回 |
| 計算内容 | RSI(10/40/120) 時系列 → percentile snapshot / 優良株判定 / SMA(5/20/25/60/75) + ATR14 + RSI14 + MACD + 20日レンジ + フィボ + 5 条件スクリーニング + E&E 6 パターン + セクター集計 + A/B/C/D マクロ判定 |
| 書き込み先 | `core.stock_financials` / `core.stock_annual_financials` / `rsi.stock_rsi_percentile` / `swing.daily_ohlcv` / `swing.stock_indicators` / `swing.stock_screening` / `swing.entry_signals` / `swing.market_context` / `swing.sector_daily` |
| 並列度 | 5 ワーカー × 200ms 間隔 |
| 所要時間 | 20〜40 分 (Yahoo の応答次第) |
| 自動実行 | `vercel.json` の cron で平日 20:00 UTC (JST 翌 05:00) → `/api/cron/sync-daily` |
| 認証 | `Authorization: Bearer $CRON_SECRET` |

### 月次 — `sync:monthly`

| 項目 | 値 |
|---|---|
| エントリ | [`scripts/sync/monthly.ts`](./sync/monthly.ts) |
| オーケストレータ | [`src/cron/monthly.ts`](../src/cron/monthly.ts) |
| 起動 | `pnpm sync:monthly` |
| Yahoo 呼び出し | **0 回** (JPX XLS のダウンロードのみ) |
| 処理 | ①JPX 公式 XLS (`data_j.xls`) → `core.stocks.sector` を 33 業種区分で更新 ②`core.stock_financials` + `swing.stock_indicators` + `public.yutai_benefits` を読んで `public.stock_financials` / `public.stock_scores` を再計算 |
| 所要時間 | <1 分 |
| 自動実行 | `vercel.json` の cron で毎月 1 日 22:00 UTC (JST 2 日 07:00) → `/api/cron/sync-monthly` |
| 認証 | `Authorization: Bearer $CRON_SECRET` |

## DB ユーティリティ — `scripts/db/`

### `apply-migration.mjs`

`drizzle-kit push` が TTY を要求してうまく動かない環境向けの代替。
`drizzle-kit generate` や手書きの SQL ファイル (`--> statement-breakpoint` 区切り) を
1 文ずつ Neon HTTP 経由で実行する。

```bash
node scripts/db/apply-migration.mjs drizzle/unify-stocks-to-core.sql
```

### `check-db.mjs`

`core` / `rsi` / `public` スキーマのテーブル一覧と各テーブルの行数を表示する確認用スクリプト (現状 `swing` / `yuho_quant` / `ir_catalog` は対象外)。

```bash
node scripts/db/check-db.mjs
```

## 環境変数

すべてのスクリプトは root の `.env` から `DATABASE_URL` を読む。
Vercel の prod 環境変数と同じものを使う。

```
DATABASE_URL=postgresql://...neon.tech/neondb?sslmode=require
CRON_SECRET=...
```
