# 2026-10-16の追加受入

追跡は[#348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。この記録は以下の対象の実測であり、全20機能・全空欄の完了を意味しない。

## 23:50 JSTの追加確認

| 対象 | 追加の受入 | 残件・制限 |
|---|---|---|
| 保有株式の原本列 | main `59dd527e`の通常CLI/publisherで先行100行を23:33:32〜23:45:56に反映。旧59行と新規41行、全467 native応答・要求のSHA、全POST、旧5列・他props保持、4組の物理PRE/POSTを検証 | 固定10銘柄の準備範囲は原本HOLD3・残46行。価格は未確定で、全市場の公開完了ではない |
| 事業タグ本文 | main `43d563a3`の通常`--mechanical-only`で先行5社の39項目を同期。旧タグ・根拠・判定日・未知の旧入力SHAを保持し、全233 native応答と物理PRE/POSTの全SHAを確認 | 固定776件の残771件。続く50件は実行中で、完了数へ加えない。旧skip99は旧判定入力の検証完了ではなく、211Aの実入力変更判定も別途必要 |
| VWAP 5分足 | [有限通常CLIの200件](vwap-finite-start-budget-20261015.md)で原本・旧履歴・全R2 POSTを独立照合 | 固定残1,656件と日足3件のHOLD。次30件はPREのみで、期限後のsource/PUTは0。定時全量の受入は未完 |
| 共通株価計算 | #430をmain `c1ad90e2`へ統合し、Cloudflareの通常deploy/versionを確認。移動平均とトレンド・モメンタムの比較を同じ受領調整済み終値へ統一 | 次回定時の再生成は未受入。月次優待MA成分の同一snapshot対応と権利処理全体は別途追跡 |
| Mac配備 | 23:27:12にmain `43d563a3`へ切替え。既存calendar・共通排他・同一依存lockと旧049/277原本を保持 | 新runtimeでの次回20時・21時の実receiptは未受入 |
| 歴史RAW索引 | run38906853023が23:16:47に500件検証（新規486・既存14）、cursor11,682/78,832・残67,150。次の同一pool run38914482437が進行中 | 全範囲anti-joinは未完。元pool起点・最大200run・結果不明記録は保持 |

保有株式100行の実測は743.05秒、Notion440要求・hosted17GET・D1 SELECT10、要求9,019,320 bytes／応答21,357,935 bytes、実mutation146。内部guardのwrites148には検索POST2件も含むため、業務mutation数と区別する。原本取得API・モデル呼出しは0。文書ごとの全母集団走査を、銘柄コードを内部CTEへ渡す最小修正で軽くし、残windowの済みprefixと全完了時の再照合を補強してから次へ広げる。

本文5件は通常CLIの成功サマリ後に`process.exit(0)`が親controllerも終了させたため、保存を再送せず別の読取専用処理で全39値・旧props・根拠・最新sourceを照合し、23:46:45に物理POSTの全文読戻しを閉じた。元200応答と追加33応答の全bytes/SHAを通信0で再検証した。続く有限補完は同じCLI option契約・`withBiztagWriter`・`runBiztag`を直接使い、終了後の独立検証を行う。別の取得・抽出・更新ロジックは作らない。

私有証跡は`tmp/feature-audit-20261016/A5-normal-mechanical-pilot-v1`、`A5-normal-mechanical-post-readonly-v1/{SUCCESS,independent-acceptance}.json`、`continuation/mac-mechanical-rollout-v1/SUCCESS.json`、`continuation/cf-main-c1ad-{build,logs}.txt`。保有明細は`.runtime/holdings-production-finish/source-v1/tmp/holdings-pilot-20261016/apply100-v1/{SUCCESS,independent-acceptance,root-independent-acceptance}.json`。秘密値・原文・署名URLはGitへ入れない。全20機能の最終受入は引き続き未完。

## 22:55 JSTの追加確認

| 対象 | 確認結果 | 残件・制限 |
|---|---|---|
| 固定955件の海外売上省略理由 | 21:09:22〜22:22:06に残945件を32回のNULL専用atomic batchで反映。先行10件を含む955件の最終D1再読込で、同一理由955・NULL0・差異0・latest active955を確認。22:55の追加検査でも全17列のPOST、他16列の保持、原manifest不明860件の保持を確認 | 固定955文書の理由列の完了。海外売上の数値全体・全市場の欠測解消とは区別 |
| VWAP日足4銘柄 | 5271・6092・7075・8303を21:17:01に復旧。保存済み10月14日原本を使用し、各R2オブジェクトのETag条件付き単発PUT、全POST、原本の観測時計・株式イベント、物理PRE/POSTを確認。21:18の追加検査も合格 | 当日16日の履歴完了ではない。株式指標・RSIは変更していない。残3銘柄の日足HOLDと5分足の残件は維持 |
| 旧A876件の新しい読取専用計画 | 21:20:33〜21:24:29に本番共通planWorkで固定876件を再確認。skip99・機械的本文同期776・入力変更確認211Aの1件。63要求（Notion59・D1 4）、応答約17.6MB、書込・上流取得・モデル呼出し0 | 776件は同期未反映。skip99は旧判定の入力SHA検証済みを意味しない。期限切れ旧Aの名前空間は再開せず、211Aの再判定も未実施 |
| 資金フロー | [本番実行38879272134](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38879272134)が21:25:41に28取得元すべてokで完了 | 未公表の区分・期間へ値を生成しない。全履歴の充足とは区別 |
| 歴史RAW索引 | [同一poolの実行38900645519](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/38900645519)が22:18:29に500件検証（新規485・既存15）、cursor11,182/78,832・残67,650、上流GET0。次の同一pool実行38906853023が進行中 | cursorは既存確認も含む進行位置であり新規登録件数ではない。全範囲anti-join未完。元のpool起点・最大200runを変更していない |

945件の反映と最終955件読取の合計は7,154要求、うちNotion5,993要求、hosted本文718,702,277 bytes。最大11,000要求・Notion10,000要求・3時間の元予算内で終了した。各batchは実対象のSQLiteによる通常成功と提出者変更・既保存・文書削除のrollbackを確認してから単発反映した。追加有料API・モデル推論・上流原本再取得は0。これは通常の差分取込に加えた今回の復旧コストであり、毎回955件を再走査する設定ではない。通信headers・ローカル電力・金額は未計測。

追加検査は保存済みsourceのnative応答4,711件、D1反映時のnative応答132件、最終D1応答24件の全本文SHA・bytes、32batchの個別差分と累積計数、全PRE/POST gzipのSHA・内容を通信0で照合した。物理hosted proofの実体読戻しは各writerで検証済み。Notion応答の全件がローカルへ保存されているとは主張しない。追加検査の初回は行順比較、2回目は累積計数の二重加算で監査側が停止し、元の監査と停止理由を保持した。行の一意キー・全件数・全値と個別IOの累積照合へ修正した3回目で合格し、この追加検査で業務書込は行っていない。

私有証跡は`omission-rest945-finite-v1/independent-acceptance.json`（SHA256 `3671536408ce68a54e7c724c04328feadb206436eeb4f14c4238476df38cf45d`）、`omission-rest945-final955-readonly-v1`、各`omission-rest945-v1-source-bNNN`／`write-bNNN`、`vwap4-saved-cas-v1`、`A876-live-plan-readonly-v1`、`continuation/latest-workflow-acceptance-2255.json`に保持する。いずれもGit対象外の`tmp/feature-audit-20261016/`配下。保有明細の全量公開・事業タグ同期・VWAP残件・[権利処理](corporate-actions-20261016.md)・全20機能の最終受入は未完。

## 21:02 JST時点の記録

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
