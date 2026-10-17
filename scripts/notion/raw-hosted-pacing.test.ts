import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CanonicalRawFile } from "../../src/shared/notion-archive/raw-files.js";
import type { RawItem } from "./raw-index-backfill.js";

// Transport/timer projection only; no financial or source data is synthesized.
vi.mock("node:timers/promises", () => ({ setTimeout: (ms: number, _value: unknown, options?: { signal?: AbortSignal }) =>
  new Promise<void>(resolve => setTimeout(resolve, ms)).then(() => options?.signal?.throwIfAborted()) }));
const bytes = new Uint8Array([0, 255, 42]), sha256 = createHash("sha256").update(bytes).digest("hex");
const raw: CanonicalRawFile = { pageId: "b".repeat(32), filename: "protocol.bin", sha256, sizeBytes: bytes.length,
  source: "計算", datatype: "protocol", scope: "ALL", dataDate: null, fetchedAt: "2026-10-16T00:00:00Z",
  sourceUrl: null, licenseTag: "commercial-ok", convertStatus: "完了", hostedAttachments: 1 };
const { sourceUrl: _url, ...metadata } = raw;
const item: RawItem = { ...metadata, source: "計算", licenseTag: "commercial-ok", convertStatus: "完了", docId: null };
const file = { name: raw.filename, url: "https://prod-files-secure.s3.us-west-2.amazonaws.com/protocol.bin" };
const tokenBefore = process.env.NOTION_TOKEN, rpsBefore = process.env.NOTION_MAX_RPS;
const originalFetch = globalThis.fetch;
let starts: Array<{ api: boolean; at: number }>;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(Date.parse("2026-10-17T00:00:00Z")); process.env.NOTION_TOKEN = "protocol-test-token"; delete process.env.NOTION_MAX_RPS;
  starts = [];
  globalThis.fetch = async input => {
    const api = String(input).startsWith("https://api.notion.com/");
    starts.push({ api, at: performance.now() });
    return api ? new Response("{}") : new Response(bytes);
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch; vi.restoreAllMocks(); vi.useRealTimers(); vi.resetModules();
  if (tokenBefore === undefined) delete process.env.NOTION_TOKEN; else process.env.NOTION_TOKEN = tokenBefore;
  if (rpsBefore === undefined) delete process.env.NOTION_MAX_RPS; else process.env.NOTION_MAX_RPS = rpsBefore;
});
const load = async (rate?: number) => {
  const client = await import("../../src/shared/notion-archive/client.js");
  client.setNotionMaxRps(.25);
  const normal = await import("./raw-index-backfill.js");
  const find = vi.fn(async () => new Map([[sha256, { raw, file }]]));
  return { ...client, ...normal, get: normal.createRawDownloader(find, undefined, rate), find };
};

it.each([undefined, 1])("default combined or explicit hosted bucket %s preserves all bytes/cache and API cap", async rate => {
  const { get, find, notionRequest } = await load(rate);
  const work = (async () => {
    await notionRequest("GET", "/metadata");
    expect(await get(item, [item])).toEqual({ body: bytes, wireBytes: bytes.length });
    expect(await get(item, [item])).toEqual({ body: bytes, wireBytes: bytes.length });
    await notionRequest("GET", "/next");
  })();
  await vi.runAllTimersAsync(); await work;
  expect(starts).toEqual(rate === undefined ? [{ api: true, at: 0 }, { api: false, at: 4000 },
    { api: false, at: 8000 }, { api: true, at: 12000 }] : [{ api: true, at: 0 }, { api: false, at: 0 },
    { api: false, at: 1000 }, { api: true, at: 4000 }]);
  expect(find).toHaveBeenCalledOnce();
});

it("dedicated spacing is measured after accounting/fsync, with only residual wait", async () => {
  const { get } = await load(1);
  const work = (async () => {
    await get(item, [item], { onAttempt: async event => {
      if (event.phase === "start") await new Promise(resolve => setTimeout(resolve, 20_000));
    } });
    await get(item, [item], { onAttempt: async event => {
      if (event.phase === "start") await new Promise(resolve => setTimeout(resolve, 259));
    } });
  })();
  await vi.runAllTimersAsync(); await work;
  expect(starts).toEqual([{ api: false, at: 20_000 }, { api: false, at: 21_000 }]);
});

it.each(["abort", "headroom"])("%s during dedicated wait stops before the next native GET", async kind => {
  const { get } = await load(1), parent = new AbortController();
  await get(item, [item]);
  const blocked = get(item, [item], { signal: parent.signal, beforeHostedRequest: () => {
    if (kind === "headroom" && performance.now() >= 500) throw new Error("finite headroom STOP");
  } });
  const checked = expect(blocked).rejects.toThrow();
  setTimeout(() => { if (kind === "abort") parent.abort(new Error("absolute deadline")); }, 500);
  await vi.runAllTimersAsync(); await checked;
  expect(starts).toEqual([{ api: false, at: 0 }]);
});

it("dedicated hosted429 remains one fatal attempt with no metadata retry/bytes substitution", async () => {
  const { get } = await load(1);
  globalThis.fetch = async () => { starts.push({ api: false, at: performance.now() }); return new Response("refused", { status: 429 }); };
  await expect(get(item, [item])).rejects.toThrow("status=429");
  expect(starts).toEqual([{ api: false, at: 0 }]);
});

it("the existing bounded transport reread uses the same independent hosted interval", async () => {
  const { get } = await load(1);
  globalThis.fetch = async () => {
    starts.push({ api: false, at: performance.now() });
    if (starts.length === 1) throw new TypeError("fetch failed");
    return new Response(bytes);
  };
  const result = get(item, [item]);
  await vi.runAllTimersAsync();
  expect(await result).toEqual({ body: bytes, wireBytes: bytes.length });
  expect(starts).toEqual([{ api: false, at: 0 }, { api: false, at: 1000 }]);
});

it.each([0, .1, -1, 1.01, Infinity, NaN])("invalid dedicated hosted rate %s fails before metadata/native", async rate => {
  const { createRawDownloader, validateRawOptions } = await import("./raw-index-backfill.js");
  expect(() => createRawDownloader(undefined, undefined, rate)).toThrow("hosted");
  expect(() => validateRawOptions({ mode: "apply", planId: "protocol", limit: 1, maxBytes: 64, maxSeconds: 1200,
    expectedCount: 1, hostedMaxRps: rate })).toThrow("hosted");
  expect(starts).toEqual([]);
});

it.each(["dry", "inspect", "reconcile"])("%s cannot enable the independent hosted mode", async mode => {
  const { validateRawOptions } = await import("./raw-index-backfill.js");
  expect(() => validateRawOptions({ mode: mode === "reconcile" ? "apply" : mode as "dry" | "inspect", planId: "protocol",
    limit: 1, maxBytes: 64, maxSeconds: 300, expectedCount: 1, cutoff: "2026-10-13T18:31:00.000Z", hostedMaxRps: 1,
    ...(mode === "reconcile" ? { reconcileSha256: sha256, reconcileStateSha256: sha256 } : {}) })).toThrow("hosted");
  expect(starts).toEqual([]);
});
