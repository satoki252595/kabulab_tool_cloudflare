# 2026-10-16の追加受入

追跡は[#348](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/348)。この記録は以下の対象の実測であり、全20機能・全空欄の完了を意味しない。

## 10月17日01:10 JSTの追加確認

本文は固定776社中155社を独立受入、残621社。追加50社は通常機械処理で更新・全POST確認後、見直し台帳の送信日時がNotionで分単位になったため検証側が停止した。業務更新は再送せず、現在の全文・最新source・全39値/他props/根拠を読取確認し、01:05:29に物理POSTを閉じ、01:05:58にrootが全SHAと通常builderで独立受入した。残621社は別の固定13組で開始し、停止したrunnerの名前空間は再開していない。

追加50社の初回は1,297 native応答、業務PATCH50、194,558,826 response bytes。追加読取専用は401要求/書込0（監査のDB ID表記差で停止）と410要求/証跡保存3操作・業務書込0。合計2,108要求・Notion1,702要求の今回限りの復旧費用であり、通常定時へ同じ再読取を追加した設定ではない。モデル・上流APIは全0。独立監査では全50の通常publisher PRE、元全native、最終全nativeと物理PRE/POSTを照合した。生データと元停止記録を保持し、旧判定入力SHAの不明は変更しない。

通常処理の#436は00:40:20にmain `c75be568`、version `65cd3ec5-5bb7-42bd-a7ec-ce6b99e21deb`を配信。非Yahoo27取得元を先行させ、同runの両summary・全source成功を結合する。#438は00:49:58にmain `8dfe0e05`、version `57896b13-29fa-43b3-bfd0-f6bbb3826067`を配信。追加300ms待機を省き、実Yahooの共通1秒制御と10年取得・権利原値・期限を保持する。通信削減と待機条件は[容量監査](yahoo-shared-capacity-20261016.md)へ記録し、次回定時全量の完走・実料金は未受入。

#439の保有株価格の事前主体資格もmain `080cf156`へ統合し、01:09:15にversion `67e59d11-4dda-482f-bc99-63fbae6104a5`を配信した。有限windowを価格書込前に資格化し、確定する商号不一致を既知HOLDとして残す。ACK不明・原本破損は従来の停止を維持する。[実原本2例と検証](holdings-price-preflight-20261017.md)を参照。これを価格公開の完了に数えない。

RAW同一poolは00:39:23にrun38919797532が成功。500検証（新483・既存17）、cursor12,682/78,832・残66,150、上流GET0、Notion10要求、elapsed2,501,889ms。次の同一pool run38925685573へ継続した。全範囲anti-join・全20機能の最終受入は未完。

私有証跡は`A671-mechanical-remaining-v1/batch-01`、`A671-batch01-post-readonly-v2/{SUCCESS,root-independent-acceptance}.json`、`A621-finite-runner-v1`、`continuation/cf-main-{436,438,439}-logs.txt`、`continuation/job-117036506509.log`。最終POST gzip SHAは`310faa940044cffd6371d8450c204e92cf3211fa4c19f6ff4c61fe857755f0d7`。

## 10月17日00:36 JSTの追加確認

211Aの有報がS100WW30からS100Z7YEへ変わった1社だけを、配備済みmain `43d563a3`の通常writer/pipelineとローカル`Cloudflare/clef-flash`で00:32:39〜00:34:40に再判定した。公式重み・processor・較正と同じ入力7,395 tokens／6問に束縛し、spawn1・Noul1・実forward1、既存1行のPATCH1・判定済。native138（Notion128・hosted3・D1読取7）、121.829秒。外部LLM・上流API・D1書込・再forwardは0。

全67propsと本文39項目・旧根拠の退役・source原文と時計を確認し、外側PRE/POSTおよび通常publisher PREの3ファイルを実体読戻しした。00:35:45にrootが全native要求/応答のSHA、6 journal原本、通常replayと別の`processStock`による保存応答再計算を追加通信・forward・業務書込0で検証した。peak RSSは20,674,904,064 bytes、swap増分の表示上限は約0.31MiBで、32GiB／1GiBの実行予算内。ローカル電力・金額は未計測。この1社は本文同期776件に含めず、105受入・残671件を維持する。未知の旧判定入力SHAは後付けしていない。

実行前のcontroller v2は.env取得順で停止し、native・model・業務書込・新journalすべて0を確認した。通常writerのpreflight後にD1を構築するv3で単発実行し、元停止記録を保持する。私有証跡は`211A-clef-normal-once-v3/{SUCCESS,independent-acceptance,root-independent-acceptance}.json`。これは固定1社の受入であり、全20機能の完了ではない。

## 10月17日00:32 JSTの追加確認

| 対象 | 追加で受け入れた範囲 | 残件 |
|---|---|---|
| 事業タグ本文 | 現在の原文から追加50社を00:05:53〜00:17:34に通常機械処理で同期。固定776件中105件を受入 | 残671件は固定14組の計画のみ。211Aの入力変更再判定と旧skip99の判定入力検証は別 |
| 保有株式の原本列 | 通常CLIで残46行を00:10:06〜00:17:11に反映し、先行100行と合わせて固定7文書146行を検証 | 価格7文書は未受入、原表不在3文書をHOLD。原本と未照合の旧16行は全値・時計を保持し、146行へ含めない。全市場の公開完了ではない |
| 通常処理の負荷 | #435で銘柄指定を最新文書照合SQLの内部へ渡し、済みprefix・全完了時の原本再照合を追加。#437で資金フローの同一値確認を50キーずつに集約 | 資金フローPhase1への接続・Yahoo共有排他の範囲調整は#436で確認中。次の定時全量の成功は未受入 |

本文の追加50社は2.0rpsでnative1,324応答・184,537,573 bytes、業務PATCH50、上流API・モデル0。00:18:25に全応答のSHA、39列・他props・根拠・source版と物理PRE/POSTを通信0で独立照合した。保有明細46行は旧37・新9、native277（Notion254・hosted10・D1読取13）、425.240秒、要求1,334,832／応答7,721,633 bytes、実mutation73。全7文書146行の最終照合、物理3組、未照合旧16行の不変を00:20:55に独立確認した。価格・上流取得・モデル・D1書込は0。

銘柄指定7件の最新文書照合は同じ結果のままD1 rows_readが1,199,527から330へ、durationが2,193.21から7.3868msへ減った。資金フローは保存済み実669行を通常比較関数で純ローカル確認し、同値の週次448行の論理照合を448回から9回へ削減した。過去221行のうち異なる187行は通常の個別再確認へ戻す。これは通信回数の計算であり、実HTTP成功や当日の全量受入を作っていない。新依存・追加モデル・有料APIは0。

Cloudflareの通常main配信も確認した。#433は00:05:12にversion `cc832d6f-fd99-46fb-9df8-5284d297d0f3`、#435は00:11:25に`d7c9b3a5-9e4f-419c-9de9-34a02c501a34`、#437は00:24:51に`411d6c88-b2ab-4767-a0e4-aa15dd1d0443`。CI成功と実deployを区別し、新しい定時全量の受入は継続する。

私有証跡は`A50-current-source-mechanical-common-v1/{SUCCESS,independent-acceptance}.json`、保有明細の`apply46-v1/{independent-acceptance,root-independent-acceptance}.json`、`continuation/cf-main-{433,435,437}-logs.txt`。全20機能の最終受入は未完。

## 10月17日00:06 JSTの追加確認

- 本文は追加50社を23:47:54〜00:05:03に共通`withBiztagWriter`/`runBiztag`で反映し、先行5社と合わせて固定776件中55件を受入、残721件。追加50社は全1,300 native応答・198,853,194 bytes、39列・他props・根拠・最新sourceと物理PRE/POSTの全SHAを00:05:34に通信0で独立再検証した。全工程はNotion上限1.2rps、通常pipelineは694要求・653.853秒、モデル/上流API0。次の50社は現在の実source原文とメタデータから検証する有限実行中で、55件へ加えていない。
- #433をmain `241f06ed`へ統合。生成SQL `0031_stock_adjusted_point.sql`を23:49:22に1回だけ適用し、旧3,767行の全38列・全索引を保持、新39列目は全行NULLと確認した。物理PRE/POSTとnative8読取/1DDLの全文SHAを独立照合、再送・指標値更新・取得元・モデル0。保存済み8303の同一Chart/Summaryから、通常parser→snapshot→indicatorの同一adjclose/SMA→月次MA比較/scoreをacceptedmainで純local確認した。列追加を過去値の充填や次回定時/月次全量の成功に数えない。
- #432のCron分精度修正はmain `c983d7b1`の通常build `cfe5e679`で23:57:15に実deploy、version `2a60e9c6-f885-45f0-b908-21a302d79176`を確認した。予定17:00:52を同じ17:00分として扱い、実受付17:10と新規開始23:30の期限を保持する。元の17時失敗と次回定時全量未受入は変更しない。
- RAWの同一pool run38914482437は23:56:10に終了。500検証（新規484・既存16）、cursor12,182/78,832・残66,650、上流GET0、Notion10要求、38分弱。次run38919797532が進行中。元manifest・起点・上限・結果不明は保持する。

残権利の追加確認では、保存済み7203/8303の各1,221本を通信0で読み、双方の直近130本中119本でcloseとadjcloseが異なり、配当原イベントを確認した。差だけから通常OHLC/ATRを無効化したり、価格へ係数を再適用したりしていない。8303の2023年9月28日の併合原値は直近窓外。現Chart OHLC/volumeの株数基準、直近の分割をまたぐ原本、増資・新株予約権・会社分割の効力日/株数履歴との連結は未証明で[#343](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/343)を継続する。参照: [Yahooの調整済み終値の説明](https://in.help.yahoo.com/kb/adjusted-close-sln28256.html)、[JPXの権利処理](https://www.jpx.co.jp/equities/trading/margin/rights/02.html)（確認日2026-10-17）。

追加の私有証跡は`A50-normal-mechanical-common-v1/{SUCCESS,independent-acceptance}.json`、`continuation/cf-main-c983-logs.txt`、`continuation/job-117018352250.log`。0031は`.runtime/yutai-ma-basis/source-v1/tmp/yutai-ma-basis/{pre-schema-v1,apply-schema-v1,final-main-replay.json}`に全原本と元の監査停止を保持する。全20機能・全欠測の最終受入は未完。

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
