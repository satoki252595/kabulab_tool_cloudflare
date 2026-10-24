# 株式・マクロ sync の CF スケジューラ

株式日次・マクロ sync の起動時刻を GitHub Actions schedule から Cloudflare Cron
Trigger へ移す。実実行は従来どおり GitHub Actions (`stock-sync.yml`
`workflow_dispatch`)。予定・担当の全体像は[本番処理一覧](production-job-inventory.md)を参照。

## 原因

- 旧 GH 株式 schedule (平日 17:13 UTC) が 250/318 分のイベント生成遅配を
  2 回連続で起こした。runner 待ちは 3 秒で、遅れは runner 不足ではなく
  schedule イベント生成側だった。
- 06:00 JST 基準 guard が正しく STOP し、遅配 run の D1 保存は起きていない
  (欠測として正しく残った)。
- cron 前倒しは Yahoo 確定証拠なしで不採用。起動時刻の信頼性を CF 側へ
  移すことで根本対策する (旧方式廃止はユーザー許可済み)。
- 10/1のマクロも予定21:00 UTCが翌00:25 UTCへ205分遅配した。
  日本市場の形成中バーとVI翌日の日付が入り、原本日付gateが正しくHOLDした。
  マクロ起動もCFへ移し、株式とは独立したreceiptと期限確認を持つ。

## 設計

CF cron 14 本 (`wrangler.toml` `[triggers]`、曜日は `MON-FRI` 名前指定。
CF の数字曜日は 1=日曜で GitHub と違うため):

| cron (UTC) | 処理 (`src/scheduler/stock.ts`) |
|---|---|
| `0 9 * * MON-FRI` | R2 receipt を claim → workflow_dispatch POST → run 詳細を CAS 保存（18:00 JST。取引日 D の当日） |
| `35 14 * * MON-FRI` | 期限 readcheck (receipt + Jobs API で完了検証。成功以外は error。23:35 JST) |
| `0 21 * * MON-FRI` | `scheduled-context` をdispatch。株式・sector33・moneyflowは起動しない |
| `5 22 * * MON-FRI` | 専用context receiptのrunを読み、同日のcontext成功と22:00完了期限を検証 |
| `15 9 * * MON-FRI` | `moneyflow.yml` に `only=independent` をdispatch。株価・JPX休場に依存しない取得元 |
| `45 14 * * MON-FRI` | 専用moneyflow receiptのrun・ingest step成功と同日09:15〜14:40完了を検証 |
| `0 10 * * MON-FRI` | `catchup.yml`の`scheduled-catchup`をdispatch。19:00 JST、TDnet→EDINETの順で実行 |
| `5 11 * * MON-FRI` | 専用catchup receiptのrun・両source成功とLinux biztag skip、19:54 JSTまでの完了を検証 |
| `0 8 * * MON,WED,FRI` / `35 14 * * MON,WED,FRI` | VWAP日足・5分足の起動 / 期限確認 |
| `17 3 * * MON-FRI` | Python日証金。`scheduled_at`を渡す |
| `0 0-10 * * MON-FRI` | Python TDnet。各時間slotの`scheduled_at`を渡す |
| `0 12 * * MON-FRI` | Python EDINET。`scheduled_at`を渡す |
| `0 8 * * MON-FRI` | 信用残。`scheduled-margin`と`scheduled_date`を渡す |

2026-10-09 に株式 dispatch を `13 17`（02:13 JST）から `0 9`（18:00 JST）へ移した。
02:13 JST は、取引日 D の ^N225 日足 close が null になる時間帯（D 23:30 JST 以降。
D=2026-10-08 の原文で 00:15 以降が null）の中だった。
[stock-sync-asof-2026-09-28.md](./test-logs/stock-sync-asof-2026-09-28.md)の
190.95分（run35669787483）は、**予定から終了まで**の時間で、開始待ち176.23分と
実行14.72分の合計。過去10runの実行時間最大は21.18分だった。
これは旧方式の観測であり、現行方式の最大実行時間や21:11終了の根拠には使わない。
終値の有無を実測したのはD 21:15と23:30だけで、18:00を含む15:30〜21:15は
未計測。開始時刻は実測の結果で変わりうる。

10/19のコードは全active/equityを直列にChart 5yとQuoteSummaryで取得し、共有clientが
HTTP開始間隔を1秒にする。3,687社なら約7,374通信の間隔だけで**約123分が下限**。
通信待ち・認証更新・原本保管・計算・D1保存・Yahoo共通queueの待ちが加わる。
workflowの210分timeoutは強制停止の限界で、完了保証や測定済み上限ではない。

保存境界もVWAPとは異なる。株式は全pending/rawを収集後に`stocks-first`の物理原本を
保管し、途中429/503があれば`custodyStop`で株式D1のflush前に停止する。
先行したoverlay/JP legの反映は別会計。正常閉鎖した中断では取得済原本が残るが、
全量収集中の強制終了で未保管原本を回収できる保証はない。
VWAPは最大30社/30wave/8MiBごとに原本保管と条件付きR2保存を行うため、
中断前に確定したbatchは保持される。既存CLIの株式専用指定は`--stocks-only`で、
銘柄指定・保存原本入力による部分再開は提供していない。
根拠は[src/cron/daily.ts](../src/cron/daily.ts)、
[回帰検査](../src/cron/daily-batch-custody.test.ts)、
[取得間隔](../src/shared/yahoo/request-spacing.ts)、
[workflow](../.github/workflows/stock-sync.yml)。

別jobへ停止期限が失われる経路は[共有cooldown修正](test-logs/yahoo-shared-cooldown-20261019.md)で
対応した。10/19 18:46:24にmain`b1c7240b2a1b070242aba5bc22d679da7f772b3c` /
CF version`ac3d1414-d93f-43fa-99da-89411874025a`を配置し、同じ10triggerを確認した。
この修正から株式全量の成功・過去データの充足を推定しない。

- POST 前ガード: 未知 cron・未来・土日・UTC 日跨ぎ・開始期限
  (株式60分、マクロ30分) 超過
  は POST 前に error。既存の price guard・close guard・完了期限・失敗率
  1% 判定は不変。
- receipt: `stock-scheduler/receipt-<予定UTC日>.json` を `If-None-Match: *`
  で原子的 claim。取得者のみ POST。重複時は既存 receipt を読戻し、
  同予定日・dispatch cron・時刻妥当性 (同日・順序)・正の run ID・
  同一 repo/run URL の全部入りで dispatched のときだけ正常 duplicate
  (追加 POST 0)。claimed/破損は error 継続・再 POST なし。
  readcheck も同一 parse で統一。互換 fallback なし。
  POST 検証 (HTTP 200 + `workflow_run_id` / 同一 repo・run の `run_url` /
  `html_url`) 後に native `etagMatches` で CAS 保存。
- マクロreceiptは `stock-scheduler/context-receipt-<予定UTC日>.json`。
  株式と同日でも別claimとし、原本・成果・成功判定を混同しない。
  予定から30分を超えたマクロdispatchはPOST前に停止する。
- GitHub API は `User-Agent` 必須。Jobs 分頁は同一 origin/path・run 限定、
  循環検出・10 頁上限超過は error。run ID は正の整数のみ。
- pending・結果不明は成功にしない。自動再 POST なし (CAS 競合時は
  手動トリアージ。POST 済みのため再送しない)。
- secret・URL 値はログに出さない (run_id の数値のみ)。
- `scheduled_date` は共有 producer 入口 (`runDailySyncAndRecord`) で検証
  のみ。`STOCK_SYNC_TARGET=scheduled-stocks` のとき必須
  (欠落・空・空白は fetch 前に落とす)。手動 stocks 未指定は現契約維持。
  時刻のバックデート・原本日付の上書きなし。
- 新 dispatch target `scheduled-stocks` は株式 only。株式成功後のmoneyflowは
  `sector-turnover`だけを連鎖する。他の取得元は独立CF起動が担当し、株式停止で止めない。
- 独立moneyflowは非Yahoo27取得元とYahoo1取得元を別jobで取得し、joinは両jobの
  結果を閉鎖してから進み、joinは両lane成功を待つ。既知のsource失敗だけならYahooは続け、不明結果では停止する。ジョブ間の共有Notion枠が未成立のため、取得順は非Yahoo→Yahooを維持する。
  Yahoo共通排他と各Notion枠1.6/1.0 RPSは保持し、全体の2.9 RPS保証とは扱わない。両laneの同run・同attempt・
  全source・実期限を共有検証し、readcheckも両producerと後続joinの3job成功を要求する。
  片側失敗・結果不明・欠落summaryは全体成功にせず、LLMは使用しない。
  これは既存本番DB/schema準備済みの運用改善であり、初回構築を並列化するものではない。
  空の環境では既存の単一入口 `pnpm ingest:moneyflow` を先に直列で正常完了させ、指標定義・
  観測ログ・取込ログ・一次データDBの準備を済ませてから定期分割を有効にする。
  共有schema更新は不足列・既存選択肢を保持した追加だけで、既存列の削除・型変換を行わない。
- `scheduled-context` は日付が必須。Node入口は予定日21:00〜21:30 UTCだけ
  開始を許可し、GSPC確定日が予定日と一致することを既存原本gateに追加する。
  N225/VIX/VIの同日・必須値・物理保管は既存条件を保持する。保管後に
  22:00を超えた場合はD1保存を止める。古い確定日を予定日へ置換しない。
- マクロreadcheckはsync jobとcontext stepの一意な成功、同日21:00〜22:00
  の完了、株式stepとmoneyflow jobのskipを全て要求する。HOLDは成功にしない。
- readcheck 成功条件: job `sync` が completed・success かつ `stock daily
  sync` が success・completed_at が同日 09:00〜14:30 UTC (古い別日の
  成功を通さない。14:30 UTC は D 23:30 JST で、それより後は null 帯に
  入った完了なので成功にしない。旧上限 21:00 UTC からは縮めた)、かつ `許容内失敗があれば Issue にコメント` が
  SKIPPED (success = 許容内失敗ありの false-green。step 欠落も error)。
  検証対象は receipt の run ID と照合する。Dispatch 受付は同期完了でない。
- 既存の Notion 完了/失敗バッチ・Actions 通知を再利用。新 table・DO・
  Issue 書き込み権限は不要。

## 受入

### 開示catchupの19時起動

2026-10-14に、GitHub scheduleで6〜9時間遅配していた平日の開示取込をCFへ移す。
同じ平日1回・母集団・取得範囲を保ち、開始を20時から19時JSTへ前倒しする。
20時のMac事業タグ処理と21時の優待処理は移動しない。開示は市場休場日も対象。
TDnet一覧は40日前〜当日の41暦日を1回ずつ読み、一次原文の物理保管・全文読戻し、
二次12分予算、EDINETの300秒/60通と別価格300秒予算、通常380ms間隔を維持する。
二次の予算打切りを全IRの保存完了と呼ばず、EDINETのcap/保留は非0終了する。

初回の起動資格は同日19:00〜19:05だけ。後続EDINETは原本閉鎖などの終端10分を残す範囲だけ新規文書へ進み、同日19:53:00で停止する。
Node入口は全fetchに元のsignalと絶対期限の両方を渡し、期限後の追加送信を拒否する。
AWS SDKのR2読取は既存のタイムアウトとjob停止の対象で、全通信の19:53:00終了を保証するものではない。
TDnetの既absolute deadlineとEDINETの各phaseにも締切を伝播し、本文・原本の照合は減らさない。
定時targetだけGitHub job予算を**54分**にする。job開始は初回資格より前なので、
19時開始なら自動cancel期限は19:54になる。19:53に新規処理・書込を停止して終了用の余裕を残す。手動tdnet/edinet/allは従来60分。
これは完了率やremote rollbackの保証ではなく、不明結果は既CAS/inFlightを残して停止する。
Node子watchdogや新しいrate基盤は追加しない。

新targetは両sourceだけを実行し、Linux biztag jobはskipする。手動allは既存の
Linux biztag停止を含むため、両sourceの正常受入には個別targetを使う。
checkoutはmainを明示し、取得前にevent ref/SHA・実HEAD・取得済origin/mainの一致と
tracked cleanを要求する。mainが途中で進んだ場合も別版へ自動再送しない。
旧scheduleは削除し、新CLIではschedule eventを取得前に拒否する。
既作成の旧head runには新guardが遡及しないため、切替直前のnative active0を別に確認する。
未観測の旧server待機イベントが完全に消えたとは扱わない。既catchup concurrencyを保ち、
receipt claim/dispatch unknownの再POSTを禁止する。EDINET日付progressのCASはTDnetの排他証明ではない。

専用receiptは`stock-scheduler/catchup-receipt-<UTC日>.json`。
20:05 readcheckは同runの起動資格→TDnet→EDINETが各一意の成功、同日の期限内・順序一致、
Linux biztagの一意skipを要求する。今日の未観測runや歴史的成功を当日の成功へ読み替えない。
手動回復は定時19時成功とは分けて確認する。設定・merge・deployだけを受入とは数えず、
実receipt/run/期限確認で判断する。18時株式・資金フローが19時にもNotion通信中なら、
その枠は別に確認する。前倒しだけで全process合計の上限を証明しない。

仕様根拠（2026-10-14確認）:
[GitHub schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)、
[checkout v4](https://github.com/actions/checkout/blob/v4/README.md)、
[job timeout](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idtimeout-minutes)、
[cancel手順](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation)、
[Cloudflare Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。

- `src/scheduler/*.test.ts`: 曜日・日跨ぎ・期限・重複・曖昧 POST・200 正常・
  target routing・date mismatch・false-green を固定 (mock のみ。live POST なし)。
- `pnpm typecheck` / `pnpm lint` / `wrangler deploy --dry-run` 成功。
- [PR #283](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/283) は資格設定後にmainへマージ済み。2026-10-03の本番version `d5027aee-ef18-4b34-b6c8-da87ea37b22f` はmerged SHA `f53e572928b8d73b800a7b1693571a7c2d1f84d3` に対応し、100%配信を確認した。
- 自動定時実行の受入は、次の平日のdispatch receipt・Actions run・readcheckの実成功で判定する。設定済み・デプロイ済みをデータ更新完了とは扱わない。

## 制限

- Workers Paid で運用する。scheduled は全銘柄の処理を行わず、日次
  各dispatchの R2 2 PUT + GitHub 1 POST と、各readcheckの R2 1 GET + Jobs API
  読取のみ。追加4系統は既存原本取得の起動元を置換し、全市場の再取得や定期回数を増やさない。
  正常な追加dispatchは平日1日14回（TDnet11回と他3回）、R2は各2 PUT、GitHubは各1 POST。
  duplicate/失敗/既存workloadは別計数。VWAPの段階分離は日足以外の環境準備1回と結果集計jobを追加するが、取得銘柄数・取得間隔・原本再送は増やさない。新しい定期監視は追加しない。
  cron 変更の伝播には最大 15 分かかる。
- 休場: [JPX公式](https://www.jpx.co.jp/corporate/about-jpx/calendar/)と
  [NYSE公式](https://www.nyse.com/trade/hours-calendars)の2026/2027公表休業日を
  `src/shared/market-calendar.json`に固定する。両HTMLは一次データ保管へ実体保存・全文SHA照合済み。
  株式はJPX、同日マクロはJPX/NYSE双方の取引日だけを対象とし、休場は
  `market_closed`・理由・出典をログ/戻り値に残す。dispatchもreadcheckもreceiptを作らない。
  未収録年・不正日付は明示失敗する。NYSE短縮取引日は休場に含めず、確定closeは
  原文session guardで証明する。原文のNULL・古い日足・部分行を成功へ読み替えない。
- 価格ガードが失敗しても公式上場状態のoverlayを先に適用する。日次の時間窓・予定日・
  書込み期限、overlay原本保管/CAS/HOLDは維持する。独立資金フローのreceiptは
  `stock-scheduler/moneyflow-receipt-<予定UTC日>.json`で、株式・マクロと混同しない。
- `GITHUB_ACTIONS_TOKEN` 未設定の Worker では scheduled が即 error
  (fail-closed)。既存 gh OAuth を Worker へ移さない。

## 手順 (Root・ユーザー向け)

1. ユーザー: この repo 限定の Actions 読み書きトークンを新規発行する
   (既存トークンの権限拡大はしない)。
2. Root: `wrangler secret put GITHUB_ACTIONS_TOKEN` で Worker に登録する
   (値はログ・PR・Issue に出さない)。
3. Root: 本 PR をレビュー後 merge する (既存 cron を先に止めない。
   削除は本 PR に含まれる)。
4. 翌平日: 株式09:00/14:35、マクロ21:00/22:05のreceipt・run・readcheckを確認する。
   株式 step の完了が 14:30 UTC（23:30 JST）より後なら readcheck は失敗する。
5. 異常時: Cron Events / Workers Logs の error を見て手動トリアージする。
   自動再 POST はしない。


## 18時writerの監視

`pipeline/.../cloud_store/slo.py`の株式は当日EOD（lag_days=0）、日証金は翌JPX営業日公表
（lag_days=1）で判定する。公式JPX休業日は加齢しない。EDINET/TDnetの提出日とは
同義でないため、これらに市場カレンダーを流用しない。日次の欠損・不正日付を
新しい取得時刻で代用せず、unknownまたは明示失敗にする。

既存ops_checkはactive普通株と小さな断面3表をPKで結合し、完了期限後の当日価格・
指標・モメンタムの全対象coverageを要求する。期限前は前取引日以上〜当日までの
実保存値を許容し、未来日を拒否する。マクロは日米共通取引日の保存日を要求する。
1銘柄のMAX更新だけで残りの停止を隠さず、未登録・古い値を警告する。
本番readonly実測（2026-10-14 00:42 JST）はSELECT1回、rows_read=14,757、
rows_written=0、SQL20.73ms。OHLCV全走査やR2列挙は追加しない。

共有`yahoo-source` concurrencyにはGitHub公式の`queue: max`を設定し、後着が
既存pending runをcancelする既定動作を防ぐ。同時取得は従来どおり1 jobだけ。
[GitHub公式仕様](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idconcurrency)
に従い、最大100件のpendingを受け付ける。時刻窓を満たせないrunを成功に変える設定ではない。

## 取得処理の時刻契約

2026-10-24改定。すべてJST。起動受付はCFの `scheduled_at`（cronが実行される予定だった時刻）。データの締切は実時計。
日証金・Python TDnet・EDINETのCF dispatchは予定分から5分以内。信用残のCFは予定時刻が17:00〜17:10で、実時計は17:30まで。同じ日時slotはR2 claim→POST1回→CASで固定し、結果不明時は再POSTしない。

| 処理 | CLIの新規開始 | 新規取得・保存の締切 | 対象日と先行関係 |
|---|---|---|---|
| 日証金 | 12:17〜同日22:00未満 | 同日23:00未満 | 予定JST日。CSV内の基準日は変更しない |
| TDnet速報 | 各09〜19時slotから60分未満 | そのslotから90分未満 | 予定JST日。遅配を別日へ読み替えない |
| Python EDINET | 21:00〜翌19:00未満 | 翌21:00未満 | 予定JST日の提出資料。19時Nodeと独立 |
| 信用残 | 予定時刻17:00〜17:10 | 実時計17:30 | 専用排他。原本の対象日・公表日を保持 |
| VWAP日足→5分足 | 日足の予定時刻17:00〜17:10。5分足は同run/attemptの受付を継承 | 実時計の同日23:30 | 日足の既知閉鎖exit0/1後だけ5分足。段階間でYahoo排他を解放 |
| 株式 | 予定時刻18:00〜20:00 | 実時計の同日23:30 | Yahoo共通排他内。日付・分割単位・原本保管の資格を維持。CFの60分超過は予定時刻からの遅配として停止 |
| 独立資金フロー | 予定時刻が18:15以降、同日締切前 | 実時計の同日23:40 | 非Yahoo結果を閉じてからYahoo。既知失敗でも独立sourceは進めるが、join成功には全source成功が必要 |
| Node開示補完 | 予定時刻19:00〜19:05 | 新規文書は終端10分を残して開始、実時計19:53で停止 | TDnet→EDINET。job予算54分、期限確認の完了上限19:54。手動targetは時刻を要求しない |

締切は新しい通信・レコード保存の開始条件であり、開始済みHTTPのremote rollbackは保証しない。
原本保存の未完intent・CAS不明・失敗は保持し、後続へ成功として渡さない。
予定日時は処理対象日の固定に使い、原本の日付・実観測時刻・最初のreceiptを置換しない。
GitHubの待ち行列は処理能力の保証ではない。Yahooは並列化せず、段階間の占有を短くする。
各jobのNotion pacingも全process共通のレート保証ではないため、追加の全量取得・自動再送は行わない。

根拠（2026-10-23確認）: [GitHub scheduleの遅配](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)、[GitHub concurrencyの待機規則](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)、[Cloudflare CronのUTC時計・伝播時間](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。
