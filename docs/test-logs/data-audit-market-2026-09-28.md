# 市場系実データ監査 (2026-09-28) — 担当B

Issue [#146](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/146) の担当B分担
(株価・信用/空売り・VWAP・RSI・Swing・金融数学・派生指標・公開面/consumer)。
財務・銘柄マスタ・EDINET/TDnet/優待の値照合はA担当、moneyflow はC担当。

## 0. 監査条件

- branch: `audit/market-2026-09-28` (基点 `origin/main` = `18d5939` #145)。
  開始時点で origin/main の先端が #145 のままだったため、#145 以降の変動は 0 件。
- 観測窓: 2026-09-28 17:00–19:30 JST。D1/R2/公開面の読取は同日 17:13 UTC
  (stock-sync) および 08:00 UTC (vwap-ingest daily-intra) の当日 run の反映前。
  R2 の最終更新は 9/25、D1 市場系の最終更新は 9/26 10:55 UTC (9/25 取引分)。
- 最新確定営業日: **2026-09-25 (金)**。9/21–9/23 は休場
  (敬老の日・国民の休日・秋分の日)、9/26–9/27 は週末。
- 境界: D1/R2 は SELECT / List / Get のみ (rows_written=0 を毎回確認)。
  取込・ranking・master apply・新 DB/endpoint の起動なし。新規 install なし。
  Yahoo/JPX 公開一次資料は既存 ingest-proxy の純粋中継または素の GET で
  観測のみ (取込経路は起動せず、観測物は `/tmp` に留め commit しない)。
  Notion は未読 (A/C との合計レート配慮。archive 状態は既存証跡 + gh のみで判定)。
- JPX 新様式・信用残日次化は 9/29 延期のまま (触らない)。
- 数値の表記: 金額・件数は監査証跡としての集計値と少量標本のみ。本文書に
  秘密値・署名 URL・全生データ・原本全文は含まない。

## 1. 母集団・鮮度 (D1/R2 全体像)

| 対象 | 件数 | 最新 | 備考 |
|---|---|---|---|
| `core_stocks` active+equity / 全体 | 3,700 / 3,810 | — | 非 active 110 (delist 等) |
| `swing_daily_ohlcv` | 361,284 行 / 3,756 銘柄 | 2026-09-25 | 9/25: 3,698 行 |
| `swing_stock_indicators` | 3,756 行 | 9/25 が 3,698 行 | 56 行が stale (delist 凍結) |
| `rsi_percentile` | 3,756 行 | computed 9/26 10:55 UTC | 同上 |
| `p_momentum` | 3,700 行 | as_of 9/25 | active と完全一致 (sweep 正常) |
| `core_stock_financials` | 3,756 行 | data 9/25 | 同上 |
| `swing_market_context` | 最新 9/26 (B) | run 日付キー | §3-6 |
| `swing_sector_daily` | 最新 9/26 (33 業種) | run 日付キー | §3-6 |
| `swing_entry_signals` | 303 行 (7 pattern) | sweep 済み | gap_follow 0 |
| R2 `daily/` / `intra/` / `margin/` | 4,444 / 4,272 / 13 週 | 9/25 / 9/25 / 9/18 週 | 7/03・7/10 週欠落 |

## 2. 全件構造検査 (直近 20 営業日 + 保持域)

母集団: `swing_daily_ohlcv` の 2026-08-26〜09-25 (20 営業日、74,072 行) を全行集計。
日付 JST・OHLC 大小・volume・重複・休日・gap・split/adjusted 混在を検査。

| # | 検査 | 結果 |
|---|---|---|
| S-01 | 日付=JST 取引日 | PASS。週末行 0 件。休場 (8/11, 9/21–23) の欠落は正常。Yahoo 日足 ts は 00:00 UTC (=09:00 JST) のため UTC 変換と JST 変換は一致 (20/20 標本で utc!=jst が 0 件)。最新 2 日の不足 (9/25: 2 銘柄、9/24: 1 銘柄) は Yahoo 一時欠損の取込漏れ |
| S-02 | 重複 (stock_id, date) | PASS。0 件 (unique index と一致) |
| S-03 | high < low | PASS。0 件 |
| S-04 | close ≤ 0 / 非正 | PASS。0 件 |
| S-05 | close が [low, high] 外 | 18 行、最大乖離 1.695%。Yahoo 丸めの既知現象 (bar-sanity.ts の実測と同規模)。8/27・9/01 に集中。誤りではない |
| S-06 | volume 負 | PASS。0 件。volume=0 は 479 行 (薄商い・整理銘柄の実態) |
| S-07 | close NULL | **13 日に大量凍結 NULL** (F-04)。8/03: 3,705、8/04: 3,704、8/13: 3,701、8/31: 3,694、8/25: 3,676、8/24: 2,679、8/19: 1,319、8/18: 1,295 他。6–7 月は 1–17 件/日のみで正常 |
| S-08 | adj NULL | 165,652/361,284 行 (45.8%) が NULL。0008 適用 (~7/28) 前の書込行に欠落、以降の backfill 行には存在するまだら。**読者は jss-api private のみで `adjusted` フラグ付き factor=1 として処理** (テストで固定)。誤りではない |
| S-09 | split/adjusted 混在 | 混在なし。Yahoo は OHLC を分割遡及調整済みで返すため adj/c は配当分のみ (9984 で f=0.94–1.0 の滑らかな勾配を確認)。RSI/指標の `adj ?? close` は正しい |
| S-10 | 保持本数 (90 本) | **F-05。3,689 銘柄が 90 行超過** (最大 120、平均 96)。月曜限定 prune が深夜跨ぎで skip され飢餓。新日程 (17:13 UTC 完了は月曜内) で自己修復見込み |
| S-11 | gap (銘柄別欠日) | 1909 の 9/11 欠落は sanitize 棄却の正当な穴 (F-01 関連)。delist 凍結銘柄を除き連続 |

### 2.1 マクロ・セクター表の日付キー (run 日付) と休日行

- `swing_market_context`・`swing_sector_daily` の date は **UTC run 日**
  (コード確認)。取引日ではない。9/26 (土) 行は 9/25 取引分の再掲。
- **F-06 [低] sector 9/22・9/23 行は 9/18 集計の bit 完全一致 duplicate**
  (旧 full-run が休日に guard なしで再集計。#127 は 9/28 merge のため当時は
  無 guard)。読者は最新日 (9/26) のみ参照のため無害。9/24・9/25 行の不在は
  深夜跨ぎ coverage skip (仕様どおりの見送り)。
- market 系列の休日・週末行 (9/21–9/23・9/26 等) は前値据置。CAPM の日付整合で
  自然に脱落し、8035 の相関 0.79 が示すとおり β 推定は正常に機能する。

## 3. 層別 20 銘柄の原本照合 + 独立再計算

### 3.1 標本 (選定理由つき)

| 区分 | コード |
|---|---|
| 流動性大型+分割履歴 | 7203, 9984, 6758, 9432, 8306, 8035 |
| 低流動 | 3600 (20 日売買代金 23.6 万円), 5969 |
| 廃止/重複/凍結 | 3681 (inactive), 7129, 8154, 3546 (2 行), 3924 (5/15 凍結), 2686 (6/26 凍結) |
| 事故・欠損・IPO | 1909 (Yahoo 破損), 9914 (14 行), 4171 (9/11 凍結), 2934 (9/25 NULL), 137A (英字), 581A (IPO 69 行) |

原本: Yahoo Chart 5y を 9/28 17:54–17:56 JST (ファイル mtime 証跡。
当初 status の「18:05 JST」記載は 10 分の過大で訂正) に中継経由で観測
(404: 3681/3546/3924/2686 = delist と整合。9914/4171 は 1-bar stub)。
基準日 9/25 で打切り照合。
計算は repo コードを import せず仕様から再実装 (Wilder RSI・percentile・SMA/ATR/
RSI14/MACD/Fib・screening・全 7 pattern・momentum 行)。

### 3.2 照合結果

- **日足 join (D1 vs 原本)**: 一致が大勢。差分は (a) 5 月 adj NULL (S-08)、
  (b) Yahoo 遡及訂正の凍結 (8/07・8/27・8/28・9/01。R2 daily と fresh が一致し
  D1 のみ旧値。例: 7203 8/07 close D1=3013/R2=fresh=2980)、
  (c) volume ±4 の丸め塵、(d) 1909 の破損域。いずれも F-01/F-04 の範囲内。
- **RSI10/40/120・percentile・sampleBars**: 16/16 の active 標本で許容内一致
  (RSI |Δ|≤0.05、percentile |Δ|≤1.0pt。実測はほぼ 0)。
  sampleBars の 1222 vs 1221 差は 5y sliding window の 1 本ずれ (9/28 追加・
  2021-09-27 脱落) で無害。137A (629)・581A (69)・9914 (1) は完全一致。
- **swing 指標 30 field + screening 6 bool**: float 全一致。ただし
  **volatility_ok が 9432/3600/5969/7129 で不一致** → F-02。
- **p_momentum (as_of/bars/closes 全文一致)**: 15/15 一致 (非 active 5 件は
  sweep で不在が正)。
- **entry pattern**: 全標本一致 (9984 の gap_fade 等を含む)。

### 3.3 個別状態

- **F-01 [中] 1909**: Yahoo 原本が破損 (全 47 bar。7/17–9/14 は close≈1.62e10・
  volume 0、9/15–9/28 は全 null、偽 split 1:4400000)。9/26 run が取込済みで
  D1 の sma_5=16278437478.4・sampleBars=40・momentum bars=40 (as_of 9/14) が
  破損値。公開詳細ページに `SMA5 16,278,437,478` と表示中 (実測)。
  sanitizeBars は 10 倍 jump のみ棄却し持続的異常レベルは素通りする。
  sector 汚染はなし (pct≈0)。meta 価格 3700 と financials 断面は正常。
  **保存 gate の通過証明 (read-only trace)**: 現行の唯一の日付 gate は
  `src/cron/daily.ts:1079` (`ohlcv6mo.at(-1)?.date !== expectedDate` で throw)。
  1909 の末尾 bar は 9/28 の fresh null bar のため expectedDate=9/28 と一致し
  **通過する**。null-latest の拒否は存在せず、RSI (null 除外後に 40 本で計算)・
  指標 (compact 後の異常値で計算)・momentum (tail 40 本) のいずれも保存成功する。
  実証: 9/26 run がまさにこの経路で保存済み (sampleBars=40 が現 D1 に存在)。
  9914 との差: 9914 の末尾は 9/18 の stale bar のため同 gate で fail-safe 失敗する。
  最小再現は §10-1。データ修復 writer は起動していない。
- **F-02 [中] volatility_ok の stale**: #135 (閾値 0.02→2) の merge
  (9/28 15:27 JST) が最終データ run (9/26) より後のため、保存 bool は旧閾値。
  実測: volatility_ok=1 かつ atr_pct<2 が **1,678 件**、
  allPassedLong 218 件中 **33 件**・allPassedShort 131 件中 **32 件**が誤通過。
  値 (atr_pct) は正しく bool のみ stale。次回 run で自己修復。
  liquidity_ok は全件一致 (mismatch 0)。
- 9914 (active): Yahoo が 1-bar stub (9/18) に縮退。D1 は 14 行 + stub 起源の
  指標 (sma 等 null)・momentum bars=1。旧 full-run (expectedDate なし) の書込で、
  新 stocksOnly の expectedDate guard では fail-safe 失敗になる。
  9/02–9/14 行は close NULL・volume ありの混合欠損。
- 4171 (inactive): delist 済み。D1 凍結 + Yahoo 1-bar stub (8/12)。
  指標行は破損起源だが非 active のため表示・集計から除外済み。
- 3681/3546/3924/2686: Yahoo 404 と inactive が整合。D1 凍結のまま。
  3546 は 2 行 (6/25–6/26) の短命残骸。3924 は 120 行 (prune 未達の最古残骸)。
- 3853: operating_margin=2.9758801 で優良株通過。Yahoo 原本 `297.59%` と
  完全一致 (忠実転記)。spec に margin 上限 cap はなく per-spec。
  参考情報として記録 (F-12)。

## 4. VWAP (R2 intra/daily、直近 5 営業日)

- 定義: 取引所 exact VWAP (全約定) は tick 非保有のため算出不能。
  本サービスは **5 分足 typical price (h+l+c)/3 の期間累積**
  (日足 adj/c 係数で分割連続化、日次サンプル) を「VWAP」と表示し、
  用語ヘルプで 5 分足算出を明示。日足 proxy (日足 typical) とも区別した。
- 独立再計算 (7203、9/16・9/17・9/18・9/24・9/25): 保存 intra から
  日次 VWAP・5 日累積・日足 proxy を再実装し、式の忠実性を検証。
  例: 9/25 dayVWAP5m=2,994.26 / cum=3,008.04 / dailyProxy=2,990.50。
  係数 f は全日 1.000000 (直近に配当落差なし)。
- **F-10 [情報] auction 除外**: intra 日合計は日足出来高の 40.5–70.8%
  (9/18 は SQ 日で 40.5%)。15:20–15:30 と寄付 auction を含まず、
  exact との差の主因。用語ヘルプの開示範囲内。
- 時刻 session: 65 本/日 = 09:05–11:30 (30) + 12:30–15:20 (35)。
  欠足なし (満 grid)。12:30 の昼休み bar が 1 本混入 (小出来高、式に混入)。
  9/24 のみ 09:00 始まりの 1 回性ずれ。
- 零出来高: R2 内 v=0 は 0 本 (fetchBars5m が drop)。3600 は 123 本/61 日と
  疎で、9/24–9/25 は欠落。fresh 5m で確認すると 9/24 全 null (v=0 と整合)、
  9/25 は 12:50 の c=1770・v=0 の 1 print のみ (日足 v=200 と Yahoo 内不整合)。
  drop-rule どおりの正直な欠落で、画面は fiveDays 注意で明示する設計。
- **F-09 [情報] R2 daily の splits=[]**: 1mo 差分更新が splits を上書きし、
  7203/9984 とも空。フロントは splits 未使用 (f=adj/c のみ) のため無影響。
  外部 2 リポジトリの splits 依存は未確認 (他 repo 非参照の限界)。

## 5. 信用残 (直近 4 週 + 9/18 週)

- R2: 13 週 (6/12–9/18) + weeks.json。**7/03・7/10 週が欠落** (F-08)。
  9/25 週の不在は JPX 公表前で正常。
- 9/18 週: rows=4230 が既存証跡 (margin-edinet log) と一致。
  **前週比の内部整合は 3 遷移で完全一致** (9/11→9/18 は 4,224 件中 bad 0)。
  sell/buy/chg の転記は忠実。
- 単位: **株** (7203 買残 17,404,700。千株なら発行済み超過のため規模で確定)。
  画面の GLOSSARY (株数) と整合。
- **F-08 [低] 旧週の種類株重複**: 9/04 以前の週に 6–7 コードの重複
  (2593/5076/7550/9201/9202/9434。種類株が 4 桁へ潰れ)。
  /api/margin の find は先勝ちのため普通株側が返る。9/11 以降は 5 桁分離で
  clean。種類株の週次履歴は 9/11 始まり。
- both-zero 36–42 行/週: 23 コードが 4 週安定 (構造的ゼロ)、
  7 コードが 9/18 に新規ゼロ化 (完済の実態。9914 を含む)。chg 整合も成立。
- **9/18 PDF 原本の SHA 照合は未実施 (限界)**: fixture 不在・Notion 未保管
  (#117 OPEN 継続)・JPX 再取得不可 (F-03) のため。
- **F-03 [中] JPX 週末残高 PDF の発見不能**: margin/02–05.html に
  syumatsu リンクが 0 件 (9/26 取込成功後に変化)。現ページは信用取引現在高の
  tvdivq 集計ファイルのみ。`latestMarginPdfUrl()` は次回 margin run
  (土曜 09:00 UTC) で `margin pdf link not found` 失敗が確定。
  R2 既存週と外部 2 リポジトリ (キー直接列挙) は無影響。
  なお 9/26 の vwap-ingest run (36245100733) の margin step 失敗は R2 書込
  (9/18.json・weeks.json) **成功後**の Notion 再保管の失敗であり、R2 データ自体は
  正常 (前週比の全行整合で保証)。job 成否と data 比較を区別した。

## 6. 財務入力の単位・年次スコープ

- **配当利回りは % 単位**: 7203: 3.35% × 2989.5 = 100.1 円 (DCF 表示と一致)。
  writer が Yahoo 小数を ×100・2 桁丸め。分布 0.07–21.61% (n=3,149、無配 607
  は NULL)。finmath の /100 正規化は正しい。8154 は 2.58% × 5420 ≈ 140 円で
  #144 修復値 (140) と整合 (値照合自体は A 担当)。
- **営業利益率 TTM は decimal 比率**: 7203: 0.07863。分布は概ね −1〜+1 だが
  3853 の 2.9759 (F-12) と負側の裾 (−6635 最小) あり。負側は全て bc=0 で正しく
  落選。spec に cap はない。
- **年次売上 scope**: FY2022–2026 が本体 (2,191–3,709 行)、2021 以前は凍結残骸
  (3–33 行)。revenue NULL は 0。FY2026 は 2,719 (12 月期の未到来分が不在で正常)。
- **年欠落**: 非連続 stock_id は **17 件** (docs の 18 件から 1 件解消)。
- **2 月末 (8267 イオン)**: 2023: 554 億 → 2024: 9.6 兆の窓外段差でも
  revenue_trend=+1 は per-spec (判定窓 2024–2026 は clean)。詳細ページに
  「前年比 2 倍超の段差」注記が出ることを実測確認。旧経路に月次ロジックは
  なく crash なし (#136 のうるう年対応は未 merge の将来)。
- 優良株 census: **1,112 件** (docs 予測「最大 1,116 程度」と一致)。
  revenue_trend NULL 949 件 (25%、判定不能の正直表示)。

## 7. 金融数学 (入力単位・計算不能表示・公開値 join)

| 経路 | 検証 |
|---|---|
| DCF 7203 (Gordon, k=7%, g=2%) | P=**2,003 円** = 100.15/0.05 完全一致。割安度 −33.0% 一致。感応度 5×5 併記あり |
| DCF 無配 2936 | **400 + 正直な誘導文** (Gordon 不可・手動入力・FCF 未実装の明示)。per-spec |
| CAPM 7203 auto | β=0.017・R²=0.000・n=81 と表示。**独立 OLS で完全一致** (β=0.0173)。低値は市場ファクト (fresh 原本でも相関 0.14。8035 は 0.79 で市場系列は正常)。R² 警告の表示あり (F-14) |
| CAPM 9914 | 「日足が 5 日分しかなく推定不能 (最低 31 日)」と表示。D1 14 行中 close 非 NULL 5 行と**完全一致** |
| BS 7203 (90 日) | S=2989.50・σ=**30.48%** (89 samples)。row-drop 再計算で完全一致。**F-11 [情報]**: NULL 行 drop 後に gap 跨ぎペアを作る流儀 (pair-break なら 29.46%)。パリティ残差 2.27e-13 (理論 0 の自己検算 PASS) |
| EMH momentum (w=60) | 3,700 対象 / 3,688 該当 / 9/25。4052 の +357.66%・1.79 を closes から**完全再現**。12 件の除外は window 未満の正直除外 |
| EMH low-vol (<1.5) | 953 件。D1 集計と**完全一致**。atr_pct % 単位の前提どおり |

## 8. #136/#144 の fresh 判定 (ranking 起動なし)

- **#136 は DRAFT + OPEN のまま未 merge** (gh 実測)。現 main に
  `jss_financials` / `pickAnnualSeries` の読者は存在しない (grep 0 件)。
  旧経路 (Yahoo 年次 → evaluateBlueChip → rsi_percentile) が実稼働中で、
  7203 の rt=null・8267 の注記が旧経路の表示であることを確認。
  **draft 内容を検証済みとして本番値に混ぜていない**。
- **#144 (正本修復) 後の指標鮮度**: #144 は Notion③/D1 source (pipeline 正本)
  の修復で、現 main の指標入力 (Yahoo) とは別 source。日次指標は 9/26 run で
  Yahoo fresh から再計算済み (9/25 basis) のため**古くない**。
  正本修復値の指標反映は #136 merge 待ちの既知状態であり不整合ではない。
- 旧 annual writer は外部 consumer (YouTube・新高値検証) のため維持が #136 で
  宣言済み (§9 と整合)。

## 9. 公開 GET と D1/R2 の join (HTTP 200 以外の合否)

| URL | 結果 |
|---|---|
| `/` portal | 200。個人利用注記 0 件 (post-#143 deploy 確認)。7 サービス card |
| `/rsi-screening/screening` | 200。7203 不在は正 (bc=0)。既定 50 件表示 |
| `/rsi-screening/stocks/7203` | 200。判定不能 + OP margin 7.9% が D1 と一致 |
| `/rsi-screening/stocks/8267` | 200。上昇基調 + 段差注記が一致 |
| `/swing-trading/` | 200。MACRO B・日経 66,364 (+0.77%)・VI 20.3・銀行業 +4.77% が D1 (9/26 行) と一致。**日付ラベルは run 日 (土曜 9/26) 表示** (F-13) |
| `/swing-trading/screening?direction=long/short` | 200。**通過 200/131 件表示だが LONG 真値は 218** (F-07: LIMIT 200 を総数表示)。SHORT 131 は一致 |
| `/swing-trading/stock/7203` | 200。SMA5 3,007・ATR 2.10%・RSI14 45.5 等が D1 と一致 (丸め内) |
| `/swing-trading/stock/1909` | 200。**SMA5 16,278,437,478 を表示中** (F-01 の user-visible 証拠) |
| `/swing-trading/signals` | 200。D1 303 行に対し 200 件表示 (F-07 と同型の cap) |
| `/vwap-analysis/api/daily?code=7203` | 200。R2 と 2,529 本・最終 bar まで完全一致 (素通し) |
| `/vwap-analysis/api/margin?code=7203&n=4` | 200。R2 4 週と完全一致 |
| jss-api-public `/health`, `/v1/meta/freshness` | 200。meta のみ |
| jss-api-public `/v1/ohlcv|indicators|valuation|supply/*` | **404 で非公開** (personal-only の第 0 層防御が live で成立) |
| finmath DCF/CAPM/BS/EMH | §7 のとおり値 join 合格。400 系 (無配・limit 範囲外) も正当 |

## 10. 最小再現手順 (read-only)

1. **F-01 (1909)**: `$YAHOO_PROXY_BASE/api/ingest/yahoo?u=<urlencode(
   https://query1.finance.yahoo.com/v8/finance/chart/1909.T?range=5y&interval=1d&events=split%2Cdiv)>`
   を Bearer 中継 GET → 47 bar・7/17–9/14 が 1.6e10・v=0・9/15 以降 null。
   D1: `SELECT sma_5, atr_14 FROM swing_stock_indicators WHERE stock_id=
   (SELECT id FROM core_stocks WHERE code='1909')` → 16278437478.4。
2. **F-02**: `SELECT COUNT(*) FROM swing_stock_indicators WHERE
   latest_date='2026-09-25' AND volatility_ok=1 AND atr_pct<2` → 1678。
3. **F-03**: JPX margin/05.html を GET → `syumatsu*.pdf` が 0 件。
   `parseMarginText` の週正規・行正規は不変のため、発見部のみの故障。
4. **F-04**: `SELECT date, SUM(close IS NULL) FROM swing_daily_ohlcv GROUP BY
   date HAVING SUM(close IS NULL)>300` → 13 日。R2 `daily/7203.json` の同日
   bar と突合せると R2=fresh で D1 のみ旧値。
5. **β再現**: D1 2 本 (`swing_market_context`、7203 の `swing_daily_ohlcv`)
   の SELECT + 単純リターン OLS (n=81、β=0.0173)。
   検証用スクリプト (`/tmp/audit-b/` 配下) は commit 外の使い捨て
   (本 report のみが成果物)。

## 11. 外部 consumer 特定 (他 repo 非編集・非起動)

- **株ラボ-Youtube** (別 repo・動画制作): R2 `vwap-data` の bucket 名を
  hardcode して intra/daily/margin を直読 + D1 直読
  (`stocks()`・`annual_revenue()`・`tags LIKE`)。
  出典: docs/CF-CANONICAL-DESIGN.md:219,253,516,826,954,972,1373,1974。
- **株ラボ-新高値ブレイク検証** (別 repo): R2 `daily/<日経225連動ETF>.json`
  等 + 年次売上。`_bootstrap.py` で Youtube と同層。
  出典: 同上 + HANDOFF-2026-09-LEDGER.md:14,80 + #136 本文。
- 両者とも **repo 外の外部 consumer** であることを既存成果物のみで特定。
  影響: (a) JPX 発見故障 (F-03) はキー直接列挙のため無影響、
  (b) 旧週の種類株重複 (F-08) は両者の読みにも波及、
  (c) R2 splits 空 (F-09) の外部影響は他 repo 非参照のため未確認 (限界)。
- 注意: ir-catalog の `recent-high-signal` は別概念 (IR 高シグナル) であり、
  新高値ブレイク検証とは無関係。

## 12. 未検証・限界 (正直な残差)

1. Notion 未読: 信用 PDF の保管状態は #117 OPEN + 既存 log のみで判定
   (9/18 週の再保管は未確認)。銘柄マスタ・株価同期 DB の読取なし。
2. jss-api private 面 (要 API キー) の live 検証なし。公開面の 404 境界と
   code/test の契約確認まで。standalone の suite は install 禁止のため未実行
   (CI が PR で実行)。
3. 9/18 PDF の SHA 照合なし (原本入手不可)。代替として rows=4230 の一致と
   前週比の全行整合で転記を保証。
4. R2 daily/intra の全銘柄網羅は未検証 (4,444/4,272 件の存在確認まで。
   内容突合せは 7203/9984/3600 の 3 銘柄)。
5. 5y RSI の全銘柄再計算は未実施 (20 標本のみ。5y closes は D1 非保存のため
   全件再計算には全銘柄 fetch が必要で、今回は層別標本に限定)。
6. 当日 run (9/28 17:13 UTC stock-sync / 08:00 UTC vwap-ingest) の反映前スナップ
   ショット。F-02/F-05 は次回 run で自己修復見込みだが本 report 時点では未確認。
7. ir-catalog の recent-high-signal 等、A 担当域の値照合は対象外。

## 13. 判定サマリ

| ID | 重要度 | 内容 | 状態 |
|---|---|---|---|
| F-01 | 中 | 1909 破損系列を取込済み・公開表示中 | 親へ status 済み。修復 writer 未起動 |
| F-02 | 中 | volatility_ok が旧閾値 (1678 件・誤通過 65 件) | 次回 run で自己修復。status 済み |
| F-03 | 中 | JPX syumatsu 発見不能 (次回 margin 失敗確定) | status 済み。R2 保全 |
| F-04 | 低 | D1 OHLCV の凍結暫定/NULL (13 日・先勝ち書込) | 指標は fresh 系で無事 |
| F-05 | 低 | prune 飢餓 (3,689 銘柄 >90 行) | 新日程で自己修復見込み |
| F-06 | 低 | sector 9/22–9/23 の休日 stale 重複 | 読者は最新日のみ。旧 run 由来 |
| F-07 | 低 | LONG/信号の LIMIT 200 を総数表示 | 開示なしの cap |
| F-08 | 低 | 旧信用週の種類株重複 + 7/03・7/10 週欠落 | 9/11 以降は clean |
| F-09–F-14 | 情報 | splits 空・auction 除外・σ 流儀・3853・run 日付ラベル・CAPM 市場ファクト | 記録のみ |

独立再計算の実証件数: 原本あり 16 標本 × (RSI 3 期間+percentile / 指標 30 field /
momentum 全文 / pattern) + delist 4 件の 404 整合 + 前週比 12,669 行 + 公開 25 経路。
真正誤り (コード・データの誤り) は F-01 の取込値・F-02 の stale bool・F-03 の
発見部の 3 件で、いずれも親へ status 済み。丸め・定義差 (F-09–F-14) と区別した。

