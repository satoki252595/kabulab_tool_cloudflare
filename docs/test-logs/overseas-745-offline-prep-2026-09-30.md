# 海外残745 純OFFLINE PREP (2026-09-30)

laneA 残 745 の later apply 前の純 offline 準備。固定 3675 ZIP の既存 raw のみを
現在 parser で全件再生成し、現 parser → `validateOverseasSaveSet` → 保存 caller
同等変換の値を旧 before / sealed 期待値と比較して current changed set を新導出
した。745 全件 update とは仮定しない。本記録は counts・SHA・limits のみ
(public 可)。per-doc の値・表は private 0600 journal/manifest のみ。

- PREP script: `services/yuho-quant/data-scripts/overseas-745-prep.ts`
  (新規 export/framework なし。既存 `parseOverseasData` /
  `validateOverseasSaveSet` + backfill-overseas/ingest 同等変換を再使用)
- 実行: `2026-09-30T00:17:43Z`–`00:19:05Z` (約82秒・fetch 全面拒否・結果 PASS)
- 実行 workHEAD: `e822744` (実行時は script 未 commit。published/reviewed
  `47c2d5c` と script bytes 同一。clean tree で commit)。
- 実 CLI (legacy `--name=value` 式):
  `pnpm exec tsx services/yuho-quant/data-scripts/overseas-745-prep.ts`
  (既定 `--lane-dir=/tmp --raw-dir=/tmp/overseas_laneA_raw`
  `--out-dir=/tmp/overseas745-prep-20260930` で実行)
- parser 固定: `services/yuho-quant/src/services/overseas-parser.ts`
  blob `07efdd0a25a79328873cf34faf6a1cb5a2095bbe` (HEAD 一致・clean 確認)
- 関連: `docs/test-logs/overseas-root-causes-2026-09-28.md` (§6 適用計画の 745 残)

## 固定入力 pins (bytes SHA256・全一致)

- `manifest_full.json` (3602) `398843d5…02ca4` + `<docID>_t1.zip` 3675件 (0600)
- `okdocs` `034cefad…98735` / `fullscan` `b5cb5c1c…071c1f` /
  `fixup5` `89dafe31…8806d28d` / `savedfacts` (21258行) `58122d8d…b2bbb31`
- `batches` `991e8db9…45a4a` / `r4xr` `9f47e75c…70d817` /
  `completions` `a8d8ae0f…704eb7` / `completions_r4xr` `6fca896c…4de702e5` /
  `journal` `03254803…73dcd` / `journal_r4xr` `b8c4c8e2…0824874` /
  `post` `ba7d0ea1…7f9041b` / `post_r4xr` `35a9d3a0…58129260b`

## 集合の確定 (sortedDocIDs JSON.stringify SHA・全一致)

- 歴史 804 = fixup5 `eqSavedNew===false`。`64daec93…922a4e983e`
  (fullscan `eqSaved=false` 109・fixup14 flip 667 とは不混和。109 は件数のみ記録)
- 適用 59 = base58 plans + R4XR 1 plan (disjoint)。
  `7ccf9a6f…2c2f70c`。completions 58+1 keys = plans、journal 全 doc
  `issued`+`sent`、planSHA/lease 連結、post `docs` 58/1・`mismatched: []`・
  `ok: true`・`sends: 0` を全件照合。59 ⊆ 804。
- 残 745 = 804−59。`8c09ab34…c2d81`。59+745 再結合 = 804。
- manifest は 3602 pins。73 pin不足 (745内 21・59内 0・804外 52) は
  uncustodied/HOLD。今回 bytes/SHA を新固定して offline parse したが
  過去 custody 済と扱わない。

## 比較基準

- applied59: sealed plans 適用後期待値 (UPDATE status/honbun + postflight JSON
  rows。INSERT binds との多重集合一致も全 59 件で自己整合を確認)。
  古 savedfacts が現在 D1 値とは主張しない。現 prod 59 全 rows は未観測。
- 非59: before (fullscan `savedStatus` + savedfacts 11col相当。
  `sales_raw` と before honbun は before 側に無いため比較対象外。current
  honbun は記録のみ)。
- 比較 fields: status/honbun(59のみ)/全 facts (NULL・unit・toYen・yearend・
  consolidated・region・ratio・pattern。59 は salesRaw も)。
- 例外は empty facts へ fallback せず HOLD_PARSE / HOLD_VALIDATION へ分類。
  旧 journal の blind apply なし。

## 結果 counts

- 総 3675: match 1947 / changed 1655 / HOLD_PARSE 0 / HOLD_VALIDATION 0 /
  HOLD_PIN_MISSING 73 (合計 3675)。3675 全件が parse+validate clean。
- remain745: changed 724 / match 0 / HOLD 21 (pin不足)。
  before facts 4134 → current 3382。
- applied59: match 53 / changed 6 / HOLD 0。
  6 件は同一 signature (同 status・同 6 rows・`isConsolidated` のみ
  sealed `true` → current `null`。内 5 件は同一発行者の FY 連番)。
  match53 の current 278 = sealed 314 − changed6 の 36 と整合。
- stable2871: changed 925 / match 1894 / HOLD 52 (pin不足)。
  changed925 の before 5412 → current 2331。
- 診断 (断定なし): fixup5 `newStatus` との一致 2971/3675。
  fixup5 は §4 世代 scan のため現 parser (§17 世代) との差は drift として記録。

## reason 内訳 (counts)

- 全体: SCOPE 1095 / VALUE 875 / RATIO 802 / FACTS_DELETED 753 / STATUS 789 /
  CONSOLIDATED 43 / PATTERN 36。単独タグは VALUE 58・SCOPE 58・
  CONSOLIDATED 6 のみ (単独 RATIO/PATTERN/RAW 0 = 丸め・正規化 artifact なし)。
- 主 combos: FACTS_DELETED+SCOPE+STATUS 753 (ok→非ok 反転) /
  RATIO+VALUE 499 (同 key の値是正・比率は再計算で追従) /
  RATIO+SCOPE+VALUE 248。
- 745内: VALUE 548 / RATIO 494 / SCOPE 388 / STATUS 206 / FACTS_DELETED 197 /
  CONSOLIDATED 33 / PATTERN 9。遷移は ok→ok 値是正 539・ok→unstructured 154・
  ok→no_table 43・ok_rows→ok_cols 9。

## zeros・原状保全

- `fetchAttempts` 0・sourceGET 0・Notion create/update/archive 0・
  新規 receipt 0・D1/R2 mutation 0・workflow 0。本番/source GET 未実行。
- 実観測: 3675 ZIP 全読・hash 1回 (期待 pin 3602 全一致) + 実行前後の
  `manifest_full.json` SHA・dir filenames 一致。ZIP 全件の再 hash は未観測
  (script は manifest SHA + dir 列挙のみ再確認。再 run なし)。
- CANCELLED の旧 laneA grants は再利用なし (journal は照合読取のみ)。

## 成果物 (private `/tmp/overseas745-prep-20260930/`・0600・dir 0700)

- `prep-manifest.json` (3675 records) `c2345269…7083a7`
- `prep-journal.jsonl` (1728 lines = changed 1655 + HOLD_PIN 73) `5127c73b…85b9dc`
- `prep-sets.json` (分類別 docID 集合) `62095358…308b5d1`
- `prep-report.json` `a96a3d33…bcb3a`
- 出力 mode は dir 0700・4 files 全 0600 を `ls` で一致確認済み。

## 検証

- PREP script 自身が全 pins・集合 SHAs・件数・zeros を断言 (違反は HOLD 終了)。
- journal 構造の独立 cross-check (python): verdict 合計・reason  combo・
  59内訳・sealed 整合 (278 = 314−36)・set 件数の再計算が一致。
- 既存 area tests: `overseas-parser` + `overseas-repair-isolation` +
  `backfill-atomic` + `ingest-atomic` の 121 tests green (nix)。
- `tsc --noEmit` clean。`eslint` (当該 script) clean。

## 非主張・limits

- 745 の 724 changed は「現 parser の before 差」であり apply 承認ではない。
- 59 の sealed 期待値は適用時点のもの。6 件 drift の処分は Root 判断。
  (現 `null` が正直値の可能性。盲目的な再 seal なし)。
- 925 の 804外 changed は現 parser 世代差による新規差分。適用範囲への
  取込可否は Root 判断 (本 PREP は範囲拡大を提案しない)。
- journal reasons は変更 field 分類のみ。parser candidate/gate/root-cause
  帰属は未完のため原因未帰属・適用資格なし。parser 自体の追加 fix を
  この diff だけから推測しない。
- stable match 1894 は before 一致のため D1 再読の対象外 (下記計画の範囲外)。
- source HTTP identity・全 physical archive・fullDL proof は later apply 前 required。

## D1 SELECT proof (Root grant 版・実行済み)

Root 承認 (SELECT-only・≤36 requests・単発・書込なし)。
対象は disjoint union 1781 docs (旧745 + changedOutside804 925 +
holdOutside804 52 + all59。73 pin不足のうち 21 は 745 内で重複加算なし)。
union SHA `9690d780…8fe1878` を private 0600 固定。18 chunks (≤100 IDs)。

- Q1 (chunk 毎 1 SELECT): doc identity + stock identity + periodEnd +
  status + honbun + doc別 correlated overseasFacts COUNT (同一 request)。
- Q2 (chunk 毎 1 SELECT): 同一 IDs の facts 全 storage cols (12 col) +
  docID echo。決定順 (`doc_id`, `fiscal_year_end`, `region_name`)。
  nullable 保持。型付き `db.select` のみ (raw positional 不使用)。
- bound: 36 SELECT / 36 HTTP requests。追加 auto-retry 0。
  Q1 cardinality (全部 unique・欠落なし) + Q1 counts 合計 = Q2 全行
  (0-facts doc 含む)。missing/dup/列異常/値異常/truncation は STOP。
- 比較: L1 live vs PREP-current / L2 live vs historical before を別比較。
  all59 は L3 live vs sealed-post も別比較。old facts counts 推計を
  必須 live 件数にしない (Q1 observed count が基準)。
- 実行 script:
  `services/yuho-quant/data-scripts/overseas-745-select-proof.ts`
  (legacy `--name=value` 式。`--env-file` で read credential を指定)。
  実行 workHEAD `06a7246` (実行時は script 未 commit。commit 後 bytes 同一)。
- 実 CLI:
  `pnpm exec tsx services/yuho-quant/data-scripts/overseas-745-select-proof.ts
  --env-file=/Users/satoki252595/projects/kabulab-cf/.env`
- 実行: `2026-09-30T00:46:17Z`–`00:46:20Z` (約3秒・結果 PASS)。
- 成果物 (private `/tmp/overseas745-select-20260930/`・dir 0700・5 files 全
  0600 を `ls` で一致確認): `select-union.json` `54c6fb38…4f16fdc` /
  `select-manifest.json` (36 queries) `560147ae…782952c` /
  `select-live.json` (観測 snapshot) `4a4cbc04…adeb517` /
  `select-compare.json` (L1/L2/L3) `75ba0835…74e879` /
  `select-report.json` (read-only receipt) `d921f6ba…165766e`。

## SELECT proof 結果 (counts・SHA のみ)

- 36/36 HTTP 成功・失敗 0・retry 0。非 D1 fetch 0・書込 0・source GET 0・
  Notion 新 POST 0。querySHA `db2f4928…6530762a` を 0600 記録。
- Q1 1781行 (18 chunks 全て cardinality 一致) / Q2 10257行 /
  Q1合計 10257 (chunk 毎 + 総計で一致。truncation なし)。
- L1 (live vs PREP-current): match 86 / changed 1695。
  match 内訳は match59 の 53 + holdOutside の before一致 33 (全て特定済み)。
- L2 (live vs before): match 1722 / changed 59。
  changed 集合は applied59 と完全一致 (live は適用 59 箇所のみ before と相違)。
- L3 (59 live vs sealed-post): match 59 / changed 0。
  適用が stuck している初の全 rows 観測。現 prod 59 は sealed どおり。
- 行数整合: before 10270 → live 10257 (Δ−13 = sealed apply 差分 314−327)。
- canonical-key 重複: DUP_BEFORE 0 / DUP_AFTER 0 (全比較)。
  live Q2 は全 storage PK/rows を保持し重複なし (dup は STOP 対象だった)。
- honbun scope 実測: L1 1781 全件両側非 null で比較・L3 59 全件比較。
  null 混在 0。honbun 値は protected scope (0600 のみ・stdout 0)。
- D1 IDs/values の stdout 出力 0。D1 IDs は 0600 snapshot のみ。
- 候補 changed の全原因帰属は既 raw の pure-offline 説明 +
  later apply 前 Root review (今回 apply grant 0)。
  future apply CAS は全 pre-image rows を exact counts/ids で含めること。
- ライブ source ZIP archive は未実行 (不可のまま)。

## Guard fix: 送信前 36-bound + doc別 COUNT (2026-09-30)

- GPT-sol final review 指摘の producer 側 2 guard を既存 flow へ数行追加。
  (1) D1 送信前に `httpObserved >= 36` を拒否
  (終端 check だけでは 37 件目の送信を防げない)。
  (2) chunk 毎に Q1 doc別 `factsCount` と Q2 doc別 rows の一致を検証
  (chunk 合計だけでは同一 chunk 内の相互相殺を見逃す)。
- offline 検証 (保存済み 1781/10257 のみ。新 live GET 0):
  実データ 1781 docs 不一致 0 + 同一 chunk 2 doc の count 相殺 mutation
  (chunk 合計不変) を 2 docs 検出で FAIL 実証。chunk 合計のみの盲も確認。
  検証 probe は private 0600 (`perdoc-check.mts`)。stdout は counts のみ。
