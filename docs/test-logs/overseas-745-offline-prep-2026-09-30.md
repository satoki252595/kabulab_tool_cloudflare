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

## 次段 D1 SELECT 計画案 (bounded・未実行・新 grant 別途)

対象は非 match の 1781 docs (changed745 724 + hold745 21 + changedOutside 925 +
holdOutside804 52 + 全59)。docID リストは private `prep-sets.json` から。
100件/chunk で 18 chunks。SELECT のみ。

- Q1 (status/honbun): `SELECT doc_id, overseas_parse_status,
  overseas_honbun_file FROM yuho_documents WHERE doc_id IN (…)`。
  期待: chunk 毎に投入件数と同行 (745系 745行・925系 925行・73系 73行・59系 59行)。
  status は PREP currentStatus と、honbun は PREP 記録 (59 は sealed) と照合。
- Q2 (facts): `SELECT d.doc_id, f.fiscal_year_end, f.region_name,
  f.region_kind, f.is_consolidated, f.unit_label, f.sales_raw, f.sales_yen,
  f.ratio_pct, f.pattern FROM yuho_overseas_facts f JOIN yuho_documents d
  ON f.document_id = d.id WHERE d.doc_id IN (…) ORDER BY 1, 2, 3`。
  期待行数の目安 (before 側): 745系 4242・925系 5412・73系 397・59系 327。
  745/925系は PREP after 表と、59系は sealed-post と多重集合比較する。
- Q3 (counts): chunk 毎の `COUNT(*)` で Q1/Q2 の抜けなしを確認。
- 実行は Root review 後の新 grant で行う。本 PREP では実行しない。
