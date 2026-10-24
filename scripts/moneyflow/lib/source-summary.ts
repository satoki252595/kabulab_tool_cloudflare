import type { MoneyflowNotYetPublishedReason } from "../../../services/moneyflow/lib/source-spec.js";
import { isoWeekLabelOf } from "../../../services/moneyflow/lib/iso-week.js";
import { isCalendarDateString } from "../../../src/shared/vwap/proof.js";

/** source選択の正本はingest.tsのSOURCES。ここでは集合の重複とlaneだけを検証する。 */
export type MoneyflowLane = "non-yahoo" | "yahoo";
export interface MoneyflowSummary {
  version: 1;
  runId: string;
  lane: MoneyflowLane;
  requestedSources: readonly string[];
  only: readonly string[];
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  outcomes: readonly { source: string; ok: boolean; detail: string; reason?: MoneyflowNotYetPublishedReason }[];
  notion: { requests: number; rateLimited: number; transientRetries: number };
}

export function moneyflowLaneSources(selected: readonly string[], all: readonly string[], lane: MoneyflowLane): string[] {
  if (new Set(all).size !== all.length || !all.includes("global-indices") ||
      new Set(selected).size !== selected.length || selected.some(source => !all.includes(source))) {
    throw new Error("moneyflow source集合に未知/重複があります");
  }
  return selected.filter(source => (source === "global-indices") === (lane === "yahoo"));
}

function isoMs(value: unknown): number {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error("moneyflow summaryの実時計が不正です");
  }
  return Date.parse(value);
}

/** 起動受付は予定時刻。実時計の23:40は moneyflowScheduledWindow が残す。 */
export function assertMoneyflowScheduledAt(plannedDate: string, scheduledAtMs: number): void {
  const floor = Date.parse(`${plannedDate}T09:15:00.000Z`);
  const cutoff = Date.parse(`${plannedDate}T14:40:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plannedDate) || !Number.isFinite(floor) || new Date(floor).toISOString().slice(0, 10) !== plannedDate || [0, 6].includes(new Date(floor).getUTCDay())) {
    throw new Error("moneyflow joinの予定日が不正です");
  }
  if (!Number.isFinite(scheduledAtMs) || scheduledAtMs < floor || scheduledAtMs >= cutoff) {
    throw new Error("moneyflowの予定時刻が18:15〜23:40 JSTの範囲外です");
  }
}

export function moneyflowScheduledWindow(plannedDate: string, nowMs: number): { floor: number; cutoff: number } {
  const floor = Date.parse(`${plannedDate}T09:15:00.000Z`), cutoff = Date.parse(`${plannedDate}T14:40:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plannedDate) || !Number.isFinite(floor) || new Date(floor).toISOString().slice(0, 10) !== plannedDate || [0, 6].includes(new Date(floor).getUTCDay())) {
    throw new Error("moneyflow joinの予定日が不正です");
  }
  if (!Number.isFinite(nowMs) || nowMs < floor || nowMs >= cutoff) throw new Error("moneyflow joinの実23:40期限外です");
  return { floor, cutoff };
}

/** 定時laneだけのHTTP期限。待機後のNotion/Yahoo送信も元signalと共に止める。 */
export function installMoneyflowDeadline(date: string): () => void {
  const { cutoff } = moneyflowScheduledWindow(date, Date.now());
  const nativeFetch = globalThis.fetch, signal = AbortSignal.timeout(cutoff - Date.now());
  const guarded: typeof fetch = (input, init) => {
    moneyflowScheduledWindow(date, Date.now());
    const original = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
    return nativeFetch(input, { ...init, signal: original ? AbortSignal.any([original, signal]) : signal });
  };
  globalThis.fetch = guarded;
  return () => { if (globalThis.fetch === guarded) globalThis.fetch = nativeFetch; };
}

interface SummaryContext {
  requested: readonly string[]; all: readonly string[]; runId: string; nowMs: number; dryRun: boolean;
  floor?: number; cutoff?: number;
}

function qualifySummary(raw: unknown, options: SummaryContext, allowKnownFailures: boolean): MoneyflowSummary {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("moneyflow summary objectがありません");
  const s = raw as MoneyflowSummary;
  if (s.version !== 1 || s.runId !== options.runId || (s.lane !== "non-yahoo" && s.lane !== "yahoo") ||
      s.dryRun !== options.dryRun || (options.floor !== undefined && s.dryRun) ||
      !Array.isArray(s.requestedSources) || JSON.stringify(s.requestedSources) !== JSON.stringify(options.requested) ||
      !Array.isArray(s.only) || JSON.stringify(s.only) !== JSON.stringify(moneyflowLaneSources(options.requested, options.all, s.lane)) ||
      !Array.isArray(s.outcomes) || s.outcomes.length !== s.only.length ||
      typeof s.notion !== "object" || s.notion === null ||
      [s.notion.requests, s.notion.rateLimited, s.notion.transientRetries].some(n => !Number.isSafeInteger(n) || n < 0)) {
    throw new Error("moneyflow summaryのrun/lane/source集合が一致しません");
  }
  const started = isoMs(s.startedAt), done = isoMs(s.finishedAt);
  if (done < started || done > options.nowMs || (options.floor !== undefined && started < options.floor) ||
      (options.cutoff !== undefined && done >= options.cutoff)) throw new Error("moneyflow summaryの実開始/完了時計が期限外です");
  for (let i = 0; i < s.outcomes.length; i++) {
    const outcome = s.outcomes[i];
    if (outcome === null || typeof outcome !== "object" || outcome.source !== s.only[i] ||
        typeof outcome.ok !== "boolean" ||
        typeof outcome.detail !== "string" || outcome.detail.trim() === "") throw new Error("moneyflow sourceに欠落/重複/失敗があります");
    const reason = outcome.reason;
    if (reason !== undefined && (reason === null || typeof reason !== "object" || outcome.source !== "cftc-cot-jpy" || outcome.ok !== false ||
        reason.code !== "not_yet_published" || !isCalendarDateString(reason.expectedAsOfDate) ||
        !isCalendarDateString(reason.expectedReleaseDate) || !isCalendarDateString(reason.latestPublishedAsOfDate) ||
        reason.latestPublishedAsOfDate >= reason.expectedAsOfDate ||
        new Date(`${reason.expectedAsOfDate}T00:00:00Z`).getUTCDay() !== 2 ||
        Date.parse(reason.expectedReleaseDate) - Date.parse(reason.expectedAsOfDate) !== 3 * 86_400_000 ||
        reason.period !== isoWeekLabelOf(new Date(`${reason.expectedAsOfDate}T00:00:00Z`)))) {
      throw new Error("moneyflow未公表理由のsource/期間/予定日が不正です");
    }
    if (!outcome.ok && !allowKnownFailures) {
      if (reason !== undefined) throw new Error(`moneyflow not_yet_published: ${outcome.source} ${reason.period} ` +
        `(基準日=${reason.expectedAsOfDate}, 公表予定=${reason.expectedReleaseDate}, 観測最新=${reason.latestPublishedAsOfDate}) は未充足です`);
      throw new Error("moneyflow sourceに欠落/重複/失敗があります");
    }
  }
  return s;
}

/** 正常に閉じた非Yahoo全sourceだけが次laneを許可する。失敗は最終joinで失敗のまま。 */
export function qualifyMoneyflowPredecessor(options: Omit<SummaryContext, "floor" | "cutoff"> & { summary: unknown; plannedDate?: string }): void {
  if (!/^[1-9]\d*\.[1-9]\d*$/.test(options.runId) || !Number.isFinite(options.nowMs)) throw new Error("moneyflow predecessorのrun/clockが不正です");
  const window = options.plannedDate === undefined ? {} : moneyflowScheduledWindow(options.plannedDate, options.nowMs);
  const summary = qualifySummary(options.summary, { ...options, ...window }, true);
  if (summary.lane !== "non-yahoo") throw new Error("moneyflow predecessorは非Yahoo laneだけです");
}

/** 同runの実summaryを照合するだけ。欠落・片側失敗を補完して成功にしない。 */
export function joinMoneyflowSummaries(options: {
  requested: readonly string[]; all: readonly string[]; runId: string;
  summaries: readonly unknown[]; plannedDate?: string; nowMs: number; dryRun: boolean;
}): { sources: string[]; finishedAt: string; notionRequests: number } {
  if (!/^[1-9]\d*\.[1-9]\d*$/.test(options.runId) || !Number.isFinite(options.nowMs) || options.summaries.length !== 2) {
    throw new Error("moneyflow joinのrun/summary数/実時計が不正です");
  }
  let floor: number | undefined, cutoff: number | undefined;
  if (options.plannedDate !== undefined) {
    ({ floor, cutoff } = moneyflowScheduledWindow(options.plannedDate, options.nowMs));
  }
  const lanes = new Set<string>(), actual = new Set<string>();
  let finished = -Infinity;
  let notionRequests = 0;
  for (const raw of options.summaries) {
    const s = qualifySummary(raw, { ...options, floor, cutoff }, false);
    if (lanes.has(s.lane)) throw new Error("moneyflow summaryのrun/lane/source集合が一致しません");
    lanes.add(s.lane);
    const done = isoMs(s.finishedAt);
    finished = Math.max(finished, done);
    notionRequests += s.notion.requests;
    for (let i = 0; i < s.outcomes.length; i++) {
      const outcome = s.outcomes[i];
      if (outcome === null || typeof outcome !== "object" || outcome.source !== s.only[i] || outcome.ok !== true ||
          typeof outcome.detail !== "string" || outcome.detail.trim() === "" || actual.has(outcome.source)) {
        throw new Error("moneyflow sourceに欠落/重複/失敗があります");
      }
      actual.add(outcome.source);
    }
  }
  if (actual.size !== options.requested.length || options.requested.some(source => !actual.has(source))) {
    throw new Error("moneyflow joinの全source集合が一致しません");
  }
  return { sources: [...options.requested], finishedAt: new Date(finished).toISOString(), notionRequests };
}
