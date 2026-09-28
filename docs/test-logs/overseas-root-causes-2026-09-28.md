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
