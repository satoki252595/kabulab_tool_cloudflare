import { vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import { executeMonthly, monthlyFailureCode, monthlyMain, parseMonthlyArgs, type MonthlyStep } from "./monthly.js";

const prepare = vi.hoisted(() => ({ plan: vi.fn(), start: vi.fn(), accept: vi.fn() }));
const subprocess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: subprocess.spawn }));
vi.mock("./competitor-prepare-stage.js", () => ({ planPrepareStage: prepare.plan, startPrepareStage: prepare.start, acceptPrepareStage: prepare.accept }));
vi.mock("./env.js", () => ({ biztagLocalEnv: { competitorPrepareCodes: () => undefined } }));
const runtime = fileURLToPath(new URL("../../.runtime/mac-main554-20261020", import.meta.url));
const state = fileURLToPath(new URL("../../tmp/biztag-local", import.meta.url));

it("runtime必須・未知引数拒否、preflightは実行計画だけでchildを起動しない", async () => {
  expect(() => parseMonthlyArgs([])).toThrow("--runtime");
  expect(() => parseMonthlyArgs(["--runtime", runtime, "--install"])).toThrow();
  const options = parseMonthlyArgs(["--runtime", runtime, "--preflight"]);
  const check = vi.fn(() => ({ revision: "4cb4867d9a9f189684b07efa89be81a085e03f51", state }));
  const execute = vi.fn(); const log = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    await monthlyMain(options, check, execute);
    expect(check).toHaveBeenCalledWith(runtime); expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ dailyReceiptUpdated: false, wholeDataComplete: false });
  } finally { log.mockRestore(); }
});

it("受入runtimeで通常biztag→モデル無許可summary、旧daily controller/receiptは使わない", async () => {
  const run = vi.fn(async (_runtime: string, _step: MonthlyStep) => "");
  await executeMonthly(runtime, state, undefined, run);
  expect(run.mock.calls.map(([cwd, step]) => [cwd, step.script, step.args])).toEqual([
    [runtime, "services/yuho-quant/data-scripts/biztag.ts", ["run", "--budget-min=20"]],
    [runtime, "services/otakara-yutai/data-scripts/summary-local.ts", ["--limit", "60", "--state-dir", join(dirname(state), "yutai-local")]],
  ]);
  expect(prepare.plan).not.toHaveBeenCalled();
});

it("先行失敗では後続・prepare markerを開始せず、再試行しない", async () => {
  vi.clearAllMocks();
  const run = vi.fn(async () => { throw new Error("expected offline stop"); });
  await expect(executeMonthly(runtime, state, ["634A"], run)).rejects.toThrow("offline stop");
  expect(run).toHaveBeenCalledTimes(1); expect(prepare.plan).not.toHaveBeenCalled();
});

it("任意prepareは既存pending/cursor/acceptを再用し、不明終了ではsummaryへ進まない", async () => {
  vi.clearAllMocks();
  const stage = { args: ["competitors", "--prepare-only", "--judge=semif", "--codes=634A", "--limit=1", "--budget-min=6", `--out=${state}`] };
  prepare.plan.mockReturnValue(stage); prepare.accept.mockImplementation(() => { throw new Error("expected unresolved archive"); });
  const run = vi.fn(async () => "saved prepare protocol");
  await expect(executeMonthly(runtime, state, ["634A"], run)).rejects.toThrow("unresolved archive");
  expect(prepare.plan).toHaveBeenCalledWith(["634A"], state); expect(prepare.start).toHaveBeenCalledWith(stage);
  expect(prepare.accept).toHaveBeenCalledWith(stage, "saved prepare protocol", expect.any(Number));
  expect(run).toHaveBeenCalledTimes(2);
});

it("事前確認の固定原因を区別し、任意exception本文やsecret風文字列を表示しない", () => {
  expect(monthlyFailureCode(new Error("既存のprivate stateが必要です"))).toBe("canonical_state_permissions");
  expect(monthlyFailureCode(new Error("runtime HEADがBIZTAG_LOCAL_ACCEPTED_REVISIONと一致しません。"))).toBe("runtime_revision_mismatch");
  expect(monthlyFailureCode(Object.assign(new Error("private path hidden"), { code: "ENOENT" }))).toBe("local_dependency_missing");
  expect(monthlyFailureCode(new Error("NOTION_TOKEN=never-forward-thirdparty-exception"))).toBe("runtime_or_stage_failure");
});

it("期限TERM後にleaderが先にcloseしても同groupをKILLし、後続を起動しない", async () => {
  vi.clearAllMocks(); vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { pid: process.pid, stdout: null });
  subprocess.spawn.mockReturnValue(child);
  const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
  try {
    const result = executeMonthly(runtime, state, undefined);
    const rejected = expect(result).rejects.toThrow("後続を実行せず停止");
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(kill.mock.calls).toEqual([[-child.pid, "SIGTERM"]]);
    child.emit("close", null, "SIGTERM"); // pipeを保持しない孫が残り、leaderだけ閉じた境界。
    await rejected;
    expect(kill.mock.calls).toEqual([[-child.pid, "SIGTERM"], [-child.pid, "SIGKILL"]]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(kill).toHaveBeenCalledTimes(2); expect(subprocess.spawn).toHaveBeenCalledTimes(1);
  } finally {
    child.emit("close", null, "SIGTERM");
    kill.mockRestore(); vi.useRealTimers();
  }
});
