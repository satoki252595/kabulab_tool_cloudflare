import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { createDb } from "../db/client.js";
import {
  PUBLISH_JPX_DERIVED_COLUMNS,
  SECTOR_DAILY_PUBLIC_KEY_SINCE,
} from "../../../../src/shared/db/public-columns.js";
import { stocks, stockFinancials } from "../db/core-schema.js";
import {
  stockIndicators,
  stockScreening,
  entrySignals,
  marketContext,
  sectorDaily,
} from "../db/schema.js";
import { stockCodeSchema } from "../../../../src/shared/jpx/stock-code-schema.js";
import {
  publicMarketColumn,
  publicSectorColumn,
} from "../../../../src/shared/db/public-columns.js";
import { activeEquityCondition } from "../../../../src/shared/db/active-equity.js";
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
  //
  // `swing_sector_daily.sector` は src/cron/daily.ts が `core_stocks.sector`
  // (= JPX 33 業種) を集約キーにして書いた**保存済みの派生コピー**で、
  // core_stocks を読まないため src/shared/db/public-columns.ts の切り替えが
  // 届かない。実測 (2026-09-13): 他の 6 サービスから JPX 由来を外した後も
  // GET /swing-trading/ だけが「銀行業」「ゴム製品」を返していた。
  //
  // PR #24 はここを同じフラグで**表示ごと**閉じた。業種名を伏せて順位だけ
  // 出す案は採らなかった (業種名の無い業種ランキングは読者にとって意味が無い)。
  //
  // 2026-09-13: 集約キーを書く側 (daily.ts `aggregateSectorDaily`) で
  // `publicSectorColumn` (= `sector33`, EDINET 由来) へ移した。ただし
  // **切り替え前の日付の行は JPX キーのまま表に残る**ので、ガードは外さず
  // 「切り替え後に cron が書いた日付だけ出す」へ変える。
  // 日付と、その日付が正しい前提 (マージ時期 / sector33 の backfill) は
  // `SECTOR_DAILY_PUBLIC_KEY_SINCE` のコメントにまとめてある。
  //
  // 比較に `macro.date` (swing_market_context の最新日付) を使ってよい理由:
  // 下のクエリは `WHERE date = latestSectorDate` なので、**実際に読む行の日付**
  // がこの値そのもの。両表は同じ cron が同じ UTC 日付で書いており、本番の
  // 実測 (2026-09-13, 直近 8 営業日 09-02〜09-11) でも日付の並びが一致した。
  // ずれる日 (マクロ取得の一過性失敗で market_context だけ前日のまま /
  // カバレッジ不足で sector_daily だけ書かない) も、読む日付で判定しているので
  // 切り替え前の行を出すことは無い (前者は前日 = 古い日付を比べて閉じる、
  // 後者はその日付の行が無く空)。
  //
  // 読まない = Worker のプロセスにも載らない。クエリごと飛ばす (rows_read も減る)。
  // 出す日のコスト: `idx_swing_sector_date_rank (date=?)` の SEARCH で
  // 1 表示あたり rows_read 5 (本番の実測)。
  const latestSectorDate = macro?.date;
  let topSectors: Array<{ sector: string; pct1d: number; stockCount: number; rank1d: number }> = [];
  if (
    latestSectorDate &&
    (PUBLISH_JPX_DERIVED_COLUMNS || latestSectorDate >= SECTOR_DAILY_PUBLIC_KEY_SINCE)
  ) {
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
  // totalScreened / passedLong / passedShort は core_stocks を JOIN しないので、
  // 母集団 (active かつ equity) では絞っていない。上場廃止の行と、日次の対象外に
  // なって凍結した行も数える。
  //
  // passedLong / passedShort は、GET /screening に母集団の条件が無かった間は一覧と
  // 同じ集合だった。/screening を母集団で絞ったので、**件数が一覧と食い違う**
  // (本番 2026-09-14: 母集団で数えると long 89 → 88、short 339 → 338。差の内訳は
  // long が上場廃止の行 1、short が非普通株の行 1)。非普通株 9 銘柄の行は
  // 2026-09-13 のユーザー決定で元データから削除するので、削除後に残る差は上場廃止の
  // 行の分だけになる。
  // /screening と同じ CROSS JOIN + 述語で数えれば揃うが、閲覧 1 回の rows_read が
  // long 89 → 178 / short 339 → 678 (同日実測) と倍になる。totalScreened も
  // 3,764 → 7,409 (2026-09-13 実測)。ランニングコストを増やさない制約により採らない。
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
  // entry_signals は日次の母集団 (active かつ equity, src/shared/db/active-equity.ts)
  // の銘柄分のみ集計/表示する。廃止 (is_active=false) 銘柄や、日次の対象外になった
  // 銘柄に古いシグナルが残っても UI に出さない (鮮度のない値を出さない)。
  const [{ totalSignals }] = await db
    .select({ totalSignals: sql<number>`count(*)` })
    .from(entrySignals)
    .innerJoin(stocks, eq(stocks.id, entrySignals.stockId))
    .where(activeEquityCondition());

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
    .where(activeEquityCondition())
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

  // 日次の母集団 (active かつ equity) の銘柄だけを出す。以前はここに is_active の
  // 条件も無く、上場廃止や日次の対象外になった銘柄の screening 行も並びえた。
  //
  // **`core_stocks` は CROSS JOIN + WHERE の等値で結ぶ (INNER JOIN にしない)。**
  // INNER JOIN のまま母集団の述語を足すと、SQLite は `core_stocks` の
  // `idx_core_stocks_active_market (is_active=?)` を外側ループに選び直し、通過銘柄
  // だけを引く `idx_swing_screening_{long,short}` を使わなくなる。本番実測
  // (2026-09-13, rows_read): long 356 → 7,585 / short 1,356 → 8,085。述語を
  // INNER JOIN の ON に移しても計画は同じだった (ON は WHERE と同じ扱い)。
  // SQLite の CROSS JOIN は左表を必ず外側に置くので、計画は変更前と同じ
  // 「screening の索引 → core_stocks の PK → indicators の PK」に戻る
  // (同日実測: long 354 / short 1,354 rows_read。変更前は 356 / 1,356)。
  // 結合条件は WHERE の等値なので、返る行は INNER JOIN と同じ。
  // 順序 (screening → stocks → indicators) は変えていない。
  const whereCondition = and(
    direction === "long"
      ? eq(stockScreening.allPassedLong, true)
      : eq(stockScreening.allPassedShort, true),
    eq(stocks.id, stockScreening.stockId),
    activeEquityCondition()
  );

  const rows = await db
    .select({
      code: stocks.code,
      name: stocks.name,
      // JPX 由来の業種は公開面へ出さない (src/shared/db/public-columns.ts)。
      sector: publicSectorColumn,
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
    // INNER JOIN にしない理由は whereCondition の上のコメント (結合順の固定)。
    .crossJoin(stocks)
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
      // JPX 由来の業種は公開面へ出さない (src/shared/db/public-columns.ts)。
      sector: publicSectorColumn,
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
          .where(activeEquityCondition())
          .orderBy(desc(entrySignals.signalStrength))
          .limit(200)
      : await base
          .where(
            and(activeEquityCondition(), eq(entrySignals.pattern, pattern))
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

  // 列を明示する。`select()` (列指定なし) は core_stocks の全列 = `personal-only` の
  // sector33 / sector17 / instrument_type / license_tag / src_source / quality まで
  // SSR プロセスへ載せてしまう。今は本番で全行 NULL だが、移行 P4b が値を入れた
  // 時点で漏れうる。詰め替え漏れではなくクエリで落とす。
  // (src/shared/db/core-stocks-license-boundary.test.ts が列指定なしを禁じている)
  const [stock] = await db
    .select({
      id: stocks.id,
      code: stocks.code,
      name: stocks.name,
      // JPX 由来は公開面へ出さない (src/shared/db/public-columns.ts)。
      market: publicMarketColumn,
      sector: publicSectorColumn,
    })
    .from(stocks)
    .where(eq(stocks.code, code))
    .limit(1);
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
