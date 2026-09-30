# 海外 CURRENT 3675 compare PREP (2026-09-30・local 実行済み)

frozen final-parser 出力 vs NEW capture-live baseline (@08:40:31Z) の
exact compare。actuals のみ (custom projection 0・`??` fill 0)。
network 0・書込 0 (OUT のみ)。per-doc 明細は private 0600 のみ。
本記録は counts・SHA・limits のみ (public 可)。

- at: `2026-09-30T09:59:09.265Z` (local・v2 actuals)
- inputs: `repair-manifest.json` `754ecba7…ac98` /
  `repair-journal.jsonl` `85985cda…e2af` /
  `capture-live.json` `96f5af98…c25e` /
  `repair-sets.json` `cf39b957…9884` /
  `join-rows.json` `6ecefab5…8554` /
  `73-provenance.json` `eaf8fd89…39e6` /
  `overseas_laneA_okdocs.json` `034cefad…8735`
- modules: parser blob `07ad7a54b975` (PREP 時と同一・不変) /
  shared helper blob `a3ffe816af35` /
  repair-prep blob `6b2b084c77d8`

## 共有正準変換 (5 callers・同一関数)

- `services/yuho-quant/src/services/overseas-save-rows.ts` に
  toYen + overseasPatternOf + toOverseasSaveRows を集約。
  writers (backfill-overseas・ingest・missing-backfill) も PREP
  (745-prep・repair-prep) も同一関数を呼ぶ。
  writers は documentId/stockId 付与のみ (9列組立の copy なし)。
  orders 系は toYen 共用のみ (振舞い変更なし)。
- 型は閉 domain (OverseasParseStatus 4種 | "parse_error")。
  実行時未知は throw (pattern 化しない。"none" 黙認なし)。
  valid の unstructured/no-table/parse_error → "none" は保持。
  toOverseasSaveRows は map 前に pattern を1回確定する
  (facts=[] でも未知 status は throw)。
- null は素通し (0/factor1 埋めなし)。undefined/欠落は throw。
  非型付入力は呼出側が事前検証する (helper は全列検証を主張しない)。
- test 8 passed (丸め・null・未知 throw・empty 配列・伝播)。
  既存 full suite green (migration の振舞い同一性)。

## Actuals (3654 verbatim + 21 fresh parse・LIMIT 0)

- JOURNAL_ACTUAL 3654: journal after.rows を verbatim 使用
  (observed 1760 top-level + historical 1894 nested)。
  9列形状を全行事前証明 (違反は LIMIT・補完なし)。
- FRESH_PARSE_ACTUAL 21: journal なし (by design・changed+HOLD のみ
  記録) の 21 通を frozen ZIP から offline 再 parse (GET 0)。
  同一 parser (blob 不変) + 同一 validator + 共有 toOverseasSaveRows。
  fresh ex.facts/ex.status が retained manifest と 21/21 完全一致
  (determinism 証明。不一致は LIMIT)。
- SOURCE_OUTPUT_LIMIT 0 (unreproducible なし)。
- 旧 v1 projection 方式は BLOCKED・破棄 (counts は WIP のまま公開せず、
  本 v2 actuals が final)。

## Verdicts (current・compare-observed)

- MATCH 494 / CHANGED_STATUS 0 / CHANGED_FACTS 929 /
  CHANGED_BOTH 2252 / LIMIT 0 (合計 3675)。
- 内訳: JOURNAL 3654 = MATCH 473 + FACTS 929 + BOTH 2252 /
  FRESH 21 = MATCH 21 (旧 live・NEW live とも一致の stable 通)。
- status 単独変化は 0 (status 変化は全通 facts 変化を伴う)。
- class × verdict:
  ADOPTED 1411 = MATCH 467 + FACTS 907 + BOTH 37 /
  CANDIDATE 2191 = MATCH 8 + BOTH 2183 /
  HOLD_PIN 73 = MATCH 19 + FACTS 22 + BOTH 32 (参考情報・HOLD 不変)。
- verdicts は compare-observed であり、authoritative repair count
  としない (HOLD/LIMIT 除外・別途 qualification 要)。
- historical 1781/1894/1695 は current count にしない
  (tags 参照のみ)。

## Source candidate / adopted / HOLD

- pin-present (pinned) 3602 = ADOPTED 1411 + CANDIDATE 2191。
  HOLD_PIN 73 (pin `fixed-now` ≡ holdPinMissing 73/73)。
- scope-known false 75 通は全通 ADOPTED 内
  (内訳 FACTS 59 + MATCH 16)。offline-candidate の既存条件
  (scope既知) を満たさない事実として報告 (新 class なし)。
  CANDIDATE 2191・HOLD 73 は全通 scope-known。
- validateOK false 0・pinMismatch 0。

## CAS inputs (protected14 / entire16・executor guard 用)

- DOC16・protected14 を形状断言。per-doc protectedSHA は
  join 値と一致確認 (verbatim)。entire16SHA を追加。
- 旧 facts full preimage は CAS guard (書込前照合) 専用。
  本キー単独で repair 実行しない。

## Primary custody (baseline と分離・既存 proof 再使用)

- qualified (live-ready/source-primary) 0 /
  offline-candidate 0 (既存分類の再使用。receipt 証跡なしの実結果) /
  ARCHIVE_PENDING 3675 (全通・73 を含む) /
  UNKNOWN (past) 73 (overlap を明示・保持)。
- known physical proofs (再使用・reverify なし):
  journal 記録の sealed-post 6 件 + applied59 の L3match 59/59
  proxy 根拠 + sealed baseline (別途保持)。
  RECEIVED は explicitly verified physical closure まで到達なし。
- bounded lookup/readback proposal (exact・proposal のみ):
  hold73 の docID sort 先頭 20 → `{doc}:type1`/`:type5` の 40 keys を
  1 run (上限 41 内) で照会する。契約は `recordEdinetZip` /
  `TypeCustody` (complete/metadata-only/missing/not-applicable)。
  既存 custody の照会であり再取得・re-record なし。
  照会 0 (将来別 grant)。対象 20 通は private
  (`custody-proposal.json` `32f89752…75e6`)。

## 73 deep provenance (既存証跡の検査・REQUIRED 未 deem)

- manifest metadata: pin `fixed-now`・zipSHA/zipBytes・periodEnd・
  status (current/saved)・honbunFile・tablesScanned・facts 計 239・
  validateOK 全 true・receipt 全 ARCHIVE_PENDING・tags。
- ZIP identity: PREP 時 zipSHA vs fresh actual SHA が 73/73 一致
  (bytes も 73/73 一致。local bytes 不変)。
- central directory: 73/73 valid (member 名は private のみ)。
- receipts: applied59 0/73・sealed-post 0/73・known proof 0/73。
- HOLD 理由: PIN_ABSENT + NO_SEALED_POST + NO_APPLIED +
  RECEIPT_ARCHIVE_PENDING + PAST_UNKNOWN。
- freshGET は NEEDS_SOURCE_PROVENANCE_REVIEW を継続。
  REQUIRED は deem しない (Root 判断)。過去 UNKNOWN を保持。

## L2 scoped (affected 実 stocks・proposal のみ)

- affected = CHANGED かつ non-HOLD かつ non-LIMIT docs の
  stockIds: 520 stocks。(MATCH/HOLD 除外。)
- 97 以下 group に分割 → 6 groups (97×5 + 35)。
- steps (既存形状のみ): per-group rebuild scoped +
  order/overseas 入力・upsert・sweep・pre/post bounded 化・
  reentry 0・全 groups 単一 runStartedSec。
  MAX(submittedAt) は scoped でも global 全表である点に注意。
- 実行 0・書込 0。新規 framework なし。

## Outputs (0600・fsync・v2)

- `compare-rows.json` `1f264da5…ce63` (3675 行)
- `compare-aggregates.json` `fbecbdcd…0628`
- `cas-inputs.json` `9bd04a40…33ee`
- `l2-scoped.json` `a5df2bb4…2ef2` (520 stocks 実リスト + groups)
- `custody-proposal.json` `32f89752…75e6` (bounded 20 通実リスト)
- `73-deep.json` `58f5a3a6…fd59`
- `run-record.json` (inputs/outputs SHAs・module pins・counts)

## zeros (now)

sourceGET 0 / Notion 追加 0 / D1 追加 READ+write 0 /
R2 0 / dispatch 0。parser 再実行は frozen ZIP の offline 21 通のみ
(GET 0・Root 許可)。fetch deny 固定。

## limits

- DB 観測は @08:40:31Z snapshot。executor は CAS guard で再確認する。
- ADOPTED/CANDIDATE は source 適格を意味しない (source-primary 別途)。
- 73 の過去 custody は UNKNOWN のまま。
- archive 実績の reverify/reupload なし (accepted)。
