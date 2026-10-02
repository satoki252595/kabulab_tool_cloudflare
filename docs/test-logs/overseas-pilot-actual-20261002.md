# 海外原文pilot 1通の実績（2026-10-02 JST）

対象は `S100YJVF` の type1 だけ。root が固定 PLAN / runner SHAをレビューし、
取得・Notion原文保管・資格確認までを別のACQUIRE grantで許可した。
D1 native / mutation、type5 GET、dispatch は初回ACQUIREで0。
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

## 初回ACQUIREの全文資格がHOLD

初回実行時のfull parserの結果は `geo_present_unstructured`、facts0、proofなし。
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

## 初回STOP時点の未完了と費用計数

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

## 共有修正後の同一ZIP資格とPRE-only実績

共有修正 [PR #262](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/262)
は実一意のXBRL期間・発行体・dimensionなしを用い、期名による推測をしない。
印刷期との矛盾、unknown current、重複context、地理未分類のguardを維持した。
独立18回帰PASS、取得済み同一ZIPのwhole parserとdiagnosticを同じcaptureで
再判定し、当期・連結の数値4factsとsave-set資格が成立した。
前期・当期の別表2件は「その他」の既存table-local未分類として却下され、
都合のよい数値候補へ変換していない。初回HOLD記録・原clock・sourceキーは不変。

rootが別PRE-only grantを発行し、`2026-10-01T18:55:59.684Z` から
`18:56:08.662Z` まで1回実行した。追加source GET / type1再POST / D1 mutationは0。
fresh PREはexact2 SELECTでdoc全16列・4facts各12列を取得し、現行4factsに
連結区分の差4件を確認した。値・本文は私有証跡だけに保持する。

| 計数 | PRE-only追加 | PRE完了時の累積 |
|---|---:|---:|
| source GET | 0 | 1 |
| Notion native | 8 | 26 |
| hosted GET | 1 | 2 |
| D1 SELECT / mutation | 2 / 0 | 2 / 0 |

旧20 nativeを全ledger・原HTTP bytes/clockごと引き継いだ。追加11 nativeは既知で
actual unknown0。既存原本の資格・SQL・fresh PRE・元と新しいHTTP入出力の
operational PRE ZIPは3,744,207 bytes、SHA256
`31b58dc8c6356ecbbdfeec0a73fedc05d3bc5d1ca3702a58d3833800a089e03a`。
Notion receiptは`recorded / written`、hosted添付の全bytes/SHA照合も完了した。
acquisition SHA256:
`60c53675937c5d187ec5ef6a2beeed4469a97934110ab3ed201ad2086adf81ec`。

fresh PREの2 SELECTを追加するためrootが**今後のD1 native capだけ14→16**へ
明示的に拡張した。初回の14 cap・20 consumedの歴史は変更しない。
source1 / Notion50 / hosted3は不変、全cap70・現在consumed31・remaining39。
prepare D1は2まで、後続applyは追加14までという別phaseで管理する。

PRE物理閉鎖まででwriterを返却して停止した。この時点ではCAS / facts置換 / L2 /
POST evidenceは0、apply grantも未発行。原本の再取得・既知source/PREの再POST・unknown再送は0。
最終適用と全32列L2照合は、actual fresh PRE/packet/SQLのroot再レビューと
別apply grantを要する。旧3611全体や次候補の修復完了へ外挿しない。

## 別APPLY grantによる1通の実適用・POST物理閉鎖

rootと別担当者がfresh PRE・packet・原子SQL・全156pinを独立レビューし、
source再GETと既知source/PRE再POSTを許さない別APPLY grantを発行した。
実行は `2026-10-01T19:11:58.039Z` から `19:12:06.513Z` まで1回。

- 原子doc batch送信1回、`APPLIED=1 / held=0`。
  共有closed44 coreが送信前にdoc全16列・facts全12列の件数と双方向EXCEPTを検証し、
  適用後も全business列・parent identity・生成idの型/一意性を照合した。
  4factsの連結区分差を解消し、doc protected14列は保存した。
- 当該stockIdだけのL2 rebuildはPOST 1行・全32列でexpectedに一致。
  timestampもtyped正規化して比較した。別銘柄や全体rebuildは行わない。
- 同じdoc producerの再入は`MATCH / senderCalls=0`、L2は再実行0。
  この確認をL2 producer自身の再入0の証明と取り違えない。
- 新source GET、既知source/PREの再POST、unknown outcome、再送・代替keyは全て0。
  元のACQUIRE HOLD・source receipt・old UNKNOWNは不変。

| 計数 | APPLY追加 | 終了時の累積 |
|---|---:|---:|
| source GET | 0 | 1 |
| Notion native | 8 | 34 |
| hosted GET | 1 | 3 |
| D1 native | 14 | 16 |

追加23 native、累積54 nativeが全て既知。D1 14の内訳はdoc pre2 / batch1 / post2、
L2 pre1 / source読取3 / upsert1 / sweep1 / post1、same doc再入読取2。
fresh PRE2を含めD1 cap16まで消費した。source / hosted枠も消費済みで、
同grantの残枠はNotion16だけ。cap70の余りを新対象取得や別適用へ使わない。

operational POST ZIPは11,366,935 bytes、SHA256
`3c0aa5e55b49589641f0326100c7809c36fe91e3c1ad2a1c1d912554474321be`。
`recorded / written` receipt後にhosted添付の全bytes/SHA照合を完了した。
完了receipt SHA256:
`8ebef8f0ab49937d62d4fc96f5b85fcc8a23a5a0aee804391f97fb7ae46a1cf9`。
PRE/POST原HTTP入出力・原文・財務値は私有0600で保持し、本文や値を公開していない。

source / PRE / POSTの物理閉鎖と1通のfull16/all12/all32適用確認まででwriterを返却した。
**この結果はS100YJVFだけ**。旧3611全件・次15候補・原本の来歴/バイト資格が不明な旧10件の修復完了とはせず、
新対象sourceや別APPLYは追加のscopeレビュー・grantを要する。
バイト数・API回数・所要時間は実測だが、請求額や月次全件外挿はここでは未測。
