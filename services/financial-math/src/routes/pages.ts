import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { createDb } from "../db/client.js";
import { stocks, stockFinancials } from "../../../../src/shared/db/core-schema.js";
import { dailyOhlcv, stockIndicators } from "../db/swing-readonly.js";
import { momentumProjection } from "../../../../src/shared/db/projection-schema.js";
import { decodeCloses } from "../../../../src/shared/indicators/momentum-series.js";
import { getOhlcvSeries, getPriceContext, type OhlcvBar } from "../services/price-cache.js";
import { homePage } from "../views/home.js";
import { dcfPage, type StockContext as DcfStockContext } from "../views/dcf.js";
import { capmPage, type CapmStockContext } from "../views/capm.js";
import { emhPage, type EmhRow } from "../views/emh.js";
import { bsPage, type BsStockContext } from "../views/black-scholes.js";
import { dcfQuerySchema } from "../validators/dcf.js";
import { capmQuerySchema } from "../validators/capm.js";
import { bsQuerySchema } from "../validators/black-scholes.js";
import { emhQuerySchema } from "../validators/emh.js";
import { calcHistoricalVolatility } from "../services/volatility.js";
import { calcLogReturns, estimateBetaOLS, calcCapmExpectedReturn } from "../services/capm.js";
import { calcMomentum } from "../services/emh.js";
import { requireBinding, requireDb } from "./env.js";
import { publicSectorColumn } from "../../../../src/shared/db/public-columns.js";
import { activeEquityCondition } from "../../../../src/shared/db/active-equity.js";

/** SSR ページルーター */
type Bindings = { DB: D1Database };
export const pagesRoute = new Hono<{ Bindings: Bindings }>();

// =============================================================================
// GET / — ホーム
// =============================================================================
pagesRoute.get("/", (c) => c.html(homePage()));

// =============================================================================
// GET /dcf?code=7203 — DCF フォーム (銘柄プリフィル対応)
// =============================================================================
pagesRoute.get("/dcf", zValidator("query", dcfQuerySchema), async (c) => {
  const { code } = c.req.valid("query");
  let stockContext: DcfStockContext | null = null;
  // CLAUDE.md ルール1: ダミーデフォルト値を埋めない。
  // 銘柄プリフィルで D1 の断面から実値が取れた場合のみセット、それ以外は null。
  // View 側で null のときは input value="" で空欄表示し、ユーザーに手動入力を促す。
  let presetDividend: number | null = null;
  /**
   * プリフィルできなかった理由。
   *
   * ここは以前 `catch {}` で、取得失敗が**何も表示されないまま**フォームが
   * 空欄で出ていた (真の silent catch 2 箇所のうちの 1 つ)。ユーザからは
   * 「銘柄コードを入れたのに何も起きない」としか見えない。
   */
  let prefillNotice: string | null = null;
  // 要求リターン (k) と成長率 (g) は「Gordon モデルの計算前提として使用者が決める値」で、
  // 銘柄固有値ではない。フォーム再描画時の initial state として一般的な値を残す
  // (k=7% は東証長期平均、g=3% は日本企業の中期トレンド)。UI で根拠を明記している。
  const presetK = 7;
  const presetG = 3;

  if (code) {
    const db = createDb(requireDb(c));
    try {
      // core_stock_financials の断面を読む (1414 のような優待なし銘柄も含む)
      const ctx = await getPriceContext(db, code);
      // 無配銘柄判定: Yahoo の dividendYield が null/0 なら estimatedDividend も null
      const isNonDividend = ctx.estimatedDividend === null || ctx.estimatedDividend <= 0;
      stockContext = {
        code: ctx.code,
        name: ctx.name ?? ctx.code,
        currentPrice: ctx.price,
        dividendYield: ctx.dividendYield,
        estimatedDividend: ctx.estimatedDividend,
        estimatedGrowth: null,
        isNonDividend,
      };
      if (!isNonDividend && ctx.estimatedDividend !== null) {
        presetDividend = Math.round(ctx.estimatedDividend * 100) / 100;
      }
      // 無配時は presetDividend は null のまま → input 空欄
    } catch (e) {
      // 不正コード / 断面未登録。画面自体は描画するが、**理由は必ず出す**。
      prefillNotice = `銘柄 ${code} のプリフィルができません: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return c.html(
    dcfPage({
      preset: {
        code,
        mode: "gordon",
        expectedDividend: presetDividend,
        // GET 時に断面からのプリフィルが走った場合のみ「自動」バッジを出す
        expectedDividendAutoFilled: presetDividend !== null && presetDividend > 0,
        requiredReturnPct: presetK,
        growthRatePct: presetG,
        highGrowthYears: 5,
        terminalGrowthPct: 2,
      },
      stockContext,
      gordonResult: null,
      twoStageResult: null,
      currentPrice: stockContext?.currentPrice ?? null,
      error: null,
      infoNotice: prefillNotice,
    })
  );
});

// =============================================================================
// GET /capm?code=9983 — CAPM フォーム (β 自動推定対応)
// =============================================================================
pagesRoute.get("/capm", zValidator("query", capmQuerySchema), async (c) => {
  const { code } = c.req.valid("query");
  const view = await buildCapmView({
    db: requireDb(c),
    code,
    mode: code ? "auto" : "manual",
    // CLAUDE.md ルール1: β=1.0 等のダミー値は埋めない。null で起動し、
    // auto モードでは推定値、manual モードではユーザー入力に任せる。
    beta: null,
    // Rf, Rm は計算前提として使用者が決めるパラメータ。日本市場の典型値を初期値に。
    riskFreeRatePct: 0.5,
    marketReturnPct: 6,
  });
  return c.html(capmPage(view));
});

// =============================================================================
// GET /black-scholes?code=7974 — BS フォーム (S とヒストリカルボラ自動入力)
// =============================================================================
pagesRoute.get("/black-scholes", zValidator("query", bsQuerySchema), async (c) => {
  const { code } = c.req.valid("query");
  let stockContext: BsStockContext | null = null;
  // CLAUDE.md ルール1: spot=1000, strike=1000, vol=30 等のダミー値を埋めない。
  // 銘柄プリフィル時のみ D1 の実値を入れる。それ以外は null = フォーム空欄。
  let presetSpot: number | null = null;
  let presetStrike: number | null = null;
  let presetVolPct: number | null = null;
  /** プリフィルできなかった理由。以前は `catch {}` で無言だった (silent catch)。 */
  let prefillNotice: string | null = null;

  if (code) {
    const db = createDb(requireDb(c));
    try {
      const [priceCtx, ohlcv] = await Promise.all([
        getPriceContext(db, code),
        getOhlcvSeries(db, code),
      ]);
      const closes = ohlcv.map((r) => r.close);
      const histVol = calcHistoricalVolatility(closes);
      const price = priceCtx.price;
      stockContext = {
        code: priceCtx.code,
        name: priceCtx.name ?? priceCtx.code,
        currentPrice: price,
        historicalVolatility: histVol?.annualizedVolatility ?? null,
        volSampleSize: histVol?.sampleSize ?? null,
        priceAsOf: priceCtx.asOf,
        seriesAsOf: ohlcv.length > 0 ? ohlcv[ohlcv.length - 1].date : null,
      };
      if (price !== null && Number.isFinite(price) && price > 0) {
        presetSpot = Math.round(price * 100) / 100;
        presetStrike = Math.round(price * 100) / 100; // ATM スタート
      }
      if (histVol) {
        presetVolPct = Math.round(histVol.annualizedVolatility * 1000) / 10;
      }
    } catch (e) {
      prefillNotice = `銘柄 ${code} のプリフィルができません: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return c.html(
    bsPage({
      preset: {
        code,
        spot: presetSpot,
        strike: presetStrike,
        // GET 時に断面からのプリフィルが走った場合のみ「自動」バッジ
        spotAutoFilled: presetSpot !== null && presetSpot > 0,
        strikeAutoFilled: presetStrike !== null && presetStrike > 0,
        volAutoFilled: presetVolPct !== null && presetVolPct > 0,
        daysToExpiry: 90, // 標準的な3ヶ月オプション (会計コンセプトとしての目安、ダミーではない)
        riskFreeRatePct: 0.5, // 日本国債10年利回り近似
        volatilityPct: presetVolPct,
      },
      stockContext,
      result: null,
      impliedVolatility: null,
      ivUnavailableReason: null,
      error: null,
      infoNotice: prefillNotice,
    })
  );
});

// =============================================================================
// GET /emh?type=momentum&... — EMH アノマリースクリーニング
// =============================================================================
// DCF/CAPM/BS は core_stock_financials (断面) と swing_daily_ohlcv (日足) を
// 銘柄 1 件ぶん読む。EMH は「横断スクリーニング」のため母集団が入力。
//
// 母集団は設計選択肢 (b) を採用済み: core.stocks を東証内国普通株
// (共有4文字コード、~3,700) に
// seed (src/cron/universe.ts) し、日次 sync (src/cron/daily.ts) が active かつ equity
// (src/shared/db/active-equity.ts) の core.stock_financials + swing.daily_ohlcv を
// 更新する。EMH はそれを読むため、universeSize = count(core_stocks WHERE active かつ
// equity) は実際に集計可能な母集団と一致する (otakara の優待縛り ~1,600 ではない)。
// small-cap / low-vol / post-earnings の件数と一覧も同じ述語で絞る (日次の対象から
// 外れた非普通株の凍結値を並べない)。is_yutai フラグは 002 専用。
pagesRoute.get("/emh", zValidator("query", emhQuerySchema), async (c) => {
  const q = c.req.valid("query");
  const db = createDb(requireDb(c));

  // 母集団 (active かつ equity) の銘柄数。4 タブ共通の分母。
  // /emh の残る走査行の大半はこの COUNT である。
  const [{ universeSize }] = await db
    .select({ universeSize: sql<number>`count(*)` })
    .from(stocks)
    .where(activeEquityCondition());

  let rows: EmhRow[] = [];
  let totalMatched = 0;
  /** 投影が持つ最長の終値本数。window の実効上限を画面へ出すために使う。 */
  let maxBars = 0;
  /** 投影の最新 as_of。momentum タブの鮮度表示に使う。 */
  let projectionAsOf: string | null = null;
  /** 投影行数 (= 有効な終値を持つ active 銘柄数)。 */
  let projectedStocks = 0;
  /**
   * momentum 以外のタブが出す最新 OHLCV 日付。
   *
   * momentum では引かない。投影から `as_of` が取れるので、追加の
   * `MAX(swing_daily_ohlcv.date)` は「投影が見ていない行」を根拠に鮮度を
   * 名乗ることになり、表示と数値の出所がずれる。
   */
  let latestDate: string | null = null;

  if (q.type === "momentum") {
    // L2 投影 (p_momentum) だけを読む。1 銘柄 1 行なので走査は銘柄数。
    // 投影が持つのは終値列そのものなので window は可変のまま、数値は変わらない。
    const projected = await db
      .select({
        stockId: momentumProjection.stockId,
        bars: momentumProjection.bars,
        closes: momentumProjection.closes,
        asOf: momentumProjection.asOf,
      })
      .from(momentumProjection);

    type Score = { stockId: number; cumRet: number; risk: number };
    const scores: Score[] = [];
    for (const row of projected) {
      const m = calcMomentum(decodeCloses(row.closes), q.window);
      if (m) scores.push({ stockId: row.stockId, cumRet: m.cumulativeReturn, risk: m.riskAdjustedScore });
      if (row.bars > maxBars) maxBars = row.bars;
      if (projectionAsOf === null || row.asOf > projectionAsOf) projectionAsOf = row.asOf;
    }
    projectedStocks = projected.length;
    totalMatched = scores.length;

    // 累積リターン降順で limit 件
    scores.sort((a, b) => b.cumRet - a.cumRet);
    const top = scores.slice(0, q.limit);

    // 銘柄情報を一括取得
    const ids = top.map((s) => s.stockId);
    const stockRows = ids.length > 0
      ? await db
          .select({
            id: stocks.id,
            code: stocks.code,
            name: stocks.name,
            // JPX 由来の業種は公開面へ出さない (src/shared/db/public-columns.ts)。
            sector: publicSectorColumn,
            price: stockFinancials.price,
          })
          .from(stocks)
          .leftJoin(stockFinancials, eq(stockFinancials.stockId, stocks.id))
          .where(inArray(stocks.id, ids))
      : [];
    const stockMap = new Map(stockRows.map((s) => [s.id, s]));

    rows = top.map((s) => {
      const st = stockMap.get(s.stockId);
      return {
        code: st?.code ?? "?",
        name: st?.name ?? "?",
        sector: st?.sector ?? null,
        metric: s.cumRet,
        secondary: s.risk,
        price: st?.price ?? null,
      };
    });
  } else {
    // momentum 以外は従来どおり断面 (stock_financials / stock_indicators) を読む。
    // これらは既に 1 銘柄 1 行で、走査行は母集団サイズのままなので投影は要らない。
    const [{ maxOhlcvDate }] = await db
      .select({ maxOhlcvDate: sql<string | null>`MAX(${dailyOhlcv.date})` })
      .from(dailyOhlcv);
    latestDate = maxOhlcvDate;
  }

  if (q.type === "small-cap") {
    const thresholdYen = q.smallCapMaxOku * 1e8;
    // 件数と行を 1 クエリに畳む (L-48)。window 関数は LIMIT の前に評価される
    // ので、over() の値はページ切り捨て前の総件数になる。
    const records = await db
      .select({
        code: stocks.code,
        name: stocks.name,
        // JPX 由来の業種は公開面へ出さない (src/shared/db/public-columns.ts)。
        sector: publicSectorColumn,
        marketCap: stockFinancials.marketCap,
        price: stockFinancials.price,
        stockId: stocks.id,
        matchedTotal: sql<number>`count(*) over()`,
      })
      .from(stockFinancials)
      .innerJoin(stocks, and(eq(stockFinancials.stockId, stocks.id), activeEquityCondition()))
      .where(and(isNotNull(stockFinancials.marketCap), gt(stockFinancials.marketCap, 0), lt(stockFinancials.marketCap, thresholdYen)))
      .orderBy(asc(stockFinancials.marketCap))
      .limit(q.limit);
    totalMatched = records[0]?.matchedTotal ?? 0;

    // 前日比% を indicators から取得
    const ids = records.map((r) => r.stockId);
    const indMap = new Map<number, number | null>();
    if (ids.length > 0) {
      const inds = await db
        .select({ stockId: stockIndicators.stockId, pct: stockIndicators.pctChange1d })
        .from(stockIndicators)
        .where(inArray(stockIndicators.stockId, ids));
      for (const i of inds) indMap.set(i.stockId, i.pct);
    }

    rows = records.map((r) => ({
      code: r.code,
      name: r.name,
      sector: r.sector,
      metric: r.marketCap,
      secondary: indMap.get(r.stockId) ?? null,
      price: r.price,
    }));
  } else if (q.type === "low-vol") {
    const threshold = q.lowVolMaxAtrPct;
    // 件数と行を 1 クエリに畳む (L-48)。window 関数は LIMIT の前に評価される
    // ので、over() の値はページ切り捨て前の総件数になる。
    // 低ボラ + 過去 20 日リターンを計算する用に OHLCV を取得
    const records = await db
      .select({
        stockId: stocks.id,
        code: stocks.code,
        name: stocks.name,
        // JPX 由来の業種は公開面へ出さない (src/shared/db/public-columns.ts)。
        sector: publicSectorColumn,
        atrPct: stockIndicators.atrPct,
        price: stockFinancials.price,
        matchedTotal: sql<number>`count(*) over()`,
      })
      .from(stockIndicators)
      .innerJoin(stocks, and(eq(stockIndicators.stockId, stocks.id), activeEquityCondition()))
      .leftJoin(stockFinancials, eq(stockFinancials.stockId, stocks.id))
      .where(and(isNotNull(stockIndicators.atrPct), gt(stockIndicators.atrPct, 0), lt(stockIndicators.atrPct, threshold)))
      .orderBy(asc(stockIndicators.atrPct))
      .limit(q.limit);
    totalMatched = records[0]?.matchedTotal ?? 0;

    // 各銘柄の 20 日累積リターンを取得 (簡易: 最新 20 営業日分の close を取って計算)
    const ids = records.map((r) => r.stockId);
    const retMap = new Map<number, number | null>();
    if (ids.length > 0) {
      const ohlcv = await db
        .select({ stockId: dailyOhlcv.stockId, close: dailyOhlcv.close, date: dailyOhlcv.date })
        .from(dailyOhlcv)
        .where(inArray(dailyOhlcv.stockId, ids))
        .orderBy(asc(dailyOhlcv.stockId), asc(dailyOhlcv.date));

      const byId = new Map<number, number[]>();
      for (const row of ohlcv) {
        if (row.close === null) continue;
        const arr = byId.get(row.stockId);
        if (arr) arr.push(row.close);
        else byId.set(row.stockId, [row.close]);
      }
      for (const [id, closes] of byId.entries()) {
        if (closes.length < 21) {
          retMap.set(id, null);
          continue;
        }
        const last20 = closes.slice(-21);
        const ret = last20[20] / last20[0] - 1;
        retMap.set(id, ret);
      }
    }

    rows = records.map((r) => ({
      code: r.code,
      name: r.name,
      sector: r.sector,
      metric: r.atrPct,
      secondary: retMap.get(r.stockId) ?? null,
      price: r.price,
    }));
  } else if (q.type === "post-earnings") {
    // 簡易代理: stock_financials.fetched_at 降順 (最近更新された銘柄)
    // 件数と行を 1 クエリに畳む (L-48)。window 関数は LIMIT の前に評価される
    // ので、over() の値はページ切り捨て前の総件数になる。
    const records = await db
      .select({
        stockId: stocks.id,
        code: stocks.code,
        name: stocks.name,
        // JPX 由来の業種は公開面へ出さない (src/shared/db/public-columns.ts)。
        sector: publicSectorColumn,
        price: stockFinancials.price,
        fetchedAt: stockFinancials.fetchedAt,
        matchedTotal: sql<number>`count(*) over()`,
      })
      .from(stockFinancials)
      .innerJoin(stocks, and(eq(stockFinancials.stockId, stocks.id), activeEquityCondition()))
      .orderBy(desc(stockFinancials.fetchedAt))
      .limit(q.limit);
    totalMatched = records[0]?.matchedTotal ?? 0;

    const ids = records.map((r) => r.stockId);
    const indMap = new Map<number, number | null>();
    if (ids.length > 0) {
      const inds = await db
        .select({ stockId: stockIndicators.stockId, pct: stockIndicators.pctChange1d })
        .from(stockIndicators)
        .where(inArray(stockIndicators.stockId, ids));
      for (const i of inds) indMap.set(i.stockId, i.pct);
    }

    rows = records.map((r) => ({
      code: r.code,
      name: r.name,
      sector: r.sector,
      metric: r.fetchedAt instanceof Date ? r.fetchedAt.getTime() : new Date(r.fetchedAt as unknown as string).getTime(),
      secondary: indMap.get(r.stockId) ?? null,
      price: r.price,
    }));
  }

  return c.html(
    emhPage({
      query: q,
      rows,
      totalMatched,
      meta: {
        latestDate: q.type === "momentum" ? projectionAsOf : latestDate,
        universeSize,
        // momentum 以外では投影を読まないので 0 のまま。view は 0 を
        // 「この指標には投影が関係ない」として扱う。
        projectedStocks,
        maxBars,
      },
    })
  );
});

// =============================================================================
// CAPM 用ヘルパー: β を OLS 推定して view props を組み立てる
// =============================================================================

interface CapmViewInput {
  db: D1Database;
  code: string | undefined;
  mode: "auto" | "manual";
  /** β。null = 未入力 (auto モード初期 or manual モード未入力)。CLAUDE.md ルール1 に従い 1.0 等のダミー値は禁止。 */
  beta: number | null;
  riskFreeRatePct: number;
  marketReturnPct: number;
}

export async function buildCapmView(input: CapmViewInput): Promise<Parameters<typeof capmPage>[0]> {
  let stockContext: CapmStockContext | null = null;
  let betaEstimate: ReturnType<typeof estimateBetaOLS> = null;
  let betaUnavailableReason: string | null = null;

  if (input.code) {
    // ここで初めてバインディングを要求する（code 無しなら DB に触らない）
    const db = createDb(requireBinding(input.db, "DB"));
    try {
      // core_stock_financials の断面を読む (日次 sync が writer)。
      // is_active=1 の 3,715 銘柄を完全被覆しているので 1414 のような
      // 優待なし銘柄も取れる。GET が Yahoo を叩くことも書き込むことも無い。
      const priceCtx = await getPriceContext(db, input.code);
      stockContext = {
        code: priceCtx.code,
        name: priceCtx.name ?? priceCtx.code,
        currentPrice: priceCtx.price,
        marketCap: priceCtx.marketCap,
        priceAsOf: priceCtx.asOf,
      };

      if (input.mode === "auto") {
        const result = await estimateBetaForCode(db, input.code);
        if (result.estimate) {
          betaEstimate = result.estimate;
        } else {
          betaUnavailableReason = result.reason;
        }
      }
    } catch (e) {
      betaUnavailableReason = `銘柄 ${input.code} のデータ取得に失敗: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // 計算に使う β を決定: auto なら estimate.beta、manual なら input.beta
  const effectiveBeta: number | null =
    input.mode === "auto" ? betaEstimate?.beta ?? null : input.beta;
  let capmResult = null;
  if (effectiveBeta !== null && Number.isFinite(effectiveBeta)) {
    try {
      capmResult = calcCapmExpectedReturn({
        beta: effectiveBeta,
        riskFreeRate: input.riskFreeRatePct / 100,
        marketReturn: input.marketReturnPct / 100,
      });
    } catch {
      // 入力チェックエラーは error フィールドで扱うため、ここでは無視
    }
  }

  return {
    preset: {
      code: input.code,
      mode: input.mode,
      // 自動推定値があればそれを表示、なければ手動入力値、それも無ければ null (空欄)
      beta: effectiveBeta,
      riskFreeRatePct: input.riskFreeRatePct,
      marketReturnPct: input.marketReturnPct,
    },
    stockContext,
    betaEstimate,
    capmResult,
    betaUnavailableReason,
    error: null,
  };
}

/**
 * 指定銘柄の OHLCV と Nikkei225 (^N225) 日次リターンから β を OLS 推定。
 *
 * 旧実装は `swing.daily_ohlcv` 全銘柄の等加重平均を市場とみなしていたが、
 * これは otakara-yutai がスクレイプした銘柄(~1,600件)に限定されており、
 * 1414 などの未登録銘柄では 0 件しか集まらず β 推定が失敗した。
 *
 * 現行: 対象銘柄は `swing_daily_ohlcv`、市場 (^N225) は
 * `swing_market_context.nikkei_close` を**読むだけ**で取る。日付整合後の
 * 単純リターンで OLS。市場の定義として ^N225 は理論的にも標準的な選択。
 *
 * D1 の保持は銘柄側 90 営業日・市場側は日付が重なる分だけなので、β の数値は
 * 旧実装と変わる。画面はサンプル数を併記する (「サンプル数」セル)。
 * R2 系列ができたらそちらを読む。
 *
 */
async function estimateBetaForCode(
  db: ReturnType<typeof createDb>,
  code: string
): Promise<{ estimate: ReturnType<typeof estimateBetaOLS>; reason: string | null }> {
  // 対象銘柄 + 市場 (^N225) を並列で取得
  const [stockRows, marketRows] = await Promise.all([
    getOhlcvSeries(db, code),
    getOhlcvSeries(db, "^N225"),
  ]);

  if (stockRows.length < 31) {
    return {
      estimate: null,
      reason: `銘柄の日足が ${stockRows.length} 日分しかなく β 推定不能 (最低 31 日必要。D1 の保持は 90 営業日)`,
    };
  }
  if (marketRows.length < 31) {
    return {
      estimate: null,
      reason: `^N225 の系列が ${marketRows.length} 日分しかなく β 推定不能 (swing_market_context は 2026-04-12 開始)`,
    };
  }

  const stockReturnByDate = simpleReturnsByDate(stockRows);
  const marketReturnByDate = simpleReturnsByDate(marketRows);

  // 日付整合 (市場側を基準に走査)
  const stockSeries: number[] = [];
  const marketSeries: number[] = [];
  for (const [date, mret] of marketReturnByDate) {
    const sret = stockReturnByDate.get(date);
    if (sret === undefined || !Number.isFinite(mret)) continue;
    stockSeries.push(sret);
    marketSeries.push(mret);
  }

  if (stockSeries.length < 30) {
    return {
      estimate: null,
      reason: `日付整合後のサンプル数が ${stockSeries.length} で 30 未満 (^N225 と取引日が一致しない可能性)`,
    };
  }

  const estimate = estimateBetaOLS(stockSeries, marketSeries);
  if (!estimate) {
    return { estimate: null, reason: "OLS 計算で市場リターン分散が 0 になり推定不能" };
  }
  return { estimate, reason: null };
}

/** OHLCV 配列から日次単純リターン (前日比) を date キーで返す */
function simpleReturnsByDate(rows: OhlcvBar[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].close;
    const curr = rows[i].close;
    if (
      prev === null ||
      curr === null ||
      !Number.isFinite(prev) ||
      !Number.isFinite(curr) ||
      prev <= 0 ||
      curr <= 0
    ) {
      continue;
    }
    out.set(rows[i].date, curr / prev - 1);
  }
  return out;
}

// 内部ヘルパーをエクスポート (api ルートから再利用)
export { calcLogReturns };
