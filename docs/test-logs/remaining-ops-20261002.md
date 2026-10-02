# 残件の本番確認と費用 — 2026-10-02

Refs #98 #102 #117 #132 #146 #160 #163 #195 #196 #272。公開Gitには集計・SHA・実行リンクだけを保存する。
原文・請求画面・アカウント財務・認証値は公開しない。

## 後続の本番確認（2026-10-02 14:24 UTC）

下記の「課金切れ25銘柄は過去状態を保持」は後続実行で更新された。
保存済み本文と既存語彙の機械的照合で25件の本番補完を完了し、独立再読で判定状態・
文書参照・マスタ連携と次回plan全25件skipを確認した。PRE/POSTは物理保管・全SHA照合済み。
TypeSafeと追加原本取得は0で、現在の新規初回限定方針は変更していない。
[対象25件の実績と確認範囲](biztag-existing25-actual-20261002.md)。

PR #273で622Aの10/2公式原本・海外13資格/84明細の再現・保存済みbaseline復旧を記録。
旧来歴・HOLD2・過去UNKNOWN・JPX新様式公表後の受入は残る。
[再確認と再開条件](data-recovery-20261002.md)。

Issue #272はPR #274で配当原値/分割履歴の保存・API配信を修正した。
取得済み原本で回帰確認し、この実装段階のYahoo追加取得・本番データ書込は0。
[保存契約と検証](yahoo-corporate-events-20261002.md)。
その後、同じ保存済み原本から1333だけを条件付き反映し、配当14件・分割1件のイベントを
追加した。価格・既存分割・proof・更新時計の全不変、API配信、PRE/POST物理保管と
root独立本番再読が一致。Yahoo追加取得・TypeSafeは0で、5分足HOLDを保持する。
[1件の本番実績](yahoo-event1333-actual-20261002.md)。

PR #195は専用repo限定PATをWorker Secretへ設定してmerge済み。
main `4440e782238f4f0946935fedf94c9c1d5855adad`の自動deploy・traffic100%・4 Cron登録・
Secret継続・静的health HTTP200を確認した。真正定時受入は10/3 JSTの株式02:13、
マクロ06:00、期限確認06:05/07:05を待つ。[本番設定受入](stock-scheduler-production-20261002.md)。
追加の全量manual起動は0。N225の通常caller1回はHTTP200・10/2実終値資格PASSとなったが、
全銘柄/VWAPの制限解除には外挿しない。[限定診断](n225-once-20261002.md)。

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
その後、TypeSafeの新規判定は利用者方針で一旦停止へ変更した。25件の過去状態は保持し、
入金待ちとして再開を促さない。[低負荷・判定停止の記録](yahoo-low-load-typesafe-disabled-20261002.md)。
停止前は最低top-up $5と25件の推論費概算約$0.069（最大retry仮定約$0.276）を区別し、
補充成立後の限定再開を検討していた。この過去の見積りは現在の購入・再開方針ではない。
追加方針で[新規銘柄の初回事業タグだけAI](biztag-new-stock-only-20261002.md)を許可し、
既存の判定済みタグは銘柄コードで再利用し、有報/語彙変更でも付け直さない。未設定/判定失敗
だけ機械的一致で不足を補完する。旧25件を新規AI対象にしない。その後、上記25件の限定補完を
完了した。全既存銘柄を付け直す更新は行っていない。

## 限定修復と残件

| 対象 | 10/2の確認済み状態 |
| --- | --- |
| 646A | 最新FSA原本→通常資格判定でsector33を化学へ修復。全56cells一致・再入SQL0・原本/PRE/POST全文保管。[実績](issuer646-actual-20261002.md) |
| 優待2307/2001/3189/6577 | 旧HOLD14行の制度/行生成を修復。実POST467cells一致・再入SQL0・全原本保管。選択/寄付/抽選の金額NULLを保持。[実績](yutai-hold14-actual-20261002.md) |
| 株式10/1 | 以前の3634/3689成功・55失敗は未修復。原文保管修正後の通常入口はN225終値nullで停止、個別株/D1/R2書込0。[実受入](stock-normal-acceptance-20261002.md)。PR263で再試行期限と回収中の取得停止を修正し、[後続N225 caller1回](n225-once-20261002.md)はHTTP200・10/2実終値資格PASS。全量成功・55件の新原文分類は未確認で、真正Cron受入を待つ |
| VWAP | 通常入口の全795応答/27partsとsummaryを全文照合。769保存後にYahoo認証429で停止、5分足未起動。[実受入](vwap-normal-acceptance-20261002.md)。株式/VWAP共通PR263は3CI成功・main `0fe0a71`へmerge済み。19:12UTC頃にrootがCloudflare UIでBuild SUCCESS・version `eb298192`・本番traffic100%を確認。新source GET0で、Yahoo制限解除・通常全量日足/5分足成功は未確認。Cloudflare Paid不足と混同しない |
| 信用残 | 旧週次PDFを同SHA/4230行で再解析し、既存定時日次成功の9/30 PDF/4260行とR2全文一致を確認。[実績](vwap-margin-weekly-readback-20261002.md)。既存7認証設定を接続した[通常業種集計run](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36908547972)は18:48:43UTCに成功、入力2添付の独立全文照合と476件再解析も19:04:54–57UTCにPASS。Producerの全476POST照合成功とは別の証拠。保存済み9/30入力の新実績であり、旧9/28 UNKNOWNの再送・解決や全moneyflow/sector-turnover正常化とは扱わない |
| 海外売上 | S100YJVF1通の4連結区分差は[実照合済み](overseas-pilot-actual-20261002.md)。後続固定15通の[修正前原本検証9資格/57明細・HOLD6](overseas-next15-custody-20261002.md)を保持し、PR266の統合全文解析で13資格/84明細・HOLD2へ更新。実反映は9APPLIED/4MATCH、全13文書16列・84明細12列・変更9銘柄の集計32列・同文書再入sender0・PRE/POST実体と全SHAの独立照合がPASS。[本番実績](overseas-qualified13-actual-20261002.md)。HOLD2と旧3611全体は未完 |
| 8508 | PR258で単発日を別列へ保持し年間利回り/定常月から分離。実1件の9/2日付修復、全97cells一致・再入SQL0・通常6月4件保持・全原本/PRE/POST保管と本番UI確認を完了。[実績](yutai-oneoff-actual-20261002.md) |
| 課金切れ25銘柄 | 保存済み本文と既存語彙の機械照合で全25件の補完・独立再読・次回skipを確認済み。PRE/POST物理保管・全SHA一致、TypeSafe/追加原本取得0。[実績](biztag-existing25-actual-20261002.md)。現在の新規初回限定設定を維持し、credit補充は不要 |
| 定時起動PR195 | 3CI成功・merge・本番100%配信・4 Cron登録・repo限定Secret継続を確認。[設定受入](stock-scheduler-production-20261002.md)。真正dispatch/receipt/期限readcheckは10/3 JST予定時刻待ち |
| 配当・分割 #272 | 保存/API契約をPR274で修正し、保存済み1333のイベント補完・PRE/POST保管・独立本番再読を完了。[実績](yahoo-event1333-actual-20261002.md)。全銘柄バックフィル・5分足再資格化は本受入の対象外 |
| 622A/海外未資格/信用残UNKNOWN/JPX新様式 | [公式根拠・再開条件](data-remaining-investigation-20261001.md)を維持。公表前の実ファイルや過去POST結果を作らない |

## コストの判断

認証済みCloudflareの現請求期間ではWorkers requests/CPU、D1 read/write/保存、
R2 A/B/Standard保存、Builds、直近30日Logsが包含枠内。Workers Paidと既存Notion Plusを
確認し、この対応のための上位プラン購入は不要と判断した。アカウントの他製品使用量を
kabulabへ帰属させたり、全額$5/月と断定したりしない。
[費用確認](../cost-audit-2026-10-01.md)に公式価格、負荷計算、保管の追加時間を残した。

新規購入、CPU上限引下げ、Logs sampling削減、Notion契約変更は行っていない。
