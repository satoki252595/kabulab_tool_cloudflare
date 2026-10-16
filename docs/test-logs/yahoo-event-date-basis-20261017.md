# Yahoo報告分割日と法的効力日の契約

2026-10-17、#343 の残差。保存原本の観測と価格補正は別の資格である。

実1798の Yahoo Chart は原timestampからJST `2026-03-30`、分割比率5を報告する。一方、同発行体の保存有報 S100YDA3 は「2026年4月1日付」の分割と、期末株数が分割前であることを明記する。原Yahoo本文SHAは `62ad3b17c528bb5e89ae781746f350932da60a9152992d53b13fc5bfdc2914ef`、issuer ZIPは `01d2c3b0046b1b1e99d300155629fb604104f350ef8cb9608b14cdc5e0974e0c`。全原本と資格済み注記は [既存fixture](../../services/yuho-quant/src/tests/fixtures/holdings-split-1798/provenance.json)、主体・context・法的日付の検証は [保有価格の記録](holdings-split-legal-basis-20261017.md)を参照する。この1例から他銘柄の報告日も市場権利落日と確定させない。

通常Yahoo日足の共通producerは、`corporateEvents.dateBasis` に `reported-timestamp-only`、`yahoo-event-timestamp-jst`、市場権利落日・法的効力日とも `not-verified`、旧ratio-onlyの日付意味 `unknown` を追加する。旧 `SplitValue.dateMeaning='split-effective'` は保存互換ラベルであり、法的効力日の確定を意味しない。旧 value・canonical JSON・SHA・version・schema1 は変更せず、同値イベントの履歴も増やさない。

既存の保存reader・repair・APIは同じ共通形状検査を使う。旧保存物の `dateBasis` 欠落を許可し、`/api/daily` の `corporateEventDateBasis` で `legacy-meaning-unqualified` と明示する。元の `corporateEvents` 自体は書き換えない。イベント未取得は `corporateEventDateBasis:null`、新metadataで法的日付の確認済みを偽装したものや未知contractはSTOPする。

## 純再生

Nix、既存lock/依存で、実1798・旧schema1互換投影・保存/APIの不正metadata境界を常時CIへ追加した。既存1333の保存原本もローカルで接続し、関連3 suites **17 PASS**。1333の既存私有6回帰は原本のないCIでは従来通り明示SKIPになる。新1798回帰はリポジトリ内の実原本を使いSKIPしない。

別の純再生では、保存済みR2 POSTの5271/6092/7075/8303/1333の全本文SHAを各旧receiptへ照合し、新readerとローカルAPIで旧bars/splits/proof/イベント値・value SHAの完全一致を確認した。ローカルAPI応答を新しいnative HTTP成功とは数えない。

旧・新producerを同じ保存Yahoo本文で各20回、順序交互に再生した。1798の中央値は3.499→3.507ms、1333は3.898→3.644ms。小規模標本のばらつきを含み、全銘柄の性能保証ではない。追加診断は各応答183 bytesで、追加HTTP・モデル・依存・DDL・価格/株数/係数補正は0。私有証跡は `.runtime/corporate-event-date-basis/source-v1/tmp/date-basis-pure-v1/result.json`、SHA `83a84e3be63bdbc370d3eb323439f6e049e1aac8da3ef3e5b3eb1c11be99f5a8`、同auditは5保存物と2原本文、旧新ソースをSHA固定して再生する。

## 残る資格

OHLCVのprovider調整基準、個別配当の株数基準、増資・新株予約権・会社分割等の網羅的な法的イベントと価格適用は未証明。日付ラベルの明示を、価格や株数を補正する許可、既知HOLDの成功化、全5,362行の解消へ拡張しない。本変更の本番次回定時・既存全保存物への反映は未受入で、#343 は開いたままにする。
