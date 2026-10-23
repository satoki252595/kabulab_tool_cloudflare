import { afterEach, describe, expect, it, vi } from "vitest";
import { SOURCES, indicatorsForSources, parseOnlyArg } from "../ingest.js";
import { installMoneyflowDeadline, joinMoneyflowSummaries, moneyflowLaneSources, moneyflowScheduledWindow, qualifyMoneyflowPredecessor, type MoneyflowSummary } from "./source-summary.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

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
    const yahooKeys = new Set(indicatorsForSources(b.only).map(indicator => indicator.key));
    expect(indicatorsForSources(moneyflowLaneSources(SOURCES, SOURCES, "non-yahoo"))
      .filter(indicator => yahooKeys.has(indicator.key))).toEqual([]);
  });
  it("両laneの重なった実行とどちらが先に完了した場合も、全source成功後だけjoinする", () => {
    const a = summary("non-yahoo"), b = summary("yahoo");
    b.startedAt = `${date}T09:16:00.000Z`;
    for (const finishedAt of [`${date}T10:00:00.000Z`, `${date}T13:31:00.000Z`]) {
      b.finishedAt = finishedAt;
      const expected = Date.parse(a.finishedAt) > Date.parse(b.finishedAt) ? a.finishedAt : b.finishedAt;
      expect(join([b, a]).finishedAt).toBe(expected);
      b.outcomes[0].ok = false;
      expect(() => join([a, b])).toThrow("欠落/重複/失敗");
      b.outcomes[0].ok = true;
    }
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
    expect(() => moneyflowScheduledWindow(date, Date.parse(`${date}T14:40:00.000Z`))).toThrow();
    expect(() => moneyflowScheduledWindow(date, Date.parse(`${date}T14:40:00.001Z`))).toThrow();
    expect(() => moneyflowScheduledWindow("2026-02-30", nowMs)).toThrow();
    expect(() => moneyflowScheduledWindow("2026-10-17", Date.parse("2026-10-17T10:00:00.000Z"))).toThrow();
    expect(() => join([summary("non-yahoo"), summary("yahoo")], requested, { nowMs: Date.parse(`${date}T14:40:00.001Z`) })).toThrow();
    for (const clock of [`${date}T14:40:00.001Z`, "2026-10-17T00:00:00.000Z", "not-a-clock"]) {
      const b = summary("yahoo"); b.finishedAt = clock;
      expect(() => join([summary("non-yahoo"), b])).toThrow();
    }
  });
  it("既知のsource失敗で完全閉鎖した非Yahooだけを後続に許可し、最終joinは失敗を保持する", () => {
    const a = summary("non-yahoo"); a.outcomes[0].ok = false; a.outcomes[0].detail = "declared upstream503";
    const qualify = (s: unknown) => qualifyMoneyflowPredecessor({ summary:s, requested, all:SOURCES,
      runId:"38879272134.1", plannedDate:date, nowMs, dryRun:false });
    expect(() => qualify(a)).not.toThrow();
    expect(() => join([a,summary("yahoo")])).toThrow("欠落/重複/失敗");
    for (const value of [undefined, {}, { ...a, runId:"38879272134.2" }, { ...a, outcomes:a.outcomes.slice(1) },
      { ...a, outcomes:[{...a.outcomes[0],ok:"unknown"},...a.outcomes.slice(1)] }, summary("yahoo")]) expect(() => qualify(value)).toThrow();
  });
  it("source内で締切を跨いでも次のHTTPを送らず、元のabort signalを保持する", async () => {
    vi.useFakeTimers({toFake:["Date"]}); vi.setSystemTime(`${date}T14:39:59.000Z`);
    const native = vi.fn<typeof fetch>(async()=>new Response("ack")); vi.stubGlobal("fetch",native);
    const restore = installMoneyflowDeadline(date), original = new AbortController();
    try {
      await fetch("https://example.invalid",{signal:original.signal});
      original.abort(); expect(native.mock.calls[0][1]?.signal?.aborted).toBe(true);
      vi.setSystemTime(`${date}T14:40:00.000Z`);
      expect(()=>fetch("https://example.invalid",{method:"POST"})).toThrow("23:40");
      expect(native).toHaveBeenCalledTimes(1);
    } finally { restore(); }
    expect(globalThis.fetch).toBe(native);
  });
});
