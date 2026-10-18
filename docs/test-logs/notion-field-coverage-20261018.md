# Notionの列別充足と通常writer — 2026-10-18

追跡: [#348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。固定バッチの処理完了、行の存在、列の充足は別の受入とする。過去の本文2,417社・保有明細2,822行等の完了件数を全DB・全列の完了とは扱わない。

## 現在の保存状態

10/18 19:41 JSTまでの読取で、現役普通株3,687社に限定して補足の基本情報と主マスタを照合した。補足DB全3,713行、主マスタ全3,857行を通常の共有Notion clientで列を絞って取得し、D1の現役コード・名称・業種と結合した。異時点の読取であり、全DBの原子的snapshotではない。39本文列はこの読取に含めていない。

| 対象 | 実測 | 自動処理の不足・対応 |
| --- | --- | --- |
| 補足の行 | 現役3,687社の行は全て存在。3,666社が取得済・判定済、21社が本文なし | 状態の存在だけで39本文列の充足を証明しない |
| 補足の33業種 | 空欄11社。うち8社は保存済みcoreと主マスタが一致 | 本文なしでも基本情報だけを補完できるよう通常writerを修正。残3社は業種根拠不足 |
| 補足→主マスタ | 空欄7社。うち4社は既存主マスタが一意 | 本文取得と独立して、既存の正しい主マスタへ結ぶ。主マスタがない3社は保留 |
| 主マスタ | 現役3,684社の行あり、622A・641A・648Aの3社なし。既存行の主要業種・EDINET・出典・取得日等は空欄0 | 通常月次処理を追跡。`--codes`の未適用を修正し、指定外への更新を防ぐ。新規3社の根拠確認は別受入 |
| 補足の書類情報 | 本文なし21社で書類種別・期末・提出日が空欄 | 有報が未選択なら値を作らない。原本・主体・最新文書選択が成立してから通常取込で埋める |
| 補足の39本文 | 今回の全列欠測数は未測定。従来は同じ書類・同期receiptがあると本文を再読しない | 現在の39列を実際に読み、保存された同期SHAと違う場合だけ原本文を再資格化・修復する |
| 競合情報 | 版・書類・判定日の欠測25社＝本文なし21社＋本文あり4社。関連先空欄308社 | 定期処理は最大5社の機械的な準備まで。意味判定・関連先の全自動補完は未実装で、準備完了と同一視しない |
| 財務サマリ③ | 全履歴35,158行中、ROE空欄23,722、ROA空欄35,149。主マスタrelation空欄1,652 | 期間・連結範囲・非公表・抽出未対応・未処理の全件分類は未完了。株式財務断面41社のD1修復はこのDBの補完ではない |
| 原本⑤→主マスタ | schemaは存在したが、通常添付writerにrelation設定がなかった | 主体が上流で確定した個別TDnet/EDINET原本だけ既存IDを渡す。全市場一覧は結ばない。既存SHAによるskip行の過去補完は別途残る |
| 上場状態・旧ミラー | 主マスタの状態selectや旧需給/優待の逆relationに空欄が多い | 状態は発効イベント所有。空欄を非上場に変換しない。廃止済み②⑥⑦・旧⑧⑨のmirrorは再開しない |

空欄の業種11社は625A・621A・618A・622A・623A・627A・619A・640A・641A・642A・648A。保存値での修復候補8社は622A・641A・648Aを除く。既存主マスタへ結べる4社は618A・627A・640A・642A。これらは全て本文なし21社に含まれ、本文がない段階でskipする旧plannerでは補完されなかった。

保存済み10/18 FSAコード表には622Aの直接証券コードがある。提出者業種はサービス業、保存JPX業種は情報・通信業だが、既存`contracts/sector33.py`はFSAの提出者申告を保存し、JPXとの分類差を訂正しない契約である。622AはFSA根拠で主マスタ作成可能。641A・648AはFSAに法人名があっても証券コードが空であり、名前だけで結ばない。出典の利用条件も保つ。535/536の銘柄指定ではD1業種を更新していなかったため、今回、選択した銘柄だけを既存の業種writerへ渡す。全市場の診断・写し更新と、未確定tickerの推測は行わない。

## 通常処理への修正

補足の基本情報は本文とは独立して選択する。現在の現役銘柄・名称・業種・最新文書選択を1社単位で再確認し、空欄だけを補う。非空欄の相反、現在の文書変更、根拠不足は保留する。文書なしは正規のnullとして扱い、架空の書類ID・本文・タグを新造しない。既存の物理PRE・書込前CAS・全文POST・publication journalを通す。

本文は既存の全長property paginationを再用して39列を検査する。同期SHAに一致すれば元本文やモデルを読み直さず、差がある場合だけ元本文SHAと現在の選択を資格化して同じwriterで修復する。毎日の対象はコード順に回る最大50社で、母集団が変わらない現役3,687社なら対象選択上は74日で一巡する。実検査の完了は予算・休止・保留に依存する。これは日々の費用を抑える巡回検査であり、初回全件確認の代用ではない。初回・過去分は同じ通常CLIの明示`--codes`で有限範囲ずつ確認する必要がある。

CLIは実測した検査対象数・検査済数・未検査数・本文差分/修復数・基本情報修復数・保留/失敗数を出力する。Macの既存実行receiptとR2 mirrorはこの件数だけを保存し、監視はexit0でも残件を検出する。従来receiptとの互換は保つが、古いreceiptから件数を推測しない。`wholeSupplementComplete=false`を固定し、当日の検査窓の完了から全DB充足を宣言しない。

全て決定的な処理で、新しいモデル・依存ライブラリ・DB・外部取得元は追加しない。事業タグの適格な新規/変更入力に限る既存ローカルClef例外は維持する。39本文の元要素不在、財務の非公表、主体/権利資格の不足は生成値で埋めない。

原本⑤のrelationは、TDnetの個社XBRL、EDINETのliteral証券コードに対応するtidy/PDF、既存6DEIが一致した追加ROA原本へ渡す。PythonにTDnet PDFの⑤添付callerはなく、Nodeの会社別IR添付とは別経路である。既存SHAでskipした過去行のrelationをこの変更で補完したとは扱わない。

## 読取根拠と受入範囲

私有根拠は`tmp/feature-audit-20261018/supplement-main-column-coverage-plan-v1/actual-thin-v2/known-full-closure.json`、SHA256 `cceb8e8e608a1126a10961485036b7009ef3cdf376f054b957950e45dfa56a3b`。補足先頭3,600行の旧有限読取は期限の余地不足で正常な部分停止とし、新しい期限で残113行から再開した。前半37＋後半43native要求、Notionの基本列とD1のコード/名称/業種のみ。モデル・新規取得元・業務書込0。

保存値による修復候補の根拠は同directoryの`saved-repair-candidate-mapping.json`、SHA256 `9091d9c6b141dd04999a82b260f829049b8c726b0dc904c990f3315fdcc5e629`。財務履歴の集計と補足状態集計は`tmp/feature-audit-20261018/notion-field-coverage-audit-v1/`に保管した。補足全39列のSQL集計は400で失敗しており、この失敗を欠測0の根拠にしない。

この段階は読取と修正の記録であり、新writerの本番配備・現候補への実適用・初回39列全件検査は未受入。各実行後に別途結果を追記する。

Nixの関連TypeScript 7suiteは305件PASS・既存private原本未配置2件SKIP。その後のHOLD重複除去の直接pipeline suiteは45件PASS。Mac receipt/競合stageの23件と監視Python22件もPASS、全体TypeScript型検査と変更したsourceのlintは通過した。追加ROAはcanonicalに既存保存された6ZIPだけを明示参照し、変更worktreeの実装で13件PASS。外部取得・モデル・業務書込0。Pythonはeditable環境の旧sourceを誤読しないよう`PYTHONPATH`を変更worktreeへ明示して検証した。

## 本番反映と初回検査の入口

#535はPRの3checks成功後main `ae8578291d6ecf12515c8519de92a169b103818b`へマージした。19:56:38 JSTのCloudflare build `a5dd2ec6-66c4-45fc-9add-72386848838f`でversion `4095e5bb-5aa2-41bb-9cab-46a0c1d1fbec`と設定同一の10triggerを確認。SSHも同mainへfast-forwardし、変更なしを確認した。

19:57:27 JSTにMacの両定期labelを同mainの専用Nix runtimeへ切替。元の20/21時・`RunAtLoad=false`・引数・ログ・stateを保持し、plistの変更はWorkingDirectoryだけ。通常preflight/installerとkernel排他を用い、旧env/runtime/plistを保持した。監視の期待revisionも配備版へ更新。切替時の業務HTTP0、自然起動とデータ充足は別に確認する。私有根拠は`tmp/feature-audit-20261018/mac-field-coverage-main535-cutover-v1/cutover.json`。

初回の有限検査は、同じ通常CLIの**明示`run --mechanical-only`だけLinux Nixでも許可**する。環境ファイルの所有者/0600・承認main・clean HEAD・ancestor・Nix Pythonのkernel flockは維持し、モデルを使う入口とMac定期の制約は変更しない。未知引数・モデル許可は通信前に拒否する。実検査済み銘柄を`textCheckedCodes`に出力し、部分停止後の残りを件数から推定しない。これはSSHの実実行受入とは別で、同時に複数hostからNotionへ書かない運用が必要。kernel flockはhost間の分散排他ではない。

## 財務サマリの空欄と過去分

ROEは当期・同連結区分の直接開示、ROAは年次の純利益ROAの直接開示だけを採る。四半期ROA・営業ROA・目標・平均値や、利益÷自己資本等による推計で空欄を埋めない。予想は通期、配当は適格な年額が必要で、別年度や半期合算で代用しない。従って履歴35,158行の空欄数は、そのまま要修復件数ではない。項目別の空欄理由は未保存で、現在の全件内訳は未測定。

既存`pipeline/scripts/reparse_financials_from_notion.py`は、保存原本SHA照合→cached再解析→Notion更新とfresh再読→別操作のD1同期を行う。9/28には34,659財務キーの修復・同期記録がある。通常日次は対象日の文書だけで、過去全履歴を定期再解析しない。別保存type1の表参照は日次EDINET側の追加経路であり、旧CSVの汎用再解析だけでは補えない。

再解析cacheのfingerprintがconverter/normalizeだけを対象にしていたため、呼出先`direct_roa.py`/`direct_roa_table.py`の改修を見逃す不具合を修正した。この2sourceを既存SHAへ追加し、helper変更後は旧成功cacheでも再解析する。新stateや数値ルールは追加せず、保存根拠の全履歴再適用は別実行。Nix関連4suite81件PASS・既存原本未配置20件SKIP、直接回帰は旧実装でFAIL→修正後PASS。Linux/検査済code出力の関連3suite59件PASS、型検査・lint通過、独立FSレビュー指摘0。

## 20時の自然起動と表記差の補正

main535の定期jobは20:00:06.214に自然起動し、20:05:05.247にcode0・signalなしで終了。対象50社の39本文を全検査し、未検査0・差分0・修復0、基本情報は640A/642Aの2社を補完した。両社の業種・主リンクをnormal publicationのPRE/intent/completionと固定候補へ照合し、本文・タグ・本文なし状態の変更なしを確認。終了receiptはR2の同一keyへ全文一致した。モデルforward/新取得元呼出し0。これは50社窓の検査受入で、全補足充足ではない。

データ側はqualificationHeld24社でattention。summaryのfailures4件は本文なし基本補完のHOLD説明で、取得/通信障害4件とは分類しない。保留には本文なし21社と2683/3840/634Aを含む。私有根拠は前節directoryの`natural20-r2-readback.json`と`tmp/feature-audit-20261018/biztag-natural20-metadata-fs-snapshot-v1/`。全job完了と個々の原本文書欠測を区別する。

業種候補の残6社は、保存補足の「（株）Skyfall」とcoreの「Ｓｋｙｆａｌｌ」等の**表示名の表記差**を新しい完全一致guardが相反と判定していた。同じ現役コードの表示比較だけNFKCと境界の法人格1個を正規化し、旧非空タイトルは変更しない。略称・類似名・法定主体の推測には使用せず、厳密な最新source照合は維持する。

全件初回検査で同じ39列を再読し直さないよう、既に完全検査した銘柄の実際の空欄数を全39項目で集計する。修復成功は最終POST、資格HOLDは同じ銘柄から全GETした現在値、未検査・取得失敗・メタ情報だけの補完は計数しない。`textEmptyCounts`と`textCheckedCodes`は通常JSON出力だけで、counter receiptへ本文や一覧を加えない。空欄から非公表/未対応を推測分類しない。追加HTTP・モデル・保存先0。

今回のNix TS関連3suite170件PASS、Python関連4suite98件PASS・既存原本未配置15件SKIP。全体型検査・対象lint・独立FSレビューも通過。表示名差の6社・622Aの実適用と初回3,666社の検査は別に受入する。

## SSHの基本情報補完と初回検査の読取範囲

#537のmain `ef21d3e4bdad45474cceaa682ff67d49a8746644`をSSHへfast-forwardし、専用のclean detached runtimeで通常CLIを実行した。元の`.env`を変更せず、同じ資格情報から所有者限定0600の実行envを用意し、Nix内で同じuv.lockの依存を準備した。20:22:12–20:22:25 JSTの`master_sync --require-cloud --codes=622A`は処理1・失敗0で終了し、①主マスタ1社とD1の同社業種1行を更新した。全市場の業種診断や写し更新は0。641A/648Aは公式の直接証券コード未確認のため保留する。

20:23:52–20:25:18 JSTの通常`biztag run --mechanical-only`では、表示差6社・622A・既補完640A/642Aの9社だけを指定し、基本情報7社を物理PRE/CAS/POSTとpublication journalで補完した。本文検査0、未検査9、本文なし状態と旧タグを保持し、モデル・新規取得元0。私有実行根拠はSSHの`tmp/supplement-initial-text-check-ssh-v1/`に保管。これらの終了件数から全39列の充足を推定しない。

補完後に同じ欠測対象11コードだけをfresh再読し、補足の業種・主リンク、主マスタ、core業種の欠測は全て641A/648Aの2社だけと確認した。622Aは①のEDINET E42099とFSA業種サービス業、core/補足の業種・一意な①relationが一致した。shared clientのNotion READ4回と対象D1 SELECT1回、3.620秒、追加取得元・モデル・業務書込0。publisherの7completion・未閉鎖intent0と実行PID消失もFSで確認。私有根拠`tmp/feature-audit-20261018/supplement-metadata-post537-v1/post537-readback.json`のSHA256は`2f7ed29aae9649699216041d6a665d356f158f1b4c535ab64712bfb3e6deca15`。19:41全量とこの対象限定再読は異時点であり、原子的な全DB現況とは扱わない。

初回3,666社・74有限バッチの開始前に、明示scopeでも関連先マスタを全市場から毎回読み直す箇所を検出した。共有`loadStockMasterIndex`へ任意の正準コードscopeを追加し、必要時だけ50コード以下のexact ORを全paginationする。空・重複・非正準入力はHTTP前、対象chunk外応答や不正schema/paginationは採用前に停止する。同コードの複数行は従来どおりrelationを採用しない。既に主マスタ関連がある本文検査・同期ではマスタ取得自体を省く。scope省略の日次全量契約は変更しない。

Nixの関連2suite91件PASS、変更source/testのESLintと全体TypeScript型検査を通過。scopeによる50/1分割、全pagination、HTTP前入力拒否、対象外応答、重複不採用と、関連済み検査の読取0を回帰検証した。初回全件の実行・列別空欄理由の分類は別受入である。

独立FSレビューは4source/testの固定bytesと呼出経路を確認してblocking0。根拠`tmp/feature-audit-20261018/biztag-scoped-master-lookup-v1/delegate-independent-fs-peer-v1.json`、SHA256 `2607ee9469da07ce05c0eb78a84ae15eb318aeb3879a3e820498687122299c97`。このレビュー自体の追加API・モデル・業務書込0。

## 初回50社と検査範囲の追加確認

#538はCI3checks成功後20:39:11 JSTにmain `fa4d5f4de26bdbe2c9c29c59bcf6acab700bd278`へマージした。Cloudflare build `cd602740-ade3-434e-a102-1b64d72a984a`は20:39:36にversion `f3119705-d490-439a-9595-eca8538d14b6`・同一10triggerで配備完了。SSHも同mainのclean専用runtimeへ更新し、既envの承認revisionだけを変えた0600ファイルで通常preflightに成功。元envは未変更。Macは当日535の自然起動receiptと監視期待値を保持し、このSSH限定実行に合わせて変更しない。

SSHで20:39:42–20:40:32 JSTの最初の50社を通常`run --mechanical-only`で検査。実行49.576秒、全50社の39本文を確認し、未検査・同期差分・修復・メタ修復・保留0、主マスタ読取なし、モデルforward/外部判定API0。実空欄は6項目に計75セルあり、同期差分0を空欄0とは扱わない。この1バッチだけから全3,666社の完了を宣言しない。有限74バッチを直列で進め、21時定期と同時書込しないよう一旦区切る。

Sonnetによる固定Gitコード限定の先回りレビューもblocking0。実モデル`claude-sonnet-5-5`、99.7秒、CLI参考費用USD0.4402149（実請求額ではない）、tools/MCP/本番API/書込0。私有根拠`tmp/feature-audit-20261018/sonnet-scoped-master-review-v1/accepted-review.json` SHA256 `6f2e6e89fe4b3ba3b76328f27964d47353fcfba63b8f0ba0a4281cb611ee7c87`。これはコードレビューであり、列充足や本番性能の実証ではない。

39列の通常検査は現在Notionと保存済み同期SHAの一致を調べ、原CSVを毎回再抽出しない。保存CSV4通の全ZIP SHAを照合して現parserを実行し、38/36/38/38節を確認したが、非空の正規TextBlockの取りこぼしや文字数切捨てはこの4通で未確認。元要素不在へ別注記を代入しない。旧parser由来の全件漏れを証明/否定する検査ではなく、必要な再抽出は既存`backfill-text-sections --doc=... --force`で行う。私有根拠`tmp/feature-audit-20261018/supplement-metadata-post537-v1/saved-csv-four-extraction-audit.json` SHA256 `47df0558cf624e61667c56e38ea2e568179c426621d740e3e705d57f5e21cee9`。

## 財務の過去分と主リンクの追加確認

日次の適格な数値は同じ原本からNotion③の19数値列とD1へ接続している。汎用の過去再解析は既relationのCSVのみを使い、日次側の別保存type1 ROA表を自動で採らない。また主マスタIDを渡さず、主relationの空欄補完にはならない。保存済み3社のCSV NULL→直接ROA表の採用例は既に実適用済みで、追加の現Notion誤NULL件数は未測定。無条件のtype1全量取得や、ROAの算出・原本の付替えは行わない。FS根拠`tmp/feature-audit-20261018/financial-summary-remaining-fs-audit-v1/delegate-fs-audit-v1.json` SHA256 `cd7961cf8efb2345fb5415de1ec20379b1b19582acb8833050f843de61c1118d`。

主relation空欄1,652行の先頭20行に続き、同じ薄い列指定で全cursorを閉じた。fresh先頭20行と残1,632行の18要求・34.298秒・3,455,382B、全200・再送/429・原本取得・モデル・業務書込0。全1,652行/370コードに原本relationが1件ある。保存済み①と結べるのは593A/634A/624Aの3行で、残1,649行は保存済み主マスタ・現役coreに不在。REITや歴史銘柄を含み、現在のページ不在を歴史的な対象外の証明とは扱わない。先頭20行の実測は保存し、全件結果に置き換えた。全件受入は`financial-master-relation-sample-v1/sealed-tail-v1/delegate-tail-acceptance-v1.json` SHA256 `c4acff7bcbc1c1d7bd6bfe331379f2b98e69053048db513989a25d6dfa4f8c42`。

上記3行のfresh財務・①・⑤計9要求と、既保存の物理ZIP3件227,553Bから全SHA/sizeとnative DEIのEDINET・証券コード・法定名・期末・開示区分・連結区分を機械照合した。624Aは現役coreの外にあるが、同じ法定主体の履歴relation候補であり、現役化や別主体への付替えはしない。根拠`candidate-qualification-v1/delegate-candidate-qualification-acceptance-v1.json` SHA256 `74f66a1ae777a9bec29b0ff31df74feebf4e021c07b3646491f4f2f0ae4cc6be`。通常helperの時計条件を確認するfresh財務/⑤計6要求は10.220秒・39,008B、全200・再送/原本再取得/業務書込0。593Aは通常の同SHA再利用により⑤が初回取得時計、③が再取得時計になるため、両時計を独立にtimezone付き・非未来と検査し、等値や順序を作らず保存値を保持する。

## 月次の財務マスタrelation補完

通常`master_sync`から、今回選択した適格コードの空relationだけを補完する。新規作成①だけに限定せず、前月に根拠不足だった既存①も次月の対象にする。コードORを50社ずつ、空relation filterと7メタ列を指定し、各chunkの全paginationを終えてから書く。3,858コードの場合の発見は最低79薄い要求（schema1＋query78、該当行の追加pagination/資格検査/保管は別）で、財務35,158行の全本文走査は行わない。

該当行だけfresh全PRE・一意な①・既保存原本の全SHA/sizeとnative6項目を照合し、既存R2 raw bucketの財務page ID固定keyへ条件付きpendingを作る。既存共有窓口で物理PREを保管して全財務・①・⑤の書込直前比較を通し、空relation1列だけPATCH、全POSTと物理保管、同ETag条件付きcompletionと読戻しまで通す。19数値・原本relation・出典・ライセンス・源取得時計は全て保持する。claim後の不完全CAS/POSTや通信結果不明はrunを止め、pendingが別run/hostの再PATCHも止める。Notion PATCH自体のatomic CASを保証するものではない。

R2の条件付き更新は[公式S3拡張](https://developers.cloudflare.com/r2/api/s3/extensions/)の`If-None-Match`/`If-Match`を使う（2026-10-18確認）。既存SDKの条件付きwire再送は残るため、PUTを単送とは扱わない。412や結果不明は再claimせず停止する。新bucket・秘密情報・モデル・代替ローカル状態は増やさない。コードの受入と上記3行の本番適用は別に記録する。

## 21時の自然起動

Macの優待要約はmain535のまま21:00:06.265に自然起動し、21:00:08.940にcode0・signalなし・再送0で終了した。通常receiptはR2の同一keyと327B全文一致、実行PID終了・plistの21時予定/RunAtLoad=false保持を確認した。監視の期待revisionは当日の20時/21時receiptと一致する535を維持し、SSH本文検査用538や後続mainへの切替で当日成功を無効化しない。受入`mac-yutai-summary-natural21-v1/final-acceptance.json` SHA256 `343e96f29dee368f403b783201cc8a23af9d5031d4aee12dba341190d5f3ad90`。これは自然起動の受入であり、優待の全列充足とは扱わない。

## 指定ビューの事業内容と事業タグ

ユーザー指定の[銘柄マスタ（補足）Default view](https://app.notion.com/p/kabu-labo2/3e6d74ff84cd8119a15ec61865c436a1?v=3e6d74ff84cd811c88f4000ced862391&source=copy_link)を直接確認した。sourceは`3e6d74ff-84cd-81c9-9e4f-000ba435581f`で、監査中の補足DBと同じである。全3,713行の薄いSQL集計では事業の内容・有報IDの空欄が各21行、事業タグ3分類が全て空の行が991行あった。うち970行はv5の「判定済」で、候補語数0が89行、候補語数あり881行。本文同期SHAの一致をタグの充足とは扱わない。

空タグ991行のコード・状態・候補数・根拠文字数・入力prefixだけを、コード/pageのkeyset順で全10窓取得した。本文は取得せず、991コード/page一意・終端まで閉鎖した。21:17:40–21:18:37 JSTの範囲観測で、原子的snapshotではない。私有根拠`user-view-business-tags-v1/empty-tags-collected-v2.json` SHA256 `e9b2dc0bb53c6f14ed42bfbc3b607fbb351ee3311230e5351c11261f925671b7`。19:41保存の現役普通株3,687社とのFS結合では空タグ981社（本文なし21、判定済960）。判定済960のうち候補語数あり872、0が88。候補あり872の要確認文あり255・なし617で、後者を原判定「全いいえ」の証明とは扱わない。

保存Clefの112batch/110コードと重なる19社は全て現役で、同doc・保存4SHA・語彙・model/較正・応答が一致したが、採用確率のタグは0、11社が要確認、8社が全いいえだった。従って保存yes結果の反映漏れを再利用して埋められる社数は、この集合では0。候補語数0の88社も、語彙の対象外と業態をカバーできていない問題を分けるための追加確認が必要で、正しい空欄と断定しない。根拠`saved-output-overlap-v1/saved-output-overlap.json` SHA256 `57d2dba9c7b317688df0dd7b63bc1e6414aa4eda5545c256204505f1b05d355d`。

通常plannerは同docの「判定済」を再利用するため、この空タグを本文39列の検査だけでは補完しない。全社の無差別再判定や旧判定をキーワードだけで覆す方法は採らず、明示した有限コードの空タグだけを既存ローカルClef・原本資格・PRE/CAS/POSTへ通す入口を実装中。定期の新規初回/実入力変更の経路は維持する。全いいえ・要確認・語彙候補0は再確認と記録し、タグを埋めた件数には加えない。

## 空タグの明示再確認入口

ユーザーの空欄指摘を受け、`biztag run --repair-empty-tags`を追加した。固定1〜50の一意な正準コード・同数limit・明示20分以内budgetを必須とし、active返却コード集合が指定scopeと完全一致しない場合は本文/モデル/書込前に停止する。現在の適格有報と既存行の同doc・通常のメタ/来歴資格・判定済み・3分類全空だけを専用markerで選択する。非空タグ、本文なし、入力変更や根拠不整合はHOLDにして、通常の別writerへ流さない。

既存の原文読取・候補語抽出・固定Clef較正・durable journal・物理PRE/CAS/全POSTを再用する。一意なマスタを解決できなければ旧relationを消さずモデル前HOLD。旧no/uncertainをkeyword一致だけで覆さず、入力変更の再判定とは異なる専用prefixを記録する。機械専用/dry-runは本文・モデル前HOLD。通常定期の既定対象・モデル・しきい値・秘密情報・保存先は増やさない。

summaryの`emptyTagRepair`はselected/eligible/rechecked/tagged/allNo/uncertain/noCandidates/held/remainingを分ける。タグ付与と要確認は同時にあり得るが、全noは候補ありで両方なしの場合だけ。候補語なし・要確認・全noを空欄補完成功とは数えない。完全同一の保存決定を再利用する場合は元の判定完了日を保持し、今回のpublication時計は通常journalへ残す。

Nixの直接関連4suite214件PASS、全体TypeScript型検査・変更8source/testのESLint・diff checkを通過。readyは`biztag-empty-tags-requalification-v1/ready-v1.json` SHA256 `16b9046c0fbfbd75f3809c5d008ad74d0e9c414419d9f71005e5c9f41326b567`。このコード検証時点で新しいモデル推論・原本取得・本番書込は0で、981社の再確認やタグ付与を完了したものではない。

## 空タグ3社の実適用と本文なし21社の追加診断

#542はCI3checks成功後21:38:56 JSTにmain `9ed177cc8b0d835d81ff58db57e0fd4f3e3bcf2d`へマージした。同mainのclean Mac専用runtime・所有者0600の専用envでpreflightを通し、SSH本文54窓の自然閉鎖中に固定1401/1414/6156だけを通常`--repair-empty-tags`で実行した。21:43:45–21:44:47、61.455秒、exit0・再実行0。適格3/再確認3/タグ付与2/全no1/要確認1（タグ付与との重複あり）、HOLD・残件・failure0。Clef実推論2・完全一致保存結果再利用1、外部判定API0。Notion56要求・429/再送0。料金はローカル未計測で、費用ゼロとは扱わない。

1401は「総合建設（ゼネコン）」と住宅の要確認、1414は「土木・道路舗装」が保存された。6156は保存6問が全noで、空タグと元の判定日を保持した。3社とも同doc・原入力4SHA・現在39本文の送信SHA・raw答え・しきい値・物理PRE・publication completion/通常POSTを独立FS照合した。同じNotion sourceの3社だけを追加で薄く再読し、上記2タグ・全no1・専用prefix・本文長2,084/684/1,611字を確認。原本不在や全noを埋めた件数に加えない。

私有受入`biztag-empty-tags-pilot-v1/delegate-independent-saved-pilot-acceptance-v1.json` SHA256 `019700060681a10fc735f9102f05d4c721339d0e47f94a4cdfcb1d050fd8c0dd`。見える3社の再読SHA256 `20402a38cc3cde6252c3c1b836b6d1519019d214b285fc67881487f6af20e787`。21:56の同sourceのfresh集計は全3,713行・事業内容空21・タグ3分類全空989で、実2社の補完を確認した。薄い集計の私有保存SHA256 `07c6132a83237d4f1c2d2b1d409355f9616eb7fbcf408024f27e3b1688417ee4`。過去の991行と異時点で、原子的な前後snapshotではない。残りの現役・候補語あり869社を25社ずつ35区分に固定したが、計画作成と実適用は別受入である。

21:48:02–21:48:03の通常`loadLatestDocs`に21本文なしの固定コードを渡し、SSH Nixの対象D1 SELECT2回だけで確認した。21社すべて現役返却、120/130の年次文書選択0、reported HOLD0。応答2,571B・read7,437行・write0、本文・Notion・外部取得元・モデル・再送0。これはD1の年次未取込であり、公式の未提出/候補不在/取得漏れ/原本資格HOLDを区別した結果ではない。診断`supplement-no-text21-fresh-latest-v1/diagnosis.json` SHA256 `2c09f126ad9d4225854f0afb82223b181d51c7adb251d0aaab7f2079b9496da8`。

22:01の追加1 SELECTでは対象21 EDINETコードだけの120/130 metadataを現役条件なしで既coreと結合し、別銘柄に結ばれた年次候補も0件だった。1.754秒・応答371B・read38,241行・write0、本文/Notion/外部取得元/モデル/付替え0。18社はFSAの現証券コードと①が一致、627Aは保存①のみ、641A/648Aは診断用途の未資格対応を維持した。これは既DB結合集合の不在で、公式historyの不在や孤立文書の不在を証明しない。診断SHA256 `9843a2e6b49e3dd22dc21fe675f0e02a17d6c385e2df80a329a35eae58e05435`。

旧候補語0の現役88社も現在のprefilterでは未確認のため、有限再確認に含める。既869社と88社の一意unionから、pilot3社を除く現役957社を固定した。25社×38＋最後7社の39区分、通常`--repair-empty-tags`・同数limit・20分の新規入場予算で直列実行する。候補0ならモデルを呼ばずnoCandidates、候補があれば既Clefで判断する。語彙・しきい値・原本・非空タグを勝手に変更せず、候補なしを正しい空欄と断定しない。旧869社だけの計画は未実行で保管し、新plan SHA256 `895cd17153f877407114666b9d25355a66ba34f4e895cb43840f72ddbb3e2466`に置き換える。実適用の結果は別受入である。

## 月次relation初回適用の既知拒否

#540はCI3checks成功後21:18:38 JSTにmain `4e40ab90c1abe67639f68b1835c1ed753a2f3a25`へマージ。Cloudflare main build `f12f070a-1b69-4b47-8936-9d4920ed0b76`で21:19:13にversion `52c158cb-7892-43e6-acc6-b58aa0920fcc`・同一10triggerを確認した。SSHも同mainへ更新し、本文用538と別のclean runtime・所有者0600の専用envで実行した。

21:21:23–21:21:42 JSTの通常`master_sync --require-cloud --codes=593A,634A,624A`は、公式コード表の通常保管と①の同値skip3社の後、624Aの物理PRE保管で停止した。取得URLなしを`""`で送ったため、Notionの⑤page createが明示400 validationを返した。共通URL生成で空文字だけを正規の欠測`null`へ直し、実保存原本→CALC PRE→通常raw propertyの回帰を含む180件をNixで確認した。偽のURLや他の出典を追加しない。

financial PATCHは例外より後の経路にあり未到達。3行のfresh全property再読が旧値と完全一致し、R2pendingは624Aの1件だけ、他2社は未入場だった。旧pending・原log・PRE原本を保持し、結果不明の再送禁止を解除しない。実行19.420秒・exit1、finance補完0件。readback私有根拠`financial-master-relations-normal540-v1/after-known-pre-rejection.json` SHA256 `78c36e5a6dd704c5af2e2f1606160a4a79d3e6d75c9fcf6118eede21bf48457e`。本文検査は33窓の正常閉鎖後に区切り、財務停止と保全確認後21:25:03に同じdriver/runtime/envから再開した。

## 既知の物理PRE拒否からの限定再開

624Aの旧pendingを削除して再実行せず、通常`master_sync`に明示入口を追加した。旧main540の3source、実log、開始/終了receipt、終了PID確認、3財務の全property不変読戻し、旧pending全文を固定SHAで検証する。任意の400や結果不明を例外扱いしない。実証跡9ファイルを使うoffline loader検査も通過した。

実行はNix内・設定済み`.env`・適用mainの専用runtimeで、通常のPython moduleに次の引数を渡す。両proof引数と`--codes=624A`を必須とし、`--limit`は許可しない。SSHへの移送では9原本bytesを保持してproofの絶対pathだけを付け替え、その新しいproof SHAを明示する。

```sh
python -m jp_stock_pipeline.jobs.master_sync --require-cloud --codes=624A \
  --reconcile-financial-pre=FILE --reconcile-financial-pre-sha256=SHA
```

この入口は公式コード表取得・①upsert・D1業種更新より前に分岐する。現在の財務全文、一意な①、⑤と原本native主体/期間を再資格化し、同一GETのR2本文/ETagが旧pendingと完全一致する時だけ同keyへ条件付き再開markerを保存する。markerの成功応答後にのみ、旧pending原本の物理PRE保管・通常の書込直前比較・空relation1列PATCH・全文POST/物理POST・条件付きcompletion/読戻しを行う。数値19列・出典・ライセンス・源取得時計・旧開始時計を変更しない。

既存SDKの条件付きPUT再送は維持する。markerが適用された結果不明、PATCHの結果不明、POST未完はmarker/pendingを保持して停止し、同じ証跡の再PATCHを許さない。markerの通信結果不明でサーバー未適用なら旧SHAが残り得るため、この場合まで永続的な再入場禁止を保証するものではない。運用は停止・自動再実行なしとする。通常月次経路は引き続き既存pendingで停止し、この例外を自動適用しない。

Nixの6suite356件PASS・既存原本未配置2件SKIP、URL修正541の統合後3suite158件PASS・実証跡loader PASS、変更7PythonのRuffと独立FSレビューを通過。ready-v2 SHA256 `89072f2b16f371ac8839d625b4fb77ccdcaa815f35073a67621661ce1f1836e7`、統合peer SHA256 `d94ad61949fd2811497d6d2206058366939bbe1f4a9d038e53291b09a4201245`。542のmergeでは当該7Python bytesは変わっていない。このコード受入時点では新入口の本番実行・3relation補完は未実施だった。

## 財務リンク3行のSSH実適用

#543をCI3checks成功後main `af78db37a8912685e504d4eb762f4f44f4f4ef2e`へマージした。21:49:56 JSTにCloudflare version `22506eda-64fe-4c65-b1c1-b9e63ecaaf04`と同一10triggerを確認。SSHも同mainへfast-forwardし、別のclean専用runtime・0600 envで原証跡9ファイルと付替えproofをoffline検査した。旧env・原証跡bytesは不変。本文60窓の自然閉鎖後に同時書込みを避けて実行した。

通常CLIの明示624A再開は21:51:03–21:51:15、11.915秒、processed1/failed0・exit0。旧pendingを削除せず、同keyの条件付き再開後に旧PREの物理保管・通常PATCH/全文POST・物理POSTとcontrol completionまで閉じた。通常`master_sync --codes=593A,634A`は21:51:43–21:52:23、40.522秒、③のexamined2/repaired2/held0・exit0。①は同値skip2、選択2社のD1業種更新0行、全市場診断・写し更新なし。追加モデル0・operator再実行0。

21:52:56–21:53:00のfresh財務3GET＋R2 control3GETは4.246秒で成功。旧全propertyと比較し、正しい①relationだけが差分で、19数値・原本relation・出典・ライセンス・源取得時計を保持した。3controlは全てcompletedでPRE/POST全文SHA・通常物理保管receiptのSHA/sizeが一致。624Aは旧native/raw/開始時計と旧PREが完全一致し、固定proofのmarkerだけを追加。物理fileや①をさらに独立再取得した検査ではなく、既通常writerの物理読戻しと固定資格に基づく。SDKのnative読取再送は未計測、論理読取3＋3、業務書込/原本download/モデル0。

私有fresh読戻し`financial-pre-rejection-reconcile-v1/ssh-actual-main543-v1/final-financial3-completed-read-v1.json` SHA256 `0baf295963287d602494baf15bcaa07a2216cab695bc3ef3090c1c882cb074e7`。3実行の子/親6PID不在を確認後、21:53:24に元の本文driverだけを再開した。空relation1,652行の既観測から候補3行を補完したが、残1,649行の歴史主体資格・全履歴数値の空欄理由分類を完了したものではない。

独立FS受入は16実証跡とmain543の固定sourceを検証してPASS。proof SHA256 `ca2c383afb2066b9925a35c07e95a093779cadef842ee8dd6c87c1db6a33f031`。通常2社runにある指定外E38412のFSA identity HOLD警告2eventは保持し、今回の③relation repaired2/held0と区別した。追加API・モデル・原本再取得なし。

## 過去本文の再抽出失敗による旧索引消去を防ぐ

`backfill-text-sections --force`は非空の再抽出なら、新Notion全文の往復照合→D1のstatus/索引/新pointerを同一batchで確定→旧Notion行を退役する既存経路が接続している。一方、CSV未提供・parse失敗で0節になった場合は、旧Notionpointerを残したまま正常な旧D1索引をDELETEする枝があった。

全3callerが使う共有builderで`parse_error`をSQL作成前に拒否した。0節の確定も旧status/pointerのsnapshotが不明、旧status正常、旧pointerありなら停止して保持する。CLIは既SELECTでpointer1列を追加するだけで、追加native要求はない。既error集計で非0終了し、失敗を成功や未開示へ変換しない。正常な新規0節は旧status/pointerが明示的に無い時だけ従来どおり記録する。他2callerは非空の全文照合後だけbuilderへ入るため、正常な確定契約は変更しない。

保存実6963の37索引を含む全6表で、失敗投影4条件のSQL送信0・旧値不変と新規0節の正常系を検証。関連6suite96件PASS、全体TypeScript型検査・変更source/testのESLint成功。修正のための原本取得・モデル・実データ修復・本番書込0。根拠`tmp/feature-audit-20261018/text-backfill-empty-preserve-v1/ready-v1.json` SHA256 `812115bf1e82d551db506af0e86a5cece4e5a4b9a074f6934aa2ae9113b3ca3f`。これで過去の損失件数や全原本の再抽出を受け入れたとは扱わない。

## 現役全社の現在39本文の読取完了

SSHの固定3,666社・74バッチは20:39:42–22:07:03 JSTに全てexit0で閉鎖した。通常処理で3,664社を現在39列まで検査し、2683/3840の2社は資格HOLDで未検査として保持した。通常検査済みの634Aと別の24社診断の重複1社を除き、診断追加23社とのunionで固定現役3,687社の現在39本文値を観測した。対象外26行はこの全社読取に含めない。

同期差分・本文修復・metadata修復・主マスタ読取・failure・モデル0。Notionは通常5,058＋診断27＝5,085要求、429/再送0。通常elapsed合計3,598.624秒、実wallには定期/タグpilot/財務の排他pauseを含む。全296 log/summary/receiptの最終SHAとsize、全74code CSV/limit/終端/一意、所有driver＋子75PID不在を独立FS照合した。受入SHA256 `2db365780e8ba0649cf1a74c1b033153d694d6e0f6d74aaab5b34f7119c0d52f`。

現在値の空欄は7,074 / 143,793セル。下表の分母は各3,687社で、本文なし21社は全列に含む。異時点観測であり、診断23社のsource資格を新たに成立させた検査ではない。空欄理由（非公表/対象外/抽出漏れ）の全件分類・原CSV抽出の網羅性・全補足の充足・実請求額は未確認で、同期差分0を全項目補完完了とは扱わない。

| 本文項目 | 空欄社数 |
| --- | ---: |
| 事業の内容 | 21 |
| 事業等のリスク | 22 |
| 経営方針、経営環境及び対処すべき課題等 | 22 |
| 配当政策 | 21 |
| 経営者による財政状態、経営成績及びキャッシュ・フローの状況の分析 | 21 |
| 研究開発活動 | 22 |
| 大株主の状況 | 23 |
| 発行済株式、株式の総数等 | 21 |
| 所有者別状況 | 21 |
| 発行済株式、議決権の状況 | 21 |
| 自己株式等 | 22 |
| 株主総会決議による取得の状況 | 23 |
| 取締役会決議による取得の状況 | 23 |
| 取得自己株式の処理状況及び保有状況 | 23 |
| 関係会社の状況 | 21 |
| 従業員の状況 | 21 |
| 沿革 | 21 |
| 重要な契約等 | 21 |
| 役員の状況 | 24 |
| 株式の保有状況 | 23 |
| 社外取締役（及び社外監査役） | 59 |
| コーポレート・ガバナンスの概要 | 27 |
| 監査の状況 | 21 |
| サステナビリティに関する考え方及び取組 | 26 |
| 主要な設備の状況 | 29 |
| 設備の新設、除却等の計画 | 30 |
| 設備投資等の概要 | 30 |
| 有価証券明細表 | 3,383 |
| 有価証券関係、財務諸表 | 150 |
| 有形固定資産等明細表 | 45 |
| 賃貸等不動産関係、財務諸表 | 2,154 |
| セグメント情報等、財務諸表 | 27 |
| 重要な後発事象、財務諸表 | 352 |
| 関連当事者情報、財務諸表 | 71 |
| 提出会社の親会社等の情報 | 21 |
| ライツプランの内容 | 24 |
| 行使価額修正条項付新株予約権付社債券等の行使状況等 | 21 |
| 発行済株式総数、資本金等の推移 | 21 |
| 主要な顧客ごとの情報 | 146 |
