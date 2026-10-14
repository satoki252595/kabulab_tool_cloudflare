# RAW単一索引reconcileの転送・期限制限

原証跡は2026-10-14 UTC、修正検証は2026-10-15 JST。通常apply/inspectの対象集合・cursor・継続仕様は変更せず、既存の明示manual `reconcileRawIndex` の読取だけを制限する。索引は従来の単発plain unique INSERT、旧active/stateは全bytes＋ETag照合を維持し、旧unknownを消さない。

本番inspect38582945803（main401）で、固定manifest78,832件／cutoff `2026-10-13T18:31:00.000Z` のcursor5389が `index_inflight` と確認された。当該原本の全文SHA一致・D1索引欠測・resolution intent/complete欠測、直前5388の原本／索引全列一致を確認済み。inspectは読取12req／R2 31,720,908B／6.560秒、書込0。元のreceipt_inflightで失敗したpayloadやACKは未観測のまま保持する。

旧manual経路はmanifest GETに `R2ReadOptions` を渡さず、`transformToByteArray()` の無制限読取となっていた。`maxBytes` は単一rawのサイズだけに使われ、31,579,382Bのmanifestやreceiptには適用されなかった。共有R2 helper自体に20MiBの既定値はない。今回もmanifestを20MiBへ切り詰めず、明示64MiB以内で1回全文照合する。

変更後はmanualだけ最大64MiB／600秒、R2 GETを最大14回とし、全GETに `singleAttempt/maxBytes/absolute abortSignal/beforeAttempt/onRead` を渡す。各送信開始前は65秒の残時間を要求する。R2全GET＋resolution receipt PUTを合算し、PUTとその全文readbackのbytesを送信前に確保する。中断時は取得できた元prefixを最大16KiBまで私有receiptへ保存してSTOPする。D1は既存60秒制限付き2SELECT／1INSERTで、D1応答bytesはこのR2計数に含まず未計測と明示する。

64MiBは観測できたR2オブジェクト本文＋receipt PUT本文の計数であり、HTTP headersやSDK例外応答本文を含む全wire量ではない。共有S3 helperは明示NoSuchKey/404をnullとして返すため、そのエラー応答本文も未計測である。結果に `sdkErrorResponseBytesMeasured:false` を明示し、reconcileのSDK例外はname/message/stack/$metadataを最大16KiBまで私有receiptの `reconcile_error_private` へ保存する。公開consoleは既存のhashと秘匿済み構造のみとし、元例外JSONをHTTP本文そのものとは呼ばない。

正常フローの固定上限は次のとおり。

| 操作 | 回数 |
|---|---:|
| active/state初回GET | 2 |
| manifest全文GET | 1 |
| resolution intent/complete存在確認GET | 2 |
| raw全文GET | 1 |
| active/state同値確認GET（3組） | 6 |
| resolution intent/complete全文readback GET | 2 |
| resolution intent/complete CAS PUT | 2 |
| D1索引SELECT／plain unique INSERT | 2／1 |
| HTTP合計 | 19 |

raw PUT、Notion取得・書込、外部source API、モデル呼出し、旧state書換え、unknown自動clear、manualからのcontinuationは0。INSERT後のunknownはintentを残してSTOPし、同操作を再送しない。正常manual完了後もcursor5389と旧index_inflightを保持し、別承認された通常resumeが原本全文＋索引全列を再確認してcursorを進める。

回帰は既存manual成功／CAS競合／INSERT結果不明／intent結果不明を維持し、14GET・19HTTP・全R2実bytes合算、manifest予約>20MiB、manifest転送予算超過のmutation0、本文中断prefix保全、65秒headroom不足の送信0、設定上限超過の最初のGET0を検証する。共有R2 bounded stream回帰も同時実行する。

本変更の検証はローカルNix環境のみ。本番reconcile/resumeのdispatchは別rootレビュー・main受入・実値再照合後とし、この変更やinspect成功を本番回復完了には扱わない。元200run枠は既存191再開の実消費3＋新inspect1を計上して未使用187、manual1を追加すると186。resume自身を含む最大186runなので `continue_runs=185` が上限となる。追加dry/inspect/失敗/dispatch結果不明も1ずつこの残数から減算し、200へ戻さない。実行時には新規childや別dispatchが無いことを別途確認する。

検証結果: Nix node22.22.2／既存pnpm9.15.9と同lock依存で4suite130tests、全体`tsc --noEmit`、変更2code/testのeslint、`git diff --check`がPASS。raw-backfill70testsには既存のunknown/CAS/inspect制約を含む。追加依存・新source取得・本番API呼出し・dispatch・書込みは0。

診断の追加確認は実CLIと既存SDKを用いたprotocol fault3ケース（inspect／reconcileの短例外、reconcileの長stack）で実施。SDK送信関数で各1回だけ例外を発生させ、native送信前に止めた。元name/message/stack/$metadataの私有保存、長例外の16KiB prefix・complete=false、公開consoleの秘密値漏れ0、元の停止phase保持を確認した。これは実本番エラー本文を取得した証拠ではない。
