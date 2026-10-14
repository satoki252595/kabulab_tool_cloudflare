# 地域別売上の「その他」直接証明（2026-10-14）

従来は「その他」「その他の地域」を一律に地理未分類としていたため、売上の
地理分類が明示された原表も構造化できなかった。1333/S100YCK1と3036/S100YCV6の
実原表を根拠に、通常の共通パーサへ限定した採用条件を加えた。

採用には既存のsingle-row直接証明を再利用する。同一filingのnative durationと
印刷期間が一致する当期、表ローカルの連結true、直接売上TextBlock、唯一の数値行、
唯一の日本列・その他列・印刷総額、同じTextBlockの表直後にある明示地理分類注記を
全て必要とする。次table/ix境界の先や別表の注記を借りない。地理未分類・欠損・
既存の丸め区間照合は維持し、同じ単位で複数のOther適格原表が矛盾すればscore差でも
`other-geography-conflict`でHOLDする。行型や複数値行への拡張は行わない。

Otherのラベル、native期間、原注記をparserの非DB保存proofへ運び、共通保存検証でも
必要条件を確認する。以前のproofや判定入力SHAへ新しい証拠を後付けしない。
原額・原地域名を保存し、連結総額から日本を引いた残差を外国の実額へ代入しない。
1333の印刷海外合計は302,689百万円（全leaf1,105,888、総額1,105,890）、3036は
86,561百万円（全leaf219,717、総額219,720）であり、端数差を埋めない。

1332/S100YHOQ、4095/S100YJGK、2183/S100YGWG、4248/S100XSML、
4978/S100YLVF、5161/S100YIPCの6社は、顧客所在地が明示された原表への
採用基準変更として分離する。旧基準は順に所在地（同報告の業績説明で補強）、
販売元所在地、サービス提供地、連結会社所在地・消去前地域額、事業segment×国
（販売元/顧客のどちらかは未証明）、拠点地域segmentの外部顧客行である。
旧値へ基準を推測して後付けせず、消去額を海外へ配賦しない。
独立した原典読解で同年度・連結・売上指標を確認し、既存の当期連結地域注記
優先policyに沿う基準変更として扱う。
以前の数値を架空値や過去値の誤訂正とは扱わない。実適用時は旧factsと完全PRE、
採用基準note全文・SHA、基準変更理由を別gateで保全する。

1964/4222/4968では印刷集計と新しい実地域leaf合計に2/1/1原単位の差があり、
3433では海外合計17,764百万円を保ったまま中国8,673・その他9,091の地域詳細へ
分かれる。原印刷値と既存丸め区間を保持し、旧数値を誤値と断定しない。

通常の到達経路は `ingestDocument`、`missing-backfill`（catchup共用）、
`backfill-overseas` → `parseOverseasData` → `validateOverseasSaveSet` →
`toOverseasSaveRows`。既存prep2経路も同じparser/proof/検証を利用する。
特定doc一覧や復旧専用の条件を本番へ追加せず、受注・本文39項目・事業タグは変更しない。

原表・native context投影の来歴、原ZIPとfixtureのSHA、旧時計UNKNOWN・権利の境界は
[fixtures README](../../services/yuho-quant/src/tests/fixtures/README.md#explicit-geographical-other-regression-2026-10-14)に記録した。
1860/S100YG3Eは当期・連結・地理軸があっても分類注記がなくHOLDを維持する。
注記の削除・TextBlock外への移動、期間証拠欠測、誤FY、個別、複数日本、総額欠測、
score差のある矛盾原表を負例として固定した。既存の減損損失除外も維持する。

Nixの8 suites・187 tests、全体型検査、変更TypeScriptのlint（0 warning）を確認した。
Notion/source API/モデル/業務書込は0。保存原本の全量旧新比較はprivateな固定入力と
50件checkpointで実施し、最新731内の新回復、旧supported差分、source資格不足を分離する。
この修正の本番値への適用には別のfresh PRE/source pins/releaseが必要である。

保存全量比較は2026-10-13T23:08:46Zに終端した。固定した34 producer plansの
1,700最新docを対象とし、原ZIP全文SHA・item/content-manifest・metadata・DEIで
1,689通が資格化、11通は元metadata/添付の資格不足を保持した。非開示とは断定しない。
旧accepted main `6d814768bc8fcb4a090bff89da3575797bd72c1a`のparserと今回のparserを
同じ原ZIPで実行し、旧baselineはimportの相対pathだけを移設して逆変換の完全一致を
確認した。全資格通の保存集合検証が通り、旧資格→新HOLDは0通だった。

| 現本番statusのcohort | 旧parserでも資格化できる未反映 | 今回Otherで新規資格化 |
| --- | ---: | ---: |
| 最新未対応731のうち数値資格候補78 | 32（同値30、基準変更1332/4095の2） | 46 |
| 現no_overseas_tableのうち数値資格候補67 | 30 | 37 |

現在supportedの26通にも旧新parser差分があり、19通は旧accepted parserのHOLDから
新資格へ、7通は旧資格からの地域詳細・印刷集計等の差分だった。これらはparser出力の
比較であり、現在D1の全factsとの比較や本番適用を主張しない。最新731のsource到達は
351（資格349、sourceHOLD2）、未到達380である。本番未対応の731件自体は未変更。

通信・モデル・業務write0で原ZIP1,425,484,895 bytesを照合した。旧新二重実行と
資格検査の合計557.427秒、旧parse267.666秒、新parse266.813秒、item境界の最大観測
RSS1,650,655,232 bytes。小さな時間差を速度改善とは扱わず、lifetime peakも主張しない。
private `geographic-other-all-saved-replay-v1/classification.json` SHA
`2338c27843e76f710c5d5e8a424c6ac8f1ee935dc55022bb5a2235e3bcd63720`、
効果分離 `code-effect-separate-v2.json` SHA
`5447ae72190dc224ae8ff930fb4e9d872a5b755875663a6e494752d43b43619d`を固定した。

独立原典レビュー `independent-primary-review-market-v1.json` SHA
`fcb605f9bd99b9c7e5add36ff2844ef32254bd5d23cde3db850b9b46fd53583a`、
追加4社 `independent-primary-review-market-additional4-v1.json` SHA
`94faf3c6de155672d31b85e1feea8e3e5f6e04730c90a6438fcd6a25f60e02d4`、
印刷集計・地域詳細の一次照合 `primary-printed-granularity-review-v1.json` SHA
`978534383b8ca220df6dfb6a9e7f05ec7fab4c4cabe7835e67129b49f4bd944e`を束縛した。
