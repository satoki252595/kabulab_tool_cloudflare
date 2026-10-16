# 2026-10-16 21:02 JSTの追加受入

追跡は[#348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。この記録は以下の対象の実測であり、全20機能・全空欄の完了を意味しない。

| 対象 | 受入済み | 残件・制限 |
|---|---|---|
| Mac 20時の事業タグ | 承認済み`27709ccf`で実20時に起動し20:20:13にexit0。197社を訪問、本文同期143・既存再判定5・skip49。Clefの7交換は共通journal replayで入力・request/raw responseの全SHA、文書・モデル・較正・qids・確率・時計を追加forward0で検証 | 197/3,687は今回の訪問数。全体の判定充足率へ転用しない。資格HOLD23と停止中TypeSafeを保持 |
| Mac 21時の優待要約 | 実21:00:06.541起動、21:00:09.163完了、exit0・再試行0。pendingBefore/Afterとも0、モデル呼出し・常駐モデルとも0。R2の最終receiptを1GET/327 bytesで独立確認 | pending0は現行要約タスクの充足。優待情報モデルの全条件対応とは区別 |
| 海外売上の理由表示 | #414のmain `2a4b376b`を20:48:49に本番配信（version `686e7bf5-1d87-474c-8e75-238a4a4df7dc`）。実3画面でHTTP200・海外節の表示を確認 | 過去の理由列は別途反映が必要 |
| 955件の省略理由の機械再処理 | 保存済み物理原本955件の全SHAを確認し、現在の共通parser/serializerで955件すべて合格。上流GET・Notion読取・LLM・業務書込み0、約169秒、原本約724MB。保存列の合計867,636 bytes、1件最大914 bytes。D1の24読取で955件の文書・提出者・期間・latest active・旧NULLを確認 | これは固定母集団の資格確認。全市場の現在値や全欠測の解消を意味しない。原manifest不明860件を不明のまま保持 |
| 最初の10件の本番反映 | 原本をNotionから実体読戻し、全SHA・native期間・提出者・添付版を確認。21:01:15に理由列だけを単一D1 batchで反映。全17列のPOSTと物理PRE/POSTを検証し、既存16列を保持。実3画面に理由原文・文書IDを表示し、内部SHAは非表示 | 固定955件の残945件は未反映。数値・parse status・補足DB・原本manifestを変更していない |
| 権利処理の範囲 | #423の調整後終値必須化と#424の機能別監査をmainへ反映 | [権利監査](corporate-actions-20261016.md)の残件と#343を維持。18時runは旧`27709ccf`であり、新ロジックの定時受入ではない |
| 当日株式 | [18時実行38877553046](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38877553046)の当日更新3,646、完全成功3,645、失敗42。8303の過去RSI HOLD 1を含む | 残41の当日足欠測を0や前日値で補わない。部分成功を全量成功へ変更しない |
| 歴史RAW索引 | [同一poolの実行38891434050](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38891434050)で500件検証（新規473、既存27）、cursor10,182/78,832 | 残68,650・全範囲anti-join未完。次の同一pool実行38895798947が進行中。元結果不明・既存pool起点と上限を維持 |

## 費用・変更範囲と証跡

10件のsource資格確認はNotion読取37＋hosted10、約6.46MB・約72秒。理由反映はNotion読取26／mutation6／hosted2、D1読取3／atomic batch1。反映時の実測request body約40KB・response body約631KBで、headersや転送オーバーヘッドの総量ではない。PRE/POSTのgzip合計15,723 bytesを実体保存・全SHA読戻しした。追加有料API・追加モデル推論・数値の一括再計算は0。ローカル電力・ハードウェア費用は未計測であり、0円と断定しない。

NULL専用CASは実10文書の全17列で検査した。提出者名変更・既存理由の同時保存・文書削除の3負例でatomic rollbackを確認し、ネイティブD1応答4件と全列の変化を追加通信0で独立検証した。曖昧な応答を再送する経路は追加していない。

証跡はGit対象外の`tmp/feature-audit-20261016/`配下の`mac20-clef-journal-audit.json`、`mac-scheduled-final21-readonly-v1`、`omission-saved955-prepare-v2`、`omission-d1-scope-readonly-v1`、`omission-source10-readonly-v1`、`omission-reason10-apply-v1`、`omission10-live-ui-readonly-v1`に保持する。raw本文・signed URL・資格はGitへ追加しない。本文固定3,666件の受入と0030移行は[既存台帳](feature-recovery-20261014.md)を参照。
