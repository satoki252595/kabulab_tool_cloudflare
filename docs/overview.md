# kabulab プロジェクト群 概要

**kabulab** は日本株投資を支援する Web サービス群の統合ブランド。**単一の Vercel プロジェクト** (`kabulab`) に複数のサービスを Hono サブアプリとしてマウントする mono-repo 構成で運用する。共通 DB として Neon PostgreSQL を共有する。

## ブランドアイデンティティ

| 項目 | 内容 |
|---|---|
| ブランド名 | **kabulab** |
| ポータルURL | `https://kabulab.vercel.app/` |
| デザインシステム | **Editorial Swiss Grid**（白黒×ニューブルータリスト） |
| 共通フォント | Space Grotesk（display）/ JetBrains Mono（数字）/ Noto Sans JP（本文） |
| アクセント | Blue `#1d4ed8` |

ポータル (`/`) からヘッダーで各サービスへ遷移できる。各サービスは Vercel の同一プロジェクト内で `/<slug>/*` のサブパスにマウントされている。

## 共通技術スタック

| レイヤー | 技術 |
|---|---|
| Runtime | Node.js (ESM) |
| Web Framework | Hono v4 (mono-repo: 1 root app + 複数 sub-app) |
| Database | Neon (serverless PostgreSQL) |
| ORM | Drizzle ORM (`drizzle-orm/neon-http`) |
| Validation | Zod v4 + `@hono/zod-validator` |
| View | Hono が直接 HTML 文字列を返却（**JSX 不可** — Vercel `@vercel/node` が `.tsx` を bundle しない） |
| Language | TypeScript (strict mode) |
| Deploy | Vercel Serverless Functions（**単一プロジェクト**） |
| Test | Vitest |
| Package Manager | pnpm 9 (Nix Flake で固定。`nix develop` で Node 22 + pnpm 9) |

## プロジェクト一覧

| # | プロジェクト | 概要 | ステータス | URL |
|---|---|---|---|---|
| 000 | [Portal](./000-portal.md) | サービス統合ポータル | 稼働中 | `kabulab.vercel.app/` |
| 001 | [RSI Screening](./001-rsi-screening.md) | 過去5年間でRSIが最も低水準にある優良株を発見 | 稼働中 | `kabulab.vercel.app/rsi-screening/` |
| 002 | [お宝優待](./002-otakara-yutai.md) | 割安な株主優待銘柄をファンダ×テクニカルで発見 | 稼働中 | `kabulab.vercel.app/otakara-yutai/` |
| 003 | [Swing Trading](./003-swing-trading.md) | 数日〜2週間の短期売買をマクロ+5条件+E&E 6パターンで定量化 | 稼働中 | `kabulab.vercel.app/swing-trading/` |
| 004 | 金融数学 | DCF Gordon / CAPM β自動推定 / EMH アノマリースクリーニング / Black-Scholes Greeks | 稼働中 | `kabulab.vercel.app/financial-math/` |
| 005 | [有報定量検索](./005-yuho-quant.md) | EDINET 有報の受注高/受注残高をセグメント別に構造化し最大5年推移を可視化 | 稼働中 | `kabulab.vercel.app/yuho-quant/` |
| 006 | [IR Catalog](./006-ir-catalog.md) | TDnet 適時開示を全量取得し表題からタグ分類、対象タグは PDF 本文のポジ/ネガを軽量 OSS 判定 | 稼働中 | `kabulab.vercel.app/ir-catalog/` |

## ディレクトリ構成

```
kabulab_tool/                          (git: satoki252595/kabulab_tool)
├── api/
│   └── index.ts                       # Vercel 関数エントリ — req.body を materialize して app.fetch(Request) に橋渡し
├── src/
│   ├── index.ts                       # ルート Hono アプリ: ポータルホーム + サブアプリ mount + 統一 cron 2 本
│   ├── cron/
│   │   ├── daily.ts                   # 日次 sync オーケストレータ (1 本で全サービス更新)
│   │   └── monthly.ts                 # 月次 sync オーケストレータ (JPX + otakara scoring)
│   └── shared/
│       ├── design.ts                  # 共通デザイントークン (CSS 変数 / フォントリンク)
│       ├── auth.ts                    # 統一 cron Bearer token 検証
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
│   │   │   ├── db/                    # core / rsi スキーマ + Drizzle クライアント
│   │   │   ├── routes/                # /api/screening, /api/stocks, SSR pages
│   │   │   ├── services/              # screening-service / stock-detail-service (UI クエリ用)
│   │   │   ├── views/                 # template literal を返す .ts 関数
│   │   │   └── tests/
│   │   └── CLAUDE.md / README.md
│   ├── otakara-yutai/                 # 002 お宝優待
│   │   ├── app.ts                     # Hono サブアプリ (SSR ページを集約)
│   │   ├── src/
│   │   │   ├── db/                    # public スキーマ (core.stocks を再 export) + Drizzle クライアント
│   │   │   ├── services/              # yutai-scraper / yutai-data-provider (優待マスタ管理用)
│   │   │   └── tests/
│   │   ├── data-scripts/              # 優待マスタ投入用の 1 回限りスクリプト
│   │   └── CLAUDE.md / README.md
│   ├── swing-trading/                 # 003 Swing Trading
│   │   ├── app.ts                     # Hono サブアプリ公開エントリ
│   │   ├── base-path.ts               # BASE_PATH = "/swing-trading"
│   │   ├── src/
│   │   │   ├── index.ts               # Hono アプリ本体 (routes + onError)
│   │   │   ├── db/                    # core / swing スキーマ + Drizzle クライアント
│   │   │   ├── routes/                # POST /api/risk/calc + SSR pages
│   │   │   ├── services/              # risk.ts (2% ルール純関数) のみ残存
│   │   │   ├── views/                 # template literal を返す .ts 関数
│   │   │   └── tests/
│   │   └── CLAUDE.md / README.md
│   └── financial-math/                # 004 金融数学
│       ├── app.ts                     # Hono サブアプリ公開エントリ
│       ├── base-path.ts               # BASE_PATH = "/financial-math"
│       └── src/
│           ├── index.ts               # Hono アプリ本体 (routes + onError)
│           ├── db/                    # core-schema + swing-readonly + Drizzle クライアント (新規スキーマなし)
│           ├── routes/                # POST /api/{dcf,capm,black-scholes}/calc + SSR pages
│           ├── services/              # 純関数: dcf.ts / capm.ts / black-scholes.ts / volatility.ts / emh.ts
│           ├── validators/            # Zod (空文字列は preprocess で undefined に正規化)
│           ├── views/                 # template literal を返す .ts 関数
│           └── tests/                 # unit (純関数) + integration (Hono ルート E2E)
├── public/
│   ├── otakara-yutai/                 # PWA 静的ファイル (manifest.json / sw.js / icons)
│   └── sw.js                          # 旧 SW を unregister するキルスイッチ
├── scripts/
│   ├── README.md
│   ├── sync/
│   │   ├── universe.ts                # pnpm sync:universe の CLI エントリ (JPX 全内国株を core.stocks に seed)
│   │   ├── daily.ts                   # pnpm sync:daily の CLI エントリ (runDailySync を呼ぶ)
│   │   └── monthly.ts                 # pnpm sync:monthly の CLI エントリ
│   └── db/
│       ├── apply-migration.mjs        # drizzle 生成 SQL を Neon HTTP で適用 (--> statement-breakpoint 区切り)
│       ├── apply-unify-migration.mjs  # public.stocks → core.stocks 統一マイグレーションの一回限りランナ
│       └── check-db.mjs               # 各スキーマの行数確認
├── drizzle/                           # マイグレーション SQL (手書き)
├── docs/                              # mono-repo 全体のドキュメント (このフォルダ)
├── drizzle.*.config.ts                # スキーマ別 drizzle-kit 設定
├── package.json
├── vercel.json                        # rewrites + crons (日次 8 シャード + 月次 1 = 計 9 本) + functions.maxDuration
└── tsconfig.json / vitest.config.ts / eslint.config.js
```

## URL 構成

| URL | ハンドラ |
|---|---|
| `/` | ルート Hono アプリのポータルホーム ([src/index.ts](../src/index.ts)) |
| `/otakara-yutai/*` | 002 サブアプリ ([services/otakara-yutai/app.ts](../services/otakara-yutai/app.ts)) |
| `/otakara-yutai/manifest.json` 等 | public/otakara-yutai/ から Vercel 直接配信 |
| `/rsi-screening/*` | 001 サブアプリ ([services/rsi-screening/app.ts](../services/rsi-screening/app.ts)) |
| `/swing-trading/*` | 003 サブアプリ ([services/swing-trading/app.ts](../services/swing-trading/app.ts)) |
| `/financial-math/*` | 004 サブアプリ ([services/financial-math/app.ts](../services/financial-math/app.ts)) |
| `/api/cron/sync-daily` | 統一 日次 cron ([src/cron/daily.ts](../src/cron/daily.ts)) — 全 active 銘柄を一括取得 (CLI / 無分割) |
| `/api/cron/sync-daily/{part}/{of}` | 日次 cron のシャード実行。母集団 ~4,000 が Vercel タイムアウトを超えるため vercel.json で 8 分割。`id % of = part` で銘柄を分配 |
| `/api/cron/sync-monthly` | 統一 月次 cron ([src/cron/monthly.ts](../src/cron/monthly.ts)) — 母集団同期 (全 JPX 内国株) + 優待 (is_yutai) 再スコア |
| `/api/*` (上記以外) | `vercel.json` で rewrite され、ルート Hono アプリへ |

トレーリングスラッシュの有無を吸収するため、ルートおよびサブアプリは `new Hono({ strict: false })` で生成している。

## DB 設計 — 単一 source of truth

銘柄マスタは **`core.stocks` に 1 本化** 済み (2026-04 の refactor で `public.stocks` を廃止)。`public.yutai_benefits` 等の FK は `core.stocks(id)` を指す。

```
Neon PostgreSQL
├── core スキーマ (日次/月次 sync が更新。全サービスが読み取り)
│   ├── stocks                         銘柄マスタ = 全 JPX 上場内国株 ~4,000 行 (is_yutai で優待銘柄を区別)
│   ├── stock_financials               最新ファンダ + 営業利益率 TTM
│   └── stock_annual_financials        年度売上高 (過去 4 年程度)
├── rsi スキーマ (001 固有)
│   └── stock_rsi_percentile           RSI(10/40/120) + percentile + 優良株フラグ
├── swing スキーマ (003 固有)
│   ├── daily_ohlcv                    日足 OHLCV (90 営業日。母集団 ~4,000 化で Neon 容量確保のため 120→90 に短縮)
│   ├── stock_indicators               SMA(5/20/25/60/75) + ATR14 + RSI14 + MACD + Fib
│   ├── stock_screening                5 条件フィルター結果
│   ├── entry_signals                  E&E 6 パターン signal
│   ├── market_context                 A/B/C/D マクロ判定 (日次)
│   └── sector_daily                   33 業種の騰落ランキング (日次)
├── public スキーマ (002 固有。銘柄マスタは core.stocks を参照)
│   ├── yutai_genres                   優待ジャンルマスタ (17 件)
│   ├── yutai_benefits                 優待情報 (7986 件)
│   ├── stock_financials               monthly sync で core + swing から合成 (is_yutai=true のみ)
│   └── stock_scores                   monthly sync の再スコア結果 (is_yutai=true のみ)
├── finmath スキーマ (004 固有。銘柄マスタは core.stocks を参照)
│   ├── price_snapshot                Yahoo 由来の最新価格スナップショット (自前ユニバース)
│   └── daily_ohlcv                   Yahoo 由来の日足 OHLCV キャッシュ
├── yuho_quant スキーマ (005 固有。銘柄マスタは core.stocks を参照)
│   ├── documents                     取り込んだ有報 1 通 = 1 行 (doc_id 一意 = 冪等キー)
│   └── order_facts                   受注高/受注残高 (有報×会計期末×セグメント粒度)
└── ir_catalog スキーマ (006 固有。銘柄マスタは core.stocks を参照)
    └── disclosures                   TDnet 適時開示 1 件 = 1 行 (タグ分類 + PDF センチメント)
```

**004 金融数学** は `finmath.price_snapshot` / `finmath.daily_ohlcv` で Yahoo 由来の価格・OHLCV をキャッシュしつつ、`core.stocks` / `core.stock_financials` / `core.stock_annual_financials` / `swing.daily_ohlcv` / `swing.stock_indicators` を読み取り専用で集計する。DCF/CAPM/EMH 等の集計計算は永続化せずオンデマンドでレスポンスに返す。

### 過去に存在したが削除されたテーブル

| テーブル | 削除時期 | 理由 |
|---|---|---|
| `core.stock_price_history` | 2026-04 | RSI 計算は in-memory で完結、DB 永続化不要 |
| `rsi.stock_rsi_history` | 2026-04 | 日次 RSI 時系列は UI 非使用、percentile だけ保存 |
| `public.stock_history` | 2026-04 | 月次 PER/PBR 推移は UI 非使用 |
| `public.stocks` | 2026-04 | core.stocks に一本化 (FK 付け替え済み) |

### `swing.stock_indicators.sma_25` の特殊性

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

## データ取得 — 日次 / 月次 (sync:universe は内包済み)

従来はサービス毎に sync コマンド (`sync:rsi`, `sync:otakara`, `sync:swing`, `sync:sectors`, `sync-light`) が分裂していた。2026-04 の refactor で `sync:daily` / `sync:monthly` の 2 本に統合。2026-05、004 financial-math (DCF/CAPM/EMH) が一般日本株ユニバースを要するため母集団を「otakara が seed する優待縛り ~1,600」から **全 JPX 上場内国株 ~4,000** へ拡張し、母集団 seed 用の `sync:universe` を追加した (3 コマンド体制)。2026-06、commit 5442c4b で `sync:universe` を `sync:daily` の Phase 0 と `sync:monthly` の Phase 1 に内包し、**定常運用の CLI は `sync:daily` / `sync:monthly` の 2 本** へ収束。`pnpm sync:universe` は明示 seed/復旧用 CLI として残置 (毎日叩かない)。優待は `core.stocks.is_yutai` フラグで保持し、002 otakara のみ is_yutai=true を母集団とする。

### `pnpm sync:universe` (日次 cron Phase 0 / 月次 cron Phase 1 に内包)

JPX 公式 `data_j.xls` の内国普通株 (プライム/スタンダード/グロース) を `core.stocks` に upsert。新規 insert + name/market/sector 更新 + raw JPX に無い code の inactivate (上場廃止)。`is_yutai` は触らない (otakara の優待スクレイパーが writer)。**日次 sync の Phase 0 に内包されたため毎営業日 core.stocks が最新化される** (shard 分割時は shard 0 のみが実行)。月次 cron でも同処理が走る。CLI の `pnpm sync:universe` は明示的な手動 seed/反映用として存続。

### `pnpm sync:daily` (平日 20:00–20:49 UTC、8 シャード cron)

1 銘柄につき Yahoo を **Chart(5y) 1 回 + QuoteSummary 1 回** だけ叩き、in-memory で全サービス分の指標を計算して DB に書き込む。

- Phase 0: JPX `data_j.xls` で `core.stocks` を全内国株へ同期 (= `seedUniverse`) — **シャード時は shard 0 のみ実行** (JPX 重複 DL / upsert 競合回避)。失敗時は別値で埋めず警告 + `universe=null` を残し既存 `core.stocks` で続行 (ルール2)
- Phase 1: `core.stocks` から active 銘柄を取得 (シャード時は `id % of = part` で分配)
- Phase 2: マクロ指数 (^N225 / ^VIX / ^GSPC / NIY=F) + 日経VI を並列取得 — **シャード時は shard 0 のみ実行** (Yahoo 重複呼び出し回避)
- Phase 3: worker pool (CONCURRENCY=5, DELAY_MS=200) で:
  - Yahoo `fetchStockRawData(code, "5y")` = Chart + QuoteSummary 並列
  - 5y OHLCV → RSI(10/40/120) 時系列 + percentile snapshot + 優良株判定
  - 6mo スライス → SMA(5/20/25/60/75) + ATR14 + RSI14 + MACD + Fib + volume/turnover + 前日比%
  - 5 条件 screening と E&E 6 パターン判定
  - `core.stock_financials` / `core.stock_annual_financials` / `rsi.stock_rsi_percentile` / `swing.{daily_ohlcv,stock_indicators,stock_screening,entry_signals}` を upsert
  - 404 の銘柄は `core.stocks.is_active=false` 予約
- Phase 5: 廃止銘柄の is_active 更新 (シャード毎)
- Phase 4: セクター集計 — **シャード時は最終 shard のみ**。`core.stocks ⋈ swing.stock_indicators` を DB から再読込し、本日更新分のカバレッジ 90% 未満なら誤集計を避けて保留 (前回値維持)・警告。`swing.sector_daily` 書き直し

母集団 ~4,000 を 1 invocation で回すと Vercel タイムアウト超過のため、vercel.json で 8 シャード (`/api/cron/sync-daily/{part}/8`、20:00–20:49 UTC (7分間隔×8)) に分割。**この構成は Vercel 有料プラン前提** (cron 9 本 = 日次 8 シャード + 月次 1; Hobby は cron 2 本で不可)。`functions.maxDuration` は現行プラン上限の **300 秒**（以前は 800 を指定していたが現行プランは最大 300 のためデプロイ不可。800 前提だったシャード設計は、各シャードが 300 秒で完了しない場合はシャード数を増やす等の再調整が必要）。

### `pnpm sync:monthly` (毎月 1 日 22:00 UTC cron)

**Yahoo を 1 回も叩かない**。JPX 公式 XLS と DB 内データだけで完結する。

- Phase 1: JPX `data_j.xls` から `core.stocks` を全内国株に同期 (= `seedUniverse`、sector も upsert に内包)
- Phase 2: `is_yutai=true` の優待銘柄のみ `core.stock_financials` + `swing.stock_indicators` + `public.yutai_benefits` を読んで `public.stock_financials` / `public.stock_scores` を再計算 (otakara public テーブルを ~1,600 に抑え Neon 容量を節約)

## 認証

cron エンドポイント (`/api/cron/sync-daily`, `/api/cron/sync-monthly`) は `Authorization: Bearer $CRON_SECRET` を要求する。Vercel Dashboard の Environment Variables に `CRON_SECRET` を設定しておくと Vercel が cron 実行時に自動でヘッダを付ける。検証ロジックは [src/shared/auth.ts](../src/shared/auth.ts) に集約 (以前はサービス毎に重複していた)。

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
pnpm dev                    # vercel dev (ローカル)
pnpm typecheck              # 全サービス型チェック
pnpm test                   # 全サービス vitest 実行
pnpm lint                   # eslint

# デプロイ
# git push origin main で Vercel auto-deploy が発火する
pnpm run deploy                 # (任意) vercel deploy --prod で手動デプロイ

# DB (サービス別 — schema 編集時のみ使う)
pnpm db:push:rsi            # core / rsi スキーマを Neon に push
pnpm db:push:otakara        # public スキーマを Neon に push
pnpm db:push:swing          # core / swing スキーマを Neon に push
pnpm db:studio:rsi / :otakara / :swing
pnpm db:push:finmath        # finmath スキーマ (price_snapshot / daily_ohlcv キャッシュ) を Neon に push

# データ同期 (定常運用は daily / monthly の 2 本)
pnpm sync:daily             # 全 active ~4,000 + マクロ + 全サービス指標・パターン・セクター (数十分)。Phase 0 で JPX 母集団同期を内包
pnpm sync:monthly           # 母集団同期 + 優待 (is_yutai) 再スコア (Yahoo なし)
pnpm sync:universe          # (通常不要・毎日叩かない) 明示 seed/復旧用 CLI。日次 cron Phase 0・月次 cron Phase 1 に内包済み
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
9. **Cron が必要ならサブアプリ内ではなく `src/cron/` の既存 daily/monthly に相乗りさせる**。単独のサービス cron は作らない (統一方針)
10. **JSX は使えない** — `.tsx` ファイルは Vercel `@vercel/node` が bundle しないため、ビューは template literal を返す `.ts` 関数として実装する
11. **POST フォームの optional フィールド**は `z.preprocess((v) => v === "" ? undefined : v, ...)` で空文字列を吸収する (HTML form の標準挙動でフォーム未入力は `""` 送信)。`z.coerce.number().optional()` 単独だと `""` が `0` に変換されるバグの温床になるので注意。
12. **POST body の取り扱い** — Vercel の Node ランタイムは `application/x-www-form-urlencoded` を事前パースして `req.body` に格納し、生ストリームを drain するケースがある。ルート [api/index.ts](../api/index.ts) はこれを検出して body を再シリアライズしてから `app.fetch(Request)` に橋渡ししている (`@hono/node-server/vercel` の `handle()` をそのまま使うと `c.req.parseBody()` が空ストリームから読み続けて hang する)。
