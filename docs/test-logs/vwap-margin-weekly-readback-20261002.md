# VWAP信用残PDFの再読受入検証（2026-10-02 JST）

旧9/18週次PDFは既存Notion物理添付から全文を回収でき、既知の実byte pinと一致した。
現行通常入口の日次信用残は、既存定時runの成功と現在のPDF/R2全文照合が確認できた。
[#117](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/117)の
daily/intra障害や全VWAP取込の成功を、この信用残確認だけで完了にしない。

## 旧週次の失敗と同じ原本の回収

[旧run36245100733](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36245100733)
はhead `7b048036b7cb94f53b38f361bef2d6b769c87c32`、9/26 UTC
13:25:31〜13:25:39のweekly margin stepが失敗した。
ログは `margin-2026-09-18.pdf` の空ファイル拒否を示す。
当時の経路はR2保存後にNotion保管を行い、PDF parserへのバッファ移譲で元bytesが
detachされた。現在の `parseMarginPdf` は `bytes.slice()` をparserへ渡す。

[既存page3e9d74ff-84cd-81bb-ad8b-ccce3f71267e](https://www.notion.so/3e9d74ff84cd81bbad8bccce3f71267e)
のkey `jpx-margin-2026-09-18`、service vwap-analysis、status recorded、
単一Notion-hosted `margin-2026-09-18.pdf` とmetadataをstrictに確認した。

- 再読clockは **2026-10-01 17:57:53.992 UTC**。
- hosted PDF全文873,311 bytesのSHA-256は
  `21c99f4e06641cae0270bd8151c41d45559e28a08f165a829726b9601c52131d`。
  [9/28の既知pin](official-source-storage-2026-09-28.md)と既存margin回帰の実原本pinに一致した。
- 共有parserでweek2026-09-18、4,230 rows。解析後も元bytesの長さと全文SHAが不変。
  `marginArchiveInput` が同じ原本byte参照・key・ファイル名を返すことも確認した。
- 旧HTTP原文の実取得clockは **UNKNOWN**。今回の再読clockや失敗runの時刻で補完しない。
  失敗した9/26の転送済バッファを回復したという主張ではなく、固定週の既知同一PDFの
  既存物理保管を現在再確認した証拠である。
- 既知keyのNotion AI search1回、Notion GET/pages1回、hosted GET1回。
  source GET・新archive POST・Notion mutation・D1/R2 requestはすべて0。

私有reader `/tmp/kabulab-margin117-oldweek-readonly.mts` のSHAは
`d53d33e056a684228aa2b584169fc285009e51942741f3fd1fb0f11221fd6da6`。
私有reportは383 bytes、SHA
`eac91ad89dbdbdf052bdbe8a9db49e7a15bff368918c0707caad2d14cf631b79`。
元PDF/reportは0700 directory・wx0600・fsyncでローカル保存し、公開Git/artifactへ出していない。
ローカル保存をCI runner終了後の永続回収保証として扱わない。

## 現行日次入口の既存定時成功

[通常run36879997507](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36879997507)
はevent schedule、head `7f1442972793051882d4c2d15771348eb6e4c647`。
10/1 UTC 14:53:59生成、job14:54:03〜14:54:39、margin daily step
14:54:14〜14:54:36（22秒）でsuccess。daily/intra/backfill stepはskipped。
workflowの実条件上、平日日次信用残の `0 8 * * 1-5` の経路である。
遅配runの観測時刻をcron予定時刻と同一扱いしない。

最終ログはbasis2026-09-30・publication2026-10-01・4,260 rows・
page `3ecd74ff-84cd-8125-8d7f-dcb370f8d41d` を示す。PUT0行は無い。
当時headから再読時head `4ba208af1339589ad2641d675a85eb4740783092` まで、
`ingest-margin.ts` / margin parserの差分は0。
現行コードの最終成功行は、shared custodyの単一hosted添付を全文照合した後、
snapshot/indexの必要差分を条件PUTし、それぞれのreadbackが一致した場合のみ到達する。
少なくとも一方をPUTした経路だが、どちらを送ったかの個別計数はログから確定できない。

今回の限定再読は **18:08:01.717 UTC** にexit0。
[日次PDF page](https://www.notion.so/3ecd74ff84cd81258d7fdcb370f8d41d)の単一物理添付を
全文照合し、共有日次parserの結果はbasis9/30・publication10/1・4,260 rows・19 totals。
parser後の元PDF bytes/SHAも不変だった。

| 対象 | byteLength | SHA-256 |
| --- | ---: | --- |
| 日次hosted PDF全文 | 1,779,287 | `4ae578f3ae690c6010d7ffed1d993f5d29441c302de89aa5daf05bc5d9badefe` |
| R2 snapshotと同SHAの再生成JSON | 3,603,939（derived） | `7ec99c0a3c8e8d0b7c6c083946ed2fb68e59f71b840bb5e1e5093eaea3d1c957` |
| 私有日次再読report | 609 | `e730a731681ae1388b5b605103a1d27ca4862484d4cee6bac5d579219b1862ea` |

R2 snapshotは、今回の同PDF parseへrawPageIdを設定したJSONと全文一致した。
byteLengthは保存済PDFを共有parserでoffline再解析して同JSONを再生成したderived計数。
再生成全文SHAが実R2 responseの観測SHAに一致することを要求した（network0・追加R2 GET0）。
実R2 response bodyを私有ファイルへ保存した計数とは区別する。
日次PDFの当時の実取得clockはmetadataに無く **UNKNOWN**、今回の再読clockで補完しない。
診断はNotion GET/pages1・hosted GET1・既知R2 snapshot GET1、source GET・Notion mutation・
D1 request・R2 writeは0。新margin dispatchは不要と判断し実行していない。
私有日次reader `/tmp/kabulab-margin-normal36879997507-readonly.mts` のSHAは
`437cd5bbab22604267c63fda47b00c66c41a58ad759731834393ef60b99ea160`。

## 旧週次とmoneyflow結果不明の境界

現行 `pnpm ingest:vwap-margin` / workflow `target=margin` は日次専用。
CLIは `--date=YYYYMMDD` の基準日だけを認識する。旧 `--week` は認識しないので
旧週次の再実行selectorとして使用しない。残るlegacy `fetchMargin` は通常CLIから呼ばれない。

moneyflowの旧9/28固定462行は別経路で、安全461行のsame-upsert unchanged・追加更新0は
[既存証拠](data-remaining-investigation-20261001.md)がある。
unknown #110の0hitは以前のPOST不成立を証明せず、再POSTしない。
`jpx-margin-sector` sourceの通常selectorはR2 indexの実最大basisを選び、個別行除外selectorは無い。
今回18:00:24.261 UTCのR2 index GET1は9/28・9/29・9/30、最大9/30を示した。
その通常入力は旧9/28のunknown keyとは別だが、旧固定462行の完了証拠にはならない。
moneyflow dispatch・固定9/28再送は0を維持した。
