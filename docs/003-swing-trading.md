# 003 Swing Trading — kabulab

数日〜2週間の短期売買を **ルール化・定量化** する Web サービス。
Notion ガイド「短期売買実践ガイド」の 3 章 (スクリーニング / エントリー&エグジット / リスク管理) を
日足ベースで自動化する。

> kabulab mono-repo (`services/swing-trading/`) として配置され、
> Cloudflare Workers + Hono 上で `https://kabulab-cf.satoki252595.workers.dev/swing-trading/*` として公開される。

## コンセプト

- **マクロ → セクター → 個別** の 3 層フィルターで「今日、短期で取るべきか」を定量判断
- 5 実戦パターン (ブレイクアウト / 押し目買い / 出来高急増 / ギャップ / 決算後代理) を日足ベースで自動検出 (6 番目の VWAP は分足必須でスコープ外)
- **2% ルール** のポジションサイズ計算機で、口座資金とロスカット幅から最適な株数を自動計算
- **④需給 / ⑤カタリスト** は Yahoo Finance で取れないため「外部データ未対応」として UI 明示

## ディレクトリ構成

```
services/swing-trading/
├── app.ts                     # Hono サブアプリ公開エントリ (export default app)
├── base-path.ts               # export const BASE_PATH = "/swing-trading"
├── src/
│   ├── index.ts               # Hono アプリ本体 (routes + onError)
│   ├── db/
│   │   ├── client.ts          # createDb(c.env.DB) — D1 バインディング + Drizzle (drizzle-orm/d1)
│   │   ├── core-schema.ts     # 共有 core_* スキーマ (読み取り専用)
│   │   └── schema.ts          # 003 固有 swing_* テーブル (5 テーブル。旧 screening は indicators に畳み)
│   ├── routes/
│   │   ├── pages.ts           # GET / /screening /signals /stock/:code /risk
│   │   └── api.ts             # POST /api/risk/calc のみ
│   ├── services/
│   │   └── risk.ts            # 2% ルール ポジションサイズ計算 (純関数)
│   ├── views/                 # template literal を返す .ts 関数
│   ├── validators/            # Zod スキーマ (zod/mini。K4c-2 で移行)
│   └── tests/unit/            # indicators / patterns / risk のユニットテスト
├── CLAUDE.md
└── README.md
```

D1 マイグレーションは root の `drizzle/d1/*.sql`（サービス配下の `drizzle/` は持たない）。
`pnpm db:generate:d1` で生成し、`wrangler d1 execute kabulab-cf --remote --file=...` で適用する。

**過去から変わった点** (2026-04):

- 本サービス固有の `yahoo-finance.ts` / `nikkei-vi.ts` / `sync.ts` / `indicators.ts` / `patterns.ts` / `macro.ts` / `sector.ts` / `screener.ts` / `validators/yahoo-finance.ts` / `scripts/sync-daily.ts` は **削除**。
- 計算ロジックは [src/shared/](../src/shared/) (root 直下) に移動:
  - `indicators/technical.ts` (SMA/ATR/RSI14/MACD/Fib)
  - `screener.ts` (5 条件)
  - `patterns.ts` (E&E 6 パターン)
  - `macro.ts` (A/B/C/D)
  - `sector-aggregate.ts` (33 業種集計)
  - `yahoo/client.ts` + `yahoo/nikkei-vi.ts`
- 本サービス内の cron ルート `/api/cron/sync-daily` と `/api/cron/sync-light` は廃止。取込は **GitHub Actions (`stock-sync.yml`) から Node で実行する統一 sync** が代替する。**intraday マクロ更新 (sync-light) は削除**。
- 純関数の `risk.ts` のみ `services/swing-trading/src/services/` 配下に残存 (UI 側から直接 import しているため)。

## DB スキーマ (swing_*)

単一 Cloudflare D1 (SQLite) `kabulab-cf` に全サービスが接頭辞テーブルで同居する。D1 は名前空間が無いため旧 PG スキーマ `swing.<table>` は接頭辞 `swing_<table>` へ降ろしている。Drizzle ORM は `drizzle-orm/d1` + `sqlite-core`。

| テーブル | 用途 | 粒度 |
|---|---|---|
| `swing_daily_ohlcv` | 日足 OHLCV 履歴 | 1 銘柄 × 最大 90 営業日 |
| `swing_stock_indicators` | テクニカル指標の最新値 (SMA5/20/**25**/60/75, ATR, RSI, MACD, Fib 等) + 5 条件の畳み込み列 (L-52) | 1 銘柄 1 行 |
| `swing_entry_signals` | E&E パターン判定 | 1 銘柄 × 複数パターン |
| `swing_market_context` | マクロ判定 (A/B/C/D) | 1 日 1 行 |
| `swing_sector_daily` | セクター騰落ランキング (30 日保持。旧 `pct_5d` は常時 NULL のため 0018 で DROP) | 1 日 × 業種 |

`core_stocks` と `core_stock_financials` は 日次 sync が所有しており (正本 `src/shared/db/core-schema.ts`)、003 は読み取り専用で参照する。

### `sma_25` カラムの特殊性

`swing_stock_indicators.sma_25` は **002 otakara の MA25 乖離率スコアリングで使う** ために追加されている (2026-04)。swing 自身の screening/patterns では使わないが、共通フェッチパスで計算しておくことで月次 sync が Yahoo を叩かずに済む。

## ページ

| URL | 内容 |
|---|---|
| `/swing-trading/` | マクロ判定バッジ (A/B/C/D) + セクター上位 5 + 強度上位シグナル 5 |
| `/swing-trading/screening?direction=long\|short` | 5 条件通過銘柄一覧 (LONG/SHORT 切替) |
| `/swing-trading/signals?pattern=*` | E&E パターン別シグナル一覧 |
| `/swing-trading/stock/:code` | 銘柄詳細 (全指標 + 該当パターン + リスク計算プリセット) |
| `/swing-trading/risk` | 2% ルール ポジションサイズ計算機 (form) |

## 実装されたロジック (shared モジュール)

### マクロ判定 ([src/shared/macro.ts](../src/shared/macro.ts))

```
A (積極): 日経VI 20-25, 売買代金 1.2x 超, ギャップ小
B (通常): 日経VI 25-30, 売買代金 平均程度
C (慎重): 日経VI 30-35, 売買代金 0.8x 未満
D (見送り): 日経VI 35 超 or VIX 20 超 & S&P500 -1% 以下
HOLD  : 日経VI 取得不能 (silent fallback せず保留)
```

マクロデータは日次 sync の `fetchMarketContextDraft()` が以下を取得し、`judgeMacro()` で判定する ([src/cron/daily.ts](../src/cron/daily.ts)):

- Yahoo Finance (統一クライアント [src/shared/yahoo/client.ts](../src/shared/yahoo/client.ts)): `^N225` / `^VIX` / `^GSPC` / `NIY=F` (CME 日経 225 円建て先物)
- Nikkei 電子版スマートチャート (scrape): 日経平均 VI ([src/shared/yahoo/nikkei-vi.ts](../src/shared/yahoo/nikkei-vi.ts))

日経VI scraper は `https://www.nikkei.com/smartchart/?code=N145/O` の `window.__INITIAL_STATE__` から DPP (現在値) / PRP (前日終値) を抽出する。HTML 構造が変わったら throw し、UI は「判定保留」と明示する (silent fallback 禁止)。

### 5 条件スクリーニング ([src/shared/screener.ts](../src/shared/screener.ts))

| # | 条件 | 計算 | 実装 |
|---|---|---|---|
| ① | 流動性 | `avgTurnover20d ≧ 10億 OR (volumeRatio ≧ 3 AND ≧ 5億)` | ✅ |
| ② | ボラ | `atrPct ≧ 0.02` (% 値比較のため実効 0.02% と極めて緩い既知の状態。別タスクで挙動修正を検討) | ✅ |
| ③ | トレンド | `sma5>sma20 AND close>sma5` (long) / 逆 (short) | ✅ |
| ④ | 需給 (信用倍率) | 松井証券ページ | ❌ 外部未対応 |
| ⑤ | カタリスト (決算) | 株予報カレンダー | ❌ 外部未対応 |

### E&E 6 パターン ([src/shared/patterns.ts](../src/shared/patterns.ts))

1. **ブレイクアウト** — 20 日レンジ突破 + 出来高 1.5x
2. **押し目買い / 戻り売り** — パーフェクトオーダー + fib 38.2-61.8
3. **出来高急増** — 3x + 前日比 3%+ (翌日エントリー狙い)
4. **ギャップ** — 追随 (breakout gap) / 窓埋め (普通窓)
5. ~~VWAP~~ — 分足必須のためスコープ外
6. **決算後初動 (代理)** — 出来高 2.5x + 前日比 5%+ + ATR% 3%+

### リスク計算機 ([services/swing-trading/src/services/risk.ts](../services/swing-trading/src/services/risk.ts))

Notion ガイドの例題を再現:

- 口座 500 万、エントリー 2,000 円、ロスカ 1,940 円、2% ルール → **1,600 株**

ユニットテスト `tests/unit/risk.test.ts` で完全一致を保証。risk.ts は UI form からも直接 import するため shared ではなくサービス内に残している。

## データ同期

本サービスは独自の sync を持たない。**統一日次 sync** ([src/cron/daily.ts](../src/cron/daily.ts)) が以下を行う:

1. マクロ 4 指数 + 日経VI を並列取得 → `swing_market_context` に A/B/C/D 判定付きで upsert
2. 全 active 銘柄を worker pool (5 並列 × 150ms 間隔) で:
   - Yahoo `fetchStockRawData(code, "5y")` = Chart + QuoteSummary 並列
   - 5y の末尾 6mo をスライスして SMA/ATR/RSI14/MACD/Fib/volume 計算
   - `swing_daily_ohlcv` は増分 upsert (初回のみ 6mo 全 backfill、以降は当日分 1〜2 行。保持は 90 営業日)
   - 90 本を超える古い行の削除は書き込み経路ではなく **Phase 4 の一括 sweep** (`pruneOhlcvRetention`) が行う。書き込み経路内で prune していた頃は Yahoo 取得が失敗し続けた銘柄で一度も走らず、120 行の残骸が残っていた
   - `swing_stock_indicators` (5 条件の畳み込み列を含む) / `swing_entry_signals` に multi-row upsert (K4a 系)
3. セクター集計 (Phase 5): `core_stocks ⋈ swing_stock_indicators` を DB から再読込し `swing_sector_daily` を書き直し (当日分 + 30 日より古い行を破棄)。本日更新分のカバレッジ 90% 未満なら誤集計を避けて保留・警告

書込 (取込) は **Node (GitHub Actions)** から D1 REST 経由 (`createD1HttpDb`) で行う。Yahoo へのアクセスは `YAHOO_PROXY_BASE` (Worker エッジ `/api/ingest/yahoo`) を介して 429 を回避する。Worker 側の読取は `c.env.DB` バインディング (`createDb(c.env.DB)`)。

起動:

```bash
pnpm sync:daily:core   # core/rsi/swing 単体の手動実行 (全 active ~3,700)
```

自動実行: **GitHub Actions** `stock-sync.yml` が日次で `sync:daily:core` (core/rsi/swing) を、月次で universe / otakara rebuild を実行する。`sync:daily` は core に VWAP 3 工程を加えたローカル手動フル実行。母集団 ~3,700 を Node ランナー上で一括処理するため、Workers Cron / Workers Paid は使わない。VWAP 時系列 (007) は `vwap-ingest.yml`、005 EDINET / 006 TDnet は `catchup.yml` が担当する。

## スコープ外の明示

Yahoo Finance 無料 API の制約により実装しないもの:

- パターン 5: VWAP 戦略 (分足必須)
- 当日 14 時急増エントリー (分足必須)
- ギャップ寄り後 10 時の判定 (分足必須)
- 信用倍率 / 買残 / 貸借情報 (Yahoo 非対応)
- 決算・配当・IR カレンダー (Yahoo 非対応)
- ポートフォリオ追跡 (保有ポジション DB は作らない、計算機のみ)
- ドローダウン段階別モード自動切替 (目安表示のみ)
- 昼休みの intraday マクロ更新 (旧 `sync-light` は 2026-04 に廃止)

UI 上で「手動確認リンク」として JPX / 松井証券 / 株予報 へ誘導する。

## 関連

- ポータル: [../src/index.ts](../src/index.ts)
- ガイド: [./new-project-template.md](./new-project-template.md)
- 共有デザイン: [../src/shared/design.ts](../src/shared/design.ts)
- 共通オーケストレータ: [../src/cron/daily.ts](../src/cron/daily.ts)
- 001 RSI Screening: [./001-rsi-screening.md](./001-rsi-screening.md)
- 002 お宝優待: [./002-otakara-yutai.md](./002-otakara-yutai.md)
