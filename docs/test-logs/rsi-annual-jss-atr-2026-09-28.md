# 001年度売上の正本読取とATR%閾値の検証（2026-09-28）

Issue [#124](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/124)
（全件の Notion/D1 反映）の完了を merge 条件とする先行 PR の検証ログ。
Refs [#132](https://github.com/satoki252595/kabulab_tool_cloudflare/issues/132)。
source D1・Notion への書込は行わない。コードとローカル検証のみ。

## 変更

- 001 RSI の年度売上（銘柄詳細の表示と優良株選定の入力）を旧
  `core_stock_annual_financials`（Yahoo 派生・連結/単体混在・暦年丸め）から
  正本 `jss_financials` の本決算実績へ移行。共有 gate（`pickAnnualSeries`）が
  最新本決算期末の連結区分に単一化し、未来期のみ除外する。短期決算の
  推測除外はしない（期末間隔からの期間推定は期首も期間も持たないため
  行わない — 推定で落とすと最新の実績を捨てる事故になる）。決算期変更の
  端数期も年欠落・null と同じく原文のまま保持する。予想・四半期・修正は
  実績に混ぜない。訂正は writer の disclosed_at ガード付き完全置換（#131）
  で同一 PK 行へ反映済みのため、reader 側に新旧選択は無い。
- 優良株選定（`evaluateBlueChip`）は直近 3 期が同一既知区分（連結/単体）
  かつ実績期末が年次連続（暦年 +1・同月日）かつ売上確定値のときだけ
  数値比較し、年欠落・決算期変更・不明区分・未取得があれば年率化や
  穴埋めをせず `revenueTrend: null`（判定不能）に倒す。TTM 営業利益率は
  Yahoo のまま。残件: 期首/期間を持たないため同一月日の連続でも各期の
  正確な長さは証明できない（上場年初年度の短い第 1 期など）。是正には
  source 側の会計期間列が必要（`docs/001-rsi-screening.md` の残件節）。
- 公開面の数値クエリは `license_tag='commercial-ok'`（EDINET）を SQL 条件に
  含める。TDnet 短信由来（factual-cite）は公開面に出さない。
  DDL の正本は pipeline 側のため、TS の mirror は読む 6 列だけとし
  drizzle generate の対象外に保つ。
- 日次 sync は正本年次を 1 文で先読みし銘柄ごとに束ねて選定入力にする。
  TTM 営業利益率は Yahoo のまま（定義を保つ）。旧 annual writer は
  外部 consumer（YouTube/新高値検証）が残るので維持し、DROP は宣言しない。
- 共通 `screenStock` の ATR% 閾値を `0.02`（実効 0.02%）から `2`（2%）へ修正
  （独立 PR で先行。入力は `src/cron/daily.ts` から `ratio × 100` の % 表記
  で来るため、画面の「ATR% ≧ 2%」表示と一致する）。

## 回帰検証

- `services/rsi-screening/src/tests/integration/annual-jss.test.ts`（新規）:
  実 SQLite 上で `getStockDetail` を実行。8154 の既存 fixture
  （2025-03-31 本決算・連結・547,779,000,000 円、
  FY2026 連結・658,941,000,000 円）の期末・連結区分・実績値が期待通りで、
  同一期末の単体・予想・四半期・修正・他銘柄行と factual-cite 行を混ぜないこと、
  最新期単体化は単体系列・最新期不明は不明表示（古い区分で埋めない）こと、
  未来期のみ除外し決算期変更の端数期は原文のまま残すこと、未取得は
  null・空系列のまま補完しないことを確認。旧表の DDL は作らないため、
  旧表参照が残れば "no such table" で落ちる。
- `services/rsi-screening/src/tests/unit/blue-chip-filter.test.ts`（更新）:
  既存 fixture を実績期末・連結区分つきの年次連続行へ具体化し、正常系列の
  判定が変わらないことを確認。年欠落（FY2022/2024/2026）・決算期変更
  （2021-03-31→2021-12-31→2022-12-31）・不明区分・窓内 null の 4 件は
  `revenueTrend: null`・非優良に倒れることを確認（年率化・穴埋めなし）。
- `src/cron/daily-jss-annual.test.ts`（新規）: sqlite-proxy 経路で
  `loadJssAnnualMap` を実行。本決算 × commercial-ok だけを 1 文で引き
  銘柄ごとに束ねること、絞り込みが SQL の WHERE であることを確認。
- `src/shared/screener.test.ts`（新規）: ATR% 1.99→不通過 / 2→通過 /
  2.01→通過 / null→不通過の境界のみ。
- `nix develop -c pnpm test`（全体）: **188 files / 2579 pass / 383 skip / 0 fail**（ATR の 4 件は独立 PR #135 側で検証。+4 は年次比較ガードの新規 4 件）。
- `nix develop -c pnpm typecheck`: 通過。`nix develop -c pnpm lint`: 通過。
- `nix develop -c pnpm db:generate:d1`: **No schema changes**
  （読取ミラー `src/shared/db/jss-financials.ts` は generate 対象外。
  DDL の正本は `pipeline/.../cloud_store/schema.py` の `_FINANCIALS`）。
