# 004 financial-math — 金融数学

教科書レベルの金融工学 (**DCF / CAPM / EMH アノマリー / Black-Scholes**) を
東証の実銘柄データと組み合わせて使えるようにする計算ツール群。

> kabulab mono-repo (`services/financial-math/`) として配置され、
> 単一の Cloudflare Worker (`kabulab-cf`) にマウントされて
> `https://kabulab-cf.satoki252595.workers.dev/financial-math/*` で公開される。

## コンセプト

- 銘柄コード (数字 4 桁 / `130A` 形式の英数字コード) を入れるだけで、
  日次 sync が D1 に書いた実データ (株価・配当利回り・日足) を読み取り専用で参照して
  理論値を計算する (Yahoo へは直接取りに行かない)。
- 計算ロジックは全て **純関数** (`src/services/*.ts`)。前提条件を満たさない
  入力は **throw**、データ不足は **null + 理由文字列** で正直に返す。
  「それっぽい近似値」での代替はしない (ルール1/2)。
- 理論値の単一表示を避け、DCF は **感応度マトリクスを必ず併記** して
  前提次第で値が大きく動くことを可視化する。

## 計算モジュール (`src/services/`)

### DCF — Gordon 成長モデル + 2 段階 DDM (`dcf.ts`)

- **Gordon モデル**: `理論株価 P = D1 / (k − g)` (D1=来期配当, k=要求リターン,
  g=配当成長率)。制約は **D1 > 0、k > 0、k > g** — 満たさなければ throw
  (k ≤ g は発散するため)。
- **感応度マトリクス**: k / g をそれぞれ ±2% (1% 刻み) 振った **5×5** の
  理論株価を必ず返す。セルが k ≤ g または k ≤ 0 になる組合せは `null`。
- **2 段階 DDM** (`calcTwoStageDcf`): 高成長期 (1〜30 年の整数) は
  `PV = D_t / (1+k)^t` を積み上げ、Year N 末に Gordon でターミナル
  バリュー `TV = D_{N+1} / (k − g_terminal)` を計算して割引。
  `k > g_terminal` 必須 (違反は throw)。各年配当/PV・TV・TV の PV を返す。
- **配当 CAGR** (`calcDividendCagr`): 配当履歴 (古い順) から
  `(D_last/D_first)^(1/(N−1)) − 1`。有効値 2 件未満は `null`。
  ※現状は純関数 + 単体テストのみで、ルートには未配線。
- **⚠️ FCF ベース DCF は未実装** — 実装されているのは **配当ベース**
  (Gordon / 2 段階 DDM) のみ。したがって **無配銘柄は理論株価を直接計算
  できない**。POST 時に code 指定 + Yahoo に配当データなし + 手動入力なしの
  場合は 400 で「想定配当を手動入力してください (会社 IR の予想配当 /
  FCF ベース DCF の併用を推奨)」と誘導する (値を捏造しない)。

### CAPM — β 自動推定 + 期待リターン (`capm.ts`)

- `E[R] = R_f + β × (R_m − R_f)`。入力レンジ検証あり
  (R_f: −5%〜+20% / R_m: −50%〜+50% / β: −5〜+5、逸脱は throw)。
- **β 推定** (`estimateBetaOLS`): 日次リターンの OLS 回帰
  `r_i = α + β r_m + ε`。**有効ペアのサンプル数 < 30、または市場リターンの
  分散が 0 の場合は null** (計算不能を正直に返す)。戻り値は β / 年率換算 α
  (×252) / R² / サンプル数 / 銘柄・市場の年率ボラ / 相関係数。
- **auto モードの市場 = `^N225` (日経平均)**。対象銘柄の日足は
  `swing_daily_ohlcv`、^N225 は `swing_market_context.nikkei_close` から読み
  (旧 finmath キャッシュは PR #23 で廃止)、**日付整合した単純リターン (前日比)** で
  OLS する (`routes/pages.ts` の `estimateBetaForCode`)。各系列 31 日未満 /
  日付整合後 30 サンプル未満 / 分散 0 は推定せず、理由を
  `betaUnavailableReason` として UI に表示する。
  ※旧実装は swing_daily_ohlcv 全銘柄の等加重平均を市場としていたが、
  優待縛り ~1,600 銘柄に限定され未登録銘柄で失敗したため ^N225 に変更済。
- `calcLogReturns` (ログリターン化ヘルパ) も提供 (NaN/Infinity/非正値は除外)。

### Black-Scholes — 価格 + Greeks + IV (`black-scholes.ts`)

- **ヨーロピアン・無配当 (q=0) 限定**。配当落ち補正 (S → S·e^(−qT)) は
  コード上のコメントで言及されているのみで未実装。
- コール `C = S·N(d1) − K·e^(−rT)·N(d2)` / プット
  `P = K·e^(−rT)·N(−d2) − S·N(−d1)` を一括計算し、**プット・コール・
  パリティ残差** (`C − P − (S − K·e^(−rT))`、理論 0) を検算として返す。
- **Greeks (コール/プット両方)**: Δ / Γ / ν (ボラ **1%** 変化あたり) /
  Θ (**1 日** 経過あたり、年率を 365 で割る) / ρ (金利 **1%** 変化あたり)。
- 入力検証: S > 0、K > 0、0 < T ≤ 5 年、R_f は −5%〜+20%、0 < σ ≤ 500%
  (違反は throw)。
- 正規分布 CDF は誤差関数の有理式近似 (Abramowitz & Stegun 7.1.26、
  誤差 ≤ 7.5e-8)。
- **Implied Volatility** (`calcImpliedVolatility`): BS 価格が σ に単調なことを
  利用した **二分法** (σ ∈ [0.001, 5.0]、許容誤差 1e-5、最大 100 反復)。
  市場価格が範囲内の BS 理論値で到達不能なら **null** を返し、UI は
  「市場価格が BS 理論値の範囲外」と表示する。
- **σ の初期値はヒストリカルボラ** (`volatility.ts`) を自動補完
  (補完は notice で明示)。

### ヒストリカル・ボラティリティ (`volatility.ts`)

- 日次 **ログリターンの標本標準偏差 (n−1) × √252** を年率ボラとする。
- 有効ログリターンが **20 未満は null** (NULL/非正値/Infinity は除外)。
- 戻り値: 年率ボラ / 日次標準偏差 / 使用サンプル数。

### EMH アノマリー (`emh.ts` + `/emh` ルート)

Notion「金融数学入門」で紹介された **4 つのアノマリー** をスクリーニング:

| type | 内容 | 実装 |
|---|---|---|
| `momentum` | モメンタム | L2 投影 `p_momentum.closes` (日次 sync が書く終値配列) から window (20〜100 営業日、デフォルト 60) の累積リターン降順。リスク調整スコア = 累積リターン ÷ 年率ボラも併記。window 分のサンプルが無い銘柄は null (除外) |
| `small-cap` | 小型株効果 | 時価総額 < 閾値 (デフォルト 500 億円) を時価総額昇順 |
| `low-vol` | 低ボラ・アノマリー | `swing_stock_indicators.atr_pct` < 閾値 (デフォルト 1.5)。**atr_pct は % 値保存** (decimal ではない) |
| `post-earnings` | PEAD (決算後ドリフト) | **決算日が外部データなしに取れないため、`core_stock_financials.fetched_at` (更新時刻) を簡易代理** とする — 真の決算発表日ではない (コード内コメントで明示済の制限) |

- 母集団は `core_stocks` の **is_active 全銘柄（東証内国普通株・共有4文字コード、約3,700）**。
  モメンタムの時系列は L2 投影 `p_momentum.closes`、指標は `swing_stock_indicators`、
  時価総額等は `core_stock_financials` をいずれも読み取り専用で参照。
  `swing_daily_ohlcv` の保持は **90 営業日** (window 上限 100 との差に注意。
  条文上 91〜100 を指定できるが終値が足りず null 除外されうる)。
- クエリ: `window` 20〜100 / `limit` 10〜500 (デフォルト 50) /
  `smallCapMaxOku` / `lowVolMaxAtrPct` (Zod 検証、範囲外は 400)。

## DB スキーマ

004 は**所有する表を持たない**。価格断面・日足・市場系列はすべて他サービスが
書いた表を読み取り専用で参照する (`src/shared/db/core-schema.ts` /
`src/db/swing-readonly.ts` / `src/shared/db/projection-schema.ts` /
L2 投影 `p_momentum`)。

| 用途 | 読む表 |
|---|---|
| 価格・配当利回り・時価総額 | `core_stock_financials` (日次 sync が書く断面) |
| 個別銘柄の日足 | `swing_daily_ohlcv` (保持 90 営業日) |
| 市場系列 (^N225) | `swing_market_context.nikkei_close` |

旧 `finmath_price_snapshot` / `finmath_daily_ohlcv` は「SSR の GET 中に Yahoo を
叩いて D1 に書く」遅延キャッシュだった。PR #23 で読み取り面を上の表へ振り替え、
読み書きが無くなったので宣言を消して `drizzle/d1/0012` で DROP する
(本番適用は `sqlite_master` で確認すること)。
DROP 前の全行 (3,759 行 / 3,490 行) は `~/kabulab-cf-backup-20260913/d1-finmath/`
に JSONL で退避してあり、同ディレクトリの README.md に復元手順がある。

- DCF/CAPM/EMH/BS の **計算結果は永続化しない** (オンデマンド計算)。
- 読み取り面は D1 へ書かない (`src/tests/integration/price-read-path.test.ts`)。

## データ取得フロー (`src/services/price-cache.ts` — 名前は残るが現行は読み取り専用アクセス層)

1. `getPriceContext(db, code)` — `core_stock_financials` の断面を読む。
   断面が無い銘柄は 0 や null で埋めずに throw し、画面に理由を出す。
2. `getOhlcvSeries(db, symbol)` — 個別銘柄は `swing_daily_ohlcv`、`^N225` は
   `swing_market_context` を読む。それ以外の指数は黙って空にせず落とす。
3. シンボル検証: 銘柄コードは共有ヘルパ `src/shared/jpx/stock-code.ts` の
   正準パターン (数字 4 桁 / 数字 3 桁 + 英字 1 文字)、指数は `^XXX` 形式。
   不一致は throw。
4. **% 値 → decimal 正規化**: Yahoo / DB の `dividend_yield` は % 値 (3.43)
   保存。`PriceContext.dividendYield` では `/100` して decimal (0.0343) に
   正規化し、`estimatedDividend = price × dividendYield` で来期配当を推定する。

## ルート

マウント: ルート Hono アプリに `BASE_PATH = "/financial-math"` で
`new Hono({ strict: false })` をマウント。

### SSR ページ (GET、`src/routes/pages.ts`)

| パス | 内容 |
|---|---|
| `/` | 4 ツールのハブ (初心者向けバルーンヘルプ付き) |
| `/dcf?code=` | DCF フォーム。code 指定時は D1 断面の推定配当をプリフィル (無配 / 取得失敗時は **空欄のまま** — ダミー値を埋めない) |
| `/capm?code=` | CAPM フォーム。code 指定時は auto モードで β を OLS 推定 |
| `/black-scholes?code=` | BS フォーム。code 指定時は D1 断面の現在株価 (S, K=ATM) とヒストリカル σ を自動入力 |
| `/emh?type=&window=&limit=...` | EMH アノマリースクリーニング (4 種) |

### フォーム送信 (POST、`src/routes/api.ts` — 応答は JSON でなく HTML 再描画)

| パス | 内容 |
|---|---|
| `/api/dcf/calc` | Gordon / 2 段階 DCF。**code 指定 + 断面に推定配当ありの場合はフォームの配当値を破棄して銘柄データで計算** (古いフォーム値による無関係な結果を防ぐ意図的仕様。silent でなく notice で明示)。手動値で計算したい場合は code 欄を空にする |
| `/api/capm/calc` | mode=auto (β 自動推定) / manual (β 手動入力)。β のダミーデフォルト (1.0 等) は埋めない |
| `/api/black-scholes/calc` | spot 空→断面の現値 / strike 空→ATM (=S) / σ 空→ヒストリカル σ で補完 (全て notice 明示)。marketPrice 指定時は IV を逆算 |

JSON API は提供していない (005/006 と異なり全応答が SSR HTML)。

## 注意・免責

- **DCF は配当ベースのみ (FCF ベース未実装)** — 無配銘柄・低配当銘柄の
  本源的価値評価には不向き。理論株価は k / g の前提に強く依存するため、
  感応度マトリクスを必ず確認すること。
- **BS は無配当ヨーロピアン限定** — 配当利回りの高い銘柄や
  アメリカンタイプの評価には補正が必要。
- **PEAD は真の決算日ではなく `fetched_at` の簡易代理** — 厳密な
  決算後ドリフト分析には使えない。
- β・ヒストリカルボラは過去データに基づく推定値であり将来を保証しない。
- 価格データの出典は Yahoo Finance (日次 sync が D1 へ書いた断面を読む。鮮度は
  日次 sync の最終成功時刻に依存する)。投資判断は自己責任で。
