/**
 * E2E スモーク: CAPM β 自動推定 と BS ヒストリカルボラを 1414 で実行。
 * pnpm tsx services/financial-math/scripts/verify-capm-bs.ts [code]
 */
import "dotenv/config";
import { createDb } from "../src/db/client.js";
import { getOhlcvSeries, getPriceContext } from "../src/services/price-cache.js";
import { buildCapmView } from "../src/routes/pages.js";
import { calcHistoricalVolatility } from "../src/services/volatility.js";

async function main() {
  const code = process.argv[2] ?? "1414";
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  const db = createDb(url);

  console.info(`[verify] === CAPM auto for ${code} (uses ^N225 internally) ===`);
  const capm = await buildCapmView({
    code,
    mode: "auto",
    beta: 1.0,
    riskFreeRatePct: 0.5,
    marketReturnPct: 6,
  });
  console.info({
    stockContext: capm.stockContext,
    betaEstimate: capm.betaEstimate,
    betaUnavailableReason: capm.betaUnavailableReason,
    capmResult: capm.capmResult,
  });

  console.info(`[verify] === BS hist vol for ${code} ===`);
  const ohlcv = await getOhlcvSeries(db, code);
  const histVol = calcHistoricalVolatility(ohlcv.map((r) => r.close));
  const price = (await getPriceContext(db, code)).price;
  console.info({
    samples: ohlcv.length,
    currentPrice: price,
    annualizedVolatility: histVol?.annualizedVolatility,
  });
}

main().catch((e) => {
  console.error("[verify] ERROR:", e);
  process.exit(1);
});
