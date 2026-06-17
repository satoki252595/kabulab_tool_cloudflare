import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { stockCodeParamSchema } from "../validators/screening.js";
import { getStockDetail } from "../services/stock-detail-service.js";
import { createDb } from "../db/client.js";

/** 銘柄詳細APIルーター */
export const stocksRoute = new Hono();

stocksRoute.get("/:code", zValidator("param", stockCodeParamSchema), async (c) => {
  const { code } = c.req.valid("param");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    return c.json({ error: "DATABASE_URL is not configured" }, 500);
  }

  const db = createDb(databaseUrl);
  const detail = await getStockDetail(db, code);

  if (!detail) {
    return c.json({ error: "銘柄が見つかりません" }, 404);
  }

  return c.json(detail);
});
