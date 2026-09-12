# 002 お宝優待 — kabulab

**kabulab** プロジェクト群の002番。割安な株主優待銘柄をファンダメンタルズ × テクニカル分析で発見するサービス。

ポータル: `https://kabulab-cf.satoki252595.workers.dev/`

## 技術スタック

- **Runtime**: Hono v4 + Cloudflare Workers
- **Database**: Cloudflare D1 (SQLite) + Drizzle ORM (`drizzle-orm/d1` + sqlite-core)
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
│   │   ├── client.ts          # createDb(c.env.DB) — D1 + Drizzle
│   │   └── schema.ts          # yutai_*/otakara_* 接頭辞テーブル定義 (stocks は core-schema 再 export)
│   ├── services/              # yutai-scraper.ts / yutai-data-provider.ts (取込系)
│   ├── validators/            # 優待スクレイパー用 Zod スキーマ
│   ├── types.ts               # 共通型定義
│   └── tests/                 # unit テスト
├── data-scripts/              # 1 回限り/手動のデータ取得・解釈スクリプト
├── drizzle/                   # drizzle-kit 生成の migration
├── CLAUDE.md / README.md
```

## Hono 規約

- 本サービスは `app.ts` 単一ファイル構成 (ルート分割しない。下記「実装メモ」参照)
- バリデーションには Zod を使う
- DB 接続は Worker の D1 バインディング `c.env.DB` を `dbMiddleware`
  (`c.set("db", createDb(c.env.DB))`) で各リクエストの context に注入する。
  ハンドラ側は `c.get("db")` で取得し、`DATABASE_URL` 等の接続文字列は参照しない

## Drizzle ORM 規約

- スキーマ定義は `src/db/schema.ts` に集約する
- テーブル名・カラム名は snake_case を使用する
- TypeScript側の変数名は camelCase を使用する（Drizzle が自動マッピング）
- 型推論は `typeof table.$inferSelect` / `typeof table.$inferInsert` を使う
- マイグレーションはルートから `pnpm db:generate:d1` で `drizzle/d1/*.sql` を生成し、
  `wrangler d1 execute kabulab-cf --remote --file=<sql>` で D1 に適用する
  (`db:push:*` / pg dialect の `drizzle.otakara-yutai.config.ts` は obsolete)

## D1 規約

- 単一 DB `kabulab-cf` に全サービスが接頭辞テーブルで同居する。D1 は名前空間が
  無いため、共有正本は `core_*` (`core_stocks` 等)、002 固有は `yutai_*` /
  `otakara_*` 接頭辞で衝突を避ける
- ドライバは `drizzle-orm/d1` + sqlite-core を使用する
- 本番 DB への直接変更は避け、生成済み SQL を `wrangler d1 execute` で適用する

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

- **JSX は使えない** (mono-repo 共通規約) — ビューは template literal を返す
  `.ts` 関数として実装する方針を踏襲し、HTML は **`app.ts` 内の template
  literal** で直接生成する (Workers/esbuild ビルドでも同方針)
- スタイリング: インラインCSS（`app.ts` の `CSS` 定数、`<style>` タグ内）
- インタラクションが必要な場合は純粋な form / `<details>` / CSS `:checked` か、
  最小限の vanilla JS (`/screening` の絞り込みのみ) を使う
- デザインシステムは CSS カスタムプロパティで定義
- 用語バルーンヘルプは `app.ts` 内の `tip()` / `TIPS` (ルール7。本ルール制定前
  からのインライン実装で、`src/shared/term-tip.ts` と挙動同一。改修で触れた際
  に共通実装へ移行してよい)
- **本番は `services/otakara-yutai/app.ts` の 1 ファイルのみ**。旧
  `src/index.ts` / `src/pages-app.ts` は 2026-06 の整理で削除済み。現エントリは
  `app.ts` の 1 ファイル構成
- 2026-09 に `src/routes/` / `src/views/` / `src/types.ts` /
  `src/validators/index.ts` / `src/middleware/{index,db}.ts` も削除した
  (17 ファイル / 4,245 行)。**2026-06 の整理でエントリだけ消してルートとビューが
  残っていた**ため、未マウントのまま `ILIKE` (D1 で動かない) と重複キー 5 箇所を
  温存していた。公開面を足すときは `app.ts` に書く。別ディレクトリに
  「新しい実装」を作ると、マウントし忘れた瞬間に同じ状態に戻る
  (`src/tests/public-summary-safety.test.ts` が `src/routes` / `src/views` の
  再出現を検知して落とす)

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
- ヘッダー左端に `← KABULAB` リンクを必ず配置し、`https://kabulab-cf.satoki252595.workers.dev/` へ遷移
- ロゴサブタイトル: `002 / KABULAB`

### NG

- 高級感演出（金色・グラデーション・グロー・ガラスモーフィズム）
- 装飾的フォント
- 薄い色（コントラスト不足）
- 影は黒の `5px 5px 0 0` 1パターンのみ。柔らかいdrop shadow禁止

## コマンド

このサービスは kabulab mono-repo のサブアプリ。コマンドはすべて **リポジトリルート** から実行する。

```bash
pnpm dev                  # ローカル開発サーバー起動 (wrangler dev)
pnpm run deploy           # Cloudflare Workers 手動デプロイ (wrangler deploy)。
                          #   通常は main push → Workers Builds (Git 連携) で無料自動デプロイ
pnpm db:generate:d1       # drizzle/d1/*.sql を生成 (生成後 wrangler d1 execute で適用)
# データ同期はサービス固有コマンド無し。root 統一 sync を使う (Node / GitHub Actions):
pnpm sync:universe        # 東証内国普通株・共有4文字コード ~3,700 を core_stocks に seed
pnpm sync:daily:core      # 全 active の OHLCV/ファンダ/指標 (otakara も core/swing 経由で反映)
pnpm sync:monthly:core    # is_yutai=true のみ otakara_stock_scores 再計算
# 優待データ取込パイプライン (data-scripts、GitHub Actions 非対象・ローカル手動。.ts は tsx 実行):
#   1. pnpm exec tsx services/otakara-yutai/data-scripts/fetch-yutai-full.ts            # minkabu→yutai_benefits + is_yutai
#   2. pnpm exec tsx services/otakara-yutai/data-scripts/export-benefit-descriptions.ts # →data/benefit-descriptions.jsonl
#   3. pnpm interpret:yutai                                                             # ローカル LLM (node-llama-cpp) 解釈→data/interpreted/chunk-*.jsonl
#   4. pnpm exec tsx services/otakara-yutai/data-scripts/apply-benefit-interpretations.ts # →DB short_summary/estimated_value
pnpm test                 # 全サービス横断のテスト
pnpm test:coverage        # カバレッジ付き
pnpm lint                 # ESLint
pnpm typecheck            # 全サービス型チェック
```

ポータル: <https://kabulab-cf.satoki252595.workers.dev/>
このサービス: <https://kabulab-cf.satoki252595.workers.dev/otakara-yutai/>

## 実装メモ

- 本番ビルドは `services/otakara-yutai/app.ts` の 1 ファイル構成 (旧 src/index.ts / src/pages-app.ts は削除済み)
- DB スキーマとクライアントは `src/db/schema.ts` / `src/db/client.ts` の単一 source of truth
- `src/services/` のスクレイパー類は `data-scripts/` から呼ばれる
  (スコアリングは `src/shared/scoring.ts` + 月次同期 (`pnpm sync:monthly:core`) に統合済み。
  旧 `src/scripts/sync-and-score.ts` は削除済み)
- `data-scripts/` 配下は **2026-09 から typecheck 対象**
  (以前はディレクトリ単位で tsconfig の `exclude` に入っていた)。
  除外はファイル単位に変わり、otakara は 1 件も除外が無い。
  残っている除外は [../../docs/ci-typecheck-blind-spots.md](../../docs/ci-typecheck-blind-spots.md) を参照
- **JSX は使えない** — mono-repo 方針 (ビューは template literal を返す .ts 関数。Workers/esbuild でも踏襲) により、HTML は app.ts 内で template literal として直接生成する
