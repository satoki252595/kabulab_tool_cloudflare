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
