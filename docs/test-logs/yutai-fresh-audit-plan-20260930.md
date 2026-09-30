# Yutai fresh audit 事前計画 (2026-09-30, prepare-only)

本番 D1 現値と保存済み preimage/証跡を突き合わせる fresh 監査の計画。
probe 実装は `services/otakara-yutai/data-scripts/probe-yutai-fresh-audit.ts`
(手動 diagnostic CLI)。**この時点では live 8 実行の grant なし。
main merge せず、live 実行せず、probe 実装と計画のみ報告する。**

## 1. scope (offline 再導出・固定)

- ABC 131 + FT 13 + normal 34 (manifest-34) → union **144** 銘柄。
  A∩FT=6、normal-outside=6、benefitId→親 mapping 1668 件。
- scope SHA (sorted canonical): `183147371fa0d681d0e113a7f676f62f8d350744d18a0dd6e30ae5e33acb6689`
- chunk: 144 = **80 + 64** (既存 `ID_CHUNK=80` のまま)。
- 外 6 銘柄は stockID/code/active-equity/benefitID の exact proof を取る
  (active-equity は `activeEquityCondition` 述語通過 + `is_active=true` で示す。
  `instrument_type` の値は読まない)。

## 2. 8 SELECT (既存 chain のみ。新 SQL/API adapter 0)

- 経路: `openOtakaraD1()` → `fetchYieldInputs(db, union144)` →
  `snapshotStockPreimages` (純粋)。`loadBenefitRows` (unbounded) は使わない。
- chunk ごとに parent → fin → score → benefits の 4 SELECT (固定順) ×2。
- 物理テーブル: `core_stocks` / `otakara_stock_financials` /
  `otakara_stock_scores` / `yutai_benefits`。
- 期待列 (コード由来。実 bytes と違えば STOP):
  parent 3 (`id,code,is_active`) / fin 13 / score 4 / benefits 9。
  - 注意: 指示の `fin14cols` に対しコード由来は 13 列
    (`stock_id,price,per,pbr,dividend_yield,roe,ma25,rsi14,macd,macd_signal,yutai_yield,data_date,fetched_at`)。
    強制せず live bytes で確定する。score の `score3` は stock_id 除きで一致。
- 送信前検査: URL 完全一致 (DB exact)・単発 `{sql,params}` envelope のみ
  (`batch` 拒否)・SELECT 単文 (`;` 拒否)。8 件 exact (extra 0)・redirect 0・
  retry 0。writer/sender は throw-if-called のみ。batch 送信口は作らない。

## 3. 取得と検証 (live 時のみ)

- `POST /query` ×8。fetch ラッパで `response.clone()` の実 bytes を保存する。
- raw 応答の厳密検証: HTTP 成功・`success:true`・`result[0].results` 配列の
  存在・行の列順と列型・chunk 帰属・一意性。results の欠落を `[]` とは
  扱わない (共有 client の fallback があっても監査は 0 同値を主張しない)。
- caps: benefits 合計 ≤2000、parent/fin/score 各 ≤144。超過は STOP
  (追加 query 0)。親の欠落・不活性・code 不一致は実 code + 全 ID を保存し
  STOP (truncate しない)。
- 8 連読は global transaction ではない。将来の apply は FULL CAS が別 gate。

## 4. 出力 10 件 (private のみ。Git/doc は件数・SHA のみ)

- `/tmp/yutai-fresh-audit-20260930/` (0700, write-once。非空なら拒否)。
- `raw-response-01.json`〜`08.json` (実 bytes, 0600) +
  `fresh-snapshot.json` (derived, 0600) + `metadata.json` (0600)。
- stdout/doc に auth header・env・cookie・URL 生値・原文を出さない
  (URL は SHA のみ)。

## 5. 比較 (fresh snapshot 入力。模擬 post ではない)

- ABC 473: 現行 3 値 + 保護 identity (親) + 掲載文 (FT 62 は newFull・他は
  row-manifest 旧文) を全 ID 比較。差が無ければ実 planner→実 apply で
  0 送信を証明する (既存 producer/proof 関数を再利用)。
- FT 62: 実分類の actual 件数 (ALREADY_APPLIED/CANDIDATE/STOP) +
  ALREADY_APPLIED 行の実 builder 0 文・送信 0 回。
- normal45: fresh 現行行 + 実 planner の actual 件数。
  offline 28pending/38src + 9stale/12 = 37/50 は cross-check (未実測) で、
  違えば実 diff を保存し件数を強制しない。
- 9 stale タスクの ID 書換だけでの修復は禁止 (原文の再認定が必要)。

## 6. gates と completeness (grant 条件)

- live 8 実行の grant は probe file exact SHA + scope SHA + 件数 +
  private filenames + semantics + completeness の root review 後。
- Source GET 0 / Notion archive 0 / D1 R2 writes 0 / dispatch 0 のまま。
- 将来 capture 成功後の Notion PrimaryData 記録
  (unique key 日付+snapshotSHA・force false・physical 10 全件 strict unique)
  は別 WRITE gate。現在 WRITE grant 0。
