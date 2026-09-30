# Owner-after 2-READ exact packet (2026-09-30、LOCAL PREP)

提案 `owner-read-sector6-cas-proposal-20260930.md` の承認済み範囲を
exact packet として具体化する。**packet のみ。live 実行しない。**
コード・SQL・件数・pin のみ。値は含まない。

## ファイル

- `docs/owner-2read-r1-20260930.json`: R1 47 unfiltered identity/status。
  exact SQL + 47 binds (live-note 順) + eligible40/excluded7 + pins。
- `docs/owner-2read-r2-20260930.json`: R2 qualified-40 full OHLCV preimage。
  exact SQL (date bind + 40 id slots) + 40-code order + fill 規則 + pins。

## 件数 (exact)

- R1: sends 1、binds 47、期待行 ≤47、writes 0。
- R2: sends 1、binds 41 (date 1 + id 40)、期待行 ≤40、writes 0。
- 合計 sends ≤ 2、dispatch 0。bind 上限 100 内 (47・41)。
- R1 述語は `core_stocks_code_unique`、R2 は `(stock_id, date)` unique
  で索引カバーされる。

## 規則

- R1 は 47 全件を無濾過で読む。exact-1 active-equity 適格は 40 のみ。
  除外 7 は現状記録し全体の false HOLD にしない。
- R2 前提: 40 全件が R1 で exact-1 解決済み。未解決があれば R2 は
  送らない (HOLD)。per-code 部分送信は本 packet の範囲外。
- 未解決 id は sentinel のまま非 actual。`-1` を bind に置かず、
  id を捏造しない。slot は R1 actual のみで埋める。
- post/readback (R3) + 書込は将来の書込 grant の範囲。本 packet 外。

## 再利用 (新 framework 0)

- p197 repair 経路の述語・列形 (identity 4 列・OHLCV 8 列・unique)。
- 共有境界: stock-code 契約 (47 全件の正準確認)・D1 bind 上限 100・
  有限スカラー helper (R1 binds 全件を実 helper で検査)・PR215 の
  query strict (dict 行・literal True・result exact1)。
- SQL text は placeholder/bind 機械照合 + 実列名 stub への EXPLAIN
  で syntax 確認 (offline)。

## pin

- diag key `price-sync-diag-20260929-local-1790720602657`、
  manifest SHA `f509f5db…94d` (55 添付)。
- eligible-r2 SHA256 `643d017a…fee8e4b` (codes 40 件順を slot 順に採用)。
- base A-receipt CONFIRMED-single-831-match、
  SHA `fff94dd1…b78` (228486 bytes・4441 rows・asOf 2026-08-31)。
- 将来 apply 時の fresh same-run verification は mandatory。

## sector6 (本 packet 外の維持事項)

- S1 preimage には full-preimage guard の executor 呼出が必須
  (正準/重複/構造型/phantom。PR215 gate を再利用)。
- 622A・627A・646A の identity HOLD を維持。fallback なし。
- 本 packet に sector6 の read は含まない。

## 検証 (offline、live 0)

- 集合: 47 件一意・40 ⊂ 47・47−40 = 除外 7 (文書記録と一致)。
- 正準: 47/47 が `parse_stock_code` exact 一致・非 phantom。
- placeholder/bind: R1 47=47・R2 41=1+40。bind 上限・有限性 ok。
- owner write 0・READ 0・source 0・Notion archive 0・R2 0・dispatch 0。
  live 境界は Root が別明示する。
