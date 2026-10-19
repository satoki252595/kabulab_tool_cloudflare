# 事業タグ・優待要約のMac定時運用

更新: 2026-10-19。事業タグの唯一の定時writerをApple Silicon Macへ移す。
適格新規の初回と、最新有報IDまたは既知の実入力SHAが変わった対象だけClef-Flash/MPSを使う。
同一入力の保存タグは再利用し、旧失敗・不足は従来のkeywords/excludes一致で補完する。
開始日前の上場を新規AI対象へ広げず、未保存の旧入力SHAは捏造しない。TypeSafeへの自動代替、語彙審査、
goldenの定期実行、競合判定は再開しない。

## 起動経路

`com.kabulab-cf.biztag` LaunchAgentが毎日Macの現地時刻20:00に起動する。
このMacはAsia/Tokyo。通常の`install`ではログイン時の`RunAtLoad`も同じ入口を通る。
`install-next`で作成した場合は`RunAtLoad=false`とし、次のcalendar起動を待つ。
優待要約は別label `com.kabulab-cf.yutai-summary`で毎日21:00に同じ入口の
`run yutai-summary`を実行する。原文変更・未要約・契約違反の最大60群について、機械判定できるものだけを定型処理する。残りは理由付きで保留し、旧行を保持する。
通常の定期・月次入口はモデルを起動しない。手動でsummary-localへ`--allow-model`を明示した場合だけ、既存固定モデルを使う。
定型分も同じ共有取込契約と物理PRE/POST照合を通す。配備状況と例外は[決定的な本番処理](deterministic-production.md)を参照。
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

## 競合の機械準備stage（任意・配備は別受入）

`.env`の任意キー`BIZTAG_COMPETITOR_PREPARE_CODES`へ、受入対象の固定コード集合を明示した場合だけ、
20時biztagの正常終了後に通常CLI `competitors --prepare-only --judge=semif`を同じ唯一writerで実行する。
未設定ではstageを起動しない。競合推論・relation・確率・判定日の更新は行わない。

固定集合は1〜100社。コード順に最大5件を選び、物理保存確認後のafter-codeで次へ進む。末尾後は先頭へ巡回し、
変更入力を再資格化する。同入力archive-skipでも毎晩同じ先頭5件へ戻らない。HOLDはその入力の保留一覧に保持し、
競合なし/判定完了と扱わない。scope変更は停止する。変更する場合は旧cursor/closureの保全と新scopeを確認する。

別CLI processへ新規読取6分・Notion最大0.3rpsを明示する。stage childは最大7分でSIGTERM。
startup receiptの所要も含めた全体30分timerをリセットしない。開始から22分以降はstageを始めず、
receipt用に1分を残す。20時/21時calendarと既存readcheckの30分期限は変更しない。

`tmp/biztag-local/competitor-prepared/stage-pending.json`をchild起動前に固定scope/cursor/selectedへ束縛する。
kill/通信/原本保存の結果不明では、入力SHAが変わっても次stageを始めない。pendingを消して再試行しない。
通常CLIの正常終了・物理確認ACK、gzip本文SHA、manifest対象/状態/HOLDとreceiptの一致を確認してから、
closure保存→cursor原子的更新→pending除去の順に閉じる。途中停止でpendingが残れば、実archive/receiptと照合してから扱う。

保存済みcorpus条件では5件に44 Notion読取とD1 4回、候補CPU21.07秒、maxRSS約2.56GiBを要した。
現在入力の全文量・archive/親processのgzip読戻し・追加電力/所要は未測定。7分完了や全量完走を保証しない。
83社なら正常な5件stageの一巡に最低17回を要するため、定時巡回と有限ローカル回復は区別する。
実測と未受入は[stage検証記録](test-logs/competitor-finite-stage-20261017.md)を参照。

## 受入と設定

1. Clefの通常経路・実較正とruntime設定をmainへmergeし、runtime worktreeをそのSHAで用意する。
2. 既存のprivate `.env`へのsymlinkをruntimeに置く。実体は実行ユーザー所有の
   通常ファイル・0600であること。`BIZTAG_LOCAL_ACCEPTED_REVISION`をruntimeの
   完全SHA、`BIZTAG_NEW_LISTING_FROM`を対象開始日、`CLEF_PYTHON`をNixで用意した
   下記venvの`bin/python`絶対パス、`CLEF_MODEL_PATH`を固定revisionのローカルモデルへ設定する。
   Pythonのsymlinkをrealpathで解決しない（venvを外れ、依存パッケージを読めなくなる）。
   優待要約を手動で`--allow-model`実行する場合の`SEMIF_PYTHON`は別設定。秘密値をコマンド引数・ログ・Gitへ出さない。
3. runtimeで`nix develop --command pnpm install --frozen-lockfile`を実行し、
   Nix shell/model cacheを準備する。定時起動は`--offline`でNix環境を使う。
4. 以下のpreflight/install/install-nextは外部取得・事業タグ保存をしない。

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
受入済みの定時receiptを後日の即時起動で置き換えず、更新後の次の定刻から始める場合は、
同じ承認SHAのruntimeで`install`の代わりに次を使う。

```bash
nix develop --command pnpm exec tsx scripts/biztag-local/main.ts install-next
nix develop --command pnpm exec tsx scripts/biztag-local/main.ts install-next yutai-summary
```

`install-next`もplist作成・構文検証だけを行い、既存plistを上書きしない。
20時・21時calendar、実行引数、ログ先、umask、preflightは`install`と同じで、`RunAtLoad`だけがfalseになる。
bootstrap直前にGitHubの旧catchup/backfillのqueued/in_progressが無いこと、
共有Notion writerが空いていることを確認する。

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.kabulab-cf.biztag.plist"
launchctl print "gui/$(id -u)/com.kabulab-cf.biztag"
```

通常の`install`で作成したplistはbootstrapで`RunAtLoad`の実処理を起動する。
`install-next`の場合はbootstrap時に実処理せず、次のcalendar起動を待つ。設定が存在することだけで完了にしない。
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

## Clef判定の原応答と再開

通常の`biztag run`は、同じ`.env`実体を基点にした`tmp/biztag-local/clef-decisions/`へ
判定入力と原JSONLを保存する。入力の有報ID・期末・39本文SHA・4節SHA・本文pointer・質問/qid・
語彙の全文hash・モデルmanifest・較正hashを束縛し、送信前にintentと要求原文を、
応答を受理する前に応答原文を`wx`で新規作成してfile/親directoryをfsyncする。
directoryは0700、fileは0600。`.env`値は保存しない。

質問集合・確率・全文hashまで検証された`accepted.json`と全原文がある場合は、
同じ入力・recipeの保存出力を再利用し、Python起動/forwardを行わない。判定日は保存時の完了時計を
JSTへ変換し、再開日へ更新しない。これはモデル出力の受理であり、Notion保存やジョブの成功ではない。
公開前には従来の最新有報確認・物理PRE・CAS・全項目読戻しを通す。publisherの不明markerを回避しない。

既知journalの未完intent、破断/未知応答、書込/fsync失敗、束縛の不一致では自動再推論せず停止する。
未完記録がある次runも、別銘柄を含め次forwardを開始しない。旧記録は削除・上書きしない。
完全な要求と同じidの既知エラー応答だけが残り、writerの終端を確認できた場合は、
通常の排他下で次の明示コマンドを1回だけ使える。指定は保存directory名と実応答のSHAであり、
値を推測しない。入力・要求・送信記録・応答の全hashと時計を検証し、原本を再fsyncして
`rejected.json`を追記する。業務書込・推論・再送は0。同じ入力は以降もHOLDし、
ほかの入力だけが通常処理へ進める。部分応答・未知エラー・不一致・受理済み出力には使えない。

```sh
nix develop --offline --no-write-lock-file --command env -u NODE_PATH \
  node --import tsx services/yuho-quant/data-scripts/biztag.ts acknowledge-clef-error \
  --journal-key=<保存directoryの64桁hash> --response-sha256=<保存response.rawの64桁SHA>
```

単一質問でも全文が16,000tokenを超える場合は、推論前の専用エラー`clef_input_token_limit`を返す。
本文の切捨てや候補の推測はせず、この場合も同じ入力を自動再推論しない。
原文の上限は1file 1MiB、1run 64MiB、保存全体1GiBで、新しい要求の前に6MiBを予約する。
上限到達はHOLDとして運用者が確認し、無制限保存や自動整理は行わない。
SemIf/競合判定の既定経路にはこのjournalを接続しない。旧モデルの無記録履歴をClefへ付け替えない。
有限回復の900 native要求/90分・メモリ等の予算は専用wrapperの別条件で、通常の定時頻度は変えない。

## 空事業タグの有限見直し

`判定済`でも3分類とも空の銘柄は、同docを再利用する通常定期では再判定されない。
明示`--repair-empty-tags`を指定した有限のMac CLIだけ、同じ適格有報・現active・一意な主マスタを確認して
既存のローカルClefと物理PRE/CAS/全POSTへ通せる。固定1〜50の一意コード、同数limit、明示20分以内budgetが必須。
以下は入口の形式であり、実行前に指定コードの欠測対象と現在の資格を確認する。

```sh
nix develop --offline --no-write-lock-file --command env -u NODE_PATH \
  node --import tsx services/yuho-quant/data-scripts/biztag.ts run \
  --repair-empty-tags --codes=<固定コード一覧> --limit=<コード数> --budget-min=20
```

同じNix・承認main・所有者0600のprivate env・kernel writer排他・通常journalを使い、
定期labelや当日の自然起動receiptを手動実行で置き換えない。refresh/reconcileとの併用は拒否する。
既存非空タグ・本文なし・現在入力の資格不足はHOLD。`--mechanical-only`/`--dry-run`では推論しない。
判定結果は`emptyTagRepair`で再確認・タグ付与・全no・要確認・候補なし・HOLD・残りを分ける。
再利用できた決定の判定日は元の実完了時計を保ち、今回の操作時計は通常publicationに残す。
空欄ゼロや全社の再判定を約束する入口ではなく、語彙不足と未採用は別に確認する。

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
