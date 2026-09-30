# 海外 baseline custody / current PREP proposal (2026-09-30)

現行基準は frozen 3675 + current parser + NEW full16/Q2 all13。
旧 1781/1894 分割・旧 1687/1695 counts は historical のみ
(live target count にしない)。
archive ONE は実行済み PASS (09:18:19Z)・join PREP は local 実行済み
(09:28:15Z)。再実行・re-GET・re-record なし。
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
- ZIP 160 members = payload 159 + member-list 1。
  payload: capture-union/manifest/live/report + attempt.log +
  raw body 74 + markers 74 + preflight/stdout/run-record/packet/chunks +
  baseline-pins.json。member-list は payload のみ列挙 (self-hash なし)。
- immutableKey: `freshread-baseline-20260930:{liveSHA}`
  (`liveSHA` = `96f5af98…`。actual capture 由来)。
- one logical shared strict custody: 上記 key の単一論理単位。
- baseline ZIP は OBSERVATION (DB 観測の保管)。
  3675 rawZIP の primary proof では決してない。
  source-primary の適格判断は join PREP / source 照合が担う
  (証跡 `docs/test-logs/overseas-current3675-join-2026-09-30.md`)。
- code/source/preflight pins は baseline-pins.json に固定
  (runner blob/full・params/combined/SQL・union・d1Target)。

## Archive runner (ONE 実行済み PASS・再実行なし)

- 実行 bytes: `services/yuho-quant/data-scripts/overseas-baseline-archive.ts`
  HEAD `e793866` (blob `41e890d7fc68`, FULL `e784c025…bec0`)。
  09:18:04Z→09:18:19Z exit 0: recorded・manifestMatch written・
  Notion 16 ≤ 96・hosted GET 3 = 3・ZIP 160 closure 3/3 + 3/3。
  pageId は private report (`a8113ca0…0cf52`) のみ。
- e793 order 限界 (保持・捏造なし): known-result は readback 後の
  最終 report にのみ保存された。事後の `archive-record-receipt.json`
  (`f3a3aebd…76a0b`) は post-hoc 保持であり、returnedAt は
  実 instant ではなく send-log 由来の bound
  (09:18:14.169Z→09:18:15.231Z) として記録した。
  earlier receipt の捏造なし。
- producer 修正 (rerun なし・将来 HEAD 用): record 復帰直後に
  known-result を wx0600+fsync で即時保存し、その後に
  unique/readback を行う (blob `4ff6ee00caaf`、
  FULL `0cc1b2ef…4700`、self pin `269c2fc3…655`、
  test 8 passed・preflight `bfcaa288…9de` sends 0)。
- fixed key `freshread-baseline-20260930:{liveSHA}` + fetchedAt 08:40:31Z。
  force=false 固定。record → queryUniqueRow 一意性 →
  verifyArchivedAttachments 全 3 files bytes/SHA (既存 Promise<void>)。
  Unknown 再送なし。too_large/unknown-manifest は HOLD。
- 比較: ZIP bytes+SHA pin + member-list/pins pins + payload 件数。
  159 payload SHA は freeze 時独立検証済み・同一 ZIP bytes が保証
  (member-list bytes 照合。新 ZIP parser なし)。
- 固定 gate (native 前): Notion API 試行 ≤ 96・hosted GET ≤ 3 を
  実数し、durable log の上で forward。非 GET/非 GET-POST・budget 超過・
  不明 host は拒否。shared retry 意味・Unknown 不再送は不変。
  stdout HOLD は safe label (helper 由来 detail は 0600 のみ)。
- modules pin 10: self 正準化 + shared archive/readback/client/
  file-upload/page-file/env/index/sha256 + pnpm-lock。
- preflight: exit 0 (送信 0・書込 0・fetch 拒否固定)。freeze pins +
  modules + typed TOKEN/PAGE_ID 存在 (欠落は HOLD nonzero)。
  証跡 `archive-preflight.json` `4cbeafb2…63683` (0600)。

## Archive 境界 (通過・実行済み)

- Root conditional GO + independent CODE CLEAR + Root first
  notification を経て ONE を実行した (追加 wait なし)。
  force=false・full hosted ZIP + ALL members・SourceGET 0 / D1 write 0。
- safe format: ZIP bytes + member-list + pins のみ。
  全 members 検証 (count/SHA) は archive 前後に完了。
- 以降の reverify/reupload/re-record/new key なし
  (Root accepted・追加 Notion 停止)。

## Join PREP (local 実行済み・parser rerun なし)

- fresh Q1F/Q2F x pin census 3602 x tags x inspect-73 の exact join を
  local 実行した (network 0)。parser 再実行なし。
  証跡 `docs/test-logs/overseas-current3675-join-2026-09-30.md`。
- 3675 = PIN_PRESENT 3602 + PIN_MISSING_HOLD 73。
  distinct stocks 563 (HOLD 接触 67)。Q2 21245 = 20848 + 397。
  論理キー doc 内重複 0。
- 73 は全通 ZIP あり + actual SHA 初回記録 + fresh identity あり。
  NEEDS_SOURCE_PROVENANCE_REVIEW・HOLD 継続 (REQUIRED なし)。
- CAS keys (protected14 SHA + Q2 key/rows SHA)・L2 stock 集計は
  join 成果物に確定 (executor guard 入力・書込 0)。
  旧 1687/1695 は使わない (join 実結果のみ)。
- current compare (frozen parser × NEW live) は別記録に確定
  (MATCH 494・CHANGED 3181・L2 affected 520・bounded 20/40 提案)。
  証跡 `docs/test-logs/overseas-current3675-compare-2026-09-30.md`。

## 73 pin-inspection (local・fetch 0・確定)

- 73/73: 既存 ZIP あり + NEW DB identity あり + 旧 pin 不足
  (category pin-absent)。per-doc 明細は private 0600
  (`inspect-73.json` `88c2d5a0…90b93`)。
- 検査範囲の限定: official source metadata・current ZIP issuer・
  doc identity・known physical proof は未検査。
  既存 ZIP actual SHA は join PREP で初回記録済み (73-provenance)。
  source identity / known receipt は検査待ちのため全通
  NEEDS_SOURCE_PROVENANCE_REVIEW を継続する。
  REQUIRED は既存 official provenance が資格化不能な場合のみ付与する。
  旧 pin 不足が GET を強制するとは主張しない。
- 全通 HOLD 継続 (過去 custody UNKNOWN・現資格なし。偽補完なし)。
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

sourceGET 0 / D1 追加 READ+write 0 / R2 0 / dispatch 0。
Notion 16 + hosted 3 は authorized ONE archive のみ。
D1 READ 74 は前 run の authorized ONE のみ
(再実行・re-GET・re-record なし)。

## limits

- baseline ZIP は OBSERVATION。3675 rawZIP の primary proof ではない。
- PIN_PRESENT は source 適格を意味しない (source-primary 別途)。
- 73 は HOLD 継続 (過去 custody UNKNOWN・現資格なし)。
- DB 観測は @08:40:31Z snapshot。executor は CAS guard で再確認する。
