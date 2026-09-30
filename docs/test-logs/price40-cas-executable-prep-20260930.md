# price40 missing-only 9/29 CAS executable PREP (LOCAL・WRITE 0)

日付: 2026-09-30。既存 PR197 実行物の exact 再使用 PREP。
コード変更なし。WRITE 0・source5 GET 0。
本番 WRITE は独立 review + Root write grant + final CODE CLEAR まで行わない。
counts/SHA のみ。

追記 (4cb 時点で冒頭の「コード変更なし」は stale。履歴として保持):
既存 `runGapRepair`/replay/builders/sender 本体は不変だが、fixed-packet
化のため thin adapter (`price40-cas-execute.ts`。依存 seam 注入のみ) を
追加済み。B11 参照も frozen SHA 参照から actual SQL guard (4 文目) へ
移行済み。4cb の full-B guard (core 3819/state/events) は Root の
touched-40 contract より広いため qualified packet ではない。
下記 scoped shared patch plan (touched-40 exact) の確定・実装待ち。
WRITE 0 のまま。

## 訂正: 既存 main は fixed-packet executor ではない (live BLOCKED)

- eb94 初版の「R1 drift STOP」等の主張は誤り。正確な既存 main の挙動:
  - `loadTargets` は runtime Map を作るだけで frozen R1 と比較しない。
    code→ID が変化していても新規採用し、後の CAS は runtime ID と
    照合する (承認済み ID との照合ではない)。
  - 実行の度に 55 件を ungated/default-follow で再取得する。
    新規 read の budget は未付与。
- よって既存 main の直接実行は live 不可。正規の実行物は下記の
  thin pinned CLI adapter (`runGapRepair` の依存 seam 注入) とする。
  既存 `runGapRepair` / replay / builders 本体は不変 (再使用のみ)。

## exact 実行物 (thin adapter + 既存 seam)

- adapter: `scripts/sync/price40-cas-execute.ts` (978 行)。
  self full SHA (報告のみ):
  `80e573784eff7ea7335aa0e502b82b495582d538916575a4353eea002580d104`
  (price branch。再 pin 3 件のみ差分。
  旧 packet 978 行 `1c3cbcdc…ac3da` / 917 行 `dd124e32…1e81` /
  845 行 `fbf0676d…37f93` / `fb80d0f8…69a0` は記録保持)
- 依存 8 件: loadCustody (retained 55)・loadTargets (R1-exact 47)・
  readRows (99-chunk)・sendBatch (frozen-body guard)・
  probe/persist (既存 local)・record (既存 + known-result 即時保存 +
  archive gate 再使用)・verifyReceipt (既存 + 同 gate)。
- D1 送信: SELECT 3 件は既存 bounded+capture stack
  (attempt・targetSHA・marker・durable・manual・retry0・wx)。
  batch POST ≤4 件は frozen-body allowlist + 同一 idiom wrapper
  (既存 sender 本体は不変)。
- preflight0 (canonical env。送信 0・network 0): **PASS** exit 0。
  artifacts 17・retained 58・modules 18・D1 URL SHA。stderr 0 bytes。
  stdout は private 固定 artifact に保存:
  `/tmp/price40-packet-preflight-20260930/PREFLIGHT.json` (0600)
  SHA `c182d1d83b44b38d6098ba9cec2453accd4e5baf51e1b6b1e7524760913fac75`
- modules 19: stockGapRepair `c190af5a…` / repairPreflight `da7e9b27…` /
  d1client `5a50ec98…` / daily `c1b03b62…` / swingSchema `fe9f19ce…` /
  coreSchema `3393ccc6…` / index `6b1f4547…` / archive `b4388151…` /
  client `4a7f7800…` / env `de8449e3…` / pageFile `48f8574f…` /
  sha256 `da3711c4…` / yahooClient `60bca236…` /
  yahooBarSanity `0f7ec911…` / archiveAdapter `70b19e72…` /
  freshCapture `fede652c…` / selectProof `6c864f43…` /
  universeOverlay `c69c0536…` / pnpmLock `805dd5b3…`
  (full 値は adapter 内定数)。
  注: price-branch bytes 基準 (latest main 3e045d8 世代。
  packet 世代 `2d16180b…` / `cf8294df…` / `3e25047d…` は記録保持)。
  preflight 再確定済み (下記)。
- read guards: 既存 `assertProjection` (select-proof) で full4/exact-8
  射影を確定 (違反は HOLD)。行は実型厳密検証
  (isActive は drizzle bool のみ。Number() 矯正なし)。
  null-or-finite・日付 exact・要求集合内・重複 STOP を経て map。
  preimage の absent→insert・同値→write0・差異→HOLD  typing は
  既存 seam のまま。frozen body の無言 retarget なし
  (不一致は送信前 STOP)。
- 既存 `runGapRepair` (L397-671)・`replayRawBar`・builders・
  `recordPrimaryData`・receipt 順序は不変。adapter は依存 8 件を
  固定 packet 用に差し替えるのみ。新規 framework なし。
- 起動形:
  `node --env-file=<canonical> node_modules/tsx/dist/cli.mjs scripts/sync/price40-cas-execute.ts --execute --grant=<Root承認文> --attempt-log=<fresh> --report-out=<fresh>`
  (`--eligible-file` は不要。eligible は frozen pin 内蔵)。
- runId は `priceSyncBatchRunId(startedAt)` (`local-<ms>`)。実行時確定の
  ため freeze 不可。同一 runId の再 POST は既存仕様で禁止
  (probe → HOLD → resume-only)。

## 実行順 (adapter 差替 + 既存 `runGapRepair` L397-671)

1. adapter `loadCustody`: source55 retained 55 件 (bytes+SHA+manifest)
   から既存 `parseDiagManifest` で復元。再取得 0。
   manifest complete・未試行 0・eligible 40 の `has_real_bar` を要求
   (既存判定のまま)。
2. eligible 40 を replay (既存 `replayRawBar`。evidence 流用なし)。
3. adapter `loadTargets`: D1 bounded 47 query (1 SELECT・full4) を
   frozen R1-actual 47 行と exact 照合 (重複・欠落・drift は write 前
   STOP)。通過分から actual 40 の code→id を返す。B full11 は不変参照。
4. `readRows` preimage (40 ids = 1 SELECT)。既存なし→insert 候補、
   7 値同値→write0、差異→HOLD。
5. `probeProofAbsent(runId)` (local のみ)。既存 runId は HOLD。
6. chunk batch 送信 (12/12/12/4)。1 chunk = 1 POST・3 文
   (銘柄同一性・不存在 CAS・plain INSERT)。最初の失敗で break
   (後続なし・再 POST なし)。sender に retry なし。
7. readback 再 SELECT (1 文)。`ohlcvSevenEqual` exact-match のみ
   適用確定。absent/drift/unobserved は unknown/HOLD。再送なし。
8. receipt: 0600 persist → `record` 1 回 (force:false) → 添付 readback
   (page-get 1 + hosted 1)。Unknown 含め再送なし。
   回収は `resume-receipt --run-id` の readonly のみ。

## 入力証拠 (固定。preflight 照合済み)

- source55 same-run: report `54547fec…edbc` (10924B) /
  attempt `ccfffba1…5c32bb` (126908B) /
  retained manifest `f509f5…94d` (10329B) + raw 54 (計 58 件)。
- actual R1: 47 行 exact-1。body `3187e4c8…afbe7` (3505B)。
  packet-r1 `997bcf84…5312e` (2213B)。code→id は R1-actual を正とする。
- Bpost core full11: 保護対象 (参照のみ)。`9bc6b50b…1ec8` (1057631B)。
  対象表は `swing_daily_ohlcv` のみ。指標・財務 0。
- actual R2 preimage: 0 行 (40/40 absent)。body `497e22b7…ed44fe` (364B)。
  packet-r2 `d9e35a8d…8d0e` (3929B)。証拠のみ (書込時 proof に代用しない。
  不存在は batch 内 CAS が再確定)。
- eligible grant: `643d017a…ee8e4b` (1107B)。40 codes。
- expected-post-40: `5b722925…27d3b` (5205B)。40 full7tuples。
  stockId は R1-actual と全件突合済み。
- body-hashes `24459b16…771c` / tuples `af861e0d…1505` /
  chunk-plan `fcfb7bcc…4248` / budget `7efbbe88…85ad` /
  replay-40 `2db97ff0…a15f1` (既凍結のまま)。

## canonical chunk bodies (凍結。private)

- v1 `/tmp/price40-prep-20260930/chunk-bodies.json` (0600):
  既存 builder 3 文/chunk (記録保持。実行は v2)。
  16068 bytes,
  SHA `b60793c9403bd7a985e4f77a3c7a1772bf9239acd4ecd40cd874615449bfb26e`。
- v2 `/tmp/price40-prep-20260930/chunk-bodies-b11.json` (0600):
  既存 builder 3 文 + B11 parent guard 1 文の 4 文/chunk。
  binds [36,24,96,1]×3 + [12,8,32,1] (上限 100/文以内)。
  4819284 bytes,
  SHA `614963b6ec2efa7ab0415d546341b5aea41b7bd036fee1248b53898a1fb92fc8`。
- 順序は executable 真実 (manifest.codes 逐次 ∩ eligible ∩
  has_real_bar)。chunk-plan の順序と一致確認済み。
- 注意: runtime の `loadTargets` 再解決と batch 内 CAS が最終確定。
  本 bodies は計画確定値 (drift 時は CAS が STOP する)。

## B11 parent CAS (actual guard。frozen SHA 参照ではない)

- 既存 `buildOverlayPreflightStatement` (full-row 両方向 EXCEPT +
  件数。1 JSON bind) を既存 `assertValidSnapshotShape` 済みの
  承認 B snapshot (core 3819×11 + state 1 + events 226。
   eligible 40/40 被覆確認) から生成し、adapter の sendBatch seam で
  4 文目として同一 atomic batch に追加する。新規 SQL なし。
- guard bind は 851116 bytes JSON (本番 overlay path と同一機構)。
- 保護範囲は core/state/events 全集合 (touched40 の上位集合)。
  対象外行の drift も縮小せず STOP する (conservative)。
- 意味 proof (offline。stdlib sqlite3 のみ。network 0):
  保護 field 全 33 flip (core 11 + state 10 + events 12) + 行追加 +
  base 通過の 34 cases。全 flip で guard error → tx rollback →
  writes 0。行追加も block + writes 0。結果 PROOF-OK。
  - guard SQL `a984daba…264f7` / doc `f6c08d90…12823` /
    fixture `19f0cc99…773f` / emitter `0ca0f94b…a985` /
    runner `044b9e82…2925` (`/tmp/b11-proof-20260930/` 0700・0600)。
  - 機構 proof (小規模 snapshot)。本番は full 3819 snapshot の
    同一 SQL 形。D1 batch 原子性は既存実証の前提 (再実証なし)。

## scoped shared patch: touched-40 exact guard (実装済み。qualified-pending)

4cb の full-B guard (851116 bytes JSON × 4。core 3819 + state + events)
は Root contract (touched-40 full11) より広い。4cb を qualified packet
としない。Root 承認により下記 scoped 化を実装 (live WRITE なし)。
qualified 判定は fixed CLEAR まで pending (本記録は qualified 主張なし)。

- 共有 patch (`src/cron/universe-overlay.ts` のみ):
  1. `assertValidCoreRows(rows)` を export (既存 shape 関数の core 部分
     を抽出。同関数はこれを呼ぶ。移動行は byte-identical
     (loop 変数名のみ))。
  2. `buildCoreRowsPreflightStatement(rows)` を export (core-only。
     act 側は `WHERE id IN (承認 ids リテラル)`。件数 + 両方向 EXCEPT +
     json(CASE) error idiom は既存機構と同一。空集合は拒否)。
  3. 既存 `buildOverlayPreflightStatement` 本体は無改変。
     既存 overlay tests PASS (packet 世代 71/71。price-branch 再確認:
     src/cron 51/51 + scripts/sync 2/2。挙動維持)。
- adapter 側: guard 生成を新 helper + 承認 40 B rows
  (Bpost ∩ 承認 IDs。`assertValidCoreRows` 済み。id 昇順 canonical) に
  切替。guard doc は 7866 bytes (1 bind)。
- bodies v3 `/tmp/price40-prep-20260930/chunk-bodies-t40.json` (0600):
  4 文/chunk。binds [36,24,96,1]×3 + [12,8,32,1]。
  68276 bytes,
  SHA `e33ed352439f818506aba93d88c24f526856c3a03bde568c58e31508c584616d`。
  (v1/v2 は記録保持。実行は v3。budget v2 の counts は同一)
- proof (offline。stdlib のみ。network 0):
  base 通過 + 保護 11 cols 全 flip block + 削除 block + 全 flip で
  writes 0。scope proof: 非対象行 (41st) flip 3 件は guard 通過 +
  writes 1 (touched exact の確認)。結果 PROOF-OK。
  - guard SQL `0dde1534…a8af3` / doc `1f2fc786…9e330` /
    fixture `244c867f…e5010` / emitter `c0f62437…99a9` /
    runner `6dad4740…d269` (`/tmp/b11-proof-t40-20260930/` 0700・0600)。
  - 機構 proof (小規模集合)。本番は承認 40 行の同一 SQL 形。
- one-off raw SQL copy なし。新規 framework なし。
- 実装中の defect 記録: 初版 scoped SQL の最終 CTE 末尾カンマで
  base case が syntax error。proof が検出して修正 (現行 bytes)。
  v3 bodies は修正後に再 freeze (旧 bytes は未記録・未 commit のため
  破棄)。originals (v1/v2/proof 記録) は保持。

## outcome acceptance: 期待 outside-7 診断 (実装済み。Root 承認済み)

既存 producer (`runGapRepair` L439) は source-real の outside-eligible
7 件を held (`not-in-eligible-set`) に入れる。旧 `clean`
(`held.length === 0` 要求) は 40 applied 成功でも HOLD/exit 1 を返す
concrete blocker のため、最小 acceptance に修正 (事実の除去なし。
held 7 件は private report に全件保持・報告する):

- `classifyPacketClean(rep, eligible.codes)` (純関数。adapter 内):
  aborted 偽 + unknown 0 + applied 40 +
  held が期待 7 件のみ (各件が eligible 外 code かつ
  reason exact `not-in-eligible-set`) を APPLIED とする。
  eligible-held・想定外 reason・件数 drift は HOLD。
- `PACKET_EXPECTED_OUTSIDE_HELD = 7` (導出: pinned manifest
  has_real_bar 47 − pinned eligible 40。pure proof が actual 照合)。
- proof 用に既存 loader を export (挙動不変):
  `loadRetainedCustody` (ctx 最小面 `CustodyLoadCtx` に分離)・
  `loadFrozenR1`・`loadFrozenEligible`。

pure reentry proof (既存 `runGapRepair` を PURE deps で駆動。
network/Notion 0。fetch は throw stub で物理禁止。no second runner):
same retained55 custody + 承認 expected-post full7
(`5b722925…27d3b`) + fake receipt (not live):

- A reentry (readRows=full post): sendBatch 0 / write0 40 / applied 0 /
  approved-held 0 / outside-7 保持 / excluded 7。
  (reentry は APPLIED 主張なし。適用済み確認の事実のみ)
- B first-run (preimage 0 → readback full post): sendBatch 4 /
  applied 40 / capture 40 full7 == expected-post / classifier APPLIED。
- C 対照 (eligible 1 行 drift): sendBatch 0 / write0 39 / held 8
  (`existing-row-differs`) / classifier HOLD。
- D 対照 (custody outside 6 ≠ 7): applied 40 でも classifier HOLD。
- 結果 PROOF-OK (`/tmp/price40-outcome-proof-20260930/` 0700・0600)。
  packet 世代: `PROOF.json` SHA
  `8f91616390c840b82ffadb00da0519aad8f2a09d6a6d976eba2acf6222cb130e` /
  adapter `1c3cbcdc…ac3da` (記録保持)。
  price-branch 再実行: `PROOF.json` SHA
  `3d60e8500e5e4855187d7f3b162722d3f659dcd2aa260be9c4516f0a19eb325e` /
  runner SHA `7808b834e0d78107b99f88166c6573bd2daaaa03d0ba54b007901876212128cc` /
  evidence `c27af448…724cf7` /
  adapter `80e57378…d104` / producer `c190af5a…30189`。
  同一 4 case 全合格 (fetch 0)。

将来の NEW POST 手順 (確定。live reapply 禁止):
receipt の 40 full tuple 照合 → local pure reentry-0 (本 proof と同一形。
追加 live reapply なし)。

## bounded send/post budget (凍結)

- v1 `/tmp/price40-prep-20260930/budget-send.json` (0600):
  1275 bytes,
  SHA `39c527f82342bee8a3f50ffb84117445e386f52157f4e71009ef48a25c510757`
  (記録保持。実行は v2)。
- v2 `/tmp/price40-prep-20260930/budget-send-b11.json` (0600):
  1293 bytes,
  SHA `a25c249b2dce49c2ef5dedf2d05f377bd3eb7656e79d327b6c4cb8a78e3853b2`
  (記録保持。実行は v3)。
- v3 `/tmp/price40-prep-20260930/budget-send-t40.json` (0600):
  1416 bytes,
  SHA `fdc700a9608a63c4343ba4c78fb87547e7b7eac94f69da3c6c66b926892f39dd`。
  v2 の statements_total 16 は batch-only scope の誤記のため訂正
  (binds [36,24,96,1]×3 + [12,8,32,1] は t40 実測と同一)。
- D1: SELECT 3 (targets 1 + preimage 1 + readback 1) +
  batch POST ≤4 (4 文/POST = 既存 3 + scoped T40。batch 計 ≤16 文)。
  HTTP 計 ≤7・文計 ≤19 (SELECT 3 + batch 16)。
- Notion: custody 再取得 0 (retained 使用) + receipt
  (persist 1 → record 1 → page-get 1 + hosted 1)。
- Yahoo 0。

## preflight sends0 (凍結)

- `/tmp/price40-prep-preflight-20260930/PREFLIGHT.json` (0600):
  artifacts 16・modules 14・envOk・sends 0。exit 0。
  SHA `a73bfd0ab555cb2dff13ddb7bfe2249aeb8b26d333078c7d243a852583e60d17`
- modules 14: stockGapRepair `c190af5a…` / repairPreflight `da7e9b27…` /
  d1client `2d16180b…` / daily `c1b03b62…` / swingSchema `fe9f19ce…` /
  index `6b1f4547…` / archive `b4388151…` / client `4a7f7800…` /
  env `de8449e3…` / pageFile `48f8574f…` / sha256 `da3711c4…` /
  yahooClient `cf8294df…` / yahooBarSanity `0f7ec911…` /
  pnpmLock `805dd5b3…` (full 値は preflight 内)。
- env: Notion 2 + D1 3 の typed presence のみ (値なし・network なし)。
- outcome-fix 後再確定 (canonical env。送信 0・network 0): **PASS** exit 0。
  artifacts 17 (budgetSend v3 pin 含む)・retained 58・modules 18・
  D1 URL SHA。stderr 0 bytes。
  `/tmp/price40-packet-preflight-20260930/PREFLIGHT.json` (0600)
  SHA `c182d1d83b44b38d6098ba9cec2453accd4e5baf51e1b6b1e7524760913fac75`
  (出力 JSON 同一のため既報 SHA と一致)。
  packet 世代 adapter `1c3cbcdc…ac3da` (978 行) で実行 (記録保持)。
  price-branch 再確定: 同 PASS (exit 0・sends 0・stderr 0)。
  adapter `80e57378…d104` + main 世代 3 pin で検証済み。

## review 項目 (write grant 判断用。正直記録)

- 既存 main の直接実行は live 不可 (上記訂正)。adapter が
  custody の再取得 0・R1 exact 照合・frozen body exact-send を強制する。
- runId・fetchedAt・generatedAt は実行時確定 (freeze 対象外)。
- runtime identity drift・preimage 変化は adapter 照合 + CAS/readback が
  STOP/HOLD する (計画値との差は失敗扱い。再送なし)。
- receipt record 内部の API 試行は archive gate 再使用で上限強制
  (mutation は granted receipt 経路のみ)。
- D1 送信は bounded capture (cap・manual・retry0・durable・strict) 再使用。
  POST ≤4・SELECT 3 の exact budget。

## 予算消費・残

- 追加の D1/Notion/Yahoo 送受信は 0 のまま (本 PREP は local のみ)。
- price WRITE 0・source5 GET 0 は各 final CODE CLEAR まで維持。
