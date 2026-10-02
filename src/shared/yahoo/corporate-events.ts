/** 配当/分割の原値と訂正履歴。価格への係数適用は行わない。 */
import { sha256Hex } from "../sha256.js";
import { isCalendarDateString, isStrictIsoUtc, jstDateSec } from "../vwap/proof.js";
import type { DailyBar, DailyFetchProof } from "./client.js";

export const DAILY_PRICE_BASIS = "yahoo-quote-as-received;ohlc-rounded-2dp;adjclose-unused;local-adjustment-none" as const;
export type EventSource = {
  symbol: string; sourceUrl: string; fetchedAt: string; bodySha256: string;
  requestedRange: string; priceSnapshotSha256: string; priceBasis: typeof DAILY_PRICE_BASIS;
};
export type DividendValue = {
  timestamp: number; date: string; dateMeaning: "ex-dividend"; amount: number;
  currency: string | null; currencySource: "chart.result[0].meta.currency" | null;
  paymentDate: null; paymentDateStatus: "not-provided";
};
export type SplitValue = {
  timestamp: number; date: string; dateMeaning: "split-effective";
  numerator: number; denominator: number; ratio: number;
};
export type EventRevision<T> = { version: number; valueSha256: string; value: T; source: EventSource };
export type CorporateEvents = {
  schemaVersion: 1; source: EventSource;
  /** 当該応答/要求範囲の観測。全期間でイベントなし、とは主張しない。 */
  observation: { dividends: "observed" | "verified-none-in-response"; splits: "observed" | "verified-none-in-response" };
  dividends: EventRevision<DividendValue>[]; splits: EventRevision<SplitValue>[];
  /** 旧保存物には原timestamp/分子/分母/sourceがない。推定で埋めない。 */
  legacySplits: Array<{ date: string; ratio: number }>;
};
export const yahooChartSourceUrl = (symbol: string, range: string, interval: string, events: boolean): string =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}${events ? "&events=split,div" : ""}`;
export const dailyEventSourceUrl = (symbol: string, range: string): string => yahooChartSourceUrl(symbol, range, "1d", true);
export const priceSnapshotJson = (bars: readonly DailyBar[]): string => JSON.stringify({
  priceBasis: DAILY_PRICE_BASIS,
  bars: bars.map(({ date, o, h, l, c, v }) => ({ date, o, h, l, c, v })),
});
const fail = (): never => { throw new Error("Yahoo events の原値/根拠/履歴が不正です。STOP"); };
const object = (v: unknown): Record<string, unknown> => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return fail();
  return v as Record<string, unknown>;
};
const timestamp = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0 || !Number.isFinite(new Date((v + 32400) * 1000).getTime())) return fail();
  return v;
};
const positive = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return fail();
  return v;
};
const hash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const dividendJson = (v: DividendValue): string => JSON.stringify({ timestamp: v.timestamp, date: v.date,
  dateMeaning: v.dateMeaning, amount: v.amount, currency: v.currency, currencySource: v.currencySource,
  paymentDate: v.paymentDate, paymentDateStatus: v.paymentDateStatus });
const splitJson = (v: SplitValue): string => JSON.stringify({ timestamp: v.timestamp, date: v.date,
  dateMeaning: v.dateMeaning, numerator: v.numerator, denominator: v.denominator, ratio: v.ratio });

export async function parseCorporateEvents(args: {
  events: unknown; currency: unknown; symbol: string; range: string;
  observedAt: string; rawSha: string; bars: readonly DailyBar[];
}): Promise<CorporateEvents> {
  const { symbol, range, observedAt, rawSha, bars } = args;
  const source: EventSource = { symbol, requestedRange: range, sourceUrl: dailyEventSourceUrl(symbol, range),
    fetchedAt: observedAt, bodySha256: rawSha, priceSnapshotSha256: await sha256Hex(priceSnapshotJson(bars)), priceBasis: DAILY_PRICE_BASIS };
  const events = args.events == null ? {} : object(args.events);
  const currency = args.currency == null ? null : args.currency;
  if (currency !== null && (typeof currency !== "string" || currency.trim() === "" || currency.length > 16)) fail();
  const dividends: CorporateEvents["dividends"] = [], splits: CorporateEvents["splits"] = [];
  for (const d of Object.values(events.dividends == null ? {} : object(events.dividends))) {
    const raw = object(d), ts = timestamp(raw.date);
    if (typeof raw.amount !== "number" || !Number.isFinite(raw.amount) || raw.amount < 0) fail();
    // 現対応応答は支払日を提供しない。新契約を黙って「不明」に落とさない。
    if (raw.paymentDate != null || (raw.currency != null && raw.currency !== currency)) fail();
    const value: DividendValue = { timestamp: ts, date: jstDateSec(ts), dateMeaning: "ex-dividend", amount: raw.amount as number,
      currency: currency as string | null, currencySource: currency === null ? null : "chart.result[0].meta.currency",
      paymentDate: null, paymentDateStatus: "not-provided" };
    dividends.push({ version: 1, valueSha256: await sha256Hex(dividendJson(value)), value, source });
  }
  for (const s of Object.values(events.splits == null ? {} : object(events.splits))) {
    const raw = object(s), ts = timestamp(raw.date), numerator = positive(raw.numerator), denominator = positive(raw.denominator);
    const value: SplitValue = { timestamp: ts, date: jstDateSec(ts), dateMeaning: "split-effective", numerator, denominator, ratio: positive(numerator / denominator) };
    splits.push({ version: 1, valueSha256: await sha256Hex(splitJson(value)), value, source });
  }
  const result: CorporateEvents = { schemaVersion: 1, source,
    observation: { dividends: dividends.length ? "observed" : "verified-none-in-response", splits: splits.length ? "observed" : "verified-none-in-response" },
    dividends, splits, legacySplits: [] };
  assertCorporateEventsShape(result, symbol);
  return result;
}

/** 同じJST権利落ち/分割日を訂正単位とし、異なる原値を新versionで残す。 */
function mergeRevisions<T extends { date: string }>(old: readonly EventRevision<T>[], fresh: readonly EventRevision<T>[]): EventRevision<T>[] {
  const result = [...old];
  for (const next of fresh) {
    const previous = result.filter((r) => r.value.date === next.value.date).at(-1);
    if (previous?.valueSha256 === next.valueSha256) continue;
    result.push({ ...next, version: (previous?.version ?? 0) + 1 });
  }
  return result.sort((a, b) => a.value.date.localeCompare(b.value.date) || a.version - b.version);
}
export function currentEventRevisions<T extends { date: string }>(revisions: readonly EventRevision<T>[]): EventRevision<T>[] {
  const byDate = new Map<string, EventRevision<T>>();
  for (const r of revisions) byDate.set(r.value.date, r);
  return [...byDate.values()].sort((a, b) => a.value.date.localeCompare(b.value.date));
}
export function mergeCorporateEvents(old: CorporateEvents | undefined, fresh: CorporateEvents, oldSplits: readonly { date: string; ratio: number }[]): CorporateEvents {
  assertCorporateEventsShape(fresh, fresh.source.symbol);
  if (old !== undefined) assertCorporateEventsShape(old, fresh.source.symbol);
  const legacy = old?.legacySplits ?? oldSplits;
  return { ...fresh, dividends: mergeRevisions(old?.dividends ?? [], fresh.dividends),
    splits: mergeRevisions(old?.splits ?? [], fresh.splits), legacySplits: [...legacy] };
}

export function assertCorporateEventsShape(input: unknown, symbol: string): asserts input is CorporateEvents {
  const e = object(input);
  if (e.schemaVersion !== 1) fail();
  const source = (input: unknown): void => {
    const s = object(input);
    if (s.symbol !== symbol || typeof s.requestedRange !== "string" || s.requestedRange === "" ||
        s.sourceUrl !== dailyEventSourceUrl(symbol, s.requestedRange) || !isStrictIsoUtc(s.fetchedAt) ||
        !hash(s.bodySha256) || !hash(s.priceSnapshotSha256) || s.priceBasis !== DAILY_PRICE_BASIS) fail();
  };
  source(e.source);
  const observation = object(e.observation);
  for (const k of ["dividends", "splits"] as const) {
    if (observation[k] !== "observed" && observation[k] !== "verified-none-in-response") fail();
    if (!Array.isArray(e[k])) fail();
    const versions = new Map<string, number>();
    for (const raw of e[k] as unknown[]) {
      const r = object(raw), v = object(r.value), ts = timestamp(v.timestamp);
      if (v.date !== jstDateSec(ts) || !hash(r.valueSha256) || r.version !== (versions.get(v.date as string) ?? 0) + 1) fail();
      versions.set(v.date as string, r.version as number); source(r.source);
      if (k === "dividends") {
        if (v.dateMeaning !== "ex-dividend" || typeof v.amount !== "number" || !Number.isFinite(v.amount) || v.amount < 0 ||
          (v.currency !== null && (typeof v.currency !== "string" || v.currency.trim() === "" || v.currency.length > 16)) ||
          v.currencySource !== (v.currency === null ? null : "chart.result[0].meta.currency") || v.paymentDate !== null || v.paymentDateStatus !== "not-provided") fail();
      } else if (v.dateMeaning !== "split-effective" || positive(v.numerator) / positive(v.denominator) !== positive(v.ratio)) fail();
    }
  }
  if (!Array.isArray(e.legacySplits)) fail();
  const seen = new Set<string>();
  for (const raw of e.legacySplits as unknown[]) {
    const s = object(raw);
    if (!isCalendarDateString(s.date) || seen.has(s.date)) fail();
    seen.add(s.date as string); positive(s.ratio);
  }
}
/** 保存/API両方が同じcanonical bytesをSHAへ照合する。 */
export function corporateEventPins(events: CorporateEvents): Array<{ json: string; sha256: string }> {
  return [...events.dividends.map((r) => ({ json: dividendJson(r.value), sha256: r.valueSha256 })),
    ...events.splits.map((r) => ({ json: splitJson(r.value), sha256: r.valueSha256 }))];
}
export function corporateSplitProjection(events: CorporateEvents): Array<{ date: string; ratio: number }> {
  const byDate = new Map(events.legacySplits.map((s) => [s.date, s]));
  for (const { value } of currentEventRevisions(events.splits)) byDate.set(value.date, { date: value.date, ratio: value.ratio });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
export function assertEventSourceProof(events: CorporateEvents, proof: DailyFetchProof): void {
  const s = events.source;
  if (s.symbol !== proof.symbol || s.bodySha256 !== proof.rawSha || s.requestedRange !== proof.requestedRange || s.fetchedAt !== proof.observedAt) fail();
}
