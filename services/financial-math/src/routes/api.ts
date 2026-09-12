import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { createDb } from "../db/client.js";
import { dcfFormSchema } from "../validators/dcf.js";
import { capmFormSchema } from "../validators/capm.js";
import { bsFormSchema } from "../validators/black-scholes.js";
import { calcGordonValue, calcTwoStageDcf } from "../services/dcf.js";
import { calcBlackScholes, calcImpliedVolatility } from "../services/black-scholes.js";
import { calcHistoricalVolatility } from "../services/volatility.js";
import { getOhlcvSeries, getPriceContext } from "../services/price-cache.js";
import { dcfPage, type StockContext as DcfStockContext } from "../views/dcf.js";
import { capmPage } from "../views/capm.js";
import { bsPage, type BsStockContext } from "../views/black-scholes.js";
import { buildCapmView } from "./pages.js";
import { errorStatus, requireDb } from "./env.js";

/** API ルーター — POST フォーム送信ハンドラ */
type Bindings = { DB: D1Database };
export const apiRoute = new Hono<{ Bindings: Bindings }>();

// =============================================================================
// POST /api/dcf/calc
// =============================================================================
apiRoute.post(
  "/dcf/calc",
  zValidator("form", dcfFormSchema, (result, c) => {
    // バリデーション失敗時は JSON ではなく HTML フォームを再表示する。
    // 無配銘柄で expectedDividend 未入力等のケースで分かりやすいエラー表示が出る。
    if (!result.success) {
      const firstIssue = result.error.issues[0];
      const message = firstIssue?.message ?? "入力エラーがあります";
      return c.html(
        dcfPage({
          preset: {
            code: undefined,
            mode: "gordon",
            // CLAUDE.md ルール1: expectedDividend は null で渡し、view 側で空欄表示
            expectedDividend: null,
            requiredReturnPct: 7,
            growthRatePct: 3,
            highGrowthYears: 5,
            terminalGrowthPct: 2,
          },
          stockContext: null,
          gordonResult: null,
          twoStageResult: null,
          currentPrice: null,
          error: message,
        }),
        400
      );
    }
  }),
  async (c) => {
  const v = c.req.valid("form");

  // 銘柄コード指定があれば core_stock_financials の断面 (日次 sync が writer) から
  // 現在株価・配当利回りを取得して表示用 context を構築する。
  // 母集団は JPX 一覧由来の東証内国普通株なので 1414 のような優待なし銘柄も拾える。
  // POST でも Yahoo は叩かない (= 計算結果が「誰が押したか」に依存しない)。
  let stockContext: DcfStockContext | null = null;
  let currentPrice: number | null = null;
  let priceFetchError: string | null = null;
  // 銘柄から取れた配当推定値 (上書き判定に使う)
  let stockEstimatedDividend: number | null = null;

  if (v.code) {
    const db = createDb(requireDb(c));
    try {
      const ctx = await getPriceContext(db, v.code);
      currentPrice = ctx.price;
      stockEstimatedDividend = ctx.estimatedDividend;
      stockContext = {
        code: ctx.code,
        name: ctx.name ?? ctx.code,
        currentPrice: ctx.price,
        dividendYield: ctx.dividendYield,
        estimatedDividend: ctx.estimatedDividend,
        estimatedGrowth: null,
        isNonDividend: ctx.estimatedDividend === null || ctx.estimatedDividend <= 0,
      };
    } catch (e) {
      // 断面未登録 / 不正コードなどは UI に出して計算は続行
      priceFetchError = `銘柄 ${v.code} の価格取得に失敗: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // === 銘柄コード指定時の expectedDividend 強制上書き ===
  // 1414 バグ対策: ブラウザ autofill / 古いキャッシュ / 別タブからの遷移等で
  // expectedDividend に古い値 (100 等) が残ったまま submit されると、銘柄コードと
  // 関係ない理論株価 (= 100/0.04 = 2,500 円) が出る。これは UX 的に「銘柄を入れたのに
  // その銘柄と無関係な計算結果」になり混乱の元。
  //
  // 設計: 銘柄コードが指定 + 断面から配当推定値が取れた場合、フォーム送信値を
  // 無視して銘柄プリフィル値で計算する。「配当を手動で試算したい」場合は
  // 銘柄コードを空にして submit すれば従来通り user 入力で計算可能。
  //
  // ※ ルール2 (フォールバック禁止) との整合: これは「ユーザー入力の正規化」ではなく
  //   「銘柄コードを入れた時点でそのデータが正、フォームの古い値は破棄」という
  //   意図的な仕様。サイレントではなく view 側で「銘柄プリフィル値で計算」と明示する。
  // expectedDividend は optional (validator で「code or expectedDividend のどちらか」必須)
  // - 入力あり + code 指定 + 断面の推定値あり: 上書き発動 (フォームの古い値は破棄、銘柄データを優先)
  // - 入力なし + code 指定 + 断面の推定値あり: 断面の推定値で計算 (notice 不要)
  // - 入力あり + code 空: ユーザー手動値で計算
  const overrideKind: "form-override" | "auto-fill" | "user-input" | "none" =
    v.code !== undefined && stockEstimatedDividend !== null && stockEstimatedDividend > 0
      ? v.expectedDividend === undefined
        ? "auto-fill"
        : Math.abs(v.expectedDividend - stockEstimatedDividend) > 0.01
          ? "form-override"
          : "user-input"
      : "user-input";

  const effectiveDividend: number =
    overrideKind === "form-override" || overrideKind === "auto-fill"
      ? Math.round(stockEstimatedDividend! * 100) / 100
      : v.expectedDividend ?? 0; // 0 はここに来ない (validator が弾く)

  // 無配 + ユーザー入力なしの早期エラー: code 指定したが断面に配当データがなく、
  // ユーザーも手動入力していないケース。calcGordonValue が「正の数を」と汎用エラーを
  // 出す前に、より具体的な誘導メッセージを返す。
  if (
    v.code !== undefined &&
    v.expectedDividend === undefined &&
    (stockEstimatedDividend === null || stockEstimatedDividend <= 0)
  ) {
    return c.html(
      dcfPage({
        preset: {
          code: v.code,
          mode: v.mode,
          expectedDividend: null,
          requiredReturnPct: v.raw.requiredReturnPct,
          growthRatePct: v.raw.growthRatePct,
          highGrowthYears: v.raw.highGrowthYears ?? 5,
          terminalGrowthPct: v.raw.terminalGrowthPct ?? 2,
        },
        stockContext,
        gordonResult: null,
        twoStageResult: null,
        currentPrice,
        error: `銘柄 ${v.code} は無配銘柄 (断面に配当利回りなし) のため、Gordon DCF では理論株価を直接算出できません。詳細設定を開いて「来期予想配当」に想定値を手動入力してください (会社 IR の予想配当 / FCF ベース DCF の併用を推奨)。`,
      }),
      400
    );
  }

  const presetEcho = {
    code: v.code,
    mode: v.mode,
    expectedDividend: effectiveDividend > 0 ? effectiveDividend : null,
    expectedDividendAutoFilled:
      overrideKind === "auto-fill" || overrideKind === "form-override",
    requiredReturnPct: v.raw.requiredReturnPct,
    growthRatePct: v.raw.growthRatePct,
    highGrowthYears: v.raw.highGrowthYears ?? 5,
    terminalGrowthPct: v.raw.terminalGrowthPct ?? 2,
  };

  // 上書き / 自動入力が起きたことをユーザーに通知 (silent fallback 禁止 — ルール2)。
  const overrideNotice =
    overrideKind === "form-override"
      ? `銘柄 ${v.code} の推定配当 ${effectiveDividend.toFixed(2)} 円 (日次同期の断面) で計算しました (フォーム入力 ${(v.expectedDividend ?? 0).toFixed(2)} 円より銘柄データを優先)。手動値で計算したい場合は銘柄コード欄を空にして再計算してください。`
      : overrideKind === "auto-fill"
        ? `銘柄 ${v.code} の推定配当 ${effectiveDividend.toFixed(2)} 円 (日次同期の断面) で計算しました (来期予想配当未入力のため自動補完)。手動指定したい場合は詳細設定で値を入力してください。`
        : null;

  try {
    if (v.mode === "gordon") {
      const result = calcGordonValue({
        expectedDividend: effectiveDividend,
        requiredReturn: v.requiredReturn,
        growthRate: v.growthRate,
      });
      return c.html(
        dcfPage({
          preset: presetEcho,
          stockContext,
          gordonResult: result,
          twoStageResult: null,
          currentPrice,
          // データ取得失敗は error (赤)、上書きは info (青) に分離
          error: priceFetchError,
          infoNotice: overrideNotice,
        })
      );
    }
    // two-stage
    const N = v.highGrowthYears ?? 5;
    const gT = v.terminalGrowthRate ?? 0.02;
    const result = calcTwoStageDcf({
      expectedDividend: effectiveDividend,
      requiredReturn: v.requiredReturn,
      highGrowthRate: v.growthRate,
      highGrowthYears: N,
      terminalGrowthRate: gT,
    });
    return c.html(
      dcfPage({
        preset: presetEcho,
        stockContext,
        gordonResult: null,
        twoStageResult: result,
        currentPrice,
        error: priceFetchError,
        infoNotice: overrideNotice,
      })
    );
  } catch (e) {
    const calcErr = e instanceof Error ? e.message : String(e);
    const errMsg = priceFetchError ? `${priceFetchError} / ${calcErr}` : calcErr;
    return c.html(
      dcfPage({
        preset: presetEcho,
        stockContext,
        gordonResult: null,
        twoStageResult: null,
        currentPrice,
        error: errMsg,
        infoNotice: overrideNotice, // 上書きは無関係なので情報として残す
      }),
      errorStatus(e)
    );
  }
});

// =============================================================================
// POST /api/capm/calc
// =============================================================================
apiRoute.post("/capm/calc", zValidator("form", capmFormSchema), async (c) => {
  const v = c.req.valid("form");
  try {
    const view = await buildCapmView({
      // code が無ければ DB に触らないので、ここでは要求しない
      db: c.env?.DB,
      code: v.code,
      mode: v.mode,
      // CLAUDE.md ルール1: フォールバック ?? 1.0 を排除。null のまま渡し、
      // buildCapmView 内で auto 推定 or null 表示の判定が走る。
      beta: v.beta ?? null,
      riskFreeRatePct: v.raw.riskFreeRatePct,
      marketReturnPct: v.raw.marketReturnPct,
    });
    return c.html(capmPage(view));
  } catch (e) {
    return c.html(
      capmPage({
        preset: {
          code: v.code,
          mode: v.mode,
          beta: v.beta ?? null,
          riskFreeRatePct: v.raw.riskFreeRatePct,
          marketReturnPct: v.raw.marketReturnPct,
        },
        stockContext: null,
        betaEstimate: null,
        capmResult: null,
        betaUnavailableReason: null,
        error: e instanceof Error ? e.message : String(e),
      }),
      errorStatus(e)
    );
  }
});

// =============================================================================
// POST /api/black-scholes/calc
// =============================================================================
apiRoute.post("/black-scholes/calc", zValidator("form", bsFormSchema), async (c) => {
  const v = c.req.valid("form");

  let stockContext: BsStockContext | null = null;
  let priceFetchError: string | null = null;
  // 断面 / 日足から取れた値 (effective に流す)
  let stockSpot: number | null = null;
  let stockHistVol: number | null = null;
  if (v.code) {
    const db = createDb(requireDb(c));
    try {
      const [priceCtx, ohlcv] = await Promise.all([
        getPriceContext(db, v.code),
        getOhlcvSeries(db, v.code),
      ]);
      const histVol = calcHistoricalVolatility(ohlcv.map((r) => r.close));
      stockSpot = priceCtx.price;
      stockHistVol = histVol?.annualizedVolatility ?? null;
      stockContext = {
        code: priceCtx.code,
        name: priceCtx.name ?? priceCtx.code,
        currentPrice: priceCtx.price,
        historicalVolatility: stockHistVol,
        volSampleSize: histVol?.sampleSize ?? null,
        priceAsOf: priceCtx.asOf,
        seriesAsOf: ohlcv.length > 0 ? ohlcv[ohlcv.length - 1].date : null,
      };
    } catch (e) {
      priceFetchError = `銘柄 ${v.code} のデータ取得に失敗: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // === effective 値の決定 ===
  // - spot 空 + code 指定 + 断面あり → 現在株価で補完
  // - strike 空 → ATM (= effective spot) で計算
  // - volatility 空 + code 指定 + ヒストリカル σ 取得成功 → 補完
  const effectiveSpot: number | null =
    v.spot ?? (stockSpot !== null && stockSpot > 0 ? stockSpot : null);
  const effectiveStrike: number | null =
    v.strike ?? (effectiveSpot !== null ? effectiveSpot : null); // 未指定なら ATM
  const effectiveVol: number | null =
    v.volatility ?? (stockHistVol !== null && stockHistVol > 0 ? stockHistVol : null);

  // 補完 notice の組み立て (silent fallback 禁止 — ルール2)
  const fillMsgs: string[] = [];
  if (v.spot === undefined && effectiveSpot !== null && stockSpot !== null) {
    fillMsgs.push(`株価 S = ${effectiveSpot.toFixed(2)} 円 (日次同期の断面の株価で自動補完)`);
  }
  if (v.strike === undefined && effectiveStrike !== null) {
    fillMsgs.push(`行使価格 K = ${effectiveStrike.toFixed(2)} 円 (ATM = 現在株価)`);
  }
  if (v.volatility === undefined && effectiveVol !== null && stockHistVol !== null) {
    fillMsgs.push(`ボラ σ = ${(effectiveVol * 100).toFixed(2)}% (ヒストリカル σ で自動補完)`);
  }
  const overrideNotice = fillMsgs.length > 0 ? `自動補完: ${fillMsgs.join(" / ")}` : null;

  const presetEcho = {
    code: v.code,
    spot: effectiveSpot,
    strike: effectiveStrike,
    spotAutoFilled: v.spot === undefined && effectiveSpot !== null,
    strikeAutoFilled: v.strike === undefined && effectiveStrike !== null,
    volAutoFilled: v.volatility === undefined && effectiveVol !== null,
    daysToExpiry: v.raw.daysToExpiry,
    riskFreeRatePct: v.raw.riskFreeRatePct,
    volatilityPct: effectiveVol !== null ? Math.round(effectiveVol * 1000) / 10 : null,
    marketPrice: v.raw.marketPrice,
    ivType: v.raw.ivType,
  };

  // 必須値が揃っているか最終チェック (validator で大抵カバー、念のため)
  if (effectiveSpot === null || effectiveStrike === null || effectiveVol === null) {
    return c.html(
      bsPage({
        preset: presetEcho,
        stockContext,
        result: null,
        impliedVolatility: null,
        ivUnavailableReason: null,
        error: `必要な値が揃っていません${priceFetchError ? ` (${priceFetchError})` : ""}。銘柄コード、または (株価 S と ボラ σ の両方) を入力してください。行使価格 K は未指定なら ATM (= S) で自動計算します。`,
      }),
      400
    );
  }

  try {
    const result = calcBlackScholes({
      spot: effectiveSpot,
      strike: effectiveStrike,
      timeToExpiry: v.timeToExpiry,
      riskFreeRate: v.riskFreeRate,
      volatility: effectiveVol,
    });

    let impliedVolatility: number | null = null;
    let ivUnavailableReason: string | null = null;
    if (v.marketPrice !== undefined && v.marketPrice > 0) {
      impliedVolatility = calcImpliedVolatility({
        marketPrice: v.marketPrice,
        type: v.ivType ?? "call",
        spot: effectiveSpot,
        strike: effectiveStrike,
        timeToExpiry: v.timeToExpiry,
        riskFreeRate: v.riskFreeRate,
      });
      if (impliedVolatility === null) {
        ivUnavailableReason = "市場価格が BS 理論値の範囲外 (σ ∈ [0.1%, 500%])";
      }
    }

    return c.html(
      bsPage({
        preset: presetEcho,
        stockContext,
        result,
        impliedVolatility,
        ivUnavailableReason,
        error: priceFetchError,
        infoNotice: overrideNotice,
      })
    );
  } catch (e) {
    const calcErr = e instanceof Error ? e.message : String(e);
    const combined = priceFetchError ? `${priceFetchError} / ${calcErr}` : calcErr;
    return c.html(
      bsPage({
        preset: presetEcho,
        stockContext,
        result: null,
        impliedVolatility: null,
        ivUnavailableReason: null,
        error: combined,
        infoNotice: overrideNotice,
      }),
      errorStatus(e)
    );
  }
});
