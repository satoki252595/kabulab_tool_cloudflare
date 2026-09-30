# macro-canonical fixtures

`selectConfirmedCloses` / macro persist のテスト用原文 fixture。
由来は `provenance.json` に記録 (source/SHA/slice/observed)。

## actual (bounded capture 由来。値を捏造しない)

- `n225-20260930.json` / `gspc-20260930.json` / `vix-20260930.json` /
  `niy-20260930.json`: 2026-09-30T01:55:26Z (10:55 JST) の bounded
  Yahoo 4-capture (proxy HTTP 4, symbol 各1, no retry) の原文を
  末尾 3 bar + meta そのままに trim。Notion `yahoo-4-20260930T015526Z`
  に原本保管済み。期待: N225/GSPC/VIX の確定日は 9/29
  (N225 の 9/30 bar は形成中のため除外)。
- `n225-20260929.json`: 2026-09-29 取得の旧 N225 原文 (末尾 3 bar)。
  lastTs(9/28) < start(火曜 session) で候補 9/28 close NULL のため
  HOLD が正しい (金曜 9/25 への代替なし)。回帰用。

注意: 01:55Z capture は 09:10 失敗時の replay でも 06:00 成功の
proof でもない (10:55 JST session 中の mechanism/parse 証拠)。

## symbolic (test-only。由来区別。値は丸め synthetic)

- `n225-0910-forming.symbolic.json`: 09:10 JST 境界。9/30 session
  形成中 (lastTs==start, rmt<end) → 確定は直前実バー 9/29。
- `gspc-nullclose.symbolic.json`: session 終了済みだが確定バー
  close null → HOLD (older 代替なし)。
- `n225-friday-stale.symbolic.json` / `vix-friday-stale.symbolic.json`:
  lastTs < start (月曜 session・金曜バー) → 確定 9/25。
  日付乖離 gate のテスト用。
- `vi-symbolic.html`: parse 可能な VI ページ double
  (DPP-PRP==DYWP, ZXD 2026-09-29)。値は synthetic。
