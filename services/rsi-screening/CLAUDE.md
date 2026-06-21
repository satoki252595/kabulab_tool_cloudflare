# 001 RSI Screening — kabulab

**kabulab** プロジェクト群の001番。日本株の個別銘柄を対象に、各期間のRSI (10/40/120営業日) が過去5年で最も下がっている優良株を発見するWebサービス。

ポータル: `https://kabulab-cf.satoki252595.workers.dev/`

## 優良株の定義

- 営業利益率が過去3年で上昇基調
- 売上高が過去3年で増加基調

## 技術スタック

- **Runtime**: Hono v4 + Cloudflare Workers
- **Database**: Cloudflare D1 (SQLite) + Drizzle ORM (drizzle-orm/d1)
- **Validation**: Zod
- **Language**: TypeScript (strict mode)

## DB スキーマ設計 (共有DB方式)

**kabulab** 配下の複数プロジェクトで単一 D1 DB (`kabulab-cf`) を共有する。D1 は 1 DB = 1 SQLite で名前空間が無いため、旧 PostgreSQL スキーマ名を **接頭辞テーブル** (`core_*` / `rsi_percentile` 等) に降ろして同居させる (ADR-0001)。

| 接頭辞 | 所有 | 用途 |
|--------|------|------|
| `core_*` | 001_RSIScreening が更新 | 銘柄マスタ・財務 (一次情報) |
| `rsi_percentile` | 001_RSIScreening のみ | パーセンタイル + 優良株判定 |
| `yutai_*` / `otakara_*` | 002_otakara-yutai | 優待情報・スコア |

### 共有テーブル (core_*)

001 が日次同期で更新する。他プロジェクトは読み取り専用で参照する。

- `core_stocks` — 銘柄マスタ
- `core_stock_financials` — 最新ファンダメンタルズ
- `core_stock_annual_financials` — 年度売上高

**追加原則**: `core_*` には「Yahoo Finance等から取得した生に近いデータ」のみ置く。テクニカル指標やスコアは各プロジェクトのテーブルへ。

### 001固有テーブル

- `rsi_percentile` — 現在のパーセンタイル + 優良株判定

## ディレクトリ構成

```
src/
├── index.ts                 # Honoエントリ
├── db/
│   ├── client.ts            # D1 + Drizzle クライアント (createDb(c.env.DB))
│   ├── core-schema.ts       # 共有テーブル (core_*)
│   └── schema.ts            # 001固有テーブル (rsi_percentile)
├── routes/                  # ルートハンドラー
├── middleware/              # カスタムミドルウェア
├── validators/              # Zod スキーマ
├── services/                # ビジネスロジック
├── views/                   # template literal を返す .ts 関数 (SSR)
├── scripts/                 # バッチスクリプト
├── types/                   # 型定義
└── tests/
    ├── unit/
    └── integration/
```

## コーディング規約

- 命名規則: 変数・関数は camelCase、型・クラスは PascalCase、定数は UPPER_SNAKE_CASE
- テーブル名・カラム名は snake_case、TypeScript側は camelCase (Drizzleが自動マッピング)
- コメントは日本語、公開API・関数にはJSDocを記述
- `any` 型禁止。やむを得ない場合は `unknown`
- TypeScript strict mode 必須
- API入出力にはZodスキーマでバリデーション
- テストカバレッジ 80% 以上

## コマンド

このサービスは kabulab mono-repo のサブアプリ。コマンドはすべて **リポジトリルート** (`/Users/satoki252595/projects/kabulab-cf/`) から実行する。

```bash
pnpm dev                # ローカル開発サーバー起動 (wrangler dev)
pnpm db:generate:d1     # D1 マイグレーション生成 (drizzle/d1/*.sql。全サービス共通)
                        # 反映: wrangler d1 execute kabulab-cf --remote --file=drizzle/d1/<n>.sql
pnpm sync:universe      # JPX 全内国株 ~4,000 を core_stocks に seed
pnpm sync:daily         # 統一日次同期 (Yahoo → core/rsi/swing。サービス固有 sync:rsi は廃止)
pnpm test               # 全サービス横断のテスト
pnpm typecheck          # 全サービス型チェック
pnpm lint               # ESLint
```

ポータル: <https://kabulab-cf.satoki252595.workers.dev/>
このサービス: <https://kabulab-cf.satoki252595.workers.dev/rsi-screening/>

## フロントエンド方針

- フレームワーク: Hono (template literal を返す `.ts` 関数で SSR)
- **JSX は使えない** — mono-repo 方針として、ビューは `views/*.ts` で `string` を返す template literal 関数で実装する (Workers/esbuild でも踏襲)
- スタイリング: インライン CSS — 共通トークンは root の `src/shared/design.ts` から取り込み、サービス固有スタイルは `src/views/layout.ts` の `GLOBAL_STYLES` に集約
- **デザインシステム: kabulab Editorial Swiss Grid**（[../docs/overview.md](../docs/overview.md) 参照）
  - 配色: 白 `#fafafa` ベース + 純黒 `#0a0a0a` ボーダー、アクセントは Blue `#1d4ed8`
  - フォント: Space Grotesk（display）+ JetBrains Mono（数字）+ Noto Sans JP（本文）
  - 角丸 4px、ボーダー 2px 黒、ホバーは `translate(-3px,-3px)` + `5px 5px 0 0 黒影`
- ヘッダー左端に `← KABULAB` リンクを配置し、`https://kabulab-cf.satoki252595.workers.dev/` へ遷移させる
- ロゴサブタイトルは `001 / KABULAB`

## Git 規約

Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `perf:`)
