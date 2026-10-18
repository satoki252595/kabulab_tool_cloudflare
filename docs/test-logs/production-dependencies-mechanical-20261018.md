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
