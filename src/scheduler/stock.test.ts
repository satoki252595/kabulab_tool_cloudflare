import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduledVwapGuard } from "../../scripts/vwap/lib/scheduled-window.js";
import {
  DISPATCH_CRON,
  READCHECK_CRON,
  CONTEXT_DISPATCH_CRON,
  CONTEXT_READCHECK_CRON,
  MONEYFLOW_DISPATCH_CRON,
  MONEYFLOW_READCHECK_CRON,
  CATCHUP_DISPATCH_CRON,
  CATCHUP_READCHECK_CRON,
  VWAP_DISPATCH_CRON,
  VWAP_READCHECK_CRON,
  vwapReceiptKey,
  evaluateVwapReadcheck,
  runVwapDispatch,
  runVwapDeadlineReadcheck,
  catchupReceiptKey,
  evaluateCatchupReadcheck,
  runCatchupDispatch,
  runCatchupDeadlineReadcheck,
  moneyflowReceiptKey,
  runMoneyflowDeadlineReadcheck,
  evaluateMoneyflowReadcheck,
  contextReceiptKey,
  evaluateContextReadcheck,
  runContextDispatch,
  runContextDeadlineReadcheck,
  claimReceipt,
  evaluateReadcheck,
  fetchAllJobs,
  handleStockScheduled,
  receiptKey,
  resolveRunDate,
  routeCron,
  runDeadlineReadcheck,
  runStockDispatch,
  saveDispatchResult,
  schedulerToken,
  type RunJob,
  type SchedulerBucket,
  type SchedulerEnv,
  type StockReceipt,
} from "./stock.js";

describe("定時VWAPは同頻度CF one-shotで開始/終了窓を検査", () => {
  const date = "2026-10-14", start = Date.parse(`${date}T08:00:00.000Z`);
  const jobs = (): RunJob[] => [{ name: "ingest", run_id: 101, status: "completed", conclusion: "success", steps: [
    { name: "VWAP daily + intra → R2", status: "completed", conclusion: "success", started_at: `${date}T08:01:00.000Z`, completed_at: `${date}T14:30:00.000Z` },
    { name: "VWAP intra backfill → R2", status: "completed", conclusion: "skipped", completed_at: null },
    { name: "VWAP margin (daily) → R2", status: "completed", conclusion: "skipped", completed_at: null },
  ] }];
  it("月水金17時と期限照会を識別し、別曜日/10分遅配はPOST/claim0", async () => {
    expect(routeCron(VWAP_DISPATCH_CRON)).toBe("vwap-dispatch");
    expect(routeCron(VWAP_READCHECK_CRON)).toBe("vwap-readcheck");
    expect(resolveRunDate("vwap-dispatch", start, start + 600_000)).toBe(date);
    const { bucket, puts } = makeBucket(), { fetchFn, calls } = makeFetch(() => jsonRes({}));
    for (const at of [start + 600_001, Date.parse("2026-10-15T08:00:00.000Z")]) {
      await expect(handleStockScheduled({ cron: VWAP_DISPATCH_CRON, scheduledTime: at === start + 600_001 ? start : at },
        { BUCKET: bucket, GITHUB_ACTIONS_TOKEN: TOKEN }, { fetchFn, nowMs: at })).rejects.toThrow();
    }
    expect(calls).toEqual([]); expect(puts).toEqual([]);
  });
  it("本番で観測した17:00:52は同じ17:00分のdispatch・receipt・Actions受付へ実時計を保持する", async () => {
    const observed = 1792137652 * 1000, now = observed + 123, observedDate = "2026-10-16";
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    try {
      const { bucket, puts } = makeBucket();
      const { fetchFn, calls } = makeFetch(() => jsonRes({ workflow_run_id: 101,
        run_url: "https://api.github.com/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/101",
        html_url: "https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/101" }));
      const controller = { cron: VWAP_DISPATCH_CRON, scheduledTime: observed }, env = { BUCKET: bucket, GITHUB_ACTIONS_TOKEN: TOKEN };
      expect(await handleStockScheduled(controller, env, { fetchFn, nowMs: now })).toEqual({ status: "dispatched", workflowRunId: 101 });
      expect(await handleStockScheduled(controller, env, { fetchFn, nowMs: now })).toEqual({ status: "duplicate", workflowRunId: 101 });
      expect(calls).toHaveLength(1);
      const payload = JSON.parse(String(calls[0].init?.body));
      expect(payload.inputs).toEqual({ target: "scheduled-daily-intra", scheduled_date: observedDate, daily_session_source: "yahoo-direct" });
      expect(puts[0].key).toBe(vwapReceiptKey(observedDate));
      expect(JSON.parse(puts[0].value)).toMatchObject({ status: "claimed", claimedAt: new Date(now).toISOString() });
      const admission = scheduledVwapGuard({ plannedDate: payload.inputs.scheduled_date, runId: "101.1", phase: "daily", nowMs: now,
        directory: mkdtempSync(join(tmpdir(), "vwap-native-clock-")) });
      expect(admission.admission).toMatchObject({ plannedDate: observedDate, admittedAt: new Date(now).toISOString() });
      expect(() => admission.assertActive()).not.toThrow();
    } finally { vi.useRealTimers(); }
  });
  it("予定時刻は17:00分だけを受け入れ、10分受付を52秒分延長しない", () => {
    for (const offset of [0, 1, 52_000, 59_999]) expect(resolveRunDate("vwap-dispatch", start + offset, start + 600_000)).toBe(date);
    for (const offset of [-1, 60_000]) expect(() => resolveRunDate("vwap-dispatch", start + offset, start + 600_000)).toThrow("17:00 JSTの分");
    expect(() => resolveRunDate("vwap-dispatch", start + 52_000, start + 600_001)).toThrow("開始期限");
  });
  it("専用receiptへ1回POSTし、同じ予定日のduplicateは再送0", async () => {
    vi.setSystemTime(new Date(start));
    const { bucket, puts } = makeBucket();
    const { fetchFn, calls } = makeFetch(() => jsonRes({ workflow_run_id: 101,
      run_url: "https://api.github.com/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/101",
      html_url: "https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/101" }));
    const deps = { bucket, token: TOKEN, cron: VWAP_DISPATCH_CRON, scheduledDate: date, nowMs: start, fetchFn };
    expect(await runVwapDispatch(deps)).toEqual({ status: "dispatched", workflowRunId: 101 });
    expect(await runVwapDispatch(deps)).toEqual({ status: "duplicate", workflowRunId: 101 });
    expect(calls).toHaveLength(1); expect(calls[0].url).toContain("vwap-ingest.yml/dispatches");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ ref: "main", inputs: {
      target: "scheduled-daily-intra", scheduled_date: date, daily_session_source: "yahoo-direct" } });
    expect(puts.map(x => x.key)).toEqual([vwapReceiptKey(date), vwapReceiptKey(date), vwapReceiptKey(date)]);
  });
  it("unknown dispatchはclaimedを保持してduplicate再送0", async () => {
    const { bucket } = makeBucket(), { fetchFn, calls } = makeFetch(() => { throw new Error("transport unknown"); });
    const controller = { cron: VWAP_DISPATCH_CRON, scheduledTime: start + 52_000 }, env = { BUCKET: bucket, GITHUB_ACTIONS_TOKEN: TOKEN };
    const deps = { nowMs: start + 52_123, fetchFn };
    await expect(handleStockScheduled(controller, env, deps)).rejects.toThrow("unknown");
    await expect(handleStockScheduled(controller, env, deps)).rejects.toThrow("未完了");
    expect(calls).toHaveLength(1);
  });
  it("readcheckは同日の一意成功・17:10内開始・23:30内完了だけ受入", () => {
    expect(evaluateVwapReadcheck(jobs(), date)).toEqual({ vwapCompletedAt: `${date}T14:30:00.000Z` });
    for (const at of [null, `${date}T07:59:59Z`, `${date}T08:10:00.001Z`, "2026-10-15T08:00:00Z"]) {
      const bad = jobs(); bad[0].steps![0].started_at = at;
      expect(() => evaluateVwapReadcheck(bad, date)).toThrow("開始期限");
    }
    for (const at of [null, `${date}T14:30:00.001Z`, `${date}T08:00:00Z`]) {
      const bad = jobs(); bad[0].steps![0].completed_at = at;
      expect(() => evaluateVwapReadcheck(bad, date)).toThrow();
    }
    for (const index of [0, 1, 2]) {
      const bad = jobs(); bad[0].steps![index].conclusion = index === 0 ? "failure" : "success";
      expect(() => evaluateVwapReadcheck(bad, date)).toThrow();
    }
    expect(() => evaluateVwapReadcheck([...jobs(), ...jobs()], date)).toThrow("一意");
  });
  it("受領済みrunのJobsを全頁照会して期限判定し、claimedは照会0", async () => {
    const raw = { ...dispatchedBody(), scheduledDate: date, cron: VWAP_DISPATCH_CRON,
      claimedAt: `${date}T08:00:00Z`, dispatchedAt: `${date}T08:00:01Z` };
    const { bucket } = makeBucket({ [vwapReceiptKey(date)]: JSON.stringify(raw) });
    const { fetchFn, calls } = makeFetch(() => jsonRes({ jobs: jobs() }));
    expect(await runVwapDeadlineReadcheck({ bucket, token: TOKEN, scheduledDate: date, fetchFn }))
      .toEqual({ vwapCompletedAt: `${date}T14:30:00.000Z` });
    expect(calls).toHaveLength(1);
    const claimed = makeBucket({ [vwapReceiptKey(date)]: JSON.stringify({ ...raw, status: "claimed" }) });
    await expect(runVwapDeadlineReadcheck({ bucket: claimed.bucket, token: TOKEN, scheduledDate: date, fetchFn })).rejects.toThrow("未完了");
    expect(calls).toHaveLength(1);
  });
});

describe("定時マクロの独立dispatchと期限確認", () => {
  const date = "2026-09-30";
  const started = Date.parse(`${date}T21:00:30.000Z`);
  const contextJobs = (): RunJob[] => [{
    name: "sync", run_id: 101, status: "completed", conclusion: "success",
    steps: [
      { name: "stock daily sync", status: "completed", conclusion: "skipped", completed_at: null },
      { name: "market context sync", status: "completed", conclusion: "success", completed_at: `${date}T21:02:00.000Z` },
    ],
  }, { name: "moneyflow", run_id: 101, status: "completed", conclusion: "skipped" }];

  it("専用cronを識別し30分遅延を超えるdispatchを拒否する", () => {
    expect(routeCron(CONTEXT_DISPATCH_CRON)).toBe("context-dispatch");
    expect(routeCron(CONTEXT_READCHECK_CRON)).toBe("context-readcheck");
    expect(resolveRunDate("context-dispatch", started, started + 30 * 60_000)).toBe(date);
    expect(() => resolveRunDate("context-dispatch", started, started + 30 * 60_000 + 1)).toThrow("開始期限");
  });

  it("株式とは別receiptをclaimしscheduled-contextを1回だけPOSTする", async () => {
    vi.setSystemTime(new Date(started));
    const { bucket, puts } = makeBucket();
    const { fetchFn, calls } = makeFetch(() => jsonRes({ workflow_run_id: 101,
      run_url: "https://api.github.com/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/101",
      html_url: "https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/101" }));
    const deps = { bucket, token: TOKEN, cron: CONTEXT_DISPATCH_CRON, scheduledDate: date, nowMs: started, fetchFn };
    expect(await runContextDispatch(deps)).toEqual({ status: "dispatched", workflowRunId: 101 });
    expect(await runContextDispatch(deps)).toEqual({ status: "duplicate", workflowRunId: 101 });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ ref: "main", inputs: { target: "scheduled-context", scheduled_date: date } });
    expect(puts[0].key).toBe(contextReceiptKey(date));
    expect(await bucket.get(receiptKey(date))).toBeNull();
  });

  it("一意のcontext成功と株式/moneyflow skipのみ成功と判定する", () => {
    expect(evaluateContextReadcheck(contextJobs(), date)).toEqual({ contextCompletedAt: `${date}T21:02:00.000Z` });
    const bad = contextJobs(); bad[1].conclusion = "success";
    expect(() => evaluateContextReadcheck(bad, date)).toThrow("skip");
    expect(() => evaluateContextReadcheck([contextJobs()[0]], date)).toThrow("skip");
    expect(() => evaluateContextReadcheck([contextJobs()[0], ...contextJobs()], date)).toThrow("一意");
  });

  it("HOLD/skip/期限超過/別日の成功を成功にしない", () => {
    for (const conclusion of ["failure", "skipped", null]) {
      const bad = contextJobs(); bad[0].steps![1].conclusion = conclusion;
      expect(() => evaluateContextReadcheck(bad, date)).toThrow("成功完了");
    }
    for (const completed of [`${date}T20:59:59.000Z`, `${date}T22:00:00.001Z`, "2026-10-01T21:02:00.000Z"]) {
      const bad = contextJobs(); bad[0].steps![1].completed_at = completed;
      expect(() => evaluateContextReadcheck(bad, date)).toThrow("範囲外");
    }
  });

  it("専用receiptのcron不一致ではJobs照会をしない", async () => {
    const { bucket } = makeBucket({ [contextReceiptKey(date)]: JSON.stringify(dispatchedBody()) });
    const { fetchFn, calls } = makeFetch(() => jsonRes({ jobs: contextJobs() }));
    await expect(runContextDeadlineReadcheck({ bucket, token: TOKEN, scheduledDate: date, fetchFn })).rejects.toThrow("cron");
    expect(calls).toEqual([]);
  });
});

/**
 * R2 conditional PUT 意味論つき fake bucket。etag は本物と同じ raw
 * (引用符なし不透明文字列) にし、CAS は native etagMatches で突合する。
 */
function makeBucket(initial: Record<string, string> = {}) {
  const store = new Map<string, { body: string; etag: string }>(
    Object.entries(initial).map(([k, v], i) => [
      k,
      { body: v, etag: `seedraw${i}` },
    ])
  );
  let n = 0;
  const puts: Array<{
    key: string;
    value: string;
    onlyIf: Headers | { etagMatches: string } | undefined;
  }> = [];
  const bucket: SchedulerBucket = {
    get: async (key: string) => {
      const hit = store.get(key);
      return hit ? { text: async () => hit.body } : null;
    },
    put: async (
      key: string,
      value: string,
      options?: { onlyIf?: Headers | { etagMatches: string } }
    ) => {
      const onlyIf = options?.onlyIf;
      puts.push({ key, value, onlyIf });
      if (onlyIf instanceof Headers) {
        if (onlyIf.get("If-None-Match") === "*" && store.has(key)) return null;
      } else if (onlyIf !== undefined) {
        const cur = store.get(key);
        if (!cur || cur.etag !== onlyIf.etagMatches) return null;
      }
      n += 1;
      const etag = `rawetag${n}`;
      store.set(key, { body: value, etag });
      return { etag };
    },
  };
  return { bucket, puts, store };
}

type RouteHandler = (url: string, init?: RequestInit) => Response;
function makeFetch(handler: RouteHandler) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    return handler(u, init);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const jsonRes = (body: unknown, status = 200, link: string | null = null) =>
  new Response(JSON.stringify(body), {
    status,
    headers: link ? { Link: link } : {},
  });

// 2026-09-30 (水) 17:13 UTC。開始期限・日跨ぎのガード用（定時の 09:00 UTC とは別の時刻）。
const TUE_1713 = Date.parse("2026-09-30T17:13:00.000Z");
const TUE_1713_30S = TUE_1713 + 30_000;
const SAT_1713 = Date.parse("2026-10-03T17:13:00.000Z");
const TOKEN = "tok-fake-secret";

describe("catchup専用定時入口", () => {
  // JPX休場日にも旧cronと同じ平日scopeで動く。
  const date = "2026-09-23";
  const start = Date.parse(`${date}T10:00:00Z`);
  const receipt = () => ({ ...dispatchedBody(), cron: CATCHUP_DISPATCH_CRON, scheduledDate: date,
    claimedAt: `${date}T10:00:01Z`, dispatchedAt: `${date}T10:00:02Z` });
  const jobs = (): RunJob[] => [{ name: "catchup", run_id: 101, status: "completed", conclusion: "success", steps: [
    { name: "catchup起動資格", status: "completed", conclusion: "success", completed_at: `${date}T10:01:00Z` },
    { name: "ir-catalog TDnet catchup", status: "completed", conclusion: "success", completed_at: `${date}T10:10:00Z` },
    { name: "yuho-quant EDINET catchup (受注 + 海外売上)", status: "completed", conclusion: "success", completed_at: `${date}T10:59:00Z` },
  ] }, { name: "biztag", run_id: 101, status: "completed", conclusion: "skipped" }];

  it("市場休場に依存せずmainの新targetを1回POSTし専用receipt/readcheckを使う", async () => {
    vi.setSystemTime(new Date(start + 30_000));
    const { bucket, puts } = makeBucket();
    const { fetchFn, calls } = makeFetch((url) => url.includes("/dispatches") ? jsonRes({ workflow_run_id: 101,
      run_url: dispatchedBody().runUrl, html_url: dispatchedBody().htmlUrl }) : jsonRes({ jobs: jobs() }));
    const env: SchedulerEnv = { BUCKET: bucket, GITHUB_ACTIONS_TOKEN: TOKEN };
    const controller = { cron: CATCHUP_DISPATCH_CRON, scheduledTime: start };
    expect(routeCron(CATCHUP_DISPATCH_CRON)).toBe("catchup-dispatch");
    expect(routeCron(CATCHUP_READCHECK_CRON)).toBe("catchup-readcheck");
    expect(await handleStockScheduled(controller, env, { fetchFn, nowMs: start + 30_000 })).toEqual({ status: "dispatched", workflowRunId: 101 });
    expect(await handleStockScheduled(controller, env, { fetchFn, nowMs: start + 30_000 })).toEqual({ status: "duplicate", workflowRunId: 101 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/catchup.yml/dispatches");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ ref: "main", inputs: { target: "scheduled-catchup", scheduled_date: date } });
    expect(puts[0].key).toBe(catchupReceiptKey(date));
    const check = Date.parse(`${date}T11:05:00Z`);
    expect(await handleStockScheduled({ cron: CATCHUP_READCHECK_CRON, scheduledTime: check }, env, { fetchFn, nowMs: check + 30_000 }))
      .toEqual({ tdnetCompletedAt: `${date}T10:10:00Z`, edinetCompletedAt: `${date}T10:59:00Z` });
    expect(await bucket.get(receiptKey(date))).toBeNull();
  });
  it("ACK unknownはclaimedを保ち二重POSTせず、誤cron/期限超過も拒否する", async () => {
    const { bucket } = makeBucket();
    const { fetchFn, calls } = makeFetch(() => new Response(null, { status: 204 }));
    const deps = { bucket, token: TOKEN, cron: CATCHUP_DISPATCH_CRON, scheduledDate: date, nowMs: start, fetchFn };
    await expect(runCatchupDispatch(deps)).rejects.toThrow();
    await expect(runCatchupDispatch(deps)).rejects.toThrow("未完了");
    expect(calls).toHaveLength(1);
    await expect(runCatchupDispatch({ ...deps, cron: DISPATCH_CRON })).rejects.toThrow("一致");
    expect(() => resolveRunDate("catchup-dispatch", start, start + 5 * 60_000 + 1)).toThrow("開始期限");
  });
  it("missing/old/claimed/wrongkind receiptを当日の完了に読み替えない", async () => {
    const { fetchFn, calls } = makeFetch(() => jsonRes({ jobs: jobs() }));
    for (const raw of [undefined, { ...receipt(), scheduledDate: "2026-09-22" }, { ...receipt(), status: "claimed" }, { ...receipt(), cron: DISPATCH_CRON }]) {
      const { bucket } = makeBucket(raw ? { [catchupReceiptKey(date)]: JSON.stringify(raw) } : {});
      await expect(runCatchupDeadlineReadcheck({ bucket, token: TOKEN, scheduledDate: date, fetchFn })).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });
  it("source skip/部分成功/重複/時刻逆転/別日/Linuxbiztag実行を成功にしない", () => {
    expect(evaluateCatchupReadcheck(jobs(), date).edinetCompletedAt).toBe(`${date}T10:59:00Z`);
    for (const index of [0, 1, 2]) for (const conclusion of ["skipped", "failure", null]) {
      const bad = jobs(); bad[0].steps![index].conclusion = conclusion;
      expect(() => evaluateCatchupReadcheck(bad, date)).toThrow();
    }
    for (const at of ["2026-09-22T10:59:00Z", `${date}T10:59:00.001Z`, `${date}T10:09:00Z`, null]) {
      const bad = jobs(); bad[0].steps![2].completed_at = at;
      expect(() => evaluateCatchupReadcheck(bad, date)).toThrow();
    }
    const duplicate = jobs(); duplicate[0].steps!.push(duplicate[0].steps![1]);
    expect(() => evaluateCatchupReadcheck(duplicate, date)).toThrow();
    const liveBiztag = jobs(); liveBiztag[1].conclusion = "success";
    expect(() => evaluateCatchupReadcheck(liveBiztag, date)).toThrow();
    expect(() => evaluateCatchupReadcheck([jobs()[0]], date)).toThrow();
    expect(() => evaluateCatchupReadcheck([...jobs(), jobs()[0]], date)).toThrow();
  });
});

function claimBody(date = "2026-09-30"): StockReceipt {
  return {
    version: 1,
    scheduledDate: date,
    cron: DISPATCH_CRON,
    status: "claimed",
    claimedAt: "2026-09-30T17:13:30.000Z",
  };
}

function dispatchedBody(runId = 101): StockReceipt {
  return {
    ...claimBody(),
    status: "dispatched",
    dispatchedAt: "2026-09-30T17:13:31.000Z",
    workflowRunId: runId,
    runUrl: `https://api.github.com/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/${runId}`,
    htmlUrl: `https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/${runId}`,
  };
}

function syncJob(runId = 101, overrides: Partial<RunJob> = {}): RunJob {
  return {
    name: "sync",
    status: "completed",
    conclusion: "success",
    run_id: runId,
    steps: [
      {
        name: "stock daily sync",
        status: "completed",
        conclusion: "success",
        completed_at: "2026-09-30T12:11:00.000Z",
      },
      {
        name: "許容内失敗があれば Issue にコメント",
        status: "completed",
        conclusion: "skipped",
        completed_at: "2026-09-30T12:12:00.000Z",
      },
    ],
    ...overrides,
  };
}

let info: ReturnType<typeof vi.spyOn>;
let Err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  info = vi.spyOn(console, "info").mockImplementation(() => {});
  Err = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  info.mockRestore();
  Err.mockRestore();
});

describe("routeCron", () => {
  it("2 cron を振り分ける", () => {
    expect(routeCron(DISPATCH_CRON)).toBe("dispatch");
    expect(routeCron(READCHECK_CRON)).toBe("readcheck");
  });
  it("未知 cron は落とす", () => {
    expect(() => routeCron("13 17 * * *")).toThrow("未知の cron");
  });
});

describe("resolveRunDate", () => {
  it("定刻 dispatch は予定日を返す", () => {
    expect(resolveRunDate("dispatch", TUE_1713, TUE_1713_30S)).toBe("2026-09-30");
  });
  it("土日は落とす (曜日)", () => {
    expect(() => resolveRunDate("dispatch", SAT_1713, SAT_1713 + 30_000)).toThrow(
      "土日"
    );
  });
  it("未来の予定は落とす", () => {
    expect(() => resolveRunDate("dispatch", TUE_1713, TUE_1713 - 1000)).toThrow(
      "未来"
    );
  });
  it("UTC 日跨ぎは落とす", () => {
    const nextDay = Date.parse("2026-10-01T00:05:00.000Z");
    expect(() => resolveRunDate("dispatch", TUE_1713, nextDay)).toThrow("日跨ぎ");
  });
  it("dispatch 開始期限 (60分) 超過は落とす", () => {
    expect(() =>
      resolveRunDate("dispatch", TUE_1713, TUE_1713 + 61 * 60_000)
    ).toThrow("開始期限");
    expect(resolveRunDate("dispatch", TUE_1713, TUE_1713 + 59 * 60_000)).toBe(
      "2026-09-30"
    );
  });
  it("readcheck に開始期限はない", () => {
    const t = Date.parse("2026-09-30T21:05:00.000Z");
    expect(resolveRunDate("readcheck", t, t + 61 * 60_000)).toBe("2026-09-30");
  });
});

describe("schedulerToken", () => {
  it("未設定・空は落とす", () => {
    const bucket = makeBucket().bucket;
    expect(() => schedulerToken({ BUCKET: bucket })).toThrow(
      "GITHUB_ACTIONS_TOKEN"
    );
    expect(() =>
      schedulerToken({ BUCKET: bucket, GITHUB_ACTIONS_TOKEN: "  " })
    ).toThrow("GITHUB_ACTIONS_TOKEN");
  });
});

describe("runStockDispatch", () => {
  it("200 正常: claim→POST→CAS保存 (URL/入力の指定どおり)", async () => {
    const { bucket, puts } = makeBucket();
    const { fetchFn, calls } = makeFetch(() =>
      jsonRes({
        workflow_run_id: 101,
        run_url:
          "https://api.github.com/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/101",
        html_url:
          "https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/101",
      })
    );
    const r = await runStockDispatch({
      bucket,
      token: TOKEN,
      cron: DISPATCH_CRON,
      scheduledDate: "2026-09-30",
      nowMs: TUE_1713_30S,
      fetchFn,
    });
    expect(r).toEqual({ status: "dispatched", workflowRunId: 101 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/satoki252595/kabulab_tool_cloudflare" +
        "/actions/workflows/stock-sync.yml/dispatches"
    );
    const init = calls[0].init as RequestInit;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(headers["X-GitHub-Api-Version"]).toBe("2026-03-10");
    expect(headers["User-Agent"]).toMatch(/^kabulab-stock-scheduler\//);
    expect(JSON.parse(String(init.body))).toEqual({
      ref: "main",
      inputs: { target: "scheduled-stocks", scheduled_date: "2026-09-30" },
    });
    expect(puts).toHaveLength(2);
    expect(puts[0].onlyIf).toBeInstanceOf(Headers);
    expect((puts[0].onlyIf as Headers).get("If-None-Match")).toBe("*");
    const cas = puts[1].onlyIf as { etagMatches: string };
    expect(cas.etagMatches).toBe("rawetag1");
    expect(cas.etagMatches).not.toContain('"');
    const savedObj = await bucket.get(receiptKey("2026-09-30"));
    expect(savedObj).not.toBeNull();
    const saved = JSON.parse(await savedObj!.text());
    expect(saved.status).toBe("dispatched");
    expect(saved.workflowRunId).toBe(101);
  });

  it("重複 + dispatched 読戻しは POST 0 で正常 duplicate", async () => {
    const { bucket } = makeBucket({
      [receiptKey("2026-09-30")]: JSON.stringify(dispatchedBody(101)),
    });
    const { fetchFn, calls } = makeFetch(() => jsonRes({}));
    const r = await runStockDispatch({
      bucket,
      token: TOKEN,
      cron: DISPATCH_CRON,
      scheduledDate: "2026-09-30",
      nowMs: TUE_1713_30S,
      fetchFn,
    });
    expect(r).toEqual({ status: "duplicate", workflowRunId: 101 });
    expect(calls).toHaveLength(0);
  });

  it("重複 + claimed/破損/日付不一致/run欠落は error 継続 (再 POST 0)", async () => {
    const bad: Array<[string, string]> = [
      ["dispatch 未完了", JSON.stringify(claimBody())],
      ["JSON が不正", "{oops"],
      ["version が未知", JSON.stringify({ version: 9 })],
      [
        "日付不一致",
        JSON.stringify({ ...dispatchedBody(), scheduledDate: "2026-09-29" }),
      ],
      [
        "workflow_run_id が不正",
        JSON.stringify({ ...dispatchedBody(), workflowRunId: "x" }),
      ],
      [
        "workflow_run_id が不正",
        JSON.stringify({ ...dispatchedBody(), workflowRunId: 0 }),
      ],
      [
        "workflow_run_id が不正",
        JSON.stringify({ ...dispatchedBody(), workflowRunId: -5 }),
      ],
      [
        "同一 repo/run ではありません",
        JSON.stringify({
          ...dispatchedBody(101),
          runUrl:
            "https://api.github.com/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/102",
        }),
      ],
      [
        "html_url",
        JSON.stringify({ ...dispatchedBody(), htmlUrl: undefined }),
      ],
      [
        "cron が dispatch ではありません",
        JSON.stringify({ ...dispatchedBody(), cron: READCHECK_CRON }),
      ],
      [
        "claimedAt が時刻として不正",
        JSON.stringify({ ...dispatchedBody(), claimedAt: "not-a-date" }),
      ],
      [
        "時刻順序が不正",
        JSON.stringify({
          ...dispatchedBody(),
          claimedAt: "2026-09-30T17:13:31.000Z",
          dispatchedAt: "2026-09-30T17:13:30.000Z",
        }),
      ],
      [
        "時刻が予定日と一致しません",
        JSON.stringify({
          ...dispatchedBody(),
          dispatchedAt: "2026-10-01T00:00:00.000Z",
        }),
      ],
    ];
    for (const [msg, body] of bad) {
      const { bucket } = makeBucket({ [receiptKey("2026-09-30")]: body });
      const { fetchFn, calls } = makeFetch(() => jsonRes({}));
      await expect(
        runStockDispatch({
          bucket,
          token: TOKEN,
          cron: DISPATCH_CRON,
          scheduledDate: "2026-09-30",
          nowMs: TUE_1713_30S,
          fetchFn,
        })
      ).rejects.toThrow(msg);
      expect(calls).toHaveLength(0);
    }
  });

  it("重複 + 読戻しで receipt 消失は error (再 POST 0)", async () => {
    const { bucket } = makeBucket({
      [receiptKey("2026-09-30")]: JSON.stringify(dispatchedBody()),
    });
    const realGet = bucket.get.bind(bucket);
    let n = 0;
    bucket.get = (async (...a: Parameters<typeof realGet>) => {
      n += 1;
      if (n === 1) return null;
      return realGet(...a);
    }) as typeof realGet;
    const { fetchFn, calls } = makeFetch(() => jsonRes({}));
    await expect(
      runStockDispatch({
        bucket,
        token: TOKEN,
        cron: DISPATCH_CRON,
        scheduledDate: "2026-09-30",
        nowMs: TUE_1713_30S,
        fetchFn,
      })
    ).rejects.toThrow("消えています");
    expect(calls).toHaveLength(0);
  });

  it("POST 非 200 は status のみで落とす (応答 body を含めない)", async () => {
    const { bucket, puts } = makeBucket();
    const { fetchFn } = makeFetch(() => jsonRes({ message: "boom" }, 500));
    const err: unknown = await runStockDispatch({
      bucket,
      token: TOKEN,
      cron: DISPATCH_CRON,
      scheduledDate: "2026-09-30",
      nowMs: TUE_1713_30S,
      fetchFn,
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      "dispatch POST が失敗しました: HTTP 500"
    );
    expect(puts).toHaveLength(1);
  });

  it("200 でも run 詳細欠落・URL 不正・repo/run 不一致は落とす", async () => {
    const ok = {
      workflow_run_id: 101,
      run_url:
        "https://api.github.com/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/101",
      html_url:
        "https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/101",
    };
    for (const body of [
      { run_url: "https://x/y", html_url: "https://x/y" },
      {
        workflow_run_id: 1,
        run_url: "http://insecure/y",
        html_url: "https://x/y",
      },
      { workflow_run_id: 1, run_url: "https://x/y" },
      { ...ok, workflow_run_id: 0 },
      { ...ok, workflow_run_id: 1.5 },
      // 別 repo
      {
        ...ok,
        run_url:
          "https://api.github.com/repos/other/repo/actions/runs/101",
      },
      // 別 run
      {
        ...ok,
        html_url:
          "https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/102",
      },
      // run_url に /repos 無し (html 形の混入)
      {
        ...ok,
        run_url:
          "https://api.github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/101",
      },
      // html_url に /repos 付き (API 形の混入)
      {
        ...ok,
        html_url:
          "https://github.com/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/101",
      },
    ]) {
      const { bucket, puts } = makeBucket();
      const { fetchFn } = makeFetch(() => jsonRes(body));
      await expect(
        runStockDispatch({
          bucket,
          token: TOKEN,
          cron: DISPATCH_CRON,
          scheduledDate: "2026-09-30",
          nowMs: TUE_1713_30S,
          fetchFn,
        })
      ).rejects.toThrow();
      expect(puts).toHaveLength(1);
    }
  });

  it("CAS 競合は上書きせず落とす (再 POST なし)", async () => {
    const { bucket } = makeBucket();
    const realPut = bucket.put.bind(bucket);
    let n = 0;
    bucket.put = (async (...a: Parameters<typeof realPut>) => {
      n += 1;
      if (n === 2) return null;
      return realPut(...a);
    }) as typeof realPut;
    const { fetchFn, calls } = makeFetch(() =>
      jsonRes({
        workflow_run_id: 7,
        run_url:
          "https://api.github.com/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/7",
        html_url:
          "https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/7",
      })
    );
    await expect(
      runStockDispatch({
        bucket,
        token: TOKEN,
        cron: DISPATCH_CRON,
        scheduledDate: "2026-09-30",
        nowMs: TUE_1713_30S,
        fetchFn,
      })
    ).rejects.toThrow("CAS");
    expect(calls).toHaveLength(1);
  });
});

describe("evaluateReadcheck", () => {
  const DATE = "2026-09-30";
  it("正常: sync success + 株式期限内 + コメント SKIPPED", () => {
    expect(evaluateReadcheck([syncJob()], DATE)).toEqual({
      stockCompletedAt: "2026-09-30T12:11:00.000Z",
    });
  });
  it.each(["stock daily sync", "許容内失敗があれば Issue にコメント"])(
    "%s の重複は最初の成功を代用せず落とす",
    (name) => {
      const base = syncJob();
      const duplicate = base.steps!.find((step) => step.name === name)!;
      expect(() => evaluateReadcheck([
        syncJob(101, { steps: [...base.steps!, { ...duplicate, conclusion: "failure" }] }),
      ], DATE)).toThrow("複数あります (曖昧)");
    }
  );
  it("job 欠落・重複・未完了・非 success は落とす", () => {
    expect(() => evaluateReadcheck([], DATE)).toThrow("見つかりません");
    expect(() => evaluateReadcheck([syncJob(), syncJob()], DATE)).toThrow(
      "複数"
    );
    expect(() =>
      evaluateReadcheck([syncJob(101, { status: "in_progress" })], DATE)
    ).toThrow("未完了");
    expect(() =>
      evaluateReadcheck(
        [syncJob(101, { status: "completed", conclusion: "failure" })],
        DATE
      )
    ).toThrow("成功ではありません");
  });
  it("株式 step の欠落・失敗・期限超過は落とす", () => {
    const base = syncJob();
    expect(() =>
      evaluateReadcheck(
        [syncJob(101, { steps: base.steps!.filter((s) => s.name !== "stock daily sync") })],
        DATE
      )
    ).toThrow("見つかりません");
    expect(() =>
      evaluateReadcheck(
        [
          syncJob(101, {
            steps: base.steps!.map((s) =>
              s.name === "stock daily sync"
                ? { ...s, conclusion: "failure" }
                : s
            ),
          }),
        ],
        DATE
      )
    ).toThrow("成功完了ではありません");
    expect(() =>
      evaluateReadcheck(
        [
          syncJob(101, {
            steps: base.steps!.map((s) =>
              s.name === "stock daily sync"
                ? { ...s, completed_at: "2026-09-30T21:30:00.000Z" }
                : s
            ),
          }),
        ],
        DATE
      )
    ).toThrow("14:30 UTC を超過");
    expect(() =>
      evaluateReadcheck(
        [
          syncJob(101, {
            steps: base.steps!.map((s) =>
              s.name === "stock daily sync" ? { ...s, completed_at: null } : s
            ),
          }),
        ],
        DATE
      )
    ).toThrow("completed_at がありません");
  });
  it("株式 step の完了が同日 09:00 より前 (別日の成功) は落とす", () => {
    const base = syncJob();
    expect(() =>
      evaluateReadcheck(
        [
          syncJob(101, {
            steps: base.steps!.map((s) =>
              s.name === "stock daily sync"
                ? { ...s, completed_at: "2026-09-29T20:30:00.000Z" }
                : s
            ),
          }),
        ],
        DATE
      )
    ).toThrow("09:00 UTC より前");
    expect(
      evaluateReadcheck(
        [
          syncJob(101, {
            steps: base.steps!.map((s) =>
              s.name === "stock daily sync"
                ? { ...s, completed_at: "2026-09-30T09:00:00.000Z" }
                : s
            ),
          }),
        ],
        DATE
      )
    ).toEqual({ stockCompletedAt: "2026-09-30T09:00:00.000Z" });
  });
  it("コメント step の success (false-green)・欠落は落とす", () => {
    const base = syncJob();
    expect(() =>
      evaluateReadcheck(
        [
          syncJob(101, {
            steps: base.steps!.map((s) =>
              s.name === "許容内失敗があれば Issue にコメント"
                ? { ...s, conclusion: "success" }
                : s
            ),
          }),
        ],
        DATE
      )
    ).toThrow("false-green");
    expect(() =>
      evaluateReadcheck(
        [
          syncJob(101, {
            steps: base.steps!.filter(
              (s) => s.name !== "許容内失敗があれば Issue にコメント"
            ),
          }),
        ],
        DATE
      )
    ).toThrow("見つかりません");
  });
});

describe("runDeadlineReadcheck", () => {
  const DATE = "2026-09-30";
  const jobsFetch = (jobs: RunJob[]) => makeFetch(() => jsonRes({ jobs }));
  it("正常に verdict を返す", async () => {
    const { bucket } = makeBucket({
      [receiptKey(DATE)]: JSON.stringify(dispatchedBody(101)),
    });
    const { fetchFn, calls } = jobsFetch([syncJob()]);
    const v = await runDeadlineReadcheck({
      bucket,
      token: TOKEN,
      scheduledDate: DATE,
      fetchFn,
    });
    expect(v).toEqual({ stockCompletedAt: "2026-09-30T12:11:00.000Z" });
    expect(calls[0].url).toContain("/actions/runs/101/jobs?per_page=100");
  });
  it("receipt 欠落・破損・claimed・日付不一致・run欠落は落とす", async () => {
    const bad: Array<[string, Record<string, string>]> = [
      ["receipt がありません", {}],
      ["JSON が不正", { [receiptKey(DATE)]: "{oops" }],
      ["version が未知", { [receiptKey(DATE)]: JSON.stringify({ version: 9 }) }],
      ["dispatch 未完了", { [receiptKey(DATE)]: JSON.stringify(claimBody()) }],
      [
        "日付不一致",
        {
          [receiptKey(DATE)]: JSON.stringify({
            ...dispatchedBody(),
            scheduledDate: "2026-09-29",
          }),
        },
      ],
      [
        "workflow_run_id が不正",
        {
          [receiptKey(DATE)]: JSON.stringify({
            ...dispatchedBody(),
            workflowRunId: undefined,
          }),
        },
      ],
      [
        "workflow_run_id が不正",
        {
          [receiptKey(DATE)]: JSON.stringify({
            ...dispatchedBody(),
            workflowRunId: 0,
          }),
        },
      ],
    ];
    for (const [msg, initial] of bad) {
      const { bucket } = makeBucket(initial);
      const { fetchFn, calls } = jobsFetch([syncJob()]);
      await expect(
        runDeadlineReadcheck({
          bucket,
          token: TOKEN,
          scheduledDate: DATE,
          fetchFn,
        })
      ).rejects.toThrow(msg);
      expect(calls).toHaveLength(0);
    }
  });
  it("Jobs API を全ページ辿る (2ページ目で発見)", async () => {
    const { bucket } = makeBucket({
      [receiptKey(DATE)]: JSON.stringify(dispatchedBody(5)),
    });
    const page2 =
      "https://api.github.com/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/5/jobs?page=2";
    const { fetchFn, calls } = makeFetch((url) => {
      if (url.includes("page=2")) return jsonRes({ jobs: [syncJob(5)] });
      return jsonRes(
        {
          jobs: [
            {
              name: "moneyflow",
              status: "completed",
              conclusion: "success",
              run_id: 5,
            },
          ],
        },
        200,
        `<${page2}>; rel="next"`
      );
    });
    const v = await runDeadlineReadcheck({
      bucket,
      token: TOKEN,
      scheduledDate: DATE,
      fetchFn,
    });
    expect(v.stockCompletedAt).toBe("2026-09-30T12:11:00.000Z");
    expect(calls).toHaveLength(2);
    const getHeaders = calls[0].init?.headers as Record<string, string>;
    expect(getHeaders["User-Agent"]).toMatch(/^kabulab-stock-scheduler\//);
  });

  it("next が対象外 origin/path のとき辿らず落とす (Bearer 送出なし)", async () => {
    const badNext = [
      "https://evil.example.com/jobs?page=2",
      "http://api.github.com/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/5/jobs?page=2",
      "https://api.github.com/repos/other/repo/actions/runs/5/jobs?page=2",
      "https://api.github.com/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/6/jobs?page=2",
      "https://api.github.com/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/5/checks?page=2",
    ];
    for (const next of badNext) {
      const { fetchFn, calls } = makeFetch(() =>
        jsonRes({ jobs: [] }, 200, `<${next}>; rel="next"`)
      );
      await expect(fetchAllJobs(fetchFn, TOKEN, 5)).rejects.toThrow(
        "対象外 origin/path"
      );
      expect(calls).toHaveLength(1);
    }
  });

  it("pagination の循環・ページ数超過は落とす", async () => {
    const self =
      "https://api.github.com/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/5/jobs?per_page=100";
    const loop = makeFetch(() =>
      jsonRes({ jobs: [] }, 200, `<${self}>; rel="next"`)
    );
    await expect(fetchAllJobs(loop.fetchFn, TOKEN, 5)).rejects.toThrow("循環");
    let n = 0;
    const endless = makeFetch(() => {
      n += 1;
      return jsonRes(
        { jobs: [] },
        200,
        `<https://api.github.com/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/5/jobs?page=${n + 1}>; rel="next"`
      );
    });
    await expect(fetchAllJobs(endless.fetchFn, TOKEN, 5)).rejects.toThrow(
      "上限 (10) を超過"
    );
    expect(endless.calls).toHaveLength(10);
  });

  it("run ID 非正整数・job run_id 不一致は落とす", async () => {
    const { fetchFn } = makeFetch(() => jsonRes({ jobs: [] }));
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(fetchAllJobs(fetchFn, TOKEN, bad)).rejects.toThrow(
        "正の整数"
      );
    }
    const mixed = makeFetch(() =>
      jsonRes({ jobs: [{ ...syncJob(101), run_id: 999 }] })
    );
    await expect(fetchAllJobs(mixed.fetchFn, TOKEN, 101)).rejects.toThrow(
      "別 run の job"
    );
  });
  it("壊れた必須job/step項目とsteps形を空値へ置換せず拒否する", async () => {
    const base = syncJob(101);
    const step = base.steps![0];
    const malformed = [
      { ...base, name: null },
      { ...base, status: 1 },
      { ...base, steps: [{ ...step, name: undefined }] },
      { ...base, steps: [{ ...step, status: "" }] },
      { ...base, steps: null },
      { ...base, steps: [null] },
      { ...base, steps: [{ ...step, completed_at: 1 }] },
    ];
    for (const job of malformed) {
      const { fetchFn, calls } = makeFetch(() => jsonRes({ jobs: [job] }));
      await expect(fetchAllJobs(fetchFn, TOKEN, 101)).rejects.toThrow("Jobs API");
      expect(calls).toHaveLength(1);
    }
    const pending = { ...base, status: "in_progress", conclusion: null,
      steps: [{ name: step.name, status: "queued" }] };
    const { fetchFn } = makeFetch(() => jsonRes({ jobs: [pending] }));
    const jobs = await fetchAllJobs(fetchFn, TOKEN, 101);
    expect(jobs[0].conclusion).toBeNull();
    expect(jobs[0].steps![0]).toEqual({ name: step.name, status: "queued", conclusion: null, completed_at: null });
    expect(() => evaluateReadcheck(jobs, DATE)).toThrow("未完了");
  });
  it("Jobs API 非 200 は落とす", async () => {
    const { bucket } = makeBucket({
      [receiptKey(DATE)]: JSON.stringify(dispatchedBody()),
    });
    const { fetchFn } = makeFetch(() => jsonRes({}, 403));
    await expect(
      runDeadlineReadcheck({
        bucket,
        token: TOKEN,
        scheduledDate: DATE,
        fetchFn,
      })
    ).rejects.toThrow("HTTP 403");
  });
});

describe("handleStockScheduled", () => {
  it.each([
    [DISPATCH_CRON, "2026-10-12T09:00:00Z", "JPX"],
    [READCHECK_CRON, "2026-10-12T14:35:00Z", "JPX"],
    [CONTEXT_DISPATCH_CRON, "2026-10-12T21:00:00Z", "JPX"],
    [CONTEXT_READCHECK_CRON, "2026-10-12T22:05:00Z", "JPX"],
    [CONTEXT_DISPATCH_CRON, "2026-09-07T21:00:00Z", "NYSE"],
    [CONTEXT_READCHECK_CRON, "2026-09-07T22:05:00Z", "NYSE"],
  ])("公表休場の%sは理由付き対象外、receipt/POSTは作らない", async (cron, at, market) => {
    const { bucket, puts } = makeBucket();
    const { fetchFn, calls } = makeFetch(() => jsonRes({}));
    const result = await handleStockScheduled({ cron, scheduledTime: Date.parse(at) },
      { BUCKET: bucket }, { fetchFn, nowMs: Date.parse(at) + 30_000 });
    expect(result).toMatchObject({ status: "market_closed", scheduledDate: at.slice(0, 10),
      closures: [expect.objectContaining({ market, sourceUrl: expect.stringMatching(/^https:\/\//) })] });
    expect(puts).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
  it("未知 cron は bucket/fetch に触らず落とす", async () => {
    const { bucket, puts } = makeBucket();
    const { fetchFn, calls } = makeFetch(() => jsonRes({}));
    const env: SchedulerEnv = { BUCKET: bucket, GITHUB_ACTIONS_TOKEN: TOKEN };
    await expect(
      handleStockScheduled({ cron: "0 0 * * *", scheduledTime: TUE_1713 }, env, {
        fetchFn,
        nowMs: TUE_1713_30S,
      })
    ).rejects.toThrow("未知の cron");
    expect(puts).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
  it("token 未設定は POST 前に落とす", async () => {
    const { bucket } = makeBucket();
    const { fetchFn, calls } = makeFetch(() => jsonRes({}));
    await expect(
      handleStockScheduled(
        { cron: DISPATCH_CRON, scheduledTime: TUE_1713 },
        { BUCKET: bucket },
        { fetchFn, nowMs: TUE_1713_30S }
      )
    ).rejects.toThrow("GITHUB_ACTIONS_TOKEN");
    expect(calls).toHaveLength(0);
  });
  it("ログに秘密・URL 値を出さない", async () => {
    const { bucket } = makeBucket();
    const runUrl =
      "https://api.github.com/repos/satoki252595/kabulab_tool_cloudflare/actions/runs/9";
    const htmlUrl =
      "https://github.com/satoki252595/kabulab_tool_cloudflare/actions/runs/9";
    const { fetchFn } = makeFetch((url) =>
      url.includes("/dispatches")
        ? jsonRes({ workflow_run_id: 9, run_url: runUrl, html_url: htmlUrl })
        : jsonRes({ jobs: [syncJob(9)] })
    );
    const env: SchedulerEnv = { BUCKET: bucket, GITHUB_ACTIONS_TOKEN: TOKEN };
    // dispatchedAt は actual clock のため、fixture 時刻を実 shape
    // (同 UTC 日・claim 後) へ合わせる。
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T17:13:35.000Z"));
    try {
      await handleStockScheduled(
        { cron: DISPATCH_CRON, scheduledTime: TUE_1713 },
        env,
        { fetchFn, nowMs: TUE_1713_30S }
      );
    } finally {
      vi.useRealTimers();
    }
    await handleStockScheduled(
      {
        cron: READCHECK_CRON,
        scheduledTime: Date.parse("2026-09-30T21:05:00.000Z"),
      },
      env,
      { fetchFn, nowMs: Date.parse("2026-09-30T21:05:30.000Z") }
    );
    const lines = info.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(runUrl);
      expect(line).not.toContain(htmlUrl);
    }
  });
});

describe("claimReceipt/saveDispatchResult", () => {
  it("If-None-Match の往復 (取得→重複)", async () => {
    const { bucket } = makeBucket();
    const key = receiptKey("2026-09-30");
    const first = await claimReceipt(bucket, key, claimBody());
    expect(first.claimed).toBe(true);
    expect(first.etag).toBeTruthy();
    expect(first.etag as string).not.toContain('"');
    const second = await claimReceipt(bucket, key, claimBody());
    expect(second).toEqual({ claimed: false, etag: null });
  });
  it("CAS 保存は etag 一致でのみ成功", async () => {
    const { bucket } = makeBucket();
    const key = receiptKey("2026-09-30");
    const { etag } = await claimReceipt(bucket, key, claimBody());
    await saveDispatchResult(bucket, key, etag as string, dispatchedBody());
    await expect(
      saveDispatchResult(bucket, key, etag as string, dispatchedBody())
    ).rejects.toThrow("CAS");
  });
});


describe("資金フロー独立取得元のCF起動", () => {
  const date = "2026-10-12"; // JPX休場でも独立取得元は止めない。
  const start = Date.parse(`${date}T09:15:00Z`);
  const jobs = (conclusion = "success", completed = `${date}T14:00:00Z`): RunJob[] => [
    { name: "ingest-non-yahoo", run_id: 101, status: "completed", conclusion,
      steps: [{ name: "moneyflow ingest (non-yahoo)", status: "completed", conclusion,
        started_at: `${date}T09:15:30Z`, completed_at: `${date}T10:30:00Z` }] },
    { name: "ingest-yahoo", run_id: 101, status: "completed", conclusion,
      steps: [
        { name: "moneyflow ingest (yahoo)", status: "completed", conclusion,
          started_at: `${date}T13:30:00Z`, completed_at: `${date}T13:31:00Z` },
        { name: "moneyflow source join", status: "completed", conclusion,
          started_at: `${date}T13:31:00Z`, completed_at: completed },
      ] },
  ];
  const receipt = () => ({ ...dispatchedBody(), scheduledDate: date, cron: MONEYFLOW_DISPATCH_CRON,
    claimedAt: `${date}T09:15:00Z`, dispatchedAt: `${date}T09:15:01Z` });

  it("休場日はindependentのみ1回dispatchし、専用receiptで期限成功を確認する", async () => {
    const { bucket } = makeBucket();
    const body = receipt();
    const { fetchFn, calls } = makeFetch((url) => url.endsWith("/dispatches")
      ? jsonRes({ workflow_run_id: 101, run_url: body.runUrl, html_url: body.htmlUrl })
      : jsonRes({ jobs: jobs() }));
    const env = { BUCKET: bucket, GITHUB_ACTIONS_TOKEN: TOKEN };
    vi.useFakeTimers(); vi.setSystemTime(new Date(start + 30_000));
    try {
      const controller = { cron: MONEYFLOW_DISPATCH_CRON, scheduledTime: start };
      expect(await handleStockScheduled(controller, env, { fetchFn, nowMs: start + 30_000 }))
        .toEqual({ status: "dispatched", workflowRunId: 101 });
      expect(await handleStockScheduled(controller, env, { fetchFn, nowMs: start + 30_000 }))
        .toEqual({ status: "duplicate", workflowRunId: 101 });
    } finally { vi.useRealTimers(); }
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/moneyflow.yml/dispatches");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ ref: "main", inputs: { only: "independent", scheduled_date: date } });
    const check = Date.parse(`${date}T14:45:00Z`);
    expect(await handleStockScheduled({ cron: MONEYFLOW_READCHECK_CRON, scheduledTime: check }, env,
      { fetchFn, nowMs: check + 30_000 })).toEqual({ moneyflowCompletedAt: `${date}T14:00:00Z` });
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["skipped", `${date}T14:00:00Z`],
    ["failure", `${date}T14:00:00Z`],
    ["success", `${date}T14:40:01Z`],
    ["success", `${date}T09:14:59Z`],
  ])("未実行・失敗・期限外を成功と扱わない (%s %s)", async (conclusion, done) => {
    const { bucket } = makeBucket({ [moneyflowReceiptKey(date)]: JSON.stringify(receipt()) });
    const { fetchFn } = makeFetch(() => jsonRes({ jobs: jobs(conclusion, done) }));
    await expect(runMoneyflowDeadlineReadcheck({ bucket, token: TOKEN, scheduledDate: date, fetchFn })).rejects.toThrow();
  });

  it("開始60分超過をPOST前に拒否する", () => {
    expect(() => resolveRunDate("moneyflow-dispatch", start, start + 60 * 60_000 + 1)).toThrow("開始期限");
  });

  it("片側欠落/重複/skipとjoin欠落・実queue遅配を成功にしない", () => {
    for (const mutate of [
      (j: RunJob[]) => j.splice(0, 1),
      (j: RunJob[]) => { j[1] = j[0]; },
      (j: RunJob[]) => { j[0].conclusion = "skipped"; },
      (j: RunJob[]) => { j[1].steps?.pop(); },
      (j: RunJob[]) => { j[1].steps![0].started_at = `${date}T14:40:01Z`; },
      (j: RunJob[]) => { j[0].steps![0].started_at = `${date}T09:14:59Z`; },
    ]) {
      const j = jobs(); mutate(j);
      expect(() => evaluateMoneyflowReadcheck(j, date)).toThrow();
    }
    expect(evaluateMoneyflowReadcheck(jobs("success", `${date}T14:40:00Z`), date))
      .toEqual({ moneyflowCompletedAt: `${date}T14:40:00Z` });
  });
});
