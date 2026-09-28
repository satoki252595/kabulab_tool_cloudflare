# 原本抜粋の財務範囲・単位回帰fixture

2026-09-28にNotion⑤の物理ZIPをSHA256照合し、使用する数値ファクト・DEI・context/unit定義だけを抜粋した。元原本の公開URL、SHA256、Notion③ page IDは `manifest.json`。値・要素名・CSV全列は原文を保持し、TSVはUTF-8で記録、テストでEDINETのUTF-16へ符号化する。iXBRLは実context/unit/factだけを抜粋したXMLであり、完全な開示文書としては扱わない。

- 5918: セグメント売上3,473百万円と会社全体4,422百万円。
- 6269: 同一要素・contextにUSDとJPY、USDPerSharesとJPYPerSharesが共存する。
- 6269/7951: `EquityToAssetRatioIFRSSummaryOfBusinessResults` は原文でBPS、unit=JPYPerShares。自己資本比率は `RatioOfOwnersEquityToGrossAssetsIFRSSummaryOfBusinessResults`、unit=pure。
- 8154: 半期予想70円、年間予想140円。divide unitはJPY/shares。
- 7699: 半期予想12.99円だが年間はnil。年額を半期で埋めない。
- 3463: iXBRL本表が別ファイルのunit/contextを参照する。解決後、本表の期間は開示日より未来の2027-01-31であり、現在実績へ割当しない。明示された短信実績2026-07-31の営業利益1,625百万円・経常利益1,232百万円だけを採用する。

iXBRLは元ZIPのファイル境界を維持して `parts` に記録し、共有resourcesの解決を検証する。

ユニット根拠: [金融庁 EDINETタクソノミ設定規約](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140303.pdf) §4-1。
原本の市場数値を生成していない。unknown unit、ID名に現れないdimension、多値の構造テストは、原本値を使って入力構造だけを変更する。
