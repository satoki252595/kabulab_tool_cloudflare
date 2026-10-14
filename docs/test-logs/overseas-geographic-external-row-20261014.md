# 地域別売上の唯一の外部顧客行（2026-10-14）

3382/S100Y4VBの所在地別営業収益表は、地域列に「その他の地域」、値行に外部顧客への
営業収益・地域間営業収益・営業利益を持つ。従来の無ラベル単一値行だけの直接証明では
受理できなかったため、通常の共通parserへ唯一の明示外部顧客売上行を限定して追加した。

既存のnative durationと印刷期間の一致、表ローカルの当期連結、唯一の日本列・その他列、
印刷総額、同じTextBlockの表直後にある地理分類注記、印刷leafと総額の丸め区間照合を
再利用する。値行は「外部顧客への／に対する売上高・売上収益・営業収益」の完全一致で
唯一であることを必要とする。DEIの連結trueだけでは表の連結scopeを作らない。
「計」と「連結」の2列は、両方の印刷外部顧客総額が完全同値のときだけ受理する。
他の複数集計列や矛盾する適格表をscoreで選ばず、明示HOLDする。

地理区分注記の表現には実原文の「国又は／または地域の区分は地理的近接度」を追加した。
注記は同じTextBlock内の表直後から次table/ix境界までに限定する。地域間収益や利益を
売上へ混ぜず、海外額は印刷された外国leafの合計を用いる。total−Japanで補完しない。

3382の当期は2025-03-01〜2026-02-28、native entityはE03462-000である。
日本1,844,286・北米7,960,998・その他624,984百万円、印刷外国leafの合算8,585,982を保持する。
全leaf10,430,268と公表計・連結10,430,269の1百万円差は丸め差であり、海外額へ足さない。
原表は所在地別営業収益であり、顧客所在地basisと推測して書き換えない。

実fixtureは元ZIP SHA `9170e29c50f4c1e130bc0d79daf8b85ed87283d28bb2405c0e0c3a462eacfb81`、
honbun SHA `75d7a5ec99085b6f4c545e3f03a2fe246f0d9ef68a3268d925c138e039b1c92e`に
束縛した連続した原文と、同instanceのnative context投影である。元producer manifestと
旧取得clockはUNKNOWNのまま保持する。詳細は[fixtures README](../../services/yuho-quant/src/tests/fixtures/README.md#explicit-external-sales-row-and-other-geography-s100y4vb)に記録した。

実原表の回帰ではnative欠測・誤FY・印刷期首矛盾・地理分類注記欠測・個別・非売上metric・
印刷期間欠測・計と連結の不一致・leaf不一致・複数日本・複数external行・同一期適格表の
矛盾をHOLDへ固定した。Nixの9 suites・192 tests、全体型検査、変更TypeScriptのlint
（0 warning）を確認した。通常ingest/catchup/missing-backfill/backfill-overseasは同じ
`parseOverseasData` → `validateOverseasSaveSet` → `toOverseasSaveRows`へ到達する。
通常非shard catchupの末尾は既存`rebuildYuhoGrowthProjection`でL2投影も再生成する。
手動backfillは既存仕様どおり次定時までL2が旧値のため、単発修復の完了判定では別途
対象限定の共通projection再生成と完全PRE/CAS/POSTを必要とする。

固定した保存原本52 plans・2,600最新docの旧新比較は2026-10-14T09:24:26.789Zに終端した。
原ZIP全文SHA・item/content-manifest・metadata・DEIを検査し2,583通が資格化、17通は元の
metadata・物理添付・サイズ予算の資格不足を保持した。これらを非開示とは扱わない。
比較baselineはaccepted main `aee7bc0d50d2e5c4dd6d32fb821dd1a505a2811b`であり、旧parserは
importの相対pathだけ移設して逆変換の完全一致を確認した。

| cohort | 旧parserでも資格化できる未反映 | 今回コードで新規資格化 |
| --- | ---: | ---: |
| 最新未対応731のうち数値資格候補154 | 152 | 2 |
| 現no_overseas_tableのうち数値資格候補135 | 135 | 0 |

新規2通は3382の唯一external行と、6023/S100YCLQの既存無ラベル単一値行＋今回追加した
実地理区分注記表現である。6023は当期連結の日本42,471と外国4leafの合算45,594百万円を
保持する。原表に印刷された海外集計値ではなく、22,392＋10,345＋2,502＋10,355の実地域額
の合算である。全leaf88,065と公表総額88,066の差1を埋めない。既存資格→新HOLD、旧新の資格あるfacts差、
現在supportedの旧新parser差分はいずれも0通だった。最新731へのsource到達は560通
（資格555・sourceHOLD5）、未到達171通であり、未到達を非開示へ分類しない。
これはparser出力比較であり、現在D1 factsの差分や本番適用を主張しない。

旧新二重parseと資格検査のv2経過は1,051.671秒、原ZIP読取2,181,634,925 bytes、
当runの旧parse500.503秒・新parse500.766秒、item境界の最大観測RSS1,668,939,776 bytes。
途中のコメント変更をpin guardが検知して停止した旧v1は保全した。コメントだけの逆変換
完全一致証明により446既存parse receiptを再利用し、旧runのparse時間208.243秒は別計数
した。v2の所要時間へ旧失敗runの全wall時間を含めたとは主張せず、RSSもlifetime peakとは
扱わない。全てローカル保存原本の機械処理で、Notion/source API/model/業務writeは0である。

private全量分類 `geographic-external-row-all-saved-replay-v2/classification.json` SHA
`926a43e5c4cb1f9863739f8c7e7d91a902be4553f61a828499b82d84c0a37be4`、
効果分離 `code-effect-separate-v1.json` SHA
`04eac53cd844e20e2995f8a691a0ad3ea410cb97f370bdac00f0ed076a97c352`、
6023の独立一次レビュー `independent-primary-review-market-6023-v1.json` SHA
`7af41b63c7909919ca10013e509d98b72e0a5db64602f0b2e9a59390147b9dd5`、
コメント不変証明 `external-row-comments-only-transition-v1.json` SHA
`7a6a032b0b1f2d370322c2fbb1c6ad770e1d2694e4ab6b93333e8a72e3ccc710`を固定した。
既存の採用basis変更6社と印刷丸め差は[前回の記録](overseas-geographic-other-20261014.md)の
扱いを維持し、旧数値を架空値や単純な誤訂正と呼ばない。本番反映は新accepted main、
fresh完全PRE、原本再資格、対象限定atomic CASと物理POSTの別gate後に行う。
