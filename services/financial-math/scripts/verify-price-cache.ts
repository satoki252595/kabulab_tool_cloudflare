/**
 * E2E スモーク: finmath キャッシュ + Yahoo 二次利用が
 *   1) price snapshot を埋める
 *   2) daily ohlcv を 5y 分埋める
 *   3) ^N225 でも同じパスが通る
 *   4) 2 回目は cacheHit / 行追加なし
 * を一気に確認する。
 *
 *   pnpm tsx services/financial-math/scripts/verify-price-cache.ts [code]
 */
import "dotenv/config";
import { createDb } from "../src/db/client.js";
import { getOhlcvSeries, getPriceContext } from "../src/services/price-cache.js";

async function main() {
  const code = process.argv[2] ?? "1414";
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  const db = createDb(url);

  console.info(`[verify] === getPriceContext(${code}) — 1st call ===`);
  const p1 = await getPriceContext(db, code);
  console.info({
    code: p1.code,
    name: p1.name,
    price: p1.price,
    dividendYield: p1.dividendYield,
    marketCap: p1.marketCap,
    cacheHit: p1.cacheHit,
  });

  console.info(`[verify] === getPriceContext(${code}) — 2nd call (cache) ===`);
  const p2 = await getPriceContext(db, code);
  console.info({ cacheHit: p2.cacheHit, sameFetchedAt: p1.fetchedAt.getTime() === p2.fetchedAt.getTime() });

  console.info(`[verify] === getOhlcvSeries(${code}) — 1st call ===`);
  const s1 = await getOhlcvSeries(db, code);
  console.info({ length: s1.length, first: s1[0], last: s1[s1.length - 1] });

  console.info(`[verify] === getOhlcvSeries(${code}) — 2nd call (cache) ===`);
  const t0 = Date.now();
  const s2 = await getOhlcvSeries(db, code);
  console.info({ length: s2.length, ms: Date.now() - t0, sameLength: s1.length === s2.length });

  console.info(`[verify] === getOhlcvSeries("^N225") — 1st call ===`);
  const m1 = await getOhlcvSeries(db, "^N225");
  console.info({ length: m1.length, first: m1[0], last: m1[m1.length - 1] });

  console.info(`[verify] === getOhlcvSeries("^N225") — 2nd call (cache) ===`);
  const t1 = Date.now();
  const m2 = await getOhlcvSeries(db, "^N225");
  console.info({ length: m2.length, ms: Date.now() - t1 });
}

main().catch((e) => {
  console.error("[verify] ERROR:", e);
  process.exit(1);
});
