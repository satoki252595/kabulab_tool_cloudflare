# 1333の日足イベント補完・本番受入（2026-10-02）

[Issue272](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/272)の保存/API契約は[PR274](https://github.com/satoki252595/kabulab_tool_cloudflare/pull/274)で実装済み。本記録は、そのコードを使って**保存済み1333の1件だけ**に配当・分割イベントの原値と取得根拠を追加した本番実績。価格の再取得・全銘柄バックフィル・5分足の受入を実施した記録ではない。

## 原本と補完前の照合

- main `e7a3dd25bd7dd32d50f69ba30c791c7334f90c94` のWorker build・check・python-pipelineの3チェックがSUCCESS。新しい本番API契約も読取で確認した。
- 既存run `36903916350` のNotion物理保管済みstage0 gzipを再利用。1,430,874 bytes、SHA256 `388f21836e8b11c22fb91e2f1abe79a81fe872076356ce1dd77c39fa4955f7d3`。全30memberの原bytes/長さ/SHAを再照合した。
- 対象原応答は226,625 bytes、SHA256 `5d6109a75c8a7b8a14330914e198f8ad91303cf9b2e0eaf924da4319dc64305b`。HTTP200、実本文取得時計は `2026-10-01T18:03:15.537Z`。今回の作業時刻へ付け替えていない。
- PREPは `2026-10-02T14:02:37.352Z`～`14:02:38.504Z`。本番API GET1と直接R2 GET1だけを実施し、共有 `parseDailyChart` → `buildRepairPost` で候補を作成。原文再解析と旧R2の全bars・全splits・whole proofが完全一致し、`updated`を含む旧全フィールドをそのまま保つことを確認した。
- PRE全文SHA256は `aee471657600d5f50a0e5c3ece078619e6ff2ecfb558ac3c72b5273ac78983d6`。純粋な独立レビューでも原文/実clock/価格snapshot SHA/全フィールド一致とmodule pinsを確認した。

## 1回の条件付き適用と全文保管

実行は `2026-10-02T14:20:59.254Z`～`14:21:07.715Z`（8.461秒）。46 file pinsと期限付き実行枠を固定した私有runnerをNix経由で1回だけ起動した。

1. PRE・plan・candidateを含む13memberのlossless gzipを、共有 `recordPrimaryData` で物理保管し、`verifyArchivedAttachments` でhosted全bytes/長さ/SHAを確認。
2. R2を再読し、PRE全bytesと不透明ETagの両方が準備時と一致することを確認。
3. 既存 `r2Put` の `IfMatch` / SDK `maxAttempts: 1` で1回だけ条件付きPUT。
4. R2 POST全文を再読し、candidate全bytes/SHA、strict保存schema、全旧フィールド不変、追加イベント全体を照合。既存1時間の公開cacheを考慮した別queryのAPI GET1でも全bars/splits/proof/updated/corporateEventsと最新dividendsを照合。
5. POST全文とPOST保管開始前のreceiptをlossless gzipで物理保管し、hosted全bytes/SHAを再照合。最後の保管・verifyまで含むcomplete receiptは別に私有保存した。

| 保管物 | bytes | SHA256 |
| --- | ---: | --- |
| PRE/plan/candidate gzip | 166,159 | `73da4707e75648b41a8e576e9355c2170b1e68f438ee789bc42981a32cba8280` |
| POST/receipt gzip | 728,544 | `96d7df1bbfb0216396548fb9f88b02a9cd69d788b70151d280b96467a3527d21` |
| R2 POST全文 | 196,520 | `60d3fbe0708cd283a0ea144daf74305fe12b300cbbaed0a4b0d205c4c207a0c8` |

complete receipt SHA256は `373d5317c69ca7f86f51b9a11e469b10de8cc21f2eeed122b79364b055db440d`。原文・金融値・Notion私有ID/URL・認証情報は公開Gitへ含めず、私有0700 directory/wx0600/fsyncで保持した。

## 実績・通信・独立再読

配当**14件**・分割**1件**の原timestamp/原値/取得根拠を `corporateEvents` に追加し、旧ratio-only分割1件も履歴として保持した。価格、既存splits、whole proof、`updated`は完全不変。対応価格snapshotと原本文SHA・元の取得時計を結び、支払日は推定しない。

適用phaseの追加通信は**20件**（Notion14、hosted GET2、直接R2 GET2、R2 PUT1、本番API GET1）。17 fetchの予約・応答全bytes/SHAを私有保存し、すべて2xx。PREPのAPI GET1/直接R2 GET1はこの20件とは別。Yahoo新規GET・TypeSafe・D1・他R2 key・再PUTは0。未知・競合・保管不一致なら以後の通信を停止する契約を維持した。

rootの独立本番再読は `2026-10-02T14:23:59.884Z`、**直接R2 GET1＋公開API GET1**で、適用phaseの20件とは別計数。POST全文196,520 bytes/SHAと、全bars/splits/proof/corporateEvents/updated/最新dividendsの完全一致を確認し、追加source GET・writeは0。独立receipt SHA256は `a5d591bb4efd47351167ce6fbe09e7b6ae469fdf478d430d04ab7dbf12ed9486`。

## 継続する境界

元応答の末尾null barによるproof span不一致/HOLDはそのまま保持し、5分足を再資格化していない。通常の全銘柄日足・5分足完走、全銘柄のイベント補完、Yahoo制限の全面解除は本作業で証明していない。価格basisは受信quote＋既存OHLC丸め、adjclose未使用・ローカル調整なしを維持し、provider側調整内容や実際の入金額/税/保有株数を推定しない。取得/訂正/未取得の詳しい契約は[実装検証記録](./yahoo-corporate-events-20261002.md)を参照。
