# 001 RSI Screening — kabulab

過去 5 年間で RSI（10/40/120 営業日）が最も低水準にある優良株を発見するスクリーニングサービス。

> kabulab mono-repo (`services/rsi-screening/`) として配置され、`https://kabulab-cf.satoki252595.workers.dev/rsi-screening/*` で公開される (Cloudflare Workers にデプロイ)。

## コンセプト

- RSI の **パーセンタイル順位** で「今が 5 年間で何%の底値水準か」を定量化
- 3 期間 (短期 10 日 / 中期 40 日 / 長期 120 日) の RSI を同時に評価
- 優良株フィルタ: 売上高増加（過去 3 年）AND 営業利益率 TTM ≥ 5% を満たす銘柄のみ

## ディレクトリ構成

```
services/rsi-screening/
├── app.ts                     # Hono サブアプリ公開エントリ (export default app)
├── base-path.ts               # export const BASE_PATH = "/rsi-screening"
├── src/
│   ├── index.ts               # Hono アプリ本体 (API + SSR 配線、onError)
│   ├── db/
│   │   ├── client.ts          # createDb(c.env.DB) — D1 + Drizzle (drizzle-orm/d1)
│   │   ├── core-schema.ts     # core_* (共有テーブル)
│   │   └── schema.ts          # rsi_percentile (固有テーブル)
│   ├── routes/
│   │   ├── screening.ts       # GET /api/screening
│   │   ├── stocks.ts          # GET /api/stocks/:code
│   │   └── pages.ts           # SSR: /, /screening, /stocks/:code
│   ├── services/
│   │   ├── screening-service.ts     # スクリーニングクエリ (UI)
│   │   └── stock-detail-service.ts  # 個別銘柄クエリ (UI)
│   ├── views/                 # template literal を返す .ts 関数 (layout/home/screening/stock-detail)
│   ├── validators/            # Zod スキーマ
│   ├── middleware/            # error-handler
│   └── tests/unit/            # ユニットテスト (shared/indicators 配下を参照)
├── drizzle/                   # drizzle-kit 生成の migration
├── CLAUDE.md
└── README.md
```

**過去から変わった点**: 2026-04 の sync 統一化で本サービス固有の `yahoo-finance.ts` / `sync-service.ts` / `rsi-calculator.ts` / `percentile-engine.ts` / `blue-chip-filter.ts` / `scripts/sync-daily.ts` / `scripts/seed-stocks.ts` / `validators/yahoo-finance.ts` は **削除**。計算ロジックは `src/shared/indicators/` (root 直下) に移動し、日次 sync は `scripts/sync/daily.ts` の全サービス共通オーケストレータを Node (GitHub Actions) から実行する。

ルート Hono アプリ (`src/index.ts`) は次のようにマウントする:

```ts
import { rsiScreeningApp, BASE_PATH as RSI_BASE_PATH } from "../services/rsi-screening/app.js";
app.route(RSI_BASE_PATH, rsiScreeningApp);
```

**Cron は本サービス内には無い**。日次同期は **GitHub Actions** (`.github/workflows/stock-sync.yml`) が Node から D1 REST 経由で全サービス分を一括実行し、本サービスのテーブルも更新される (Workers Cron / Workers Paid は不使用)。母集団は 2026-05 に「優待縛り ~1,600」から **東証プライム／スタンダード／グロースの内国株式（共有4文字コード、約3,700）** へ拡張済み。本サービスは全 active 銘柄を対象とする (is_yutai は 002 専用フラグで RSI 判定には無関係)。

## DB スキーマ

### core_* (共有 — 日次 sync が更新)

D1(SQLite) 版の型表記 (ADR-0001): `serial`→`integer PK autoincrement`、`boolean`→`integer(mode:boolean)`、`date`→`text('YYYY-MM-DD')`、`timestamptz`→`integer(mode:timestamp)`。

```
core_stocks
├── id          integer PK (autoincrement)
├── code        text UNIQUE          # 4 桁銘柄コード
├── name        text
├── market      text
├── sector      text?                # 月次 sync で JPX 33 業種を backfill
├── is_active   integer(boolean)     # Yahoo 404 時に false に更新
├── is_yutai    integer(boolean)     # 002 専用の母集団フラグ
└── created_at / updated_at

core_stock_financials
├── id                 integer PK (autoincrement)
├── stock_id           FK → core_stocks (CASCADE, UNIQUE)
├── price / per / pbr / dividend_yield      real?
├── eps / bps / roe / roa / market_cap      real?
├── operating_margin   real?          # TTM (financialData.operatingMargins の生値)
├── data_date          text           # 'YYYY-MM-DD'
└── fetched_at         integer(timestamp)

core_stock_annual_financials
├── id           integer PK (autoincrement)
├── stock_id     FK → core_stocks (CASCADE)
├── fiscal_year  integer              # UNIQUE(stock_id, fiscal_year) / 暦年丸め・銘柄間で意味が違う
└── revenue      real?                # 連結と単体が混在している (下記)
```

> **`core_stock_annual_financials` の既知の欠陥 (どちらも列では直していない)**
>
> 1. **`revenue` は連結と単体が混在する。** Yahoo `quoteSummary` の
>    `incomeStatementHistory[].totalRevenue` の生値で、Yahoo は期ごとに
>    連結 (売上収益) と親会社単体の売上高を混ぜて返す。持株会社では単体が連結の
>    2〜10% しかないため、同一銘柄の系列内に 10〜40 倍の段差が生まれる。
>    例: 7203 トヨタは FY2024 17.58 兆 / FY2025 18.28 兆 (単体水準) → FY2026 50.68 兆 (連結)。
>    実際の連結は 45.1 / 48.0 / 50.7 兆。
> 2. **`fiscal_year` は銘柄間で意味が違う。** 期末日を `getUTCFullYear()` で暦年に
>    丸めているだけなので、3 月期企業の `fiscal_year=2025` は和暦 2024 年度
>    (2024-04〜2025-03)、12 月期企業の `2025` は 2025 年度を指す。
>    **銘柄をまたいで同じ `fiscal_year` を横並び比較してはいけない** (同一銘柄内の
>    時系列としてのみ有効)。決算期変更で暦年が衝突すると年が 1 つ欠ける
>    (実測 18 銘柄 / 43 年分)。
>
> 列 (連結/単体フラグ・期末日) を足して直さない理由: この表は「現状維持のまま、
> 既存消費者を新しい正本へ向け終えたら DROP する」方針なので、寿命の短い表に
> スキーマ変更を積まない。利用側で降りる ([優良株判定ロジック](#優良株判定ロジック))。

> 過去には `core_stock_price_history` (5 年分の OHLCV) も持っていたが、
> RSI 計算がメモリ上で完結し DB を読み返さないため 2026-04 に削除した。
> Yahoo の `incomeStatementHistory.operatingIncome` も 2025 年頃に空オブジェクトを返すように
> なったため、年度別の営業利益は `core_stock_annual_financials` に保持していない。

### rsi_percentile (001 固有)

```
rsi_percentile
├── id                       integer PK (autoincrement)
├── stock_id                 FK → core_stocks (CASCADE, UNIQUE)
├── rsi_10 / rsi_10_percentile          real?
├── rsi_40 / rsi_40_percentile          real?
├── rsi_120 / rsi_120_percentile        real?
├── rsi_min_percentile       real?      # 3 期間の最小パーセンタイル
├── is_blue_chip             integer(boolean)   # 優良株フラグ
├── operating_margin_ttm     real?      # 営業利益率 TTM
├── revenue_trend            integer?   # +1=上昇 / 0=横ばい / -1=下降 / NULL=判定不能
└── computed_at              integer(timestamp)
```

> 過去には `rsi_stock_rsi_history` (5 年分の日次 RSI 時系列) も持っていたが、
> パーセンタイル算出がメモリ上で完結するため 2026-04 に削除した。

## スクリーニング API

```
GET /api/screening
  ?period=min          # "10" | "40" | "120" | "min"
  &percentileMax=10    # パーセンタイル上限 (0-100)
  &blueChip=true       # 優良株のみ
  &sort=percentile     # "percentile" | "rsi" | "marketCap"
  &limit=50&offset=0
```

## データ更新フロー

本サービスは独自の sync を持たない。**統一日次 sync** ([scripts/sync/daily.ts](../scripts/sync/daily.ts)) を Node (GitHub Actions) から実行し、1 銘柄あたり Yahoo Chart(5y) + QuoteSummary を 1 回ずつ叩いて、以下を in-memory で計算し D1 REST 経由で書き込む (Yahoo 取得は Worker エッジ `/api/ingest/yahoo` = `YAHOO_PROXY_BASE` 経由で 429 を回避):

1. `calculateAllRsiSeries(closes)` ([src/shared/indicators/rsi.ts](../src/shared/indicators/rsi.ts)) で RSI(10/40/120) 時系列
2. `computeRsiPercentileSnapshot` ([src/shared/indicators/percentile.ts](../src/shared/indicators/percentile.ts)) で最新値のパーセンタイル順位
3. `evaluateBlueChip` ([src/shared/indicators/blue-chip.ts](../src/shared/indicators/blue-chip.ts)) で優良株判定
4. `core_stock_annual_financials` / `core_stock_financials` / `rsi_percentile` へ upsert

起動:

```bash
pnpm sync:daily:core # core/rsi/swing 単体の手動実行
```

自動実行: GitHub Actions (`.github/workflows/stock-sync.yml`) が日次で `pnpm sync:daily:core` を実行し、全 active を一括処理する (Workers Cron / Workers Paid は不使用)。`pnpm sync:daily` はこれに VWAP 3 工程を加えたローカル手動フル実行。

## 優良株判定ロジック

[src/shared/indicators/blue-chip.ts](../src/shared/indicators/blue-chip.ts) の実装:

- `judgeTrend(values)`: 全期間変化率 > +5% かつ 各年 YoY 下落が -5% 以下 → 上昇トレンド (+1)
- `hasDefinitionBreak(values)`: 判定窓に隣接年比 > 2 倍 / < 0.5 倍 の段差があれば真
- `evaluateBlueChip`: 売上高トレンド=上昇 AND 営業利益率 TTM ≥ 5% → `isBlueChip: true`
- 売上高の判定には 3 年分のデータが必要（不足時は `isBlueChip: false`）

### `revenue_trend` が NULL のとき何を意味するか

`revenue_trend` の NULL は「売上が伸びていない」ではなく **「売上トレンドを判定できない」**。
次の 2 通りがある。

1. 年次売上が 3 期分揃っていない
2. **判定窓の中に隣接年比 2 倍超 (または半減) の段差がある** — `revenue` に
   連結と単体が混在しているため、成長率が計算上の産物になっている

2 を素通りさせると、単体 → 連結の段差はトレンド条件 (全期間 +5% 超・YoY -5% 超の下落なし)
を必ず通る。7203 トヨタは直近 3 年が [17.58 兆, 18.28 兆, 50.68 兆] で **+188%** と
算出されるが、実際の連結ベースは +12.4%。トレンドの大きさが完全な捏造だった。

「トレンドが悪い」ではないので 0 ではなく NULL に倒す。UI は
一覧で `?`、詳細ページで「判定不能」と表示する (`—` = データ無しとは区別する)。

詳細ページの年度売上テーブルは**生値をそのまま表示したまま**、系列に段差があれば
注記 (`ANNUAL_BREAK_NOTE`) を添える。ラベルを「判定不能」に直しても
17.58 兆 → 18.28 兆 → 50.68 兆 を無注記で並べれば読者は +188% を読み取るため。
注記は判定窓 (直近 3 期) ではなく**表示している全期間**で判定するので、
段差が窓の外にある銘柄 (`revenue_trend` は +1 のまま正当) にも出る
— ガードの「窓の外は素通りする」限界を表示面だけ埋めている。

**これは止血であり是正ではない。** このガードが検出できるのは「定義が切り替わった
**瞬間**」だけで、判定窓 3 期がすべて単体 (あるいはすべて連結) に揃っている系列は
段差を持たないので**素通りする**。層別実測では銘柄名に「ホールディングス/ＨＤ」を
含む 464 銘柄中 296 (63.8%) が自系列内に 10 倍超のスパンを持つ (それ以外は
3,285 銘柄中 185 = 5.6%。**11.4 倍の濃縮**)。つまり窓が単体側に揃って
「単体の売上で優良株判定される」銘柄は必ず残る。この限界は
`blue-chip-filter.test.ts` にテストとして固定してある。

影響: 優良株は **1,355 → 最大 1,116 程度 (239 減、-17.6%)**。
`screening-service.ts` / `pages.ts` が `eq(isBlueChip, true)` で絞るため、
トップ画面の掲載数が目に見えて減る。

### 残課題: `core_stock_annual_financials` 既存 15,963 行の再構築

汚染は**古い行に濃い**。自系列最大値に対する低位外れ値の割合:

| fiscal_year | 2022 | 2023 | 2024 | 2025 | 2026 |
| --- | --- | --- | --- | --- | --- |
| 低位外れ値の割合 | 20.6% | 16.9% | 15.0% | 7.7% | 4.6% |

これは「Yahoo の 4 期ウィンドウから外れた行が凍結され、DELETE も再照合もされない」
という書き込み側の欠陥が実害として出ている証拠 (古い行は単体売上のまま置き去られる)。

上記のガードは判定を止めるだけで、**汚染行そのものは残る**。消すには既存 15,963 行の
再構築が必要だが、それには「連結売上をどこから取るか」の供給源決定が要る
(EDINET / TDnet の XBRL、決算短信サマリ等)。**供給源の選択はユーザ判断**なので
本ドキュメントに残すだけにしてある。
