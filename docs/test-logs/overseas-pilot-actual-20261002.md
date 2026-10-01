# 海外原文pilot 1通の実績（2026-10-02 JST）

対象は `S100YJVF` の type1 だけ。root が固定 PLAN / runner SHAをレビューし、
取得・Notion原文保管・資格確認までを別のACQUIRE grantで許可した。
D1 native / mutation、type5 GET、dispatch はこのpilotで0。
原本・HTTP入出力・実時刻・台帳・財務値を含む診断はGit対象外・0600の私有証跡に保持する。

## 実原文の保管まで成功

- 公式 source GET は1回、HTTP200、884,834 bytes。
  ZIP SHA256: `41d3af026c1090c4dc92362005630992bbaebc08186f2a98a905951043d87d13`。
- 実送信 `2026-10-01T17:56:50.199Z`、headers受領 `17:56:52.422Z`、
  full body受領 `17:56:52.468Z`。保管の `fetchedAt` はこの新取得のbody完了時刻。
  提出日時・mtime・runner開始時刻を旧取得時刻へ代用していない。
- `recordEdinetZip(force=false)` の既知API receipt は
  `outcome=recorded / manifestMatch=written / fileTooLarge=false`。
  receiptファイル SHA256: `9c5fc28162aeb53335d2f8d28092d034a98c38e21af88f1ed00e598f1cd977ff`。
- Notion hosted添付の全bytes読み戻しは `17:56:58.184Z` に完了。
  名前・添付数・長さ・whole SHAを共有strict readerで照合してから資格確認へ進んだ。
  物理保管の成立と、create送信inputから観測したmanifestを区別する。
  後者をremote persisted metadata全文GETの検証とは呼ばない。
- 旧clock / 旧manifest / 旧ZIPのsame-bytes資格は UNKNOWNのまま。
  新source保管を過去の同一原本証明へ置き換えていない。旧keyの上書き・別keyによるunknown回避は0。

## 全文資格がHOLD

現行full parserの結果は `geo_present_unstructured`、facts0、proofなし。
診断STOP理由は `single-row-fiscal-unknown`。数値positiveの既存fragment fixtureは
fresh ZIP全文の資格を保証しなかった。HONBUN SHA256:
`5fb4cf750c9cf74689c0ce2eb7766f557803338b61d2d985e3f4d1a6847e07b0`。

全文診断では当期・連結の数値候補も観測したが、後続の地域売上single-row表で
captionに期の日付がなく、現行guardが文書全体をSTOPした。
既存4factsが誤りという結論にはしていない。financial values・原文表は私有証跡だけに残す。

追加sourceなしのoffline確認では、actual XBRL contextの一意定義が
前期 `2024-04-01–2025-03-31` / 当期 `2025-04-01–2026-03-31` を示す。
前期表だけを実end dateで除外する**私有仮説probe**でも、後続当期表が
同じSTOPになった。prior-only除外だけでは資格が閉じず、contextRef名だけから
期・連結区分を推定しない共有修正の検討が必要。
診断・仮説probeは選定資格や本番適用結果ではない。

- 当期候補のHTML文字位置: `833503`。
- 最初のSTOP表: `874210`、table SHA256
  `5c9b2e0baf62b981baecce2ca1284ee2489c932eff5a7182a0f81a43ed6caaae`。
- 前期だけ除外した仮説での次STOP表: `893001`、table SHA256
  `c25307dd1b102feb6c89d7575158cd2ef2d57f66a324bc06b6a24ee2b60bb3b6`。
- shared code・production資格を変更せず、取得済みknown ZIPだけをofflineで使用。

## STOP後の未完了と費用計数

| 計数 | ACQUIRE終了時の累積 | 今回ACQUIRE分 |
|---|---:|---:|
| source GET | 1 | 1 |
| Notion native | 18 | 9 |
| hosted GET | 1 | 1 |
| D1 native / mutation | 0 / 0 | 0 / 0 |

Notion累積18には事前metadata READ9を含む（known search再読7＋成功READ2）。
counter・元ledger・exact入出力を引き継ぎ、0へ戻していない。
今回の11 native応答は全HTTP200で既知、Notion非冪等POSTは3回
（upload作成・send・page作成）、actual unknown mutation0。
新nativeの応答body合計は2,213,881 bytes。これは取得・Notion応答・hosted読取の
合計で、total wire bytes・storage bytes・請求量そのものではない。

固定cap source1 / Notion50 / hosted3 / D114を増やさず停止した。
source1は消費済み。D1 PREの準備読取は別途2回と旧除外候補2回をPLANへ記録しており、
ACQUIREによるD1追加・書込が0という記述と混同しない。
実行はローカルNix cached toolsで、Node elapsedをWorker CPUへ換算しない。
新sourceファイル容量とAPI数は実測だが、アカウント請求額・月次外挿はここでは未測。

numeric資格HOLDのため **新SQL/PRE evidence ZIP/acquisition artifactは未作成**。
apply grantは発行されておらず、CAS / facts置換 / L2 / POST evidenceは全て0。
source/PRE両方の物理閉鎖、修復完了、writer再入0の受入を宣言しない。
STOP後の新GET・POST再送・代替key・D1 writerは0で、writerを返却した。
共有parser修正の全文回帰・root再レビュー・別phase grantが次の条件となる。
