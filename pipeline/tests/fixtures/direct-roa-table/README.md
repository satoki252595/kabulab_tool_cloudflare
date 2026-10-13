# 実 EDINET 有報の ROA 表

6963/S100YF41、8014/S100YBIN、8593/S100YF4V の保存済み type1 ZIP から、
ROA の定義・年度・連結・実績列を照合する実 TextBlock、native DEI、当期連結
NetSales fact を機械的に切り出した部分資料です。原 ZIP 全体ではありません。
表・値の合成や修正はしていません。同値の重複 fact は一つにまとめ、由来を全件記録しています。

`provenance.json` に原 ZIP・member・切出し・各 fact・context の SHA-256、
docID、取得 URL、元の取得時計を記録しています。旧保管には独立した取得時 SHA が
なかったため、今回の SHA 計測を過去の照合済みという証拠へ置き換えていません。
全 ZIP は既存 private 作業領域と Notion の一次データ保管に保持しています。

再切出しはリポジトリルートから、保存原本だけを使います（外部取得なし）。

```sh
nix develop -c uv run --project pipeline --frozen --offline python pipeline/scripts/capture_direct_roa_table_fixtures.py
```

EDINET は公共データ利用規約準拠の `commercial-ok`。JPX・日証金等の原本は含めません。
