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
  const results = await screenStocks(db, query);

  return c.json({
    query,
    count: results.length,
    results,
  });
});
