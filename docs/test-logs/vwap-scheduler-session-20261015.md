# VWAP 定時起動と当日受付窓 (2026-10-15)

## 問題と変更

旧定時 run [38570657322](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38570657322) は月水金17時予定から約7時間19分遅れて日足+5分足の実stepが起動した。保存済みHTTP原本の `^N225` 当日終値がNULLで、日足の既存資格検査が停止した。信用残だけの実行ではなく、日足+5分足stepが起動し信用残stepはskipだった。原本のNULLを休場や当日終値へ読み替えない。

月水金17時の日足+5分足の起動だけを、既存Cloudflare scheduled handlerの単発dispatchへ移す。予定日別R2 claim・dispatch応答のrun ID照合・CAS受領保存・結果不明後の再POST禁止を既存株式等と共有する。GitHubの月水金cronを削除し、平日17時の信用残cron、18時株価、マクロ、資金フローの時刻・頻度は変更しない。Cloudflare CronはUTCで解釈され、設定反映には最大15分かかるため、設定変更だけで次の本番起動成功を保証しない。[Cloudflare Cron Triggers公式説明](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

CFは月水金08:00 UTCに `vwap-ingest.yml` の `scheduled-daily-intra` を `main`/明示予定日/`yahoo-direct` で1回だけdispatchする。予定日が月水金でない、CF起動が17:00〜17:10 JSTを外れる、原clock不正、日跨ぎの場合はclaim/POST前に停止する。JPXの公表休場は既存カレンダーで区別する。受付成功を取込完了とは扱わない。

ActionsのYahoo共有lockを取得した後、日足CLIが同じ受付窓を、母集団読取やYahoo取得より前に検査する。queue待ちやsetup遅延で17:10を過ぎた場合も取得0で停止する。受付した実時計はrun ID/attempt/予定日を付けたローカル専用JSONへ排他的に保存し、日足summary原本にも残す。5分足は同じrun/予定日の受付JSONを要求し、開始時計を更新せず継承する。記録欠測・不正版・別runは停止する。

定時runは23:30 JSTを終了窓とし、新しいsource呼出しと価格PUTの直前で時計を再検査する。23:30:00.000以降は新規開始を拒否し、readcheckでは既に完了した処理の23:30:00.000ちょうどを許可する。期限到達で次銘柄を止め、取得済み原本の物理保管と未着手全件のsummary記録を続けてexit2にする。既に開始したHTTPの結果を取り消し成功と扱わず、取得時計は原文の時計を保持する。23:35のCF readcheckは同受領runの全job頁を読み、日足+5分足の一意成功、実step開始17:00〜17:10、完了23:30以内、単独5分足/信用残skipを確認する。部分成功や未完は成功にしない。

共有Yahoo clientの任意 `beforeRequest` は既存spacingの同期 `assertAllowed` に接続し、待機後・credential page/crumb・401後の再認証を含む各native発信直前で検査する。未指定callerの動作と429停止は維持し、globalなguard状態は追加しない。通常Actionsは既存proxyへ送るため、この検査が保証するのはNodeからproxyへのnative開始であり、その後のCFproxy内部upstream時刻までは保証しない。新しいheader/API契約は追加しない。価格snapshot producerの内部await後もregistry/intent/activeの新規PUT直前に任意 `beforeMutation` を検査し、途中停止時の既ACK/readbackとinflightを保持する。activeの既知ACKと全文readbackが完了した後は、期限を越えてもcomplete受領記録だけを閉じ、CLIの最終期限検査は失敗を明示する。最後のskipやsummary保管が期限を越えた場合も、日足/5分足は最終検査でexit2にする。

通常の市場sessionは従来のdirect `^N225` のまま。既存 `archived-jp-leg` の同日・閉場・全bytes/SHA検査は明示手動選択として維持し、失敗後の自動切替は加えない。17時の未計測producerを18時株価の新しい必須依存にする変更も含めない。

## 費用・容量と未受入

Yahoo要求数・母集団・ライブラリ・原本保存量は通常経路と同じ。追加は定時ごとのCF dispatch/readcheck、receipt claim/CAS各1PUTと照会GET、Actionsローカル約200Bの受付記録だけ。既存 `yahoo-source` の `queue: max`、CONC=1、300分timeout、初回429/503 STOPとRetry-After保全は維持する。並列取得や自動回復dispatchは追加しない。

17:00〜23:30は390分、受付の最遅時点からは380分。保存runの株式142分39秒・資金フロー53分27秒・VWAP181分31秒は別runの所要時間であり、VWAPの5分足は1823 written/7 skippedの後に429で中断した。これらの足し算を「全量実測」として容量保証には用いない。日足+5分足の全量所要時間は未計測で、300分job上限と共有lockの待ちを含む窓内完走保証も未証明である。今回の変更は遅配した夜間取得の阻止と未完の明示であり、全量完了・当日source欠測47社の回復・5分足の未開始1855社と429対象の回復を実施済みとはしない。これらの固定cohortと旧unknown/rejected0は別の保存監査・限定回復に残す。

本変更ではvendor取得、GHA dispatch/cancel、Worker deploy、Notion/D1/R2本番書込、モデル実行は行わない。通常main配置後の次の月水金起動・source資格・全量summaryの実受入が残る。

## 検証

Nixプロジェクト環境 (Node 22.22.2 / pnpm 9.15.9、既存lockと依存closure) を使用。source-free回帰で、旧7時間超遅配の取得0、受付後の期限超過、同run時計継承、破損/別日/別runの拒否、期限途中の既取得原本保管とPUT0、CF一回POSTとunknown再送0、readcheckの開始/終了窓、既存direct/保存原本・CLI異常終了を検査する。実vendor通信の成功はこの回帰の主張に含まない。

- native直前hook追加前の初版関連8suite: 199 PASS / 3既存optional skip。同初版の `nix develop -c pnpm test`: 320 suite PASS / 1 suite skip、5545 PASS / 446既存optional skip、49.16秒。
- 最終関連15suite: 293 PASS / 3既存optional skip。実spacing/clientとfetch置換を使い、全6取得入口・page/crumb/401認証各境界の発信停止、既429理由維持、既開始本文の原clock capture、registry新規3PUT前と既知active受領記録、最終summary後の期限検査を確認する。全体の最終版確認はPR CIでも実施する。
- main `a61a2fd3` (#409一覧境界/#410 UTC保存session) 統合後の関連16suite: 304 PASS / 3既存optional skip。両release notesと保存readerを保持し、同fileのoptional guardを統合した。
- 23:30ちょうどの新規開始拒否と、既知active ACK/readback後のcomplete受領保全を補強した6suite: 166 PASS / 3既存optional skip。完了記録後のCLI期限失敗を維持する。

## 2026-10-16: 本番17時Cronの秒ゼロ前提を修正

Issue #348。本日17時の`stock-scheduler/vwap-receipt-2026-10-16.json`は正規R2 bucketの単発GETでnative `NoSuchKey`/404だった。これだけから未発火とは判定しない。Cloudflare ObservabilityのAND条件でservice=`kabulab-cf`・cron=`0 8 * * MON,WED,FRI`に束縛すると、scheduledイベント1件・outcome=`exception`・`$workers.event.scheduledTime=1792137652`を確認できた。同serviceとエラー完全一致の別クエリは、同じclock・Worker version `d3d109ef-ae39-4c5d-ad8e-c48dfcd74c7c`に「VWAP予定時刻が17:00 JSTではありません」を結び付けた。

このObservability表示値はepoch秒で2026-10-16 17:00:52 JSTに対応する。[Scheduled Handlerの公式仕様](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)はcontroller入力をepochミリ秒と定義するが、秒・ミリ秒がゼロである保証はない。controllerの生ミリ秒値自体は未採取であり、回帰では公式入力単位へ変換した`1792137652000`を用いた。[Cron式は分を指定する](https://developers.cloudflare.com/workers/configuration/cron-triggers/)ため、通常の共有`resolveRunDate()`で予定17:00分への所属を確認する。予定日・曜日・未来・日跨ぎ・実時計17:10:00.000までの受付と23:30の新規開始拒否は既存どおり。52秒を受付延長へ加算せず、実時計や保存原本を17:00:00へ書き換えない。

通常handlerを通す回帰で、17:00:52のcontroller→単一claim→同日`scheduled_date`のGitHub payload→同じActions受付guard、duplicateのPOST0、unknown時のclaimed保持/再送0を確認する。17:00:00.001/17:00:59.999は受入、16:59:59.999/17:01:00は拒否、実17:10:00.001以降は拒否する。兄弟の株式・マクロ・開示・資金フロールートに同じミリ秒完全一致前提はなかった。

私有証跡は`tmp/feature-audit-20261016/vwap-scheduled-receipt-readonly-v1/`のnative R2エラーと`observability-bound-cron-native.json`/`observability-bound-failure-native-v2.json`。直接schedules APIの読取は.env tokenの権限403で、現在の一覧を取得できたとは扱わない。raw events表示もMCP側のscheduled event schemaで失敗したため、ヘッダーを出さない集計とログfieldだけを使用した。取得/dispatch/本番writeはこの修正で0。本日の17時処理を成功へ変えず、別の有限通常CLIで受入済みの200件・残1,656件と分けて記録する。実デプロイと次の定時起動・全量完走は別途確認する。
- `nix develop -c pnpm exec tsc --noEmit`、変更TS15filesのeslint、`git diff --check`: PASS。
- installed Wrangler 4.101.0 `deploy --dry-run`: Worker compile/config検査 PASS。実upload/deploy/traffic変更0。
