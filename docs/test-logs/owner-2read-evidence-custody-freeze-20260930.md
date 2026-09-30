# Owner 2-READ 証拠 custody freeze (LOCAL・未 archive)

日付: 2026-09-30。HEAD `5b15483` 固定。counts/SHA のみ (生値なし)。
network 0。actual archive 0。archive 本体は明示 CODE CLEAR + Root
hash 通知まで開始しない。

訂正: `known-record.json` は LOCAL freeze descriptor であり、Notion の
actual receipt ではない。record 返却値の即時 persist (verify より前)
は adapter (`scripts/sync/owner-2read-archive.ts`) に実装済み・未実行。
「known record verified before already」の表現は取り消す。

## key・ZIP・known record

- key: `owner-2read-evidence-20260930-c89721383ce0`
  (`owner-2read-evidence-{YYYYMMDD}-{sha12(manifest-minus-key bytes)}`)
- ZIP: `owner-2read-evidence-20260930-c89721383ce0.zip`
  20170 bytes,
  SHA `c8c5a2a3623722f3b48b760315bc776698c71af5f3bbda1b8ed7219aa34537d5`
- manifest-minus-key SHA:
  `c89721383ce04a6307f9c09f008e27bbe85ea7c93b66443e22cf4d71f26bf3af`
- manifest.json (2280 bytes) SHA:
  `3eb6b6fc967acf9e3f6932aedd36eb479da5e9f95b2abfa602fc5fbdcee05596`
- known-record.json (702 bytes, O_EXCL 0600 + fsync) SHA:
  `290419232fe5a2c6c8217e31cf8555848e982a2ee27e799ab5662eaa7e13f99e`
- 保管場所 (private): `/tmp/owner-2read-custody-20260930/` (0700・全件 0600)。
  値は /tmp のみ。repo へは本記録 (counts/SHA) のみ残す。

## 実際 clock (retained attempt.log の verbatim)

- seq1-R1-send: `2026-09-30T09:37:28.962Z`
- seq1-R1-receipt: `2026-09-30T09:37:29.373Z`
- seq2-R2-send: `2026-09-30T09:37:29.384Z`
- seq2-R2-receipt: `2026-09-30T09:37:29.448Z`
- ZIP mtime (fixed): 1790761049 (seq2-R2-receipt epoch)。

## member 12 件 (ZIP 内包。entry 名順・stored・固定 attrs)

| name | bytes | sha256 | role |
|---|---|---|---|
| attempt-001-R1-body.bin | 3505 | `3187e4c8122279ba34802593f5d89869cb69b1f5d9209d7e4530b87b0dfafbe7` | raw |
| attempt-001-R1-reserved | 224 | `c3f9ce3d89eabf681edb2eba16e823cf6bd612c76e8efc0f18e862ba4c189d6d` | attempt-marker |
| attempt-002-R2-body.bin | 364 | `497e22b7a6e5c244d0dc00f575a5f011ed91e7b0fcf8df56c2a9c85b7aed44fe` | raw |
| attempt-002-R2-reserved | 224 | `3c8f2ad85ac734df32c7209599e830998c87d232a40197833b256c60e3ea5809` | attempt-marker |
| attempt.log | 1582 | `9f3ee2ba45955100d4a00d2e806854a7e962ba4184fae9cd672c7c249c6dc3dd` | attempts |
| hold-details.log | 273 | `52eba0b70d2ba46c7c4557410763d288da52615160887eb06cd655a70b147bb1` | hold-details |
| manifest.json | 2280 | `3eb6b6fc967acf9e3f6932aedd36eb479da5e9f95b2abfa602fc5fbdcee05596` | manifest |
| owner-2read-report.json | 2507 | `07060bc26c217273b4a991a646eedf73c999636b5d23bc9dd245ff375075c08b` | report |
| packet-r1.json | 2213 | `997bcf8442ba0f7baddca249b30bea3e844d4cb47ae609acf955e6599fa5312e` | source |
| packet-r2.json | 3929 | `d9e35a8d8a8fd18492f10588317d05f853046c2cce3f7f85252792ceb4bd8d0e` | source |
| pins.json | 1234 | `5f6412ebcb355e98a83595c75b39ab8e4f6e748a1d7aa6cc92671fba51c06ac2` | pins |
| PREFLIGHT.json | 489 | `d76559ae3f808c1e5d268eb13858d2ef8ba796fa947157960607a643b54a7e6c` | preflight |

除外 (別 track。ローカル 0600 に保持):
`sector6-baseline-proposal.json` (2194 bytes,
`d38309e345a9393d99f6fed3c1eb6dc42d92c9abe0a50027865f79e7a0e481d4`)。

## 同一性検査 (offline・fail-closed。済み)

- staged bytes と pinned SHA の一致 (raw2・PREFLIGHT・packet2)。
- staged raw2 と report receipts (seq/kind/sha/bytes) の一致。
- report counts: sends 2・responses 2・holds 0。
- ZIP は既存 `ipo-zip-bridge.py build` で決定的生成し、`list` で
  CRC + 12 件の name/bytes/SHA を manifest と照合済み。

## adapter 実装 (固定。未実行)

- `scripts/sync/owner-2read-archive.ts` (612 行)。
  self full SHA (報告のみ):
  `70b19e72de35a4af7d85018556ed070826d3f87e1eaf47bd85d6979fb1d538c3`
  (旧 594 行 `63020aa4…0131` は narrow 修正前の値として記録保持)
- 共有 helper を直接呼ぶ (recordPrimaryData / findBackupChildByTitle /
  queryUniqueRow / verifyArchivedAttachments)。global baseline bundle
  (edinet 用) は呼ばない。最小 param 抽出。新規 framework なし。
- gate は C baseline (`overseas-baseline-archive.ts` の
  createNotionGateFetch。C WT。main 未収録) の抽出 + 固定差分
  (route 表・hosted 各1回・redirect manual・3xx STOP)。
- module pins 7 件 (preflight0 照合): index `6b1f4547…` /
  archive `b4388151…` / client `4a7f7800…` / env `de8449e3…` /
  fileUpload `c63657f6…` / pageFile `48f8574f…` / readback `6bfde103…`
  (full 値は adapter 内定数)。
- 開始 freshness: attemptLog と receiptOut が両方 absent でなければ
  fetch 前に STOP (init 'a' の再利用を禁止。unknown replay 防止)。
- service は ARCHIVE_SERVICE 固定。`--service` override を廃止
  (key scope 不変。別 DB target への切替不可)。
- record 返却は recorded+written か skipped_existing+same のみ有効。
  それ以外 (unknown 含む) は STOP・再送なし。skipped_existing+same は
  再利用確定として `reused:true` で正直に報告し HOLD しない。
- fail 表記を分割: failPreflight (送信 0) は preflight 専用。
  実行後の失敗は failLive (送信件数を主張しない)。
- main catch は capture の holdPrivate 準拠: provider 詳細は
  receiptOut と同 dir の `hold-details.log` (0600+durable) へ退避し、
  stdout/stderr には safe label のみ。
- preflight0 (canonical env。送信 0・network 0): **PASS** exit 0。
  stdout は private 固定 artifact に保存:
  `/tmp/owner-2read-archive-preflight-20260930/PREFLIGHT.json` (0600)
  SHA `c78762deee2006c2b7e7d885b75bb6367516f85ef1e6bc1051e953bd22be9edb`
  narrow 修正後の再実行 (stderr 0 bytes) も byte-identical を確認
  (canonical artifact は上書きせず温存)。
- 作業記録: live dir 内の未記録 preflight 複製 1 件を、誤った起動
  (`node` への tsx bin 直渡し) の失敗時に shell redirect で 0 byte 化
  してしまい、残骸 2 件を除去して custody を原状 8 件に復帰。
  記録済み canonical PREFLIGHT.json / ZIP / manifest / known-record の
  SHA は全て不変を確認済み。archive 実行は 0 のまま。

## ONE archive 実行結果 (CODE CLEAR 受領。実行済み 1 回)

- CLEAR: HEAD `df6e868356afa1f781e66d3bb6e28b09993db852` exact。
  adapter `70b19e72…538c3` / preflight `c78762de…9edb` 固定一致を確認。
  hash/scope は Root へ事前通知済み。grant
  `Root-CODE-CLEAR-df6e868-20260930-ONE-archive` (存在要求のみ)。
- 実行 1 回のみ (canonical env。fresh attempt+receipt paths)。
  clocks (UTC): 開始 2026-09-30T10:30:35Z / record-return
  2026-09-30T10:30:48.771Z / 終了 2026-09-30T10:30:53Z。exit 0。
- 結果: ARCHIVED。outcome `recorded` / manifestMatch `written` /
  verified true / reused false / holds 0。fileTooLarge false。
- 送信: record 1・unique 1・verifyDownloads 2。
  gate 実績: notion 16 / hosted 2 / rejected 0。
  rule 別: search 2・children-scan 2・db-create 1・db-query 2・
  users-me 1・upload-create 2・upload-send 2・upload-status 2・
  page-create 1・page-get 1 (全て上限内)。
  statsDelta: requests 16・retries 0・rateLimited 0 (gate 一致)。
- 順序: record-return を wx0600+fsync で persist してから unique →
  hosted verify (attempt.log の phase 順で確認)。stderr 0 bytes。
- 証跡 (`/tmp/owner-2read-archive-run-20260930/` 0700。全件 0600):
  - `receipt.json` (228B) SHA
    `6a1e5b71b84d172ec22e9294dabc351ca5e62ba59c2095c0dc6137988ce3fd05`
    (actual returned Notion receipt。pageId は private。本文書に非記載)
  - `attempt.log` (3214B) SHA
    `67fe42d122f91641739db0d970e57e163ed657e19a23c73288b71a532e609412`
  - `stdout.json` (924B。public aggregate。pageId なし) SHA
    `462a70c3c88145aff4cd75e9658d0ce4c9f700989b2625126e605f27f0efb4d5`
  - `stderr.txt` (0B)
- module pins 7 件は adapter 内定数 (preflight0 照合済み)。run HEAD
  は CLEAR 対象の df6e868 と同一 (実行前 `git rev-parse` 確認。tree clean)。
- 追加の 2READ / source55 verify / source5 GET / WRITE / R2 /
  dispatch は 0 のまま。source55 は native cap 配線 + 別途 CLEAR待ち。
  price40 WRITE は別途 Root GO待ち。

## 当初の archive 手順 (実行前計画。参考保持)

- adapter 実行 1 回のみ (`--execute --grant=`)。record 1 回
  (force:false) → 返却即時 wx0600+fsync → unique 1 回 + pageId 一致 →
  hosted 2 件 verify。添付は ZIP + manifest.json の 2 件。
- native 上限 (gate が送信前強制。logical 数と別会計):
  - API 計 96・hosted 計 2。rule 別: search ≤4・db-query ≤2・
    users-me ≤1・upload-create ≤2・upload-send ≤2・upload-status ≤8・
    page-create ≤1・db-create ≤1・db-get ≤1・page-get ≤1・
    children-scan ≤5。complete/PATCH/DELETE/未知 path は全面拒否。
    mutation は表内の granted record 経路のみ
    (単一論理 record の DB-create 1 回まで含む)。
  - hosted は GET のみ・URL 毎 1 回。API/hosted とも redirect manual。
    3xx は追随せず STOP。
  - 1 call の HTTP attempts ≤7 (初回 + retry 6。client 定数)。
    非冪等 create は network/529/5xx で単発 Unknown・再送禁止。
  - 全試行の前に durable attempt 記録 (log 事前確定 + forward 前 fsync)。
    超過は STOP・再送なし。
  - notionStats は計測のみ (enforcement 主張なし)。
- fileTooLarge・想定 pair 外 (recorded+written / skipped_existing+same 以外)・
  unique 不一致は STOP・再送なし。skipped_existing+same は reused 報告 (HOLD なし)。
- D1/R2/Yahoo/source GET 0。
