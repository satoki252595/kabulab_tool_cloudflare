/** 保存422が確定した5銘柄だけの明示期間回復。通常rangeの代替には使わない。 */
import { createHash } from "node:crypto";
import { marketClosure } from "../../../src/shared/market-calendar.js";
import { isStrictIsoUtc, jstDateSec } from "../../../src/shared/vwap/proof.js";
import type { YahooRawCapture } from "../../../src/shared/yahoo/client.js";

const RECOVERY_CODES = new Set(["593A", "598A", "603A", "604A", "607A"]);
const DAY = 86400;
export interface IntraRecoveryWindow { from: string; toExclusive: string; period1: number; period2: number }
export interface IntraRecoveryProof extends IntraRecoveryWindow {
  sourceUrl: string; observedAt: string; rawSha256: string;
  rawBars: number; firstTs: number | null; lastTs: number | null;
}
function fail(): never { throw new Error("5分足明示回復: 対象・実clock・60日内のJP営業窓が不一致です"); }
function seconds(value: string): number {
  if (!isStrictIsoUtc(value) || Date.parse(value) % 1000 !== 0) fail();
  return Date.parse(value) / 1000;
}
function validateWindow(window: IntraRecoveryWindow, now: string): void {
  if (!isStrictIsoUtc(now)) fail();
  const at = Date.parse(now) / 1000, from = seconds(window.from), to = seconds(window.toExclusive);
  if (window.period1 !== from || window.period2 !== to || from >= to || to > at || from < at - 60 * DAY) fail();
  // 60日前より後の最初の公表済み営業日の寄付き。短い窓を60日回復とは呼ばない。
  let first = Math.ceil((at - 60 * DAY) / DAY) * DAY;
  while (marketClosure("JPX", jstDateSec(first)) !== null) first += DAY;
  // 引けauctionの実timestamp15:30を含むため、exclusiveは引け+1秒。
  let last = Date.parse(`${jstDateSec(at)}T06:30:01Z`) / 1000;
  if (last > at) last -= DAY;
  while (marketClosure("JPX", jstDateSec(last)) !== null) last -= DAY;
  if (from !== first || to !== last) fail();
}

export function resolveIntraRecoveryWindow(args: {
  from?: string; toExclusive?: string; codes?: string; range?: string; limit?: string; now: string;
}): IntraRecoveryWindow | null {
  if (args.from === undefined && args.toExclusive === undefined) return null;
  if (!args.from || !args.toExclusive || !args.codes || args.range !== undefined || args.limit !== undefined) fail();
  const codes = args.codes.split(",");
  if (new Set(codes).size !== codes.length || codes.some(code => !RECOVERY_CODES.has(code))) fail();
  const window = { from: args.from, toExclusive: args.toExclusive, period1: seconds(args.from), period2: seconds(args.toExclusive) };
  validateWindow(window, args.now);
  return window;
}

/** 全raw timestampを検証。v0/null除去後の範囲へ読み替えない。 */
export function proveIntraRecoveryCapture(capture: YahooRawCapture, window: IntraRecoveryWindow, symbol: string): IntraRecoveryProof {
  if (!RECOVERY_CODES.has(symbol.replace(/\.T$/, "")) || !symbol.endsWith(".T") || capture.symbol !== symbol || capture.status !== 200) fail();
  validateWindow(window, capture.receivedAt);
  let url = new URL(capture.url);
  if (url.searchParams.has("u")) url = new URL(url.searchParams.get("u")!);
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password || url.hash !== "" ||
      !["query1.finance.yahoo.com", "query2.finance.yahoo.com"].includes(url.hostname) ||
      decodeURIComponent(url.pathname) !== `/v8/finance/chart/${symbol}` ||
      url.searchParams.getAll("period1").length !== 1 || url.searchParams.get("period1") !== String(window.period1) ||
      url.searchParams.getAll("period2").length !== 1 || url.searchParams.get("period2") !== String(window.period2) ||
      url.searchParams.getAll("interval").length !== 1 || url.searchParams.get("interval") !== "5m" ||
      [...url.searchParams.keys()].some(key => !["period1", "period2", "interval"].includes(key))) fail();
  const json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(capture.bytes)) as {
    chart?: { error?: unknown; result?: Array<{ meta?: { symbol?: unknown; currency?: unknown; instrumentType?: unknown;
      dataGranularity?: unknown; exchangeTimezoneName?: unknown }; timestamp?: unknown }> };
  };
  const result = json.chart?.result;
  if (json.chart?.error || !Array.isArray(result) || result.length !== 1) fail();
  const meta = result[0].meta, stamps = result[0].timestamp;
  if (meta?.symbol !== symbol || meta.currency !== "JPY" || meta.instrumentType !== "EQUITY" || meta.dataGranularity !== "5m" ||
      meta.exchangeTimezoneName !== "Asia/Tokyo" || !Array.isArray(stamps) || stamps.length === 0) fail();
  if (typeof stamps.at(-1) !== "number" || jstDateSec(stamps.at(-1)) !== jstDateSec(window.period2 - 1)) fail();
  for (let i = 0; i < stamps.length; i++) {
    const ts: unknown = stamps[i];
    if (typeof ts !== "number" || !Number.isSafeInteger(ts) || ts % 300 !== 0 ||
        ts < window.period1 || ts >= window.period2 || (i > 0 && (stamps[i - 1] as number) >= ts) ||
        marketClosure("JPX", jstDateSec(ts)) !== null) fail();
    const time = ((ts + 32400) % DAY + DAY) % DAY;
    if (!(time >= 9 * 3600 && time <= 11.5 * 3600 || time >= 12.5 * 3600 && time <= 15.5 * 3600)) fail();
  }
  return { ...window, sourceUrl: url.toString(), observedAt: capture.receivedAt,
    rawSha256: createHash("sha256").update(capture.bytes).digest("hex"), rawBars: stamps.length,
    firstTs: stamps.length === 0 ? null : stamps[0] as number,
    lastTs: stamps.length === 0 ? null : stamps.at(-1) as number };
}
