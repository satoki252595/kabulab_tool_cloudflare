# kabulab プロジェクト群 概要

**kabulab** は日本株投資を支援する Web サービス群の統合ブランド。**単一の Cloudflare Worker** (`kabulab-cf`) に複数のサービスを Hono サブアプリとしてマウントする mono-repo 構成で運用する。共通 DB として単一の Cloudflare D1 (SQLite) を共有する (ADR-0001 で Neon PostgreSQL から移行済み)。

## ブランドアイデンティティ

| 項目 | 内容 |
|---|---|
| ブランド名 | **kabulab** |
| ポータルURL | `https://kabulab-cf.satoki252595.workers.dev/` |
| デザインシステム | **Editorial Swiss Grid**（白黒×ニューブルータリスト） |
| 共通フォント | Space Grotesk（display）/ JetBrains Mono（数字）/ Noto Sans JP（本文） |
| アクセント | Blue `#1d4ed8` |

ポータル (`/`) からヘッダーで各サービスへ遷移できる。各サービスは同一 Worker 内で `/<slug>/*` のサブパスにマウントされている。

## 共通技術スタック

| レイヤー | 技術 |
|---|---|
| Runtime (配信) | Cloudflare Workers (Hono root app を fetch ハンドラとして公開) |
| Runtime (取込/書込) | Node.js (ESM) — GitHub Actions 上で sync / ingest を実行 |
| Web Framework | Hono v4 (mono-repo: 1 root app + 複数 sub-app) |
| Database | Cloudflare D1 (SQLite) — 単一 DB `kabulab-cf` に接頭辞テーブルで全サービス同居 |
| ORM | Drizzle ORM (`drizzle-orm/d1` + sqlite-core)。Worker は `c.env.DB` バインディング、取込は `createD1HttpDb` (D1 REST) |
| 時系列ストア | Cloudflare R2 (007 VWAP の daily/intra/margin JSON) |
| 一次データ (raw) | Notion (ルール6。`src/shared/notion-archive`) |
| Validation | Zod v4 + `@hono/zod-validator` |
| View | Hono が直接 HTML 文字列を返却（**JSX 不可** — mono-repo 方針として Workers/esbuild バンドルでも template literal を踏襲する） |
| Language | TypeScript (strict mode) |
| Deploy | Cloudflare Workers Builds (Git 連携。main push で無料自動デプロイ。手動は `wrangler deploy`) |
| 自動化 | GitHub Actions (Node) 3 本: stock-sync / vwap-ingest / catchup |
| Test | Vitest |
| Package Manager | pnpm 9 (Nix Flake で固定。`nix develop` で Node 22 + pnpm 9) |

## プロジェクト一覧

| # | プロジェクト | 概要 | ステータス | URL |
|---|---|---|---|---|
| 000 | [Portal](./000-portal.md) | サービス統合ポータル | 稼働中 | `kabulab-cf.satoki252595.workers.dev/` |
| 001 | [RSI Screening](./001-rsi-screening.md) | 過去5年間でRSIが最も低水準にある優良株を発見 | 稼働中 | `kabulab-cf.satoki252595.workers.dev/rsi-screening/` |
| 002 | [お宝優待](./002-otakara-yutai.md) | 割安な株主優待銘柄をファンダ×テクニカルで発見 | 稼働中 | `kabulab-cf.satoki252595.workers.dev/otakara-yutai/` |
| 003 | [Swing Trading](./003-swing-trading.md) | 数日〜2週間の短期売買をマクロ+5条件+E&E 6パターンで定量化 | 稼働中 | `kabulab-cf.satoki252595.workers.dev/swing-trading/` |
| 004 | 金融数学 | DCF Gordon / CAPM β自動推定 / EMH アノマリースクリーニング / Black-Scholes Greeks | 稼働中 | `kabulab-cf.satoki252595.workers.dev/financial-math/` |
| 005 | [有報定量検索](./005-yuho-quant.md) | EDINET 有報の受注高/受注残高をセグメント別に構造化し最大5年推移を可視化 | 稼働中 | `kabulab-cf.satoki252595.workers.dev/yuho-quant/` |
| 006 | [IR Catalog](./006-ir-catalog.md) | TDnet 適時開示を全量取得し表題からタグ分類、対象タグは PDF 本文のポジ/ネガを軽量 OSS 判定 | 稼働中 | `kabulab-cf.satoki252595.workers.dev/ir-catalog/` |

## ディレクトリ構成

```
kabulab-cf/                            (git: satoki252595/kabulab-cf)
├── worker/
│   └── entry.ts                       # Cloudflare Worker エントリ — src/index.ts の Hono root app を fetch ハンドラとして公開
├── src/
│   ├── index.ts                       # ルート Hono アプリ: ポータルホーム + サブアプリ mount + 取込プロキシルート
│   └── shared/
│       ├── design.ts                  # 共通デザイントークン (CSS 変数 / フォントリンク)
│       ├── auth.ts                    # 取込プロキシ/取込ルートの Bearer token 検証
│       ├── db/                        # D1 クライアント: createServiceDb (c.env.DB) / createD1HttpDb (D1 REST) + core-schema (sqlite-core)
│       ├── notion-archive/            # ルール6: 一次データ Notion アーカイブの唯一の窓口
│       ├── types.ts                   # 共有型 (StockRawData / DailyOhlcv 等)
│       ├── scoring.ts                 # otakara スコアリング (純関数)
│       ├── screener.ts                # swing 5 条件フィルター (純関数)
│       ├── patterns.ts                # swing E&E 6 パターン判定 (純関数)
│       ├── macro.ts                   # swing A/B/C/D マクロ判定 (純関数)
│       ├── sector-aggregate.ts        # swing 33 業種セクター集計 (純関数)
│       ├── yahoo/
│       │   ├── client.ts              # 統一 Yahoo Finance クライアント (Chart + QuoteSummary)
│       │   ├── validators.ts          # Yahoo レスポンス Zod スキーマ
│       │   └── nikkei-vi.ts           # 日経VI スクレイパー
│       ├── jpx/
│       │   └── sectors.ts             # JPX 公式 XLS パーサ
│       └── indicators/
│           ├── rsi.ts                 # RSI(n) 時系列 + percentile rank (Wilder)
│           ├── percentile.ts          # 現在 RSI のパーセンタイル snapshot
│           ├── blue-chip.ts           # 優良株判定 (売上トレンド + 営業利益率 TTM)
│           └── technical.ts           # SMA/ATR/RSI14/MACD/Fib/volume 純関数
├── services/
│   ├── rsi-screening/                 # 001 RSI Screening
│   │   ├── app.ts                     # Hono サブアプリ公開エントリ
│   │   ├── base-path.ts               # BASE_PATH = "/rsi-screening"
│   │   ├── src/
│   │   │   ├── index.ts               # Hono アプリ本体 (API + SSR 配線)
│   │   │   ├── db/                    # core_* + rsi_percentile スキーマ (sqlite-core) + Drizzle/D1 クライアント
│   │   │   ├── routes/                # /api/screening, /api/stocks, SSR pages
│   │   │   ├── services/              # screening-service / stock-detail-service (UI クエリ用)
│   │   │   ├── views/                 # template literal を返す .ts 関数
│   │   │   └── tests/
│   │   └── CLAUDE.md / README.md
│   ├── otakara-yutai/                 # 002 お宝優待
│   │   ├── app.ts                     # Hono サブアプリ (SSR ページを集約)
│   │   ├── src/
│   │   │   ├── db/                    # yutai_* / otakara_* スキーマ (core_stocks を再 export) + Drizzle/D1 クライアント
│   │   │   ├── services/              # yutai-scraper / yutai-data-provider (優待マスタ管理用)
│   │   │   └── tests/
│   │   ├── data-scripts/              # 優待マスタ投入用の 1 回限りスクリプト
│   │   └── CLAUDE.md / README.md
│   ├── swing-trading/                 # 003 Swing Trading
│   │   ├── app.ts                     # Hono サブアプリ公開エントリ
│   │   ├── base-path.ts               # BASE_PATH = "/swing-trading"
│   │   ├── src/
│   │   │   ├── index.ts               # Hono アプリ本体 (routes + onError)
│   │   │   ├── db/                    # core_* + swing_* スキーマ (sqlite-core) + Drizzle/D1 クライアント
│   │   │   ├── routes/                # POST /api/risk/calc + SSR pages
│   │   │   ├── services/              # risk.ts (2% ルール純関数) のみ残存
│   │   │   ├── views/                 # template literal を返す .ts 関数
│   │   │   └── tests/
│   │   └── CLAUDE.md / README.md
│   ├── financial-math/                # 004 金融数学
│   │   ├── app.ts                     # Hono サブアプリ公開エントリ
│   │   ├── base-path.ts               # BASE_PATH = "/financial-math"
│   │   └── src/
│   │       ├── index.ts               # Hono アプリ本体 (routes + onError)
│   │       ├── db/                    # core_* + finmath_* + swing-readonly (sqlite-core) + Drizzle/D1 クライアント
│   │       ├── routes/                # POST /api/{dcf,capm,black-scholes}/calc + SSR pages
│   │       ├── services/              # 純関数: dcf.ts / capm.ts / black-scholes.ts / volatility.ts / emh.ts
│   │       ├── validators/            # Zod (空文字列は preprocess で undefined に正規化)
│   │       ├── views/                 # template literal を返す .ts 関数
│   │       └── tests/                 # unit (純関数) + integration (Hono ルート E2E)
│   ├── yuho-quant/                    # 005 有報定量検索 (yuho_* スキーマ。EDINET 取込 + 受注高/受注残高)
│   ├── ir-catalog/                    # 006 IR Catalog (ir_disclosures。TDnet 取込 + PDF センチメント)
│   └── vwap-analysis/                 # 007 VWAP 分析 (R2 時系列を c.env.BUCKET 経由で読取)
├── public/                            # Worker の [assets] 配信 (kabulab PWA 資産 + public/vwap-analysis/ フロント)
│   ├── otakara-yutai/                 # PWA 静的ファイル (manifest.json / sw.js / icons)
│   └── sw.js                          # 旧 SW を unregister するキルスイッチ
├── scripts/
│   ├── README.md
│   ├── sync/
│   │   ├── universe.ts                # pnpm sync:universe (JPX 全内国株を core_stocks に seed・Node)
│   │   ├── all-daily.ts               # pnpm sync:daily (日次 core/rsi/swing 指標を計算 → D1。GitHub Actions)
│   │   ├── all-monthly.ts             # pnpm sync:monthly (月次 universe + otakara rebuild → D1)
│   │   ├── yuho-edinet.ts             # pnpm ingest:yuho-edinet (Worker /yuho-quant/admin/catchup を叩く)
│   │   └── ir-tdnet.ts                # pnpm ingest:ir-tdnet (TDnet + kuromoji → D1 HTTP)
│   ├── vwap/                          # 007 VWAP 取込 → R2 (GitHub Actions で定期実行)
│   └── migrate/                       # Neon→D1 移行ツール (一度きり)
├── drizzle/                           # マイグレーション SQL。drizzle/d1/*.sql が D1 へ適用する正本
├── docs/                              # mono-repo 全体のドキュメント (このフォルダ)
├── drizzle.d1.config.ts               # D1 スキーマ生成用 drizzle-kit 設定 (sqlite dialect)
├── package.json
├── wrangler.toml                      # Worker 設定 (DB=D1 / BUCKET=R2 / ASSETS=public バインディング)
├── .github/workflows/                # GitHub Actions: stock-sync.yml / vwap-ingest.yml / catchup.yml
└── tsconfig.json / vitest.config.ts / eslint.config.js
```

## URL 構成

| URL | ハンドラ |
|---|---|
| `/` | ルート Hono アプリのポータルホーム ([src/index.ts](../src/index.ts)) |
| `/otakara-yutai/*` | 002 サブアプリ ([services/otakara-yutai/app.ts](../services/otakara-yutai/app.ts)) |
| `/otakara-yutai/manifest.json` 等 | public/otakara-yutai/ から Worker の `[assets]` (ASSETS バインディング) 配信 |
| `/rsi-screening/*` | 001 サブアプリ ([services/rsi-screening/app.ts](../services/rsi-screening/app.ts)) |
| `/swing-trading/*` | 003 サブアプリ ([services/swing-trading/app.ts](../services/swing-trading/app.ts)) |
| `/financial-math/*` | 004 サブアプリ ([services/financial-math/app.ts](../services/financial-math/app.ts)) |
| `/yuho-quant/*` | 005 サブアプリ ([services/yuho-quant/app.ts](../services/yuho-quant/app.ts))。`/yuho-quant/admin/catchup` は EDINET 取込の認証ルート (GitHub Actions catchup が叩く) |
| `/ir-catalog/*` | 006 サブアプリ ([services/ir-catalog/app.ts](../services/ir-catalog/app.ts)) |
| `/vwap-analysis/*` | 007 サブアプリ ([services/vwap-analysis/app.ts](../services/vwap-analysis/app.ts))。R2 時系列を `c.env.BUCKET` 経由で読取 |
| `/api/ingest/*` | Yahoo 取込プロキシ ([src/routes/ingest-proxy.ts](../src/routes/ingest-proxy.ts)) — GitHub Actions(Node) の Yahoo 取得を Cloudflare エッジ経由にして 429 を回避。`CRON_SECRET` で認証 |

トレーリングスラッシュの有無を吸収するため、ルートおよびサブアプリは `new Hono({ strict: false })` で生成している。日次/月次の指標計算・VWAP 取込は Worker 上の cron ではなく **GitHub Actions(Node)** が担い、D1 へは `createD1HttpDb` (D1 REST) で直接書き込む (Workers Paid / Workers Cron を使わない無料運用)。

## DB 設計 — 単一 source of truth

リレーショナルの正本は **単一の Cloudflare D1 (SQLite) `kabulab-cf`** (ADR-0001 で Neon PostgreSQL から移行)。PG のスキーマ名 (core / rsi / public / swing / finmath / ir_catalog) という概念は廃止し、**サービス別の接頭辞テーブル** (`core_*` / `rsi_*` / `swing_*` / `yutai_*` / `otakara_*` / `finmath_*` / `yuho_*` / `ir_*`) を 1 つの D1 に集約する。Drizzle は `drizzle-orm/d1` + sqlite-core。スキーマの正本は [`src/shared/db/core-schema.ts`](../src/shared/db/core-schema.ts) (共有 core) と各サービスの `db/`。

銘柄マスタは **`core_stocks` に 1 本化** 済み (2026-04 の refactor で別マスタを廃止)。`yutai_benefits` 等の FK は `core_stocks(id)` を指す。

```
Cloudflare D1 (kabulab-cf, SQLite)
├── 共有 core_* (sync が更新。全サービスが c.env.DB で読み取り)
│   ├── core_stocks                    銘柄マスタ = 全 JPX 上場内国株 ~4,000 行 (is_yutai で優待銘柄を区別)
│   ├── core_stock_financials          最新ファンダ + 営業利益率 TTM
│   └── core_stock_annual_financials   年度売上高 (過去 4 年程度)
├── 001 RSI 固有
│   └── rsi_percentile                 RSI(10/40/120) + percentile + 優良株フラグ
├── 003 Swing 固有
│   ├── swing_daily_ohlcv              日足 OHLCV (90 営業日。母集団 ~4,000 化で容量確保のため 120→90 に短縮)
│   ├── swing_stock_indicators         SMA(5/20/25/60/75) + ATR14 + RSI14 + MACD + Fib
│   ├── swing_stock_screening          5 条件フィルター結果
│   ├── swing_entry_signals            E&E 6 パターン signal
│   ├── swing_market_context           A/B/C/D マクロ判定 (日次)
│   └── swing_sector_daily             33 業種の騰落ランキング (日次)
├── 002 お宝優待 固有 (銘柄マスタは core_stocks を参照)
│   ├── yutai_genres                   優待ジャンルマスタ (17 件)
│   ├── yutai_benefits                 優待情報 (7986 件)
│   ├── otakara_stock_financials       monthly sync で core + swing から合成 (is_yutai=true のみ)
│   └── otakara_stock_scores           monthly sync の再スコア結果 (is_yutai=true のみ)
├── 004 金融数学 固有 (銘柄マスタは core_stocks を参照)
│   ├── finmath_price_snapshot         Yahoo 由来の最新価格スナップショット (自前ユニバース)
│   └── finmath_daily_ohlcv            Yahoo 由来の日足 OHLCV キャッシュ
├── 005 有報定量検索 固有 (銘柄マスタは core_stocks を参照)
│   ├── yuho_documents                 取り込んだ有報 1 通 = 1 行 (doc_id 一意 = 冪等キー)
│   └── yuho_order_facts               受注高/受注残高 (有報×会計期末×セグメント粒度)
└── 006 IR Catalog 固有 (銘柄マスタは core_stocks を参照)
    └── ir_disclosures                 TDnet 適時開示 1 件 = 1 行 (タグ分類 + PDF センチメント)
```

時系列データ (007 VWAP の daily/intra/margin) は D1 ではなく **R2** (バケット `vwap-data`)、外部取得した一次データ (raw) は **Notion** に置く (後述)。

**004 金融数学** は `finmath_price_snapshot` / `finmath_daily_ohlcv` で Yahoo 由来の価格・OHLCV をキャッシュしつつ、`core_stocks` / `core_stock_financials` / `core_stock_annual_financials` / `swing_daily_ohlcv` / `swing_stock_indicators` を読み取り専用で集計する。DCF/CAPM/EMH 等の集計計算は永続化せずオンデマンドでレスポンスに返す。

### 過去に存在したが削除されたテーブル

| テーブル | 削除時期 | 理由 |
|---|---|---|
| `core_stock_price_history` | 2026-04 | RSI 計算は in-memory で完結、DB 永続化不要 |
| `rsi_stock_rsi_history` | 2026-04 | 日次 RSI 時系列は UI 非使用、percentile だけ保存 |
| `public.stock_history` | 2026-04 | 月次 PER/PBR 推移は UI 非使用 |
| `public.stocks` | 2026-04 | core_stocks に一本化 (FK 付け替え済み) |

### `swing_stock_indicators.sma_25` の特殊性

002 otakara の MA25 乖離率スコアリングで使うため、swing の日次インジケータ計算パスで SMA(25) も一緒に算出して保存している (swing 自身の screening/patterns では未使用)。月次 sync が otakara のスコア計算時に参照する。

## 一次データアーカイブ (Notion — ルール6)

外部取得した一次データ (raw source data) は DB への構造化保存とは別に、
共有ライブラリ [`src/shared/notion-archive/`](../src/shared/notion-archive/)
を唯一の窓口として Notion へ冪等記録する。

| 関数 | 役割 |
|---|---|
| `recordPrimaryData()` | 冪等 key (EDINET docId 等) 付きでメタ + **物理ファイル実体** をアップロード |
| `moveToTrash()` | input 変更で不要化した元データを `Obsoleted At/Reason/Origin` 付きで「ごみ」へ退避 |
| `isArchived()` | 記録済み判定 (バックフィルの再開に使う) |

- 記録先は「バックアップ」ページ配下の `一次データ｜<service>` DB (自動生成。
  区切りは全角縦棒 U+FF5C)。退避先は「ごみ」配下の `ごみ｜<service>`。
- `client.ts` が全通信をプロセス内直列化 (~3req/s)、429 は Retry-After 尊重、
  5xx は指数バックオフ。**他モジュールから `api.notion.com` を直叩きしない**。
- 高頻度ポーリング由来の派生データ (per-stock 日次 JSON 等) はミラーしない —
  「取得バッチ単位の確定ファイル」粒度で記録する (Notion ハードリミット帰結)。
- 利用例: 005 yuho-quant (有報 ZIP)、006 ir-catalog (TDnet PDF —
  [docs/006-ir-catalog.md](./006-ir-catalog.md) 参照)、002 otakara
  (優待 JSONL エクスポート)。

## データ取得 — 日次 / 月次 (GitHub Actions / Node)

取込 (書込) は **GitHub Actions(Node)** が担う。指標・スコア計算は Node で行い、D1 へは `createD1HttpDb` (D1 REST) で書き込む。Yahoo は共有クライアントが **`YAHOO_PROXY_BASE`** (Worker エッジの `/api/ingest/yahoo`) 経由で叩くため、ランナー IP が 429 されない。Workers Paid / Workers Cron は使わない (subrequest 50/invocation の無料枠では Worker 上で全銘柄 sync を捌けないため)。

株価系の自動化は GitHub Actions ワークフロー [`.github/workflows/stock-sync.yml`](../.github/workflows/stock-sync.yml) が担当 (平日 21:00 UTC = 翌 06:00 JST に日次、毎月 1 日 22:30 UTC に月次 universe + otakara rebuild)。

従来はサービス毎に sync コマンド (`sync:rsi`, `sync:otakara`, `sync:swing`, `sync:sectors`, `sync-light`) が分裂していた。2026-04 の refactor で `sync:daily` / `sync:monthly` の 2 本に統合。2026-05、004 financial-math (DCF/CAPM/EMH) が一般日本株ユニバースを要するため母集団を「otakara が seed する優待縛り ~1,600」から **全 JPX 上場内国株 ~4,000** へ拡張し、母集団 seed 用の `sync:universe` を追加した (3 コマンド体制)。優待は `core_stocks.is_yutai` フラグで保持し、002 otakara のみ is_yutai=true を母集団とする。

### `pnpm sync:universe`

JPX 公式 `data_j.xls` の内国普通株 (プライム/スタンダード/グロース) を `core_stocks` に upsert。新規 insert + name/market/sector 更新 + raw JPX に無い code の inactivate (上場廃止)。`is_yutai` は触らない (otakara の優待スクレイパーが writer)。xlsx パースは Node 専用。月次ワークフローで `sync:monthly` の前段として実行され、母集団 (`core_stocks`) を最新化する。明示的な手動 seed/復旧用 CLI としても使う。

### `pnpm sync:daily` (= `scripts/sync/all-daily.ts`)

1 銘柄につき Yahoo を **Chart(5y) 1 回 + QuoteSummary 1 回** だけ叩き、in-memory で全サービス分の指標を計算して D1 に書き込む。

- Phase 0: JPX `data_j.xls` で `core_stocks` を全内国株へ同期 (= `seedUniverse`)。失敗時は別値で埋めず警告 + `universe=null` を残し既存 `core_stocks` で続行 (ルール2)
- Phase 1: `core_stocks` から active 銘柄を取得
- Phase 2: マクロ指数 (^N225 / ^VIX / ^GSPC / NIY=F) + 日経VI を並列取得
- Phase 3: worker pool (CONCURRENCY=5, DELAY_MS=200) で:
  - Yahoo `fetchStockRawData(code, "5y")` = Chart + QuoteSummary 並列 (`YAHOO_PROXY_BASE` 経由)
  - 5y OHLCV → RSI(10/40/120) 時系列 + percentile snapshot + 優良株判定
  - 6mo スライス → SMA(5/20/25/60/75) + ATR14 + RSI14 + MACD + Fib + volume/turnover + 前日比%
  - 5 条件 screening と E&E 6 パターン判定
  - `core_stock_financials` / `core_stock_annual_financials` / `rsi_percentile` / `swing_{daily_ohlcv,stock_indicators,stock_screening,entry_signals}` を upsert
  - 404 の銘柄は `core_stocks.is_active=false` 予約
- Phase 5: 廃止銘柄の is_active 更新
- Phase 4: セクター集計。`core_stocks ⋈ swing_stock_indicators` を D1 から再読込し、本日更新分のカバレッジ 90% 未満なら誤集計を避けて保留 (前回値維持)・警告。`swing_sector_daily` 書き直し

母集団 ~4,000 を 1 回の Node 実行で回す。GitHub Actions ジョブの `timeout-minutes: 90` (~40-50 分/回) 内で完結する。GH Actions 無料枠 (private 2,000 min/月) を意識し、VWAP と合わせて枠に近づく場合は cron を間引く運用余地がある。

### `pnpm sync:monthly` (= `scripts/sync/all-monthly.ts`)

**Yahoo を 1 回も叩かない**。JPX 公式 XLS と D1 内データだけで完結する。

- Phase 1: JPX `data_j.xls` から `core_stocks` を全内国株に同期 (= `seedUniverse`、sector も upsert に内包)
- Phase 2: `is_yutai=true` の優待銘柄のみ `core_stock_financials` + `swing_stock_indicators` + `yutai_benefits` を読んで `otakara_stock_financials` / `otakara_stock_scores` を再計算 (otakara テーブルを ~1,600 に抑える)

### その他の取込ワークフロー (GitHub Actions)

- **007 VWAP** ([`.github/workflows/vwap-ingest.yml`](../.github/workflows/vwap-ingest.yml)): 平日 08:00 UTC に日足10年 + 5分足、土 09:00 UTC に信用残高 (週次) を取得し **R2** (`vwap-data` バケット、`daily/{code}.json` / `intra/{code}.json` / `margin/{week}.json`) へ書き込む。Yahoo は `YAHOO_PROXY_BASE` (Worker エッジ `/vwap-analysis/api/ingest-fetch`) 経由。
- **005 EDINET + 006 TDnet** ([`.github/workflows/catchup.yml`](../.github/workflows/catchup.yml)): 平日 11:00 UTC に当日の開示をキャッチアップ。006 TDnet は kuromoji (Node 専用) のセンチメント判定込みで Node 実行 → D1 HTTP 書込。005 EDINET は Worker の認証ルート `/yuho-quant/admin/catchup` を叩く薄いトリガ (EDINET fetch + Notion アーカイブ + D1 書込は Worker 側が時間予算内で実行)。
- **002 優待の LLM 解釈** (`pnpm interpret:yutai`) のみローカル手動運用 (自動化対象外)。

## 認証

取込プロキシ (`/api/ingest/*`) と各サービスの取込ルート (例 `/yuho-quant/admin/catchup`) は `Authorization: Bearer $CRON_SECRET` を要求する。`CRON_SECRET` は Worker 側に `wrangler secret put CRON_SECRET` で登録し、GitHub Actions 側は同値を Secrets に持たせる。検証ロジックは [src/shared/auth.ts](../src/shared/auth.ts) に集約 (以前はサービス毎に重複していた)。

## デザインシステム

すべての kabulab サービスは「**Editorial Swiss Grid**」デザインを共有する。CSS 変数とベースリセットは [`src/shared/design.ts`](../src/shared/design.ts) に集約されており、サービスはここから token を取り込んでサービス固有スタイルを連結する。

### 配色

| 用途 | 値 |
|---|---|
| 背景 | `#fafafa`（オフホワイト）/ `#ffffff`（純白カード） |
| 反転背景 | `#0a0a0a`（純黒） |
| テキスト | `#0a0a0a`（主）/ `#3a3a3a`（副）/ `#737373`（弱） |
| ボーダー | `#0a0a0a`（2px 実線が基本） |
| アクセント | `#1d4ed8`（フォーカス・リンク強調） |
| Success | `#15803d` |
| Warning | `#b45309` |
| Danger | `#b91c1c` |

### タイポグラフィ

| 用途 | フォント |
|---|---|
| Display（見出し・ナビ・ボタン） | **Space Grotesk** 700 |
| Mono（数字・コード・ラベル） | **JetBrains Mono** 400-700 |
| Body（本文） | **Noto Sans JP** 400-700 |

ベースフォントサイズ 17px、行間 1.75。タップ領域 48px+。

### 共通UIパターン

- **ロゴ**: 16×16 の白い四角を黒い 32×32 枠で囲んだマーク + ブランド名（日本語）+ プロジェクト番号サブタイトル（英字 mono）
- **セクションラベル**: `001 / SECTION NAME`（左に 2px 黒バー + uppercase mono）
- **カードホバー**: `translate(-3px, -3px)` + `box-shadow: 5px 5px 0 0 #0a0a0a`（ニューブルータリスト）
- **角丸**: 4px（シャープ）
- **ボーダー**: 2px 純黒
- **ボタン**: 黒背景・白文字・uppercase + tracking
- **フィルター/ガイドボックス**: 上端に「FILTER」「GUIDE」のラベルバッジ

## 主要コマンド

```bash
# 開発
pnpm dev                    # wrangler dev (ローカル Worker。D1/R2 バインディングつき)
pnpm typecheck              # tsc --noEmit (全サービス型チェック)
pnpm test                   # vitest run
pnpm lint                   # eslint src services

# デプロイ
# git push origin main で Cloudflare Workers Builds が無料で auto-deploy する
pnpm run deploy             # (任意) wrangler deploy で手動デプロイ

# DB スキーマ管理 (D1。schema 編集時のみ使う)
pnpm db:generate:d1         # D1(SQLite) スキーマ生成 → drizzle/d1/*.sql
# 反映: wrangler d1 execute kabulab-cf --remote --file=drizzle/d1/<n>.sql

# データ同期 (GitHub Actions / Node。定常運用は daily / monthly の 2 本)
pnpm sync:daily             # 全 active ~4,000 + マクロ + 全サービス指標・パターン・セクター (~40-50分)。Phase 0 で JPX 母集団同期を内包
pnpm sync:monthly           # 優待 (is_yutai) 再スコア (Yahoo なし)
pnpm sync:universe          # JPX 母集団 (core_stocks) を seed/更新 (月次 universe の前段。手動 seed/復旧にも使う)

# 取込 (GitHub Actions / Node)
pnpm ingest:vwap-daily / :vwap-intra / :vwap-margin   # 007 VWAP → R2
pnpm ingest:ir-tdnet        # 006 TDnet 適時開示 (kuromoji) → D1
pnpm ingest:yuho-edinet     # 005 EDINET 有報トリガ (Worker /yuho-quant/admin/catchup)
```

## 新プロジェクト追加時のパターン

詳細は [new-project-template.md](./new-project-template.md) を参照。要点:

1. `services/<slug>/` フォルダを作成
2. `app.ts` で Hono サブアプリを定義し、`BASE_PATH = "/<slug>"` を export
3. ルート HTML / form action / fetch URL は必ず `${BASE_PATH}` を前置
4. ヘッダー左端に `← KABULAB` リンクを配置（`/` へ遷移、ポータルへ戻る）
5. ロゴサブタイトル: `NNN / KABULAB`（NNN はプロジェクト番号）
6. `src/index.ts` に `app.route(BASE_PATH, mySubApp)` を追加
7. `SERVICES` 配列にカードを追加（src/index.ts 内）
8. PWA / 静的アセットは `public/<slug>/` に配置
9. **定期実行が必要なら Worker 上の cron ではなく GitHub Actions(Node) の既存ワークフロー (stock-sync / vwap-ingest / catchup) に相乗りさせる**。Workers Cron は使わない (無料運用方針)。指標計算は Node で行い D1 へは `createD1HttpDb` で書く
10. **JSX は使えない** — ビューは template literal を返す `.ts` 関数として実装する (mono-repo 方針として Workers/esbuild バンドルでも踏襲)
11. **POST フォームの optional フィールド**は `z.preprocess((v) => v === "" ? undefined : v, ...)` で空文字列を吸収する (HTML form の標準挙動でフォーム未入力は `""` 送信)。`z.coerce.number().optional()` 単独だと `""` が `0` に変換されるバグの温床になるので注意。
12. **DB アクセス** — Worker (読取) は `c.env.DB` を `createServiceDb(c.env.DB, ownSchema)` でラップ、取込 (書込) は Node 側で `createD1HttpDb` (D1 REST) を使う。共有 core スキーマ + サービス固有スキーマはいずれも sqlite-core で定義する。
