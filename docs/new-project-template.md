# 新サービス追加テンプレート

**kabulab** mono-repo に新しいサービスを追加する際のガイド。デザインシステムは [overview.md](./overview.md) の「デザインシステム」セクションを参照し、必ず Editorial Swiss Grid を踏襲すること。

## 0. 前提

kabulab は **単一の Cloudflare Workers プロジェクト** (`kabulab-cf`) に複数のサービスを Hono サブアプリとしてマウントする mono-repo 構成。既存サービスと依存関係 (Hono / Drizzle (`drizzle-orm/d1` + `sqlite-core`) / Zod 等) を共有し、root の単一 `package.json` で全てを管理する。新サービス追加時は依存関係の追加は基本的に不要。

DB は **Cloudflare D1 (SQLite)** の単一 DB `kabulab-cf`。名前空間が無いため、全サービスを **接頭辞テーブル** (`core_*` / `<slug>_*`) で同居させる。Worker からは `c.env.DB` バインディング経由で読み取る。

**定常 sync は統一 3 コマンド** (`sync:universe` / `sync:daily:core` / `sync:monthly:core`) に集約されている。`:core` なしの daily/monthly は追加取込も束ねるローカル手動フル実行。母集団は `core_stocks` = 東証プライム／スタンダード／グロースの内国株式（共有4文字コード、約3,700）で、`sync:universe` が JPX XLS から seed する。月次ワークフローは universe の後に rebuild を実行する。新サービスが日次/月次のデータ取得を必要とする場合、独自の sync を書かずに [src/cron/daily.ts](../src/cron/daily.ts) / [src/cron/monthly.ts](../src/cron/monthly.ts) に統合する (本ドキュメント §9 参照)。`core_stocks.is_yutai` は 002 otakara 専用フラグなので、他サービスは全 active を対象にしてよい。

## 1. サービスフォルダの作成

```bash
cd /Users/satoki252595/projects/kabulab-cf
mkdir -p services/<slug>/src/{db,routes,services,validators,views,tests}
```

`<slug>` は URL に出る名前 (`rsi-screening`, `otakara-yutai`, `swing-trading` など)。

## 2. BASE_PATH 定数

`services/<slug>/base-path.ts`:

```ts
/**
 * <slug> のマウントパス。すべての HTML リンク・form action・JS ナビゲーションは
 * この値を必ず前置すること。cron は root app に集約しているので BASE_PATH を経由しない。
 */
export const BASE_PATH = "/<slug>";
```

## 3. DB スキーマ (Drizzle + D1 / sqlite-core)

DB は単一の Cloudflare D1 `kabulab-cf`。名前空間が無いため旧 PG スキーマ名 (core / public / swing 等) の概念は廃止し、**接頭辞テーブル** (`core_*` / `<slug>_*`) で同居させる。スキーマは `drizzle-orm/sqlite-core` で定義する。

### 共有スキーマを使う場合

共有 core は単一正本の [src/shared/db/core-schema.ts](../src/shared/db/core-schema.ts) (`core_stocks` / `core_stock_financials` / `core_stock_annual_financials`)。新サービスはそれを **読み取り専用** で参照し、再宣言しない。

```ts
// services/<slug>/src/db/schema.ts で import するだけ
import { stocks } from "../../../../src/shared/db/core-schema.js";
```

### 固有スキーマを定義

テーブル名は必ず `<slug 由来の接頭辞>_` を付ける (例: 005 `yuho_documents`、006 `ir_disclosures`)。PG → SQLite の方言マッピングは core-schema.ts の冒頭コメントを参照 (`serial` → `integer autoIncrement` / `timestamp(tz)` → `integer({mode:'timestamp'})` / `date` → `text` / `boolean` → `integer({mode:'boolean'})`)。

```ts
// services/<slug>/src/db/schema.ts
import { sqliteTable, integer, real, text } from "drizzle-orm/sqlite-core";
import { stocks } from "../../../../src/shared/db/core-schema.js";

export const myProjectData = sqliteTable("<prefix>_my_table", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  stockId: integer("stock_id").references(() => stocks.id, { onDelete: "cascade" }).notNull(),
  // ... プロジェクト固有カラム
});
```

### DB クライアント

各サービスは共有ファクトリ [src/shared/db/client.ts](../src/shared/db/client.ts) の `createServiceDb` を薄くラップするだけ。core は内部で必ず混ざる。

```ts
// services/<slug>/src/db/client.ts
import * as schema from "./schema.js";
import { createServiceDb } from "../../../../src/shared/db/client.js";

/** Worker バインディング `c.env.DB`（または取込の env.DB）を渡す。 */
export function createDb(d1: D1Database) {
  return createServiceDb(d1, schema);
}

export type Database = ReturnType<typeof createDb>;
```

### Drizzle 設定 (root) とスキーマ反映

新サービスの sqlite スキーマは、サービスごとの config を作らず **共通の [drizzle.d1.config.ts](../drizzle.d1.config.ts)** の `schema` 配列へ追記する (dialect は `sqlite` 固定、`out` は `./drizzle/d1`)。

```ts
// drizzle.d1.config.ts の schema 配列に1行追加
"./services/<slug>/src/db/schema.ts",
```

スキーマの生成・反映は 2 段階:

```bash
pnpm db:generate:d1                                              # drizzle/d1/*.sql を生成
wrangler d1 execute kabulab-cf --remote --file=drizzle/d1/<n>.sql  # D1 へ反映
```

> ❌ `db:push:<slug>` / サービス別 `drizzle.<slug>.config.ts` (dialect=postgresql) は obsolete。新サービスでは作らない。

## 4. Hono サブアプリ

### `services/<slug>/src/index.ts`

Hono アプリ本体。**`strict: false`** を必ず指定 (trailing slash 吸収)。

```ts
import { Hono } from "hono";
import { createErrorHandler } from "../../../src/shared/error-handler.js";
import { pagesRoute } from "./routes/pages.js";

export const app = new Hono({ strict: false });
const errorHandler = createErrorHandler("<slug>");

app.route("/api/...", apiRoute);  // 必要に応じて
app.route("/", pagesRoute);
app.onError(errorHandler);

export default app;
```

> エラーハンドラはサービス内に作らず、共有の `createErrorHandler()` を使う
> (K4c-1 で一本化。各サービスの `src/middleware/error-handler.ts` は削除済み)。

### `services/<slug>/app.ts`

サブアプリの公開エントリ。BASE_PATH と app を export する。

```ts
import app from "./src/index.js";

export { BASE_PATH } from "./base-path.js";
export const <slug>App = app;
export default app;
```

## 5. ビュー (重要 — JSX は使わない)

ビューは JSX を使わず template literal を返す `.ts` 関数として実装する (mono-repo の方針。Workers/esbuild バンドルでも template literal を踏襲する)。001 / 003 の `src/views/` を参考にする。

```ts
// services/<slug>/src/views/layout.ts
import { BASE_PATH } from "../../base-path.js";

export function h(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function layout(title: string, body: string, activeNav?: string): string {
  return `<!DOCTYPE html>...
    <a href="${BASE_PATH}/">HOME</a>
    <a href="${BASE_PATH}/screening">SCREENING</a>
    <a href="/" class="portal-back">← KABULAB</a>
    ...`;
}
```

## 6. ルート Hono アプリへのマウント

`src/index.ts` を編集:

```ts
import { <slug>App, BASE_PATH as <SLUG>_BASE_PATH } from "../services/<slug>/app.js";

// SERVICES 配列に追加
const SERVICES: Service[] = [
  // ...
  {
    num: "NNN",
    slug: "<slug>",
    title: "サービス名",
    subtitle: "短いキャッチコピー",
    desc: "サービスの説明文。",
    features: ["FEAT A", "FEAT B"],
    url: `${<SLUG>_BASE_PATH}/`,
    status: "live",
  },
];

// マウント (ファイル末尾、既存の app.route 群に追加)
app.route(<SLUG>_BASE_PATH, <slug>App);
```

## 7. 静的アセット (PWA など)

`public/<slug>/` 配下に置けば Cloudflare Workers の静的アセット (`wrangler.toml` の `[assets]` = `ASSETS` バインディング) が同一オリジンで配信する。`manifest.json` の `start_url` と `scope` は `/<slug>/` にする:

```json
{
  "start_url": "/<slug>/",
  "scope": "/<slug>/",
  "icons": [
    { "src": "/<slug>/icon-192.png", "sizes": "192x192", "type": "image/png" }
  ]
}
```

Service Worker のキャッシュ範囲も `/<slug>/` に閉じること。

## 8. 認証 (取込ルートなどを自分で持つ場合)

もし本当に独自の認証取込エンドポイント (例: 005/006 の `/admin/catchup`) を持つなら、共通認証を使う:

```ts
import { cronAuthMiddleware } from "../../../src/shared/auth.js";
app.get("/api/some-protected", cronAuthMiddleware, async (c) => { ... });
```

ただし **独自の自動取込ジョブの新規追加は原則禁止** (§9 参照)。

## 9. データ同期 — 統一パイプラインに相乗り

**サービス独自の `sync-daily` / `sync-monthly` は作らない**。日次/月次 sync は root の [src/cron/daily.ts](../src/cron/daily.ts) / [src/cron/monthly.ts](../src/cron/monthly.ts) に実装が一本化され、母集団 seed は [src/cron/universe.ts](../src/cron/universe.ts) (`sync:universe`) にある。母集団は東証内国普通株の共有4文字コード約3,700銘柄 (xlsx パースは Node 専用)。地域市場の単独上場銘柄を追加する場合は、市場マスターと対応プロバイダーを別途設計し、`.T` への一律変換や suffix 推測は行わない。

自動実行は **GitHub Actions (Node)** が担う ([.github/workflows/stock-sync.yml](../.github/workflows/stock-sync.yml) — 日次 core/rsi/swing + 月次 universe/otakara rebuild)。Workers Paid を使わないため **Workers Cron は使わない** (無料枠の subrequest 上限では Worker 上で全銘柄 sync を捌けない)。Node からの書込は [src/shared/db/d1-http-client.ts](../src/shared/db/d1-http-client.ts) の `createD1HttpDb` (D1 REST) 経由、Yahoo は共有クライアントが `YAHOO_PROXY_BASE` (Worker エッジ `/api/ingest/yahoo`) 経由で叩き 429 を回避する。手動実行・バックフィルは `pnpm sync:daily:core` / `pnpm sync:monthly:core` を使う。`:core` なしは VWAP や優待4工程も動かすローカル手動フル実行。

### 新サービスが日次データを必要とする場合

[src/cron/daily.ts](../src/cron/daily.ts) の `runDailySync()` 系に、自分のテーブルへの upsert を追加する。Yahoo は 1 銘柄につき Chart + QuoteSummary をまとめて取得しているので追加フェッチは不要。in-memory の OHLCV / 指標から自分が欲しい値を計算するだけで済む。

なお `writeStockSnapshot()` の ②断面 (`core_stock_financials`) だけは `options.writeCoreFinancials` (既定 true) で止められる。writer が外へ移る移行のためのスイッチなので、**新サービスは「日次 sync が必ず ②断面を書く」前提を置かないこと**（options は任意引数なので、追加する upsert 側の書き方は変わらない）。

### 新サービスが月次データを必要とする場合

[src/cron/monthly.ts](../src/cron/monthly.ts) の `runMonthlyRebuild()` に Phase を追加。Yahoo を追加で叩かないこと (DB からの集計で足りるはず)。

### それ以外のバッチが必要な場合

`scripts/` 配下の手動実行スクリプトに閉じる (自動取込ジョブには登録しない)。

## 10. デザインシステム適用（必須）

新サービスは **kabulab Editorial Swiss Grid** デザインを必ず踏襲する。

1. 共通デザイントークンは `src/shared/design.ts` から取り込む (`DESIGN_TOKENS`, `BASE_RESET`, `FONT_LINKS`)
2. サービス固有スタイルはサブアプリ内に閉じて連結
3. ヘッダーロゴは「**プロジェクト名（日本語）** + **NNN / KABULAB**（英字 mono サブタイトル）」
4. ヘッダー左端に `← KABULAB` リンクを必ず配置し、`/` (ポータル) へ同一タブ遷移
5. モバイル下部ナビには `HOME` / メイン機能 / `PORTAL`(`/`) を配置
6. セクションタイトルは `NNN / SECTION` 形式の section-label を併用
7. 角丸 4px、ボーダー 2px 黒、ホバーは `translate(-3px,-3px)` + `5px 5px 0 0 黒影` を遵守

## 11. デプロイ後チェックリスト

- [ ] `pnpm typecheck` / `pnpm test` / `pnpm lint` が通る
- [ ] デプロイ後 `/<slug>/` が 200 を返す (本番 Worker URL 配下)
- [ ] `/<slug>` (slash なし) も 200
- [ ] ヘッダーの `← KABULAB` リンクが `/` に遷移する
- [ ] ロゴサブタイトルが `NNN / KABULAB` 形式
- [ ] フォント Space Grotesk / JetBrains Mono / Noto Sans JP が読み込まれている
- [ ] CSS 変数 `--bg: #fafafa`、`--text: #0a0a0a`、`--border: #0a0a0a` が定義されている
- [ ] カードホバーで黒い 5px 影が出る
- [ ] モバイルで bottom-nav に PORTAL ボタンがある (`/` に遷移)
- [ ] ポータル `/` の SERVICES グリッドに新サービスのカードが表示されている
- [ ] 同一タブで遷移する (sub-path なので `target="_blank"` 不要)
- [ ] (該当時) `pnpm db:generate:d1` → `wrangler d1 execute kabulab-cf --remote --file=drizzle/d1/<n>.sql` で D1 にスキーマが作成された（**流す前に [drizzle/d1/README.md](../drizzle/d1/README.md) を読む**。本番へ流してはいけない生成物がある。`drizzle-kit push` は D1 では禁止）
- [ ] (該当時) `src/cron/daily.ts` or `monthly.ts` に新サービス用の書き込みを統合済み
- [ ] (該当時) `pnpm sync:universe` で母集団を seed 後、`pnpm sync:daily:core` / `pnpm sync:monthly:core` を手動実行してデータが入ることを確認
