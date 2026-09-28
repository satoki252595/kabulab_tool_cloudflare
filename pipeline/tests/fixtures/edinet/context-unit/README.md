# 原本の財務範囲・単位回帰fixture

EDINETのcommercial-ok原本4件の数値ファクト・DEI・CSV全列を原文のまま抜粋した。公開URLと原ZIP SHA256は `manifest.json`。TSVはUTF-8で保持し、テストで原API形式のUTF-16へ符号化する。

- 5918: 会社全体とセグメントの売上を区別する。
- 6269: 同一要素/contextのUSDとJPY、USDPerSharesとJPYPerSharesを区別する。
- 6269/7951: IFRSのBPSと自己資本比率をunit=JPYPerShares/pureで区別する。

TDnetはこの公開repoへ再配布しない。`tdnet.source.txt` は公開URL・原本SHA・期等の取得ポインタだけを持つ。保存済み原本cacheから次のコマンドでローカルのignored fixtureへ複製する。

```sh
nix develop -c uv run --project pipeline python pipeline/scripts/capture_financial_context_fixtures.py --cache-dir /tmp/kabulab-financial-raw-cache
```

未取得環境ではTDnet実原本3件だけを既存 `fixture_path()` でskipする。会社範囲/通貨/比率のEDINET回帰と、年間配当/予想年度/共有resourcesの構造テストはCIでも必ず実行する。市場値を生成しない。

ユニット根拠: [金融庁 EDINETタクソノミ設定規約](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140303.pdf) §4-1。
