# 保有明細の列挙見出しと共通ZIP予算（2026-10-14）

## 通常処理の修正

- `ShareholdingsTextBlock` の完全に対になった `(i)` / `(ii)` と種別名を同義の列挙見出しとして読む。追加対象は保存原典4社（3926/4578/6498/9612）の特定投資株式31明細。新たな取得・数値生成はしない。
- 既に読めた `(a)` / `(b)` + 空白は維持する。未知/不完全な同じ段落内の列挙記号はHOLD。独立した前段の括弧注記を列挙記号と誤認しないため、このguardだけは元HTMLのp/div/h境界内に限定する。主体判定は引き続き全区画の明示提出会社/当社と別会社境界で行う。
- 4578の最大保有会社・次位保有会社の明細と、3289の主体未確認は提出会社へ付け替えない。S100Z2Z6の子会社保有2行も提出会社明細へ戻さない。
- publisher・保存type1 reader・source再開・価格再開は同じ20MiB ZIP上限を参照する。展開は従来の最大5,000 entries / 64MiBを維持する。全SHA・提出者・期末・filer主体・単発mutation/readback・unknown停止は変更しない。

## bounded downloadとHTTPの意味

既存moneyflowの `downloadArchivedFile` をWorkerで使える共有ファイルへ移し、旧exportを維持する。新依存・Node fs/S3のWorker static importはない。

上限付きの場合、Notion-hosted HTTPS origin・credentialsなし・redirect拒否・45秒期限を検査し、Content-Length欠測でも実streamを上限内に留める。欠測をサイズ0へ補わない。過大/不正サイズ、body途中失敗、identity応答の宣言/実長不一致は停止し、partial bytesを返さない。HTTP content-encodingがある場合、Content-Lengthはwire長でfetch streamは復元後の添付長であるため、両者の長さ比較は行わない。復元streamの上限とcallerの全添付bytes/SHA・ZIP完全性は維持する。上限なしの既存callerの取得契約は変更しない。

## 実原本と費用・性能境界

全3666の保存ZIP corpusは3,112,349,201 bytes。5MiB超の適格保存原本は次の3通だけで合計16,637,043 bytes（0.535%）。保存cacheからの再解析なので今回の追加通信・upload・業務writeは0。

|銘柄/文書|ZIP bytes|展開bytes|entries|原表の扱い|
|---|---:|---:|---:|---|
|2270/S100YC5I|5,701,982|20,588,515|107|提出会社32明細|
|3289/S100YHXW|5,505,772|16,686,460|81|主体未資格、0明細HOLD|
|6498/S100XS6X|5,429,289|16,655,086|78|今回の種別対応で提出会社17明細|

個別原本の実読取/解析時RSSは約281–309MB、取得1.69–1.86秒、解析0.028–0.040秒だった。20MiBに近い実原本はこのcohortに存在しないため、**上限20MiB級の実RSSは未測定**。20MiB化を原本の切詰めや展開上限解除の根拠にはしない。全cold readerで増え得る対象はこの3GET/16.6MB、通常ingestの新たなsource API GETは0（既に取得した同じtype1を処理する）。

## 通常caller

- `services/yuho-quant/src/services/ingest.ts` は既存type1保管の全bytes照合後に共有publisherを呼ぶ。同じZIPを再取得しない。
- `src/cron/yuho-edinet.ts` はsource予算100行の保存原本再開と、独立した価格予算100行/116chunks/256MiBを使う。Node CLI `scripts/sync/yuho-edinet.ts` から価格source loaderを注入し、WorkerにNode S3/fs依存を取り込まない。
- `services/yuho-quant/data-scripts/backfill-shareholdings.ts` のprepare/applyも同じreader/publisherを使う。最新doc fresh照合、parser startup SHA一致、legacyの非0適格通だけのmodern保管、旧journal未知停止はそのまま。
- source明細が確定しても価格は別資格。元の価格・欠測理由・実観測時計を保持し、価格不可を保有事実全体の非開示へ読み替えない。

## 全量対照と検証

Nixで同じ全3666保存cohortを再資格化し、source資格3642通/未証明24通、保有明細ready1833通・22,755行、HOLD1833通を確認した。旧ready1829通/22,724行のstatus/factsは全件同値、新規4通31行だけ追加。各新行のtableIndex/rowIndex・実株数・帳簿価額は保存原表へ直接束縛した。3289は主体HOLDのまま。

108.731秒、peak RSS420,151,296 bytes、通信/source API/model/業務write0。純粋な`verifySavedHoldingsSource`本体はaccepted7513とbyte完全一致（function sliceSHA `04c8394ef6c983bb03a6943dcf49f2575b27fd8078061a5a4d4c7471049547a0`）。全量manifest SHA `5fa05d6ce0245679af3ed0d22dba1a371420eb700ba0a4f494dd19a025af87aa`。private入口は`tmp/feature-audit-20261013/holdings-latest-all/source-all3666-kind20-20261014-v4/`。原ZIP/SHA、元metadata/取得時計、旧item/plan、projection全bytes SHAを保持する。

候補v1/v2/v3は旧ready差を検知して停止した不採用結果であり、その部分出力/STOPも保全した。受入に使うのは旧ready差0のv4だけ。全1833HOLDを成功や非開示へ一括変換しない。原本未証明24はmetadataの銘柄束縛12/docID7/legacy type1添付資格5で、公式未提供とは断定しない。

関連8suite143tests、global tsc、owned ESLint、diff checkが通過。6MiBの同じ全ZIPがpublisher→保存reader→価格resumeとsource有限再開を通る回帰、20MiB超停止、HTTP wire/decoded長、未知/不完全見出し、実4社31行/既原表/子会社除外を含む。本番公開/全量applyはこの検証では実施していない。
