import { createMiddleware } from "hono/factory";
import { createDb, type Database } from "../db/client.js";

/**
 * DBクライアントをContextに設定するミドルウェア
 * ルートハンドラーで c.get("db") を通じてアクセス可能にする
 */
export const dbMiddleware = createMiddleware<{
  Bindings: { DATABASE_URL: string };
  Variables: { db: Database };
}>(async (c, next) => {
  const databaseUrl = c.env?.DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }
  const db = createDb(databaseUrl);
  c.set("db", db);
  await next();
});
