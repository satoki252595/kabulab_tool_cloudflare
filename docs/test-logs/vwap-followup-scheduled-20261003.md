# VWAP後続定時runの読取確認（2026-10-03 JST）

既存の769銘柄保存を記録したrun36903916350より後の定時run2件を確認した。成功したrunは信用残高だけで、日足・5分足の全量成功ではない。後続の日足runも初回429/503のgateで停止し、5分足は未起動。以下の時刻はUTC。

## 対象と実計数

両runのheadは `4440e782238f4f0946935fedf94c9c1d5855adad`、eventはschedule。

| run | job実時間 | 結果と対象 |
| --- | --- | --- |
| [37018669823](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37018669823) | 10/2 14:16:17〜14:16:46 | SUCCESS。margin stepだけ14:16:30〜14:16:42に成功。daily/intraはSKIP。成功log・保存日・PDF内容・更新件数は本読取の対象外。 |
| [37019817917](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37019817917) | 10/2 14:26:00〜14:43:02 | FAILURE。daily+intra stepは14:26:11〜14:42:55。daily_exit=2/intra_exit=not-run。marginはSKIP。 |

後者のfinal log（14:42:53.114 UTC）は codes3689 / written510 / skipped0 / empty0 / errors0 / invalid0 / rateLimited1 / backfilled511 / abortedtrue / fatalfalse / unknown0 / rejected0。

14:42:50.883 UTCに `consecutive=1` の429/503 gateで新規取得を停止した。`backfilled` は取得呼出しの試行数で、保存数ではない。このrunでは511試行・510保存・rateLimited1、未試行3178という計数になる。ログだけからproxy内の総Yahoo HTTP数、429と503のどちらの原応答か、credentialとChartのどの段階か、元Retry-Afterを確定しない。

日足raw custodyは18stages/18pages、raw計70676060bytes/gzip計25316292bytesの完了記載がある。最後のstageのrawは83bytes。finalsummaryは14:42:53.118に私有ローカル保存後、14:42:55.111にrecordedと記録された。失敗summary artifactは32055bytesでupload成功、失敗通知stepもSUCCESS。新たなNotion添付やR2全510件の独立再取得・全文照合は本調査で実施していないため、ログの保存計数と独立した原文受入を区別する。

## 旧集計との差分と限界

旧runのwritten769/notStarted2898は当時の停止runの履歴として保持する。今回のwritten510は同じ銘柄の更新を含み得るため、769＋510をユニーク保存数にしない。両runの銘柄別集合・現在のR2全体を再読していないため、新規カバレッジ増分と現在の未完件数はUNKNOWN。今回の結果からYahoo制限の全面解除、全銘柄の正常化、5分足完走、同じ入力での再入0を主張しない。

## 読取証跡

2runのmetadata/jobsは `gh run view --json` の投影を私有0600に保存。後者の既知failed job logだけを `gh api` 1callerでdownloadし、0600・fsync保存した。成功runのlog・新しいYahoo/EDINET原本・Notion/D1/R2・model・dispatch/rerunへの追加アクセス/書込は0。GitHub CLI内部のHTTP/redirect数は別途計測していない。

failed logは33036bytes、SHA256 `5c60af0ac9354808516595473a74bcffa72178cddc98fc5c125cc40b6e94b02b`。download時計は10/2 17:32:03.347〜17:32:04.671 UTCで、実runや市場原本の取得時計へ代用しない。metadata投影のSHA256は成功run `c24ccc28f96e9c94792fe003229bb1c7e9c4cc0a35650f114239fec96f971f0b`、失敗run `fb97f49f65cfcf77e6141e592e7fb9c06b4b78329fa71d5285e6293e35635dd1`。

後続の10/2 18:08:50 UTCに、この調査のmetadata/log/読取記録6filesを運用一次記録25membersへ含め、共有Notionへ物理保管した。添付24741bytes、SHA256 `32e3e314f30ad27e3785b059f6170ea5c623115ed0afb049a1edef40239a4c93`。実Notion8/hosted1の全9HTTP・全25memberのbytes/SHAをrootが独立照合した。市場raw custodyのNotion添付とR2全510件の独立受入は、引き続き本調査の範囲外。[運用証跡の保管](remaining-ops-20261002.md)。
