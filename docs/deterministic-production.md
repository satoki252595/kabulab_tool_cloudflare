# 決定的な本番処理

更新: 2026-10-25。**本文39/基本補足と優待の決定的同期はGitHub Actions日次。Mac定期は廃止・停止済みで、Clef・競合の意味判断・優待`--allow-model`は[月次手動](mac-monthly-manual.md)**。[取得元・機能の全件一覧](batch-data-inventory.md)を参照。取得・抽出・計算・照合・保存・検証は通常CLIと共有関数を使う。過去分の有限補完も同じparser・保存・停止条件を通す。

予定・担当・先行条件・LLM利用は[README](../README.md#本番の定期処理先行条件llm利用)、workflowとSSHの運用は[本番処理一覧](production-job-inventory.md)、最新の実測・残件・未受入は[10/25の作業記録](work-plans/production-completion-20261025.md)を参照する。予定と実行成功、個別復旧と全件完了を区別する。

## 実行場所

| 場所 | 担当 | 実行しない処理 |
|---|---|---|
| Cloudflare | API、予定のdispatch、receiptと期限の監視 | 長時間の全市場取込 |
| GitHub Actions | 日次/月次のNode・Python取得、構造抽出、金融計算、原本保管、本文39/基本補足・優待機械同期 | 事業タグの定期モデルwriter |
| 旧Mac | 定期2本をdisable/unload済み。Clef・競合の意味判断・優待`--allow-model`だけ月次手動 | 自動再開しない。state/未完記録/原本を保持 |
| SSH nipogi | 必要対象を固定した不足補完 | 日次の重複cron、全履歴RAWミラー |

ローカル・SSHはリポジトリのNixと依存lockを使う。本番Actionsの通常CLIと入力契約を合わせ、復旧中のruntime・設定は固定する。

財務NULLの[有限診断](financial-null-audit.md)はNixの手動CLI。コード別の③読取だけにsingle-attempt/HTTP上限/絶対期限を適用し、保存原本のlocal再解析を分離する。既存normalizerの任意診断で理由を残し、Actions/CF/Macの通常writer・定期・計算結果は変更しない。未完partitionや原本HOLDを全履歴充足にしない。

## 機械処理と意味判断

- 株価・需給・有報・IR・財務・保有・原本索引は機械処理。未取得、主体不明、期間/単位/basis不一致を別値で埋めない。
- 旧事業タグは適格新規の初回、実入力変更、固定修復だけ`Cloudflare/clef-flash`。現行MPS限定で、月次手動の準備のみ。日次自動は停止中。保存済み同入力の判断は再利用する。自由文を作文して事業内容へ入れない。
- 本文39/基本補足と優待要約の決定的部分は`sync:mechanical`で日次処理する。未対応は理由付き保留。優待の既存MLXはMac月次手動の`--allow-model`だけ。
- 競合は候補・質問・保存物検証まで機械化。定期の意味判定は停止を維持する。

## 保存・資格・停止

1. 一次原本は`src/shared/notion-archive/`経由で物理保管し、実体・全SHA・metadataを検証する。D1へ構造化、R2へ時系列・receiptを保存する。
2. 主体・書類・期間・最新pointerを確認し、既存writerのPRE/CAS/POSTを通す。株式分割・併合・増資等は法的効力・株数/単位・価格basisが成立したものだけ金融計算へ使う。
3. Yahoo 429/503は共有期限内の後続取得を止める。D1の期限読取失敗でも上流へ進まない。株式は物理照合済みの正常snapshotだけを保存して元の取得停止を返し、全量成功時の集計・掃除へ進まない。
4. 通信や保存の結果不明はintent/inFlightを残し、自動再送しない。価格PUTだけは同processで送信した全bytes・全metadataを単発の完全GETで確認できた場合に限り、ACK不明の証拠を残して続行する。旧値や照合不能は停止を維持し、過去runのunknownを解除しない。
5. EDINET情報修正は、修正前後の主体・形式・期末、保存ZIP、通常parserの全factsと全文が完全一致した観測だけを追記台帳で解決する。取下げ・不開示・parser不一致はHOLD。
6. `exit0`・未処理0・タグ判定済みだけで全データ充足とは扱わない。全no・要確認・候補0・原本なしを分け、予定日・対象集合・結果・欠測理由・receiptで検収する。

## 必要原本だけを扱う

歴史78,832件の全量R2コピー・独立全量再GETは停止した。最新shina等の本番が実際に読む原本は`raw:required`で対象を先に絞り、通常validator・本文SHA・索引を確認する。必要な過去原本だけ個別に補完し、原本不足を生成値で補わない。

本文39列の同期、保有明細・価格queue、海外/受注backfillは通常共有publisherを使う。意味判断・金融資格・原本保存・本文同期の完了を互いに代用しない。各機能の実測と未受入は復旧状況から対応する検証記録を参照する。

## 情報修正の派生metadataだけを明示訂正する

`yuho:reaccept:derived-metadata`は明示1doc・保存済みイベント/元提出日一覧のprivate receiptと各SHA・10分以内の予算を必須とする。上流取得は行わず、元提出日一覧の実物がない場合もSTOPする。通常のstrict/v1やreaderは変更しない。現旧ZIP全member、主体/native8、全facts・本文索引・全文、省略理由の完全一致から、通常parserの`honbun_file`/`overseas_parse_status`/`overseas_honbun_file`/`overseas_omission_json`だけを候補にする。旧manifestのunknownはPREへそのまま残す。

```bash
nix develop --offline --no-write-lock-file --command pnpm yuho:reaccept:derived-metadata \
  --doc=<明示docID> --event-snapshot=<private receipt> --event-sha256=<receipt SHA256> \
  --original-snapshot=<元提出日private receipt> --original-sha256=<receipt SHA256> --budget-min=10
```

`.env`はcanonical repoと同じ親のprivateファイルを明示loadする。planの`preSha256`を確認後、同じ引数に`--execute --expected-pre-sha256=<plan SHA256>`を加える。PREは現在時刻や一時URLに依存しない。同一Git common rootの`tmp/edinet-information-edit-basis/<docID>/`へO_EXCLでlatch・完全PRE/INTENT/POSTを保存し、既存共有ownerを取得する。PRE/POSTは既存`一次データ｜yuho-quant`にも`information-edit-basis:<docID>:<PRE SHA256>:PRE/POST`で物理保管・全bytes確認する。全材料を再照合し、issuer/現主体・観測/解決集合・全データ・進捗の同一batch CASを通した一度だけの4列UPDATE後、完全POSTと元strict一致を検証する。金融数値・本文・時計・解決台帳は更新しない。

成功も`basis_reaccepted_resolution_pending`であり、解決は通常のstrict再資格化へ残す。通常再資格化が元日付一覧の新captureを要する場合は、本CLIとは別の明示本番操作とする。unknownや失敗はowner/固定latchを保全し、自動再送・別dir迂回・状態解除を行わない。実3776回帰fixtureの元提出日receiptは保存原物から取得し、通信応答は明示offline controlとする。回帰を実運用の原典資格へ代用せず、本番適用は別途の対象限定受入が必要。
