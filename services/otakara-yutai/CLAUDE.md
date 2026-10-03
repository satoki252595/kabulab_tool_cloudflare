# 002 お宝優待 — kabulab

**kabulab** プロジェクト群の002番。割安な株主優待銘柄をファンダメンタルズ ×
テクニカル分析で発見するサービス。

仕様の正本は [docs/002-otakara-yutai.md](../../docs/002-otakara-yutai.md)。
本ファイルは実装時の規約のみを持つ。

## ディレクトリ構成

```
services/otakara-yutai/
├── app.ts                     # Hono サブアプリ — 全 SSR ページと /api/screening
│                              #   を保持する単一ファイル構成 (本番はこれだけ)
├── src/
│   ├── db/{client,schema}.ts  # yutai_*/otakara_* 定義 (stocks は core-schema 再 export)
│   └── tests/                 # unit テスト (scoring は src/shared/ に移動済み)
├── data-scripts/              # 月次パイプライン + 1 回限りの保守スクリプト
├── docs/llm-summary-task.md   # クラウド LLM 向け要約作業仕様書
├── CLAUDE.md / README.md
```

**公開面を足すときは `app.ts` に書く**。別ディレクトリに「新しい実装」を
作ると、マウントし忘れた瞬間に未マウント並行実装 (2026-09 に 17 ファイル /
4,245 行を削除) と同じ状態に戻る (`src/tests/public-summary-safety.test.ts`
が `src/routes` / `src/views` の再出現を検知して落とす)。

## Hono 規約

- 本サービスは `app.ts` 単一ファイル構成 (ルート分割しない)
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
  (`db:push:*` / pg dialect の config は obsolete)

## D1 規約

- 単一 DB `kabulab-cf` に全サービスが接頭辞テーブルで同居する。共有正本は
  `core_*`、002 固有は `yutai_*` / `otakara_*` 接頭辞で衝突を避ける
- ドライバは `drizzle-orm/d1` + sqlite-core を使用する
- 本番 DB への直接変更は避け、生成済み SQL を `wrangler d1 execute` で適用する

## コーディング規約

- 命名規則: 変数・関数は camelCase、型・クラスは PascalCase、定数は UPPER_SNAKE_CASE
- コメントは日本語で記述する
- 公開API・関数には JSDoc を記述する
- `any` 型の使用は禁止。やむを得ない場合は `unknown` を使う
- TypeScript strict mode 必須
- API の入出力には必ず Zod スキーマでバリデーションを適用する
- テストカバレッジ 80% 以上を維持する

## フロントエンド方針

- **JSX は使えない** (mono-repo 共通規約) — HTML は **`app.ts` 内の template
  literal** で直接生成する
- スタイリング: インラインCSS（`app.ts` の `CSS` 定数、`<style>` タグ内）
- インタラクションが必要な場合は純粋な form / `<details>` / CSS `:checked` か、
  最小限の vanilla JS (`/screening` の絞り込みのみ) を使う
- デザインは kabulab Editorial Swiss Grid ([docs/overview.md](../../docs/overview.md) 参照)。
  ヘッダー左端に `← KABULAB` リンク、ロゴサブタイトルは `002 / KABULAB`
- 用語バルーンヘルプは `app.ts` 内の `tip()` / `TIPS` (ルール7。本ルール制定前
  からのインライン実装で、`src/shared/term-tip.ts` と挙動同一。改修で触れた際
  に共通実装へ移行してよい)

## コマンド

すべて **リポジトリルート** から実行する (一覧は root README 参照):

```bash
pnpm dev                  # ローカル開発サーバー起動 (wrangler dev)
pnpm sync:monthly:core    # is_yutai=true のみ otakara_stock_scores 再計算
# 月次Actions: universe → pnpm yutai:fetch → sync:monthly:core
# Mac毎日21時: yutai:summary:local（変更・未要約分、最大60件を公平に処理）
pnpm yutai:fetch           # 原本・更新前全行をNotion物理照合してから取込
pnpm exec tsx --env-file=.env scripts/biztag-local/main.ts run yutai-summary
# 既存固定MLXモデル。金額は共有厳密判定のみ。専用private stateは入口で選ぶ。
# 外部エージェントでの個別再作成は引き続き export/import を使える。
# tasks/resultsはprivateのみ。自動経路も同じ契約・原子適用を通す。
pnpm test / pnpm typecheck / pnpm lint
```

## Git 規約

Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `perf:`)
