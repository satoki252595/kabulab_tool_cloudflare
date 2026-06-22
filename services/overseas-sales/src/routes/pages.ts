import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { createDb } from "../db/client.js";
import { BASE_PATH } from "../../base-path.js";
import {
  searchStocks,
  getOverseasTrendByCode,
  screenOverseasGrowth,
  listSectorsWithOverseas,
  REGION_BUCKETS,
  type ScreenOpts,
} from "../services/overseas-query.js";
import { homePage } from "../views/home.js";
import { stockDetailPage } from "../views/stock-detail.js";
import { screeningPage } from "../views/screening.js";
import { layout } from "../views/layout.js";
import { STOCK_CODE_ERROR } from "../../../../src/shared/jpx/stock-code.js";
import { stockCodeSchema } from "../../../../src/shared/jpx/stock-code-schema.js";

/**
 * SSR ルーター。データは Cloudflare D1 バインディング `c.env.DB` から取得する。
 * 検索ヒット 0 件は「該当なし」を正直に返す（架空候補を作らない・ルール1）。
 */
type Bindings = { DB: D1Database };
export const pagesRoute = new Hono<{ Bindings: Bindings }>();

const homeQuery = z.object({
  q: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  focus: z.string().optional(),
});

pagesRoute.get("/", zValidator("query", homeQuery), async (c) => {
  const { q } = c.req.valid("query");
  if (q === undefined) {
    return c.html(homePage({ query: "", results: null }));
  }
  const db = createDb(c.env.DB);
  const results = await searchStocks(db, q);
  return c.html(homePage({ query: q, results }));
});

// ---- 海外売上高比率スクリーニング ----
const numOpt = z.preprocess(
  (v) => (v === "" || v === undefined ? undefined : v),
  z.coerce.number().optional()
);
const screenQuery = z.object({
  minYears: z.preprocess(
    (v) => (v === "" || v === undefined ? 3 : v),
    z.coerce.number().int().min(2).max(5)
  ),
  minOverseasRatioPct: numOpt,
  maxOverseasRatioPct: numOpt,
  minOverseasCagrPct: numOpt,
  // 地域別絞り込み (REGION_BUCKETS の key)。空文字→未指定。不正値は 422 で弾く。
  region: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.enum(Object.keys(REGION_BUCKETS) as [string, ...string[]]).optional()
  ),
  minRegionRatioPct: numOpt,
  maxRegionRatioPct: numOpt,
  sector: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  minOpMarginPct: numOpt,
  minMarketCapOku: numOpt,
  maxMarketCapOku: numOpt,
  maxPer: numOpt,
  minRoePct: numOpt,
  minDivYieldPct: numOpt,
  limit: z.preprocess(
    (v) => (v === "" || v === undefined ? 100 : v),
    z.coerce.number().int().min(1).max(500)
  ),
});

function toScreenOpts(q: z.infer<typeof screenQuery>): ScreenOpts {
  return {
    minYears: q.minYears,
    minOverseasRatioPct: q.minOverseasRatioPct,
    maxOverseasRatioPct: q.maxOverseasRatioPct,
    minOverseasCagrPct: q.minOverseasCagrPct,
    region: q.region,
    minRegionRatioPct: q.minRegionRatioPct,
    maxRegionRatioPct: q.maxRegionRatioPct,
    sector: q.sector,
    minOpMarginPct: q.minOpMarginPct,
    minMarketCapOku: q.minMarketCapOku,
    maxMarketCapOku: q.maxMarketCapOku,
    maxPer: q.maxPer,
    minRoePct: q.minRoePct,
    minDivYieldPct: q.minDivYieldPct,
    limit: q.limit,
  };
}

// スクリーニングは全銘柄の facts を走査する重いクエリ。facts は日次取込でしか
// 更新されないため、エッジ/ブラウザに 30 分キャッシュさせ D1 読取を抑える
// (条件=URL ごとに別エントリ。無料枠 D1 read 予算を守る)。
const SCREEN_CACHE = "public, max-age=1800";

pagesRoute.get("/screening", zValidator("query", screenQuery), async (c) => {
  const opts = toScreenOpts(c.req.valid("query"));
  const db = createDb(c.env.DB);
  const [rows, sectors] = await Promise.all([
    screenOverseasGrowth(db, opts),
    listSectorsWithOverseas(db),
  ]);
  c.header("Cache-Control", SCREEN_CACHE);
  return c.html(screeningPage({ opts, sectors, rows }));
});

pagesRoute.get("/api/screening", zValidator("query", screenQuery), async (c) => {
  const opts = toScreenOpts(c.req.valid("query"));
  const db = createDb(c.env.DB);
  const rows = await screenOverseasGrowth(db, opts);
  c.header("Cache-Control", SCREEN_CACHE);
  return c.json({ opts, count: rows.length, rows });
});

// URL は証券コード (ティッカー) で受ける。
const codeParam = z.object({ code: stockCodeSchema });

/** 検索へ戻る導線付きの通知ページ (袋小路にしない) */
function noticePage(title: string, message: string, status: 404 | 422) {
  return [
    layout(
      title,
      `<div class="container"><div class="notice"><strong>${message}</strong></div>
       <p style="margin:20px 0"><a href="${BASE_PATH}/">← 検索に戻る</a></p></div>`,
      "search"
    ),
    status,
  ] as const;
}

pagesRoute.get(
  "/stock/:code",
  zValidator("param", codeParam, (result, c) => {
    if (!result.success) {
      return c.html(...noticePage("証券コードが不正です", STOCK_CODE_ERROR, 422));
    }
  }),
  async (c) => {
    const { code } = c.req.valid("param");
    const db = createDb(c.env.DB);
    const trend = await getOverseasTrendByCode(db, code);
    if (!trend) {
      return c.html(
        ...noticePage(
          "銘柄が見つかりません",
          `証券コード ${code} の上場銘柄は見つかりませんでした。`,
          404
        )
      );
    }
    return c.html(stockDetailPage(trend));
  }
);

pagesRoute.get("/api/trend/:code", zValidator("param", codeParam), async (c) => {
  const { code } = c.req.valid("param");
  const db = createDb(c.env.DB);
  const trend = await getOverseasTrendByCode(db, code);
  if (!trend) return c.json({ error: "stock not found" }, 404);
  return c.json(trend);
});
