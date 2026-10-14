# VWAP原本照合後のR2保存を最大2件に限定 (2026-10-15)

## 根拠と変更

保存run `38547185176.1` の日足は、最後の26銘柄の原本物理照合が `2026-10-14T14:22:59.310428Z` に完了し、26件すべてwrittenとなったsummary時計が `14:23:17.747Z` だった。残り18.44秒のコード経路は保管後の直列R2保存である。この一batchは待ち時間の存在を示すが、全体の平均や節約時間の実測としては用いない。

日足/5分足の既存 `mapLimit(writes, CONC)` は、vendor取得のCONC=1をR2保存にも使っていた。原本batch全件の物理照合が成功した後の、異なる銘柄keyへのR2 PUTだけを `mapLimit(writes, 2)` にする。新しい設定・factory・依存ライブラリは追加しない。source取得、最大30銘柄/8MiBの保管単位、既存CAS、23:30の新規開始拒否、価格registryの直列4CASは維持する。

unknown/rejected/期限検査の失敗を知ったら新しいwriteを停止する。既に開始した最大2件は取消成功とみなさずsettleを待ち、成功・unknown・rejected・未送信を全件summaryへ記録する。失敗の判明前に始まった別銘柄のACKも保持する。後続batchのvendor取得と同じkeyの再送は行わない。

remote要求の件数・body bytes・source頻度・vendor並列数は増えない。R2の同時inflightだけ最大1から2へ変わる。実時間短縮、同時PUT時の実latency、全量所要、共有Yahoo lockの全ジョブが窓内に収まることは未計測である。株式・資金フロー・途中429停止したVWAPの別runを足した概算は、全量完走の根拠にしない。

## 検証範囲

通常mainを通す機構回帰で、vendor最大1/保管前PUT0/R2最大2/異なるkey/成功時のslot再利用、unknown・412拒否・23:30ちょうどのSTOP後の新規write0、開始済みのsettle、31銘柄目のsource0、全件outcomeとsummary保全を確認する。価格registryは専用既存suiteで直列CAS/unknown保全を検査する。

保存済み本物の原本6件もローカルで純再生する。日足は固定 `37202207552.1`/10月2日sessionの1301・6758・7203の10y原本、5分足は保存 `38437920118.1` の5957・5958・5959の60d原本を使う。gzip全SHA→member全SHA/bytes→実parserを通し、元の価格・split・proof・取得時計を変えず、mock R2の最大2inflightと全payloadを照合する。日足の独立市場sessionは既存テストseamであり、この回帰でN225の資格を新たに主張しない。実rawは私有保存のままでGitへ追加しない。

私有fixtureの `/tmp/kabulab-vwap-put2-replay/{daily,intra}.json` が無いCIでは当2件を明示skipし、上記の機構回帰は常時実行する。本番source/Notion/D1/R2/model/dispatch/deployはこの実装検証で0。

Nixの関連5suiteは140 PASS / 既存3 skip。上記保存6原本を用いる2件はローカルで実行されてPASSした。`tsc --noEmit`、変更TS4ファイルのeslint、`git diff --check`もPASS。実remoteへのPUT2の所要短縮はこの検証には含まれない。
