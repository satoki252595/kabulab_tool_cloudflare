import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq, asc, desc, inArray, count } from "drizzle-orm";
import {
  stocks,
  yutaiBenefits,
  yutaiGenres,
  stockFinancials,
  stockScores,
} from "../db/schema.js";
import {
  parseStockCode,
  STOCK_CODE_ERROR,
} from "../../../../src/shared/jpx/stock-code.js";
import { stockQuerySchema } from "../validators.js";
import type { AppEnv } from "../types.js";

/**
 * 銘柄ルート
 * GET /stocks — スクリーニング結果一覧
 * GET /stocks/:code — 銘柄詳細
 */
export const stockRoutes = new Hono<AppEnv>();

/**
 * GET /stocks — スクリーニング結果一覧
 * クエリパラメータでフィルタ・ソート・ページネーションが可能
 */
stockRoutes.get(
  "/",
  zValidator("query", stockQuerySchema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: "Validation Error",
          message: result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join(", "),
        },
        400,
      );
    }
  }),
  async (c) => {
    const { genre, sort, order, page, limit } = c.req.valid("query");
    const db = c.get("db");
    const offset = (page - 1) * limit;

    // ジャンルフィルタ: 対象銘柄IDを先に取得
    let targetStockIds: number[] | undefined;
    if (genre) {
      const genreRow = await db
        .select({ id: yutaiGenres.id })
        .from(yutaiGenres)
        .where(eq(yutaiGenres.slug, genre))
        .limit(1);

      if (genreRow.length === 0) {
        return c.json({ stocks: [], total: 0, page, limit });
      }

      const benefitRows = await db
        .selectDistinct({ stockId: yutaiBenefits.stockId })
        .from(yutaiBenefits)
        .where(eq(yutaiBenefits.genreId, genreRow[0].id));

      targetStockIds = benefitRows.map((b) => b.stockId);
      if (targetStockIds.length === 0) {
        return c.json({ stocks: [], total: 0, page, limit });
      }
    }

    // 総件数（ユニーク銘柄数）
    const stockCondition = targetStockIds
      ? inArray(stocks.id, targetStockIds)
      : undefined;

    const countResult = await db
      .select({ count: count() })
      .from(stocks)
      .where(stockCondition);

    const total = countResult[0]?.count ?? 0;

    // ソートカラムを決定
    const sortColumn = (() => {
      switch (sort) {
        case "fundamental":
          return stockScores.fundamentalScore;
        case "technical":
          return stockScores.technicalScore;
        case "price":
          return stockFinancials.price;
        case "total":
        default:
          return stockScores.totalScore;
      }
    })();

    const orderFn = order === "asc" ? asc : desc;

    // 銘柄一覧（LEFT JOINでスコア・財務データを結合、1銘柄1行）
    const rows = await db
      .select({
        id: stocks.id,
        code: stocks.code,
        name: stocks.name,
        market: stocks.market,
        sector: stocks.sector,
        price: stockFinancials.price,
        dividendYield: stockFinancials.dividendYield,
        per: stockFinancials.per,
        pbr: stockFinancials.pbr,
        fundamentalScore: stockScores.fundamentalScore,
        technicalScore: stockScores.technicalScore,
        totalScore: stockScores.totalScore,
      })
      .from(stocks)
      .leftJoin(stockScores, eq(stockScores.stockId, stocks.id))
      .leftJoin(stockFinancials, eq(stockFinancials.stockId, stocks.id))
      .where(stockCondition)
      .orderBy(orderFn(sortColumn))
      .limit(limit)
      .offset(offset);

    // ページ内の銘柄IDから優待情報を一括取得
    const stockIdsInPage = rows.map((r) => r.id);
    const benefits =
      stockIdsInPage.length > 0
        ? await db
            .select({
              stockId: yutaiBenefits.stockId,
              description: yutaiBenefits.description,
              genreSlug: yutaiGenres.slug,
              genreName: yutaiGenres.name,
            })
            .from(yutaiBenefits)
            .innerJoin(yutaiGenres, eq(yutaiBenefits.genreId, yutaiGenres.id))
            .where(inArray(yutaiBenefits.stockId, stockIdsInPage))
        : [];

    // レスポンス整形（1銘柄1エントリ）
    const stockItems = rows.map((row) => {
      const rowBenefits = benefits.filter((b) => b.stockId === row.id);
      return {
        code: row.code,
        name: row.name,
        market: row.market,
        sector: row.sector ?? null,
        benefitDescription: rowBenefits.map((b) => b.description).join(" / "),
        genreSlug: rowBenefits[0]?.genreSlug ?? null,
        genreName: rowBenefits[0]?.genreName ?? null,
        price: row.price ?? null,
        dividendYield: row.dividendYield ?? null,
        per: row.per ?? null,
        pbr: row.pbr ?? null,
        fundamentalScore: row.fundamentalScore ?? null,
        technicalScore: row.technicalScore ?? null,
        totalScore: row.totalScore ?? null,
      };
    });

    return c.json({
      stocks: stockItems,
      total,
      page,
      limit,
    });
  },
);

/**
 * GET /stocks/:code — 銘柄詳細
 * 銘柄コードに対応する銘柄の詳細情報（優待情報・財務データ・スコア）を返す
 */
stockRoutes.get("/:code", async (c) => {
  // 数字 4 桁 (例: 7011) と JPX 英数字コード (例: 130A) を受理して正準形に正規化
  const code = parseStockCode(c.req.param("code"));
  if (code === null) {
    return c.json(
      {
        error: "Validation Error",
        message: STOCK_CODE_ERROR,
      },
      400,
    );
  }

  const db = c.get("db");

  const stockData = await db.query.stocks.findFirst({
    where: eq(stocks.code, code),
    with: {
      benefits: {
        with: {
          genre: true,
        },
      },
      financials: {
        orderBy: (financials, { desc }) => [desc(financials.fetchedAt)],
        limit: 1,
      },
      scores: {
        orderBy: (scores, { desc }) => [desc(scores.scoredAt)],
        limit: 1,
      },
    },
  });

  if (!stockData) {
    return c.json(
      {
        error: "Not Found",
        message: `銘柄コード ${code} は見つかりません`,
      },
      404,
    );
  }

  const latestFinancial = stockData.financials[0] ?? null;
  const latestScore = stockData.scores[0] ?? null;

  return c.json({
    code: stockData.code,
    name: stockData.name,
    market: stockData.market,
    sector: stockData.sector ?? null,
    benefits: stockData.benefits.map((b) => ({
      id: b.id,
      description: b.description,
      minShares: b.minShares,
      recordMonth: b.recordMonth,
      estimatedValue: b.estimatedValue ?? null,
      genre: b.genre
        ? {
            id: b.genre.id,
            name: b.genre.name,
            slug: b.genre.slug,
          }
        : null,
    })),
    financial: latestFinancial
      ? {
          price: latestFinancial.price ?? null,
          per: latestFinancial.per ?? null,
          pbr: latestFinancial.pbr ?? null,
          dividendYield: latestFinancial.dividendYield ?? null,
          eps: latestFinancial.eps ?? null,
          bps: latestFinancial.bps ?? null,
          roe: latestFinancial.roe ?? null,
          roa: latestFinancial.roa ?? null,
          marketCap: latestFinancial.marketCap ?? null,
          ma5: latestFinancial.ma5 ?? null,
          ma25: latestFinancial.ma25 ?? null,
          ma75: latestFinancial.ma75 ?? null,
          rsi14: latestFinancial.rsi14 ?? null,
          macd: latestFinancial.macd ?? null,
          macdSignal: latestFinancial.macdSignal ?? null,
          dataDate: latestFinancial.dataDate ?? null,
        }
      : null,
    score: latestScore
      ? {
          fundamentalScore: latestScore.fundamentalScore,
          technicalScore: latestScore.technicalScore,
          totalScore: latestScore.totalScore,
          scoredAt: latestScore.scoredAt.toISOString(),
        }
      : null,
  });
});
