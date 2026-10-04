# 自動処理の実行検証（2026-10-04）

ユーザー指示で定義済みの自動処理を通常経路から実行し、失敗原因を修正する。
開始時の本番mainは `ee906280571b1d37a6a649f4a7b81427c37a9990`。
日曜の休場・未公表資料・品質保留を成功へ置換しない。
取得元を重複実行せず、一次原本は非公開の既存Notion保管・全文照合を使う。
TypeSafe設定、新規の有料AI契約は変更しない。

## 初回の実行と原因

| 処理 | 実行・結果 | 判定 |
| --- | --- | --- |
| Cloudflare疎通 | [37201303947](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37201303947) | R2両bucket・D1接続成功。現行9表に古い「10表以上」判定が失敗。#299 |
| 株式日次 | [37201365228](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37201365228) | 実対象10/4に対して実N225は10/2。保存前停止し、sector33/moneyflowはskip。日付の変更・価格補完なし。 |
| マクロ | [37201428002](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37201428002) | 通常取得・原本保管後に成功。D1再読で基準日10/2、実更新時刻12:15:09Z、必須6値を確認。 |
| Mac事業タグ | 20時の通常処理、20:00→20:01 JST | 最新mainで終了0。判定済み3,667と本文不足22を保持し、モデル呼出し0。 |
| Mac優待要約 | 21時の通常処理、12:00:05→12:00:37Z | 8群保留。6群は原文と同じ完全な株数範囲の上限を誤拒否。残2群は文字数超過・選択条件欠落。 |
| 優待原文 | 2533の1回の復旧確認 | HTTP200、原本実体保管・全文照合。全量は1秒間隔で1回取得を開始し、取込完了は未確認。 |

## 初回の修正

- 疎通診断は既存`declared_tables()`と`JSS_TABLES_SQL`を再利用する。必須表が欠ける場合は、無関係な表が多くても失敗する。
- 優待契約`.5`では原文・要約の同一の完全な株数範囲を、実受取行の下限株数と照合する。上限単独、別段階、範囲の書換えは保留する。旧出力の本番再適用はしない。
- 続く契約`.7`では、保有期間・選択・抽選・応募・申込の欠落検証を自動選定・外部取込・月次持越しにも接続する。抽選を応募の代用にしない。`.6`時点の既存要約の純監査では2,563群が再確認対象になり、7203の保有条件欠落も検出した。原文と更新前の解釈は保持・保管し、未確認の要約・金額を月次へ持ち越さない。
- 全量取得済みの同一原本を更新後の検証へ渡すため、既存の更新前全行保管・原子取込をそのまま`importCollectedYutaiData()`へ分離する。取得を繰り返さず、原本の完全性・実体保管・全文照合後にだけ適用する。
- 信用残の単独CLIは既存の日足・5分足と同じ`.env`読込を使い、設定未読のまま原本を取得する経路を修正する。
- 資金フローのdry-runは結果の失敗を終了コード1へ反映する。成功検証の終了状態と、Notion書込0を維持する。

検証：優待148テスト（更新後の共通条件検証）、全量取込63テスト、信用残19テスト、資金フロー33テスト、D1診断・スキーマ18テスト、TypeScript型検査、変更対象の静的検査が成功。
非公開原本・生成本文・資格情報はGitへ保存しない。更新後の実行と残る自動処理は後続で追記する。

## 運用監視から見つかった追加の原因

[ops_check 37201889052](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37201889052)は成功したが、月次更新を再開済みの優待を旧`NOT_REFRESHED`宣言で加齢判定から除いていた。さらに`MAX(updated_at)`は日次要約だけでも進み、原文の取得状況を表していなかった。

12:31:41.867ZのD1集約1回（HTTP200、24,546行読取、書込0）で、active普通株の優待は7,921行・1,603銘柄、最古の`created_at=1782134712`、最新の`updated_at=1791081116`を確認した。母集団外の旧261行は保持する。従って月次の対象と同じactive普通株だけを観測し、全量取込のDELETE→INSERTが更新する`MIN(created_at)`を既存の月次40/50日閾値で判定する。途中取込や日次要約で古い原文を隠さない。修正後の実監視は全量取込の実受入後に確認する。

Python原本保管は新規・既存SHAともページと原本/変換添付の全バイトを照合し、取得日をまたぐ同一原本は旧添付名のまま照合する。EDINETのCSV/PDF提供フラグとTDnetの正式件数上限によるcoverage補完を区別し、未知の通信・保管結果では後続取得を停止する。需給は`updated`以外が完全同値なら後退禁止検査後にR2書込を省き、D1の実取得時刻は保持する。

監視の既存90テストと静的検査が成功した。原文全量・VWAP・Python/Nodeの実収集は進行中であり、監視ジョブの成功だけでそれらの完了とはしない。

実行ログでNixキャッシュが未認証のFlakeHub接続を試みていたため、8workflowの既存actionに`use-flakehub: false`を明示する。GitHubの既存キャッシュは維持し、追加契約・秘密値・依存の導入はない。[公式actionの設定](https://github.com/DeterminateSystems/magic-nix-cache-action#action-options)に従い、8件のYAML構文を検証した。

マスタ月次cronは旧`0 21 1 * *`（UTC）だと日本時間2日06時で、定義の1日06時から1日ずれていた。`0 6 1 * *`と`timezone: Asia/Tokyo`に修正し、独自の末日判定は追加しない。[GitHubの公式timezone対応](https://github.blog/changelog/2026-03-19-github-actions-late-march-2026-updates/)に従う。

NodeのTDnet通常取得・backfillは原HTTPを解析前に実体保管し、構造化した同じ入力も全文照合してからD1へ渡す。PDFは既存の`IR資料`添付を全バイト照合した後だけ分類・本文をD1へ保存する。DB行の不存在・本文保存・Notionページ更新の不明結果を握りつぶさず、後続取得を停止する。共有の照合関数を再利用し、既存の銘柄別DB構成は変更しない。資金フローのPhase1も原本上限超過・添付不一致で観測値保存へ進まない。

この経路の既存Vitestに、原本保管前のD1書込禁止・PDF照合失敗後の次PDF取得禁止・本文保存失敗・対応行欠落の回帰検証を追加した。関連5suite47テスト、型検査・静的検査が成功。Python原本・月次鮮度を合わせた全テストも成功し、既存の実資料がない73件のskipは保持した。これらはコード検証であり、更新後の通常収集・実データ受入の結果は後続に記録する。

独立レビューで、PDF抽出器が原本のArrayBufferをdetachし、後段照合で正常なPDFも不一致になる経路を検出した。共有の抽出入口で`bytes.slice()`を渡し、通常分類の全callerで原本を保持する。native transferを行う回帰テストは旧コードで失敗し、修正後は関連3suite51テストが成功した。

保管済みのJPX信用残PDF1件をhostedから読戻してmanifest全一致を確認し、新抽出入口でoffline解析した。1,772,736B・SHA `d0d32ee816d463bab348d2cd357d10e21afb911db996ac1129af0bd62a8072bc`が解析前後で一致し、解析中の通信0・取得元再GET0だった。PR301初回CIはPython 1,552成功/73skip・月次cronの旧期待値1件失敗。既存テストと正本設計の時刻を更新し、関連48成功/2既存skipを確認した。

月次の母集団取込も、JPX XLSを解析前に実体保管・全文照合する。同月の差替えを旧月キーで既存扱いにしてしまわないよう、全文SHAで冪等化し旧原本は保持する。容量上限・設定不足・照合不明でD1へ進まない。関連4suite54テスト・型検査・静的検査が成功。Pythonマスタ同期はNotionマスタ・業種・逆引き写しの処理で、Nodeの母集団同期と月次派生再構築は別に実受入を確認する。

非200の不透明`.bin`は共有アップロードが拒否するため、HTTPエラー原文だけnative gzipで包み、status付きSHAキーで区別する。元bodyのbytes/SHAを保持し、空body・非UTF8 bodyでも共有の実アップロード形式検証とgzip復元の全一致を確認した。関連4suite56テストが成功。正常XLSX・旧原本・戻り値の契約は保持する。

13:06:24Zまでの優待通常取得は一覧86＋詳細1,711の全1,797 GETがHTTP200で完走し、Notion/D1前のゲートで停止した。全量原文のoffline再解析は8,008予定行・権利月不明0、随時は1766/8617。gzip96,620,903B/SHA `17670fccfaebd81fb08241e818d96036c0ca30f26fd4a62f6836068905a8fbe9`と未圧縮JSONLの全バイト一致を確認し、canonical private tmpへ保存した。これは取得完了であり、原本のNotion保管とD1適用はまだ未実施。通常保管関数もexportの1行だけで再利用可能にし、新mainから同じ原本を渡して再GETを避ける。

PR301は全3CI成功後、13:14:25Zにmain`64070f1076205195b550a917c8ed8a3cb1708c4a`へマージした。優待の旧取得プロセスは13:09:56Zに両permit未発行・Notion/D1 0で終了し、全原本とhandoffをcanonical private tmpへ保持した。

後続の資金フローを追跡し、既存原本の読取が外部URLを受け入れる経路を検出した。完全キー・当月prefix・共通spec取込が通る`toArchivedRecord()`でNotion-hostedの実体添付だけを受け入れ、外部リンクを取得元へ再GETしない。既存2経路の回帰は旧コードで2件失敗、修正後は関連3suite41テスト・型検査が成功。通常hostedの同期間再利用と全文照合は維持する。

PR #300は12:36:58Zにmain`79e6bbe63031ca8ddf86e571c8b4123654ed9058`へマージし、mainのCI3件成功、12:37:31Zのnative deploymentがversion`4d307582-410e-4705-b0cb-99d4b9939bcc`の100%配信であることを確認した。Macのkernel排他下で同mainへ更新し、canonical.envのaccepted revision以外は保持。通常の[cloud_check再実行37202784871](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37202784871)はR2両bucket・必須9表、processed=3 / failed=0で完了し、#299を閉じた。

## 本番への反映と続く実受入

PR #301のmain CI [37204907318](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37204907318)と、同commitのWorkers Build `2bf237d5-5d45-41fb-9b1c-7dfd0c8b5291`は成功した。native deployment `8299732d-2e7a-4306-ae0d-25c40c10ea29`は13:14:54Zにversion `6b0af90e-1e80-465b-868b-56f18f78a06c`の100%配信を示した。月次cronの旧期待値によるCI失敗 #302は、後続mainの成功を確認して閉じた。

PR #303も全3CI成功後、13:23:25Zにmain `298add924ee191d07cd8c6a503a85def23aff0ab`へマージした。main CI [37205449164](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37205449164)と同commitのWorkers Build `cb8f45b8-892b-47a4-a69f-0753b4bc804b`が成功。13:27:44Zのnative読取はdeployment `752f6336-05e8-4741-b336-98c94de47f7f`（作成13:23:51Z）、version `a9f2f0a6-b481-4dfe-878c-729621a9bbaa`の100%配信を示した。native metadataにはGit SHAがないため、exact commitのBuild成功とdeployment作成時刻を合わせて確認した。13:28:01ZにMacのkernel排他下で同mainを受理し、clean、canonical.env 0600、accepted revision以外の設定と登録を保持した。更新receipt SHAは `1322e1306681385772755c84245736bff3628ccef67c430ea9b0a8ea46534220`。

13:28Z時点でVWAP通常allは進行し、Notion保管は80分割・daily最大offset 2,370まで前進した。これは原本保管の途中経過であり、全量R2保存・読戻しの完了ではない。同時の他heavy writerは0。残る月次の通常処理は、追加のローカルwriterを1本だけ、Notion実通信（共有再試行も含む）の開始間隔4秒以上で順番に実行する。共有clientのRetry-After・未知の書込結果停止、Yahooの直列取得と1秒間隔は保持する。

優待8508は読み取り1回で、現D1の単発行が基準日2026-09-02のまま存在し、新原本の通常4行とは掲載文・株数・月のキーが一致しないことを確認した。原文を推測で同定したり単発日付を通常優待へ移したりせず、通常取込の削除前停止を保持して原因を調査している。この時点で全量取込・月次派生・新契約の通常要約は未完了。

保存済み公式原本のoffline確認では、9/2は資格基準日であり、受取期限は2027年1月18日23:59だった。従って期限終了による削除は採らず、月次取得元に載らなくなった過去基準日の単発行を原12列・ID不変で保持する。月次監視も非単発行の最古`created_at`だけを測り、保持する単発行は総件数に含める。既存SQLite回帰で単発行の古い時刻を除いても件数を消さず、非単発行の部分取込・要約更新による誤成功を引き続き拒否することを確認した。監視の既存91テストが成功。

通常の全量取得入口から原本の最終受信UTC時刻を渡し、その日本日付より前で新掲載キーに無い単発だけを月次削除対象から外す。元ID・全列へ書き込まず、基準日を通常優待へ移さない。一覧から銘柄自体が消えても、残す単発行の銘柄の優待flagを維持する。`planCarry()`への直接呼出し・時計不足・同一contextの衝突・基準日が当日/未来の場合は従来の削除前停止を保持した。新SQLite回帰は旧298で同定不能の失敗を再現し、修正後は関連3suite70テスト、型検査・静的検査が成功した。実D1への全量適用は後続で確認する。

PR #304は全3CI成功後、13:44:24Zにmain `d97238eb4d41cf7070cc5487a4ab2660f70e45b6`へマージした。main CI [37206691484](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37206691484)と同commitのWorkers Build `20b8d806-182c-4fc9-9a83-d13c43314676`（終了13:45:08Z）も成功。native読取13:45:13Zはdeployment `b0ab05e4-0ea9-4189-8802-63acb7fa928a`（作成13:45:03Z）、version `76a31b8c-2d68-4b8a-8d9b-5dc39ebe0be4`の100%配信を確認した。Macも13:48:56Zに同mainを受理し、clean・canonical.env 0600・登録不変。receipt SHA `22ed035e6c4d4322502a71a312cbed2d3646fcd150a95c24484291f3e73f10f1`。

## 月次銘柄マスタの通常実行

13:32Zに既存`runUniverseSync(createUniverseDb())`を通常1回実行し、13:34:38Zに終了0。JPX GET1、Notion14/hosted2、D1 HTTP237（SELECT9/変更228）、D1 metaのrows_read=16,357 / rows_written=7,490。実原本は2026-08-31・4,441行・同期普通株3,631で、日付を新公表月へ置換しなかった。core全3,828行は保持し、upsert3,631・deactivated0・instrumentTypeUpdated0。

原本と正準PRE3の実体・全バイトを照合してから同期し、全POSTで既存ID・code・isYutai・sector33・createdAt、events全列、baseAsOf以外のstate全列を照合した。保存した全254 HTTPは200で、元応答をSQLiteへ再現して正準SQLの結果を独立検証した。続くPOST証跡1bundleは13:43:19Zに通常の共有保管・全文読戻しを完了し、Notion8/hosted1、取得元/D1/モデル0。gzip656,944B・1,019members・SHA `5e28a62a7d720a851e3103dcb453cd55ef312033e114e2448e9e0f08dc264483`と全member原bytesが一致。参照される同一原本を複数の独立添付として数えず、強制再保管・同一run再入は0。

マージ・remote末端SHAが一致したPR300/301/303の不要remote枝3本も削除した。未統合の変更・実行中のworktreeと非公開原本は保持する。

優待の同一原本をd97238で再解析し、13:49:44Zにoffline資格確認を終了0で確認した。原本の実最終受信は13:06:11.365Z（取得終了ゲートの13:06:24Zとは別）で、SHAと全1,797ページ・予定8,008行は不変。13:50:04Zに新mainの通常物理保管→通常取込を1回開始した。取得元への再GETとモデル呼出しは0で、全量適用の完了はまだ未確認。

## 優待全量の実受入

同じ原本を使った通常取込は13:56:35Zに終了0。active普通株1,650銘柄の新原文7,717行、過去基準日の単発1行、母集団外の既存261行を合わせた全POST7,979行を照合した。8508の単発ID38642は原12列・IDと基準日2026-09-02を保持し、新原文の通常4行へ日付を移していない。利回り880件・スコア851件を通常関数で再計算した。

原本gzip96,620,903BのNotion実体と全文読戻しは13:51:20.992Zに完了し、最初の通常D1要求は13:51:21.178Zだった。更新前全8,182行のgzip1,015,022B/SHA `7f41674e75d006b7b2b20fad2ec295b8bf0f052e2c0eb93a3df15e2e71a613d6`を保管・照合してから通常取込へ進み、更新後全行のgzip1,048,114B/SHA `21fbc52a76db68acb9f24c089c5afb7d2e56d63b9027a80a56ed3cb8a7892eff`も保管・全文照合した。D1 HTTP2,656、Notion43、hosted6の全2,705応答が200、未知結果・429・再試行は0。全Notion開始間隔の最小値は4,000.320ms。14:00:02Zの独立FS照合でも全要求・応答・添付のbytes/SHAが一致した。

非公開の最初のsource-physical receiptはオブジェクト展開で検証開始時刻が閉鎖時刻を上書きしたため、元receiptを保持し別のtiming-correctionで上記native受信時刻・ファイルmtime・後続D1要求時刻を結び付けた。業務データへ渡した実原文受信時刻・保管前書込禁止の経路は変えていない。

14:02:05Zの保存済全POSTと通常recompute入力のoffline確認では、1766の「随時」4行と8617の「随時」1行が権利月0・日付NULLのまま保存され、年間利回りの対象から除かれた。1766の通常4月7行と8508の通常4行は年間対象、8508の単発1行は年間除外。1766/8617の価格行はこの時点で未生成のため、通常再計算はnoFinancialRowとして保持し、価格を補っていない。追加の取得元・D1・Notion・モデル呼出しは0。

## 月次の利回り・スコア再計算

新main d972で既存`runMonthlyRebuild(createMonthlyRebuildDb())`を1回実行し、14:07:50.042Zに終了0。scoredStocks=1,650 / isYutai変更0、取得元・モデル0。更新前の正準9表をgzip実体保管・全文照合してから通常再計算へ進んだ。元470 HTTPは全200（D1 SELECT26 / write435、PRE Notion8 / hosted1）、D1 metaはrows_read=86,751 / rows_written=3,300。

保存した正準normal443 SQL/paramsを独立再現し、対象1,650件のfinancial18列・score6列と全POSTを比較した。元財務・指標・優待・genreの4表、overlay全列、core保護9列、非対象の派生行は保持した。再計算dataDateは2026-10-04 UTCで、元財務の取得日を更新した意味にはしない。全POST15,948,766B/SHA `121ddd36a88fa507496c9daaf1deb7e48149108412801fdf871ab4b27d2e2a09`を確認した。

POST証跡のNotion実体保管・全文読戻しも14:11:02.701Zに終了0。Notion8 / hosted1の全9応答は200、1,884member・元55,445,320Bをgzip8,302,911B/SHA `0c6052bc6ca13c40a987c31132156fe90042d0d5573f3742bd4b8a9eb6d1aefa`として保管し、全memberの原bytes・metadata・manifest・native時計を独立照合した。既PREの13添付は参照だけを記録し、新たな独立添付として数えない。

## 優待要約の通常60件と製品名の誤判定

Macの通常`main.ts run yutai-summary`をdefault60のまま契約`.7`で1回実行し、14:14:51.052Zに終了した。固定済みの既存SemIfモデル1 resident / 60 callsで、32群を採用・28群を品質保留し、pendingは3,645→3,613。採用32群の37行だけを更新し、残る7,942行・8508単発の全列を保持した。外側exit1はpartial_rejectionで、通信・未確定書込の失敗ではない。

原40 HTTPの全要求・応答のbytes/SHAを独立FSで照合した。全応答200、Notion14の最小開始間隔4,000.478ms、unknown0、wrapper retry0 / child1、pending-writeなし。通常PRE/POSTのNotion実体保管・全バイト読戻しも完了し、closure receipt SHA `53fb67e6597b557aa10fe14a91f7cb0277f2349e593d662a678954adb2501c2f`にtasks・モデルprotocol/results・planと全7,979行の結び付きを記録した。取得元への追加GET・有料AI呼出しは0。

保留の内訳は生成側17（JSON形式2、保有条件8、申込条件1、選択/保有2、選択4）と取込側11（数値10、文字数1）。全保存出力43件のoffline確認で、1431の3件だけ原文と同じ製品名「3Dプリンター住宅」を数量3と誤認していた。共通数値guardで原文と一致する同製品語内の3Dだけを除き、33D/13D/A3D、源文にない製品語、後続の額・率・数量・株数・保有条件の変更を拒否する。契約`.8`と仕様を更新し、旧`.7`結果は再適用しない。

既存回帰は旧d972で失敗し、修正後の関連110テスト・型検査・静的検査が成功。実保存出力の純再検証は該当3件だけfalse→true、他7件の数値保留を保持した。root統合で固定1語の集合をbooleanへ簡素化し、変更2suite96テストが成功した。更新後の新しい通常生成・保存は後続で確認する。

## VWAP全量実行で見つかった不具合

[通常all 37202207552](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37202207552)はdailyの3,689対象中written838 / errors2,619 / sourceObserved3,456で、13:54Zに終了2。9409のnative R2 GETがInternalErrorとなり、intraは未実行、marginはskipだった。成功した838件は追加取得・書込0の全R2本文読戻しで形状・全bytesを確認した。部分成功を全量完了には扱わない。

保管済み最初の30原文はgzip1,427,803B/SHA `f08daf6d28406741ffbae5f570795705e690aa27e9d466d30bdd6cc96af87947`の全文読戻しで全memberが一致した。1301の元受領時刻12:28:34.484Zとrange=10yの原応答では、確定session・末尾barは実10/2、先頭barは2016/10/3。日曜10/4の壁時計を使ったcallerが下限2016/10/4を契約にしており、10年取得範囲を誤拒否していた。原bars/eventsを切り詰めず、実sessionの契約を検証する共通修正を進める。取得元へのall再GETは実施しない。
