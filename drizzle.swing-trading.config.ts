import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * 003 Swing Trading 用の Drizzle 設定
 *
 * `core` スキーマ (kabulab 共通の銘柄マスタ) は 001 が所有するので、
 * 003 からは **読み取り専用で参照** するのみ。この設定ファイルの
 * `schemaFilter` には core を含めるが、実際には drizzle-kit push 時に
 * 001 と同じ core 定義を再宣言しているだけなので、push しても差分は発生しない
 * (同一 CREATE TABLE IF NOT EXISTS になる)。
 *
 * 固有スキーマは `swing` に全て閉じ込める (6 テーブル)。
 *
 * 実行例:
 *   pnpm db:push:swing      # swing スキーマを Neon に push
 *   pnpm db:generate:swing  # マイグレーションファイル生成
 *   pnpm db:studio:swing    # Drizzle Studio 起動
 */
export default defineConfig({
  schema: [
    "./services/swing-trading/src/db/core-schema.ts",
    "./services/swing-trading/src/db/schema.ts",
  ],
  out: "./services/swing-trading/drizzle",
  dialect: "postgresql",
  schemaFilter: ["core", "swing"],
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // strict: true は TTY を要求するため CLI から非対話で push できない。
  // swing.* への新規追加のみなのでデータ損失リスクは無く、false で OK。
  strict: false,
  verbose: true,
});
