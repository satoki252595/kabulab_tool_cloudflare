# price40 corrective PREP (2026-09-30。NO operation GO)

ブランチ `prep/price40-corrective-20260930` (base `fc552b2`)。PREP のみ。
archive・corrective attempt ともに本記録では実行しない
(sequential grant は Root が review 後に判断)。

## 原本 (immutable。変更なし)

- 失敗 ONE run (merged `6e0bcdc`。exit 1): batch-0 POST が
  745 import 副作用の SELECT-only guard に ban され outcome-unknown
  STOP。Notion 到達も ban (retry が search rule 上限を消費)。
  D1/Notion とも state 変更 0。再送・再実行なし。
- receipt key: `price-sync-repair-20260929-local-1790772411835`
  (runId `local-1790772411835`)。
- 原本 proof: `/tmp/price40-exec-20260930/tmp/stock-gap-repair/receipt-local-1790772411835.json`
  (0600。3911B。wrapper `a88cde88…fab9` / payload `508fd433…05757`)。
  Git には載せない (SHA pointer のみ)。
- abortReason: `chunk-0:SELECT proof: batch envelope 禁止 (単発 SELECT のみ)`。
  applied 0 / unknown 12 / write0 0 / held 7 / excluded 7。
- attempt 順序・counters・d1 bodies は
  `/tmp/price40-live-20260930/` に保持 (HASHNOTICE `9cdc85c1…` /
  PREFLIGHT `c182d1d…`)。上書き・再実行なし。
- root cause fix: PR236 merged (`eda5319`)。regression + private
  actual-old proof PROOF-OK (`a692251e…8ec64`)。

## corrective 40 packet (repin のみ。body 不変)

- adapter: `scripts/sync/price40-cas-execute.ts` (978 行)。
  `ce50bf80935892652ea6e70b420cd42600a8f16d5dbc97370b6db2f9aaddb684`
  (旧 CLEAR `80e57378…d104` は記録保持)。
- 差分は 2 pin 行のみ (merged-236 の実 bytes への追随):
  selectProof `6c864f43…` → `cbb03a3a…` (approved shared root 修正本体)、
  freshCapture `fede652c…` → `d349a80b…` (同 merge の comment-only 差分。
  preflight 照合のため実 bytes に合わせる。両者とも merged-236)。
  他の 17 module pins・全 artifact pins は不変。
- 不変: source55 retained 55 件 (`54547fec…`)・frozen chunk bodies v3
  (`e33ed352…` 68276B)・expected-post (`5b722925…`)・eligible
  (`643d017a…`)・touched-40 core11 guard (`c69c0536…`)・producer
  (`c190af5a…`)・予算 v3 (HTTP ≤7・文計 19・96/2)。
- preflight0 (canonical env。送信 0): **PASS** exit 0。
  artifacts 17・modules 19・D1 URL SHA。stderr 0。
- pure proof (same producer。network/Notion 0) 再実行: PROOF-OK。
  A0/40/0/7 B4/40/40clean C0/39/HOLD D40/6/HOLD fetch0。
  `PROOF.json` `7c7cab8e06840ee828ebb77f58c25e47c301dede57d5a44df5830e49a7b0e57b`。
  adapter `ce50bf80…` / producer `c190af5a…`。
- corrective receipt key recipe: `price-sync-repair-20260929-<newRunId>`
  (runId は実行時 fresh。旧 key/runId の再利用なし)。
  FRESH dirs 必須 (旧 `batch-0-reserved` 等の持越なし)。
- 実行予算 (v3 同一): SELECT ≤3 + batch POST ≤4 (4 文/POST。
  identity+nonexist+insert+scopedT40) + Notion receipt (96/2 内)。
  Yahoo 0・55 再取得 0。

## failed receipt archive 計画 (same key/body。raw JSON。NO ZIP)

- 方針: 原本 key・原本 payload bytes をそのまま 1 record
  (`<key>.json`) に保管する。ZIP 化しない。
  理由: 失敗試行が意図した record と同一にするため
  (ZIP は別 bytes・別 record になる)。manifest 規律は
  record の metadata + readback で満たす。
- docs への raw mirror なし (BLOCKED につき除去済み)。
  原本 immutable `/tmp/price40-exec-20260930/...` を
  `--proof-path` で再使用 + SHA pointer (bytes/wrapper/payload/key)。
- private one-off thin runner (repo 外。tracked 新規なし。
  raw mirror なし):
  `/tmp/price40-failed-archive-20260930/run.mts` (0600。172 行)。
  FULL SHA `32de718b06b10874014d16c802b8406f337cf9fb0c5471783af275da8622e444`
  (旧 `8a3b703a…c0ffc` は記録保持)。
  新規 suite/report framework なし。
- narrow 確定: wrapper.runId を exact 照合して直接使用
  (fallback なし)。fetchedAt は原本 generatedAt (valid string
  照合済み)。attemptLog/reportOut は同一 dirname を初回 network
  前に assert + 両 dir を record 前に用意 (known-receipt 落下防止)。
  stage counter は fresh。原本 counter 不変。
- 既存 helper のみ:
  `recordPrimaryData` (literal key/body/source・force:false。
  fetchedAt は原本 generatedAt。metadata は原本 counts +
  `archivedFrom` 来歴) → known-result wx 即時保存 (verify 前) →
  `queryUniqueRow` exact → `verifyArchivedAttachments`
  (件数・名前・hosted・全 bytes) → 固定 archive gate (96/2)。
  3 度目の listing なし (verifier 内の 1 page-get + hosted 1 のみ)。
- 注: `loadReceiptProof` / `sanitizeLogText` は現 tree に存在しない
  (rg 確認)。前者は thin runner 内の最小 read+SHA 照合で代替
  (契約: 固定 path + bytes + wrapper/payload SHA + key)。
  後者は house idiom (safe label stdout + 詳細 private 0600 追記)
  で代替。原本 failed counter は不変。新 stage は別 dir +
  distinct counter。
- module pins 9 (full 値は runner 内定数):
  index `6b1f4547…` / archive `b4388151…` / client `4a7f7800…` /
  env `de8449e3…` / fileUpload `c63657f6…` / pageFile `48f8574f…` /
  readback `6bfde103…` / sha256 `da3711c4…` /
  archiveAdapter `70b19e72…`。
- preflight0 (canonical env。送信 0): **PASS** exit 0。stderr 0。
  modules 9・proof (wrapper 3911B + SHA + payload SHA)・envOk。
  `PREFLIGHT.json` (0600)
  `1decce7451086199c42e8b960ff844618796dbf7949adef848a91ed627d79c63`。
- 実行予算: Notion API のみ (gate 96 内。見込み findDb 2-3 +
  record 4-12 + db-query 1 + page-get 1 = ≤20) + hosted 1 (2 内)。
  D1/Yahoo/R2/dispatch 0。
- stdout は safe label のみ (counts/SHA。pageId なし。pageId は
  private record-return に保持)。

## grant 提案 (順序。いずれも未実行)

1. failed receipt archive (`price40-failed-receipt-archive.ts`) の
   ONE 実行 grant (key/pins/budget 上記)。
2. corrective 40 attempt (`price40-cas-execute.ts` repin 版) の
   ONE 実行 grant (新 runId・fresh dirs・予算 v3)。
3. どちらも自動実行しない。review 後に Root が sequential に判断する。
