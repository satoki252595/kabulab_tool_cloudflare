# 海外 actual-repair OFFLINE PREP (2026-09-30)

最終 parser (PR208 merge) での actual repair 前の純 offline 準備。固定 3675 ZIP
の既存 raw のみを現 parser で全件再生成し、docID union (census / live1781 /
旧1695 / 73unknown / 804系列の dedup + 全 membership tags) ごとに full facts
+ preimage + protected 差 + reason journal を一度確定した。本記録は counts・
SHA・limits のみ (public 可)。per-doc の値・表は private 0600 のみ。

- PREP script: `services/yuho-quant/data-scripts/overseas-repair-prep.ts`
  (745-prep と同一 skeleton の再使用。新 framework/export なし。既存
  `parseOverseasData` / `validateOverseasSaveSet` + backfill-overseas/ingest
  同等変換 + lib `repair-union.ts` の union/tags/分離)
- union lib: `services/yuho-quant/data-scripts/lib/repair-union.ts`
  (test: `overseas-repair-union.test.ts` 10 passed。実 docID の
  交差/outside-live/unknown-pin 対照 + 母集合分離 + receipt 分類)
- 実行: `2026-09-30T06:48:14Z`–`06:50:40Z` (約146秒・fetch 全面拒否・結果 PASS)
- 実行 workHEAD: `4b998ab34b35` (PR208 merge main。closed-208 branch 不使用)
- 実 CLI: `npx tsx services/yuho-quant/data-scripts/overseas-repair-prep.ts`
  (既定 `--lane-dir=/tmp --raw-dir=/tmp/overseas_laneA_raw`
  `--prep-dir=/tmp/overseas745-prep-20260930`
  `--select-dir=/tmp/overseas745-select-20260930`
  `--census=/tmp/overseas-census2-3602.jsonl --receipts=none`
  `--out-dir=/tmp/overseas-repair-prep-20260930` で実行)
- parser 固定: `services/yuho-quant/src/services/overseas-parser.ts`
  blob `07ad7a54b975c543a604dcf52b31df91b72f23f7` (HEAD 一致・clean 確認)

## 固定入力 pins (bytes SHA256・全一致)

- `manifest_full.json` (3602) `398843d5…02ca4` + `<docID>_t1.zip` 3675件 (0600)
- `okdocs` `034cefad…98735` / `savedfacts` (21258行) `58122d8d…b2bbb31`
- `prep-manifest.json` (3675) `c2345269…7083a7` /
  `prep-sets.json` `62095358…308b5d1` / `prep-journal.jsonl` (1728行) `5127c73b…88d5b9dc`
- `overseas-census2-3602.jsonl` (最終 freeze) `bb1cccb1…de7387`
- `select-union.json` (1781) `54c6fb38…f16fdc` /
  `select-live.json` (q1 1781/q2 10257) `4a4cbc04…adeb517` /
  `select-compare.json` (1781) `75ba0835…74e879`
- receipt 証跡: none (不在 → 全 ARCHIVE_PENDING)

## 集合の確定 (dedup union + 全 tags・sortedDocIDs SHA 照合)

- 804/59/745 系列は pinned prep 出力から再構成し setSHA 連続確認
  (`64daec93…` / `7ccf9a6f…` / `8c09ab34…`)。59+745 再結合 = 804。
- union 組成照合: 745 ∪ outside977 (925+52) ∪ 59 = live1781 (集合一致)。
- census class: 採用 1411 (36 reverse を含む・併持 tags) / HOLD 1487 /
  reverse 36 / other 668。census doc集合 = manifest keys (3602)。
- 旧 L1changed 1695 = select-compare L1 changed (旧 parser prep 由来)。
  union の subset。pin73 = manifest 欠落 = prep fixed-now (集合一致)。
- union 3675 全 doc に tags (census/live/old1695/pin73/804系列)。
  同じ doc の複数母集合所属は正当 (例: S1008Q8O は 5 tags 併持)。
  対照: S1008XET (outside-live 採用)、S100AKTK (unknown-pin + live 観測)。

## preimage 基準

- applied59: journal 記録の sealed-post があれば primary (6件)、なければ
  live 行を L3match 59/59 (status/honbun/raw 含む全行一致) の根拠で proxy。
- 非59: savedfacts before + savedStatus。live 観測行は別途添付
  (observed-not-current の表示)。
- 比較 fields は 745-prep と同一 (STATUS/HONBUN/SCOPE/FYEAR/VALUE/RAW/
  UNIT/CONSOLIDATED/REGIONKIND/RATIO/PATTERN)。

## 結果 counts

- total 3675 (59/745/2871)。match 475 / changed 3127。
- HOLD_PARSE 0 / HOLD_VALIDATION 0 / HOLD_PIN_MISSING 73 /
  HOLD_PIN_MISMATCH 0 / HOLD_RECEIPT 0。
- receipt: PENDING 3675 / RECEIVED 0。newQualified 0 (assert)。
- 分離: oldL1Changed1695=1695 / newQualified=0 (別 field)。
- census 自己整合 3602/3602 (同一 parser・同一 bytes の再現)。
- 成果物: `repair-manifest.json` (3675) `4736faff…5e97672c` /
  `repair-journal.jsonl` (3200行) `7572a3b3…41e5c` /
  `repair-sets.json` `060358ee…b9e15` /
  `repair-report.json` (0600 out-dir のみ)

## zeros

fetchAttempts 0 / sourceGET 0 / notionCreateUpdateArchive 0 /
d1r2mutation 0 / workflow 0 / newReceipts 0 / sends 0。

## limits

- 1411/1487/36 (3602 census) と旧 live 1695 (旧 parser prep 由来
  L1changed) は母集合が別。1695 を新 qualified 候補数と呼ばない。
- live snapshot は旧観測で live-current を保証しない (preimage 参照のみ)。
- 73 pin不足は過去 custody UNKNOWN として apply HOLD。将来 official
  fresh GET / current identity / full-bytes / custody / current CAS で
  現修正資格化する道を残し、過去を偽補完しない。
- 旧 source pins mismatch は再 pin せず per-doc HOLD (今回は 0)。
- receipt 証跡なし → 全 ARCHIVE_PENDING。apply-qualified 0 (apply grant なし)。
- 旧 journal/grants は照合読取のみ。CANCELLED grants は再利用しない。
- 本番/source GET は未実行 (fetch 0)。orders/text 修正 0。
