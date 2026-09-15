# scripts/

ルートレベルのスクリプト一覧。kabulab mono-repo 横断で使うエントリポイントだけをここに置く。
サービス内部の細かなユーティリティは `services/<slug>/src/scripts/` または
`services/<slug>/data-scripts/` に置く。

> 全サービスを **Cloudflare D1 + R2 + Notion** へ移行済み（Neon 全廃）。
> 日次/月次の指標・スコア計算は **GitHub Actions (Node)** が自動実行する。本ディレクトリの
> `sync/*` は手動/CI 用の実行入口、`vwap/*` は GitHub Actions 用の取込。
> 旧 `migrate/*` (Neon→D1 移行ツール) は K1a で削除済み。

```
scripts/
├── README.md                         # このファイル
├── sync/                             # 取込トリガ / 母集団 seed
│   ├── daily.ts                      # pnpm sync:daily:core — core/rsi/swing を計算して D1 へ書込
│   ├── monthly.ts                    # pnpm sync:monthly:core — otakara 派生テーブルを再構築
│   ├── universe.ts                   # pnpm sync:universe — 東証母集団を core_stocks に seed (Node・xlsx)
│   ├── all-daily.ts / all-monthly.ts # ローカル手動フル実行のオーケストレータ
│   ├── yuho-edinet.ts              # 005: Worker /yuho-quant/admin/catchup を叩く薄いトリガ
│   ├── ir-tdnet.ts                 # 006: TDnet を Node 直接実行 (kuromoji) → D1 HTTP 書込
└── vwap/                             # 007 VWAP 取込 → R2 (GitHub Actions で定期実行)
    ├── ingest-daily.ts / ingest-intra.ts / ingest-margin.ts
    └── lib/                          # R2(S3互換) / Yahoo(YAHOO_PROXY_BASE 経由) / codes ヘルパ
```

## 運用サマリ（定点ジョブ）

| ジョブ | 実行 | コマンド / トリガ |
|---|---|---|
| 日次 stock sync (core/rsi/swing) | **自動** (GitHub Actions) | `.github/workflows/stock-sync.yml`(平日 21:00 UTC) / 手動 `pnpm sync:daily:core` |
| 月次 母集団 + otakara rebuild | **自動** (GitHub Actions) | 同上(10 日 01:30 UTC) / 手動 `pnpm sync:universe` + `pnpm sync:monthly:core` |
| VWAP 日足/5分足/信用 → R2 | **自動** (GitHub Actions) | `.github/workflows/vwap-ingest.yml` / 手動 `pnpm ingest:vwap-*` |
| 005 EDINET / 006 TDnet | **自動** (GitHub Actions) | `.github/workflows/catchup.yml`(平日 11:00 UTC) / 手動 `pnpm ingest:yuho-edinet` / `ingest:ir-tdnet` |
| 002 優待スクレイプ+LLM要約 | 手動 (Node) + 要約は外部のクラウド LLM | `services/otakara-yutai/data-scripts/*`（月次）/ [作業仕様書](../services/otakara-yutai/docs/llm-summary-task.md) |

詳細・前提・残タスクは root [`README.md`](../README.md#運用ステータス自動化手作業残タスク) と
[`docs/deploy-cloudflare.md`](../docs/deploy-cloudflare.md) を参照。

## 取込の実装メモ

- `sync/daily.ts`(= [`src/cron/daily.ts`](../src/cron/daily.ts)) / `sync/monthly.ts`(=
  [`src/cron/monthly.ts`](../src/cron/monthly.ts)) は **Node 実行**。D1 へは `createD1HttpDb`
  (D1 REST)で書き、Yahoo は共有クライアントが `YAHOO_PROXY_BASE`(Worker エッジの
  `/api/ingest/yahoo`)経由で叩いて 429 を回避する。OHLCV は増分 upsert。
- `vwap/*` も Node 実行。Yahoo は共有クライアントが `/api/ingest/yahoo` 経由 (旧 `/vwap-analysis/api/ingest-fetch` は K4c-1 で廃止)、R2 へは S3 互換 API。
- Worker(無料プラン)は配信 + 取込プロキシ + 005/006 の /admin/catchup のみ(Workers Cron は不使用)。
- スキーマ反映は `pnpm db:generate:d1` →
  `wrangler d1 execute kabulab-cf --remote --file=drizzle/d1/<n>.sql`
  （旧 Neon 用の `scripts/db/*.mjs` は D1 移行で廃止・削除済み）。

## 環境変数

root `.env` を使う（`.env.example` 参照）。本番 Worker 側は Cloudflare Secret が正のソース。
取込で使う主なもの: `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `D1_DATABASE_ID`
（D1 HTTP 書込）、`WORKER_BASE_URL` / `CRON_SECRET`（Worker トリガ）、
`YAHOO_PROXY_BASE`（全取込のエッジ経由 Yahoo）、`R2_*`（VWAP の R2 書込）、
`EDINET_API_KEY` / `NOTION_TOKEN` ほか。
