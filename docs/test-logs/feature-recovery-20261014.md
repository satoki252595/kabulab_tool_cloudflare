# 機能別監査後の復旧と受入

追跡: [#348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。監査と全20機能の完了条件は [feature-gap-audit-20261014.md](feature-gap-audit-20261014.md)。作業開始2026-10-14 JST。全件の本番受入が済むまではこのIssueを閉じない。

## 10/14 02:15 JSTの受入台帳

「実装済み」と「本番の全量完了」を分ける。予定時刻前の処理、結果不明、原典にない数値を完了に含めない。

| 機能 | 実装・本番証跡 | 残る受入 |
|---|---|---|
| 銘柄マスタ・上場状態 | 公式233イベント、廃止3・市場変更1・保留0、再適用0書込 | 次の定時overlay |
| 株価・財務断面 | 18時取得とactive全件coverage監視をmainへ反映 | 10/14 18時の同日全量・23:35読戻し |
| RSI・スイング・モメンタム | 同じ母集団・基準日の下流監視を追加 | 株価復旧後の全件・期間不足理由 |
| マクロ | 公式日米営業日表を反映 | 夕方JP原本と翌朝US原本の二段取得・実受入 |
| 財務サマリ | 保存TDnet原本149件15,370,605BをSHA照合。専用ROE102件をD1全34列/Notion全property読戻し。残45件は専用項目なし、2件は数値不適格/nil | ROAは未取得仕様。異なる利益比率で補わず、原典の欠測理由を示す |
| EDINET・本文なし | 00000と040000/040001様式の漏れを特定しTS/Python双方を修正。実646A資料で回帰 | 542A/646Aの保存原本取込、0000誤紐付け1件のCAS修復、残20社の初回報告期分類 |
| 有報39項目 | S100Z2Z6を35→37節、連結注記・補足4列・D1索引一致。旧行退役・タグ保持も確認 | 他の最新有報の保存CSV再投影と非開示分類 |
| 受注・海外売上 | 保存113実表の受注未対応66→59。保存13原本で本文7件・海外1件・受注3件を復旧可能 | 適格11件の本番再投影。残2件は情報あり未構造化を維持 |
| IR・PDF | 381件物理保管・読戻し、行エラー0。旧SAAF1件は翌日の公式差替案内・差替PDFを確認し別保管 | 元PDFは取得不能のまま。差替を元PDFとして偽装しない |
| VWAP日足 | 旧3034の結果不明を現物SHAで照合。夜間のN225終値NULLは正しく停止 | 終値提供窓の全量実行と全body読戻し |
| VWAP5分足 | 7203試験成功。全量60dは1,830件書込後429を検知、unknown0/rejected0で停止 | 保存1,830件の全SHA読戻し後、残1,855件のみ再開 |
| 信用残・日証金 | 信用10/9基準・10/13公表4,247行、日証金10/9基準4,349行 | 残存旧日付行の掲載対象・欠測分類 |
| 優待 | active普通株7,716行の条件DTOをnullable列へ原子適用、全旧列保持・全行読戻し。要約pending0 | 本番画面・有効キー付き内部APIの受入 |
| 事業タグ・Mac | 永続runtime、両実処理exit0・残0。同一SHA確認。新しいR2開始/終了receipt監視を実装 | 新版mainへruntime更新・R2実receipt・20/21時開始窓 |
| 競合判定 | 本文あり83社が旧全社判定停止後の未実施と判明 | 既存ローカルSemIfだけで対象限定の品質・費用確認 |
| 資金フロー | 独立28取得元を分離、JPX9月株式448・ETF/REIT26実行の純解析を確認 | 独立runの全系列・最新期間・原本照合、sectorは株価全量後 |
| 原本索引 | 既存GH資格でraw R2実GET・D1読取成功、新規資格不要。Notion固定集合と予算付き一回送信を実装中 | 50件実測後、歴史全件のR2全SHA・D1 anti-join0 |
| 保有明細 | 旧27,587件を物理保全。保存最新type1・確定単位・同日期末価格を照合するwriterを実装、実2件が価格適格 | schema/2件実受入後、最新原本範囲を予算内で回収。未確定価格は理由付き |
| API・MCP | 内部/公開Workerを更新、両start9ms。公開許可・非提供404・未認証401等8経路PASS | 既存有効APIキーを用いた業務API/MCP通し確認 |
| 監視・Notion案内 | 全件coverage、独立ジョブ、Mac監視。カタログ本文更新・コネクタ再読取で現構成一致 | 次の定時成功後のfreshness/ops実判定と無書込再更新 |

復旧用の大量処理は通常Cronと分け、上流の再取得を最小化する。Mac監視増分は両処理・ops合計で月120 PUT/240 GET・小JSON2個。歴史原本は最大24.73GBの追加保管で月約$0.285の保守的増分見積り（既存約4GB、無料10GB、$0.015/GB-monthの条件）。通信・照合時間は別で計測する。既存Workers Paid固定費を従量$0に含めない。

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

新規サービス、依存ライブラリ、有料AI、モデルダウンロードは追加しない。通常取込のsource数はsector1＋独立28で29のまま。株価失敗日に独立28も止まっていた状態から、予定どおり稼働する分は回復に伴う負荷として計測する。

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

株価・マクロ・VWAPの最新全量、39項目の既存文書再投影、識別保留15件/本文なし22社の分類、受注/海外表の未対応パターン、財務専用原典タグ、優待公開条件、Mac runtime、競合未判定理由、資金フロー最新期間、歴史原本索引、保有明細の単位/価格来歴、認証付きAPI/MCP、監視更新、Notionカタログの本番読戻しを継続する。

原典非開示・未提出・非適用・資格未確認は欠測理由として残す。列をNULLで追加しただけ、入口HTTP200だけ、単独銘柄成功だけでは全項目完了にしない。
