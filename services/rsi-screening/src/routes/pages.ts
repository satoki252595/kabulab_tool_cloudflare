import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { count, eq, max } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { stocks, stockFinancials } from "../db/core-schema.js";
import { stockRsiPercentile } from "../db/schema.js";
import { screeningQuerySchema, stockCodeParamSchema } from "../validators/screening.js";
import { screenStocks } from "../services/screening-service.js";
import { getStockDetail } from "../services/stock-detail-service.js";
import { homePage } from "../views/home.js";
import { screeningPage } from "../views/screening.js";
import { stockDetailPage } from "../views/stock-detail.js";
import { BASE_PATH } from "../../base-path.js";

/** SSR ページルーター */
type Bindings = { DB: D1Database };
export const pagesRoute = new Hono<{ Bindings: Bindings }>();

pagesRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);

  const [{ total }] = await db
    .select({ total: count() })
    .from(stocks)
    .where(eq(stocks.isActive, true));

  const [{ blue }] = await db
    .select({ blue: count() })
    .from(stockRsiPercentile)
    .where(eq(stockRsiPercentile.isBlueChip, true));

  const [{ lastUpdate }] = await db
    .select({ lastUpdate: max(stockFinancials.dataDate) })
    .from(stockFinancials);

  return c.html(homePage({ totalStocks: total, blueChipCount: blue, lastUpdate }));
});

pagesRoute.get("/screening", zValidator("query", screeningQuerySchema), async (c) => {
  const query = c.req.valid("query");
  const db = createDb(c.env.DB);
  const results = await screenStocks(db, query);
  return c.html(screeningPage({ query, results }));
});

pagesRoute.get("/stocks/:code", zValidator("param", stockCodeParamSchema), async (c) => {
  const { code } = c.req.valid("param");
  const db = createDb(c.env.DB);
  const detail = await getStockDetail(db, code);
  if (!detail) {
    return c.html(
      `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>404 Not Found | RSI Screening</title></head><body style="background:#fafafa;color:#0a0a0a;text-align:center;padding:80px 24px;font-family:'Space Grotesk','Noto Sans JP',sans-serif">
        <div style="font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#737373;margin-bottom:16px">
          404 / NOT FOUND
        </div>
        <h1 style="font-size:48px;font-weight:700;letter-spacing:-0.03em;line-height:1">STOCK NOT FOUND.</h1>
        <p style="margin:24px 0 32px;color:#3a3a3a">該当する銘柄が見つかりませんでした。</p>
        <a href="${BASE_PATH}/screening" style="display:inline-block;font-family:'Space Grotesk',sans-serif;color:#fafafa;background:#0a0a0a;font-weight:700;font-size:14px;padding:14px 28px;border:2px solid #0a0a0a;border-radius:4px;text-decoration:none;text-transform:uppercase;letter-spacing:0.06em">
          → BACK TO SCREENING
        </a>
      </body></html>`,
      404
    );
  }
  return c.html(stockDetailPage({ detail }));
});
