# Yahoo共通排他と定時処理の容量監査 (2026-10-16)

保存済みの実ログと修正前main `c983d7b1989efafaed2de655b4e79312816224ec` の通常コードを照合した監査。新規本番GET・取得元GET・dispatch・本番書込・モデル呼出しは全て0。Nixで標準Nodeのみを実行した。**全量完走・期限内完了を証明する受入結果ではない。**

## 実際の期限と排他の順序

| 処理 | 予定dispatchと実受付 | 本体の期限 | 期限readcheck |
|---|---|---|---|
| MWF VWAP | CF 17:00 JST。通常CLIの日足入口は実時計17:00〜17:10を検証し、同runのintraへ元の受付時計を継承 | 23:30より前だけ新規Yahoo取得・価格PUTを開始 | 23:35照会。通常日足+intra stepが17:00〜17:10開始、23:30までに一意に成功完了 |
| 株式 | CF 18:00 JST、POSTは予定から60分以内。本体は予定日の一致と15:30〜翌06:00の開始窓を検証 | 翌06:00 JSTで新たな書込を停止 | 23:35照会。stock stepが同日18:00〜23:30に一意に成功完了、許容内失敗の通知stepもskipが必要 |
| 独立moneyflow | CF 18:15 JST、POSTは予定から60分以内。現CLIに定時の実開始窓はない | 現CLIは通常jobの120分timeout | 23:45照会。独立ingest job/stepが一意に成功し、step完了が18:15〜23:40 |
| 翌朝context | CF 翌06:00 JST、POSTは30分以内。本体の実開始窓も06:00〜06:30 | 翌07:00 JSTまでの保存 | 翌07:05照会。予定日・元のJP leg・米原本・専用context stepの成功と期限を検証 |

根拠は `src/shared/vwap-schedule.ts`、`scripts/vwap/lib/scheduled-window.ts`、`src/shared/stock-sync-window.ts`、`src/cron/daily.ts`、`src/scheduler/stock.ts`。**株式に「18:10を超えた実開始を拒否する」guardはない。** CFでのPOST受付と、Actionsが共通排他を取得してから実際にsourceを開始する時刻は別である。株式の翌06:00書込期限は、23:30までのreadcheck成功を代替しない。moneyflowも翌00:00完了では23:40条件に通らない。

各workflowの `yahoo-source` はjob単位の排他である。

- `vwap-ingest.yml` の `ingest`: setup→日足10y全量→intra5d全量→一次原本保管/条件付PUT/summaryまで同じjobが保持。日足とintraの間も解放しない。
- `stock-sync.yml` の `sync`: 共通排他を取得してからsetup/stock producerを開始する。成功時のsector33用Nix setup/同期も同じjob内。後続のreusable moneyflowはsync jobの終了後に呼ぶ。
- `moneyflow.yml` の `ingest`: 独立28取得元とNotion原本保管/観測ログ確認の全体を保持。株式後のsector-turnover単独でも同じjob排他を取る。

`queue: max` / `cancel-in-progress: false` を維持した。これは同時Yahoo取得を許可する設定ではない。今回、複数待機jobの実行順・先行margin/手動job・queue取得時間は観測していないため、FIFOや「必ずVWAP→株式→独立moneyflow」とは扱わない。VWAPのGH信用残cronも平日17:00 JSTにあり、同じworkflow/groupの競合候補だが、定時に先行した場合の所要は未測定。翌朝contextも共通Yahoo job groupとstock-syncのworkflow groupの両方を待ちうる。夜間のproducerが翌06:00まで生存できることから、朝contextの実受付が守られるとは推定しない。

## 保存済み実測

| 取得元 | 観測した所要 | 結果と限界 |
|---|---:|---|
| 10/14 VWAP run `38547185176.1` | job 181.5167分、日足124.9425分、intra部分56.1211分 | 日足3632 written/54 error。intra1823 written/7 skipped/1 rate limit/1855未着手。全量成功ではない。PUT2変更前、registry正常有効化も未測定 |
| 10/16 stock job `116896150290` | ログ観測141.3285分、本体141.0400分 | 成功3645/失敗42/RSI履歴HOLD1。失敗したため、健康なrunのsector33/連鎖処理を含む全lock所要ではない |
| 10/16 independent moneyflow job `116901766737` | ログ観測63.2079分 | 28/28成功。global-indicesは221行同値・Yahoo再取得0。全体で4594行の既存同値確認を記録。source別の所要・Notion通信数はログにない |
| 10/16 local Nix intra pilot | 100社157.948秒＋次100社158.708秒 | 200社の正常source/原本保管/CAS/独立POST確認済み。Mac/Notion0.6rps/固定scopeの実測で、Actions全量速度の代用ではない |

stock/moneyflowは最初〜最後のログtimestamp差であり、job lock取得前・未記録setupを含む全占有時間とは主張しない。両者間のqueue取得差も外挿に加算していない。

3687 active社の日足とintraを各1回ずつsource取得する場合、少なくとも7374 chart要求が必要。共有clientの1秒間隔だけでも、別Node processである日足/intraをそれぞれ `(3687−1)` 秒と数えて122.8667分が必要である。認証・benchmark・応答待ち・R2・CPU・Notion・registry・setupは含まない。同一sessionの正規完了証拠による日足source前skipがあれば要求数は減るが、次の新sessionにその全量skipを仮定しない。

## 現排他を維持した場合の必要条件

以下は **他の待機0、VWAP-first→株式→独立moneyflowの順** という条件式である。所要を測定していないintra残1856社を実測済みとして足さない。今日のstock/moneyflowログ観測を仮に次runへ代入した比較であり、完了予測ではない。

| VWAPの実入場 | 株式23:30条件のためのVWAP全job上限 | 独立moneyflow23:40条件のためのVWAP全job上限 |
|---|---:|---:|
| 17:00 | 248.67分 (`390−141.33`) | 195.46分 (`400−141.33−63.21`) |
| 17:10 | 238.67分 | 185.46分 |

追加のsetup・sector33・registry・信用残・queue待ち・障害余裕は全てこの上限から差し引く必要がある。moneyflowが株式に先行する場合、株式23:30にもその占有を足す必要があり、上の株式だけの緩い上限は使えない。

- 旧intra部分の速度を全3687社へ機械的に外挿した**非実測の比較例**: intra113.07分、日足/当時setup込みVWAP238.36分、株式まで379.69分、独立moneyflowまで442.90分。17:00基点なら株式だけは条件内の例だが、独立moneyflowは400分の条件を42.90分超える。
- 別の**非実測の比較例**として、Mac200社の速度を全量へ外挿するとintra97.29分。旧日足と合わせたVWAP222.24分＋今日stock/moneyflowで426.77分。ホスト・Notion rateが異なり、こちらも全量測定ではない。

従って「18時株式が遅れる」ことだけを修正理由にはしない。一方、現在の保存実測から共有lockのまま3処理全てが期限内に通るとも証明できない。PUT2の全量改善、残intra全量、正常registry、正常stock後段は未測定である。分間隔緩和・Yahoo並列化・期限延長・未取得日の補完は行わない。

## 今回の最小共通変更

独立28取得元のうちYahoo実取得を使うのは **global-indicesだけ**。`services/moneyflow/lib/sources/global-indices.ts` の固定16銘柄を `adapters/global-indices.ts` が直列で各1回取得する。保管済み週バッチなら `scripts/moneyflow/lib/run-spec.ts` が保存原本を再解析し、Yahoo GETは0。10/16はこの0 GET経路を実際に通った。他27取得元にはYahoo clientの呼出しがない。

全independent jobの排他を無条件に外すと、未保管の週に16 GETが株式/VWAPと重なるため採用しない。既存source選択を使い、**global-indicesだけ共通Yahoo jobに残し、他27を非Yahoo jobへ分けた**。非Yahoo jobの正常summaryを同runのartifactで渡し、Yahoo jobが最後に両summaryの集合をjoinする。global-indicesの16要求と原本物理保管・全行確認は維持する。新しい取得元、頻度、依存、LLMは不要。株式後のsector-turnover/手動非Yahoo subsetだけの場合はYahoo排他を取らない。各lane内の既存source相対順・sector-turnoverのproducer trade_dateを保持する。

workflowの行を分けるだけでは不十分なため、次の既存境界も変更した。

- `--only` の正本一覧から対象を厳格に分割し、未知/重複/漏れ/二重取得を拒否する。manualの複数source指定も同じ規則を使う。
- moneyflow readcheckの `jobs.length === 1` を両producer job/stepとjoin stepの一意成功・実順序・23:40完了へ変える。join CLIが同run/同attemptの実summaryから、選択scopeの過不足0・全outcome成功を検証する。片側skip/失敗を全28成功にしない。Jobs API読取回数は増やさない。
- CF payloadに元の `scheduled_date` を渡し、両producer入口とsource間・joinで実18:15〜23:40を検証する。queue待ちで23:40を超えたglobal jobはcatalog/source前に停止する。日付や受付時計を置換しない。
- 既存 `setNotionMaxRps()` と同じnative試行pacingに、通常CLI用typed optional `NOTION_MAX_RPS` を追加。未指定380msを保持し、既定超・不正値はnative0で拒否する。先に狭くした明示bulk予算を環境値で緩めない。summaryには既存 `notionStats()` を記録し、通常VWAP/stockも終了ログに同じ実カウンタを残す。計測のための追加HTTPはない。
- all-unchanged/失敗原本/条件付更新/全行同値/物理Notion原本を維持する。source種別の回帰でglobal-indices以外からYahoo経路へ出ないことも検証する。

全VWAPの分割、Yahoo queue刷新、vendor spacing変更は含めない。定時の初回全量で、queue取得/両producer所要/Notion実要求数/原本保管/全行同値/23:40 joinを測って初めて運用受入する。

## Notion予算と未測定の背景処理

旧stock/VWAPログにはNotion要求数が記録されていない。2.0rpsへ制限する場合、元380msとの差は1要求あたり最大120msの追加待機という条件上限までしか出せない。実HTTP遅延・CPU・既存間隔に隠れる部分は不明であり、任意の速度向上/低下を全量へ仮定しない。

独立moneyflowは、今日のglobalを除く同値4373行＋変更1707行だけでも旧方式は少なくとも `4373 + 1707×2 = 7787` Notion要求。source/物理保管/catalog/postverifyを除いても0.7rpsでは185.40分となり、120分job timeoutを超える。従って低rateと分離だけを対策にはしない。先に通常の共通batch precheckで完全同値だけをbounded natural-key OR queryにまとめ、変更/欠落は従来のfresh per-key upsertを維持する。全量の要求数/所要は修正後の実カウンタで確認する。

| 同時に動きうる処理 | 時刻/現在のrate設定 | この変更での扱い |
|---|---|---|
| VWAP/stock/context、Yahoo側moneyflow | 17時MWF/18時/翌06時。修正前Nodeはprocess内約2.63rps、sector33 Pythonは2.5rps | 共通Yahoo排他の1jobにNode/Python2.0rpsを設定する候補。Yahoo spacing/並列数は不変 |
| 非Yahoo moneyflow | 18:15独立、stock後sector-turnover、手動subset | 0.7rps候補。低rate単独では上記120分超なのでbatch改善と併用して検証 |
| Node catchup | 平日19:00、初回<=19:05/19:59まで。既存380ms | このPRでrate/timeout/scheduleは変更しない |
| Python tdnet_hourly | 09〜19時毎時、GHイベント遅配がありうる。`NOTION_RPS` 未設定なら既存2.5rps | 30分job timeoutを一律低rateで壊さない。実Notion要求数/他jobとの重なりは未測定 |
| Python edinet_daily | 21:00、同じくGHイベント遅配あり。既存2.5rps | 120分timeout・scheduleは維持。重なりと実要求数は未測定 |
| Python ops_check | 23:30、既存2.5rps | 15分timeoutを維持。主にD1 readだがNotion要求数の実測はない |
| 手動raw/backfill・Mac writer | 実行ごとに異なる。CLI明示予算があるものもある | 定時と重なる場合の合計rateを個別releaseで確認する必要がある |

`Yahoo側2.0 + 非Yahoo0.7 + 背景予約0.3 = 3.0` は**予算表であり、背景の実上限制御ではない**。現在の背景処理は0.3rpsに自動制限されていないため、ワークスペース全processの合計<=3rpsを保証しない。広範なschedule/timeout変更や新broker/DOをこの問題の代用にはしていない。bulk改善の保存native照合と通常callerの要求数差、次全量のactual statsを根拠に配分を決め、未観測の全量正常稼働はHOLDのまま扱う。

## 証跡

生ログ・原本・秘密はGitへ入れない。ローカルprivate集計は `tmp/feature-audit-20261016/yahoo-capacity-offline-v1/result.json`、SHA-256 `133daec518a4afd01249bb46fd8ee674f46852e2939ba4016fc24cc22481c50e`。

| 保存済み入力 | SHA-256 |
|---|---|
| `tmp/feature-audit-20261013/vwap-put2-code-v1/capacity-source-only.json` | `5974d987182b4ad449ff897df5d29691216f98d108ccea0af922b72f5867d73d` |
| `tmp/feature-audit-20261016/continuation/job-116896150290.log` | `7de01b36ef92c9e9e0d7428f9110fd908db62149ddfbe05eb6cef71700006821` |
| `tmp/feature-audit-20261016/continuation/job-116901766737.log` | `206371d17681d2992e2ffdeb863b776da3be6c93b2785549daa13cfed2781003` |

10/16に独立受入できたintra200社と残1656社は [200社の受入記録](./vwap-finite-start-budget-20261015.md) を参照。通常17時は実Cronイベントの秒をミリ秒完全一致で拒否した別障害で、#432で共有minute guardを修正した。200社受入もこの修正も、次の通常17時全量の成功証拠にはしない。
