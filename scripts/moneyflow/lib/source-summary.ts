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
  outcomes: readonly { source: string; ok: boolean; detail: string }[];
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

export function moneyflowScheduledWindow(plannedDate: string, nowMs: number): { floor: number; cutoff: number } {
  const floor = Date.parse(`${plannedDate}T09:15:00.000Z`), cutoff = Date.parse(`${plannedDate}T14:40:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plannedDate) || !Number.isFinite(floor) || new Date(floor).toISOString().slice(0, 10) !== plannedDate || [0, 6].includes(new Date(floor).getUTCDay())) {
    throw new Error("moneyflow joinの予定日が不正です");
  }
  if (!Number.isFinite(nowMs) || nowMs < floor || nowMs > cutoff) throw new Error("moneyflow joinの実23:40期限外です");
  return { floor, cutoff };
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
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("moneyflow summary objectがありません");
    const s = raw as MoneyflowSummary;
    if (s.version !== 1 || s.runId !== options.runId || (s.lane !== "non-yahoo" && s.lane !== "yahoo") ||
        lanes.has(s.lane) || s.dryRun !== options.dryRun || (floor !== undefined && s.dryRun) ||
        !Array.isArray(s.requestedSources) || JSON.stringify(s.requestedSources) !== JSON.stringify(options.requested) ||
        !Array.isArray(s.only) || JSON.stringify(s.only) !== JSON.stringify(moneyflowLaneSources(options.requested, options.all, s.lane)) ||
        !Array.isArray(s.outcomes) || s.outcomes.length !== s.only.length ||
        typeof s.notion !== "object" || s.notion === null ||
        [s.notion.requests, s.notion.rateLimited, s.notion.transientRetries].some(n => !Number.isSafeInteger(n) || n < 0)) {
      throw new Error("moneyflow summaryのrun/lane/source集合が一致しません");
    }
    lanes.add(s.lane);
    const started = isoMs(s.startedAt), done = isoMs(s.finishedAt);
    if (done < started || done > options.nowMs || (floor !== undefined && started < floor) || (cutoff !== undefined && done > cutoff)) {
      throw new Error("moneyflow summaryの実開始/完了時計が期限外です");
    }
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
