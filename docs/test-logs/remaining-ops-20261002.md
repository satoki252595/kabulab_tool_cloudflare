# 残件の本番確認と費用 — 2026-10-02

Refs #98 #117 #132 #146 #163 #196。公開Gitには集計・SHA・実行リンクだけを保存する。
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

## 限定修復と残件

| 対象 | 10/2の確認済み状態 |
| --- | --- |
| 646A | 最新FSA原本→通常資格判定でsector33を化学へ修復。全56cells一致・再入SQL0・原本/PRE/POST全文保管。[実績](issuer646-actual-20261002.md) |
| 優待2307/2001/3189/6577 | 旧HOLD14行の制度/行生成を修復。実POST467cells一致・再入SQL0・全原本保管。選択/寄付/抽選の金額NULLを保持。[実績](yutai-hold14-actual-20261002.md) |
| 株式10/1 | 通常runは3634/3689成功、55失敗。55は現在active equity、将来廃止を前倒ししない。原本欠落の修正後に受入確認が必要 |
| 8508 | 実DBの既存record_monthは6。公式9/2単発の基準日を毎年の月末扱いへ一般化するモデル欠陥を修正中。受領期間が継続しているため終了扱いで削除しない |
| 課金切れ25銘柄 | 通知欠落をPR255で修正。補充未実施。最低top-up $5と25件の推論費概算上限約$0.069（最大retry仮定約$0.276）は別。10/3以後なら現retry条件のまま限定再開可能 |
| 定時起動PR195 | 3CI成功・レビュー済み。WorkerのGITHUB_ACTIONS_TOKENが未設定のため未merge。既存cronを消すだけの状態へ移行しない |
| 622A/海外未資格/信用残UNKNOWN/JPX新様式 | [公式根拠・再開条件](data-remaining-investigation-20261001.md)を維持。公表前の実ファイルや過去POST結果を作らない |

## コストの判断

認証済みCloudflareの現請求期間ではWorkers requests/CPU、D1 read/write/保存、
R2 A/B/Standard保存、Builds、直近30日Logsが包含枠内。Workers Paidと既存Notion Plusを
確認し、この対応のための上位プラン購入は不要と判断した。アカウントの他製品使用量を
kabulabへ帰属させたり、全額$5/月と断定したりしない。
[費用確認](../cost-audit-2026-10-01.md)に公式価格、負荷計算、保管の追加時間を残した。

新規購入、CPU上限引下げ、Logs sampling削減、Notion契約変更は行っていない。
