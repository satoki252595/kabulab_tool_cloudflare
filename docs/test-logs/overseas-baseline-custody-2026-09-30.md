# 海外 baseline custody / current PREP proposal (2026-09-30)

LOCAL proposal のみ (未実行)。現行基準は frozen 3675 + current parser +
NEW full16/Q2 all13。旧 1781/1894 分割・旧 1687/1695 counts は
historical のみ (live target count にしない)。
本記録は counts・SHA・limits のみ (public 可)。raw・表・値は
private 0600 のみ。

- branch: `fix/overseas-baseline-custody-20260930` from main `e5e4463` (PR219 merge)
- run HEAD `f352c7c` は commit object として保持 (書換なし)。
  main 上の runner blob は run 時と同一 (`666de96e…`)。
  closed-219 branch への push なし。

## Baseline freeze (local 確定済み)

- ZIP (stdlib・deterministic・rebuild 同一 SHA):
  `freshread-baseline-20260930.zip` 16579214 bytes
  `e8948dc3…4292f99` (0600)。
- members 160: capture-union/manifest/live/report + attempt.log +
  raw body 74 + markers 74 + preflight/stdout/run-record/packet/chunks +
  baseline-pins.json + member-list.json (payload のみ・self-hash なし)。
- immutableKey: `freshread-baseline-20260930:{liveSHA}`
  (`liveSHA` = `96f5af98…`。actual capture 由来)。
- one logical shared strict custody: 上記 key の単一論理単位。
  ZIP pin は byte identity であり physical Notion custody ではない
  (PENDING のまま)。
- code/source/preflight pins は baseline-pins.json に固定
  (runner blob/full・params/combined/SQL・union・d1Target)。

## Archive 境界 (conditional GO・未実行)

- Root conditional GO: ONE shared force=false logical record +
  full hosted ZIP + ALL members。SourceGET 0 / D1 write 0。
- 実行は review boundary の後: fixed hash / member list / full pins /
  safe format の independent CODE CLEAR + Root first notification。
  境界通過後は追加 Root wait なしに進行可。
- safe format: 上記 ZIP bytes + member-list + pins のみ。
  全 members 検証 (count/SHA) を archive 前後に行う。

## Join proposal (parser rerun なし・未実行)

- 既存 PR216 private facts/proof journal (per-doc after/proof/facts) を
  NEW 3675 baseline (fresh Q1F/Q2F) に join する。parser 再実行なし。
- verdicts: changed / match / hold + source-custody-pending を分離する。
  旧 1687/1695 は使わない (join 実結果のみ)。
- 保護: doc14 不変 + expected2 (overseas status/honbun) 比較。
  facts は business key + 全列 + NULL + count で照合。
  full preimage (doc 全16 + facts 全列) を CAS 入力とする。

## 73 pin-inspection (local・fetch 0・確定)

- 73/73: ZIP あり + fresh identity あり + 旧 pin 不足
  (category pin-absent)。per-doc 明細は private 0600
  (`inspect-73.json` `0e82871d…97e3b`)。
- 全通 HOLD (過去 custody UNKNOWN。偽補完なし)。
  official fresh GET は custody 資格化に needed (将来 grant)。
  73 は permanent skip ではない。

## Physical lookup/readback (bounded PREP・将来 grant)

- 既知 primary proof を再使用。既存 20doc/40keys/41cap helper の
  bounded PREP で行う。UNKNOWN 既存 key の re-record 0。

## L2 / CAS (proposal のみ)

- L2: NEW baseline join で確定した affected actual stockIds のみ
  scoped 再生成 (≤97/call・単一 runStartedSec・bounded pre/post /
  reentry 0)。scoped MAX は将来最小 helper。旧 L2 温存なし。
- CAS: entire16 + all facts。runtime NEW ids (DELETE+INSERT 置換)。
  scoped L2 sweep explicit。orders/text 変更 0。
- post: doc protected id+fields 不変 + expected NEW facts exact
  (全列/論理キー/count/NULL + fresh PK unique + referential identity)。

## zeros (now)

sourceGET 0 / Notion READ+archive 0 / D1 READ+write 0 /
R2 0 / dispatch 0。D1 READ 74 は前 run の authorized ONE のみ
(再実行・re-GET なし)。

## limits

- 本 proposal 未実行。freeze ZIP は local 確定 (hosted archive は
  review boundary の後)。
- ZIP pin != physical Notion custody (PENDING)。
- 73 は HOLD 継続 (将来 official fresh GET 道あり)。
- code/test 新規なし (plan のみ)。
