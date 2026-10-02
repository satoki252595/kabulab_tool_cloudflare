/**
 * Daily fetch proof の共有純粋 guard + zero-split 適格判定。
 *
 * Worker/Node 両用・依存ゼロ。ingest (writer)・API (serve/qualify)・
 * テストが同一 logic を使う (ONE contract)。node:crypto・env を import
 * しないこと (Workers 配信 path から import される)。
 */
import type { DailyFetchProof } from "../yahoo/client.js";

/** YYYY-MM-DD の暦妥当性 (ingest-guard isCalendarDate と同一 logic)。 */
export function isCalendarDateString(d: unknown): d is string {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const ms = Date.parse(`${d}T00:00:00Z`);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === d;
}

/**
 * 厳格 ISO UTC 時刻 (toISOString 形)。Date.parse 単独は存在しない日付の
 * 繰り上げ・緩い文字列を通すため、日付部は暦検証・時刻部は範囲検証する。
 */
export function isStrictIsoUtc(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?Z$/.exec(s);
  if (!m) return false;
  if (!isCalendarDateString(m[1])) return false;
  const h = Number(m[2]);
  const min = Number(m[3]);
  const sec = Number(m[4]);
  if (h > 23 || min > 59 || sec > 59) return false;
  return Number.isFinite(Date.parse(s));
}

/** 秒 ts → JST 日付 (yahoo/client jstDate と同一式)。 */
export const jstDateSec = (ts: number): string =>
  new Date((ts + 32400) * 1000).toISOString().slice(0, 10);

/** DailyFetchProof の形状検証 (保存物・応答物の strict-when-present 用)。 */
export function isDailyFetchProof(p: unknown): p is DailyFetchProof {
  if (p === null || typeof p !== "object" || Array.isArray(p)) return false;
  const o = p as Record<string, unknown>;
  if (!isStrictIsoUtc(o.observedAt)) return false;
  if (typeof o.rawSha !== "string" || !/^[0-9a-f]{64}$/.test(o.rawSha)) return false;
  if (typeof o.requestedRange !== "string" || o.requestedRange.length === 0) return false;
  if (typeof o.symbol !== "string" || o.symbol.length === 0) return false;
  const { firstTs, lastTs } = o as { firstTs?: unknown; lastTs?: unknown };
  const tsOk = (t: unknown): t is number | null =>
    t === null || (typeof t === "number" && Number.isFinite(t) && t > 0);
  if (!tsOk(firstTs) || !tsOk(lastTs)) return false;
  // 空 span は両 null のみ (片 null は不正)。
  if ((firstTs === null) !== (lastTs === null)) return false;
  if (firstTs !== null && lastTs !== null && firstTs > lastTs) return false;
  if (!Array.isArray(o.splits)) return false;
  for (const s of o.splits as unknown[]) {
    if (s === null || typeof s !== "object" || Array.isArray(s)) return false;
    const e = s as Record<string, unknown>;
    if (!isCalendarDateString(e.date)) return false;
    if (typeof e.ratio !== "number" || !Number.isFinite(e.ratio) || e.ratio <= 0) return false;
  }
  return true;
}

export type IntraBarShape = {
  ts?: unknown; o?: unknown; h?: unknown; l?: unknown; c?: unknown; v?: unknown;
};

/**
 * 5m bar 形状 (findInvalidBars + ts>0 と同一。adj は 5m に無い)。
 * ts 重複は object 単位で別途見る。
 */
export function isIntraBarShape(b: unknown): boolean {
  if (b === null || typeof b !== "object" || Array.isArray(b)) return false;
  const r = b as Record<string, unknown>;
  if (typeof r.ts !== "number" || !Number.isFinite(r.ts) || r.ts <= 0) return false;
  for (const k of ["o", "h", "l", "c"] as const) {
    if (typeof r[k] !== "number" || !Number.isFinite(r[k] as number) || (r[k] as number) <= 0) return false;
  }
  if (typeof r.v !== "number" || !Number.isFinite(r.v) || (r.v as number) < 0) return false;
  if ((r.h as number) < (r.l as number)) return false;
  return true;
}

export type DailyBarShape = {
  date?: unknown; o?: unknown; h?: unknown; l?: unknown; c?: unknown; v?: unknown; adj?: unknown;
};

/**
 * 日足 bar 形状 (金融 schema は date/OHLCV のみ。adj は見ない)。
 * legacy bytes の adj (正負問わず) は原文保管として温存し、検証しない。
 */
export function isDailyBarShape(b: unknown): boolean {
  if (b === null || typeof b !== "object" || Array.isArray(b)) return false;
  const r = b as Record<string, unknown>;
  if (!isCalendarDateString(r.date)) return false;
  for (const k of ["o", "h", "l", "c"] as const) {
    if (typeof r[k] !== "number" || !Number.isFinite(r[k] as number) || (r[k] as number) <= 0) return false;
  }
  if (typeof r.v !== "number" || !Number.isFinite(r.v) || (r.v as number) < 0) return false;
  if ((r.h as number) < (r.l as number)) return false;
  return true;
}

export type IntraWindow = { firstTs: number; lastTs: number; bars: number; sessions: string[] };

/** 検証済み bars から window を実測する (純粋。bars は非空・shape 済み)。 */
export function intraWindowOf(tsList: readonly number[]): IntraWindow {
  let firstTs = Infinity;
  let lastTs = -Infinity;
  const sessions = new Set<string>();
  for (const ts of tsList) {
    if (ts < firstTs) firstTs = ts;
    if (ts > lastTs) lastTs = ts;
    sessions.add(jstDateSec(ts));
  }
  return { firstTs, lastTs, bars: tsList.length, sessions: [...sessions].sort() };
}

export type ZeroSplitReason =
  | "span-mismatch"
  | "sessions-uncovered"
  | "splits-mismatch"
  | "in-window-split"
  | "range-not-10y";

/**
 * zero-split 適格 (full gate)。全条件を満たす場合のみ適格:
 * - proof span (JST 暦日) が daily bars の first/last と一致
 *   (latest anchor。秒比較はしない — session-start 時刻と場中/引け
 *   時刻の直接比較は同日最終 session を誤却下するため)。
 * - intra の全 sessions が daily bar 日付に存在する。
 * - 今回span前の保存済み旧split（proofにも無い）のみ比較対象外。
 *   span内欠落・最終日後・proofが返したspan外splitは一致を必須とする。
 * - 保存窓の初日から日足の最終日までに分割がない。窓終了後の分割も
 *   現在の日足との株数基準を変えるため、未確認の旧5分足を適格にしない。
 * - proof.requestedRange が "10y" (full-10y のみ。構造の後・最後に見る)。
 * daily bars/splits は検証済み (isDailyBarShape 等) のものを受け取る。
 */
export function zeroSplitCovered(
  proof: DailyFetchProof,
  window: IntraWindow,
  barDates: readonly string[],
  dailySplits: readonly { date: string; ratio: number }[]
): { ok: true } | { ok: false; reason: ZeroSplitReason } {
  if (proof.firstTs === null || proof.lastTs === null || barDates.length === 0) {
    return { ok: false, reason: "span-mismatch" };
  }
  let barFirst = barDates[0];
  let barLast = barDates[0];
  for (const d of barDates) {
    if (d < barFirst) barFirst = d;
    if (d > barLast) barLast = d;
  }
  if (jstDateSec(proof.firstTs) !== barFirst || jstDateSec(proof.lastTs) !== barLast) {
    return { ok: false, reason: "span-mismatch" };
  }
  const have = new Set<string>(barDates);
  for (const s of window.sessions) {
    if (!have.has(s)) return { ok: false, reason: "sessions-uncovered" };
  }
  const proofDates = new Set(proof.splits.map((s) => s.date));
  const coveredSplits = dailySplits.filter((s) => s.date >= barFirst || proofDates.has(s.date));
  if (coveredSplits.length !== proof.splits.length) {
    return { ok: false, reason: "splits-mismatch" };
  }
  const byDate = (a: { date: string }, b: { date: string }): number => (a.date < b.date ? -1 : 1);
  const ds = [...coveredSplits].sort(byDate);
  const ps = [...proof.splits].sort(byDate);
  for (let i = 0; i < ds.length; i++) {
    if (ds[i].date !== ps[i].date || ds[i].ratio !== ps[i].ratio) {
      return { ok: false, reason: "splits-mismatch" };
    }
  }
  const first = window.sessions[0];
  for (const s of dailySplits) {
    if (s.date >= first && s.date <= barLast) return { ok: false, reason: "in-window-split" };
  }
  // full-10y のみ適格。最後に置く: 構造 HOLD の診断を range で潰さない。
  // (API 境界は provenance を先に見る。両層で見るのが契約)。
  if (proof.requestedRange !== "10y") return { ok: false, reason: "range-not-10y" };
  return { ok: true };
}
