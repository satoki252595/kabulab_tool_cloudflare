/**
 * 東証全銘柄テストの結果集計 (otakara 1,580 + untested 2,180 = 3,747 銘柄全部)
 *
 * 入力:
 *   /tmp/fm_validation/{dcf,capm,bs}.json       (core.stocks 1,580 銘柄)
 *   /tmp/fm_validation/{dcf,capm,bs}_untested.json  (未登録 2,180 銘柄)
 *
 * 出力: 妥当性レポートをコンソールへ
 */
import fs from "node:fs/promises";

const DIR = "/tmp/fm_validation";

function pct(arr, q) { return arr.length === 0 ? null : [...arr].sort((a, b) => a - b)[Math.floor(arr.length * q)]; }
function pctSummary(arr, label) {
  if (arr.length === 0) return `${label}: (空)`;
  const min = pct(arr, 0)?.toFixed(2);
  const p25 = pct(arr, 0.25)?.toFixed(2);
  const p50 = pct(arr, 0.5)?.toFixed(2);
  const p75 = pct(arr, 0.75)?.toFixed(2);
  const max = pct(arr, 0.999)?.toFixed(2);
  return `${label}: n=${arr.length}, min=${min}, p25=${p25}, p50=${p50}, p75=${p75}, max=${max}`;
}

async function load(name) {
  try { return JSON.parse(await fs.readFile(`${DIR}/${name}.json`, "utf8")); } catch { return []; }
}

function mergeResults(core, untested) {
  return [
    ...(core ?? []).map(r => ({ ...r, _source: "core" })),
    ...(untested ?? []).map(r => ({ ...r, _source: "untested" })),
  ];
}

// ============================================================
// DCF
// ============================================================
const dcfCore = await load("dcf");
const dcfUnt = await load("dcf_untested");
const dcf = mergeResults(dcfCore, dcfUnt);
if (dcf.length > 0) {
  console.log(`\n========= DCF 集計 (core: ${dcfCore.length} + untested: ${dcfUnt.length} = ${dcf.length}) =========`);
  const byStatus = {};
  let nonDiv = 0, infoOverride = 0, errCount = 0, okCount = 0;
  let dataFetchFail = 0;
  const headlines = [], margins = [];
  const exceptional = [];

  for (const r of dcf) {
    byStatus[r.status ?? "exception"] = (byStatus[r.status ?? "exception"] ?? 0) + 1;
    if (r._exception) { errCount++; continue; }
    if (r.hasNonDiv) nonDiv++;
    if (r.hasInfo) infoOverride++;
    if (r.hasError) {
      errCount++;
      if (r.errorMsg && /価格取得に失敗|404/.test(r.errorMsg)) dataFetchFail++;
      else exceptional.push({code: r.code, name: r.name, reason: "calc_error", msg: r.errorMsg});
    }
    if (r.status === 200 && r.headline !== null) {
      okCount++;
      headlines.push(r.headline);
      if (r.currentPrice && r.currentPrice > 0) {
        margins.push((r.headline - r.currentPrice) / r.currentPrice * 100);
      }
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
  console.log(`  └ Yahoo データ取得失敗 (未上場/廃止/Yahoo にない): ${dataFetchFail}`);
  console.log("");
  console.log(pctSummary(headlines, "理論株価 [円]"));
  console.log(pctSummary(margins, "割安度 [%]"));

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
// CAPM
// ============================================================
const capmCore = await load("capm");
const capmUnt = await load("capm_untested");
const capm = mergeResults(capmCore, capmUnt);
if (capm.length > 0) {
  console.log(`\n========= CAPM 集計 (n = ${capm.length}) =========`);
  const betas = [];
  let unavailable = 0, errCount = 0;
  const reasons = {};
  const exceptional = [];

  for (const r of capm) {
    if (r._exception) { errCount++; continue; }
    if (r.unavailable) {
      unavailable++;
      const key = r.reason?.slice(0, 50) ?? "(unknown)";
      reasons[key] = (reasons[key] ?? 0) + 1;
      continue;
    }
    if (r.beta !== null && Number.isFinite(r.beta)) {
      betas.push(r.beta);
      if (Math.abs(r.beta) > 5) exceptional.push({code: r.code, name: r.name, beta: r.beta});
    }
  }

  console.log(`β 推定成功: ${betas.length}`);
  console.log(`β 推定不能: ${unavailable}`);
  console.log("  内訳:", reasons);
  console.log(`エラー: ${errCount}`);
  console.log(pctSummary(betas, "β"));
  const negBeta = betas.filter(b => b < 0).length;
  const lowBeta = betas.filter(b => b >= 0 && b < 0.5).length;
  const midBeta = betas.filter(b => b >= 0.5 && b < 1.5).length;
  const highBeta = betas.filter(b => b >= 1.5).length;
  console.log(`  β<0 (逆相関):  ${negBeta}`);
  console.log(`  0≤β<0.5:       ${lowBeta}`);
  console.log(`  0.5≤β<1.5:     ${midBeta}`);
  console.log(`  β≥1.5:         ${highBeta}`);

  if (exceptional.length > 0) console.log(`\n妥当性違反 ${exceptional.length} 件:`, exceptional.slice(0, 10));
  else console.log(`\n✓ 妥当性違反 0 件`);
}

// ============================================================
// BS
// ============================================================
const bsCore = await load("bs");
const bsUnt = await load("bs_untested");
const bs = mergeResults(bsCore, bsUnt);
if (bs.length > 0) {
  console.log(`\n========= BS 集計 (n = ${bs.length}) =========`);
  let errCount = 0, unavailable = 0;
  const callPrices = [], putPrices = [], callToSpot = [], putToSpot = [];
  const exceptional = [];

  for (const r of bs) {
    if (r._exception) { errCount++; continue; }
    if (!r.callPrice || !r.putPrice || !r.spot) { unavailable++; continue; }
    callPrices.push(r.callPrice);
    putPrices.push(r.putPrice);
    callToSpot.push(r.callPrice / r.spot);
    putToSpot.push(r.putPrice / r.spot);
    if (r.callPrice < 0) exceptional.push({code: r.code, reason: "call_negative", val: r.callPrice});
    if (r.putPrice < 0) exceptional.push({code: r.code, reason: "put_negative", val: r.putPrice});
    if (r.callPrice > r.spot * 1.1) exceptional.push({code: r.code, name: r.name, reason: "call_exceeds_spot", call: r.callPrice, spot: r.spot});
    if (r.putPrice > r.spot * 1.1) exceptional.push({code: r.code, name: r.name, reason: "put_exceeds_spot", put: r.putPrice, spot: r.spot});
    const parity = r.spot * (1 - Math.exp(-0.005 * 90 / 365));
    const cmp = r.callPrice - r.putPrice;
    if (Math.abs(cmp - parity) > r.spot * 0.005) {
      exceptional.push({code: r.code, name: r.name, reason: "parity_violation", expected: parity.toFixed(2), actual: cmp.toFixed(2)});
    }
  }

  console.log(`成功 (call/put 両方): ${callPrices.length}`);
  console.log(`データ不足/未取得: ${unavailable}`);
  console.log(`エラー: ${errCount}`);
  console.log(pctSummary(callPrices, "Call [円]"));
  console.log(pctSummary(putPrices, "Put  [円]"));
  console.log(pctSummary(callToSpot.map(x => x * 100), "Call/Spot比率 [%]"));

  if (exceptional.length > 0) {
    const groupBy = {};
    for (const e of exceptional) groupBy[e.reason] = (groupBy[e.reason] ?? 0) + 1;
    console.log(`\n妥当性違反 ${exceptional.length} 件:`);
    console.log("  種別:", groupBy);
    for (const e of exceptional.slice(0, 10)) console.log(`  ${e.code} ${e.name ?? ""} ${e.reason} ${JSON.stringify(e)}`);
  } else {
    console.log(`\n✓ 妥当性違反 0 件`);
  }
}

console.log("\n========= 完了 =========");
