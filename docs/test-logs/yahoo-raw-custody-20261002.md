# Yahoo 通常取得の原本保管・検証記録（2026-10-02）

ルール6の対象は、構造化した日足・5分足や終了サマリとは別の、同じ HTTP 応答から取得した本文 bytes。
この変更は既存取得へ capture を接続し、共有の lossless gzip 保管・物理 readback が完了してから保存する。
本記録の VWAP 検証はオフライン回帰のみ。本番での初回全量 bytes・圧縮時間・Notion 転送時間は未測定。

## VWAP の保存順序

- [`ingest-daily.ts`](../../scripts/vwap/ingest-daily.ts) と
  [`ingest-intra.ts`](../../scripts/vwap/ingest-intra.ts) は既存の `CONC` 件ずつ取得する。
  通常 workflow の `CONC=5` を維持し、各波の全 in-flight 処理が終了するまで待つ。
  最大6波・30銘柄へまとめ、raw 合計8 MiB到達、fatal、ABORTの後は次の波を開始しない。
  最後の波で8 MiBを越えた分は shared helper が分割する。
  PUT unknown検知前の取得済未保存が最大30銘柄になる境界と引換えに、保管呼出しを減らす。
- shared Yahoo client の `onRaw` で HTTP 判定・JSON parse より前の同一応答本文を捕捉する。
  HTTP 429、parse/価格 guard 失敗、run ABORT でも、既に取得した本文を保管対象へ含める。
  transport 失敗には bytes を作らず API・銘柄・attempt・失敗時刻・理由を明記する。
- [`archiveYahooRawBatch`](../../src/shared/yahoo/raw-custody.ts) は合計 raw 8 MiB 以下へ分割し、
  各本文の lossless base64・実取得時刻・HTTP status・byteLength・SHA-256 を gzip に含める。
  ローカル展開で全 member を照合し、既存 `recordPrimaryData()` の物理添付保管後、
  `verifyArchivedAttachments()` で hosted gzip の件数・名前・全 bytes・SHA を照合する。
- 自分の本文を含む chunk の全添付が照合済みになってから、その chunk の R2 PUT を開始する。
  capture 不明、単一本文 8 MiB 超過、保管結果不明、`file_too_large`、readback 不一致は run STOP。
  当該 chunk の R2 PUT は 0、次 chunk の新取得も 0 とする。
  STOP 前に保管・保存済みの chunk を取り消したことにはしない。
- 既存の `MAX_RL`、5分足の最大3 attempt、R2 CAS、PUT 結果不明時の再送禁止、終了サマリ保管を維持する。
  fatal/ABORT 後は新 attempt を開始しない。新規 Yahoo GET と新規 R2 PUT の経路は増やさない。

保管成功を確認できない場合の STOP は、原本回復の完了を意味しない。
共有 helper は全 gzip parts を `.yahoo-raw-custody/`（Gitignored、dir 0700 / file wx 0600 / fsync）へ先に保存し、
local全bytes/SHA照合後だけ Notion へ送る。unknownでも取得し直さず、localの全partsを残す。
原本は通常の Git・公開 Actions artifact へ出さない。
CI runnerのlocal diskはjob終了後の永続回収を保証せず、その先の私有回収は別途確認が必要。

## VWAP の追加負荷・費用条件

以下は **正常応答・再実行なし・30銘柄の raw が8 MiB内で gzip 1添付に収まる場合** の計算であり、月間実測ではない。
母集団 `N=3,695` は [保存済み VWAP 記録](./vwap-repair3-actual-20261001.md) と
[完了検査](./vwap-cli-completion-20261001.md) に基づく断面。
[`vwap-ingest.yml`](../../.github/workflows/vwap-ingest.yml) の月水金実行は2026年10月に13回、
日足・5分足それぞれ `CONC=5`。祝日による未発火は仮定しない。

| 項目 | 計算式 | 正常シナリオの月次量 |
|---|---|---:|
| 既存 Yahoo 応答取得 | `3,695 × 13 × 2` | 96,070（capture による追加取得 0） |
| 保管 batch 数 / Notion ページ数 | `ceil(3,695 / 30) × 13 × 2` | 3,224 |
| Notion API 呼出し | `3,224 × 6` | 約19,344 |
| hosted 添付 readback GET | `3,224 × 1` | 約3,224（Yahoo GET ではない） |
| 現 limiter の間隔相当 | `19,344 × 0.380 / 3,600` | 約2.04時間 |
| 保守的な 2.5 req/s シナリオ | `19,344 / 2.5 / 3,600` | 約2.15時間 |

当初の5銘柄保管案は19,214ページ / 約115,284 API呼出し、間隔相当約12.17時間
（2.5 req/s条件では約12.81時間）だった。最終案は同じ全原文を保管し、この正常条件で約83%削減する。

1添付の通常経路は key 照会・upload 作成・本文送信・upload status 読取・page 作成・
readback page 読取の6 Notion API 呼出しを数えた。
現 [`client.ts`](../../src/shared/notion-archive/client.ts) の最小間隔は380 ms（約2.63 req/s）であり、
2.5 req/s は費用検討用の条件。日足＋5分足1回分の間隔相当は約9.42分（2.5 req/s なら約9.92分）。
これは実際の追加 job 時間ではなく、取得・転送・圧縮・既存待機との重なりを測定していない。
初回 DB / workspace 探索、追加 status poll、429 待機、再試行、サマリ保管も別に加わる。
8 MiB到達前に30銘柄を取得できない場合や helper が複数添付へ分割する場合は、
ページ数・呼出しが増えるので、この表は上限ではない。

日足10年と5分足の本文サイズ・圧縮率は未測定。株式5年 Chart の欠測診断標本を VWAP の実量へ転用しない。
追加保管 bytes は実際の全 gzip の合計で評価し、未取得を0としない。
初回受入では各 chunk の `rawCustody` ログ（`pages` / `rawBytes` / `compressedBytes`）と実行時間、
Notion 429・再試行・timeout を確認する。通常 job の timeout は現行300分。
capture / gzip / Notion は Node 側で実行し、Cloudflare scheduler の CPU 処理として加算しない。
既存 proxy・D1・R2 の使用量を含めた全体費用は [費用監査](../cost-audit-2026-10-01.md) を参照。
現在の包含枠内確認を、未測定の将来の raw 保管全量が問題ないという判断へ拡張しない。

- Notion は認証済み画面で既存 Plus と Business trial を確認した。
  公式 [料金表](https://www.notion.com/pricing) は Plus の file uploads を unlimited とし、
  ファイル単位上限を別に定める（2026-10-02取得）。実 workspace の約5 GB / file 上限も読取確認済み。
  共有 upload は `/users/me` の実上限を取得し、この helper はさらに gzip 20 MiB 以下を要求する。
  この物理保管だけのために新規 upgrade は不要。契約額・seat・個人請求情報は私有記録に保管する。
  unlimited uploads は API レート・処理時間の無制限を意味しない。
- 公式 [Notion request limits](https://developers.notion.com/reference/request-limits) は
  Plus 等180 req/min、Business / Enterprise 600 req/minと、workspace 共有枠を定める
  （2026-10-02取得）。既存の380 ms limiter を維持し、試用プランのレートへ変更していない。
- 公式 [Notion database limits](https://www.notion.com/help/optimize-database-load-times-and-performance) は
  DBあたり250,000行、500プロパティ、行のプロパティ合計2.5 MB、DB構造1.5 MBを定める
  （2026-10-02取得）。物理添付 bytes は2.5 MB制限に含まれない。
  本文を添付へまとめても行数枠は有限なので、既存行・他の取得経路・再実行・分割を含む増加を監視する。
  現在の正確なDB行数と残り容量は未測定。この変更で期限を推定して古い原本を削除しない。
- 現 repo は public、workflow は標準 `ubuntu-latest`。
  公式 [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
  により、この条件の compute 料金は $0（2026-10-02取得）。
  raw 保管による時間増加にもこの条件が適用されるが、artifact / cache の追加保管、
  larger runner、将来の private 化は別評価。本文 gzip の公開 artifact 追加はこの変更に含めない。

## VWAP オフライン回帰

Nix 管理の Node と既存依存で、次を実行した。

```sh
node node_modules/vitest/vitest.mjs run scripts/vwap/ingest-daily.test.ts scripts/vwap/ingest-intra.test.ts scripts/vwap/lib/r2.test.ts scripts/vwap/lib/ingest-guard.test.ts scripts/vwap/cli-completion.test.ts
```

5 files passed、102 passed / 3 skipped（既存の私有 source replay 3件）。
本文保管/readback の成功前に PUT しないこと、HTTP 429 ABORT 本文の保管、
capture 欠落・上限超過・archive unknown 後の PUT 0 / 次 chunk 取得0、
全 in-flight 待ち、5分足 parse 再試行の全 attempt 保管、transport 欠落明記を確認した。
30銘柄上限・8 MiB到達時の保管・次offsetの無欠落、2波目fatal後の3波目source GET 0も確認した。
既存の CAS・結果不明停止・終了サマリ回帰も通過した。`git diff --check` 通過。
共同差分の `tsc --noEmit` も通過した。
テスト中の新 source GET・本番 Notion / D1 / R2 書込みは0。

## 株式通常syncの欠落と修正

通常 `buildSnapshot()` は5年ChartとQuoteSummaryの変換結果を用いていたが、両方の応答本文を
Notionへ物理保管していなかった。終了時の `price-sync-batch` は失敗明細であり原文ではない。
マクロ、欠測診断、VWAPの個別原本が存在することも、通常株式の全原文保管の代わりにならない。

- `fetchQuoteSummary()` / `fetchBars5m()` に既存Chartと同じ capture hookを追加し、
  Chart・日足・5分足とも最終HTTP応答本文の受信後、HTTP判定・parse・価格guardより前に捕捉する。
  URL metadataの平文/URL-encoded crumbは除去する。headerはContent-Typeとupstream statusのみ。
  本文bytesは秘密除去や数値serializationで加工しない。
- `fetchStockRawData()` はChart/QuoteSummary両APIを `allSettled` で待つ。
  片方の失敗で相方のin-flight原文を置き去りにせず、単一原文超過は相方のparse失敗にも隠さない。
  bodyを8 MiB超まで受信した場合は切詰原文を作らずrun STOPとし、双方のstreamを停止する。
  認証bootstrapや内部401更新の中間本文は、この最終財務応答captureの対象とは別である。
- N225株式session確認の原文を専用batchへ保管/readbackしてからスキーマ・公式overlayへ進む。
  session原本不明はここでSTOP。既存の対象日/fresh-close/価格guardを維持する。
- 初回Phase 3aの全workerと各銘柄の両APIを待ち、HTTP/parse/鮮度guard失敗の本文も含め、
  全raw batchの物理保管/readback後にPhase 3bの最初の株式snapshot D1文を開始する。
  初回custodyの失敗は株式snapshot書込0でrun abort。公式原文保管済みのoverlayを取り消した扱いにはしない。
- 回収attemptは別stage/attemptで原文を保管/readbackし、成功後だけ `writeStockSnapshot()` へ進む。
  保管失敗はrun全体のSTOPを保持し、次回収対象の新GET/株式snapshot文を開始しない。
  transport/bodyなしのattemptには実失敗clockと「原本captureなし」の事実を記録し、本文を作らない。
  ChartとQuoteSummaryのどちらが返したか不明な例外を、片APIの確定した診断へ読み替えない。
- source取得後、custody後、各D1 snapshot文の開始直前に対象日の21:00 UTC期限を検査する。
  `flushSnapshots()` の期限callbackは銘柄save failureへのcatch外に置き、後続文を止める。
  overlay送信batch、回収、sector、signal掃除、OHLCV prune、projection仕上げも同じ期限callbackを渡す。
  既に開始したHTTP/D1文が期限後に完了することや、期限前に保存した部分を撤回することは保証しない。

## 全partsの私有ローカル保管

共有helperは各gzipを展開し、全memberのapi・銘柄・attempt・byteLength・SHAとlossless bytesを照合する。
**全parts**を先に `.yahoo-raw-custody/` へ保存してから、Notionへのparts順送信を開始する。
既存 [`writeSummaryLocal()`](../../scripts/vwap/lib/ingest-guard.ts) の0700 directory、wx0600 file、full-write、
fsyncを再利用する。ローカル保存失敗・既存file衝突はNotion送信前STOPで、上書きしない。
送信前にローカルfile全bytesのSHAも検査し、物理Notion添付後にhosted gzip全bytesを照合する。
後半POSTの結果不明でも、取得済みの全partsは同じrunnerのローカルに残る。unknown POSTを再送しない。

このdirectoryはGit ignore対象で、公開GitHub artifact uploadは追加していない。
ローカル実行では作業ホストの私有fileとして保持されるが、CI runnerのローカルdiskはjob終了後の
永続回収を保証しない。Notion保管不成立時はデータ回復が完了したとは扱わず、原本の私有・耐久回収を
別途確認する。メモリには既存の全captured本文とsnapshotがあり、gzipは8 MiB raw単位で準備し、
Notion送信時は対応する1つのprivate fileを読む。新規の原本公開先は作らない。

## 株式原本の追加量（実測と外挿を区別）

9/29診断の保存済みChart54件をNotion-hostedから読戻し、54/54のbytes/SHAを診断manifestへ照合した。
追加Yahoo GETは0。raw合計3,651,509 bytes、平均67,620.54、中央値73,861.5、範囲1,197〜107,884 bytes。
この既存原本をlossless base64・ファイル名・byteLength・SHAを含む**測定用wrapper**へ入れ、
Nix管理Node22のnative `CompressionStream("gzip")` でオフライン測定した。
wrapper4,876,615 bytes → gzip1,253,350 bytes（raw比約34.32%）。展開した54/54の全bytes/SHA一致を確認した。
これは通常helperの全clock/HTTP metadataを含む本番全量の圧縮率ではない。

| 項目 | Chart54標本からの単純外挿（全量実測ではない） |
|---|---:|
| 現株式対象3,689のChart raw | 約249.5 MB / 日 |
| 同Chart gzip | 約85.6 MB / 日 |
| 月22回の同Chart gzip | 約1.88 GB / 月 |
| raw 8 MiB capでのChart parts | 約30 / 日 |
| 通常1添付のNotion API経路 | 約180 requests / 日（6 / part） |
| 現380 ms limiterの間隔相当 | 約68.4秒 / 日（2.5 req/s条件では72秒） |
| Chartのみページ数 | 約660 / 22回 |

欠測診断54は全母集団の代表標本ではない。QuoteSummary、N225、回収attempt、HTTP中間応答、
初回workspace/DB探索、追加status poll、429待機、転送/圧縮時間は表に含まない。
正常時の最終財務API取得は既存の `3,689 × 2` ＋ N225 sessionであり、capture自体による追加Yahoo GETは0。
Notion実workspaceの認証済み `/users/me` 読取は `max_file_upload_size=5,368,709,120` bytesだった。
helperはこれより厳しいgzip20 MiB capを課す。新規upgradeを前提にした設計ではない。
Nodeで圧縮/保管するためCloudflare scheduler CPUの追加処理にはしないが、保管量とjob時間は追加になる。
初回正常運用の全Chart/QuoteSummary rawBytes・compressedBytes・parts・時間を計測するまで、
Paid Cloudflareだけから将来の全費用が問題ないとは確定しない。

## 10/1通常runの受入状態

[run 36879969126](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36879969126) は
main `7f14429` の正規時間帯で実行したが、株式3,634 / 3,689成功、55失敗（1.49%）で非0。
[失敗batch原本](https://www.notion.so/3ecd74ff84cd81d0b34dc354d3671e5b) の7,785 bytes / SHA
`f7d8d0bd43ae10e9e1a91b2cf995a200b9c06f457b8a8ef51e59a7dba066fbe5` をphysical manifestへ照合した。
54件は対象10/1のfresh close欠測、8303は履歴adj負値で共有guardが応答全体を拒否した。
5年adjはRSI計算に用いるため、8303の保護を緩めない。

D1 SELECTでactive equity3,689、対象日close＋volumeおよび対象日indicator各3,634を確認した。
欠測55は失敗batch55と完全一致し、全55の最新保存OHLCVは9/29。全55は現在active equityであり、
5484/9691の将来delistを前倒しして除外しない。通常runの公式overlay適用stateは確認したが、
sector33 / moneyflowは株式失敗でskipのため正常chain成功とは扱わない。
9/29欠測54と10/1欠測54の重なりは15件。その15件の保存済み9/29原文には9/29最終日足が存在した。
10/1通常原文は未保管だったため、10/1のstale/null/forming細分類は未確定である。
この変更によって過去の未保管原文が復元されたとは主張しない。診断のための新source GET・本番修復writeは0。

## 株式・共有回帰

Nix環境で原本before-parse、全inflight待ち、片API失敗と原文超過のSTOP優先、gzip全member照合、
8 MiB分割、全parts private保存、後半unknown POST再送0、Notion hosted不一致、capture不足、
初回・回収custody失敗、custody中の21UTC到達、各D1文の期限停止を確認した。
株式・共有対象4files70 passed。既存macro modeを含む対象47 passed。
型検査・lint・`git diff --check` が成功。全suiteは254 files passed / 4,142 passed / 427既存skipで成功（main統合前）。Wrangler dry-runも成功。
テストの実HTTP/source GET・本番Notion / D1 / R2 mutationは0。
