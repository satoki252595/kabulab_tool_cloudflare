# 最新有報の保有明細 prepare（2026-10-14）

Issue #348。最新保有明細の準備は保存済み type1 のみを使い、EDINET/Yahoo GET・AI・本番業務 write を行わない。母集団は active 普通株に限定する。03:20 JST の D1 読取では active 3,686、年次有報（120/130）あり 3,666、D1 年次有報なし 20。年次有報なしを公式原本未提供とは断定しない。

現行 type1 key が存在すれば、その原本だけを読む。不在時は legacy bare-doc key の単一 hosted type1 添付を明示的に読む。CSV は代用しない。docID と実 metadata の stockCode/secCode/rawSecCode、存在する EDINET/期末、原本の公式 jpdei namespace・提出者/証券コード/会計期末 DEI・全 SHA を照合する。旧 manual primary の EDINET/期末 metadata 欠測は欠測一覧を残し、実 DEI を根拠に同定する。metadata 自体は書き換えない。未割当 00000/未観測のコードは公式提出者逆引きの追加証拠なしでは HOLD、非0不正は保全停止する。

最初の active 50 通の旧parser観測は 23 ready / 27 HOLD、246 明細で、保有主体資格が不足するため旧planは未受入とする。保存 ZIP 45,319,647 bytes（typed 19 / legacy 31）、原本不在0という保管観測は保持する。既存 13 ZIP・10,430,955 bytes は保存 SHA・DEI・fresh metadata の再照合で再利用し、再ダウンロード 0。測定処理 212.70 秒（別途 cache 照合約26秒）、Notion 106 requests（cache 照合13 requests別）、D1 1 read（cache 選択1 read別）、hosted 37 GET / 34,888,692 bytes、peak RSS 342,048,768 bytes。Notion mutation / R2 operation / upstream GET / 本番業務 write はすべて 0。local disk 空きは約1.3TiB。

HOLD 27 は、資格を確認できる明細表なし22、ヘッダ/単位/当期の不適格2、行対応不適格1、同名複数2。明細表なしは原表の非保有を確定した意味ではない。保存価格は既存の2chunks・60symbolsに限定し、246行は価格未成立（対象symbol原本不足208、公式提出者名の完全一致なし25、株数非開示13）。金額や価格を推定補完しない。

最初の50で、明細表なしを除く5件を保存 ZIP だけで別診断した。単位をセルに明示した上下段形式、追加の金額単位ヘッダ行、数値先頭の限定注1/2が各1。複数明細の2件は、特定投資とみなし保有の別種別、提出会社と連結子会社の別保有主体だった。前期列の誤採用とは区別する。自然キーに保有種別を追加し、parser/shared writerは当社/提出会社の明示区画資格を必須にした。別会社区画の当社を提出会社へ読み替えない。単位/行対応/当期の保存ガードは維持し、限定注1/2 prefixは数値を変えず正規化する。

同じ保存50 ZIPの新parser再解析は24 ready / 26 HOLD・252行。5件の構造不適格は解消したが、旧readyの4通53行は名義別区画2・主体不明1・種別/ヘッダ不明1としてHOLDへ戻した。新HOLDは明細表なし22、名義別区画2、主体不明1、種別/ヘッダ不明1であり、非保有や原本未提供を断定しない。価格資格は新projectionで再計算するまで未受入。

旧pilot S100Z2Z6の2行は実際には子会社コーア商事株式会社の保有だったため、rootが保有会社名を訂正・保有会社コードを空欄・原本/価格資格falseへ戻し、全props読戻しを完了した。数値・原本・価格証拠・旧列は保持している。新parserで元ZIP全SHAを照合した実回帰は no_detail_table / filer-only0 / unqualified。PREと主体証明のNotion pageは `3f8d74ff-84cd-8196-b642-f8dd9e0f632b`。原文はpublic fixtureに複製しない。

process開始時にparser source SHAを捕捉し、item/planへ固定する。prepare完了前とapply前/各itemでdisk同値を検証し、SHAのない旧planや別versionは書込前に拒否する。最初100通と途中chunkの旧planは保存して無効化し、同じZIPcacheから別dirへ再解析する。

全 cold 概算は Notion 約9.7k requests、ZIP 約3.32GB、0.5 request/sec で約5.4時間。one-off の準備で本番 storage 増加0・R2 operation0。実分布差を記録しながら同レートで残対象を継続する。50通ごとに private plan / source SHA / current projection / measurement を保存し、unknown・不一致は自動再送せず停止する。Notion 占有時は private `holdings-latest-all/PAUSE` marker を次 item の type1 query 開始前に待つ。source producer が変化した場合も次 chunk 開始前に停止する。現在はparser修正のためitem境界でpause中で、新版の再解析完了後に再開する。最後に fresh active 最新文書集合へ突合し、旧文書化・欠落があれば未完として報告する。

検証: holdings 4 suites 51 tests、owned ESLint、diffcheck成功。担当TypeScript errorは0（共有全体checkの他担当編集中errorは別報告）。元S100Z2Z6と最初50 ZIPを全SHA照合して再解析し、upstream GET / 本番業務writeは0。全量 prepare / 本番適用 / 全価格の照合完了はまだ未達。

## 固定保存価格snapshotの索引と実測

価格段階はsource分類と分離する。限定60symbolsの原本で不在だったことを、保存全体の価格不在とは断定しない。初回100通の価格評価と、powerx英字商号の句点不一致によるSTOPは保全し、当該商号の正規化を広げない。現在の全量prepareは別dirのsource-onlyで、価格stageは未実施と明示する。

固定run `37202207552.1` の保存116chunksだけを調査した。保存native Notion116行のKey・hostedファイル名・manifestとlocal gzip全文SHA、各member全文SHA/byteLengthを照合し、既存daily parserでも全3,456membersが妥当だった。3,456symbolsで重複0。gzip173,188,326 bytes、展開630,937,457 bytes、原body471,923,669 bytes。13.53秒・peak RSS270,041,088 bytesで2,717,866 bytesのmetadata索引を作成した。索引は署名URL・bodyBase64・個別価格値を含まない。Notion観測は10/4保存物であり、fresh本番custody読戻しは未実施である。

`HoldingsPriceIndex` は明示的な索引入口とし、原本SHA・候補のbodySHA/要求/chart検証を共有する。通常のarray入力も同じstrict coreを通り、英字商号・通貨・symbol・要求・SHA・期末・分割の資格を緩めない。固定全体の候補一意性を確認してから1chunkずつ評価し、解放する。異なるsnapshotから都合のよい価格を選ばない。

実際の新source-only最初100通・587明細と固定snapshotの代表fullchunk（1,919,422 bytes）で比較した。代表は対応明細数52が最大のchunkを処理量基準で選び、価格結果では選んでいない。

| 観測 | 通常の反復array入力 | 明示index共有 |
|---|---:|---:|
| 所要 | 9.393秒 | 0.152秒 |
| peak RSS | 203,423,744 bytes | 174,424,064 bytes |
| gzip内JSON展開 | 504回 | 1回 |
| chart JSON解析（既存validatorとraw close読取） | 104回 | 30回 |
| 全587行の結果SHA | `abefa91bc429c24395f199af50754facbfb9d4260d3fe7640efb90017b2e328e` | 同値 |

この代表chunkの価格qualified30行等は性能・同値の検証結果であり、全価格の受入ではない。全原本のfresh custodyと全明細の価格評価は後段に残る。診断では既知の資格不一致を行別の明示STOPとして保全し、全体を未完にする。未知transport・物理SHA・manifest不一致は全runを停止し、自動再送・business applyを行わない。

追加検証は価格12testsを含む関連5 suites63tests、全体TypeScript、担当ESLintでPASS。計測・診断の原本GET、Notion/R2 mutation、本番業務writeはいずれも0。
