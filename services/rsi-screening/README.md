# RSI Screening

日本株の個別銘柄を対象に、**RSI(2週間・2ヶ月・半年)が過去5年の分布で最も低い水準にある優良株**を発見するWebサービス。

## DB共有方針

kabuTool配下のプロジェクトは**単一のNeon DB**を共有し、PostgreSQLスキーマで名前空間を分離する。

| PGスキーマ | 所有 | 用途 |
|------------|------|------|
| `core` | 001 (sync-coreバッチ) | 銘柄マスタ・日次株価・ファンダメンタルズ・年度財務 |
| `rsi` | 001 のみ | RSI履歴・パーセンタイル・優良株判定 |
| `yutai` | 002 (未移行) | 優待情報・スコア |

001は `core.*` を更新する「同期オーナー」であり、他プロジェクトは `core.*` を読むだけ。Yahoo Finance API呼び出しを重複させずに済む。

詳細: [docs/architecture/shared-database.md](./docs/architecture/shared-database.md)

## 特徴

- **3期間のRSI**: 10/40/120営業日 (約2週間・2ヶ月・半年)
- **パーセンタイル順位**: 現在のRSIが過去5年の分布で下位何%にあるかを算出
- **優良株フィルタ**: 営業利益率が過去3年で上昇基調 AND 売上高が過去3年で増加基調
- **個別銘柄詳細**: 株価・PER/PBR・ROE・年度財務トレンド・RSI履歴

## 技術スタック

| カテゴリ | 技術 |
|----------|------|
| Backend | Hono v4 |
| Deploy | Vercel Serverless Functions |
| Database | Neon (PostgreSQL) |
| ORM | Drizzle ORM |
| Validation | Zod + @hono/zod-validator |
| Frontend | Hono JSX (SSR) |
| Test | Vitest |
| External API | Yahoo Finance API |

## セットアップ

> **本サービスは [kabulab](../../README.md) mono-repo の 001 サブアプリ**。コマンドは全て **リポジトリルート**から実行する (サービス固有の `pnpm sync`/`pnpm db:push` は廃止し、サフィックス付き・統一コマンドに移行済み)。

### 前提条件

- Node.js 22 / pnpm 9 (ルートの **Nix Flake** で固定。`nix develop` 推奨)
- Neon データベース

### インストール

```bash
nix develop                 # Node 22 + pnpm 9 の dev shell
pnpm install                # mono-repo ルートで一括インストール
cp .env.example .env        # DATABASE_URL / CRON_SECRET を設定
```

### DB初期化

```bash
pnpm db:push:rsi            # core / rsi スキーマを Neon に反映
```

### 銘柄マスタ + データ同期

母集団 seed と日次同期は **統一 sync** で行う (旧 `pnpm sync` / 手動 TSV seed は廃止)。

```bash
pnpm sync:universe          # JPX 全内国株 ~4,000 を core.stocks に seed (Yahoo なし)
pnpm sync:daily             # 全 active の OHLCV/ファンダ/RSI/percentile/優良株判定
```

### 開発サーバー起動

```bash
pnpm dev
```

## コマンド (全てリポジトリルートから)

| コマンド | 説明 |
|----------|------|
| `pnpm dev` | ローカル開発サーバー |
| `pnpm db:push:rsi` | core / rsi スキーマを Neon に反映 |
| `pnpm db:studio:rsi` | Drizzle Studio 起動 |
| `pnpm sync:universe` / `pnpm sync:daily` | 母集団 seed / 日次同期 |
| `pnpm test` | テスト実行 |
| `pnpm test:coverage` | カバレッジ測定 |
| `pnpm typecheck` | TypeScript型チェック |
| `pnpm lint` | ESLint |
| `pnpm run deploy` | Vercelデプロイ |

## API

### `GET /api/screening`

RSIパーセンタイル順位で銘柄をスクリーニング。

| パラメータ | 型 | デフォルト | 説明 |
|-----------|------|-----------|------|
| `period` | `10` \| `40` \| `120` \| `min` | `min` | RSI期間 (min=3期間の最小) |
| `percentileMax` | number | 10 | パーセンタイル上限 (0〜100) |
| `blueChip` | boolean | true | 優良株フィルタ |
| `sort` | `percentile` \| `rsi` \| `marketCap` | `percentile` | 並び順 |
| `limit` | number | 50 | 件数 (最大200) |
| `offset` | number | 0 | オフセット |

### `GET /api/stocks/:code`

銘柄詳細。価格履歴・RSI履歴・年度財務を含む。

### `GET /api/cron/sync-daily`

Vercel Cronから呼び出す日次同期エンドポイント。`Authorization: Bearer <CRON_SECRET>` 必須。

## ページ

| パス | 説明 |
|------|------|
| `/` | ホームページ (プリセット検索へのリンク) |
| `/screening` | スクリーニング結果一覧 |
| `/stocks/:code` | 銘柄詳細 |

## Vercel Cron

`vercel.json` で平日 UTC 20:00 (JST 05:00) に `/api/cron/sync-daily` を自動実行する設定。

## ディレクトリ構成

```
services/rsi-screening/
├── app.ts                       # サブアプリ本体 (root が /rsi-screening に mount)
├── base-path.ts                 # BASE_PATH 定義
└── src/
    ├── index.ts                 # サブアプリ組み立て
    ├── db/
    │   ├── client.ts            # Neon + Drizzle
    │   ├── core-schema.ts       # 共有スキーマ (core.*)
    │   └── schema.ts            # 001 固有スキーマ (rsi.*)
    ├── routes/                  # pages.ts / screening.ts / stocks.ts
    ├── services/                # screening-service.ts / stock-detail-service.ts
    ├── views/                   # home.ts / screening.ts / stock-detail.ts / layout.ts (template literal・JSX不可)
    ├── validators/              # screening.ts (Zod)
    ├── middleware/              # error-handler.ts
    └── scripts/                 # seed-stocks.ts
```

> Vercel 関数エントリは **ルートの `api/index.ts`** 1 つ。RSI 計算・Yahoo 取得・
> percentile・優良株判定は 2026-04 の sync 統一化で root の `src/shared/indicators/`
> + `src/cron/daily.ts` へ移動済み (本サービス固有の `yahoo-finance.ts` /
> `rsi-calculator.ts` / `percentile-engine.ts` / `blue-chip-filter.ts` /
> `sync-service.ts` は削除)。

## ライセンス

Private
