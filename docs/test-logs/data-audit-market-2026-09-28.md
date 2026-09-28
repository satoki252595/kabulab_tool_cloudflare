# 市場系実データ監査 (2026-09-28) — 担当B

Issue [#146](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/146) の担当B分担
(株価・信用/空売り・VWAP・RSI・Swing・金融数学・派生指標・公開面/consumer)。
財務 (EDINET/Notion 正本)・銘柄マスタ・TDnet/優待の値照合はA担当、
moneyflow はC担当 (Yahoo quoteSummary 断面は §0 役割分担のとおり B)。

## 0. 監査条件

- branch: `audit/market-2026-09-28` (基点 `origin/main` = `18d5939` #145、
  追補時点で #147 `c84b6a4`・#148 `bde6b03`・#136 `5b792e9` を通常 merge 済み。
  #136 の `src/cron/daily.ts` 差分 (正本年次 reader) は保持。
  review 修正時に #150 `5b54a74` を通常 merge (海外 parser + 監査報告。
  #136 reader・#150 code とも保持)。
- 観測窓: 2026-09-28 17:00–19:30 JST (初回) + 同日 19:00–19:25 JST (追補:
  D1 SELECT のべ 42 文 (F-02 preview 9 文を内訳追加のため 3 回・
  例外断面 4 文・cap 分布 2 文・2180 signals 2 文・RSI 3 銘柄 2 文・
  provenance 3 文・indicators 時刻 2 文)・Yahoo 4 GET・公開 11 GET・JPX 1 GET・
  R2 2 GET。
  いずれも read-only、rows_written=0)。D1/R2/公開面の読取は同日 17:13 UTC
  (stock-sync) および 08:00 UTC (vwap-ingest daily-intra) の当日 run の反映前。
  R2 の最終更新は 9/25、D1 市場系の最終更新は 9/26 10:55 UTC (9/25 取引分)。
- 最新確定営業日: **2026-09-25 (金)**。9/21–9/23 は休場
  (敬老の日・国民の休日・秋分の日)、9/26–9/27 は週末。
  保存系列の最新も 9/25 (D1 市場系・R2 daily/intra とも)。
  9/28 営業日分は未反映: 当日 run (9/28 17:13 UTC stock-sync・
  08:00 UTC vwap-ingest) の予定時刻と実成功を混同しない。
  本監査の snapshot 時点ではいずれも反映前である。
- 境界: D1/R2 は SELECT / List / Get のみ。
  取込・ranking・master apply・新 DB/endpoint の起動なし。新規 install なし。
  本番 D1/R2/Notion への write・archive・ingest・dry-run・ranking refresh・
  master apply は一切なし (再発防止 guard・修復 preview ともに offline 検証のみ)。
  Yahoo/JPX 公開一次資料は既存 ingest-proxy の純粋中継または素の GET で
  観測のみ (取込経路は起動せず、観測物は `/tmp` に留め commit しない)。
  Notion は未読 (A/C との合計レート配慮。archive 状態は既存証跡 + gh のみで判定)。
- 役割分担: Yahoo quoteSummary 断面 (`core_stock_financials` の入力) の
  値検証は B (株価・金融数学の入力として)。EDINET/Notion 正本の財務値照合は
  A 担当のまま (別 source)。
- JPX 新様式・信用残日次化は 9/29 延期のまま (実装しない)。
- 数値の表記: 金額・件数は監査証跡としての集計値と少量標本のみ。本文書に
  秘密値・署名 URL・全生データ・原本全文は含まない。私的 script・capture は
  §15 に path・SHA・実行 command・出力要約のみ記録する。
- 結論の読み方: 全件検証・層別標本・未確認・取得/保存/表示/鮮度を分けて書く。
  未確認は合格に数えない (§9.4・§12 の未確認項目を参照)。

## 1. 母集団・鮮度 (D1/R2 全体像)

| 対象 | 件数 | 最新 | 備考 |
|---|---|---|---|
| `core_stocks` active+equity / 全体 | 3,700 / 3,810 | — | 非 active 110 (delist 等) |
| `swing_daily_ohlcv` | 361,284 行 / 3,756 銘柄 | 2026-09-25 | 9/25: 3,698 行 |
| `swing_stock_indicators` | 3,756 行 | 9/25 が 3,698 行 | 非 9/25 は 58 行 = 非 active 凍結 56 + active 2 (9914: 9/18・7426: 9/15)。ただし 9/25 行にも破損値あり (1909・2180。F-01) |
| `rsi_percentile` | 3,756 行 | computed 9/26 10:55 UTC | 1909 は bars=40 の破損 RSI。2180 は bars=1217 だが RSI 破損由来は未証明 (§3.3 F-01) |
| `p_momentum` | 3,700 行 | as_of 9/25 が 3,695 行 | 行数=active で sweep 正常。ただし as_of 例外 5 件 (9914: 9/18・1909: 9/14・2180/7426: 9/15・3480: 9/01)。「latest 全件」は撤回 |
| `core_stock_financials` | 3,756 行 | data 9/25 | market_cap 分布: 1000億+ 963・1000億未満 2763・10億未満 19・NULL 5・100万未満 6 (内 active 破損 3: 1909/2180/7426 + 非 active 凍結 3)。F-15 |
| `swing_market_context` | 最新 9/26 (B) | run 日付キー | §3-6 |
| `swing_sector_daily` | 最新 9/26 (33 業種) | run 日付キー | §3-6 |
| `swing_entry_signals` | 303 行 (7 pattern) | sweep 済み | gap_follow 0。1909/2180 の行は 0 (当該破損の signals 汚染なし) |
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
| S-10 | 保持本数 (90 本) | **F-05。3,689 銘柄が 90 行超過** (最大 120、平均 96)。月曜限定 prune が深夜跨ぎで skip され飢餓。新日程 (17:13 UTC 完了は月曜内) での自己修復は次回 run で確認するまで未確認 |
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
追補で 2180 の chart 原本 + 1909/7426/2180 の quoteSummary 原本を追加観測
(19:05–19:10 JST。各 1 GET。SHA は §15)。

### 3.2 照合結果 (母数分離: コード/件数/除外を明示)

20 標本 = 原本応答あり 16 (active 15 + 非 active 4171 の 1-bar stub)
+ 原本なし 4 (delist 404: 3681/3546/3924/2686)。検査ごとの計算可能 n は異なる:

| 検査 | 分母 (コード) | n | 除外 | 結果 |
|---|---|---|---|---|
| 日足 join (D1 vs 原本) | 観測 16 | 16 | 404 の 4 | 差分は (a)–(d) のみ (下記) |
| RSI 3 期間+percentile+sampleBars | 観測 active 15 | 15/15 許容内一致 | 404 の 4 + 4171 (非 active stub。保存旧値と不一致は期待どおり) | 1909 は破損値同士の一致 (正の証明でない)。9914 (1)・137A (629)・581A (69) は完全一致。1222 vs 1221 差は 5y sliding window の 1 本ずれで無害 |
| 指標 30 field + screening 6 bool | 観測 16 | 全一致 11 + vol 不一致 4 + 対象外 1 | 404 の 4。4171 は非 active stub のため比較対象外 | vol 不一致 9432/3600/5969/7129 → F-02 |
| p_momentum 全文 (as_of/bars/closes) | momentum 行あり 15 | 15/15 一致 | sweep 不在 5 (非 active: 3681/3546/3924/2686/4171。不在が正) | 1909 (40/40 破損)・9914 (1/1 stub) は異常値同士の一致。標本外に 2180/3480/7426 の例外あり (§1) |
| entry pattern | 最新 close 非 NULL 15 | 15/15 一致 | 404 の 4 + 1909 (skip: 最新 null) | 9984 の gap_fade 等を含む |

- **日足 join の差分内訳**: (a) 5 月 adj NULL (S-08)、
  (b) Yahoo 遡及訂正の凍結 (8/07・8/27・8/28・9/01。R2 daily と fresh が一致し
  D1 のみ旧値。例: 7203 8/07 close D1=3013/R2=fresh=2980)、
  (c) volume ±4 の丸め塵、(d) 1909 の破損域。いずれも F-01/F-04 の範囲内。
- 許容値: RSI |Δ|≤0.05、percentile |Δ|≤1.0pt (実測はほぼ 0)。
- 2180 (追補標本): chart 原本・D1 断面・公開表示・guard replay は検証済み。
  30 field 独立再計算は未実施 (標本外発見のため。未確認)。

### 3.3 個別状態

- **F-01 [高→対応中] Yahoo chart 破損の取込済み (1909 + 2180 同型)**:
  1909: 全 47 bar。7/17–9/14 は close≈1.62e10・volume 0、9/15–9/28 は全 null、
  偽 split 1:4400000、meta 価格 3700 は正常。D1 は sma_5=16278437478.4・
  sampleBars=40・momentum bars=40 (as_of 9/14) が破損値、かつ
  indicators latest_date=9/25・latestClose=null (null-fresh の日付合格)。
  公開詳細ページに `SMA5 16,278,437,478` と表示中 (実測)。
  2180 (追補発見): 全 47 bar。7/17–9/15 は close≈1.89e9・volume 0、
  9/16 以降 null、偽 split 1:1440960、meta 1309 は正常。D1 は
  sma_5=1886167168・momentum as_of 9/15 bars=85 が破損値、公開詳細ページに
  `SMA5 1,886,167,168` と表示中 (実測)。rsi 行は bars=1217・rsi10=56.2 と
  一見正常。保存 RSI 使用本数 1217 に対し現在 raw は 47 本だが、9/26 run
  時の応答 raw artifact がなく過去 raw 全文比較は未確認のため、RSI 破損由来は
  未証明 (9/26 応答 full 1217・進行性劣化・corrupt-tail 由来の断定はしない)。
  D1 の giant SMA (sma_5=1886167168)・p_momentum 保存 closes の bad
  (as_of 9/15・bars=85) は確認済み (保存値の直接確認)。
  sanitizeBars は 10 倍 jump のみ棄却し持続的異常レベルは素通りする
  (実関数 replay で rejected=[] を確認。§14)。
  sector 汚染はなし (pct≈0)。
  **保存経路の分析**: (a) stocksOnly の日付 gate は対象日の fresh null bar と
  日付一致で通過する (実関数 replay で 9/28 null bar が一致することを確認)。
  (b) full run (expectedDate なし) には gate 自体がない。
  破損値を保存した run が (a)(b) のどちらかは D1 からは未確認。
  どちらも本 PR の guard で塞ぐ (fetch 境界の応答整合 + 日次の実終値 gate。§14)。
  9914 との差: 9914 の末尾は 9/18 の stale bar のため日付 gate で fail-safe
  失敗する。データ修復 writer は起動していない (preview のみ §14)。
- **F-15 [高→対応中] Yahoo quoteSummary 破損の取込済み (1909/2180/7426)**:
  Yahoo 原本の sharesOutstanding が 1 桁 (1909: 6・2180: 10・7426: 2) のため
  marketCap (22200/13090/1182)・PER・EPS が破損。writer は無変換の素通しの
  ため D1 は忠実転記 (1909: per≈4.37e-06・eps=846560000・cap=22200)。
  公開影響 (実測): small-cap 上位 3 件がこの 3 銘柄で占有 (誤ランク)、
  1909 RSI 詳細に時価総額 `0億円`・PER `0倍`・EPS `846,560,000円` を表示中。
  pbr/bps/roe/roa/配当/営業利益率は正常値。chart guard の対象外
  (quoteSummary に meta 照合の相手がいない) のため guard は未実装・要 follow-up。
  非 active 凍結の tiny-cap 3 件 (3593/4556/7999) は表示対象外 (注記のみ)。
- **F-02 [中] volatility_ok の stale**: #135 (閾値 0.02→2) の merge
  (9/28 15:27 JST) が最終データ run (9/26) より後のため、保存 bool は旧閾値。
  現行 screenStock による全件 offline 再計算 (preview。§14):
  9/25 行は volatility 1,678 件 (全て 1→0)・long 誤通過 33 件・short 誤通過 32 件、
  非 9/25 行は volatility 3 件・long 1 件 (8963。非 active)・short 0 件。
  long/short 反転集合の重なりは 0 のため unique は 9/25 行 65 件・全体 66 件
  (判定数 33+32 および 34+32 と一致。重複なしを検証済み)。
  値 (atr_pct) は正しく bool のみ stale。liquidity_ok・trend 系は全件一致。
  自己修復は次回 run の再計算を確認するまで未確認 (「自己修復見込み」とは書かない)。
- 9914 (active): Yahoo が 1-bar stub (9/18) に縮退。D1 は 14 行 + stub 起源の
  指標 (sma 等 null)・momentum bars=1。保存 run の mode は未確認
  (日付一致で保存されうる形)。現在の expectedDate では日付 gate で
  fail-safe 失敗になる。9/02–9/14 行は close NULL・volume ありの混合欠損。
- 4171 (inactive): delist 済み。D1 凍結 + Yahoo 1-bar stub (8/12)。
  指標行は旧履歴由来の凍結値 (現 stub との比較対象外)。非 active のため
  表示・集計から除外済み。
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
- **R2 daily の破損 tail (F-01。再掲。追補)**: `daily/1909.json`
  (2,523 本) の末尾 22 本 (8/14–9/14) と `daily/2180.json` (2,524 本) の
  末尾 22 本 (8/17–9/15) が破損水準 (v=0)。偽 split も記録済み
  (1909: 1:4400000・2180: 1:1440960)。fetchDaily 経路の書込到達の実証。
  それ以前の 10 年分は正常 (1909: 8/13 まで 3705・2180: 8/14 まで 1307)。
  破損開始が Yahoo 5y 応答の 7/17 とずれる理由は未確認。
  修復は tail 除去 + 偽 split 除去の別対応 (本 PR では preview のみ)。

## 5. 信用残 (直近 4 週 + 9/18 週)

- R2: 13 週 (6/12–9/18) + weeks.json。**7/03・7/10 週が欠落** (F-08)。
  9/25 週の不在は JPX 公表前で正常。
- 9/18 週: rows=4230 が既存証跡 (margin-edinet log) と一致。
  **前週比の内部整合は 3 遷移で完全一致** (9/11→9/18 は 4,224 件中 bad 0)。
  sell/buy/chg の週次間整合は成立。ただしこれは R2 保存値どうしの内部一致で
  あって、PDF 原表からの転記忠実の証明ではない (原表 SHA 未確認のため)。
- 単位: **株** (7203 買残 17,404,700。千株なら発行済み超過のため規模で確定)。
  画面の GLOSSARY (株数) と整合。
- **F-08 [低] 旧週の種類株重複**: 9/04 以前の週に 6–7 コードの重複
  (2593/5076/7550/9201/9202/9434。種類株が 4 桁へ潰れ)。
  /api/margin の find は先勝ちのため普通株側が返る。9/11 以降は 5 桁分離で
  clean。種類株の週次履歴は 9/11 始まり。
- both-zero 36–42 行/週: 23 コードが 4 週安定 (構造的ゼロ)、
  7 コードが 9/18 に新規ゼロ化 (9914 を含む)。chg の内部整合も成立するが、
  ゼロ化が完済の実態かは原表突合せなしには保証しない (内部一致どまり)。
- **9/18 PDF 原本の SHA 照合は未実施 (限界)**: fixture 不在・Notion 未保管
  (#117 OPEN 継続) のため。JPX からの再取得可否は F-03 のとおり。
- **F-03 [中] JPX 週末残高 PDF の発見不能**: margin/02–04.html は JPX 側 404
  ページ (同一 SHA の 3 件)、05.html は「信用取引現在高 過去推移表」
  (syumatsu リンク 0 件・tvdivq 集計のみ)。実関数 replay
  (`latestMarginPdfUrl()` に保存 HTML を stub 経由で投入) で
  `margin pdf link not found` の throw を確認 (§10-3・§15)。
  05.html は 19:12 JST の再取得でも同一 SHA (full SHA は §15) で条件が
  持続し、保存 capture が 05.html 自身であることも確定した。
  **次回 margin run (土曜 09:00 UTC) が同状況なら同エラーで失敗する**
  (将来の JPX 側変化は断定しない)。R2 既存週は保全。
  外部 2 リポジトリはキー直接列挙のため現週分は読めるが、将来週の欠落が
  波及しないとは断定しない (未接続 consumer への無影響は言わない)。
  JPX 新様式への実装対応は 9/29 扱いで本 PR では行わない。
  なお 9/26 の vwap-ingest run (36245100733) の margin step 失敗は R2 書込
  (9/18.json・weeks.json) **成功後**の Notion 再保管の失敗であり、R2 データ自体は
  前週比の全行整合 (内部一致) の範囲で正常。job 成否と data 比較を区別した。

## 6. 財務入力の単位・年次スコープ

- **市場キャップ・PER・EPS の破損 3 銘柄 (F-15。再掲)**: Yahoo 原本の
  sharesOutstanding が 1 桁 (1909: 6・2180: 10・7426: 2) のため marketCap・
  PER・EPS が破損し、writer 素通しで D1 に保存済み (1909: cap=22200・
  per≈4.37e-06・eps=846560000)。分布上は tiny (<100万) 6 件中の active 3 件
  (残り 3 件は非 active 凍結)。7203/9984/3600 の同列は正常値。
  pbr/bps/roe/roa/配当/営業利益率は 3 銘柄とも正常。
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
  なく crash なし (#136 のうるう年対応は merge 済み。表示は旧経路のもの)。
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
| EMH momentum (w=60) | 3,700 対象 / 3,688 該当 / 9/25。4052 の +357.66%・1.79 を closes から**完全再現**。12 件の除外は window 未満の正直除外 (1909 の 40 本・9914 の 1 本・3480 の 31 本を含む。残り 9 件の内訳は未確認)。w≤40 では 1909 の破損 closes が混入しうる (未検証) |
| EMH low-vol (<1.5) | 953 件。D1 集計と**完全一致**。atr_pct % 単位の前提どおり |
| EMH small-cap (<500億。追補) | 3,700 対象 / **2,360 該当** / 9/25。先頭 3 件が 7426/2180/1909 (破損 cap 順の誤ランク)。#4 (4316・1.92億) から正常域。入力 marketCap は financials 9/25 断面。該当件数の D1 全件再集計は未実施 (表示値のみ) |
| EMH post-earnings (PEAD簡易。追補) | 3,700 対象 / **3,700 該当** / 9/25。fetched_at 降順で先頭は 09/26 10:54 更新群 (最終 run 時刻と一致)。代理定義 (決算日でなく更新時刻) は画面に明示あり。件数の D1 再集計は未実施 (表示値のみ) |

## 8. #136/#144 の fresh 判定 (ranking 起動なし)

- **#136 は追補時点で main へ merge 済み** (`5b792e9`。09:47 UTC squash)。
  初回観測時点 (DRAFT + OPEN) の記述は失効。本 PR branch は #136 を通常 merge
  済みで、正本年次 reader (`jss_financials` / `pickAnnualSeries`) を保持する。
  本 report の値検証は merge 前の旧経路
  (Yahoo 年次 → evaluateBlueChip → rsi_percentile) の表示に対するもので、
  7203 の rt=null・8267 の注記は旧経路の表示。#136 適用後の表示値は未検証。
- **#144 (正本修復) 後の指標鮮度**: #144 は Notion③/D1 source (pipeline 正本)
  の修復で、日次指標の入力 (Yahoo) とは別 source。日次指標は 9/26 run で
  Yahoo から再計算済み (9/25 basis) のため再計算時点では新しい。
  ただし例外あり: 1909/2180 の破損値は同 run で保存された新しい誤りであり、
  「古くない」を「正しい」と読まないこと (F-01/F-15)。
  正本修復値の指標反映は #136 で開始済み (merge 後の表示は未検証)。
- 旧 annual writer は外部 consumer (YouTube・新高値検証) のため維持が #136 で
  宣言済み (§11 と整合)。

## 9. 公開経路と D1/R2 の join (件数・list・合否基準の一致)

旧「25 経路」の数え方は request 単位で再現不能だったため、本追補で
unique route 単位に再定義し全件列挙する。分類: **値join** (D1/R2 と値を突合)、
**200-only** (到達の証明。値合格に数えない)、**境界** (404/401/429 は防御・契約の
証明。値合格に数えない)。200-only と境界を値合格に数えない。

### 9.1 Portal 7 mount (実 URL・status・基準日)

| mount | URL | status | 基準日表示 |
|---|---|---|---|
| portal | `/` | 200 | なし (shell。個人利用注記 0 件・7 card は値join #1) |
| 001 RSI | `/rsi-screening/` | 200 | 9/25 |
| 002 お宝優待 | `/otakara-yutai/` | 200 | なし (B 対象外。値未検証) |
| 003 Swing | `/swing-trading/` | 200 | 9/26 (run 日ラベル。F-13。値は値join #5) |
| 004 金融数学 | `/financial-math/` | 200 | なし (index) |
| 005 有報 | `/yuho-quant/` | 200 | なし (B 対象外。値未検証) |
| 006 IR | `/ir-catalog/` | 200 | 9/24–9/25 (B 対象外。値未検証) |
| 007 VWAP | `/vwap-analysis/` | 200 | なし (app shell) |

URL は portal card の href 実測。rsi/swing の root は旧 capture と新 GET が
SHA 一致 (再掲 §15) で変化なし。

### 9.2 値join 23 件 (旧 19 + 新 4)

| # | URL | 結果 |
|---|---|---|
| 1 | `/` portal | 個人利用注記 0 件 (post-#143 deploy 確認)。7 サービス card |
| 2 | `/rsi-screening/screening` | 7203 不在は正 (bc=0)。既定 50 件表示 |
| 3 | `/rsi-screening/stocks/7203` | 判定不能 + OP margin 7.9% が D1 と一致 |
| 4 | `/rsi-screening/stocks/8267` | 上昇基調 + 段差注記が一致 |
| 5 | `/swing-trading/` | MACRO B・日経 66,364 (+0.77%)・VI 20.3・銀行業 +4.77% が D1 (9/26 行) と一致。**日付ラベルは run 日 (土曜 9/26) 表示** (F-13) |
| 6 | `/swing-trading/screening?direction=long` | **通過 200 件表示だが LONG 真値は 218** (F-07: LIMIT 200 を総数表示) |
| 7 | `/swing-trading/screening?direction=short` | SHORT 131 は一致 |
| 8 | `/swing-trading/stock/7203` | SMA5 3,007・ATR 2.10%・RSI14 45.5 等が D1 と一致 (丸め内) |
| 9 | `/swing-trading/stock/1909` | **SMA5 16,278,437,478 を表示中** (F-01 の user-visible 証拠) |
| 10 | `/swing-trading/signals` | D1 303 行に対し 200 件表示 (F-07 と同型の cap) |
| 11 | `/vwap-analysis/api/daily?code=7203` | R2 と 2,529 本・最終 bar まで完全一致 (素通し) |
| 12 | `/vwap-analysis/api/margin?code=7203&n=4` | R2 4 週と完全一致 |
| 13 | finmath DCF 7203 | P=2,003 円・割安度 −33.0% が一致 (§7) |
| 14 | finmath DCF 無配 2936 | **400 + 正直な誘導文** (§7。エラー契約の値証明) |
| 15 | finmath CAPM 7203 | β=0.017・n=81 が独立 OLS と一致 (§7) |
| 16 | finmath CAPM 9914 | 推定不能 (5 日/最低 31 日) が D1 と一致 (§7) |
| 17 | finmath BS 7203 | σ=30.48% が一致、パリティ残差 2.27e-13 (§7) |
| 18 | finmath EMH momentum | 4052 の +357.66%・1.79 を再現 (§7) |
| 19 | finmath EMH low-vol | 953 件が D1 集計と一致 (§7) |
| 20 | finmath EMH small-cap (新) | 2,360 件・先頭 3 件・閾値 500 億・9/25 (§7。件数の D1 再集計なし) |
| 21 | finmath EMH post-earnings (新) | 3,700 件・更新時刻 09/26 10:54・9/25 (§7。件数の D1 再集計なし) |
| 22 | `/swing-trading/stock/2180` (新) | **SMA5 1,886,167,168 を表示中** (F-01 の user-visible 証拠) |
| 23 | `/rsi-screening/stocks/1909` (新) | 時価総額 `0億円`・PER `0倍`・EPS `846,560,000円`・母数 40 を表示中 (F-15 の証拠) |

### 9.3 200-only 9 件 (旧 4 + 新 5。値合格に数えない)

`/rsi-screening/` (root 表示。値突合せなし)、finmath POST echo 3 件
(dcf/capm/bs-post。各 200)、`/financial-math/`・`/vwap-analysis/`・
`/otakara-yutai/`・`/ir-catalog/`・`/yuho-quant/` (各 200。新)。

### 9.4 境界 6 件 (値合格に数えない) + 未確認

- jss-api-public `/health`・`/v1/meta/freshness`: 200 (meta のみ)。
- jss-api-public `/v1/ohlcv|indicators|valuation|supply/*`: **404 で非公開**
  (personal-only の第 0 層防御が live で成立。値の証明ではない)。
- **未確認**: jss-api-private の値 (`JSS_API_KEYS` が `.env` に不在のため
  到達不能。fail-closed のコード確認まで。キー名のみ確認し値は触れず)。
  w≤40 の EMH momentum (1909 破損 closes 混入の可能性)。
  #136 適用後の表示値 (§8)。

合計: request 40 (旧 capture 23 + jss 6 + 新 11)、unique 38
(値join 23 + 200-only 9 + 境界 6。rsi/swing root の重複確認 2 を除く)
+ 未確認 3 項目。

## 10. 最小再現手順 (read-only)

1. **F-01 (1909/2180)**: `$YAHOO_PROXY_BASE/api/ingest/yahoo?u=<urlencode(
   https://query1.finance.yahoo.com/v8/finance/chart/1909.T?range=5y&interval=1d&events=split%2Cdiv)>`
   を Bearer 中継 GET → 47 bar・7/17–9/14 が 1.6e10・v=0・9/15 以降 null
   (2180 は 7/17–9/15 が 1.89e9・v=0・9/16 以降 null)。
   D1: `SELECT sma_5, atr_14 FROM swing_stock_indicators WHERE stock_id=
   (SELECT id FROM core_stocks WHERE code='1909')` → 16278437478.4。
   実関数 replay: `replay-1909-guard.mjs` (§15) で guard 前は 3 fetcher が
   解決 (47 bar・40 破損受理)、guard 後は全拒否・書込到達 0。
2. **F-02**: `SELECT COUNT(*) FROM swing_stock_indicators WHERE
   latest_date='2026-09-25' AND volatility_ok=1 AND atr_pct<2` → 1678。
   全件 preview: `preview-repair.mjs` (§15) で 3 列のみ変化・2nd run 差分 0。
3. **F-03**: JPX margin/05.html を GET → 現 parser の発見正規で 0 件。
   実関数 replay: `replay-jpx-margin.mjs` (§15) で実 `latestMarginPdfUrl()`
   が `margin pdf link not found` を throw (18:06 capture と 19:12 fresh が
   同一 SHA で条件持続)。`parseMarginText` の週正規・行正規は不変のため、
   発見部のみの故障。次回同状況なら失敗 (将来断定なし)。
4. **F-04**: `SELECT date, SUM(close IS NULL) FROM swing_daily_ohlcv GROUP BY
   date HAVING SUM(close IS NULL)>300` → 13 日。R2 `daily/7203.json` の同日
   bar と突合せると R2=fresh で D1 のみ旧値。D1 先勝ち暫定 + NULL 13 日旧値は
   誤りリスクとして残す (「指標無事」とは書かない)。
5. **β再現**: D1 2 本 (`swing_market_context`、7203 の `swing_daily_ohlcv`)
   の SELECT + 単純リターン OLS (n=81、β=0.0173)。
6. **F-15 (quoteSummary)**: `fetch-qs.mjs 1909` (§15 既存) →
   sharesOutstanding raw=6・marketCap raw=22200。D1 同値を確認
   (忠実転記)。表示は §9.2 #23。
   検証用スクリプトは `/tmp/audit-b/` 配下に保持し、使い捨てにしない。
   path・SHA・実行 command・出力要約は §15 (本 report と併せて成果物)。

## 11. 外部 consumer 特定 (他 repo 非編集・非起動)

- **株ラボ-Youtube** (別 repo・動画制作): R2 `vwap-data` の bucket 名を
  hardcode して intra/daily/margin を直読 + D1 直読
  (`stocks()`・`annual_revenue()`・`tags LIKE`)。
  出典: docs/CF-CANONICAL-DESIGN.md:219,253,516,826,954,972,1373,1974。
- **株ラボ-新高値ブレイク検証** (別 repo): R2 `daily/<日経225連動ETF>.json`
  等 + 年次売上。`_bootstrap.py` で Youtube と同層。
  出典: 同上 + HANDOFF-2026-09-LEDGER.md:14,80 + #136 本文。
- 両者とも **repo 外の外部 consumer** であることを既存成果物のみで特定。
  影響: (a) JPX 発見故障 (F-03): 現週分はキー直接列挙で読めるが、将来週の
  欠落が波及しないとは断定しない (§5 と同一条件)、
  (b) 旧週の種類株重複 (F-08) は両者の読みにも波及、
  (c) R2 splits 空 (F-09) の外部影響は他 repo 非参照のため未確認 (限界)。
- 注意: ir-catalog の `recent-high-signal` は別概念 (IR 高シグナル) であり、
  新高値ブレイク検証とは無関係。

## 12. 未検証・限界 (正直な残差)

1. Notion 未読: 信用 PDF の保管状態は #117 OPEN + 既存 log のみで判定
   (9/18 週の再保管は未確認)。理由: A/C との合計レート配慮で B は読まない
   方針。銘柄マスタ・株価同期 DB の読取なし。
2. jss-api private 面の live 検証なし。理由: `JSS_API_KEYS` が `.env` に不在
   (キー名のみ確認) のため到達不能。公開面の 404 境界 + fail-closed の
   code 確認まで。standalone suite は install 禁止のため未実行 (CI が実行)。
3. 9/18 PDF の SHA 照合なし。理由: fixture 不在・Notion 未保管 (#117 OPEN)。
   rows=4230 の一致と前週比の全行整合は内部一致どまりで、転記の保証にしない。
4. R2 daily/intra の全銘柄網羅は未検証 (4,444/4,272 件の存在確認まで。
   内容突合せは 7203/9984/3600 + 破損 tail の 1909/2180)。
5. 5y RSI の全銘柄再計算は未実施 (20 標本 + 追補 1。5y closes は D1 非保存の
   ため全件再計算には全銘柄 fetch が必要で、層別標本に限定)。
6. 当日 run (9/28 17:13 UTC stock-sync / 08:00 UTC vwap-ingest) の反映前スナップ
   ショット。F-02/F-05 の自己修復は次回 run の再計算を確認するまで未確認。
7. ir-catalog の recent-high-signal 等、A 担当域の値照合は対象外。
8. 破損保存 run の mode (stocksOnly/full) は D1 からは未確認 (両経路とも
   guard で塞ぐため対応に支障なし)。
9. 2180 の 30 field 独立再計算・w≤40 の EMH momentum・#136 適用後の表示値・
   small-cap/post-earnings 件数の D1 再集計は未実施。
10. F-15 (quoteSummary) の guard は未実装 (照合相手のない設計が要検討)。

## 13. 判定サマリ

| ID | 重要度 | 内容 | 状態 |
|---|---|---|---|
| F-01 | 高→対応中 | Yahoo chart 破損の取込済み (1909 + 2180 同型)・公開表示中 | 本 PR で guard 実装 (§14)。修復は preview のみ、writer 未起動 |
| F-15 | 高→対応中 | Yahoo quoteSummary 破損の取込済み (1909/2180/7426 の cap/PER/EPS)・公開表示中 | 忠実転記を確認。guard 未実装・要 follow-up |
| F-02 | 中 | volatility_ok が旧閾値 (9/25 行 1678 件・誤通過 unique 65 件 + 凍結行 3/1 件) | 次回 run の再計算を確認するまで未確認。preview 済み (§14) |
| F-03 | 中 | JPX syumatsu 発見不能 (次回同状況なら margin 失敗) | 実関数 replay で確認。R2 保全。新様式は 9/29 |
| F-04 | 低 | D1 OHLCV の凍結暫定/NULL (13 日・先勝ち書込) | 誤りリスクとして残す (指標無事とは書かない) |
| F-05 | 低 | prune 飢餓 (3,689 銘柄 >90 行) | 次回 run の再計算を確認するまで未確認 |
| F-06 | 低 | sector 9/22–9/23 の休日 stale 重複 | 読者は最新日のみ。旧 run 由来 |
| F-07 | 低 | LONG/信号の LIMIT 200 を総数表示 | 開示なしの cap |
| F-08 | 低 | 旧信用週の種類株重複 + 7/03・7/10 週欠落 | 9/11 以降は clean |
| F-09–F-14 | 情報 | splits 空・auction 除外・σ 流儀・3853・run 日付ラベル・CAPM 市場ファクト | 記録のみ |

### 優先対応 3 件 (親 review・merge 後の follow-up)

1. **破損値の隔離と表示止め (F-01/F-15)**: 1909・2180 の派生 3 表
   (indicators・rsi_percentile・p_momentum) + 1909/2180/7426 の financials
   破損列 (cap/PER/EPS) が公開表示中。隔離候補は §14 に限定済み。
   本番 apply は writer 返却後の別対応 (本 PR では preview のみ)。
2. **F-02 stale bool の解消**: 次回 run の再計算で治る見込みだが確認待ち。
   run 前に直す場合は §14 の preview 適用 (3 列のみ・冪等確認済み)。
3. **JPX 発見不能 (F-03)**: 次回 margin run が同状況なら失敗。新様式対応は
   9/29 扱い。R2 既存週は保全済み。

独立再計算の実証件数: 観測 16 (RSI 15/15・指標 11 全一致+4 vol・momentum 15/15・
pattern 15 + skip 1) + delist 4 件の 404 整合 + 前週比 12,669 行 (内部一致) +
公開 38 route (値join 23・200-only 9・境界 6)。詳細は §3.2・§9。
丸め・定義差 (F-09–F-14) は記録のみ。

## 14. 再発防止 guard と offline 修復 preview (本 PR の実装)

### 14.1 応答整合 guard (F-01 再発防止)

- 場所: `src/shared/yahoo/bar-sanity.ts`
  (`assertResponsePriceCoherent`・`checkFreshClose`) を
  `src/shared/yahoo/client.ts` の `fetchChart`・`fetchDaily` 両境界と
  `src/cron/daily.ts` の日次 gate から呼ぶ (#136 差分は保持)。
- 述語: 同一応答の最新有効終値と `meta.regularMarketPrice` が 10 倍超乖離
  (`MAX_DAILY_RATIO` reuse) しかつ出来高なし (0/null) の場合のみ応答全体を
  throw。薄商い 0・出来高を伴う急変 (正規分割。30 倍乖離 + 出来高ありで
  受理を確認)・全履歴比較・巨大 split 単独・判定不能 (欠落: null/undefined)
  は拒否しない。実在する数値の無効 (非正・非有限) は欠落と別扱いで拒否する
  (各側を先に独立検査し、逆側 missing 時も通さない)。
- 日次 gate: expectedDate の一致に加え使用値 (`adj ?? close`) の正の有限値を
  要求。共有 helper `checkFreshClose` を N225 session gate と
  `buildSnapshot` の両方で再利用 (rg 全追跡済み)。正当な欠損は未取得扱い
  (throw) で値補完なし。`buildSnapshot` の gate は fetch 直後・
  RSI を含む全 technical 計算の前 (年次 #136 の pick/evaluate は保持)。
- 呼出 trace (rg 全件): `fetchChart` ← `fetchStockRawData` ← `buildSnapshot`
  (+ 日経セッション確認・マクロ文脈の 2 経路も同一 guard 下)。
  `fetchDaily` ← `scripts/vwap/ingest-daily.ts` (R2 daily 書込の手前)。
  `fetchBars5m` は v=0 drop 済みで 1909 形を素通ししない (対象外)。
- 実関数 replay (§15): guard 前は 1909 全 capture が 3 fetcher で解決
  (47 bar・40 破損受理・書込到達可)。guard 後は 1909/2180 が全 fetcher で
  拒否・書込到達 0、7203/3600/9984 が受理、9914 stub は日次 gate へ委譲
  (stale で fail-safe)。review 修正後の offline 再 run は保存結果と
  byte 一致 (非 target 受理を保持)。writer 0。
- durable test: `bar-sanity.test.ts` (述語 20 件 + sanitize 素通しの記録 1 件)、
  `client.test.ts` (fetchChart 3 件)、`chart-bars.test.ts` (fetchDaily 4 件)、
  `daily-mode.test.ts` (session gate 1 件追加)。
  focused Yahoo 59 件 + cron 58 件 = 117 件が緑。typecheck・lint 通過
  (全 suite の再実行は CI に委譲)。

### 14.2 F-02 の offline preview (本番 apply なし)

- 方法: 保存入力 3,756 行を SELECT (read-only) し現行 `screenStock` で再判定。
  私的 node:sqlite snapshot に before/after/diff を保存。日時等その他列は不変。
- 結果: 変化は `volatility_ok`・`all_passed_long`・`all_passed_short` の
  3 列のみ (他 bool 0 件)。9/25 行 1,678/33/32 (全て 1→0)、凍結行 3/1/0。
  long/short 反転集合の重なり 0 (unique 65/66 を検証)。2nd run 差分 0 (冪等)。
- 適用は writer 返却後の別対応。archive 保管も適用時に writer 経由で行う。

### 14.3 1909/2180 の quarantine preview (本番 apply なし)

- 隔離候補 (破損由来が確定した行のみ): 1909 の
  `swing_stock_indicators` (giant SMA 保存値)・`rsi_percentile` (bars=40。
  bad raw full-40 replay で確定)・`p_momentum` (as_of 9/14・bars=40)、
  2180 の `swing_stock_indicators` (giant SMA 保存値)・`p_momentum`
  (as_of 9/15・bars=85。保存 bad 値で確定)。
  2180 の `rsi_percentile` (bars=1217) は保留: corrupt-tail 由来が未証明
  (§3.3) のため確定候補に入れず、限定 predicate から除外する。
  R2 は `daily/1909.json`・`daily/2180.json` の末尾 22 本 + 偽 split
  (§4)。financials 破損列 (F-15) の列単位隔離は範囲外・要 follow-up。
- 除外 (証拠付き): `swing_entry_signals` は 1909/2180 とも 0 行。
  otakara は 1909 が 5 月由来の clean 値 (ma25=2892.8・dataDate 5/17)、
  2180 は行なし。7426/3480 の派生行は stale だが正常値。
  正常な daily ohlcv・master は維持。core_financials の「正常」とは
  F-15 未破損 column (pbr/bps/roe/roa/配当/営業利益率) の意味に限り、
  F-15 の bad cap/PER/EPS (1909/2180/7426) は未修復のまま保持する。
  推定補正 (正しい current raw がない) は禁止どおり行わない。
- 消費契約 (code 確認): swing 詳細は indicator 欠落を null/— 表示
  (`pages.ts` の `?.` + view の fmt ガード)、rsi 詳細は `rsi: null` で判定不能
  表示 (`stock-detail-service.ts` + view)、screening 一覧は行不在で除外
  (FROM 派生表)、EMH momentum は投影行不在で除外。
  snapshot→missing 表示→冪等の preview は私的 sqlite で実施済み
  (2nd run 差分 0)。review 修正時は guard replay の offline 再 run で
  1909/2180 拒否・非 target (7203/3600/9984) 受理を保持し、F-02 preview
  結果は不変 (screenStock・保存入力とも本修正の対象外。2nd run 0 を維持)。
  本番 apply なし。

## 15. 私的 script・capture の inventory (再利用・使い捨て禁止)

`/tmp/audit-b/` 配下 (0600 等)。repo には path・SHA・command・要約のみ記録し、
secret・署名 URL・raw 全体・private Notion ID は含まない。
SHA は省略形ではなく 64 桁全文を既存 artifact から記録する。

私的再現制約: script・capture は私的配布なし (`/tmp/audit-b/` にのみ存在)。
replay/preview 系は監査 worktree の path を hardcode しているため、
第三者がそのまま実行できるとは言わない。command・保存 inputs・
full SHA の整合は下記のとおり。

### script (S-01–S-09)

- S-01 `replay-1909-guard.mjs`
  SHA256: `1786418f7f211598e5c91cb18b56b72d4a53aee4923a014b3bec2d08b4979e93`
  実行: `<worktree>/node_modules/.bin/tsx /tmp/audit-b/replay-1909-guard.mjs`
  要約: 実 fetcher replay。guard 前: 1909 解決 (47 bar・40 破損)。
  guard 後: 1909/2180 全拒否・書込 0、7203/3600/9984 受理、9914 委譲。
- S-02 `preview-repair.mjs`
  SHA256: `6751028188e074762ccc7b2a199915bec9bc3adc6e47d6ee30e1926a5d39971b`
  実行: 同 tsx で実行 (D1 SELECT 9 文。非 SELECT は機械的に拒否)
  要約: F-02 全件再計算 (3 列のみ・1678/33/32+3/1/0・2nd run 0) +
  quarantine 候補 + 例外 5 件の分類。
- S-03 `replay-jpx-margin.mjs`
  SHA256: `3c26f79c2de8ef935c545c9c8a5989d59bf3cf0753cd48586c2656ab2f52d035`
  実行: 同 tsx で実行 (引数に HTML)
  要約: 実 `latestMarginPdfUrl()` が保存/ fresh 05.html で throw。
- S-04 `compare.mjs` (= part1+part2。既存)
  SHA256: `cc88b4bb970f4797bb9c200ba6b75885b614f34d4d4672cfa34cf94570986ef2`
  実行: `node /tmp/audit-b/compare.mjs`
  要約: 層別 20 の独立再計算。rerun で母数確定 (§3.2)。
  rerun log `compare-rerun.log`
  SHA256: `c5cced611e3fde5e5794593df5fe491ab1d1e5bee30bd0e56435381f18f52891`
- S-05 `fetch-qs.mjs` (既存)
  SHA256: `023f206ee48f9b5219fbd181b6537482a5e4a9c7d8ed9e9065139a4ff0d16a74`
  実行: `node /tmp/audit-b/fetch-qs.mjs <code>`
  要約: quoteSummary 観測。1909/7426/2180 で shares 1 桁を確認。
- S-06 `fetch-yahoo-one.mjs` (新規単発)
  SHA256: `c0eb8c68bcc173c98e59d5297e6cddff33ec2f7e1e8cfa2bd520c61759746d4d`
  実行: `node /tmp/audit-b/fetch-yahoo-one.mjs 2180`
  要約: 2180 chart 47 bar の観測 (全再 fetch 回避)。
- S-07 `fetch-public3.mjs` (新規)
  SHA256: `01eb3fbc5db8d4e5742749178f771c2b58b70b2717894df6df18e218bba822b9`
  実行: `node /tmp/audit-b/fetch-public3.mjs` (≤1rps)
  要約: EMH 2 tab + otk/ir/yuho root の GET。
- S-08 `follow-exceptions.mjs` 他 5 件 (新規)
  SHA256: `follow-exceptions.mjs`
  `7f2a6da74a0361b48c7f146506a530c580ac4a6934a51f3ccd78a8810a44c0fc`・
  `follow-capdist.mjs`
  `ddfc7ceb741aaf0a0f06874bc8572dfa426bc43c4e5edfdfa1bba4cef123759e`・
  `follow-sig2180.mjs`
  `dae5f000604855644fde9e7cf410610569406b6fdbb2e476082bcbcab676d5a3`・
  `follow-rsi3.mjs`
  `fa8f1171cbc6eb73b6a547a9b0218f27f3f2dae82017a5299e1469f0d3b2f31a`・
  `follow-prov.mjs`
  `95bda6aac2147efe1ae9967026f66dca8c2d3cae903a69c93dd9e9d7dcf3c710`・
  `follow-indts.mjs`
  `ee58e11b65e094baf73e7a7d12ae8a19b5fa545bbd19ad89b1f468dd3af56742`
  実行: 同 tsx で実行 (各 2–4 SELECT。非 SELECT は機械的に拒否)
  要約: 例外断面・cap 分布・provenance の確定。
- S-09 `r2read.mjs` (既存)
  SHA256: `f7d6c08c64889d80229e23db8d58192feb9d43ce44cf727db2e7a7b55819e3e0`
  実行: `node /tmp/audit-b/r2read.mjs get daily/<code>.json <dest>`
  要約: R2 daily の 1909/2180 破損 tail 確認 (§4)。

### capture・result (全文ではなく SHA のみ)

- `yahoo-5y/1909.json`
  `259c2581532d1ac046352c4660851a52e57d5ece74ca06370caf6dab50115e03`
- `yahoo-5y/7203.json`
  `0db61a252127532d33ae2c486836fd7e5aad5adf17c223903c9e2c36d3a0f023`
- `yahoo-5y/3600.json`
  `f16d885bd1525c6fdabad4755513baca14376433b7203640cd08ebb1d9f77104`
- `yahoo-5y/9984.json`
  `06b44e798fdbc669a618f6f5f64d59ec86fe2bb4b916674c34f6e518ac01234f`
- `yahoo-5y/9914.json`
  `18287074fae72a50c16881c481fa9996b4d273143f3afa0860247747c53b1c64`
- `yahoo-5y/2180.json`
  `77a8c1c34ea551b53a62b2fd8434cb3f68553f2c5ae8a22020a409b1d97590d2`
- `qs-1909.json`
  `c811d931660dfd77c37c8a05b1a009376f0d47a134495623bdfd35ddcb40dc19`
- `qs-7426.json`
  `a6bdbfe798af6757fb890a9590afdc4109f5ffbf3d5dcd2a2cb3e665848a9d9d`
- `qs-2180.json`
  `f411855281ecd8009a09afc4750d1d0aece3ab7ecdb081f743406d6ad7d483e2`
- `jpx-m02.html` = `jpx-m03.html` = `jpx-m04.html` (同一)
  `b125474612e15be33c0ba12fd3b0fc0a826a3047c415e19b885be21fdd99eff9`
- `jpx-margin-page.html` = `jpx-05-fresh.html`
  `cd2748a59334903ba08e24bf05965680317404afeb054ef41d755f12b3366493`
- `r2/daily-1909.json`
  `c16fa1514e7e4639e8a74f1f422a9dffb114248c74c4f3034ad07f22c2f2f5a4`
- `r2/daily-2180.json`
  `7f3cb7ac7126ca07a2011783211215d384e6036c19f30ee0e2b47077288507c8`
- `replay-post-guard.json`
  `862bfe8a8b456d4c2cfdc4831581b95a37a1a4d8044eed7fb6444ec99222c92c`
- `preview-repair.json`
  `1d25cd638ea5f4f3a615911048a56f35724e14662368dfbd388af09a33f5763c`
- `preview-repair.sqlite` (私的 snapshot)
  `ed55af31d432dce3353caa43c01ff095345d829cd95ed0efce8fce67f3485d24`

原本 URL 形: `https://query1.finance.yahoo.com/v8/finance/chart/<code>.T?range=5y&interval=1d&events=split%2Cdiv`
(中継経由)、`https://www.jpx.co.jp/markets/statistics-equities/margin/05.html`
(直 GET)。

