# 公式銘柄表の原本保管だけの入口（2026-10-18）

日足更新後の価格台帳有効化で、旧Oct2のHOLD資料が最新の`universe`世代として選ばれて停止した。通常の母集団保管を業種更新と分けて実行できるようにし、既存の厳密なreaderを維持する。

最小読取では、最新候補の`manifest.json`（916 bytes）が旧形式で、取得完了13:08:53.611ZよりNotionの分単位Fetched At 13:08:00Zが前、基準日も既activeのOct14より前だった。添付名だけを許可して復活させる対象ではない。追加読取はNotion6・hosted2、11.31秒、2,118,012 bytes、業務書込・外部取得元・モデル0。private receipt SHAは`3e521df4d8cb75d1fd8035d561759c6aa7e43e73b480a7f721ff9676c2370500`。

`sector33_sync --archive-only`は通常のHTTP応答、実取得時計、ZIP、parse/scan/normalization、世代key、Nodeの通常原本保管と全文物理照合を再用し、その直後で終了する。業種UPDATEを行わない。通常のflagなし実行は維持する。共通runnerのjob名は`sector33_archive`へ分け、通常`sector33_sync`の最新成功実績を置き換えない。

```sh
nix develop --command uv run --project pipeline --offline --no-sync python -m jp_stock_pipeline.jobs.sector33_sync --archive-only
```

必要な通常設定とlock済み依存を用意してから実行する。`--dry-run`は物理保管自体を省くため、正規世代の作成完了にはならない。通常HTTP collectorは1呼出につき最大3回のretry契約を維持し、実HTTP数は別に記録する。共通opsの既存DMLは90日prune DELETEとINSERTの2文であり、全DML0とはしない。新しい取得元・依存・DDL・Cronはない。

NixのPython60件、関連Node3suite35件、ruff・型検査・compile・実CLI helpを確認し、別agentの読取レビューでblocking0。回帰はflagありの業種DML0、保管失敗時の停止、flagなしの既存UPDATEとjob名の維持を確認した。コード検証時点で本番取得・保管は未実施。

private検証manifest: `tmp/feature-audit-20261018/sector33-archive-only-proof-v1/review-ready-v2.json`、SHA256 `b9bb7bcb4bfba4ae4251d9cb3b944c483e1812412e37392d2400be6ffa99d456`。原本と署名URLはGitへ含めない。
