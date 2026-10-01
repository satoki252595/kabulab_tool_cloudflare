# catchup 定期実行の確認（2026-10-02 JST）

[run 36898106782](https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/36898106782)
は `schedule` / HEAD `81604b54d43201a7fa144425b6c3accd41ec6618` で
SUCCESS。開始 2026-10-01 17:16:01 UTC、最終更新 17:40:35 UTC。
全文ログは Git 対象外・0600 で私有保存し、公開文書には集計だけを残す。
ログ SHA256: `4757aca648522a48699f83751e6cab530dac6e4abcf6c83c97ae090bd3aac4d4`。

## 実時間

| ステップ | UTC 開始–完了 | Actions ステップ時間 | CLI 自己計測 |
|---|---|---:|---:|
| TDnet | 17:16:13–17:31:25 | 912 秒 | 910.499 秒 |
| EDINET | 17:31:25–17:38:26 | 421 秒 | 419.514 秒 |
| biztag | 17:38:45–17:40:27 | 102 秒 | 99.997 秒 |

2 jobs の開始–完了合計は `1344 + 120 = 1464 秒`（24分24秒）。
workflow の開始–最終更新は 24分34秒。セットアップ、キュー待ち、通知を含む
範囲が異なるため、CLI 計測と同一の指標として足さない。

## TDnet

- 対象範囲 `20260925-20261002`。fetched 1530 / inUniverse 1326 /
  upserted 1326 / unclassified 521。upsert 数は新規作成行数・PDF取得数ではない。
- バッチ保管の API receipt は `outcome=recorded` / `fileTooLarge=false`。
  このログだけから全添付の独立した bytes/SHA readback を完了扱いにしない。
- 銘柄別処理は stocksTouched 241 / created 106 / updated 0 /
  skippedExisting 300 / skippedNoFile 0 / rejudged 0 / rowErrors 0。
  これらは同じ粒度の件数ではなく、stocksTouched と処理行数を足さない。
- `reachedDeadline=true`。workflow 成功は、期限までに全銘柄の保管を
  完了した意味ではない。後続の差分処理・実保管確認は別途必要。

## EDINET

- scannedDays 24 / matched 102 / ingested 0 / skippedExisting 102 /
  outOfUniverse 1 / reachedCap true。listErrors・ingestErrors は空。
- 受注状態は `ok_pattern_a=7 / no_order_table=11 / table_unrecognized=1`。
  海外状態は `no_overseas_table=15 / geo_present_unstructured=2 / ok_geo_rows=2`。
  本文状態は `text:ok=19`。
- 実行 HEAD の [計数コード](https://github.com/satoki252595/kabulab_tool_cloudflare/blob/81604b54d43201a7fa144425b6c3accd41ec6618/src/cron/yuho-edinet.ts#L216)
  は早期 `skipped_existing` を byStatus から除き、`archived_only` を
  skippedExisting に含める。集計から **19通を再処理、83通を早期skipしたと推論**
  できる。各文書の旧原文・修復完了をこの推論だけで証明しない。
- [通常取込](https://github.com/satoki252595/kabulab_tool_cloudflare/blob/81604b54d43201a7fa144425b6c3accd41ec6618/services/yuho-quant/src/services/ingest.ts#L623)
  には `needDbWork=false` でも本文保管・本文ポインタ更新の経路がある。
  非シャード L2 再生成も実行され、projectionStocks は 1384。
  **ingested 0 を Notion/D1 書込0、海外欠落全件修復とは扱わない**。
- 60新規取込 / 300秒の開始予算は次の文書・日付の開始を止める条件。
  進行中の処理・最終 L2 を含む全実行の300秒上限ではなく、今回も419.514秒。

## biztag と通知

- totalStocks / processed は 3689、remaining は0。
  処理種別は skip 3672 / retry 14 / create_row 3。
- 判定済 3570 / 判定不能 25 / 本文なし 94、coverage 約96.77%。
  `billingBlocked=25` が残り、Jev 呼出は0。retry・create_row・remaining 0は
  AI推論実行や課金待ち25件の解消を意味しない。
- 以前確認した課金待ち25件と **件数は変わらない**。前後の全銘柄集合の比較は
  本検証の範囲外で、集合まで同一とは断定しない。
- Notion requests 135 / rateLimited 0 / transientRetries 0。
  failures・masterDuplicates・retryExhausted は空。vocab `v5`、seeded false。
  gate reviewed 0、提案期限は適用外で追加通知要求なし。
- 20分の実行予算に対しCLI実時間99.997秒。
  課金待ち25件の通知ステップはSUCCESSで、
  [Issue #102 のコメント receipt](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/102#issuecomment-5937025375)
  がログに返った。一般のジョブ失敗通知はskip。
  補充・再判定の受入は未完了のまま。

## 費用の境界

- 実測対象は上記 wall time / API集計で、このrunのCloudflare・Notionの
  請求額、全転送 bytes、D1課金行数は未測。欠けた実測を0で埋めない。
- 公開repo + `ubuntu-latest` 標準 runner の compute は
  [GitHub公式の無料条件](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
  に該当（2026-10-02確認）。artifact/cache/larger runner 等の費用とは区別する。
  Node CLIの24分24秒をWorkers CPU millisecondsへ換算しない。
- biztag のJev呼出0は今回の追加推論なしの根拠で、課金待ちを解除した根拠ではない。
  Notion135要求もファイル容量・DB残容量・アカウント請求額を表さない。
  同じ重さが22日続く仮定ならrunner実時間 `1464 × 22 / 3600 = 8.9467 時間/月`、
  biztag Notion `135 × 22 = 2970 要求/月`。これは外挿で、月次実測ではない。

本検証担当による追加のproduction source取得・Notion mutation・D1 writerは0。
別の海外pilot・通常scheduled runの結果はこのreceiptへ混ぜない。
