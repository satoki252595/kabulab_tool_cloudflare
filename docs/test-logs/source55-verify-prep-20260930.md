# source55 same-run verification PREP (LOCAL・GET 0)

日付: 2026-09-30。既存 PR197 `loadRepairCustody` の exact 再使用 +
薄い native-cap 配線 PREP。verify 実行は 0 のまま。
CODE CLEAR + hash-first Root 通知の後に ONE verify のみ。
counts/SHA のみ。

## runner (固定。未実行)

- `scripts/sync/source55-verify.ts` (741 行)。
  self full SHA (報告のみ):
  `c64256b6ab46fb6af2e74b7d81cbfb307005c8a7f019cf4e8b20642217805135`
  (旧 558 行 `6e0d2e7b…9449` / 702 行 `2cc2900e…85b6a` /
  735 行 `a0f943b8…88ef6` は修正前の値として記録保持)
- 既存 `loadRepairCustody` をそのまま 1 回呼ぶ。custody 判定
  (55 件数・名前集合・manifest pinned-SHA・コード別 full-bytes SHA・
  complete・未試行残・集合一致) は既存 helper のまま。
  本 runner は native 上限の送信前強制と証跡だけ。新規 framework なし。
- gate は archive adapter と同一機構 (route 表だけ read-only)。
  上限は code 内定数で強制する。文書の単独 cap 主張なし。
- guard clone: 全応答 (hosted 55 + API) の SAME whole-body を helper
  判定より前に wx0600+fsync で保存し、同一 bytes の Response を下流へ
  渡す。保存名は `hosted-<n>.bin` / `api-<seq>.bin`。
  meta (attempt log の fetch-result 行。private): status・bytes・SHA・
  観測 finalUrl・requestedAt/receivedAt・allowlist 応答 header
  (content-type・content-length・etag・last-modified・date の存在分のみ。
  cookie/auth 系なし)。body 内容は記録しない。追加 GET なし。
- 3xx は raw 保存 + meta 記録の後に STOP (追随しない)。
  保存なしの throw はしない。
- provenance 対応: private full report に原文 55 件の
  filename ↔ hosted-N.bin / len / SHA を記録
  (manifest 名 + code-chart-5y 名は既存 helper 契約の逐次順で対応付け)。
- retention 確認: 保存 bytes を読み戻して manifest pin と照合
  (helper の in-memory 照合と合わせて SAME 確定)。
  hosted 順序は既存 helper の逐次 DL 順 (manifest → codes 順) と対応。
- offline replay-40: 保存 bytes を既存 replayRawBar で replay し、
  expected-40 pin と既存 ohlcvSevenEqual で 40/40 照合 (同一 producer。
  network 0。chart の代替 parse なし)。不一致の明細は private へ
  退避して STOP。byteLength の仮 sentinel なし (保存 bytes の実長)。
- 開始 freshness: attemptLog と reportOut が両方 absent でなければ
  fetch 前に STOP。diag key 固定 (override なし)。
- fail 表記を分割: failPreflight (送信 0) は preflight 専用。
  実行後の失敗は failLive (送信件数を主張しない)。
- helper の失敗文は per-code 詳細を含むため、main catch は
  holdPrivate 準拠で private `hold-details.log` (0600+durable) へ退避し、
  stdout/stderr には safe label のみ。public stdout は counts/SHA のみ
  (pageId・URL・per-code 配列なし)。per-code 明細は private full
  report (wx0600+fsync) に persist してから集計を出す。

## frozen pins (preflight0 で照合)

- diag key `price-sync-diag-20260929-local-1790720602657`,
  添付 55 (Chart 原文 54 + manifest 1), codes 54,
  manifest SHA
  `f509f5dbc2e1838d9073067b9b7059de8cee760ac4878f1da3df63f8e1af894d`
  (既存 const と突合)。
- 凍結 artifact 10 件 (bytes + SHA):
  expected-post-40 `5b722925…27d3b` (5205) /
  body-hashes `24459b16…771c` (3704) /
  tuples `af861e0d…1505` (2078) /
  chunk-plan `fcfb7bcc…4248` (1161) /
  budget `7efbbe88…85ad` (1074) /
  eligible-grant `643d017a…ee8e4b` (1107) /
  replay-40 `2db97ff0…a15f1` (8740) /
  Bpost-full11 `9bc6b50b…1ec8` (1057631) /
  R1-body `3187e4c8…afbe7` (3505) /
  R2-body `497e22b7…ed44fe` (364)。
  (full 値は runner 内定数 + price40 freeze 記録と一致確認済み)
- module pins 10 件: stockGapRepair `c190af5a…30189` /
  index `6b1f4547…` / archive `b4388151…` / client `4a7f7800…` /
  env `de8449e3…` / pageFile `48f8574f…` / sha256 `da3711c4…` /
  yahooClient `cf8294df…37bdf` / yahooBarSanity `0f7ec911…5eea6` /
  pnpmLock `805dd5b3…17e58`
  (full 値は runner 内定数。notion-archive 5 件は archive 実行時と不変。
  yahoo 2 件は replayRawBar の decoder/guard 実体)。
- preflight0 (canonical env。送信 0・network 0): **PASS** exit 0。
  stderr 0 bytes。stdout は private 固定 artifact に保存:
  `/tmp/source55-verify-preflight-20260930/PREFLIGHT.json` (0600)
  SHA `b77cd3f90f009213f9240be2a063338bd803d0d046c87e617ebc41749777a5f8`
  (guard-clone 追加後・capture 修正後の再実行も byte-identical を確認。
  canonical 温存)

## native 上限 (wired。logical 数と別会計)

- API 計 77・hosted 計 55 (exact)。
- rule 別 (attempts 会計。1 call ≤7):
  search ≤28 (cursor 4 頁×7)・children-scan ≤35 (helper 内 max 5 頁×7)・
  db-query ≤7 (1 call×7)・page-get ≤7 (1 call×7)。
- CREATE 系・PATCH・DELETE・complete・users-me・未知 path は全面拒否。
- hosted は GET のみ・URL 毎 1 回。API/hosted とも redirect manual。
  3xx は追随せず STOP。非 2xx は既存 helper の契約で STOP。
- 全試行の前に durable attempt 記録 (log 事前確定 + forward 前 fsync)。
  超過は STOP・再送なし。
- notionStats は計測のみ (enforcement 主張なし)。
- Yahoo 0・D1 0・Notion mutation 0。

## 引き継ぐ budgets (price40 freeze 記録のまま。WRITE 0)

- CAS atomic: 12 行/chunk の 4 chunk [12,12,12,4]。
  batch 3 文 (銘柄同一性・不存在 CAS・plain INSERT。bind 上限内)。
- Bpost core full11 保護: 対象表 `swing_daily_ohlcv` のみ。
  指標・財務 0。full11 SHA `9bc6b50b…1ec8`。
- preimage0: R2 actual 0 行 (40/40 absent)。書込時の不存在は
  batch 内 CAS が再確定 (R2 を書込時 proof に代用しない)。
- post: 全件再 SELECT + `ohlcvSevenEqual` exact-match のみ適用確定。
- reentry0: `probeReceiptProofAbsent(runId)` を全送信の前に実行。
  既存 runId は resume-only。receipt は wx0600 → record 1 件 → readback。
- price40 WRITE は別途 Root GO まで行わない。

## ONE verify 実行結果 (CODE CLEAR 受領。実行済み 1 回)

- CLEAR: HEAD `7e4af7991e19059d5b19c8bd554b4d9039a4966f` exact。
  script `c64256b6…05135` / preflight `b77cd3f9…a5f8` /
  module 10 pins 固定一致を確認。hash-first Root 通知済み。grant
  `Root-CODE-CLEAR-7e4af79-20260930-ONE-source55` (存在要求のみ)。
- 実行 1 回のみ (canonical env。fresh attempt+report paths)。
  clocks (UTC): 開始 2026-09-30T11:00:27Z / verified
  2026-09-30T11:00:52.492Z / 終了 2026-09-30T11:00:52Z。exit 0。
- 結果: VERIFIED。files 55・codes 54・manifest `f509f5…94d` 一致・
  holds 0。replay40: compared 40・matched 40
  (既存 replayRawBar + ohlcvSevenEqual。保存 bytes に対して offline)。
- 送信: api 3・hosted 55。gate 実績: notion 3 / hosted 55 / rejected 0。
  rule 別: search 1・db-query 1・page-get 1 (全て上限内。
  children-scan 不要・retry 0)。
  statsDelta: requests 3・retries 0・rateLimited 0 (gate 一致)。
- 順序: custody 1 回 → 保存 bytes 読み戻し pin 照合 (SAME retention) →
  replay-40 → private full report persist → 集計。stderr 0 bytes。
- 証跡 (`/tmp/source55-verify-run-20260930/` 0700。全件 0600):
  - `report.json` (10924B) SHA
    `54547fec770de7e7df1bf153eada653a8fd7b3f601dcf93407722cf9a092edbc`
    (private full report。原文 55 件の filename ↔ hosted-N / len / SHA 付き)
  - `attempt.log` (126908B) SHA
    `ccfffba19ab1085dd37d8ffbffac96b94c3a02f7a818e376917b8cf1195c32bb`
    (58 send + 58 fetch-result。meta 付き)
  - `responses/` (58 件。api 3 + hosted 55。全件 0600。計 4.3M。
    hosted-1.bin SHA は manifest pin と独立確認済み)
  - `stdout.json` (575B。public aggregate。per-code なし) SHA
    `b5437d771a082516fe8a7833d177989b0e4191e6cb4c446005f2ffddd2627fc0`
  - `stderr.txt` (0B)
- run HEAD は CLEAR 対象の 7e4af79 と同一 (実行前 `git rev-parse` 確認)。
- 追加の source GET / Yahoo / Notion mutation / D1・R2 write /
  dispatch は 0 のまま。source5 と WRITE40 は 0 のまま。

## 当初の verify 手順 (実行前計画。参考保持)

- runner 実行 1 回のみ (`--execute --grant=`)。custody 1 回 →
  private full report persist → 集計。失敗・unknown は STOP・再送なし。
- 追加の 2READ / source5 GET / WRITE / R2 / dispatch は 0 のまま。
