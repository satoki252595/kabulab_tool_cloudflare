# ops runners release note (2READ / archive / source55)

日付: 2026-09-30。review 済み ops code の publish。
本 PR は code + 記録の publish。マージで再実行なし。
実行の CLEAR 順序は runner 毎に異なる (正確な記録):
- archive・source55: 独立 CODE CLEAR + hash-first 通知の後に各 1 回実行。
- owner 2READ (09:37): 最終の独立 CLEAR + hash-first 通知より前に実行。
  事後の独立 audit で受領 (sequencing limitation 付き・rerun なし)。
  事前 CLEAR 済みの主張・backdate はしない。

## 含むもの (exact・review 済み)

- `scripts/sync/owner-2read-execute.ts`
  owner-after bounded 2-READ executor。R1 47 exact-1・R2 sparse-missing 40。
  ONE run 済み (sends 2/2・holds 0・exit 0)。
- `scripts/sync/owner-2read-archive.ts`
  2-READ 証拠の one-shot custody archive。ONE archive 済み
  (recorded/written・verified・gate 16/2/0)。
- `scripts/sync/source55-verify.ts`
  source55 same-run re-verification。ONE verify 済み
  (files 55・codes 54・replay40 40/40・gate 3/55/0)。
- 2READ executor の `stableStringify` は、未 review IPO WIP の同名純粋関数を
  verbatim 移設した実体 (本 PR に IPO 926-line 本体は含めない。
  将来の IPO 側はここを再使用)。移設のみの差分のため canonical bytes・
  PACKET SHA (`6c7fb424…`) は不変。
- 実行時 bytes pins (executor 旧 SHA・`ipoBridge: 462c1219…`・
  `sharedEnv: 183af3b9…`・`yahooClient: cf8294df…` 含む) は run 記録に
  歴史的事実として保持 (retag・rerun なし)。
  本 PR の実行時との差分は下記 3 点のみ:
  1. executor の stableStringify 移設 (canonical bytes 同一。
     PACKET SHA `6c7fb424…` 不変を確認)。
  2. latest-main の `sharedEnv` additive 差分 (VWAP knobs 追加のみ。
     42+/0-) への re-pin。
  3. latest-main の `yahoo/client.ts` 差分 (応答銘柄同一性検証の追加等)
     への re-pin。retained 54 bytes に対する offline replay-40 等価性
     (既存 replayRawBar + ohlcvSevenEqual。network 0・書込 0) で
     40/40 一致を確認。55 の再取得・再 verify なし。
- `services/yuho-quant/data-scripts/overseas-fresh-read-capture.ts`
  最小差分 (sha256Hex/setSHA export・R1/R2 kind・self pins 更新)。
- `src/shared/db/d1-http-client.ts`
  最小差分 (assertBindableParams / assertD1SingleQueryResponse /
  d1HttpQueryUrlFor / d1HttpQueryUrl の export・共有化。挙動不変)。
- 記録 docs: owner-2read packet / codeclear / custody-freeze /
  source55-verify-prep + R1/R2 packet JSON。

## 含まないもの (別途・未 review)

- price40 CAS 実行物 (`price40-cas-execute.ts`・price40 記録)。
  seam adapter は packet branch に WIP 隔離。WRITE 0 のまま。
- IPO 本体 (`ipo-bridge-capture.ts` 926-line・`ipo-zip-bridge.py`・
  tests・IPO 記録)。UNEXECUTED / WIP。source5 は別途 whole-code
  review + final CODE CLEAR の後に着手。source5 GET 0 のまま。
  (poppler 追加は承認済み。待ちではない)
- 上記以外の packet branch 差分は本 PR に含めない。

## gates

- `pnpm typecheck` / `pnpm lint` / `pnpm test` (CI)。
- 各 runner の canonical preflight0 (sends 0) は記録済み
  (archive `c78762de…`・source55 `b77cd3f9…`)。
- live 実行は本 PR の範囲外 (実行済み各 1 回の budget 消費済み。
  再実行なし)。
