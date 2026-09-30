# Primary provenance inventory (2026-09-30・LOCAL のみ・新規送信 0)

59 closure PARTIAL 受理後の LOCAL 作業。保存済み artifacts +
local FS 読みのみ。source / live Notion / D1 新規操作 0・
新規 grant 消費なし。

## A. 60th page forensics (GET 0・captured のみ)

- 対象 `S100YWM7:type1` (Tier B 先頭・fail-fast HOLD 行)。
  query 時 (11:28–11:30Z) と listing 時 (12:1xZ) で
  created/edited (`2026-09-29T04:45:00Z`)・全 properties 一致。
  観測間 drift なし。
- publisher-original provenance (legacy metadata):
  filer `河西工業`・edinetCode + secCode・docTypeCode 130
  (訂正有報・第95期)・periodEnd 2026-03-31・
  submitDateTime 2026-08-14 11:00 (= Fetched At)・
  parse ok系・honbunFile・fact counts・edinetDocType 1。
  bytes/SHA/cachedZipPath/lease はなし (legacy 世代)。
- Source: `EDINET API v2 /documents/S100YWM7?type=1`
  (bare 形。新 59 行の cached-path suffix なし)。
- container 時刻 (observed metadata・fetch 時刻の証明ではない):
  hosted 内 mtime 09-29 13:45 / local 内 mtime 09-28 23:25
  (as-stored・TZ 未確定)。ZIP 内 mtime も FS mtime も
  repack/copy で変わるため actual source fetch 時刻を証明しない。
  「2 独立 fetch」は仮説であり観測事実ではない (所見から除外)。
- manifest anchor (recorded 09-28): local 慣用原本の SHA は
  manifest_full 記録値 `44d67cf6…` と一致 (09-28 以降不変)。
  hosted (`42a7404d…`) は manifest anchor とも不一致。
  既存 publisher/sourceDoc/wire custody の検査を GET 必要性の
  判断より先に行う。fresh GET 自体が re-timestamp し得るため、
  GET が bytes anchor を与える保証はない。
- 決定: Tier B の bytes/official は NEED-REVIEW/LIMIT
  (mandatory な NEED-SOURCE とは主張しない)。
  archived-wire-as-primary は content-level 利用に限り LIMIT 付きで
  可 (official 形 source URI + 観測区間内
  (09-29 作成 → 09-30 2 captures) で created==edited +
  manifest-anchor 済み local との content 照合済み。
  最終観測以降の不変は主張しない。same-bytes 適格化ではない)。
- inner-ZIP-equal (entry-bytes SHA `ded1638c…` 一致) 単独では
  official/bytes 適格化しない。残 Tier B 4 行は hosted 未取得の
  ため pattern 類推を主張しない (unattempted)。
- 原本 ZIP / hosted raw を変更しない (repack・新 key での
  再 archive による SAME 捏造の禁止。不変性の事実主張ではない)。

## B. missing-3611 inventory + 最小 batch 提案 (未実行)

- union 3675 verdicts 確定: t1 missing 3611 / t5 missing 3670。
  pinPresent=false == 73 list を照合一致。
- t1 local 原本: 3675/3675 存在・empty 0・20MB 超 0
  (max 5117559・全 single_part)。
  FS mtime 09-28 13:19–14:26Z は metadata 扱い
  (capture 時刻の証明ではない)。
  t5 local: 0/3675 (全 absent)。
- manifest 照合 (recorded 09-28): eligible 3611 中
  match 3538 / mismatch 0 / absent 73 (73-set 全件)。
  manifest.json 59 件 = Tier A doc set と一致。
  per-file の actual fetch clock は manifest/log/receipt の
  どこにも存在しない (source 日 tag `2026-09-28` のみ)。
  よって sourceClock = UNKNOWN (substitution なし)。
- batch  eligible-bytes (t1 missing + local 存在 + 正サイズ):
  3611/3611 (3602-set 3538 + 73-set 73)。no-local 0。
  総 bytes 2984049797。
- private packet (0600): `missing-t1-inventory.json`
  `a91c7958…1000e3` (per-cell: doc/type/key/legacyKey/
  pinSet/stockId/filerName/periodEnd/SHA/size/sourceURI/
  clockBasis{fsMtimeObserved/manifestDay/sourceClock}/
  manifestSha/manifestMatch)。
  typed custody は観測済み・legacy key custody は
  UNOBSERVED (契約上読まない)。key 形 mapping のみ収録。
- t5 missing 3670: local 0 のため batch scope 0・全 HOLD。
  fresh GET の必要性は推論しない。
- 73-set 73 件は batch に含むが provenance LIMIT 付き
  (pin-absent の repair 側 HOLD は記録で解消しない。
  3602/73 の grant 分割は Root 判断)。
- 最小 batch 提案 (実装・実行は別途 CODE CLEAR + grant):
  既存 `recordEdinetZip` (type1) + 内蔵 readback のみ。
  新規 archive framework なし。metadata: edinetDocType=1 +
  source 構築 URI (観測形・構築と明示) + packet SHA +
  観測 metadata (fsMtime/manifestDay・capture 主張なし) +
  lease (Root 支給)。filename/contentType は契約 exact。
- fetchedAt: UNDECIDED。mtime からの capture 時刻の発明なし・
  省略時の now 暗黙も使わない。batch は bytes 適格だが
  clock 規約が Root 決定待ち (CODE CLEAR の前提)。
- closed caps: 1 record 当たり notionRequest 論理 ≤9
  (existence 1・upload-create 1・part-send 1・polls ≤4・
  pages-create 1・readback-listing 1) ×7 + hosted 1 =
  64 native max。初回 ensure ≤70 + users/me 7。
  batch 3611 で native cap 231181 (77 + 3611×64)。
  D1/source 0。
- 失敗方針 (提案): record-level HOLD (fileTooLarge/重複/形状外)
  は outcome 収集して継続・輸送/unknown/auth は ABORT。
  Unknown 再送なし。実行時 existence 再照合は helper 内蔵
  (staleness 対応)。
- module pins (full SHA256): archive `b4388151…5edf`・
  client `4a7f7800…6754`・env `de8449e3…ae1c0`・
  readback `6bfde103…2194c`・page-file `48f8574f…3f59`・
  sha256 `da3711c4…001de`・file-upload `c63657f6…07f8f`・
  edinet/archive `a02f24f6…53fbc5`・pnpm-lock `805dd5b3…17e58`。

## C. closed-59 qualification plan (Root review 前・書込なし)

- 59 通 (全 3602-set・73 を含まない) の現行 parser facts /
  scope / units / full preimage / scoped CAS / L2 を束ね、
  全 3675 を待たず meaningful subset 先行の Root review へ。
  same-bytes のみで primary-qualified と呼ばない。
- 内訳: class ADOPTED 19 / CANDIDATE 40・
  verdict MATCH 15 / CHANGED_BOTH 32 / CHANGED_FACTS 12・
  source JOURNAL_ACTUAL 44 / FRESH_PARSE_ACTUAL 15・
  parserStatus ok系 19 / unstructured 35 / no_table 5・
  factsEq true 15 / statusEq true 27。
- preimage: entire16SHA 59/59・protectedSHA 59/59・
  Q2 314 rows (per-doc key/rows SHA 収録)。
- journal 44/59 (proof 付き 12)。残 15 は fresh-parse 出力に
  ex.facts/ex.proof (journal 外)。scope/units/fiscal 証跡の
  深さは通単位で濃淡あり (per-doc 収録・一律主張なし)。
- CAS: per-doc entire16 + protected + facts が scoped CAS 入力
  (列定義は cas-inputs doc16/protected14)。
- L2: distinct stocks 16 → 1 group (≤97・単一 scoped 呼出し)。
- private packet (0600): `closed59-qual.json`
  `8830fd9b…beced1223` (per-doc 全層 + 集計)。
  status: SAME-BYTES-CLOSED, PRIMARY-QUALIFICATION PENDING
  ROOT REVIEW。
- 書込 (D1/Notion) 0。適用は Root review 後の別 grant。

## 適格の境界 (exact)

- custody59: Tier A 59 keys の metadata-anchored same-bytes
  receipt のみ確定。whole-apply (repair 適用) = 0。
- Tier B: 1 行 content-equivalent 証明 (bytes 拒否)・
  4 行 unattempted。Tier C 5: HOLD (byte source なし)。
- missing 3611/3670 は source 不在の証明ではなく、
  fresh GET 必要性を意味しない。
- 閉鎖・記録・適用のいずれも READY の blanket 適格化なし。

## zeros (now)

sourceGET 0 / live Notion 0 (保存 bodies 読みのみ) /
D1 新規 0 / R2 0 / dispatch 0 / record 0 / mutation 0。
live 送信は消費済み grant のみ (query 2+184・close 120)。
追加送信・rerun なし。
