# 本文39・基本補足・優待の機械定期同期

2026-10-25の実装。保存済みの適格原本を使うLinux/Actionsの独立処理で、EDINET/Yahooの再取得、語彙審査、Clef/MLX、有料APIを呼ばない。旧Macの自動起動は廃止を維持する。**実装・定期設定・初回移行・実データ充足は別の受入条件**で、マージだけでは移行完了ではない。

| 段階 | 入口・有限範囲 | 先行条件・停止 |
|---|---|---|
| 本文39・基本補足 | `pnpm sync:mechanical --target=supplement --limit=50 --budget-min=10` | active普通株の変更文書＋コード巡回をSQLで先に最大50社へ限定。10分で新しい会社を開始せず、追加IOのhard境界はその5分後。未閉鎖は保持して成功にしない |
| 優待機械要約 | `pnpm sync:mechanical --target=yutai --limit=60 --budget-min=15 --state-dir=<private-dir>` | 最大60群、既存の条件・金額文法/validator/原子取込を使用。モデル許可は入口で拒否。機械未対応は理由付き保留 |
| 月次Mac手動 | [月次手動](mac-monthly-manual.md)の同じdriver | 適格新規/実入力変更のClef判定と、設定済み固定scopeの競合入力準備。優待要約はここから外す |

`.github/workflows/mechanical-publishing.yml` は毎日04:17 JST。夕方〜23:30の通常取得と06時処理の間に置き、本文→優待を直列で動かす。本文の既知HOLDは優待の意味上の前提ではないので後続へ進むが、保存結果不明の共有owner/pendingなら後続は依存生成前に停止する。jobは30分。両jobが既存`record-job-clock`でJobs APIの実開始時刻を取得し、CLIのhardを「CLI開始＋指定budget＋5分」と「job実開始＋25分」の早い方へ固定する。新規開始のsoftはhardの5分前で、clock欠落・setup後にsoftを過ぎた場合は共有owner/業務依存の生成前に停止する。本文は銘柄単位、優待は最大60群の原子batch開始時にsoftを検査し、開始済みPRE→POSTとR2/HTTPは同じhardまでに閉鎖する。指定budgetやjob開始時計は書き換えない。GitHub遅配時も実開始時の保存入力を対象とし、予定日の市場取得成功へ読み替えない。次回の機械同期は未完cursorを使う。

## 本文とタグを別の原本へ束縛する

`有報書類ID`・会計期末・提出日時・本文39列・`本文同期根拠`は現在の本文。`事業タグの根拠書類`・`判定入力`・根拠文・判定時刻は歴史的な意味判断で、本文同期では変更しない。本文の4対象節SHAと判定入力SHAを別のrich_text列に保存する。過去に未保存の判定SHAはNULLのまま。

新しいNotion formula `事業タグと現在本文の対応` は「旧書類のタグ（再判定待ち）」「本文入力が変更（再判定待ち）」「判定入力未確認」を区別する。異なる書類/既知入力の旧タグを、plannerや競合候補が最新判定として再利用しない。formulaは[公式のsubstring/length/if/empty](https://www.notion.com/help/formula-syntax)で構成する。列は既存`ensureSupplementDb`が追加し、別のD1 migrationや手動schema操作は不要。既存選択肢や語彙は削除しない。

最大50社の現在targetを完全GETし、実値の正規化SHAを照合する。選択済みの保存Notion原本は未変更候補でも所属/7メタ/strict全文を1回読む。未変更なら業務PATCHは0。変更・欠落だけ通常の物理PRE保管→旧値CAS→完全POST検証を通す。本文が未保管なら基本情報の欠落だけ補い、旧本文・タグを消さない。原本にもない節はNULLを維持し、非開示と断定しない。主体/同doc非空メタの矛盾、reported-state、master重複はHOLD。

変更文書cursorは取得時刻＋docID、巡回cursorはコード順。初回は過去の原本を一括読込せず、最大50社ずつ確認する。変更が多い場合は変更を優先するため、全社が毎日更新される保証はない。summaryの`processed/unstarted/synced/unchanged/basicOnly/held`、優待の残件/保留を確認する。

## MacとLinuxの共有書込保護

通常の本文readerは選択済み1docのD1主体/doc/FY/pointer/状態/idを照会し、共通`readVerifiedDocText`でNotion所属・全7メタ・strict全文を確認する。consumerだけ実全文からsection数/codepoint数を算出し、producerの独立した件数/原文照合は維持する。旧メタ欠落や不同を補作せずHOLDとし、原本ZIPは取り直さない。旧receiptだけではsource所属を保証できないため、unchanged候補もこの読取資格を通し、一致時は業務書込をしない。

全ての通常Mac writer、Linux本文/優待、月次優待原文取込は、既存`R2_BUCKET_RAW`の`mechanical-publishing/v1/writer.json`を同じETagの単発条件付きPUTで取得する。raw sourceを取得するだけの期間はこのownerを保持しない。新しいCloudflare resource/依存ライブラリはない。[R2のS3互換API](https://developers.cloudflare.com/r2/api/s3/api/)を既存helperから使う。

- ownerにTTLはない。別host、期限超過、fresh runnerで未閉鎖状態を解除しない。
- 送信前pendingと完全PRE bytesを保管・全文読戻ししてから業務送信。適用不明のPUT/Notion/D1は自動再送しない。
- 通常publisherの完全POST/原本保管成功後にcompletionを保存し、pendingを閉じる。その後だけcursorをCAS更新してownerを解放する。
- `publishingReadOnly`で明示した純SELECT/GETが、reserve/cursor書込開始前に失敗した場合だけ、同owner/同state/STOPなしを再読しCAS解放する。schema ensure/モデル/保管/業務送信を純read扱いしない。
- 旧FS supplement journal、Clef journal、優待pending/進捗は保持する。未知を片付けるための削除・別state・無条件上書きは禁止。モデルforwardの未知と業務書込の未知は区別し、旧Clef journalは保全して通常のモデルforward前STOPを維持する。モデル未解決だけで本文同期を意味判断へ結合し直さない。未閉鎖時は保存PRE/実結果を限定照合し、個別の明示解消が必要。

旧単体 `yutai:summary:import --apply` と `backfill-public-facts.ts apply*/resume*` はCLI入口で業務IO前に拒否する。dry-run/prepare、既存の純粋planner・原子apply部品は維持する。`verify-repair-reentry` とfresh-auditは実senderがthrowする読取/保存済み検証であり、実DMLへは接続しない。旧未閉鎖intentを通常CLIの再実行やこの停止で消さない。

## 初回切替（root/operatorが一度だけ実施）

**通常runより先に以下を全て満たす。Linuxから初期化はできない。** この文書の新runtime名`.runtime/mac-publishing-20261025`は切替用の計画値で、作成・実受入は別の運用証跡に残す。

1. CI緑のマージ済みmainを新しい受入runtimeへ用意する。新runtimeの`.env`は従来と同じcanonical実体、モデル・state・原本も同じ。依存はNix/既存lockで準備する。
2. Macの全writerがidleで、旧journal未閉鎖0、優待pendingなしを確認する。旧runtime/env/receiptの切替前SHAを保存する。未知の掃除はしない。
3. 同canonical `.env` の`BIZTAG_LOCAL_ACCEPTED_REVISION`を新main SHAへ明示更新する。**旧runtimeのpreflightが版不一致で止まることを確認**し、Calendar/月次driverの`--runtime`も新runtimeへ変える。旧runtimeを残したまま共有gateを迂回できる構成にしない。
4. 新runtime自身をcwdにしてNixから次の一回限りの移行を実施する。scriptの`import.meta`で解決したrootと`.env`、preflightのHEAD/acceptedRevision/main祖先/clean/権限を同じruntimeへ固定する。

```sh
cd /Users/satoki252595/projects/kabulab-cf/.runtime/mac-publishing-20261025
umask 077
nix develop --offline --no-write-lock-file --command env -u NODE_PATH pnpm publishing:initialize --initialize-from-accepted-mac >../../tmp/biztag-local/shared-publishing-initialize.log 2>&1
```

既存privateなcanonical stateとkernel lockの下で旧FS journal全件を検証し、全completion SHAと旧優待cursor SHAをimmutable baselineへ保存する。旧優待cursorは同じbytesを共有cursorへ移す。初回共有keyが既存/不明なら再初期化しない。途中PUT不明でも再実行しない。

5. GitHub secretsを同じcanonical設定から登録/照合する。値はGit/ログへ書かない。

| 用途 | 既存secret名 |
|---|---|
| D1 REST | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID` |
| Notion共通 | `NOTION_TOKEN`, `NOTION_ARCHIVE_PAGE_ID`, `NOTION_STOCK_INFO_PAGE_ID`, `NOTION_DB_STOCK_MASTER` |
| R2共有状態/物理PRE | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, **`R2_BUCKET_RAW`** |

`NOTION_YUHO_TEXT_DB_ID`はproducerが保管する既存「有報テキスト」DBのIDを必須で設定する（共有型付きaccessorで検査）。新DBで補完しない。

`R2_BUCKET_RAW`はMacと**同じ原本bucket**にする。公開価格用`R2_BUCKET`へ代用しない。stock-syncの月次優待source importも同じsecretを必要とするので、次の月次実行より前に初回移行を閉じる。既存のNotion DB IDが未設定なら共有ensureの同親/同title検索を使い、秘密欠落を別DBで黙って代用しない。

6. 有限scopeの初回本番処理と完全readbackをrootが確認し、残件/unknownとcanonical旧bytes不変を記録する。**それから** `MECHANICAL_PUBLISHING_ENABLED=true` をGitHub repository variableへ設定する。未設定ではschedule/manual jobとも実行しない。新schema/readback・定期初回結果はコードテストとは別の受入証跡にする。

## 費用・性能の上限

モデル/有料API追加0、上流原本の新規取得0。Notionは毎日最大50社の現在値確認＋source所属/7メタ/strict本文の有限読取（変更がない対象も含む）＋変更分だけ通常publisher、優待は最大60群の既存一括SELECT/原子適用/バッチ保管。R2は共有状態の小さいGET/CASと、実際に変更するpublicationのPRE/completion/cursorだけ。物理PREは64MiB、状態/完了/各cursorは16KiBを超えると停止する。

Notionは新job内0.8 req/sで直列、本文と優待も同時実行しない。raw/source取込を含む他全familyとのグローバルrate制御はこのownerでは成立しないため、既存の取得rateを増やさず閑散時間に置く。最大値だけから請求額や全残の所要日数を断定しない。初回本番summaryの実Notion requests/429/retryとcursor進行から算定する。
