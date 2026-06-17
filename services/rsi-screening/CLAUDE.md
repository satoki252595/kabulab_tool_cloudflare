# 001 RSI Screening — kabulab

**kabulab** プロジェクト群の001番。日本株の個別銘柄を対象に、各期間のRSI (10/40/120営業日) が過去5年で最も下がっている優良株を発見するWebサービス。

ポータル: `https://kabulab.vercel.app/`

## 優良株の定義

- 営業利益率が過去3年で上昇基調
- 売上高が過去3年で増加基調

## 技術スタック

- **Runtime**: Hono v4 + Vercel Serverless Functions
- **Database**: Neon (PostgreSQL) + Drizzle ORM
- **Validation**: Zod
- **Language**: TypeScript (strict mode)

## DB スキーマ設計 (共有DB方式)

**kabulab** 配下の複数プロジェクトで単一Neon DBを共有する。

| PGスキーマ | 所有 | 用途 |
|------------|------|------|
| `core` | 001_RSIScreening が更新 | 銘柄マスタ・株価・財務 (一次情報) |
| `rsi` | 001_RSIScreening のみ | RSI履歴・パーセンタイル |
| `yutai` | 002_otakara-yutai のみ (未移行) | 優待情報・スコア |

### core スキーマ (共有)

001がsync-coreバッチで日次更新する。他プロジェクトは読み取り専用で参照する。

- `core.stocks` — 銘柄マスタ
- `core.stock_price_history` — 日次OHLCV (5年分)
- `core.stock_financials` — 最新ファンダメンタルズ
- `core.stock_annual_financials` — 年度売上高・営業利益

**追加原則**: `core.*` には「Yahoo Finance等から取得した生に近いデータ」のみ置く。テクニカル指標やスコアは各プロジェクトのスキーマへ。

### 001固有スキーマ (rsi)

- `rsi.stock_rsi_history` — 日次RSI(10/40/120)
- `rsi.stock_rsi_percentile` — 現在のパーセンタイル + 優良株判定

## ディレクトリ構成

```
src/
├── index.ts                 # Honoエントリ
├── db/
│   ├── client.ts            # Neon + Drizzle クライアント
│   ├── core-schema.ts       # 共有スキーマ (core.*)
│   └── schema.ts            # 001固有スキーマ (rsi.*)
├── routes/                  # ルートハンドラー
├── middleware/              # カスタムミドルウェア
├── validators/              # Zod スキーマ
├── services/                # ビジネスロジック
├── views/                   # Hono JSX (SSR)
├── scripts/                 # バッチスクリプト
├── types/                   # 型定義
└── tests/
    ├── unit/
    └── integration/
api/
└── [[...route]].ts          # Vercelキャッチオール
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

このサービスは kabulab mono-repo のサブアプリ。コマンドはすべて **リポジトリルート** (`/Users/satoki252595/work/0002_kabuTool/`) から実行する。

```bash
pnpm dev                # ローカル開発サーバー起動
pnpm db:generate:rsi    # マイグレーション生成 (このサービス専用)
pnpm db:push:rsi        # スキーマを Neon に直接反映 (core / rsi スキーマ)
pnpm db:studio:rsi      # Drizzle Studio
pnpm sync:universe      # JPX 全内国株 ~4,000 を core.stocks に seed
pnpm sync:daily         # 統一日次同期 (Yahoo → core/rsi/swing。サービス固有 sync:rsi は廃止)
pnpm test               # 全サービス横断のテスト
pnpm typecheck          # 全サービス型チェック
pnpm lint               # ESLint
```

ポータル: <https://kabulab.vercel.app/>
このサービス: <https://kabulab.vercel.app/rsi-screening/>

## フロントエンド方針

- フレームワーク: Hono (template literal を返す `.ts` 関数で SSR)
- **JSX は使えない** — Vercel `@vercel/node` が `.tsx` を bundle しないため、ビューは `views/*.ts` で `string` を返す関数として実装する
- スタイリング: インライン CSS — 共通トークンは root の `src/shared/design.ts` から取り込み、サービス固有スタイルは `src/views/layout.ts` の `GLOBAL_STYLES` に集約
- **デザインシステム: kabulab Editorial Swiss Grid**（[../docs/overview.md](../docs/overview.md) 参照）
  - 配色: 白 `#fafafa` ベース + 純黒 `#0a0a0a` ボーダー、アクセントは Blue `#1d4ed8`
  - フォント: Space Grotesk（display）+ JetBrains Mono（数字）+ Noto Sans JP（本文）
  - 角丸 4px、ボーダー 2px 黒、ホバーは `translate(-3px,-3px)` + `5px 5px 0 0 黒影`
- ヘッダー左端に `← KABULAB` リンクを配置し、`https://kabulab.vercel.app/` へ遷移させる
- ロゴサブタイトルは `001 / KABULAB`

## Git 規約

Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `perf:`)
