# 海外 CURRENT 3675 join PREP (2026-09-30・local 実行済み)

fresh capture-live (current DB @08:40:31Z) x pin census (3602) x
repair-sets tags x inspect-73 の exact join。network 0・書込 0
(OUT のみ)。per-doc actual IDs (doc/stockId) は private 0600 のみ。
本記録は counts・SHA・limits のみ (public 可)。

- at: `2026-09-30T09:28:15.905Z` (local)
- inputs: `capture-live.json` `96f5af98…bc25e` /
  `manifest_full.json` `398843d5…02ca4` /
  `repair-sets.json` `cf39b957…19884` /
  `inspect-73.json` `88c2d5a0…0b93`

## Join counts (exact・構造断言済み)

- union 3675 = PIN_PRESENT 3602 + PIN_MISSING_HOLD 73 (重複 0)。
  73 は `holdPinMissing` 集合と完全一致 (不足・重複なし)。
- Q1 factsCount == Q2 row count を全 3675 通で一致確認 (不一致 HOLD 0)。
- Q2 合計 21245 = pin 側 20848 + HOLD 側 397。
- distinct stockIds 563。HOLD 73 が触れる stocks 67。
- 論理キー (fiscalYearEnd|regionName|regionKind|isConsolidated)
  の doc 内重複: 0 通 (全通一意。CAS compare 可)。

## Tag x class 行列 (tags は multi-membership・合計は 3675 を超える)

- census-adopted 1411 / held 1487 / other 704 / reverse 36:
  全通 PIN_PRESENT (census 系に pin 欠落なし)。
- live1781 = 1708 + 73 (HOLD 全通が live1781 持ち)。
- old-l1changed1695 = 1655 + 40 (historical 参照のみ)。
- hist804 = 783 + 21。remain745 = 724 + 21。
  stable2871 = 2819 + 52。applied59 = 59 (全通 pin 側)。
- 全 tag 合計が既知 census (1781/1695/804/745/2871/73/59) と照合一致。

## CAS PREP (executor guard 用 current 比較キー・書込 0)

- DOC16 = Q1F 17 keys − factsCount (形状断言 16)。
  protected14 = DOC16 − {overseasParseStatus, overseasHonbunFile}
  (形状断言 14。2 列は authorized change 予定)。
- per-doc: protectedSHA + factsCountQ1 + q2RowCount +
  q2KeySHA + q2RowsSHA (全 13 列・NULL 保持) + q2DupKeys。
- orders/text 変更 0 は別途 CAS 条件 (本ファイル対象外)。
- 本キー単独で repair 実行しない
  (source-primary qualification + 別 grant 要)。

## L2 PREP (p_yuho_growth・集計のみ)

- stock 単位の join 集計 (docs / pinMissing / facts 計) のみ。
  projection 実行 0・書込 0。
- 将来 sweep は 1 call target group <= 97 (3+N<=100) の
  既存提案に従う (本 PREP は group 実行しない)。

## 73 provenance (HOLD 理由・構造化)

- 全 73: `PIN_ABSENT_ZIP_PRESENT_NEEDS_SOURCE_PROVENANCE_REVIEW`
  (bytes 存在 73/73・bytes 不在 0)。
- 既存 ZIP actual SHA を初回記録 (offline read-only)。
  pin なしのため照合対象なし・捏造なし。
- inspect-73 行 + tags + CAS keys + actual SHA を 1 行に統合。
- official source metadata / current ZIP issuer / doc identity /
  known physical proof は未検査。全通
  NEEDS_SOURCE_PROVENANCE_REVIEW を継続・HOLD 継続。
  REQUIRED は既存 official provenance が資格化不能な場合のみ。

## Bounded custody proposal (既存・本 join で具体化)

- baseline ZIP は OBSERVATION (DB 観測の保管)。
  3675 rawZIP の primary proof では決してない。
- source-primary qualification: pin byte-identity (3602) は
  候補条件に過ぎず、official source 照合なしに repair 適格としない。
- 73 は source provenance review が先行 (既存 ZIP actual SHA 済み)。
  review 結果が不適格な場合のみ official fresh GET 道
  (別 grant・backfill なし)。

## Outputs (0600・fsync)

- `join-rows.json` `6ecefab5…8554` (3675 行・actual IDs 含む)
- `join-aggregates.json` `390238ef…788d`
- `stockids-actual.json` `0694bfe6…85f` (563 stocks 実リスト)
- `cas-prep.json` `eedd91b0…7301`
- `l2-prep.json` `954e5f71…73d6`
- `73-provenance.json` `eaf8fd89…39e6`
- `run-record.json` (inputs/outputs SHAs・counts)

## zeros (now)

sourceGET 0 / Notion 追加 0 / D1 READ+write 追加 0 /
R2 0 / dispatch 0。D1 READ 74・Notion 16+3 は各 authorized
ONE のみ (再実行・re-GET・re-record なし)。

## limits

- DB 観測は @08:40:31Z snapshot。current 性は executor が
  CAS guard (書込前照合) で再確認する (本 PREP では再読しない)。
- PIN_PRESENT は source 適格を意味しない。
- 73 の過去 custody は UNKNOWN のまま。
