# 定期処理の先行関係と機械処理の標準

確認日: 2026-10-18。[全16処理の一覧](../production-job-inventory.md)に先行条件と本番LLM利用を追加した。データ上の依存と、Yahoo・保存先・API予算による排他を分ける。

## 変更と検証

- 資金フローの非Yahoo27取得元とYahoo1取得元はデータ上は独立している。共有Notion枠が未成立のため取得は非Yahoo→Yahooを維持し、joinを両lane成功後の別jobに分ける。共有joinとWorker監視も直列前提を除き、同run/attempt・全source・各実時計・期限を維持する。監視は両producerとjoinの3jobを確認し、join開始が両producerの完了以降であることを要求する。
- 欠落・部分失敗・結果不明を成功にしない。Notion枠1.0/1.6rps、Yahoo共通排他、取得元集合を維持する。初回の空DB/schema構築は既存単一CLIで直列に済ませる。
- 優待要約はモデルなしを既定とし、未対応は理由付きHOLDで旧値・時計を保持する。機械処理と手動の明示`--allow-model`は同じ金額資格・PRE/CAS/POST・pending latchを通す。定期・月次入口は明示許可を渡さない。
- 指定済み事業タグの適格新規・入力変更に限るローカルClef例外は維持する。競合の自動意味判定は再開しない。

Nix Node22.22.2 / pnpm9.15.9で資金フロー関連5suite・165件PASS、最後のcatalog非交差assert追加後のsource-summary 8件もPASS。優待関連8suite・116件PASS、既存private原本未配置の4件はSKIPで、新default/明示許可の検査は全実行した。ルート型検査・対象lint・差分検査も通過。両担当による相互FSレビューのblocking指摘は0。

優待の私有検証receipt: `tmp/feature-audit-20261018/yutai-mechanical-default-proof-v1/review-ready-v1.json`、SHA256 `9e77b45039d4c4246a5fa1629418738e49113241542e7ffeb40fdf129eaa3271`。

## 費用・本番受入の境界

取得元API・モデル呼出し・新依存は増やさない。資金フローはjoin用runnerのsetupとartifact転送が増える。実請求額と時間短縮は未測定であり、並列化だけで効果を保証しない。優待の機械HOLDも未完として非0終了し、成功件数に加えない。

月次は母集団→優待原文→再計算の順とし、保存財務・スイングを使い、MA乖離比較だけ財務日と指標日の一致を要求する。不一致でスコア行全体を停止せず、当該比較を保留する。当日18時の未来の取得を先行条件にせず、欠測を値で補わない。月次CLIのexit0を全銘柄の財務充足とは扱わない。

コード受入・Cloudflare配備、Mac専用runtimeのquiet切替、次の自然calendar成功は別の受入。SSHの稼働中価格補完はmain527に固定し、今回のローカル変更を途中反映しない。OS設定だけのHTTP0切替にSSH価格writerの停止待ちは加えない。

## 共有Notion枠の追加監査

共有Node clientのpacingはprocess内、Pythonはclient instance内であり、跨process/hostの全体制御はない。catchupは既定380ms（約2.63rps）、Python TDnet/EDINETは既定2.5rps。Mac095/529のprivate設定にも`NOTION_MAX_RPS`は無い。18:15資金フローと19時開示・20/21時Mac等は重なり得るため、1.6+1.0+背景0.3=2.9を全体保証とは扱えない。

追加の取得並列化を見送り、既存のlane rate・直列取得を維持する是正を行った。別joinと3job受領、同run/全source/実時計の厳格性は維持。対象workflowのNix 1suite/1testもPASS。全actorの一斉低rate化や新しい分散limiterは追加しない。既存job間の429待機の可能性と性能実測は未解消であり、値だけで安全・短縮済みとは記録しない。

財務断面41社は旧10/16の通常5年chartとQuoteSummaryが保存済みだが、当日バー欠測で通常資格が成立しない。新10/18の10年chartを旧QuoteSummaryと黙って混ぜず、適用済みOHLCVと分離する。通常株式CLIにcodes限定入口はなく、単純filterは全市場シグナルの掃除を伴うため追加しない。保存物だけの財務/RSI復旧は未受入。新vendor・LLM・追加DB書込0のFS監査である。

## Macの機械要約を定期環境へ反映

main529 `7f26a9dd9a0228084b870ff1fec6ef2162142e51`はPR3checks・main CI `39102821068`とも成功。Cloudflare build `37ad4475-62e6-48ab-a8ba-92dafbb2550e`の06:06:56 UTC配置ログでversion `d917430b-968f-4984-a0cd-574e9a2d4ee6`と設定同一の10triggerを確認した。私有受入 `tmp/feature-audit-20261018/product-main529-acceptance-v1.json`、SHA256 `516423df458b1c75e8c9e909c092388ac7c79ce5b9cd07a6ef39cc8ec8303d18`。

15:12 JSTにMacの20/21時2labelを同mainの専用runtimeへ切り替えた。旧41設定のうち承認revision以外40値同一、両lock・同じNode22/Nix・recipe14を照合。通常preflightと要約parserの既定`allowModel=false`、定期引数に明示許可がないことを実確認した。

quiet切替は通常`install-next`2回を含む11commandを11.793秒で完了。両plistの全文・`RunAtLoad=false`・元20/21時・停止/PID0、全owned子とkernel閉鎖を確認した。provider/Notion/D1/R2通信・モデル・業務書込0。旧env/runtime/plistと全記録を保持し、稼働中SSH価格writerを止めなかった。

私有受入 `tmp/feature-audit-20261018/mac-mechanical-main529-quiet-cutover-v1/root-final-acceptance-v1.json`、SHA256 `6c5255c351f7b56e5aa3ecdbd56599bb4af6e0224ae66a6efdbc06046792c9ca`。自然20/21時の成功をこのOS設定変更で代用しない。workflow/docsのみの後続変更へMac runtimeを再切替しない。

15:14にはGitHubの既存監視設定`BIZTAG_LOCAL_ACCEPTED_REVISION`も、実配備済み529の完全SHAへ更新し、native ACK0と設定更新metadataを確認した。自然成功を期待SHA更新の前提にすると新receiptを旧SHAで拒否するため、配備の確認と自然実行の成功を分ける。終了code0・予定開始5分・終了30分・同一SHAの判定は変更せず、旧receiptを書き換えない。公開revision設定1件だけの更新でAPI tokenの変更・読出しは0。私有受入`expected-revision-acceptance-v1.json`のSHA256は`fc3cea9b52d13c02c64125c8be78af5c70a5bc4c3fc1d0bd11c119bfdd48f97b`（上記Mac private directory内）。

## 定期環境と本日分の再確認

15:56〜15:57 JSTにGitHubの14 workflowが有効、実行中・待機0、Macの2labelが登録済み・停止/PID無し・20/21時予定・無効override無しであることを再確認した。意図的に停止しているのは不要な全履歴RAW補完で、再enableやOS再設定は不要だった。競合の自動意味判定の停止も維持する。

main530 `e976582a600ebd3cda1487874810e1da19f93d40`のmain CI `39103688793`は成功。CF build `206eedc3-df81-4299-a886-2de9b8acaece`の配置ログでversion `0a471f78-4e65-41dd-a71e-a368de4904bb`と設定同一の10trigger登録を確認し、15:56のbuild一覧も同じ成功版だった。私有受入 `tmp/feature-audit-20261018/product-main530-acceptance-v1.json`、SHA256 `ac4c9fc5329e4254023fad1b5bc7ac49952b333a52279200d0159b863fb4bd7e`。live設定APIの再確認は403で未成立であり、配備ログの確認範囲と分ける。

今朝の`ops_check` run `39053713321`は財務価格・指標・モメンタムが各3,646/3,687、旧IR原本1279652が1件未保管の4検査で失敗した。OHLCV41件の追加をこの3断面の充足とは扱わない。鮮度観測8件・schema・ライセンス検査は成功で、旧期待revisionや有報の主体未解決はこのrunの失敗原因ではなかった。

本日は日曜なので株価の最新対象日は10/16。全市場の株式・VWAP・マクロや月次を再実行せず、必要な当日公表確認を本番と同じNix・通常Python入口で実行する。共有Notion枠がないため、SSH価格の正常window閉鎖後だけTDnet→EDINETを順次実行する。Pythonの`NOTION_RPS=2.5`を専用envに明示し、Node用`NOTION_MAX_RPS`をPythonの制御値と誤認しない。

16:05のTDnet初回では検証済み0件一覧・派生3添付のNotion全バイト照合が成功したが、旧ローカルR2資格でのraw HEADが403となり、PUT前に停止した。D1には失敗の実行履歴を記録し、EDINETは起動しなかった。旧STOP・原本・envを保持し、観測した2プロセスのPID/開始時計の閉鎖を独立確認した。これは既知の読取拒否であり、結果不明の書込を再送する根拠にはしない。

保存先の名前は同じ`jp-stock-raw`で、既に読取受入済みのSSH資格との違いを特定した。既存SSH資格のR2設定だけを新しいローカル専用envへ安全に受け取り、SSH/canonical/旧envと既存GitHubキーは変更せず、資格値を出力しなかった。16:10に通常Pythonの既存実在原本へのHEADが成功した。キーの新規発行・ローテーション・仮PUT/DELETE試験は行っていない。

16:12:49〜16:13:01 JSTに同じ通常TDnet→EDINETを新資格で1回ずつ実行し、双方exit0・processed0/failed0で終了した。TDnetは同じ原本SHA・既存Notionページを再利用し、EDINETも日付10/18・正常status・件数0・空results・公表側処理時計を検証した。これは観測時点の0件であり、当日全体の確定・Nodeの未解決16件の解消とは扱わない。

原本・派生6ファイル合計1,779Bの保存SHA、Notionの3添付ずつの全バイト照合、R2の6 PUT正常ACKログ、D1索引・実行履歴の通常成功経路、68 source/lock pinsと旧env保全をFS照合した。4つの観測PID/開始時計も独立に閉鎖確認し、SSH価格39窓目から元の期限・設定で再開した。全体12.578秒、通常本体はTDnet4.3秒・EDINET5.6秒。モデル呼出し0。native要求数・実費・再試行数は未測定、D1全ACK bodyの保存とR2独立再GETは行っていない。

私有受入は`tmp/feature-audit-20261018/python-current-day-source-jobs-20261018-authorized-r2-v2/root-final-acceptance.json`（SHA256 `f67a2cd3381c3d9d6cd6cd9d12a0dc4c9d704ceb07ebc6b15baaac819cd3a7c5`）、独立保存物照合は同directoryの`delegate-saved-acceptance.json`（SHA256 `4a03b3a60b20c9012ba3ba28c861f596800650187c496486bdcdcd9a750bdf6b`）。旧STOPを変更せず、資格修正の根拠と新しい通常観測を別に保持した。
