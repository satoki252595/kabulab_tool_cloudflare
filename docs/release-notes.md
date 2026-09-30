# リリースノート

kabulab-cf の変更履歴。**新しい順**。PR をマージしたら、その PR で何が変わったか（利用者・運用から見た変化）をここに追記する。
2026-09-23 以前の変更は `git log` を参照。

表記: 各項目末尾の `#番号` は GitHub の PR 番号。「本番作業」はコードの変更ではなく、本番の D1 / Notion / 設定に対して行った作業。

---

## 2026-09-30

### 変更
- price40 missing-only 9/29 CAS の fixed-packet executor を追加 (未実行。WRITE 0)。既存 runGapRepair の依存 8 件だけを retained55/R1-exact/frozen-body exact-send に差し替え。touched-40 full11 の scoped EXCEPT parent guard を共有 overlay 機構から抽出 (既存挙動不変)。outcome は eligible-held 0 + 期待 outside-7 診断のみ APPLIED。pure 4-case proof PROOF-OK (network/Notion 0)。文計 19 (SELECT 3 + batch 16)。証跡 `docs/test-logs/price40-cas-executable-prep-20260930.md`。live WRITE なし、データ変更なし。
- 優待 company 判定に表見出し context を persist (内部 headed 保存形式。合同割引・抽選 scope・型付き券 unit×数量の narrow 規則。見出しのみ金額は額面にしない。本文 negative は authoritative)。要約契約 2026-09-30.1 (内部 marker の echo を `internal` 違反で reject)。次回 full-import から保存文が headed 形に変わる (公開面は shortSummary のみで不変)。データ変更なし (Refs #146)。
- 海外 source-custody query runner を追加 (既存 checkDocsCustody 再使用・query-only。round1 20 docs/40 keys は ONE 実行済み PASS (t1/t5 missing 40/40・attempts 2・READY 0)。rest 3655 docs/7310 keys (183 chunks) は ONE 実行済み PASS (t1 missing 3591・complete 64・t5 missing 3650・complete 5・attempts 184・query 成功 183/183・READY 0・両 grant 消費・追加照会なし)。read-only route guard (CREATE/PATCH/DELETE 拒否・body/query exact 束縛・redirect manual/3xx STOP) + closed caps (96/1351) + 同一 response clone 保存 + full SHA pins)。証跡 `docs/test-logs/overseas-custody-query-2026-09-30.md`。source/Notion-mutation/D1/R2/dispatch 0、データ変更なし。
- 海外 L2 `source_max_date` の MAX を `stockIds` 指定時は対象集合に拘束 (未指定時は global MAX 不変・空は throw 維持。caller は global 呼び不変)。scope 別契約の focused tests (23 + 5 passed)。データ変更なし。
- jss-api 日足の調整意味論を訂正 (価格は生値・adj_* は配当込 total-return、係数不明は null・偽 1 なし、出来高未補正、cache v2)。データ変更なし。
- VWAP daily adj 修復の rebuild 土台 (fetchDaily 原文 capture hook 追加・repair-daily whole-post 再構築 + tests)。取得実績: 7944 は fresh 応答自体の非正 adj で HOLD (既知)、8303/8919 は未送信 STOP。Adj 定義は Yahoo 公式 [adjusted close は分割+配当](https://in.help.yahoo.com/kb/adjusted-close-sln28256.html)・[AAPL history の Close=分割調整・Adj Close=分割+配当/キャピタルゲイン](https://finance.yahoo.com/quote/AAPL/history/) に基づく。データ変更なし (Refs #117)。
- VWAP batch summary の原本 bytes を archive 前に runner local (0700/wx0600/fsync) へ保持し、失敗時は artifact で回収。local 書込失敗は archive 前 fatal exit 2 (daily 2 で intra 0)。データ変更なし (Refs #117)。
- VWAP batch summary の metadata を counts+pin+集約のみに縮小し per-code outcomes は物理 JSON 本文に保持 (旧 full 内包は約 530KB・266 分割で Notion 上限超過 → run 36698387232 の daily archive が 413 UNKNOWN・intra 0。証跡 `docs/vwap-run36698387232-413-unknown-20260930.md`)。データ変更なし (Refs #117)。
- 共有 Yahoo parse 境界で request/response の meta.symbol 一致を検証 (不一致・欠落は throw、alias 推測なし。既存 normalize のみ)。データ変更なし。
- VWAP 取込 producer の root 修正 (R2 送信 1 試行・PUT 応答契約・rejected/unknown 分別・GET 厳格 bootstrap、Yahoo 真正 empty は timestamp 空配列のみ・全行欠落と malformed は throw、保存形状 strict、R2 fault で新規停止・保管失敗は exit 2、knob 型付き取得)。データ変更なし (Refs #117)。
- 海外 baseline custody / current PREP を追加 (baseline ZIP 160 members 固定 + immutable key の ONE archive 実行済み PASS (Notion 16 + hosted 3・160 closure)、CURRENT 3675 exact join を local 実行 (3602 pin + 73 HOLD・stocks 563・Q2 21245、CAS keys + L2 集計 + 73 provenance 確定)、frozen parser × NEW live の current compare を actuals で local 実行 (journal 3654 verbatim + fresh parse 21・LIMIT 0。MATCH 494・CHANGED 3181 (FACTS 929 + BOTH 2252)・adopted 1411/candidate 2191/HOLD 73・L2 affected 520 stocks→6 groups・bounded 20docs/40keys 提案。facts→DB 変換は共有正準 helper に集約・5 callers 同一関数)。baseline ZIP は OBSERVATION (rawZIP primary proof ではない)。旧 1781/1894・旧 counts は historical)。証跡 `docs/test-logs/overseas-baseline-custody-2026-09-30.md`・`docs/test-logs/overseas-current3675-join-2026-09-30.md`・`docs/test-logs/overseas-current3675-compare-2026-09-30.md`。source/D1追加/R2/dispatch 0、データ変更なし。
- 海外 fresh full READ を capture runner で実行 (Q1F 17射影 + Q2F 13射影 × 37 chunks = 74 SELECT。3675全通観測・21245 facts・missing 0。grant-first・preflight・fsync-first log・whole body wx0600・safe receipt・retry 0)。旧 1781/1894 は historical のみ、現行基準は frozen 3675 + NEW full16/Q2 all13。証跡 `docs/test-logs/overseas-fresh-read-proposal-2026-09-30.md`。D1 READ 74 のみ、source/Notion/D1書込/R2/dispatch 0、データ変更なし。
- Python D1 trust root を最小厳格化 (query 応答の dict・literal True・result exact1・entry・results・行 dict 必須、bind は有限スカラーのみ max100、upsert は全行検査を初 chunk 前に、file_size 兄弟も同格)。sector job は current active の空・重複・非正準 code (phantom 含む)・sector33 非 str/非 None・不完全行を prewrite STOP (正準形一致・正準 ID 重複・構造型、未知 sector は retain/gap 維持)。証跡 `docs/test-logs/py-d1-trust-root-20260930.md`。データ変更なし (Refs #196)。
- sector33-only cadence を追加 (stock daily 成功＋trade_date 非空の直後・moneyflow 前の step)。EDINET 取得→厳密 parse→共有候補検査 (ticker/issuer 一意＋literal 有効 EDINET 必須)→TS CLI 保管検証→active-equity 差分のみ D1 書込。重複は last-wins 廃止で STOP、未知 sector は retain (NULL 消去なし)、builder は None/33 業種外を拒否。不足残存は partial (exit 1) で moneyflow 停止。証跡 `docs/test-logs/sector33-cadence-proof-20260930.md`。データ変更なし (Refs #196)。
- 母集団 universe overlay を原子 batch 化する PREP (Refs #196): full core 11 列全行 + state/events 全集合の CAS guard を先頭に [guard, 書込 30 文] を sender へ 1 回送信 (retry 0)。base/reuse/skip/plan/guard は同一確定 snapshot が駆動し、内部読替え・逐次適用・fallback 経路を除去。未確定 IPO は送信前に HOLD (書込 0)。共有 D1 送信口 (batch + single-query) を strict 化 (top.success===true・entry 全 success・有限 bind 事前検証、outcome-unknown は再送なし)。実 q7 3810x11 + fresh9 での offline proof は private のみ (9/14/5・events 226・31 文・maxBind 99・再入 0・9/29 全 9 HOLD)。本番適用なし、データ変更なし (Refs #196)。
- 海外 actual-repair の純 offline PREP を追加 (最終 parser で 3675 通を再生成し docID union の tags + full facts + preimage + protected 差 + reason journal を確定。1411/1487/36 と旧 live 1695 は母集合分離、observed1781/historical1894 を namespace 分離 (DB 比較は observed のみ、outside は LIVE_UNOBSERVED・DB 推論なし)、73 pin不足は過去 UNKNOWN+HOLD、receipt なし→全 ARCHIVE_PENDING、apply-qualified 0)。証跡 `docs/test-logs/overseas-repair-prep-2026-09-30.md`。データ変更なし。
- EDINET コードリストの信頼境界を厳格化 (zip 内は期待名 CSV 単独・ヘッダ名一意・非空白行の列幅不一致は STOP)。9 月 IPO 9 件の一次取得 PREP (asOf 2026-09-30、6 件適格・3 件 identity 未確定 HOLD (ticker literal 不在)、保管 readback 2/2)。証跡 `docs/test-logs/edinet-codelist-9ipo-proof-20260930.md`。データ変更なし (Refs #196)。
- 優待 full-import の write/end・write-error/end に post-image 利回り・スコア追随を追加 (既存 builders のみ。新規 financial SQL/計算なし): scope は優待保持∪今回取得∪利回り残存で廃止・中断の stale を修復。個別失敗が残れば再計算適用後に明示の部分失敗を投げて成功完了にせず、銘柄は全行成功でのみ imported に数える。書き込み前 STOP では走らせない。書くのは yield+fetched_at/score3 のみ (price/data_date 不変)。データ変更なし (Refs #146 #102)。
- 優待 company 値の共有厳密判定を追加: 要約取込と full-import carry が同じ純関数で額面 scope・同一 clause の積・tier/月混在・複数額面を検証する。不認定の取扱いは経路で異なる — 要約取込は結果全体を reject して現行行を温存する (既存の financial data を修復しない)、carry のみ値と出典を null で戻す (要約は保持、provenance 付け替え温存なし)。未対応出典・解釈食い違いは削除前に STOP。生産ガードの 50 行再判定は QUALIFIED 8/HOLD 42 (人手監査 rev2 の 16/34 とは tier/cross-clause/≒ の機械判定差。7075 の raw 対 DB 陳腐値は別 gate)。データ変更なし (Refs #146 #102)。
- 海外売上 producer の表ローカル連結区分 Gate0 を確定 (PR208 CLEAR。数値根因と一体): caption の range 表題・exact 既知 TextBlock で連結区分を確定 (grid 文面のみで scope を落としていた 6 文書 36 行を連結に是正)。個別 FY 表題×positive 共存は doc-STOP、不足は null。59 sealed 最終 MATCH 15 / flips 32 / scope-only 12 (numeric 1487 HOLD は次項)。歴史 data-write 0。repair apply は別途 PENDING。データ変更なし。
- 海外売上 producer の数値根因を修正 (PR208): 修飾なしその他・事業・期表示・会社共通・既知 leaf 欠損の地理未分類は候補ごと HOLD (不採用+不加算。推定なし)。selected sales axis 内の unknown-role leaf も共通 guard で HOLD (空 header は (col N)/(row N) の labeled HOLD。免除は実証済 metric の exact 一致のみ)。proof に未分類額の必須 field を追加し保存前検証が算術の前に STOP (旧 proof は default 0 なし)。明示消去・別収益・丸めは維持。3602 文書中 1487 件が labeled HOLD (empty 0)、最終 ok 1411 件は全件検証通過。将来 producer では reducer HOLD は geo_present_unstructured+空・検証例外は parse_error+空で保存されうる (部分数値は persist しない。旧 facts 温存ではない)。証跡 `docs/test-logs/overseas-numeric-root-2026-09-30.md`。データ変更なし。
- 海外売上 producer の caller archive を raw-before-DB 化 (PR208): ingest / backfill-missing-docs は物理 ZIP の Notion 記録を DB batch より先に 1 回行い、custody 完備でも DB 書込ありは同一 bytes/SHA 確認を通す (strict byte guard。重複 mutation なし)。共有 helper に readback 照合を内蔵 (mismatch は throw)。ingest の archive 既定 true・false 明示は STOP、`--no-archive` は write 未対応で STOP。metadata は DBid 非依存、text 本文のみ DBid 解決後に保管。backfill-overseas は順序不変。データ変更なし。
- マクロ行キーの日時正準化と原本保管: 行キーは GSPC 確定バー日、N225/VIX 確定日と VI 日付が一致し必須値が揃うときだけ保存 (不一致・不足は HOLD で前回値保持)。最終 draft と同一 generation の chart 原文 4 + VI HTML + manifest を `macro-source-batch-*` に保管し strict readback 通過後のみ D1 保存 (保管失敗は throw)。`previousClose` は source 明示値のみ (補完 chain 削除)。データ変更なし (Refs #163)。
- 株式 guard の全 stock パス共有: 時間窓・N225 対象日/fresh-close・銘柄別 targetDate・完了期限を default パスにも適用 (stocksOnly はマクロ有無のみ)。`expectedDate` 必須化と `dataDate` 代替の除去。データ変更なし (Refs #163)。
- 母集団 universe の月次 stale 窓を JPX 公式 3 頁 (上場廃止/新規上場/市場区分変更) の日次 overlay で補正する PREP (収集・厳密 parse・宣言被覆・世代管理・HOLD/不完全失敗・月次 deferral・daily/monthly 配線・0025 migration)。IPO 分類は normal current-observation qualification を接続 (実 3 段収集時刻+実 custody の当日一致のみ現周期を認定、9/9 fresh positive。historic は unknown HOLD)。additive 0025 DDL 適用済み、owner/core データ適用は 0。明示 bootstrap proof (8/31 base exact・direct apply offline・reentry 0) のみ (normal null-base 等価の主張なし。null-base normal 経路は bootstrap HOLD)。本番適用なし、データ変更なし (Refs #196)。
- 優待 144 銘柄の fresh 監査を frozen probe の 8 read-only SELECT で実測し FRESH_MATCH (content 差 0・drift 0・実送信 0、FT 62 全適用済み・normal 37/50 一致)。証跡 11 件は private + Notion 一次データ保管。doc `docs/test-logs/yutai-fresh-audit-proof-20260930.md`。データ変更なし (Refs #146 #102)。
- 優待 ABC 131/全文 13 の実再入 0 を保存済み証跡のみで offline 証明 (ABC 473 行全省略・全文 62 行全適用済み・効果文 0、送信口 throw-if-called)。共有 planner に preimage 3 値の同値省略と全文分類を追加。normal C45 は pending/stale を正直計数。証跡 `docs/test-logs/yutai-reentry-proof-20260930.md`。データ変更なし (Refs #146 #102)。
- Yahoo crumb 429 を typed deadline 付きで保持し、取込 proxy は 429 + 実残り秒 Retry-After で返す (従来の 502 丸めを是正)。期限内は同一 deadline で再 bootstrap せず、期限切れ後に single-flight で回復。Node recovery の待機 budget cap 30 秒・認証方式・再試行回数は不変。データ変更なし (Refs #163)。
- Notion read-list 全入口 (TS 共有 client + Python client) の応答メタ (`results`・`has_more`・`next_cursor` の型と組合せ) を厳密検証し、不正・反復カーソル (same・A→B→A) は追加取得前に停止 (再試行なし)。正常本文・保存形式・writer は不変、既存 caller の失敗通知へ伝播。データ変更なし (Fixes #199)。
- 海外残745 の純 offline PREP を実施 (固定 raw の再生成・changed set 新導出のみ。原本追加取得・本番書込 0。変更候補は検証待ち)。データ変更なし (#202)。
- PIP-384 実 entry 再入の直接証跡を公開 proof として追記 (実 upsert 384 全 unchanged・書込 0、応答 strict 検証 395/395・query 全件 + search 全 sequence terminal false。旧比較 proof とは別証跡)。データ変更なし (#201, Refs #132 #146)。
- C107 有報テキスト 10 文書・364 section を保存済み原文と read-only 精査し 10/10 MATCH (全文 SHA 一致・D1 索引重複 0、HTTP mutation 0)。証跡 `docs/test-logs/c107-yuho-text-audit-2026-09-29.md`。範囲外の主張なし。データ変更なし。
- moneyflow 指標定義の未確認断定を除去: 財務省系列の「速報値で確報改定を反映しない」を版 (最終更新日) +直近 CSV 窓 upsert の実契約どおりの説明へ修正 (速報/確報の区別は原本未確認のため断定しない)。JSDA hako.pdf の docs 状態を「2026-09-27 取得・確認済み」へ是正。データ変更なし。
- 需給 API 4経路 (REST latest/series・MCP latest/series) の `meta.attribution` をフィルタ適用後の返却データから算出 (JSF→日証金・JPX→JPX の厳密写像、空は `[]`、`personal-only` 維持)。MCP enum に `jpx_margin` を追加し説明で JSF貸借とJPX信用を区別。不正フィルタは 400/isError、未知返却データ・point 形状不正は 500/isError。データ変更なし (#193)。
- Issue #163 の 9/29 欠損 47 replay 修復 PREP を追加（保管原文 replay・eligible 集合で保存対象を確定、行不存在 INSERT + CAS batch・receipt、最大 40 適用見込み）。日次増分判定の過去行不存在回収（保持 90 本窓）も修正。live 未実行、データ変更なし (#197)。
- Issue #163 の 9/29 OHLCV 欠損 54 銘柄の固定診断 PREP を追加（Chart 5y/1d のみ 54 GET、7 分類全件判定、診断バッチ 1 行 custody + readback 照合、D1 SELECT のみ、`--execute` live gate）。live 未実行、データ変更なし (#192)。
- 残存する個人利用用途文言を整理 (MCP 5 ツール説明中の用途断定を削除、moneyflow 世界指数の用途文言から Notion 個人ダッシュボード断定を削除。応答のライセンス meta・配備範囲は不変)。データ変更なし (#190)。
- 未保管 moneyflow 経路の書込前に保管添付の完全一致（件数・名前・バイト長・SHA256）を検証し、file_too_large・不一致は観測ログを書かず停止。新規・更新ありの書込バッチは指標×期間の分割読取で全行を read-only 再検証（ページ ID + 全項目照合、重複・欠落・不一致・不正カーソルは保全停止）。データ変更なし (#188)。
- Worker の Observability を最小設定で有効化 (呼出ログ + 既存 console ログを残す。EDINET 外向き URL の Subscription-Key のため traces は無効のまま)。EDINET 日次取込に秘密なしの進捗 checkpoint を追加し次回標準実行の段階特定を可能に (#187)。
- 優待 producer の表ローカル月 root 修正 + 推定値 trust 境界 (residual33/68): 個別ページ抽出が h3 表ごとの権利確定月・見出しを優待に付け、ページ union の blanket 展開を廃止 (8022 の 9 月幽霊行 37956 等を合成しない)。月不明表・取得失敗は import/収集の前に STOP (未確定を廃止削除しない)。判定は表見出しも走査 (額面根拠にはしない)。利回り・スコア・公開面は backend 合成 (company + 共有厳密判定の通過分) / 公開最小境界 (company のみ) を通り、不認定・由来なしは null の正直表示 (0 フォールバックなし)。月/ジャンル集計を月次と repair-CAS の共有関数に抽出。67株 + 1808 の現行 read-only 計測は private 証跡のみ。データ変更なし (Refs #146)。
- ops runners (2READ/archive/source55) の code + 実行記録を publish (各 live 1 回の actual closure 済み。2READ は事後 audit 受領・sequencing limitation 付き)。共有 D1 batch sender 注釈を known/unknown throw+stop/再送なし/readonly 照合へ是正 (挙動不変)。新規 WRITE なし、データ変更なし。

### 本番作業
- 本番作業: 母集団 universe 9/30 overlay を D1 へ 1 回適用 (owner 31 文全 success、core 3810→3819・activeEquity 3695・events 226、適用後 3-SELECT 再読で exact 一致・再入 collect 0/send 0 を検証)。actual 証跡 19 点を Notion 一次データへ RECORDED (key `actual-proof-2026-09-30-3eaff8c3...`、manifestMatch written、readback 通過)。証跡 pins は `docs/universe-overlay-actual-proof-20260930.md` (Refs #196)。
- 優待 source52 修復を適用 (16 batch・74 statements・52行、適用後 post4 全列一致・outside54 保護一致・NEWPOST 再入 0 を実証)。exec/post 証跡 56点 1-ZIP を Notion 一次データへ full SHA readback 保管 (Refs #146)。
- 優待 ABC 修復 131 銘柄を適用 (requests 131・statements 508・完了 131、適用前 refetch 全一致、inactive 11 除外)。再入 (2nd run 差分 0) は未観測のため主張なし。
- 優待全文修復 13 銘柄を適用 (requests 13・statements 75・desc 62、適用前 refetch 全一致。eligible 85 のうち historical 39・whole-stock STOP 23 は除外)。再入は未観測のため主張なし。
- Issue #163 の 9/29 欠損 54 固定診断を live 1 回実行し complete（実バー有り 47・終値なし 2・stale 1・priceguard 4、原文 54 + manifest 1 の 55 添付を 1 行 custody・全件 readback 一致）。旧 run 失敗理由は未確定のまま。D1 修復なし。
- 業種別信用残を352行新規保存し、既存分を含む安全対象461行の全19項目一致を再読確認。safe461同一入力再実行は全461 unchanged・作成/更新送信0 (証跡 Issue #132)。#110はPOST結果不明のため保留し、462行すべて完了とは扱わない。

---

## 2026-09-29

### 変更
- **007 信用残日次化**: JPX 銘柄別信用取引残高の日次様式へ直接切替 (旧週次互換なし)。R2 `margin/daily/{基準日}.json` + `margin/dates.json` (`--date=YYYYMMDD` ingest、`?code=&n=` API は日次 schema)。週次オブジェクト/コードは残すが通常経路は読まない。業種別集計 (33 業種×14 指標の日次 moneyflow spec `jpx-margin-sector`、JPX 再取得なし) も同 scope で実装 (#182)。
- **005 shared catalog**: 投資家別売買 inner weekly を 4 キー (証券自己・法人→事業/その他法人・信託銀行) へ細分化し共有キー契約へ (#182)。
- 共有 upsert の POST/PATCH 応答検証ガードを追加 (id・明示 active・key・書込値の ack 検証、不正は unknown 保全停止・再送なし。全 caller 共有) (#183)。データ変更なし。
- 一次データ記録に入力 bytes freeze + SHA manifest を追加 (producer 側 before-bytes 証跡。物理 fullDL 証明とは別。同一 skip/変更 STOP/旧行 unknown) (#184)。データ変更なし。
- shared POST の Unknown 例外へ key context を付与 (観測 key・primary key SHA、生 key 非開示、再送なし・Unknown 型維持) (#185)。データ変更なし。
- moneyflowのJPX投資部門別売買状況 (株式・週次) を2026-09-29掲載分の新様式 (単一xlsx) に対応。新様式はnet/grossに加え公式売付/買付セルを直接記録し、名前付き6内訳 (市場/投資部門/取引種別/親区分/階層/公表日) で冪等キー7セグメントに。旧様式系列は従来キーのまま (移行・再取込なし)。実ファイル (9月第3週) で検証 (xlsx 112件算術一致・同期間PDF親合計96/96一致)。月次新様式 (10/08〜)・ETF/REIT (10/13〜) は未公表のためreject維持 (#181)。実データ適用は後続。
- 株式日次syncの完了・例外どちらの終了時も失敗明細バッチ (全件・切詰なし+件数/取引日/分類/元例外) を一次保管してから return/throw するよう修正 (CLI の 1% throw の前に物理保管あり)。保管失敗は非0終了。CLI の 20 グループ表示は要約として残し保管キーを指す (#180)。データ変更なし。
- 財務③の同値再 PATCH を省くよう共有 upsert へ同値判定を追加 (EDINET/TDnet 両 caller が継承。取得日時だけの差は送らない。旧キー採用・訂正新旧ガード・NULL 置換は維持。create 競合の収束時も同値なら書き直さない。再解析の直接 PATCH も同判定で already_reparsed)。保証は Notion ③ の PATCH 0 であり日次再 dispatch 全体の sender 0 ではない (ローカル系統・D1 書込は継続) (#179)。データ変更なし。
- Node 実行の有報取込と 3 backfill (海外・定性・取込漏れ) で文書メタ・status だけ残り facts が 0 件になる部分保存が起きないよう、既存の D1 HTTP sender を明示指定し、1 文書ぶんの upsert・facts 置換を単一 batch で一括保存 (sender 未指定・未知 backend は書込前に停止)。日次 Worker の取込も同一組成の単一 batch。定性 backfill は本文保管未完了の通も force 無しで回収対象に (#176)。データ変更なし。
- 株式sync成功後のmoneyflow連鎖を取得元selectorで限定 (dispatch=stocksはsector-turnoverのみ、daily/all・既存scheduledは明示の空=全取得元維持、context/monthlyは連鎖なし)。未知event/target/scheduleはproducer起動前に非0停止 (fallback禁止) (#177)。データ変更なし。
- 本番作業: 単一378A書類の有報テキスト35 section を Notion へ記録し文書 pointer を設定 (他列・3 facts 集合不変、適用後読戻35/35一致、完了再入 sender0 を実証)。単一 lease の1回適用のみ。fulltuple範囲外の主張なし。
- pipeline 共有 runner の終了コードを厳格化 (9 caller 共通: 成功だけ exit 0、一部失敗・実CF書込失敗・実行履歴の記録失敗は exit 1)。未設定/None・dry-run・合法 skip は 0 のまま。EDINET 財務 tidy の本物の変換失敗を欠損計上し、kabuMCP type1 は連携対象外の合法 skip として情報記録のみに。データ変更なし。
- VWAP取込の日足失敗 (exit1) で5分足を道連れ停止しないよう日足/5分足の実行を独立化 (両statusを出力・どちらか非0はexit1)。ABORT (exit2・連続429/503) だけは5分足を走らせず即exit2の契約を維持 (#175)。データ変更なし。
- 原本⑤のNotion保管を本番共通strict化 (全caller: 未保管で取得単位を中止。dry-runのみ旧来継続)。財務系④ポインタは実解析原本のみに限定し、手動 --date の子bash転送欠陥 (edinet/tdnet) を位置引数化で修正 (#174)。実データ適用なし。
- 本番作業: EDINET一次データ修復59書類 (51訂正/7正規nonsales/1非構造) とL2投影16銘柄 (15再生成/1正規absent) を適用。適用前後fresh全一致・再計算write0を確認 (#174)。fulltuple範囲外の主張なし。
- 有報テキスト本文のNotion保管失敗・行ID未書戻しをwarn成功にせず未完了として扱うよう3経路(日次Worker/2 backfill)で統一し、本文保管失敗は全実行で非0終了に。既存文書スキップは本文ポインタ+type保管の完成判定に限定し、日次Workerは共有ingest経由で回収。type保管完成は実Files物理添付で判定しmetadata-only行は明示修復STOP、XBRL公式未提供は対象外。日次/backfillの保管完成照会は日ごとの一括取得に集約。実ファイル上限超過のmetadataのみ記録成功扱いを全経路で拒否。課金切れ(402)で判定不能のまま残る銘柄をサマリ+通知へ集計しremaining:0のgreenに埋もれない形に修正。保管行照会は41件上限・cursor追跡なし・実ホスト添付のみ計数にし、既存行スキップ時は実体を再検証してmetadata-only/重複行を保全停止、T1公式未提供は同通T5行flag由来で判定。データ変更なし。
- VWAP取込の母集団を静的銘柄リスト依存からD1正規のactive普通株集合へ切替え (`--codes` 明示指定も正規集合の所属が必須・対象外はSTOP)、同一内容の二重PUTを内容比較で抑止してactiveな正規母集団の履歴を壊さない形に修正 (#172)。データ変更なし。
- L2投影 `p_yuho_growth` の再生成に `stockIds` 部分再生成を追加 (両入力クエリ・全write・sweepを同一集合に拘束。空集合は全体の意味にせずthrow)。通常の全体再生成の動作は不変 (#171)。実データ適用なし。
- VWAP取込の5分足にも日足と同じ応答価格整合ガードを接続し、日足/5分足とも保存前に異常バーを書かず数えるSTOPとrun粒度バッチ保管(通常runに必須接続・保管失敗はjob失敗)を追加 (#169)。データ変更なし。
- 一次データ添付の署名URL更新による重複修復の誤停止を解消し、署名以外の属性・実ファイル照合は維持 (#170)。
- EDINET一次データ記録をtype別key (`{docID}:type1/5`) +実ZIP添付の共通契約へ統一し、Type5済みによるType1保存抑止を解消。海外backfillにもType1記録を追加 (#168)。旧docID記録は不変。実データ適用は後続。
- 年次preflightと優待の共通保存経路に親銘柄active/区分・同一性CASを追加し凍結破りを境界で止め、適用runnerの完了キーは種別つき必須+重複検査にした (#166)。データ変更なし。
- 本番作業: 市場Source D1修復を適用 (ATR 1679行・年次 1490行のactive行のみ。非active 36行は凍結維持のため適用後に復元)。送信前fresh全一致・適用後全new一致・再計算write0・保護一致を確認 (#166)。
- 市場Source修復の共通input CAS preflight (ATR全入力6+銘柄同一性/年次系列全点+TTM+日付のNULL-safe同一batch検証) と優待全文境界のdescription CAS (行ごと旧文CAS) ビルダーを追加 (#165)。データ適用はまだ。
- 本番作業: Yahoo実測9件 (N225は9/28終値未取得で厳密STOP確定・fake8は404不在で除去VOID) とD1変更前スナップショット2件をNotion一次データへ物理記録 (再DL全SHA一致・unknown0)。境界テスト31件+全文2件PASS。
- 優待掲載文を切り詰めず全文保存し、同一銘柄の保存前 preimage が変化していたら batch 全体を STOP するガードを追加 (#161)。保存済みデータの修復自体は未適用。
- ①マスタ重複の snapshot を完全 proof 化 (本文全 capture+添付 inventory+別キー v2 保管。全 apply 入口に共通 gate)。moneyflow を stock-sync 成功後の連鎖実行に変更し独立 cron を廃止、sector-turnover は実 tradingDate 固定+厳密 coverage gate (#160)。実データ適用は後続。
- ①マスタ重複の保持先ガードを件数固定から証明済み ID 集合へ変更 (7129 keep 開示 10→11 valid-addition 対応。baseline は実 receipt+v1 を実行時読取、take 固定+直後再読、追加は issuer/原本/keep-only 実証のみ許可)。`--take-only` (snapshot 取得まで・schema は v2-manifest 証拠を SHA 検証再利用) を追加。
- ①マスタ重複の D1 前 gate に keeper/retire の union 一致 (全 pagination・意図移行状態) を追加し全経路へ接続。resume の同数 ID 置換を見逃さないよう集合比較へ是正。実データ適用は後続 (Refs #102)。
- ①マスタ重複の props 比較を Files 署名 URL rotation に対応 (hosted は name/type/resource で同一判定、external は全体比較、未知形状は fail closed。bytes は既存 proof 連鎖)。実データ適用は後続 (Refs #102)。

## 2026-09-28

### 追加
- 海外売上の地域表パーサを共通検証化 (#155): 印刷年度・当該表の売上根拠 (TextBlock/小見出し)・集計範囲・実cell精度で前期/受注/資産の誤採用・丸め・重複計上を防止し、同 proof を3保存経路へ必須接続。実原本 fixture・123回帰テスト。保存済みデータの修復は後続。本番書込なし (writer grant 待ち)。
- EDINET 取得に共通期限を付与し catchup 停滞を可視失敗化、旧財務 backfill CLI を撤去 (#155): 一覧 15s・書類 60s (応答 body 含む) で打ち切り、未完了分は次回 60 日窓が回収。reparse 用の共有コンバータは保持。
- 財務行へ原本のNotion⑤ページIDをnullableメタデータとして渡す。通常保存と監査済み正本の同期で同じ原本関係だけを保持し、未知はNULL、既存33列は不変。原本ZIPとPDFの検証範囲、閲覧権限を分けて扱う。
- 財務の正本修復→D1同期でも元原本と再読証跡のキー一致・新鮮な正本キー一意性を要求する。既知原本SHAが異なる旧書類IDを新しい値へ引き継がず、未知の重複・証跡混入を反映前に拒否する。
- ①銘柄マスタ重複3681/7129の単発解消plan/applyを追加 (#137)。既定は読取のみのplan、適用はwriter解放後の明示指定に限定。JPX上場廃止確定で3681はlisted=false維持・状態のみ移行、7129補足の空relation修復、snapshot先行・receipt再開・再実行無変更の回帰付き。7件の実flow補正 (保管実DL検証・中間ガード分離・receipt回収+全pagination・退避full検索・検証省略禁止・schema列挙・create marker+POST再送禁止) を同PRで追加。実データ適用は後続・実apply保留 (Refs #102 #132)。
- 財務の誤キー合流で古い原本ページが最新版の保存先となった場合も、同じページ・キー・監査済み原本全項目・より新しい開示日を新鮮に再証明して再開可能にした。未知の変更を拒否する条件は維持する。
- 財務の一度きりの正本修復に、共有レート制御のまま独立50コードbatchを最大4本で処理する明示オプションを追加。既定の直列2.5rps、原本照合・再読・再開条件を維持し、429/529は全処理で待機する。
- 通常の財務D1/local保存もNotion③と同じNULL込みの完全置換へ変更。後続の疎な原本で消えた項目を古い値で補わず、古い開示の巻戻し・連結区分・厳しいライセンス・冪等性は維持する。
- 中間決算のBPS・自己資本比率を当中間期末の原本contextから選び、同じCSVの年度末値との競合で欠損になる経路を修正。7384の実原本と同一時点多値の回帰を追加。
- Notion ③の既存財務サマリを D1 `jss_financials` へ補完する一度きりのスクリプトを追加。既定は読み取り検証、明示的な `--apply` だけが未登録キーを挿入する。移送だけを品質合格とせず、原本再解析・正本再読を通した修復を使用する。
- 財務の期末を実績損益のコンテキストから決め、連結区分に配当メタ情報を使わず、EDINET中間実績を読み取るよう修正。全原本のSHA照合・再解析と確認後のNotion再読更新を再開可能にした。本番D1同期は全件差分・staging検証後に実施する。
- IFRS/米国基準の経営指標要素を認識し、連結実績に単体数値や未来年度の配当実績が混ざる経路を修正。売上収益と広い収益の定義を区別し、旧parser版で作った監査結果の反映を拒否する。
- TDnetの米国基準の売上・利益・EPSと、EDINET原本に直接あるROEを取得。ROEは原本の連結区分を保った比率の単位変換に限定し、推計で補わない。
- 財務修復は対象コード群の正本まとめ読取と更新後の再読記録を使い、監査結果と一致した行だけD1へ同期可能にした。旧誤キーを原本・開示日時で限定して除き、新しい開示を保護する。
- 財務キー修正で後日の開示に合流する場合は、最新原本を先に修復。旧ページを退避した証跡と新しい原本の再読結果を保ち、古い開示を再実行で戻さない。
- Notion再読の整数・小数の表現差で同じ財務値を修復不一致にしない。財務キーと全項目の値を比較し、監査済み原本との一致は維持する。
- 日本株の全銘柄同期を翌02:13 JSTへ移し、米国市場のマクロだけを従来の翌06:00 JSTに分離。全銘柄の二重同期をせず、休場/実日足欠損や基準時刻超過を隠さない。
- 財務の会社全体・円建て・比率・年間配当を原本のcontext/unitで検証し、セグメント、外貨、半期配当を混ぜない。iXBRL共有resourcesとSHA照合cacheで全原本を再監査し、更新後の新鮮なまとめ再読で数値・旧ページ・キー一意性を確認してから確定する。
- moneyflowのJPX先物・オプション投資部門別とIMF CPISをdry-runで初回実データ確認。IMFのDBnomics欠損マーカー"NA"は欠損として読み飛ばすよう修正し、387行で成功。一次実体のNotion保存は後続のwriter枠で実施する。
- 001 RSI の年度売上（銘柄詳細の表示と優良株選定の入力）を正本 `jss_financials` の本決算実績から読むよう変更し、連結/単体の区分と実績期末を表示する。旧 Yahoo 派生表は 001 では読まない。本番切替とランキング再計算は #124 の全件反映後に行う。

### 変更
- 優待推定値ガードの根因修正: 全角数字の誤読 (`４`→52)・抽選賞品の
  総額拾い・未換算外貨・数量の人数乗算・根拠なし要約 `%` を共有境界で一括修正。
  要約取込は利回り・スコア再計算を同実行化し中断再開対応。要約表示の `推定 0円`
  を不明表示へ。実データ適用は後続 (計画: `services/otakara-yutai/docs/repair-plan-2026-09-28.md`)。
- 優待要約取込の通常 `--apply` を銘柄単位の原子 batch へ接続 (#157):
  同一銘柄の要約・推定値・利回り・スコアを D1 REST `{batch}` 1 リクエストで送り、
  要約だけ書いて中断する形を無くした。同値の再送は省略する。Stage C (45 群の実 apply) は別本番 Task として未実施。
- Yahoo財務の株数尺度不整合ではEPS/PER/時価総額のみ未取得にし、正常な他項目を保持する。市場監査F-01/F-15の限定修復planを追加し、既定は読取のみ、原本物理退避・SHA再読・全列CAS/R2条件付き書込を要求する (#152)。実完了後は一回用の修復スクリプトと専用テストを削除し、通常guardと実施記録を保持する。
- **Yahoo 破損応答の取込拒否 (F-01 再発防止)** (#149): 同一応答の最新終値と meta 価格の 10 倍超乖離 + 出来高なしで `fetchChart`/`fetchDaily` が応答全体を拒否。無効な実数値 (非正・非有限の終値/meta) も欠落と別扱いで拒否。日次 gate は対象日の実終値も要求。薄商い・正規分割は受理。#149時点の保存値修復はpreviewのみ。限定8対象の実完了は下記の本番作業 (#152) に記録した。
- **週次信用残の Notion 一次保管の復旧** (#134, #117): JPX 週次 PDF の解析が原本バイト列を破壊して「空ファイルはアップロードできません」で落ちていたのを修正。解析後も原本が不変なことを実 PDF の回帰で固定。運用は次回 vwap-ingest で 2026-09-18 週の再保管が必要。
- **EDINET catchup トリガの単発要求化** (#134, #98): Worker への POST を再送なしの単発要求とし、ヘッダ＋本文全体に 600 秒の明示期限をかけた（300 秒超の正当な応答を捨てない）。切断は可視のまま残し、次回定期実行の 60 日窓で自己回収する。
- 共通スクリーニングのボラ条件を ATR% 2% に修正。閾値が % 表記と食い違い実効 0.02% になっていたのを直し、画面の「ATR% ≧ 2%」表示と一致させた。
- ドキュメント・コメント内の用途注記から「個人」の表記を削除し、非公開運用の表記に統一した (ライセンス・出典条件・動作は不変)。
- 有報の海外売上で同一地域名が重複する曖昧な表（地域×品目の2次元表）は数値化せず「未対応」とし、保存後に地域計と合計が乖離する誤取込を防ぐ。実原本の回帰1件付き、既存の正常表の判定は不変。本番の既存59文書は未修復のまま (#150)。
- 財務・有報・IR・優待/配当の実データ照合レポートを公開（証跡 `docs/test-logs/data-audit-fundamentals-2026-09-28.md`）。発見5件のうち1件は解消確認、残りは owner 対応待ち (#150)。
- 監査レポートの正準数値（分類・合計・日付・隔離/保留・full SHA）を `docs/test-logs/data-audit-2026-09-28.results.json` からの生成ブロックに一本化し、本文要約層の重複転記を集計ID参照へ置換。`pnpm audit:report:check`（内訳不一致・保留混入・SHA省略・手編集の検出）をCIへ組込 (#153)。
- 保存運用の根本原因修正 (証跡 `docs/test-logs/storage-operations-root-causes-2026-09-28.md`): Notion 単一行照会の重複時・先頭選択を共通 helper `queryUniqueRow` で保全停止化 (moneyflow 指標/観測・価格同期・有報テキスト・銘柄別データ・保管読取の全6経路)、moneyflow 取込のカタログ失敗を取込ログへ記録、週次信用残の発見先を JPX 01.html へ移転+`--week` 補修と欠落週検出、①マスタ重複の退避を moveToTrash から直接 archive へ契約修正。review 対応で結果不明 DB 回収を厳密化 (同名複数は保全停止・回収前の GET 型検証・通常探索の最古収束は維持) し、重複エラーの private ID 出力を除去。本番適用 (初回保存・再保管・退避) は writer 枠待ち。
- moneyflow の IMF 取得元をミラー (DBnomics) 経由から IMF 公式 SDMX API (pip) 直接へ移行。報告資産と Derived 負債の意味同一を実測で証明した範囲だけ指標キーを維持し、報告負債との混同・ミラーとの混在・無視される期間クエリを止める検証付き。週次信用残の公開 API は旧取込の種類株崩壊週を値無しで除外週として明示し、正常な週・銘柄の表示は不変。本番適用は writer 枠待ち。
- 市場系保存の根本原因修正 (証跡 `docs/test-logs/market-storage-repair-2026-09-28.md`): 一覧の通過数が LIMIT 200 で頭打ちに見えたのを同一条件の総数と先頭表示に分離、OHLCV の保存済み NULL 日を通常日次で訂正再送、R2 日足の分割履歴が 1mo 更新で消えるのを窓マージ化、週1 prune/年次の日跨ぎ飢餓を run 開始時刻固定で、sector/market 表の休場・再実行の重複 snapshot を実データ取引日キー＋N225 照合で解消。ATR bool・優良株判定の stale は正規再計算経路を選定し、旧 Yahoo 年次 writer は外部契約のため維持。本番適用は writer 枠・次回 normal job 待ち。

### 本番作業
- F-01/F-15の監査済み派生5行を削除し、1909/2180/7426の財務3列だけNULL化。R2の1909/2180は各22本の破損末尾と偽分割1件だけを除去した。Notion物理原本退避・SHA再読、native D1変更8/R2 PUT2、再実行の実変更0、独立した正常対照・財務履歴・2180 RSI・原本ファイルの保全確認まで完了。guardはmain `bdaa217` / Version `8df9edc3` の100%配備で確認（証跡: `docs/test-logs/market-corruption-repair-2026-09-28.md`、#152）。
- 検証済み原本のNotion⑤ページIDを既存source財務34,659行へ同期。元33列全不変・原本ID/SHA全組一致・隔離の再同期不変とsource全34列一致を確認し、検証用D1だけ削除。Notion閲覧権限が必要な原本ZIP参照であり、PDF番号の推測・公開共有・アプリ財務複製は追加していない（Refs #124、#145）。
- 財務全34,663原本を再解析し、Notion正本34,659キーを新鮮な再読で修復完了。実隔離D1の全33列・再同期不変と現行SHORT出来高分岐の影響を確認後、既存source D1へ346→34,659行を同期し、全33列一致を再読確認。原本・引用全文や新しい常設財務DBは追加せず、TDnetのPDF番号未取得は未取得のまま表示契約へ通知。証跡は `docs/test-logs/financial-context-unit-2026-09-28.md`。
- #133 (moneyflow)・#134 (信用残/EDINET ingest)・#135 (ATR% 2%)・#137 (銘柄マスタ重複3681/7129 plan/apply) を main へマージし、本番 Worker へ自動デプロイ。main `499ef9f` → Version `d39f1a69` (100%、2026-09-28 06:31 UTC)。ポータル・RSI/スイング screening・VWAP の読取スモークは全て HTTP 200・SSR 行あり・エラーなし。証跡は `docs/test-logs/deploy-2026-09-28.md`。
- #136 (RSI screening 年度売上正本化) は draft のまま実 apply 保留。`#102` のマスタ実 apply・Notion 新 writer・D1 修復・RSI 再計算・本番 ingest 起動も未実施のまま保留。現 receipt 約 26,024 行を全完了扱いしない。JPX 新様式信用残の日次化は 9/29 に延期 (Refs #102 #132 #136)。
- 原本再解析・Notionの新鮮なまとめ再読・実隔離D1の差分/冪等検証後、8154等の年間配当4行と3463の当期損益をsource D1へ同期。財務346行のうち変更5行、無関係341行の全列不変を確認。全34,663原本の正本修復は別途継続中。
- 優先26原本を再解析してNotion正本を再読し、25財務キーを隔離D1で二度検証してからsource D1へ反映。322→346行、誤った3463旧キー1行のみ除去、他321行全列不変。8154全10行の連結売上・中間実績・原文ROEと3911の新しいEDINET中間実績を確認。全件監査は継続中。

---

## 2026-09-27

### 追加
- **競合他社判定のローカル代替判定 (`judge=semif`)** (#118): jev のクレジット枯渇で中断した競合他社判定の残り銘柄を、Apple Silicon ローカル PC 上の SemIf (Qwen3.5-4B, MLX) で代替判定できるようにした。`pnpm biztag competitors -- --judge=semif` / `competitors-eval -- --judge=semif` で切替。評価セットで精度 0.909・再現率 0.928 を確認（`--only-unjudged` で既判定分は再判定しない）。
- **008 moneyflow (「お金の流れ」ダッシュボード) Phase 0/1** (#121): 東証33業種別の売買代金・シェア・上昇/下落日売買代金 (既存D1)・業種別時価総額 (JPX月次PDF)・業種別空売り比率 (JPX日次PDF→月次集計) を Notion「株式情報」直下の「資金フロー｜観測ログ」等の DB へ記録する取込を追加した (`pnpm ingest:moneyflow`、平日17:30 JST cron)。非公開運用・近似値であることを指標定義に明記。信用残の日次化 (9/28〜) は別途対応 (docs/moneyflow.md の TODO参照)。
- **008 moneyflow Phase 2〜5 (取得元 17 件)** (#121): 投資部門別 (株式・ETF/REIT・先物オプション)、財務省の対外対内証券売買、国際収支 (地域別)、投信・REIT の資金増減、公社債の発行償還、日銀資金循環、店頭FX・くりっく365、暗号資産 (JVCEA・CoinGecko)、CFTC COT、IMF CPIS・BIS・World Bank、世界の主要指数を同じ Notion DB へ週次/月次/四半期で記録する取込を追加した (`pnpm ingest:moneyflow -- --only=<spec名>` で個別実行可。一覧は docs/moneyflow.md)。あわせて Phase 1 の不具合 (業種別時価総額・空売りの PDF が 0 バイトで一次データ保管に失敗する、売買代金 0 のとき比率を 0 と記録する) を修正。


### 本番作業
- 競合他社の判定の残り 1,614 社を SemIf (Qwen3.5-4B) でローカル実行し、全 3,607 社の判定が完了（jev 1,993 社・SemIf 1,614 社。「競合判定の版」で区別できる。失敗 0 件）。
- **008 moneyflow の Notion DB を作成** (#121): 「株式情報」直下に「資金フロー｜指標定義」「資金フロー｜観測ログ」「資金フロー｜取込ログ」、「一次データ保管」配下に「一次データ｜moneyflow」を、取込コードが期待するスキーマと同一の列で作成した (中身は空。初回の取込で書き込まれる)。
---

## 2026-09-26

### 追加
- **競合他社の判定** (#116): 銘柄マスタ（補足）に「競合他社」列（同じ DB の行へのリレーション・複数）と、競合判定日・競合判定の版・競合判定書類ID の列を追加。候補は事業タグと事業の内容の文字 2-gram の逆引き索引で 1 社あたり上位 50 社に絞り（全社×全社の比較はしない。全 3,607 社で約 52 秒）、jev が「同じ顧客・市場に代替となる商品・サービスを売っているか」を判定する。仕入先・販売先、同業種でも商品が違う会社、周辺事業だけの重なりは競合としない。しきい値は評価用の 122 組（各組に有報原文の根拠つき）で較正し、精度 1.00・再現率 0.93。A 社から見た競合を A 社の行に入れ、自動で相互には付けない。
- **株価の日次同期の完了記録** (#114): 平日の株価同期（stock-sync）が終わると、Notion「株式情報」配下の DB「株価の日次同期」に 1 取引日 1 行で記録する（取引日・状態 完了/一部失敗/失敗・完了日時・対象/更新/失敗銘柄数・実行ログ URL・失敗理由）。取引日は実際に取り込んだ日足の最新日で、カレンダーの日付ではない。求まらないときは「失敗（取引日不明）」として記録し、日付を推測しない。
- **jss-api 内部面の新ツール** (#112): MCP ツール `jp_indicators_latest`（終値・出来高・移動平均・RSI・MACD・ATR 等）、`jp_valuation`（株価・PER・PBR・配当利回り・時価総額 等）、`jp_job_runs`（取込ジョブごとの最新実行）と、対応する REST `/v1/indicators/:code`・`/v1/valuation/:code`。提供先は認証付き内部面（jss-api-private）のみ。

### 変更
- **事業タグの単語帳 v4 → v5** (#113): 「港湾ロジスティクス」テーマの構成語から港湾と無関係な「倉庫・3PL」「物流機器・マテハン」を外した（このテーマの会社 145 → 29 社）。「専門商社・卸売業」に「卸売事業」等のキーワードと医薬品の例示を追加し、医薬品卸（スズケン・メディパル・アルフレッサ・東邦 HD・バイタルケーエスケー）等に中核タグが付くようにした。
- **事業タグの単語帳 v3 → v4** (#111): 専門商社・卸売業、アパレル/生活雑貨の専門小売、経営コンサル、広告代理店の 5 語を追加し、自動車部品に平易なキーワードを追加。
- **単語帳の自動審査** (#109): 今の版と提案の版の比較で、入力（抜粋・質問）が同じ問いは同じ判定結果を使うようにした。判定 AI の答えの揺れで改善提案が不採用になるのを防ぐ。
- **根拠文の再判定** (#114): タグか要確認があるのに「事業タグの根拠文」が空の行を再判定の対象にした（本番 1,494 行）。

### 本番作業
- 単語帳を v5 まで採用し、全 3,700 社を再判定。タグが 1 つも付かない会社は 1,229 → 987 社。
- jss-api-private をデプロイし、API キーを作り直して Claude Code に MCP サーバ `jss-api` として登録（旧 `jp-stock` 登録は削除）。
- 根拠文が空だった 1,494 社を再判定し、タグか要確認があるのに根拠文が空の会社は 0 社になった。
- 株価の日次同期を手動で 1 回実行し、「株価の日次同期」DB に取引日 2026-09-25（完了・3,700 銘柄・失敗 0）を記録。
- 競合他社の判定を jev で全社実行したが、jev のクレジットが尽きて 1,993 社で停止（残りは 9/27 に SemIf で実行）。

---

## 2026-09-25

### 追加
- **銘柄マスタ（補足）と事業タグ** (#100 / #101): 有報の本文 39 項目を 1 銘柄 1 行で持つ Notion DB と、単語帳 × jev による事業タグ判定を追加。
- **事業タグの第 3 列と根拠文** (#108): 「事業タグ（流通・サービス）」列と、タグごとの有報原文を示す「事業タグの根拠文」列を追加。単語帳を v1 → v2 → v3 に更新（タイヤ・自動車完成車の平易なキーワード、半導体テスタ、総合商社・人材・小売業態・宿泊・旅行・ディーラー等の新語）。

### 変更
- **一次データ保管の移設** (#107): 開けないほど重くなった「バックアップ」ページ（銘柄ごとの子ページ + 子 DB が数千件）をやめ、「株式情報」→「一次データ保管」配下に移した。有報テキストは単一 DB「有報テキスト」（1 行 = 1 通）にまとめた。CLAUDE.md ルール 6 に「銘柄ごとに子ページ/子 DB を量産しない」を追加。
- **空の列・表の削除と需給バグ修正** (#99): 書込経路が無く本番で空だった列・表を削除（`core_stocks` の 9 列、`jss_supply_latest.isin`、`jss_index_symbols` の 2 列、`jss_xbrl_documents` / `jss_xbrl_elements`、`yutai_benefits.estimate_source_url`）。jss-api の `jp_xbrl_elements`（常に空）を撤去。需給の前週比（`loan_chg` / `stock_chg`）が D1 に保存されていなかったバグを修正。
- その他: 選択肢名の検査で読点「、」をカンマ扱いしない (#103)、単語帳見直し Automation の秘密名変更 (#104)、契約書の更新 (#105)。

### 削除
- Notion ②株価テクニカル・⑥時系列エクスポート・⑦収集ジョブログ（廃止済み DB）を削除し、`db_ids.json` から外した (#106)。①銘柄マスタの空のプロパティ（17業種・市場区分・上場日・上場廃止日）と旧履歴列を削除（本番作業）。

### 本番作業
- 有報テキスト 37,949 通と一次データ DB 6 個を「一次データ保管」へ移動（ページ ID は維持）。空になった旧「バックアップ」「ごみ」「アーカイブ索引」はゴミ箱へ。索引ページは新しい場所に作り直した。
- D1 に migration 0024 と jss 表の DROP を適用。

---

## 2026-09-24

### 変更
- **使われていない 17 業種の列を削除** (#96 / #97): `core_stocks.sector17`（書込も参照も無く全行 NULL）を削除。「33 業種は全行 NULL」という古いコメント・資料を修正（実際は 2026-09-13 から充填済みで公開面が使用中）。
- アーカイブ索引ページの自動生成 (#95)、バックアップ直下の探索を Search 完全一致 + 最古優先に (#94)、有報の通数指定でのギャップ修復 (#93)。
