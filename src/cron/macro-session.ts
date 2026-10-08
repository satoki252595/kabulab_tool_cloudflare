/**
 * マクロ用 confirmed-bar 選択 (同一 actual JSON の session meta 基準)。
 * 対象は N225/GSPC/VIX のみ (NIY=F は snapshot のため対象外)。
 *
 * `fetchChart(..., { onRaw })` の同一 actual JSON から timestamp・
 * session・timezone を読み、現形成 session のバーを除外した上で
 * 実終値つき confirmed bar の close + 直前 actual session day の close
 * を返す。generic の価格選択・ParsedSchema は再実装しない
 * (bars は fetchChart 戻りの guard 済み)。
 *
 * 判定は SOURCE の timestamp/session/timezone だけで行い、wall clock・
 * 固定 cutoff・UTC 前日・休日推測は使わない。世界のカレンダー知識も
 * 持たない (session 日の日付比較のみ)。不十分・不整合・欠落は
 * explicit HOLD (throw)。HOLD 時も older-bar の状況は正直に記録するが
 * confirm には使わない。older バーへの黙殺代替はしない。
 */
import type { DailyOhlcv } from "../shared/types.js";

export interface ConfirmedCloses {
  /** 最新 confirmed bar の close (実終値)。取れなければ throw (HOLD) */
  value: number;
  /** 確定 session day より前の直近 session day の close。無ければ null */
  prev: number | null;
  /** value バーの日付 ('YYYY-MM-DD', UTC。bar 日付と同一基準) */
  date: string;
}

interface SessionEvidence {
  timestamps: readonly number[];
  closes: readonly (number | null)[];
  regularStart: number;
  regularEnd: number;
  regularMarketTime: number;
  timeZone: string;
}

function hold(symbol: string, why: string, bars: DailyOhlcv[]): never {
  throw new Error(`マクロ HOLD: ${symbol} ${why} (${olderBarEvidence(bars)})`);
}

/** raw JSON の検証 + session 証拠の抽出。 */
function readSessionEvidence(
  raw: Uint8Array,
  symbol: string,
  bars: DailyOhlcv[]
): SessionEvidence {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    hold(symbol, "の原文 JSON を読めません", bars);
  }
  const r0 = (
    json as {
      chart?: { result?: Array<Record<string, unknown>> };
    }
  )?.chart?.result?.[0] as
    | {
      meta?: {
        symbol?: unknown;
        dataGranularity?: unknown;
        exchangeTimezoneName?: unknown;
        regularMarketTime?: unknown;
        currentTradingPeriod?: {
          regular?: { start?: unknown; end?: unknown };
        };
      };
      timestamp?: unknown;
      indicators?: { quote?: Array<{ close?: unknown }> };
    }
    | undefined;
  const meta = r0?.meta;
  if (meta?.symbol !== symbol) {
    hold(symbol, `の原文 symbol 不一致 (${String(meta?.symbol)})`, bars);
  }
  if (meta?.dataGranularity !== "1d") {
    hold(symbol, "は日足 (1d) ではないため対象外", bars);
  }
  const ts = r0?.timestamp;
  if (
    !Array.isArray(ts) ||
    ts.length === 0 ||
    !ts.every((t) => typeof t === "number" && Number.isFinite(t))
  ) {
    hold(symbol, "の timestamp が無いため形成中判定不可", bars);
  }
  const stamps = ts as number[];
  for (let i = 1; i < stamps.length; i++) {
    if (!(stamps[i - 1] < stamps[i])) {
      hold(symbol, "の timestamp が狭義単調増加ではない", bars);
    }
  }
  const closes = r0?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(closes) || closes.length !== stamps.length) {
    hold(symbol, "の timestamp と close 配列の長さが合わない", bars);
  }
  const tz = meta?.exchangeTimezoneName;
  if (typeof tz !== "string" || tz === "") {
    hold(symbol, "の exchangeTimezoneName が無い", bars);
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  } catch {
    hold(symbol, `の exchange tz 不正 (${tz as string})`, bars);
  }
  const start = meta?.currentTradingPeriod?.regular?.start;
  const end = meta?.currentTradingPeriod?.regular?.end;
  const rmt = meta?.regularMarketTime;
  for (const [name, v] of [
    ["regular.start", start],
    ["regular.end", end],
    ["regularMarketTime", rmt],
  ] as const) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      hold(symbol, `の session meta (${name}) 不足のため形成中判定不可`, bars);
    }
  }
  if (!((start as number) < (end as number))) {
    hold(symbol, "の session が start<end ではない", bars);
  }
  return {
    timestamps: stamps,
    closes: closes as (number | null)[],
    regularStart: start as number,
    regularEnd: end as number,
    regularMarketTime: rmt as number,
    timeZone: tz as string,
  };
}

/** actual timezone での session 日 ('YYYY-MM-DD')。 */
function localDateOf(timeZone: string, timestampSec: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestampSec * 1000));
}

/** Yahoo 日足と同じ UTC 日付化 (`client.ts toDateString` と同一式)。 */
function utcDateOf(timestampSec: number): string {
  return new Date(timestampSec * 1000).toISOString().split("T")[0];
}

function isUsableClose(v: number | null): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * guard bars 側での証明: 既存 UTC bar 日付が ONE 該当 + close 一致。
 * 見つかればその close、無ければ null (呼び出し側が throw / null を決める)。
 */
function proveGuardClose(
  bars: DailyOhlcv[],
  utcDate: string,
  rawClose: number
): number | null {
  const hits = bars.filter((b) => b.date === utcDate);
  if (hits.length !== 1) return null;
  return hits[0].close === rawClose ? rawClose : null;
}

/**
 * confirmed bar (形成中除外・実終値つき) の close + 直前 actual close。
 *
 * candidate (raw idx):
 * - session 終了証明あり (rmt が当 session 日かつ rmt >= end) →
 *   session 日以前の最新 idx (当 session 日のバーも確定)。
 * - それ以外 → session 日より前の最新 idx ([-2] 決め打ち禁止。
 *   当 session day の重複があっても prior unique なら採用する)。
 * - 全 idx が session 日以降なら HOLD。
 * - 最新 idx が session 日より新しい (raw が session より進んでいる)
 *   不整合も HOLD。
 *
 * value: candidate の raw close (finite 正) を guard bars で ONE+一致
 * 証明。ambiguous duplicate・除去・null・非 finite・非正は HOLD
 * (older 代替 0)。
 *
 * prev: candidate session day より前の直近 session day の最新 idx を
 * 1 回だけ選び guard 証明。null・重複・不一致は explicit null
 * (null スキップ・older 代替 0)。day 自体が無ければ null。
 */
export function selectConfirmedCloses(
  raw: Uint8Array,
  bars: DailyOhlcv[],
  symbol: string
): ConfirmedCloses {
  const ev = readSessionEvidence(raw, symbol, bars);
  if (bars.length === 0) {
    hold(symbol, "にバーが無い", bars);
  }
  const localDates = ev.timestamps.map((t) => localDateOf(ev.timeZone, t));
  const sessionDate = localDateOf(ev.timeZone, ev.regularStart);
  if (localDateOf(ev.timeZone, ev.regularEnd) !== sessionDate) {
    hold(symbol, "の session が日跨ぎのため判定不能 (unknown)", bars);
  }
  const latestLocal = localDates[localDates.length - 1];
  if (latestLocal > sessionDate) {
    hold(symbol, "の原文が session より新しい (不整合)", bars);
  }
  const ended =
    localDateOf(ev.timeZone, ev.regularMarketTime) === sessionDate &&
    ev.regularMarketTime >= ev.regularEnd;
  let candidate = -1;
  for (let i = localDates.length - 1; i >= 0; i--) {
    if (ended ? localDates[i] <= sessionDate : localDates[i] < sessionDate) {
      candidate = i;
      break;
    }
  }
  if (candidate < 0) {
    hold(symbol, "は形成中のみで確定候補が無い", bars);
  }
  if (ev.timestamps[candidate] > ev.regularMarketTime) {
    hold(symbol, "の確定候補バーが quote 観測時刻より新しい (不整合)", bars);
  }
  const rawClose = ev.closes[candidate];
  const utcDate = utcDateOf(ev.timestamps[candidate]);
  const proved =
    isUsableClose(rawClose) ? proveGuardClose(bars, utcDate, rawClose) : null;
  if (proved === null) {
    hold(
      symbol,
      `の確定日 ${utcDate} の実終値を証明できない (除去・重複曖昧・null・非正のいずれか)`,
      bars
    );
  }
  const candidateDay = localDates[candidate];
  // 直前 actual session の最新 idx を 1 回だけ選ぶ。null スキップ・
  // older 代替はしない。証明できなければ explicit null。
  let priorIdx = -1;
  for (let i = candidate - 1; i >= 0; i--) {
    if (localDates[i] < candidateDay) {
      priorIdx = i;
      break;
    }
  }
  let prev: number | null = null;
  if (priorIdx >= 0) {
    const c = ev.closes[priorIdx];
    if (isUsableClose(c)) {
      prev = proveGuardClose(bars, utcDateOf(ev.timestamps[priorIdx]), c);
    }
  }
  return { value: proved, prev, date: utcDate };
}

/** INC-20261008-kabulab_tool_cloudflare-financials-stale 計測用の HOLD 理由区分。 */
export type ConfirmedCloseDiagReason =
  | "ok"
  | "null"
  | "non_finite"
  | "non_positive"
  | "duplicate"
  | "mismatch"
  | "removed"
  | "no_candidate"
  | "other";

export interface ConfirmedCloseDiag {
  reason: ConfirmedCloseDiagReason;
  /** 確定候補バーの日付 (UTC 日付。selectConfirmedCloses の date と同一基準)。候補が無ければ null */
  candidateDate: string | null;
  /** 原文 session 日 (exchange tz)。読めなければ null */
  sessionDate: string | null;
  /** session 終了証明の有無。読めなければ null */
  ended: boolean | null;
}

/**
 * 計測専用 (INC-20261008-kabulab_tool_cloudflare-financials-stale)。
 * selectConfirmedCloses と同じ候補選択をなぞり、HOLD 理由の区分だけを返す。
 * 判定・例外・戻り値には一切使わない (呼び出し側はログ出力のみ)。
 * 決して throw しない。
 */
export function diagnoseConfirmedCloses(
  raw: Uint8Array,
  bars: DailyOhlcv[],
  symbol: string
): ConfirmedCloseDiag {
  let sessionDate: string | null = null;
  let ended: boolean | null = null;
  let candidateDate: string | null = null;
  try {
    const ev = readSessionEvidence(raw, symbol, bars);
    const localDates = ev.timestamps.map((t) => localDateOf(ev.timeZone, t));
    sessionDate = localDateOf(ev.timeZone, ev.regularStart);
    ended =
      localDateOf(ev.timeZone, ev.regularMarketTime) === sessionDate &&
      ev.regularMarketTime >= ev.regularEnd;
    let candidate = -1;
    for (let i = localDates.length - 1; i >= 0; i--) {
      if (ended ? localDates[i] <= sessionDate : localDates[i] < sessionDate) {
        candidate = i;
        break;
      }
    }
    if (candidate < 0) {
      return { reason: "no_candidate", candidateDate, sessionDate, ended };
    }
    candidateDate = utcDateOf(ev.timestamps[candidate]);
    const rawClose: unknown = ev.closes[candidate];
    if (rawClose === null || rawClose === undefined) {
      return { reason: "null", candidateDate, sessionDate, ended };
    }
    if (typeof rawClose !== "number" || !Number.isFinite(rawClose)) {
      return { reason: "non_finite", candidateDate, sessionDate, ended };
    }
    if (rawClose <= 0) {
      return { reason: "non_positive", candidateDate, sessionDate, ended };
    }
    const hits = bars.filter((b) => b.date === candidateDate);
    if (hits.length === 0) {
      return { reason: "removed", candidateDate, sessionDate, ended };
    }
    if (hits.length > 1) {
      return { reason: "duplicate", candidateDate, sessionDate, ended };
    }
    if (hits[0].close !== rawClose) {
      return { reason: "mismatch", candidateDate, sessionDate, ended };
    }
    return { reason: "ok", candidateDate, sessionDate, ended };
  } catch {
    return { reason: "other", candidateDate, sessionDate, ended };
  }
}

/** HOLD 診断用に older-bar の状況だけ正直に記録する (confirm には使わない)。 */
function olderBarEvidence(bars: DailyOhlcv[]): string {
  const last = bars.at(-1)?.date ?? "なし";
  const lastClose =
    [...bars].reverse().find((b) => b.close !== null)?.date ?? "なし";
  return `最終バー ${last}・直近実終値バー ${lastClose}`;
}
