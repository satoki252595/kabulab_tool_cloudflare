# お宝優待 (otakara-yutai)

日本株の株主優待において、ファンダメンタルズ及びテクニカルの観点から割安な銘柄を優待ジャンル毎に紹介するWebサービス。

> **本サービスは [kabulab](../../README.md) mono-repo の 002 サブアプリ**。`https://kabulab-cf.satoki252595.workers.dev/otakara-yutai/` で公開され、コマンドは全て **リポジトリルート**から実行する。実装規約の正本は [CLAUDE.md](./CLAUDE.md)。

## 技術スタック

| カテゴリ | 技術 |
|----------|------|
| Backend | Hono v4 (`new Hono({ strict: false })`) |
| Deploy | Cloudflare Workers (単一 Worker kabulab-cf。Workers Builds の Git 連携で自動デプロイ) |
| Database | Cloudflare D1 (SQLite) — 単一 DB `kabulab-cf` に `yutai_*`/`otakara_*` 接頭辞テーブル + 共有 `core_*` を参照 |
| ORM | Drizzle ORM (`drizzle-orm/d1` + sqlite-core) |
| Validation | Zod + @hono/zod-validator |
| Frontend | Hono SSR — **HTML は `app.ts` 内の template literal で生成 (JSX 不可)** |
| Test | Vitest + @vitest/coverage-v8 |
| External API | **なし** (Yahoo は統一 daily sync が `core`/`swing` を更新し間接反映。本サービス独自の Yahoo 呼び出しはゼロ) |

## セットアップ

### 前提条件

- Node.js 22 / pnpm 9 (リポジトリルートの **Nix Flake** で固定。`nix develop` 推奨)
- Cloudflare アカウント (D1 `kabulab-cf` + Workers)
- `wrangler` CLI (D1 操作・デプロイ)

### インストール

```bash
git clone <repo-url> kabulab_tool
cd kabulab_tool
nix develop               # Node 22 + pnpm 9 の dev shell
pnpm install              # mono-repo ルートで一括インストール
```

### 環境変数

`.env.example` をコピーして `.env` を作成:

```bash
cp .env.example .env
```

| 変数名 | 説明 | 必須 |
|--------|------|------|
| `CLOUDFLARE_API_TOKEN` | 取込 (Node / GitHub Actions) が D1 REST 書込に使う API トークン (D1 edit 権限) | 取込時 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare アカウント ID (D1 REST 用) | 取込時 |
| `D1_DATABASE_ID` | D1 データベース `kabulab-cf` の ID (D1 REST 用) | 取込時 |
| `OTAKARA_LLM_MODEL` | 優待解釈 (interpret:yutai) の GGUF モデル上書き (HF URI)。既定 ELYZA-JP-8B | No |

> Worker の読取経路は D1 バインディング `c.env.DB` を使うため接続文字列は不要。
> 上記 `CLOUDFLARE_*` / `D1_DATABASE_ID` は **書込 (取込)** を行う Node 側でのみ参照する。

### データベースセットアップ

スキーマ操作は **ルートからコマンド**で行う。シード投入は無く、データは統一 sync + 優待取込パイプラインで投入する。

```bash
pnpm db:generate:d1        # drizzle/d1/*.sql を生成
wrangler d1 execute kabulab-cf --remote --file=drizzle/d1/<生成SQL>  # D1 に適用
pnpm sync:universe         # core_stocks を全 JPX 内国株 ~4,000 に seed
pnpm sync:monthly          # 母集団同期 + is_yutai 銘柄のスコア再計算
```

## 開発コマンド (全てリポジトリルートから)

| コマンド | 説明 |
|----------|------|
| `pnpm dev` | ローカル開発サーバー起動 (wrangler dev) |
| `pnpm run deploy` | Cloudflare Workers 手動デプロイ (wrangler deploy)。通常は main push の自動デプロイで足りる |
| `pnpm test` / `pnpm test:coverage` | テスト / カバレッジ付き |
| `pnpm typecheck` | TypeScript 型チェック |
| `pnpm lint` | ESLint 実行 |
| `pnpm db:generate:d1` | D1 マイグレーション SQL 生成 (`drizzle/d1/*.sql`)。適用は `wrangler d1 execute kabulab-cf --remote --file=...` |
| `pnpm interpret:yutai` | 優待 description をローカル LLM (node-llama-cpp) で解釈 (取込パイプライン step3) |

優待データ取込パイプライン (fetch → export → interpret → apply) の詳細は [CLAUDE.md](./CLAUDE.md) と [ルート README](../../README.md#優待データ取込パイプライン-002-otakara-data-scriptscron-非対象) を参照。

## デプロイ

kabulab は **単一 Cloudflare Worker** (`kabulab-cf`)。`git push origin main` で Workers Builds (Git 連携) の **無料**自動デプロイが発火する (手動は `pnpm run deploy` = `wrangler deploy`)。ビルド/ルーティング設定は `wrangler.toml` に集約し、D1 (`binding=DB`) / R2 (`binding=BUCKET`) / 静的アセット (`binding=ASSETS`) のバインディングを定義する。取込用シークレット (`CLOUDFLARE_API_TOKEN` 等) は GitHub Actions Secrets で管理する。

本サービスは root app が `app.route("/otakara-yutai", otakaraYutaiApp)` で mount する。`app.ts` のルート:

| パス (mount 後は `/otakara-yutai` 配下) | 内容 |
|------|--------|
| `/` | ホーム (SSR) |
| `/screening` | スクリーニング (SSR) |
| `/genres/:slug` | ジャンル別 (SSR) |
| `/stocks/:code` | 銘柄詳細 (SSR) |
| `/api/screening` | スクリーニング用フィルター検索 (内部利用) |

## 内部API

| Method | Path | 説明 |
|--------|------|------|
| GET | `/api/screening` | スクリーニングページ用フィルター検索（内部利用） |

### クエリパラメータ (GET /api/screening)

| パラメータ | 型 | デフォルト | 説明 |
|-----------|------|-----------|------|
| `month` | number | - | 権利確定月（1-12） |
| `genre` | string | - | ジャンルslugでフィルタ |
| `perMax` | number | - | PER上限 |
| `pbrMax` | number | - | PBR上限 |
| `yieldMin` | number | - | 配当利回り最低% |
| `rsiMax` | number | - | RSI上限 |
| `sort` | string | `total` | ソート対象 |
| `order` | `asc` \| `desc` | `desc` | 並び順 |
| `limit` | number | 50 | 取得件数（最大100） |

## 自動化 (GitHub Actions)

データ取込 (書込) は Node で動く **GitHub Actions 3 本**が担う (Workers Cron / Workers Paid は使わない)。02 優待の LLM 解釈のみローカル手動。

### stock-sync.yml — 銘柄データ同期 (002 に直接関係)

- **トリガー**: 平日 21:00 UTC (日次 core/rsi/swing sync) + 毎月 1 日 22:30 UTC (母集団同期 + otakara rebuild) + 手動
- **内容**: `sync:daily` / `sync:monthly` 等を実行し D1 を REST 経由で更新。is_yutai 銘柄の `otakara_stock_scores` も月次で再計算
- **デプロイは Workers Builds が別途担当** (このワークフローは取込専用)

### vwap-ingest.yml — VWAP 時系列取込 (007)

- **トリガー**: 平日 08:00 UTC (日足10年 + 5分足) + 土 09:00 UTC (信用残高 週次) + 手動
- **内容**: Yahoo データを R2 (`vwap-data`) へ書込

### catchup.yml — 開示取込 (005 / 006)

- **トリガー**: 平日 11:00 UTC + 手動
- **内容**: EDINET 有報 (005) / TDnet 適時開示 (006) を取り込み

> 優待データ取込パイプライン (fetch → export → interpret → apply) は GitHub Actions 非対象・ローカル手動。詳細は [CLAUDE.md](./CLAUDE.md)。

## ディレクトリ構成

```
services/otakara-yutai/
├── app.ts                       # ★本番ビルドの単一ファイル — 全 HTML を template literal で生成 + 全ルート
├── src/
│   ├── db/
│   │   ├── client.ts            # createDb(c.env.DB) — D1 + Drizzle クライアント
│   │   └── schema.ts            # yutai_*/otakara_* 接頭辞テーブル定義 (single source of truth)
│   ├── services/
│   │   ├── yutai-scraper.ts         # 優待データ取込 (HTML/CSV/JSON)
│   │   └── yutai-data-provider.ts   # ファイルベースインポート
│   └── (index.ts / pages-app.ts / routes/ / views/ / middleware/ 等は dead code — 本番は app.ts)
└── data-scripts/                # GitHub Actions 非対象・ローカル手動実行の優待取込パイプライン
    ├── fetch-yutai-full.ts          # 1. minkabu → yutai_benefits + is_yutai
    ├── export-benefit-descriptions.ts # 2. → data/benefit-descriptions.jsonl
    ├── interpret-benefits.ts        # 3. ローカル LLM (node-llama-cpp) で解釈 → data/interpreted/
    └── apply-benefit-interpretations.ts # 4. → DB short_summary / estimated_value
```

> Worker エントリは **ルートの `worker/entry.ts`** 1 つ。root app (`src/index.ts`) が本サービスを `/otakara-yutai` に mount する。

## ライセンス

Private
