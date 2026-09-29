# Issue #163 9/29欠損54 live 診断証跡（2026-09-29 22:23–22:25 UTC）

PR192 の `scripts/sync/stock-gap-diagnostic.ts --execute` を main
`423cc39d` で 1 回実行した記録。個別の価格値は載せない（集計のみ）。

## 実行条件

- 対象: 固定 54 コード × 2026-09-29（PREP 固定集合と同一）。
- 実 run 冒頭の live anti-join で欠測 54・drift なしを確認後に取得。
- 取得: Yahoo Chart 5y/1d の Node→proxy invocation 54（全 HTTP 200）。
  upstream 実 GET 数は非観測。診断側の追加 retry なし。
  保管原文は最終 proxy 応答であり、中間 401 応答（あれば edge 側）は
  未保管（共有認証更新の既存動作。事実として記録）。
- D1 は SELECT 2 文のみ、書込 0。指標・OHLCV・修復の書込なし。
- 日時は実測値（バックデートなし）。

## 結果（54 件無省略、complete 終了・exit 0）

| 分類 | 件数 | コード |
|---|---|---|
| has_real_bar | 47 | 1380,1787,1905,1948,291A,3184,3439,3477,3495,3583,3600,3944,4365,4464,4629,4800,4976,5202,5484,5969,5990,6396,6408,6486,6558,6566,7067,7240,7413,7515,7523,7565,7812,7857,7877,9012,9017,9049,9087,9223,9313,9331,9361,9362,9508,9691,9698 |
| source_gap（終値なし） | 2 | 3480,3856 |
| stale（末尾が 9/29 より前） | 1 | 9914 |
| priceguard（応答全体乖離） | 4 | 7082,7426,1909,2180 |
| http / parse / unknown | 0 | — |

## custody

- 診断バッチ 1 行（service "stock-sync"、
  key `price-sync-diag-20260929-local-1790720602657`）に Chart 原文 54 +
  manifest 1 の 55 添付を記録。
- 記録後に strict `listPageFiles` で 55 件の件数・名前・hosted・全 bytes
  長さ・SHA256 を readback 照合し、全件一致。
- Notion 書込: batch 記録 1 件（添付 55）。原文 bytes への patch なし
  （共有 record 経路の自動 custody のみ）。

## 未確定事項

- Chart が正常でも旧 run の失敗理由は undetermined のまま。
  次回通常 run の PR180 batch と照合する。
- 価格 repair（D1 書込）は本診断の範囲外。次計画待ち。
