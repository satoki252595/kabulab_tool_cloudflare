import { afterEach, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";

vi.mock("dotenv/config", () => ({}));
vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it("a failed child stops subsequent Yahoo processes and reports failure", async () => {
  vi.resetModules();
  vi.mocked(spawnSync).mockReset().mockReturnValue({ status: 2 } as ReturnType<typeof spawnSync>);
  const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await import("./all-daily.js");
  expect(spawnSync).toHaveBeenCalledTimes(1);
  expect(vi.mocked(spawnSync).mock.calls[0][1]?.[1]).toBe("scripts/sync/daily.ts");
  expect(exit).toHaveBeenCalledWith(1);
});
