# Yutai ABC 131/全文 13 の実再入 0 の offline 証明 (2026-09-30)

優待 ABC 修復 (131 銘柄)・全文修復 (13 銘柄) の適用後に同一入力を再入
しても効果文が出ないことを、保存済み証跡のみで offline 証明した記録。
結論: **ABC 473 行全省略・全文 62 行全適用済み・効果文 0**。
normal C45 経路は pending/stale を正直計数し、0-writes の範囲を明示する。

## 1. 根因と共有 fix (本 PR のコード変更)

- 根因: 旧私用 generator が C 更新の出典 `estimateValueSource` を無条件
  null で割り当てた。共有 planner の同値判定は 3 値 (要約・推定値・出典)
  の厳密一致のため、null 出典行は company 要求と同値にならず pending
  として残る (正当。来歴を隠す弱体化はしない)。
- `planAtomicBatches`: preimage の 3 実値と完全一致する ID を省略する。
  preimage/ID の欠落は投げる。変更 ID・利回り・全 CAS は維持する。
  (ABC no-op に掲載文 description の比較は持ち込まない。全文だけが
  旧文/新文の一致を使う。)
- `buildDescriptionUpdateStatements`: 旧文と新文が同一の行を飛ばす。
- 新 `classifyDescriptionRepair`: 現文=新全文→`ALREADY_APPLIED`、
  現文=旧文→`CANDIDATE`、その他→`STOP`。
- 新 CLI `services/otakara-yutai/data-scripts/verify-repair-reentry.ts`:
  実 builder/planner を再利用し、送信口は throw-if-called。
  効果文が残れば送信経路で落とす (dry-run や gate STOP による
  見せかけの 0 を作らない)。

## 2. 結果 (offline。live D1/Notion/R2/source GET なし)

| 証明 | 結果 |
| --- | --- |
| A: normal C45 実 planner | 45 タスク = pending 28 (38 行・全行出典のみ差) + skipped 8 + stale 9 (全文起因・12 行) + 未回答 0。pending+stale=37 は live cUpdates と一致、出典差 38+12=50。0-writes は equivalent 8 の範囲のみ |
| B: legacy ABC shared 原子同値化 | 131 銘柄・filed 264 文・473 一意 ID (重複・衝突・null 要約 0)。per-ID 省略 473/473、優待文 0、利回り変化 0、スコア変化 0、欠落 0 |
| C: 全文 62 行分類再入 | 適用済み 62/62、未適用 0、STOP 0、文 0 (旧≠新の実変化 62 を確認のうえ。builder なら 62 文出る) |

- filed 内訳の再検算: 131 preflight + 264 優待 + 61 利回り + 52 スコア = 508。
  利回り・スコア文の params は yield entry の next と一致。
- v3 独立 snapshot と manifest preimage の全 1557 行一致 (7 列)。
- row-manifest 349 行の provenance SHA は upstream 実ファイル 68 件と
  manifest-34 記録の両方と一致。
- 送信: throw-if-called sender を通過する効果文なし (0 writes)。

入力 pin (SHA256):

- `yutai-abc-manifest.json`: `f3586e6f…135379fe`
- `yutai-fulltext-manifest.postabc.json`: `e90e3235…d9a1b43e`
- `yutai-row-manifest.json`: `23638f8d…f40403dbd0`
- `yutai-before-inventory.v3.json`: `1a8cfabe…051f1f25b`
- `yutai-ftbefore-inventory.v1.json`: `15d30dc2…4417ce779`
- `abc-apply-post.json`: `8e5b987e…3484e2d4`
- `ft-apply-post.json`: `c466ea90…0530610d22`
- `manifest-34.json`: `be5996c0…2aa69cc`

## 3. 限界 (未証明・範囲外)

- 本証明は保存済み preimage による offline 再現。live D1 との照合は
  Root 承認の query 計画・範囲・件数上限のもとで後続実施する。
- aDrift 412 は filed 数の算術 (18+412=430) と「post 差分は planned
  473 の範囲内」を検証。旧 A snapshot の行単位の再導出は pin 入力に
  含まれないため live フェーズの範囲とする。412 を新規変化とは扱わない。
- post 模擬は 3 値のみ適用し `updated_at` は模擬しない (比較列の対象外)。
- 証跡全文は私的 0600 保管 (`/tmp/yutai-reentry-20260930/evidence.json`)。
  公開 doc は件数・SHA・HEAD のみ。
