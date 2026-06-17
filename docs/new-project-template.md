# 新サービス追加テンプレート

**kabulab** mono-repo に新しいサービスを追加する際のガイド。デザインシステムは [overview.md](./overview.md) の「デザインシステム」セクションを参照し、必ず Editorial Swiss Grid を踏襲すること。

## 0. 前提

kabulab は **単一の Vercel プロジェクト** (`kabulab`) に複数のサービスを Hono サブアプリとしてマウントする mono-repo 構成。既存サービスと依存関係 (Hono / Drizzle / Neon / Zod 等) を共有し、root の単一 `package.json` で全てを管理する。新サービス追加時は依存関係の追加は基本的に不要。

**sync は統一 3 コマンド** (`sync:universe` / `sync:daily` / `sync:monthly`) に集約されている。母集団は `core.stocks` = 全 JPX 上場内国株 ~4,000 (`sync:universe` が JPX XLS から seed、月次 cron Phase 1 にも内包)。新サービスが日次/月次のデータ取得を必要とする場合、独自の sync を書かずに [src/cron/daily.ts](../src/cron/daily.ts) / [src/cron/monthly.ts](../src/cron/monthly.ts) に統合する (本ドキュメント §9 参照)。`core.stocks.is_yutai` は 002 otakara 専用フラグなので、他サービスは全 active を対象にしてよい。

## 1. サービスフォルダの作成

```bash
cd /Users/satoki252595/projects/kabulab_tool
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

## 3. DB スキーマ (Drizzle)

### 共有スキーマを使う場合

日次 sync が `core` スキーマを更新している。新サービスはそれを **読み取り専用** で参照する。

```ts
// services/<slug>/src/db/core-schema.ts
// 既存の services/rsi-screening/src/db/core-schema.ts からコピーして利用
// または import で参照: `import { stocks } from "../../../rsi-screening/src/db/core-schema.js"`
```

### 固有スキーマを定義

```ts
// services/<slug>/src/db/schema.ts
import { pgSchema, serial, integer, real, timestamp } from "drizzle-orm/pg-core";
import { stocks } from "./core-schema.js";

export const mySchema = pgSchema("<slug_underscore>");

export const myProjectData = mySchema.table("my_table", {
  id: serial("id").primaryKey(),
  stockId: integer("stock_id").references(() => stocks.id, { onDelete: "cascade" }).notNull(),
  // ... プロジェクト固有カラム
});
```

### Drizzle 設定 (root)

`drizzle.<slug>.config.ts` を root に追加:

```ts
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./services/<slug>/src/db/core-schema.ts",
    "./services/<slug>/src/db/schema.ts",
  ],
  out: "./services/<slug>/drizzle",
  dialect: "postgresql",
  schemaFilter: ["core", "<slug_underscore>"],
  dbCredentials: { url: process.env.DATABASE_URL! },
  strict: true,
  verbose: true,
});
```

`package.json` に対応スクリプトを追加:

```json
"db:push:<slug>": "drizzle-kit push --config=drizzle.<slug>.config.ts",
"db:generate:<slug>": "drizzle-kit generate --config=drizzle.<slug>.config.ts",
"db:studio:<slug>": "drizzle-kit studio --config=drizzle.<slug>.config.ts"
```

## 4. Hono サブアプリ

### `services/<slug>/src/index.ts`

Hono アプリ本体。**`strict: false`** を必ず指定 (trailing slash 吸収)。

```ts
import { Hono } from "hono";
import { errorHandler } from "./middleware/error-handler.js";
import { pagesRoute } from "./routes/pages.js";

export const app = new Hono({ strict: false });

app.route("/api/...", apiRoute);  // 必要に応じて
app.route("/", pagesRoute);
app.onError(errorHandler);

export default app;
```

### `services/<slug>/app.ts`

サブアプリの公開エントリ。BASE_PATH と app を export する。

```ts
import app from "./src/index.js";

export { BASE_PATH } from "./base-path.js";
export const <slug>App = app;
export default app;
```

## 5. ビュー (重要 — JSX は使えない)

**Vercel `@vercel/node` は `.tsx` ファイルを bundle しない** ため、ビューは JSX を使わず template literal を返す `.ts` 関数として実装する。001 / 003 の `src/views/` を参考にする。

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

`public/<slug>/` 配下に置けば Vercel が同一オリジンで配信する。`manifest.json` の `start_url` と `scope` は `/<slug>/` にする:

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

## 8. 認証 (cron などを自分で持つ場合)

もし本当に独自の認証エンドポイントを持つなら、共通認証を使う:

```ts
import { cronAuthMiddleware } from "../../../src/shared/auth.js";
app.get("/api/some-protected", cronAuthMiddleware, async (c) => { ... });
```

ただし **cron 新規登録は原則禁止** (§9 参照)。

## 9. データ同期 — 統一 cron に相乗り

**サービス独自の `sync-daily` / `sync-monthly` は作らない**。2026-04 の refactor で、日次/月次 sync は root の [src/cron/daily.ts](../src/cron/daily.ts) / [src/cron/monthly.ts](../src/cron/monthly.ts) に一本化された。2026-05 に母集団を全 JPX 内国株 ~4,000 へ拡張し、母集団 seed の [src/cron/universe.ts](../src/cron/universe.ts) (`sync:universe`) を追加。日次 cron は ~4,000 を Vercel タイムアウト内に収めるため 8 シャード分割実行 (Vercel Pro 前提)。

### 新サービスが日次データを必要とする場合

[src/cron/daily.ts](../src/cron/daily.ts) の `StockSnapshot` 型と `buildSnapshot()` にフィールドを追加し、`writeStockSnapshot()` で自分のテーブルに upsert する。Yahoo は 1 銘柄につき `fetchStockRawData(code, "5y")` が Chart + QuoteSummary を並列取得しているので、追加フェッチは不要。in-memory の OHLCV / 指標から自分が欲しい値を計算するだけで済む。

### 新サービスが月次データを必要とする場合

[src/cron/monthly.ts](../src/cron/monthly.ts) に Phase を追加。Yahoo を追加で叩かないこと (DB からの集計で足りるはず)。

### それ以外のバッチが必要な場合

`scripts/db/*.mjs` として手動実行スクリプトに閉じる (cron には登録しない)。

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
- [ ] `https://kabulab.vercel.app/<slug>/` が 200 を返す
- [ ] `https://kabulab.vercel.app/<slug>` (slash なし) も 200
- [ ] ヘッダーの `← KABULAB` リンクが `/` に遷移する
- [ ] ロゴサブタイトルが `NNN / KABULAB` 形式
- [ ] フォント Space Grotesk / JetBrains Mono / Noto Sans JP が読み込まれている
- [ ] CSS 変数 `--bg: #fafafa`、`--text: #0a0a0a`、`--border: #0a0a0a` が定義されている
- [ ] カードホバーで黒い 5px 影が出る
- [ ] モバイルで bottom-nav に PORTAL ボタンがある (`/` に遷移)
- [ ] ポータル `/` の SERVICES グリッドに新サービスのカードが表示されている
- [ ] 同一タブで遷移する (sub-path なので `target="_blank"` 不要)
- [ ] (該当時) `pnpm db:push:<slug>` で Neon にスキーマが作成された
- [ ] (該当時) `src/cron/daily.ts` or `monthly.ts` に新サービス用の書き込みを統合済み
- [ ] (該当時) `pnpm sync:universe` で母集団を seed 後、`pnpm sync:daily` / `pnpm sync:monthly` を手動実行してデータが入ることを確認
