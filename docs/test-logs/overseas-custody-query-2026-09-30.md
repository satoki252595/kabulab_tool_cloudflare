# Source-custody query runner (2026-09-30・round1 実行済み・rest PREP)

query-only 照会 runner。既存 helper `checkDocsCustody` を再使用
(新規 framework なし)。read-only route guard + closed caps +
hash-first packet。round1 (20/40) は ONE 実行済み PASS。
rest (3655/7310) は PREP のみ・live は grant 待ち。

- script: `services/yuho-quant/data-scripts/overseas-custody-query.ts`
  (FULL `4ac4489d…9ab5d`、self pin `42d54333…069d3`)。
  test `services/yuho-quant/src/tests/overseas-custody-query.test.ts`
  21 passed 同梱 (実 helper bytes 照合 + retry/変造 guard 含む)。
- preflight (両 round): `cb6a686f…10f3` exit 0・sends 0・writes 0・
  round1 (20/40・chunkBodies 1) + rest (3655/7310・chunkBodies 183)
  検証済み (canonical env・typed parent 照合済み)。
  旧 preflight 成果物は HEAD 明示 rename 済み
  (`preflight-55d1229-stdout.json` = `6570d974…7ab80`・
  `preflight-1aa5cbd-stdout.json` = `ae83938f…deeb`・bytes 不変)。
- round1 実行 bytes: FULL `577af613…9c9f57`
  (HEAD `9144b25`・CODE CLEAR 済み・bytes は履歴に保持)。
- rest 束縛強化 (live 0 のまま): query は当該 chunk の canonical
  body SHA 厳密一致のみ許可 (membership 検査から置換)。
  同一 chunk 再送は 2xx まで許可・前進は 2xx 後のみ・
  最終 query 成功 chunk 数 = round chunks を assert。

## Round1 result (ONE 実行済み PASS・再実行なし)

- window: `2026-09-30T10:48:35.511Z` → `10:48:36.641Z` exit 0。
  workHEAD `9144b25` 照合一致。
- verdicts: 20 docs / 40 keys — t1 missing 20・t5 missing 20
  (全 40 keys 行なし。query `results 0 / has_more false`)。
- network: native 2 (search 200 + query 200)・rejected 0・
  rateLimited 0・retries 0。bodies 2 保存。
  DB 既存発見 (scan 代替・CREATE 経路なし)。
- receipts (0600): findings `40787ec6…5dafb`・
  attempt log `b771b6e6…3d14`・search body `19314ce9…`・
  query body `c46d2026…`。stdout counts/SHA のみ・stderr 空。
- zeros: sourceGET 0 / D1 0 / R2 0 / dispatch 0 / writes 0。
- missing 行から freshGET necessity を推論しない。
  原本 ZIP / official provenance を先に扱う (REQUIRED は Root 判断)。
- primary READY 0 (query-only)。byte 適格化なし。

## Fixed scope (rounds)

- round は `--round=1|rest` の明示指定のみ (default なし)。
- round1: hold73 先頭 20 通 (docID sort)・40 exact keys。
  key manifest `custody-keys-20.json` `f2f348d5…158f`。
  実行済み・重複照会禁止。
- rest: union 3675 MINUS round1 exact 20 = 3655 通・7310 keys
  (docID sort・均一 packet・53+3602 分割なし)。
  key manifest `custody-keys-rest.json` `6d0f4e9b…bd6e`。
  183 chunks (末尾 30 keys)。live 未実行・grant 待ち。
- 各 round: docs/keys exact・各通対・key 再導出一致を形状証明。
  補完なし。

## Read-only guard (native の前・actual)

- allow-list (到達の4経路のみ):
  POST `/v1/search`・POST `/v1/databases/{id}/query`・
  GET `/v1/databases/{id}`・GET `/v1/blocks/{id}/children`
  (後者のみ start_cursor/page_size 許可)。https + api.notion.com
  厳密・ID 形状・traversal 拒否。
- deny (送らず HOLD): POST `/v1/databases` (ensureDatabase の
  CREATE 経路)・POST `/v1/pages`・PATCH・DELETE・
  非 Notion host・形状外全般。DB 不在は CREATE せず HOLD。
- binding (第2関門): query は当該 chunk の canonical body SHA と
  厳密一致のみ許可 (packet docs + helper 順の事前導出 183 件。
  subset/oversized/重複/余分 key/順序入替・page_size 違いは
  bytes 不一致で拒否)。同一 chunk 再送は 2xx まで許可・
  前進は 2xx 受信後のみ (3xx/4xx/5xx・到達失敗は不前進)。
  search title/filter/page_size 厳密固定・children 親 typed 一致
  (dashless)・DB id 単一 pin (初回確定・drift 拒否・
  未 pin の dbget 拒否)。最終 query 成功 chunk 数 = round chunks。
- deny forensics (0600): 拒否 request の bodySHA + bodyLen を
  attempt log に残す (ID 素値なし)。
- redirect: 同一 request に manual 強制。3xx は follow せず STOP。
- native 到達失敗も HOLD (safe label・詳細は private log)。

## Capture (同一 response・helper 判定の前)

- forward の前に `reserved` 行 (seq・method・host・path・
  bodySHA/bodyLen・at) を durableAppend + fsync で ledger へ書く。
  crash しても送信試行が残り、受信後の captured/redirect-stop 行と
  seq で対になる。round1 実行 bytes (`577af613…`/`9144b25`) には
  この予約が無い (当時 ledger は受信後行のみ) — PASS 自体の有効性に
  影響なし (attempts/counters/bodies 照合済み)・rerun なし。
  以後の予約捏造はしない。
- forward した全 response (3xx 失敗含む) を clone し、HTTP bytes +
  status + safe headers (content-type/length・retry-after のみ。
  session/cookie 系なし) + actual clock (receivedAt) を
  wx0600 + fsync で private 保存する (余分 GET なし)。
  3xx は保存後に follow せず STOP する。
  原本は untouched で helper へ返す。
- 全行 NULL/metadata を保全し、projection で代替しない。
  (TypeCustody 判定は helper が行う。raw は次段 closure・lookup 証跡。)
- attempt log (0600 fsync): seq・判定・method/host/path・
  status/bytes/bodySHA/file・receivedAt。findings は log SHA 参照。

## Caps (closed)

- round1: native 試行 ≤ 96 (導出: 論理 worst 11 × retry 乗数 7 =
  77 + 余白 19。超過は HOLD)。pre-forward 計数 + post-assert。
- rest: native 試行 ≤ 1351 (導出: ensure worst 10 (search ≤4 +
  scan ≤5 + schema 1。search 4 は仮定・超過 HOLD) + query 183 =
  193 論理 × 7 = 1351 厳密)。DB 解決は初 chunk の 1 回のみ
  (以降 dbCache + guard pin 再使用)。
- helper 内 41 = query ROWS 上限/chunk (has_more で HOLD)。
- listing/DL は本 round 範囲外 (別 stage・別 caps・計数別)。

## Honest status

- query-only。complete = 行存在 + hosted fileCount>0。
- complete ≠ same-bytes 検証済み。full-ZIP readback
  (listing + hosted DL + length/SHA) は別途 future stage。
- primary READY 0 (query-only。complete でも適格化しない)。
- Unknown は再送しない (shared client 契約)。

## Pins (full content SHA256)

- self `42d54333…069d3` (正準化) / FULL `4ac4489d…9ab5d`
- edinet/archive `a02f24f6…53fbc5`
- shared archive `b4388151…5edf`・client `4a7f7800…6754`・
  env `de8449e3…ae1c0` (PR221 時と同一・不変)
- pnpm-lock `805dd5b3…17e58` (同一・不変)
- key manifest `f2f348d5…158f`・parent `4896af08…a2205`

## Runner 契約

- grant-first (Root explicit grant なしに実行しない・fetch 0)。
- OUT-fresh (既存拒否)。durable log + findings 0600。
- stdout は counts/SHA のみ (docIDs・grant 文は 0600 のみ)。
- HOLD 時は hold-detail (0600) + attempt log 保持。再送なし。

## zeros (now)

sourceGET 0 / D1 READ+write 0 / R2 0 / dispatch 0 / Notion mutation 0。
Notion 照会は round1 authorized ONE (2 attempts) のみ。
rest live は CODE CLEAR + concrete grant 待ち (照会 0)。

## limits

- rest は PREP (code + packet + preflight + tests) のみ。live 未実行。
- round1 receipts は保持・再実行なし。README/PR 記録は不変。
- DB 観測・parser 出力・baseline 160 の再検証なし (fixed reuse)。
- full closure (listing/DL) は別途 stage・別 caps。
- missing 行から freshGET necessity を推論しない。
  原本 ZIP / official provenance を先に扱う。
