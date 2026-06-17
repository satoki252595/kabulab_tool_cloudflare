# お宝優待 (otakara-yutai)

日本株の株主優待において、ファンダメンタルズ及びテクニカルの観点から割安な銘柄を優待ジャンル毎に紹介するWebサービス。

> **本サービスは [kabulab](../../README.md) mono-repo の 002 サブアプリ**。`https://kabulab.vercel.app/otakara-yutai/` で公開され、コマンドは全て **リポジトリルート**から実行する。実装規約の正本は [CLAUDE.md](./CLAUDE.md)。

## 技術スタック

| カテゴリ | 技術 |
|----------|------|
| Backend | Hono v4 (`new Hono({ strict: false })`) |
| Deploy | Vercel Serverless Functions (単一プロジェクト kabulab) |
| Database | Neon (PostgreSQL) — `public` スキーマ + 共有 `core`/`swing` を参照 |
| ORM | Drizzle ORM |
| Validation | Zod + @hono/zod-validator |
| Frontend | Hono SSR — **HTML は `app.ts` 内の template literal で生成 (JSX 不可)** |
| Test | Vitest + @vitest/coverage-v8 |
| External API | **なし** (Yahoo は統一 daily sync が `core`/`swing` を更新し間接反映。本サービス独自の Yahoo 呼び出しはゼロ) |

## セットアップ

### 前提条件

- Node.js 22 / pnpm 9 (リポジトリルートの **Nix Flake** で固定。`nix develop` 推奨)
- Neon データベース
- Vercel アカウント

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
| `DATABASE_URL` | Neon PostgreSQL 接続文字列 (`sslmode=require` 必須) | Yes |
| `OTAKARA_LLM_MODEL` | 優待解釈 (interpret:yutai) の GGUF モデル上書き (HF URI)。既定 ELYZA-JP-8B | No |

### データベースセットアップ

スキーマ操作は **ルートからサービス別サフィックス付きコマンド**で行う (サービス固有の `pnpm db:push` は存在しない)。シード投入は無く、データは統一 sync + 優待取込パイプラインで投入する。

```bash
pnpm db:push:otakara       # public スキーマを Neon に反映
pnpm sync:universe         # core.stocks を全 JPX 内国株 ~4,000 に seed
pnpm sync:monthly          # 母集団同期 + is_yutai 銘柄のスコア再計算
```

## 開発コマンド (全てリポジトリルートから)

| コマンド | 説明 |
|----------|------|
| `pnpm dev` | ローカル開発サーバー起動 (vercel dev) |
| `pnpm run deploy` | Vercel デプロイ (単一プロジェクト kabulab) |
| `pnpm test` / `pnpm test:coverage` | テスト / カバレッジ付き |
| `pnpm typecheck` | TypeScript 型チェック |
| `pnpm lint` | ESLint 実行 |
| `pnpm db:generate:otakara` | マイグレーションファイル生成 (public) |
| `pnpm db:push:otakara` | スキーマを Neon に直接反映 (public) |
| `pnpm db:studio:otakara` | Drizzle Studio 起動 |
| `pnpm interpret:yutai` | 優待 description をローカル LLM (node-llama-cpp) で解釈 (取込パイプライン step3) |

優待データ取込パイプライン (fetch → export → interpret → apply) の詳細は [CLAUDE.md](./CLAUDE.md) と [ルート README](../../README.md#優待データ取込パイプライン-002-otakara-data-scriptscron-非対象) を参照。

## デプロイ

kabulab は **単一 Vercel プロジェクト**。`git push origin main` で auto-deploy が発火する (手動は `pnpm run deploy`)。ビルドは Vercel 側が処理するため独自 Build Command は不要 (`build` スクリプトは no-op)。環境変数 (`DATABASE_URL` 等) は Vercel Env Variables で管理し、`vercel.json` はルート 1 つに集約 (rewrites + cron)。

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

## CI/CD ワークフロー

### ci.yml — 継続的インテグレーション

- **トリガー**: `push` (main), `pull_request`
- **内容**: pnpm install → typecheck → lint → test:coverage → Drizzle整合性チェック
- **カバレッジ**: 80%未満で失敗

### pr-review.yml — Claude Code 自動レビュー

- **トリガー**: PR作成・更新時
- **内容**: Claude Code が変更ファイルをレビューし、PRコメントに投稿
- **観点**: TypeScript strict、Hono/Drizzle規約、セキュリティ
- **必要シークレット**: `ANTHROPIC_API_KEY`

### security-audit.yml — 定期セキュリティ監査

- **トリガー**: 毎週月曜 AM3:00 (UTC) + 手動
- **内容**: Claude Code がセキュリティ監査を実施
- **アクション**: Critical/High 発見時にGitHub issue自動作成
- **必要シークレット**: `ANTHROPIC_API_KEY`

### db-migration-check.yml — DBマイグレーションチェック

- **トリガー**: PRに `src/db/` 配下の変更がある場合
- **内容**: スキーマ変更を検出し、破壊的変更があればPRにコメント
- **必要シークレット**: `DATABASE_URL`

## ディレクトリ構成

```
services/otakara-yutai/
├── app.ts                       # ★本番ビルドの単一ファイル — 全 HTML を template literal で生成 + 全ルート
├── src/
│   ├── db/
│   │   ├── client.ts            # Neon + Drizzle クライアント
│   │   └── schema.ts            # public スキーマ定義 (single source of truth)
│   ├── services/
│   │   ├── yutai-scraper.ts         # 優待データ取込 (HTML/CSV/JSON)
│   │   └── yutai-data-provider.ts   # ファイルベースインポート
│   └── (index.ts / pages-app.ts / routes/ / views/ / middleware/ 等は dead code — 本番は app.ts)
└── data-scripts/                # cron 非対象・手動実行の優待取込パイプライン
    ├── fetch-yutai-full.ts          # 1. minkabu → yutai_benefits + is_yutai
    ├── export-benefit-descriptions.ts # 2. → data/benefit-descriptions.jsonl
    ├── interpret-benefits.ts        # 3. ローカル LLM (node-llama-cpp) で解釈 → data/interpreted/
    └── apply-benefit-interpretations.ts # 4. → DB short_summary / estimated_value
```

> Vercel 関数エントリは **ルートの `api/index.ts`** 1 つ。本サービスは root app (`src/index.ts`) が `/otakara-yutai` に mount する。

## ライセンス

Private
