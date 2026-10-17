/** 株式Chart原本の報告イベント診断。権利の網羅性・OHLCV調整基準は推定しない。 */
import type { DailyOhlcv } from "../types.js";
import { isStrictIsoUtc } from "../vwap/proof.js";

type Observation = "absent" | "null" | "empty" | "observed";
type EventKind = "splits" | "dividends" | "capitalGains";
type EventBase = { kind: EventKind; dictionaryKey: string; epoch: number; date: string; reference: string };
export type StockReportedEvent = EventBase & (
  { kind: "splits"; numerator: number; denominator: number; ratio: number; splitRatio: string | undefined } |
  { kind: "dividends" | "capitalGains"; amount: number }
);
export interface StockCorporateEvents {
  observation: { events: Observation; splits: Observation | "events-absent" | "events-null";
    dividends: Observation | "events-absent" | "events-null"; capitalGains: Observation | "events-absent" | "events-null" };
  currency: string | null;
  responseMetadata: Record<string, string | number | null>;
  reported: StockReportedEvent[];
}
const stop = (): never => { throw new Error("株式Chartの報告権利イベント/原本時計/窓構造が不正です。STOP"); };
const object = (v: unknown): Record<string, unknown> => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return stop();
  return v as Record<string, unknown>;
};
const positive = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return stop();
  return v;
};
function state(v: unknown): Observation {
  if (v === undefined) return "absent";
  if (v === null) return "null";
  return Object.keys(object(v)).length === 0 ? "empty" : "observed";
}

/** 同じ応答のdictionary key・原epoch・分子分母を検査。省略を「権利なし」に変えない。 */
export function extractStockCorporateEvents(json: unknown, receivedAt: string): StockCorporateEvents {
  if (!isStrictIsoUtc(receivedAt)) stop();
  const chart = object(object(json).chart);
  if (!Array.isArray(chart.result) || chart.result.length !== 1) return stop();
  const raw = object(chart.result[0]), meta = object(raw.meta);
  if (!Array.isArray(raw.timestamp) || raw.timestamp.length === 0) return stop();
  const timestamps = raw.timestamp;
  for (const [i, ts] of timestamps.entries()) {
    if (typeof ts !== "number" || !Number.isSafeInteger(ts) || ts <= 0 || ts * 1000 > Date.parse(receivedAt) ||
      (i > 0 && ts <= timestamps[i - 1])) stop();
  }
  const responseMetadata: StockCorporateEvents["responseMetadata"] = {};
  for (const field of ["symbol", "range", "dataGranularity", "timezone", "exchangeTimezoneName", "instrumentType"] as const) {
    const value = meta[field];
    if (value !== undefined && (typeof value !== "string" || value.trim() === "")) stop();
    responseMetadata[field] = value === undefined ? null : value as string;
  }
  if ((meta.range !== undefined && meta.range !== "5y") || (meta.dataGranularity !== undefined && meta.dataGranularity !== "1d")) stop();
  for (const field of ["firstTradeDate", "regularMarketTime"] as const) {
    const value = meta[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || !Number.isFinite(new Date(value * 1000).getTime()) || value * 1000 > Date.parse(receivedAt))) stop();
    responseMetadata[field] = value === undefined ? null : value as number;
  }
  const indicators = object(raw.indicators);
  if (!Array.isArray(indicators.quote) || indicators.quote.length !== 1) stop();
  const quote = object((indicators.quote as unknown[])[0]);
  for (const field of ["open", "high", "low", "close", "volume"] as const) {
    if (quote[field] !== undefined && (!Array.isArray(quote[field]) || (quote[field] as unknown[]).length !== timestamps.length)) stop();
  }
  if (indicators.adjclose !== undefined) {
    if (!Array.isArray(indicators.adjclose) || indicators.adjclose.length !== 1) stop();
    const adj = object((indicators.adjclose as unknown[])[0]).adjclose;
    if (!Array.isArray(adj) || adj.length !== timestamps.length) stop();
  }
  const currency = meta.currency === undefined || meta.currency === null ? null : meta.currency;
  if (currency !== null && (typeof currency !== "string" || currency.trim() === "" || currency.length > 16)) stop();
  const topState = state(raw.events);
  const observation: StockCorporateEvents["observation"] = {
    events: topState, splits: "events-absent", dividends: "events-absent", capitalGains: "events-absent",
  };
  const reported: StockReportedEvent[] = [];
  if (raw.events === undefined || raw.events === null) {
    const missing = raw.events === undefined ? "events-absent" : "events-null";
    return { observation: { events: topState, splits: missing, dividends: missing, capitalGains: missing }, currency: currency as string | null, responseMetadata, reported };
  }
  const events = object(raw.events);
  if (Object.keys(events).some(k => !["splits", "dividends", "capitalGains"].includes(k))) stop();
  for (const kind of ["splits", "dividends", "capitalGains"] as const) {
    observation[kind] = state(events[kind]);
    if (events[kind] === undefined || events[kind] === null) continue;
    for (const [dictionaryKey, value] of Object.entries(object(events[kind]))) {
      const v = object(value), epoch = positive(v.date);
      if (!Number.isSafeInteger(epoch) || dictionaryKey !== String(epoch) || epoch * 1000 > Date.parse(receivedAt)) stop();
      // 株式バーのparseChartResponseと同じUTC日付投影。法的効力日の確認には代用しない。
      const base = { dictionaryKey, epoch, date: new Date(epoch * 1000).toISOString().slice(0, 10), reference: `chart.result[0].events.${kind}.${dictionaryKey}` };
      if (kind === "splits") {
        if (Object.keys(v).some(k => !["date", "numerator", "denominator", "splitRatio"].includes(k))) stop();
        const numerator = positive(v.numerator), denominator = positive(v.denominator), ratio = positive(numerator / denominator);
        if (v.splitRatio !== undefined) {
          if (typeof v.splitRatio !== "string" || !/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(v.splitRatio)) stop();
          const parts = (v.splitRatio as string).split(":").map(Number);
          if (parts[0] !== numerator || parts[1] !== denominator) stop();
        }
        reported.push({ ...base, kind, numerator, denominator, ratio, splitRatio: v.splitRatio as string | undefined });
      } else {
        if (Object.keys(v).some(k => !["date", "amount"].includes(k)) || typeof v.amount !== "number" || !Number.isFinite(v.amount) || v.amount < 0) stop();
        reported.push({ ...base, kind, amount: v.amount as number });
      }
    }
  }
  return { observation, currency: currency as string | null, responseMetadata, reported };
}

type Window = {
  rows: number; firstDate: string | null; lastDate: string | null; requestedRows: number;
  /** 窓全体の充足。指標ごとの算出可否は既存計算の責務（短いrange等は算出され得る）。 */
  completeRequestedWindow: boolean;
  missingValues: Record<string, number>;
  /** 原本内の参照だけ。イベント原値は既存Chartファイルから読む。全権利の不存在証明ではない。 */
  reportedEventReferences: string[];
};
export interface StockCorporateDiagnostics {
  schemaVersion: 1;
  source: { code: string; bodySha256: string; receivedAt: string; requestedRange: "5y"; interval: "1d"; requestedEvents: "split,div" };
  observation: StockCorporateEvents["observation"];
  currency: string | null;
  responseMetadata: StockCorporateEvents["responseMetadata"];
  reportedCounts: Record<EventKind, number>;
  supplied: { rows: number; firstDate: string | null; lastDate: string | null };
  windows: { atr130: Window; volume21: Window; range20: Window; close2: Window; adjustedMomentum90: Window };
  basis: { ohlc: "unknown"; volume: "unknown"; dividendShareBasis: "unknown"; localAdjustment: "none" };
  eventDateBasis: "UTC-calendar-date-as-stock-bars;legal-effective-date-unverified";
  unknownReasons: readonly string[];
}

/** 報告splitを跨ぐ計算だけ保留する。比率の再適用や法的効力日の推定には使わない。 */
export const STOCK_SPLIT_WINDOW_HOLD = {
  atr130: "atr130:reported-split-crossing;provider-ohlcv-basis-unproven",
  volume20: "volume20:reported-split-crossing;provider-ohlcv-basis-unproven",
  volume21: "volume21:reported-split-crossing;provider-ohlcv-basis-unproven",
  turnover20: "turnover20:reported-split-crossing;provider-ohlcv-basis-unproven",
  range20: "range20:reported-split-crossing;provider-ohlcv-basis-unproven",
  close2: "close2:reported-split-crossing;provider-ohlcv-basis-unproven",
} as const;

function reportedSplitWindowHolds(events: StockCorporateEvents, bars: readonly DailyOhlcv[]): string[] {
  const recent = bars.slice(-130), last20 = recent.slice(-20), last21 = recent.slice(-21);
  const finite = (v: number | null | undefined): boolean => typeof v === "number" && Number.isFinite(v);
  const atr = recent.filter(b => finite(b.high) && finite(b.low) && finite(b.close));
  const range = last20.filter(b => finite(b.high) || finite(b.low));
  const windows = {
    atr130: atr.length >= 15 ? atr : [],
    volume20: last20.length === 20 && last20.every(b => finite(b.volume)) ? last20 : [],
    volume21: last21.length === 21 && last21.every(b => finite(b.volume)) ? last21 : [],
    turnover20: last20.length === 20 && last20.every(b => finite(b.close) && finite(b.volume)) ? last20 : [],
    range20: range.some(b => finite(b.high)) && range.some(b => finite(b.low)) ? range : [],
    close2: recent.filter(b => finite(b.close)).slice(-2),
  };
  return (Object.keys(windows) as (keyof typeof windows)[]).filter(key => {
    const used = windows[key];
    return used.length >= 2 && events.reported.some(event => event.kind === "splits" &&
      used[0].date < event.date && event.date <= used[used.length - 1].date);
  }).map(key => STOCK_SPLIT_WINDOW_HOLD[key]);
}

/** normal/replayが実際に採用した同一バー列へ結ぶ純関数。指標・価格・出来高は変更しない。 */
export function buildStockCorporateDiagnostics(args: {
  events: StockCorporateEvents; code: string; bodySha256: string; receivedAt: string;
  suppliedBars: readonly DailyOhlcv[]; qualifiedBars: readonly DailyOhlcv[];
}): StockCorporateDiagnostics {
  const { events, code, bodySha256, receivedAt, suppliedBars, qualifiedBars } = args;
  if (!/^[0-9a-f]{64}$/.test(bodySha256) || !isStrictIsoUtc(receivedAt)) stop();
  const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const span = (bars: readonly DailyOhlcv[]) => ({ rows: bars.length, firstDate: bars.length === 0 ? null : bars[0].date,
    lastDate: bars.length === 0 ? null : bars[bars.length - 1].date });
  const window = (bars: readonly DailyOhlcv[], requestedRows: number, fields: readonly (keyof DailyOhlcv)[]): Window => {
    const s = span(bars);
    return { ...s, requestedRows, completeRequestedWindow: bars.length === requestedRows,
      missingValues: Object.fromEntries(fields.map(field => [field, bars.filter(b => !finite(b[field])).length])),
      reportedEventReferences: events.reported.filter(e => s.firstDate !== null && s.lastDate !== null && e.date >= s.firstDate && e.date <= s.lastDate).map(e => e.reference) };
  };
  const recent = qualifiedBars.slice(-130);
  const atr = recent.filter(b => finite(b.high) && finite(b.low) && finite(b.close));
  const volume = recent.slice(-21), range = recent.slice(-20);
  const closes = recent.filter(b => finite(b.close)).slice(-2), momentum = qualifiedBars.slice(-90);
  return { schemaVersion: 1, source: { code, bodySha256, receivedAt, requestedRange: "5y", interval: "1d", requestedEvents: "split,div" },
    observation: events.observation, currency: events.currency, responseMetadata: events.responseMetadata,
    reportedCounts: { splits: events.reported.filter(e => e.kind === "splits").length,
      dividends: events.reported.filter(e => e.kind === "dividends").length, capitalGains: events.reported.filter(e => e.kind === "capitalGains").length },
    supplied: span(suppliedBars), windows: {
      // ATR Wilderは直近130行中の全有効OHLCを使う。必要TR14本にはOHLC15本が必要。
      atr130: window(atr, 130, ["high", "low", "close"]), volume21: window(volume, 21, ["volume"]),
      range20: window(range, 20, ["high", "low"]), close2: window(closes, 2, ["close"]),
      adjustedMomentum90: window(momentum, 90, ["adj"]),
    }, basis: { ohlc: "unknown", volume: "unknown", dividendShareBasis: "unknown", localAdjustment: "none" },
    eventDateBasis: "UTC-calendar-date-as-stock-bars;legal-effective-date-unverified",
    unknownReasons: ["reported-events-only;omission-is-not-none", "provider-ohlc-and-volume-adjustment-basis-not-proven",
      "capitalGains-not-requested", "rights-issues-capital-increases-and-other-legal-actions-not-covered",
      ...reportedSplitWindowHolds(events, qualifiedBars)],
  };
}
