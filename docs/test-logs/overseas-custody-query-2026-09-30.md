# Source-custody query runner round1 PREP (2026-09-30・live 未実行)

20 docs / 40 keys の query-only 照会 runner。既存 helper
`checkDocsCustody` を再使用 (新規 framework なし)。
read-only route guard + closed caps + hash-first packet。
live は CODE CLEAR + concrete grant 待ち (照会 0)。

- script: `services/yuho-quant/data-scripts/overseas-custody-query.ts`
  (FULL `577af613…9c9f57`、self pin `482e65f2…f73649`)。
  test `services/yuho-quant/src/tests/overseas-custody-query.test.ts`
  14 passed 同梱。
- preflight: `8d7f4a6b…91ea3` exit 0・sends 0・writes 0・
  docs 20・keys 40 (canonical env・typed parent 照合済み)。

## Fixed scope (round1)

- service `yuho-quant` + hold73 先頭 20 通 (docID sort)。
- 40 exact keys `{doc}:type1`/`:type5`。
  key manifest `custody-keys-20.json` `f2f348d5…158f` (SHA 照合)。
- docs 厳密 20・keys 厳密 40・各通対・key 再導出一致を形状証明。
  補完なし。

## Read-only guard (native の前・actual)

- allow-list (round1 到達の4経路のみ):
  POST `/v1/search`・POST `/v1/databases/{id}/query`・
  GET `/v1/databases/{id}`・GET `/v1/blocks/{id}/children`
  (後者のみ start_cursor/page_size 許可)。https + api.notion.com
  厳密・ID 形状・traversal 拒否。
- deny (送らず HOLD): POST `/v1/databases` (ensureDatabase の
  CREATE 経路)・POST `/v1/pages`・PATCH・DELETE・
  非 Notion host・形状外全般。DB 不在は CREATE せず HOLD。
- binding (第2関門): query filter 全 key が manifest 40 内・
  page_size 厳密 41・search title/filter/page_size 厳密固定・
  children 親 typed 一致 (dashless)・DB id 単一 pin
  (初回確定・drift 拒否・未 pin の dbget 拒否)。
- redirect: 同一 request に manual 強制。3xx は follow せず STOP。
- native 到達失敗も HOLD (safe label・詳細は private log)。

## Capture (同一 response・helper 判定の前)

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

- native 試行 ≤ 96 (導出: 論理 worst search ≤4 + scan ≤5 +
  query 1 + schema 1 = 11 × retry 乗数 7 (MAX_RETRY 6) = 77 +
  余白 19。超過は HOLD)。pre-forward 計数 + post-assert。
- helper 内 41 = query ROWS 上限 (has_more で HOLD)。
- listing/DL は本 round 範囲外 (別 stage・別 caps・計数別)。

## Honest status

- query-only。complete = 行存在 + hosted fileCount>0。
- complete ≠ same-bytes 検証済み。full-ZIP readback
  (listing + hosted DL + length/SHA) は別途 future stage。
- primary READY 0 (query-only。complete でも適格化しない)。
- Unknown は再送しない (shared client 契約)。

## Pins (full content SHA256)

- self `482e65f2…f73649` (正準化) / FULL `577af613…9c9f57`
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

sourceGET 0 / Notion 照会 0 / D1 READ+write 0 /
R2 0 / dispatch 0。live は CODE CLEAR + concrete grant 待ち。

## limits

- 本記録は PREP (code + preflight + tests) のみ。live 未実行。
- DB 観測・parser 出力・baseline 160 の再検証なし (fixed reuse)。
- round2 以降 (残 3602・full closure) は別途計画。
