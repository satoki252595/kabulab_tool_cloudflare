import { describe, expect, it } from "vitest";
import { SOURCES, parseOnlyArg } from "../ingest.js";
import { joinMoneyflowSummaries, moneyflowLaneSources, moneyflowScheduledWindow, type MoneyflowSummary } from "./source-summary.js";

const requested = parseOnlyArg(["--only=independent"], SOURCES);
const date = "2026-10-16", nowMs = Date.parse(`${date}T14:00:00.000Z`);
function summary(lane: "yahoo" | "non-yahoo", selected = requested): MoneyflowSummary {
  const only = moneyflowLaneSources(selected, SOURCES, lane);
  return { version: 1, runId: "38879272134.1", lane, requestedSources: selected, only, dryRun: false,
    startedAt: lane === "non-yahoo" ? `${date}T09:15:30.000Z` : `${date}T12:30:00.000Z`,
    finishedAt: lane === "non-yahoo" ? `${date}T12:25:41.082Z` : `${date}T13:31:00.000Z`,
    outcomes: only.map(source => ({ source, ok: true, detail: "原本と全観測行の正常照合" })),
    notion: { requests: 0, rateLimited: 0, transientRetries: 0 } };
}
const join = (summaries: unknown[], selected = requested, override = {}) => joinMoneyflowSummaries({
  requested: selected, all: SOURCES, runId: "38879272134.1", summaries,
  plannedDate: date, nowMs, dryRun: false, ...override,
});

describe("同runのmoneyflow source集合join", () => {
  it("正本29のindependent28を27+1に分け、各lane内のsource順を保つ", () => {
    const a = summary("non-yahoo"), b = summary("yahoo");
    expect(a.only).toHaveLength(27); expect(b.only).toEqual(["global-indices"]);
    expect(join([a, b]).sources).toEqual(requested);
    expect(new Set([...a.only, ...b.only]).size).toBe(28);
  });
  it.each([
    { selected: ["sector-turnover"] }, { selected: ["global-indices"] }, { selected: ["coingecko-global", "global-indices"] },
    { selected: ["global-indices", "jpx-short-selling", "coingecko-global"] },
  ])("手動subset $selectedも空laneを含めて過不足なくjoinする", ({ selected }) => {
    expect(join([summary("non-yahoo", selected), summary("yahoo", selected)], selected, { plannedDate: undefined }).sources).toEqual(selected);
  });
  it("source重複/未知・片側欠落・別run・false-green・取得順改変を拒否する", () => {
    expect(() => moneyflowLaneSources(["global-indices", "global-indices"], SOURCES, "yahoo")).toThrow();
    expect(() => moneyflowLaneSources(["unknown"], SOURCES, "non-yahoo")).toThrow();
    expect(() => join([summary("non-yahoo")])).toThrow();
    expect(() => join([summary("non-yahoo"), summary("non-yahoo")])).toThrow();
    for (const change of [
      (s: MoneyflowSummary) => { s.runId = "38879272134.2"; },
      (s: MoneyflowSummary) => { s.outcomes[0].ok = false; },
      (s: MoneyflowSummary) => { s.outcomes = []; },
      (s: MoneyflowSummary) => { s.only = ["coingecko-global"]; },
      (s: MoneyflowSummary) => { s.requestedSources = [...s.requestedSources].reverse(); },
      (s: MoneyflowSummary) => { s.dryRun = true; },
      (s: MoneyflowSummary) => { s.outcomes = [s.outcomes[0], s.outcomes[0]]; },
    ]) {
      const b = summary("yahoo"); change(b);
      expect(() => join([summary("non-yahoo"), b])).toThrow();
    }
  });
  it("実23:40超・queue後の期限切れ・別日/不正clockを拒否する", () => {
    expect(() => moneyflowScheduledWindow(date, Date.parse(`${date}T14:40:00.001Z`))).toThrow();
    expect(() => moneyflowScheduledWindow("2026-02-30", nowMs)).toThrow();
    expect(() => join([summary("non-yahoo"), summary("yahoo")], requested, { nowMs: Date.parse(`${date}T14:40:00.001Z`) })).toThrow();
    for (const clock of [`${date}T14:40:00.001Z`, "2026-10-17T00:00:00.000Z", "not-a-clock"]) {
      const b = summary("yahoo"); b.finishedAt = clock;
      expect(() => join([summary("non-yahoo"), b])).toThrow();
    }
  });
});
