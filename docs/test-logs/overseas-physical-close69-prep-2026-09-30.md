# 69 physical closure PREP (2026-09-30・LOCAL のみ・live DL なし)

既存 69 property keys (rest query complete 行) の physical closure
提案 PREP。LOCAL 読みのみ (保存済み bodies + local FS)。
live DL・record・D1 書込・fresh source GET は全て未実行・別 grant。

## 69 inventory 実測 (保存 bodies 由来・counts のみ)

- rows 69・distinct keys 69・distinct pages 69・distinct docs 64。
  t1 64 cells・t5 5 cells。64 通 = t1-only 59 通 + t1+t5 5 通
  (t5 は全て legacy 10 の内。round1 20 通は全 missing のため対象外)。
- kind `file` (hosted) 69/69・fileCount 1 が 69/69・
  status `recorded` 69/69・service `yuho-quant` 69/69。
- `recordEdinetZip` 契約照合: key `{docID}:type{1,5}`・
  filename `{docID}_xbrl.zip`/`{docID}_csv.zip`・
  `edinetDocType` 一致・source `/documents/{docID}?type={n}` 形式・
  違反 0。
- metadata 2 世代: 新契約 `{bytes,sha256,cachedZipPath,lease,
  edinetDocType}` が 59 行・legacy 20-key (bytes/SHA/path なし)
  が 10 行 (5 通 × t1+t5)。
- Fetched At: 69/69 存在・`2026-08-03` → `2026-09-28`。
- 証跡 base: findings `af82c988…28d24a`・ledger `516bb9c2…07fc4`
  (rest round・184 attempts・184 reserved/captured pairs)。

## 既存 ZIP inventory (local FS・no network)

- 新 59 行: `cachedZipPath` (`/tmp/overseas_laneA_raw/`) 全存在・
  size 一致 59/59・SHA256 一致 59/59。
- legacy 10 行: metadata に path なし。慣用 path
  (`/tmp/overseas_laneA_raw/{docID}_t{1,5}.zip`) の監査で
  t1 5/5 存在 (size>0・SHA 記録)・t5 5/5 不在。

## Closure tiers (byte source 基準)

- Tier A (59): metadata-anchored strict。local 原本
  (metadata SHA 照合済み) の bytes を期待値に
  `verifyArchivedAttachments` (listing + count/name/kind +
  hosted 全 bytes 長 + SHA) で閉じる。
- Tier B (5・legacy t1): hosted↔local same-bytes のみ。
  慣用 local を期待値に fullverify 可だが metadata anchor なし
  (local 自身の来歴は慣用 path のみ)。limit 付きで scope 内。
- Tier C (5・legacy t5): HOLD。byte source なし。
  fresh GET の必要性は推論しない (missing ≠ necessity)。
  原本 ZIP / official provenance の監査が先。

## 閉鎖 runner 契約 (提案・未実装・未実行)

- DL scope: 64 pages / 64 files (A59 + B5)。Tier C 除外。
- 再使用のみ: strict `verifyArchivedAttachments` (+ `listPageFiles`
  `GET /pages/{id}`)。新規 framework・bulk alias なし。
- page 単位 listing→DL pairing (hosted URL は署名付き失効制)。
  packet の exact pageID を使用 (search 0・DB 解決 0)。
- closed caps: listing 64 論理 × retry 乗数 7 (MAX_RETRY 6) =
  448 native max・hosted DL 64×1 = 64 exact
  (verifier に hosted retry なし。失敗は HOLD・再送なし)。
  native 合計 cap 512。record 0・D1 0・source GET 0。
- rows: 1 file/row 期待 (count 不一致は verifier が HOLD)。
  Unknown は再送しない。
- private packet (0600): `physical-close-69.json`
  `16d51720…63bd4d8` (69 keys・pageIDs・names・bytes/SHA・
  lease・source・local 照合・full module pins 収録)。
- module pins (full content SHA256): shared archive
  `b4388151…5edf`・client `4a7f7800…6754`・env `de8449e3…ae1c0`・
  readback `6bfde103…2194c`・page-file `48f8574f…3f59`・
  sha256 `da3711c4…001de`・edinet/archive `a02f24f6…53fbc5`
  (既存 pin と同一・不変のものは再掲)。

## 閉鎖 runner 実装 (LOCAL PREP・未実行・CODE CLEAR 待ち)

- script: `services/yuho-quant/data-scripts/overseas-physical-close64.ts`
  (FULL `9e23e814…5e1da`、self pin `8d3b2648…f0d85`)。
  test `services/yuho-quant/src/tests/overseas-physical-close64.test.ts`
  14 passed 同梱 (実 verifier 経路含む・hermetic)。
- 既存 `verifyArchivedAttachments` を直接使用 (新規 framework なし)。
  期待 bytes は local 原本 (Tier A: metadata 照合・Tier B: 観測値照合)。
- guard: GET pages exact 64 + hosted 観測 host
  (`prod-files-secure.s3.us-west-2.amazonaws.com`・保存 bodies 由来)
  各 URL 1 回・redirect manual・reserved 行 fsync 先行・
  whole body wx0600・3xx STOP・fail-fast。
- preflight: `996f2212…d76bf` exit 0・sends 0・writes 0・
  69/64/59/5/5 + 67497778 bytes 再照合済み
  (canonical env・packet `16d51720…63bd4d8` 不変照合)。
- Root conditional DL grant にて ONE 実行済み (結果は次節)。
  追加実行なし。

## 閉鎖 ONE 実行結果 (HOLD・fail-fast・再実行なし)

- window: `2026-09-30T12:11:37.443Z` → `12:12:18.201Z` exit 1。
  実行 HEAD `a2415d2` (実行前照合・tree clean・bytes FULL 照合済み。
  hold-detail に workHEAD 記録なし — 知られた制限)。
- Tier A 59/59 閉鎖達成 (metadata-anchored same-bytes)。
  続く Tier B 先頭 `S100YWM7:type1` で SHA 不一致 HOLD。
  残 Tier B 4 行は未試行 (fail-fast)。Tier C 5 は除外のまま。
- 不一致の内訳 (LOCAL forensics・再取得なし):
  hosted 長 = local 長 = 1032133・hosted SHA `42a7404d…9756f2c`・
  local SHA `44d67cf6…4844e8` (packet inventory 値と一致・
  local 変化なし)。55 entries・names + 長さ同一・
  entry-bytes SHA 両者 `ded1638c…f4580` で一致。
  結論: 同一 content の re-timestamped container
  (hosted 09-29 13:45 / local 09-28 23:25・初 divergence byte 11)。
  strict byte-closure の拒否は正しい。content 同一の証明であり、
  same-bytes 適格化ではない。
- network: native 120 (listing 60 + hosted 60)・全 200・
  rejected 0・hosted retry 0。ledger reserved 120 + captured 120 =
  240 行・seq 1:1 対・全 bodySHA 照合一致・全 0600。
- receipts (0600): hold-detail `ae8fc7f2…2fe06`・
  ledger `1320fdce…712`・stderr `13a66c4d…61f5f` (stdout 空)。
- zeros: search 0 / sourceGET 0 / D1 0 / R2 0 / record 0 /
  mutation 0 / dispatch 0。
- grant 消費済み ONE。Tier B 残・Tier C に追加照会・rerun なし。
- READY は blanket 適格化なし (Root 判断)。
  Tier A 59 の same-bytes receipt のみ確定。

## Limits

- 本 PREP + ONE 実行は閉鎖 59 + HOLD 1 で確定。追加送信なし。
- missing t1 3611 / t5 3670 (union) は source 不在の証明ではなく、
  fresh GET の必要性も意味しない。Tier C は HOLD のまま。
- complete ≠ READY。READY 判定は Root (本 PREP は bytes 照合の
  可否範囲のみを確定する)。
- Tier B は hosted↔local 等価のみ (metadata-anchored ではない)。
- live DL は別途 CODE CLEAR + 具体 caps/grant が必要。

## L2 scoped MAX 修正 (同 branch・実装済み)

- `rebuildYuhoGrowthProjection` の `source_max_date` 用
  `MAX(yuhoDocuments.submittedAt)` を `stockIds` 指定時は
  対象集合に拘束 (`inArray(stockId, targets)`)。
  未指定時は global MAX (既定・不変)。空集合は既存 throw 維持。
- caller `src/cron/yuho-edinet.ts` は未指定呼び (global・不変)。
- tests: `projection-equivalence.test.ts` に scope 別契約 test 追加
  (scoped [1]=1750000000 日・[2]=1760000000 日・global 不変)。
  旧「部分=全体 (computed_at 除く)」は scope 別契約の承認変更に
  合わせ `source_max_date` 除外へ更新 (他列の一致は維持)。
- gates: projection-equivalence 23 passed・
  active-equity-universe 5 passed・tsc 0・eslint 0。
- D1 書込 0 (tests は in-memory のみ)。
