import { defineConfig } from "drizzle-kit";

/**
 * Cloudflare D1(SQLite) スキーマ生成設定（ADR-0001）。
 *
 * Neon 用の各 drizzle.<service>.config.ts（dialect=postgresql）とは別に、D1 へ
 * 移行したサービスの sqlite-core スキーマをここへ集約する。D1 は 1 DB = 1 SQLite
 * のため、共有 core と各サービスを単一 DB に同居させ、接頭辞でテーブルを分ける。
 *
 *   pnpm exec drizzle-kit generate --config=drizzle.d1.config.ts   # SQL 生成
 *   wrangler d1 execute kabulab-cf --remote --file=drizzle/d1/<n>.sql  # 反映
 *
 * 移行が進むにつれ schema 配列へ各サービスの sqlite スキーマを追加していく。
 */
export default defineConfig({
  schema: [
    "./src/shared/db/core-schema.ts",
    "./services/yuho-quant/src/db/schema.ts",
    "./services/ir-catalog/src/db/schema.ts",
  ],
  out: "./drizzle/d1",
  dialect: "sqlite",
});
