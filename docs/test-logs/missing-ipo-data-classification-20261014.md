# 新規上場企業の有報本文・財務欠測分類（2026-10-14）

本文なし22社は「取込漏れ2社」「設立後の初回期末前9社」「初回有報の提出予定が未確定11社」に分かれる。財務なし14社はそれぞれ2社・4社・8社。最後の11社は「未提出」と断定しない。

## 回復できる2社

|銘柄|保存原典|欠測の原因|回復・完了判定|
|---|---|---|---|
|542A ビタブリッドジャパン|S100Y5S8、2026-05-25提出、2026-02-28期|一覧のsecCode=NULLを旧経路が除外|同一提出者E41361を公式codeListの542A0へ解決。CSV/XBRL保存済み。通常取込後、本文37節・ポインタ・原文SHAと財務の読戻しを検証|
|646A クラサスケミカル|S100Z0VF、2026-09-07提出、2025-12-31期|secCode=00000と第四号様式040000が対象外。旧財務は0000へ誤保存|同一提出者E42126を公式codeListの646A0へ解決。CSV/XBRL保存済み。本文34節とポインタを検証。旧財務34列PRE保全後、codeとstock_idだけCAS補正し全列一致を検証|

00000は今回の実原典で観測した値であり、全ての不正コードを推測補完する規則ではない。NULL/完全一致00000だけ、企業開示府令010・年次120/130・有効状態・同一提出者の一意マスタへ解決する。非0不正コードや大量保有のissuerEdinetCodeは使わない。

[FSA公式様式コードリスト](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140327.xlsx)は010/040000を法24条3項の有価証券報告書、040001を訂正報告書としている。原XLSXのSHA256は`652b160ad8eba90bdbda9b10520b402a7b69fa1441a60d99ed7eb555665a8a24`、2026-10-14取得・Notion物理保管/全bytes照合済み。

## 初回期末前9社

JPXの会社別上場概要に設立日と事業年度が明記されている。初回の期末はこの2事実から算出した暦日で、報告書の提出予定日を意味しない。前身会社の実績で埋めない。

|銘柄|設立日|初回期末|財務なし|出典|
|---|---|---|---|---|
|544A GMSグループ|2026-04-01|2027-03-31|いいえ|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000000og5p-att/04GMSGroup-Outline.pdf)|
|545A トランヴィア|2026-04-01|2027-03-31|いいえ|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000000oge8-att/04Toranvia-Outline.pdf)|
|546A MIRAINIホールディングス|2026-04-01|2027-03-31|いいえ|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000000ogiv-att/04MIRAINIHOLDINGS-Outline.pdf)|
|547A ムニノバホールディングス|2026-04-01|2027-03-31|いいえ|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000000ogm0-att/04MuninovaHoldings-Outline.pdf)|
|575A 前澤ホールディングス|2026-06-01|2027-03-31|いいえ|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000001435r-att/06MAEZAWAHoldings-Outline.pdf)|
|590A ギフティグループ|2026-07-01|2026-12-31|はい|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000001enne-att/07gifteeGroup-Outline.pdf)|
|640A ASNOVA Companies|2026-10-01|2027-03-31|はい|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000001v8bw-att/10ASNOVACompanies-Outline.pdf)|
|641A NOK Group|2026-10-01|2027-03-31|はい|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000001v7rs-att/10NOKGroup-Outline.pdf)|
|642A キューデンホールディングス|2026-10-01|2027-03-31|はい|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000001v7y2-att/10KYUDENHoldings-Outline.pdf)|

641Aは2026-10-14公式codeListで同法人のEDINET対応が未確認。旧NOKへ接続しない。

## 初回有報の予定が未確定11社

|銘柄|現法人設立日|事業年度末|財務なし|出典|
|---|---|---|---|---|
|558A SQUEEZE|2014-09-01|12-31|いいえ|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000000pxz5-att/04SQUEEZE-Outlinet.pdf)|
|589A ネイス|2010-09-01|08-31|はい|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000001eeb4-att/06NEIS-Outline.pdf)|
|593A ティアフォー|2015-12-01|09-30|いいえ|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000001ihj9-att/07TIERIV-Outlinet.pdf)|
|604A ビーエイブル|1991-03-14|07-31|いいえ|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000001ib8q-att/07beABLE-Outline.pdf)|
|618A KOMPEITO|2012-09-03|08-31|はい|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000001u0tv-att/09KOMPEITO-Outline.pdf)|
|619A オリバー|2021-04-30|12-31|はい|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000001u3px-att/09OLIVER-Outlinet.pdf)|
|621A オーディオストック|2007-10-11|09-30|はい|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000001u6ah-att/09Audiostock-Outlinet2.pdf)|
|622A テクノクラフト|1995-03-02|09-30|はい|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000001u6eo-att/09TechnoCraft-Outline.pdf)|
|623A ベルテックス|2010-12-07|11-30|はい|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000001u6j2-att/09Vertex-Outline.pdf)|
|625A Skyfall|2017-10-26|09-30|はい|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000001ub12-att/09Skyfall-Outline.pdf)|
|627A akippa|2009-02-02|12-31|はい|[JPX](https://www.jpx.co.jp/listing/stocks/new/t13vrt000001udd2-att/09akippa-Outline.pdf)|

上場前に期末を迎えた期の有報が上場後に提出される実例（542A）があるため、「上場後最初の期末」から初回有報を推定しない。具体的な提出日は保存原典で未確定として残す。627A/E38412はcodeList上場区分が上場でも証券コードが空。名前だけで自動名寄せしない。

## 観測範囲と検証

- 旧ローカル一覧784ファイルの走査は2026-06末まで。一部の過去年・日付欠けがある。
- Notion保存の2026-08-14〜2026-10-13一覧61日を、gzip/原HTTPの長さとSHAを全照合して再読。22社に対応する年次は上記646Aの1通のみ。
- 2026-07-01〜08-13は今回の全日一覧照合範囲外。取得済みNotion④だけで「未提出」と断定しない。
- 対象20社のJPX概要と訂正版を物理保管・全bytes照合済み。最初の4社で確認書PDFを選んだため、概要の訂正版4冊を追加取得した。確認書も原本として保持する。原文をGitへ追加しない。
- 既存競合判定の未判定83社は全て事業タグ判定済・本文取得済・有報IDあり（事業本文773〜29,954字）。本文なし22社とは分け、既存の明示SemIf・較正済み版で対象限定計画を作る。
- 同定のTS回帰、Python回帰、lintを検証。旧財務移動SQLはローカルSQLiteで正常移動・PRE変更・対象PK衝突を検証し、後2つの原子的rollbackを確認。本番適用の結果は別途追記する。

本番適用追記: PR #352後に両社の本文37/34節・D1全索引・Notion本文とpointerを照合し、財務も全34列/全property読戻し済み。active本文なし20社・財務なし12社まで減少。残る分類を未提出の断定に置き換えない。
