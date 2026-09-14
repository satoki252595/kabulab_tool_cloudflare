# RSI Screening

日本株の個別銘柄を対象に、**RSI(2週間・2ヶ月・半年)が過去5年の分布で最も低い水準にある優良株**を発見するWebサービス。

## DB共有方針

kabulab 配下のプロジェクトは**単一の Cloudflare D1 DB (`kabulab-cf`)** を共有し、**接頭辞テーブル**で名前空間を分離する (D1 は 1 DB = 1 SQLite で PostgreSQL のようなスキーマ名が無いため。ADR-0001)。

| 接頭辞 | 所有 | 用途 |
|--------|------|------|
| `core_*` | 001 (日次同期) | 銘柄マスタ・ファンダメンタルズ・年度財務 |
| `rsi_percentile` | 001 のみ | パーセンタイル・優良株判定 |
| `yutai_*` / `otakara_*` | 002 | 優待情報・スコア |

001は `core_*` を更新する「同期オーナー」であり、他プロジェクトは `core_*` を読むだけ。Yahoo Finance API呼び出しを重複させずに済む。

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
| Deploy | Cloudflare Workers (Workers Builds の Git 連携で自動デプロイ) |
| Database | Cloudflare D1 (SQLite) |
| ORM | Drizzle ORM (drizzle-orm/d1) |
| Validation | Zod + @hono/zod-validator |
| Frontend | template literal SSR (.ts 関数・JSX不可) |
| Test | Vitest |
| External API | Yahoo Finance API |

## セットアップ

> **本サービスは [kabulab](../../README.md) mono-repo の 001 サブアプリ**。コマンドは全て **リポジトリルート**から実行する (サービス固有の `pnpm sync` は廃止し、統一コマンドに移行済み)。

### 前提条件

- Node.js 22 / pnpm 9 (ルートの **Nix Flake** で固定。`nix develop` 推奨)
- Cloudflare D1 データベース (`kabulab-cf`) + wrangler

### インストール

```bash
nix develop                 # Node 22 + pnpm 9 の dev shell
pnpm install                # mono-repo ルートで一括インストール
cp .env.example .env        # 取込用シークレット等を設定 (Worker 側は Cloudflare Secrets)
```

### DB初期化

```bash
pnpm db:generate:d1                                              # drizzle/d1/*.sql を生成
wrangler d1 execute kabulab-cf --remote --file=drizzle/d1/0000_clean_tag.sql   # D1 に反映
```

### 銘柄マスタ + データ同期

母集団 seed と日次同期は **統一 sync** で行う (旧 `pnpm sync` / 手動 TSV seed は廃止)。取込 (書込) は Node (GitHub Actions) から D1 REST 経由で実行する。

```bash
pnpm sync:universe          # 東証内国普通株・共有4文字コード ~3,700 を seed (Yahoo なし)
pnpm sync:daily:core        # 全 active の ファンダ/RSI/percentile/優良株判定
```

### 開発サーバー起動

```bash
pnpm dev
```

## コマンド (全てリポジトリルートから)

| コマンド | 説明 |
|----------|------|
| `pnpm dev` | ローカル開発サーバー (wrangler dev) |
| `pnpm db:generate:d1` | D1 マイグレーション生成 (drizzle/d1/*.sql) |
| `wrangler d1 execute kabulab-cf --remote --file=drizzle/d1/<n>.sql` | D1 に反映 |
| `pnpm sync:universe` / `pnpm sync:daily:core` | 母集団 seed / core 日次同期 |
| `pnpm sync:daily` | core + VWAP 3 工程のローカル手動フル実行 |
| `pnpm test` | テスト実行 |
| `pnpm test:coverage` | カバレッジ測定 |
| `pnpm typecheck` | TypeScript型チェック |
| `pnpm lint` | ESLint |
| `pnpm run deploy` | Cloudflare Workers デプロイ (`wrangler deploy`。通常は Workers Builds が自動) |

## 日次同期 (GitHub Actions)

日次同期は Worker のエンドポイントではなく **GitHub Actions** (`.github/workflows/stock-sync.yml`) が Node から D1 REST 経由で実行する (`pnpm sync:daily:core`)。Yahoo 取得は Worker エッジ (`/api/ingest/yahoo`, `YAHOO_PROXY_BASE`) を経由して 429 を回避する。

## ページ

| パス | 説明 |
|------|------|
| `/` | ホームページ (プリセット検索へのリンク) |
| `/screening` | スクリーニング結果一覧 |
| `/stocks/:code` | 銘柄詳細 |

## 自動化 (GitHub Actions)

`.github/workflows/stock-sync.yml` が日次で core/rsi/swing を同期し、月次で universe / otakara を rebuild する (Workers Cron / Workers Paid は不使用)。

## ディレクトリ構成

```
services/rsi-screening/
├── app.ts                       # サブアプリ本体 (root が /rsi-screening に mount)
├── base-path.ts                 # BASE_PATH 定義
└── src/
    ├── index.ts                 # サブアプリ組み立て
    ├── db/
    │   ├── client.ts            # D1 + Drizzle (createDb(c.env.DB))
    │   ├── core-schema.ts       # 共有テーブル (core_*)
    │   └── schema.ts            # 001 固有テーブル (rsi_percentile)
    ├── routes/                  # pages.ts / screening.ts / stocks.ts
    ├── services/                # screening-service.ts / stock-detail-service.ts
    ├── views/                   # home.ts / screening.ts / stock-detail.ts / layout.ts (template literal・JSX不可)
    ├── validators/              # screening.ts (Zod)
    └── middleware/              # error-handler.ts
```

> Worker エントリは **ルートの `src/index.ts`** 1 つ (本サービスは `app.route()` で mount)。
> RSI 計算・Yahoo 取得・percentile・優良株判定は 2026-04 の sync 統一化で root の
> `src/shared/indicators/` + `scripts/sync/daily.ts` (Node/GitHub Actions) へ移動済み
> (本サービス固有の `yahoo-finance.ts` / `rsi-calculator.ts` / `percentile-engine.ts` /
> `blue-chip-filter.ts` / `sync-service.ts` は削除)。

## ライセンス

Private
