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

価格全量の正常入口は実UTC日と日経平均当日確定バーを要求する。10/3・10/4の週末を10/2へ置換して取得する入口はない。次の既存株式Cronは10/5 17:13 UTC（10/6 02:13 JST）、株価stepの完了期限は10/5 21:00 UTC、株価readcheckは21:05 UTC（10/6 06:05 JST）。業種・別moneyflowを含む全連鎖成功は別受入である。マクロは10/5 21:00 UTC、完了期限22:00 UTC、readcheckは22:05 UTC（10/6 07:05 JST）。dispatchだけでは受入済みにしない。

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

## PR288反映後の全量停止と既定順の確認

[PR288](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/288)は19:43:58Zにmain `25ec36513f9249ff3d1ba44d61460c7b5d5db774`へsquash merge。最終head83a8219の3CI成功、同mainに結合したCF version `39067a1c-ac6d-4dca-8467-f78294d02bff`の100%配信とMac通常入口のpreflightを確認した。

利回り降順の通常全量取得は19:47:58.867→19:50:08.474Zに1回実行し、一覧86応答すべてHTTP200、掲載1,711件・実カード1,711件だった。一意銘柄は1,684件で、ページ間重複27件により全件数照合で停止。詳細取得・D1取込・推論は0、再実行0。原body18,201,648Bを逐次保存し、JSONL24,286,441Bとgzip4,767,551Bを共有物理保管した。独立Notion query1/hosted1で全bytes・metadata・manifest一致を確認（gzip SHA `db9adec6bdce274bdc6e4c91ac3812bd9e65076e676d964c18f25b31a96c70b8`）。取得済み86応答を同じ正準解析で通信0再生し、全件数不一致の停止を再現した。利回りの同率やcacheの具体的挙動は断定しない。

保存HTMLに掲載された[公式JS](https://minkabu.jp/assets/jsbundling/application-473418caf8de27216b70573e1aefe823c2d433836822568e3cb146afeda76516.js)を1GETで確認。並び替えの未指定optionは空値で、公式handlerが`order`へその空値を設定する。未掲載のコード順enumは推測しない。この正式操作による[空orderの1ページ目](https://minkabu.jp/yutai/search?order=&page=1)も別の1GETでHTTP200、最終URL一致・LocationNULL・現在1ページ・全1,711件・一意20カードのコード昇順を認定した。次リンクは`/yutai/search?order=&page=2`で、空orderを明示保持する。JS原body1,848,236Bと一覧原body221,532Bは各々共有gzip実体保管・全文読戻し済み（各source1/Notion8/hosted1、D1・推論・retry0）。一覧原body SHA `3db70c306c4e464a41184df4893a89f5336c8d3683cf40da84a188a12d037ff4`。

新しい先頭20件と旧bare2〜86の1,691件は、保存原本だけの比較で計1,711件・重複0・全体コード昇順が一致した。異なる取得時計の資料比較であり、新しい通常全量取得の成功とは扱わない。次の修正は公式の空orderを取得入口とページ送りへ明示し、全件数・重複・不明時停止の検証を維持する。修正後の全詳細取得・D1全取込の受入は未実施。

同mainの契約2026-10-04.2でMac優待要約を20:09:45.990→20:10:12.732Zに通常1回実行。選択11群・受入1群1行・保留10群、未要約11→10、モデル11呼出/1resident、source・外部有料API0、終了は部分保留によるexit1で未知書込みmarkerは残らなかった。独立PUREで11群の全task・受取14行・現行guard・全POST8,182行のUnicodeを照合し、1行だけ更新、残13行の全項目不変、原金額NULLを確認。HOLDは選択条件不足1群・数値未根拠9群。PRE/POSTのhosted原bytesも全文一致（独立Notion2/hosted2）、追加推論0。PURE receipt SHA `855a4c2cffde25b3f04cc81bd712522477cba27b1b8263037459abca995774b7`。この監査の更新前原文は選択14行に限定し、scope外全行のPRE/POST独立一致は主張しない。

## PR289反映後の通常取得停止と有報1文書の修復

[PR289](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/289)は20:23:56Zにmain `9d0c75fd18a39fb9180dfe0095d09a7c2ed6f422`へsquash merge。PRと[同main CI37151392836](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37151392836)の全CI成功、CF version `151b2f7e…` / deployment `ff34581d…`の20:24:24Z・100%配信を確認した。公式の空orderによる通常取得は20:25:56.266→20:28:56.743Zに1回実行し、一覧86＋詳細33の119応答がすべてHTTP200。一覧1,711件は全件一意、詳細32件を解析後、1766の権利日「随時」1件で停止した。該当DOM表の先頭2spanにある掲載値であり、regexの読取失敗ではなく、月1〜12を要求する現行形式の未対応である。他表の月を代入せず、不明・未対応を優待廃止と扱わない。随時の保存表示・年利回り除外かHOLD維持かは方針未決定で、コード変更・D1取込・再計算は0。原応答gzip6,764,077B SHA `5224b82d995703fdfef00466a896ffc01760b090c312412a9acee6744daa2feb`を共有保管し、独立Notion1/hosted1で全文照合した（closure receipt1,242B / SHA `f1705390c5b9c3026e7b8bef7f0fb22e1e8d2296df62ee3d45da59f54ed04e56`）。

有報の通常run2〜5は保存一覧と進捗からcap範囲で続行し、run6後の台帳は完了181文書・未完17日・識別保留7件・inFlight1文書（S100Z2Z6）だった。該当文書の署名付き保管URLから2原本を全文/SHA・ZIP CRCで確認し、本文の7属性は一致したが、35節の原文50,206文字に対して保存本文は50,205文字でU+200Bが1文字欠落していた。厳密な本文照合で停止する不一致を確認した一方、元runが投げた例外classと正確な停止phaseはUNKNOWNを維持する。修復前の51membersを997,005B gzipへ実体保管・全文読戻し済み（Notion8/hosted1、SHA `6aeb5d8122c7868b508efac94911bb132e57320ef4fd4b60d7907d6127088785`）。

20:33:29.518Z、同文書だけを可逆v2へ再保存し、全35節・50,206文字を原文と完全照合した（Notion6/D1 3、原本再GET0）。本文pointer更新とcompleted1件追加・inFlight解除を原子的に確認し、本文索引・受注/海外財務値・タグは不変、修復前の全PREも保持。50membersのPOSTを211,256B gzipへ共有物理保管・全文照合した（Notion8/hosted1、SHA `a65ac815a190e016e782495015e65d6f38edf400a6cd022479623349e5e514ad`）。20:40:33.207Zの全台帳読戻しはcompleted182・inFlight0・未完17日・識別保留7件。[通常run7 37152437318](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37152437318)は同main9d0で再開したが、catchup全体の成功はまだ未観測。旧失敗の例外class/phase UNKNOWNは修復結果で置き換えない。

同mainの通常run7はknown cap・完了204文書となり、新規一覧6件の実体全照合後、[run8 37153006869](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37153006869)へ続行した。run8もknown capで完了231文書、保存一覧50・識別保留7・未完11日・inFlight0。既受入50一覧の再GETは0。[run9 37153551324](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37153551324)はS100Z3BY（9/24）の開始後にCLI exit2で停止、21:04:13Zの台帳は完了237・inFlight0・未完11日・識別保留7。該当時刻・文書の失敗HTTP保管検索は1queryで0行で、受信前の源GET失敗と整合するが、元class/phaseはUNKNOWNを維持し、追加dispatch・源再取得は停止した。

「随時」は原文どおり保存・表示し、年間回数を推定せず年間利回りと月別カレンダーから除外する。0は明記された随時専用の内部enumで、不明月や単発日との混在は拒否する。JSSは実月と非定期を区別し、モデル契約2026-10-04.3は0月を拒否する。保存済み33詳細のPURE再解析では33件受理・既存32結果不変（新規source/DB/model0、receipt SHA `a5ffe9629a32b42e608f49d0b5b9f6a0aca1e534b69d46a3b67ed58b9adfff97`）。関連212テスト・JSS12テスト・両型検査・lint・Python ASTはPASS。全量詳細・本番取込は反映後の通常処理で確認する。

既存有報本文の全文不一致は、未送信の既存行・全7属性一致・native全頁の完全な形式と原文を確認した場合だけ`text_readback_mismatch`へ保留し、後続文書を進める。本文を自動forceせず、新規保存・通信・native形式/件数不正は未知の停止を維持する。関連93テストとlint PASS、追加したlegacy見出し/件数不正の反証を含む3suite71テストもPASS。

## PR290と連携APIの本番反映

[PR290](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/290)は21:18:21Zにmain `c210b8f22eb5378620d1c43039a3e7af4cf9dd71`へsquash merge。PRと[同main CI37154637238](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37154637238)の全CI成功、GitHub checkで同SHAに結合したCF version `86db73c4-00b0-4195-be4d-dcdaf5e33945`をnative deploymentで21:19:03Z・100%配信と確認した。Macも同main/clean/.env0600/accepted revision一致でpreflight PASS。

JSS privateは独立した既存Workerのため、同mainから既存設定・依存・秘密設定を保持して別途1回デプロイした。21:26:43Z作成のversion `596ecada-3922-4ecc-af60-b96bc86f95e8`を100%配信、全bindingのPRE/POST一致と21:31:57Zのhealth HTTP200を確認。新規Worker・秘密値の読出し・取得元問い合わせは0。healthは随時の実優待行を認証付きAPIで返す受入の代わりにはしない。

有報run2〜9の原ログ・台帳・物理原本の参照等709membersを共有Notionへ実体保管・全文照合した（gzip1,108,595B、SHA `f4d30143d5a8d070d840e97a265a98c9aa50f890e3ebf21160a7f3443bbabb58`、21:23:12Z closed）。既存原本は再取得せず参照を保管した。旧run6修復PREには保管URLから確認したCSV/XBRLの2ZIP実体が含まれているため、物理原本の重複が0だったとは扱わない。publisherへの追加問い合わせは0。

地方2銘柄は福岡証取の公式個社・月次一覧等とJPX公式一覧の計8応答を実体保管・全文照合した（gzip603,743B、SHA `6d038c9da83649750b7018686d627e0c688b0c1abdb097a65b5bcd69a8105c34`、21:34:58Z closed）。3824/353Aの証券コードを実提出一覧の書類へ直接結合できるが、JPX側の現ファイルは8/31基準で両銘柄は未収録。21:39:23Zの本番3SELECTでcore/eventとも対象行0、overlay適用日は10/1だったため、現在10/4の資格は未成立として補完を保留した。正常overlay完了時の`held_listing_codes=NULL`は既存仕様だが、この古いstate単体から現在の保留なしを推測しない。業務書込・再queue・原本再取得は0。

## 将来の期間表記と1株優待の根因修正

22:01:31Zの正常overlay入口は、公式3GET・Notion17・hosted4・D1 SELECT3の全27応答がHTTP200で、DBbatch0のまま解析停止した。JPX市場変更の実1行が`2026/10/20 ～ 2026/10/22`という将来期間だったことが原因。3原HTMLとincomplete manifestの実体4添付を保存原本と全バイト照合した。単日を選ばず、両端が実在日かつ開始が適用日より未来の場合だけ原期間・銘柄・市場を別の未確定予定へ保管する。境界を跨ぐ期間・無効日・逆順は停止を維持する。保存実48行は単日47行の全項目不変＋明示保留1行としてPURE受理、関連64テスト・型・lint PASS。旧STOP/10月1日stateは書き換えていない。

地方2銘柄の補完は、価格対象を増やす操作と開示取込用のID登録を区別する。既存契約の`inactive＋instrument_type=NULL`による登録には、JPX overlayが現在まで正常commit済みという条件はない。保存3HTMLの正準tableと全コード（廃止137・新規46・市場変更48、将来期間行も含む）に両コードが無いことをPURE確認した。前段の現在日gateは私有readerが加えた過剰な条件だったため登録資格の必須条件から外す。価格・優待のactive普通株母集団や旧stateを推定で更新する資格ではない。

優待の通常取得は22:04:50.271→22:10:38.968Zに1回実行、一覧86＋詳細126の計212応答すべてHTTP200で、2337の明記された「1株以上」を2桁以上を要求する正規表現が読み落として停止した。取込・モデル実行・再実行0、unknown markerなし。原body40,236,217B、JSONL53,686,801B（SHA `347bacadafad70545ebde23132b65e7aa127a915a6082b0b130d834c8f90eb0c`）、gzip11,733,244B（SHA `2f6abbe426cf58c4c3c572d441debd9ee71c2d5b285aa90fdbdf7063e9336dc4`）を保管し、独立Notion query1/hosted1でmetadata・manifest・全bytesを一致確認した（receipt SHA `5240855792227ae374557cf23347de70549463379e50be5f979f5c186ffbc33e`）。

共有株数解析を1桁にも対応させ、セル先頭の整数・正しいカンマ区切りを厳密に確認する。0/安全整数外/小数/負数/不正カンマはUNKNOWNとして停止する。停止時は銘柄コードと固定理由をログへ残す。保存126詳細のPURE再解析は126受理、旧125内122件は全結果不変、1518/2001/2168は従来落ちた1桁条件各1行だけ追加し、従来採用済み全行・その他項目は不変。2337は1株と原月・本文・備考が一致。関連21テスト・型・lint PASS、PURE receipt SHA `1473d74ed6cfec880f4342e9b7459134000793b4e360c8fe926195b3b65b1f0c`。全1,711詳細・本番取込は未受入。212応答の受信区間341秒から源1797callerを単純外挿すると約48分であり、原本保管・原子取込・再計算の余裕を確保する次検証の上限は90分とする。実完了時間の保証ではない。

有報の22:03:40Zの再開前確認はGH main1・重複run1・D1全台帳SELECT1のread-only3通信で、main c210/重複0/inFlight0/completed237/未完11日/識別保留7を確認した。既存内部の例外分類はCLIが例外objectを捨てる前に行われ、既知の源取得失敗だけmarkerを解除する。保存済み9/24一覧から通常入口で再開できる一方、元run9のclass/phase UNKNOWNは保持する。追加dispatch・publisher問い合わせ・業務書込は0。現定時は平日20時JSTで、10/4日曜の定時は定義されていない。

地方2銘柄の開示ID登録は22:35:48.780Zに正常完了した。直前の対象core/event/stateの3SELECT、原子batch1、対象全11列POST1の計5応答がすべてHTTP200。3824/353Aの実名称・福岡市場を`inactive＋instrument_type=NULL`で2行新規登録し、全11列を照合した（POST SHA `dec8a8bb1d7d257871f776c32bd3816592347385b1f766532820fec612874baf`）。D1の物理rows_writtenは各INSERT4・合計8で、論理追加行数2とは区別する。旧core・JPX state・価格・優待・事業タグ・台帳は変更せず、再queueは別途確認後に行う。

## PR294と限定再開の本番観測

[PR294](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/294)は全3CI成功後、22:57:10Zにmain `e03f39d2b565698a6ac5ff3e8758a7befb9a26fd`へsquash mergeした。同SHAのGitHub check111311933207はCF build `8d812708-93d2-439c-a5a5-fe2be387a0c0`・version `501f8dee-efe5-4c9f-8d19-bda7f6be56c6`へ結合し、native deployment `3e571ab8-acd9-40b1-a752-aa4f464c70db`を22:58:17Z作成・100%配信と確認した。[同main CI37160154433](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37160154433)も全ジョブ成功。Mac runtimeも同main/clean/.env0600/accepted revision一致へ更新し、取得前preflightは通信0・業務書込0でPASSした。

地方2銘柄登録の5通信と全PRE/POST等29membersの運用束を22:51:05Zに共有Notionへ実体保管・全bytes照合した（gzip23,585B、SHA `38720ce7cb507e4603d464b1d35906fa7bcf1acffbc2b6ac67dc0b570e307a8c`）。8/26・8/28だけ既存`saveProgress`のfresh11列/CASで`pendingCheckedDate=NULL`へ戻し、revision+1/updatedAt以外の全9列・保留7件を保持した。22:55:12Zの6D1応答は全200、2更新それぞれrows_written1、全POSTはCAS応答と一致。再queue運用30membersも22:58:15Zに実体保管・全文照合した（gzip11,188B、SHA `9aff7a35b05222918be78f2030ee6d1f115cd337f3e70a081fdc17726c102d8c`）。登録・再queueは受理済み有報書類を取得済みにする操作ではなく、通常取得で改めて確認する。

有報の[run10 37160447949](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37160447949)は同mainから23:03:00Zに開始し、22通取込・既存1通確認で処理量上限に達した（list/ingest errors0、elapsed387.317秒）。23:10:58Zの全台帳はcompleted260・未完10日・identity保留8・inFlight0。新しい提出一覧1件は23:11:16ZにNotion1/hosted1の全量照合、旧50件の再GET0。元run9でclass/phase UNKNOWNだったS100Z3BYは、今回の通常入口で原本・本文照合・本文ポインタの3段階応答が確認できた。元UNKNOWN履歴を成功へ書き換えてはいない。

JPXの正常overlayは23:13:03→23:13:14Zに公式3/Notion17/hosted4/D1 SELECT6・batch1の計31応答すべてHTTP200で、一次4原本の全文照合後に28 statementsを原子適用した。適用日は10/4、held listingはNULL、core変更0。私有検証のPRE guard.state配列と正準POST.state objectの取り違えで、保存後のlocal predicateだけがSTOPした。再取得・再送は行わず、元STOPを保持して実全PRE/POSTを比較し、全3,824 coreの11列・FSE2行は完全不変、230 eventの意味項目とIDは不変、原本に結合した観測時刻・archive key等だけ更新、state全10列がcompiled入力と一致と確認した。単日未確定の将来1期間は物理manifestに保管し、日付を推定してeventにしなかった。運用POST束は後でまとめて保管する。

[run11 37161524529](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37161524529)は19通取込・既存2通確認、[run12 37162084451](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37162084451)は20通取込・既存2通確認で、両方とも既知の処理量上限・list/ingest errors0。23:40:19Zの全台帳はcompleted303・未完7日・識別保留10・inFlight0。run11の新一覧3件はNotion/hosted各3で全量照合、run12の新一覧0件と旧54件のdescriptor一致を確認し、旧原本の再GETは行っていない。

[run13 37162563263](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37162563263)は20通取込・既存4通確認、[run14 37163084183](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37163084183)は19通取込・既存4通確認。両方とも既知の上限・list/ingest errors0。23:59:35Zの全台帳はcompleted350・未完5日・識別保留20・inFlight0。各新一覧1件の実体をNotion/hosted各1で全量照合し、保存済み56一覧を保持した。優待取得と書込みを重ねないため、run15はまだ起動していない。

## 優待の株数1列表による停止と修正

同mainの通常優待取得を00:00:29→00:25:05Zに1回実行した。一覧86ページは今回の公式全件数1,707とunionが一致し、重複0。前回1,711件との保存原文比較は追加0・削除4（3670/4171/9223/9914）、残存コードの順序も一致した。実受信874応答は全200で、一覧86＋詳細788。詳細787件は正常だが、末尾5283だけ`no-benefit-tables`で停止した。Phase3/DB取込0・モデル0・再取得0・未知書込markerなし。予測値1,711を今回の受入件数へ置き換えてはいない。

原応答はHTML計151,844,250B、JSONL202,614,985B（SHA `96ac0c4f4b9ddfb710c3dfa471fbd2ef463ab708069ff566d3a4c4bc3703ba20`）、gzip47,182,015B（SHA `7b79a6bdca9e94078855944a272d81f4acee237c35aac27a21b31be466818a8c`）。共有原本保管後、00:34:55ZにNotion1/hosted1の全200・全metadata/manifest/全gzip bytesを独立照合した。原取得UTC00:00:33.847→00:24:48.222、元UNKNOWN・未完状態を保持する。

5283の保存原文には、h3の`なめ茸「志賀の郷」`、権利月6月、正式な必要株数1列・200株以上が明記されていた（body165,331B、SHA `f2e4911dd575b69284443c2f5563b1bf118b72930dd692f562d6787a59cb622a`）。共有解析が2列未満を除外していたため、この明記された1列表だけ見出しを優待内容として採用する。月・見出しの欠落、正式headerでない表、列数不整合、株数不正はUNKNOWNを維持する。実原文抜粋を使う回帰を含む22テスト・全型チェック・対象lintがPASS。全量取込はまだ未受入。

独立した全原文PURE比較では、旧正常787ページ・5283だけUNKNOWNから、修正後は788ページすべて正常となった。旧優待2,464行の全tupleを順序付きで保持し、全他fieldも一致。追加は原h3・6月・200株を持つ5283の1行だけ。TS ASTが復元した回帰fixtureも同原bodyの連続抜粋と完全一致した。追加通信・DB書込・モデル利用0、元source STOPは成功へ書き換えていない。

[PR295](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/295)は全3CI成功後、00:43:48Zにmain `bcce32a6ff683892b6db1bd64ba7e352a02d33b2`へsquash mergeした。[同main CI37165835877](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37165835877)も全ジョブ成功。GitHub check111328511145の同SHAからCF build `6eb42f7f-041c-43ff-bcbe-3f83759c4335`・version `7428571c-4788-4605-abf6-ad5e610956a0`を特定し、native deployment `467b7457-8f08-47c7-8af6-7ca10d051845`は00:44:24Z作成・100%配信と確認した。Mac runtimeを同main/cleanへ更新し、writer kernelが空いている間にcanonical .envのaccepted revisionだけを原子的に置換した（0600、他bytes不変）。preflightは通信0・業務書込0でPASS。全量優待取得の受入は次の通常処理で確認する。

地方市場4銘柄の資格確認には、既存のFSA・提出一覧原本に加え、福岡・札幌・名古屋証取と会社公式の7応答を用いた。全7応答はHTTP200・追加再試行0、52membersの341,406Bを97,796B gzip（SHA `3b8c1a6c088222d2e51d725fbd82c77aeafeca3a123f2152f93a312d8408a352`）へまとめた。00:48:19Z、共有Notion8/hosted1の全metadata・manifest・全gzip bytes一致を確認した（closure receipt SHA `825addc9adc024da467f5d2da1b120d54e94ba3cea7fb76fb5bb16a762f38f67`）。公式名称・市場・コードの根拠は1999/3808/2172/624Aに一致するが、この原本保管だけでは登録・有報取得済みとは扱わない。

00:58:03.681→00:58:04.340Z、直前3SELECT・原子batch1・全11列POST1の5D1応答すべてHTTP200で、同4銘柄の開示IDを新規登録した。実ID18170〜18173、公式名称・市場、`is_active=0/is_yutai=0/instrument_type=NULL/sector=NULL/sector33=NULL`を全項目で確認した（POST892B、SHA `c9f9ad5a1e6d8fb2e4bd3dcdebbace44b6510d9200676a6a1d64e1c49fbdad16`）。旧core/state/eventの変更・源再取得・Notion追加・モデル呼出・再試行0。保存済み5原HTTPの独立照合もPASS（receipt SHA `b2cc8398fb2b4adf40f33beb96aa4b759334603d97e4ed5308c92a296737e5eb`）。有報の取得完了とは区別し、運用PRE/POSTは最終の一束へまとめて保管する。

01:01:11.122→01:01:11.978Z、9/28・9/29・9/30のfresh3読取＋既存`saveProgress` CAS2＋全11列POST3の計8D1応答すべてHTTP200で再判定を準備した。finished/sealedで同日再確認済みの2行だけpendingCheckedDateをNULLへ戻し、revision+1/実updatedAt以外を保持。9/30は未finishedのため全文不変・更新0。全pending/completed/snapshot/finished/sealedは保持し、独立した保存8原HTTP照合もPASS（receipt SHA `aa14967ecf1792224e2bc4e1e19130942da39ef5a0358613743fa5f4963dc345`）。日付単位の再確認なので、同日の他の保留文書も通常の再判定対象となる。有報の原本取得成功は後続の通常runで確認する。

同mainの新しい全量優待取得は01:02:22→01:08:51Zに1回実行、一覧86ページの実1,707銘柄は全件一意だった。詳細160件を正常解析した後、2533の源GETでHTTP503を01:08:44.507Zに受信して停止した。全247応答はHTTP200×246＋503×1。Phase3/DB取込・モデル・再試行0、未知書込markerなし。JSONL61,392,776Bとgzip13,579,659Bを保持し、終了receipt SHA `efbe8262941a35c5262e9d1d04057988b6070a1ac0aa4044c0dafea59663017a`を記録した。旧全量未完と今回の取得元停止は保持し、新しい原文全量・「随時」「1株優待」の本番保存表示・契約.3要約はまだ受入済みとしない。503の詳細本文・実体保管の独立照合は後続で確認する。

保存した503本文4,642B（SHA `73a2b64b84ef2414bad601090e3ef1c909474e4d5372cfebcdd4ad004cea1c7d`）は、みんかぶのメンテナンス案内で、復旧時刻やリンクの記載は無かった。追加GET0で確認した。JSONL SHA `e73cc6e2516ae67273c919f7d8867d346063c63eccd2f01084d041c1454680e0`、gzip SHA `ffeae2eb90249b84a3efd20279e2048ca9d43e86086cba5f23335aefc6992476`を全損失なしと照合し、01:18:20Zに独立Notion1/hosted1のmetadata・manifest・原取得clock・全gzip bytesも一致した（closure receipt SHA `f5bd6cae840386cb9b451d7ea90656ea79618b0d8f4297dc34ed8359df083ef8`）。取得元停止・全量未完を保持し、有報の通常run15以後を同mainから再開する。

[有報run15](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37167681207)は21通取込・処理量上限で停止し、[run16](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37168177030)は9通取込・上限未到達で終了した。両runともlist/ingest errors0。01:35:55.668Zの全60日台帳はcompleted380・finished60・sealed59・queuedDays0・inFlight0・identity保留15。保存台帳から同日再確認が必要な保留日数も0と独立再計算した。当日の1日は翌日再確認まで未sealed、識別保留15件は成功や削除へ変更していない。追加登録した地方市場6銘柄の対象書類はすべて同日completedに入った。新しい一覧はrun15の1件とrun16の3件だけをNotion/hosted各1・各3で全文照合し、60一覧の資格を保持、旧56件の再GET0。run15の新規識別保留1件は保存FSA全11,402行・ZIP全CRC・提出者名/JCN一意一致から非上場・コード空欄を確認した（独立receipt SHA `84969e20f84678156fa0518587ba84543617313cc6dcc1ff2febaee386ff9b33`）。run17は起動していない。

取得元の復旧確認は2533の詳細だけ1回行い、01:39:09.925Zに再びHTTP503・同4,642B/同SHAを受信した。全量取得を再開せず、再試行0・DB取込0・モデル0を維持した。原応答は共有Notion8/hosted1の全200、metadata・manifest・全gzip bytes一致を01:39:16Zに確認した（gzip4,344B、SHA `43bc7023ee3c38fc750fb0e40fcfc0b5c2d61a336658693cc573f81b892c0d1e`、closure SHA `6e0d32c65426d4d42124d9c2725bbeb547a50d84270511e664a52ef378e1fb36`）。終了時刻は依然不明。次の全量取得は既存の月次10日10:30JSTであり、その成功や随時優待の本番行・表示を確認したとは扱わない。

全量源取得の成功を私有要約planの必須条件にしていたが、通常の21時要約入口は既存D1の現在原文を独立して処理する。取込0で旧原文が保持されたことを確認し、この余計な前提だけを外して契約.3の通常入口を01:43:22.883→01:44:15.184Zに1回実行した。run `f2ff4408-d348-4cd6-9106-a6ab37b29e39`は10群から1群受入・9群保留、pending10→9。実13受取行のうち2001の1行だけshortSummary/updatedAtを更新し、推定金額NULLを保持、残り12行の全tupleは不変。生成保留は受取条件欠落1群、取込保留は数値照合不一致7群・契約違反1群。旧.2出力の流用0、Qwen3.5-4Bはresident1/calls10/input3,582/output340/model elapsed29,029ms、paid API・源GET・モデル追加再試行0、未知書込markerなし。独立PURE再計算は新task/protocol/qualification/import plan/全POST8,182行に一致した（receipt6,928B、SHA `6c6e4fc061df1b7bc6449ee73c2ff09be5c979c3b037643a24aa4634d8fab1f5`）。PREは選択13行だけなので、非選択全行の独立full-before一致は主張しない。

同要約のPRE4,125B（SHA `21df953463e6151859445d1122337fb471756efcd1647b4d04cba82965a11f4f`）とPOST494,836B（SHA `46c4a46897a27e62f7df3a5e8dc6a02377d6a59fa1345be2b124b27c1a768daf`）を01:52:38Zに独立Notion2/hosted2で確認し、原clock・service/status・全metadata/manifest・実ファイル全bytesが一致した（closure985B、SHA `692db33ff9805f71be4d4a902f54ced4c48961884942a95ad6999336074e580f`）。これは現在DBの通常要約の部分受入であり、未完の全量源・随時優待・1株優待・SSRの受入証跡ではない。21時処理はMacが起動している場合のローカル処理である。

[PR296](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/296)は全3CI成功後、01:52:35Zにmain `2807e0a6e8579534cd56356c16321c9334569cb7`へsquash mergeした。共有マクロdraftで必須N225のdate/price/prevClose欠損と取得・解析throwを即停止し、後続4原本を取得しない。正常5源・原本物理保管・不成立時DB更新0は保持する。両実callerと再取得設定を独立追跡し、実原文による3回帰を含む96関連テスト・型・対象lintがPASS、追加の実Yahoo probe0。GitHub check111339051592の同SHAからCF build `8c97898c-38b8-4c47-8f82-fafc674d579b`・version `ad841610-1669-419f-bc84-f25d05d084cd`を特定、native deployment `ec928a8b-7e02-49b7-b48d-5275f7589efa`は01:53:44Z作成・100%配信と確認した。Mac runtimeは同main/clean、writer idle時のaccepted revision原子置換は.env0600・他bytes不変、preflightは通信0・業務書込0でPASS。

Yahooの共有制御はprocess/isolate内の取得開始を1秒間隔とし、GitHubのstock/VWAP/moneyflowは共通concurrencyで重複を避ける。401では既存の認証更新後に1回再送する経路があるため、全origin通信の再試行0やisolate間の世界共通制限とは主張しない。429/503の抑止期限と既存原本による確定済み日の再取得防止を維持した。次の平日の全銘柄株価・VWAP完走と新CF dispatch/readcheck成功は未観測であり、過去の1件成功・今回のデプロイを制限全面解除へ読み替えない。

PR296の[main CI37169328154](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37169328154)も全ジョブ成功を確認した。

02:00:46Z、有報run10〜16・JPX overlay・地方4銘柄の登録/CAS・停止した優待原文取得と復旧確認・契約.3要約の運用証跡595membersを最後の一束で共有Notionへ保管した。元member3,779,875B、gzip1,973,225B（SHA `a6b02a03460b5f4d4f1f72d884869e36a58a1999764907b818c0f3e630ae80b9`）、metadata124,237B。共有Notion8/hosted1の原9応答はすべて200・attempt1、全metadata/manifest・全hosted gzipと全member復元bytesが一致した（closure318B、SHA `2d1e1f93134bf1453a81fa61e5b507bd3c9f6b61c63a851b80d37cd2bfc7a347`）。保存済み源ZIP/JSONL/gzip・モデル入出力・PRE/POST原本とhosted読戻しbodyは参照だけを含め、追加の取得元通信・D1/R2業務書込・モデル・再試行0。元UNKNOWN/private false STOP/503/識別・品質保留を保持し、archive成功を業務データ全量成功に読み替えていない。要約のexact task/protocol/resultsTextとPRE/全POSTは元物理束の内容として照合済み、派生qualification等の別file serializationを個別hosted GETしたとは扱わない。

本日時点の実施可能な修正・原本保管・main反映は完了。残る外部供給・将来の実受入は、みんかぶメンテナンス復旧後の優待全量取得（現在取込0、随時/1株優待の実行・表示未確認）、次の平日の全株価/VWAP/全連鎖とCF定時dispatch/readcheck、未公表JPX資料・未観測年次書類である。識別15件・要約9群は保留であり、完了数や新規取得成功には加えない。
