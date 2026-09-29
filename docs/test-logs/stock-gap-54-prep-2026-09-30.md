# Issue #163 9/29欠損54 固定診断 PREP（2026-09-30）

## 固定入力（D1 SELECT 確定）

- 52 latest_date<9/29: 1380,1787,1905,1948,291A,3184,3439,3477,3480,3495,
  3583,3600,3856,3944,4365,4464,4629,4800,4976,5202,5484,5969,5990,6396,
  6408,6486,6558,6566,7067,7082,7240,7413,7426,7515,7523,7565,7812,7857,
  7877,9012,9017,9049,9087,9223,9313,9331,9361,9362,9508,9691,9698,9914
- 2 indicator 行なし: 1909,2180
- 9/29 OHLCV 行不存在 54/54、close NULL 0。実 run 冒頭で live anti-join を
  再確認し、集合 drift 時は 1 GET もせず STOP する。

## 実装（live 未実行）

- `src/shared/yahoo/client.ts`: 既存 `fetchChart` に任意 raw-capture hook
  1 箇所（`response.clone()`、HTTP 判定・parse・guard より前）。未指定の
  通常呼出は不変。parse 部を純粋 `parseChartResponse` へ抽出して診断と共有
  （既存 yahoo 4 suite 87 件で同一性を確認）。QuoteSummary・
  fetchStockRawData・日次・Notion 本体は不変。
- 新規 `scripts/sync/stock-gap-diagnostic.ts`（手動実行 1 ファイル）:
  Chart 5y/1d だけ 54 GET（QuoteSummary なし）。7 分類
  （source_gap/stale/priceguard/http/parse/has_real_bar/unknown）を全件
  無省略で判定。9/29 バーは exact date、sanitize 棄却を source absent と
  混同しない。429/5xx・無応答は取得済み分を partial 保管して STOP
  （盲再試行なし）。保管自体の失敗（record/verify の throw）は成功に
  偽らず例外のまま STOP し、部分保管は行わない。D1 は SELECT のみ。
  `--execute` が無いと起動しない。
- custody: 診断バッチ 1 行を service "stock-sync"・冪等 key
  `price-sync-diag-20260929-{runId}` で記録。コード別 Chart 原文 +
  manifest（code/HTTP 状態/SHA/未取得理由）添付。記録後は現 main の
  strict `listPageFiles`（kind あり・不正 throw）で件数・名前・hosted・
  全 bytes SHA を readback 照合。短縮等は HOLD。
  Files 配列は Retrieve a page の 25 件省略対象外（GPT-sol 公式確認済み）。
- Chart が正常でも旧 run の失敗理由は undetermined のまま。次回通常 run
  の PR180 batch と照合する（診断出力・manifest に明記）。

## 検証（nix、Yahoo/Notion/D1 live ゼロ）

- 停止信号の complete 判定混入（最終 2180 停止でも partial + exit 1。
  stopped/stopReason を判定・report・manifest/metadata・CLI ログへ配線）
- 新規 focused: `src/shared/yahoo/raw-capture.test.ts`（3 件）+
  `scripts/sync/stock-gap-diagnostic.test.ts`（25 件: 7 分類 13・drift・
  batch・record・readback・runner 完走/partial/最終停止/保管失敗）
- 近傍含む 7 files / 155 passed
- `nix develop -c npm test` → 224 files / 3557 passed / 281 skipped / 0 failed
- `nix develop -c npm run typecheck` → exit 0
- `nix develop -c npm run lint` → exit 0

## live-run gate（別 bounded grant 待ち）

`--execute` + proxy env（`requireYahooProxyForNodeSync`）+ D1 読み。
54 GET 逐次（500ms 間隔・429 backoff 尊重）。修復（D1 書込）は含まない。
