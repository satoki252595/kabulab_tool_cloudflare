# macro canonical-date + custody proof (2026-09-30)

PR #206 (Refs #163)。09:10 失敗の根本修正: 正準日付キー + producer 原本
custody + shared `previousClose` 明示化 + 株式 guard 全パス共有。
本文・価格・秘密なし (counts/dates/SHA-prefix のみ)。

## Capture (bounded grants, all consumed, re-GET 0)

- VI 1 GET: `https://www.nikkei.com/smartchart/?code=N145/O`
  200, 92849B, SHA `808121fd8cae...`, req/recv 2026-09-30T01:45:18Z,
  retry 0, other Yahoo 0.
  送信 headers は独立 capture 条件 (既存要求の完全再現ではない。
  当初 meta の "exact" 主張は撤回→下記補足 custody)。
- Yahoo 4 (proxy HTTP total 4, symbol 各1, no retry, redirect manual):
  `^N225`→`^GSPC`→`^VIX`→`NIY=F` sequential, existing `fetchChart(*,'1mo',{onRaw})`
  - N225: 200, 2937B, `4495c7d8e7b4...`, dataDate 9/30 (20 bars)
  - GSPC: 200, 3327B, `4288024e4daa...`, dataDate 9/29 (21 bars)
  - VIX: 200, 3512B, `c56a57dd0a7d...`, dataDate 9/29 (22 bars)
  - NIY: 200, 2376B, `fd99273b3642...`, dataDate 9/30 (22 bars)
  - 観測 2026-09-30T01:55:26Z (10:55 JST session 中)。
  - Worker 内部の bootstrap retry / Yahoo GET 数は unobserved
    (proxy-HTTP count のみ)。bytes は Node decoded body (wire 主張なし)。
- 01:55Z capture は 09:10 失敗時の replay でも 06:00 成功の proof でもない
  (mechanism/parse 証拠)。D1/R2 write 0、dispatch 0。

## Source findings (date/HOLD 根拠。値は private のみ)

- Session meta (same-actual-JSON): N225 9/30 形成中 (rmt<end) → 確定 9/29。
  GSPC/VIX 9/29 確定 (rmt>=end)。NIY live tick (helper 対象外・snapshot)。
- `meta.previousClose` は 4/4 で欠落。`chartPreviousClose` は 4/4 で
  直前実バー終値と不一致 (別意味)。前日終値契約として支持 0 →
  macro pct は実バー + 直前実バー終値経路。shared chain 削除。
- VI: ZXD 2026-09-30 + DPP:T 2026-09-30T10:45:00+09:00 (live session-today)。
  正準キー 9/29 と不一致 → HOLD (混ぜない)。PRP は bare
  (timestamp companion なし。前日日付の推測なし)。
- 旧 N225 actual (9/29 取得): lastTs(9/28) < start(火曜) で候補 9/28
  close NULL → HOLD (9/25 代替なし。旧案 9/25-success は撤回)。
- 既存 `fetchNikkeiVi` は `window.__INITIAL_STATE__` を読み、保存 body の
  offline replay (0 network, pristine d395) で parse OK。
  NEXT_DATA 欠如を失敗原因とする当初主張は撤回 (parser 無関係)。

## Notion custody receipts (Rule 6, force=false, strict readback)

- `vi-n145o-20260930T014518Z`: recorded/written, unique 1 row, 2 files
  kind=file, hosted HTTP200 + length + SHA 一致 ×2。
- `vi-n145o-20260930T014518Z-provenance-correction` (supplement):
  recorded/written, 1 file (`corrected-provenance.json` 3463B,
  `f44c9c60a769...`) readback 一致。原本 row 不変、overwrite 0。
- `yahoo-4-20260930T015526Z`: recorded/written, unique 1 row, 5 files
  (raw 4 + manifest 6842B `c7b3c631a264...`) kind=file, HTTP200 +
  length + SHA 一致 ×5。archive 要求は capture-4 と別計数。

## Implementation scope (PR #206)

- `src/cron/macro-session.ts`: session-meta confirmed 選択
  (N225/GSPC/VIX。symbol/granularity/昇順/start<end/同日 session/
  rmt 終了証明/candidate<=rmt/guard ONE+一致)。NIY は snapshot。
- `src/cron/daily.ts`: collector (attempt 別・実時刻・SHA) +
  `macro-source-batch-*` 保管→readback→persist (失敗 throw) +
  正準 gate (GSPC キー・N225/VIX/VI 照合・必須値完全性・INSERT 前) +
  原本必須 (全 target) + single final persist。
- 株式 sibling: 時間窓・N225 guard・銘柄別 targetDate・完了期限を
  default パスへ (stocksOnly はマクロ有無のみ)。`expectedDate` 必須、
  `dataDate` 代替除去 (latestDate は gate 証明済み expectedDate)。
- shared: `fetchChart.previousClose` は source 明示のみ (chain 削除)。
  VI: ZXD 暦日 + DPP:T TZ 付き ISO8601・日付一致必須、onRaw 追加。
  readback 照合を共有 helper へ (診断 caller 契約維持)。
- GHA split 不変。C-files untouched。

## Tests (local, Nix)

- macro-session.test.ts: 32 (actual 4 + symbolic 境界 + malformed 14 + 重複/guard 証明 8)
- daily-mode.test.ts: 24 (stocks 3 + macro/HOLD 9 + custody/archive 4 + stock-default 8 [window 2/session 3/銘柄 3])
- nikkei-vi.test.ts: 12 (parse 1 + STOP 9 + onRaw 2)
- raw-capture.test.ts: 9 (既存 3 + previousClose 再生 6: actual4/explicit1/no-fallback1)
- full: 229 files / 3642 passed / 389 skipped / 0 failed
- typecheck 0 error, eslint clean (touch files)。
- fixture: `src/cron/__fixtures__/macro-canonical/` (actual trim 5 + symbolic 5 + provenance.json + README)。
