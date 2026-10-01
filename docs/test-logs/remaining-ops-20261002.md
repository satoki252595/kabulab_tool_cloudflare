# 残件の本番確認と費用 — 2026-10-02

Refs #98 #102 #117 #132 #146 #160 #163 #196。公開Gitには集計・SHA・実行リンクだけを保存する。
原文・請求画面・アカウント財務・認証値は公開しない。

## 有報の通常Node入口

[catchup run 36889246176](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36889246176)
をmain `ee2760d2787c53e796f495159b1c35776b1413f0`、target=edinetで1回dispatch。
実行前に全in-progress/queued一覧を読み、他の本番writerが無いことを確認した。

- workflow作成: 2026-10-01T16:04:46Z、job開始16:04:52Z。
- Node取込step: 16:05:07Z → 16:11:33Z、正常終了0。
- 全体workflow成功。TDnetとbiztagは対象外でskip、失敗通知もskip。
- 実summary: scannedDays24、matched83、ingested0、skip83、outOfUniverse1、
  reachedCap=true、listErrors0、ingestErrors0、projectionStocks1384、elapsedSec384.468。
- 60日窓を全走査したとは主張しない。300秒予算が新しい日/文書の開始を止め、
  開始済みの文書と末尾L2をawaitする既存契約どおり。
- `text:ok`22、受注status計22、海外status計22。共有コードでは`archived_only`を
  skipへ合算し、早期`skipped_existing`をstatusから除くため、22再処理・61早期skipと
  **推論**する。ingested0をsource GET0/Notion0/D1 write0とは読み替えない。
- 原本不足時は既存type ZIP保管と全添付readbackを経由する。`needDbWork=false`では
  文書/facts/text-index置換batchを送らないが、本文backupとnotionDocPageId UPDATEは
  別経路で実行し得る。今回のtype1/type5新規数・本文new/skip内訳はログから未確定。
- 全体L2の開始/完了を確認。1本の長時間Worker HTTP応答待ちは使わず、今回
  ECONNRESETは再発しなかった。過去の切断主体が判明したという意味ではない。

実jobログは私有0600で保持した。再dispatch・未知の過去POST再送は行っていない。

その後、[定時catchup](catchup-scheduled-20261002.md)はTDnet・EDINET・biztagまで成功。
TDnetの期限到達とEDINETのcap、課金切れ25件は残っており、全履歴完了とは扱わない。

## 限定修復と残件

| 対象 | 10/2の確認済み状態 |
| --- | --- |
| 646A | 最新FSA原本→通常資格判定でsector33を化学へ修復。全56cells一致・再入SQL0・原本/PRE/POST全文保管。[実績](issuer646-actual-20261002.md) |
| 優待2307/2001/3189/6577 | 旧HOLD14行の制度/行生成を修復。実POST467cells一致・再入SQL0・全原本保管。選択/寄付/抽選の金額NULLを保持。[実績](yutai-hold14-actual-20261002.md) |
| 株式10/1 | 以前の3634/3689成功・55失敗は未修復。原文保管修正後の通常入口はN225終値nullで停止、個別株/D1/R2書込0。[実受入](stock-normal-acceptance-20261002.md)。[PR263](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/263)で再試行期限と回収中の取得停止を修正したが、修正後の通常全量成功・55件の新原文分類は未確認。将来廃止を前倒ししない |
| VWAP | 通常入口の全795応答/27partsとsummaryを全文照合。769保存後にYahoo認証429で停止、5分足未起動。[実受入](vwap-normal-acceptance-20261002.md)。株式/VWAP共通PR263は3CI成功・main `0fe0a71`へmerge済み。19:12UTC頃にrootがCloudflare UIでBuild SUCCESS・version `eb298192`・本番traffic100%を確認。新source GET0で、Yahoo制限解除・通常全量日足/5分足成功は未確認。Cloudflare Paid不足と混同しない |
| 信用残 | 旧週次PDFを同SHA/4230行で再解析し、既存定時日次成功の9/30 PDF/4260行とR2全文一致を確認。[実績](vwap-margin-weekly-readback-20261002.md)。既存7認証設定を接続した[通常業種集計run](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36908547972)は18:48:43UTCに成功、入力2添付の独立全文照合と476件再解析も19:04:54–57UTCにPASS。Producerの全476POST照合成功とは別の証拠。保存済み9/30入力の新実績であり、旧9/28 UNKNOWNの再送・解決や全moneyflow/sector-turnover正常化とは扱わない |
| 海外売上 | S100YJVF1通の4連結区分差を条件付き反映し、full16/all12/L2all32・source/PRE/POST全SHA・同doc producer再入sender0を確認。[実績](overseas-pilot-actual-20261002.md)。後続の固定15通は原本全文照合済み（新取得13・既存読取2）、全文数値資格9通/57明細・保留6通。[原本検証](overseas-next15-custody-20261002.md)。後続9通のD1反映・旧3611全体は未完 |
| 8508 | PR258で単発日を別列へ保持し年間利回り/定常月から分離。実1件の9/2日付修復、全97cells一致・再入SQL0・通常6月4件保持・全原本/PRE/POST保管と本番UI確認を完了。[実績](yutai-oneoff-actual-20261002.md) |
| 課金切れ25銘柄 | 通知欠落をPR255で修正。Jevのcredit補充は人手判断待ちで未実施。最低top-up $5と25件の推論費概算上限約$0.069（最大retry仮定約$0.276）は別。補充成立後、10/3以後なら現retry条件のまま限定再開可能 |
| 定時起動PR195 | 3CI成功・レビュー済み。WorkerのGITHUB_ACTIONS_TOKENが未設定のため未merge。既存cronを消すだけの状態へ移行しない |
| 622A/海外未資格/信用残UNKNOWN/JPX新様式 | [公式根拠・再開条件](data-remaining-investigation-20261001.md)を維持。公表前の実ファイルや過去POST結果を作らない |

## コストの判断

認証済みCloudflareの現請求期間ではWorkers requests/CPU、D1 read/write/保存、
R2 A/B/Standard保存、Builds、直近30日Logsが包含枠内。Workers Paidと既存Notion Plusを
確認し、この対応のための上位プラン購入は不要と判断した。アカウントの他製品使用量を
kabulabへ帰属させたり、全額$5/月と断定したりしない。
[費用確認](../cost-audit-2026-10-01.md)に公式価格、負荷計算、保管の追加時間を残した。

新規購入、CPU上限引下げ、Logs sampling削減、Notion契約変更は行っていない。
