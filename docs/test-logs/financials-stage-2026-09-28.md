# Notion③財務サマリの一時 D1 検証（2026-09-28）

対象: PR #123 の `pipeline/scripts/backfill_financials_from_notion.py`。記事本文ではなく、
Notion③の財務ファクトを `jss_financials` に補完する。Cloudflare 上に専用の一時 D1
`kabulab-cf-financials-stage-20260928`（ID `69cbcdc0-d7f0-4043-b5b3-afcb5b156a48`）を作り、
本番 D1 は `core_stocks` と既存財務の読み取りだけに使った。本番 D1 への書き込み、
Worker の切替、記事本文の保存は行っていない。

## 実行と照合

- 一時 D1 に本番の `core_stocks` の ID・コード 3,810 件のみ読み取り複製し、空の
  `jss_financials` に PR の `run(apply=True, verify_code="8154")` を実行した。
- Notion③は 34,663 ページ、34,663 一意キー、4,204 銘柄。実 D1 は 0 → 34,663 行。
  D1 へ別の読み取りクエリを発行して同じ件数と銘柄数を再確認した。
- 連結 34,663 行。出典は EDINET 31,732 行、TDnet 2,931 行。開示種別は本決算
  13,028、1Q 5,177、2Q 3,817、3Q 4,301、中間 8,340。数値は円、期末日・連結区分・
  開示種別・出典・取得日を維持した。
- 現在の `core_stocks` に対応しない Notion③の 1,967 行は、`stock_id=NULL` のまま保持。
  コードの推測結合は行わなかった。
- 8154 は Notion③と実 D1 がともに 10 行。2025-03-31 本決算の連結売上は
  **547,779,000,000 円**、EDINET、data_date 2025-06-26。
  2026-03-31 本決算の連結売上は 658,941,000,000 円、EDINET。
- 別途、既存本番 `jss_financials` 322 行と Notion③をローカル SQLite の同一スキーマ・
  同一 UPSERT SQL で併合し、既存 322 行が全列不変、最終 34,663 行であることを確認した。
  実 D1 では空表からの全件投入を確認した。

## 選定への影響

`src/market/ranking-sql.ts` の本決算月取得式を本番 D1 と一時 D1 で同じように適用し、
本番の `yutai_benefits` を共通に使って `src/lib/rights-window.ts` の規則を
2026-09-28 へ適用した。3,810 銘柄の本決算月既知は 152 → 3,793。
`rightsWindow` は true→false 677 銘柄、false→true 574 銘柄。
8154 は月不明→3月だが true→true。合成スコア・並び順の式は本決算月を参照しない。
ただし SHORT の「出来高急増のみ」の通過判定には `rightsWindow` を使うため、
該当銘柄の門は変わりうる。専用一時 D1 は市場テーブルを持たないので、
市場全体の実ランキング再計算はこの検証に含めていない。

直近の市場指標日 2026-09-25 について、本番 `swing_stock_indicators` の
`volume_ratio >= 2`（実装の `VOLUME_SURGE_RATIO`）369 銘柄を取り出し、
本番/一時 D1 の本決算月と本番の優待月で `rightsMonthsOf` / `isRightsWindow` と
`shortSetupGate` の**出来高単独分岐**を照合した。通過は旧 121 → 新 98 銘柄で、
新たに通過 40、新たに不通過 63。8154 の直近出来高倍率は 2.738 倍だが、
権利ウィンドウは旧/新とも true なので、この分岐は両方不通過。
実際の SHORT setup 門は開示タグまたは正の event_drift があれば先に通過する。
それらを再計算していないため、上記の 103 件の変化は実際の全 setup 門の変化件数ではなく、
**出来高だけで判定される場合**の差分である。

## 後片付け

検証ログを先に保存した後、専用一時 D1 を Wrangler 4.101.0 の
`d1 delete kabulab-cf-financials-stage-20260928 --skip-confirmation` で削除し、
`Deleted ... successfully` を確認した。本番 D1 は保持した。
