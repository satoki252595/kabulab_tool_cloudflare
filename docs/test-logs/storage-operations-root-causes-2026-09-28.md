# Lane C: 保存運用の根本原因と共通境界の修正 (2026-09-28)

Lane C (moneyflow 保存・週次信用残・①マスタ重複・共有 notion-archive/env) の
根本原因調査とコード修正の記録。基準 `origin/main ae4aa34`、branch
`fix/storage-operations-root-causes-20260928`。本番書込は writer 枠待ちのため
本記録の検証はコード・隔離 (mock)・読取専用 (Notion GET/query・D1 SELECT・
R2 GET・公開 HTTP GET) のみ。書込 0。

表記: Notion ページ/DB の ID・署名 URL は記さない (役割・件数・時刻のみ)。
公開原本 (JPX PDF/HTML) の SHA は full で記す。R2 派生 JSON は sha16 まで。

## 1. Finding 一覧 (原因/証拠/同型/非対象/運用回復)

### F1. moneyflow 4 DB が 0 行 — job 未実行 (呼出断)

- 原因: `moneyflow` workflow の実行が 0 件 (API `total_count=0`。初回
  schedule 9/28 08:30 UTC も 13:51 UTC 時点で未発火)。保存コードはあるが
  一度も走っていない。DB identifier・schema・dry-run・read-query のいずれも
  不良ではない (下記で除外)。
- 証拠:
  - `gh workflow view moneyflow`: Total runs 0。直近 60 runs に moneyflow なし。
  - 4 DB は全て 2026-09-27T04:50:00Z (同一分) に作成済み、行 0 (page_size 1
    probe + has_more=false)。schema はコード定義と一致 (primary 10・defs 9・
    obs 13・runlog 7 props)。作成は #121 マージ (9/27 16:48 JST) より前。
  - 監査の DB 発見は本番コードと同一の `findBackupChildByTitle` + 同一
    title/parent のため「read query wrong DB」は除外。
- 除外した候補: DB identifier 規約 (発見できる=一致)、schema 不整合 (一致)、
  書込 dry-run (schedule は本番実行のはずだが未発火)、呼出断=肯定。
- 非対象: 25 spec の fetch/parse (監査で全 25 dry-run OK 済み。再 parse 禁止)。
- 同型の修正: カタログ同期の失敗が取込ログに残らず「DB だけ作って 0 行の
  無痕跡状態」を作る経路を修正 (F3)。
- 運用回復: writer 枠で初回 `workflow_dispatch` (all) → 保存再読 → 2 回目
  0 件計画 (§4 P1)。9/28 schedule 未発火は外部異常として root へ報告
  (peer の tdnet_hourly/supply_daily は同日発火済み)。

### F2. 週次信用残の発見不能 — JPX が 05.html を更新し週末残高 PDF は 01.html へ移転

- 原因: 9/26 まで 05.html にあった `syumatsu*.pdf` リンクが、9/28 実測で
  05.html から消滅 (0 件)。同ページは信用取引現在高表のみになった。週末残高
  PDF は 01.html (銘柄別信用取引残高) に移転し、直近 4 週
  (08/28・09/04・09/11・09/18) + 新ファイル `20260925_mtall.pdf` が掲載。
  現行コードは 05.html 固定のため次回 job は「margin pdf link not found」で
  落ちる (確定。再現: 9/28 18:06 JST の 05.html bytes に syumatsu 0 件)。
- 新様式との境界: 移転先の週末残高 PDF は従来の `syumatsu*.pdf` 名・内容
  (9/18 はバイト同一を実証 §F4)。index 移転のみで新様式本体に依存しない
  ため、repoint は今 scope。`20260925_mtall.pdf` の内容は触らない (延期分)。
- 証拠: `/tmp/audit-b/jpx-margin-page.html` (9/28 18:06 JST、md5
  875b4aac…)、`/tmp/laneC-jpx-01.html` (9/28 取得、0600、sha256
  b299a114d6177b43c97f4fc2e82b483c27913cdbc4004892277ca0e7cd2cfabc)。
- 修正: `PAGE` を 01.html へ + 発見の純関数化と回帰 (F6)。
- 非対象: 日次化・新様式 PDF の解析 (9/29 以降・別 scope)。
- 運用回復: 土曜 job は最新週のみ取得のため、欠落週の補修は `--week` で個別
  取得 (§4 P2)。一覧に無い週は throw して最新で代用しない。

### F3. (同型・修正済み) moneyflow 取込のカタログ失敗が取込ログに残らない

- 原因: `scripts/moneyflow/ingest.ts main()` は `syncIndicatorCatalog` を
  try 外で呼び、失敗時は runlog 記録なしに落ちる。F1 と同じ「DB あり行なし
  無痕跡」症状を作る。
- 修正: 失敗を `indicator-catalog` の失敗 outcome として取込ログへ記録し
  exit 1。既存 path の振る舞いは不変 (共通 `writeRunLog` へ抽出)。
- 回帰: `ingest.test.ts` に fatal-path テスト (失敗記録・exit 1・取得未実行)。

### F4. #117 (9/18 週の保管欠落) — bytes は保全、保管のみ未了

- 原因: #134 で修正済みの detach (解析が原本 bytes を破壊)。9/26 run は
  R2 保存後に保管で失敗 (部分完了)。
- 実証 (再取得・再パース禁止ではなく既存原本の純解析 + 新 index からの
  同一性確認):
  - `/tmp/syumatsu.pdf` (9/27 取得 cache): 873,311 bytes、sha256
    `21c99f4e06641cae0270bd8151c41d45559e28a08f165a829726b9601c52131d`。
    修正後コードで parse → week=2026-09-18・rows=4230・parse 前後バイト不変。
  - 新 index (01.html) の `syumatsu2026091800.pdf` を取得 (0600): 同バイト数・
    同 sha256 (バイト同一)。週次内容の連続性を実証。
  - Notion `一次データ｜vwap-analysis` の `jpx-margin-*` は 0 行 (保管は
    9/26 の 1 回だけ試行され失敗。#75 の保管追加は 9/20 のため、それ以前の
    run は R2 のみで正常終了していた)。
- 運用回復: writer 枠で 9/18 PDF の再保管 (bytes 上記) → 物理再読 (§4 P2)。

### F5. 旧週欠落 7/3・7/10 — Actions 起動失敗の連鎖 + 最新のみ取得 (backfill なし)

- 原因: (a) 7/11・7/15・7/17・7/18・7/20 の vwap-ingest が起動 4 秒で失敗
  (step 未到達。stock-sync も同日に 4 秒失敗あり=platform 側。ログは保持
  期限切れで原文確認不能)。(b) `ingest-margin` は最新 PDF のみ取得し、
  落とした週を追わない。7/4 run は 6/26 週を保存 (当時の最新)、7/25 run は
  7/17 週を保存し、7/3・7/10 は永久に飛ばされた。
- 証拠: R2 `margin/weeks.json` (13 週) に 7/3・7/10 なし。dispatch 実行は
  6 月のみで 7-9 月の手動補填なし。
- 取得可否の実証 (一覧の有無だけでは断定しない): 週末残高 PDF の格納
  dir (`.../margin/tvdivq0000001rnl-att/`) は 3 月の Wayback snapshot と
  現在で同一 (stable)。同 dir 直下の未掲載 11 週 (6/12・6/19・6/26・7/3・
  7/10・7/17・7/24・7/31・8/7・8/14・8/21) を live HEAD で全件確認 →
  全て HTTP 404 (21,082 bytes の共通エラーページ)。JPX は直近 4–5 週だけ
  残し旧週を削除する運用 (3 月 snapshot は 5 週掲載)。よって 7/3・7/10 の
  原本は現行公開物から再取得不能 → 正直な欠落として残す (推測補完しない)。
  残差: JPX 側の復旧・別公開は repo 外 (確認手段なし)。
- 修正 (再発防止): 欠落週の検出 (`weeksMissing`。末尾だけでなく区間内部も。
  実 13 週リストで 7/3・7/10 を検出する回帰付き) と `--week` 個別取得を
  追加。保存済み内容の書換えはしない。日次 job には初回設計から backfill
  要求を出す (root へ提案)。
- 非対象: 当時の 4 秒失敗の platform 根本原因 (repo 外。ログ消滅)。

### F6. 旧種類株コード重複 — #28 以前の R2 11 週に崩壊あり、9/11 は正常

- 原因: #28 (9/13) より前の code は 5 桁種類株を 4 桁へ潰し、同一コードの
  別行を保存した (推測ではなくコード差分で確定)。
- 実証 (R2 全 13 週の読取行列):
  - 6/12–9/04 の 11 週: 各 dupExcess=7・5 桁 0。9/04 の 6 コード
    (2593/5076/7550/9201/9202/9434・9434 は 3 行) で、2 行目以降は種類株の
    小値 (例 2593: 77200/244500 と 100/17500)。行は別々に残るが、どちらが
    種類株かは JSON だけでは断定不能 (ISIN は PDF のみ) のため原本必須。
  - 9/11・9/18: dup 0・5 桁 7 (25935/50765/75505/92015/92025/94345/94346)。
    9/11 は Sol 分類の「重複」に当たらず正常 (普通+種類の共存は現行契約)。
- 回復: 8/28 (856,411 bytes・sha256
  `660596c6e48730d490c7ea99a638b082a3ab71dba94f3647b4a15fa3a8b11c99`) と
  9/04 (867,440 bytes・sha256
  `c263121c131e6a79a01353d1e7ae94e8b22a45368104f1fdd76690eee43b0bfd`) の
  原本を 01.html から確保 (0600・未 archive)。修正後コードで再 parse →
  8/28 は 4229/4229 distinct、9/04 は 4226/4226 distinct・5 桁 7 で修復
  可能を実証。writer 枠で R2 書換え + PDF 保管 (§4 P2)。
  6/12–8/21 の 9 週は原本が stable dir で 404 (全週 live 確認) のため修復
  不能 → 正直な既知不良として残す (R2 の崩壊 JSON は上書きせず残す)。
- 非対象: 9/11 以降の週 (正常のため無変更)。

### F7. 単一行照会の先頭選択 — 共通境界へ修正 (全6経路)

- 原因: Notion に一意制約は無いのに、`page_size: 1` + `results[0]` の照会が
  重複時に先頭行を黙って選ぶ。書込側 (`findByKey`) は重複で保全停止する
  のに対し、読取/更新側が黙って選ぶ非対称があった (例: 保管読取が別行を
  返し再解析が取り違える)。
- 母集団調査 (repo 内 `results[0]` 全件): 対象 6
  (moneyflow 指標定義・観測ログ・価格同期・有報テキスト・銘柄別データ親・
  moneyflow 保管読取)。非対象: `findByKey` (既に厳密・今回の委譲元)、
  `loadSupplementRows` (重複 throw 済み)、`loadStockMasterIndex` (重複を
  index から除外し件数報告済み)、biztag-ledger/competitors (全件収集で
  先頭選択なし)、index-page (列挙のみ)。
- 修正: `archive.ts` に `queryUniqueRow` (page_size 2・2 件以上/has_more で
  保全停止) を追加し 6 経路を移行。`findByKey` は委譲 (message 不変)。
- 回帰: helper 4 件 + 指標/観測/保管読取の重複 throw 3 件 (書込 0 まで検証)。

### F8. ①マスタ重複 3681/7129 — 生成は旧時代、現行 code は収束済み

- 生成の原因 (2026-06-28): 3681 は同分 2 作成 (同時実行の競合。当時の
  コードに create 収束なし)。7129 は 4 時間差の 2 作成目 (map 読込後に
  先行行ができた stale-map create)。いずれも現行の #13 収束
  (`converge_created_page` + 最古勝 + `_dedup_by_code` + all-or-nothing map)
  より前の時代の産物。
- relation 乖離の原因: 3681 の全 20 relation は 2026-06-28–07-05 に退避側
  へ書かれた (fresh snapshot で created を実測)。当時の解決規則 (旧) の
  産物で、現行の最古勝では保持側に書かれる。現行 code の乖離ではない。
  (D1 写しは両 code とも保持先を指すことを 9/28 fresh SELECT で確認。
  最終書込は 9/15 の月次 master_sync。)
- 現行 code の残存 risk: 同時実行の二重 create は収束の再 query で拾う
  設計だが、Notion query の eventual consistency を突き抜けると残る。
  対策は検出 (biztag backfill の重複件数報告が既に検出器として機能。
  9/25 run で本件を検出)。code 変更なし。
- 同型の確認: master 作成 caller は `master_sync` のみ
  (`upsert_stock_master` 呼出は同所だけ。edinet/tdnet は読取のみ。TS 側に
  master 作成なし)。supplement/biztag は重複を除外・報告する (F7)。
- Python 回帰: 同分タイの page-id 決定は既存テストでカバー
  (`test_same_created_time_is_decided_by_page_id` 等) のため追加なし。
- 運用回復: #137 の plan/apply (退避の契約修正つき §F9) を writer 枠で
  実行 (§4 P3)。`master-dedup-102` の一次/ごみ DB は不在を確認
  (手動 caller は書込前に停止 → migration 不要)。

### F9. 退避の所有契約 — master ページに moveToTrash は不可、直接 archive が正

- 原因: #137 の退避 step は ① マスタページを `moveToTrash` へ渡すが、
  共有 helper は origin の `Service` が一致しなければ保全停止する
  (`archive.ts` の厳密照合で実証)。master ページに Service はなく、
  推測付与は禁止 (D1 指示) のため現行 apply は退避で停止する。
  これが正しい所有契約: moveToTrash の対象は一次データ保管のレコードのみ。
- 解決 (既存情報から): pipeline の重複収束 (`converge_created_page`) と
  同じく直接 archive (PATCH archived:true)。内容の証拠は snapshot
  (一次データ保管・SHA 検証済み) + receipt で保つ。ごみ DB は作らない
  (新 DB 乱造の回避にもなる)。
- 修正: `applyRetire` を直接 archive 方式へ (`create`/`repatch`/`recover`/
  `stop` の 4 分岐。archive PATCH は冪等のため repatch 再送は安全。
  外部 archive は stop)。receipt は `{archivedAt, verifiedAt}` へ
  (archivedAt は再読 API の last_edited_time)。旧形式 receipt は引継がず
  停止。`verifyTrashPage` → `verifyArchivedPage`。
- 回帰: 決定表・検証・receipt の既存 75 件を新契約へ更新し全緑。
- 非対象: snapshot 保管 (`recordPrimaryData`・所有契約は正しいため不変)、
  移行/lifecycle/補足/D1 の各 step (不変)。

### F10. IMF CPIS 公式 primary — 登録不要の公式口を確認 (訂正あり)

- 訂正: 初版は「登録なしの公式機械取得口はない」としたが、誤りだった。
  旧 CPIS 頁 404・bot 壁 403 は PIP 改名後の公式口の不存在証明にならない
  (root 指摘)。R 公式 client (`pedrobtz/imf.data`) の URL 構築を実ソースで
  確認し、正しい path で再試行したところ匿名で取得できた。
- 実証 (9/28・匿名・登録不要):
  - base `https://api.imf.org/external/sdmx/3.0`。一覧は
    `structure/dataflow/IMF.STA/%2A/%2B?detail=allstubs`
    (wildcard は URL encode 要。生 `*` は 500)。191 dataflows。
  - CPIS の後継は dataflow `PIP` v5.0.0 (agency `IMF.STA`、
    "Portfolio Investment Positions by Counterpart Economy (formerly
    CPIS)")。表示名 PIP を API ID と推測したのではなく一覧で確定。
  - DSD `DSD_PIP` v5.0.0。key 順:
    COUNTRY.ACCOUNTING_ENTRY.INDICATOR.SECTOR.COUNTERPART_SECTOR.
    COUNTERPART_COUNTRY.FREQUENCY (+TIME_PERIOD)。
  - codelist: `CL_PIP_COUNTRY` v2.0 (日本=`JPN`・世界計=`G001`)、
    `CL_ACCOUNTING_ENTRY` (資産=`A`/負債=`L`)、
    `CL_PIP_INDICATOR` v4.0.0 (60 codes。代表 5:
    `P_TOTINV_P_USD`/`P_F51_P_USD`/`P_F3_P_USD`/`P_F3_S_P_USD`/
    `P_F3_L_P_USD`)、`CL_SECTOR` (計=`S1`)、`CL_FREQ` (半期=`S`)。
  - data 例:
    `data/dataflow/IMF.STA/PIP/5.0.0/JPN.A.P_TOTINV_P_USD.S1.S1.G001.S?
    lastNObservations=1` → HTTP 200。日本・対外資産計の公式最新は
    2025-S1 (2025-6 末。Sol 報告と一致) = 4808565885737.681。
    単位は鏡と同 scale (2024-S1 の公式 4330263358778.068 に対し鏡
    4337640482073.52。差は改訂分 ~0.17%。鏡は 2024-S2 以降を持たない)。
  - pagination: `lastNObservations` は有効。`startPeriod/endPeriod` は
    無視された (全期間 38 obs が返った) ため実装者は注意。
  - 旧口の状態: `dataservices.imf.org` は NXDOMAIN (死)。`sdmxcentral`
    2.1 は生存も CPIS 公表なし (収集様式のみ)。`portal.api.imf.org` の
    signin は開発者 portal の話で、SDMX data API に key は不要だった。
- 結論: 現行 code (鏡を鏡と明示・最新扱い fallback なし) は正しいまま
  code 変更なし。公式移行は別 scope の新規 SDMX-JSON parser が必要
  (鏡 parser (`series.docs` 系) の流用不可。auth 失敗時の鏡 fallback 不可)。
  上記の正式契約を移行時の正本とする (P4 改訂)。
- 非対象: 移行の実装自体 (本 PR 外。root が scope 決定)。

### F11. (review 修正) 信用残取込が R2 を先に保存 — 保管失敗で部分保存になる

- 原因: `ingest-margin` は R2 JSON → weeks.json → Notion 保管の順で、
  保管失敗時に R2 だけ残る (#117 がその実例)。派生 (R2) は原本から
  再生成できるが逆はできないため順序が逆。
- 修正: 「検証 → 原本保管 → R2 PUT」に固定。保存前検証を純関数
  `validateMarginData` (週/行/原本バイト) へ抽出し、週一覧の読取・検証も
  全 PUT より前へ。保管失敗時は R2 へ何も書かず throw する。
- 回帰: `ingest-margin.test.ts` に順序テスト (保管→R2 の呼出順・保管失敗で
  r2Put 0 回) + `validateMarginData` の 4 件。`main` を export して
  doMock で検証 (moneyflow ingest と同方式)。
- 非対象: R2 失敗時の保管済み残存 (原本が先にある状態。R2 は再実行で
  再生成できるため、逆の部分保存より回復可能)。

### F12. (review 修正・F5 の検出を強化) `weeksMissing` が末尾しか見ない

- 原因: 初版は保存最大週より先だけを欠落とし、7/3・7/10 のような
  区間内部の欠落 (保存済みに挟まれた欠落) を検出できない。
- 修正: 保存済みと今回週の両端を結ぶ 7 日刻みの期待週から、保存済み・
  今回を除いた週を全て報告する。`--week` の過去週補修でも内部欠落は
  報告する (今回週は除く)。
- 回帰: 実 13 週リストで 7/3・7/10 を検出するテスト + backfill 形のテスト。

### F13. (review 修正・F7 の同型) DB 作成の結果不明再送 — 停止と回収

- 原因: 非冪等 create の結果不明再送禁止は POST /pages のみで、
  POST /databases (DB 作成 9 箇所) は network/529/5xx で内部再送し、
  同名 DB の二重作成を起こし得る。
- 修正: (a) `client.ts` の guard を POST /databases へ拡張し、結果不明は
  型付き `NotionUnknownResultError` で即 throw (message は不変)。
  (b) 共通 helper `createDatabaseOrAdopt` を追加し 9 箇所を移行
  (archive・moneyflow 3・価格同期・補足・台帳・dataset 親子)。
  結果不明時は `refind` (full query) で確認し、あれば回収・無ければ
  停止 (自動再 create しない)。回収時は schema 検証へ進む
  (同名の古い DB かもしれないため)。
- 回帰: guard 4 件 (500/529/network/429-再送可) + helper 3 件
  (作成・回収・未発見停止。POST は 1 回きりまで検証)。
- 非対象: POST /pages の既存 guard (message 不変・回帰維持)、
  file_uploads (孤児は無害・scope 外)、同時実行の二重作成
  (従来どおり検出で対応)。

### F14. (review 修正) run-spec の最終行 skip — 途中欠落を見落とす

- 原因: 保管済み path は最後の 1 観測キーの有無で全バッチを skip する
  ため、「最後だけある途中欠落」や値・relation の不一致を修復できない。
- 修正: 常に全 draft を `upsertObservation` にかける (同値は書かず、
  欠落・不一致だけ修復する既存動作を全行に適用)。全行同値なら
  「未更新 (N 行同値確認)」、修復があれば再送の内訳を返す。
  `observationExists`/`observationKey` の import を除去
  (Phase 1 の既存使用は不変)。
- 回帰: 全行同値 (upsert 2 回・書込なし・未更新) + 途中欠落の修復
  (新規 1/同値 1) の 2 件へ更新。
- 非対象: 未保管 path (取得→保管→upsert は不変)、dry-run (不変)。

### F15. (review 修正・F13 の残り 2 件 + privacy 1 件) 回収の厳密化と型検証

- 原因: (a) 結果不明回収の `refind` が通常探索
  (`findBackupChildByTitle` の最古選択) のため、同名複数時に古い DB を
  黙って回収し得る。(b) `archive.ts` の一次/ごみ DB と `dataset.ts` の
  銘柄別親 DB は回収 DB を schema 検証なしで cache/return し、型違いを
  通す。子 DB も adopted 時の型検証が無い。(c) `queryUniqueRow` の重複
  エラーに private な databaseId 全文が載り、通常の GH ログに出る。
- 修正: (a) 回収専用 `findUniqueBackupChildByTitle` (完全一致
  0=null停止・1=回収・複数=保全停止。Search 0 件で bounded 保険走査に
  戻らない) と子 DB 用 `findUniqueChildDatabaseForAdopt` (全走査で多重
  検出) を追加し、9 箇所の refind を全て移行 (通常探索の最古収束は
  不変。POST 再送なし)。(b) 共通 `assertAdoptedDatabaseSchema`
  (必須列の存在+型を検証し、不足・型違いは保全停止。既存列を置換
  しない) を追加し、archive・dataset 親・dataset 子 (adopted 時のみ)
  の cache/return 前に GET 検証。(c) 重複エラーから databaseId を除去
  し公開 key・context のみ (`findByKey` の context に key を追加)。
- 回帰: `archive.test.ts` +12 (回収 0/1/複数・子 DB 0/1/複数・型検証 3・
  回収統合 2・privacy 2 更新)。POST 1 回きり・cache 前停止も検証。
- 非対象: 通常探索の最古収束 (不変)、既存 DB の不足列 PATCH 移行
  (不変)。本 gate は code のみで本番書込なし (writer 枠待ちは不変)。

## 2. 変更ファイル (16 + docs)

- `services/vwap-analysis/lib/margin.ts`: 発見先 01.html・発見の純関数化
  (`extractMarginPdfLinks`/`latestMarginPdfUrlFromHtml`/
  `marginPdfUrlForWeekFromHtml`)・指定週取得 (`fetchMargin(week)` + 週一致
  検証)・`weeksMissing` (末尾+内部欠落)・`validateMarginData`。
- `scripts/vwap/ingest-margin.ts`: `--week=YYYYMMDD`・欠落週の報告・実行
  guard 追加 (import 時の main 誤実行を抑止)。保存順序を
  「検証 → 原本保管 → R2 PUT」に固定し `main` を export (順序テスト用)。
- `src/shared/notion-archive/archive.ts`: `queryUniqueRow` 追加・
  `findByKey` の委譲・`createDatabaseOrAdopt` 追加・回収専用厳密探索
  (`findUniqueBackupChildByTitle`・`findAllChildDatabases`・
  `findUniqueChildDatabaseForAdopt`)・`assertAdoptedDatabaseSchema` 追加。
  重複エラーから private databaseId を除去 (公開 key のみ)。
- `src/shared/notion-archive/client.ts`: 非冪等 guard を POST /databases へ
  拡張・結果不明を型付き `NotionUnknownResultError` 化 (message 不変)。
- `src/shared/notion-archive/moneyflow.ts`・`price-sync-log.ts`・
  `stock-text.ts`・`dataset.ts`・`scripts/moneyflow/lib/archived-files.ts`:
  単一行照会 6 経路の移行。
- `src/shared/notion-archive/moneyflow.ts` (3)・`price-sync-log.ts`・
  `stock-supplement.ts`・`biztag-ledger.ts`・`dataset.ts` (親子)・
  `archive.ts`: DB 作成 9 箇所を `createDatabaseOrAdopt` へ移行
  (回収時は schema 検証へ進む。refind は厳密探索へ移行し、
  dataset 親子は cache 前に GET 型検証)。
- `scripts/moneyflow/ingest.ts`: カタログ失敗の取込ログ記録 (`writeRunLog`)。
- `scripts/moneyflow/lib/run-spec.ts`: 保管済み path を全 draft upsert 化
  (最終行 skip を廃止。同値確認の未更新メッセージ付き)。
- `scripts/notion/master-dedup.ts`・`master-dedup-3681-7129.ts`: 退避の
  直接 archive 化 (決定・検証・receipt・marker 運用)。
- 回帰 (上記 +): `margin.test.ts` (+13)・`ingest-margin.test.ts`
  (新・3+順序 2)・`archive.test.ts` (+4+3+12)・`client-retry.test.ts` (+4)・
  `moneyflow.test.ts` (+2)・`archived-files.test.ts` (新・3)・
  `ingest.test.ts` (+1)・`run-spec.test.ts` (更新・2)・
  `master-dedup.test.ts` / `master-dedup-flow.test.ts` (更新・75)。
- `docs/notion-master-dedup-3681-7129.md`: 退避 step の契約更新。
- `docs/release-notes.md`: 変更 1 行。

## 3. 検証 (隔離・読取のみ)

- `vitest run`: 197 files・2829 passed・367 skipped・0 failed
  (F15 gate 後に再測定。+12 は回収厳密化・型検証・privacy)。
- `tsc --noEmit`: clean。`eslint src services --max-warnings=0`: exit 0。
  (`scripts/` の既存 lint error 1 件は gate 外かつ本差分の範囲外のため不変。)
  `audit:report:check`: OK。本 gate も本番書込 0 (code・隔離 mock のみ)。
- 読取専用スナップショット (Notion 約 60 req・1400ms 間隔、D1 SELECT 3、
  R2 GET 約 20、公開 HTTP GET 約 30): 全て `/tmp/laneC-*` (0600) に保存。
  本番書込 0 (Notion/D1/R2 の書込・archive・job 起動なし)。
- 保全範囲の正確な記載: incoming snapshot は件数+created 時刻の行 inventory
  であり、開示/財務の行本文・物理添付の完全保全ではない。行内容の原本は
  各行の ⑤ 原本 record が持ち、本 snapshot は master 4 page の全 properties
  + body block inventory + files 一覧 + incoming 行 inventory を保全する。
- 実 PDF の純解析: 9/18 (873,311 bytes・週/行・前後不変)、9/04・8/28
  (修正後 parse で全 distinct・5 桁 7 を確認)。

## 4. 本番適用 plan (writer 枠で root が直列実行。新 task 化を想定)

共通 gate: 対象 writer の GitHub Actions が実行中 0・queued 0
(#154 の前例)。各 plan は適用→再読→2 回目 0 件までを 1 枠で直列。

### P1. moneyflow 初回保存

1. `workflow_dispatch` (moneyflow・all) を手動起動 (schedule 未発火のため)。
2. 再読: defs 行数=指標数・primary=取得元数・obs>0・runlog=成功。upsert の
   full key・bytes・sha・source/period/units を実体再読で確認。
3. 同 key で 2 回目 dispatch → 新規 0・更新 0 (差分なし) を確認。
4. 翌 schedule (平日 08:30 UTC) の発火を監視。未発火が続けば workflow 側の
   追加調査 (repo 外の可能性)。

### P2. 週次信用残の再保管・修復

1. `--week=20260918` で 9/18 PDF を再保管 (bytes は §F4 の sha256 と照合) →
   物理添付の再 GET 読取で sha 照合。
2. `--week=20260828`・`--week=20260904` で R2 JSON を再生成・上書き
   (旧 JSON の sha16 を証跡に記録) + PDF 保管。
3. R2 `weeks.json` の不変 (13 週のまま) と 9/11 の無変更を確認。
4. 7/3・7/10 と 6/12–8/21 の 9 週は欠落のまま残す (原本なし)。
   `missingWeeks` がそれらだけを示すことを出力で確認。
5. 土曜 job (最新週) の成功 + 保管再読までを後続 criteria とする。
   (次回 10/3 は新様式の影響範囲のため root 判断。)

### P3. ①マスタ重複の適用 (新契約)

1. plan CLI を fresh 実行し guard 0 件を確認 (TARGETS・EDINET・JPX・D1)。
2. `--apply` 実行: snapshot→移行→補足→lifecycle→D1→直接 archive。
3. 再読: 2 code とも有効各 1・relation 全保持 (3681: 開示 12・財務 8、
   7129: 開示 10・財務 8)・補足 7129 の relation 修復・次 biztag run の
   重複 0。2 回目 apply で実変更 0。
4. 新 DB は作らない (一次データ保管は snapshot のみ。ごみ DB なし)。

### P4. IMF 公式 primary への移行 (別 scope・本 PR は契約確定まで)

- 公式口は登録不要で到達可能 (§F10)。移行時は新規 SDMX-JSON parser を
  別 scope で実装する (鏡 parser の流用・auth 失敗時の鏡 fallback は禁止)。
  正式契約 (agency/dataflow/version・DSD・key 順・codelist・代表 series・
  最新期・単位・pagination 注意) は §F10 を正本とする。
- 移行までの現行 (鏡を鏡と明示) は正しいため無変更。本 PR の code 変更なし。

## 5. writer 所有の報告 (訂正あり。code + metadata 調査 + root 連絡)

- 訂正: 財務 34k・市場 8 対象の本番修復は完了済み。writer の明示返却は
  9/28 13:19 UTC に受領済み (root 連絡)。初版の「未着手・未返却」は古い。
  これらを再実行しないこと。
- 通常運用の writer (tdnet_hourly・edinet_daily・supply_daily・
  master_sync 月次) は正常稼働中 (9/28 も success)。本番 Notion/D1 への
  書込は生きている。
- 待ち列 (Lane C 把握分): P1 (moneyflow 初回)・P2 (信用残再保管・修復)・
  P3 (マスタ適用)。直列 1 枠ずつ root が token 配布。Lane C への本番
  grant は未受領のため、本 stage は引続き書込 0 (code・隔離・plan のみ)。
- 既存 writer session の停止・編集なし。

## 6. root への決定事項

1. moneyflow schedule 未発火 (9/28 08:30 UTC が 13:51 UTC 時点で runs 0)
   の扱い: P1 の手動 dispatch で進め、翌発火を監視する (提案)。
2. IMF 公式移行の scope 化 (§F10。契約は確定済み。実装は別 scope)。
3. 退避の直接 archive 契約 (§F9) の承認 (本 PR の review で)。
4. 日次信用残 job の初回設計に backfill 要求を含めること (§F5)。
5. P1–P3 の writer token 配布順 (提案: P3→P2→P1 の順で依存が少ないものから)。

## 7. 証拠インベントリ (全て /tmp・0600・未 archive)

- `/tmp/laneC-snap-20260928.json`: Notion/D1/R2/PDF の読取 snapshot
  (moneyflow 4 DB・master 4 page の全 properties+body inventory+files 一覧・
  incoming 行 inventory (件数+created 時刻)・supplement・vwap 保管 key・
  dedup-102 不在・R2 5 週・PDF918)。開示/財務の行本文・物理添付の完全
  保全ではない (それらは各行の ⑤ 原本 record が持つ)。
- `/tmp/laneC-01-syumatsu2026082800.pdf` (856,411 B)・
  `/tmp/laneC-01-syumatsu2026090400.pdf` (867,440 B)・
  `/tmp/laneC-01-syumatsu2026091800.pdf` (873,311 B): 新 index からの原本。
  9/18 は既存 cache とバイト同一。
- `/tmp/laneC-jpx-01.html` (29,987 B・sha256 §F2): 新 index。
- `/tmp/laneC-r2-margin-2026-09-04.json`・`-09-11.json`: R2 読取 (dup 解析)。
- `/tmp/laneC-imf-*`: IMF 各口の probe 応答 (NXDOMAIN・sdmxcentral 101 件・
  404/403・mirror meta・公式 dataflow 191 件・PIP flow+DSD・JP 2025-S1・
  JP 全期間・R client 抜粋)。
- `/tmp/laneC-wb-05-20260310.html`: Wayback の 05.html (stable dir の証拠)。
  未掲載 11 週の live HEAD は全て 404 (本文取得なし)。
- 既存 cache の再利用: `/tmp/syumatsu.pdf` (9/18・バイト同一確認)、
  `/tmp/audit-b/jpx-margin-page.html` (05.html 移転の証拠)、
  `/tmp/mf-audit-*` (監査の照会方式)。
- 未 archive 状態: 上記 `/tmp/laneC-*` はいずれも一次データ保管へ未記録。
  実体保管は writer 枠で共有 library 経由 (P2)。
