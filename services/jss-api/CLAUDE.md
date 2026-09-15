# jss-api — 配信 Worker (standalone)

正本（R2 + D1）を REST と MCP で読むための Cloudflare Worker。**読み取り専用**
（唯一の例外は内部面の鮮度 upsert）。詳細は [README.md](./README.md)。

## このサービス固有の絶対ルール (mono-repo CLAUDE.md に追加)

### standalone を保つ — ルートの設定に相乗りしない

jss-api は独自 `pnpm-lock.yaml`・独自 `tsconfig.json`・独自
`vitest.config.ts` を持つ独立プロジェクト。ルートの `tsc` / `vitest` からは
委譲除外されている（`tsconfig.json`・`vitest.config.ts` のコメントと
`docs/ci-typecheck-blind-spots.md` の「委譲」節を参照）。依存の追加・更新は
このディレクトリ内で完結させ、ルートの lock と混ぜない。

### `@types/node` のピンは決定的解決のため

`test/*.test.ts` が `node:fs` / `node:url` を明示 import するため、
`@types/node` を devDependencies にピンしている。ピンが無いと `tsc` が
リポジトリルートの `@types/node`（メジャー違い）まで遡って解決し、
`URL` の型不一致で誤検出が出る。vitest が解決する版と同一
（現行 `22.20.2`）に揃えること。更新時は `pnpm typecheck` を
ルート `node_modules` ありの状態で確認する。

### 契約ファイルはリポジトリ直下の正本を読む

`test/*-contract.test.ts` は `../../../tests/fixtures/contracts/*.json`
（直下の正本）を相対参照する。複製を作らない。

### 公開面の bind を増やさない

`wrangler.public.jsonc` に `jp-stock-supply` / `vwap-data` を bind しない
（personal-only への物理的到達不能が第0層の防御）。
`test/bindings.test.ts` が設定ファイルごと固定している。

## 技術スタック

- Runtime: Cloudflare Workers × 2 (`jss-api-public` / `jss-api-private`)
- Framework: Hono v4（旧ピン維持。wrangler 3 / vitest 2 / hono 4.6 系の
  更新は一本化と別件として扱う）
- Language: TypeScript (strict、独自 tsconfig)
- Test: vitest (`test/**/*.test.ts`)

## よく使うコマンド（このディレクトリで）

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test
pnpm deploy:public   # 公開 REST
pnpm deploy:private  # 内部 REST + MCP（要 JSS_API_KEYS）
```
