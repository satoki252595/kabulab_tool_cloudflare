/**
 * INC-20261014-kabulab_tool_cloudflare-stock-sync-null-bars
 *
 * 実日足未取得の失敗ログ。判定・例外・再取得には使わない。
 * 入力は失敗時点でメモリにある chart 原文・バー・cache header だけ。
 * 時刻表示は jstDateSec と同じ +9h (日本は夏時間なし)。
 * 対象日バーの突合は日足 date と同じ UTC 日付 (toISOString の日付)。
 */
import { STOCK_CODE_REGEX } from "../shared/jpx/stock-code.js";
import type { DailyOhlcv } from "../shared/types.js";
import { isCalendarDateString } from "../shared/vwap/proof.js";

export const INC_NULL_BARS_TAG = "[INC-20261014-kabulab_tool_cloudflare-stock-sync-null-bars]";

const TAIL_COUNT = 3;

export interface NullBarsFailureInput {
  code: string;
  expectedDate: string;
  /** 取得済み chart 原文。無いときはバーだけで対象日を見る。 */
  bytes?: Uint8Array;
  headers?: { age?: string; cfCacheStatus?: string };
  bars: readonly Pick<DailyOhlcv, "date" | "open" | "high" | "low" | "close" | "volume">[];
}

interface NullBarsCategories {
  fullyNull: boolean;
  closeOnlyNull: boolean;
  absent: boolean;
  tradeBefore: boolean;
}

interface NullBarsRunCounts {
  failures: number;
  fullyNull: number;
  closeOnlyNull: number;
  absent: number;
  tradeBefore: number;
}

let activeRun: NullBarsRunCounts | null = null;

/** runDailySync の開始で呼ぶ。前回の残りは捨てる。 */
export function startNullBarsRun(): void {
  activeRun = { failures: 0, fullyNull: 0, closeOnlyNull: 0, absent: 0, tradeBefore: 0 };
}

/** run につき 1 行。active が無ければ 0 件。呼ぶとカウンタを閉じる。 */
export function finishNullBarsSummaryLine(): string {
  const counts = activeRun ?? { failures: 0, fullyNull: 0, closeOnlyNull: 0, absent: 0, tradeBefore: 0 };
  activeRun = null;
  return `${INC_NULL_BARS_TAG} summary failures=${counts.failures} fullyNull=${counts.fullyNull} closeOnlyNull=${counts.closeOnlyNull} absent=${counts.absent} tradeBefore=${counts.tradeBefore}`;
}

export function describeNullBarsFailure(input: NullBarsFailureInput): { line: string; categories: NullBarsCategories } {
  const target = isCalendarDateString(input.expectedDate) ? input.expectedDate : null;
  const code = STOCK_CODE_REGEX.test(input.code) ? input.code : "bad";
  const response = readChart(input.bytes);
  const fromRaw = response.kind === "raw";
  const bar = fromRaw ? targetBarFromRaw(response, target) : targetBarFromBars(input.bars, target);
  const rmt = fromRaw && response.rmt !== null ? jstClock(response.rmt) : null;
  const rmtDay = rmt === null || target === null ? "-"
    : rmt.date === target ? "on"
    : rmt.date < target ? "before"
    : "after";
  const tail = fromRaw ? tailOf(response.timestamps) : { n: "-", tail: "-" };
  const categories: NullBarsCategories = {
    fullyNull: bar.present && bar.o === "N" && bar.h === "N" && bar.l === "N" && bar.c === "N",
    closeOnlyNull: bar.present && bar.c === "N" && !(bar.o === "N" && bar.h === "N" && bar.l === "N"),
    absent: !bar.present,
    tradeBefore: rmtDay === "before",
  };
  const line = `${INC_NULL_BARS_TAG} ${code} rmt=${rmt === null ? "-" : rmt.full} rmtDay=${rmtDay} o=${bar.o} h=${bar.h} l=${bar.l} c=${bar.c} v=${bar.v} n=${tail.n} tail=${tail.tail} prev=${bar.prev} age=${headerToken(input.headers?.age)} cf=${headerToken(input.headers?.cfCacheStatus)} src=${response.kind === "raw" ? "raw" : response.kind === "bad" ? "bad" : "bars"}`;
  return { line, categories };
}

/** 失敗 1 件を warn し、開いている run の区分へ数える。例外は投げない。 */
export function logFreshCloseNullBars(input: NullBarsFailureInput): void {
  const described = describeNullBarsFailure(input);
  if (activeRun !== null) {
    activeRun.failures += 1;
    if (described.categories.fullyNull) activeRun.fullyNull += 1;
    if (described.categories.closeOnlyNull) activeRun.closeOnlyNull += 1;
    if (described.categories.absent) activeRun.absent += 1;
    if (described.categories.tradeBefore) activeRun.tradeBefore += 1;
  }
  console.warn(described.line);
}

interface RawChart {
  kind: "raw";
  rmt: number | null;
  timestamps: number[] | null;
  open: unknown[] | null;
  high: unknown[] | null;
  low: unknown[] | null;
  close: unknown[] | null;
  volume: unknown[] | null;
}

function readChart(bytes: Uint8Array | undefined): RawChart | { kind: "missing" } | { kind: "bad" } {
  if (bytes === undefined) return { kind: "missing" };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { kind: "bad" };
  }
  const root = asObject(json);
  const chart = asObject(root?.chart);
  const result = chart?.result;
  const first = Array.isArray(result) ? asObject(result[0]) : null;
  if (first === null) return { kind: "bad" };
  const meta = asObject(first.meta);
  const rmtValue = meta?.regularMarketTime;
  const rmt = typeof rmtValue === "number" && Number.isFinite(rmtValue) ? rmtValue : null;
  const timestamps = Array.isArray(first.timestamp)
    ? first.timestamp.map((ts) => (typeof ts === "number" && Number.isFinite(ts) ? ts : Number.NaN))
    : null;
  const indicators = asObject(first.indicators);
  const quote = indicators !== null && Array.isArray(indicators.quote) ? asObject(indicators.quote[0]) : null;
  const series = (key: string): unknown[] | null => {
    const value = quote?.[key];
    return Array.isArray(value) ? value : null;
  };
  return {
    kind: "raw",
    rmt,
    timestamps,
    open: series("open"),
    high: series("high"),
    low: series("low"),
    close: series("close"),
    volume: series("volume"),
  };
}

interface BarView {
  present: boolean;
  o: "N" | "V" | "-";
  h: "N" | "V" | "-";
  l: "N" | "V" | "-";
  c: "N" | "V" | "-";
  v: string;
  prev: "N" | "V" | "-";
}

function targetBarFromRaw(response: RawChart, target: string | null): BarView {
  if (target === null || response.timestamps === null) return absentBar();
  let index = -1;
  for (let i = 0; i < response.timestamps.length; i++) {
    if (utcDate(response.timestamps[i]) === target) index = i;
  }
  if (index < 0) {
    return { ...absentBar(), prev: prevFlag(response.close, lastIndexBefore(response.timestamps, target)) };
  }
  return {
    present: true,
    o: slotFlag(response.open, index),
    h: slotFlag(response.high, index),
    l: slotFlag(response.low, index),
    c: slotFlag(response.close, index),
    v: volumeToken(response.volume, index),
    prev: prevFlag(response.close, index - 1),
  };
}

function targetBarFromBars(bars: NullBarsFailureInput["bars"], target: string | null): BarView {
  if (target === null) return absentBar();
  let index = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i]?.date === target) index = i;
  }
  if (index < 0) {
    let prevIndex = -1;
    for (let i = 0; i < bars.length; i++) {
      const date = bars[i]?.date;
      if (date !== undefined && date < target) prevIndex = i;
    }
    const prev = prevIndex < 0 ? undefined : bars[prevIndex];
    return { ...absentBar(), prev: prev === undefined ? "-" : valueFlag(prev.close) };
  }
  const bar = bars[index];
  if (bar === undefined) return absentBar();
  const prev = index > 0 ? bars[index - 1] : undefined;
  return {
    present: true,
    o: valueFlag(bar.open),
    h: valueFlag(bar.high),
    l: valueFlag(bar.low),
    c: valueFlag(bar.close),
    v: bar.volume === null ? "null" : volumeNumber(bar.volume),
    prev: prev === undefined ? "-" : valueFlag(prev.close),
  };
}

function absentBar(): BarView {
  return { present: false, o: "-", h: "-", l: "-", c: "-", v: "-", prev: "-" };
}

function lastIndexBefore(timestamps: readonly number[], target: string): number {
  let index = -1;
  for (let i = 0; i < timestamps.length; i++) {
    const date = utcDate(timestamps[i]);
    if (date !== null && date < target) index = i;
  }
  return index;
}

function slotFlag(series: unknown[] | null, index: number): "N" | "V" {
  if (series === null || index < 0 || index >= series.length) return "N";
  return valueFlag(series[index]);
}

function valueFlag(value: unknown): "N" | "V" {
  return value === null || value === undefined ? "N" : "V";
}

function prevFlag(series: unknown[] | null, index: number): "N" | "V" | "-" {
  if (index < 0) return "-";
  return slotFlag(series, index);
}

function volumeToken(series: unknown[] | null, index: number): string {
  if (series === null || index < 0 || index >= series.length || series[index] === undefined) return "missing";
  if (series[index] === null) return "null";
  return volumeNumber(series[index]);
}

function volumeNumber(value: unknown): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "bad";
}

function tailOf(timestamps: number[] | null): { n: string; tail: string } {
  if (timestamps === null) return { n: "-", tail: "-" };
  if (timestamps.length === 0) return { n: "0", tail: "-" };
  const tail = timestamps.slice(-TAIL_COUNT).map((ts) => {
    const clock = jstClock(ts);
    return clock === null ? "bad" : clock.hhmm;
  }).join(",");
  return { n: String(timestamps.length), tail };
}

function headerToken(value: string | undefined): string {
  if (value === undefined || value === "") return "-";
  return /^[A-Za-z0-9._-]{1,32}$/.test(value) ? value : "bad";
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Unix 秒 → UTC 日付。日足 date と同じ。 */
function utcDate(sec: number): string | null {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return null;
  const ms = sec * 1000;
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  const iso = date.toISOString().slice(0, 10);
  return isCalendarDateString(iso) ? iso : null;
}

/** Unix 秒 → JST。日付は +9h シフト (jstDateSec と同じ)。 */
function jstClock(sec: number): { date: string; hhmm: string; full: string } | null {
  if (typeof sec !== "number" || !Number.isFinite(sec)) return null;
  const ms = (sec + 32400) * 1000;
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms);
  if (Number.isNaN(shifted.getTime())) return null;
  const iso = shifted.toISOString();
  const date = iso.slice(0, 10);
  const clock = iso.slice(11, 19);
  if (!isCalendarDateString(date) || !/^\d{2}:\d{2}:\d{2}$/.test(clock)) return null;
  return { date, hhmm: `${date}T${clock.slice(0, 5)}`, full: `${date}T${clock}+09:00` };
}
