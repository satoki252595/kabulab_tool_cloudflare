/**
 * 004 financial-math の全銘柄 × 全機能 本番テスト
 *
 * 目的: 1,414 のような不適切な計算が他にないか網羅的に検証
 *
 * 対象:
 *   - core.stocks (otakara universe) の active 銘柄 ~1,580 件
 *   - DCF (Gordon, code 指定で Yahoo 上書き経路)
 *   - CAPM (auto モード、β 推定)
 *   - Black-Scholes (現在株価 ATM、90日、自動ボラ)
 *   - EMH (4 種類の anomaly screening、結果妥当性のみ)
 *
 * 妥当性チェック:
 *   - 4xx/5xx エラー
 *   - 結果値が異常 (NaN, Infinity, 株価 100 倍超など)
 *   - 計算ロジックの数学的妥当性
 */
import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import fs from "node:fs/promises";

const BASE = "https://kabulab.vercel.app";
const CONCURRENCY = 5;
const DELAY_MS = 100;
const OUT_DIR = "/tmp/fm_validation";

const sql = neon(process.env.DATABASE_URL);

await fs.mkdir(OUT_DIR, { recursive: true });

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

// ===== 各機能のテスト関数 =====

async function testDcf(code) {
  // POST with code + 100円 (古い値) → Yahoo 推定で上書き発動するはず
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
  const currentPrice = extract(t, '現在株価</div>\\s*<div class="val">([0-9.,—]+)');
  return {
    status: res.status,
    headline: headline ? parseFloat(headline.replace(/,/g, "")) : null,
    echoedD: echoedD ? parseFloat(echoedD) : null,
    currentPrice: currentPrice && currentPrice !== "—" ? parseFloat(currentPrice.replace(/,/g, "")) : null,
    hasInfo, hasNonDiv, hasError,
  };
}

async function testCapm(code) {
  // GET (auto β 推定)
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
  // POST: spot=現在株価, strike=現在株価, 90日, 自動取得した vol
  // まず GET で自動入力された spot/vol を取る
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

// ===== 並列ワーカー =====

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
      if (onProgress && done % 20 === 0) onProgress(done, items.length);
      if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (onProgress) onProgress(items.length, items.length);
  return results;
}

// ===== Main =====

const cmd = process.argv[2] ?? "all"; // all | dcf | capm | bs | emh | summary

if (cmd === "stocks") {
  const rows = await sql`SELECT code, name FROM core.stocks WHERE is_active = true ORDER BY code`;
  await fs.writeFile(`${OUT_DIR}/stocks.json`, JSON.stringify(rows));
  console.log(`Saved ${rows.length} stocks to ${OUT_DIR}/stocks.json`);
  process.exit(0);
}

const stocksJson = await fs.readFile(`${OUT_DIR}/stocks.json`, "utf8").catch(() => null);
if (!stocksJson) {
  console.error("Run 'node scripts/full-validation.mjs stocks' first");
  process.exit(1);
}
const stocks = JSON.parse(stocksJson);
console.log(`Loaded ${stocks.length} stocks`);

const t0 = Date.now();

if (cmd === "dcf" || cmd === "all") {
  console.log(`\n[DCF] Testing ${stocks.length} stocks...`);
  const results = await runWithConcurrency(stocks, CONCURRENCY, async (s) => {
    const r = await testDcf(s.code);
    return { code: s.code, name: s.name, ...r };
  }, (done, total) => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(`  ${done}/${total} (${elapsed}s)\r`);
  });
  await fs.writeFile(`${OUT_DIR}/dcf.json`, JSON.stringify(results));
  console.log(`\n  ✓ DCF results saved to ${OUT_DIR}/dcf.json`);
}

if (cmd === "capm" || cmd === "all") {
  console.log(`\n[CAPM] Testing ${stocks.length} stocks...`);
  const results = await runWithConcurrency(stocks, CONCURRENCY, async (s) => {
    const r = await testCapm(s.code);
    return { code: s.code, name: s.name, ...r };
  }, (done, total) => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(`  ${done}/${total} (${elapsed}s)\r`);
  });
  await fs.writeFile(`${OUT_DIR}/capm.json`, JSON.stringify(results));
  console.log(`\n  ✓ CAPM results saved to ${OUT_DIR}/capm.json`);
}

if (cmd === "bs" || cmd === "all") {
  console.log(`\n[BS] Testing ${stocks.length} stocks...`);
  const results = await runWithConcurrency(stocks, CONCURRENCY, async (s) => {
    const r = await testBs(s.code);
    return { code: s.code, name: s.name, ...r };
  }, (done, total) => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(`  ${done}/${total} (${elapsed}s)\r`);
  });
  await fs.writeFile(`${OUT_DIR}/bs.json`, JSON.stringify(results));
  console.log(`\n  ✓ BS results saved to ${OUT_DIR}/bs.json`);
}

if (cmd === "emh" || cmd === "all") {
  console.log(`\n[EMH] Testing 4 anomaly types...`);
  const types = ["momentum", "small-cap", "low-vol", "post-earnings"];
  const results = {};
  for (const type of types) {
    const r = await fetchWithTimeout(`${BASE}/financial-math/emh?type=${type}&limit=200`);
    const t = await r.text();
    const matched = extract(t, '該当: ([0-9,]+) 件')?.replace(/,/g, "");
    const universe = extract(t, '集計対象: ([0-9,]+) 銘柄')?.replace(/,/g, "");
    // Parse table rows
    const rows = [];
    const trRe = /<tr>\s*<td>(\d+)<\/td>\s*<td><a[^>]*>([0-9]+)<\/a><\/td>\s*<td>([^<]+)<\/td>\s*<td>([^<]+)<\/td>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]+)<\/td>/gs;
    let m;
    while ((m = trRe.exec(t)) !== null) {
      rows.push({
        rank: parseInt(m[1]),
        code: m[2],
        name: m[3].trim(),
        sector: m[4].trim(),
        price: m[5].trim(),
        metric: m[6].replace(/<[^>]+>/g, "").trim(),
        secondary: m[7].replace(/<[^>]+>/g, "").trim(),
      });
    }
    results[type] = {
      status: r.status,
      matched: matched ? parseInt(matched) : null,
      universe: universe ? parseInt(universe) : null,
      topCount: rows.length,
      topRows: rows.slice(0, 10),
    };
    console.log(`  ${type}: status=${r.status}, matched=${matched}, top rows parsed=${rows.length}`);
  }
  await fs.writeFile(`${OUT_DIR}/emh.json`, JSON.stringify(results, null, 2));
  console.log(`  ✓ EMH results saved to ${OUT_DIR}/emh.json`);
}

const elapsedTotal = ((Date.now() - t0) / 1000).toFixed(0);
console.log(`\nDone in ${elapsedTotal}s`);
