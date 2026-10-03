# 定義済み情報の自動更新 — 2026-10-04

追跡: [Issue #284](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/284)。設定・デプロイと、原本に基づく実データ更新の成功は区別する。

## 実装した経路

- 優待: 毎月10日10:30 JSTのActionsで母集団→原文取得→派生再計算。原HTTP全バイトをgzipで物理保管・全文照合し、D1更新前の全優待行も同じ共有Notion経路へ保管する。1秒間隔・直列・再試行0、最初の取得/パース不明で後続取得と取込を停止する。
- 優待取込: 銘柄ごとの旧行削除・新行挿入・優待フラグ変更をD1の単一batchへまとめた。その銘柄の失敗では旧行を保持する。先に成功した銘柄まで全量rollbackしたとは扱わない。
- 優待要約: Mac毎日21時、既存キャッシュの固定Qwen3.5-4B/MLXで変更・未要約・契約違反の最大60群。事業タグと同じkernel writer lockを使う。落選群もcursorを進めて後続を塞がず、原文・モデル出力・適用計画の物理照合後に既存の原子取込を使う。未解釈金額・条件欠落はHOLD、保存結果が不明なら次の自動送信を止める。
- 有報本文: Notionへのupsert ACKに加え、実ページの親・全7プロパティと39項目の全文を読戻してからD1 pointerを返す。部分本文や異なるpage ACKを成功にしない。
- マクロ: 日経平均の確定終値が不足した時点で後続4取得元を停止し、取得済み原本を保管して失敗を返す。別日の値や形成中価格を使わない。
- 有報: 日付・文書ごとのD1進捗から未完を翌日に再開する。初回60日、以後は新しい日付を追加し、期間窓を過ぎた未完も残す。原日付一覧をNotion物理保管し、完了した文書のZIPと封印済み一覧は再取得しない。証券コードNULLは提出者EDINETコードと既存銘柄マスタの一意一致だけで解決し、未知・パース失敗を成功として数えない。
- 定時資格: Pythonの本番4workflowはD1/R2資格不足を取得前に停止する。TDnet失敗だけで独立した有報取得までskipしない。既知のsource GET失敗はrun内再試行0で停止し、次の通常定時実行へ回す。Notion/D1保存の結果不明は再送せず保留する。

## 現行モデルの限定品質確認

実優待の既存物理保管済みPOSTから4群を固定して確認した。新しいsource/D1/Notion通信・業務書込・有料AI APIは0。初回はモデル起動前のcache資格で停止し、その後の2回は各1resident/4生成。最終v3は2群受入、2群は選択条件の欠落としてHOLDした。全4群の意味同等・全量品質PASSとはしていない。単純固定現金額の実品質はこの4群には含まれない。

v3私有品質receipt SHA256: `ffa40dcb4fcbbdb0b2d073973929d0c3e72a0e49c4128c937ab15e31a5ed3514`。原文・固有名詞・モデル全文・資格情報はGitへ入れない。

現行数値契約`2026-10-04.1`へ同じ実PREからtaskを再発行し、元taskのversion以外の全項目・元生成bytesの不変を照合して再資格確認した。結果は1群受入/3群HOLD（選択条件欠落2＋数値未裏づけ1）。新推論/通信/業務書込0、PURE receipt 3,484B / SHA256 `551fff2355b034d6cff14bb73556d1ab46faf0d4d4642b366dcfd7d940bb7595`。既v3の4生成合計はinput 1,396tokens、output 174tokens、elapsed 3,572ms。60群の全wallclockは未計測であり、29/30分はtimeout上限として扱う。

## Yahooの限定観測

2026-10-03T16:34:28.562Zに通常の共有proxy/clientで`^N225` chartを1回だけ取得。10/2確定バーと前日終値を認定した。raw 2,946B / SHA256 `c1c1362bd2fde13eb9eb7977fc4ee3159f08afcd114d32abd72f44d44441dcbf`、共有Notion物理保管と全バイト読戻し確認済み。業務D1/R2書込0、再試行0。この1件を全APIの制限解除・全銘柄価格完了とはしない。

## 費用の判断

2026-10-04確認。既存TypeSafe設定を維持し、新しい有料AI API・モデル契約・依存ライブラリは追加していない。ローカル推論の電力とMac稼働費は未計測。

このrepoはPUBLIC、Actionsは標準`ubuntu-latest`。その実行時間は[GitHub公式料金条件](https://docs.github.com/en/billing/concepts/product-billing/github-actions)で無料対象。artifact/cache容量・大型runnerは別条件なので、実行時間無料を全請求0とは言い換えない。

ユーザー申告のWorkers Paidを前提に、[Workers公式料金](https://developers.cloudflare.com/workers/platform/pricing/)は月1,000万request・3,000万CPU msを包含し、超過は100万requestあたり$0.30、100万CPU msあたり$0.02。[D1公式料金](https://developers.cloudflare.com/d1/platform/pricing/)は月250億read/5,000万write/5GBを包含し、超過は100万readあたり$0.001、100万writeあたり$1、GB月あたり$0.75。

今回の追加処理は既存定時取得への接続・日次最大60群と5分の新規開始予算で制限する。完了済み原本の再取得を避け、優待の物理ファイルは取得バッチ単位にする。大きな追加費用は見込まないが、アカウント全体の当月使用量・請求明細・保存容量を実測した結論ではない。包含枠を超えない保証や請求0の断言はしない。

既存価格全量は3,689銘柄なら日経平均1＋Chart/QuoteSummary各3,689＝7,379caller。1秒間隔の最低待機だけで約123分、原本保管等を含むwallclockは未実測。平日22日なら約16.3万callerという計画値はWorkers包含requestより小さいが、proxyの認証内部通信・他サービスの使用量は別。週末や同日manualの重複全量を追加して費用・API負荷を増やさない。

## 本番受入と残件の境界

この文書作成時点では新PRのmerge/deploy、0027適用、新しい優待LaunchAgentのbootstrapは未受入。実行結果は下へ追記する。

0027適用前の本番`sqlite_master`照会は表/索引0、D1 `rows_read=84 / rows_written=0 / total_attempts=1`。このDBの`size_after=458,010,624B`を観測した。必要なActions Secretのキー名は全項目存在することを確認したが、その存在だけで書込認証の実成功を主張しない。値の表示・資格設定変更は0。

統合WTのPython全suiteはNix/locked依存で1,527 PASS / 73 SKIP（既存実fixture未取得）。Ruff PASS、Worker dry-run bundle PASS。skipを取得元の実受入へ数えない。

公式年次書類を観測できない銘柄、未公表JPX月次ファイル、取得元のNULL/429、資格不明な要約はHOLDとして残す。既存の年次未観測22銘柄を「未提出」とは断定しない。定時dispatch/readcheckの新設定後の実成功は次の平日に別途確認する。

価格全量の正常入口は実UTC日と日経平均当日確定バーを要求する。10/3・10/4の週末を10/2へ置換して取得する入口はない。次の既存株式Cronは10/5 17:13 UTC（10/6 02:13 JST）、業種・資金フローを含む終了判定は10/5 21:00 UTCまで。マクロは10/5 21:00 UTC、readcheckは22:05 UTC。dispatchだけでは受入済みにしない。

## 本番0027の適用

2026-10-03T18:02:06Z（10/4 03:02 JST）、レビュー済みCREATE2文だけを1回適用、exit0 / success=true。実行receipt 915B / SHA256 `16c97a1f520ab53c5a5b875db2aa01c3e305100a31993424a0dce9a2d7279208`、D1 read3/write4（DDL内部）/attempts1。既存業務行のUPDATE/DELETEは0。

18:03:15Zの読戻しでCREATE全文、実11列、PK(scope,date)、索引(scope,finished,sealed,date)がSQLと一致、進捗表の初期行数0。POST receipt 4,770B / SHA256 `dbbc7f13a7afc9ace9cb319eaed6be6f7c6038837d59c5ff3ec15e587d521c33`、read87/write0。各時計はCLI受信完了を観測したもので、HTTP packet時計はUNKNOWN。新コードの通常catchupによる進捗生成は未受入。

優待要約の既存pending markerは最初のNotion保管より前に保存する。原本保管の結果不明でも翌日の新UUIDによる再生成・自動再送を止め、更新0件を含む正常物理閉鎖後だけ解除する。対象14テストで確認した。

最終統合検証はTypeScript 271 suite / 4,514 PASS / 433 SKIP（既存fixture条件）、typecheck・全体ESLintと変更scriptsのESLint・監査生成物check・Drizzle再生成no changes・Worker dry-run PASS。全体検査で検出した2件の旧test契約不整合を修正し、保存済parse_error/NULLの保持と新しいマスタ存在照会の公開列境界を確認した。SKIPは実データの受入に数えない。

## PR285反映後の真正通常処理

[PR285](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/285)は18:15:57Zにsquash merge、main `8de6525dfcbf9b9c3298c77d5e9b66601042055e`。PRのcheck/python-pipeline/Workers Buildsとmain CI37143541922が全成功。mainのWorkers Builds `a298b60f-8d77-4bbc-af37-b3ff97098168`のGitHub check原応答に同SHAとversion `79bfcaf4-6215-4d98-bcfc-e8e2ddbda20a`を明記、native deploymentsで18:16:33Z作成の100%配信を確認した。check原応答SHA `7070f17c1882aeb5c74859f691b300443ab2f64ef6ec21395b642f4fb1f200cb`。Macも同main/clean/.env0600 accepted revisionでpreflight PASS。

0027のPRE/適用/POST・SQL原文等9membersを共有Notionへgzip実体保管し、全member/hosted bytesとmanifestを照合した。4,605B / SHA `df7b1fa077a031f1ef61c323b1b31a039a283aa53641073045a9d608eb4e09d7`、Notion8/hosted1、18:12:29Z closed。source再取得・D1業務書込0、pre/CLI内部HTTP時計UNKNOWNを維持した。

[通常マクロrun37143967756](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37143967756)はmain8de/target=context/定時日付指定なしで成功。5源caller（Yahoo4＋VI1）/raw105,041B、同世代の5原本＋manifest全bytes/SHA一致、共有parser/確定バー/VIの通信0 replay、2026-10-02のD1全11列一致を独立確認した。未対応topixTurnoverRatioはNULL。独立readbackはNotion2/hosted6/D1SELECT1/source0/write0/retry0、receipt761B / SHA `4ab6bc6fb8ac6eebb85d5aea498c784f4bc61dca833c18915d72616c62d55163`。定時CF発火や全株/VWAPの受入とは区別する。

[初回通常有報run37143803966](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37143803966)はmain8de、セットアップ・共通設定step成功後に初期処理で失敗/CLI exit2。原本取得開始0、POST進捗0行/snapshot0/inFlight0/pending0。生成SQLはDrizzleの既定値もbindされ、1行7個・40行280個で[公式D1上限100](https://developers.cloudflare.com/d1/platform/limits/)を超えていた。10行70個へ分割し、全生成SQLのparams<=100と60日seed・同日再入INSERT0をSQLiteで確認した。内部の元例外本文がCLIに残らないため、生成SQLの根因修正とGH Secretの実権限成功は分けて扱う。失敗run/2実D1読取など37membersは共有物理保管・全文照合済み（gzip40,404B、Notion8/hosted1）。修正後の通常runは未実施。

Mac優待要約21時LaunchAgentを18:29:19Zにbootstrap、通常runは18:29:20.542→49.141Z。14群選択/3群受入/11群保留、pending14→11、1resident/14生成、再試行0。有料AI・source新取得0。原本/計画PRE4,750B SHA `2d3aaf7e967d67568debabf4a50e20b5243deff6409af39e23ede25c9e5cded0`と8,182行POST494,892B SHA `02fcd5c22d13cd57a4ad4caa6775356c871bbaaf0aec1831cb5bc9ca7c956b1f`を物理保管・全読戻し後にmarkerを解除。partial_rejectionによりexit1を返し、11群のHOLDを成功化しない。意味・数値の保証は判定契約の範囲であり全量品質PASSではない。

この時点で優待source全量は未開始だった。全HTTP原本文をRAM配列へ保持して最後にJSONL joinしていたため、Nodeの文字列上限到達時に保存前の喪失が起こり得た。各受信応答を次GETより前にwx0600 JSONLへfsyncし、終端はstdlib stream gzipで共有物理保管する。個別HTTP bodyと共有upload向け圧縮bytesはRAMを使用するが、全量base64配列/joinは除去。失敗時も私有JSONL/gzipを保持し、源の再取得で復元しない。GET間隔・再試行0・原子取込順は維持した。

## PR287後の通常処理と数値単位の修正

[PR287](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/287)は18:45:40Zにmain `f0610f415c4236beab2162ccddc39c0d65bde5e1`へsquash merge。PRとmain CI37145418129の全CI成功、同mainのWorkers Builds `cd78fd9e-e6c7-40e5-a6ce-41abeda944ec`がversion `d3f7fffb-2ff0-4295-a781-572e53af03d4`を明記し、18:46:08Zのnative deploymentsで100%配信を確認した。Mac通常入口も同main/clean/.env0600、accepted revision一致のpreflight PASS。

[修正後の通常有報run37145531123](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37145531123)は同mainで18:47:31→18:52:41Z。初期60日登録成功、20日分の一覧を取得、60文書は既存保存済みとしてZIP再取得0。19日完了/20日封印、41日未処理、identity_unresolved1、inFlight0。cap/pendingでCLI exit1を返し、完了扱いにしない。20一覧の全gzip/元bytes/SHA/日付/件数をNotion20/hosted20で精密読戻し、追加publisher取得0。運用原証跡188members/361,657Bを141,389B gzipとして共有保管・全member照合した（Notion8/hosted1、SHA `5a9b862a4d686f5e1f87a2a6c136cf98c551e18b23be13012efdcce95496e454`、complete receipt317B / SHA `f782825a9cfa317c5be411eb9d3487042f384c1acee0b2db1fc88c66bbd0e04f`）。残日付は既知capから通常入口で再開し、結果不明の自動再送はしない。

優待要約の通常14出力を原task/version以外の全項目・元protocol bytes不変で`2026-10-04.2`へPURE再資格確認した。原文と同じ「日」「か月」を認識し、期間「か月」を権利月「月」や換算から補わない。旧3受入→4受入/10保留（選択条件1＋数値不一致9）、受入対象6行。ほかの株数不一致がある群は引き続き保留する。再推論・通信・業務書込0、receipt2,676B / SHA `bc544be69abcf55914dba4f98b7502aed74ea8572a580513e7a68c780da65361`。これは修正規則の再資格であり、4群が新たに本番更新されたという意味ではない。関連3suite101 PASS、typecheck/対象ESLint/diff check PASS。

同mainの優待source通常入口は18:55:43.452→18:57:51.827Z、1回実行/再実行0、87応答（HTTP200×86＋404×1）で停止。詳細取得・D1取込・推論0。原body19,081,162B、private JSONL25,457,299B（SHA `33fc7308f6cab542f935f76f871e422c37c985d8f928a2edf483023911b36eda`）とgzip5,029,560B（SHA `1d8d73f9c173d459bb5a089f4a3c9dd78ab26aa5b4cdc4fd51510810c0e047fc`）を保持。共有保管後、独立Notion query1/hosted1の全文・メタデータ・manifest照合も成功、closure receipt1,135B / SHA `300a617bfd8d6fe9deabe8fb2c43b141e8115601b52d65e00b67e4621b9770eb`。保存原本の通信0解析で、1ページ目は検索トップ、46リンクは推薦等で検索結果ではなかった。2〜86ページの正式一覧には全1,711件・current・next/disabled終端が存在する。末尾86のdisabled nextを見落として87を取得したことと、推薦欄の誤採用を共有一覧解析で修正する。404や構造不明を空一覧として扱わない。

厳密一覧解析のhead957bdf9で、保存済み2〜86の85ページの全current/next・20件/最終11件/total1,711をPURE照合した。元1ページ目・HTTP404は受理0、私有receipt19,553B / SHA `960e7a6415165323b491bf69c4d9079a6bf0bbfe94f8b631a896ce8a526cba57`。対象17tests/typecheck/ESLint/diff check PASS。公式GETフォームの空keywordを明示したURLも、限定1GETでHTTP301/body0Bを観測し、後続redirect GET0で停止した。原応答gzip176B SHA `7689671eceec3d2424ffcd580a11bd1342255b95da49358baeed3e0c6d4d018c`は共有実体保管・全読戻し済み（Notion8/hosted1）。この観測でLocationは未捕捉、一覧資格は未成立。源の完全一覧復旧はまだ受入せず、新しい解析は検索トップの時点でD1取込前に停止する。

掲載済みの正式な並び順パラメータ`order=yutai_yield_desc`を絞込なしで要求する新URLを、別の1GETだけで確認した。19:25:28.018ZにHTTP200、最終URL一致/redirectなし/LocationNULL、正式検索領域・現在1ページ・全1,711件・一意20カード・同orderを保持する次ページ2リンクを認定した。原body211,293B SHA `26451da8cdec074214ee0930e020b5b525fddc14bf6eff0e1270948272a36665`、原応答gzip56,981B SHA `e648e6becb129816fef8f597cc2a50151dad962d30bc5a8ee6a11fb84a602476`を共有実体保管・全文照合（source1/Notion8/hosted1、D1・推論・retry0）。資格receipt925B SHA `2c8ea7068c92da5093846f2c3678a0ab3820b72e598f9be9bfe88b4f766e9279`。正式入口をこの並び順指定へ修正し、ページ送りも同条件を検証する。これは入口の実資格であり、後続全86ページ・全詳細・D1全取込の受入は通常処理で別途確認する。

最終解析は同orderの次リンクだけを受理し、別origin・条件付きquery・重複page/orderを拒否する。旧bare-pageを通す切替は本番コードに残さず、85ページの証明は上の歴史headに限定した。最終module SHA `2bec97e1dd635034b190dd22c10cdf08ca6503374c2602f5618c5bf713540184`で実order付き1ページ目の同bytesを独立再解析しPASS（source0、750B receipt SHA `8fa5099e4a6d9c00e5994f6066f6f2af29822d730738db9bda812fa2aa3d8753`）。対象18tests/typecheck/ESLint/diff check PASS、default入口とmainの両方の取得URLを回帰検証した。
