import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * 006 ir-catalog 用の Drizzle 設定。
 *
 * 銘柄マスタ `core` は 001 が所有するため、ここでは rsi-screening の
 * core-schema を読み取り参照するだけ (再宣言しない)。固有スキーマは
 * `ir_catalog` に閉じる (disclosures)。
 *
 * 実 DB 反映は手書き SQL を node scripts/db/apply-migration.mjs で適用する
 * (drizzle/create-ir-catalog.sql)。本設定は型生成 / studio / 差分確認用。
 *
 *   pnpm db:push:ircat      # ir_catalog スキーマを Neon に push
 *   pnpm db:generate:ircat  # マイグレーション生成
 *   pnpm db:studio:ircat    # Drizzle Studio 起動
 */
export default defineConfig({
  schema: [
    "./services/rsi-screening/src/db/core-schema.ts",
    "./services/ir-catalog/src/db/schema.ts",
  ],
  out: "./services/ir-catalog/drizzle",
  dialect: "postgresql",
  schemaFilter: ["core", "ir_catalog"],
  dbCredentials: { url: process.env.DATABASE_URL! },
  strict: false,
  verbose: true,
});
