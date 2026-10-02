# 原本復旧と未資格データの再確認 — 2026-10-02 JST

Refs #132 #146 #196。開始時main `0728c67d940ec0dcbca89d651d060e9a536a6b29`。
TypeSafeの現在の方針・設定・コードは変更していない。原文・財務値・Notion ID/URL・認証値は公開Gitへ保存せず、私有0600の原本・HTTP証跡で保持する。

## 622Aの当日公式原本

- 金融庁の[公式EDINETコードリスト](https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip)を1 GETだけ取得。HTTP200、572,284 bytes、ZIP SHA-256 `8181327d8ce2a51692c83f68071e3295d58af8b69fe0be130e70d5ff25630e77`。原本基準日は2026-10-02で、取得日から推定していない。
- 現在の厳密CSV reader・通常parser・業種候補検査で11,402行13列を検証。E42099の発行体・上場区分・業種・証券コード・法人番号は10/1原本の同5項目と一致。非上場・証券コード空欄のため622Aの業種採用は0。JPXとの差を推測で埋めずHOLDを維持した。原ZIP全体は10/1原本とは異なる。
- ZIPと同一取得応答のmanifest（916 bytes、SHA `27089d283f05c22a6e3afae86d566ee577d76caf760368db3b13e140e34283f3`）を、既存の世代key生成関数と共有`archiveAndVerify`/`recordPrimaryData(force:false)`で1回だけ物理保管。Key SHAは `4436860dc69dc5045973649b4d55203d712049d9136818a4a52ac36f1c149811`。
- 実保管は`recorded`/`written`。一意な行の5プロパティ・persisted `_fileManifest`の両ファイル名/MIME/bytes/SHA/ uploaded状態と、hosted添付2件の全文を独立照合した。Notion13/hosted2の全15通信がHTTP200、page create1/upload2、unknown/retry/再送0。新規DB作成・既存データ変更・D1/R2書込・追加source GETは0。
- 同応答のbody完了時刻 `2026-10-02T13:08:53.611Z` はmanifest本文とpersisted Metadataへ完全一致で保持。NotionのDate列「Fetched At」は同時刻を送信したが、実応答は `13:08:00.000+00:00`。Date列の秒単位一致は主張せず、原取得の精密な時刻はmanifestから読む。

## 海外売上の保存原本と旧母集団

- 保存済み15原ZIPをmainの共有parser・保存validatorで再判定。全bytes/SHAとissuer/年度を確認し、13資格/84明細・HOLD2を再現した。私有結果SHAは `e1d2ff9fd3d38721e852225f51c31334768bfbf4f2bf3dd8a7bd8a0ae27e0bf5` で前回の独立結果と一致。新規通信・書込は0。
- S100W1Q5は同じ当期・連結でも契約収益と会社売上の集計範囲が異なる候補の競合（`multi-group`）。S100FHUHは期間範囲を明記しない当/前期語の矛盾（`single-row-fiscal-mismatch`）。既存の失敗停止条件を解除して都合のよい候補を採用していない。2文書は本番更新対象外。
- 旧`/tmp`の母集団・原本packetは現在のローカルに無かったため、共有find-only検索・固定key一意照会・files読取を1回行い、保管済みbaselineの3添付を回収。Notion3/hosted3、全HTTP200、mutation/sourceGET/D1/R2/再送0。
- baseline ZIP 16,579,214 bytes、SHA `e8948dc3453035c85b96c84c74cf72fa0b5e6d5fb1dbd644037bf15f74292f99` が既知pinと一致。全160 memberとpayload159件のbytes/SHA、別添member-list/pinsとZIP内の対応を照合した。2026-09-30T08:40:31.050Z時点の3675文書・21,245明細、一意docIDと文書別明細件数を復元できた。
- このbaselineは過去のDB観測であり、全原ZIPの資格や現在の全件状態を証明しない。旧legacy10件のsource来歴・原bytes期待値を含む69件のpacketも復元できたとは扱わない。全体の無条件backfillは実行していない。

## 結果不明・公表待ち

- 旧9/28信用残の1 POST UNKNOWNは、既存exact-key/archived/Trash118候補の検索結果を確認した。過去送信のreceiptがないことや0hitを未送信の証明にせず、再POST・462件完了扱いをしていない。新しい監査ログ契約で過去イベントを取得できるとの判断もしていない。[既存の調査と再開条件](data-remaining-investigation-20261001.md)。
- 10/2に公式一覧を再確認。[株式月間](https://www.jpx.co.jp/markets/statistics-equities/investor-type/00-01.html)は10/8、[ETF](https://www.jpx.co.jp/markets/statistics-equities/investor-type/02.html)・[REIT](https://www.jpx.co.jp/markets/statistics-equities/investor-type/03.html)は10/13掲載分から新様式と明記。9月の実ファイルは未掲載で、予告sampleを本番原本として取得・取込していない。公表後の実ファイル照合は残る。

## 私有証跡のSHA

| 証跡 | SHA-256 |
| --- | --- |
| baseline回収実績 | `51f574c8b96a7aefb4a7ab008daf17799df54bf77e5553f9a52e7112b286d406` |
| baseline内部159件照合 | `12d8408b1e3a163f3dd059a2e5be44e148b829eb9475c007c8f37f4d2e3d013d` |
| FSA原本比較 | `e0d669c7e9a0791afe07906449dc22ffbf9e5ccad968376f02b55f2927245942` |
| FSA実応答metadata | `16c14a1108f5a004d39cb8cf1e9101b99e9c66934b9388830a6f39b734eb17fa` |
| FSA実保管・15通信 | `c49880ab0e2ed1aef744cca8ee15861961c252e83a1611a628a651f565564d75` |
| FSA保管の独立照合 | `cd37cb948e2534db83dea63cd32385fa933e12477a21a3bcb0969022db89e01b` |

上記の限定調査・物理保管は完了。海外全母集団の原本資格、旧来歴、過去UNKNOWN、公表前ファイルの本番取込の完了とは扱わない。
