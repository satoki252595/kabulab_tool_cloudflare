# VWAP非同期CLIの終了境界

## 保存済み定時runの実範囲

run `36730312678` は `1e81a10effd50160f21c186c08c6da95ea31cf84` で実行され、2026-09-30T16:37:32Zにjob SUCCESS。ただし日足・5分足とも連続429/503のABORTを記録し、最後のworkflow表示は `daily_exit=0 intra_exit=0`。margin/backfillはskipped。

日足は範囲内欠落4件・範囲外fresh1件のエラー行を記録。5分足は全行欠落1件、最後の進捗は3000/3695、written2962/errors1/rateLimited5。進捗は途中値であり最終計数ではない。両方の最終計数・local summary・recording/recorded行は0件。ジョブ成功を3695件完了や物理保管成功とは扱わない。429/503の一時性と未解決操作の個別原因は未確定。

全文ログは私有保存（37483 bytes）、SHA256 `f44091429ef497bb4f46eaf73edb34339a56bb6e147ed42daf46efcca61cd3ec`。job metadata SHA256 `b8148f949b7f655bcd15da241b965dca09b8836c99a63c3fe2da477506475ba6`。初回保存は新規0700ディレクトリ内の0600リダイレクトで、その後同一bytesをexclusive-create/fsyncのsealedファイルへ保存。原ログはGitへ追加しない。追加source/R2/consumer/dispatch実行0。

## 恒常的な終了契約の修正

daily/intra/marginのCLIは従来 `main().catch(...)` で起動し、daily/intraはpoolとsummaryの完了後に初めてexitCodeを設定していた。Nodeは未解決Promiseだけでは稼働を維持しないため、未完了のままexit0になり得る。全3入口を初期exit2・top-level awaitにし、完了時のみ正常/partial出口へ進める。marginの正常完了は0、予期しない失敗は2。

共有mapLimitは各workerをPromise.allで待ち、ABORT後のcallback returnは残りを正常にdrainする。pool自体のsettlement欠陥は静読・回帰で確認されず変更しない。既に開始したsource/R2 Promiseの個別未解決原因をこのログだけから断定しない。

workflowは0（正常完了）と1（集計済みpartial）以外をfatalとして後続intraを停止する。Nodeの未解決top-level await出口13も成功やpartialとして流さない。再試行・再dispatch・新しい取得経路は追加しない。

実CLIブロックを別Nodeプロセスで検証し、未解決・reject・正常完了・partial/fatal維持、ABORT後のsettled poolと未解決inflightを確認。既存workflow実ブロックの実行検査にも出口13を追加。
