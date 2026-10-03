# 事業タグ・優待要約のMac定時運用

更新: 2026-10-04。事業タグの唯一の定時writerをApple Silicon Macへ移す。
新規銘柄の初回だけSemIf/MLXを使い、既存の保存タグを再利用し、旧失敗・不足は
従来のkeywords/excludes一致で補完する。TypeSafeへの自動代替、語彙審査、
goldenの定期実行、競合判定は再開しない。

## 起動経路

`com.kabulab-cf.biztag` LaunchAgentが毎日Macの現地時刻20:00に起動する。
このMacはAsia/Tokyo。ログイン時の`RunAtLoad`も同じ入口を通る。
優待要約は別label `com.kabulab-cf.yutai-summary`で毎日21:00に同じ入口の
`run yutai-summary`を実行する。原文変更・未要約・契約違反の最大60群を既存固定モデルで処理し、
新しい有料APIは使わない。`tmp/yutai-local`にprivate進捗・原本・送信中記録を残す。
実行コードはCIを確認してmainへmergeした専用runtime worktreeに固定し、
自動pull/resetや未レビューのPR実行はしない。

```text
LaunchAgent → nix develop --offline → scripts/biztag-local/main.ts run
  → biztag CLI → withBiztagWriter → runBiztag → eligible新規だけlazy SemIf
```

Linuxの`catchup.yml`はEDINET/TDnetを継続し、biztagの定期writerを起動しない。
手動`target=biztag/all`のbiztag部分と、`backfill.yml`の全biztag系は
checkout/一次データ取得前に明示停止する。MacのwriterへGitHubからジョブを
転送する仕組みも設けない。株価/macroeconomicsのCloudflare 4 Cronは別の経路であり、
この設定では変更しない。

## 受入と設定

1. SemIf新規初回・実較正とruntime設定の両変更をmainへmergeし、runtime worktreeをそのSHAで用意する。
2. 既存のprivate `.env`へのsymlinkをruntimeに置く。実体は実行ユーザー所有の
   通常ファイル・0600であること。`BIZTAG_LOCAL_ACCEPTED_REVISION`をruntimeの
   完全SHA、`BIZTAG_NEW_LISTING_FROM`を対象開始日、`SEMIF_PYTHON`をNixで用意した
   既存SemIf interpreterに設定する。秘密値をコマンド引数・ログ・Gitへ出さない。
3. runtimeで`nix develop --command pnpm install --frozen-lockfile`を実行し、
   Nix shell/model cacheを準備する。定時起動は`--offline`でNix環境を使う。
4. 以下のpreflight/installは外部取得・事業タグ保存をしない。

```bash
nix develop --command pnpm exec tsx scripts/biztag-local/main.ts preflight
nix develop --command pnpm exec tsx scripts/biztag-local/main.ts install
# 優待要約も同じ承認SHAのruntimeから作成する（このコマンドでは実処理しない）。
nix develop --command pnpm exec tsx scripts/biztag-local/main.ts install yutai-summary
```

`install`はplist作成・構文検証まで。既存plistを黙って上書きしない。
bootstrap直前にGitHubの旧catchup/backfillのqueued/in_progressが無いこと、
共有Notion writerが空いていることを確認する。

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.kabulab-cf.biztag.plist"
launchctl print "gui/$(id -u)/com.kabulab-cf.biztag"
```

bootstrapは`RunAtLoad`の実処理を起動する。設定が存在することだけで完了にしない。
終了status・同じSHAの私有receipt・Notionの保存後確認を受入として残す。
新規対象0ならSemIfモデルのspawnは0。Macが停止/ログアウトしていた時刻の
実行を、実行済みの予定時刻へ置換しない。
[AppleのLaunchAgent仕様](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
ではスリープ中のcalendar起動は復帰時にまとめられ、電源OFF中の予定は失われる。

## 排他と停止時の扱い

手動の`biztag run`・台帳writer・優待要約も同じ`withBiztagWriter`を通す。
private `.env`の実体を基点に`tmp/biztag-local/writer.lock`を共有するため、
同じサービスの別worktreeから実行しても同じkernel排他になる。
lockfileを削除/差替えず、所有するNodeのFDを全処理が終わるまで保持する。

Nix Python3.12の標準`fcntl.flock(LOCK_EX | LOCK_NB)`で取得する。
Python子はNodeのFDと同じopen file descriptionを共有し、明示`LOCK_UN`を
しない。子が終了/killされても、Node本体が終わるまでロックが残る。
[Apple flock仕様](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html)、
[Python標準fcntl](https://docs.python.org/3/library/fcntl.html#fcntl.flock)。

kernelがbusyなら取得・モデル・保存を開始しない。ファイルが残っているだけでは
runningと判定しない。Node終端でkernel handleが解放され、次の実行は保存済み結果を
確認して再開する。ownerの実PID/開始identityと旧handle終了は私有診断として残す。
優待の適用・POST原本照合が未完なら`pending-write.json`を保持し、翌日の自動再送を止める。
月次Actionsの原文取込は10:30 JST、要約は21:00で通常時刻を分ける。手動で両処理を同時に始めない。
取得通知が不正/不明ならfailし、保存を始めない。同run再試行とKeepAliveは無い。

runtime HEADが承認SHAと不一致、SemIf専用較正modelが不一致/未配置、追跡対象がdirty、承認SHAが取得済みorigin/mainの
祖先でない、private `.env`の権限が広い、Apple Silicon/Nixが不足する場合も早期停止。
モデル不適合や本文資格不足は元のHOLD/判定不能を維持する。

停止は`launchctl bootout "gui/$(id -u)/com.kabulab-cf.biztag"`。
更新時は停止と実PID終端を確認し、CI/main受入後の新runtimeとSHAへ切り替え、
preflight→plist確認→bootstrapを行う。広い`gh` OAuthはWorkerや外部HTTPへ渡さない。
本体ログ・clock/exit receiptはprivate `tmp/biztag-local/`、0600で残す。

## 選択理由と実証範囲

調査時点でrepoにself-hosted runnerは0。pinされたnixpkgs25.11の
`github-runner`はaarch64-darwinでavailable=true、version2.334.0。
[公式最新release](https://github.com/actions/runner/releases/tag/v2.337.0)は
2.337.0でosx-arm64を提供するため、Darwin自体が不可ではない。
ただし[GitHub公式のセキュリティ指針](https://docs.github.com/en/actions/reference/security/secure-use#hardening-for-self-hosted-runners)
は公開repoのself-hosted runnerによる任意PRのホスト侵害を警告する。
専用LaunchAgentは既存Macモデル/cacheを再利用し、公開PRをこのMacで実行する経路を
追加しない。追加runner登録token/ホストサービス/モデルの再ダウンロードも不要。

実Mac/Nixの回帰で、取得helper終了後の別writer拒否、owner NodeのSIGKILL後の再取得、
残存lockfileによる誤ったrunning判定が無いことを確認した。これは排他境界の実証であり、
本番LaunchAgentの初回完了はmain merge・bootstrap後の実clock/receiptで別に確認する。
