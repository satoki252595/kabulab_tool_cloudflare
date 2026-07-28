# 003 Swing Trading — kabulab

**kabulab** プロジェクト群の 003 番。
**数日〜2週間の短期売買**をサポートするサービス。Notion ガイド
「短期売買実践ガイド」の 3 章 (銘柄スクリーニング / エントリー&エグジット / リスク管理) を
日足ベースで自動化し、定量ルールで毎朝の売買判断を再現可能にする。

ポータル: <https://kabulab-cf.satoki252595.workers.dev/>
本サービス: <https://kabulab-cf.satoki252595.workers.dev/swing-trading/>

## 何ができるか

1. **マクロ判定 (A/B/C/D)**: ^N225 / ^VIX / ^GSPC / NIY=F (Yahoo) + 日経VI (Nikkei smartchart scrape) から地合いを 4 段階評価
2. **5 条件スクリーニング**: ①流動性 / ②ボラ / ③トレンド を自動判定。④需給 / ⑤カタリストは外部未対応 (UI で明示)
3. **E&E 6 パターン**: ブレイクアウト / 押し目買い / 出来高急増 / ギャップ追随 / 窓埋め逆張り / 決算後初動 (代理)
4. **リスク計算機**: Notion の「2% ルール」ポジションサイズを純関数で提供

### スコープ外 (明示)

- パターン 5: VWAP 戦略 — 分足必須
- パターン 3 の当日 14 時急増エントリー — 分足必須
- 信用倍率 / 買残 (5 条件④) — Yahoo 非対応
- 決算カレンダー (5 条件⑤) — Yahoo 非対応

## 技術スタック

- **Runtime**: Hono v4 + Cloudflare Workers
- **Database**: Cloudflare D1 (SQLite) + Drizzle ORM (`drizzle-orm/d1` + `sqlite-core`)
- **Validation**: Zod
- **Language**: TypeScript (strict mode)

## DB スキーマ設計

**kabulab** 配下の全プロジェクトで単一 Cloudflare D1 (SQLite) `kabulab-cf` を共有し、
名前空間の代わりに **接頭辞テーブル** で同居する (ADR-0001)。旧 PG スキーマ名
(`core` / `rsi` / `swing` …) の概念は廃止し、`swing_<table>` などの接頭辞テーブルへ降ろした。

| 接頭辞 | 所有 | 用途 |
|------------|------|------|
| `core_*` | 日次 sync が更新 | 銘柄マスタ・最新ファンダメンタル (一次情報) |
| `rsi_*` | 001_RSIScreening のみ | RSI パーセンタイル |
| `swing_*` | 003_swing-trading のみ | OHLCV 履歴・指標・スクリーニング・E&E シグナル・マクロ・セクター |

### core_* テーブル (共有、読み取り専用)

- `core_stocks` — 銘柄マスタ
- `core_stock_financials` — 最新ファンダメンタル (PER/PBR/配当利回り/時価総額 等)

正本は共有スキーマ `src/shared/db/core-schema.ts` (sqlite-core)。

**追加原則**: `core_*` には「Yahoo Finance から取得した生に近いデータ」のみ置く。
テクニカル指標・スクリーニング結果・E&E シグナルなど「003 の解釈」は `swing_*` に置く。

### 003 固有テーブル (swing_*)

- `swing_daily_ohlcv` — 日足 OHLCV (約 90 営業日保持、90 日超は削除)
- `swing_stock_indicators` — 銘柄ごとの最新テクニカル集計 (1 銘柄 1 行)
- `swing_stock_screening` — 5 条件フィルター結果 (1 銘柄 1 行)
- `swing_entry_signals` — E&E パターン判定 (1 銘柄 × 複数パターン)
- `swing_market_context` — マクロ判定 (1 日 1 行)
- `swing_sector_daily` — セクター騰落ランキング (1 日 × 業種)

## ディレクトリ構成

```
services/swing-trading/
├── base-path.ts                  # BASE_PATH = "/swing-trading"
├── app.ts                        # Hono サブアプリ公開エントリ
└── src/
    ├── index.ts                  # Hono({ strict: false }) + routes + onError
    ├── db/
    │   ├── client.ts             # createDb(c.env.DB) — D1 バインディング + Drizzle (drizzle-orm/d1)
    │   ├── core-schema.ts        # 共有スキーマ (core_*) — 読み取り専用
    │   └── schema.ts             # 003 固有スキーマ (swing_*)
    ├── middleware/
    │   └── error-handler.ts      # グローバルエラーハンドラ
    ├── services/
    │   └── risk.ts               # ポジションサイズ計算 (リスク計算機)
    ├── validators/
    │   └── risk.ts               # フォーム入力 Zod
    ├── views/
    │   ├── layout.ts             # 共通レイアウト (JSX 使わず template literal)
    │   ├── dashboard.ts          # / トップ
    │   ├── screening.ts          # /screening
    │   ├── signals.ts            # /signals
    │   ├── stock-detail.ts       # /stock/:code
    │   └── risk.ts               # /risk
    ├── routes/
    │   ├── pages.ts              # SSR ページ
    │   └── api.ts                # POST /api/risk/calc (cron 系は廃止・GitHub Actions へ集約)
    └── tests/
        └── unit/
            ├── indicators.test.ts
            ├── patterns.test.ts
            └── risk.test.ts
```

> 2026-04 の sync 統一化で、テクニカル計算系 (`indicators` / `screener` /
> `patterns` / `macro` / `sector` / `sync` / `yahoo-finance` とその Zod) は
> root の `src/shared/` (`screener.ts` / `patterns.ts` / `macro.ts` /
> `sector-aggregate.ts` / `indicators/` / `yahoo/`) と `src/cron/daily.ts`
> へ移動済み。本サービス配下に残る純ロジックは `risk.ts` のみ
> (テストは計算ロジックの移動後も `src/tests/unit/` に残置)。

## コーディング規約

- 命名規則: 変数・関数は camelCase、型・クラスは PascalCase、定数は UPPER_SNAKE_CASE
- テーブル名・カラム名は snake_case、TypeScript 側は camelCase (Drizzle が自動マッピング)
- コメントは日本語、公開 API・関数には JSDoc を記述
- `any` 型禁止。やむを得ない場合は `unknown`
- TypeScript strict mode 必須
- API 入出力には Zod スキーマでバリデーション
- テストカバレッジ 80% 以上

## CLAUDE.md ルール遵守の要点

### 1. フォールバック禁止

- Yahoo 取得失敗 → throw (silent に null を返さない)
- 日経 VI 取れない → `judgment = "HOLD"` として明示 (VIX だけで B 判定にしない)
- ④需給 ⑤カタリスト → "外部データ未対応" として UI に明示
- エラーハンドラも 200 で握り潰さず、必ず 4xx/5xx を返す

### 2. 実データ必須

- ユニットテストの純関数は OK (indicators/patterns/risk)
- 統合テストはローカルの D1 (wrangler) で実データを使うこと
- sync は 1 銘柄単位で Yahoo から実際のレスポンスを取ってくる

## コマンド

このサービスは kabulab mono-repo のサブアプリ。コマンドはすべて **リポジトリルート**
から実行する。

```bash
pnpm dev                 # ローカル開発サーバー起動 (wrangler dev)
pnpm db:generate:d1      # D1 マイグレーション SQL を生成 (drizzle/d1/*.sql)
# 適用: wrangler d1 execute kabulab-cf --remote --file=drizzle/d1/<file>.sql
pnpm sync:universe       # 東証内国普通株・共有4文字コード ~3,700 を seed (Node 専用)
pnpm sync:daily:core     # core/rsi/swing 日次同期 (サービス固有 sync:swing は廃止)
pnpm test                # 全サービス横断のテスト
pnpm typecheck           # 全サービス型チェック
pnpm lint                # ESLint
```

> 旧 `pnpm db:push:swing` / `db:generate:swing` / `db:studio:swing` (pg dialect) は
> ADR-0001 移行で obsolete。スキーマ管理は `db:generate:d1` + `wrangler d1 execute` に一本化。

## フロントエンド方針

- フレームワーク: Hono (template literal を返す `.ts` 関数で SSR)
- **JSX は使えない** — mono-repo 方針として、ビューは `views/*.ts` で `string` を返す
  template literal 関数で実装する (Workers / esbuild ビルドでもこの方針を踏襲)
- スタイリング: インライン CSS — `views/layout.ts` の `GLOBAL_STYLES` に集約
- **デザインシステム: kabulab Editorial Swiss Grid** (`../../docs/overview.md` 参照)
  - 配色: 白 `#fafafa` ベース + 純黒 `#0a0a0a` ボーダー、アクセントは Blue `#1d4ed8`
  - フォント: Space Grotesk (display) + JetBrains Mono (数字) + Noto Sans JP (本文)
  - 角丸 4px、ボーダー 2px 黒、ホバーは `translate(-3px,-3px)` + `5px 5px 0 0 黒影`
- ヘッダー左端に `← KABULAB` リンク配置、ロゴサブタイトル `003 / KABULAB`

## Git 規約

Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `perf:`)
