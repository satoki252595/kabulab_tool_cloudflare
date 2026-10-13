# 事業タグ・優待要約のMac定時運用

更新: 2026-10-14。事業タグの唯一の定時writerをApple Silicon Macへ移す。
適格新規の初回と、最新有報IDまたは既知の実入力SHAが変わった対象だけClef-Flash/MPSを使う。
同一入力の保存タグは再利用し、旧失敗・不足は従来のkeywords/excludes一致で補完する。
開始日前の上場を新規AI対象へ広げず、未保存の旧入力SHAは捏造しない。TypeSafeへの自動代替、語彙審査、
goldenの定期実行、競合判定は再開しない。

## 起動経路

`com.kabulab-cf.biztag` LaunchAgentが毎日Macの現地時刻20:00に起動する。
このMacはAsia/Tokyo。ログイン時の`RunAtLoad`も同じ入口を通る。
優待要約は別label `com.kabulab-cf.yutai-summary`で毎日21:00に同じ入口の
`run yutai-summary`を実行する。原文変更・未要約・契約違反の最大60群を既存固定モデルで処理し、
新しい有料APIは使わない。`tmp/yutai-local`にprivate進捗・原本・送信中記録を残す。
実行コードはCIを確認してmainへmergeした専用runtime worktreeに固定し、
自動pull/resetや未レビューのPR実行はしない。

専用runtimeの標準位置は、このサービスの`.runtime/mac`とする。
プロジェクト外の一時的なOrca workspaceや削除候補の兄弟worktreeをWorkingDirectoryにしない。
`.runtime/`はGit対象外だが、`git worktree list`に登録された運用worktreeとして保持する。

```text
LaunchAgent → nix develop --offline → scripts/biztag-local/main.ts run
  → biztag CLI → withBiztagWriter → runBiztag → 適格新規/実入力変更だけlazy Clef
```

Linuxの`catchup.yml`はEDINET/TDnetを継続し、biztagの定期writerを起動しない。
手動`target=biztag/all`のbiztag部分と、`backfill.yml`の全biztag系は
checkout/一次データ取得前に明示停止する。MacのwriterへGitHubからジョブを
転送する仕組みも設けない。株価/macroeconomicsのCloudflare 4 Cronは別の経路であり、
この設定では変更しない。

## 受入と設定

1. Clefの通常経路・実較正とruntime設定をmainへmergeし、runtime worktreeをそのSHAで用意する。
2. 既存のprivate `.env`へのsymlinkをruntimeに置く。実体は実行ユーザー所有の
   通常ファイル・0600であること。`BIZTAG_LOCAL_ACCEPTED_REVISION`をruntimeの
   完全SHA、`BIZTAG_NEW_LISTING_FROM`を対象開始日、`CLEF_PYTHON`をNixで用意した
   下記venvの`bin/python`絶対パス、`CLEF_MODEL_PATH`を固定revisionのローカルモデルへ設定する。
   Pythonのsymlinkをrealpathで解決しない（venvを外れ、依存パッケージを読めなくなる）。
   優待要約の既存モデル用`SEMIF_PYTHON`は別設定。秘密値をコマンド引数・ログ・Gitへ出さない。
3. runtimeで`nix develop --command pnpm install --frozen-lockfile`を実行し、
   Nix shell/model cacheを準備する。定時起動は`--offline`でNix環境を使う。
4. 以下のpreflight/installは外部取得・事業タグ保存をしない。

Clefの依存は`services/yuho-quant/local-model/uv.lock`で固定する。実行環境とローカル検証で
同じinterpreterとlockを使い、環境構築時だけNixから次を実行する。既存venvも
`pyvenv.cfg`の`home`がNix storeを指すことを確認し、別Python基底の環境を再利用しない。

```bash
nix develop --command sh -c 'uv sync --locked --no-python-downloads --project services/yuho-quant/local-model --python "$(command -v python3.12)"'
```

モデルは`Cloudflare/clef-flash`のrevision `8b2e5fd17c09fd49bc2880b805d5323ec7ff4ff3`。
全ファイルのサイズ/SHAと専用判定headを`src/shared/clef/manifest.json`で照合する。
通常起動はモデル取得をせず、MPSが無い・依存版が違う・因果attention検証が失敗した場合は停止する。
全本文を保ったまま質問だけを決定的に分割し、全分割の16000token上限を推論前に検証する。
単一質問でも上限を超える入力や途中の失敗は、切捨てや別モデルへの切替で補わない。

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
AI対象0ならClefモデルのspawnは0。Macが停止/ログアウトしていた時刻の
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

runtime HEADが承認SHAと不一致、追跡対象がdirty、承認SHAが取得済みorigin/mainの
祖先でない、private `.env`の権限が広い、Apple Silicon/Nixが不足する場合も早期停止。
本文39列の同期と語句一致は較正ファイルを読まない。実AI判定の直前だけClef専用較正の存在・
固定model一致を必須にし、欠配置/不一致は明示失敗とする。モデル不適合や本文資格不足は元のHOLD/判定不能を維持する。

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
追加しない。追加runner登録token/ホストサービスは不要。Clefの固定原本は初回に約19GBをローカル保管する。

実Mac/Nixの回帰で、取得helper終了後の別writer拒否、owner NodeのSIGKILL後の再取得、
残存lockfileによる誤ったrunning判定が無いことを確認した。これは排他境界の実証であり、
本番LaunchAgentの初回完了はmain merge・bootstrap後の実clock/receiptで別に確認する。
