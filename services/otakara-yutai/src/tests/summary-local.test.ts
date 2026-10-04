/** Synthetic unit inputs only; no source-site text, model, or production I/O. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SEMIF_HF_MODEL,
  SEMIF_HF_REVISION,
  SEMIF_SOURCE_REVISION,
  SEMIF_MLX_VERSION,
  SEMIF_MLX_LM_REVISION,
} from "../../../../src/shared/semif/client.js";
import {
  buildLocalResults,
  companyValue,
  parseLocalArgs,
  runLocalSummary,
  selectFairBatch,
  type LocalDependencies,
} from "../../data-scripts/summary-local.js";
import { missingSummaryConditions } from "../../data-scripts/summary-contract.js";
import {
  parseTaskFile,
  selectSummaryTasks,
  type BenefitRow,
  type SummaryTask,
} from "../../data-scripts/summary-tasks.js";
import type { ImportPlan } from "../../data-scripts/summary-import.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function state(): string {
  const dir = mkdtempSync(join(tmpdir(), "yutai-summary-unit-"));
  dirs.push(dir);
  return dir;
}
function row(id = 1, over: Partial<BenefitRow> = {}): BenefitRow {
  return {
    id,
    stockId: id,
    stockCode: String(9000 + id),
    stockName: "合成テスト社",
    description: "合成商品券 3,000円分",
    shortSummary: null,
    estimatedValue: null,
    estimateValueSource: null,
    minShares: 100,
    recordMonth: 3,
    recordDate: null,
    updatedAt: 1,
    ...over,
  };
}
const ready = {
  ready: true,
  model: SEMIF_HF_MODEL,
  revision: SEMIF_HF_REVISION,
  sourceRevision: SEMIF_SOURCE_REVISION,
  mlxVersion: SEMIF_MLX_VERSION,
  mlxLmRevision: SEMIF_MLX_LM_REVISION,
  maxInputTokens: 16000,
  maxOutputTokens: 512,
  promptSHA256: "a".repeat(64),
  artifacts: { "config.json": "b".repeat(64) },
};
function protocol(tasks: readonly SummaryTask[], text = '{"shortSummary":"商品券 3,000円分"}'): string {
  return (
    [
      ready,
      ...tasks.map((task) => ({
        taskId: task.taskId,
        text,
        finishReason: "stop",
        inputTokens: 100,
        outputTokens: 20,
        elapsedMs: 5,
      })),
    ]
      .map((v) => JSON.stringify(v))
      .join("\n") + "\n"
  );
}
function dependencies(initial: BenefitRow[]): {
  deps: LocalDependencies;
  events: string[];
  rows: () => BenefitRow[];
} {
  let current = structuredClone(initial);
  const events: string[] = [];
  return {
    events,
    rows: () => current,
    deps: {
      loadRows: vi.fn(async () => structuredClone(current)),
      generate: vi.fn(async (path) => {
        events.push("generate");
        return protocol(parseTaskFile(readFileSync(path, "utf8")));
      }),
      archive: vi.fn(async (bytes, _clock, phase) => {
        events.push(`archive-${phase}`);
        expect(JSON.parse(gunzipSync(bytes).toString())).toBeTruthy();
      }),
      apply: vi.fn(async (_rows: readonly BenefitRow[], plan: ImportPlan) => {
        events.push("apply");
        current = current.map((r) => {
          const update = plan.updates.find((u) => u.ids.includes(r.id));
          return update
            ? {
                ...r,
                shortSummary: update.shortSummary,
                estimatedValue: update.estimatedValue,
                estimateValueSource: update.estimateValueSource,
                updatedAt: 2,
              }
            : r;
        });
      }),
    },
  };
}

describe("local summary generation/import boundary", () => {
  it("keeps choice/holding/lottery qualifications instead of silently taking a representative benefit", () => {
    expect(missingSummaryConditions("合成商品から選択、1年以上保有、抽選で当選者に贈呈", "商品")).toEqual([
      "choice_condition_missing",
      "holding_condition_missing",
      "lottery_condition_missing",
    ]);
    expect(
      missingSummaryConditions("合成商品から選択、1年以上保有、抽選で当選者に贈呈", "1年以上保有者の抽選、商品を選択"),
    ).toEqual([]);
    expect(missingSummaryConditions("応募者向け合成商品", "商品")).toEqual(["application_condition_missing"]);
    expect(missingSummaryConditions("合成商品から選択", "合成商品から選ぶ")).toEqual([]);
    expect(missingSummaryConditions("合成商品から選択", "合成商品を選び受取")).toEqual([]);
  });
  it("omitted conditions remain unanswered with their previous amount/summary untouched", async () => {
    const old = row(1, {
      description: "合成商品を選択、1年以上継続保有",
      shortSummary: "※旧値",
      estimatedValue: 5000,
      estimateValueSource: "company",
    });
    const { deps, events, rows } = dependencies([old]);
    const dir = state();
    const report = await runLocalSummary({ stateDir: dir, limit: 60 }, deps);
    expect(report).toMatchObject({ accepted: 0, rejected: 1, pendingAfter: 1, outcome: "partial_rejection" });
    expect(deps.apply).not.toHaveBeenCalled();
    expect(rows()[0]).toEqual(old);
    expect(events).toEqual(["generate", "archive-pre"]);
    expect(readdirSync(dir)).not.toContain("pending-write.json");
  });
  it("caps the CLI at60, requires private state, and rejects unknown flags", () => {
    expect(parseLocalArgs(["--state-dir", "/private/unit"])).toMatchObject({
      limit: 60,
    });
    for (const limit of ["0", "61", "1.5", "-1", "01"])
      expect(() => parseLocalArgs(["--limit", limit, "--state-dir", "/private/unit"])).toThrow();
    expect(() => parseLocalArgs([])).toThrow();
    expect(() => parseLocalArgs(["--state-dir", "/private/unit", "--show-text"])).toThrow();
  });
  it("rotates rejected first60 so later pending tasks are attempted", () => {
    const tasks = selectSummaryTasks(Array.from({ length: 65 }, (_, i) => row(i + 1)));
    const first = selectFairBatch(tasks, null, 60);
    const second = selectFairBatch(tasks, first.at(-1)!.taskId, 60);
    expect(new Set([...first, ...second].map((t) => t.taskId)).size).toBe(65);
    expect(second.slice(0, 5)).toEqual(tasks.slice(60));
  });
  it("does not permit the generator to supply any amount or a substituted task", () => {
    const tasks = selectSummaryTasks([row()]);
    expect(
      buildLocalResults(tasks, protocol(tasks, '{"shortSummary":"商品券","estimatedValue":99999}'))
        .generationRejections,
    ).toEqual([{ taskId: tasks[0].taskId, reason: "generated_schema" }]);
    expect(() => buildLocalResults(tasks, protocol(tasks).replace(tasks[0].taskId, "f".repeat(16)))).toThrow("binding");
    expect(() => buildLocalResults(tasks, protocol(tasks).replace(SEMIF_HF_REVISION, "f".repeat(40)))).toThrow(
      "binding",
    );
  });
  it("takes only uniquely qualified company amounts; discount/tier/missing remain explicitNULL", () => {
    const task = selectSummaryTasks([row()])[0];
    expect(companyValue(task)).toEqual({
      value: 3000,
      reason: "qualified_company_per_grant",
    });
    const discount = { ...task, description: "合成レストラン 20%割引券 2枚" };
    expect(companyValue(discount)).toEqual({
      value: null,
      reason: "no_source_yen_amount",
    });
    expect(
      companyValue({
        ...task,
        recipients: [...task.recipients, { minShares: 200, recordMonth: 3, recordDate: null }],
      }),
    ).toEqual({ value: null, reason: "mixed_share_context" });
  });
  it("reports input/output limits as unanswered instead of truncating or fabricating a result", () => {
    const tasks = selectSummaryTasks([row()]);
    const input = [
      ready,
      {
        taskId: tasks[0].taskId,
        error: "input_token_limit",
        inputTokens: 16001,
      },
    ]
      .map((v) => JSON.stringify(v))
      .join("\n");
    expect(buildLocalResults(tasks, input)).toMatchObject({
      resultsText: "",
      modelCalls: 0,
      generationRejections: [{ reason: "input_token_limit" }],
    });
    expect(buildLocalResults(tasks, protocol(tasks).replace('"stop"', '"length"'))).toMatchObject({
      resultsText: "",
      modelCalls: 1,
    });
  });
  it("empty pending work never starts a generator, archive, or writer", async () => {
    const { deps } = dependencies([row(1, { shortSummary: "商品券 3,000円分" })]);
    expect(await runLocalSummary({ stateDir: state(), limit: 60 }, deps)).toMatchObject({
      outcome: "empty",
      modelCalls: 0,
    });
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.archive).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
  });
  it("physical pre readback precedes atomic import, and post readback precedes completion", async () => {
    const { deps, events } = dependencies([row()]);
    const dir = state();
    expect(await runLocalSummary({ stateDir: dir, limit: 60 }, deps)).toMatchObject({
      accepted: 1,
      rejected: 0,
      pendingAfter: 0,
    });
    expect(events).toEqual(["generate", "archive-pre", "apply", "archive-post"]);
    expect(readdirSync(dir)).not.toContain("pending-write.json");
    const run = readdirSync(dir).find((name) => name !== "progress.json")!;
    expect(statSync(join(dir, run)).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, run, "generation.jsonl")).mode & 0o777).toBe(0o600);
  });
  it("unknown pre archive retains the latch; next execution performs no read, generation, archive, or mutation", async () => {
    const { deps } = dependencies([row()]);
    const dir = state();
    deps.archive = vi.fn(async () => {
      expect(statSync(join(dir, "pending-write.json")).mode & 0o777).toBe(0o600);
      throw new Error("unknown_archive");
    });
    await expect(runLocalSummary({ stateDir: dir, limit: 60 }, deps)).rejects.toThrow("unknown_archive");
    expect(deps.apply).not.toHaveBeenCalled();
    expect(readdirSync(dir)).not.toContain("progress.json");
    expect(readdirSync(dir)).toContain("pending-write.json");
    vi.mocked(deps.loadRows).mockClear();
    vi.mocked(deps.generate).mockClear();
    vi.mocked(deps.archive).mockClear();
    await expect(runLocalSummary({ stateDir: dir, limit: 60 }, deps)).rejects.toThrow("previous_write_unresolved");
    expect(deps.loadRows).not.toHaveBeenCalled();
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.archive).not.toHaveBeenCalled();
    expect(deps.apply).not.toHaveBeenCalled();
  });
  it("partial rejection retains the previous row and records remaining work", async () => {
    const old = row(2, {
      shortSummary: "※旧値",
      estimatedValue: 5000,
      estimateValueSource: "company",
    });
    const { deps, rows } = dependencies([row(), old]);
    deps.generate = async (path) => {
      const tasks = parseTaskFile(readFileSync(path, "utf8"));
      const lines = protocol(tasks)
        .trim()
        .split("\n")
        .map((v) => JSON.parse(v));
      lines[2].text = '{"shortSummary":"架空の追加10%割引"}';
      return lines.map((v) => JSON.stringify(v)).join("\n");
    };
    expect(await runLocalSummary({ stateDir: state(), limit: 60 }, deps)).toMatchObject({
      outcome: "partial_rejection",
      accepted: 1,
      rejected: 1,
      pendingAfter: 1,
    });
    expect(rows()[1]).toEqual(old);
  });
  it("stale recipient context is rejected before writing", async () => {
    const { deps } = dependencies([row()]);
    let reads = 0;
    deps.loadRows = async () => [row(1, { minShares: ++reads === 1 ? 100 : 200 })];
    expect(await runLocalSummary({ stateDir: state(), limit: 60 }, deps)).toMatchObject({ rejected: 1, accepted: 0 });
    expect(deps.apply).not.toHaveBeenCalled();
  });
  it("unknown apply keeps a durable latch; later automatic execution has no D1/model call", async () => {
    const { deps } = dependencies([row()]);
    deps.apply = vi.fn(async () => {
      throw new Error("unknown_write");
    });
    const dir = state();
    await expect(runLocalSummary({ stateDir: dir, limit: 60 }, deps)).rejects.toThrow("unknown_write");
    vi.mocked(deps.loadRows).mockClear();
    vi.mocked(deps.generate).mockClear();
    await expect(runLocalSummary({ stateDir: dir, limit: 60 }, deps)).rejects.toThrow("previous_write_unresolved");
    expect(deps.loadRows).not.toHaveBeenCalled();
    expect(deps.generate).not.toHaveBeenCalled();
  });
  it("a known but mismatched POST cannot release the latch or declare success", async () => {
    const { deps } = dependencies([row()]);
    deps.apply = vi.fn(async () => {});
    const dir = state();
    await expect(runLocalSummary({ stateDir: dir, limit: 60 }, deps)).rejects.toThrow("summary_post_mismatch");
    expect(readdirSync(dir)).toContain("pending-write.json");
    expect(deps.archive).toHaveBeenCalledTimes(1);
  });
});
