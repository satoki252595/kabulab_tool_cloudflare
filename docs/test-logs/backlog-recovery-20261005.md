# 未処理分の再開 — 2026-10-05

Refs #284 #117 #160 #196 #291 #292 #293 #305。

前回は実行上限を理由に5分足2,439件・優待要約3,592群・TDnet848件を未処理のまま残した。
2026-10-05のユーザー指示により、保存済み原本の再利用と残りだけの取得で処理を続ける。
品質・同定不足と未開始を区別し、不明書込を盲目的に再送しない。TypeSafe設定は変更しない。大量要約はユーザーの追加指示に従い `muse-spark-1.3-contributor / max` で生成する。通常Macのモデル設定はこの明示一巡のためには変更しない。

## 続行時の観測

5分足は全3,689銘柄を処理済みで、現在の未開始・保存結果不明は0、原文品質保留6件。
日足36銘柄の通常一巡も全件着手し、3477を保存した。30件は前営業日が最終約定の
無約定日バーを誤拒否する共有判定の問題で、[PR323](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/323)
が全CI通過後00:09:28 UTCにmain `6dc2f2f`へマージされた。元37応答の再検証は31適格・5欠損、
追加Yahoo取得0。00:17:03.581〜00:17:26.146 UTCの通常source0復旧で30件を保存し、
全30 native POSTと通常summaryを読戻した。未開始・保存結果不明・拒否・429は0、EXIT0。
保存前の全30旧本文はNotionの一次・退避へ物理保管し、両方の全文検証後に各ETagのCASを1回行った。
Notion25/hosted5、最小間隔380.474 ms、source/model0。receipt SHA
`62d795687523183d3fcd3cd852aa277c62bdd7b4801c91051d210b2197ba4674`。
standing日足の既存成功との重複5件を除いた適格成功集合は3,685/3,689、
残る4件は523A・5271・6092・8303。今回の元応答欠損5件の7075は過去正常本文があるため別集計。
この集合は複数の実観測を束ねたもので、全銘柄を同時刻に再読取したsnapshotとは扱わない。
実36一巡はEXIT1/未開始0/未知保存0で、元結果を成功へ書き換えない。

TDnetの原再開は23:45:59.871 UTCにD1本文INSERTのHTTP500で停止し、元completeは存在しない。
最後の対象275786/1283132・試行4,682 UTF-16文字は観測できたが、元送信全文SHAは未観測。
最後の保存結果不明履歴を保持し、同じINSERTを盲目的に再送しない。
00:01:34.470 UTCまでの単一の全件POST読取は1,292ページ参照、本文1,069件、
本文なし判定6件、未完了217件を確認した。対象の現在本文は不存在。
11,815,155 bytesの全応答と保護13列・全本文をFS照合した（追加源・Notion・書込0）。
全読取SHA `3a3010ac742b5463b994c55d5ff6aea739105415bb3f175b6b19b5a6676a4ad5`、
FS SHA `39d945511765c3cb25ea92f23dcf133e414ddfc912bb8ff914c60dfef271e658`。
保管済みPDFから未完了本文を再開する[PR324](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/324)
は関連35件・型検査・lintと全CIに成功し、00:16:45 UTCにmain
`0441671c3cd6f78007fdaeb03b5bf2fef5f07a62`へマージされた。
同mainのCI37246888120は全2ジョブ成功、同headのWorkers Buildも成功。
00:24:41.780861 UTCまでのnative metadataでdeployment
`11b459f3-0928-4350-9e65-876381f00590`、version
`d37396f5-fc95-4734-8cae-ceeb2c459735`の100%配信を確認した。
Git SHAを持たないnative metadataと同head Buildを区別したclosure SHAは
`671e404f2cf651d807c69a7962f006bb1c751d1ed46e75d0d11bd3adff51d052`。
Mac runtimeは00:23:36.085 UTCに通常FFで044を受け入れ、正準.envは
accepted revisionの1キーだけを変更した。

最初の217件復旧は私有検証がNotionの検索POSTを更新と誤認して停止した。
00:25:19.757 UTCの終端まで実Notion/hosted/PDF/業務書込0、D1の全SELECT3回のみ。
旧STOPのNotion counter 7は送信前検証の評価回数で、実API呼出し数ではない。
旧全応答・STOPを保持し、検索POSTとquery POSTを読取として扱うだけの別helperを
純検証・型検査後、00:31:07.876 UTCに明示1回開始した。
通常の保管済みPDF復旧は01:03:09.754 UTCに業務処理を終え、217件の全PDFを読み、
216件の本文・1件の本文なしを確定した。全1,292行のPOSTは本文1,285・本文なし7・未完了0。
旧1,069本文・旧本文なし6件の全24列を保持し、新本文614,735 UTF-16文字が実INSERTと一致した。
全871 D1応答のstrict成功、全217 PDF bytes/SHAと本文・分類payloadを純FS照合した。
全POST13,263,215 bytes/SHA `7916fba4838fe33e3574766826e794803f13eb218afdbe7e729a9684fd8a49d9`、
全照合1,246,927 bytes/SHA `cc3820a0c368bc5c08ad5539d56081b6c3b5a3609c281b8f7e75d77f5b69adf8`。
発行元・モデル呼出しは0。読取先Notion3,762/PDF217、独立PDF再抽出は行っていない。

元wrapperは末尾の私有検証が実列`char_count`を`charCount`と誤比較して01:03:11.296 UTCに
EXIT1となった。元STOP・元HTTP500/未知結果を保持し、再取込せず全保存済み応答の別FS照合で閉じた。
FS初回の応答ファイル並び誤認も失敗ログを保持し、連番1〜871の検証で訂正した。
旧未知対象275786/1283132の現在本文は4,682文字で、新INSERT全文と全POSTが一致した。
旧試行全文は未観測のため、現在の一致から旧HTTP500の保存成否を遡って推定しない。
元execの正式EOFとwriterのfinallyによる解放を確認した。

優待は5巡と残る枚数誤り3群の修正をすべて指定Muse・maxで生成した。
129バッチは全終端し、未知結果0・tool呼出し0。現旧snapshotの未処理3,679群は
適格3,586・数量単位「足」の誤拒否1・原文条件保留1・対象外91に分かれる。
「足」は掲載文と同数・同単位の1群を正当に救済する共有契約`.14`の
[PR325](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/325)で修正した。
元2失敗が修正後に成功し、関連145件・型検査・lintと全CIも成功した。
既原回答の1群・受取条件2件を追加推論なしで適格にできることを純検証した。
原生成版・原回答・生成時計を維持し、追加推論なしの再資格と実モデル呼出しを区別する。
129バッチの原本は01:05:20.148263 UTCまでに共有Notion保管・正常EOF・writer解放を確認した。
gzip11,484,745 bytes/SHA `2418af439d1cf9a46ec1b489beac7e934d84ceee97206b2a54975912fb10f5c5`、
page `3f0d74ff-84cd-81c2-b762-c496dca106e5`。hosted全bytesと展開後の全2,362ファイル・
105,749,112 bytesが元原本・manifestに一致し、6元source snapshotは既存物理保管への参照だけにした。
Notion8/hosted1・全HTTP200・source/D1/model0。生成版と時計は変更しない。
全FS receipt SHA `1f2ee93f94635ea966770c1b4fe8ca04c264e42941bdb3dc9e7302834a0a4eb1`。
01:18:09.163 UTCの追加通信0の全再資格で、現在のpending3,588群のうち3,587群を実7977行の
受取条件へ束縛できた。残1は2221の保有条件省略、未知0・新未開始0。元6巡の生成版と
129原応答を変更せず、検証版だけ`.14`にした。全gate receipt SHA
`0aa03f555f7c0be7d88d012f87d1f806bccad0708d7762662f564fc874a57d64`。
残1は同じ指定Muse/maxで、現在の3月だけの実recipientと元本文から別バッチで生成した。
その入力は正常POST gzip `70d7ded…`・実snapshot時計01:13:49.470 UTCで、元13:06のsource時計と
旧129の15:27 snapshot時計を区別する。01:22:43.829 UTCに正常終端し、モデル1/tool0。
原文の「同一の株主番号」を要約の「同一株主番号」と照合すると、契約`.14`が数量「一株」と
誤認して拒否した。原回答・元拒否を保持し、実3callerが通る共有判定で原文に実在する
この2表記だけを比較から除く[PR326](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/326)
を実装した。実株数・回数・期間・金額・率の変更と原文にない両表記は引き続き拒否する。
関連184件・型・lintと全CIが成功し、01:38:14 UTCにmain `52cdbce`へマージした。
原回答1件を`.15`で正常資格へ通す純検証に成功。機能ブランチでの全7977行の純selectorは
pending3,588で増分0。main52c受入後、01:44:24.649 UTCに全130原回答を実7977行へ束縛した。
3,588群すべて正常gateに成功、品質保留・未知・新未開始0。元生成版・原回答本文・時計を維持し、
原source実行`.14`/721と現在validation`.15`/52cの唯一の共有判定差を別に検証した。
全5validatorの実runtime bytesが52c Gitblobと一致。原recipientのsubsetだけを実IDへ束縛し、
金額は通常companyValueの機械判定を使う。選択・抽選・条件tierなど未確定額はNULLを保つ。
最終資格SHA `c4910332fa253076c692a8d915efd69c6f8659198fc4ba89048c6867c5b5ee4b`、
tasks3,501,324 bytes/SHA `f4b959591efa0947f4432c25efe40ae4e596ced4bdd769543738fe8f0669cd2a`、
results633,786 bytes/SHA `8348f4d94b124712108b54450957e172e1421ec668696b816e892dc64922687b`。
全FS資格で追加API・モデル・書込0。通常原子取込はこの時点では開始前である。

追加1バッチの原native36,244 bytes/SHA
`d355e1949461a6a11dfa2ca2d9189736a29e3efaaef059f40ff918035a992135`と原生成・拒否`.14`を
別の物理保管へ閉じた。01:31:03.116136 UTCまでにNotion8/hosted1・全HTTP200・EXIT0・writer解放。
gzip67,648 bytes/SHA `7104cf03e71221b7c0bdf7cdcec58da2fec633f2bb9ee9ee8475dddbe529fbef`、
page `3f0d74ff-84cd-8154-afa7-dbc997c55b30`。全hostedと展開後34ファイルが元bytesに一致し、
元129・原source本文は重複uploadしない。全照合SHA
`a4138afc44abe56f06bf8f3015ddd95c121ac8df612a88c4602a2e4438540ef2`。

PR326の同main CI37252203438は全2jobs成功。同head Build111582099132は01:38:59 UTC成功、
01:39:56/01:40:24 UTCのnative読戻しでdeployment `82ae4c35-8856-4b51-ac27-7c9aa5fbf9b4`・
version `aa5c3990-0e58-467c-be3e-7a5e9f168f8e`の100%配信を確認した。
最初の01:38:43 UTCのmetadataは旧721配信のままで、元readを保持してBuild後の別readと区別した。
native metadataにGit SHA・実HTTP packet時計/attemptはなく、同head Buildと実作成時計を別に束縛する。
全closure SHA `c1f6879135c14da0ae268a1cca9cf932e8fc4a96fde5ffd240b081b5658cddba`。
01:42:47.784 UTCにMac runtimeを通常FFで52cへ受け入れ、正準.envはaccepted revisionの1キー
だけ変更、他bytesと0600を保持した。正式EOF/EXIT0とwriter解放を確認した。

01:48:57.086 UTCに全23通常moduleの実runtime＝52c Gitblobを再確認した1回の原子取込を開始した。
原129と追加1の既物理ファイルは同key・原clockで再利用し、全PRE2,192,250 bytesを
物理保管・全文読戻ししてから通常CLIを起動した。01:50:52.469 UTCに子CLIは正常EXIT0、
全3,588群・4,721行を保存し、利回り317・スコア299銘柄を通常計算で更新した。
拒否・未回答・金額消失・元金額変更0。新規金額825行はcompanyValueの機械資格による。
01:50:57.612 UTCに外wrapperの私有スコア比較だけがSTOP/EXIT1となり、元履歴を保持した。
`fetchYieldInputs.scores`の実objectが銘柄IDを含む4項目、`scoreNext`が数値3項目であるため、
object全体の等値比較が誤拒否した。全1,140銘柄のID集合と数値3項目は厳密一致・丸め差0。
業務処理の再書込・追加APIは行わず、正常finallyのwriter解放を正式EOFから確認した。

01:55:35.778 UTCの別FS companionは、保存した全原応答から通常SELECT mapperを再生し、
全7,977行×12列・active7,716・対象外261・全原子SQL/paramsを照合した。
現在の要約pendingは0。元株価・data_date・権利月・親同定・その他財務列を保持し、
全正常計算・要約の元文字列・実金額に一致した。source/model/追加API/業務書込0。
元通信はD1 1,379/Notion12/hosted3、全1,394応答HTTP200、最小Notion間隔380.749 ms・UNKNOWN0。
元wrapperに存在しないcompleteを補作せず、原EXIT1・子EXIT0と別FS成功を区別した。
FS receipt SHA `c82564c17b9a1d3d59cb53fdeef22016a71f580b3b34d7b4624b128eaadc52ab`。
POST gzip1,967,391 bytes/SHA `260b97b5085c0ebc9243f411e418807e5172f69d155c44491b623bf730492807`は
元最終POST応答時計01:50:57.589 UTCと新assembly時計を分け、同時刻の原子snapshotとは扱わない。
POSTの物理保管はこの時点では未実施で、通常取込の再入をせず別1回保管へ渡す。
01:59:17.461 UTCの第二者による全原応答FS検証も、全1,394通信・全130原回答・正常mapper・
全原子SQL・保存前後の全値に一致した。全5,583 query結果はserver metaを持ち、
rows_read379,064 / rows_written5,337 / total_attempts5,583、欠落0。
独立全FS SHA `eacfdb142eb5fa9bd94a77a33dd1cd782b41003b0978b93ecafae6f50ab74f37`。
02:03:48.864 UTCには独立再構築POSTと上記gzip全本文・全7,977×12列・financial map・
全1,394 native参照のSHA/時計も完全一致した。追加API・source・model・業務書込0。
全gzip結合FS SHA `112bb0861f4ba41c5878ca2b2782b01bd177b976a786bd3c7427d34df9a4361d`。
02:06:37.847〜02:06:45.216 UTCにPOSTだけを通常共有保管へ1回渡し、正式EXIT0・writer解放。
page `3f0d74ff-84cd-815e-96d3-f85f13e4b350`へgzip全1,967,391 bytesを物理保存した。
Notion8/hosted1は全HTTP200、業務再入・D1・source・model0。全hosted本文・MIME payload・
展開JSON20,969,677 bytes・全7,977行×12列・16入力pinが元bytesと一致した。
要求した原POST時計01:50:57.589 UTCは元payload・要求metadataへ保持する。
実NotionのFetched Atは分精度01:50:00で返り、元時計を分精度へ書き換えない。
全physical/FS照合SHA `28540272f51560389750dcaefbf2c4c61eb411b6566f1242a498c4b3f01a884e`。
元wrapperのcomplete不存在・EXIT1はそのままで、別の物理保管EXIT0と現在のpending0を区別する。
第四266群は全件生成済み・未知結果0・原契約`.12`で224適格、同じ原応答の`.13`検証で249適格。
追加推論なしの契約修正と、実モデル呼出し数を区別する。この段階の残17群も後続で処理済み。
全union SHA `afa3e0e7265ac2d2c7daa56881d7b32e9fca07571a310e30c7f0c0737da13549`。

通常の保存原本再投影v4は00:09:42.733 UTCに私有PRE検証の列名不一致で停止した。
全14応答はHTTP200、D1 2回はいずれもSELECTで、業務データ変更0。
原本物理読戻しは閉じたが、期待7,977行の保存を完了したとは扱わない。
旧STOP・全原応答を保持してネイティブ列名の検証だけを修正したv5は、
00:19:17.772 UTCに通常PRE保存の既存ファイルとのwx衝突で停止した。
全5 nativeはHTTP200、Notion3/hosted1/D1 SELECT1、業務データ変更0。
元バックアップ1,115,178 bytesを保持し、正常PREの世代名だけを新しくするv6を純検証した。
原8,006行・取得時計・一次キーは同一で、raw一次保管を重複せず、7979→7977行と
保護履歴262行の全検証を維持する。v6は受入721で正常EXIT0となり、01:13:53.735 UTCに
全POST7,977行を確認した。active7,716は源泉7,715行と過去の単発1行、対象外履歴261行も
全12列を保持した。既適格要約2,994行を維持。D1 1,764/Notion27/hosted6の全1,797応答は
HTTP200、最小Notion間隔380.544 ms・retry/UNKNOWN/STOP0・源GET/モデル0。
POST gzip1,054,343 bytes/SHA `70d7ded68c67edcad377e55308419ffb30135bb2da08b84c93da9967c902db59`
をpage `3f0d74ff-84cd-8176-ac35-c53577e33eaf`へ物理保管・全読戻しした。
complete SHA `0fbcf2c57e277079a880632de255dcac784ae98193b78b1d6896dc3aa4a4e603`。
元source取得時計と原本キーを維持し、v4/v5の失敗を成功へ変更しない。
01:20:30.989 UTCの独立全FSでは、元1,797応答の通常parser再解析、全native応答とD1 strict ACK、
全source/PRE/POST hosted本文、全262履歴を照合した。保存済み応答だけで通常SELECT mapperを
3回再生し、全POST・12列・親3,689行が一致。追加API・書込0、全照合SHA
`2cd983247fc0bbe6c63bb9e22f87504f8ccddcd4701f045b3f3aae4ee9f1d8f4`。

資金動向の通常業種売買代金ジョブもmain721で1回実行した。
[Actions37251494901](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37251494901)
は対象日2026-10-01、`dry_run=false / only=sector-turnover`。01:28:01 UTCに通常FAILURE、
全jobs終端後の01:30:11.442120 UTCのclosureでwriter不在を確認した。
実資格は3,688/3,689銘柄で、全銘柄一致の通常guardが集計を保留した。観測の保存試行0、
追加Yahoo・発行元・モデル0、再dispatch0。native endpointは不足コードを列挙しないため、
既知の8303株価保留と同一だとは断定しない。正常catalog同期4定義の更新対skip内訳と
Notion品質ログの独立packet読戻しは未観測。通常エラー通知jobは成功した。
全ログ・workflow・実時計のclosure SHA
`20abf6121ccbb8c044ffb78341e977395d81b8afb93daa75dfc700e7afe12169`。
全coverageに足りない源データを架空補完して成功にせず、#160の品質保留として残す。

## 通常運用チェック

[ops_check 37254314741](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37254314741)
をmain52c・入力なしで1回実行した。02:13:12 UTCまでに正式FAILUREへ終端。
鮮度観測は8件/失敗0、マスタは11列・2索引・孤児0、ライセンス検査も成功した。
本番33表402列、列地図11行・writer claim17件を正常に照合した。
SLOはTDnet・EDINET・日証金・株式財務の4件を各yellow/約1.5日と判定し、
通常の失敗通知で[#327](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/327)へ記録した。
全ログclosure SHA `af829c83baa53270bf59911d683a6015fa905624fcd65abea3cd002f59a3051d`。
収集元・Yahoo・モデル0。これは4層の実検査結果であり、すべての元データが正常という証明ではない。
週末開始の日曜24時間を誤計上する共有加齢処理を
[PR328](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/328)で修正した。
JSTの平日に実際に重なる区間だけ数え、UTC同一時刻・週末内・日中境界・未来起点を検証する。
閾値30/48時間・lag・原基準日・取得時計・祝日契約は変更しない。
元6失敗が修正後に成功し、SLO全101件・Ruffと全CIが成功した。
原4tupleを原logger時計で再計算した別FSはEDINETだけ35.18→11.18時間/green、
残3は同じ35.18時間/yellowだった。SLO内部のdatetime.now精度を捕捉した再現とは扱わない。
02:28:13 UTCにmain `ca378c775bbcc4928e437713a0e39d8aa61794fb`へ通常squash mergeした。
main CI37255527765の全2jobsも成功。同head Build111591774735のnative出力が直接示すversion
`c86a3006-dbf9-44e4-9472-ee8eada7bbc3`と、02:34:27/42 UTCの実metadata読戻しが一致した。
deployment `919825f3-5504-46a6-8e8c-1e60fc64cae9`は同versionの100%配信。
02:34:57.550 UTCにMac runtimeを通常FFでcaへ受け入れ、正準.envのaccepted revisionだけ変更した。
他bytes・0600を保持し、正式EXIT0/ロック解放を確認した。元opsのFAILUREは保持する。

修正後のmain caで[通常ops_check 37256039258](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37256039258)
を入力なしで1回実行した。jobは02:36:06〜02:37:40 UTCに正式終端した。
鮮度8件/失敗0、マスタ11列・2索引・孤児0、ライセンス33表402列・列地図11行・
writer claim17件の照合が成功した。EDINETは原10/4・1,453件・source epochを保持したまま
green/0.5日へ解消し、残るTDnet・日証金・株式財務の3件だけyellow/1.5日である。
元7 source tupleは変更していない。通常FAILUREと
[#327への実コメント](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/327#issuecomment-5987145189)
を保持し、自動closeは実skippedだった。全ログclosure SHA
`de0dc2c0aea8fd0530d24af77a406a1e5bf5bcbe3add6cc57d3f2548a78bf206`、
全4層の原field照合SHA `7ec08aaffe4aadd411cb35cf20f0887e4506602c11d7e6d879fa88c531091c7c`。
追加の収集元・Yahoo・モデル呼出し0。CLIログの照合件数を実D1書込数や料金へ置き換えない。

残3は別の契約・品質警告である。株式の木曜10/1止まりは金曜分の欠落可能性を残す。
株式の現CF起動は17:13 UTCで、UTC当日の確定終値と21:00 UTC期限を要求するため、
月曜11時JSTの手動起動へ金曜の日付を渡したり時計を戻したりしない。
日証金はCSVの申込日を基準にし、観測時は次の月曜12:17 JST定時更新前。
TDnetは最新公表日を測るため、当日開示0件の正常走査と未走査をこの指標だけでは区別できない。
基準日や取得時計を塗り直して警告を消さず、#292の契約課題と実更新確認を残す。

以下の各段落は元の実行順の記録であり、当時のLIVE/受入revisionは現在の完了数ではない。

## 再開処理の実装

TDnetは既存CLIへ `--resume-from=2026-09-27 --resume-to=2026-10-04` を追加した。
D1に保存済みの同じ開示情報を、通常取込と共通の二次保管・PDF分類・本文保存へ渡す。
一覧の再取得とD1一次行の再upsertは0、明示期間の二次処理には12分の新規開始上限を付けない。
既存終端ページも参照IDを返すようにし、保存D1からの再開で参照欠けを回収する。
一次保管・PDF全bytes読戻し・未知結果停止は既存共有処理を維持する。

検証は保存D1入力の二次保管再開と、既存終端ページの源GETなし参照回収の回帰を含む23件が成功。
実行結果と残件は、実処理の終了後に追記する。

優待要約は最後のcursor群が採用されてpendingから消えても、保存済み全元行の位置から続きを選ぶ。
実7979行・pending3592の純照合で、旧cursorの直前群32件の再選択が修正後0件となった。
関連111件の回帰が成功。5分足workflowは新規未観測2,429コードを既存 `--codes` に引用付きで渡し、
既知成功1,247コードのYahoo再取得を避ける。保存raw10件と未知PUT1件は別に資格確認する。

## 保存済み株価・5分足の実反映

`33f9ee6` の通常共有パーサとR2条件付き保存を使い、10/4 21:30:04.764〜21:32:12.912 UTCに
保存済み5分足11件を各1回反映した。PRE gzip 764,180 bytes、POSTのR2全11本文
3,522,020 bytes・57,220本を照合し、書込不明・資格拒否は0。原取得時計・URL・SHAを維持し、
Yahoo再取得は0。共有Notion物理保管・全読戻しは正常終了（Notion32/hosted6、429・再試行0）。
独立FS検証は保存した全R2応答・D1応答と原本を照合したもので、保存していないhosted応答bytesを
独立再検証したとは扱わない。

旧4368のPUT502は、その送信が成功したという証拠には変更しない。
現在の修復結果だけを新しい条件付き保存と全本文照合で受け入れ、旧UNKNOWN履歴を保持した。
残る未開始2,429銘柄は[通常Actions 37236301817](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37236301817)
へ1回だけ渡した。実行中の件数を全保存成功とは数えない。

同じ保存済み原文から、資格を満たす2026-10-01の株価54件を5つの原子的INSERTへ渡した。
実D1通信は更新5・POST読取1の6回で、全54件の値・銘柄同定・日付を照合した。
8303は原応答に負の調整後価格746件があり、全応答の通常資格を満たさないため1件を保留。
問題行の切捨てや対象日だけの再取得で成功数を作らない。通常日足36件の限定再取得と区別する。

完了receipt SHA `55634e61ce57f164540126b56389b1b386b6dfba472a60ae414059526d81caa5`、
独立FS SHA `e5e64121d40ca2f285bac5fa6d98346538457793e9a1e8059c7b4722a3f8fc10`。
receiptの旧計画欄 `writes/R2Calls/D1Calls:0` は実処理回数ではない。
実績は11 R2保存・54 INSERT・6 D1通信で、付随する実結果を根拠に集計する。

## 未開始5分足2,429件の通常終端と原本照合

同Actionsは10/4 22:38:50 UTCに終端し、保存2,409・同値16・通常エラー4、全2,429件を処理した。
未開始・保存結果不明・レート制限・中断は0。通常EXIT1を全成功へ置き換えない。
22:40:58.369 UTCに全81 gzip・2,429原本・元41,567,825 bytesと通常summaryを
共有Notionから全読戻しし、全物理SHA一致・欠落0を確認した。
R2全2,425本文の読戻しは22:52:44.626 UTCに通常EXIT0で終わり、両端のruntime/accepted `33f9ee6`を検証した。
全本文763,656,933 bytes・12,257,021 barsを保存し、22:54:34.378 UTCに原本との純FS照合も完了した。
元の新規OHLCV486,249行が全一致。読戻しreceipt SHA
`81ace45a386b59994f1e52194e224756795d763ebaa720cec15afbcb37bc1ffe`、
全照合SHA `aef0fe657a9c7775d34d14f6dc4b24a7f715a9ffa6a3f6729a033c5d0795a745`。
論理R2読取2,425回で、CLI内部の実HTTP attempt数は未観測として区別する。

4件は6396・7531・9087・9720。HTTP200の原文にtimestampがあるが、全候補がOHLCV欠損または
出来高0で、VWAPを計算できる実バーが無い。元原本だけで通常`parseBars5m`の同じ拒否を確認し、
追加Yahoo取得・値補完は0。旧1992・3477の2件と合わせた6件の原文品質保留を保持する。
新4件の純FS proof SHA `1057320b246ef31b3a5c54d2559147685b848394f890425d216ceabe79b907f2`。

Notion読戻し完了後、TDnetの実PID/commandを確認して通常間隔への復帰を指示し、
22:42:23.405 UTCに同稼働プロセスの`notionGapMs:380` ACKを観測した。
追加取得元/D1/モデル通信は0。制御記録SHA
`34f7161be637bc1a888cb2cbeb1f0773881bb2400ac31ae2fa030046ebf146df`。
R2 readerは完了した。稼働中のTDnetが終わるまでruntime/accepted `33f9ee6`を維持する。

元の5分足母集団3,689は、旧成功1,247・保存原本の修復11・新成功2,425・原文品質保留6で閉じる。
3成功集合は非交差で、旧未開始2,439もsource0処理10と通常処理2,429ですべて着手済み。
現在の保存結果不明0と、4368の旧保存応答不明履歴を区別する。
群ごとの全本文照合を集約した値は1,134,667,197 bytes・18,256,323 barsであり、
全母集団を新たに同一時刻に読み直したsnapshotではない。
集合closure SHA `842c371bd30c339f452ea800bf00f5431f200615902e73aaa9105d3003dfc5af`。

## 次営業日の実結果確認

次の対象営業日2026-10-05のCF処理は、10/6 02:13 JSTの株式dispatch、06:00のマクロdispatch、
06:05/07:05の期限確認である。未来の発火・保存成功を手動処理から推定しない。
既存Orca runtimeに10/6 07:10 JSTの実結果検証を登録し、enabled・次回時計を読戻した。
実CF receipt、Actions終端、保存先を確認して本repo/#196/#284に記録し、検証後に自分自身を無効化する。
検証automation ID `a3e9f5b3-e776-4a3d-a625-9d3395f8fa03`。Macが動いている必要がある。
Cloudflareの業務Cronは独立して動く。

## 日曜EDINET原応答の通常読戻しと契約検証

00:07:33.778 UTCまでに、通常Python NotionClientから元ページを1回読み、
元319 bytesを1回取得して共有の全ファイル検証に通した。完全な公式空応答に対する
新しいcollectorの本文契約も純検証PASS。SHA
`1fcbce19fc5b5d0e754bdfb527d47a64d2d64db1daed27b146fc8ce38a07a590`、
読戻しreceipt `36e341366c20255def40bbd01b3172841c90d61855fef5dfcc5b3bb7914a0c10`。
Notionに記録されたFetched Atは `2026-10-04T23:24:00.000+09:00` で、元発行元HTTP状態と
完全な取得時計は未観測。純関数へ渡したHTTP200を元取得時の証拠として扱わず、
旧FAILEDを修復成功へ書き換えない。converted2件の再取得・新EDINET API・D1・モデル・書込は0。

最初の85束縛起動はcleanmainのrevision変更を検出してAPI前に停止した。
N0/H0・lock/started/read-once未作成を確認し、旧STOPを保持したまま新4e計画を
純再検証して上記1回だけを実行した。runtime/acceptedは両端4e、通常writer finallyで解放済み。

## 契約`.13`の通常mainと本番配信

[PR322](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/322) は
全CI通過後00:01:26 UTCにmain `4e878cf0c3af82c6d50f925db672df460df34598`へマージした。
同mainのCI37245849052は全2ジョブ成功。同headのWorkers Buildは00:02:02 UTC成功、
00:05:46/47 UTCのnative metadataでdeployment `79feb6a8-0444-4d6b-ad89-59ac5f0be422`、
version `9e14e026-11f3-4670-b884-7b25ac08ee59`の100%配信を確認した。
nativeにGit SHAと実HTTP packet時計がないため、同head GitHub Buildと実作成時計を別に結合する。
closure SHA `d49097d7fc0174892ce595ef295bf5fcabfcab4eaf7482c4a20384e353233992`。
00:06:51.989 UTCにMac runtimeを通常FFで4eへ受け入れ、正準.envは
`BIZTAG_LOCAL_ACCEPTED_REVISION`だけを変更、他bytesと0600を検証した。
通常LaunchAgent・TypeSafe・MLX/Qwenの設定は変更していない。

日足修正main `6dc2f2f94474c0801b2d96426a6a0068f3a59c7b`はCI37246378674の全2ジョブ成功、
同headのWorkers Build成功と、native deployment `3e08a4fc-25e8-4adf-aa9b-2d94239e131c`・
version `620f9400-693b-484a-a1a2-04b2d96cd546`の100%配信を照合した。
closure SHA `85ed9d98f433c2e91f0b2251f8a611d7712f238ca0e33f0020b74bb30d52d187`。
00:14:07.369 UTCにMac runtimeも6dcへ正常FF受入し、30件の復旧中は固定した。

[PR324](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/324)は全CI成功後、
00:16:45 UTCにmain `0441671c3cd6f78007fdaeb03b5bf2fef5f07a62`へマージした。
同mainのCI・native配信・Mac受入は後続で完了し、217件の通常復旧中は044に固定した。

契約`.14`の[PR325](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/325)も
全CI成功後00:35:52 UTCにmain `721abdc1ece507fa50e9288be16a64073e5c3efb`へマージした。
同mainのCI37248141154は全2ジョブ成功、同headのWorkers Buildは00:36:37 UTC成功。
00:40:30.126379 UTCまでの正常native読取でdeployment
`8e6b1a7d-b9b5-4b41-81b4-9839d97b1432`、version
`05efabac-282d-4895-b3d9-c947dc2d4e66`の100%配信を確認した。
closure SHA `e4bddbcead16fa49e8aaa2cd89f3dbff784d97a5de268c70e984dc786338ab3d`。
metadataを読むlocal code HEAD044と対象main721は別に記録した。native Git SHA・
CLI内部のpacket時計とattemptは未観測。044の復旧・原回答保管終端後、01:09:16.845 UTCに
Mac runtimeを通常FFで721へ受け入れた。正準.envはaccepted revisionの1キーのみ変更し、
他bytesと0600を検証した。通常LaunchAgent・TypeSafe・MLX/Qwenの設定は変更していない。

## 有報15件の現在の対象資格

保存済みFSAコードリストの原header日付は2026-10-02。
ZIP 572,284 bytes/SHA `8181327d8ce2a51692c83f68071e3295d58af8b69fe0be130e70d5ff25630e77`、
全CRC・全11,402行を検証した。保留15件は提出者コード・社名・JCNが原本と一意に一致し、
上場区分は全件明示の「非上場」、証券コードは空。NULLだけから非上場を推定していない。
保存済みEDINET一覧5 gzipの全bytes・metadataと、21:18:29.089 UTCの正規提出者逆引き読取
（15提出者・対応0・書込0）を結合し、22:00:27.624666 UTCにFS照合を完了した。
closure SHA `05d51029e6e79ab55c43c17eb8eb950d171a605b33c4b5f5bf7d83eec0eee346`。

このFSA世代と現在の銘柄マスタでは、投資対象銘柄に対応付けられない非上場提出者である。
追加の書類GETや架空の銘柄コードを作らず、旧15件のidentity HOLD・文書・原時計を保持する。
非上場を永続除外する固定リストも作らない。既存の日次保留再照合は維持し、将来のマスタ対応を再判定する。
通常の有報取込母集団は `equity OR inactive+typeNULL` のままで、価格用active条件へ狭めない。
一覧0だった実日曜のPython実行/#305は別件で、この確認から取得成功へ変更しない。

## 要約の共有判定修正と本番配信

[PR315](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/315) は要約選定・月次持越しにも
既存の数値資格を適用し、各行の実受取条件で正しい既存要約を保持する。
実原文の12数量単位は同じ数値・同じ単位だけを比較し、単位換算・数量変更・別条件の金額を拒否する。
契約は `2026-10-05.10`。関連4 suite 181件・型検査・対象lintが成功した。

main `75119d8ee0af2a68a1a69ebe4d1547c483e438fa` の
[CI37239285233](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37239285233) は
10/4 22:19:11 UTCに全成功。Cloudflareの同SHA build
`053f6f0b-c72d-48f9-83d3-d47aff670308` も22:15:32 UTCに成功した。
native deployment `d1c150e5-8a67-4c1b-b74a-e2ce4bfea50e` と
version `2dabc948-dd8d-45e2-a7b7-52fd8eec223c` の100%配信を読戻した。
native version metadataにはGit SHAが無いため、同SHA buildと配信時計を合わせて示し、
期待SHAだけをnative証拠とは扱わない。

私有のmain CI原stdout SHA `91142747ccad98273e452643213f5ac34f9934404dd8afce838bbb572d29f203`、
check-runs原stdout SHA `7e3c4d8bc3f26df9c28e3209feef08c923fa8a7fbf096afb301187b858074ce3`。
Nix banner1行を含む原bytesは保存し、JSON解析時だけ既知の1行を検証して除外した。
稼働中のTDnetが終わるまで、Mac runtime/acceptedは`33f9ee6`を保持する。

[PR316](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/316)は、数量表記と保有期間定義の
比較を原文の同じ意味・同じ受取条件に限定して修正した。契約は`2026-10-05.11`。
別期間の定義本文に金額・交付条件・例外がある場合は除外せず、本文から条件を消す要約を引き続き拒否する。
main `7f30009e42aabc3aac274a46f94911c15dacd630`の
[CI37241351826](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37241351826)は
22:51:24 UTCに全成功。同SHA Cloudflare build `e8c0e93c-c254-4eba-a418-9afd1b4bd590`も成功した。
この時点のnative version読戻しはまだ実施しておらず、build成功と100%配信確認を混同しない。

[PR320](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/320)は、原文と同数・同単位の
「品」「缶」を契約`.12`で照合する。品目・品種・缶目・缶詰の部分一致、数量変更・換算は拒否する。
関連5 suite 204件と型検査・lintが成功。head `0240751682ef9841b6c046102561d3ebb6fdd1aa`の
[CI37243555018](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37243555018)は
23:28:47 UTCに全成功、同head Cloudflare buildも成功した。
23:32:39 UTCの通常squash merge後のmainは`62dcc4c9e70ffe39ddbe6cb1e891a352031970c6`。
[main CI37244141571](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37244141571)は
23:35:40 UTCに全成功、同SHA Cloudflare buildも23:33:33 UTCに成功した。
GH原応答の独立closure SHA `7d15c4c43be167cad085951ec58e86886228ce4562d841902210e236327f2e16`。
この時点のnative配信読戻しはまだ実施していない。

## EDINETの正常な空一覧の応答契約

[PR317](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/317)は、金融庁の公式v2仕様に従い、
HTTP200・要求日付/type・status/message・実処理時刻・count/results一致を全て検証した0件だけを
原本保管後に処理0件として記録する。不正応答・保管失敗は停止し、連続空振りのSLO監視は維持する。
全CI成功のhead `8e96e2e5a78cba63e1e47d21983c6a66622b9a19`を22:55:15 UTCにマージした。
mainは`b6c94682b0bf2efd6c68fb126be0965a38909082`。
[main CI37241835945](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37241835945)は
23:00:03 UTCに全成功。同SHA build `ae5ded60-f185-4a8f-94a8-aba6b88cca24`も22:56:04 UTCに成功した。
23:01:19.667/23:01:53.610 UTCにnative deployment
`095ecc9a-d23e-4dd0-b410-3b46a3a64241`とversion `cb73f228-d1db-4e40-be6b-811ee065afc3`の100%配信を読戻した。
同SHA buildと配信時計を結合し、native metadataにGit SHAが無い限界を保持する。
本番読戻しclosure SHA `2fbe85e7dd9d967635b9168c6ef318f1cff99c5257f084cd76825294cd90f058`。
新しい公開仕様PDFは原文1,570,381 bytes/SHA
`20b20e00739edf3a04d3dbd93ad55c06b1fb6fbb30375b5f06faae1e18c899b7`を保存済みで、物理Notion保管は未実施。
公式の公開応答例と、既に保管済みの実日曜319-byte応答は別物である。
旧実応答の完全な契約再資格は未確認とし、旧FAIL履歴を書き換えない。

## 優待の行注記による権利月

[PR319](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/319)は、表が3月・9月でも全文が
単一額面と独立した「3月のみ」の注記である実原文2行だけ、権利月を3月へ限定する。
利用・開催・申込・発送や複数額面の時期から権利月を推定せず、表との矛盾・随時混在は停止する。
保存済み全1,797応答・1,711詳細で、新旧投影は8,008→8,006行となり、他の本文・株数・備考は変わらない。
元原本SHA `86fa5c8c1dc11ba9856d7395525cba99008d39cd59cd11c7781c5a0deb1101b8`、
元取得時計13:06:11.365 UTCを保持した純照合で、追加取得は0。
全CI成功のhead `edb52b9426286ed182bcda875bdb55a0965af593`を23:10:04 UTCにマージした。
mainは`611a16e0a04777d9d184b5923a1b03fd6ffcbfcf`。DB再投影はこの時点では未実施。
[main CI37242763858](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37242763858)は全成功、
同SHA Cloudflare buildも23:10:49 UTCに成功した。
23:14:59.860/23:15:29.628 UTCのnative読戻しでdeployment
`216e18ce-58bc-4d98-b15d-2168119b56ea`・version `70c0fe2d-31d3-4ced-8788-35c4bbb265a4`の100%配信を確認した。
native Git SHA・CLI内部HTTP packet時計/attemptは未観測とし、同SHA buildと配信時計を結合した。
closure SHA `4d8fb44eadebe1321f19ad8bbaadf3d89760246a208993b6504e86d0660aa4fa`。

元source全8,008行と実DB7,979行の差29は、母集団の範囲で説明できる。
通常対象1,650コードの7,717行に、対象外の旧261行・過去単発1行を保持したものが実DB7,979行である。
対象外のsource61コード291行は通常取込の対象へ追加しない。
同じ実親集合・内容をPREで再確認できれば、新対象7,715＋保持262＝POST7,977が期待値となる。
原文条件の追加はせず、9月の誤投影2行だけを除去する。原子作直しで変わるIDsは実POSTへ再束縛して
要約・年間利回り・スコアの通常資格を検証する。純集合closure SHA
`04da903080f1f95e11ff97d0f7fc35e24800e38b7ce0fc6f80ec6247c458669b`。

## 不要ブランチの削除

完了PR316/317の元HEADはbundleへ全reachable履歴を保全し、`git bundle verify`が成功した。
bundle 8,348,337 bytes/SHA `0523a3f2de3c820e811106cf9fad31edbfd338975010e2f6b9095b012d7b1f04`。
両WTを同じHEADでdetachし、原ファイル・`.env`参照・私有候補を保持した。
実remoteの正しい2HEADを確認して不要local2・remote2を削除した。新たなlocal削除は通常`-d`だけ。
累計local54・remote29、local内訳は通常`-d`11・保全後の明示`-D`43。force-push・WT削除・pruneは0。
native結果closure SHA `64b80cc2a93c7d3bb02f71acc018acef2ad2effcf5d4e8ec09c891cefc44ae9b`。
続いて終了した要約生成`.8`・数値選定`.10`・PR319・PR320の4 local/3 remoteも削除した。
4 WTは同じHEADでdetachし、モデルが参照する原ファイル・私有原本・依存・`.env`を全保持した。
全reachable履歴のbundleは8,357,202 bytes/SHA
`e5d5ed6330f926402af34da67e6096b8641ff214122981360b1b73a3a29ff39a`、verify・全7 refs一致が成功。
既にremoteが無い`.8`は未使用の元生成枝でPRは無く、通常`-d`の未マージ拒否を保存した後、
保全済み履歴と所有者の参照不要確認に基づいて明示`-D`でlocal参照だけを削除した。
残る3件は通常`-d`・通常remote削除で、23:40:13.448 UTCの実remote読戻しで全不在を確認した。
累計local58・remote32、local内訳は通常`-d`14・保全後の明示`-D`44。
force-push・ファイル/WT削除・pruneは0。main・runtime・PR321・この記録用ブランチ・
ユーザーのdirty WTは保持している。

続いて所有者の不要確認後、完了PR321/322の2 local/2 remoteも保全して削除した。
全7,549 reachable object IDsを独立bareへ復元・fsck・元集合と全一致させたbundleは
8,360,890 bytes、SHA
`0353f9981470f8930f9f2c4c266fd3ffedfc039fa8ac8f14feea79f330431111`。
各WTを同じ元HEADでdetachし、元回答・全通常ファイル・symlink・`.env`・依存を保持した。
最初の私有検証のSTOP2件と、同時稼働Museが正当に追加した原ファイルも保持し、巻戻し0。
00:15:54.539764 UTCに両refの削除・不在を確認した。累計local60・remote34、
local内訳は通常`-d`16・保全後の明示`-D`44。closure SHA
`18593665874123d9e95f3d36e32f2150dadbff73a7b3c346df92655577d0aabc`。
PR323/324/325/326と記録用refは処理・検証が終わるまで保護し、最終段階で同じ保全後削除を行う。

通常処理・全生成・物理保管・修正後opsの正式終端と所有者の不要確認後、
PR323/324/325/326/328の5 local/5 remoteを削除した。各元HEADの全履歴を保全済みbundleから
独立bareへ復元し、全reachable object集合とstrict fsckを再照合してから、WTを同じHEADでdetachした。
全通常ファイル・symlink・`.env`・依存・私有原本は削除前後で同一、5件とも通常`-d`と通常remote削除だった。
累計local65・remote39、local内訳は通常`-d`21・保全後の明示`-D`44。
fresh全ref読戻しでremoteはmainだけ、localはmain・runtime・ユーザーのdirty WT・この記録用refだけ。
force-push・WT/ファイル削除・pruneは0。記録用refもこのPRのマージと本番受入後に同じ条件で削除する。
最初の3件は正常EXIT0後、外monitorが結果ディレクトリを誤転記してEXIT1になった。
元失敗を保存し、実削除の再入0で原receiptと残2件の正式EXIT0を別companionへ束縛した。
全実closure SHA `a7b158930d0886a7d4e9ee8a5d8192bce2cd54ad06b586529b836afe976b9125`。
