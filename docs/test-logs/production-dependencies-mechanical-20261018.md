# 定期処理の先行関係と機械処理の標準

確認日: 2026-10-18。[全16処理の一覧](../production-job-inventory.md)に先行条件と本番LLM利用を追加した。データ上の依存と、Yahoo・保存先・API予算による排他を分ける。

## 変更と検証

- 資金フローの非Yahoo27取得元とYahoo1取得元は独立して取得し、joinだけ両laneの成功を待つ。共有joinとWorker監視も直列前提を除き、同run/attempt・全source・各実時計・期限を維持する。監視は両producerとjoinの3jobを確認し、join開始が両producerの完了以降であることを要求する。
- 欠落・部分失敗・結果不明を成功にしない。Notion枠1.0/1.6rps、Yahoo共通排他、取得元集合を維持する。初回の空DB/schema構築は既存単一CLIで直列に済ませる。
- 優待要約はモデルなしを既定とし、未対応は理由付きHOLDで旧値・時計を保持する。機械処理と手動の明示`--allow-model`は同じ金額資格・PRE/CAS/POST・pending latchを通す。定期・月次入口は明示許可を渡さない。
- 指定済み事業タグの適格新規・入力変更に限るローカルClef例外は維持する。競合の自動意味判定は再開しない。

Nix Node22.22.2 / pnpm9.15.9で資金フロー関連5suite・165件PASS、最後のcatalog非交差assert追加後のsource-summary 8件もPASS。優待関連8suite・116件PASS、既存private原本未配置の4件はSKIPで、新default/明示許可の検査は全実行した。ルート型検査・対象lint・差分検査も通過。両担当による相互FSレビューのblocking指摘は0。

優待の私有検証receipt: `tmp/feature-audit-20261018/yutai-mechanical-default-proof-v1/review-ready-v1.json`、SHA256 `9e77b45039d4c4246a5fa1629418738e49113241542e7ffeb40fdf129eaa3271`。

## 費用・本番受入の境界

取得元API・モデル呼出し・新依存は増やさない。資金フローはjoin用runnerのsetupとartifact転送が増える。実請求額と時間短縮は未測定であり、並列化だけで効果を保証しない。優待の機械HOLDも未完として非0終了し、成功件数に加えない。

月次は母集団→優待原文→再計算の順とし、保存財務・スイングを使い、MA乖離比較だけ財務日と指標日の一致を要求する。不一致でスコア行全体を停止せず、当該比較を保留する。当日18時の未来の取得を先行条件にせず、欠測を値で補わない。月次CLIのexit0を全銘柄の財務充足とは扱わない。

コード受入・Cloudflare配備、Mac専用runtimeのquiet切替、次の自然calendar成功は別の受入。旧Mac095の自動MLX動作はruntime切替前には残る。SSHの稼働中価格補完はmain527に固定し、今回のローカル変更を途中反映しない。OS設定だけのHTTP0切替にSSH価格writerの停止待ちは加えない。
