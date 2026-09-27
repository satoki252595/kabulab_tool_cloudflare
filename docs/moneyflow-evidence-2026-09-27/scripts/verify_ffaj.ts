import { readFileSync } from "node:fs";
import {
  parseFfajIndexPage,
  parseTradingVolAndPosition,
  parseOpenPositionWithMc,
  parseDepositAmountInformation,
  resolveFfajOtcFxPeriodStatus,
  toFfajOtcFxObservations,
  parseFfajOtcFxFiles,
  FFAJ_CURRENCY_CODES,
} from "/Users/satoki252595/projects/kabulab-cf/.claude/worktrees/wf_a6c4999f-a98-9/services/moneyflow/lib/sources/ffaj-otc-fx.ts";

const html = readFileSync("/tmp/ffaj-index.html", "utf-8");
const page = parseFfajIndexPage(html);
console.log("=== index page ===");
console.log(JSON.stringify(page, null, 2));

const tradingBytes = new Uint8Array(readFileSync("/tmp/ffaj-trading_vol_and_position.xls"));
const openPosBytes = new Uint8Array(readFileSync("/tmp/ffaj-open_position_with_mc.xls"));
const depositBytes = new Uint8Array(readFileSync("/tmp/ffaj-deposit_amount_information.xls"));

const marketTotal = parseTradingVolAndPosition(tradingBytes);
console.log("\n=== marketTotal rows:", marketTotal.length, "===");
console.log("latest (first row):", JSON.stringify(marketTotal[0]));
console.log("second row:", JSON.stringify(marketTotal[1]));
console.log("oldest row:", JSON.stringify(marketTotal[marketTotal.length - 1]));

const currencyPositions = parseOpenPositionWithMc(openPosBytes);
console.log("\n=== currencyPositions rows:", currencyPositions.length, "===");
const latestMonth = marketTotal[0].month;
for (const c of FFAJ_CURRENCY_CODES) {
  const row = currencyPositions.find((r) => r.month === latestMonth && r.currency === c);
  console.log(c, JSON.stringify(row));
}

const deposits = parseDepositAmountInformation(depositBytes);
console.log("\n=== deposits rows:", deposits.length, "===");
console.log("latest:", JSON.stringify(deposits[0]));
console.log("second:", JSON.stringify(deposits[1]));
console.log("oldest:", JSON.stringify(deposits[deposits.length - 1]));

// check for any "na" cells across full series
const naRows = deposits.filter((d) => d.netChangeYen === null);
console.log("\nna-count:", naRows.length, "months:", naRows.map((d) => d.month));

// cross check: sum of currency turnovers vs ALL(TOTAL) turnover for latest month
const sumCurrencyTurnover = FFAJ_CURRENCY_CODES.reduce((acc, c) => {
  const row = currencyPositions.find((r) => r.month === latestMonth && r.currency === c);
  return acc + (row?.turnoverMillionYen ?? 0);
}, 0);
console.log("\nsum of 9-currency turnover (latest month):", sumCurrencyTurnover);
console.log("ALL(TOTAL) turnover (latest month):", marketTotal[0].turnoverMillionYen);
console.log("ratio:", (sumCurrencyTurnover / marketTotal[0].turnoverMillionYen).toFixed(4));

const sumCurrencyShort = FFAJ_CURRENCY_CODES.reduce((acc, c) => {
  const row = currencyPositions.find((r) => r.month === latestMonth && r.currency === c);
  return acc + (row?.shortPositionMillionYen ?? 0);
}, 0);
const sumCurrencyLong = FFAJ_CURRENCY_CODES.reduce((acc, c) => {
  const row = currencyPositions.find((r) => r.month === latestMonth && r.currency === c);
  return acc + (row?.longPositionMillionYen ?? 0);
}, 0);
console.log("sum 9-currency short:", sumCurrencyShort, "vs ALL(TOTAL) short:", marketTotal[0].shortPositionMillionYen);
console.log("sum 9-currency long:", sumCurrencyLong, "vs ALL(TOTAL) long:", marketTotal[0].longPositionMillionYen);

// verify netLong = long - short for each currency row (latest month)
console.log("\n=== netLong = long - short check (latest month) ===");
for (const c of FFAJ_CURRENCY_CODES) {
  const row = currencyPositions.find((r) => r.month === latestMonth && r.currency === c);
  if (!row) continue;
  const computed = row.longPositionMillionYen - row.shortPositionMillionYen;
  const ok = computed === row.netLongMillionYen;
  console.log(c, "computed=", computed, "reported=", row.netLongMillionYen, ok ? "OK" : "MISMATCH");
}

// period status check
console.log("\n=== period status ===");
console.log("target=latest:", JSON.stringify(resolveFfajOtcFxPeriodStatus(latestMonth, page.latestPublishedMonth)));
const nextMonth = (() => {
  const [y, m] = latestMonth.split("-").map(Number);
  const nm = m === 12 ? 1 : m + 1;
  const ny = m === 12 ? y + 1 : y;
  return `${ny}-${String(nm).padStart(2, "0")}`;
})();
console.log("target=next month (should be not_yet_published):", JSON.stringify(resolveFfajOtcFxPeriodStatus(nextMonth, page.latestPublishedMonth)));

// full parse + observations count sanity
const parsed = parseFfajOtcFxFiles({
  tradingVolAndPosition: tradingBytes,
  openPositionWithMc: openPosBytes,
  depositAmountInformation: depositBytes,
});
const observations = toFfajOtcFxObservations(parsed);
console.log("\nobservations total:", observations.length);
console.log("marketTotal months:", parsed.marketTotal.length, "currencyPositions rows:", parsed.currencyPositions.length, "deposits months:", parsed.deposits.length);

// verify unique months order (ascending or descending?)
console.log("\nmarketTotal month order (first 5):", marketTotal.slice(0, 5).map((r) => r.month));
console.log("deposits month order (first 5):", deposits.slice(0, 5).map((r) => r.month));

// verify deposits vs marketTotal date ranges match up count-wise
console.log("\nmarketTotal total rows:", marketTotal.length, "deposits total rows:", deposits.length);
