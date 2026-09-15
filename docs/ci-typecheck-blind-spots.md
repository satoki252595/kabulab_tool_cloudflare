# CI が見ていない範囲（typecheck / lint の死角）

`pnpm typecheck` (`tsc --noEmit`) と `pnpm lint` (`eslint src services`) が
**構造上見ていない**ファイルの一覧。CI が緑でも下記は検査されていない。
2026-09-14 に借金残高ゼロを確認。以降の経緯は git 履歴。

## tsconfig の死角（残高ゼロ）

`exclude` は `node_modules` / `dist` のみ (実質なし)。ただし `include` 対象は
src・services・scripts・*.config.ts のみで **worker/・tests/ は tsc の対象外**。

## 委譲（死角ではない）: services/jss-api/**

stockStock 一本化 (PR-1) で移設した配信 Worker。独自 `pnpm-lock.yaml`・
独自 `tsconfig.json` (`types: ["@cloudflare/workers-types"]`)・独自
`vitest.config.ts` (vitest 2) を持つ standalone で、ルートの設定では検査できない:

- ルート tsc (DOM lib・`types: ["node", "vitest/globals"]`) では `R2Bucket` 等の
  workers 型が解決できず誤検出が出る → `tsconfig.json` の `exclude` に
  `services/jss-api/**/*` を追加（PR-1 で実測）。
- ルート vitest 4 で走らせると、jss-api のテストが vitest 2 系の解決と混ざる
  （二重実行にもなる）→ `vitest.config.ts` の `exclude` に追加。
- `pnpm lint` (`eslint src services`) は jss-api 配下も対象のまま
  （2026-09-15 実測で error 0 のため。 warning のみ）。

死角にしない条件: `services/jss-api` 自身の `pnpm typecheck` と `pnpm test` を
CI の `python-pipeline` ジョブで回す（PR-2 で配線）。jss-api 側の
`tsconfig.json` の `include` (`src/**/*.ts`・`test/**/*.ts`) が新規ファイルも
自動で拾うため、ディレクトリ単位の委譲でも将来のファイルは検査される。
上記 CI 配線を外す変更は、この節を死角として格上げすること。

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
