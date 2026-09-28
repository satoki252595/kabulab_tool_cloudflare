# 市場系保存の根本原因修正と隔離検証（2026-09-28）

市場監査（`data-audit-market-2026-09-28.md`）の残存 finding のうち、
本 lane が所有する共有境界（§1〜§7）の根本原因を code/隔離 stage で修正した。
9/29 延期（JPX 新様式・信用残日次化の 2 件）と、所有外の同型
（rsi-screening・yuho-quant の COUNT/表示。§3・末尾の依頼節に記録）は
本 log の対象外。source への適用は未実施（各節の plan どおり、要 writer 枠）。
本番 D1/R2/Notion への書込・archive・normal job 起動は行わない。
base `origin/main` = `e5e80c6` (#157)、branch `fix/market-storage-root-causes-20260928`。

私的証拠は `/tmp/market-fix/`（0700/0600）のみ。`/tmp/audit-b/`・`/tmp/d-audit/`
の既存 artifact は読取再利用し、1 バイトも書き換えない。
`results.json`・`render-data-audit`（#153）には触らない（正本競合なし）。

## 1. ATR bool stale（F-02）— 3 列の正規再計算経路

- 根因：#135（閾値 0.02→2%）の merge が最終データ run より後で、
  保存 bool が旧閾値のまま。数値列（atr_pct 等）は正常で bool のみ stale。
- 正規再計算単位：既存 `screenStock`（`src/shared/screener.ts`）。
  呼出側は `src/cron/daily.ts` の `buildIndicatorRows` のみ（rg 全追跡済み）。
- 修正：`diffStaleScreeningFlags(input, saved)` を追加。保存入力から
  `screenStock` で再計算し、stale になりうる 3 bool
  （volatilityOk/allPassedLong/allPassedShort）だけ返す。
  他 bool・数値列は触らない。`changed=false` の行は書込対象外。
- 隔離検証（D1 SELECT 2 文＋私的 sqlite）：現本番 3,754 行（#152 で
  1909/2180 指標行を削除済み）を全件再計算。変化は 3 列のみ
  （vol 1,681/long 34/short 32、他 bool 0 件）、long/short 反転の重なり 0、
  fresh（9/25）33/32・全体 34/32、2nd run 差分 0。#149 preview と一致。
- source 適用 plan（未実施・要 writer 枠）：物理退避→対象行の全列 CAS 読取→
  3 列のみ条件付き更新→実再読→再実行 0。次 normal job（9/29 以降の日次）が
  全行を `buildIndicatorRows` で書き直すため、job 後の再計算で
  changedRows=0 になることが成功基準。直接修復と job の二重適用は冪等で安全。

## 2. bluechip/trend（#136 切替差分）— 正規再計算単位の選定

- 正規再計算単位：`buildSnapshot` 内の `pickAnnualSeries`＋`evaluateBlueChip`
 （`src/cron/daily.ts:1155-1159`）→ `buildRsiRows` が
  `is_blue_chip`/`revenue_trend` を upsert。呼出側は日次のみ。
  Yahoo 年次の再取得は再計算の代用にしない（入力は jss 正本のまま）。
- 修正なし（既存単位を選定）。最新原本・period・scope・reader を維持。
- 隔離検証（D1 読取なし・`/tmp/d-audit/compare.json` の再導出）：
  全 3,810 行で flag 反転 690 件（false→true 398/true→false 292）、
  trend 行列・保存一致（flag 3,063/3,756・trend 2,232/3,756）・
  旧再計算の保存代理精度（99.8%/99.2%）を再現。20 層別 case の全理由
  （年欠落・期変更・不明・窓内 null・うるう対）は既存テストで網羅済み。
- source 適用 plan（未実施）：次 normal job で保存 bool が新値へ更新される。
  成功基準は job 後の保存 vs 新再計算の flag 一致 ≒100%（残差は job 以降の
  annual 更新分のみ）。限定 apply が要る場合は is_blue_chip/revenue_trend
  の 2 列 CAS 更新＋再実行 0。

## 3. LONG/signals LIMIT 200（F-07）— COUNT と表示の分離

- 根因：`services/swing-trading/src/routes/pages.ts` の screening/signals が
  `.limit(200)` の `rows.length` を `totalCount` に渡し、頭打ちが全件数に見えた。
- 修正：同一 where の `COUNT(*)` を別途発行し総数とする（CROSS JOIN 順序維持）。
  view は `rows.length < totalCount` のときだけ
  「先頭N件を表示（全M件）」を明記（旧値 218/303 の hardcode なし）。
  LONG/SHORT・シグナル数に共通 `termTip` を付け、`TERM_TIP_STYLES` を
  swing layout に注入（ルール7・新規 `.tip` 定義なし）。
- 同型調査：rsi-screening の `${results.length} HITS`（limit/offset 付き）、
  yuho-quant の `/api/screening*`（`count: rows.length`＋`opts.limit`）も同型。
  いずれも本 lane の所有外のため修正せず、owner 決定を root へ依頼する。
  （追記 9/28：別 lane が本 branch 上で対応。完了・検証の正は当該 lane の報告）
  financial-math EMH（totalMatched/表示分離）と ir-catalog（別 COUNT）は正形。
  swing dashboard の母集団なし COUNT は意図的（rows_read 抑制・コメント済み）。
- 隔離検証：view 5 件＋実 SQLite の app-level で 201 件通過→「全201件」＋
  「先頭200件を表示」＋表示 200 行を固定。保存行への変更なし（COUNT は読取）。
- 実値 UI 確認 plan（deploy 後）：`/screening?direction=long|short` と
  `/signals`（all＋各 pattern）を取得し、総数＝D1 同一 where 集計・
  表示≦200・注記の有無が一致すること。

## 4. historical NULL 13 日（F-04）— 訂正再送の共有 upsert 修正

- 根因（2 段）：(a) `fetchChart` は null バーを保持し、`buildOhlcvRows` の
  増分フィルタ（`date > existingMaxDate`、MAX は indicators.latest_date 由来）は
  保存済み NULL 日を二度と再送しない（先勝ち凍結）。R2 経路（`fetchDaily`）は
  null バーを落とし日付マージで自己修復するため R2 のみ正常。
  (b) 当時の入力異常（Yahoo 側の一過性 null を取込）自体は過去応答がなく
  上流形状は未特定。書込機構と凍結機構は実証済み。
- 全日/全銘柄抽出（D1 SELECT 6 文＋Yahoo 2 GET）：361,284 行・
  close-NULL 27,014・116 日。300 超の大量日は監査どおり 13 日
  （8/03・8/04・8/07・8/13・8/14・8/17・8/18・8/19・8/24・8/25・8/27・
  8/31・9/01）。重なり検証で全 null 6,325 行＋close のみ null 20,689 行の
  2 系統に分離。銘柄別は 3,749 銘柄、上位は廃止凍結銘柄。
- 分類（7203/9984/3600 標本＋fresh 7203 原本）：
  N=入力異常 NULL（R2=fresh が一致し値を証明）23/23 標本、
  R=遡及訂正凍結（D1 旧値・R2=fresh 新値、8/07・8/27・8/28・9/01 の 8 件標本）、
  G=真正欠損（fresh も null）は標本 0 件。
  fresh と R2 の一致は探索 116/116。機械一括の NULL→値置換はしない。
- 修正：`loadNullCloseDates`（1 文）で保存済み NULL 日を集め、
  `FlushItem.correctionDates`→`buildOhlcvRows` で「fresh に実終値がある
  保存済み NULL 日」だけ再送する。fresh も null の日は NULL のまま残し、
  保存済み有効値（R 系）は自動で書き換えない。初回/回収パス両対応。
- 隔離検証（私的 sqlite）：全 27,014 行の round1 で active+equity 26,327 行が
  訂正対象、round2 残 0。残 687 行は非 active/非 equity の凍結（対象外を維持）。
  他表・他列への波及なし（ohlcv upsert のみ）。単体 4 件で再送/非再送/回収継承を固定。
- R 系の扱い（未実施）：保存有効値の書換えは normal run では行わない。
  別途 raw 証跡（R2＋fresh 一致＋事由）つきの限定修復 plan とする。
- 次 normal job の成功基準：active+equity の close-NULL 残≒0
  （fresh-null の真正欠損のみ残る）。`loadNullCloseDates` 件数の単調減少と
  書込増分（初回のみ約 26k 行）が想定内であること。
- 注：指示文の「D1/Yahoo 差 72038/7」は到達可能な証拠（本 repo・/tmp 両監査）
  に存在せず再現不能。本 log の実測（27,014 NULL・標本 R 8 件）を正とする。

## 5. R2 splits[]（F-09）— 窓マージ

- 根因：`scripts/vwap/ingest-daily.ts` は bars を日付マージするのに splits を
  1mo 応答で全置換し、窓外の分割履歴を消した。`fetchDaily` の唯一の本番
  呼出は同 ingest。repo 内読者は `/api/daily` 素通し（front は adj/c のみ使用、
  splits 未使用・実証済み）。repo 外 2 件の splits 依存は未確認のまま。
- 修正：共有純関数 `mergeDailySplits`（`scripts/vwap/lib/daily-merge.ts`）を
  追加し ingest に接続。窓外の既存イベント保持・窓内は fresh が正
  （新規・訂正・陳腐落とし）。bars なし応答は従来どおり書込見送り。
  schema `{code, updated, bars, splits}` は不変（G1 順守）。
- 隔離検証：実原本（7203 の 5:1・ts 1632873600→2021-09-29）の窓外保持、
  窓内訂正・新規・陳腐落とし・整列一意・冪等（2nd run 0）の 7 件。
- R2 棚卸し（GET 4,444・LIST 一式・読取のみ）：4,428 が splits 空、
  16 が 1 件（整数比の plausble 8 件＋1e-6〜1e-8 級の偽 family 8 件：
  2540/4556/4659/4974/6403/6670/7999/9927。1909/2180 型と同型の疑い）。
  6576 の 1 オブジェクト欠落は次回 backfill で自己回収。
- 偽 family 8 件は隔離候補として報告のみ。除去は Yahoo events の raw 証明＋
  exact-SHA CAS の別途 source 対応とし、本 merge で undo/再混入しない。
  #152/#154 の 1909/2180（2501/2502 本・splits 空を確認）は再修復しない。
- 空母集団の回復 plan（未実施）：10y 再取得の対象別 backfill
  （各 fetch が自証明。真正「分割なし」は空のまま誠実に残す）＋
  R2 条件付き PUT＋物理退避。実行は writer 枠・Yahoo 負荷配慮で別途計画。

## 6. prune 飢餓/休日 sector 重複（F-05/F-06）— 取引日キーと N225 照合

- 根因（2 段）：(a) 週1ゲート（prune・年次）の月曜判定を Phase 実行時刻で
  評価していた。旧 21:00 UTC 日程の開始遅延で Phase 4 が火曜に落ち、
  月曜限定 prune が毎週 skip されて 3,689 銘柄が 90 本超過まで飢餓。
  (b) sector/market 表の行キーが実行日で、休場・再実行のたびに重複 snapshot
  が増えた（9/22・9/23 sector 行が 9/18 集計の複製）。run 開始日への固定だけ
  では休場 snapshot の根因は残る（GPT-sol review 指摘）。
- 修正：(a) `runDateKeys(startedAt)` に一本化し、writeAnnual・prune ゲートを
  run 開始時刻に固定（scheduling 系。キー系と独立）。
  (b) sector 行キーは `loadIndicatorsMaxLatestDate`（実データの取引日）。
  再実行は同一取引日キーへ畳まれ、実行日キーで増えない。
  (c) market 行は N225 の実バー日と run 日が一致するときだけ書く。
  不一致（休場・取得遅延・N225 取得失敗）は書かず前回値を残す。
  曜日の推測もカレンダーも使わない。一致するとき run 日≡取引日。
- 休日行：既存の 9/22・9/23 sector 重複は旧無 guard run 由来で削除しない。
  全 ingest rerun も代用にしない。
- 隔離検証：`runDateKeys` の日跨ぎ 2 件、loader MAX/空/再実行畳み込み 3 件、
  N225 不一致 skip 1 件。既存 cron の退行なし。
- 次 normal job の成功基準：月曜 run で prune が実行され（prunedStocks>0）、
  90 本超過銘柄が 0 へ収束すること。sector/market 行の日付が実データの
  取引日と一致し、休場日は skip ログのみで前回値を残すこと。
  非月曜は prune skip ログのみ。

## 7. 旧 Yahoo 年次 writer（daily.ts 1236/1584 付近）— 維持の確定

- 全 caller/contract 確認：writer（`buildAnnualRows`＋flush annual spec）は
  月曜 run のみ `core_stock_annual_financials` へ Yahoo 年次を upsert。
  fetch（`fetchStockRawData` の annual）は writer が消費し、未使用 fetch なし。
  repo 内読者はなし（001 詳細は #136 で jss へ移行済み。旧
  `blue-chip-filter.ts` は既に除去済み）。
- 外部 consumer（株ラボ-Youtube の `annual_revenue()`・新高値検証）の移行は
  未確認。governance（`CF-CANONICAL-DESIGN.md:954`）は DROP を移行完了後の
  別チケットと定める。よって writer/fetch/表を維持し、削除しない。
- 実証済みの不要コードはなし（差分なし）。削除依存の記録として本節を残す。

## 他 lane への依頼（root 宛）

- rsi-screening と yuho-quant の同型 COUNT/表示：owner 決定を依頼（§3）。
- R2 偽 splits family 8 件の raw 証明＋CAS 除去：source lane へ（§5）。
- R 系遡及訂正（D1 旧値）の限定修復：要否判断を root へ（§4）。
- `results.json`/正本 report には触らず。manifest 競合なし。

## 検証

- 全 203 files 2902 件が緑（386 skipped・0 failed。対象回帰＋audit render 含む）。
- `tsc --noEmit` clean、`eslint src services --max-warnings=0` clean。
- 本番 D1/R2/Notion への書込 0（D1 SELECT 12 文・R2 GET 約4.4k＋LIST・Yahoo 2 GET のみ）。
