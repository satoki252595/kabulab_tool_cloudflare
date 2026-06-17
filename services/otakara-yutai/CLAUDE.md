# 002 お宝優待 — kabulab

**kabulab** プロジェクト群の002番。割安な株主優待銘柄をファンダメンタルズ × テクニカル分析で発見するサービス。

ポータル: `https://kabulab.vercel.app/`

## 技術スタック

- **Runtime**: Hono v4 + Vercel Serverless Functions
- **Database**: Neon (PostgreSQL) + Drizzle ORM
- **Validation**: Zod
- **Language**: TypeScript (strict mode)

## ディレクトリ構成 (実態。詳細は [docs/002-otakara-yutai.md](../../docs/002-otakara-yutai.md))

```
services/otakara-yutai/
├── app.ts                     # Hono サブアプリ — 全 SSR ページ (/, /screening,
│                              #   /genres/:slug, /stocks/:code 等) と /api/screening
│                              #   を保持する単一ファイル構成 (本番はこれだけ)
├── src/
│   ├── db/
│   │   ├── client.ts          # createDb() — Neon HTTP + Drizzle
│   │   └── schema.ts          # public スキーマ定義 (stocks は core-schema 再 export)
│   ├── services/              # yutai-scraper.ts / yutai-data-provider.ts (取込系)
│   ├── validators/            # 優待スクレイパー用 Zod スキーマ
│   ├── types.ts               # 共通型定義
│   ├── tests/                 # unit テスト
│   └── index.ts, pages-app.ts # ★dead code (本番未使用。歴史的経緯で残存)
├── data-scripts/              # 1 回限り/手動のデータ取得・解釈スクリプト
├── drizzle/                   # drizzle-kit 生成の migration
├── CLAUDE.md / README.md
```

## Hono 規約

- 本サービスは `app.ts` 単一ファイル構成 (ルート分割しない。下記「実装メモ」参照)
- バリデーションには Zod を使う
- DB 接続は `c.env?.DATABASE_URL ?? process.env.DATABASE_URL` (app.ts 冒頭) —
  Vercel Bindings とローカル実行 (dotenv) の両対応のための実装。これは
  「同じ値の取得経路の差異吸収」であり値のフォールバックではない

## Drizzle ORM 規約

- スキーマ定義は `src/db/schema.ts` に集約する
- テーブル名・カラム名は snake_case を使用する
- TypeScript側の変数名は camelCase を使用する（Drizzle が自動マッピング）
- 型推論は `typeof table.$inferSelect` / `typeof table.$inferInsert` を使う
- マイグレーションはルートから `pnpm db:generate:otakara` → `pnpm db:push:otakara` (または `node scripts/db/apply-migration.mjs <sql>`) の順で実行する

## Neon 規約

- SSL接続は必須（`sslmode=require`）
- ドライバは `@neondatabase/serverless` の `neon()` + `drizzle-orm/neon-http` を使用する
- プレビューブランチを活用し、本番DBに直接変更を加えない

## コーディング規約

- 命名規則: 変数・関数は camelCase、型・クラスは PascalCase、定数は UPPER_SNAKE_CASE
- コメントは日本語で記述する
- 公開API・関数には JSDoc を記述する
- `any` 型の使用は禁止。やむを得ない場合は `unknown` を使う

## 品質基準

- テストカバレッジ 80% 以上を維持する
- TypeScript strict mode 必須（`tsconfig.json` で `strict: true`）
- API の入出力には必ず Zod スキーマでバリデーションを適用する
- ESLint / Prettier によるコード品質を維持する

## Git 規約

- Conventional Commits に準拠する
  - `feat:` 新機能
  - `fix:` バグ修正
  - `docs:` ドキュメント
  - `chore:` 雑務・設定変更
  - `refactor:` リファクタリング
  - `test:` テスト追加・修正
  - `perf:` パフォーマンス改善

## フロントエンド方針

- **JSX は使えない** (mono-repo 共通規約) — Vercel `@vercel/node` が `.tsx` を
  bundle しないため、HTML は **`app.ts` 内の template literal** で直接生成する
- スタイリング: インラインCSS（`app.ts` の `CSS` 定数、`<style>` タグ内）
- インタラクションが必要な場合は純粋な form / `<details>` / CSS `:checked` か、
  最小限の vanilla JS (`/screening` の絞り込みのみ) を使う
- デザインシステムは CSS カスタムプロパティで定義
- 用語バルーンヘルプは `app.ts` 内の `tip()` / `TIPS` (ルール7。本ルール制定前
  からのインライン実装で、`src/shared/term-tip.ts` と挙動同一。改修で触れた際
  に共通実装へ移行してよい)
- **本番は `services/otakara-yutai/app.ts` の 1 ファイルのみ**。旧
  `src/index.ts` / `src/pages-app.ts` は dead code (画面変更で触らないこと)

## デザイン方針 — kabulab Editorial Swiss Grid

**ターゲット**: モバイル投資家（高齢層含む）。読みやすさとブランドの一貫性を最優先。

詳細は [../docs/overview.md](../docs/overview.md) の「デザインシステム」セクションを参照。kabulab 全プロジェクト共通のデザインシステム。

### 配色

- 背景: `#fafafa`（オフホワイト）/ `#ffffff`（純白カード）
- テキスト: `#0a0a0a`（主）/ `#3a3a3a`（副）/ `#737373`（弱）
- ボーダー: `#0a0a0a`（2px 実線が基本）
- アクセント: Blue `#1d4ed8`（フォーカスのみ）
- Score: success `#15803d` / warning `#b45309` / danger `#b91c1c`

### タイポグラフィ

- Display（見出し・ナビ・ボタン）: **Space Grotesk** 700
- Mono（数字・コード・ラベル）: **JetBrains Mono** 400-700
- Body（本文）: **Noto Sans JP** 400-700
- ベースフォントサイズ 17px、行間 1.75
- タップ領域 48px+

### 共通ルール

- 角丸 4px（シャープ）
- ボーダー 2px 黒
- ホバー: `translate(-3px,-3px)` + `box-shadow: 5px 5px 0 0 #0a0a0a`（ニューブルータリスト）
- セクションラベル: `001 / SECTION NAME` 形式（左に2px黒バー + uppercase mono）
- ヘッダー左端に `← KABULAB` リンクを必ず配置し、`https://kabulab.vercel.app/` へ遷移
- ロゴサブタイトル: `002 / KABULAB`

### NG

- 高級感演出（金色・グラデーション・グロー・ガラスモーフィズム）
- 装飾的フォント
- 薄い色（コントラスト不足）
- 影は黒の `5px 5px 0 0` 1パターンのみ。柔らかいdrop shadow禁止

## コマンド

このサービスは kabulab mono-repo のサブアプリ。コマンドはすべて **リポジトリルート** から実行する。

```bash
pnpm dev                  # ローカル開発サーバー起動
pnpm run deploy               # Vercel 本番デプロイ (単一プロジェクト kabulab を更新)
pnpm db:generate:otakara  # マイグレーションファイル生成
pnpm db:push:otakara      # スキーマを Neon に直接反映 (public スキーマ)
pnpm db:studio:otakara    # Drizzle Studio
# データ同期はサービス固有コマンド無し。root 統一 sync を使う:
pnpm sync:universe        # JPX 全内国株 ~4,000 を core.stocks に seed
pnpm sync:daily           # 全 active の OHLCV/ファンダ/指標 (otakara も core/swing 経由で反映)
pnpm sync:monthly         # 母集団同期 + is_yutai=true のみ public スコア再計算
# 優待データ取込パイプライン (data-scripts、cron 非対象。.ts は tsx 実行):
#   1. pnpm exec tsx services/otakara-yutai/data-scripts/fetch-yutai-full.ts            # minkabu→yutai_benefits + is_yutai
#   2. pnpm exec tsx services/otakara-yutai/data-scripts/export-benefit-descriptions.ts # →data/benefit-descriptions.jsonl
#   3. pnpm interpret:yutai                                                             # ローカル LLM (node-llama-cpp) 解釈→data/interpreted/chunk-*.jsonl
#   4. pnpm exec tsx services/otakara-yutai/data-scripts/apply-benefit-interpretations.ts # →DB short_summary/estimated_value
pnpm test                 # 全サービス横断のテスト
pnpm test:coverage        # カバレッジ付き
pnpm lint                 # ESLint
pnpm typecheck            # 全サービス型チェック
```

ポータル: <https://kabulab.vercel.app/>
このサービス: <https://kabulab.vercel.app/otakara-yutai/>

## 実装メモ

- 本番ビルドは `services/otakara-yutai/app.ts` の 1 ファイル構成 (旧 src/index.ts + src/pages-app.ts は dead code)
- DB スキーマとクライアントは `src/db/schema.ts` / `src/db/client.ts` の単一 source of truth
- `src/services/` のスクレイパー類は `data-scripts/` から呼ばれる
  (スコアリングは `src/shared/scoring.ts` + `src/cron/monthly.ts` に統合済み。
  旧 `src/scripts/sync-and-score.ts` は削除済み)
- `data-scripts/` 配下の 1 回限りのデータ取得スクリプトは tsconfig から除外されている
- **JSX は使えない** — Vercel `@vercel/node` が `.tsx` を bundle しないため、HTML は app.ts 内で template literal として直接生成する
