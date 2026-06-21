# Cloudflare 自動デプロイ (Workers Builds / Git 連携)

`main` への push で Worker 本体 (`kabulab-cf`) を自動デプロイする手順。
Cloudflare ネイティブの **Workers Builds**(Git 連携)を使う。GitHub に API トークンを
置く必要がなく、repo に CI ファイルも不要(Cloudflare の GitHub App が認証を持つ)。

> ⚠️ 自動デプロイは **Worker 本体の `wrangler deploy` のみ**を実行する。
> D1 スキーマ適用 (`drizzle/d1/*.sql`) と cutover は **手動のまま**
> (`wrangler d1 execute kabulab-cf --remote --file=...`)。自動経路は本番データを触らない。

## 前提

1. **Workers Paid プラン**。Cron Triggers / `[limits] cpu_ms` / 10,000 subrequests は
   すべて Paid 必須。Free のままだと `[limits]` で deploy が弾かれる。
2. **Worker secrets は設定済み**で deploy をまたいで保持される
   (`CRON_SECRET` / `DATABASE_URL` 等)。Workers Builds は secrets を触らない。
3. **production ブランチ = `main`**。今の作業ブランチ `feat/d1-r2-migration` は
   PR #1 を `main` にマージしてから自動デプロイ対象になる。

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
4. 保存 → 以降 `main` への push ごとに自動ビルド&デプロイ。Cron Triggers
   (wrangler.toml の `[triggers]`)はデプロイ時に自動登録される。
5. (任意)非 production ブランチに **Preview デプロイ**を有効化すると PR ごとに
   プレビュー URL が出る。

## 確認

- 初回デプロイ後、ダッシュボードの **kabulab-cf → Triggers** に 5 本の Cron
  (`0/3/6/9 20 * * 1-5` + `0 22 1 * *`)が表示されること。
- ログは **kabulab-cf → Logs**(または `wrangler tail`)で確認。日次 cron は
  `[cron] sync-daily shard N/4: {...}` を出す。
- 手動トリガ(任意): `curl -X POST "https://kabulab-cf.<sub>.workers.dev/admin/sync-daily?part=0&of=4" -H "Authorization: Bearer $CRON_SECRET"`

## ロールバック

ダッシュボード **Deployments** から過去デプロイへワンクリックでロールバック可能。

## VWAP 定期取込 (GitHub Actions)

007 VWAP(日足10年/5分足/信用残高 → R2)は Worker Cron の対象外なので、
GitHub Actions で定期実行する(`.github/workflows/vwap-ingest.yml`)。

- Yahoo は **`YAHOO_PROXY_BASE` 経由(Worker エッジの `/vwap-analysis/api/ingest-fetch`)**
  で叩くため、GitHub ランナーの IP が Yahoo に直接弾かれること(429)はない。
  → **public 切り出し不要・private repo のままで OK**。
- スケジュール: 平日 08:00 UTC(日足+5分足)/ 土 09:00 UTC(信用残高週次)。
  手動実行は Actions タブの「Run workflow」(target: daily-intra / margin / all)。
- **発火条件**: schedule は **default ブランチ(main)** のワークフローのみ。PR #1 を
  main にマージすると有効化される。
- 無料枠(private 2,000 min/月)内の想定。

### 必要な GitHub Secrets

リポジトリ **Settings → Secrets and variables → Actions → New repository secret** で、
ローカル `.env` と同じ値を登録する:

| Secret | 値 |
|---|---|
| `YAHOO_PROXY_BASE` | デプロイ済み Worker の URL(例 `https://kabulab-cf.<sub>.workers.dev`) |
| `CRON_SECRET` | Worker secret と同値(プロキシ認証) |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | R2 書込(S3 互換) |

> EDINET(005)/ TDnet(006)の日次キャッチアップも同様に GitHub Actions 化できる
> (`pnpm ingest:yuho-edinet` / `ingest:ir-tdnet` を `WORKER_BASE_URL` + `CRON_SECRET`
> で叩くだけ)。必要になれば同じ要領で追加する。
