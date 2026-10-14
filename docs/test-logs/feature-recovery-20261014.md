# 機能別監査後の復旧と受入

追跡: [#348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。監査と全20機能の完了条件は [feature-gap-audit-20261014.md](feature-gap-audit-20261014.md)。作業開始2026-10-14 JST。全件の本番受入が済むまではこのIssueを閉じない。

## 10/14〜10/15 本番受入台帳

「実装済み」と「本番の全量完了」を分ける。予定時刻前の処理、結果不明、原典にない数値を完了に含めない。以下の表は10/15 01:20 JSTまでの追加確認を反映し、各機能の独立した読戻し時計に基づく。同時snapshotではない。株価の対象日は10/14であり、翌日の新価格として扱わない。

| 機能 | 実装・本番証跡 | 残る受入 |
|---|---|---|
| 銘柄マスタ・上場状態 | 公式233イベント、廃止3・市場変更1・保留0、再適用0書込 | 次の定時overlay |
| 株価・財務断面 | 10/14定時run38539360030は失敗。当日D1は3,638/3,686社、残48は47社の当日OHLCV/adj全NULLと8303の過去245行調整値異常に分離。原本38件/7,373原文全SHAを照合。通常計算PR393/395とSDK期限PR397はmain・実配信を確認 | 47社のQuoteには価格のnative時計がなく、Chart当日9社も09:00で終値採用不可。8303は有限v5で添付長名400、v6で物理PRE page作成後のhosted全文GET timeoutにより、D1業務更新前に停止。既存PREは新しいread-only onceでpage/hosted各1GET、33,775B全文SHAと旧63証跡不変を確認。旧V6は再開/完了化せず保持。通常株式のUTC対象日・06:30〜21:00窓を保存原本readerにも共用するPR410はレビュー済み/CI中で、VWAPのJST当日制限は変更しない。全量回復は未受入 |
| RSI・スイング・モメンタム | 10/14 price/indicator/momentum各3,638社。RSI3/SMA75 16/MACD10の期間不足を実barsで照合 | 上流48社の回復とsectorの後続受入。23:35本番readcheckは実exceptionで未完を検知。期間不足を架空指標で埋めない |
| マクロ | 公式日米営業日と夕方JP/翌朝US二段取得をmainへ反映。10/14夕方の保存N225・VIを通常readerで再parseし、同日確定session/前日終値/VI引け後tickとNotion物理manifest・VI全SHA一致を確認。4read・上流GET/書込0 | 翌朝USの実定時受入。JP原本の成功を両市場の全完了へ広げない |
| 財務サマリ | 専用ROE102件と直接開示の純利益ROA6社を本番全読戻し済み。実表ROA3社の通常parserはPR374/main、保存済みtype1原本だけのpublisherはPR378/main・run38534023380で成功。独立にNotion/R2の全9ファイルと索引3件17列の一致、財務D1全25行/Notion3全props・時計の未変更を確認 | 3社も限定反映と独立読戻しを完了。ROA6963=-11.6/8014=8/8593=1.3、D1全25行/Notion3全props・物理POST一致、他22行不変。旧403/検索判定guardSTOPは保全、原本再publisher0。未開示の財務値は原典理由で保持 |
| EDINET・本文なし | 00000と040000/040001様式の漏れを特定しTS/Python双方を修正。542A/646A本文37/34節と財務修復を全読戻し済み。欠けていた7/1〜8/13の44日一覧も実体保管・全文SHAから直接提出者別に照合し、対象20社の120/130は0 | active本文3,666/3,686・財務3,674/3,686。残20社は初回期末前9・提出予定明示1（604A 10/30）・提出時期未確定10。44日内の未観測を解消したことを全期間の未提出証明に広げず、公式の初回提出予定の確認を継続。通常EDINET run38574602631はpending15/保有要確認1を残し失敗終了。最新D1単発読取で15全件identity_unresolved・同日確認済/finished/sealed・inflightNULL・当日queue0を確認し、非上場を理由に除外せず保持 |
| 有報39項目 | 適格原本3,666通中NOOP505＋修復800＝1,305通を全文/D1/物理POST/FINAL/旧最後退役まで受入。通常39列機械同期はmain。新008〜012の各50通が完了 | 残2,361＝canonical2,345＋typed/legacy16。旧008の原本GET STOPを保持し、未開始53batchだけ新namespaceで続行。元60,000要求・絶対deadline10/15 15:59:06を継承。pool累計11batch550通/Notion7,155/D1 15,472、013を実行中。typed/legacy16は原CSV/DEI/601項目をoffline資格化した段階で、最新sourceのfresh readと適用は未実施 |
| 受注・海外売上 | 適格11操作を全読戻し。明示地理Other・唯一の外部顧客売上行・明示省略理由をPR383/389までmainへ反映。最新3,666保存集合で省略理由955通を資格化、旧数値との差0。safe20は21:27に20社のatomic facts＋共通L2反映・全6表読戻し・物理PRE/POST全文照合まで成功、310.65秒、Notion154要求・D1読取270/atomic batch20・上流GET/原本upload/補足write/モデル0 | safe20は別プロセスでも全20社の全6表・本文・原典版・両物理添付を照合し、300.38秒/Notion76読取・D1読取18・書込0で独立受入まで完了。旧数値候補189は原本連結179＋scope不明10に分離。別表対応v2の全3642対照は旧適格559全件不変→577、新規18、955理由差0だが、新18中14は旧本番既OKなので18欠測解消とは扱わない。旧189と新18はcode/doc交差0でunion207、本文保護・連結・safe20除外を満たす次候補15も残body55と交差0。非表示CSS/hiddenの6例とMDA実前期contextの誤採用を共通境界で修正し、PR398をmain08725576へマージ・22:59にversion540de0ddの実デプロイを確認。v4全3642原本は既559数値/status/proof差0・省略955差0・追加18（577）、次15は未反映。過去理由70通の物理派生保管・理由UIも別受入 |
| IR・PDF | 381件物理保管・読戻し、行エラー0。旧SAAF1件は翌日の公式差替案内・差替PDFを確認し別保管。通常TDnet run38571851266は1,051件upsert/銘柄原本180追加/行エラー0で成功。 | 元PDFは取得不能のまま。差替を元PDFとして偽装しない。銘柄別原本の12分soft期限で打切りあり。前後の原本保存/D1処理を含む全体1047.124秒を12分完了とは呼ばない。 |
| VWAP日足 | 旧3034の結果不明を現物SHAで照合。夜間のN225終値NULLは正しく停止。旧7203限定dispatchのHTTP500/ACK不明は保持し再送0。10/14同日JP確定原本の資格確認後、未発火の通常全量daily-intraを1回dispatch、HTTP204/run38547185176 ACK。共有Yahoo queueの解放後21:18:05にjob開始 | 新runは00:19:36に失敗終了。日足は3,632保存/54error、個社の確定session条件が未成立のため全量未受入。00:19:40に後続scheduleも実daily-intraで起動し、当日N225終値NULLのため00:19:59に停止。別margin起動とは扱わない。旧unknownと異なる同日確定窓の新intentを保存。定期頻度は増やさず通常300分/CONC1/原本30銘柄batch/429停止を維持 |
| VWAP5分足 | 593Aは保存原本から再GET0で単発CAS、残4はrun38463034602で各1GET。5件の原本物理・R2全SHA・旧履歴保持を照合。先行1,830＋1,850＋7203pilotを含めactive3,686との集合照合は欠測0/余剰0 | 旧各読戻し時点の合算で同時snapshotではない。最終約定日は10/13が3,623・それ以前63。新run38547185176の5d更新は1,823保存/7skip後、rateLimited1/aborted=trueで停止、unknown/rejected/fatal0。取得元制限を無視した即時再dispatchはせず、未処理suffixの原本/全body資格と次の取得窓を確認する |
| 信用残・日証金 | 信用10/9基準・10/13公表4,247行、日証金10/9基準4,349行 | 旧日付20コードは最新保存CSVに全て非掲載と照合済み。旧観測日を保持し、最新値に偽装しない |
| 優待 | active普通株7,716行の条件DTOを原子適用し、全旧列保持・全行読戻し、要約pending0。本番7203画面と既存有効キー付きAPI/MCPの実条件schemaを照合済み | 未解決の取得元条件は根拠未確認として保持し、生成した事実で埋めない |
| 事業タグ・Mac | 10/14 20時の通常049e39a版は159社＝同期151/再判定7/skip1で正常終了、Notion2,077・429/再試行0・ローカルClef7/外部AI0。21時優待もpending0/モデル0で正常終了。両R2 receipt全文を独立照合。PR402の通常CLI durable原応答/未完停止/完成出力再利用は215テスト・CI成功後main、Worker配信23:57:54/version a7b75246を確認 | Mac実runtimeは固定049のまま。A876は旧22読取unknownを保持し、新finite18 v2の001でreview-material台帳作成前に停止。同じparent DB UUIDのハイフン表記差をwire期待値が拒否した。既知200書込と未送信台帳を分けて監査し、旧run/PREへの再入はしない。explicit process.exit(0)の終端検査修正はprivate実行へ反映済み。B23のfresh資格とローカル判定、通常MacのPR402切替えと次定時受入は未完 |
| 競合判定 | 固定83社の保存確率から追加推論0で81社/574関係を反映、全読戻し・物理POST照合。今回の本文再抽出だけでは固定83入力のwire差0を確認 | 旧corpus→最新docの先行世代差109社と本文修復差を分離。候補Bの質問変更27社を含む対象A33社を、最新タグ/候補の確定後に再資格化。未観測B13社、HOLD130A/145Aを変更なし/採用扱いしない |
| 資金フロー | 独立run38541122068は21:18正常終了、28取得元全outcome ok=true。週448/先物145/世界新34＋既187の各原典・読戻しを確認。23:45本番Cronの実outcome okをCloudflareで確認 | sectorは株価の全量失敗で未起動。独立28/監視成功をsector成功へ広げない。新規/更新行の別読戻しは継続 |
| 原本索引 | 固定cutoff78,832件。最後の500件成功run38563817035はcursor5,002。後続38571686207が停止し、PR401を本番へ配信後にinspect38582945803を単発実行。実cursor5,389/残73,443/index_inflight、原本17,352B全文SHA一致・当該索引欠測・前項索引全列一致を確認。12read/6.560秒/R2本文31,720,908B/Notion0/write0 | 旧failed payload/ACKは未観測のまま、state/unknownを変更しない。PR404をmain/00:23:04 version b529dd8eへ配信し、単発run38588508638は00:22:02に回復成功。unique INSERT1/索引全15列読戻し・旧state/active不変、19HTTP・観測R2本文31,603,114B・7.531秒、Notion/上流0。SDK/D1応答bytesは別未計測。元200枠の既知消費14、resume自身を含め残186/continue185を維持。PR408の通常RAWへpartial bytes/同URL再GET/親期限/既存レート枠を接続し、00:54:29に実配信済み。PR409も01:11:59に実配信後、元14消費/残186をfresh確認して01:17:34にrun38596823383をmain342c2ab2から単発送信、実処理中。continue185/500件・2GiB・新規開始3600秒を維持。全78,832件のanti-join欠測0まで未完 |
| 保有明細 | 全3,666保存原本の収集完了、機械対照1,833社/22,755行・旧facts差0。197A通常1社1行の価格269円/12,802,248円を物理POST/独立全照合。PR399でNode CLIの排他記録・追記journal確定をmainへ反映、23:08:57/version7152aa43実配信を確認 | 全量公開は未実行。先行inventoryの101応答がrequest_status=incomplete/query_result_limit_reachedだったため、旧10,000件の全量認定を拒否。固定created_time窓へ分割し、最初の窓4,463件を46GET/19,430,926B/180.344秒で全文照合。次の隣接窓は実行中で、全DB件数は未確定。旧27,587を現在の全件数とは扱わない。価格10/2 snapshotを当日へ偽装せず、原本HOLD24/主体/英名/株数/分割基準を別資格化 |
| API・MCP | 正式JPX信用残・JSF品貸料経路をmainへ反映、内部normal Workerは6binding/100%配信。Cloudflare上の既存キーを外へ出さず28固定ケース・8tools・REST/MCP10組・native4digestが全成功 | normal版8772279cの配信/全binding不変を照合済み。認証拒否のsurfaceなし契約も確認済み |
| 監視・Notion案内 | カタログ89block全内容・既存5viewを照合、同値更新0。実Cloudflare集計で23:35株価Cron exception1/23:45資金フローCron ok1を確認 | 両Cronの発火を全source成功へ広げない。翌朝USと次19時catchup/20:05、Mac runtime切替え後の定時受入が未完 |

復旧用の大量処理は通常Cronと分け、上流の再取得を最小化する。Mac監視増分は両処理・ops合計で月120 PUT/240 GET・小JSON2個。歴史原本は最大24.73GBの追加保管で月約$0.285の保守的増分見積り（既存約4GB、無料10GB、$0.015/GB-monthの条件）。通信・照合時間は別で計測する。既存Workers Paid固定費を従量$0に含めない。

04:28 JST追記: accepted main `847c2279988082f6b7cda58e559a631ab3f6b517` の通常CLIで対象5社を限定反映。3社のdoc変更再判定と2社の機械補完が判定済、残0・失敗0・資格保留0。共有writerの旧全PRE保全→新根拠全文確認→単発更新→全property読戻しまで完了した。CLI98.641秒、起動を含む全体100.151秒、Notion172要求・429/再試行0、SemIf3回・外部AI API0回。プロセスツリーの1秒間隔実測ピークは9,294,944KiB（約8.86GiB）、128GiB機の空き最低60%、既存swap使用10,566.88MiBからの増加0。これは限定5社の実測であり、全最新文書の再投影時間や実精度の保証へ広げない。

価格照合cacheは保存済み実明細587行で結果SHA不変、同じ1.92MB chunkの展開504→1・chart解析104→30、9.393秒→0.152秒、RSS203→174MB。固定価格116ファイル/3,456銘柄の索引作成は13.53秒・ピーク約270MB・源GET/業務write0。全保有明細の原本/価格資格は別途確認する。

月跨ぎ週W40の本番448件は392.215秒・全create ACK/独立全19項目読戻し一致・既存更新0・無関係write0・元サイト再GET0。POST全文物理保管SHAは`a2d4adcff0fee88dc71a18e4add5a2ad9798c4c0514e8e0360eda07b93fbd4ae`。世界指数の新JPY原本は要求`JPY=X`に対して実symbol`USDJPY=X`だったため初回は停止した。両名称`USD/JPY`、通貨`JPY`、資産種別`CURRENCY`、exchange`CCY`が全一致する限定aliasを共通parserで扱い、取得rawと解析snapshotの実symbolを保持する。実4,078B原本の回帰9件を含め関連51件PASS、別のprivate fixture不在35件はskip。過去13週の既存値/原本参照/時計の変更は、欠けの補完と分けてPREで確認する。

ROA定義の一次根拠は[JPX用語集「総資本利益率」](https://www.jpx.co.jp/glossary/sa/554.html)（2026-10-14確認、25,608B、SHA`e73f867741fba59ceff7f9e36858bbd81d7576738694acdb5bdea5c3099bcba8`）。利益の種類による定義差を維持し、経常利益率を純利益ROAへ代入しない。公式HTMLと149原本の検査結果をNotionへ物理保管・全文SHA照合済み。5社の実行計測も別原本として物理保管・全文SHA照合した。

02:30 JST追記: PR #351はCI成功後にmain `ef75b480`へmerge。0000誤紐付けを646A/core18156へ移し、D1全34列・Notion全property・元時計/数値不変を確認。日証金の旧20行は最新保存CSV（公表10/13、実申込日10/9、4,752行/4,349コード、SHA `e1f039abe7a824a3c37307be969c9bde007e670d135ce15bfa9ce2918be0f9e0`）に全件非掲載。最新値に補完せず、各旧実観測日で保持する。

Macは同mainで両実処理exit0、開始/終了R2 receiptを全文照合する経路を実行した。夜間手動起動は20/21時の定時開始成功には数えず、次の開始窓を別に確認する。既存Notionの高ROE・業種別・直近開示・決算カレンダー・commercial-okビューの設定も読取り確認し、重複ビューは作らない。[現行のビューAPI](https://developers.notion.com/reference/create-view)に対応しているため、カタログの「API未対応」は修正する。

保有明細schemaの初回要求は確認できず停止。読取り照合で全旧propertyが不変と確認し、[公式API制約](https://developers.notion.com/reference/update-property-schema-object)に沿ってoption改名をやめ、旧property退避→読戻し→正規列作成の二段へ修正する。旧pendingを消して同じ要求を再送しない。

## 22:14までの追加運用証跡

株式の通常日次修正は[PR393](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/393)で関連232テスト・独立51テストとCIを通し、main `941d70e9403ca965759aec84ce07e834e7c6700b`へ反映した。Cloudflare main build `6ad64aee-4eb9-4a53-b953-4824b4d33744`の通常`wrangler deploy`成功を確認し、21:43の本番8303 SSRはHTTP200・33,282B・SHA `077bb8a5838097e4400041a0305f397a6a2048d1ba79dbf19be73b900ab64ecc`。画面到達の成功を当日データ回復と取り違えない。引用したYahoo一次方針2HTMLは物理page `3f9d74ff-84cd-81b6-97d2-e0fe8dea0c2c`へ実体保管・全SHA読戻し済み、金融API再取得0。

通常日次と保存原本のデコード・計算を共通化した[PR395](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/395)も関連254テスト・独立36テストと全CI成功後main `d23ba81c571cc3ba7e19293c9a602bfb51be9e1d`へ反映した。main build `cbc6b683-d5a5-46ff-a4ba-090bc215c6e5`は22:12:15に通常deploy成功、version `70ea4242-0ad4-4ed0-9b69-51b941e359e3`・既8Cronを確認した。指標計算・Quote計算・SQL writerのバイト同一、HTTPSと保存原本の全文SHA/実取得時計を検証し、新規金融GET・復旧の本番writeはまだ0。

safe20の本番反映は全20社・20 atomic batchで終了し、PRE/POST物理添付2,218,553Bを全SHA照合した。独立inspectorは別プロセスで全20社の全6表・本文全ブロック・原典版・最新文書・両物理添付を照合し、300.38秒で成功終了した。モデル0・元サイトGET0・補足更新0を維持する。

不要なclean worktree23個を通常`git worktree remove`で削除した。全24 HEADをarchive refsと検証済みbundleへ保全し、私有設定/資料67fileも全SHA照合して保持。旧未コミット実験1worktree・9変更と稼働中runtimeは削除していない。Gitへの私有ファイル追加0。私有cleanup receipt SHA `128e4df131f74f068a3375e673081aafd616492d511dd9ca21aa184bb16dd306`。実disk空き増57,884,672Bは観測値で、共有node_modulesを含む論理容量とは区別する。

catchupの遅配対策は通常ハーネスの[PR394](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/394)でCI全成功後main `bb77c8c97e71fb11434b263583152b3efc803abc`へ反映した。Cloudflare main build `b8515356-c604-4da7-bb41-560eeae0cc1b`は22:05:07に通常deploy成功、version `34fc8b33-c9ca-45ed-ab72-3d2d377e0731`と全8Cronを確認した。開示19時起動と20:05結果確認が本番登録済み。予定日/開始窓/main資格・絶対締切・54分外部cancel・全Jobsの順序と完了を確認し、手動回復を定時成功へ流用しない。S3 SDKの保存価格読取はglobal fetch外なので、既存単発timeoutと外部終了制限に依存する範囲を明記した。

今日の通常TDnetは、bodyの既知安全境界停止・safe20独立読戻し終端・資金フロー成功・catchup active0・RAW実cap0.25を確認し、wx/fsyncの単発intent後に22:05:48/run38568972670/head bb77c8c9で起動した。起動資格と共通設定は成功したが、22:07:04に同日確定バッチ `tdnet-daily-2026-10-14` の内容差で保全停止した。native terminal SHA `fad2d6535fba3977d71cb1d9c3fea1ba7e6753f16aab308fb829656f7654482c`、全log SHA `e7352b0a9e941be345de2812e2c52b5bb30f94125064c09c8c379c0d3b94409a`。一覧日内更新とD1欠測差分の解消で確定バッチは合法に変わるため、同じ固定keyへ上書きせず通常producerのsnapshot識別を修正する。無条件force・再送はせず、EDINETもまだ起動していない。今日の両source成功と次回19時の定刻受入は未完。

この根因は[PR396](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/396)で日次だけ実生成JSONの全文SHA付きsnapshot keyへ修正した。既保管317,029B・717行を全SHA照合し、実2行の最小回帰を使用。関連92・独立22テストと全CI成功後main `34af2ccbade654128e05fab38c44af4d1e2eb9ea`へマージし、22:26:59にmain build `fb06bf6f-4d65-4d94-a3e8-5e475abd1f75`の通常deploy、version `a068382b-d98f-4fe4-9ac1-a29c64ec76e3`を確認した。新しい単発intentのrun38571851266は同mainで起動資格成功・取込中。旧失敗run自体の再実行は0。

RAW run38563817035は22:25:44に成功終了、固定集合の追加500件を全照合した。17件既完了・483新規、cursor5,002/残73,830、源GET0、Notion10要求、実原本211,869,614B、計58.245分。native full log111,869BのSHAは `dd993f91f8c933f23f2c3022ff6524038b3da80bda6d42dc52ede154078fe19b`。前runと転送bytesが違うため時間差をコード単独の効果と断定しない。次の有限継続run38571686207はhead d23ba81cで実行中、同RAWコードと実cap0.25を保持する。

R2のSDKはglobal fetchを通らず、保存8303 v1の全HTTP予算に算入できていなかった。v1は未実行のまま全bytesを保全し、[PR397](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/397)で既存共通readerのsend前予約・SDK/body同一絶対signal・全body/中断prefixと実ETagの観測を追加する。通常保存JP readerにもR2キャッシュ20MiB/60秒を接続。関連331・独立52テスト成功、main受入待ちで有限本番writeは0。本文55batchはroot独立75pinsと元pool/deadline継承の全文レビューまで成功、通常2sourceの終端後に未開始範囲だけ再開する。

## 10/15 00:36の本番ハーネス確認

- ローカルはNix Node22.22.2/pnpm9.15.9と本番と同じlock依存を使用し、通常共通計算/parser/writerへ接続する。復旧専用の業務writerや別の判定モデルは追加しない。Worker/GitHub Actions/Macそれぞれの反映を分けて記録する。
- 通常の19時起動・54分上限・20:05全job確認（PR394）、日次原本key（396）、保存価格共通計算（395）、R2本文期限（397）、海外別表とscope（398）、保有CLIのdurable journal（399）、EDINET実queue/理由表示（400）はmain反映済み。399のmain実配信23:08:57、400は23:19:05/version944a7d76。次の19時予定実行はまだ受入前。
- [PR401](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/401)のmain配信23:43:12/version06426f50と8Cronを確認し、[inspect38582945803](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38582945803)で原本と索引を変更せず停止箇所を確定した。旧送信ACKの復元やunknown clearは行っていない。
- [PR402](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/402)は通常Mac CLIの入力/要求/原応答をwx/fsyncで確定し、未完/破断後の次forwardを跨runで停止する。215回帰をrootも実行し、partial.rawだけ残るfsync失敗も拒否する。同じ完成出力の再利用は元完了時計を保持し、Notion保存成功とは分ける。main配信済みだがMac049からの切替えはA復旧の固定sourceを解放した後。
- 添付118文字がFile Upload200/200後にFiles.name上限100でページ作成400となった原証跡を保存し、[Python PR403](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/403)と[TS PR405](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/405)をmainへ反映した。通常入口で全添付の最終Files名を送信前に検査し、名前を黙って切らない。upload APIだけの102/118文字という別の契約は保持する。root独立Python144＋fixture方針9、TS78テストが成功。新規金融GET/モデル呼出し/データwriteは0。
- [PR406](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/406)は通常共通readbackとmoneyflowを既存shared archived-downloadへ統一し、同じURLのGETだけ各45秒/合計90秒/最大2回とする。root独立106テスト、全318suite/5,501テストとCIが成功し、00:31にmain5e122963へマージ。00:34:48の実deploy/version46f07355と8Cronも確認。正常時は1GET、失敗時の増分は最大1GET、添付のbyte上限は各試行単位であり全wire総量とは呼ばない。旧A/8303のsticky STOPは保持し、書込を再送しない。RAW正常移行はfinal bodyだけを計数していたため、partialを含む実要求/bytesの接続を別途直してから再開する。
- A876の初回read-only STOP後は元22要求/102,209ms/開始時計/絶対expiry10/15 17:30を継承する。独立レビューでbeforeExitのみでは通常CLIの明示exitに到達できないことを発見。未実行の新handoffは保留し、実CLI終端を通る成功/非0/完了検証拒否の回帰を追加してから判断する。本文/Notionのguardを消して続行しない。
- VWAP通常全量run38547185176は181分31秒で失敗し、300分hard cap到達ではない。日足summaryは3,632/3,686保存・error54、5分足summaryは1,823保存/7skip・rateLimited1・aborted true。full native log SHA `37bb6d4633a14e4557e2b9827b6d9c721202285f6f1486b37ec0be537d8480d4`。後続schedule38570657322はdaily-intraの実stepでN225当日終値NULLに停止、native log SHA `2968dcf8ff1d6945e47625fb864060d3b5bfe96a4bb3be10a9b7c1a92e8bd6e8`。旧推定のmargin-onlyとはせず、古い終値への代替/無条件再実行は行わない。
- 本文新53batchのroot独立レビューは36owned/祖先197SHA/29Git source＋保護lib/元と新の依存15,119entryを全照合。旧008の業務mutation/unknown0と失敗Notion3＋D1 61を保全し、origin/deadlineをリセットしていない。新fresh単一D1読取のclassification SHAは`0201b8c9fdb110b6287080a7641c3a8cb34b63b2b6000aa35b6f8d0f6abcb01c`。EDINET15件の既知HOLD失敗は成功へ変更しない。
- 23:35/23:45の実Cron集計はCloudflare公式Observabilityで確認。株価exception1・資金フローok1、原native集計の私有保存SHA `d8f633448557b944f7d345e4ccbc0eb0c9d1e0598f93bb63b4db6a83f5dcba3e`。events表示はconnectorのscheduled requestId schema不一致があったため、同じ時刻/Workerのnative集計で確認した。運用記録の欠測をジョブ成功へ置換しない。

GitHub repositoryは実APIでPUBLIC、既存workflowはstandard `ubuntu-latest`。現行の[GitHub公式料金方針](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)でこのrunnerの公開repo実行時間は無料（2026-10-15確認）。RAWの現在58.245分/500件を残73,443件へ単純外挿すると約143時間で、容量差/障害/待機を含む終了保証ではない。原本移行の時間を隠さず、元200run上限・通常ジョブのsource lock・料金/転送を維持する。R2保管・cache/artifact・Mac電力等を無料実行時間へ混ぜない。

## 23:06までの通常経路と有限復旧の追加証跡

- PR394のCloudflare 19時起動・定時54分終了・absolute cutoff、PR395の通常/保存共通計算、PR396の日次snapshotキー、PR397のR2 SDK本文期限、PR398の原典付き海外解析をmainへマージ済み。397は22:52 version41969285、398は22:59 version540de0ddの実デプロイと8Cronを確認。次の19時定期実行の受入とは分ける。
- [TDnet38571851266](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38571851266)は成功、[EDINET38574602631](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38574602631)は既知HOLD15件を残す失敗。同じmain34af2ccbで通常起動資格を通過した実結果で、手動起動を19時定時成功に流用しない。最新DBで固定body2695/A876の書類/年度/原本pointer等は全件不変、pending15全件も旧原一覧/理由と一致・同日再確認待ちを照合した。A876と15件のdoc/issuer交差は0だが、Aの実同期は未起動。
- 本文55batchは22:58:36に別review済みcontrollerから再開。旧完了batch/元開始時計/Notion累計と元deadline10/15 15:59:06を維持し、sourceGET/補足write/モデル0、.75rps・元60,000要求poolを広げない。個々の全6表CAS/物理PRE/POST/FINAL/旧最後退役を続ける。
- 海外解析v4の全3642実解析は652.820秒・RSS1.584GB。別runの旧baseline比+6.94%で同時ベンチマークではない。依存/取得/モデル追加0。18追加資格のうち14は旧本番既OKであり、18欠測解消とは数えない。
- RAWの次runは結果不明を含むreceipt_inflightで停止。成功済み5002件の後の部分進捗を読み取るまでcursor/旧receiptを変更せず再送しない。全78,832件完了とは扱わない。

## 01:20 JST 本番ハーネスへの反映状況

一時復旧だけでなく通常callerへ適用した変更を、mainへのマージと実配信で照合する。ローカルはNix Node22.22.2/pnpm9.15.9と固定lockを使い、本番の既存依存を再利用する。新しいジョブ基盤・有料AIサービスは追加していない。

| 通常経路の修正 | PR・本番配信 | 確認と残条件 |
|---|---|---|
| Notion保存添付の有限再GET | #406/main5e122963、00:34:48/version46f07355 | 同URL最大2回・各45秒/全90秒・全文SHA必須。HTTP失敗/guard/不明例外は再試行しない。正常1GETは維持 |
| RAWの部分本文・再GET・既存レート枠 | #408/maind90725af、00:54:29/versionead4cd1e | 部分受領も加算、5S+2W予約・元絶対期限。SDK/header/D1応答bytesは未計測を維持。新runの実速度確認は未完 |
| Notion未完一覧の誤成功防止 | #409/main342c2ab2、01:11:59/version4c075436 | 共通TS/Python入口でpresent markerはexact completeのみ。absentは旧形式のまま。Python自然終端10,000以上もSTOP。TS242/Python147独立テスト成功 |
| 株式UTC対象日と保存原本のclock一致 | #410/head9509ed44、CI中 | 通常dailyと同じ06:30〜21:00 UTC、原観測時計は不変。独立Nix7suite171PASS/既存3skip。VWAP JST条件は維持。本番配信・新fresh9表CASは未完 |
| VWAP定期起動・遅配停止 | 隔離branchで実装/検証中 | MWF17時の頻度を維持して既存CF schedulerへ接続、同run予定日/開始窓/新通信・PUT期限を検査する。18時stock/JP producerに新依存は加えない。PR/本番/次定時は未完 |
| Clef CLI原応答の永続化と再利用 | #402/main、Worker23:57:54/versiona7b75246 | 原応答のwx/fsync・未完停止・完成出力再利用を通常CLIへ反映済み。Mac049は復旧runtimeを保護して切替え待ち。定時受入は別 |

Notionの[クエリ上限](https://developers.notion.com/reference/query-a-data-source#pagination-limit)はカーソル終端だけでは完全性を証明しない。保存済み333一覧envelopeの監査ではincomplete101は保有明細に限定された。RAWの固定78,832集合は16SHA分割/各4,840〜5,036件・unique SHA/page/保存native progressと一致し、今回のcapによる欠落の証拠はない。ただし旧HTTP query envelopeの全保存はなく、全原本処理完了とも呼ばない。カタログ89件は別のblock children全文照合である。

## 最初の修正

- 母集団overlayをN225鮮度ガードより前へ移動。開始窓・期限・HOLD時の停止は維持。
- JPX/NYSE公式2026/2027休場表をTypeScript/Pythonで共有。未整備の年は推定せず停止し、休場は理由付き予定なしとして扱う。
- 価格依存sector-turnoverだけを株価成功に連鎖。他28取得元は既存`only=independent`でCFから平日18:15 JSTに起動し、23:45に完了を別receiptで確認する。
- 18時writerの期限に合わせ、価格・指標・モメンタムのactive全件coverageとマクロ基準日を既存opsで検査。1銘柄だけ日付が進む誤成功を検知する。
- 連結注記5系統の明示elementId/ラベルを追加し、連結優先を保持。保存済み実有報S100Z2Z6は35→37節になり、連結セグメント・関連当事者が追加、有価証券関係・後発事象は連結版へ是正される。
- Notionカタログは`--refresh-catalog`指定時だけ更新。同値なら無書込。新本文の全読戻し後に旧blockをarchiveし、子DB等混在・結果不明・読戻し不一致は旧本文を残して停止。

## 費用と性能の確認

初期の機械的な取込修正では新規サービス・有料AIを追加せず、通常取込のsource数はsector1＋独立28で29のまま。後続の指定Clef導入では専用uv.lockの依存と19.08GBのモデルを追加した。実87社のNix実行は24分6.7秒・RSS20.57GB・MPS driver26.65GB・swap増0で、旧モデル実験より大幅に遅い。全社定時再判定をせず変更対象だけに限定し、機械39列同期はモデルから独立させる。ローカル電力/ハードウェア費用は未計測。株価失敗日に独立28も止まっていた状態から、予定どおり稼働する分は回復に伴う負荷として計測する。

10/14 00:50 JST前後に認証済みCloudflare請求画面を読み取り、現行Workers Paid/R2 Paidと、10/4〜10/13観測の従量合計$0・予測$0・全表示項目が包含枠内であることを確認。アカウント全体の表示値はWorkers171.19k requests/CPU2.89M ms、D1 read1.08B/write1.13M、R2 Class A40.64k/Class B190.74k、build51分。R2 storage1.22GB-month、D1 storage0.24GB-monthは累積課金量であり現在容量ではない。請求画面は当プロジェクト単独の使用量ではなく、固定契約費も従量$0に含めない。

coverage SQLの本番SELECT1回は`rows_read=14,757`、`rows_written=0`、SQL20.73ms。30日実行で442,710行/月、D1 Paid包含25,000,000,000行/月の約0.00177%。OHLCV全走査やR2全列挙は行わない。包含超過後の従量単価でもこの増分は月$0.000443相当。

独立資金フローの起動監視は平日2 Cron・既存R2にreceiptを2回PUT/1回GET・GitHub dispatch/Jobs読取を追加する。22平日ならR2は44 PUT/22 GET規模で、100万Class A/1,000万Class B包含枠に比べて小さい。ジョブ本体は既存標準ubuntu-latestのpublic repoで実行する。

連結注記抽出は39項目内の候補照合だけで、通常取得の外部通信増0。営業日判定の実行時通信増0。カタログは明示更新だけなので日次通信増0。原本再処理は保存済み原本から対象を絞り、全38,210通の再GETや13.8GBの歴史原本二重化を行わない。

料金根拠（2026-10-14確認）: [Cloudflare D1](https://developers.cloudflare.com/d1/platform/pricing/)、[Workers](https://developers.cloudflare.com/workers/platform/pricing/)、[R2](https://developers.cloudflare.com/r2/pricing/)、[GitHub Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。将来の全量保管bytesや通常ジョブの所要時間を未測定のまま$0・性能影響なしとはしない。

## 本番作業の事実

- 00:43 JST前後の母集団overlay: events233、delist3、transfer1、listed0、held0。対象コード7183/7490/9691の読戻しと同日再入の不要書込0は続けて確認する。
- 失敗VWAP run38283511757の3034予定body SHAは`e900aeca117b8d6c9ab304be4958abf63f57533a21c12b6e0bd45115bff61f27`。現R2は旧10/2までの別SHAであり、予定bodyが現保存物と一致する証拠はない。unknown PUTを再送していない。
- 00:44 JSTの新run [38424649307](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38424649307) はN225の10/13終値NULLで、個別銘柄取得前にHOLD。原典NULLを古い終値で補っていない。日足全量完了として数えない。
- 5分足60dの7203単独run [38424981255](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38424981255) は成功。R2全body・原本と全母集団の受入は別に行う。
- IR通常catchupを既存の40日窓・古い未保管優先・12分予算で実行中。取得済み/保管結果不明の自動再送はしない。

## 公式原本の保管

JPX/NYSE営業日HTML、JPX株式・ETF・REITの2026-09実XLSX、トヨタ優待公式HTMLを共有`recordPrimaryData`で実体保存し、全bytes長とSHA256をNotion添付から読戻し照合した。営業日pinは`src/shared/market-calendar.json`、私有receiptは`tmp/feature-audit-20261013/official/`。実XLSXは既存parserで受入でき、パーサ本体の変更は不要だった。

## 受入を残している範囲

現在の残受入は、株価・マクロ・VWAP日足の最新全量、本文残2361文書と補足39列、本文なし20社の原典理由（604A提出予定10/30、10社予定未確定）、受注/海外表の修復・旧facts是正、Clefの適格な実入力変更対象、本文変更後の競合入力整合、資金フローsector/次の定時窓、歴史原本索引、全保有明細の主体/単位/価格来歴、監視の定時freshnessである。JSS認証付き28ケースとNotionカタログ全89block/5viewの読戻しは完了済み。

原典非開示・未提出・非適用・資格未確認は欠測理由として残す。列をNULLで追加しただけ、入口HTTP200だけ、単独銘柄成功だけでは全項目完了にしない。

## PR #352後の本番検証

- main `07cd0d188244263dd674a03338d38356c0b60ea3`はPR/本流CIとも成功。Mac runtimeは同SHAへff更新し、accepted SHAも一致、preflightは外部通信0/データ書込0。
- 保存済み原本だけで542A/S100Y5S8と646A/S100Z0VFを通常ingestへ渡し、Notion本文37/34節とD1の全索引elementId/charCount/ポインタを照合。上流GET0。補足39列と初回タグ判定は別の受入として残す。
- 646Aのcanonical⑤の旧scope0000を同一提出者の公式同定に従って646Aへ訂正し、関連マスタ・全旧property・原ファイル名/bytes/SHA/時計の保持を読戻し確認。歴史索引のmanifestはこの訂正後の集合から作る。
- 保有明細schemaは旧5propertyをIDのまま退避してから正規列を作成、2回PATCHの後に全schema読戻し。当初S100Z2Z6の2行を提出会社の保有として公開したが、03:38 JSTの再確認で主体の誤帰属を訂正した。以下の訂正記録を現行判定とする。
- SAAFの2026-09-08開示1279652の元PDFは取得不能。翌9日の公式差替案内とPDF（374,068B、SHA `08f8f81bf50ea701896ba0bc3c539fb32e73eace0b0026c248955846ec6b2746`）は別原本として物理保管・全照合済み。元行のNotion pointerはNULLを保持し、差替PDFを元原本として付け替えない。[差替原本](https://ssl4.eir-parts.net/doc/1447/tdnet/2882796/00.pdf)。
- 競合5社/250問の実測はyes64/no87/uncertain99・失敗0。uncertainを採用せず、旧候補選定の食品小売/SaaS大分類capによる候補外を精度上の限界として残す。残78社はswap増1GiB/空き20%を停止閾値にした純ローカル生成のみ、まだ本番判定成功には数えない。

## 保存原本pilotの完了と次の課題

保存13 ZIPのうち適格11操作は、本番D1全列CASと全Notion本文読み戻しを経て完了した。本文7件は歴史文書のため最新補足は0更新、受注3/海外1からの画面投影は適格条件を満たす2銘柄だけ生成し、対象4との差を欠測値で埋めていない。最初の試行は他処理によるp_yuho_growth/3962の日時3列変更を検出して業務書込前に停止し、旧ラッチを保持。新PREで再計画した残入口は、既に保管したtype別原本11を再アップロードせず全文検証した。上流GET0/原本再upload0、PRE/POSTは物理保管・全SHA照合済み。

原本索引dry失敗は件数/byte実測の成功として数えない。共有Notion/Zod/通信例外が伏せられ原因未確定だったため、定型文allowlist・Zod code/path・message/cause SHA・Notion要求/429/再試行数・最終phase/prefix進捗だけを観測する。署名URL/原文/資格情報は出さず、再送制約は維持する。⑤の基準日NULLはyfinance valuation49件あり、架空日付で埋めない。

基準日不明49原本について、共通Python publisherが取得日を基準日へ補っていた根因を修正する。TypeScript/Pythonとも物理partitionは明示`nodate/nodate`、D1 data_dateはNULL、取得時計は元値を保持し、日付あり原本の既存keyは不変。既存索引/R2の旧状態は別途読取照合し、未知の旧オブジェクトを上書きしない。

## 03:38 JSTの本番読戻しと保有主体の訂正

最新50社の差分38社は、保存原本・PRE/POST物理保管と全文SHA照合、新本文→D1全列CAS→全読戻し→旧本文退役の順で完了。上流GET0・原本upload0・補足更新0・AI0。POST SHAは`060226a9f092f5abeaec0d59cea8e81d7746cf34c03672829de6d96de39d4bd3`。補足やタグの受入へ成功を流用しない。

S100Z2Z6原本の見出しは「コーア商事株式会社における株式の保有状況」であり、上場提出会社コーア商事ホールディングス株式会社の直接保有ではなかった。2行ともfresh全PREと主体原文を共有archiveへ物理保全し、単発PATCHで保有会社を実子会社へ訂正、未確認の会社コードを空欄、原本照合済/価格照合済をfalseへ戻した。全property読戻しで株数・帳簿価額・価格観測・原典・旧値の不変を確認。保管pageは`3f8d74ff-84cd-8196-b642-f8dd9e0f632b`。当初の2行を適格な提出会社保有として数えない。保存ZIPは同一SHAのまま、全量準備を次item前に停止し、主体区画guard追加後に旧計画を再解析する。

基準日不明49原本のうち既存D1索引があったのは1件。canonical Notionの元ファイルを全文SHA照合し、全17列CASで`data_date`だけNULLへ訂正、他列・時計・旧R2 keyは保持して全列読戻し済み。R2 body照合・R2更新はこの作業では0で、歴史原本全量の受入は別に残す。
