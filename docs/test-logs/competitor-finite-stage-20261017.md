# 競合準備の有限Mac stage（2026-10-17）

Issue #348。通常モデル0準備CLI（#440）の後段接続。mainへのコード反映とMac runtime配備・本番入力受入は分ける。
この変更の新規live Notion/取得元HTTP/モデル/業務書込/runtime配備は0。

## 実行と停止

- 任意の型付き`.env`キー`BIZTAG_COMPETITOR_PREPARE_CODES`で固定1〜100社を明示した場合だけ、既存20時biztag正常終了後に第二CLI childを起動する。未設定はstage停止。
- 正常CLIの同じ`--prepare-only --judge=semif`を使い、Notion0.3rps・新規読取6分・child最大7分を固定。モデル/TypeSafe/key/競合/schema変更は0。
- startup receipt待機を含む開始から30分の残時間で既存timerを設定する。開始22分以降はstageを新規起動せず、stage終了後のreceiptへ1分を予約する。20/21時calendar・既存readcheck期限は変えない。
- 同じ補足/本文/原本/公開契約を持つ通常CLIがkernel writerを保有する。追加LaunchAgent・scheduler・GH writerの再開はない。

固定scopeをコード順に最大5件ずつ処理する。after-codeは正常終了と全物理確認後だけ前進し、
末尾の次に先頭へ巡回する。input変更を次巡回で再照合し、同じ先頭5件のarchive-skipを繰り返さない。
83社の一巡には最低17回を要する。局所回復をこの夜次巡回の完了と取り違えない。

child起動前の`stage-pending.json`は固定scope・旧cursor SHA・選出コード順へ束縛する。
未知の前stageがあれば、新しいinput SHAでも新stageを起動しない。CLI内のSHA別archive markerだけに依存しない。
pendingを削除して再送する運用は禁止する。unknownは既存archive/CLI receiptと照合するまで停止する。

正常終了時はsummary/物理receipt、gzip全SHA、解凍本文SHA=input SHA、manifest target順・各status・
一意HOLDとsummaryを照合し、今回のCLI開始/終了時計をpendingへ束縛する。closure→cursor原子的更新→
pending除去の順で閉じる。途中killでpendingが残る場合は安全側に停止する。
HOLDは保存した入力の保留として残し、競合なし/旧意味判定の検証済みへ読み替えない。
同input再使用時の最初の物理確認時計と、今回CLI物理照合後の終了時計を分けて残す。

## 通信0回帰

保存済み実2社full39 fixtureは#440と同じ111KBの投影を再利用し、新fixture/架空財務値/確率を加えていない。
cursor対象は保存A33の先頭7コード（crosscheck SHA
`aa8383ef16ca4a94863f10eae9c6e1a1be7131630424c1332390e92bf8d9e310`）。
ACK/child/receiptはprotocol置換であり、外部原本を保管/照合した証跡ではない。

- first5→next2→末尾wrap、HOLD保持、scope変更/旧ACK再使用STOP。
- gzip本文SHA・対象順・重複HOLD・status・物理確認・旧実行時計・期限不一致でcursor0/pending保持。
- 10分startup receipt後は20分でchild停止し、全体30分を延ばさない。startup30/31分ならchild0。
- 第二child7分SIGTERM後はpendingが残り、次runの第一biztag終了後もprepare childを再起動しない。
- 既存20/21時job、kernel writer、Linux writer停止の回帰も維持。
- #440と同じ保存実2社の通常prepare出力/gzip/物理receiptをstage ACKへ直接渡し、全39入力の正例でもclosure/cursor前進を確認した（transport/物理ACKは置換、live0）。

ローカルはNix/Node22/frozen依存で対象3 suites / 28 checks、全型検査、対象lintが成功した。mergeはexact CIの確認後とし、
Mac runtimeのrollforwardは既存writer終了後に別受入する。

## 条件コストと未受入

保存3689 profile/3712行の5社条件は44 Notion読取＋D1 4回、0.3rps spacingだけで143.33秒、
候補CPU21.073秒、maxRSS2,686,528KiB（約2.56GiB、約3GB）だった。2分stageは不成立なので採用しない。
この事実は[通常準備の記録](competitor-mechanical-prepare-20261017.md)の保存入力計算であり、現在corpusのlive測定ではない。

現在全39のgzip量/通信・原本保管/再試行・親processの全gzip解凍検証/電力費用は未測定。
子の7分timerと書込前deadlineで予算超過をSTOPにするが、7分内の物理完了や全件完走は保証しない。
Notion0.3rpsはこのchildの実native枠であり、他ワークフローを含む全体上限を保証するbrokerではない。
runtime/source/model live受入前に、共存writer・現corpus/full39・実archive/終了receiptを確認する。
