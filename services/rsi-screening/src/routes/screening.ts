import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { screeningQuerySchema } from "../validators/screening.js";
import { screenStocks } from "../services/screening-service.js";
import { createDb } from "../db/client.js";

/** スクリーニングAPIルーター */
export const screeningRoute = new Hono();

screeningRoute.get("/", zValidator("query", screeningQuerySchema), async (c) => {
  const query = c.req.valid("query");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return c.json({ error: "DATABASE_URL is not configured" }, 500);
  }

  const db = createDb(databaseUrl);
  const results = await screenStocks(db, query);

  return c.json({
    query,
    count: results.length,
    results,
  });
});
