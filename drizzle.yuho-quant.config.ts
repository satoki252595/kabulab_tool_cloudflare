import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * 005 yuho-quant 用の Drizzle 設定。
 *
 * 銘柄マスタ `core` は 001 が所有するため、ここでは rsi-screening の
 * core-schema を読み取り参照するだけ (再宣言しない)。固有スキーマは
 * `yuho_quant` に閉じる (documents / order_facts)。
 *
 * 実 DB 反映は手書き SQL を node scripts/db/apply-migration.mjs で適用済み
 * (drizzle/create-yuho-quant.sql)。本設定は型生成 / studio / 差分確認用。
 *
 *   pnpm db:push:yuho      # yuho_quant スキーマを Neon に push
 *   pnpm db:generate:yuho  # マイグレーション生成
 *   pnpm db:studio:yuho    # Drizzle Studio 起動
 */
export default defineConfig({
  schema: [
    "./services/rsi-screening/src/db/core-schema.ts",
    "./services/yuho-quant/src/db/schema.ts",
  ],
  out: "./services/yuho-quant/drizzle",
  dialect: "postgresql",
  schemaFilter: ["core", "yuho_quant"],
  dbCredentials: { url: process.env.DATABASE_URL! },
  strict: false,
  verbose: true,
});
