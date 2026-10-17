# EDINETの報告状態の保持とexact書類HOLD — 2026-10-17

日付一覧に実在する`parentDocID`・`opeDateTime`・`legalStatus`と取下げ/編集/開示状態を保持し、同じ書類IDの取下げ又は未資格の状態変更を通常処理と公開表示で保留する。親子関係だけで正常な訂正有報の独立した原表を無効化せず、親の数値継承・差分反映・法的失効を実行しない。コード検証は保存入力のみ。本番の空表DDLは後述のroot別操作で受入済みだが、新観測取込・公開guard配備・定期受入は未実施。

## 一次証拠と未資格の境界

保存34原一覧の全8,884行、8,597,590Bを旧Notionページ・日付・ファイル名・原HTTP本文SHAへ束縛した。旧typed parserは追加3項目を全行で捨てていた。取下げ1は8観測/6書類、親ID非NULLは1,813観測。新表へ保存する候補は、年次訂正/親関係又は状態変更のある163観測/126書類で、状態HOLDは38書類。原本にある親IDの相違も上書き統合しない。

- `S100YOCW → S100YI5H`は130訂正、原一覧の期末NULL、状態正常、親は保存34一覧に無い。関係未資格を記録するが、それだけで独立した現行原表をHOLDしない。
- `S100YRSP → S100VVJZ`は取下げ1、書類種別/提出者/期末がNULL。exact `S100YRSP`をHOLDし、`S100VVJZ`へ取下げを伝播しない。
- `S100YSGA / S100YVTZ`は同じ保存入力内の120/130関係。原報告の保持を確認し、財務差分や法的な親失効の証明には使わない。

Git fixtureは選択した実4原行を変更せず保持し、元一覧のSHA・旧ページ・日付を記載する。抜粋だけから全原一覧SHAを再構成できるとは主張しない。保存34一覧には通常captureの取得時計・gzip SHA・HTTP受信証拠が揃っていないため、今回のSQLite候補投影を本番へ取り込まない。後付けした時計で旧原本を資格済みにしない。

通常の新規観測は、既存`captureListSnapshot`の原HTTP全文→gzip物理保管→全SHA読戻し後、資格済みsnapshotと全原行を新表へ保存する。`reported`は`qualified`な訂正鎖ではない。

## 最小の保存契約

`yuho_edinet_reported_changes`は原7列＋nullableな`stock_id/period_end/submitted_at`の10列、主キー`(source_page_id, seq_number)`、exact doc ID索引とstock/period/submission複合索引。nullableな種別/提出者を持つ取下げ原行も保存する必要があるため、年次書類だけの既存`yuho_documents`への列追加では閉じない。元raw SHA、元seq、元Notionページ、完全なtyped原行とsnapshotをJSONに保持する。同じbytesが別ページ/取得時計で保管された観測を消さない。

同じ主キーの全列が異なればSTOP。保存前後に全対象行を比較し、欠落だけを9行/90bind以下でINSERTする。INSERTのACK不明は再送せず、通常cronの`@list`と実snapshotのpage/raw/gzip/取得時計を保持する。`legalStatus`や`opeDateTime`を効力日・株式class・金融値の基準日へ読み替えない。

未取込の書類でも、原一覧が通常年報の完全な様式・非空提出者・明記sec/EDINETCode・期末・提出時計を持ち、原secの厳格ticker、既存EDINETCode逆引きの唯一ticker、通常ingest母集団のcore IDが一致する場合だけnullable3列を埋める。両mapは既存helper/母集団を再用し、JPX短名を法的商号へ推測変換しない。日付・分までの時計はcalendar roundtripを要求し、旧通常ingestと同じtimestamp保存表現で比較する。旧ingestの時計の意味は変更しない。原期末NULL、親IDだけ、タイトルからの期末推測、未来期末、不正時計、逆引き未到着/不一致は3列ともNULLのまま。

保存38 HOLDには完全annual metadata候補が**0**。新nullable資格の正例は実3106 metadataを使う宣言transport/master protocolで、実際の取下げやfresh master照合の成功を主張しない。未取込raw観測しかなくidentity/FYを資格化できない場合はexact doc IDのHOLDを保持するが、別IDの親や別会社の金融値を推測無効化しない。この未資格関係の解決は残る。

SQL/snapshotはNixの通常`drizzle-kit generate --name=edinet_reported_changes`で生成。旧25表は0031 snapshotと全内容同一。旧snapshotのworking tree削除は`drizzle/d1/README.md`原則4（最新snapshotとjournalのみを残す）に従い、0031 SQL/journalとGit内の旧snapshot履歴は保持する。

## 通常callerと公開consumer

| 経路 | 接続した境界 |
| --- | --- |
| `src/cron/yuho-edinet.ts` | 一覧の全状態観測を元filterより前に保存。新writer前に資格済みsnapshotを`@list`のままdurable保存し、保存確認前にmarkerを解除しない。known HOLDを`reported_document_state`と件数へ記録 |
| `data-scripts/backfill.ts`, `backfill-missing-docs.ts` | 既存`captureListSnapshot`→同じ観測保存→元filter/ingest。物理保管又は観測ACK不明は日付を進めず停止 |
| `services/ingest.ts`, `lib/missing-backfill.ts` | typed原行と実D1のexact IDを原本取得/保管前に確認。金融atomic batchにも同じguardを1文追加 |
| `biztag/source.ts`, `plan.ts` | 最新を選択後、exact ID又は資格済み未取込の新報告をHOLD。古い親へ戻さず、通常planへ理由を渡す |
| `lib/shareholdings-backfill.ts`と通常CLI | 最新を選択後にHOLD。再読/原本資格/明示操作のlatest callbackへ同じ境界を接続 |
| `src/shared/notion-archive/shareholdings.ts` | source/価格の全通常callerに実D1を必須化。known HOLDは価格原本GET・unknown marker・publisher mutationより前に保留。DB未知応答は例外を保持 |
| `scripts/sync/holdings-issuer-names.ts`, issuer evidence loader | latest HOLDを資格未成立として扱い、alias資格を拡張しない |
| `lib/saved-overseas-backfill.ts` | orders/overseasのprepare/apply/inspectとも、固定集合を実D1の1 indexed SELECTで確認してからclaim/Notion PREへ進む |
| `lib/saved-overseas-atomic.ts` | 既存6表CAS後、同じatomic batchの1 SELECTで状態競合を検査。HOLDなら全batch rollback。6表snapshotは7表へ拡張しない |
| `order-query.ts` | detailは最新facts選択後に年度値と理由をHOLD。`screenOrderGrowth`と`listSectorsWithOrders`は同じSQL内で使用年度とoverall最新報告をguard |
| `overseas-query.ts` | detailは最新facts選択後に全該当年度をHOLDし、部分地域の合算で隠さない。`screenOverseasGrowth`と`listSectorsWithOverseas`にも同じguard |
| `text-sections-query.ts` | 最新選択後にHOLD。同FYの最新HOLDに索引0でも実報告doc IDでNotion読取前に停止。現時点の外部本番callerは0 |
| `stock-detail.ts`, `overseas-section.ts` | 理由付き保留を表示し、最新HOLDを古い年度のsummaryで埋めない |

`p_yuho_growth`を読む公開consumerは上記4関数だけ（全production TSの参照検索で確認）。projection自体、全財務原値、旧6表snapshot、株数、価格、原本時計は変更しない。無効な最新書類にfactsが無い場合も同FYの旧親factsへ戻さず、最新FYが投影窓の外でfacts0でも古い年度をcurrent screen/summaryへ採用しない。古い窓外HOLDは正常な最新FYを一括無効化しない。独立した新しい正常130は期末→提出時計→既存row IDの順で保つ。未取込観測にはrow IDを捏造せず、同時計で新旧が確定できない場合は保留を残す。

公開document一覧は同じD1 SELECTのunionで資格済み未取込報告を示し、`origin: reported_observation`と「提出書類一覧で確認」を付ける。取込済みdocumentの出力へoriginを補作しない。報告状態を本文/数値の取込成功と混同せず、旧chart・原値は保持し、最新HOLD時は旧年度summaryを出さない。

原本を別系統で取得するPython JSS collectorの訂正/取下げ鎖、原観測の全期間再取得、親の同issuer/FY資格、訂正値の差分適用、法的失効はこの変更の完成範囲ではない。

## 検証

- Nix full TypeScript検査PASS、変更39 TypeScript filesのlint PASS、関連23 suites **433 tests PASS**。Python governance **35 PASS**。
- 実4原行でmetadata保持/NULL状態と関係未資格を確認。同一原本再観測、原行/時計差替え、exact ID不正、INSERT済みACK喪失→`@list`保持を検証。
- 実3106の原ZIPと6表PREを基準に、宣言した取下げraceで金融batch全rollback、関係だけなら通常値同一を確認。3106自体の取下げを観測したという試験ではない。
- 同FYの「最新書類にfacts無し」と「独立した新130」のmetadata/fact有無は明示protocol fault。正常な原3106の欠測や訂正事実に読み替えない。
- source/price known HOLDはNotion mutation/価格loader0、予約refundはknown HOLDのみ。DB ACK不明/不正応答は通常STOP。保留queue先頭が全HOLDなら後続が進まない現行制約を残し、全価格queue完了とは数えない。
- SQLiteの実batchとEXPLAINでdoc索引・stock/period索引を確認。公開HOLD中も6表の全raw値と投影を保持する。
- 実3113/3382の保存20社PREから、対象2社の6表原行を変更せず抜粋。最新2026年度と旧投影2021/2023年度が離れるケースへ宣言HOLD/facts0を注入し、screen/sectorで旧年度へ戻らないことを確認。実際の取下げ観測ではない。3382の旧2025年度qualified HOLD/正常2026年度のcontrolは旧screenを維持する。

保存済み市場cohortの全3,687株/36,929年次履歴から、旧新`loadLatestDocs`全3,687結果、保有selector全74ページ/3,666書類は完全一致。保存38 HOLD書類とこの時点の最新書類の交差は0。新nullable3列の資格化候補も0。対象の将来状態やfresh本番資格とは別。

純SQLite median（5回、D1のrows_read/課金ではない）:

| 同じ保存入力/SQL回数 | 旧 | 新 |
| --- | ---: | ---: |
| 最終市場latest 2 queries / 40,616 returned rows | 38.249ms | 47.972ms |
| 最終保有selector 74 queries / 3,739 returned rows | 43.728ms | 48.128ms |
| 実3106 detail受注 | 0.02365ms | 0.03863ms |
| 実3106受注screen | 0.02332ms | 0.05601ms |
| 実3106受注sector | 0.00455ms | 0.00612ms |
| 実3106 detail海外 | 0.01965ms | 0.02071ms |
| 実3106海外screen | 0.02494ms | 0.05879ms |
| 実3106海外sector | 0.00458ms | 0.00462ms |

上の単社数値は初期実装の測定で、最終public SQLの性能根拠にはしない。最終市場selectorのVM概数は610,800→2,088,500、保有は2,974,200→3,128,000。CPU/VMと全コンパイルSQLは私有`selector-cost-final-v1.json`へ固定する。追加index照合の費用をゼロとは主張しない。

実20社の元6表PRE・screen実通過3113/3382を含む最終public SQLを、同入力・同4関数・5回×50反復で比較した。旧→新SQLite medianはorders screen **0.02691→0.15786ms**、overseas screen **0.03173→0.16307ms**、orders sector **0.00644→0.03013ms**、overseas sector **0.00643→0.02780ms**。VM概数は618→5,162、574→5,144、214→2,714、206→2,390。全4出力と全20社×6表は同値。known HOLD predicateをlatest探索前へ置く1回のtrialで、新VMを7,394/6,950/4,084/3,294から低減したが、旧版に対する追加費用は残る。全市場D1の課金・性能保証へ広げない。新compound索引/既存doc・facts索引の利用はEXPLAINで確認した。

## I/Oと上限

通常cronの一覧原本capture/Notion物理保管は既存処理を再用するので追加source/Notionは0。変更観測が0なら観測保存のD1 IOも0。観測ありは2 SELECT＋ceil(未保存行/9) INSERT。原metadataが完全なHOLD候補に限り、既存issuer逆引きとnormal core集合を各90件以内で照合するD1 SELECTが増える。保存38 HOLDの候補0にはこのlookupを発行しない。新captureで変更観測ありの場合はsnapshot保全の進捗CAS1回、保存一覧からの再開時は`@list`予約/解除CAS2回が増える。

保存candidateを27原本ページ/163観測とした技術SQLiteでは9行chunkが33、観測保存は54 READ＋33 INSERTの条件付き87 D1 requests相当。完全snapshot未資格の旧入力を実行する予算ではない。raw一覧の再資格化/新capture/進捗CAS/物理保管は別費用として扱う。

normal ingest/missing、source publisherはexact IDを事前確認するD1 SELECTが各1回追加。価格resumerは原本GETより前の確認とpublisher確認で最大2回/owner追加。金融atomicは同じbatchに1 SQL/1bindを追加し、HTTP追加0、既存最大1,000文にguardを含める。保存orders/overseasは集合最大100件/100bindの事前SELECTが1 native増えるため、今後の有限planはその費用を既存cap内へ予約する。未知応答時に別値を使って進めない。

旧2CLIの冷間一覧は物理保存が新たに必要。既存DB・single-part・sendが直ちにuploadedとなる1一覧は、key query1＋upload create/send2＋page create1＋Files GET1の**5 Notion＋hosted読戻し1**、加えてprocess最初のusers/me1。upload確定照会は最大4 GET追加。DB discovery/cache miss、metadata children照会、multipart化は既存helperの別費用なので、この基礎件数を全実行の固定上限とは呼ばない。実行時は既存finite captureで全native/bytesを予算化する。同一覧のsource再GETや無意味な再uploadは追加しない。旧2CLIにはcronの永続`@list`再開契約を新設しておらず、ACK不明で停止した操作を新出力先から安全に再送できるとは主張しない。

## 配備の必須順序

1. rootがmigrationの固定SHA、対象通常D1 **`kabulab-cf`**、既存全schema/indexの物理PREをレビューし、別有限DDL操作をreleaseする。コード担当によるD1接続は0。
2. 既存normal migration senderで`0032_edinet_reported_changes.sql`のCREATE TABLE/CREATE INDEXだけを1回適用。ACK不明は再送しない。表全10列、nullable3、PK順、doc/compound索引、空行数、既存全schema/index不変・既存表へのDML0をfull readback/物理POSTで受け入れる。固定SQLは644B/SHA `28da5b93381228aa0f5f9b435086083c2a73ed94c6130389da24d37ba9d6d017`。
3. **本番schema受入後にrootがPRをmergeし、main Cloudflare build/deployを受け入れる。** missing-table fallbackを入れないため、先に自動deployすると公開readが失敗する。通常typed accessor/DB bindingを使い、別DBへ代替しない。
4. normal cron又は別有限旧原本資格の実測は次の受入。Mac4a、旧E4、稼働有限writer/envはこのPRで切り替えない。

10/17のroot別操作でDDL schema受入を完了した。24 native（13 Notion/2 hosted/8 D1 READ/1 batch）、3 CREATE、10列・PK2列・explicit索引2本・新表0行・旧catalog全同値、物理PRE/POST2本を検証。旧表データの全量読取はしておらず、旧表へのDML0。原900秒内93.93秒の操作で、native COLLECTED後に私有controllerのTLA import cycleによるexit13が起きた。再送せず、元時計内に別saved-only auditを0.59秒/新HTTP0で閉鎖した。通常producerのSUCCESSを作ったとせず、root-finalで区別する。root receiptは canonical `tmp/feature-audit-20261017/edinet-reported-lineage-schema-once-v1/root-final-acceptance-v1.json`、SHA `9305a12b3f631dfd03080e5bce3757555e80ffae6be09c1e265eba85850faef4`。コードpush/merge/deployと金融値適用はこのschema受入に含めない。

コードrollback時も新表と原観測を保持する。表DROP、観測削除、原raw書換えをrollbackとして自動実行しない。訂正/取下げの全機能、権利処理、全20項目完了とはしない。

私有証跡: canonical `tmp/feature-audit-20261017/edinet-reported-lineage-readonly-v1/{evidence-v1,proposal-v2,storage-comparison-v1}.json`、本WT `tmp/edinet-lineage-proof-v1/{paired-v4/paired-selectors-v1.json,selector-cost-final-v1.json}`、`tmp/edinet-lineage-public20-cost-v1/actual20-v2/{queries,cost}.json`。私有raw/ログ/時計をGit fixtureへ無断転載しない。
