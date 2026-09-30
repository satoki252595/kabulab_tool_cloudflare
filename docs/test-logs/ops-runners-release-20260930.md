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
- `scripts/sync/ipo-bridge-capture.ts`
  compile 依存として exact 収録 (2READ executor の stableStringify
  供給のみ)。UNEXECUTED / WIP であり、CODE CLEAR・live proof ではない。
  IPO live path は本 PR で実行しない。source5 の前に whole-code review
  が必要。originals 保持・55/2READ の rerun なし。
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
- IPO live 5-GET (`ipo-zip-bridge.py`・tests・flake poppler・
  IPO 記録)。source5 GET 0 のまま。
- 上記以外の packet branch 差分は本 PR に含めない。

## gates

- `pnpm typecheck` / `pnpm lint` / `pnpm test` (CI)。
- 各 runner の canonical preflight0 (sends 0) は記録済み
  (archive `c78762de…`・source55 `b77cd3f9…`)。
- live 実行は本 PR の範囲外 (実行済み各 1 回の budget 消費済み。
  再実行なし)。
