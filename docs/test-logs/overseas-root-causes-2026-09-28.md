# Lane A: 海外59件の根因・分類・修復 (2026-09-28)

`yuho_overseas_facts` 3675文書のうち地域計≠海外売上高の59文書 (327 facts) について、
原本 (EDINET type=1) の純 replay で全件の機構を個別実証し、共通境界の修正と
実原本回帰を残した。59件を1原因扱いにせず、原表構造の家族分類ごとに回復可否を分けた。
母集団 reparse では59件以外にも dup なし live 誤 pick (生産・資産・減損表) を検出し、
同一基準で修正・検証した。

- 対象: `services/yuho-quant/src/services/overseas-parser.ts` + 取込/保存 caller
  (`ingest.ts` / `backfill-overseas.ts` / `backfill-missing-docs.ts`) + EDINET client +
  #98 catchup 実 caller (`scripts/sync/yuho-edinet.ts` / `src/cron/yuho-edinet.ts`)
- ブランチ: `fix/overseas-root-causes-20260928` (origin/main ae4aa34 から作成)
- 本番 D1/R2/Notion 書込・原本 archive・ジョブ起動は writer gate 待ち
  (本 stage は code + 隔離検証まで。適用計画は §7)

## 1. 全59件の機構実証 (旧 parser + caller dedup で 59/59 完全再現)

保存行は全件 #150 以前の parser の出力であることを、各文書の原本 ZIP (sha256 確保)
への純 replay + 取込 caller 等価の `(fiscalYearEnd, regionName)` 先頭採用 dedup +
toYen で証明した。比較は保存行の 7 列 (fiscal_year_end/region_name/region_kind/
sales_yen/unit_label/is_consolidated/pattern) の多重集合一致で、59/59 が完全一致。

共通機構: **aggregate-before-dedup** — parser が同一表内の重複地域名を複数値で出し、
`海外売上高` 集計を dedup 前の水増し合計で確定させ、caller の dedup が2番目以降を
落とすため、保存後に `SUM(overseas) < overseas_total` の乖離が残る。全59件が
DROP 方向 (sum<total)。EXTRA 方向 (sum>total) は0件で、旧行残存・二重書込の形跡なし。

## 2. 原表構造の家族分類 (17家族・59件) と回復

| # | 家族 (代表doc) | 件数 | 原表の真構造 | 保存ot/total | 正回復 (証明) | pattern |
|---|---|---|---|---|---|---|
| 1 | 7277 (S100J2E7) | 4 | 販売実績 2-D (地域×品目) + 合計 | 正 | 品目合算/地域 (合計一致) | P-2D |
| 2 | 7203 Toyota (S100DA2Y) | 11 | 売上block + 営業利益block 積層 (`計` のみ) | 誤 (混算) | 売上block + 消去考慮検証 | P-block |
| 3 | 2802-hier (S100DDYF) | 6 | 2階層 geo_cols (親アジア/米州 + 子) | 正 | 親 grouping 合算 | P-hier-cols |
| 4 | 2802-AO7M (S100AO7M) | 1 | 年金資産表を誤pick (真表は #3 同形) | 誤 (年金値) | 非売上却下→#3表へ | R1-head + P-hier-cols |
| 5 | 4041 (S100OJV9) | 5 | 2階層行ラベル (親`海外` + 子アジア等) | 正 | 子ラベル読替 | P-hier-rows |
| 6 | 8946 (S100QIEX) | 5 | 収益block (契約 + その他収益) + 小計 | 正 | block合算 (小計証明) | P-block |
| 7 | 5013 (S100OE0P) | 5 | 生産実績 vs 販売実績の同点 tie | 誤 (生産値) | 販売実績表 | B2 |
| 8 | 9147 (S100VI7V) | 7 | 地域×項目 (売上高/営業利益) 対 + 年列 | 誤 (混算) | 売上行のみ。合計なし→null | P-metric |
| 9 | 4082 (S100OE1D) | 2 | 地域block + 用途別block (`その他` 混入) | 誤 (混算) | 地域市場blockのみ | P-block |
| 10 | 6391 (S100OH3F) | 3 | 地域block + 財block + `中近東` 未認識 | 誤 (混算+脱落) | 地域block + 語彙追加 | P-block + lex |
| 11 | 5988 (S100YDNF) | 1 | 財block + 地域block (`その他` 重複) | 正 | 地域blockのみ | P-block |
| 12 | 6324 (S100YBHC) | 1 | 生産 vs 販売 tie + 双方2-D | 誤 (生産2-D値) | B2で生産殺→販売2-D | B2 + P-2D |
| 13 | 2124 (S100NPNR) | 2 | 減損損失表 (非売上) | 誤 (全部) | なし (却下が正) | R1 (真unsupported) |
| 14 | 3681 (S100T6Q9) | 2 | 減損損失表 (非売上) | 誤 (全部) | なし (却下が正) | R1 (真unsupported) |
| 15 | 6072 (S100W64J) | 2 | 減損損失表 (非売上) | 誤 (全部) | なし (却下が正) | R1 (真unsupported) |
| 16 | 9843 (S100R1N2) | 1 | 減損損失表 (非売上) | 誤 (全部) | なし (却下が正) | R1 (真unsupported) |
| 17 | 8570 (S100Y53G) | 1 | 3階層 geo_cols (親国内/海外 + 子) | 正 | 親 grouping 合算 | P-hier-cols |

最終 disposition (現 parser replay): **52件が内部整合 ok** (#1–#12, #17。保存値と
異なる=正値へ是正) + **7件が正直な未対応** (#13–#16。5件 no_overseas_table +
2件 unstructured。売上開示なし・却下が正)。

## 3. 共通境界の修正

- **B2**: 見出し最寄り表題語が `生産実績` の表を候補から除外 (#7/#12。5013系)。
  `isProductionTable` + fixture 3件。
- **P-2D/P-block/P-hier/P-metric**: 証明つき構造回復。block 小計・`計`・消去との
  照合が取れた表だけ ok とする (取れない表は却下。捏造なし)。
- **共通保存前検証** `validateOverseasSaveSet`: 3 caller (ingest + 2 backfill) の
  先頭採用 dedup を撤去し、共通境界で重複/単位/期末/連結混在・集計/比率/総額を検証。
  壊れた集合は `parse_error` + 空保存。
- **語彙**: `アセアン` (10文書で脱落を実証)・`中近東` (#10) を海外地域に追加。
- **section 標識**: `製品ライン` を非売上 section に追加 (NOK系7文書。`主要な製品
  ライン` block の `その他` 混入を除去。当初 `製品` は S100YR3G の表題
  `[表2]エリア別製品販売状況` を誤殺したため `製品ライン` に限定。両方 fixture 化)。
- **消去/調整**: `調整額` を消去行に追加 (9文書。VYJU: 109281+1766=111047≈111050)。
- **R1-heading**: 見出し最寄り metric 名詞が `非流動資産`/`減損損失` の表を除外
  (dup なし live 誤 pick。G2DL: 約2兆円の資産額が連結売上高として保存されていた。
  J2FF/L227/VYQN: 減損表。「記載を省略」文中の名詞は不開示として除外し、
  S100QHOQ の当期売上表 (P/L 90 と一致) の誤殺を防ぐ。AJAN/QHOQ で固定)。
- **R1-grid**: 表頭 (先頭2行) に `減損損失`/`非流動資産` がある表を除外。入れ子
  内側表は見出し窓に表題が入らず heading-R1 をすり抜けるため (S100O4SN で実証:
  内側表の窓は style 屑+単位のみ。減損額 476690 を連結売上高にしていた)。

## 4. 全母集団調査 (3675文書)

### 4.1 SQL 全件 (D1 read-only)

- ok 文書 = 3675。facts 21258行。
- fullkey 再集計の違反は **59件のみ** (全件 DROP)。EXTRA 0件。
- (document, fy, region) 重複 0件。status↔pattern 不整合 0件。

### 4.2 原本 reparse 走査 (3675件の type=1 を取得・sha256 確保。未 archive を記録)

最終 parser の内訳: ok_geo_rows 2585 + ok_geo_cols 979 + unstructured 63 +
no_table 48。保存一致 2871 / 不一致 804。

round-1→最終の反転 **171件は全件個別に原因帰属** した (R1-only parser との
3者比較で機械帰属 + 全件の原表確認):

- R1-heading 119件: 非売上表の除外・売上表への乗換 (G2DL/AOJX/DF5F 等の資産→販売
  乗換 55件、単独非売上表の除外 56件、J2FF/VYQN 等の正直な未対応化 8件)。
- R1-grid 26件: 入れ子・表題なし非売上表の除外・乗換 (9UK1/CJ9O 等の資産表、
  壱番屋系減損表、ツバキ系8件の資産→販売乗換)。
- LEX 26件: アセアン10件・製品ライン7件・調整額9件の回復 (いずれも開示小計と照合)。
- 過程で検出した誤殺2件 (YR3G・QHOQ) は修正 + 回帰 fixture 化。再検証で他に
  誤殺なし (修正前後の差分は該当2件のみ)。

804件の不一致の内訳 (適用計画用): B2生産→販売 521 + R1-head 119 + R1-grid 26 +
LEX回復 26 + round-1合計のみ是正 32 + 旧来不一致 80 (59違反を含む)。

### 4.3 すり抜け調査 (R1/B2 の完全性)

- R1: 最終 ok 全件の採用値を含む表を走査。非売上単体表の採用は 0件
  (残りは売上 block を含むセグメント表のみ)。
- B2: 生産高表頭 + 採用値一致の表は 0件 (3557 ok 全件)。B2 の入れ子すり抜けなし。

## 5. #98 catchup 失敗の分析と正規 job 再実行手順

- run 36156111106 (9/25 15:43Z): TDnet 成功後、`pnpm ingest:yuho-edinet` が開始
  4分後に旧トリガの undici fetch で `fetch failed` / `ECONNRESET`。
- #134 (merge 済) が node:https 単発 + 600秒期限 + 可視失敗へ置換。再発評価:
  trigger→Worker は #134 で修正 (post-#134 成功は定期実行で初検証)。
  Worker→EDINET は retry なしだが 60日窓 + docId 冪等で自己回収 (#98 と無関係。
  改変なし)。Worker→Notion は共通 retry 使用済み。
- 再実行手順 (root 承認後): 平日 11:00Z 定期実行 (~15:30Z 発火) を待つ。
  失敗時は `gh run view --log-failed` で段階特定 (期限切れ→shard 分割、
  HTTP/要求エラー→自己回収 or 手動 dispatch)。保存再読は Worker 応答 JSON と
  D1 `yuho_documents` + Notion key=docId 照会で確認。

## 6. 修復適用計画 (writer gate 後の root 承認実行用。書込なし準備)

対象: §4.2 の804文書 (59違反を含む)。方針は「全件を現 parser の reparse 値へ」
(ok→正値、非ok→status + facts空。誤値の放置より正直な未対応)。

1. 前提: 本PR merge + デプロイ後の parser で804件の reparse 値を確定
   (値は本分析 + 隔離検証で固定済み)。
2. CAS: 文書ごとに現 D1 行を退避読取し、本分析の保存値と一致確認後に置換
   (不一致は hold)。手順は backfill-overseas と同一。
3. 退避: 置換前の facts を別 table/JSONL へ退避 (格納先は root 指定)。
4. 検証: 置換後に fullkey 再集計で違反 0 + 母集団違反 0 を再確認。
   2nd run (同一 reparse 再実行) で差分 0。
5. 原本 archive (提案・未承認): 新取得 type=1 は rule6 の物理 archive 対象。
   `recordPrimaryData` による archive-only 計画を別途提案 (facts 補修とは別 gate)。

## 7. 検証

- `overseas-parser.test.ts`: **50 tests green** (実原本 fixture 16表。B2/R1/語彙/
  調整/誤殺防止の回帰を含む)。
- `overseas-repair-isolation.test.ts`: 隔離 D1 での原本→保存→表示 + 再実行不変
  (OE0P 販売値回復・T6Q9 売上表なし化)。green。
- `services/yuho-quant`: 44 files / **497 tests green**。repo 全体:
  196 files / **2794 passed** (385 skipped) / 0 failed。
- `tsc --noEmit` clean。`eslint src services --max-warnings=0` clean。
- 旧 parser replay 59/59 保存再現 (機構証明)。現 parser replay 52 ok + 7 未対応。

## 8. 成果物・証拠の所在

- 原本 ZIP: `/tmp/overseas_laneA_raw/<docID>_t1.zip` (3675件。0600) +
  `manifest_full.json` (sha256)。未 archive (正直に記録。§6-5 の計画待ち)。
- 調査: `/tmp/overseas_laneA_replay3.json` (現行59件)・`oldreplay.json` (旧59/59)・
  `fullscan.jsonl`・`fixup5.jsonl` (最終3675)・`savedfacts.json` (21258行)・
  `diff147.txt`・`r1audit2.txt`・`attr.txt` (171件の帰属証拠)。
- fixture: `services/yuho-quant/src/tests/fixtures/georows-*.html` (実原本切出し)。

## 9. 残課題・申送り

- Tier 3 の7件 (減損表系) は売上開示なし。却下 (facts削除) が正しいが最終判断は root。
- VYJU: 本文の海外売上高 77,128 と販売表の導出値 53,994 が不整合 (発行者開示の問題。
  表内整合を契約として採用)。表示側への申送り要否は root 判断。
- 同一値双子文書あり (G2DL/GO7J、I54Q/KZTZ、YCBI/YJ3O 等。訂正版等の重複登録と推定。
  保存値の重複検証は lane 外)。
- `事業収益合計` (YR3G) の集計名詞化は見送り (fallback 合計で読める。改善余地)。
- 新取得原本の archive-only 計画 (§6-5) は root grant 待ち。

## 10. Round-3: F1–F8 follow-up + FIX-A–H2 (同一ブランチ継続)

### 10-1. 期間29件の全件根因 (fixup8→trace2 CAND)
- F5-ok/N-ok 値違い 29件を CAND 単位で全件照合: 真の期間勝ち 12
  (F5=前期表・N=当期表。採点の当期+4/前期-6 が系統的に正しい)、
  F5-invalid-pick 6 (N=単一正規候補)、同表行parse差 10 (F1 注除去/F4
  segment-その他除外/連結優先で N が正しい)、F2-EMEA回復 2 (AI6T/ARDL:
  F5=非流動資産表の誤採用、N=顧客所在地別収益表)。
- G3BR/G9OV のみ N-miss: 当連結セグメント表 (score 12) が正準の
  (4)地域に関する情報表 (score 10) に勝ち、非地域その他 7,880 を含む
  セグメント切りを採用 (domestic+overseas_total≠total の Δ7,881 不整合。
  c3 は完全整合)。→ FIX-D (正準ブースト)。

### 10-2. FIX-A–H2 (全て実原本で機構実証)
- FIX-A 総額列検出 (FHUH): 連結列「連結損益計算書 計上額」・計列「計」を
  拾う共通正規表現 `RX_TOTAL_COL` (cols 2箇所 + rows 値列1箇所)。
  副作用の複数集計列 (合計+連結併記) は連結優先で解消 (OC7S/R4LB/TSO2
  の後退を回復。fixture 固定)。
- FIX-B F7 裁定 (R9AG/PV48): 葉和≠開示小計のとき開示総額を裁定者にし、
  開示小計が総額と整合すれば葉誤記として採用 (R9AG: アジア 5,793 vs
  5,973、総額 29,461 と Δ2)、不整合なら却下維持 (PV48: Δ9002)。
- FIX-C 重複列単位片除去 (YJVF/YTZ3): 結合セル展開ずれの
  「（単位；千円）種結晶」vs「種結晶」を見逃さず間引く (二重計上→F7誤殺)。
- FIX-D 正準ブースト (G3BR/G9OV/R173/TNH4/VZ5K/YCXB/VHA9/XTT8):
  表題窓の地域注記題名に +4。当/前ペアは対称で期間優先を保持。
- FIX-F R1 拡張 (DCF4/W3QI): 有形固定資産/無形資産の地域別資産表を
  追加。表題パターン gate (近傍の地域別/内訳/残高 + footnote 語 veto)
  + joint 表題 abstain (W20H) で QG12/RS6X の誤殺を回避。
- FIX-G backlog gate (TP3I + E01575系9件): 繰越工事高/受注高の手持ち表を
  最寄り表題語で除外。販売実績表は保持。
- FIX-H2 tiebreak (255件回復): 同点2候補・同 status・同注記種・同連結区分・
  同期表示語・総額相違の gate の下、(a) 片側のみ metric 標識 (移行日/
  非流動資産/減損/有形/無形) なら clean 側 (CMLA)、(b) 両 clean かつ
  期表示語なしなら後表=当期 (R98H: 前期表→当期表の開示順。採点解消済み
  T/Z ペア 1409 件中 1391 件=98.7% が当期後置で裏付け)。[T]/[TZ] の順序
  解決は禁止 (TA7H: 同期間の収益認識/セグメント対。TZ は売上/非売上混在)。
- FIX-E (集計後その他橋渡し) は母集団 3675 で発火ゼロのため削除
  (TODG は cols 側の非地域 bridge で既に正しく保守的)。
- 副作用ゼロ確認: 3後退 (OC7S/R4LB/TSO2) は連結優先で即回復。
  TP3I の backlog 誤回復は FIX-G で除去。QG12/RS6X/W20H の R1 誤殺は
  gate で回避 (全て fixture 固定)。

### 10-3. 母集団検証 (fixup8 N1 → fixup14 N7、全3675)
- N1→N7 差分 347件を全件帰属: 回復 325 (follow-up 55 + FIX-B 9 [E01264系]
  + FIX-D 6 + FIX-H2 255)、正 kill 10 (AM9X 資産表 + E01575 backlog 9)、
  FIX-D 正準入替 6、KEYCHG 6 (FHUH/R9AG/YJVF/YTZ3/VHA9/XTT8)。false-kill 0。
- tiebreak 255件は経営指標の連結売上高系列で独立検証: 230 一致 +
  4 検証済み (J3TY joint-fit、T4V8/VGT3/XS5K 同一発行者の連鎖一致) +
  2 和暦 noparse 抽出一致 + 18 noparse (oracle 範囲外。validated 規約に従う)
  + 1 曖昧 (G9KL: joint-fit は N 側を支持)。proven-wrong 0。
  (旧 H1 の loserWin 35件は H2 で解消: TZ/T 順序禁止 + metric-clean 採用)。
- viol-59 replay: 59/59 (53 同一 + 6 tiebreak 解決。
  6件とも F5=前期表の誤採用で N7=当期表が正しい。経営指標で確認)。
- ok-ok (F5-ok かつ N7-ok 値違い) 387件を分類: 期間 233 (tiebreak/採点。
  oracle 検証済み)、DROP-その他 68 (F4。9QVM 抽出確認)、ADD 9 (F2/F4)、
  名称のみ 31 (F1 注除去。5件抽出確認)、mixed 18 (期間+F1。4件確認)、
  total選択 28 (開示例優先。FM6C Δ2 確認)。全 class 処分済み。
- NONE-8: りそな系6件は銀行有価証券残高表の F5-false-positive で N-correct-kill
  (集計 proof)。PV48 却下維持・YCP3 回復 (fixture 固定)。
  7-unsupported は正直 abstain 維持 (root 申送り)。
- 残 tie 266件は正直に unstructured (TZ/T-clean、3者以上、内訳 tie、両 metric)。

### 10-4. 検証ゲート (最終 head)
- `overseas-parser.test.ts`: **78 tests green** (69 + FIX 回帰 9:
  FHUH/R9AG/YJVF/G3BR/OC7S/DCF4/TP3I/R98H/CMLA。実原本 fixture 9表追加)。
- `services/yuho-quant`: 44 files / **525 tests green**。repo 全体:
  196 files / **2823 passed** (385 skipped) / 0 failed。
- `tsc --noEmit` clean。`eslint src services --max-warnings=0` clean。
  `render-data-audit.ts --check` OK。
- fixture 計 28表 (F1–F8/follow-up 19 + FIX-A–H2 9)。全て実原本 verbatim。
- 本番書込なし (D1/R2/Notion/job-apply 未実行。writer grant 待ち)。
  原本 ZIP は `/tmp/overseas_laneA_raw/` (未 archive のまま正直に記録)。

## 11. HOLD-gate 対応: bound 導出・全比較 grouping・期首継承・R1-wide (同一ブランチ継続)

### 11-1. Gate-(a): 丸め許容の導出 (旧 0.5*(L+4) 廃止)
- 開示値は切捨て表示が明記 (NRWW/DDYF の会計方針「百万円未満の端数を切り捨て」)。
  最悪計算: 各表示葉セルは真値より [0,1) だけ小さい → |Σ表示葉−真合計| < L、
  |開示総額−真合計| < 1。両辺整数より |差| ≤ L。四捨五入 (|差| ≤ 0.5(L+1)) も
  L≥1 で包摂。注記なし文書 (OJX1: 千円) も切捨て側で包摂。隠れ小計の二重丸めは
  底辺葉セル数に織込済 (DDYF: アジア 118476+182922=301398 完全一致。L=6)。
- `roundingBoundFor(L)=L` を export + 4 検査点 (totalsConsistent / rows-recon /
  B1-shokei / cols-adjusted / validate-fallback) を置換。未導出の intermediate
  +1 は削除 (総額セルは1表示セルで整数性に折畳済)。
- 実証: 差 4 の完全読取 4 表を受理 (NRWW L=5・OJX1 L=5 (raw-run: 5脚col表)・
  DDYF L=6・PUMS L=15)、脱落 (9XV6 差 7・FFET 差 10、L=5) を共に却下。
- 保存パス片側検査の設計根拠を明記: 総額は非地域収益を含み得るため上振れは正当。
  単一候補の脱落は非地域超過と算術的に区別不能 (読取完全性の領域)。

### 11-2. Gate-(b)+(c): 全比較 grouping + 期首継承 (順序 proxy 廃止)
- 最高点群を (sourceFiscal, 連結区分, 単位) で group 化し group 内全比較。
  group 内不一致→STOP、単一 group 全一致→収束 (metric 標識ありは STOP)、
  複数 group→継承 T/Z ペアのみ T 側、それ以外 STOP。
- `inheritSourceFiscal(wide, pe)`: 広窓 (60KB-HTML) の最寄り ranged 表題から継承。
  T=終期pe一致のみ確定、Z=終期pe以前のみ確定。半角括弧 (TA7H)・期数式 (第N期。
  TSNG/W7ZO/YHFZ)・和暦終期 (西暦化して照合) に対応。順序・metric-clean 優先なし。
- 正準 boost から「(2) 地域別の内訳」を除外 (セグメント注小題。R98H: セグメント
  切り日本 100383 vs 地域注記切り日本 100547 の脚不一致を実証)。ablation で
  flip 0 を確認 (無害)。
- E00766 4期 (R98H/TU43/W4M7/YJKO) は節表題 25KB 前方から継承して回復 (BASE と
  同値)。TTUY/AO7M (近接表題)・CMLA (R1-wide)・G9KL (pe 検証 T。cross-period
  の KEI-loserWin は oracle artifact) も維持/解決。

### 11-3. R1-grid up-front (tiebreak metric 分岐の移設)
- 表頭の移行日だけでは落とさない: IFRS 移行年の売上表も移行日列を持つ (AI6T:
  移行日/前/当の3期比較・地域別売上。blind-kill で誤殺を確認→撤回)。
- R1-wide: narrow 160字に metric 名詞なし + 表頭移行日 + 広窓最寄り名詞が資産
  (joint-abstain は近接のみ) のときだけ除去。CMLA 後表を除去し売上表のみ残す。
- 3675 rescan: R1-wide kill 5件は全て真 kill (9B8Y/HLV4・LPBU/PIW4 双子 + W81W 反転。
  KEI 照合で資産表を確認。W81W は資産 173275→売上 177057=KEI へ正反転)。

### 11-4. 3675 全母集団 rescan (BASE=HEAD vs NEW)
- 156 diffs: R1-wide 真 kill 4 + W81W 正反転 + 回復 9 (KEI 多重証跡で抽出確認。
  TNDP/SO25/RA2B は tie 救済) + honest-STOP 142。
- STOP 142 は順序 proxy 撤廃の cost (ablation: R1-wide-off で回復 4 のみ、
  canonical-restore で回復 0、残りは tiebreak)。内訳に TA7H 級を含む。
- oracle-255: nWin 209→206 (−3: TA7H/VLI7/XYFO の同 group-T 総額不一致。
  全社計 vs 外部顧客計の genuine-conflict で honest-STOP)、loserWin 1 (G9KL
  artifact 維持)、proven-wrong 0。期数式で TSNG/W7ZO/YHFZ を回復済み。
- diff histogram (NEW-ok 3148): 0:760/1:1157/2:855/3:280/4:52/5:7 + 上側超過 30
  (非地域収益。設計どおり)。差 5 の7件は全て旧 bound でも受理 (L≥8)。新規
  loosening-admission なし。bound 違反 (下側) 0。
- viol-59: 59/59 不変。ok-ok fact-change: W81W のみ (正反転済み)。

### 11-5. 検証ゲート (最終 head)
- `overseas-parser.test.ts`: **91 tests green** (78 + HOLD net 13:
  nohead-STOP/TTUY-T-pick/TA7H-STOP (R98H 置換) + roundingBoundFor 4 +
  inheritSourceFiscal 7 + CMLA-title 更新。実原本 fixture 3表: TTUY/TA7H 新規 +
  R98H-nohead 転用、R98H-later 削除)。
- `services/yuho-quant`: 44 files / **544 tests green**。repo 全体:
  206 files / **3058 passed** (363 skipped) / 0 failed。
- `tsc --noEmit` clean。`eslint src services --max-warnings=0` clean。
  `render-data-audit.ts --check` OK。
- 本番書込なし (D1/R2/Notion/job-apply 未実行。writer grant 待ち)。
  原本 ZIP は `/tmp/overseas_laneA_raw/` (未 archive のまま正直に記録)。
- 残課題 (follow-up): 単一行 geocols (R98H 地域注記ペア等) の新構造対応で
  E00766 の地域注記切りも読める。TA7H 級 (全社計 vs 外部顧客計) の総額意味
  選好は gate 外のため STOP 維持。
