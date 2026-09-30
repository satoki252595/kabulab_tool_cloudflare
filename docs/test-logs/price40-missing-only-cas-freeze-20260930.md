# Price40 missing-only 9/29 CAS packet freeze (LOCAL・WRITE0)

日付: 2026-09-30。既存 PR197 実行物の exact 再使用 PREP。
WRITE 0。40WRITE は別途 Root GO (最終 exact CAS plan / CODE CLEAR /
primary verification の後) まで行わない。counts/SHA のみ。

## 入力証拠 (固定)

- source55 (known custody。未再取得。source GET 0):
  diag key `price-sync-diag-20260929-local-1790720602657`,
  添付 55 (Chart 原文 54 + manifest 1),
  manifest pinned SHA
  `f509f5dbc2e1838d9073067b9b7059de8cee760ac4878f1da3df63f8e1af894d`。
- Bpost core full11: 3819 行。SHA
  `9bc6b50b7fa3ac86edd17bf87ef60625428423e72efa9df86de7ca741a5b1ec8`。
- actual R1: 47 行 exact-1・ownerpost identity 一致・適格 40 解決。
  body SHA `3187e4c8122279ba34802593f5d89869cb69b1f5d9209d7e4530b87b0dfafbe7`
  (3505 bytes)。
- actual R2 preimage: 0 行 (40/40 absent。許容+記録)。
  body SHA `497e22b7a6e5c244d0dc00f575a5f011ed91e7b0fcf8df56c2a9c85b7aed44fe`
  (364 bytes)。dateBind `2026-09-29`。
- eligible は Root 支給の pinned grant file
  (`/tmp/elig-p197-r2-20260930/eligible-r2-20260929.json`, 40 codes)。
  SHA `643d017a66a86fa8a78a4d45f57b243aafe2e997987a24d4bbe5abcbcfee8e4b`
  は r2 pin と一致。R2 adopted target pin は Root 実際 grant で充足済み
  (open item 解消)。bare list 不可のまま。

## expected post 40 full7tuples (主成果物。private)

- 根拠: grant-B の fixed source54 records (hosted 55 件) + manifest pin
  `f509f5…` (hosted-04 が一致) を既存 decoder/mapper
  (`parseDiagManifest` / `replayRawBar` / `ohlcvSevenEqual`) で
  native offline replay。network 0。
- native replay 結果: 54/54 を SHA 対応付け。ok 47 (= has_real_bar)。
  held 7 内訳は close 非正 2・guard 拒否 4・9/29 欠落 1 (live 診断の
  分類と一致)。eligible 40 は全件 ok かつ
  `replay-40-tuples.json` (SHA
  `2db97ff0e28aa9e210e9653938664e35895f061f84eb91e907a72fb91f3a15f1`,
  8740 bytes) の行と `ohlcvSevenEqual` で 40/40 一致。
  B-receipt verdict `PREVIEW-40-replay-ok`。
- `/tmp/price40-prep-20260930/expected-post-40-full.json` (0600):
  40 件 {code, stockId(R1-actual), row[7]}。code 順。
  5205 bytes,
  SHA `5b722925d32371e81275ad1e2b9f7512771465d8b29f6d2fc5b27604727d3b15`。
- `/tmp/price40-prep-20260930/body-hashes.json` (0600):
  40 件の canonical tuple body SHA + combined。
  3704 bytes,
  SHA `24459b167e0284e69fd2d0f2d3427cb7479e9cb34db09e4aee79375037de771c`。
- null 保持・guard 意味は既存のまま (今回の 40 行は 7 値 full。
  null-fill なし)。

## actual40 source tuples (副。identity+preimage)

- `/tmp/price40-prep-20260930/tuples.json` (0600): 40 件
  {code, stockId(R1-actual), preimage: absent}。slot 順は packet idSlots。
  2078 bytes,
  SHA `af861e0d2e65f38b749c3c6f188bf93394df3227cb30a4f1215b200692851505`。
- 本ファイルは identity 専用。expected post の主は上記の full7tuples。

## exact 既存 CAS/body (PR197・変更なし)

- chunk: `OHLCV_REPAIR_CHUNK_ROWS` = 12。40 行 → [12, 12, 12, 4] の 4 chunk。
- chunk 内 batch (3 文・atomic。`createD1HttpBatchSender`):
  1. `buildStockIdentityPreflightStatement` (3 binds/行。
     id・code・active・equity の全行一致。最大 36 binds)
  2. `buildOhlcvNonexistencePreflightStatement` (2 binds/行。
     (stock_id, date) 不存在。最大 24 binds)
  3. `buildOhlcvInsertStatement` (8 binds/行。plain INSERT。
     12 行で 96 binds。上限 100/文以内)
- chunk-plan (private 0600): 4 chunk の codes/slot 順・binds。
  1161 bytes,
  SHA `fcfb7bcc2524140188a900977b8b6d18087617660f0c858d0e8b1d3a37254248`。
- R2 preimage は証拠のみ。書込時の不存在は batch 内 CAS が再確定する
  (時間差のため R2 を書込時 proof に代用しない)。

## post / runtime identity / reentry0 受け入れ

- post: 送信対象の全件再 SELECT。既存 `ohlcvSevenEqual`
  (date + OHLCV + adj の null-safe 完全一致) の exact-match のみ適用確定。
  observed-absent-at-readback / drift / unobserved は unknown/HOLD。
  適用 0 の断定・再送なし。rollback 確定の区分なし (既存仕様)。
- expected post: 40 full7tuples (rows 40・各 7 値完全)。
- runtime identity: code→stockId は実行時に `loadTargets` で再解決し
  batch 内で束縛。R1-actual との drift は CAS で STOP。
- reentry0: `probeReceiptProofAbsent(runId)` を全送信の前に実行。
  既存 runId は resume-only (`resume-receipt` readonly)。再 POST なし。
  receipt は wx0600 persist → 1 件 record (force:false) → 添付 readback。

## budget (private artifact + counts)

- `/tmp/price40-prep-20260930/budget.json` (0600): 1074 bytes,
  SHA `7efbbe88d50a8f1b04036caedb12a627c101937b3f0e24fe564a263116e885ad`。
- D1 (最大。40 inserts 時): identity batch 4・statements 12。
  preimage SELECT は 99-ids/chunk のため 40 ids = 1 文。
  readback SELECT は attempted 対象で同上 (≤40 ids = 1 文)。
  対象表 `swing_daily_ohlcv` のみ。指標・財務 0。
- source55 same-run: 下記 spec の通り。Yahoo GET 0。
- receipt: probe 1・persist 1・record 1・verify 1 (hosted GET 1)。
  resend 0。

## source55 same-run verification spec (未開始。GET 0)

既存 `loadRepairCustody` + 既存 helper のみ。新規 runner なし。
開始は exact PREP budget 通知の後、明示 review 通知まで 0 のまま。
訂正: 下記は logical 3 ではなく native 上限の会計である。
追記: native 上限の actual wired 配線は
`scripts/sync/source55-verify.ts` + `docs/test-logs/source55-verify-prep-20260930.md`
に移管 (Root 指示)。下記 spec の数値は配線時の参照として保持する。

- 手順 (既存通り):
  1. `findBackupChildByTitle` (一次データ｜stock-sync DB 解決)
  2. `queryUniqueRow` (diag key の unique 行解決)
  3. `listPageFiles` (Files 全件。55 件でなければ STOP)
  4. manifest 1 件 DL → pinned SHA 照合 → strict parse
     (key/date/completeness=complete/unattempted 0)
  5. コード別 raw 54 件 DL → manifest の per-code bytes/SHA を全件照合
  6. 添付集合の一致 (54 + 1 = 55。想定外ファイルがあれば STOP)
- native 上限 (logical 3 と別会計):
  - Notion API: search (cursor 頁。cursor guard 付き) + miss 時のみ
    children-scan ≤5 頁 + db-query 1 (page_size 2。pagination なし) +
    page GET 1。DB は存在確定のため create 経路なし
    (欠落時は別途 STOP。create しない)。
  - 1 call の HTTP attempts ≤7 (初回 + retry 6。client 定数)。
    read-only 経路のため Unknown-create 分岐なし。
  - hosted: 55 件 (manifest 1 + raw 54) 各 1 回。raw fetch のため
    retry・queue・stats 外。再送なし。
  - raw loop 回数は manifest.codes.length に従うが、loop 前の
    pinned-SHA 照合 (`f509f5…` = 54 codes 確定) が暗号的に 54 に縛る。
- read-only route gate (別建て。mutation STOP):
  許可は GET + POST-to-`/search` + POST-to-`/databases/{id}/query` のみ。
  POST の他 path・PUT/PATCH/DELETE・complete は全面拒否。
  Yahoo 0・D1 0・Notion mutation 0。
- preforward counter: 55 hosted attempts を試行前に計数する。
  超過・二重・表外は送らず STOP。
- notionStats は計測のみ (enforcement 主張なし)。
- 不一致・非 complete・未試行残・集合不一致は即 STOP。
