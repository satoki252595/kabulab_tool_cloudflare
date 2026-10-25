# Mac専用処理の月次手動実行

2026-10-20のユーザー指定。MacのLaunchAgentは廃止したまま、月1回の案内からコマンドを手動実行する。Macを常時起動・ログインしておく必要はない。Cloudflare／Actionsの通常定期は継続する。

月次の機械取得は毎月10日10:30 JSTに母集団→優待原文→スコア再計算の順で動く。案内は2026-11-11開始、毎月11日09:00 JST（Asia/Tokyo）のGoogle Calendar予定と開始0分前のメール通知を設定し、読戻し確認した。非公開・予定ありにしない15分枠の説明欄には、短い起動/事前検査/本実行コマンド5行と、privateログ保存の本手順への参照を保存した。日時・繰返し・通知等も変更なしを読戻し済み。初回メール受信・月次の本モデル実行は未観測。

## 実行対象と保存境界

| 順序 | 処理 | 範囲・LLM |
|---|---|---|
| 1 | 事業タグの意味判定（必要な本文資格確認を含む） | 既存biztag通常CLI。20分の有限処理。適格新規/実入力変更だけ既存Clef、同入力判定は再利用 |
| 2 | 競合入力の機械準備 | 既存envで固定scopeが設定された場合だけ最大5社。意味判定/モデル実行はなし |

本文39・基本補足・優待機械要約は[独立Linux定期](mechanical-publishing.md)へ分離する。月次driverは優待stageを実行しない。

受入済みruntimeとそのprivate.envを明示指定し、既存のcanonical state・writer lock・原本・未完intentを再利用する。新規install/enable/bootstrap、モデル取得、別モデルへの置換、自動再試行は行わない。

日次launcherを呼ばず、月次手動実行を過去20/21時の成功receiptへ書き換えない。旧日次receiptの定期監視は廃止する。月次手動の未実行・残件は日次の成功に読み替えない。

各処理が失敗したら後続を止める。保存結果不明・pendingがあれば削除や出力先変更で回避せず、原本と実結果を照合する。有限窓なので1回で全社・全優待が完了する保証はなく、終了summaryのHOLD・remaining・not-startedを確認する。

## コマンド

```sh
cd /Users/satoki252595/projects/kabulab-cf
nix develop --offline --no-write-lock-file --command env -u NODE_PATH pnpm biztag:monthly --runtime .runtime/mac-publishing-20261025 --preflight
```

preflightが成功した場合だけ実行する。出力には原本・判定の診断が含まれるためprivateログへ保存する。

```sh
umask 077
monthly_log="tmp/biztag-local/monthly-$(date +%Y%m%dT%H%M%S)-$$.log"
nix develop --offline --no-write-lock-file --command env -u NODE_PATH pnpm biztag:monthly --runtime .runtime/mac-publishing-20261025 >"$monthly_log" 2>&1
```

上記runtimeは`45629c8`で受入済み。[初回移行](mechanical-publishing.md)でcanonical state・原本・旧journalを保全し、acceptedRevision一致と旧runtimeの版不一致停止、新runtimeの月次preflightを確認した。Calendarもこのruntimeへ更新済み。これは本モデルの実行成功とは別である。root側の月次driverはCIが通ったmainから実行する。ログを確認する際もファイル全体を公開しない。

runtimeのHEAD・acceptedRevision・main包含・clean・env権限・Nix依存をpreflightで確認する。受入済みruntimeを勝手にpull/resetせず、変更時はCI確認と未完状態保全を先に行う。実行ログはprivateな既存stateへ保存し、本文・判断入力・秘密値をメールやGitへ貼らない。

優待要約の現main契約は`2026-10-25.1`です。上記pin済みruntimeは旧契約・既存protocolのままで、今回の更新は遡及しません。新契約の実行は別途runtime受入後に現在行からtaskを選定し直し、旧版結果は取り込まず保全します。初期移行・owner・pending・共有baselineの更新/解除を伴いません。

## 月次案内メールの原稿

件名: kabulab-cf 月次手動メンテナンス

月次の母集団・優待原文・スコア取得後に、Mac専用処理を手動で実行してください。上のpreflight→runコマンドを使用します。Macの自動起動は無効のままです。実行後はログ末尾の終了状態・残件を確認し、失敗/結果不明ならそのまま停止してください。

全データ機能と自動/手動/停止/未実装の内訳は[全件一覧](batch-data-inventory.md)。月次メールの受信・実処理成功は、それぞれ設定と別に検証する。
