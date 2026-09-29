# run-spec 保管検証 + 観測 readback 検証（2026-09-30）

## 変更の要点

- `scripts/moneyflow/lib/run-spec.ts` 未保管経路：`recordPrimaryData` 直後に
  `fileTooLarge` なら観測ログを書かず停止。続けて保管ページの Files 添付を
  `verifyArchivedAttachments`（新規、`archived-files.ts`）で検証する。
  検証内容は件数・名前・バイト長・SHA256 の完全一致（`listPageFiles` +
  `downloadArchivedFile` 再利用）。不一致は解析・書込の前に保全停止。
- `src/shared/notion-archive/moneyflow.ts` に `verifyObservedBatch`（新規、
  read-only）を追加。新規・更新が 1 行でもある書込バッチは、指標×期間の
  分割クエリで全期待キーを新規読取し、ページ ID と既存
  `observationRowMatches` 全項目照合で確認する。重複・欠落・不一致・
  不正カーソル・ページ上限超過は保全停止。全行 unchanged の再実行は
  upsert 照合済みのため呼ばない。`runSpec` の唯一の本番 caller は
  `scripts/moneyflow/ingest.ts` `runSource`（失敗は取込ログへ集計・非0終了。
  sector 系 phase-1 runner は対象外、変更なし）。

## 検証（nix、外部書込なし）

- `nix develop -c npx vitest run scripts/moneyflow/lib/run-spec.test.ts scripts/moneyflow/lib/archived-files.test.ts src/shared/notion-archive/moneyflow.test.ts`
  → 3 files / 63 tests passed（新規 10 件含む：file_too_large 停止・
  保管検証失敗の書込前停止・readback 呼出/非呼出・添付一致/件数不一致/
  SHA256 不一致/外部添付拒否・一括 readback/ページ送り/不一致5種停止）
- `nix develop -c npm test` → 221 files / 3526 passed / 281 skipped / 0 failed
- `nix develop -c npm run typecheck` → exit 0
- `nix develop -c npm run lint` → exit 0
- 実 Notion/R2/取得元への書込・GET・#110 再実行なし（全て fetch モック）。
