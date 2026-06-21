# 004 financial-math — 金融数学

教科書レベルの金融工学 (**DCF / CAPM / EMH アノマリー / Black-Scholes**) を
東証の実銘柄データと組み合わせて使えるようにする計算ツール群。

> kabulab mono-repo (`services/financial-math/`) として配置され、
> 単一の Cloudflare Worker (`kabulab-cf`) にマウントされて
> `https://kabulab-cf.satoki252595.workers.dev/financial-math/*` で公開される。

## コンセプト

- 銘柄コード (数字 4 桁 / `130A` 形式の英数字コード) を入れるだけで、
  Yahoo Finance 由来の実データ (株価・配当利回り・日足) を自動取得して
  理論値を計算する。
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
- **auto モードの市場 = `^N225` (日経平均)**。対象銘柄と ^N225 の OHLCV を
  finmath キャッシュ経由で取得し、**日付整合した単純リターン (前日比)** で
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
| `momentum` | モメンタム | window (20〜100 営業日、デフォルト 60) の累積リターン降順。リスク調整スコア = 累積リターン ÷ 年率ボラも併記。window 分のサンプルが無い銘柄は null (除外) |
| `small-cap` | 小型株効果 | 時価総額 < 閾値 (デフォルト 500 億円) を時価総額昇順 |
| `low-vol` | 低ボラ・アノマリー | `swing_stock_indicators.atr_pct` < 閾値 (デフォルト 1.5)。**atr_pct は % 値保存** (decimal ではない) |
| `post-earnings` | PEAD (決算後ドリフト) | **決算日が外部データなしに取れないため、`core_stock_financials.fetched_at` (更新時刻) を簡易代理** とする — 真の決算発表日ではない (コード内コメントで明示済の制限) |

- 母集団は `core_stocks` の **is_active 全銘柄 (全 JPX 内国株 ~4,000)**。
  時系列は `swing_daily_ohlcv` (003 所有、**約 100 営業日保持** — window 上限
  100 の根拠)、指標は `swing_stock_indicators`、時価総額等は
  `core_stock_financials` をいずれも読み取り専用で参照。
- クエリ: `window` 20〜100 / `limit` 10〜500 (デフォルト 50) /
  `smallCapMaxOku` / `lowVolMaxAtrPct` (Zod 検証、範囲外は 400)。

## DB スキーマ (`finmath_*`)

Cloudflare D1 (SQLite) は名前空間が無いため、旧 PG スキーマ `finmath` の
概念は廃止し、接頭辞テーブルとして単一 DB `kabulab-cf` に同居させる
(ADR-0001)。定義の正本は `src/db/finmath-schema.ts` (drizzle-orm sqlite-core)。

```
finmath_price_snapshot   最新価格スナップショット (code 一意 = UPSERT、1 銘柄 1 行)
  code / name(nullable) / price / per / pbr / dividend_yield / eps / bps
  roe / roa / market_cap / operating_margin_ttm
  data_date (Yahoo Chart の最新営業日) / fetched_at (キャッシュ TTL 判定)
finmath_daily_ohlcv      日足 OHLCV キャッシュ (symbol × date 一意)
  symbol (4桁/英数字コード or "^N225" 等の指数) / date
  open / high / low / close / volume / fetched_at
```

- `finmath_*` は **004 が所有・唯一の writer**。`core_stocks` (銘柄マスタ。
  otakara-yutai が writer) と `swing_*` (003 所有) は **読み取り専用** で
  再宣言して参照する (`src/db/core-schema.ts` / `swing-readonly.ts`)。
- finmath_* を自前で持つ理由: core_stocks のユニバースに縛られず、
  1414 のような優待なし銘柄も Yahoo 二次利用の遅延フェッチで扱うため。
- `finmath_daily_ohlcv` は **再生成可能な遅延キャッシュ**。欠損/TTL 切れ時は
  Worker エッジ (`c.env.DB` 経由で計算、取得は Yahoo 二次利用) で再取得して
  UPSERT し直せるため、恒久データではない。
- 実 DB 反映は `pnpm db:generate:d1` で `drizzle/d1/*.sql` を生成し、
  `wrangler d1 execute kabulab-cf --remote --file=drizzle/d1/<n>.sql` で適用する。
  ※ `drizzle.financial-math.config.ts` (pg dialect) / `pnpm db:push:finmath` /
  `db:generate:finmath` / `db:studio:finmath` は ADR-0001 で **obsolete**。
- DCF/CAPM/EMH/BS の **計算結果は永続化しない** (オンデマンド計算)。

## データ取得フロー (`src/services/price-cache.ts`)

1. `getPriceContext(db, code)` — `finmath_price_snapshot` の `fetched_at` が
   **TTL 24 時間** 以内ならキャッシュ返却。ミス時は Yahoo
   (Chart + QuoteSummary、取込バッチと同じ共有クライアント
   `src/shared/yahoo/client.ts` の二次利用) を 1 銘柄ぶん叩いて UPSERT。
   銘柄名は finmath_* に持たないため core_stocks にあれば補完 (なければ null)。
2. `getOhlcvSeries(db, symbol)` — 同一 symbol の `MAX(fetched_at)` で鮮度判定
   (TTL 24h)。ミス時は Yahoo Chart から **2 年分** (`DEFAULT_OHLCV_RANGE="2y"`)
   を取得し **300 行チャンク** で UPSERT。`finmath_daily_ohlcv` は再生成可能な
   遅延キャッシュなので、欠損時はこの経路でいつでも作り直せる。
   - 5y にしていた当初、全銘柄 ×1,250 行 ≈ 600 MB で **DB 容量を超過する事故**
     が発生 → 2y (~240 MB) に縮小。用途
     (β 推定 60-120 営業日 / ヒストリカル σ / 6-12 ヶ月モメンタム) には十分。
   - チャンク分割は SQL バインドパラメータ数の上限対策 (一括 insert で
     過去に 909/3,760 銘柄が失敗)。
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
| `/dcf?code=` | DCF フォーム。code 指定時は Yahoo 推定配当をプリフィル (無配 / 取得失敗時は **空欄のまま** — ダミー値を埋めない) |
| `/capm?code=` | CAPM フォーム。code 指定時は auto モードで β を OLS 推定 |
| `/black-scholes?code=` | BS フォーム。code 指定時は現在株価 (S, K=ATM) とヒストリカル σ を自動入力 |
| `/emh?type=&window=&limit=...` | EMH アノマリースクリーニング (4 種) |

### フォーム送信 (POST、`src/routes/api.ts` — 応答は JSON でなく HTML 再描画)

| パス | 内容 |
|---|---|
| `/api/dcf/calc` | Gordon / 2 段階 DCF。**code 指定 + Yahoo 推定配当ありの場合はフォームの配当値を破棄して銘柄データで計算** (古いフォーム値による無関係な結果を防ぐ意図的仕様。silent でなく notice で明示)。手動値で計算したい場合は code 欄を空にする |
| `/api/capm/calc` | mode=auto (β 自動推定) / manual (β 手動入力)。β のダミーデフォルト (1.0 等) は埋めない |
| `/api/black-scholes/calc` | spot 空→Yahoo 現値 / strike 空→ATM (=S) / σ 空→ヒストリカル σ で補完 (全て notice 明示)。marketPrice 指定時は IV を逆算 |

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
- 価格データの出典は Yahoo Finance (最大 24 時間のキャッシュ遅延あり)。
  投資判断は自己責任で。
