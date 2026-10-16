import { afterEach, beforeEach, expect, it, vi } from "vitest";

const tokenBefore = process.env.NOTION_TOKEN;
const rpsBefore = process.env.NOTION_MAX_RPS;
const originalFetch = globalThis.fetch;
let starts: number[];
let statuses: number[];
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(1_000_000);
  process.env.NOTION_TOKEN = "protocol-test-token";
  delete process.env.NOTION_MAX_RPS;
  starts = []; statuses = [];
  globalThis.fetch = async () => {
    starts.push(performance.now());
    const status = statuses.shift() ?? 200;
    return new Response(JSON.stringify({ ok: true }), { status, headers: { "Retry-After": "0" } });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (tokenBefore === undefined) delete process.env.NOTION_TOKEN;
  else process.env.NOTION_TOKEN = tokenBefore;
  if (rpsBefore === undefined) delete process.env.NOTION_MAX_RPS;
  else process.env.NOTION_MAX_RPS = rpsBefore;
  vi.useRealTimers(); vi.resetModules();
});
const load = () => import("./client.js");
it.each(["queue", "retry"])("有限読取guardは%s待機後のnative再開を期限内で止める", async kind => {
  const { notionRequest, notionStats } = await load();
  const { NotionConfigError } = await import("./env.js");
  const guard = () => { if (Date.now() > 1_000_100) throw new NotionConfigError("finite read STOP"); };
  statuses = kind === "retry" ? [429] : [200];
  const call = kind === "retry" ? notionRequest("GET", "/a", undefined, { beforeRequest: guard }) :
    notionRequest("GET", "/a").then(() => notionRequest("GET", "/b", undefined, { beforeRequest: guard }));
  const result = call.catch(e => e);
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ name: "NotionConfigError" });
  expect(starts).toEqual([0]); expect(notionStats().requests).toBe(1); expect(notionStats().transientRetries).toBe(0);
});
it.each([2.0, 0.7, 1.6, 1.0])("通常CLIはtyped envだけでnative retryと次queueを%srpsへ抑える", async rps => {
  process.env.NOTION_MAX_RPS = String(rps);
  const { notionRequest } = await load();
  statuses = [429, 200, 200];
  const calls = Promise.all([notionRequest("GET", "/a"), notionRequest("GET", "/b")]);
  await vi.runAllTimersAsync(); await calls;
  const interval = Math.ceil(1000 / rps);
  expect(starts).toEqual([0, interval, interval * 2]);
});
it("通常CLIのtyped env上限をretry/queueへ適用し、明示bulkの狭い予算を緩めない", async () => {
  process.env.NOTION_MAX_RPS = "2.0";
  const { notionRequest, setNotionMaxRps } = await load();
  setNotionMaxRps(0.7);
  statuses = [429, 200, 200];
  const calls = Promise.all([notionRequest("GET", "/a"), notionRequest("GET", "/b")]);
  await vi.runAllTimersAsync(); await calls;
  expect(starts).toEqual([0, 1429, 2858]);
});
it.each(["0", "-1", "NaN", "Infinity", "2.7", "", " " ])("不正なtyped env rate %jはnative0で拒否する", async value => {
  process.env.NOTION_MAX_RPS = value;
  const { notionRequest } = await load();
  await expect(notionRequest("GET", "/a")).rejects.toThrow();
  expect(starts).toEqual([]);
});
it("設定なしの通常queueは380msと順番を維持する", async () => {
  const { notionRequest } = await load();
  const calls = Promise.all([notionRequest("GET", "/a"), notionRequest("GET", "/b")]);
  await vi.runAllTimersAsync(); await calls;
  expect(starts).toEqual([0, 380]);
});
it.each([0.25, 1.5])("明示%s rpsはretryと次queue両方のnative試行へ適用する", async (rps) => {
  const { notionRequest, setNotionMaxRps, notionStats } = await load();
  setNotionMaxRps(rps); statuses = [429, 200, 200];
  const calls = Promise.all([notionRequest("GET", "/a"), notionRequest("GET", "/b")]);
  await vi.runAllTimersAsync(); await calls;
  const interval = Math.ceil(1000 / rps);
  expect(starts).toEqual([0, interval, interval * 2]);
  expect(notionStats()).toEqual({ requests: 3, rateLimited: 1, transientRetries: 0 });
});
it("Retry-Afterがcapより長ければ元の待機を短縮しない", async () => {
  const { notionRequest, setNotionMaxRps } = await load();
  setNotionMaxRps(0.25);
  globalThis.fetch = async () => {
    starts.push(performance.now());
    return new Response("{}", { status: starts.length === 1 ? 429 : 200, headers: { "Retry-After": "10" } });
  };
  const call = notionRequest("GET", "/a");
  await vi.runAllTimersAsync(); await call;
  expect(starts).toEqual([0, 10250]);
});
it.each([0, -1, NaN, Infinity, 2.7, Number.MIN_VALUE, 1e-9])("不正または既定より速いrate %s はnative0で拒否する", async (rps) => {
  const { setNotionMaxRps } = await load();
  expect(() => setNotionMaxRps(rps)).toThrow("pacing");
  expect(starts).toEqual([]);
});
it("開始後にrateを変更できない", async () => {
  const { notionRequest, setNotionMaxRps } = await load();
  await notionRequest("GET", "/a");
  expect(() => setNotionMaxRps(0.25)).toThrow("pacing");
  expect(starts).toEqual([0]);
});

it("APIとhostedの再GETは同じ.25rps枠を使い、予定待機中abortは送信しない", async () => {
  const { notionRequest, setNotionMaxRps, paceNotionNativeRequest } = await load();
  const { downloadArchivedFile } = await import("./archived-download.js");
  setNotionMaxRps(0.25);
  let hostedAttempts = 0;
  globalThis.fetch = async input => {
    starts.push(performance.now());
    if (String(input).includes("file.notion.so") && ++hostedAttempts === 1) throw new TypeError("fetch failed");
    return new Response("{}");
  };
  const work = (async () => {
    await notionRequest("GET", "/metadata");
    await downloadArchivedFile({ name: "source.zip", url: "https://file.notion.so/source.zip" }, "mixed", {
      maxBytes: 2, onAttempt: event => event.phase === "start" ? paceNotionNativeRequest() : undefined,
    });
    await notionRequest("GET", "/next");
  })();
  await vi.runAllTimersAsync(); await work;
  expect(starts).toEqual([0, 4000, 8000, 12000]);
  const parent = new AbortController(), reason = new Error("absolute deadline");
  const blocked = downloadArchivedFile({ name: "source.zip", url: "https://file.notion.so/source.zip" }, "aborted", {
    maxBytes: 2, signal: parent.signal, onAttempt: event => event.phase === "start" ? paceNotionNativeRequest(parent.signal) : undefined,
  });
  const check = expect(blocked).rejects.toBe(reason);
  await vi.advanceTimersByTimeAsync(1000); parent.abort(reason);
  await vi.runAllTimersAsync(); await check;
  expect(starts).toHaveLength(4);
});
