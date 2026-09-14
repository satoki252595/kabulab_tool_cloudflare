# CI が見ていない範囲（typecheck / lint の死角）

`pnpm typecheck` (`tsc --noEmit`) と `pnpm lint` (`eslint src services`) が
**構造上見ていない**ファイルの一覧。CI が緑でも下記は検査されていない。
2026-09-14 に借金残高ゼロを確認。以降の経緯は git 履歴。

## tsconfig の死角（残高ゼロ）

`exclude` は `node_modules` / `dist` のみ (実質なし)。ただし `include` 対象は
src・services・scripts・*.config.ts のみで **worker/・tests/ は tsc の対象外**。

## lint の死角（未解消）

| 範囲 | TS ファイル数 | 中身 |
|---|---|---|
| `scripts/**` | 12 | `sync:*` / `ingest:*` の実行本体 |
| `worker/**` | 1 | **本番エントリ `worker/entry.ts`** |
| `*.config.ts` | 数件 | `vitest.config.ts` / `drizzle.*.config.ts` |
| `tests/**` (root) | 数件 | root 直下のテスト |

`worker/entry.ts` は本番エントリなので優先的に対象へ入れるべき
(既存 warning 32 件〈2026-09-14 実測〉の扱いとセットで別途判断)。

> 新しい除外を足すときは規模と実行経路をここに必ず書くこと。
