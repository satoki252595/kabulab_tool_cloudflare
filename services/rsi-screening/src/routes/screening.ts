import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { screeningQuerySchema } from "../validators/screening.js";
import { screenStocks } from "../services/screening-service.js";
import { createDb } from "../db/client.js";

/** スクリーニングAPIルーター */
type Bindings = { DB: D1Database };
export const screeningRoute = new Hono<{ Bindings: Bindings }>();

screeningRoute.get("/", zValidator("query", screeningQuerySchema), async (c) => {
  const query = c.req.valid("query");
  const db = createDb(c.env.DB);
  const { rows, staleExcluded, maxAgeDays } = await screenStocks(db, query);

  // 鮮度で落とした件数も返す。API 利用側が「0 件」と「古い行しか無い」を
  // 区別できないと、上流の同期停止に気づけない。
  return c.json({
    query,
    count: rows.length,
    staleExcluded,
    freshnessMaxAgeDays: maxAgeDays,
    results: rows,
  });
});
