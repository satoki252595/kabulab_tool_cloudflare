# 海外 closed-44 executor PREP (2026-09-30・WRITE 0)

guarded-CAS NEWPOST executor の実装 + preflight PASS。live 未実行
(Root exact grant 0)。59physical/74read/custody の再実行なし。
source-12 pins・unknown-32 honest-empty 契約は qual のまま。

## 実装 (再使用のみ・新規 framework なし)

- `services/yuho-quant/data-scripts/overseas-closed44-execute.ts`
  (`fcf03ba9…47dc7`・797 行) + focused test
  (`services/yuho-quant/src/tests/overseas-closed44-execute.test.ts`
  `259f17f1…213b`・8 passed 実 SQLite)。
- 共有 writer: `toOverseasSaveRows` (6th caller)。原子 batch は ingest
  idiom (docId subquery + DELETE-by-subquery + chunked INSERT +
  per-doc batch)。送出は `toD1BatchStatements` +
  `createD1HttpBatchSender`。失敗 = D1 error-JSON throw で batch 全体
  no-op (既存 json-error mechanism・再送なし)。
- 既定 preflight (送信 0・network 0)。`--live` でのみ D1 へ送る。

## CAS 設計 (concrete・review 用)

- guard は DELETE/UPDATE の WHERE に一度だけ埋め込む: doc16 全列 +
  Q2 echo (business 11 列・NULL-safe `IS`・順序不問 exact-set) +
  `COUNT(*)=N`。bind worst 67/100 (7 行通)。
- DELETE 後に OLD Q2 guard を再評価しない。INSERT に OLD-state
  guard を付けない (post-DELETE で 0 行化し partial no-op を招く
  ため — Root 指摘の禁止 pattern)。代わり: unique
  (doc/period/region) + batch 原子性 + post-read 検証。
- numeric 競合: INSERT unique 違反 → batch atomic no-op → HOLD。
  unknown 競合: DELETE 0 行 + UPDATE の post-zero 断定で 0 行 →
  成功・無変更 → post-read で HOLD 確定 (new-state 断定であり
  OLD guard 再評価ではない)。
- 文: numeric [DELETE, INSERT×1, UPDATE]・unknown [DELETE, UPDATE]。
  44 通で write 100 (DELETE 44 + INSERT 12 + UPDATE 44) ≤ 提案
  cap 119。read 176 (pre/post full16+Q2)。order/text 非接触。
  Notion/R2/dispatch 0。MATCH 15 は対象外。
- post 判定 3 値: APPLIED / NOOP_PRESTATE (HOLD) / MISMATCH
  (ABORT・手動確認・自動再実行なし)。

## Preflight 結果 (PASS・sends 0)

- packet `c7c0b56f…f3dd` (322234 bytes) + module pins 5/5 照合。
- 44 通全 batch 組立: statements 100・maxBinds 67・決定性再現
  (statements SHA `7a37aac8…da4bf2` 2 回一致)。
- archive (0600): 44 通 batch.json (full SQL + expected post) +
  summary。stdout は counts/pins/SHA のみ。
- L2 plan: 10 stocks 1 group (≤97・packet 実 distinct と照合)。
  L2 実行は follow-up granted step (Worker 経路。Node 直接呼出の
  前例なし + Database 型が Worker 束縛のため本 executor は
  plan pin + applied-set 記録まで)。

## Live (未実行)

- per-doc: pre-read → JS prestate 照合 → batch → post-read 判定。
  HOLD (prestate/noop/batch-error) は skip 継続・輸送/unknown は
  ABORT。ledger.jsonl (append+fsync) + receipt.json (applied
  stocks + L2 plan) を 0600 で残す。
- 適用は Root review 後の別 grant。whole-apply 現状 0 のまま。

## Gates

- `npx tsc --noEmit` 0・eslint 2 files 0・vitest 8/8・
  `render-data-audit.ts --check` OK。live 0。
