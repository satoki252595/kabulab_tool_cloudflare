# 003 Swing Trading — kabulab

**kabulab** プロジェクト群の 003 番。
**数日〜2週間の短期売買**をサポートするサービス。Notion ガイド
「短期売買実践ガイド」の 3 章 (銘柄スクリーニング / エントリー&エグジット / リスク管理) を
日足ベースで自動化し、定量ルールで毎朝の売買判断を再現可能にする。

ポータル: <https://kabulab.vercel.app/>
本サービス: <https://kabulab.vercel.app/swing-trading/>

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

- **Runtime**: Hono v4 + Vercel Serverless Functions
- **Database**: Neon (PostgreSQL) + Drizzle ORM
- **Validation**: Zod
- **Language**: TypeScript (strict mode)

## DB スキーマ設計

**kabulab** 配下の複数プロジェクトで単一 Neon DB を共有する。

| PG スキーマ | 所有 | 用途 |
|------------|------|------|
| `core` | 001_RSIScreening が更新 | 銘柄マスタ・最新ファンダメンタル (一次情報) |
| `rsi` | 001_RSIScreening のみ | RSI パーセンタイル |
| `swing` | 003_swing-trading のみ | OHLCV 履歴・指標・スクリーニング・E&E シグナル・マクロ・セクター |

### core スキーマ (共有、読み取り専用)

- `core.stocks` — 銘柄マスタ
- `core.stock_financials` — 最新ファンダメンタル (PER/PBR/配当利回り/時価総額 等)

**追加原則**: `core.*` には「Yahoo Finance から取得した生に近いデータ」のみ置く。
テクニカル指標・スクリーニング結果・E&E シグナルなど「003 の解釈」は `swing.*` に置く。

### 003 固有スキーマ (swing)

- `swing.daily_ohlcv` — 日足 OHLCV (約 100 営業日保持、100 日超は削除)
- `swing.stock_indicators` — 銘柄ごとの最新テクニカル集計 (1 銘柄 1 行)
- `swing.stock_screening` — 5 条件フィルター結果 (1 銘柄 1 行)
- `swing.entry_signals` — E&E パターン判定 (1 銘柄 × 複数パターン)
- `swing.market_context` — マクロ判定 (1 日 1 行)
- `swing.sector_daily` — セクター騰落ランキング (1 日 × 業種)

## ディレクトリ構成

```
services/swing-trading/
├── base-path.ts                  # BASE_PATH = "/swing-trading"
├── app.ts                        # Hono サブアプリ公開エントリ
└── src/
    ├── index.ts                  # Hono({ strict: false }) + routes + onError
    ├── db/
    │   ├── client.ts             # Neon + Drizzle クライアント
    │   ├── core-schema.ts        # 共有スキーマ (core.*) — 読み取り専用
    │   └── schema.ts             # 003 固有スキーマ (swing.*)
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
    │   └── api.ts                # POST /api/risk/calc + GET /api/cron/sync-daily
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
- 統合テストは Neon preview branch で実データを使うこと
- sync は 1 銘柄単位で Yahoo から実際のレスポンスを取ってくる

## コマンド

このサービスは kabulab mono-repo のサブアプリ。コマンドはすべて **リポジトリルート**
(`/Users/satoki252595/work/0002_kabuTool/`) から実行する。

```bash
pnpm dev                 # ローカル開発サーバー起動
pnpm db:generate:swing   # マイグレーションファイル生成
pnpm db:push:swing       # スキーマを Neon に直接反映 (swing スキーマ)
pnpm db:studio:swing     # Drizzle Studio
pnpm sync:universe       # JPX 全内国株 ~4,000 を core.stocks に seed
pnpm sync:daily          # 統一日次同期 (Yahoo → core/rsi/swing。サービス固有 sync:swing は廃止)
pnpm test                # 全サービス横断のテスト
pnpm typecheck           # 全サービス型チェック
pnpm lint                # ESLint
```

## フロントエンド方針

- フレームワーク: Hono (template literal を返す `.ts` 関数で SSR)
- **JSX は使えない** — Vercel `@vercel/node` が `.tsx` を bundle しないため、ビューは
  `views/*.ts` で `string` を返す関数として実装する
- スタイリング: インライン CSS — `views/layout.ts` の `GLOBAL_STYLES` に集約
- **デザインシステム: kabulab Editorial Swiss Grid** (`../../docs/overview.md` 参照)
  - 配色: 白 `#fafafa` ベース + 純黒 `#0a0a0a` ボーダー、アクセントは Blue `#1d4ed8`
  - フォント: Space Grotesk (display) + JetBrains Mono (数字) + Noto Sans JP (本文)
  - 角丸 4px、ボーダー 2px 黒、ホバーは `translate(-3px,-3px)` + `5px 5px 0 0 黒影`
- ヘッダー左端に `← KABULAB` リンク配置、ロゴサブタイトル `003 / KABULAB`

## Git 規約

Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `perf:`)
