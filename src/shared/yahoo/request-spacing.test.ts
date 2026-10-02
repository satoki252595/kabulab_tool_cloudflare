import { afterEach, expect, it, vi } from "vitest";

vi.unmock("./request-spacing.js");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  vi.resetModules();
  const { fetchYahooWithSpacing } = await import("./request-spacing.js");
  const starts: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async () => {
    starts.push(Date.now());
    return new Response("ok");
  }));
  const request = () => fetchYahooWithSpacing("https://test.invalid", {}, () => {});
  return { starts, request };
}

it("同時要求の実HTTP開始を1秒ずつ離し、空いた後は余分に待たない", async () => {
  const { starts, request } = await setup();
  const requests = Array.from({ length: 3 }, request);
  await vi.advanceTimersByTimeAsync(2_000);
  await Promise.all(requests);
  expect(starts).toEqual([10_000, 11_000, 12_000]);
  vi.setSystemTime(20_000);
  await request();
  expect(starts).toEqual([10_000, 11_000, 12_000, 20_000]);
});

it("遅延したtimerが同時起床しても実HTTP開始を1秒離す", async () => {
  const { starts, request } = await setup();
  const requests = Array.from({ length: 3 }, request);
  vi.setSystemTime(15_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(starts).toEqual([10_000, 16_000]);
  await vi.advanceTimersByTimeAsync(1_000);
  await Promise.all(requests);
  expect(starts).toEqual([10_000, 16_000, 17_000]);
});

it("待機中に制限が判明した要求は起床後に実HTTPを送らない", async () => {
  const { starts, request } = await setup();
  const { fetchYahooWithSpacing } = await import("./request-spacing.js");
  await request();
  let stopped = false;
  const reason = new Error("source stopped");
  const queued = fetchYahooWithSpacing("https://test.invalid", {}, () => {
    if (stopped) throw reason;
  }).catch((error: unknown) => error);
  stopped = true;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await queued).toBe(reason);
  expect(starts).toEqual([10_000]);
});
