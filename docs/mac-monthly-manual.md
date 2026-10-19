# Mac専用処理の月次手動実行

2026-10-20のユーザー指定。MacのLaunchAgentは廃止したまま、月1回の案内からコマンドを手動実行する。Macを常時起動・ログインしておく必要はない。Cloudflare／Actionsの通常定期は継続する。

月次の機械取得は毎月10日10:30 JSTに母集団→優待原文→スコア再計算の順で動くため、案内の推奨日は翌11日09:00 JST。メールの繰り返し配信方式は別に設定受入する。スクリプト準備をメール予約済みと扱わない。

## 実行対象と保存境界

| 順序 | 処理 | 範囲・LLM |
|---|---|---|
| 1 | 補足DBの基本情報・39本文・事業タグ | 既存biztag通常CLI。20分の有限処理。適格新規/実入力変更だけ既存Clef、同入力判定は再利用 |
| 2 | 競合入力の機械準備 | 既存envで固定scopeが設定された場合だけ最大5社。意味判定/モデル実行はなし |
| 3 | 優待の機械要約・条件/金額検証・保存 | 既存CLIで最大60群。--allow-modelは使わず、未対応は保留 |

受入済みruntimeとそのprivate.envを明示指定し、既存のcanonical state・writer lock・原本・未完intentを再利用する。新規install/enable/bootstrap、モデル取得、別モデルへの置換、自動再試行は行わない。

日次launcherを呼ばず、月次手動実行を過去20/21時の成功receiptへ書き換えない。旧日次receiptの定期監視は廃止する。月次手動の未実行・残件は日次の成功に読み替えない。

各処理が失敗したら後続を止める。保存結果不明・pendingがあれば削除や出力先変更で回避せず、原本と実結果を照合する。有限窓なので1回で全社・全優待が完了する保証はなく、終了summaryのHOLD・remaining・not-startedを確認する。

## コマンド

```sh
cd /Users/satoki252595/projects/kabulab-cf
nix develop --offline --no-write-lock-file --command env -u NODE_PATH pnpm biztag:monthly --runtime .runtime/mac-main554-20261020 --preflight
```

preflightが成功した場合だけ実行する。出力には原本・判定の診断が含まれるためprivateログへ保存する。

```sh
umask 077
monthly_log="tmp/biztag-local/monthly-$(date +%Y%m%dT%H%M%S)-$$.log"
nix develop --offline --no-write-lock-file --command env -u NODE_PATH pnpm biztag:monthly --runtime .runtime/mac-main554-20261020 >"$monthly_log" 2>&1
```

初期の受入runtimeは`4cb4867d9a9f189684b07efa89be81a085e03f51`。通常CLI・モデル・private.envの版は固定したまま使う。root側の月次driverはCIが通ったmainから実行する。ログを確認する際もファイル全体を公開しない。

runtimeのHEAD・acceptedRevision・main包含・clean・env権限・Nix依存をpreflightで確認する。受入済みruntimeを勝手にpull/resetせず、変更時はCI確認と未完状態保全を先に行う。実行ログはprivateな既存stateへ保存し、本文・判断入力・秘密値をメールやGitへ貼らない。

## 月次案内メールの原稿

件名: kabulab-cf 月次手動メンテナンス

月次の母集団・優待原文・スコア取得後に、Mac専用処理を手動で実行してください。上のpreflight→runコマンドを使用します。Macの自動起動は無効のままです。実行後はログ末尾の終了状態・残件を確認し、失敗/結果不明ならそのまま停止してください。

全データ機能と自動/手動/停止/未実装の内訳は[全件一覧](batch-data-inventory.md)。月次メールの受信・実処理成功は、それぞれ設定と別に検証する。
