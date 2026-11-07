/**
 * INC-20261008-kabulab_tool_cloudflare-financials-stale 計測用ログ行の組み立て (純粋関数)。
 * 判定・例外・リトライ・既定値には使わない。値は日付・真偽・時刻だけで秘密を含まない。
 */
import type { DailyOhlcv } from "../shared/types.js";
import type { ConfirmedCloseDiag } from "./macro-session.js";

export const INC_FINANCIALS_STALE_TAG = "[INC-20261008-kabulab_tool_cloudflare-financials-stale]";

type BarLike = Pick<DailyOhlcv, "date" | "close" | "adj"> | undefined;

/** 株式 N225 鮮度ゲート直前の 1 行 (取得済みデータのみ使用)。 */
export function formatStockSessionDiag(
  ohlcv: readonly BarLike[],
  receivedAt: string | undefined,
  targetDate: string
): string {
  const latest = ohlcv.length > 0 ? ohlcv[ohlcv.length - 1] : undefined;
  const prev = ohlcv.length > 1 ? ohlcv[ohlcv.length - 2] : undefined;
  return `${INC_FINANCIALS_STALE_TAG} stocks-session ${JSON.stringify({
    targetDate,
    receivedAt: receivedAt ?? null,
    latestBarDate: latest?.date ?? null,
    latestCloseNull: latest === undefined ? null : latest.close === null,
    latestAdjNull: latest === undefined ? null : (latest.adj ?? null) === null,
    prevBarDate: prev?.date ?? null,
  })}`;
}

/** マクロ / VWAP の confirmed-close HOLD 理由の 1 行。 */
export function formatConfirmedHoldDiag(
  stage: "macro" | "vwap-daily-session",
  symbol: string,
  receivedAt: string | undefined,
  diag: ConfirmedCloseDiag
): string {
  return `${INC_FINANCIALS_STALE_TAG} ${stage} ${JSON.stringify({
    symbol,
    receivedAt: receivedAt ?? null,
    reason: diag.reason,
    candidateDate: diag.candidateDate,
    sessionDate: diag.sessionDate,
    ended: diag.ended,
  })}`;
}

export interface NullBandHoldInput {
  stage: "stocks-session" | "stocks-snapshot" | "vwap-daily-session";
  symbol: string;
  /** 取得済み capture の receivedAt (UTC ISO)。無いときは出さない。 */
  receivedAt: string | undefined;
  /** 取得済みの chart 原文。追加の Yahoo リクエストはしない。 */
  raw: Uint8Array | undefined;
  bars: readonly BarLike[];
  /** 証明したい取引日 D。候補が無ければ null（日付を推測しない）。 */
  targetDate: string | null;
}

/**
 * HOLD／停止時の理由行。判定・例外・戻り値には使わない。
 * ctp の JST 日が D の翌日で、D バーの close が null のときだけ
 * null 帯での取得の疑いを書き分ける。
 */
export function formatNullBandHoldLog(input: NullBandHoldInput): string {
  const latest = input.bars.length > 0 ? input.bars[input.bars.length - 1] : undefined;
  const targetHits = input.targetDate === null
    ? []
    : input.bars.filter((bar) => bar?.date === input.targetDate);
  const target = targetHits.length === 1 ? targetHits[0] : undefined;
  const regular = readRegularPeriod(input.raw);
  const receivedAtJst = input.receivedAt === undefined ? null : formatJst(Date.parse(input.receivedAt));
  const regularStartJst = regular === null ? null : formatJst(regular.start * 1000);
  const regularEndJst = regular === null ? null : formatJst(regular.end * 1000);
  const sessionDate = regularStartJst === null ? null : regularStartJst.slice(0, 10);
  const targetCloseNull = target === undefined ? null : target.close === null;
  const nullBandSuspicion = input.targetDate !== null
    && sessionDate === nextCalendarDate(input.targetDate)
    && targetCloseNull === true
    ? "null 帯（D 23:30〜D+1 09:45 以降）での取得の疑い"
    : null;
  return `${INC_FINANCIALS_STALE_TAG} null-band-hold ${JSON.stringify({
    stage: input.stage,
    symbol: input.symbol,
    receivedAt: input.receivedAt === undefined ? null : input.receivedAt,
    receivedAtJst,
    regularStartJst,
    regularEndJst,
    latestBarDate: latest === undefined ? null : latest.date,
    latestCloseNull: latest === undefined ? null : latest.close === null,
    latestAdjNull: latest === undefined ? null : latest.adj === null || latest.adj === undefined,
    targetDate: input.targetDate,
    targetCloseNull,
    targetAdjNull: target === undefined ? null : target.adj === null || target.adj === undefined,
    nullBandSuspicion,
  })}`;
}

function readRegularPeriod(raw: Uint8Array | undefined): { start: number; end: number } | null {
  if (raw === undefined) return null;
  const json: unknown = JSON.parse(new TextDecoder().decode(raw));
  if (typeof json !== "object" || json === null) {
    throw new Error("chart 原文が object ではありません");
  }
  const chart = (json as { chart?: unknown }).chart;
  if (typeof chart !== "object" || chart === null) {
    throw new Error("chart 原文に chart がありません");
  }
  const result = (chart as { result?: unknown }).result;
  if (!Array.isArray(result) || result.length === 0 || typeof result[0] !== "object" || result[0] === null) {
    throw new Error("chart 原文に result がありません");
  }
  const meta = (result[0] as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) {
    throw new Error("chart 原文に meta がありません");
  }
  const regular = (meta as { currentTradingPeriod?: unknown }).currentTradingPeriod;
  if (typeof regular !== "object" || regular === null) {
    throw new Error("chart 原文に currentTradingPeriod がありません");
  }
  const period = (regular as { regular?: unknown }).regular;
  if (typeof period !== "object" || period === null) {
    throw new Error("chart 原文に currentTradingPeriod.regular がありません");
  }
  const start = (period as { start?: unknown }).start;
  const end = (period as { end?: unknown }).end;
  if (typeof start !== "number" || !Number.isFinite(start) || typeof end !== "number" || !Number.isFinite(end)) {
    throw new Error("currentTradingPeriod.regular の start/end が時刻ではありません");
  }
  return { start, end };
}

function formatJst(ms: number): string {
  if (!Number.isFinite(ms)) throw new Error("JST へ変換する時刻が不正です");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const pick = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined || value === "") throw new Error(`JST の ${type} を読めません`);
    return value;
  };
  return `${pick("year")}-${pick("month")}-${pick("day")}T${pick("hour")}:${pick("minute")}:${pick("second")}+09:00`;
}

const MACRO_HOLD_CHART_SYMBOLS = ["^N225", "^VIX", "^GSPC", "NIY=F"] as const;

export interface MacroHoldAttemptLog {
  target: string;
  attempt: number;
  requestedAt: string;
  completedAt: string;
  /** chart capture の受信時刻。無いときは null（VI HTML など）。 */
  receivedAt: string | null;
  bytes: Uint8Array | null;
}

export interface MacroGateHoldLogInput {
  /** decideMarketContextGate が既に返した reason。ここからコードを読むだけで、再判定しない。 */
  reason: string;
  charts: Record<(typeof MACRO_HOLD_CHART_SYMBOLS)[number], { date: string | null }>;
  nikkeiViDate: string | null;
  attempts: readonly MacroHoldAttemptLog[];
  /** JP leg 由来の N225。この run の chart attempt が無いときだけ取得時刻に使う。 */
  jpN225ReceivedAt: string | null;
  /** JP leg 由来の日経VI。この run の VI attempt が無いときだけ取得時刻に使う。 */
  jpViReceivedAt: string | null;
}

/**
 * gate が返した日本語 reason を、ログ用の安定コードへ写す。
 * 知らない文は null（別のコードを作らない）。判定には使わない。
 */
export function macroHoldReasonCode(reason: string): string | null {
  if (reason.startsWith("GSPC 確定日 ") && reason.includes("≠ 予定日")) return "gspc_date_ne_expected";
  if (reason.startsWith("N225 確定日 ") && reason.includes("≠ GSPC")) return "n225_date_ne_gspc";
  if (reason.startsWith("VIX 確定日 ") && reason.includes("≠ GSPC")) return "vix_date_ne_gspc";
  if (reason.startsWith("VI 日付 ") && reason.includes("≠ GSPC")) return "vi_date_ne_gspc";
  const prefixes: ReadonlyArray<readonly [string, string]> = [
    ["N225 確定日が無い", "n225_date_missing"],
    ["GSPC 確定日が無い", "gspc_date_missing"],
    ["JPX 休場日", "jpx_closed"],
    ["VIX 確定日が無い", "vix_date_missing"],
    ["VI 日付が無い", "vi_date_missing"],
    ["N225 確定終値が無い", "n225_close_missing"],
    ["N225 前日終値が無い", "n225_prev_missing"],
    ["GSPC 確定終値が無い", "gspc_close_missing"],
    ["GSPC 前日終値が無い", "gspc_prev_missing"],
    ["VIX 確定終値が無い", "vix_close_missing"],
    ["NIY snapshotが無い", "niy_price_missing"],
    ["VI 価格が無い", "vi_price_missing"],
  ];
  for (const [prefix, code] of prefixes) {
    if (reason.startsWith(prefix)) return code;
  }
  return null;
}

interface ChartSessionClock {
  exchangeSessionDate: string | null;
  regularStart: string | null;
  regularEnd: string | null;
  regularEndSec: number | null;
  regularMarketTime: string | null;
  regularMarketTimeSec: number | null;
  ended: boolean | null;
}

const EMPTY_CLOCK: ChartSessionClock = {
  exchangeSessionDate: null,
  regularStart: null,
  regularEnd: null,
  regularEndSec: null,
  regularMarketTime: null,
  regularMarketTimeSec: null,
  ended: null,
};

/**
 * チャート原文から session 時計だけを読む。判定・例外には使わない。
 * 読めない欄は null。JSON 不正や tz 不正でも投げない。
 * URL・crumb・cookie は読まない。
 */
export function readChartSessionClock(raw: Uint8Array | null): ChartSessionClock {
  if (!(raw instanceof Uint8Array) || raw.length === 0) return { ...EMPTY_CLOCK };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { ...EMPTY_CLOCK };
  }
  const meta = chartMeta(json);
  if (meta === null) return { ...EMPTY_CLOCK };
  const regular = asRecord(asRecord(meta.currentTradingPeriod)?.regular);
  const start = finiteNumber(regular?.start);
  const end = finiteNumber(regular?.end);
  const rmt = finiteNumber(meta.regularMarketTime);
  const timeZone = typeof meta.exchangeTimezoneName === "string" && meta.exchangeTimezoneName !== ""
    ? meta.exchangeTimezoneName
    : null;
  const startDate = timeZone === null || start === null ? null : localDateOrNull(timeZone, start);
  const endDate = timeZone === null || end === null ? null : localDateOrNull(timeZone, end);
  const rmtDate = timeZone === null || rmt === null ? null : localDateOrNull(timeZone, rmt);
  const ended = start !== null && end !== null && rmt !== null && start < end
    && startDate !== null && endDate !== null && rmtDate !== null && startDate === endDate
    ? rmtDate === startDate && rmt >= end
    : null;
  return {
    exchangeSessionDate: startDate,
    regularStart: start === null ? null : formatJstOrNull(start * 1000),
    regularEnd: end === null ? null : formatJstOrNull(end * 1000),
    regularEndSec: end,
    regularMarketTime: rmt === null ? null : formatJstOrNull(rmt * 1000),
    regularMarketTimeSec: rmt,
    ended,
  };
}

function chartMeta(json: unknown): Record<string, unknown> | null {
  const result = asRecord(asRecord(json)?.chart)?.result;
  if (!Array.isArray(result)) return null;
  return asRecord(asRecord(result[0])?.meta);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** macro-session.ts localDateOf と同じ日付化。tz 不正は null（ログ用）。 */
function localDateOrNull(timeZone: string, timestampSec: number): string | null {
  if (!Number.isFinite(timestampSec)) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(timestampSec * 1000));
  } catch {
    return null;
  }
}

/** JST の ISO。時刻が不正、または部品が欠けるときは null。 */
function formatJstOrNull(ms: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const pick = (type: Intl.DateTimeFormatPartTypes): string | null => {
      const value = parts.find((part) => part.type === type)?.value;
      return value === undefined || value === "" ? null : value;
    };
    const year = pick("year");
    const month = pick("month");
    const day = pick("day");
    const hour = pick("hour");
    const minute = pick("minute");
    const second = pick("second");
    if (year === null || month === null || day === null || hour === null || minute === null || second === null) {
      return null;
    }
    return `${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`;
  } catch {
    return null;
  }
}

function dateOrNull(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : null;
}

function selectHoldAttempt(
  attempts: readonly MacroHoldAttemptLog[],
  target: string
): MacroHoldAttemptLog | null {
  let latest: MacroHoldAttemptLog | null = null;
  let latestBytes: MacroHoldAttemptLog | null = null;
  for (const attempt of attempts) {
    if (typeof attempt !== "object" || attempt === null) continue;
    if (attempt.target !== target || typeof attempt.attempt !== "number" || !Number.isFinite(attempt.attempt)) {
      continue;
    }
    if (latest === null || attempt.attempt > latest.attempt) latest = attempt;
    if (attempt.bytes instanceof Uint8Array && attempt.bytes.length > 0
      && (latestBytes === null || attempt.attempt > latestBytes.attempt)) {
      latestBytes = attempt;
    }
  }
  if (latestBytes !== null) return latestBytes;
  return latest;
}

function holdFetchTimes(
  attempt: MacroHoldAttemptLog | null,
  jpReceivedAt: string | null
): { receivedAt: string | null; completedAt: string | null } {
  if (attempt !== null) {
    return { receivedAt: isoOrNull(attempt.receivedAt), completedAt: isoOrNull(attempt.completedAt) };
  }
  return { receivedAt: isoOrNull(jpReceivedAt), completedAt: null };
}

function macroHoldLine(fields: {
  symbol: string;
  sessionDate: string | null;
  clock: ChartSessionClock;
  receivedAt: string | null;
  completedAt: string | null;
  attempt: number | null;
  reason: string | null;
}): string {
  return `${INC_FINANCIALS_STALE_TAG} macro-hold ${JSON.stringify({
    symbol: fields.symbol,
    sessionDate: fields.sessionDate,
    exchangeSessionDate: fields.clock.exchangeSessionDate,
    regularStart: fields.clock.regularStart,
    regularEnd: fields.clock.regularEnd,
    regularEndSec: fields.clock.regularEndSec,
    regularMarketTime: fields.clock.regularMarketTime,
    regularMarketTimeSec: fields.clock.regularMarketTimeSec,
    ended: fields.clock.ended,
    receivedAt: fields.receivedAt,
    completedAt: fields.completedAt,
    attempt: fields.attempt,
    reason: fields.reason,
  })}`;
}

/**
 * マクロ gate HOLD の材料を、記号ごとに 1 行へする。
 * sessionDate は draft に採用した確定日。ended は原文の session 時計から
 * macro-session.ts と同じ式で読み直した観測値で、gate には戻さない。
 */
export function formatMacroGateHoldLines(input: MacroGateHoldLogInput): string[] {
  const attempts = Array.isArray(input.attempts) ? input.attempts : [];
  const reason = typeof input.reason === "string" ? macroHoldReasonCode(input.reason) : null;
  const charts = input.charts;
  const lines: string[] = [];
  for (const symbol of MACRO_HOLD_CHART_SYMBOLS) {
    const attempt = selectHoldAttempt(attempts, symbol);
    const times = holdFetchTimes(attempt, symbol === "^N225" ? input.jpN225ReceivedAt : null);
    const chart = charts === undefined || charts === null ? undefined : charts[symbol];
    lines.push(macroHoldLine({
      symbol,
      sessionDate: dateOrNull(chart === undefined ? null : chart.date),
      clock: readChartSessionClock(attempt?.bytes ?? null),
      receivedAt: times.receivedAt,
      completedAt: times.completedAt,
      attempt: attempt === null ? null : attempt.attempt,
      reason,
    }));
  }
  const viAttempt = selectHoldAttempt(attempts, "NIKKEI_VI");
  const viTimes = holdFetchTimes(viAttempt, input.jpViReceivedAt);
  lines.push(macroHoldLine({
    symbol: "NIKKEI_VI",
    sessionDate: dateOrNull(input.nikkeiViDate),
    clock: { ...EMPTY_CLOCK },
    receivedAt: viTimes.receivedAt,
    completedAt: viTimes.completedAt,
    attempt: viAttempt === null ? null : viAttempt.attempt,
    reason,
  }));
  return lines;
}

/** JP leg が無く、米国取得を始めなかった HOLD。 */
export function formatMissingJpLegHoldLine(expectedDate: string): string {
  return `${INC_FINANCIALS_STALE_TAG} jp-leg-missing ${JSON.stringify({
    reason: "missing_jp_leg",
    expectedDate: dateOrNull(expectedDate),
  })}`;
}

function nextCalendarDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (match === null) throw new Error(`日付が不正です: ${isoDate}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`実在しない日付です: ${isoDate}`);
  }
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
