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
