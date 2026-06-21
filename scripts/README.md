# scripts/

ルートレベルのスクリプト一覧。kabulab mono-repo 横断で使うエントリポイントだけをここに置く。
サービス内部の細かなユーティリティは `services/<slug>/src/scripts/` または
`services/<slug>/data-scripts/` に置く。

> ADR-0001 で全サービスを **Cloudflare D1 + R2 + Notion** へ移行済み（Neon 全廃）。
> 日次/月次の指標・スコア計算は **Worker Cron** が自動実行する。本ディレクトリの
> `sync/*` は手動/CI 用の薄いトリガ、`vwap/*` は GitHub Actions 用の取込、
> `migrate/*` は一度きりの cutover ツール。

```
scripts/
├── README.md                         # このファイル
├── sync/                             # 取込トリガ / 母集団 seed
│   ├── daily.ts                      # pnpm sync:daily   — Worker /admin/sync-daily を叩く薄いトリガ (+ VWAP 束ね)
│   ├── monthly.ts                    # pnpm sync:monthly — Worker /admin/sync-monthly を叩く薄いトリガ
│   ├── universe.ts                   # pnpm sync:universe — JPX 母集団を core_stocks に seed (Node・xlsx)
│   ├── all-daily.ts / all-monthly.ts # ローカル手動フル実行のオーケストレータ
│   ├── yuho-edinet.ts / ir-tdnet.ts  # 005/006 の Worker /admin/catchup を叩く薄いトリガ
├── vwap/                             # 007 VWAP 取込 → R2 (GitHub Actions で定期実行)
│   ├── ingest-daily.ts / ingest-intra.ts / ingest-margin.ts
│   └── lib/                          # R2(S3互換) / Yahoo(YAHOO_PROXY_BASE 経由) / codes ヘルパ
└── migrate/                          # Neon→D1 cutover (一度きり・移行ツール)
    └── yuho-neon-to-d1.ts
```

## 運用サマリ（定点ジョブ）

| ジョブ | 実行 | コマンド / トリガ |
|---|---|---|
| 日次 stock sync (core/rsi/swing) | **自動** (Workers Cron) | 平日 20:00 UTC〜 4 シャード / 手動は `pnpm sync:daily` |
| 月次 otakara rebuild | **自動** (Workers Cron) | 毎月 1 日 22:00 UTC / 手動は `pnpm sync:monthly` |
| VWAP 日足/5分足/信用 → R2 | **自動** (GitHub Actions) | `.github/workflows/vwap-ingest.yml` / 手動 `pnpm ingest:vwap-*` |
| JPX 母集団同期 | 手動 (Node) | `pnpm sync:universe`（上場/廃止時） |
| 005 EDINET / 006 TDnet | 手動/CI (Node→Worker) | `pnpm ingest:yuho-edinet` / `pnpm ingest:ir-tdnet` |
| 002 優待スクレイプ+LLM | 手動 (Node・ローカル LLM) | `services/otakara-yutai/data-scripts/*`（月次） |

詳細・前提・残タスクは root [`README.md`](../README.md#運用ステータス自動化手作業残タスク) と
[`docs/deploy-cloudflare.md`](../docs/deploy-cloudflare.md) を参照。

## 取込の実装メモ

- `sync/daily.ts` / `sync/monthly.ts` は Worker の認証ルート (`/admin/sync-daily` /
  `/admin/sync-monthly`, `CRON_SECRET`) を叩くだけ。実装本体は
  [`src/cron/daily.ts`](../src/cron/daily.ts) / [`src/cron/monthly.ts`](../src/cron/monthly.ts)
  で、Worker 上 (D1 binding + `db.batch`、Yahoo はエッジ直叩きで 429 回避) で動く。
- `vwap/*` は Node 実行だが Yahoo を `YAHOO_PROXY_BASE`（Worker エッジ）経由で叩くため
  ランナー IP の 429 を回避する。R2 へは S3 互換 API で書く。
- スキーマ反映は `pnpm db:generate:d1` →
  `wrangler d1 execute kabulab-cf --remote --file=drizzle/d1/<n>.sql`
  （旧 Neon 用の `scripts/db/*.mjs` は D1 移行で廃止・削除済み）。

## 環境変数

root `.env` を使う（`.env.example` 参照）。本番 Worker 側は Cloudflare Secret が正のソース。
取込で使う主なもの: `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `D1_DATABASE_ID`
（D1 HTTP 書込）、`WORKER_BASE_URL` / `CRON_SECRET`（Worker トリガ）、
`YAHOO_PROXY_BASE`（VWAP のエッジ経由 Yahoo）、`R2_*`（VWAP の R2 書込）、
`EDINET_API_KEY` / `NOTION_TOKEN` ほか。
