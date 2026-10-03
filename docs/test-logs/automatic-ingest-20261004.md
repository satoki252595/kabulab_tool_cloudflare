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

優待source全量は未開始。全HTTP原本文をRAM配列へ保持して最後にJSONL joinしていたため、Nodeの文字列上限到達時に保存前の喪失が起こり得た。各受信応答を次GETより前にwx0600 JSONLへfsyncし、終端はstdlib stream gzipで共有物理保管する。個別HTTP bodyと共有upload向け圧縮bytesはRAMを使用するが、全量base64配列/joinは除去。失敗時も私有JSONL/gzipを保持し、源の再取得で復元しない。GET間隔・再試行0・原子取込順は維持した。
