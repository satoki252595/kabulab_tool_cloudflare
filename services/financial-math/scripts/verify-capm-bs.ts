/**
 * E2E スモーク: CAPM β 自動推定 と BS ヒストリカルボラを 1414 で実行。
 * pnpm tsx services/financial-math/scripts/verify-capm-bs.ts [code]
 *
 * ADR-0001 (Neon → D1) 後の接続:
 *   D1 はバインディング経由でのみ触れるので、Node からは createD1HttpDb
 *   (drizzle sqlite-proxy / D1 REST) で繋ぐ。必要 env は CLOUDFLARE_API_TOKEN /
 *   CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID (未設定なら required で throw)。
 *
 *   ルート側の buildCapmView は `D1Database` バインディングを要求するため
 *   Node からは呼べない。確かめたい実体は β 推定 (estimateBetaForCode) と
 *   期待収益率の計算 (calcCapmExpectedReturn) なので、ラッパ越しではなく
 *   その 2 つを直接叩く。ルートの組み立て自体は
 *   src/tests/integration/routes.test.ts の担当。
 */
import "dotenv/config";
import { createD1HttpDb } from "../../../src/shared/db/d1-http-client.js";
import * as swingSchema from "../src/db/swing-readonly.js";
import type { Database } from "../src/db/client.js";
import { getOhlcvSeries, getPriceContext } from "../src/services/price-cache.js";
import { estimateBetaForCode } from "../src/routes/pages.js";
import { calcCapmExpectedReturn } from "../src/services/capm.js";
import { calcHistoricalVolatility } from "../src/services/volatility.js";

const RISK_FREE_RATE_PCT = 0.5;
const MARKET_RETURN_PCT = 6;

async function main() {
  const code = process.argv[2] ?? "1414";
  // sqlite-proxy (D1 HTTP) と D1 バインディング版は同じ async SQLite クエリビルダ
  // API を持つ (共に BaseSQLiteDatabase)。型クラスのみ異なるためキャストで橋渡し。
  const db = createD1HttpDb({
    ...swingSchema,
  }) as unknown as Database;

  console.info(`[verify] === CAPM auto for ${code} (uses ^N225 internally) ===`);
  const priceCtx = await getPriceContext(db, code);
  const { estimate, reason } = await estimateBetaForCode(db, code);
  // β が推定できなかったときに期待収益率を 1.0 等で埋めない (ルール1)。
  // 「推定できなかった」を null と reason で正直に出す。
  const capmResult =
    estimate && Number.isFinite(estimate.beta)
      ? calcCapmExpectedReturn({
          beta: estimate.beta,
          riskFreeRate: RISK_FREE_RATE_PCT / 100,
          marketReturn: MARKET_RETURN_PCT / 100,
        })
      : null;
  console.info({
    stockContext: {
      code: priceCtx.code,
      name: priceCtx.name ?? priceCtx.code,
      currentPrice: priceCtx.price,
      marketCap: priceCtx.marketCap,
    },
    betaEstimate: estimate,
    betaUnavailableReason: reason,
    capmResult,
  });

  console.info(`[verify] === BS hist vol for ${code} ===`);
  const ohlcv = await getOhlcvSeries(db, code);
  const histVol = calcHistoricalVolatility(ohlcv.map((r) => r.close));
  console.info({
    samples: ohlcv.length,
    currentPrice: priceCtx.price,
    annualizedVolatility: histVol?.annualizedVolatility,
  });
}

main().catch((e) => {
  console.error("[verify] ERROR:", e);
  process.exit(1);
});
