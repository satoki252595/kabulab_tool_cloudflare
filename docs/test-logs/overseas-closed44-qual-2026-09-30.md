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
  `c7c0b56f…f3dd` (per-doc 全層 + 判定 + source citations)。

## Source citations (numeric 12・pointers のみ)

- honbun 実 bytes (captured hosted) に対する exact Unicode spans。
  geo/disagg 11 件は独立 read の table pointer を検証 CLEAR。
  YBHC の旧 bounded-search locator (451697・production-note 誤認)
  は破棄し、exact span に置換 (false proof を freeze しない)。
- 全 spanで table 要素 + unit + geo labels の存在を検証済み
  (unit は span または直前 heading・geo は span 内 strict)。
  window = [start-2000, end+8000) + table SHA を pin。
  財務 raw 値は repo に置かない (counts/SHA のみ)。
- spans [start:end): DDYF 231716:239609・G6V9 282993:290991・
  IY1B 286491:294383・LN4K 255745:263638・ODMQ 261991:271258・
  QIMX 261897:271156・QIEX 778932:805464・TAI3 784897:811423・
  T6SM 786107:812633・VIFY 779537:806069・VKI5 779426:805958・
  YBHC 487370:507011 (total literal `59,557,877` @506332 検証済み・
  後続に location/intersegment notes 存在確認)。
- tableSHA 一致ペア 2 組を観測 (TAI3/T6SM・VIFY/VKI5。
  per-doc SHA は packet 収録。推論なし)。
- fiscal は fact の fiscalYearEnd + span 近傍の year 言及を
  offsets 収録 (heading 断定なし)。
  acquisition clock は UNKNOWN のまま (ISO DATE なし)。

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

- 適用 scope は changed-44 の実 distinct 10 stocks
  (numeric 3 + unknown 7・disjoint 検証済み)。
  closed-59 の 16 (MATCH-only 6 を含む) を流用しない。
  10 stocks → 1 group (≤97・単一 scoped 呼出し)。
- unknown 32 の empty 化に伴う L2 は unqualified old projection
  の除去 (rebuild の自然帰結) であり、fake-zero 行の作成でも
  旧値全否定の主張でもない。

## NEWPOST same-writer reentry 提案 (未実装・未実行)

- 再使用のみ: ingest persist 断片と同一 idiom
  (overseasFacts DELETE by docId subquery + INSERT via 共有
  `toOverseasSaveRows(facts, status)` + doc16 の overseas 2 列
  (status/honbun) のみ targeted update + per-doc `db.batch`)。
  新規 framework なし。order/text は非接触 (明示 boundary)。
  Notion 0 (ingest の text backup 経路は使わない)。
- 対象: NUMERIC 12 (facts+status) + UNSTRUCTURED 32
  (empty facts + honest status `geo_present_unstructured`)。
  32 の書込は parser-state の反映であり、live 旧値の各行が
  誤りであることの証明ではない (主張しない)。
- 原子 guarded CAS (必須): guard を WHERE に埋め込んだ条件 DML
  (doc16 全列 + Q2 echo の NULL-safe 一致) を per-doc 単一 batch
  で送り、0 適用 = HOLD (無変更確定)。
  pre-write SELECT 照合は必要だが単独では race-proof でない
  ため不十分。batch 原子性の根拠は repo 実証注記 + binding 文書
  (REST 文書に明文なし・provenance として明示)。
- 失敗方針 (提案): per-doc CAS-HOLD は skip 継続・
  輸送/unknown は ABORT。Unknown 再送なし。
  packet は入力 pins であり live state ではない。
- closed caps (bind ≤100/文): numeric 通は read 4
  (pre 2 + post 2) + write ≤5 (delete + insert≤3 (≤2行/文) +
  doc 更新)。unknown 通は read 4 + write 2 (delete + doc 更新)。
  44 通で read 176 + write ≤119。
  INSERT は guard 付きのため ≤2 行/文 (22+67=89 binds)。
  L2 は 10-stock 1 呼出し (既存 helper 内数)。
  D1 のみ・Notion/R2/dispatch 0。
- module pins (full SHA256): ingest `89ec23f9…baa3a0`・
  projection `924b73c2…b1d1f0`・overseas-save-rows
  `00d873f0…1303c0`・schema `8adec138…7393`・
  packet `c7c0b56f…f3dd`。
- 適用は Root review 後の別 grant。whole-apply 現状 0 のまま。
  Executor 実装は承認済み・WRITE 0 の PREP として次段。

## Limits

- OFFLINE_CANDIDATE は offline 適格であり primary 適格ではない。
- unstructured 32 の empty 化は parser-state 反映であり、
  live 旧値の各行が誤りであることの証明ではない。
- acquisition clock UNKNOWN・ISO DATE なし。
- source URI は構築形 (acquisition 証跡ではない)。
- 観測区間外の不変は主張しない。
- 財務 raw 値は repo に置かない (packet は 0600・repo は
  pointers/metadata のみ)。
