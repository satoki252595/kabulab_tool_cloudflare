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
