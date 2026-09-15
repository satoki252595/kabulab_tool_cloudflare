# Cloudflare 自動デプロイ (Workers Builds / Git 連携)

`main` への push で Worker 本体 (`kabulab-cf`) を自動デプロイする手順。
Cloudflare ネイティブの **Workers Builds**(Git 連携)を使う。GitHub に API トークンを
置く必要がない(Cloudflare の GitHub App が認証を持つ)。取込・CI は別に
GitHub Actions 4 本 (`.github/workflows/` の stock-sync / vwap-ingest / catchup / ci) がある。

> ⚠️ 自動デプロイは **Worker 本体の `wrangler deploy` のみ**を実行する。
> D1 スキーマ適用 (`drizzle/d1/*.sql`) は **手動のまま**
> (`wrangler d1 execute kabulab-cf --remote --file=...`。番号順・詳細は
> `drizzle/d1/README.md`)。自動経路は本番データを触らない。

## 前提

1. **Workers Paid は不要(無料プラン想定。要アカウント確認)**。取込は GitHub Actions(Node)で行うため
   Worker は配信 + 取込プロキシ + 005/006 の `/admin/catchup` のみ。`wrangler.toml` に `[triggers]`/`[limits]` は無い。
2. **Worker secrets は設定済み**で deploy をまたいで保持される
   (`CRON_SECRET` / `EDINET_API_KEY` / `NOTION_TOKEN` 等)。Workers Builds は secrets を触らない。
3. **production ブランチ = `main`**。`main` への push で自動デプロイされる。

## 設定手順 (Cloudflare ダッシュボード)

1. Cloudflare ダッシュボード → **Workers & Pages** → **kabulab-cf** を開く。
2. **Settings → Build**(Builds / "Connect to Git")→ **Connect** で GitHub を認可し、
   リポジトリ `satoki252595/kabulab_tool_cloudflare` を選択。
3. ビルド設定:
   - **Production branch**: `main`
   - **Build command**: `pnpm install`(省略可。lockfile から自動検出される)
   - **Deploy command**: `npx wrangler deploy`
   - **Root directory**: `/`(wrangler.toml はリポジトリ直下)
   - パッケージマネージャ/Node は repo の `packageManager`(pnpm@9.15.9)と
     `.node-version`(22)から自動解決される。
4. 保存 → 以降 `main` への push ごとに自動ビルド&デプロイ(無料プラン)。
5. (任意)非 production ブランチに **Preview デプロイ**を有効化すると PR ごとに
   プレビュー URL が出る。

## 確認

- 初回デプロイ後、本番ページ(例 `/swing-trading/`, `/financial-math/emh`)が D1 から
  読めること。ログは **kabulab-cf → Logs**(または `wrangler tail`)。
- 取込は GitHub Actions(下記)で実行・確認する。

## ロールバック

ダッシュボード **Deployments** から過去デプロイへワンクリックでロールバック可能。

## 取込の定期実行 (GitHub Actions)

取込(株価 日次/月次 + VWAP)はすべて GitHub Actions(Node)で定期実行する。Yahoo は
`YAHOO_PROXY_BASE`(Worker エッジの `/api/ingest/yahoo` に一本化。旧
`/vwap-analysis/api/ingest-fetch` は K4c-1 で廃止)
経由で叩くため、ランナー IP の 429 を回避する → **Workers Paid 不要**。

| ワークフロー | 内容 | スケジュール (UTC) |
|---|---|---|
| `.github/workflows/stock-sync.yml` | 日次 stock(core/rsi/swing) / 月次 universe + otakara rebuild | 平日 21:00 / 10 日 01:30 |
| `.github/workflows/vwap-ingest.yml` | 日足10年 + 5分足 / 信用残高週次 → R2 | 月水金 08:00 / 土 09:00 |
| `.github/workflows/catchup.yml` | 005 有報(EDINET) + 006 適時開示(TDnet) キャッチアップ | 平日 11:00 |
| `.github/workflows/ci.yml` | 型・lint・単体テスト + 地図突合 + D1 generate 差分 (push/PR) | — (cron なし) |

- 手動実行は Actions タブの「Run workflow」(stock: daily/monthly/all、vwap: daily-intra/intra/margin/all、catchup: all/tdnet/edinet)。
- **schedule は default ブランチ(main)のワークフローのみ発火**。
- 実行時間の目安 (public repo のため Actions 分課金は無し): 日次 stock(~40-50分)×平日 + VWAP(月水金。差分時は数十分、バックフィル時は 2-3h 域。timeout 300 分) ≈ 月 1,300-1,600 分(バックフィル除く)。

### 必要な GitHub Secrets

リポジトリ **Settings → Secrets and variables → Actions → New repository secret** で、
ローカル `.env` と同じ値を登録する:

| Secret | 用途 |
|---|---|
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `D1_DATABASE_ID` | D1 REST 書込 (createD1HttpDb) |
| `YAHOO_PROXY_BASE` | デプロイ済み Worker の URL(例 `https://kabulab-cf.<sub>.workers.dev`) |
| `CRON_SECRET` | 取込プロキシ認証(Worker secret と同値) |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | VWAP の R2 書込(S3 互換) |
| `NOTION_TOKEN` / `NOTION_BACKUP_PAGE_ID` / `NOTION_TRASH_PAGE_ID` | 月次 universe / TDnet の一次データ Notion アーカイブ(ルール6) |
| `WORKER_BASE_URL` | catchup.yml の EDINET トリガが叩く Worker URL(= `YAHOO_PROXY_BASE` と同値) |

> 005 EDINET / 006 TDnet は `catchup.yml` で自動化済み(TDnet=Node+kuromoji→D1、EDINET=Worker
> ルート /yuho-quant/admin/catchup を叩く)。優待(002)の LLM 解釈のみローカル手動。
