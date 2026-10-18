# 本文補完とMac定期実行登録の受入（2026-10-18）

保存済みの固定残対象659件を、通常の本文同期処理で全件補完した。Macの定期実行2ラベルも承認済みmain `09525901d6e569611a47cd8b8444e1aadaccfc0f` のruntimeへ切り替え、停止状態での登録まで実確認した。

## 本文の対象と結果

| 項目 | 実受入 |
| --- | --- |
| 今回の固定対象 | 659件、14群（50件×13＋9件） |
| 通常処理の完了／残り | 659／0 |
| 失敗／判定保留／未閉鎖publication | 0／0／0 |
| 新規の上流原本取得／判定LLM呼び出し | 0／0 |
| Notion native通信／429／通信再試行 | 8,988／0／0 |
| 通常CLIの実行時間合計 | 7,300.937秒（約121.68分） |

固定補完計画2417件のうち1758件は従来の受入、残る659件が今回の受入であり、この固定計画の残数は0となる。従来1758件の本番再読や、全市場の現在の充足率を今回あらためて測定したものではない。機能全20項目の最終受入も別の台帳で管理する。

補完には、Macの通常定期実行recipeが起動する `services/yuho-quant/data-scripts/biztag.ts run` をNixから使用した。`--codes` で対象を固定し、`--mechanical-only`、各群50件以下、業務予算18分、操作全体20分で実施した。実行sourceは `55ab6d06c5a2ac85004b7a54b7d38c1651336edd`、本文処理は受入済みmain `449a157a2275266926f4041ba029f648333a6fa3` と同等である。新しい専用publisherや並列writerは追加していない。

通常のkernel排他・durable publication・PRE/POST検証を使用し、元の銘柄コード・文書ID・対象ページ・原本ページとの一致を全659件で確認した。本文39項目と、有報書類ID・本文の状態・判定入力を合わせた42プロパティを照合し、39項目のwire SHAと旧判定入力の保持を確認した。全659件のcanonical PRE・intent・completedの保存SHAも、各群の完了記録と一致した。

最初の550件はNotionと保存hostedファイルを合わせて約1.5リクエスト/秒、後半109件は空いた共有枠を使い2.0へ変更した。変更は新しい操作の開始時だけ行い、実行中のrate・期限・source・envは保持した。2.0の最初の50件は460.709秒で、直前の50件578.122秒から約20%短縮した。

追加依存・常駐プロセス・判定LLM推論・新規vendor原本取得は0。保存原本のhosted読取総数とD1の読取行数は当laneでは計測していないため、今回の記録から金額を推定していない。追加の独立全量通信照合は行わず、通常publisherの検証と保存記録の機械集約を使用した。

## Mac定期実行の登録

`com.kabulab-cf.biztag` と `com.kabulab-cf.yutai-summary` の2ラベルについて、既存の通常 `install-next`、bootout、bootstrapを使う1回の切替が11.77秒で終了した。全11コマンドのACK、stdout/stderrの全SHA、actual plistとexpected plistの全バイト一致、旧2 plistの保全、所有親子プロセスの閉鎖、kernel解放を確認した。旧runtime・旧envも保持している。

新runtimeは `.runtime/mac-next-main09525901-20261018`。登録後の両ラベルはPIDなし・停止状態で、`RunAtLoad=false`、20時・21時の既存カレンダーを保持する。今回の登録操作による業務HTTP・source取得・モデル呼び出し・業務データ書込・env更新・秘密更新は0である。

**本日の20時・21時の自然起動は未受入。** GitHub ActionsのexpectedRevisionは旧値 `4a66929cc16513b5e8b7abb671f5bde216274cbb` を維持している。

## 保存証跡と独立確認の範囲

- 本文全659件: `tmp/feature-audit-20261018/G659-normal-mechanical-action-v1/whole659-acceptance.json`
  - SHA256: `353c3487571093d937fc3782eda1a7fa723b312e7c09147b38aa7a28b2c5864e`
  - 元659件の保存identity、14完了記録、canonical全SHAをFSのみで集約。normal pendingは0、全通常CLI・同期子処理は閉鎖。kernel解放は最終本文操作の閉鎖時に確認した。
- Mac切替: `tmp/feature-audit-20261018/mac-main09525901-quiet-cutover-v1/root-final-acceptance-v1.json`
  - SHA256: `955891e50ff97027f8e875b05b490aa18ad9f8abf1d70ec44b9519f08d2ea325`
  - 独立FS確認で全77 pins、11 ACK、両plistの全バイト、旧plist、保存after-printの停止状態と新CWD、owned closureを再確認した。独立確認による追加HTTP・OS制御・正常証跡の再ダウンロードは0。

証跡はローカルのprivate保管物であり、Gitへ原本・署名URL・秘密情報を含めない。本文の追加admissionは停止し、今回のscopeをfreezeした。
