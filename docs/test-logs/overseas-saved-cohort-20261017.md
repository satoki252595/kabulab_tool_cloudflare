# 海外売上の保存原本を通常CLIで有限回復する

2026-10-17。通常 `backfill:overseas` に明示 saved-cohort mode を追加する。本番実行・次回定時の受入は別途必要で、この変更だけで全市場の海外売上を完了にしない。

## 通常の共通経路

- `parseOverseasData` / `validateOverseasSaveSet` / `toOverseasSaveRows` / `serializeOverseasOmission` は既存の正準を再利用する。
- 保存原本は既存 `readSavedHoldingsZip` が typed-first で選び、全物理ZIPのSHA・DEI・提出者・期末・証券コード・取得時計を確認する。旧legacyから既存typedへ移った場合だけ、同一原本と `sourceLegacyPageId` の系譜を認める。旧manifest不明は不明のまま残す。
- 最新有報は全6表の対象株だけを読み、同じ `loadLatestDocs` を保存断面に適用する。現本文の唯一性・pointer・全節・page時計を通常Notion readerで確認する。欠測節を作らず、39節が常に存在すると主張しない。
- 一度共有化した `buildAtomicWithCommonProjection` は、全6表の全旧列・件数・双方向集合CASをDMLの前に置く。通常の海外保存列と0030 omission serializer、通常 `rebuildYuhoGrowthProjection`、共通D1 atomic senderを使う。受注・本文・他文書の数値は保持する。
- physical full PREが成功してから各社を1batchで適用し、同値は書換えない。全6表・原本・本文のPOSTとphysical full POSTまで検証する。別 `inspect` は読み取りだけで全6表・原本文・原本・両物理ファイルを再確認する。

2026-10-25以降、旧ダウンロードmodeは廃止し、`backfill:overseas`は本書のsaved引数を必須とする。旧`audit:overseas`も通信前に拒否し、読取監査は同じsaved modeの`prepare`または`inspect`を使う。saved modeへ `--force` / `--offset` / ordinary `--limit` を混ぜると源取得前に停止する。新規原本が必要な場合は[通常の有限原本復旧](../edinet-archive-repair.md)を別操作で行い、欠測を暗黙取得や期末代替で埋めない。旧16列のclosed44 helperはこの新経路に使わない。追加の原本API取得・モデル・依存・DDLは0。Node 22の標準SQLiteを使い、ローカルは既存flake/lockのNix、通常Actionsは既存Node 22で動く。

## 有限実行と再開

単一固定JSON（version 1、code順で最大200社、正準 `stateDir` を含む）を全SHAで指定する。各itemは `stockCode/stockId/documentId/docId/edinetCode/periodEnd/zipSha256/archivePageId/originalManifest/sourceFetchedAt` を厳格に持つ。未知キー・主体や文書の重複・順序不正は停止する。履歴の候補資格だけでは書込みを許可しない。

同じ通常CLIへ以下を明示する。毎回新しい出力namespaceを使う。

| 引数 | 意味 |
|---|---|
| `--saved-cohort` / `--cohort-sha256` | 固定masterと全SHA |
| `--saved-mode=prepare/apply/inspect` | 読取PRE / 通常atomic適用 / 独立読戻し |
| `--after-code=START` または前回閉鎖code、`--max-targets` | master中の有限prefix、1〜20社 |
| `--out` | 未使用の出力先。attempt/native/inflight/STOPを0600で保全 |
| `--capsule` / `--capsule-sha256` | applyはfresh PRE、inspectは実POST。prepareには渡さない |
| `--max-seconds` / `--not-after` | 最大1800秒と実時計期限。各送信前65秒を予約 |
| `--max-notion-rps` / `--max-notion` / `--max-http` / `--max-d1` | 共有Notion率と有限通信数。最大400Notion/1000HTTP/400D1読取 |
| `--max-response-bytes` / `--max-request-bytes` | retained応答最大256MiB、要求最大64MiB |

実送信は同じSQLとparamsの組、固定本文/原本page、既存一次DB、実応答から束縛したupload/page/hosted URLだけ。schema変更・DELETE・source page更新・supplement更新・新源API・モデルは許可しない。全nativeのURL/要求本文/応答本文/SHAを保存し、署名URLや原文をstdout/Gitへ出さない。取得中にper-response 32MiB/総retained予算を検査し、受領済みoverflowもobserved計数へ残す。D1 500k rows_readは応答後の累積STOPであり、最初のscanを未然に制限する保証ではない。

結果不明はSTOPを保持し、同じoutやinflightを再送しない。cohort JSONの固定 `stateDir` は既存実体のrealpath/owner/0700を確認し、欠測時に空dirを自動生成しない。apply前にdocId+ZIP SHAのsingle-use claimをcohort側へwx/fsync保存するため、同じPREをコピーしてoutを変更しても、新PREで同sourceを選んでもHTTP前に停止する。claimは不変で自動削除せず、既commit/未commitを推定して再送しない。別stateへ切替えて旧未知を避ける運用を許可しない。

この固定cohort modeは、同じstateを保持するローカルcatchupを前提にする。Actionsのephemeral filesystemが次runにも保存されるとは主張しない。Actionsで使う場合は、同stateの復元と未閉鎖claimの照合を別途運用確認する必要があり、通常日次ingestのparser/projection共通化とは分ける。次codeへの進行は正常applyと独立inspectの両閉鎖後に運用が決める。無限chain・自動的な別原本選択・source clockの推測はない。

## 保存実データでの検証

保存済みfresh15（全6表、0030実列、15物理原本）を、新共有builderと旧review済toolへ同じ秒で渡した。全statements/params/期待全6表が15/15同一。新builderの実SQLite適用15件、提出時計・本文索引・L2・omission列の競合60件で全体rollback、同値再計算15件のbusiness値一致を確認した。HTTP・モデル・本番書込み0。

保存native source pageを直接渡した資格確認も15/15成功。1379は旧legacyと実typedを両方系譜に束縛して16source IDsを許可し、未知のcanonicalへ許可を広げない。SQLのみでキーを上書きしない回帰は、全singletonとchunk、違うstock params/SQLを含む。

履歴候補207から既受入のsafe20内16社とnext15を除くと、残176社＝連結数値166社/993facts（ZIP合計149,013,876B）＋scope HOLD10社。全176を同じ通常parser/DEI/metadata/saveRowsで純再生し、旧資格結果と同一、35.126秒だった。この166は歴史固定本文3666のmembershipを満たす集合で、現latest/body/source clock/D1のfresh資格はまだ未観測。全市場の完了数ではない。

private証跡はroot `tmp/feature-audit-20261017/overseas-fixed-cohort-entry-pure-v1/` と作業WT `tmp/overseas-fixed-cohort-actual15-replay-v1/`、`tmp/overseas-saved-scope-actual15-v1/` に0600保管する。最新main統合後のbuilder照合は `tmp/overseas-fixed-cohort-final-replay-v2/` で15成功/60rollback/15同値を再確認し、通常入口・既存取込/原本保管の5 suites 109件とtypecheck/lintが通った。fresh15入力gzip SHAは `f11457090b72da2795c6ae70149c717fac112fa04a1260941425e9268f7e9231`。166 CLI 初期master SHAは `9f4ca37fe4f828c3635dbcacfe3dc5150d8914271e4404096aebf32d10378e88`（stateDir追加前の純案、送信不可）。stateDirを含む新draft master SHAは `6c8c53a5ed7947895978fa274944ac97aa34c27cc010a546d2b983cf1ed3aff0`。提案stateDirはまだ作らず、既存stateを確認する別releaseまでは送信不可。次20社のfresh/native予算と本番適用は別releaseで受け入れる。
