# 株式・マクロ定時失敗の調査（2026-10-01）

対象は Issue #163 / #160、main `7f1442972793051882d4c2d15771348eb6e4c647`。
本調査は GitHub 実ジョブログと既存 Notion 原本の読取のみ。新しい Yahoo 取得、
D1/R2 書込、workflow dispatch は実施していない。

## 株式：予定イベントの遅配

- [run 36779265451](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36779265451)
  は予定 `2026-09-30 17:13 UTC` に対してイベント作成・開始が `21:24:52 UTC`。
  `stock daily sync` は `21:25:15 UTC` に開始し、共有時間窓 guard が停止した。
- 株式取得前の停止で、正常保存の証明ではない。失敗バッチは既存経路で
  `price-sync-batch-36779265451.1` に記録されている。
- CF Cronで株式・マクロの起動だけを移すPR #195を最新mainへ統合する。既存の
  全経路時間窓・N225実終値・母集団overlay・完了期限を保持する。
  原本日付を予定日へ上書きしない。

## マクロ：遅配と一次欠測を分離

- [run 36796102550](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36796102550)
  は予定 `2026-09-30 21:00 UTC` に対してイベント作成・開始が
  `2026-10-01 00:25:24 UTC`（09:25 JST）。株式 step は skipped。
- 原本は [Notion の既存バッチ](https://www.notion.so/3ecd74ff84cd81c9b79dd8e28794daf4)
  `macro-source-batch-36796102550.1-1790814338681`。
  manifest は5対象各1回・HTTP200を記録しており、429失敗ではない。
- `macro-N225-attempt0.json` を読戻し、2889 bytes・SHA256
  `374c7f3dcadc017067041c581cff81aeeced94ecb70455184ddefcea7707e2f7`
  が既存添付manifestと一致した。
- N225原本の `2026-09-30` 行は OHLC・調整終値・出来高がすべて null。
  `2026-10-01` には実数があるが、regular session終了前の形成中バー。
  `selectConfirmedCloses` が9/30の実終値を証明できず HOLD するのは正当。
  meta価格・前日バー・0で補完しない。
- `macro-manifest.json` も読戻し、2031 bytes・SHA256
  `9ca66965c0846598211ea5900c504d42bd50861e400a01a408db58c5bef64d30`
  が既存添付manifestと一致した。draftの GSPC/VIX確定日は9/30、VI日は10/1。
  原本側のN225欠測が回復しても、このバッチのVI日付不一致は別のHOLD条件。
  本調査では残る4添付の物理再照合はしていない。

## 後続の業種・資金フロー

この2実行は sync job failure により sector33 / moneyflow が skipped。
既存の正常producer・実取引日・許容内失敗なしを要求する連鎖を維持する。
producerの正常実保存と後続sector-turnoverの同日実保存が揃うまで #160 / #163
を完了扱いにしない。

## Scheduler統合の検証

- `scripts/sync/moneyflow-only-check.sh`：14ケース PASS。
  `scheduled-stocks` は全sources、手動 `stocks` は sector-turnoverのみ。
  廃止した株式GH cronは明示拒否。
- Nix管理のNode22.22.2/pnpm9.15.9で最終対象77テスト・TypeScript・lint成功。
  `wrangler 4.101.0 deploy --dry-run`も成功。
- 全TypeScript suiteも4155 PASS・427既存skip、255ファイルPASS・1 skip
  （2026-10-02 JST実行、48.94秒）。その後、Jobs APIの株式/comment stepが
  重複する2ケースを追加し、一意性guardを含む対象77テストとTypeScript/lintを
  再確認した。CIはpush後に別確認する。
- credential設定・CFの定時発火・実dispatch・期限readcheckはこの調査の実施範囲外。

## 通常時間帯の実受入（2026-10-01 15:32 UTCまで）

- PR #195 head `51dd661` の CI `check` / `python-pipeline` と Workers Builds は全PASS。
- Rootが排他で起動した[通常run36879969126](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36879969126)
  は14:54:08〜15:11:07 UTCの株式stepで3634/3689成功・55失敗となり非0。
  sector33/context/moneyflowは全skip。同日連鎖保存の受入は未達。
- [既存Notion failurebatch](https://www.notion.so/3ecd74ff84cd81d0b34dc354d3671e5b)
  `price-sync-batch-36879969126.1`を全読戻し。7785 bytes/SHA256
  `f7d8d0bd43ae10e9e1a91b2cf995a200b9c06f457b8a8ef51e59a7dba066fbe5`
  が保管manifestと一致。54件は10/1実日足未取得、1件8303はnegative raw adjで
  全応答拒否（metadata分類はsourcegap54/unknown1）。guardは保持する。
- 15:19:34 UTCにD1 SELECT2本でactive+equity3689、10/1実close+volume3634、
  indicator latest_date10/1も3634。欠落55はfailure全55と集合完全一致、全55の
  latest_saved_ohlcvは9/29。sector-turnover全数coverage条件を満たさない。
- 旧9/29診断manifestと原文54（55添付）を既存Notionから読戻し、全bytes/SHA一致。
  旧54と今回の欠測54は重複15・旧のみ39・新のみ39。重複15の旧原本には
  9/29 exact1行の実close/adj正値・volumeがあるが、10/1原本は未保管のため
  今回のstale/null/forming細分類を推定しない。
- 15:24:09 UTCのD1 SELECT2本で失敗55は全active+equity、発効済delist0。
  5484（10/19）・9691（10/9）は未来予定で、欠測を理由に除外しない。
  旧のみ39のうち14は公式発効済delistでinactive、残25はactive。
- 通常株式の全Chart/QuoteSummary原文保管は未実装と判明した。failurebatchや
  マクロraw保管を全株式custodyと読み替えない。この不足の修正は別PRで扱う。
  本追跡のYahoo/source追加GET、Notion/D1/R2 mutation、追加dispatchは0。

## 公式仕様

- [GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)：
  Actions write権限、API `2026-03-10` のHTTP200応答にrun IDとURLが含まれる。
- [CF Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)：
  UTC起動とscheduled handlerを使用。cron変更の伝播に最大15分。
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)：
  conditional putでreceiptのclaim/CASを行い、競合時は再dispatchしない。

## 最新 main との統合（2026-10-02 JST）

- scheduler branch は clean を確認し、remote `40f5000` まで通常 FF した後、
  main `81604b5` を通常 merge した。force push・rebase・本番 writer は使用しない。
- main の通常 Yahoo 全原文 custody と単発優待 `record_date` を保持した。
  daily の予定日検証は fetch 前、株式の 21:00 UTC callback は保管/readback 後と
  各 write 直前で維持する。マクロ共通 helper は `expectedDate` と `beforeWrite`
  を両方受け、default daily の callback と scheduled-context の予定日を区別した。
- 旧 scheduler の session test 2 件も共有 raw capture helper を使い、原本必須条件を
  緩めず対象日日足の不一致まで検証する。default daily のマクロ原本 readback 待機中に
  21:00 UTC へ達する回帰では、原文保管後に macro D1 write 0 で停止する。
- Nix Node 22.22.2 / pnpm 9.15.9 で関連 10 files / **225 tests PASS**。
  scheduler / workflow / daily custody / macro / flush / Yahoo custody / record_date /
  full-import の境界を含む。typecheck、lint、Wrangler 4.101.0 の deploy dry-run も PASS。
  moneyflow selector の 14 ケースも PASS。
- 4 Cron・receipt・dispatch・期限 readcheck は既存 scheduler 差分を保持した。
  credential 発行/設定、live dispatch、PR merge、production deploy は未実施。
  CI 3 checks の最新 head での成功は push 後に別確認する。


## 最新 main との再統合・本番資格確認（2026-10-02 22時台 JST）

- cleanなPR195 head `79c41dd` にmain `0728c67` を通常merge。stock-syncの説明は
  実HTTP1秒間隔・初回429/503 STOP・全量時間未測定という最新mainの記述を採用した。
  TypeSafeの新規銘柄限定方針はmainのままで、判定や認証値は変更していない。
- マクロ共通原文保管helperへ予定日とbeforeWriteを別引数として渡す。
  sourceStop時も予定日を物理manifestに保持し、保管/readback後のD1 writeを0にする。
  定時マクロ初回429の回帰1件を追加して確認した。
- Nix Node22.22.2/pnpm9.15.9で関連11 files /264 tests PASS。その後の新回帰を含む
  daily-mode全36 tests、typecheck、対象lintがPASS。Wrangler4.101.0 dry-run、
  moneyflow selector14ケースもPASS。本番deploy・workflow dispatchは0。
- 本番Workerのsecret名を既存Wrangler OAuthで読取確認し、
  `GITHUB_ACTIONS_TOKEN` が未登録であることを再確認した。ローカル.envにも
  同名/GH_TOKEN/GITHUB_TOKENは無い。既存gh credentialはrepo/workflowを持つOAuthで
  repo限定のActions read/write tokenではなく、Workerへ複製していない。
  .envのCloudflare API tokenはWorker secrets resourceの読取権限が無かったため、
  同一アカウントを明示した既存Wrangler OAuthでsecret listのみを実行した。
- [最新株式run36930997317](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36930997317)
  は予定10/1 17:13 UTCに対し21:47:36イベント作成（274分遅配）。21:47:50のstock stepは
  時間窓guardで停止し、21:47:57〜21:48:03にfailure batch/失敗通知を完了した。
  個別株取得・全量回復の成功とは扱わない。
- [最新マクロrun36946799827](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36946799827)
  は予定10/1 21:00 UTCに対し10/2 00:36:01作成。market context stepは00:36:23〜00:36:46。
  N22510/1の確定実終値が無くHOLDし、株式・sector33・moneyflowはskipだった。
  遅配改善と一次欠測改善は別条件であり、前日値で埋めない。
- VWAP最新は上記既存`vwap-normal-acceptance-20261002.md`のrun36903916350のまま。
  全27 raw partsとsummaryのNotion物理照合が既に完了しているが、旧/tmp私有コピーは
  現環境に無い。769 written /4 HTTP200 captured未保存 /22制限 /2894 source未試行、
  5分足未起動を維持する。既知Notion原文からの再読・再解析は追加Yahoo GETを必要としない。
  Issue272実装と原文の整合を先に確認し、同runの全面再送や無条件全量取得は行わない。
- 株式旧55は10/1対象の欠測集合であり、10/2母集団・最新保存日の読取前に現残件数へ
  読み替えない。原本不足とfresh-close欠測・raw adj負値のguardを別々に確認する。
  ここでの新Yahoo/source GET、Notion mutation、D1/R2 writerは0。

## 専用Actions資格設定・Issue272との最終統合（2026-10-02 22:52 JST以降）

- ユーザーの明示承認によりGitHub fine-grained PAT
  `kabulab-cf-stock-cron-20261002`を本人のログイン済み設定画面で作成した。
  resource ownerはsatoki252595、対象repositoryは
  `satoki252595/kabulab_tool_cloudflare`のみ、Actions Read and writeと必須Metadata Read-only。
  User permissionsは0、有効期限は2026-12-31（90日）。保存済みのtoken metadata画面で確認した。
  token値はチャット・画像・ログ・shell argvへ出していない。
- 許可されたBrowser clipboardはsession内のみでOS clipboardへの転送は成立せず、
  ローカル.env保存helperは書込前に安全に拒否した。TerminalのUI操作もツールの安全制御で
  拒否されたため、迂回せずCloudflare Dashboardでproduction runtimeの
  `GITHUB_ACTIONS_TOKEN`をシークレットとして追加・保存した。
  本番ではWorker Secretsを正のソースとし、ローカル.envへの複製は行っていない。
  session clipboardは元の空状態へ戻した。
- Dashboardのproduction一覧に「シークレット / GITHUB_ACTIONS_TOKEN / 暗号化された値」を
  確認。さらに既存Wrangler OAuthと.envの型付きaccount指定によるread-only secret listを
  2026-10-02T13:52:02.290Zに実行し、同名secretの存在を独立確認した。
  secretの値は読めないAPIを使用し、値の表示も0。
- 資格のscope確認と保存は完了したが、実PATによるdispatchとdeadline readcheckは未実施。
  この設定は既存Workerへのsecret更新であり、PR195の4 Cronコードの本番切替や定時受入の
  成功とは扱わない。生成時の実clockを予定時刻へ書き換える処理もない。
- Issue272のmain `e7a3dd2`を通常mergeし、release-noteの競合は両履歴を保持して解消した。
  配当原値・過去分割/訂正履歴の実装を保持し、HTTP/auth/pacingは変更していない。
  新Yahoo/source GET、Notion/D1/R2 writer、追加workflow dispatchは0。
- 統合headのNix検証は関連14 files PASS / 1既存skip、265 tests PASS / 27既存skip。
  scheduler/YAML、daily/macro custody、Yahoo原本/spacing/日足、VWAP proof/repair/
  corporate-events/配信を確認した。typecheck、対象lint、Wrangler4.101.0 deploy dry-runもPASS。
  この検証ではネットワーク上の株価取得や本番writerを起動していない。
- Jobs API境界の必須job/step name/statusは非文字列・空値をthrowし、壊れたsteps形も
  拒否する。未完了conclusion/completed_atの正当なnull/省略は明示的nullとして保持し、
  数値などの不正な型を結果不明へ置換しない。1件の境界回帰で早期停止と未完了保持を確認。
  修正後scheduler/YAML全46 tests、typecheck、scheduler lintはPASS。
- 別途、Rootが期限付きで許可したN225単発診断だけ実施した。原本物理保管と全文readback後の
  10/2 fresh close資格はPASS。個別株/VWAP全量の正常化やD1/R2保存の受入とは扱わない。
  実clock・bytes/SHA・通信計数は `docs/test-logs/n225-once-20261002.md` を参照。
