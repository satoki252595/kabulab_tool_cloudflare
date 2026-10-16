# 発行株数の限定観測 producer（2026-10-17、#343は継続）

株式分割・増資の原因や係数は作らず、同じ有報type1に実在する発行株数の2項目だけを決定的に観測する。今回の受入はコード・保存原本の再生であり、正常定時の実行、全権利イベント、価格/EPS/BPSへの適用は未受入。源GET・live Notion・モデル・DDL・依存追加は0。

## 通常入口と保存先

`ingestDocument → recordEdinetZip(type1) → 物理全文照合 → publishVerifiedShareholdings` の順を保持する。保有parserの既存ZIP展開Mapに共通DEI資格と `observeIssuedShares` を接続し、新たなZIP展開はしない。主体不一致・未割当00000は診断HOLDに加え、当該原本からの保有明細公開もHOLDにする。DEIの旧ZIP wrapperの判定/戻値は維持し、既存Map用の本体へ薄く分けた。

診断全文は既存 `保有明細再開情報` JSONへ同梱する。従来のsource再開PATCHとその完全readbackに乗るため追加Notion要求は0。既存完了sourceの読取だけで終了する枝など、再開情報を書かない枝は今回のreceiptのみであり、保存済み診断とは数えない。古いarchive metadataは更新しない。原本ZIPの保存・SHA・raw-before-DB、既存cursor/旧列/価格queue、未知送信の停止は保持する。診断HOLDを権利イベントなしと解釈しない。

通常 `IngestResult` は小さい診断summary（status/理由/件数/ZIP SHA/原本行参照）を返し、catchupの既存byStatusにも状態を残す。正常Actions/Node `scripts/sync/yuho-edinet.ts` は有限catchup/source再開へ `observeIssuedShares:true` を明示し、Node backfill/applyも同じモードを使う。Worker adminはこのモードを渡さず、共通DEI gateだけを通り、full観測を呼ばず理由付きtyped `not-observed`（candidateCount/observationsはNULL）を返す。DEI不一致はどちらも明細HOLD。parser前の既知HOLDや未取得type1は未観測のままである。`missing-backfill`、海外backfill、repair、archive-onlyの全callerへ新解析は拡げない。それらの原本保管は従来どおりで、発行株数が未観測なら未知のまま。

保存再生は既存 `pnpm yuho:backfill:holdings prepare <limit> <afterCode|START> <privateDir>`。既存 `readSavedHoldingsZip` のDEI資格化済みMapから同関数を呼び、itemへ全文診断とobserver source SHAを保存する。源再取得・追加ZIP展開・upload・業務書込は0（従来のD1/Notion保存原本読取はある）。準備は有効な `.env` をプロジェクトのNix環境から読む既存運用を使う。applyの適用契約は変更しない。

`shareholdings.ts` source SHAが変更されるため、旧parser SHAのbulk plan/itemは既存guardで適用できない。正常な旧ZIP bytesを保存したまま、別private planへ再prepare・全値照合する。今回古いplanを新SHAへ書き換えて受け入れた件数は0。

## 一次資料と資格

[金融庁2025年版](https://www.fsa.go.jp/search/20241112.html)、[2026年版](https://www.fsa.go.jp/search/20251111.html)の公式EDINET taxonomy packageで、jpcrp `2024-11-01` / `2025-11-01` を確認した。

| element（jpcrp_cor） | 公式意味 | 今回のkind |
| --- | --- | --- |
| `NumberOfIssuedSharesAsOfFiscalYearEndIssuedSharesTotalNumberOfSharesEtc` | 事業年度末現在発行数、sharesItemType/instant | `fiscal-year-end` |
| `NumberOfIssuedSharesAsOfFilingDateIssuedSharesTotalNumberOfSharesEtc` | 提出日現在発行数、sharesItemType/instant | `filing-date` |

公式documentationは期末の発行数も提出日contextでタグ付けすると説明している。FY kindの経済日は同じ原本のDEI/issuer/期末を照合した文書期末であり、native `FilingDateInstant` の日付とは別field。filing kindの経済日は、同docの原 `submitDateTime`（EDINET一覧のJST `YYYY-MM-DD HH:mm`）または束縛済み保存metadataとnative日付が一致するときだけ資格化する。提出日情報の欠測・ISO変換済み時計はHOLD、原日付の矛盾は全kind HOLD。filename/nativecontextだけから経済提出日を作らず、Fetched Atを提出日へ代用しない。

同じnamespaceの `ClassesOfSharesAxis` / `OrdinaryShareMember` の明示1dimensionのみを普通株として受理する。dimension-freeを普通株へ補わない。未知namespace/再束縛・未知dimension・entity/単位不一致・nil/小数/decimals精度不足・同element/context重複・異なるcontextの同kind複数値はHOLD。受理する精度は整数原文かつdecimals `0`/`INF`。summary・自己株・保有株・単元株数・加重平均を混ぜない。

原namespace宣言、element、fact/ZIP/member SHA、context/unitの実原定義、entity・dimension・decimals・原文字列値を保持する。診断は64候補/64KiBで有限とし、超過は原ZIP参照付きHOLDで切り詰め成功にしない。原文の小さい断片は巨大instance文字列を保持しないコピーにする。`rightsApplication` は全観測でunknownのまま、株数差から権利原因・係数を逆算しない。

公式2版照合proof SHA: `12b2f9ce87d26d58de49eb196659281e613ab91d1c0d017df76ef77c64ed8dc3`。schema SHAは2024版 `1a8541752230519e877489caeef5aa455b0c3e6af81eb4d994aad40ff6d6f05a`、2025版 `5c7739d08628424c67e3e85a894b8dcb3cf352060ce37affdd65b7d3ad252bf9`。一次package・各schema/label/definitionの来歴はprivate保存proofへ固定済み。新会社原本取得はない。

## 実保存原本と追加負荷

既存manifest SHA `5fa05d6ce0245679af3ed0d22dba1a371420eb700ba0a4f494dd19a025af87aa` の3源を再生した。全3源で普通株2kindを観測し、同じ無次元2値はHOLD。株数差の原因は判定していない。

| 証券/文書 | taxonomy | FY株数 → 提出時株数 | FY経済日 / native提出日 |
| --- | --- | --- | --- |
| 4374 / S100XUUD | 2024-11-01 | 3815994 → 3815994 | 2025-12-31 / 2026-03-27 |
| 7203 / S100Y8NY | 2025-11-01 | 15794987460 → 15794987460 | 2026-03-31 / 2026-06-10 |
| 9252 / S100X7D0 | 2024-11-01 | 2762891 → 2774926 | 2025-08-31 / 2025-11-28 |

CIへは既存9252原ZIP 808,793Bだけを無加工で収録した。SHA `4b4f1d9fbe5cb6efd836c339020c2de0110ccc0368f23847d1a9f335a02472fc`。旧Fetched Atの値は旧メタデータとして保全し、実HTTP受信時計の証明とはしない。負例のXML変更はprotocol注入であり、実物として保存・公開しない。

Nix Node22.22.2で同じ正常保有parserを別processの単発で比較した。source/Notion/model通信は0、全明細の全列は1/37/1行とも同一。

| 証券 | 旧parser ms → 診断あり ms | process peak RSS MiB（旧 → 診断あり） | 診断JSON bytes |
| --- | --- | --- | --- |
| 4374 | 9.50 → 39.63 | 98.6 → 112.5 | 14430 |
| 7203 | 31.32 → 129.17 | 141.4 → 196.5 | 14621 |
| 9252 | 19.34 → 76.63 | 114.6 → 149.2 | 14605 |

常時DEI gateだけを同条件で別測定すると、4374は13.16ms/97.1MiB、7203は41.79ms/141.4MiB、9252は24.70ms/115.4MiB。全明細の全列は旧parserと同一。これもNode単発の値であり、WorkerでのCPU/peak証明ではない。

これは単発ローカルprocess全体のpeakで、Workerのメモリ値や厳密な増分/上限ではない。DEIとfull観測のmember UTF-8 decode、および既存FilingDate readerのdecodeは残る。Workerの実CPU/peak、全原本の最悪値、次正常定時の総所要は未測定。Nodeの値から128MiB内を保証せず、full診断はNode明示モードに絞った。Worker admin `/yuho-quant/admin/catchup` ではfull観測へ到達しない回帰を固定し、共通DEI gateの実Worker負荷も別受入とする。既存Map再利用で新規展開を0にし、新たな全caller解析・本文一括展開・Notion要求を足さない最小境界に限定した。

検証: Nixでobserver・実normal producer/reader・保有parser/writer・prepare CLI・ingest原子性/batch・catchup・Node入口の9 suites、型検査、変更ファイルlint。normal実fixtureで1既存展開、source予算0の正常markerは既存5要求/1PATCH、DEI不一致/00000は両モードとも既存4要求/公開0、保存prepareは1既存展開/追加Notion0を確認。Worker型未有効callerのfull観測0と、正常Node入口の明示有効も固定する。full CIと次実定時は別受入。
