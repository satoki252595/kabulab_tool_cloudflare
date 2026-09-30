# 海外 CURRENT 3675 compare PREP (2026-09-30・local 実行済み)

frozen final-parser 出力 (repair-manifest 3675 全通) vs NEW
capture-live baseline (@08:40:31Z) の exact compare。parser 再実行なし。
network 0・書込 0 (OUT のみ)。per-doc 明細は private 0600 のみ。
本記録は counts・SHA・limits のみ (public 可)。

- at: `2026-09-30T09:41:01.974Z` (local)
- inputs: `repair-manifest.json` `754ecba7…ac98` /
  `repair-journal.jsonl` `85985cda…e2af` /
  `capture-live.json` `96f5af98…c25e` /
  `repair-sets.json` `cf39b957…9884` /
  `join-rows.json` `6ecefab5…8554` /
  `73-provenance.json` `eaf8fd89…39e6`

## Projection (frozen 8col → live 9col・self-verify 済み)

- manifest facts (regionName/regionKind/salesAmount/ratioPct/unitLabel/
  unitYenFactor/fiscalYearEnd/isConsolidated) を
  salesRaw=salesAmount・salesYen=amount×factor・
  pattern=currentStatus の `ok_` 除去で 9 col 化。
- journal after.rows との overlap 1760 通 / 3389 行で全一致を
  self-verify (mismatch 0) してから全 3675 通に適用。
  locator/unit の捏造なし (unit は unitLabel/unitYenFactor の実値)。
- 非 ok 系 status (2165 + 57) は facts 0 通であることを断言
  (rule 適用外なし)。proof (2222 通 null) は verdict 入力にしない
  (status + facts business rows のみ。proof は証跡として保持)。

## Verdicts (current・observed 全 3675)

- MATCH 494 / CHANGED_STATUS 0 / CHANGED_FACTS 929 /
  CHANGED_BOTH 2252 (合計 3675)。
- status 単独変化は 0 (status 変化は全通 facts 変化を伴う)。
- class × verdict:
  ADOPTED 1411 = MATCH 467 + FACTS 907 + BOTH 37 /
  CANDIDATE 2191 = MATCH 8 + BOTH 2183 /
  HOLD_PIN 73 = MATCH 19 + FACTS 22 + BOTH 32 (参考情報・HOLD 不変)。
- historical 1781/1894/1695 は current count にしない
  (tags 参照のみ)。

## Source candidate / adopted / HOLD

- pin-present (pinned) 3602 = ADOPTED 1411 + CANDIDATE 2191。
  HOLD_PIN 73 (pin `fixed-now` ≡ holdPinMissing 73/73)。
- scope-known: false 75 通は全通 ADOPTED 内
  (内訳 FACTS 59 + MATCH 16)。offline-candidate の既存条件
  (parse+validate+pin+不一致なし+scope既知+receipt) のうち
  scope既知を満たさない事実として報告 (新 class を作らない)。
  CANDIDATE 2191・HOLD 73 は全通 scope-known。
- validateOK false 0・pinMismatch 0。

## CAS inputs (protected14 / entire16・executor guard 用)

- DOC16 (Q1F 17 − factsCount)・protected14
  (DOC16 − {overseasParseStatus, overseasHonbunFile}) を形状断言。
- per-doc: protectedSHA (join 値と一致確認) + entire16SHA +
  parser/live status + parser/live facts count + verdict + class。
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
  (`custody-proposal.json` `8e36f488…25cf`)。

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

- affected = CHANGED かつ non-HOLD docs の stockIds: 520 stocks。
  (MATCH/HOLD 除外。HOLD 54 通の変化分は L2 対象外。)
- 97 以下 group に分割 → 6 groups (97×5 + 35)。
- steps (既存形状のみ): per-group rebuild scoped +
  order/overseas 入力・upsert・sweep・pre/post bounded 化・
  reentry 0・全 groups 単一 runStartedSec。
  MAX(submittedAt) は scoped でも global 全表である点に注意。
- 実行 0・書込 0。新規 framework なし。

## Outputs (0600・fsync)

- `compare-rows.json` `b3f6b217…7a1c` (3675 行)
- `compare-aggregates.json` `6d19c8ba…f5d0`
- `cas-inputs.json` `014b19d7…334b`
- `l2-scoped.json` `5f021f5e…510b` (520 stocks 実リスト + groups)
- `custody-proposal.json` `8e36f488…25cf` (bounded 20 通実リスト)
- `73-deep.json` `25d6dd42…6699`
- `run-record.json` (inputs/outputs SHAs・counts)

## zeros (now)

sourceGET 0 / Notion 追加 0 / D1 追加 READ+write 0 /
R2 0 / dispatch 0。parser 再実行なし。

## limits

- DB 観測は @08:40:31Z snapshot。executor は CAS guard で再確認する。
- ADOPTED/CANDIDATE は source 適格を意味しない (source-primary 別途)。
- 73 の過去 custody は UNKNOWN のまま。
- archive 実績の reverify/reupload なし (accepted)。
