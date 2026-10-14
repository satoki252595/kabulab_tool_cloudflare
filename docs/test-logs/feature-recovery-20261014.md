# 機能別監査後の復旧と受入

追跡: [#348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。監査と全20機能の完了条件は [feature-gap-audit-20261014.md](feature-gap-audit-20261014.md)。作業開始2026-10-14 JST。全件の本番受入が済むまではこのIssueを閉じない。

## 10/14 本番受入台帳

「実装済み」と「本番の全量完了」を分ける。予定時刻前の処理、結果不明、原典にない数値を完了に含めない。 以下の表は19時台の追加確認を反映し、各機能の独立した読戻し時計に基づく。同時snapshotではない。

| 機能 | 実装・本番証跡 | 残る受入 |
|---|---|---|
| 銘柄マスタ・上場状態 | 公式233イベント、廃止3・市場変更1・保留0、再適用0書込 | 次の定時overlay |
| 株価・財務断面 | 18時取得とactive全件coverage監視をmainへ反映 | 10/14 18時の定時run38539360030が起動済み。同日全量・23:35読戻しは別受入 |
| RSI・スイング・モメンタム | 同じ母集団・基準日の下流監視を追加 | 株価復旧後の全件・期間不足理由 |
| マクロ | 公式日米営業日と夕方JP/翌朝US二段取得をmainへ反映。10/14夕方の保存N225・VIを通常readerで再parseし、同日確定session/前日終値/VI引け後tickとNotion物理manifest・VI全SHA一致を確認。4read・上流GET/書込0 | 翌朝USの実定時受入。JP原本の成功を両市場の全完了へ広げない |
| 財務サマリ | 専用ROE102件と直接開示の純利益ROA6社を本番全読戻し済み。実表ROA3社の通常parserはPR374/main、保存済みtype1原本だけのpublisherはPR378/main・run38534023380で成功。独立にNotion/R2の全9ファイルと索引3件17列の一致、財務D1全25行/Notion3全props・時計の未変更を確認 | 3社も限定反映と独立読戻しを完了。ROA6963=-11.6/8014=8/8593=1.3、D1全25行/Notion3全props・物理POST一致、他22行不変。旧403/検索判定guardSTOPは保全、原本再publisher0。未開示の財務値は原典理由で保持 |
| EDINET・本文なし | 00000と040000/040001様式の漏れを特定しTS/Python双方を修正。542A/646A本文37/34節と財務修復を全読戻し済み。欠けていた7/1〜8/13の44日一覧も実体保管・全文SHAから直接提出者別に照合し、対象20社の120/130は0 | active本文3,666/3,686・財務3,674/3,686。残20社は初回期末前9・提出予定明示1（604A 10/30）・提出時期未確定10。44日内の未観測を解消したことを全期間の未提出証明に広げず、公式の初回提出予定の確認を継続 |
| 有報39項目 | 最新3666通の保存原本/DEI/全文SHA資格を確定。NOOP505・修復3161のうち400通を全文/索引/D1/物理POST/旧最後退役まで完了。39列機械同期と保存native本文の重複読取省略はmain反映済み。限定5社の通常同期195項目を独立全一致・モデル0で確認 | 残2761本文=canonical2745＋typed/legacy16。canonicalは安全境界で旧chainを終了し、56batchへ引継ぎ。旧60000要求/22h予算・絶対deadlineを維持し19:00〜21:30はnetwork0待機、準備lead3720秒を確保。905資格済み本文とfresh補足planの交差を準備中。原典非開示6255節と残39列も別受入 |
| 受注・海外売上 | 適格11操作を全読戻し、全本文selector/建設表と明示地理Otherをmainへ反映。PR383/mainで唯一の外部顧客売上行も対応、保存2600通の旧適格facts差0・新2通を確認。本文保護済み20通のfresh全PRE/原本31.4MB/最新pointerの一致を確認 | 最新未対応受注118/海外731を基準に、safe20のatomic facts＋共通L2反映を準備。別に70通の当期連結地理売上の明示省略を資格化し、理由保管の通常経路を実装中。数値0や総額残差では埋めない |
| IR・PDF | 381件物理保管・読戻し、行エラー0。旧SAAF1件は翌日の公式差替案内・差替PDFを確認し別保管 | 元PDFは取得不能のまま。差替を元PDFとして偽装しない |
| VWAP日足 | 旧3034の結果不明を現物SHAで照合。夜間のN225終値NULLは正しく停止。旧7203限定dispatchのHTTP500/ACK不明は保持し再送0。10/14同日JP確定原本の資格確認後、未発火の通常全量daily-intraを1回dispatch、HTTP204/run38547185176 ACK | 新runは共有Yahoo queueで待機、source取得・全量完了・全body読戻しは未受入。旧unknownと異なる同日確定窓の新intentを保存。定期頻度は増やさず通常300分/CONC1/原本30銘柄batch/429停止を維持 |
| VWAP5分足 | 593Aは保存原本から再GET0で単発CAS、残4はrun38463034602で各1GET。5件の原本物理・R2全SHA・旧履歴保持を照合。先行1,830＋1,850＋7203pilotを含めactive3,686との集合照合は欠測0/余剰0 | 各読戻し時点の合算で、同時snapshotではない。最終約定日は10/13が3,623・それ以前63。63のNULL/volume0/未提供/解析除外を保存原本で区別し、当日分も引けslotを根拠なしに充足扱いしない |
| 信用残・日証金 | 信用10/9基準・10/13公表4,247行、日証金10/9基準4,349行 | 旧日付20コードは最新保存CSVに全て非掲載と照合済み。旧観測日を保持し、最新値に偽装しない |
| 優待 | active普通株7,716行の条件DTOを原子適用し、全旧列保持・全行読戻し、要約pending0。本番7203画面と既存有効キー付きAPI/MCPの実条件schemaを照合済み | 未解決の取得元条件は根拠未確認として保持し、生成した事実で埋めない |
| 事業タグ・Mac | 指定Clefの17file/専用head/Nixを固定し実87社を完走、precision95.16%/recall75.97%。通常5社の39列機械同期195項目を独立確認・モデル0。4054/S100Z492は実Clef保存出力を再推論0で反映、全67props・新根拠全文・旧根拠退役・最新D1・物理POSTを別processで独立全照合済み | fresh planは3554 sync_text/106 retag/26 skip。本文資格905と現在doc/FY/pointerが全一致し、機械同期876・Clef再判定23・処理済み6（4054＋既5社）へ分類済み。有限処理の費用・時間を確認中。20/21時の実定時窓は未来。全社再推論せず、旧モデルreceiptをClefへ付け替えない |
| 競合判定 | 固定83社の保存確率から追加推論0で81社/574関係を反映、全読戻し・物理POST照合。今回の本文再抽出だけでは固定83入力のwire差0を確認 | 旧corpus→最新docの先行世代差109社と本文修復差を分離。候補Bの質問変更27社を含む対象A33社を、最新タグ/候補の確定後に再資格化。未観測B13社、HOLD130A/145Aを変更なし/採用扱いしない |
| 資金フロー | 独立28取得元を分離。先物建玉145行・月跨ぎ週448行を全読戻し。世界指数16原本を物理照合、欠け34件を単発createし全221件の19列を読戻し、既存187の全props/id/親/状態は不変。POST全文も物理SHA照合済み | sectorは株価全量後。次の独立定時runとfreshness実判定 |
| 原本索引 | 固定cutoff78832件。初回日付差13件を物理PRE/POSTと全17列CASで是正し、他4808行・旧R2キー/body・両clock不変。PR377/mainで再発根因修正。残196runの同scope再開run38533846279と次38540554672は成功し、native continuation38545525664が稼働中 | 全78832件anti-join欠測0まで未完。旧200run上限から消費4を引いた196であり予算/stateをリセットしない。17:37読取cursor2523は過去の観測として保持し、現在cursorへ流用しない |
| 保有明細 | 旧27587行を物理保全、主体・source100行window・通常価格queue・最新保存公式銘柄表・英語商号句読点照合をmainへ反映。初回117価格原本/3456銘柄をfresh全SHA資格化しR2有効化を独立確認。全3666保存readerを隔離旧runtime/.5rpsで継続。固定3200通の新表形式比較で旧18904明細不変・新361明細を確認 | PR386の表形式修正は全CI緑でmain受入済み。全3666の新manifest・主体/単位/価格反映・過去source完了行の限定enqueueは別受入。197Aの通常1社1明細pilotは価格269円/12802248円まで6/6ACK、formula正常変化の誤検知をPR385/mainで修正。fresh全16/34propsと時計を確認後、残完了3propsだけを1回PATCH。source完了・他13props・holding全34props/時計を保全し、物理POSTと別process4readの独立全照合まで完了。10/2価格snapshotを当日価格と扱わない |
| API・MCP | 正式JPX信用残・JSF品貸料経路をmainへ反映、内部normal Workerは6binding/100%配信。Cloudflare上の既存キーを外へ出さず28固定ケース・8tools・REST/MCP10組・native4digestが全成功 | normal版8772279cの配信/全binding不変を照合済み。認証拒否のsurfaceなし契約も確認済み |
| 監視・Notion案内 | 全件coverage、独立ジョブ、Mac監視。カタログ本文更新・コネクタ再読取で現構成一致 | カタログ89block全内容照合・DB ID逆順でも再更新0書込を確認。推奨5view既存設定を照合済み。次の定時freshness/ops実判定は未達 |

復旧用の大量処理は通常Cronと分け、上流の再取得を最小化する。Mac監視増分は両処理・ops合計で月120 PUT/240 GET・小JSON2個。歴史原本は最大24.73GBの追加保管で月約$0.285の保守的増分見積り（既存約4GB、無料10GB、$0.015/GB-monthの条件）。通信・照合時間は別で計測する。既存Workers Paid固定費を従量$0に含めない。

04:28 JST追記: accepted main `847c2279988082f6b7cda58e559a631ab3f6b517` の通常CLIで対象5社を限定反映。3社のdoc変更再判定と2社の機械補完が判定済、残0・失敗0・資格保留0。共有writerの旧全PRE保全→新根拠全文確認→単発更新→全property読戻しまで完了した。CLI98.641秒、起動を含む全体100.151秒、Notion172要求・429/再試行0、SemIf3回・外部AI API0回。プロセスツリーの1秒間隔実測ピークは9,294,944KiB（約8.86GiB）、128GiB機の空き最低60%、既存swap使用10,566.88MiBからの増加0。これは限定5社の実測であり、全最新文書の再投影時間や実精度の保証へ広げない。

価格照合cacheは保存済み実明細587行で結果SHA不変、同じ1.92MB chunkの展開504→1・chart解析104→30、9.393秒→0.152秒、RSS203→174MB。固定価格116ファイル/3,456銘柄の索引作成は13.53秒・ピーク約270MB・源GET/業務write0。全保有明細の原本/価格資格は別途確認する。

月跨ぎ週W40の本番448件は392.215秒・全create ACK/独立全19項目読戻し一致・既存更新0・無関係write0・元サイト再GET0。POST全文物理保管SHAは`a2d4adcff0fee88dc71a18e4add5a2ad9798c4c0514e8e0360eda07b93fbd4ae`。世界指数の新JPY原本は要求`JPY=X`に対して実symbol`USDJPY=X`だったため初回は停止した。両名称`USD/JPY`、通貨`JPY`、資産種別`CURRENCY`、exchange`CCY`が全一致する限定aliasを共通parserで扱い、取得rawと解析snapshotの実symbolを保持する。実4,078B原本の回帰9件を含め関連51件PASS、別のprivate fixture不在35件はskip。過去13週の既存値/原本参照/時計の変更は、欠けの補完と分けてPREで確認する。

ROA定義の一次根拠は[JPX用語集「総資本利益率」](https://www.jpx.co.jp/glossary/sa/554.html)（2026-10-14確認、25,608B、SHA`e73f867741fba59ceff7f9e36858bbd81d7576738694acdb5bdea5c3099bcba8`）。利益の種類による定義差を維持し、経常利益率を純利益ROAへ代入しない。公式HTMLと149原本の検査結果をNotionへ物理保管・全文SHA照合済み。5社の実行計測も別原本として物理保管・全文SHA照合した。

02:30 JST追記: PR #351はCI成功後にmain `ef75b480`へmerge。0000誤紐付けを646A/core18156へ移し、D1全34列・Notion全property・元時計/数値不変を確認。日証金の旧20行は最新保存CSV（公表10/13、実申込日10/9、4,752行/4,349コード、SHA `e1f039abe7a824a3c37307be969c9bde007e670d135ce15bfa9ce2918be0f9e0`）に全件非掲載。最新値に補完せず、各旧実観測日で保持する。

Macは同mainで両実処理exit0、開始/終了R2 receiptを全文照合する経路を実行した。夜間手動起動は20/21時の定時開始成功には数えず、次の開始窓を別に確認する。既存Notionの高ROE・業種別・直近開示・決算カレンダー・commercial-okビューの設定も読取り確認し、重複ビューは作らない。[現行のビューAPI](https://developers.notion.com/reference/create-view)に対応しているため、カタログの「API未対応」は修正する。

保有明細schemaの初回要求は確認できず停止。読取り照合で全旧propertyが不変と確認し、[公式API制約](https://developers.notion.com/reference/update-property-schema-object)に沿ってoption改名をやめ、旧property退避→読戻し→正規列作成の二段へ修正する。旧pendingを消して同じ要求を再送しない。

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

現在の残受入は、株価・マクロ・VWAP日足の最新全量、本文残2761文書と補足39列、本文なし20社の原典理由（604A提出予定10/30、10社予定未確定）、受注/海外表の修復・旧facts是正、Clefの適格な実入力変更対象、本文変更後の競合入力整合、資金フローsector/次の定時窓、歴史原本索引、全保有明細の主体/単位/価格来歴、監視の定時freshnessである。JSS認証付き28ケースとNotionカタログ全89block/5viewの読戻しは完了済み。

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
