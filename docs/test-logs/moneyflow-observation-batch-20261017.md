# 資金フロー観測ログの一括同値照合（2026-10-17）

通常のspec取込と保存原本からの再取込で、全観測行を50自然キーずつOR照会する。
active page・親DB・一意キーと既存19項目の全値が一致する行だけを既知の同値とする。
変更・欠落・property不足は、既存のfresh個別queryとupsertへ渡す。古い一括応答を
PATCH/POSTの前提にはしない。入力順、ACK検証、結果不明の再送禁止と、変更があった
バッチ全体のPOST検証を維持する。`upsertObservationBatch`は通常入口が共用する。
Phase1の3経路への接続は別PRで同じAPIを使う。

一括queryは50キー・page_size100に固定し、未完のhas_more、厳格envelope/cursor違反、
件数超過・未知キー・重複・別DB・inactiveを保全停止する。未完ページを黙って捨てたり、
途中の1行だけで全体を完了扱いにしたりしない。relationのhas_moreが明示される場合は
falseだけを完全な値として採用する。環境・依存・取得元への要求・モデル呼出しは増やさない。

## 保存済み実応答の純ローカル照合

2026-10-13の保存native page 669行を直接pure matcherへ渡した。HTTP応答や200 statusを
合成していない。期待値の指標/一次データrelationは保存済みPREの入力から取得し、
照合対象のnative pageから作り直していない。PREと全POSTのcanonical JSON/gzipを
再構成し、当時の物理保管・全bytes読戻しreceiptのSHAにも一致した。

| 保存対象 | 行数 | 全19値同値 | 異なる/欠落 | 旧個別query | 新OR＋変更のfresh query |
| --- | ---: | ---: | ---: | ---: | ---: |
| global 221（完了10/14 05:13 JST） | 221 | 34 | 187 | 221 | 5＋187＝192 |
| 週次W40（完了10/14 04:37 JST） | 448 | 448 | 0 | 448 | 9 |

globalの旧187行は当時の明示方針で全propertyを保持した行であり、当時の新計画とは
異なる。今回も書込0で、同値に偽装していない。週次448行の照合queryは98.0%減る計算。
これは旧期の実page比較と固定chunk数であり、今夜の4,373同値行をnativeで全件再検証した
結果でも、本番HTTPの所要実測でもない。今回の取得元/Notion要求・業務書込・モデルは0。

- global native: 1,116,344B、SHA `5d064c00cc939b31b1ed9d9cf25d588d7fc942a66a2ef7dd4b74967bf14382a3`。
- global物理PRE/POST gzip SHA: `397401fe2a6ecad2f8a3f17f8729314b92ac8445998972ebbb6138ecc2398d3b` / `53ceb97aa0cb74a24a6726a987fe4004c0ffaaf94c7810786268772c6cd72a73`。
- 週次native: 3,029,547B、SHA `062c01a1bcb745c04f19771bb5b9328936704986bd9b379a98e6255dc2abb88a`。
- 週次物理PRE/POST gzip SHA: `df52f7dbb3b94fdad51e04ed15ea496764d88121547ea87863e6817f581e5b4d` / `a2d4adcff0fee88dc71a18e4add5a2ad9798c4c0514e8e0360eda07b93fbd4ae`。

実pageへの明示負例では値変更・property欠落・行欠落をno-op不可、重複キー・別DBをSTOP
と確認した。通常API単位テストは51同値行の50＋1 query、変更/欠落のfresh query、
一括query後に出現した行の二重作成防止、全19項目の欠落、入力の重複、未完/不正pagination、
ACK不明後の再送/後続処理禁止を検証する。Nix Node22.22.2/pnpm9.15.9を使用する。

## 通常稼働の残受入と費用

変更行は従来のquery＋writeに、一括照合queryが加わる。全て変更の場合は速くなるとは
主張しない。10/16の保存runlog（SHA
`206371d17681d2992e2ffdeb863b776da3be6c93b2785549daa13cfed2781003`）をsource別に
再集計した。global以外27 sourceのうち、行数を記録した25 specに6,080行（同値4,373・
変更1,707）があり、50件chunkのsource別切上げ合計は133 query。同じ分類が成立する
場合、この既知25 specの観測query＋writeは133＋1,707＋1,707＝3,547（旧7,787）、
0.7req/sの間隔部分は概算84.45分となる。Phase1のmarketcap/short-sellingは元logに
行数がなく、6,080行に含めていない。原本保管、指標定義、POST検証、HTTP時間、
source固有処理も別であり、27 source全体の上限や120分完走の保証にはしない。
workflow分離後の通常runで実要求数・所要・全POST・取込ログを受け入れる。
