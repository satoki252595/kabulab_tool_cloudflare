# Yutai fresh audit 事前計画 (2026-09-30, prepare-only)

本番 D1 現値と保存済み preimage/証跡を突き合わせる fresh 監査の計画。
probe 実装は `services/otakara-yutai/data-scripts/probe-yutai-fresh-audit.ts`
(手動 diagnostic CLI)。**この時点では live 8 実行の grant なし。
main merge せず、live 実行せず、probe 実装と計画のみ報告する。**

## 1. scope (offline 再導出・固定)

- ABC 131 + FT 13 + normal 34 (manifest-34) → union **144** 銘柄。
  A∩FT=6、normal-outside=6、benefitId→親 mapping 1668 件
  (= ABC fullset 1557 + ABC 外の row-manifest 111。仮定の新件数ではない)。
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
  物理列名は schema 定義どおり (`ma_25` / `rsi_14`。`ma25` 誤記は修正済み)。
  - 注意: 指示の `fin14cols` に対しコード由来は 13 列
    (`stock_id,price,per,pbr,dividend_yield,roe,ma_25,rsi_14,macd,macd_signal,yutai_yield,data_date,fetched_at`)。
    強制せず live bytes で確定する。score の `score3` は stock_id 除きで一致。
- 送信前検査: URL 完全一致 (DB exact)・単発 `{sql,params}` envelope のみ
  (`batch` 拒否)・SELECT 単文 (`;` 拒否)。さらに既存実 builder と同一の
  select 式の `.toSQL()` 8 文と SQL・params・件数を完全一致で照合する
  (projection/predicate/144 scope を強制。parent params は chunk+2 =
  82/66。式の複写乖離は runtime で STOP)。
- 8 件 exact (extra 0)・retry 0。redirect は `manual` 送信で follow を
  構造的に封じ、3xx 応答は follow せず STOP。
  writer/sender は throw-if-called のみ。batch 送信口は作らない。

## 3. 取得と検証 (live 時のみ)

- `POST /query` ×8。fetch ラッパで `response.clone()` の実 bytes を
  capture 直後に immutable 保存し (validate 前)、validate 成否も
  incremental な partial ledger へ残す。途中失敗でも取得済み bytes と
  失敗記録は失わない。
- raw 応答の厳密検証: HTTP 成功・`success:true`・`result[0].results` 配列の
  存在・行の列順と列型・chunk 帰属・一意性。results の欠落を `[]` とは
  扱わない (共有 client の fallback があっても監査は 0 同値を主張しない)。
- caps: benefits 合計 ≤2000、parent/fin/score 各 ≤144。超過は STOP
  (追加 query 0)。親の欠落・不活性・code 不一致は実 code + 全 ID を保存し
  STOP (truncate しない)。
- 8 連読は global transaction ではない。将来の apply は FULL CAS が別 gate。

## 4. 出力 11 件 (private のみ。Git/doc は件数・SHA のみ)

- `/tmp/yutai-fresh-audit-20260930/` (0700, write-once。非空なら拒否)。
- `raw-response-01.json`〜`08.json` (実 bytes, 0600) +
  `fresh-snapshot.json` (derived, 0600) + `metadata.json` (0600) +
  `partial-ledger.jsonl` (capture/validate の incremental 記録, 0600)。
- stdout/doc に auth header・env・cookie・URL 生値・原文を出さない
  (URL は SHA のみ)。

## 5. 比較 (fresh snapshot 入力。模擬 post ではない)

- 保存全行集合 (benefitMap 1668): 期待 post (ABC 3 値 + FT 掲載文 +
  不変行の pre 値) と fresh の全行比較。NULL-safe・membership 双方向・
  親帰属・minShares/recordMonth・掲載文。差は content として全件保存する
  (473 だけ見て MATCH にしない)。
- 保護 fin/score の期待値は pre ではなく期待 post
  (filed 済み 61 利回り + 52 スコアの上書き。それ以外は pre のまま)。
  pre 比較のままだと意図どおりの適用が偽 drift になるため。
  期待値は既存 proof の helper (`postFinScoreOverrides`) から取る。
- runtime drift は独立計数し full match への丸めは 0: 保護 fin/score の
  full property・untouched 行の updatedAt・利回り再計算の変化。
  正当な夜間更新もありうるため正直報告し、0 に丸めない。
  修復行の updatedAt と 61 変更銘柄の fetched_at は書込 receipt
  (pre より進むこと) を要求する。
- 実 planner→実 apply は既存 producer/proof 関数を再利用し 0 送信を証明する。
- FT 62: 実分類の actual 件数 + 全 62 行の親 identity
  (stockId/code/benefit-table) 証明 + ALREADY_APPLIED 行の実 builder 0 文。
- normal45: 既存 `proveNormal45` を fresh 現行行 + preFT 再構成行で再利用し、
  rejected/stale/equivalent/pending の全理由を保持する。
  offline 37/50 との一致は cross-check (内容一致の決定論的帰結)。
- 9 stale タスクの ID 書換だけでの修復は禁止 (原文の再認定が必要)。
- parser は既存 verify CLI の共有 export
  (`parseRowManifest` / `parseFtBatchedUpdates` / `parseManifest34Results`)。
  probe 側の複写は削除した (verify CLI の DONE は同一出力で再確認済み)。

## 6. gates と completeness (grant 条件)

- live 8 実行の grant は probe file exact SHA + scope SHA + 件数 +
  private filenames + semantics + completeness の root review 後。
- Source GET 0 / Notion archive 0 / D1 R2 writes 0 / dispatch 0 のまま。
- 将来 capture 成功後の Notion PrimaryData 記録
  (unique key 日付+snapshotSHA・force false・physical 11 全件 strict unique)
  は別 WRITE gate。現在 WRITE grant 0。
