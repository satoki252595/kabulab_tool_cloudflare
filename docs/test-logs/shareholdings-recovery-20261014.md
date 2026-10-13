# 株式保有明細の原典照合と継続更新（2026-10-14）

この記録はローカル実装・保存原本の検証結果である。本番schema変更・行更新・全件受入は別途読戻しの証跡で判定する。2行の原表解析を27,587行の原典照合完了とは扱わない。

## 保存済みデータの分類

再現可能な集計は [`shareholdings-source-diagnostic-20261014.json`](./shareholdings-source-diagnostic-20261014.json)。原文・graph本体・個別保有明細はGitへ追加しない。

| 観測事項 | 件数・結果 | 意味 |
|---|---:|---|
| graphの保有明細 / 保有会社 | 27,587行 / 2,231社 | 既存取込の範囲 |
| 銘柄コードあり / 未確定 | 25,651 / 1,936行 | コードなしは非上場の証明にならない |
| 旧株価あり / なし | 20,118 / 7,469行 | ありでも個別観測日・通貨は未確認 |
| 保存済み抽出結果と一意一致 | 27,587行 | 提出者コード・期末・銘柄名・旧抽出株数の一致 |
| 一致元がHTML表 / 平文化テキスト | 0 / 27,587行 | 表の列と単位の帰属を再証明できない |
| 株数単位の記述あり / なし | 27,586 / 1行 | 記述があるだけでは個別数値の単位を証明しない |
| 旧writerで株数・価格を原典照合した行 | 0行 | 旧値の正誤を一括断定しない |

旧writerは `/tmp/sh_analysis/notion_holdings.py`、抽出は `/tmp/sh_analysis/securities.py`。銘柄コードがなければ「非上場」、基準日は固定の2026-06-16、欠けた株数は0、抽出時は100株未満を除外していた。表を平文化した後の正規表現には当期列・前期列と単位の資格チェックがない。

元graphは7,177,700 bytes、SHA256 `b1552f1acabab8bf8cf46a44d0f2593bd388edd903c9ab1839f6b9724339f6c7`。保存済み抽出JSONLは24,916,983 bytes、SHA256 `bbb2ce9161e05c690eca1a49ac0d9a95e52d55caed8900f9af1aca60d0321acd`。graphの作成日2026-10-13と株価の日付2026-06-16は別物である。元ファイルは共有Notion物理アップロードと全文バイト読戻しで保全し、後者は20MiBを超えるため既存multipartアップロードを使う。

## 既存5列を保全するschema契約

`buildHoldingsSchemaPatch` は既存property IDを維持して下記の列名だけを変更する。27,587行のセル値は変更しない。同名の新正規列は別property IDで追加する。

| 旧列 | 保全後の列 |
|---|---|
| 区分 | 旧分類（未検証） |
| 保有株数 | 旧抽出株数（単位未確認） |
| 株価 | 旧株価（通貨・観測日未確認） |
| 保有時価 | 旧試算時価（未検証） |
| 基準日 | 旧処理基準日（観測日未確認） |

旧分類のoption IDも維持し、「上場」を「コード照合のみ（未検証）」、「非上場」を「コード未確定」へ変更する。上場区分はコード照合だけでは確定しない。期末・保有会社・銘柄コード・銘柄名は変更しない。

新正規列の「原本照合済」がfalseの行はformulaで「未検証（旧取込）」と表示する。原典照合できた行だけ、正規株数・帳簿価額・保有種別・出典キーを更新する。更新後も旧5列の値をGETで比較する。schema適用は準備時のnative schemaとfresh schemaが一致することを確認してから一回送信し、property ID・型・option IDを読戻す。

## 原表から確定できた範囲

保存済みS100Z2Z6（9273 / E34071、期末2026-06-30）のtype1 ZIP 622,690 bytesだけを使用した。追加のEDINET取得は0。対象要素は `jpcrp_cor:ShareholdingsTextBlock`、contextは `FilingDateInstant`、実ファイルは `XBRL/PublicDoc/0104010_honbun_jpcrp030000-asr-001_E34071-000_2026-06-30_01_2026-09-18_ixbrl.htm`。

要素内HTMLは31,928文字で、当期の株式数（株）と貸借対照表計上額（千円）を対応付けた2行を抽出できた。原表の見出し「銘柄 / 当事業年度 / 前事業年度」、行の対応、単位、提出者、期末をすべて検証する。入れ子の `ix:nonNumeric` と自己閉じnilは要素の終端と取り違えない。

確定株数は株へ換算し、帳簿価額は円へ換算する。株価・保有時価・価格観測日・通貨・上場区分はこの表だけでは確定しない。後述の独立原典による資格が成立した行だけ価格等を埋め、それ以外はNULL/未確認とし「欠測理由」を保存する。当期欄が横線なら0へ置換せずNULLとし、株数/帳簿価額の非開示を理由に記録する。

原典キーは文書ID・要素ID・ファイル名・context・表番号/行番号・ZIP SHA256・期末。本文の文字列だけを原表照合済とは扱わない。異なる表形、継続要素、複数の対象要素、単位不明、名前と数値の行不一致、同名の複数明細は理由付きHOLDとなり、既存値を上書きしない。

## 通常更新・再開の契約

共通writerは `src/shared/notion-archive/shareholdings.ts`。NotionへのRESTは既存の共有 `notionRequest` / `queryUniqueRow` を通す。追加のLLM・Yahoo取得・ライブラリはない。

1. 通常EDINET ingestは、従来の条件で取得したtype1 ZIPを `recordEdinetZip` で物理保存し、全文バイト読戻しが成立した直後に同じbytesをwriterへ渡す。保有明細だけのためにtype1を追加取得しない。
2. 通常catchup/backfillはrun全体で100明細の枠を共有する。並列backfillも最初の通信前に枠を予約する。通全体が残枠へ収まらなければ一部だけ公開しない。
3. type1原本保管行に「保有明細状態 / 保有明細理由 / 保有明細再開情報」を保存して読戻す。再開情報には提出者・期末・文書ID・ZIPのバイト長/SHA256・解析件数を残す。これはEDINET本文/財務のcompletedとは独立している。
4. 件数枠による既知HOLDは「再開待ち」。次の非shard catchupの先頭で最大5文書を、Notion-hosted保存ZIPのバイト長/SHA256を照合して優先再開する。EDINET upstream取得は0。未処理は原本行に残り、runは未完として終了する。
5. 未対応表形・5MiB超・100行超の通は「要確認」と理由を残す。通常枠より大きい企業は、明示した対象・上限（最大1,000行）の保存原本入口で全通処理できる。通常処理で切り詰めたり、恒久HOLDを完了扱いしない。
6. 行更新前に「実行中（結果未確定）」を記録する。全明細・旧値保全の読戻し後だけ「明細原本照合済」にする。mutationは `singleAttempt`。未知結果は停止し、次定時もblind replayせず読取照合を要求する。

既存の27587行にはtype1原本への証明がないため、schema追加だけで自動的に照合済にはしない。保存済み原本を特定できた通から明示復旧し、今後取得する年次原本は通常writerへ接続する。原本が保存されていない企業の一括再取得は今回実行していない。

手動入口は `pnpm exec tsx --env-file-if-exists=.env scripts/notion/shareholdings.ts`。

| mode | 入力・作用 |
|---|---|
| diagnose | graph/保存抽出JSONLから集計。外部通信0 |
| schema-plan | 保存native schemaから変更予定を生成。外部通信0 |
| parse-saved | 保存ZIPとsourceメタデータを解析。外部通信0 |
| apply-schema | fresh schema照合→schema一回変更→読戻し |
| publish-saved | 対象ZIPのNotion物理添付を全文照合→同じwriterで全通更新→読戻し |

書込modeは送信予約を0600のprivate journalへ先に残す。既存結果またはpending journalがあれば自動再実行しない。HTTP結果不明・読戻し不一致を成功にしない。

## 公式銘柄同定と期末参考時価（追加実証）

有報における「特定投資株式」は国内外の取引所上場銘柄を指すという[金融庁の説明](https://www.fsa.go.jp/access/22/201004b.html)を確認した（2026-10-14参照）。この表区分と、公式コードリストの「上場区分=上場」の両方を確認する。銘柄名の近似・旧graphの銘柄コード・上場一覧の第一候補は使わない。NFKC・空白・㈱/(株)→株式会社という同義表記だけを正規化し、法人格の削除や位置変更はしない。

2026-10-13現在の保存済みEDINETコードリストは11,414社、ZIP SHA256 `f65840ce54b4817583d02669cfbba8cbabf66d2225400a6ec0ee890450b86b0b`。S100Z2Z6の2明細とも公式提出者名へ完全一意一致し、上場区分・証券コード・EDINETコード・法人番号・英字商号を取得できた。コードリスト本体は共有Notion物理アーカイブと全バイト照合済みで、原典行番号・基準日・page/SHAを保存する。

対象コード4887/4272の保存済みYahoo daily raw（run `37202207552.1`、stage `vwap-daily-1530` / `vwap-daily-1200`）を発見し、既存Notion原本の一意照会・gzip全バイト読戻しを実行した。新しいYahoo/EDINET GETは0。gzip内部のbodyBase64を原本bytes長/SHAへ照合し、proxy URLの内側まで確認した要求は `interval=1d&events=split,div&range=10y` だった。

2明細ともsymbolと公式英字商号が一致し、JPY・Asia/Tokyo・2026-06-30の価格バー1本を確認した。期末後からraw captureまでの同じイベント応答にsplitはない（4887の過去splitは2024-09-27）。期末当日のraw `quote.close` × 同じ期末株数だけを「期末参考時価」とする。既存dailyの2桁丸め値、adjclose、局所的な分割係数は使わない。価格基準日は2026-06-30であり、raw取得日や今日の日付へ付け替えない。現在の株価・保有量およびraw capture後の状態は主張しない。

銘柄名/英字商号の不一致、同名やraw候補の重複、価格原典なし、期末当日の休場/欠測、期末後のsplit、観測範囲不足では価格を埋めない。通貨・symbol・原本SHAの矛盾は書込前の資格検証で停止する。価格資格は全行分を先に判定し、一部を更新した後で原本の誤指定に気付く順序を避ける。

追加正規列は「確定銘柄コード」「銘柄照合根拠」「価格照合根拠」「価格照合済」。区分はコードリスト原典で確認できた場合だけ「上場（コードリスト基準日）」とする。原本商号・コード・法人番号・基準日・原典行・page/SHA、価格原本page/gzip SHA/body SHA・symbol・raw timestamp・capture日時・要求範囲・価格/分割の基準を保持する。「価格状態」は同日期末株数×終値による期末参考時価と表示する。既に確定した価格を、後続処理で価格原本が未指定だったという理由でNULLへ消さない。

## 最新保存type1の再解析入口

`services/yuho-quant/data-scripts/backfill-shareholdings.ts` を追加した。D1の母集団は既存開示取込と同じで、各社の最大会計期末、その期末の最新提出日時、同日時の最大行IDで訂正有報を決定する。古い期末の訂正を最新年度へ取り違えない。銘柄コード順・明示cursor・1回1〜50社で全社を走査できる。

```sh
pnpm exec tsx --env-file-if-exists=.env services/yuho-quant/data-scripts/backfill-shareholdings.ts prepare 50 START /absolute/private/holdings-batch-001 /absolute/private/valuation-source-paths.json
pnpm exec tsx --env-file-if-exists=.env services/yuho-quant/data-scripts/backfill-shareholdings.ts apply /absolute/private/holdings-batch-001 1000
```

prepareはD1読取・Notion保存ZIPの取得だけで、原本provider取得・schema/行更新は0。最新type1の一意Key・単一hosted ZIP・バイト長/SHAを確認し、元manifestがある場合は照合、無い場合はunknownを保持する。原表解析と価格資格の結果をprivateの`.item.json` / `.current.jsonl`に出力する。現行投影はD1で選んだ最新有報だけから構成し、過去のNotion行や旧値を破棄しない。原本未保管・未対応表形等は理由付きheldとしてplanへ残す。

applyは準備後も同じ最新文書であることをfresh D1で確認する。銘柄/価格原本はrunで一度だけ全バイト再照合し、各type1も反映直前に全バイト再照合して、共通publisherへ同じbytesを渡す。明示上限へ通全体が収まらない場合は次回へ残す。成功通はreadback後のreceiptで再開でき、結果未確定journalが一つでもあれば自動再送しない。未対応・未処理がある回は非0終了する。planの`more/nextAfterCode`で次の範囲を準備し、heldを全件完了扱いしない。

実入口のreadonly準備で `afterCode=9272, limit=1` から最新S100Z2Z6を選び、2明細/2価格qualifiedの現行JSONLを生成した。これは本番行更新ではない。既に照合済みの同一期間行と異なる訂正原本の自動置換は現時点でsource差分HOLDとなる。過去価格を新日時へ付け替えることや、原典が変わった既存確定値を黙って上書きすることはしない。

## 費用・性能の上限と未計測部分

既存graphの会社別行数は平均12.365、中央値8、p95=42、p99=62、最大80、100行超0社。ただし旧抽出には100株未満の欠落等があり、これは原表の真の件数分布ではない。保存type1の実証は1通2行だけで、原表全体の日次平均件数は未測定。定時ログの `rows` とHOLD理由で継続観測する。

通常の追加publisher GETは0、Notion原本の二重readbackも0。明細は1行あたりunique query1回、変更時mutation1回、GET読戻し1回で最大3要求。100明細は最大300要求、共有380ms間隔だけで約114秒。原本の状態markerは1回あたりpreGET+PATCH+読戻しの3要求（正常通は開始/完了で6要求）、初回のschema資格確認は別枠。従って「100行約2分」は明細部分の下限見積もりで、ネットワーク待ちやmarker時間を含む実測ではない。既存300秒の開始予算を超えたら新通を始めず残りを次定時へ回す。

2231社の原本総サイズは未観測である。手元の1通0.594MiBを全社平均と断定しない。将来の明示復旧で1通5MiB、1run50通=250MiBと制限した場合、2231通の転送上限は10.89GiBとなる。この上限は取得の承認・全件完了を意味しない。今回の追加原本取得は0。

## 既存consumerと本番確認

repo内に旧5列を読む別consumerは見つからず、外部の旧単発writerが直接依存していた。以後はrepoの共通writerを使う。別repoの `/Users/satoki252595/work/20261011_kabulab/assets/app.js` はNotion列ではなく元graphを読むため、schema変更だけで表示は直らない。270行付近の上場断定、1187行付近の固定株価日付、未検証株数からの試算表示は、原典照合済フラグ・個別観測日/通貨・欠測理由を読む契約への対応が必要。当該repoは他の変更があるため今回直接編集していない。

本番確認は旧5列のproperty ID・セル値を保全したPRE、原本ファイルの全文バイト照合、対象明細の正規列・原典キー・NULL価格・旧値不変のPOST、原本行の保有明細状態を一組で行う。全件を未検証のまま残すschema変更だけでは機能完了にしない。

ローカル検証: 保存原本S100Z2Z6は `status=ok / 2行 / 期末参考時価qualified=2行`。価格・最新文書選定・schema・通常ingest・catchup・既存関連の11suite99tests PASS、担当ファイルESLint PASS、全体TypeScript PASS。本番証跡はroot担当の反映結果で追記する。
