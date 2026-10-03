# 残件の追跡と重複取得の修正 — 2026-10-03

Refs #117 #132 #146 #160 #163 #196。前回受入は
[残件・費用](remaining-ops-20261002.md)と
[VWAP後続定時](vwap-followup-scheduled-20261003.md)を参照。
公開Gitには件数・時計・SHA・公開リンクのみを残す。原応答、財務値、Notion ID、認証値は私有保管する。

## VWAPの日次再開

保存済みサマリ2通と最後のエラー原文を、既存共有窓口で全文再読した。
Notion 5 HTTP・添付3 HTTP、Yahoo追加取得・本番書込・再試行は0。
両実行は同じ3,689銘柄の母集団SHAを持ち、初回written 769と後続written 510の
重複は510、後続固有は0、保存結果の銘柄和集合は769だった。1,279銘柄の進捗とは扱わない。
510件の送信body SHAはすべて異なるが、時計・メタデータも含むため価格値の変更とは断定しない。
現在のR2全量・対象日充足率は未観測であり、この過去集合と区別する。

最後の83 B原文はHTTP 429、upstream marker 429、Retry-After 900秒。
受信2026-10-02T14:42:50.883Z、再開下限14:57:50.883Z、
SHA `eaa3df17f6d16906839cdb7c7dcadaee87a226237c8af70ecbdb4de46ba4391f`。
認証段階・Chart内訳は未測定。今回の初回純検証はサマリの実ラベル`10y-full`を
`10y`と誤って比較してHOLDになったが、保存済み全原文だけで再分類し、追加HTTPなしで解消した。
rootも全8応答・3添付manifest・gzip原文・全銘柄集合を独立検証した。
独立証明628 B SHA `648ea0d407fbe853e97f0802725ee29991cc263c04f856f07397ceefd550849d`。

原因は、R2の日足が存在しても毎回Yahooの10年範囲を取得してからPUT差分を判定していたこと。
同じ取得日の確定済みセッション、原応答SHA、全採用足の日付、価格snapshot SHA、
要求範囲が一致する完成証跡を保存し、次の同日再開ではYahoo取得前に除外する。
旧形式・未確定・原応答内の欠損足・別対象日はこの除外条件を満たさない。
同日中のベンダー訂正を自動追跡しない限界をコードに明記した。
既存769件をこの完成証跡で受入済みとは扱わない。

## JPXの月次新様式

公式[株式](https://www.jpx.co.jp/markets/statistics-equities/investor-type/00-01.html)、
[ETF](https://www.jpx.co.jp/markets/statistics-equities/investor-type/02.html)、
[J-REIT](https://www.jpx.co.jp/markets/statistics-equities/investor-type/03.html)の一覧と
公式仕様サンプルを各1回取得した（HTML 3・XLSX 3、再試行0、07:52:08–13 UTC）。
サンプルの全物理バイト列を私有保持し、Gitのfixtureは見出しのみ・数値セル0とする。

| 仕様サンプル | bytes | SHA-256 |
| --- | ---: | --- |
| stock_1_mYYYYMM.xlsx | 15,299 | 65610195e7fdc174faec584a0e9eaa7184dd350e749164864a638245feaa92be |
| etf_mYYYYMM.xlsx | 11,973 | d3689b9bae6b8149d0b2d5f1b41efaa672bf8d06bb8ce102a11e2ff3943c8990 |
| reit_mYYYYMM.xlsx | 11,749 | 0d0375f1d434cc1c58ed4e97206c01bc91ba5ab2bfd1c3c9b07d0a1e822b2fef |

株式は4市場×14葉部門×株数/金額、ETF/REITは13葉部門×口数/金額の構造に対応する。
月次の年月は実コード・数字ファイル名・取込キーを照合し、未掲載の実集計開始/終了日は
両端NULLとする。年月・月次指標が一致しないNULL、片側だけのNULLは共有検証で停止する。
親合計・構成比・市場全体値を合成しない。ETF/REITの観測ログは既存の金額2指標×13葉=26行で、
口数は原本・解析結果に保持する。株式の仕様サンプルに含まれる過大な仕様値は既存の桁検証で
拒否するため、本番の実値受入や112件の数値成功とは扱わない。
文字YYYYMMのサンプルを本番取得から除外し、実月次ファイルでの受入は公表後に残る。

## 本文不足90銘柄の原本検索

従来の13非有報・7TDnetのみ・70未観測という分類は、当時の保存一覧の観測範囲だった。
保存済み公式EDINETコード原本から90銘柄の87提出者を照合し、3銘柄は未資格のまま保持した。
新しいD1索引照会では既存のマスタcache 84件中83件が公式コードと一致し、646Aの旧0000は
矛盾として保持した。マスタ・財務値・タグの書込は0。

初回の広いjoin照会1 HTTPはD1 CPU制限で429/code7429になったため再送しなかった。
ローカルDDLでSEARCHのみを確認したexact銘柄の3 SELECT/1 HTTPへ絞り、90 core行・
文書0・cache 84を取得。さらに2 SELECT/1 HTTPで財務metadata 275行/75銘柄、
EDINET 242文書ID・TDnet 33を確認した。財務の本決算ラベル117件を有報資格とは扱わない。
実提出日98日と候補117 IDに限定した3 SELECT/1 HTTPでは、候補ZIP索引0、
日付一覧1件が既保存原文と同SHAだったため追加原本GETは0。
ここまでの照会はread-only・各LIMIT 5001 sentinel・maxAttempts 1で実施し、数値財務列を取得しない。
成功8 SELECTの実rows_readは621+585+217=1,423、rows_writtenは0。最初のCPU制限応答の
読取課金量は結果に含まれずUNKNOWNを保持する。
その後、銘柄ごとの最新候補67文書を実提出日30日に絞り、既保存15日との重複0を確認して
公式一覧を直列・開始間隔1秒・1日1 GETで取得した。08:36:37.857 UTCに30 GETが完了し、
全原応答12,497,848 Bを保存。全67件で120/010/030000・取消/編集/非公開状態literal 0・
提出者コード/銘柄/正式名/期末/実提出日が一致し、CSVflag 1だった。年次候補なし23件を
未提出とは扱わない。rootも全30応答と67件の資格を原文から独立検証した。
独立証明234 B SHA `99212a1be7945a73aad8f3ff8a9df1c75b4c89400a51e6a6a856b18975001afd`。
この段階は原本物理保管・本文補完前で、本番文書/財務/マスタ/タグの書込とAI呼出しは0。

## 一次データの物理保管

08:44:40.936 UTCに共有`recordPrimaryData(force:false)`で245 memberを物理保管した。
D1制限応答と全成功読取、公式一覧30原文、JPX6原本、GitHub7読取、業種API、
VWAP3保存原本と独立証明を、原受信時計・UNKNOWNを保持して同梱した。
原量16,129,651 B、gzip 1,942,380 B、
SHA `d48d2642f04fd9b3076a03e34d212308ecb6fae7550741897814c44cd0553403`。
実Notion 8・添付1 HTTP、新source・D1/R2書込・再試行0。rootも保存した全9 HTTP、
metadata全文・Fetched At・manifest・添付全bytes・gzip全member/inputを独立照合した。
root証明353 B SHA `6ee53fa92d35df4543f717a45d1ede27208e96f7f5339ae800f203e556324427`。
本文補完の成功とは区別する。

続く既存⑤原本DBのschema 1 GET・財務metadataのSHA67 exact OR query 1で、
全67件の元ページ参照・銘柄・CSV種別・EDINET source・提出日・ZIP添付名/サイズが一致した。
metadata候補67、欠落/不一致0。原CSV本体の検証は次段とし、今回のpublisher GET・hosted・
書込・再試行は0。新規ダウンロード前にこの保存済み原本を再利用する。

続いてその67添付だけを1回ずつ再読し、計6,084,381 BのSHA・全ZIP CRC・提出者/期末/提出日の
公式ファイル名を検証した。正準CSV parserから本文2,401節・3,842,914文字を回収し、
二者が全節の値・並び・serialized bytesを独立再計算して一致した。解析エラー0、U+200B 0。
元publisher時計の報告値と今回のstore読取時計を分離し、旧publisher時計の検証状態UNKNOWNを
全67件で保持する。root全件証明36,031 B SHA
`cbb5e6957397cb70332aa8a26b889d2fd60d730b0ea728fcd7eb7611c0f4b84f`。
この段階は本文の本番保存前で、publisher追加GET・Notion/D1/R2書込・再試行は0。

本文不足23件の既知提出日から未保存の2日だけを公式一覧GETし、観測5文書・厳密有報資格0を
確認した。別の保存済み一覧には銘柄コードNULLの有報1件があるが、原NULLを推測コードに
置換せず、提出者の明示的な資格照合を別対象とする。残23件を未提出とは断定しない。
受注/海外解析が必要な67件のXBRLは、既存共有保管DBのtyped/bare計134 exact keysを
4 queryで照会して0件。以降の原本取得はこの必要文書だけに限定する。

本番補完前の7 indexed SELECT/1 HTTPでは、対象90 core行・有報関連5表各0行と、
財務275行の全列を捕捉した。ここでは不変比較のため財務値を私有保存し、公開Gitへ載せない。
マスタ・タグ・既存財務を更新せず、正準有報4表と本文参照だけの補完に限定する。

## 検証

Nixで全体の型・lint・監査レポート検査が成功。全vitestは267ファイル成功/1ファイルSKIP、
4,436 PASS/430既存条件付きSKIP（実行17:37:33 JST、49.16秒）。JPXの新しい見出し/契約・
未知幅/PDFのみ/不一致停止とVWAPの同日未完だけ取得・再入取得0はCI対象の回帰で確認した。
JPX関連4suiteは70 PASS/131既存条件付きSKIP。仕様サンプルの構造検証を本番実値受入と混同しない。
WorkerのWrangler dry-runもexit0（upload 1,729.92 KiB/gzip 365.86 KiB）、本番deployはこの検査では行わない。

PR #283の初回CIはpython/Workers Builds成功、checkが新しい再開testだけ失敗した。
固定`GITHUB_RUN_ID`/attemptを継承して同じ原本名へ`wx`保存する衝突が原因で、CI環境で
再現した。testのrunIDを分離し、同test内の再開を別attemptにして環境を復元する最小修正で、
本番コードの変更は0。同じCI環境の関連3 suiteは69 PASS/3既存SKIP、型・lintも成功した。
初回失敗は[run 37112014346](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/37112014346)
として保持し、新headのCIで受入を確認する。

## 株式・マクロ・費用の確認範囲

07:54:38.876 UTCの保存済み業種API 1 HTTPはHTTP 200だったが、10/2の実充足は
0/3,689、業種34で共有検証はHOLD。Yahoo追加取得・D1/R2書込は0。
以前の13:56 UTC原文の確定終値と、17:13 UTC原文の当日close/adj close NULLは異なる原応答であり、
後者を古い価格で補わない。株式55件・当日全量・VWAP全量/5分足・マクロ保存成功は未受入。

今回追加の有料AIは0、TypeSafe設定は現状維持。全量manualジョブの再起動は0。
Cloudflare Paid加入とYahoo側の429・取得元欠損は別条件として扱う。
