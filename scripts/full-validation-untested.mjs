/**
 * core.stocks 未登録 (=otakara universe 外) の東証銘柄 ~2,180 件を
 * 004 financial-math の DCF/CAPM/BS で本番テスト。
 *
 * /tmp/fm_validation/jpx_untested.json を読む。
 * 結果を /tmp/fm_validation/{dcf,capm,bs}_untested.json に保存。
 *
 * Yahoo rate limit 対策で並列度 3、delay 200ms (= ~15 req/sec)。
 */
import "dotenv/config";
import fs from "node:fs/promises";

const BASE = "https://kabulab.vercel.app";
const CONCURRENCY = 3;
const DELAY_MS = 200;
const OUT_DIR = "/tmp/fm_validation";

async function fetchWithTimeout(url, opts = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

function extract(t, pattern, flags = "s") {
  const m = new RegExp(pattern, flags).exec(t);
  return m ? m[1] : null;
}

async function testDcf(code) {
  const res = await fetchWithTimeout(`${BASE}/financial-math/api/dcf/calc`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, mode: "gordon",
      expectedDividend: "100", requiredReturnPct: "7", growthRatePct: "3",
    }).toString(),
  });
  const t = await res.text();
  const headline = extract(t, 'class="result-headline">([0-9.,]+)');
  const echoedD = extract(t, '<input[^>]*name="expectedDividend"[^>]*?value="([^"]*)"');
  const hasInfo = /notice notice--info/.test(t);
  const hasNonDiv = /⚠ 無配銘柄/.test(t);
  const hasError = /notice notice--error/.test(t);
  const errorMsg = extract(t, 'notice notice--error">[^<]*<span class="title-badge">ERROR</span>[^<]*<strong>[^<]+</strong>([^<]*)');
  const currentPrice = extract(t, '現在株価</div>\\s*<div class="val">([0-9.,—]+)');
  return {
    status: res.status,
    headline: headline ? parseFloat(headline.replace(/,/g, "")) : null,
    echoedD: echoedD ? parseFloat(echoedD) : null,
    currentPrice: currentPrice && currentPrice !== "—" ? parseFloat(currentPrice.replace(/,/g, "")) : null,
    hasInfo, hasNonDiv, hasError,
    errorMsg: errorMsg ? errorMsg.trim().slice(0, 100) : null,
  };
}

async function testCapm(code) {
  const res = await fetchWithTimeout(`${BASE}/financial-math/capm?code=${code}`);
  const t = await res.text();
  const betaStr = extract(t, 'name="beta"[^>]*?value="([^"]*)"');
  const beta = betaStr && betaStr !== "" ? parseFloat(betaStr) : null;
  const unavailable = /β を自動推定できません/.test(t);
  const reason = extract(t, '<strong>β を自動推定できません</strong>([^<]+)');
  return {
    status: res.status,
    beta,
    unavailable,
    reason: reason?.trim().slice(0, 100) ?? null,
  };
}

async function testBs(code) {
  const r1 = await fetchWithTimeout(`${BASE}/financial-math/black-scholes?code=${code}`);
  const t1 = await r1.text();
  const spot = extract(t1, 'name="spot"[^>]*?value="([^"]*)"');
  const vol = extract(t1, 'name="volatilityPct"[^>]*?value="([^"]*)"');
  if (!spot || spot === "" || !vol || vol === "") {
    return { status: r1.status, headline: null, reason: "GET で spot/vol が取れなかった" };
  }
  const res = await fetchWithTimeout(`${BASE}/financial-math/api/black-scholes/calc`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, spot, strike: spot, daysToExpiry: "90",
      riskFreeRatePct: "0.5", volatilityPct: vol,
    }).toString(),
  });
  const t = await res.text();
  const callPrice = extract(t, 'CALL.{0,200}?class="result-headline"[^>]*>([0-9.,]+)');
  const putPrice = extract(t, 'PUT.{0,200}?class="result-headline"[^>]*>([0-9.,]+)');
  return {
    status: res.status,
    spot: parseFloat(spot),
    vol: parseFloat(vol),
    callPrice: callPrice ? parseFloat(callPrice.replace(/,/g, "")) : null,
    putPrice: putPrice ? parseFloat(putPrice.replace(/,/g, "")) : null,
  };
}

async function runWithConcurrency(items, concurrency, taskFn, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await taskFn(items[i], i);
      } catch (e) {
        results[i] = { _exception: String(e).slice(0, 200), item: items[i] };
      }
      done++;
      if (onProgress && done % 50 === 0) onProgress(done, items.length);
      if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (onProgress) onProgress(items.length, items.length);
  return results;
}

const cmd = process.argv[2] ?? "dcf";
const stocksJson = await fs.readFile(`${OUT_DIR}/jpx_untested.json`, "utf8");
const stocks = JSON.parse(stocksJson);
console.log(`Loaded ${stocks.length} untested stocks (core.stocks 未登録)`);
console.log(`Test: ${cmd}, concurrency: ${CONCURRENCY}, delay: ${DELAY_MS}ms`);

const t0 = Date.now();

const tasks = {
  dcf: { fn: testDcf, out: "dcf_untested" },
  capm: { fn: testCapm, out: "capm_untested" },
  bs: { fn: testBs, out: "bs_untested" },
};
const task = tasks[cmd];
if (!task) { console.error(`unknown cmd: ${cmd}`); process.exit(1); }

const results = await runWithConcurrency(stocks, CONCURRENCY, async (s) => {
  const r = await task.fn(s.code);
  return { code: s.code, name: s.name, market: s.marketCategory, ...r };
}, (done, total) => {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  const eta = total > done ? ((total - done) * (Date.now() - t0) / done / 1000).toFixed(0) : "0";
  process.stdout.write(`  ${done}/${total} (${elapsed}s, ETA ${eta}s)\r`);
});
await fs.writeFile(`${OUT_DIR}/${task.out}.json`, JSON.stringify(results));
const elapsedTotal = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\n  ✓ ${task.out} saved (${results.length} 件、${elapsedTotal}s)`);
