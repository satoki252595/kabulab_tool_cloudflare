import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../../src/cron/daily.js", () => ({
  createDailyDb: vi.fn(() => ({})), runDailySync: vi.fn(), runMarketContextSync: vi.fn(),
  categorizeSyncFailure: vi.fn(), isDailySyncIncomplete: vi.fn(() => false),
}));
vi.mock("./yahoo-direct.js", () => ({ createStockYahooDirectTransport: vi.fn() }));
vi.mock("../vwap/lib/r2.js", () => ({ r2GetVersion: vi.fn(), r2Put: vi.fn() }));
vi.mock("../../src/shared/notion-archive/client.js", () => ({ notionStats: () => ({}) }));

const originalArgs = process.argv;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-14T09:15:00Z"));
  for (const key of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "CRON_SECRET"]) vi.stubEnv(key, "protocol-test-only");
  vi.stubEnv("YAHOO_PROXY_BASE", "https://proxy.test.invalid"); vi.stubEnv("STOCK_SYNC_TARGET", "stocks");
  vi.stubEnv("BATCH_JOB_STARTED_AT", "2026-10-14T09:00:00.000Z");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
});
afterEach(() => { process.argv = originalArgs; vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("Actions株式の明示flagだけを注入し、proxy設定とHTTP復元を保持する", async () => {
  const daily = await import("../../src/cron/daily.js"), direct = await import("./yahoo-direct.js");
  const transport = vi.fn(), native = globalThis.fetch;
  vi.mocked(direct.createStockYahooDirectTransport).mockReturnValue(transport);
  // wrapperだけのプロトコル制御。金融データの取得・成功を表さない。
  vi.mocked(daily.runDailySync).mockResolvedValue({ failures: [], tradingDate: null, totalStocks: 0,
    successStocks: 0, failedStocks: 0, marketContextOk: null, elapsedSec: 0, batchKey: "transport-only-control" });
  process.argv = [originalArgs[0], "scripts/sync/daily.ts", "--stocks-only", "--yahoo-direct"];
  await import("./daily.js");
  await vi.waitFor(() => expect(console.info).toHaveBeenCalledWith(expect.stringContaining("notionStats")));
  expect(direct.createStockYahooDirectTransport).toHaveBeenCalledTimes(1);
  expect(daily.runDailySync).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stocksOnly: true, yahooTransport: transport }));
  expect(daily.runMarketContextSync).not.toHaveBeenCalled(); expect(process.exit).not.toHaveBeenCalled();
  expect(process.env.YAHOO_PROXY_BASE).toBe("https://proxy.test.invalid"); expect(globalThis.fetch).toBe(native);
});

it.each([
  ["context", ["--context-only", "--yahoo-direct"]],
  ["missing-mode", ["--yahoo-direct"]],
  ["duplicate", ["--stocks-only", "--yahoo-direct", "--yahoo-direct"]],
  ["ssh-no-job-clock", ["--stocks-only", "--yahoo-direct"]],
])("明示directの不完全指定%sは設定/DB/transport開始前に拒否", async (kind, args) => {
  if (kind === "ssh-no-job-clock") vi.stubEnv("BATCH_JOB_STARTED_AT", undefined);
  const daily = await import("../../src/cron/daily.js"), direct = await import("./yahoo-direct.js");
  process.argv = [originalArgs[0], "scripts/sync/daily.ts", ...args];
  await import("./daily.js");
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
  expect(daily.createDailyDb).not.toHaveBeenCalled(); expect(daily.runDailySync).not.toHaveBeenCalled();
  expect(direct.createStockYahooDirectTransport).not.toHaveBeenCalled();
});
