# 財務の会社範囲・単位・年間配当の原本再検証（2026-09-28）

Issue [#124](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/124) の続き。
Notion③の財務ファクトと⑤の物理原本を対象とし、記事本文をD1へ保存する変更ではない。
初回全34,663件の原本再解析は失敗0で完了したが、独立確認で下記を検出したため、
その結果による全件のNotion/D1反映を停止した。原本値の推計や補間は行わない。

## 共通原因と修正

| 原因 | 初回監査での影響集合 | 原本による確認・修正 |
|---|---:|---|
| 会社範囲のdimensionを破棄 | 317原本・325項目 | 事業/地域等を除外。5918の売上はセグメント3,473百万円でなく会社全体4,422百万円 |
| EDINET CSVのユニットIDを破棄 | 非JPY 18原本・100項目 | JPY/JPY per share/pureだけを項目定義に合わせて採用。6269の同一要素にあるUSD売上をJPYとして扱わない |
| IFRS要素名の誤ったalias | 887原本・887項目 | `EquityToAssetRatioIFRSSummaryOfBusinessResults` は原文でBPS、unit=JPYPerShares。比率は別要素・unit=pureを採用 |
| 配当の最初のcontextを採用 | TDnet 2,768原本 | AnnualMemberだけを年額として採用。nil/不明な年間額を半期や期末額から推定しない |
| 半期/当期/翌期予想の混在 | 半期・通期予想共存1,098原本 | 通期予想に限定。翌期が存在すれば全forecast項目を同じ翌期に揃え、欠損を当期で埋めない |
| iXBRL別ファイルのcontext/unit未解決 | TDnet Document Set共通 | 先に共有resourcesを検証。同IDの異なる定義は停止。実績ResultMemberの期と異なる本表を割り当てない |

上記件数は初回結果の影響集合であり、最終更新件数ではない。
全TDnet 2,931原本を独立確認し、同IDの共有resource不一致0、解決後の未参照context0、
contextのmember制限による会社全体・連結・予想の誤除外0を確認した。

原文のunit/contextを失わず、採用候補が同一範囲・期・要素で複数の異なる値を持つ場合は
欠損と警告にする。比率はpureの確定的な%変換だけを行い、外貨換算・株式分割調整は行わない。
TDnetの本表には見出しと異なる未来の期間を持つ原本もある。3463は原本本表の期末が
2027-01-31であり、2026-07-31の実績へ推定移動せず、当期ResultMemberの
営業利益1,625百万円・経常利益1,232百万円を使う。

## 回帰検証

`pipeline/tests/fixtures/edinet/context-unit/` にcommercial-okのEDINET実原本4件の
抜粋・原公開URL/SHA256を保存した。TDnet原本3件は公開repoの既存ポリシーを維持し、
ローカルのignored ZIPだけで検証する。取得ポインタとSHA照合cache複製スクリプトを保存し、
未取得のCIではこの3件だけをskipする。初回CIで禁止fixtureの追跡を検出し、HEADから除去した。
当初6件の回帰は修正前parserで6件すべて失敗し、修正後は合格。
未知unit、隠れたdimension、複数値、使えない翌期値を当期で埋めないこと、共有unit不一致、
cache欠損/SHA不一致で停止することも検証する。市場数値を生成したfixtureは使用しない。
年間配当・予想年度・共有resourcesの構造回帰は原本の未取得にかかわらずCIで実行する。

- `nix develop -c uv run --project pipeline pytest pipeline/tests -o addopts='-rs' -q`: **1,261 pass / 55 skip**（既存の未取得原本fixture）。TDnet local-only原本を除いたCI同等の関連回帰は **43 pass / 3 skip**。
- `nix develop -c uv run --project pipeline ruff check pipeline`: 合格。
- converterとnormalizer両方を監査fingerprintに含める。今回のparser SHA256は
  `d82afc2d0ff05eb257b0f9c75383bb27ce562be8c5052b873f5067d25471087e`。
- SHA照合済みの全34,663原本cacheをAPI呼出0で再監査中。
  新fingerprintの全件結果を確認するまでは全件反映を行わない。

## 優先修復の再確認

先行修復済み26原本/25財務キーを新鮮なNotion読取で照合し、現在の正本25キーを
新parserで再監査した。追加修正対象は次の5行であり、この時点では再反映前。

| コード | 項目 | 現行正本 | 原本再確認値 |
|---|---|---:|---:|
| 8154 | 年間配当予想 | 70 | 140 |
| 7509 | 年間配当予想 | 80 | 160 |
| 9257 | 年間配当予想 | 13 | 19.49 |
| 7699 | 年間配当予想 | 12.99 | 未取得（AnnualMemberはnil） |
| 3463 | 営業利益/経常利益 | 1,625,650,000 / 1,232,259,000 | 1,625,000,000 / 1,232,000,000 |

7699の通期売上85,302百万円、純利益2,745百万円、経常利益3,388百万円、EPS114.32は保持。
独立の原本確認でも年間配当4件と8154のROE pure→%変換を確認した。
8154の古い有報の年配当165円は期中分割前後の原文単純和であり、翌年度の調整済み比較値110円と
同じ株数基準ではない。原本165円を推定置換しない。9257の19.49も半期/期末値を再合算しない。
年度比較の株数基準・JDR換算の表示は下流の別契約で扱う。

反映はPRのCI→Notion更新/再読receipt→既存行を含む実隔離D1の差分・冪等検証→source D1の順。
旧archive receiptは退避先のリンク証拠にのみ使い、数値は必ず今回のparser原本と
新鮮な正本再読で照合する。古いparserの数値を新しい検証済み値として流用しない。

## 全件反映のAPI削減

各PATCH後の個別GETを既存50コードまとめqueryによる新鮮な再読へ置換した。
PATCH応答を再読証拠として扱わず、batchの全対象数値・旧退避ページ・新キー一意性が
一致してからarchive/receiptを許す。不一致時はどの旧ページも退避せず、receiptを出さない。
途中更新済みの値は次回の新鮮queryで再確認して再開できる。未変更batchは最初の
新鮮queryを使い、再PATCH/個別GETは行わない。
2.5rpsを維持したまま、再読約3万件を数百queryへ減らせる。約7〜8時間のAPI待ちを
約4時間へ短縮する計画であり、実所要・件数は全件完了後に固定する。

## 公開仕様

- [EDINETタクソノミ設定規約](https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/download/ESE140303.pdf) §4-1（通貨・perShare・pureのunit）。
- [Notion API制限](https://developers.notion.com/reference/request-limits)。正本APIは既定2.5rps。
- 今回のcache再監査はNotion APIと原公開APIを再取得しない。圧縮64MiB/展開128MiBの
  原本上限とZIP SHA256照合を維持する。

## 全原本監査・優先5行の反映後（同日追記）

上記の「監査中」「再反映前」はPR #128時点の状態。以下はその後の実行記録。

- d82版の全34,663原本再解析が完了。失敗0、API呼出0、所要2,894秒。
  journal SHA256は `0457245d00092510065ae27ed977efcafff1b3511172b5f9ba6151b6b8fd59af`。
- 変更34,407原本、不変256。連結29,827/単体4,836、EDINET31,732/TDnet2,931。
  初期正本からの数値項目差分は欠損復元146,565、欠損へ変更1,727、訂正10,418。
  非欠損328,363項目の会社範囲・単位・原本値・実績期/予想年度を独立照合し、違反0。
  これは利用可能な原本値の完全復元を保証する検査ではなく、欠損側も別途確認した。
- 優先5行はNotion更新後に新鮮なまとめqueryで再読し、原本と一致。
  実隔離D1の346行で変更5行/無関係341行全列不変、再同期で冪等を確認してからsource D1へ反映。
  source D1も346行、同じ5行だけ変更し、341行全列不変。
  優先25キーの原本監査SHA256は `717cbb69d0f2f77ef03d1b9292bb7b1af4223b5588b3a3b9041e0c1b6bb440a6`、
  新鮮な再読receipt SHA256は `4c0103dc20414c3bc224b651aa149936c88b8799e081acc7faad0b53ae4a7bdd`。
- 全Notion反映を2.5rpsで開始し、799原本の新鮮なまとめ再読まで完了した後、
  下記欠損の共通修正を最終結果へ含めるためbatch境界で停止。次batchのGET中に安全終了し、
  完了receiptを保持。全原本監査の完了と、全正本修復の完了は区別する。

### 欠損側の独立監査と中間期Instant

四半期/中間でBPSか自己資本比率が欠損する20,738原本をcacheから独立確認し、
会社全体・単位・同じ要素/連結区分の中間期末と年度末が競合する例は7384の1原本2項目だけだった。
EDINET `S100UTIN`（2024-09-30中間期）の原文は次のとおり。

| 項目 | 当中間期末 `InterimInstant` | 年度末 `CurrentYearInstant` | 原unit |
|---|---:|---:|---|
| BPS | 5918.24 | 5891.78 | JPYPerShares |
| 自己資本比率 | 0.0281 | 0.0280 | pure |

CSVは絶対時点日が空でも相対年度が明示されるため、中間期の2項目に限って
InterimInstantを選ぶ共通修正を行った。自己資本比率はpure 0.0281→2.81%のみ。
同じ当中間期末で数値が競合すれば欠損を保持し、Duration/予想/配当/FYの選択規則は変更しない。
原公開URL・原ZIP SHA256と無変更のCSV全列抜粋をcommercial-okのEDINET fixtureへ追加。
実原本と同時点競合回帰を含む関連92件、全pipelineテスト（1,264 pass / 既存55 skip）、ruff、diff checkが合格。

新parser SHA256は `fdfa3c89039dfc27e6a0328dff7ccd05fd6ecb250a49019be097e2b090bfb914`。
全cache再解析をAPI0で進め、d82版からの差分確認・CI・原本確認を終えてから全Notion修復を再開する。
反映済みの同一数値を再PATCHせず、新鮮なまとめ読取から新receiptを作る。
全source D1反映は、全Notion再読receiptと実隔離D1の全件差分・選定影響検証後に行う。

## 最終全原本監査（正本修復とは別の完了判定）

7384のInstant優先修正後のparser SHAは
`fdfa3c89039dfc27e6a0328dff7ccd05fd6ecb250a49019be097e2b090bfb914`。
全34,663原本をSHA照合cacheから再解析し、失敗0、49分48.6秒、Notion API 0回で完了。
独立サブエージェントも全件を照合し、旧d82版との差分は7384のBPS
`None→5,918.24円` と自己資本比率 `None→2.81%` の1原本2項目だけ。
原本SHA・URL・format・旧断面の変化、許可外差分、未来の実績期末、不明キーは0件。

最終journalはprivate `/tmp/kabulab-financial-full-instant-final-audit.jsonl`
（80,645,487 bytes、SHA256
`3be26f4dee1db4881ddbce3d478ba4b68cb9e6b9408410b242798db8e954364e`）。
原本・全行JSON・引用本文は公開Gitへ保存しない。

| 内訳 | 件数 |
| --- | ---: |
| TDnet / EDINET原本 | 2,931 / 31,732 |
| 連結 / 単体 | 29,827 / 4,836 |
| 1Q / 2Q / 3Q / 中間 / 本決算 | 5,177 / 3,817 / 4,301 / 8,340 / 13,028 |
| 旧liveから変更する原本 / 正しい財務キー | 34,407 / 34,659 |
| 原本context・unit適格性を照合した数値 | 328,365 |
| 旧liveからの数値復元 / 除去 / 訂正 | 146,567 / 1,727 / 10,418 |

優先26原本・25live行は全項目不変。source D1反映済みの年配当・ROE等は今回も同値。
隔離D1とsource D1のcore id/code全3,810件は、実読取で完全一致を確認した。
現行通常writerもNotionと同じNULL完全置換へ修正済み（PR #131）。

追加レンジ監査で543Aの自己資本比率 `-40,758,261,600%` を原本へ戻って確認した。
EDINET S100YK16のpure値・経営指標本文とも同値で、設立期・発行株1株・単体の値。
BPS/EPSも原値と一致し、閾値でNULL化したり株式交換後の株数で推定補正しない。
統合後の連結数値との比較は、範囲・会計基準・1株の基準を確認してから行う。
原文の詳細証跡はprivate `/tmp/kabulab-financial-543a-independent-raw-proof.json`
（SHA256 `43fbb7958cb29dc67fc7e3958aec95f66e83d20e857cda84fa63ffe2567c3f30`）。

### 正本修復の再開

2026-09-28 04:10:59 UTCに最終journalから全Notion修復を再開した。
先行799の実receiptは退避済みページのリンク証跡として保持し、最新parserの証明は
新鮮なまとめqueryから取り直す。最初の773原本は再PATCHなしで再証明済み。
sourceの通信上限は既存2.5 rps。既存throttleはmonotonicの送信開始間隔制御なので、
応答後の固定sleepを追加せず、ネット待ちを含む実時間とRetry-Afterを尊重する。

全原本監査の完了だけで、全Notion修復・全D1同期を完了扱いにしない。
全fresh receipt→実隔離D1の全件差分・冪等性→現行共通SQL/SHORT権利ゲート差分→
同じ基準のsource D1同期・再読の順に、後続の実測を記録する。


## 全正本修復・実隔離D1の完了

全Notion修復は2026-09-28 07:28 UTCに完了した。全34,663原本の最新receiptが
今回のparser SHA・元ZIP SHA・元原本の訂正後キーと一致し、34,659個の正しい財務キーを
全項目の新鮮な再読で再証明した。4件の同一キー合流は、新しい開示を保持した同一ページ・
同一キー・監査済み全項目完全一致の証跡を持つ。未知の変更を拒否する条件は緩めていない。

- 最終receipt SHA256: `8a7ce621743b21a121cc93aa21bb3181f4e8bcee08d53dc9cd3da31dd85a3a0d`。
- 最終並列再開区間は65分44.2秒、完了要求19,876回（PATCH 19,244 / query 632）、
  最大同時要求4、最後のin-flight 0、再読receipt未回収PATCH 0。
  429/529・HTTP失敗・再試行警告は0。停止前の直列・旧並列区間はこの要求数へ含めない。
- `already_reparsed` 15,415原本、`reparsed` 19,244原本、新しい開示の保持4原本。
  修復済みの値を無意味に再PATCHしない。
- 4 workers / 6 rpsは今回の私有起動だけで使用した。通常既定の直列2.5 rps、
  `.env`、既存ジョブ、原本・parser・licenseは変更していない。

実隔離financial D1では旧346行から34,659行へ同期し、34,394行を追加、原本・公表日時・
sourceの照合済み旧誤キー81行だけを整理した。旧キー保全条件不明0、新しいD1開示の保護0。
同じ全件同期を再実行し、全33列・全キーの完全不変を確認した。
独立読取レビューでも原本・receipt・core対応から全34,659行33列を別に再構成して一致した。
SHA不明の旧書類IDを原典証明として引き継いだ行は0。

隔離2回の所要は872.108秒。D1の返却metaの観測合計は1,279応答、
rows_read 401,963 / rows_written 103,793。これは課金額の推定ではなく返却metaの実測であり、
通信内部の再送を含む請求全体を保証する数値ではない。原本JSONや引用本文をGitへ保存しない。

### 現行SQLとSHORT出来高分岐の差分

新日次前の読取statusの参照日は2026-09-25、公表cutoffは現行契約による
2026-09-25T21:00:00Z。これは新しい実日次の成功証跡ではない。
実隔離D1のbefore/after、現行mainの財務月SQL・権利月計算・SHORT setup gateを使った。

| 観測 | 旧財務 | 修復後財務 |
| --- | ---: | ---: |
| core 3,810銘柄の本決算月既知 | 154 | 3,793 |
| 権利取りwindow内 | 2,516 | 2,413 |
| 株価日9/25の3,698銘柄で出来高分岐pass | 121 | 98 |

権利window状態の変化は1,251銘柄、出来高分岐gate状態の変化は103銘柄。
イベント材料を投入していないため、これを全selectionの差分と呼ばない。
8154は本決算月3月・権利window内・出来高分岐failで前後とも同じ。
現main SQL SHA256は `8e8b2d00e13daa029bb0a6b4c3d0e1f9b83350205ec217bf4fd2007eeb6e2ddd`、
隔離proof SHA256は `395d2f383f58ff479c62a145aa74523f25a7ccf430310ae0375aa0766a9c9ea0`。

修復後の履歴は公表cutoff以前34,659行、公表日不明0。
core 3,810中3,800銘柄に履歴があり、原本未取得の10銘柄は補間しない。
過去コード等のstock_id無し1,967行は既存nullable契約で保持し、架空の株式IDを作らない。
一時D1はfinancial検証だけに使い、他11テーブル約114k行のコピー・常設DB追加は行わない。

既存source D1への全件反映は、同じ33列の旧断面・core対応が新鮮な読取で隔離前断面と
完全一致することを要求し、全正本再読後にのみ書き込む。source結果が隔離afterと全33列一致する
後続proofを得るまでは、全source反映と下流サービスを品質合格として扱わない。


### 既存source D1の全件反映

2026-09-28 07:47:41 UTCに既存source D1への単一全同期を開始し、07:53:19 UTCに
338.204秒で終了0を得た。書込前の全346行33列・core対応3,810件が実隔離のbeforeと
新鮮な読取で完全一致し、全Notionを再読してから既存jss_financialsへ同期した。
同期後も全34,659行の新鮮な読取が隔離afterと全33列完全一致した。
他テーブルへのwrite・新しい常設財務DB・114k行の複製は行っていない。

sourceでも34,394行追加・旧誤キー81行整理・保持240行変更、未知旧キー保全0・
より新しいD1開示の保護0。公表日不明0、core 3,810中3,800銘柄に財務履歴。
HTTP失敗・Notion再試行警告・Tracebackは0だった。
返却metaは643応答、rows_read 169,121 / rows_written 138,452。
D1返却metaのwrite数はレコード追加件数ではないため、34,394行追加と混同しない。
sourceへ二重実行せず、冪等性は先の隔離2回とsource全列一致で確認した。

private source proof SHA256:
`e3ce0bc704fd6b2caa0244cdbcf08477d0830b2a1e73bc0cccc80d8dbbf4c619`。
全原本監査、全Notion修復、隔離D1、既存source D1の各完了を分けて記録した。
下流kabulabAgentsの新しい実日次・AI記事・詳細・公開は、そのリポジトリの正式releaseと
閲覧検証で別途確認する。この財務proofだけでサービス全体を品質合格にしない。

### TDnet出典番号の欠損を隠さない

修復後EDINET 31,730行はdoc_idとraw SHAが全件存在する。
TDnet 2,929行はraw SHAが全件存在し、同じ原本metadataからdoc_idを保持できた144行以外の
2,785行は番号不明を維持した。未知原本SHAから古いdoc_idを引き継いだ行は0。

2,785行を既存journalで照合すると、全件がNotion⑤に実体保管されたTDnet iXBRL ZIPであり、
元取得URLのhostはwww.release.tdnet.info、拡張子.zip、元⑤ page_idとSHAは全件存在する。
ZIPのSHAとiXBRLのcontext/unitを検証したことを、PDF本文の閲覧検証とは呼ばない。
Notion③の財務行と⑤の原本schemaはdoc_id欄を持たず、通常ジョブが元開示レコードから
D1へ直接渡すPDF番号を歴史移送では復元できない。ZIP番号からPDF番号を推測しない。

既存の到達経路は③「原本」relation→⑤ page_id→添付ZIPであり、⑤のSHA検索も既存。
D1 raw_sha256→jss_raw_files.sha256→保存済みR2 keyと、既存jss-apiの
`/v1/files/:sha256`・`/v1/files/:sha256/content`、内部MCP `jp_raw_file`もある。
この2,785件すべてのR2索引coverageは今回のfinancial-only proofでは検証していない。
未確認のkey・新しいendpoint・推測URLを作らず、Notion原本の確認済み範囲と
PDF番号・閲覧導線の未確認範囲を下流へ区別して伝えた。


追記のsource実読取1 query（08:01 UTC）では、doc_id無しTDnet 2,785行に対応する
jss_raw_filesのSHA索引・r2_key・doc_idはすべて0件だった。
R2物理オブジェクトの不存在を証明した結果ではなく、既存SHA endpointが必要とする索引が
未接続であることの確認。下流財務readerはraw SHA/⑤ page_idを渡さず、財務表の出典文字列を
flattenしているため、この既存Notion原本relationは記事の出典リンクへ継承されていない。
別経路の開示documentUrlは保持されるが、各財務原本との同一性はこの検査では未証明。
source修復の成功と原本の画面到達性を混同せず、残る導線gapを下流ownerへ報告した。
この確認ではsource書込・新しいendpoint・推測URL・下流HEAD変更を行っていない。
