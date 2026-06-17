import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * 004 Financial Math 用の Drizzle 設定
 *
 * `finmath` スキーマ (このサービス所有) のみ。
 * core / swing は読み取りで参照するだけなのでこの config では扱わない。
 *
 * 実行例:
 *   pnpm db:push:finmath      # スキーマを Neon に push
 *   pnpm db:generate:finmath  # マイグレーションファイル生成
 *   pnpm db:studio:finmath    # Drizzle Studio 起動
 */
export default defineConfig({
  schema: ["./services/financial-math/src/db/finmath-schema.ts"],
  out: "./services/financial-math/drizzle",
  dialect: "postgresql",
  schemaFilter: ["finmath"],
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  strict: true,
  verbose: true,
});
