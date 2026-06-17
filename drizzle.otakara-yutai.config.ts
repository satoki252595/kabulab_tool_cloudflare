import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * 002 お宝優待 用の Drizzle 設定
 *
 * `public` スキーマ (デフォルト) のみを扱う。優待ジャンル・銘柄・優待情報・
 * 株価財務スナップショット・スコアリング結果など。
 *
 * 実行例:
 *   pnpm db:push:otakara      # スキーマを Neon に push
 *   pnpm db:generate:otakara  # マイグレーションファイル生成
 *   pnpm db:studio:otakara    # Drizzle Studio 起動
 */
export default defineConfig({
  schema: "./services/otakara-yutai/src/db/schema.ts",
  out: "./services/otakara-yutai/drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
