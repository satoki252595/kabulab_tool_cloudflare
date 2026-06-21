import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { stocks, stockFinancials } from "../db/core-schema.js";
import {
  stockIndicators,
  stockScreening,
  entrySignals,
  marketContext,
  sectorDaily,
} from "../db/schema.js";
import { stockCodeSchema } from "../../../../src/shared/jpx/stock-code-schema.js";
import { dashboardPage } from "../views/dashboard.js";
import { screeningPage } from "../views/screening.js";
import { signalsPage } from "../views/signals.js";
import { stockDetailPage, stockNotFoundPage } from "../views/stock-detail.js";
import { riskPage } from "../views/risk.js";
import { riskQuerySchema } from "../validators/risk.js";

/** SSR ページルーター。データは Cloudflare D1 バインディング `c.env.DB` から取得する（ADR-0001: Neon 廃止）。 */
type Bindings = { DB: D1Database };
export const pagesRoute = new Hono<{ Bindings: Bindings }>();

// -----------------------------------------------------------------------------
// GET / — ダッシュボード
// -----------------------------------------------------------------------------
pagesRoute.get("/", async (c) => {
  const db = createDb(c.env.DB);

  // マクロ判定 — 最新 1 行
  const macroRows = await db.select().from(marketContext).orderBy(desc(marketContext.date)).limit(1);
  const macro = macroRows[0] ?? null;

  // セクター上位 — 最新 date の rank_1d 昇順で 5 件
  const latestSectorDate = macro?.date;
  let topSectors: Array<{ sector: string; pct1d: number; stockCount: number; rank1d: number }> = [];
  if (latestSectorDate) {
    const rows = await db
      .select()
      .from(sectorDaily)
      .where(eq(sectorDaily.date, latestSectorDate))
      .orderBy(sectorDaily.rank1d)
      .limit(5);
    topSectors = rows
      .filter((r) => r.pct1d !== null && r.rank1d !== null)
      .map((r) => ({
        sector: r.sector,
        pct1d: r.pct1d!,
        stockCount: r.stockCount,
        rank1d: r.rank1d!,
      }));
  }

  // カウント集計
  const [{ totalScreened }] = await db
    .select({ totalScreened: sql<number>`count(*)` })
    .from(stockScreening);
  const [{ passedLong }] = await db
    .select({ passedLong: sql<number>`count(*)` })
    .from(stockScreening)
    .where(eq(stockScreening.allPassedLong, true));
  const [{ passedShort }] = await db
    .select({ passedShort: sql<number>`count(*)` })
    .from(stockScreening)
    .where(eq(stockScreening.allPassedShort, true));
  // entry_signals は active 銘柄分のみ集計/表示する。廃止 (is_active=false) 銘柄に
  // 取込打ち切り等で古いシグナルが残っても UI に出さない (鮮度のない値を出さない)。
  const [{ totalSignals }] = await db
    .select({ totalSignals: sql<number>`count(*)` })
    .from(entrySignals)
    .innerJoin(stocks, eq(stocks.id, entrySignals.stockId))
    .where(eq(stocks.isActive, true));

  // 強度上位シグナル 5 件
  const topSigRows = await db
    .select({
      code: stocks.code,
      name: stocks.name,
      pattern: entrySignals.pattern,
      direction: entrySignals.direction,
      signalStrength: entrySignals.signalStrength,
      note: entrySignals.note,
    })
    .from(entrySignals)
    .innerJoin(stocks, eq(stocks.id, entrySignals.stockId))
    .where(eq(stocks.isActive, true))
    .orderBy(desc(entrySignals.signalStrength))
    .limit(5);
  const topBreakouts = topSigRows.map((r) => ({
    code: r.code,
    name: r.name,
    pattern: r.pattern,
    direction: r.direction,
    signalStrength: r.signalStrength ?? 0,
    note: r.note ?? "",
  }));

  return c.html(
    dashboardPage({
      macro: macro
        ? {
            date: macro.date,
            judgment: macro.judgment as "A" | "B" | "C" | "D" | "HOLD",
            reason: macro.judgmentReason,
            nikkeiClose: macro.nikkeiClose,
            nikkeiPct: macro.nikkeiPct,
            vix: macro.vix,
            sp500Pct: macro.sp500Pct,
            nikkeiVi: macro.nikkeiVi,
            futuresGap: macro.futuresGap,
          }
        : null,
      topSectors,
      counts: {
        totalScreened: totalScreened ?? 0,
        passedLong: passedLong ?? 0,
        passedShort: passedShort ?? 0,
        totalSignals: totalSignals ?? 0,
      },
      topBreakouts,
    })
  );
});

// -----------------------------------------------------------------------------
// GET /screening — 5 条件フィルター一覧 (long/short)
// -----------------------------------------------------------------------------
const screeningQuerySchema = z.object({
  direction: z.enum(["long", "short"]).default("long"),
});

pagesRoute.get("/screening", zValidator("query", screeningQuerySchema), async (c) => {
  const { direction } = c.req.valid("query");
  const db = createDb(c.env.DB);

  const whereCondition =
    direction === "long"
      ? eq(stockScreening.allPassedLong, true)
      : eq(stockScreening.allPassedShort, true);

  const rows = await db
    .select({
      code: stocks.code,
      name: stocks.name,
      sector: stocks.sector,
      latestClose: stockIndicators.latestClose,
      pctChange1d: stockIndicators.pctChange1d,
      avgTurnover20d: stockIndicators.avgTurnover20d,
      atrPct: stockIndicators.atrPct,
      sma5: stockIndicators.sma5,
      sma20: stockIndicators.sma20,
      volumeRatio: stockIndicators.volumeRatio,
      liquidityOk: stockScreening.liquidityOk,
      volatilityOk: stockScreening.volatilityOk,
      trendOkLong: stockScreening.trendOkLong,
      trendOkShort: stockScreening.trendOkShort,
    })
    .from(stockScreening)
    .innerJoin(stocks, eq(stocks.id, stockScreening.stockId))
    .innerJoin(stockIndicators, eq(stockIndicators.stockId, stockScreening.stockId))
    .where(whereCondition)
    .orderBy(desc(stockIndicators.avgTurnover20d))
    .limit(200);

  const mapped = rows.map((r) => ({
    code: r.code,
    name: r.name,
    sector: r.sector,
    latestClose: r.latestClose,
    pctChange1d: r.pctChange1d,
    avgTurnover20d: r.avgTurnover20d,
    atrPct: r.atrPct,
    sma5: r.sma5,
    sma20: r.sma20,
    volumeRatio: r.volumeRatio,
    liquidityOk: r.liquidityOk,
    volatilityOk: r.volatilityOk,
    trendOk: direction === "long" ? r.trendOkLong : r.trendOkShort,
  }));

  return c.html(screeningPage({ direction, rows: mapped, totalCount: rows.length }));
});

// -----------------------------------------------------------------------------
// GET /signals — E&E シグナル一覧
// -----------------------------------------------------------------------------
const VALID_PATTERNS = [
  "all",
  "breakout_long",
  "breakout_short",
  "pullback_long",
  "pullback_short",
  "volume_surge",
  "gap_follow",
  "gap_fade",
  "post_earnings",
] as const;

const signalsQuerySchema = z.object({
  pattern: z.enum(VALID_PATTERNS).default("all"),
});

pagesRoute.get("/signals", zValidator("query", signalsQuerySchema), async (c) => {
  const { pattern } = c.req.valid("query");
  const db = createDb(c.env.DB);

  const base = db
    .select({
      code: stocks.code,
      name: stocks.name,
      sector: stocks.sector,
      pattern: entrySignals.pattern,
      direction: entrySignals.direction,
      entryPrice: entrySignals.entryPrice,
      stopLoss: entrySignals.stopLoss,
      target1: entrySignals.target1,
      target2: entrySignals.target2,
      riskRewardRatio: entrySignals.riskRewardRatio,
      signalStrength: entrySignals.signalStrength,
      note: entrySignals.note,
    })
    .from(entrySignals)
    .innerJoin(stocks, eq(stocks.id, entrySignals.stockId));

  const rows =
    pattern === "all"
      ? await base
          .where(eq(stocks.isActive, true))
          .orderBy(desc(entrySignals.signalStrength))
          .limit(200)
      : await base
          .where(
            and(eq(stocks.isActive, true), eq(entrySignals.pattern, pattern))
          )
          .orderBy(desc(entrySignals.signalStrength))
          .limit(200);

  const mapped = rows.map((r) => ({
    code: r.code,
    name: r.name,
    sector: r.sector,
    pattern: r.pattern,
    direction: r.direction,
    entryPrice: r.entryPrice,
    stopLoss: r.stopLoss,
    target1: r.target1,
    target2: r.target2,
    riskRewardRatio: r.riskRewardRatio,
    signalStrength: r.signalStrength ?? 0,
    note: r.note ?? "",
  }));

  return c.html(signalsPage({ pattern, rows: mapped, totalCount: rows.length }));
});

// -----------------------------------------------------------------------------
// GET /stock/:code — 銘柄詳細
// -----------------------------------------------------------------------------
// 数字 4 桁 (例: 7011) と JPX 英数字コード (例: 130A) の両方を受理する。
const stockParamSchema = z.object({
  code: stockCodeSchema,
});

pagesRoute.get("/stock/:code", zValidator("param", stockParamSchema), async (c) => {
  const { code } = c.req.valid("param");
  const db = createDb(c.env.DB);

  const [stock] = await db.select().from(stocks).where(eq(stocks.code, code)).limit(1);
  if (!stock) {
    return c.html(stockNotFoundPage(code), 404);
  }

  const [indicator] = await db
    .select()
    .from(stockIndicators)
    .where(eq(stockIndicators.stockId, stock.id))
    .limit(1);

  const [screening] = await db
    .select()
    .from(stockScreening)
    .where(eq(stockScreening.stockId, stock.id))
    .limit(1);

  const [financial] = await db
    .select()
    .from(stockFinancials)
    .where(eq(stockFinancials.stockId, stock.id))
    .limit(1);

  const signals = await db
    .select()
    .from(entrySignals)
    .where(eq(entrySignals.stockId, stock.id))
    .orderBy(desc(entrySignals.signalStrength));

  return c.html(
    stockDetailPage({
      code: stock.code,
      name: stock.name,
      sector: stock.sector,
      market: stock.market,
      latestClose: indicator?.latestClose ?? null,
      latestDate: indicator?.latestDate ?? null,
      pctChange1d: indicator?.pctChange1d ?? null,
      avgTurnover20d: indicator?.avgTurnover20d ?? null,
      volumeRatio: indicator?.volumeRatio ?? null,
      atr14: indicator?.atr14 ?? null,
      atrPct: indicator?.atrPct ?? null,
      sma5: indicator?.sma5 ?? null,
      sma20: indicator?.sma20 ?? null,
      sma60: indicator?.sma60 ?? null,
      sma75: indicator?.sma75 ?? null,
      rsi14: indicator?.rsi14 ?? null,
      macd: indicator?.macd ?? null,
      macdSignal: indicator?.macdSignal ?? null,
      range20dHigh: indicator?.range20dHigh ?? null,
      range20dLow: indicator?.range20dLow ?? null,
      fib382: indicator?.fib382 ?? null,
      fib500: indicator?.fib500 ?? null,
      fib618: indicator?.fib618 ?? null,
      trendLong: indicator?.trendLong ?? false,
      trendShort: indicator?.trendShort ?? false,
      perfectOrderLong: indicator?.perfectOrderLong ?? false,
      perfectOrderShort: indicator?.perfectOrderShort ?? false,
      liquidityOk: screening?.liquidityOk ?? false,
      volatilityOk: screening?.volatilityOk ?? false,
      trendOkLong: screening?.trendOkLong ?? false,
      trendOkShort: screening?.trendOkShort ?? false,
      per: financial?.per ?? null,
      pbr: financial?.pbr ?? null,
      dividendYield: financial?.dividendYield ?? null,
      marketCap: financial?.marketCap ?? null,
      signals: signals.map((s) => ({
        pattern: s.pattern,
        direction: s.direction,
        entryPrice: s.entryPrice,
        stopLoss: s.stopLoss,
        target1: s.target1,
        target2: s.target2,
        riskRewardRatio: s.riskRewardRatio,
        signalStrength: s.signalStrength ?? 0,
        note: s.note ?? "",
      })),
    })
  );
});

// -----------------------------------------------------------------------------
// GET /risk — リスク計算機フォーム
// -----------------------------------------------------------------------------
pagesRoute.get("/risk", zValidator("query", riskQuerySchema), (c) => {
  const q = c.req.valid("query");
  return c.html(
    riskPage({
      preset: {
        accountYen: 5_000_000,
        riskPct: 0.02,
        entryPrice: q.entry ?? null,
        stopLoss: q.stop ?? null,
        target1: q.target ?? null,
      },
      result: null,
      error: null,
    })
  );
});
