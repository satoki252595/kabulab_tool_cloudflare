# Closed-44 deep qualification (2026-09-30・LOCAL のみ・書込なし)

closed-59 のうち CHANGED 44 通 (MATCH 15 は書込対象外) の
actual 内容を開封した適格評価。保存済み artifacts + local 読のみ。
source / Notion / D1 新規 0。書込は Root review 後の別 grant。
same-bytes のみで primary-qualified と呼ばない。

## 開封した actual (hash ではなく中身)

- journal `after` 全件: status・honbunFile・tablesScanned・
  facts 全 tuples
  ({regionName, regionKind, salesAmount, ratioPct, unitLabel,
  unitYenFactor, fiscalYearEnd, isConsolidated})・proof 全 object・
  reasons。44/44 JOURNAL_ACTUAL。
- source-HTML context: captured hosted bytes 内の honbunFile
  在否 + bytes/SHA + unit/geo literal の出現確認
  (renderer なし・bytes 照合のみ)。
- full preimage: Q1 doc16 全列 (strict own-key copy・欠列は
  HOLD で合成しない) + Q2 全 tuples (13 列・shape 検証済み)。
- CAS: entire16SHA・protectedSHA・q2KeySHA・q2RowsSHA を
  原本関数 verbatim で再計算し固定 hash と照合: 176/176 一致。
- custody: 44 通全 Tier A (metadata-anchored same-bytes)。
  provenance: manifest_full SHA 照合 44/44。
- issuer: filerName + edinetCode (Q1 観測値)。
  secCode は観測源なしのため収録しない。
- source URI: 構築 official 形 (構築と明示)。
  acquisition clock: UNKNOWN (journal に clock 字段なし。
  ISO DATE 主張なし・manifest/mtime 代用なし)。

## 適格 taxonomy (content-derived・strict)

- OFFLINE_CANDIDATE_NUMERIC (12):
  journal ok_* + facts>0 + proof object +
  全 fact の unit/fiscal/kind/consolidated/name literal 完備 +
  kind 既知 4 種のみ + unit・geo literal の HTML 出現確認 +
  preimage/CAS/manifest/honbun 完備。
  rollup 名 (`*_total` kind) は parser-assigned と区別し
  出現は記録のみ (4/24 出現・非 gating)。
- OFFLINE_CANDIDATE_UNSTRUCTURED (32):
  custody + provenance + expected empty facts (非空は HOLD) +
  full CAS + honbun 在否。数値なき unknown-state 候補として
  numeric 12 と分離。live Q2 行 (4–7 行/通) が存在するため
  数値削除は提案しない (status-level 扱いは Root 決定)。
- LIMIT: 0 (NO_JOURNAL/PREIMAGE_GAP/CAS_GAP/UNIT_GAP/
  KIND_UNKNOWN/LITERAL_UNCONFIRMED/SOURCE_CONTEXT_UNAVAILABLE/
  PROVENANCE_GAP/UNEXPECTED_FACTS のいずれも該当なし)。
- private packet (0600): `closed44-qual.json`
  `4682f8fb…46d73c6` (per-doc 全層 + 判定)。

## Per-doc exact (44)

NUMERIC 12 (CHANGED_FACTS・ok_*):
S100DDYF, S100G6V9, S100IY1B, S100LN4K, S100ODMQ, S100QIMX,
S100QIEX, S100TAI3, S100T6SM, S100VIFY, S100VKI5, S100YBHC。

UNSTRUCTURED 32 (CHANGED_BOTH・geo_present_unstructured):
S100D9O6, S100DA2Y, S100G1ZO, S100G3L2, S100IUNR, S100J2E7,
S100LO6W, S100LUYR, S100M270, S100M26Y, S100OC13, S100OE1D,
S100OH3F, S100OJV9, S100QHYM, S100QS2V, S100QZHY, S100R1RD,
S100R98H, S100RAR0, S100T5AK, S100TR7I, S100TU43, S100TTUY,
S100VI6W, S100VI7V, S100VI7S, S100VWVY, S100W4M7, S100XTG8,
S100YDNF, S100YJKO。

## Scoped L2

- numeric 3 stocks / unstructured 7 stocks (disjoint・計 10)。
  各 1 group (≤97)。numeric 適用後の L2 は 3-stock scoped 呼出し。
  unstructured 側は数値書込なしのため L2 対象外
  (status 扱いが決まれば別途)。

## NEWPOST same-writer reentry 提案 (未実装・未実行)

- 再使用のみ: ingest persist 断片と同一 idiom
  (overseasFacts DELETE by docId subquery + INSERT via 共有
  `toOverseasSaveRows(facts, status)` + doc16 の overseas 2 列
  (status/honbun) のみ targeted update + `db.batch` 原子性)。
  新規 framework なし。order/text は非接触 (明示 boundary)。
  Notion 0 (ingest の text backup 経路は使わない)。
- 対象: NUMERIC 12 のみ (facts+status)。
  UNSTRUCTURED 32 は数値書込なし。
- CAS (executor が pre-write read で照合・不一致は per-doc HOLD):
  entire16 == packet SHA・protected14 == packet SHA・
  Q2 rows == packet rows (key + rows SHA)。
  packet は入力 pins であり live state ではない。
- 失敗方針 (提案): per-doc CAS-HOLD は skip 継続・
  輸送/unknown は ABORT。Unknown 再送なし。
- closed caps: 1 通当たり read 2 (Q1+Q2) + write 3
  (delete + insert≤1 (facts≤6) + doc 更新)。
  12 通で read 24 + write 36。L2 は 1 scoped 呼出し
  (既存 helper 内数・実行時行数で確定)。D1 のみ。
- module pins (full SHA256): ingest `89ec23f9…baa3a0`・
  projection `924b73c2…b1d1f0`・overseas-save-rows
  `00d873f0…1303c0`・schema `8adec138…7393`・
  packet `4682f8fb…46d73c6`。
- 適用は Root review 後の別 grant。whole-apply 現状 0 のまま。

## Limits

- OFFLINE_CANDIDATE は offline 適格であり primary 適格ではない。
- unstructured 32 の live 行削除は提案しない。
- acquisition clock UNKNOWN・ISO DATE なし。
- source URI は構築形 (acquisition 証跡ではない)。
- 観測区間外の不変は主張しない。
