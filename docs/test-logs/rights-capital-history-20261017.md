# 保存有報735社の資本金・発行済株式履歴と単位の残差

2026-10-17、#343。旧価格単位不足5,362行の743発行体のうち、同じ保存ZIPでDEI資格が通る735社だけを調査した。旧7社の主体未資格と7183の保存原本欠測は除外して保持する。新たな取得・モデル・本番書込みは0。

## 一次根拠の機械列挙

735/735社で `jpcrp_cor:ChangesInNumberOfIssuedSharesStatedCapitalEtcTextBlock` が1件ずつ観測された。通常の `FilingDateInstant` 実定義と、同一issuer/stem/headerの既存readerを使い、表の文字列・株/千株単位・原年月日・注記・原fact SHAを保持した。提出時点のcontextを、各歴史行の経済日とは扱わない。`NotesRegardingIssuedSharesAndTreasurySharesTextBlock` と、既存の普通株FY factも別に観測した。

履歴blockで分割412社、併合145社、増資34社、新株予約権103社、一般募集21社、第三者割当73社、株式報酬61社、自己株式257社、消却265社の語を観測した。これは**語の出現会社数**で、実施イベント数や網羅性の保証ではない。普通株・日付・比率の明示文は302社、分割/併合前後の基準に関する語句は111社にあったが、一意のFY株数基準への採用は別資格である。

| 実原本 | 観測できたもの | 採用してはいけない推定 |
|---|---|---|
| 5940/S100YIDL | 履歴表は2024-09-30、注記は「2024年10月1日付で普通株式10株につき1株」の併合。表の株数単位は千株 | 表の日付を法的効力日と置き換えない。千株表示から精密株数を補作しない |
| 8425/S100YESP | 1→5の分割と有償第三者割当が別行・別注記 | 株数差を分割比率にしない。割当の発行価格を時価へ使わない |
| 2752/S100XV0N | 年間期間の権利行使、同日別々の第三者割当、一般募集、株式報酬、準備金振替が混在 | 期間合計を単一日へ集約しない。資本金差だけで株数・権利係数を決めない |
| 6706/S100YH6S | 株数減少は複数回の自己株式消却 | 株数減を株式併合と分類しない |

各例のexact docId/ZIP/member/fact SHAと全表は下記の私有inventoryに束縛する。表のdocIdは実保存manifestと原本文SHAで照合済み。

## 通常工具へ追加できた狭い範囲

既存の `observePreSplitFiscalYearBasis` に、保存4116/5729/5803/7609が共通して使う「当社は…普通株式1株につきN株の割合で株式分割を**行っておりますが、上記の事項は、当該株式分割前の株式数を基準としております**。」だけを追加した。対象は同じDEI資格済みissuerの当期 `CurrentYearDuration` の一意の注記、法的日付・正整数比率、既存普通株FY factのexact値・shares unit・dimension資格が揃う場合に限る。

normal issuer資格→通常保有価格callerが同じ関数を使う。追加ZIP展開/源GET/モデル/依存/DDLは0。8012は同文が2件あり、普通株FYのprecision資格も不足するためHOLDを維持する。子会社・予定・一部・非当期・重複・小数・日付不正・FY/dimension/unit不一致も採用しない。履歴表の先頭日や注記の別イベントをこの新文型へ流用しない。

全735の同一ZIPを旧新shared helperへ順序交互に再生し、差は4社だけ、残731社は全値同じ。qualified basisは旧1798/1723の2社から6社へ。関連する旧25行中、issuer/ownerのFYが一致するのは24行で、7609の1行はFY不一致のまま。これは**株数基準の追加証拠**であり、25行や24行の価格成功ではない。原価格・保有株数・係数の補正、単位HOLD5,362行の一括解除は0。

## 検証と費用

Nix・既存lockで関連4 suites **35 PASS**、型検査/対象lintを実施。CIには既存原本の4116/7609のZIP計1,668,239Bと原SHA/metadata/FY factを固定した。通常issuer経路では展開1回、basis helperへ既存Mapを渡す時は追加展開0を確認した。負例は原注記の表示文を投影した明示試験であり、改変した原本や新しい実観測とは扱わない。

全735の履歴inventoryは59.98秒/peakRSS645,968KiB、paired共通helper再生は31.45秒/665,248KiB。ZIPを1回ずつ展開して旧新を交互に呼んだhelper累計は9.880→10.087秒（+2.1%、新4社の証拠抽出も含む）。単回標本で本番全量の性能保証ではない。追加源通信・モデル課金は0。

- 私有inventory: `.runtime/rights-history-audit/source-v1/tmp/rights-history-discovery-v1/result.json` SHA `0e830222a4b7f2f6741f0c77fe02bbdce8a1ec35fd15431639df0846c2605f57`。
- 全735 old/new: 同dir `replay-new-v1.json` SHA `59447367d6b66bc862c4e8eff9fc680f09a86314c5b7e32e4c61abf3654e759e`。同dir `replay-new-v1.mts` は新exclusive JSON出力を第1引数で指定でき、rootがHTTP0で再実行可能。
- 原本: [4116/7609 provenance](../../services/yuho-quant/src/tests/fixtures/holdings-split-explicit-before/provenance.json)、[既存743社の監査](holdings-split-legal-basis-20261017.md)、[Yahoo日付契約](yahoo-event-date-basis-20261017.md)。

OHLCVのprovider調整基準、配当の株数基準、全増資/新株予約権/会社分割の価格適用は依然未証明。法的日付と期末株数の根拠を増やしても、Yahoo歴史価格の単位まで確定したことにはならない。全価格の受入・次回定時・#343の完了は別に残る。
