import { afterEach, beforeEach, expect, it, vi } from "vitest";

const pipeline = vi.hoisted(() => ({ run: vi.fn(async (_input: unknown) => { throw new Error("NORMAL_PIPELINE_INPUT_CAPTURED"); }) }));
vi.mock("../src/biztag/pipeline.js", async importOriginal => ({
  ...await importOriginal<object>(), runBiztag: pipeline.run,
}));
vi.mock("../../../scripts/biztag-local/runtime.js", () => ({ withBiztagWriter: (run: () => Promise<void>) => run() }));
const argv = process.argv;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("CLI scope test forbids HTTP"); }));
});
afterEach(() => { process.argv = argv; vi.unstubAllGlobals(); });

it.each(["--codes=", "--codes= , ", "--codes"])("実CLIの明示emptyを全量に変換しない (%s)", async codes => {
  process.argv = [argv[0], "biztag.ts", "run", codes, "--mechanical-only", "--budget-min=12", "--limit=50"];
  await expect(import("./biztag.js")).rejects.toThrow("空でない証券コード一覧");
  expect(pipeline.run).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it.each([{ args: [], expected: undefined }, { args: ["--codes=7247, 7254"], expected: ["7247", "7254"] }])("省略時だけ既存全量、非emptyは通常pipelineへ渡す (%j)", async ({ args, expected }) => {
  process.argv = [argv[0], "biztag.ts", "run", ...args, "--mechanical-only", "--budget-min=12", "--limit=50"];
  await expect(import("./biztag.js")).rejects.toThrow("NORMAL_PIPELINE_INPUT_CAPTURED");
  expect(pipeline.run).toHaveBeenCalledOnce();
  expect(pipeline.run.mock.calls[0][0]).toMatchObject({ codes: expected, limit: 50, mechanicalOnly: true, budgetMs: 720_000 });
  expect(fetch).not.toHaveBeenCalled();
});
