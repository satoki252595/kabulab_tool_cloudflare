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
const STOP_MESSAGE = "株式Chartの報告権利イベント/原本時計/窓構造が不正です。STOP";
const INCIDENT_LOG_PREFIX = "[INC-20261014-kabulab_tool_cloudflare-stock-sync-null-bars]";
type DiagCounts = Record<string, number>;

/** reason・整数の件数・銘柄コードだけ。値・時刻・本文は出さない。出力失敗でも STOP の型と文言は変えない。 */
function formatIncidentLine(reason: string, counts: DiagCounts | undefined, symbol: unknown): string {
  const parts: string[] = [INCIDENT_LOG_PREFIX];
  if (/^[a-z0-9_]+$/.test(reason)) parts.push(`reason=${reason}`);
  if (typeof symbol === "string" && /^[0-9A-Za-z.]{1,16}$/.test(symbol)) parts.push(`symbol=${symbol}`);
  if (counts !== undefined) {
    for (const [key, value] of Object.entries(counts)) {
      if (/^[a-z0-9_]+$/.test(key) && typeof value === "number" && Number.isInteger(value)) parts.push(`${key}=${value}`);
    }
  }
  return parts.join(" ");
}
const stop = (reason: string, counts?: DiagCounts, symbol?: unknown): never => {
  try {
    console.warn(formatIncidentLine(reason, counts, symbol));
  } catch {
    // 計測行の失敗で STOP の Error 型・文言を置き換えない。
  }
  throw new Error(STOP_MESSAGE);
};
function mergeCounts(base: DiagCounts, extra: DiagCounts): DiagCounts {
  const out: DiagCounts = {};
  for (const [key, value] of Object.entries(base)) out[key] = value;
  for (const [key, value] of Object.entries(extra)) out[key] = value;
  return out;
}
function withClause(counts: DiagCounts | undefined, clause: number): DiagCounts {
  const out: DiagCounts = {};
  if (counts !== undefined) {
    for (const [key, value] of Object.entries(counts)) out[key] = value;
  }
  out.clause = clause;
  return out;
}
function lenCounts(value: unknown, lenKey: string): DiagCounts {
  const counts: DiagCounts = { is_array: Array.isArray(value) ? 1 : 0 };
  if (Array.isArray(value)) counts[lenKey] = value.length;
  return counts;
}
function extraKeyCounts(keys: readonly string[], allowed: readonly string[]): DiagCounts {
  let extraKeyCount = 0;
  for (const key of keys) if (!allowed.includes(key)) extraKeyCount += 1;
  return { key_count: keys.length, extra_key_count: extraKeyCount };
}
/** 1 null / 2 非object / 3 配列。不正と判定したあとだけ呼ぶ。 */
function notObjectClause(v: unknown): number {
  if (v === null) return 1;
  if (typeof v !== "object") return 2;
  return 3;
}
/** 1 非number / 2 非有限 / 3 非正。不正と判定したあとだけ呼ぶ。 */
function positiveClause(v: unknown): number {
  if (typeof v !== "number") return 1;
  if (!Number.isFinite(v)) return 2;
  return 3;
}
/** 1 非number / 2 非 safe integer / 3 非正。不正と判定したあとだけ呼ぶ。 */
function timestampClause(ts: unknown): number {
  if (typeof ts !== "number") return 1;
  if (!Number.isSafeInteger(ts)) return 2;
  return 3;
}
function eventPrefix(kind: EventKind): string {
  switch (kind) {
    case "splits": return "split";
    case "dividends": return "dividend";
    case "capitalGains": return "capital_gains";
  }
}
const object = (v: unknown, reason: string, symbol?: unknown, counts?: DiagCounts): Record<string, unknown> => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return stop(reason, withClause(counts, notObjectClause(v)), symbol);
  return v as Record<string, unknown>;
};
const positive = (v: unknown, reason: string, symbol?: unknown, counts?: DiagCounts): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return stop(reason, withClause(counts, positiveClause(v)), symbol);
  return v;
};
function state(v: unknown, reason: string, symbol?: unknown): Observation {
  if (v === undefined) return "absent";
  if (v === null) return "null";
  return Object.keys(object(v, reason, symbol)).length === 0 ? "empty" : "observed";
}

/** 同じ応答のdictionary key・原epoch・分子分母を検査。省略を「権利なし」に変えない。 */
export function extractStockCorporateEvents(json: unknown, receivedAt: string): StockCorporateEvents {
  const receivedAtText: unknown = receivedAt;
  if (!isStrictIsoUtc(receivedAt)) {
    const counts: DiagCounts = {};
    if (typeof receivedAtText === "string") counts.received_at_len = receivedAtText.length;
    stop("received_at_not_iso", counts);
  }
  const chart = object(object(json, "json_not_object").chart, "chart_not_object");
  if (!Array.isArray(chart.result) || chart.result.length !== 1) return stop("chart_result_len", lenCounts(chart.result, "result_len"));
  const raw = object(chart.result[0], "result_not_object"), meta = object(raw.meta, "meta_not_object");
  const symbol: unknown = meta.symbol;
  if (!Array.isArray(raw.timestamp) || raw.timestamp.length === 0) {
    return stop(Array.isArray(raw.timestamp) ? "timestamp_empty" : "timestamp_not_array", lenCounts(raw.timestamp, "timestamps_len"), symbol);
  }
  const timestamps = raw.timestamp;
  for (const [i, ts] of timestamps.entries()) {
    if (typeof ts !== "number" || !Number.isSafeInteger(ts) || ts <= 0) {
      stop("timestamp_not_positive_int", { index: i, timestamps_len: timestamps.length, clause: timestampClause(ts) }, symbol);
    }
    if (ts * 1000 > Date.parse(receivedAt)) stop("timestamp_future", { index: i, timestamps_len: timestamps.length }, symbol);
    if (i > 0 && ts <= timestamps[i - 1]) {
      stop("timestamp_dup_or_reverse", {
        index: i, timestamps_len: timestamps.length, duplicate: ts === timestamps[i - 1] ? 1 : 0,
      }, symbol);
    }
  }
  const responseMetadata: StockCorporateEvents["responseMetadata"] = {};
  // field_index: 0 symbol, 1 range, 2 dataGranularity, 3 timezone, 4 exchangeTimezoneName, 5 instrumentType
  for (const [fieldIndex, field] of (["symbol", "range", "dataGranularity", "timezone", "exchangeTimezoneName", "instrumentType"] as const).entries()) {
    const value = meta[field];
    if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
      const counts: DiagCounts = { field_index: fieldIndex, clause: typeof value !== "string" ? 1 : 2 };
      if (typeof value === "string") counts.value_len = value.length;
      stop("meta_string_empty", counts, symbol);
    }
    responseMetadata[field] = value === undefined ? null : value as string;
  }
  if (meta.range !== undefined && meta.range !== "5y") stop("range_mismatch", undefined, symbol);
  if (meta.dataGranularity !== undefined && meta.dataGranularity !== "1d") stop("granularity_mismatch", undefined, symbol);
  // field_index: 0 firstTradeDate, 1 regularMarketTime
  // clause: 1 非number / 2 非 safe integer / 3 無効日時 / 4 未来
  for (const [fieldIndex, field] of (["firstTradeDate", "regularMarketTime"] as const).entries()) {
    const value = meta[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || !Number.isFinite(new Date(value * 1000).getTime()) || value * 1000 > Date.parse(receivedAt))) {
      let clause = 4;
      if (typeof value !== "number") clause = 1;
      else if (!Number.isSafeInteger(value)) clause = 2;
      else if (!Number.isFinite(new Date(value * 1000).getTime())) clause = 3;
      stop("meta_epoch_invalid", { field_index: fieldIndex, clause }, symbol);
    }
    responseMetadata[field] = value === undefined ? null : value as number;
  }
  const indicators = object(raw.indicators, "indicators_not_object", symbol);
  if (!Array.isArray(indicators.quote) || indicators.quote.length !== 1) stop("quote_len", lenCounts(indicators.quote, "quote_len"), symbol);
  const quote = object((indicators.quote as unknown[])[0], "quote_not_object", symbol);
  // field_index: 0 open, 1 high, 2 low, 3 close, 4 volume
  for (const [fieldIndex, field] of (["open", "high", "low", "close", "volume"] as const).entries()) {
    if (quote[field] !== undefined && (!Array.isArray(quote[field]) || (quote[field] as unknown[]).length !== timestamps.length)) {
      stop("quote_field_len_mismatch", mergeCounts(lenCounts(quote[field], "field_len"), {
        field_index: fieldIndex, timestamps_len: timestamps.length,
      }), symbol);
    }
  }
  if (indicators.adjclose !== undefined) {
    if (!Array.isArray(indicators.adjclose) || indicators.adjclose.length !== 1) stop("adjclose_len", lenCounts(indicators.adjclose, "adjclose_len"), symbol);
    const adj = object((indicators.adjclose as unknown[])[0], "adjclose_not_object", symbol).adjclose;
    if (!Array.isArray(adj) || adj.length !== timestamps.length) {
      stop("adjclose_series_len", mergeCounts(lenCounts(adj, "series_len"), { timestamps_len: timestamps.length }), symbol);
    }
  }
  const currency = meta.currency === undefined || meta.currency === null ? null : meta.currency;
  if (currency !== null && (typeof currency !== "string" || currency.trim() === "" || currency.length > 16)) {
    const counts: DiagCounts = {};
    if (typeof currency !== "string") counts.clause = 1;
    else {
      counts.currency_len = currency.length;
      counts.clause = currency.trim() === "" ? 2 : 3;
    }
    stop("currency_invalid", counts, symbol);
  }
  const topState = state(raw.events, "events_state_not_object", symbol);
  const observation: StockCorporateEvents["observation"] = {
    events: topState, splits: "events-absent", dividends: "events-absent", capitalGains: "events-absent",
  };
  const reported: StockReportedEvent[] = [];
  if (raw.events === undefined || raw.events === null) {
    const missing = raw.events === undefined ? "events-absent" : "events-null";
    return { observation: { events: topState, splits: missing, dividends: missing, capitalGains: missing }, currency: currency as string | null, responseMetadata, reported };
  }
  const events = object(raw.events, "events_not_object", symbol);
  if (Object.keys(events).some(k => !["splits", "dividends", "capitalGains"].includes(k))) {
    stop("events_extra_key", extraKeyCounts(Object.keys(events), ["splits", "dividends", "capitalGains"]), symbol);
  }
  for (const kind of ["splits", "dividends", "capitalGains"] as const) {
    const prefix = eventPrefix(kind);
    observation[kind] = state(events[kind], `${prefix}_state_not_object`, symbol);
    if (events[kind] === undefined || events[kind] === null) continue;
    let entryIndex = 0;
    for (const [dictionaryKey, value] of Object.entries(object(events[kind], `${prefix}_group_not_object`, symbol))) {
      const where: DiagCounts = { entry_index: entryIndex };
      const v = object(value, `${prefix}_entry_not_object`, symbol, where);
      const epoch = positive(v.date, `${prefix}_date_not_positive`, symbol, where);
      if (!Number.isSafeInteger(epoch) || dictionaryKey !== String(epoch) || epoch * 1000 > Date.parse(receivedAt)) {
        if (!Number.isSafeInteger(epoch)) stop(`${prefix}_epoch_not_safe_integer`, where, symbol);
        if (dictionaryKey !== String(epoch)) stop(`${prefix}_dictionary_key_mismatch`, mergeCounts(where, { key_len: dictionaryKey.length }), symbol);
        stop(`${prefix}_epoch_future`, where, symbol);
      }
      // 株式バーのparseChartResponseと同じUTC日付投影。法的効力日の確認には代用しない。
      const base = { dictionaryKey, epoch, date: new Date(epoch * 1000).toISOString().slice(0, 10), reference: `chart.result[0].events.${kind}.${dictionaryKey}` };
      if (kind === "splits") {
        const splitKeys = ["date", "numerator", "denominator", "splitRatio"];
        if (Object.keys(v).some(k => !splitKeys.includes(k))) stop("split_extra_key", mergeCounts(extraKeyCounts(Object.keys(v), splitKeys), where), symbol);
        const numerator = positive(v.numerator, "split_numerator_not_positive", symbol, where);
        const denominator = positive(v.denominator, "split_denominator_not_positive", symbol, where);
        const ratio = positive(numerator / denominator, "split_ratio_not_positive", symbol, where);
        if (v.splitRatio !== undefined) {
          if (typeof v.splitRatio !== "string" || !/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(v.splitRatio)) {
            const counts: DiagCounts = { entry_index: entryIndex, clause: typeof v.splitRatio !== "string" ? 1 : 2 };
            if (typeof v.splitRatio === "string") counts.split_ratio_len = v.splitRatio.length;
            stop("split_ratio_format", counts, symbol);
          }
          const parts = (v.splitRatio as string).split(":").map(Number);
          if (parts[0] !== numerator || parts[1] !== denominator) {
            stop("split_ratio_parts_mismatch", {
              entry_index: entryIndex, parts_len: parts.length,
              numerator_mismatch: parts[0] !== numerator ? 1 : 0, denominator_mismatch: parts[1] !== denominator ? 1 : 0,
            }, symbol);
          }
        }
        reported.push({ ...base, kind, numerator, denominator, ratio, splitRatio: v.splitRatio as string | undefined });
      } else {
        const amountKeys = ["date", "amount"];
        if (Object.keys(v).some(k => !amountKeys.includes(k)) || typeof v.amount !== "number" || !Number.isFinite(v.amount) || v.amount < 0) {
          const keys = Object.keys(v);
          if (keys.some(k => !amountKeys.includes(k))) stop(`${prefix}_extra_key`, mergeCounts(extraKeyCounts(keys, amountKeys), where), symbol);
          const counts: DiagCounts = { entry_index: entryIndex };
          if (typeof v.amount !== "number") counts.clause = 1;
          else if (!Number.isFinite(v.amount)) counts.clause = 2;
          else counts.clause = 3;
          stop(`${prefix}_amount_invalid`, counts, symbol);
        }
        reported.push({ ...base, kind, amount: v.amount as number });
      }
      entryIndex += 1;
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
  if (!/^[0-9a-f]{64}$/.test(bodySha256) || !isStrictIsoUtc(receivedAt)) {
    if (!/^[0-9a-f]{64}$/.test(bodySha256)) {
      const counts: DiagCounts = {};
      if (typeof bodySha256 === "string") counts.body_sha_len = bodySha256.length;
      stop("diag_body_sha_invalid", counts, code);
    }
    const counts: DiagCounts = {};
    if (typeof receivedAt === "string") counts.received_at_len = receivedAt.length;
    stop("diag_received_at_not_iso", counts, code);
  }
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
