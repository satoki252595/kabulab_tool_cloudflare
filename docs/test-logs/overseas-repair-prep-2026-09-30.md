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
  (test: `overseas-repair-union.test.ts` 14 passed。実 docID の
  交差/outside-live/unknown-pin 対照 + 観測 namespace 分割 +
  母集合分離 + receipt 分類 (SHA/manifest 照合のみでは ARCHIVE_PENDING
  のまま。検証済み physical loader なし → RECEIVED は将来の explicitly
  verified physical closure まで到達なし) + offline 候補除外条件)
- 実行: `2026-09-30T07:22:09Z`–`07:23:31Z` (約82秒・fetch 全面拒否・結果 PASS。
  trust 修正 run。前回 07:09 実行の counts (changed 3127/match 475) は
  未観測 doc を DB-changed に混入させていたため repair 数として破棄
  (superseded)。artifact は本 run で上書き)
- 実行 workHEAD: `768990cd2604` (= report 記録値そのまま。実行時 tree は dirty:
  trust 修正の lib/script/test が未 commit。実行→commit の間に code
  変更はなく (note/release の転記のみ)、実行 script/lib/test bytes =
  下記 commit 済み blob と同一。実行 pin の捏造なし: workHEAD は
  dirty 時の HEAD を示し、code bytes は blob SHA で review 可)
  - script blob `52b53b40b4c2` / lib blob `bcf704fec47f` /
    test blob `e3b8c147303a`
- Published HEAD: 本記録を含む branch 最終 commit (report 参照)。
  実行 HEAD (`768990c`) と published HEAD は別物:
  artifact は実行時 bytes に紐づき、published HEAD はその bytes を
  含む後続 commit である。closed-208 branch 不使用
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
- 観測 namespace 分割 (join 実結果): observed 1781 (live1781 tag あり。
  DB 比較の対象) / historical 1894 (live 観測なし。LIVE_UNOBSERVED)。
  1781 + 1894 = 3675 (構造照合)。pin73 の内訳は join が決定する
  (推測値を書かない)。

## per-doc 保持 (認定証跡・private のみ)

- 実 parser の `proof` + 変換前の実 `facts` を manifest/journal に保持する。
  proof は rounding/reconciliation 区間 (unitYenFactor・selected-table・
  fiscal locator を持たない)。facts が unitYenFactor + fiscal + scope を
  運ぶ。same-table locator は facts の行自体。toSaveRows/status のみでは
  失われるため両方残す。新 parser instrumentation/trace なし。
- receipt は既証跡の静読のみ。不在 → ARCHIVE_PENDING、不正/実 bytes
  不一致 → HOLD。same/written + pageId は manifest 照合の記録であって
  hosted bytes の証明ではないため、一致しても RECEIVED にしない
  (metadata として保持 + shaMatch)。検証済み physical receipt loader
  なし → RECEIVED は将来の explicitly verified physical closure まで
  到達なし。
- 候補は parse+validate+pin+pin不一致なし+scope既知+receipt の全条件。
  意味は OFFLINE_CANDIDATE (live READY ではない)。計算結果をそのまま報告し
  grant で 0 に偽装しない (今回は receipt 証跡なしの実結果として 0)。
  liveReady / applyQualified は grant 状態として別明示 (いずれも 0)。
- live 観測行の全体 (q1 の id/stockId/periodEnd、q2 の id/documentId/stockId
  を含む rawQ1/rawQ2) を journal に保持する (照合 projection とは別)。
  DB 全体像の preimage は名乗らない (旧 Q1 は 7 列 projection のみ)。

## preimage 基準

- observed + applied59: journal 記録の sealed-post があれば primary (6件)、
  なければ live 行を L3match 59/59 (status/honbun/raw 含む全行一致) の
  根拠で proxy (sealed baseline を別途保持)。
- observed + 非59: 旧 live の full projected rows/status/honbun を before とし
  current parser と比較する (raw/honbun 比較あり)。結果は
  observed-not-current (旧観測)。
- historical (outside 1894): live map 群に触れない。savedfacts との比較は
  歴史 namespace (historicalCompare) のみ。DB missing/current-changed/
  null-status/empty-facts を推論しない (live rows の `?? []` なし)。
- 比較 fields は 745-prep と同一 (STATUS/HONBUN/SCOPE/FYEAR/VALUE/RAW/
  UNIT/CONSOLIDATED/REGIONKIND/RATIO/PATTERN)。

## 結果 counts

- total 3675 (59/745/2871)。
  observed 1781: match 21 / changed 1687 / HOLD_PIN_MISSING 73 /
  HOLD_PARSE 0 / HOLD_VALIDATION 0 / HOLD_PIN_MISMATCH 0 / HOLD_RECEIPT 0
  (21+1687+73 = 1781。構造照合)。
- historical 1894: 全 LIVE_UNOBSERVED (repair verdict なし)。
  historicalCompare: changed 1440 / match 454 (歴史 namespace。
  repair-changed 数にしない)。unobserved 内の pin不足 0・
  未比較 0 (いずれも join 実結果)。
- 前回 run の changed 3127 / match 475 は trust 修正により repair 数として
  破棄 (superseded)。旧1695・歴史 changed のいずれも repair 対象数ではない。
- receipt: PENDING 3675 / RECEIVED 0。offlineCandidates 0 (計算結果) /
  liveReady 0 / applyQualified 0 (いずれも別 field)。
- 分離: oldL1Changed1695=1695 / offlineCandidates=0 /
  liveReady=0 / applyQualified=0 (別 field)。
- census 自己整合 3602/3602 (同一 parser・同一 bytes の再現)。
- 成果物: `repair-manifest.json` (3675) `754ecba7…caac98` /
  `repair-journal.jsonl` (3654行) `85985cda…e2af` /
  `repair-sets.json` `cf39b957…8884` /
  `repair-report.json` `9963b3b7…829` (0600 out-dir のみ)。
  同 dir の `repair-report-hold.json` は初回 06:48 の census assert
  HOLD 残骸 (superseded。今回 PASS とは無関係)。

## zeros

fetchAttempts 0 / sourceGET 0 / notionCreateUpdateArchive 0 /
d1r2mutation 0 / workflow 0 / newReceipts 0 / sends 0。

## 旧 scope 記述の正誤 (PR208 merge 確定後)

- 旧 overseas scope notes の「SOL review待ち」「数値選択不変」は
  PR208 最終 (numeric+scope CLEAR) により stale。現真値は本記録と
  `overseas-numeric-root-2026-09-30.md` が持つ (旧 note は歴史記録
  として残し、書換えない)。
- 最終 59 gate: MATCH 15 / flips 32 / scope-only 12。
  table-local numeric root の validation は完了。
  歴史 data-write は 0 (本番 D1/Notion への書込なし)。
- 現 repair の apply qualification は別途 PENDING (本 PREP は
  apply-qualified 0)。PREP actual 候補数は dedup union join からのみ
  導出し、旧1695 比較 count の再使用はしない。

## limits

- 1411/1487/36 (3602 census) と旧 live 1695 (旧 parser prep 由来
  L1changed) は母集合が別。1695 を新 qualified 候補数と呼ばない。
- DB 比較は observed (live1781) のみ。outside 1894 は LIVE_UNOBSERVED
  (DB missing/current-changed/null-status/empty-facts を推論しない。
  live rows の `?? []` なし)。旧1695・歴史 changed のいずれも repair
  対象数ではない。存在確定は将来 fresh full SELECT が行う。
- live snapshot は旧観測で live-current を保証しない (preimage 参照のみ)。
- 73 pin不足は過去 custody UNKNOWN として apply HOLD。将来 official
  fresh GET / current identity / full-bytes / custody / current CAS で
  現修正資格化する道を残し、過去を偽補完しない。
- 旧 source pins mismatch は再 pin せず per-doc HOLD (今回は 0)。
- receipt 証跡なし → 全 ARCHIVE_PENDING。不正/unknown 証跡は HOLD。
  manifest 照合一致でも hosted を名乗らない (metadata 保持)。
  offline 候補 0 は実結果。liveReady 0 (fresh custody/CAS なし)・
  apply 許可 0 (grant なし) は別明示。
- 未選択 protected fields は LIMIT (将来 fresh SELECT が要る)。unit/locator
  の断定は既 output の範囲に限る (量子幅を unit 倍率/locator 証拠と偽らない)。
- 旧 journal/grants は照合読取のみ。CANCELLED grants は再利用しない。
- 本番/source GET は未実行 (fetch 0)。orders/text 修正 0。
