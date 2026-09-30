# 海外 fresh full READ / custody / CAS proposal (2026-09-30)

PROPOSAL (未実行・LOCAL PREP のみ)。次最小 actual への具体案を Root review へ。
code/test/framework の新規なし。本記録は schema・counts・SHA・limits のみ
(public 可)。exact 列表・chunk 計画・pin 表は private 0600 packet のみ。

- branch: `fix/overseas-freshread-prep-20260930` from main `cd25a81` (PR216 merge)
- packet: `/tmp/overseas-freshread-prep-20260930/freshread-packet.json`
  `8f18941e…ba6e0` / `freshread-chunks.json` `cc44578b…47ccf` (0600)

## 現状の trust 境界 (proposal の前提)

- 旧1781 Q1 projection (7列) は full preimage ではない。不足 10列:
  `edinet_code`, `doc_type_code`, `filer_name`, `period_start`,
  `submitted_at`, `parse_status`, `honbun_file`, `text_parse_status`,
  `notion_doc_page_id`, `ingested_at`。
- outside 1894 の LIVE_UNOBSERVED は DB 不在ではない (未観測であり、
  存在・不在のいずれも断定しない)。fresh read は 3675 全通を対象とし、
  全通に観測 identity または明示の missing-identity HOLD を与える。

## Fresh full READ 仕様 (案)

- Q1F (per chunk): `yuho_documents` 全 16列 (schema.ts 宣言順) +
  doc別 correlated `factsCount` = 17射影。doc identity + protected全列。
- Q2F (per chunk): `yuho_overseas_facts` 全 12 storage列 + `docId` echo
  (inner join) = 13射影。決定順 (`doc_id`, `fiscal_year_end`,
  `region_name`)。全facts列 (旧 Q2 と同一・既に full)。
- chunks: 3675 sorted docIDs を ≤100 で 37 chunks (36×100 + 1×75)。
  chunk 計画は packet に pin (per-chunk SHA)。
- parameter counts: per SELECT の binds は chunk IDs のみ (≤100)。
  D1 上限 (bind 100 / 1文100KB / 1invocation 1000query) は
  呼出側 chunk 分割で遵守 (d1-http-client 契約)。
- 送信回数上限: 37 chunks × (Q1F + Q2F) = **74 SELECT / 74 HTTP**。
  単発試行・追加 retry 0・書込 0。guard budget 74
  (`createBoundedFetch` を budget 差替で再使用。batch envelope 禁止・
  SELECT 以外拒否・書込語拒否・budget+1 件目を送信前拒否)。
- 型付き `db.select` のみ (raw positional arrays 不使用)。実行前に
  `toSQL` を取得し read-only + 射影数 (17/13) + 射影名 uniqueness を
  断言 (`assertProjection` 再使用。C29 再発防止)。

## 観測の受理条件 (案・select-proof と同一 strictness)

- Q1 cardinality: 行数 == chunk IDs (exact)。missing doc →
  per-doc MISSING_IDENTITY (READ は継続し、CAS で HOLD)。
  dup/echo 範囲外 → STOP。
- Q2: 決定順検証 + Q1 連鎖 (`document_id`/`stock_id` 一致) + PK 重複 STOP +
  canonical-key (doc + fiscalYearEnd + regionName) 重複 STOP。
- doc別 COUNT 照合: Q1.factsCount == Q2 per-doc rows
  (`assertPerDocCounts` 再使用。chunk 合計のみでは相互相殺を見逃す)。
- 0-rows (factsCount 0 + Q2 0行) は正当な不在観測 (doc 行あり・facts なし)。
  DB-missing とは呼ばない。NULL は保持 (ルール2・0 埋めなし)。
  shape/type 外・unknown は STOP (推測しない)。
- stdout は counts/SHA のみ (D1 IDs/values 0)。honbun 等の protected 値は
  0600 のみ。

## Source / custody (案)

- source 3675: 既存 raw ZIP + `manifest_full.json` pin を carry。
  full-custody-qualified (t1 実体 complete + SHA/length 照合) vs pending を
  per-doc に分ける。照合は既存 `manifest_full` pin + 将来 official fresh
  bytes (別 grant)。
- 73 historical UNKNOWN は保持 (過去 custody 不明・apply HOLD。偽補完なし)。
  将来 official fresh GET / current identity / full-bytes / custody /
  current CAS で現修正資格化する道 (PREP 記録の通り)。
- Notion 一次保管は既存契約を再使用 (`{docID}:type1`/`:type5` keys +
  実 bytes のみ。`recordEdinetZip` / `TypeCustody`
  complete/metadata-only/missing/not-applicable)。custody 照会は
  20 docs/回 (40 keys・上限 41 内)。今回は照会 0 (将来 grant)。

## CAS (将来 apply・案。apply grant は別途)

- 条件 (全充足のみ適用可): per-doc full fresh preimage 存在 (Q1F+Q2F) +
  protected 14列の差 0 (pre→post) + missing-identity HOLD の解決または
  除外 + orders/text 変更 0 + same-run full physical verify +
  全 postflight + reentry 0。
- protected 14列 = 全 doc 列から `overseas_parse_status` /
  `overseas_honbun_file` を除いたもの (packet に列挙)。
  repair の書込は overseas 2列 + facts 置換のみ
  (backfill-overseas と同一形状: per-doc 単一 batch で
  UPDATE + DELETE + INSERT(11列順・8行 chunk)。逐次 fallback なし)。
- `yuho_order_facts` / text 系には触れない (UPDATE allowlist 2列・
  DELETE は overseas 表に限定)。orders/text 変更 0 は CAS 条件に含める。
- same-run full physical verify: 適用と同一 run で全 pre-image rows を
  exact counts/ids で含む postflight を行い、reentry 0 を receipts で示す。

## 再使用 helper (新規なし)

- `overseas-745-select-proof.ts` (blob `91eb924f41fc`):
  `createBoundedFetch` / `assertProjection` / `projectedNames` /
  `assertPerDocCounts` / Q1/Q2 型付き select 形状 / per-query manifest。
- `backfill-overseas.ts`: per-doc 原子 batch 形状 (UPDATE + DELETE +
  INSERT) / `validateOverseasSaveSet` 前検証 / `recordEdinetZip` 順序
  (D1 書込より先)。
- `src/shared/db/d1-http-client.ts`: `createD1HttpDb` (単発 SELECT・
  strict success 検証・outcome-unknown は再送なし) /
  `createD1HttpBatchSender` (将来 apply 用。件数一致 + 全文 success)。
- parser `overseas-parser.ts` blob `07ad7a54b975c543a604dcf52b31df91b72f23f7`
  (main `cd25a81` 時点。PREP と同一)。

## 固定 pins (carry・packet で bytes 検証済み)

- source: `manifest_full` `398843d5…02ca4` (3602) + ZIP 3675 (0600)
- `okdocs` `034cefad…98735` / `savedfacts` `58122d8d…b2bbb31` (21258行)
- 745-prep: manifest `c2345269…7083a7` / sets `62095358…308b5d1` /
  journal `5127c73b…88d5b9dc` (1728行)
- census `bb1cccb1…de7387` (3602 最終 freeze)
- select: union `54c6fb38…f16fdc` (1781) / live `4a4cbc04…adeb517` /
  compare `75ba0835…74e879`
- repair PREP (PR216): manifest `754ecba7…caac98` (3675) /
  journal `85985cda…e2af` (3654行) / sets `cf39b957…8884` /
  report `9963b3b7…829`
  (observed 21/1687/73 + historical 1440/454・LIVE_UNOBSERVED 1894)
- code (main `cd25a81`): parser `07ad7a54…` / repair-prep script
  `52b53b40b4c2` / repair-union lib `bcf704fec47f` /
  select-proof `91eb924f41fc`

## zeros (now)

sourceGET 0 / Notion READ+archive 0 / D1 READ 0 / D1 WRITE 0 /
R2 0 / dispatch 0。新 grant は Root 別具体承認。

## limits

- 本 proposal は未実行。具体値は将来 run の report が持つ。
- Fresh READ 自体も Root の別 grant が要る (D1 74 HTTP・SELECT-only)。
- 旧 snapshot (1781) は旧観測。full preimage は fresh Q1F+Q2F のみ。
- 未選択の protected 外 (orderFacts 行等) は scope 外:
  変更不可を構造 (allowlist + 表限定) で保証し、CAS は doc 14列差 0 で
  検証する。Root 確認事項。
- orders/text 修正 0。closed 208/216 branches への push なし。
