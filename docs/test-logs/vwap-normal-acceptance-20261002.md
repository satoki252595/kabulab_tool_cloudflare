# VWAP通常日足・5分足の原文受入検証（2026-10-02 JST）

run全体は **failure**。Yahoo認証取得の429をproxyが返し、日足のABORTで5分足は未起動。
取得済み全795応答・27partsとfullsummaryのNotion物理保管/全文照合を確認した。
769銘柄のR2保存計数と保存済1銘柄の照合があるが、全量・5分足・同一入力再入は未完。

## 実行

[run36903916350](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36903916350)
はrootがwriter空きを確認後に `target=daily-intra` を1回dispatchした。
event workflow_dispatch / head `4ba208af1339589ad2641d675a85eb4740783092`、
UTC10/1 18:02:57生成、job18:03:02開始、daily+intra step18:03:11開始。
定時scheduleの成功とは扱わず、診断側の追加Yahoo GET・再dispatchは0。
stepは18:12:12にfailure、job/runは18:12:18完了。daily+intra stepは9分1秒。
fullsummary内のdaily実clockは18:03:13.346〜18:12:10.428（8分57.082秒）。

## 最初の日足batchの全文保管

既知run/key prefixのNotion AI search1回から
[page3ecd74ff-84cd-8168-9ac7-d8520021d032](https://www.notion.so/3ecd74ff84cd81689ac7d8520021d032)
を発見した。keyは `yahoo-raw-36903916350.1-vwap-daily-0-part-0`。
service vwap-analysis / run36903916350.1 / stage vwap-daily-0、part0/parts1の全stage集合。

- 30 members、missing0。30応答すべてHTTP200で共有 `parseDailyChart` が成功した。
- 実source clocksは **18:03:14.933〜18:03:23.931 UTC**。
- raw合計3,879,766 bytes、hosted gzip全文1,430,874 bytes。
  gzip SHA-256は `388f21836e8b11c22fb91e2f1abe79a81fe872076356ce1dd77c39fa4955f7d3`。
- manifest fingerprint・単一ファイル名/MIME・gzip全bytes/SHA・内部全30memberの
  base64/bytes/SHA・raw/compressed byte counts・attempt一意性・実取得clockを照合した。
  私有ローカル保存後のgzip SHAも一致した。

再読clockは **18:12:58.140 UTC**、Nix `pnpm exec tsx` でexit0。
reader `/tmp/kabulab-vwap-normal36903916350-raw-first-readonly.mts` のSHAは
`bc3fbd7348b5b9f3e3f7a62107b7f86ba48c67f68673b818e0425e6c3a17d5be`。
私有report6,332 bytesのSHAは
`7d5073239536e4e9d3c69646161aa8c7e9f32486eb5e011bed7e730ec4d4536d`。

## 保存済R2の限定照合

同batchの `daily/135A.json` を既知GET1で再読し、strict保存schemaを確認した。
今回保存原文を共有parserで再解析したbars/splits/proof内容と一致し、proof observedAtも
今回取得clock **18:03:14.933 UTC** に一致した。
R2全文SHAは `4bd72c92ce3994e4cfc25fb7b87da0c89578d39e0284c85a72f9a757624b3765`。
今回のcapture→物理保管/readback→R2保存の最初の実績だが、全銘柄R2照合ではない。

診断通信はNotion GET/pages1＋hosted GET1＋R2 GET1、Notion mutation・D1 request・
R2 write・source GETは0。価格本文と各member詳細は私有reportだけに保持した。
0700 directory・wx0600・fsync保存を利用し、公開Git/artifactへ原文を出していない。
CI runner localの終了後永続回収は保証しない。

## 最終計数と全原文の再読

18:12:10のfinal logはcodes3689 / written769 / skipped0 / empty0 / errors0 / invalid0 /
rateLimited22 / backfilled795 / abortedtrue / fatalfalse / unknown0 / rejected0。
5連続429/503 gateで停止し、summary recorded後 `daily_exit=2 intra_exit=not-run reason=daily-abort`。

[fullsummary page3ecd74ff-84cd-817b-b2a4-f6e21a0024e3](https://www.notion.so/3ecd74ff84cd817bb2a4f6e21a0024e3)
のkey `vwap-ingest-daily-20261001-36903916350.1`、単一JSON添付354,328 bytes。
全文SHAは `dcf286b654cded7a4de702a3f3df02172b2a06ed68012fa9c7715b9bd8809ae1`。
metadata/manifestとfullbodyを照合し、全3,689銘柄outcomesはwritten769/error22/notStarted2898。

`backfilled` はコードの `fetchDaily` 呼出し直前に増える**取得試行数**で、保存成功数ではない。
全795 captured応答はHTTP200が773・HTTP429が22、共有日足parse成功773。
773−written769の4銘柄（3469・3467・3475・3479）はHTTP200/parse成功済みだが、
ABORTで新規PUTを止めたnotStarted。残るnotStarted2,894銘柄はsource未試行。
failedHTTP22も含む同fetchの本文はすべて保管され、missing0。
この795はNode→proxy最終応答数で、内部認証/401 refreshを含むYahoo総GET数ではない。

既知raw key offsets0,30,…,780の27stages/27partsを全再読し、全member bytes/SHA・
stage集合・実clock・attempt一意性・metadata合計を照合した。
raw合計 **105,967,254 bytes**、gzip合計 **38,145,883 bytes**。
source実clocksは18:03:14.933〜18:12:07.492 UTC。
この停止runで実保管された量であり、未取得2,894銘柄や5分足の月額上限へ外挿しない。

全再読clockは **18:22:54.019 UTC**。readerは
`/tmp/kabulab-vwap-normal36903916350-full-readonly.mts`、SHA
`79a90f0d8be0524d1fb9e083c49f51e6edab662aff2181747d01cc8a7678435a`。
私有fullreport15,152 bytesのSHAは
`b964cd5ebe0a0e4516c25170e78b3dc04137441074a67a16a498c5b688e10615`。
全再読フェーズはNotion GET/pages28＋hosted GET28、cap各28、query POST/source GET/
Notion mutation/D1/R2 request0。先の1stage読取（各GET1＋R2 GET1）とは別計数。
IDs discoveryは既知run/keyのAI search計6成功。page_size100の1呼出しはconnectorの
上限50でschema拒否され、実検索の成功数に含めない。既知IDs一覧のSHAは
`1e305ba13dc56cea2086d56888d12de9225e30c964a82802abda17e8690d637b`。

## 429の出所

保存済22bodyは全83 bytesのJSON `{error}`、`yahoo rate limited: ` prefix。
safeheadersは全件contentType application/json / upstreamStatus429。
`ingest-proxy.ts` のYahooRateLimitError catchが返すwrapperと一致し、同経路のtypederrorは
`yahooFetchDirect` が呼ぶcredential bootstrapのgetcrumb429（または期限内のcached error）
から発生する。Chart応答本文の429やCloudflareプラン独自制限の本文として扱わない。
worker内部で実getcrumbを何回行ったかはこのNode最終応答原文から確定できない。

22bodyの `retry-at-ms` は3種類、期限18:11:51.307〜18:12:08.985 UTC。
stage750に11件、stage780に11件。元HTTP `Retry-After` ヘッダは保存allowlist外でUNKNOWN、
本文に明示された期限と区別する。既存ABORT・cached rate guardを緩めず、追加GETは0。
offline分類report8,852 bytesのSHAは
`64241587a0fb1c9ba565fac556de475acf47f38aca27f2594f1c33c1078fab4e`。

失敗時artifactはID11182234885、zip41,970 bytesのsummaryだけをuploadしたログがある。
raw `.yahoo-raw-custody` を公開artifactへuploadしたログは0。
全量正常化・5分足・再入0の受入は引き続き未完。

## 全27partsの実byte pin

各stageはpart0/parts1。以下は全再読のhosted gzip全文pinで、原文本文は私有保管のみ。

| stage offset | page ID | captures | raw bytes | gzip bytes | gzip SHA-256 |
| ---: | --- | ---: | ---: | ---: | --- |
| 0 | `3ecd74ff-84cd-8168-9ac7-d8520021d032` | 30 | 3,879,766 | 1,430,874 | `388f21836e8b11c22fb91e2f1abe79a81fe872076356ce1dd77c39fa4955f7d3` |
| 30 | `3ecd74ff-84cd-81e5-8f70-e9c063e4db53` | 30 | 2,783,082 | 1,008,519 | `b7bf7caeac48c36acb96e7c283ffdae746e76def142aa8772bb98fd381773c61` |
| 60 | `3ecd74ff-84cd-81fc-afd1-ff7670b817fd` | 30 | 4,211,566 | 1,431,306 | `1919ebebc578c7dfa308638f403d20abe40a6996c5b6e689b583ba82fcebd1aa` |
| 90 | `3ecd74ff-84cd-819f-8994-ed98b56058cb` | 30 | 4,339,356 | 1,612,622 | `05aac3cd6ee319b753b77570c914c51785e3f6883afb9dc5d9434a8c3070cbb7` |
| 120 | `3ecd74ff-84cd-81fc-a3b3-cfe653d27e8a` | 30 | 4,365,881 | 1,622,504 | `fac0df35cf31a6a3944ee926c2a16239d2b5aac1fee112c89a6a390f4eb831e5` |
| 150 | `3ecd74ff-84cd-81f7-a3ac-e30713a29946` | 30 | 4,299,083 | 1,558,252 | `c0d26ab7c391be93e65b65cc3efa19d35c5dc0262b11e06eb878a1bda7e14e51` |
| 180 | `3ecd74ff-84cd-81ed-8a38-dde42592799a` | 30 | 4,109,787 | 1,498,102 | `d37a213590185086c8e88aec9357d75b0ff53da99814d0841ec0d74caf634c38` |
| 210 | `3ecd74ff-84cd-81d3-b932-e86b4062dbab` | 30 | 4,520,430 | 1,614,853 | `d434a3f16e79f863c52dc5b7320cb1a26afd19739f50972612e2c198e14ed255` |
| 240 | `3ecd74ff-84cd-81a0-8106-d5659b5d8bf0` | 30 | 4,605,433 | 1,590,323 | `41bb764fd861a1b9e8c111e332893cc914369661c73e77a16c8993bbf12a2248` |
| 270 | `3ecd74ff-84cd-81d5-9e88-c699ea7cb80f` | 30 | 4,615,238 | 1,600,661 | `84edb7157435e71c48a7064014684fadbd923858c3d9a1fcb677c367c4757668` |
| 300 | `3ecd74ff-84cd-81b6-ab39-c168501a9f3b` | 30 | 4,365,994 | 1,611,303 | `dbed9c67d05c5f6742a29e95d663b91fbcdcf36e1b23f625d392393ebe8f58a6` |
| 330 | `3ecd74ff-84cd-8173-bc8f-d0556ed18484` | 30 | 3,841,247 | 1,434,754 | `41fbc8b0e88356639845f70c09a175bb0faa9a13940afc123e075506bdcefb57` |
| 360 | `3ecd74ff-84cd-8165-98d2-f6d0ec32532e` | 30 | 4,362,402 | 1,560,576 | `a80635d338bf9b0b8d5487c58b310a93b692f80cb1bf89669fbce78cffc6bc4c` |
| 390 | `3ecd74ff-84cd-8192-b2fd-cf22c0c57901` | 30 | 4,063,624 | 1,404,079 | `03052abe898117b163df4b2aa72baa40c182e6e393cff8b6f5a01e1063f99c67` |
| 420 | `3ecd74ff-84cd-81a4-9e1d-e37b8ccdcb7d` | 30 | 4,197,342 | 1,484,523 | `818f6cc4f32f543625ee032415d4cddbc49330a86b689d185fea02d62950e10c` |
| 450 | `3ecd74ff-84cd-8190-a36a-e43cf9346f63` | 30 | 4,111,839 | 1,465,328 | `79ca52f1855f58e83c95e3cd8cd40850c538ac3b960de5a52e5a6e4594ec728a` |
| 480 | `3ecd74ff-84cd-819e-bce2-c7608ddae686` | 30 | 3,979,532 | 1,387,419 | `d7ff99ed8b802bdb859d98a42c9d4843fc4fe6652cd0333368ce6805fd790d13` |
| 510 | `3ecd74ff-84cd-81b6-a295-fb8c42c7e72b` | 30 | 2,780,007 | 1,025,237 | `dca5cae01526d72ed0d2af41556f7ee1ad625b3f2f26347d6db35ace8da16404` |
| 540 | `3ecd74ff-84cd-813a-a597-fa9551c82777` | 30 | 3,771,046 | 1,405,080 | `668d3e1f1c4c2d3c2c9907d29b3e2630af230411ec4e649d07364f36e5c7f2ce` |
| 570 | `3ecd74ff-84cd-8117-a023-e973efa2f900` | 30 | 4,444,099 | 1,558,039 | `cce245e6a0dc75b34213d2e446e90ab27761d8d9237ee973b45b0d940de460b3` |
| 600 | `3ecd74ff-84cd-81cd-a705-e0d9dbdf93ae` | 30 | 4,708,863 | 1,693,558 | `49af0b318aad7f5ddeda35b982c9f85d619aea3c576c305ce7e7b4c5a18c1fb7` |
| 630 | `3ecd74ff-84cd-81a3-8b9b-f0d4fcf9778a` | 30 | 4,376,617 | 1,601,374 | `a7a7090d70b203c4c5b9d4d2493aa25755b696559747b755a5ad034d111666d9` |
| 660 | `3ecd74ff-84cd-8125-94d8-e6908307b593` | 30 | 3,989,563 | 1,408,626 | `2a9a9f661007e28b8b7fe10b901f485b25eb13c090e112fc0cecd61290796fbf` |
| 690 | `3ecd74ff-84cd-8176-ae51-d7365988c8cd` | 30 | 4,001,115 | 1,446,012 | `5559e6873361e53eb05f697d21ab83d9511974947055f49f31028dc73f8c40d3` |
| 720 | `3ecd74ff-84cd-8106-81b9-e7ced5961b79` | 30 | 4,088,309 | 1,521,332 | `4cb107700412a0ead543e89848c81e81dbb4fb452ec9ed7df9dac0aa447f0c2b` |
| 750 | `3ecd74ff-84cd-818e-8634-f5f8d78fd234` | 30 | 2,569,652 | 939,348 | `81acb62512e5d688d51bca1ea18ffcc10352830dcbd85f62c9b1d45b4170363f` |
| 780 | `3ecd74ff-84cd-81c0-97d2-e6bebd040a89` | 15 | 586,381 | 231,279 | `bad29301d4dd5ffeea48fe3dc97dead1c46a384c38bdbfb430f36232611a741e` |
