import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * 001 RSI Screening 用の Drizzle 設定
 *
 * `core` スキーマ (kabulab 共通の銘柄マスタ・株価・財務) と
 * `rsi` スキーマ (RSI 履歴・パーセンタイル) を扱う。
 *
 * 実行例:
 *   pnpm db:push:rsi      # スキーマを Neon に push
 *   pnpm db:generate:rsi  # マイグレーションファイル生成
 *   pnpm db:studio:rsi    # Drizzle Studio 起動
 */
export default defineConfig({
  schema: [
    "./services/rsi-screening/src/db/core-schema.ts",
    "./services/rsi-screening/src/db/schema.ts",
  ],
  out: "./services/rsi-screening/drizzle",
  dialect: "postgresql",
  schemaFilter: ["core", "rsi"],
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  strict: true,
  verbose: true,
});
