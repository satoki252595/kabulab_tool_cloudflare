/**
 * 全銘柄テスト結果の集計・妥当性チェック
 *
 * 入力: /tmp/fm_validation/{dcf,capm,bs,emh}.json
 * 出力: コンソールに集計レポート、異常値リスト
 */
import fs from "node:fs/promises";

const DIR = "/tmp/fm_validation";

function pctSummary(arr, label) {
  if (arr.length === 0) return `${label}: (空)`;
  const sorted = [...arr].sort((a, b) => a - b);
  const p = (q) => sorted[Math.floor(sorted.length * q)];
  return `${label}: n=${arr.length}, min=${p(0).toFixed(2)}, p25=${p(0.25).toFixed(2)}, p50=${p(0.5).toFixed(2)}, p75=${p(0.75).toFixed(2)}, max=${p(0.999).toFixed(2)}`;
}

async function load(name) {
  try {
    return JSON.parse(await fs.readFile(`${DIR}/${name}.json`, "utf8"));
  } catch {
    return null;
  }
}

// ============================================================
// DCF 妥当性チェック
// ============================================================
const dcf = await load("dcf");
if (dcf) {
  console.log("\n========= DCF 集計 (n = " + dcf.length + ") =========");
  const byStatus = {};
  let nonDiv = 0;
  let infoOverride = 0;
  let errCount = 0;
  let okCount = 0;
  const headlines = [];
  const margins = [];
  const exceptional = []; // 妥当性違反

  for (const r of dcf) {
    byStatus[r.status ?? "exception"] = (byStatus[r.status ?? "exception"] ?? 0) + 1;
    if (r._exception) { errCount++; exceptional.push({code: r.code, reason: "exception", detail: r._exception}); continue; }
    if (r.hasNonDiv) nonDiv++;
    if (r.hasInfo) infoOverride++;
    if (r.hasError) errCount++;
    if (r.status === 200 && r.headline !== null) {
      okCount++;
      headlines.push(r.headline);
      if (r.currentPrice && r.currentPrice > 0) {
        const margin = (r.headline - r.currentPrice) / r.currentPrice * 100;
        margins.push(margin);
      }
      // 妥当性: headline が NaN, Infinity, 0 以下, 株価×500倍超
      if (!Number.isFinite(r.headline)) exceptional.push({code: r.code, reason: "headline_not_finite", val: r.headline});
      if (r.headline <= 0) exceptional.push({code: r.code, reason: "headline_non_positive", val: r.headline});
      if (r.currentPrice && r.headline > r.currentPrice * 500) {
        exceptional.push({code: r.code, name: r.name, reason: "extreme_high", headline: r.headline, price: r.currentPrice, ratio: (r.headline / r.currentPrice).toFixed(1) + "x"});
      }
    }
  }

  console.log("HTTP status:", byStatus);
  console.log(`OK (status=200 + headline あり): ${okCount}`);
  console.log(`無配 (notice 表示): ${nonDiv}`);
  console.log(`Yahoo 上書き (INFO notice): ${infoOverride}`);
  console.log(`エラー (4xx/5xx/exception): ${errCount}`);
  console.log("");
  console.log(pctSummary(headlines, "理論株価 [円]"));
  console.log(pctSummary(margins, "割安度 [%]  "));

  // 「2500円固定」 が複数銘柄で出ていないか?
  const exactly2500 = dcf.filter(r => r.headline === 2500 && r.code);
  console.log(`\n理論株価 == 2,500 円: ${exactly2500.length} 件`);
  if (exactly2500.length > 0 && exactly2500.length < 20) {
    for (const r of exactly2500) console.log(`  ${r.code} ${r.name} echoedD=${r.echoedD} (上書き=${r.hasInfo})`);
  }

  if (exceptional.length > 0) {
    console.log(`\n妥当性違反 ${exceptional.length} 件:`);
    for (const e of exceptional.slice(0, 20)) {
      console.log(`  ${e.code} ${e.name ?? ""} ${e.reason} ${JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['code','name','reason'].includes(k))))}`);
    }
  } else {
    console.log(`\n✓ 妥当性違反 0 件`);
  }
}

// ============================================================
// CAPM 妥当性チェック
// ============================================================
const capm = await load("capm");
if (capm) {
  console.log("\n========= CAPM 集計 (n = " + capm.length + ") =========");
  const betas = [];
  let unavailable = 0;
  let errCount = 0;
  const exceptional = [];

  for (const r of capm) {
    if (r._exception) { errCount++; exceptional.push({code: r.code, reason: "exception", detail: r._exception}); continue; }
    if (r.unavailable) { unavailable++; continue; }
    if (r.beta !== null && Number.isFinite(r.beta)) {
      betas.push(r.beta);
      // 妥当性: β は通常 -2 〜 +3 程度。±5 超は要調査
      if (Math.abs(r.beta) > 5) exceptional.push({code: r.code, name: r.name, reason: "extreme_beta", beta: r.beta});
    }
  }

  console.log(`β 推定成功: ${betas.length}`);
  console.log(`β 推定不能 (データ不足等): ${unavailable}`);
  console.log(`エラー: ${errCount}`);
  console.log(pctSummary(betas, "β        "));

  // β 分布
  const negBeta = betas.filter(b => b < 0).length;
  const lowBeta = betas.filter(b => b >= 0 && b < 0.5).length;
  const midBeta = betas.filter(b => b >= 0.5 && b < 1.5).length;
  const highBeta = betas.filter(b => b >= 1.5).length;
  console.log(`  β<0 (逆相関):     ${negBeta}`);
  console.log(`  0≤β<0.5 (低β):    ${lowBeta}`);
  console.log(`  0.5≤β<1.5 (中):   ${midBeta}`);
  console.log(`  β≥1.5 (高β):      ${highBeta}`);

  if (exceptional.length > 0) {
    console.log(`\n妥当性違反 ${exceptional.length} 件:`);
    for (const e of exceptional.slice(0, 10)) console.log(`  ${e.code} ${e.name ?? ""} ${e.reason} ${JSON.stringify(e)}`);
  } else {
    console.log(`\n✓ 妥当性違反 0 件`);
  }
}

// ============================================================
// BS 妥当性チェック
// ============================================================
const bs = await load("bs");
if (bs) {
  console.log("\n========= BS 集計 (n = " + bs.length + ") =========");
  let errCount = 0;
  let unavailable = 0;
  const callPrices = [];
  const putPrices = [];
  const callToSpot = []; // ATM call / spot 比率 (理論的に約 vol*√(T/2π))
  const putToSpot = [];
  const exceptional = [];

  for (const r of bs) {
    if (r._exception) { errCount++; exceptional.push({code: r.code, reason: "exception", detail: r._exception}); continue; }
    if (!r.callPrice || !r.putPrice || !r.spot) { unavailable++; continue; }
    callPrices.push(r.callPrice);
    putPrices.push(r.putPrice);
    callToSpot.push(r.callPrice / r.spot);
    putToSpot.push(r.putPrice / r.spot);

    // 妥当性チェック:
    // 1. Call 価格 ≤ S (ATM だと max 約 S)
    // 2. Put 価格 ≤ K (= S for ATM)
    // 3. Call ≥ 0, Put ≥ 0
    // 4. パリティ: C - P ≈ S - K·e^(-rT) (ATM, r=0.5%, T=90/365 → ≈ S × 0.00123)
    if (r.callPrice < 0) exceptional.push({code: r.code, name: r.name, reason: "call_negative", val: r.callPrice});
    if (r.putPrice < 0) exceptional.push({code: r.code, name: r.name, reason: "put_negative", val: r.putPrice});
    if (r.callPrice > r.spot * 1.1) exceptional.push({code: r.code, name: r.name, reason: "call_exceeds_spot", call: r.callPrice, spot: r.spot});
    if (r.putPrice > r.spot * 1.1) exceptional.push({code: r.code, name: r.name, reason: "put_exceeds_spot", put: r.putPrice, spot: r.spot});
    // ATM での C-P がパリティと一致
    const parity = r.spot * (1 - Math.exp(-0.005 * 90 / 365));
    const actualCminusP = r.callPrice - r.putPrice;
    if (Math.abs(actualCminusP - parity) > r.spot * 0.005) {
      exceptional.push({code: r.code, name: r.name, reason: "parity_violation", call: r.callPrice, put: r.putPrice, expected: parity.toFixed(2), actual: actualCminusP.toFixed(2)});
    }
  }

  console.log(`成功 (call/put 両方): ${callPrices.length}`);
  console.log(`データ不足/未取得: ${unavailable}`);
  console.log(`エラー: ${errCount}`);
  console.log("");
  console.log(pctSummary(callPrices, "Call 価格 [円]"));
  console.log(pctSummary(putPrices, "Put  価格 [円]"));
  console.log(pctSummary(callToSpot.map(x => x * 100), "Call/Spot比率 [%]"));
  console.log(pctSummary(putToSpot.map(x => x * 100), "Put/Spot比率 [%]"));

  if (exceptional.length > 0) {
    console.log(`\n妥当性違反 ${exceptional.length} 件:`);
    const groupBy = {};
    for (const e of exceptional) groupBy[e.reason] = (groupBy[e.reason] ?? 0) + 1;
    console.log("  種別:", groupBy);
    for (const e of exceptional.slice(0, 10)) console.log(`  ${e.code} ${e.name ?? ""} ${e.reason} ${JSON.stringify(e)}`);
  } else {
    console.log(`\n✓ 妥当性違反 0 件`);
  }
}

// ============================================================
// EMH 妥当性チェック
// ============================================================
const emh = await load("emh");
if (emh) {
  console.log("\n========= EMH 集計 =========");
  for (const [type, r] of Object.entries(emh)) {
    console.log(`  [${type}] status=${r.status}, matched=${r.matched}/${r.universe}`);
  }
}

console.log("\n========= 完了 =========");
