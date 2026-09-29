import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DISPATCH_CRON,
  READCHECK_CRON,
  claimReceipt,
  evaluateReadcheck,
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

/** R2 conditional PUT 意味論つき fake bucket。 */
function makeBucket(initial: Record<string, string> = {}) {
  const store = new Map<string, { body: string; etag: string }>(
    Object.entries(initial).map(([k, v]) => [k, { body: v, etag: `"seed-${k}"` }])
  );
  let n = 0;
  const puts: Array<{ key: string; value: string; cond: string | null }> = [];
  const bucket: SchedulerBucket = {
    get: async (key: string) => {
      const hit = store.get(key);
      return hit ? { text: async () => hit.body } : null;
    },
    put: async (key: string, value: string, options?: { onlyIf?: Headers }) => {
      const onlyIf = options?.onlyIf;
      puts.push({
        key,
        value,
        cond: onlyIf ? (onlyIf.get("If-None-Match") ?? onlyIf.get("If-Match")) : null,
      });
      if (onlyIf?.get("If-None-Match") === "*") {
        if (store.has(key)) return null;
      }
      const match = onlyIf?.get("If-Match");
      if (match !== null && match !== undefined) {
        const cur = store.get(key);
        if (!cur || cur.etag !== match) return null;
      }
      n += 1;
      const etag = `"v${n}"`;
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

// 2026-09-30 (水)。dispatch 予定 17:13 UTC。
const TUE_1713 = Date.parse("2026-09-30T17:13:00.000Z");
const TUE_1713_30S = TUE_1713 + 30_000;
const SAT_1713 = Date.parse("2026-10-03T17:13:00.000Z");
const TOKEN = "tok-fake-secret";

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
    runUrl: `https://api.github.com/repos/o/r/actions/runs/${runId}`,
    htmlUrl: `https://github.com/o/r/actions/runs/${runId}`,
  };
}

function syncJob(overrides: Partial<RunJob> = {}): RunJob {
  return {
    name: "sync",
    status: "completed",
    conclusion: "success",
    steps: [
      {
        name: "stock daily sync",
        status: "completed",
        conclusion: "success",
        completed_at: "2026-09-30T20:30:00.000Z",
      },
      {
        name: "許容内失敗があれば Issue にコメント",
        status: "completed",
        conclusion: "skipped",
        completed_at: "2026-09-30T20:31:00.000Z",
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
        run_url: "https://api.github.com/repos/o/r/actions/runs/101",
        html_url: "https://github.com/o/r/actions/runs/101",
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
    expect(JSON.parse(String(init.body))).toEqual({
      ref: "main",
      inputs: { target: "scheduled-stocks", scheduled_date: "2026-09-30" },
      return_run_details: true,
    });
    expect(puts).toHaveLength(2);
    expect(puts[0].cond).toBe("*");
    expect(puts[1].cond).toBe('"v1"');
    const savedObj = await bucket.get(receiptKey("2026-09-30"));
    expect(savedObj).not.toBeNull();
    const saved = JSON.parse(await savedObj!.text());
    expect(saved.status).toBe("dispatched");
    expect(saved.workflowRunId).toBe(101);
  });

  it("重複 claim は POST 0 (同時・逐次二重禁止)", async () => {
    const { bucket } = makeBucket({
      [receiptKey("2026-09-30")]: JSON.stringify(claimBody()),
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
    expect(r).toEqual({ status: "duplicate" });
    expect(calls).toHaveLength(0);
  });

  it("POST 非 200 は落とし CAS 保存しない (曖昧 POST)", async () => {
    const { bucket, puts } = makeBucket();
    const { fetchFn } = makeFetch(() => jsonRes({ message: "boom" }, 500));
    await expect(
      runStockDispatch({
        bucket,
        token: TOKEN,
        cron: DISPATCH_CRON,
        scheduledDate: "2026-09-30",
        nowMs: TUE_1713_30S,
        fetchFn,
      })
    ).rejects.toThrow("HTTP 500");
    expect(puts).toHaveLength(1);
  });

  it("200 でも run 詳細欠落・URL 不正は落とす", async () => {
    for (const body of [
      { run_url: "https://x/y", html_url: "https://x/y" },
      {
        workflow_run_id: 1,
        run_url: "http://insecure/y",
        html_url: "https://x/y",
      },
      { workflow_run_id: 1, run_url: "https://x/y" },
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
        run_url: "https://api.github.com/r/7",
        html_url: "https://github.com/r/7",
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
      stockCompletedAt: "2026-09-30T20:30:00.000Z",
    });
  });
  it("job 欠落・重複・未完了・非 success は落とす", () => {
    expect(() => evaluateReadcheck([], DATE)).toThrow("見つかりません");
    expect(() => evaluateReadcheck([syncJob(), syncJob()], DATE)).toThrow(
      "複数"
    );
    expect(() =>
      evaluateReadcheck([syncJob({ status: "in_progress" })], DATE)
    ).toThrow("未完了");
    expect(() =>
      evaluateReadcheck(
        [syncJob({ status: "completed", conclusion: "failure" })],
        DATE
      )
    ).toThrow("成功ではありません");
  });
  it("株式 step の欠落・失敗・期限超過は落とす", () => {
    const base = syncJob();
    expect(() =>
      evaluateReadcheck(
        [syncJob({ steps: base.steps!.filter((s) => s.name !== "stock daily sync") })],
        DATE
      )
    ).toThrow("見つかりません");
    expect(() =>
      evaluateReadcheck(
        [
          syncJob({
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
          syncJob({
            steps: base.steps!.map((s) =>
              s.name === "stock daily sync"
                ? { ...s, completed_at: "2026-09-30T21:30:00.000Z" }
                : s
            ),
          }),
        ],
        DATE
      )
    ).toThrow("21:00 UTC を超過");
    expect(() =>
      evaluateReadcheck(
        [
          syncJob({
            steps: base.steps!.map((s) =>
              s.name === "stock daily sync" ? { ...s, completed_at: null } : s
            ),
          }),
        ],
        DATE
      )
    ).toThrow("completed_at がありません");
  });
  it("コメント step の success (false-green)・欠落は落とす", () => {
    const base = syncJob();
    expect(() =>
      evaluateReadcheck(
        [
          syncJob({
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
          syncJob({
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
    expect(v).toEqual({ stockCompletedAt: "2026-09-30T20:30:00.000Z" });
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
        "workflow_run_id がありません",
        {
          [receiptKey(DATE)]: JSON.stringify({
            ...dispatchedBody(),
            workflowRunId: undefined,
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
    const { fetchFn, calls } = makeFetch((url) => {
      if (url.includes("page=2")) return jsonRes({ jobs: [syncJob()] });
      return jsonRes(
        {
          jobs: [
            { name: "moneyflow", status: "completed", conclusion: "success" },
          ],
        },
        200,
        '<https://api.github.com/x?page=2>; rel="next"'
      );
    });
    const v = await runDeadlineReadcheck({
      bucket,
      token: TOKEN,
      scheduledDate: DATE,
      fetchFn,
    });
    expect(v.stockCompletedAt).toBe("2026-09-30T20:30:00.000Z");
    expect(calls).toHaveLength(2);
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
    const runUrl = "https://api.github.com/repos/o/r/actions/runs/9";
    const htmlUrl = "https://github.com/o/r/actions/runs/9";
    const { fetchFn } = makeFetch((url) =>
      url.includes("/dispatches")
        ? jsonRes({ workflow_run_id: 9, run_url: runUrl, html_url: htmlUrl })
        : jsonRes({ jobs: [syncJob()] })
    );
    const env: SchedulerEnv = { BUCKET: bucket, GITHUB_ACTIONS_TOKEN: TOKEN };
    await handleStockScheduled(
      { cron: DISPATCH_CRON, scheduledTime: TUE_1713 },
      env,
      { fetchFn, nowMs: TUE_1713_30S }
    );
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
