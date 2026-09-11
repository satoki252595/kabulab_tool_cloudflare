import { Hono } from "hono";
import { eq, desc, inArray, and } from "drizzle-orm";
import {
  stocks,
  yutaiGenres,
  yutaiBenefits,
  stockFinancials,
  stockScores,
} from "../db/schema.js";
import type { AppEnv } from "../types.js";
import { scoreStock } from "../services/scoring.js";
import Home from "../views/pages/home.js";
import GenreStocks from "../views/pages/genre-stocks.js";
import StockDetail from "../views/pages/stock-detail.js";
import SearchResults from "../views/pages/search-results.js";
// NOTE: 本番経路は app.ts。このルータ (pages-app.ts 経由) は dead code だが、
// 証券コード判定は共有ヘルパへ統一し、復活時に英数字コード未対応へ退行しない
// ようにしておく (app.ts と同一方針)。
import { parseStockCode } from "../../../../src/shared/jpx/stock-code.js";

/** 1ページあたりの表示件数 */
const PAGE_SIZE = 20;

/** ソートキーとして受け付ける値 */
type SortKey = "totalScore" | "fundamentalScore" | "technicalScore";
const VALID_SORTS: SortKey[] = [
  "totalScore",
  "fundamentalScore",
  "technicalScore",
];

/** パラメータバリデーション用パターン (証券コードは共有ヘルパ parseStockCode を使う) */
const SLUG_PATTERN = /^[a-z0-9-]+$/;

const pages = new Hono<AppEnv>();

/** 権利確定月でフィルタしたスコアTOP銘柄を取得するヘルパー */
async function getTopStocksByMonth(
  db: ReturnType<typeof import("../db/client").createDb>,
  month: number,
  limit: number
) {
  // 該当月の権利確定銘柄IDを取得
  const benefitRows = await db
    .selectDistinct({ stockId: yutaiBenefits.stockId })
    .from(yutaiBenefits)
    .where(eq(yutaiBenefits.recordMonth, month));

  const stockIds = benefitRows.map((b) => b.stockId);
  if (stockIds.length === 0) return [];

  const rows = await db
    .select({
      stockId: stocks.id,
      code: stocks.code,
      name: stocks.name,
      totalScore: stockScores.totalScore,
      fundamentalScore: stockScores.fundamentalScore,
      technicalScore: stockScores.technicalScore,
      per: stockFinancials.per,
      pbr: stockFinancials.pbr,
      dividendYield: stockFinancials.dividendYield,
      price: stockFinancials.price,
    })
    .from(stocks)
    .leftJoin(stockScores, eq(stockScores.stockId, stocks.id))
    .leftJoin(stockFinancials, eq(stockFinancials.stockId, stocks.id))
    .where(inArray(stocks.id, stockIds))
    .orderBy(desc(stockScores.totalScore))
    .limit(limit);

  // 優待サマリーを取得
  const pageStockIds = rows.map((r) => r.stockId);
  const benefits = pageStockIds.length > 0
    ? await db
        .select({
          stockId: yutaiBenefits.stockId,
          shortSummary: yutaiBenefits.shortSummary,
          shortSummary: yutaiBenefits.shortSummary,
          genreName: yutaiGenres.name,
          minShares: yutaiBenefits.minShares,
          recordMonth: yutaiBenefits.recordMonth,
        })
        .from(yutaiBenefits)
        .innerJoin(yutaiGenres, eq(yutaiBenefits.genreId, yutaiGenres.id))
        .where(inArray(yutaiBenefits.stockId, pageStockIds))
    : [];

  return rows.map((row) => {
    const rowBenefits = benefits.filter((b) => b.stockId === row.stockId);
    const price = row.price ?? null;
    const minShares = rowBenefits.length > 0 ? Math.min(...rowBenefits.map((b) => b.minShares)) : null;
    return {
      code: row.code,
      name: row.name,
      genres: [...new Set(rowBenefits.map((b) => b.genreName))],
      totalScore: row.totalScore ?? null,
      fundamentalScore: row.fundamentalScore ?? null,
      technicalScore: row.technicalScore ?? null,
      per: row.per ?? null,
      pbr: row.pbr ?? null,
      dividendYield: row.dividendYield ?? null,
      price,
      minInvestment: price != null && minShares != null ? price * minShares : null,
      recordMonths: [...new Set(rowBenefits.map((b) => b.recordMonth))].sort((a, b) => a - b),
      benefitSummary: rowBenefits.map((b) => b.shortSummary ?? "").join(" / "),
    };
  });
}

/**
 * GET / — ホームページ
 * ジャンル一覧、今月/来月の注目銘柄、全体TOP10を表示する
 */
pages.get("/", async (c) => {
  const db = c.get("db");

  const now = new Date();
  const currentMonth = now.getMonth() + 1; // 1-12
  const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;

  // 並列で3クエリを実行
  const [genres, thisMonthStocks, nextMonthStocks] = await Promise.all([
    db.select().from(yutaiGenres).orderBy(yutaiGenres.name),
    getTopStocksByMonth(db, currentMonth, 5),
    getTopStocksByMonth(db, nextMonth, 5),
  ]);

  return c.html(
    <Home
      genres={genres}
      currentMonth={currentMonth}
      nextMonth={nextMonth}
      thisMonthStocks={thisMonthStocks}
      nextMonthStocks={nextMonthStocks}
    />
  );
});

/**
 * GET /genres/:slug — ジャンル別スクリーニング結果ページ
 * 指定ジャンルの銘柄をスコア順に表示する
 */
pages.get("/genres/:slug", async (c) => {
  const slug = c.req.param("slug");

  // スラッグのバリデーション
  if (!SLUG_PATTERN.test(slug)) {
    return c.notFound();
  }

  const db = c.get("db");

  // ジャンル取得
  const genre = await db
    .select()
    .from(yutaiGenres)
    .where(eq(yutaiGenres.slug, slug))
    .limit(1)
    .then((rows) => rows[0]);

  if (!genre) {
    return c.notFound();
  }

  // クエリパラメータ（ソート・ページ・フィルター）
  const sortParam = c.req.query("sort") ?? "totalScore";
  const sort: SortKey = VALID_SORTS.includes(sortParam as SortKey)
    ? (sortParam as SortKey)
    : "totalScore";
  const pageParam = c.req.query("page") ?? "1";
  const page = Math.max(1, Math.min(parseInt(pageParam, 10) || 1, 1000));

  // フィルターパラメータ
  const monthParams = c.req.queries("month") ?? [];
  const filterMonths = monthParams
    .map((m) => parseInt(m, 10))
    .filter((m) => m >= 1 && m <= 12);
  const maxInvestmentParam = c.req.query("maxInvestment");
  const maxInvestment = maxInvestmentParam ? parseInt(maxInvestmentParam, 10) || null : null;
  const minScoreParam = c.req.query("minScore");
  const minScore = minScoreParam ? parseInt(minScoreParam, 10) || null : null;

  const filters = {
    months: filterMonths,
    maxInvestment,
    minScore,
  };

  // このジャンルに紐づく優待情報を取得（フィルター適用）
  const benefitConditions = [eq(yutaiBenefits.genreId, genre.id)];
  if (filterMonths.length > 0) {
    benefitConditions.push(inArray(yutaiBenefits.recordMonth, filterMonths));
  }

  const benefitRows = await db
    .selectDistinct({
      stockId: yutaiBenefits.stockId,
      minShares: yutaiBenefits.minShares,
    })
    .from(yutaiBenefits)
    .where(and(...benefitConditions));

  const stockIds = benefitRows.map((b) => b.stockId);

  if (stockIds.length === 0) {
    return c.html(
      <GenreStocks
        genreName={genre.name}
        genreSlug={`genres/${genre.slug}`}
        stocks={[]}
        sort={sort}
        page={1}
        totalPages={1}
        totalCount={0}
        filters={filters}
      />
    );
  }

  // 投資額フィルター: price × minShares でフィルタ（アプリ側で処理）
  // スコアフィルター: minScore以上のみ
  // まず候補銘柄の価格とスコアを取得
  const candidateRows = await db
    .select({
      stockId: stocks.id,
      code: stocks.code,
      name: stocks.name,
      fundamentalScore: stockScores.fundamentalScore,
      technicalScore: stockScores.technicalScore,
      totalScore: stockScores.totalScore,
      per: stockFinancials.per,
      pbr: stockFinancials.pbr,
      dividendYield: stockFinancials.dividendYield,
      price: stockFinancials.price,
    })
    .from(stocks)
    .leftJoin(stockScores, eq(stockScores.stockId, stocks.id))
    .leftJoin(stockFinancials, eq(stockFinancials.stockId, stocks.id))
    .where(inArray(stocks.id, [...new Set(stockIds)]));

  // アプリ側でフィルター適用
  let filteredRows = candidateRows;
  if (maxInvestment !== null) {
    filteredRows = filteredRows.filter((row) => {
      if (row.price == null) return false;
      const stockBenefits = benefitRows.filter((b) => b.stockId === row.stockId);
      const minShares = stockBenefits.length > 0 ? Math.min(...stockBenefits.map((b) => b.minShares)) : 100;
      return row.price * minShares <= maxInvestment;
    });
  }
  if (minScore !== null) {
    filteredRows = filteredRows.filter(
      (row) => row.totalScore != null && row.totalScore >= minScore
    );
  }

  // ソート
  const sortKey = sort === "fundamentalScore" ? "fundamentalScore"
    : sort === "technicalScore" ? "technicalScore"
    : "totalScore";
  filteredRows.sort((a, b) => ((b[sortKey] ?? 0) - (a[sortKey] ?? 0)));

  // ページネーション
  const totalCount = filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * PAGE_SIZE;
  const pagedRows = filteredRows.slice(offset, offset + PAGE_SIZE);

  // 銘柄ごとのジャンル名と優待サマリーを取得
  const pageStockIds = pagedRows.map((r) => r.stockId);
  const benefitsForPage =
    pageStockIds.length > 0
      ? await db
          .select({
            stockId: yutaiBenefits.stockId,
            genreName: yutaiGenres.name,
            shortSummary: yutaiBenefits.shortSummary,
            shortSummary: yutaiBenefits.shortSummary,
            minShares: yutaiBenefits.minShares,
            recordMonth: yutaiBenefits.recordMonth,
          })
          .from(yutaiBenefits)
          .innerJoin(yutaiGenres, eq(yutaiBenefits.genreId, yutaiGenres.id))
          .where(inArray(yutaiBenefits.stockId, pageStockIds))
      : [];

  // レスポンス組み立て
  const stockItems = pagedRows.map((row) => {
    const rowBenefits = benefitsForPage.filter((b) => b.stockId === row.stockId);
    const genres = [...new Set(rowBenefits.map((b) => b.genreName))];
    const benefitSummary = rowBenefits.map((b) => b.shortSummary ?? "").join(" / ");
    const price = row.price ?? null;
    const minShares = rowBenefits.length > 0 ? Math.min(...rowBenefits.map((b) => b.minShares)) : null;

    return {
      code: row.code,
      name: row.name,
      genres,
      fundamentalScore: row.fundamentalScore ?? null,
      technicalScore: row.technicalScore ?? null,
      totalScore: row.totalScore ?? null,
      per: row.per ?? null,
      pbr: row.pbr ?? null,
      dividendYield: row.dividendYield ?? null,
      price,
      minInvestment: price != null && minShares != null ? price * minShares : null,
      recordMonths: [...new Set(rowBenefits.map((b) => b.recordMonth))].sort((a, b) => a - b),
      benefitSummary,
    };
  });

  return c.html(
    <GenreStocks
      genreName={genre.name}
      genreSlug={`genres/${genre.slug}`}
      stocks={stockItems}
      sort={sort}
      page={safePage}
      totalPages={totalPages}
      totalCount={totalCount}
      filters={filters}
    />
  );
});

/**
 * GET /stocks/:code — 銘柄詳細ページ
 * 指定銘柄のスコア内訳、財務指標、優待情報を表示する
 */
pages.get("/stocks/:code", async (c) => {
  // 数字 4 桁 + JPX 英数字コード (例: 130A) を受理して正準形に正規化
  const code = parseStockCode(c.req.param("code"));
  if (code === null) {
    return c.notFound();
  }

  const db = c.get("db");

  // 銘柄取得
  const stock = await db
    .select()
    .from(stocks)
    .where(eq(stocks.code, code))
    .limit(1)
    .then((rows) => rows[0]);

  if (!stock) {
    return c.notFound();
  }

  // 最新の財務データ
  const fin = await db
    .select()
    .from(stockFinancials)
    .where(eq(stockFinancials.stockId, stock.id))
    .orderBy(desc(stockFinancials.fetchedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  // 最新のスコア
  const score = await db
    .select()
    .from(stockScores)
    .where(eq(stockScores.stockId, stock.id))
    .orderBy(desc(stockScores.scoredAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  // 優待情報（ジャンル名付き）
  const benefitRows = await db
    .select({
      genreName: yutaiGenres.name,
      genreSlug: yutaiGenres.slug,
      shortSummary: yutaiBenefits.shortSummary,
      shortSummary: yutaiBenefits.shortSummary,
      minShares: yutaiBenefits.minShares,
      recordMonth: yutaiBenefits.recordMonth,
      estimatedValue: yutaiBenefits.estimatedValue,
    })
    .from(yutaiBenefits)
    .innerJoin(yutaiGenres, eq(yutaiBenefits.genreId, yutaiGenres.id))
    .where(eq(yutaiBenefits.stockId, stock.id));

  // スコア内訳を再計算（個別指標スコアはDBに保存されていないため）
  const scoreDetails = fin
    ? scoreStock({
        price: fin.price,
        per: fin.per,
        pbr: fin.pbr,
        dividendYield: fin.dividendYield,
        roe: fin.roe,
        ma5: fin.ma5,
        ma25: fin.ma25,
        ma75: fin.ma75,
        rsi14: fin.rsi14,
        macd: fin.macd,
        macdSignal: fin.macdSignal,
        yutaiYield: fin.yutaiYield,
      }).details
    : null;

  return c.html(
    <StockDetail
      code={stock.code}
      name={stock.name}
      market={stock.market}
      sector={stock.sector}
      fundamentalScore={score?.fundamentalScore ?? null}
      technicalScore={score?.technicalScore ?? null}
      totalScore={score?.totalScore ?? null}
      price={fin?.price ?? null}
      per={fin?.per ?? null}
      pbr={fin?.pbr ?? null}
      dividendYield={fin?.dividendYield ?? null}
      eps={fin?.eps ?? null}
      bps={fin?.bps ?? null}
      marketCap={fin?.marketCap ?? null}
      ma5={fin?.ma5 ?? null}
      ma25={fin?.ma25 ?? null}
      ma75={fin?.ma75 ?? null}
      rsi14={fin?.rsi14 ?? null}
      roe={fin?.roe ?? null}
      roa={fin?.roa ?? null}
      macd={fin?.macd ?? null}
      macdSignal={fin?.macdSignal ?? null}
      yutaiYield={fin?.yutaiYield ?? null}
      dataFetchedAt={fin?.fetchedAt?.toISOString() ?? null}
      scoreScoredAt={score?.scoredAt?.toISOString() ?? null}
      scoreDetails={scoreDetails}
      benefits={benefitRows}
    />
  );
});

/**
 * GET /months/:month — 権利確定月別銘柄一覧ページ
 * 指定月の権利確定銘柄をスコア順に表示する
 */
pages.get("/months/:month", async (c) => {
  const monthParam = c.req.param("month");
  const month = parseInt(monthParam, 10);

  if (isNaN(month) || month < 1 || month > 12) {
    return c.notFound();
  }

  const db = c.get("db");

  // クエリパラメータ
  const sortParam = c.req.query("sort") ?? "totalScore";
  const sort: SortKey = VALID_SORTS.includes(sortParam as SortKey)
    ? (sortParam as SortKey)
    : "totalScore";
  const pageParam = c.req.query("page") ?? "1";
  const page = Math.max(1, Math.min(parseInt(pageParam, 10) || 1, 1000));

  // この月に権利確定するユニークな銘柄IDを取得
  const benefitRows = await db
    .selectDistinct({ stockId: yutaiBenefits.stockId })
    .from(yutaiBenefits)
    .where(eq(yutaiBenefits.recordMonth, month));

  const stockIds = benefitRows.map((b) => b.stockId);
  const totalCount = stockIds.length;

  if (stockIds.length === 0) {
    return c.html(
      <GenreStocks
        genreName={`${month}月権利確定`}
        genreSlug={`months/${month}`}
        stocks={[]}
        sort={sort}
        page={1}
        totalPages={1}
        totalCount={0}
      />
    );
  }

  // ソートカラムを決定
  const sortColumn = (() => {
    switch (sort) {
      case "fundamentalScore":
        return stockScores.fundamentalScore;
      case "technicalScore":
        return stockScores.technicalScore;
      case "totalScore":
      default:
        return stockScores.totalScore;
    }
  })();

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * PAGE_SIZE;

  const rows = await db
    .select({
      stockId: stocks.id,
      code: stocks.code,
      name: stocks.name,
      fundamentalScore: stockScores.fundamentalScore,
      technicalScore: stockScores.technicalScore,
      totalScore: stockScores.totalScore,
      per: stockFinancials.per,
      pbr: stockFinancials.pbr,
      dividendYield: stockFinancials.dividendYield,
      price: stockFinancials.price,
    })
    .from(stocks)
    .leftJoin(stockScores, eq(stockScores.stockId, stocks.id))
    .leftJoin(stockFinancials, eq(stockFinancials.stockId, stocks.id))
    .where(inArray(stocks.id, stockIds))
    .orderBy(desc(sortColumn))
    .limit(PAGE_SIZE)
    .offset(offset);

  // ページ内銘柄の優待情報を一括取得
  const pageStockIds = rows.map((r) => r.stockId);
  const benefitsForPage =
    pageStockIds.length > 0
      ? await db
          .select({
            stockId: yutaiBenefits.stockId,
            genreName: yutaiGenres.name,
            shortSummary: yutaiBenefits.shortSummary,
            shortSummary: yutaiBenefits.shortSummary,
            minShares: yutaiBenefits.minShares,
            recordMonth: yutaiBenefits.recordMonth,
          })
          .from(yutaiBenefits)
          .innerJoin(yutaiGenres, eq(yutaiBenefits.genreId, yutaiGenres.id))
          .where(inArray(yutaiBenefits.stockId, pageStockIds))
      : [];

  const stockItems = rows.map((row) => {
    const rowBenefits = benefitsForPage.filter((b) => b.stockId === row.stockId);
    const genres = [...new Set(rowBenefits.map((b) => b.genreName))];
    const benefitSummary = rowBenefits.map((b) => b.shortSummary ?? "").join(" / ");
    const price = row.price ?? null;
    const minShares = rowBenefits.length > 0 ? Math.min(...rowBenefits.map((b) => b.minShares)) : null;

    return {
      code: row.code,
      name: row.name,
      genres,
      fundamentalScore: row.fundamentalScore ?? null,
      technicalScore: row.technicalScore ?? null,
      totalScore: row.totalScore ?? null,
      per: row.per ?? null,
      pbr: row.pbr ?? null,
      dividendYield: row.dividendYield ?? null,
      price,
      minInvestment: price != null && minShares != null ? price * minShares : null,
      recordMonths: [...new Set(rowBenefits.map((b) => b.recordMonth))].sort((a, b) => a - b),
      benefitSummary,
    };
  });

  return c.html(
    <GenreStocks
      genreName={`${month}月権利確定`}
      genreSlug={`months/${month}`}
      stocks={stockItems}
      sort={sort}
      page={safePage}
      totalPages={totalPages}
      totalCount={totalCount}
    />
  );
});

/**
 * GET /search — 銘柄検索ページ
 * 銘柄コードまたは銘柄名で検索する
 */
pages.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();

  if (!q) {
    return c.html(<SearchResults query="" stocks={[]} />);
  }

  // 証券コード完全一致ならリダイレクト (数字 4 桁 + 英数字コードを正準形で判定)
  const exactCode = parseStockCode(q);
  if (exactCode !== null) {
    const db = c.get("db");
    const stock = await db
      .select({ code: stocks.code })
      .from(stocks)
      .where(eq(stocks.code, exactCode))
      .limit(1)
      .then((rows) => rows[0]);

    if (stock) {
      return c.redirect(`/stocks/${stock.code}`);
    }
  }

  const db = c.get("db");

  // コード前方一致 or 名前部分一致で検索
  const { sql: sqlFn } = await import("drizzle-orm");
  const searchResults = await db
    .select({
      stockId: stocks.id,
      code: stocks.code,
      name: stocks.name,
      totalScore: stockScores.totalScore,
      fundamentalScore: stockScores.fundamentalScore,
      technicalScore: stockScores.technicalScore,
      per: stockFinancials.per,
      pbr: stockFinancials.pbr,
      dividendYield: stockFinancials.dividendYield,
      price: stockFinancials.price,
    })
    .from(stocks)
    .leftJoin(stockScores, eq(stockScores.stockId, stocks.id))
    .leftJoin(stockFinancials, eq(stockFinancials.stockId, stocks.id))
    .where(
      sqlFn`(${stocks.code} LIKE ${q + "%"} OR ${stocks.name} ILIKE ${"%" + q + "%"})`
    )
    .orderBy(desc(stockScores.totalScore))
    .limit(50);

  // 検索結果の優待情報
  const resultStockIds = searchResults.map((r) => r.stockId);
  const benefits =
    resultStockIds.length > 0
      ? await db
          .select({
            stockId: yutaiBenefits.stockId,
            genreName: yutaiGenres.name,
            shortSummary: yutaiBenefits.shortSummary,
            shortSummary: yutaiBenefits.shortSummary,
          })
          .from(yutaiBenefits)
          .innerJoin(yutaiGenres, eq(yutaiBenefits.genreId, yutaiGenres.id))
          .where(inArray(yutaiBenefits.stockId, resultStockIds))
      : [];

  const stockItems = searchResults.map((row) => {
    const rowBenefits = benefits.filter((b) => b.stockId === row.stockId);
    return {
      code: row.code,
      name: row.name,
      genres: [...new Set(rowBenefits.map((b) => b.genreName))],
      totalScore: row.totalScore ?? null,
      fundamentalScore: row.fundamentalScore ?? null,
      technicalScore: row.technicalScore ?? null,
      per: row.per ?? null,
      pbr: row.pbr ?? null,
      dividendYield: row.dividendYield ?? null,
      benefitSummary: rowBenefits.map((b) => b.shortSummary ?? "").join(" / "),
    };
  });

  return c.html(<SearchResults query={q} stocks={stockItems} />);
});

export default pages;
