/** Local generation only; company amounts and atomic import use the existing contracts. */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import { withBiztagWriter } from "../../../scripts/biztag-local/runtime.js";
import { createD1HttpBatchSender } from "../../../src/shared/db/d1-http-client.js";
import { recordPrimaryData, verifyArchivedAttachments } from "../../../src/shared/notion-archive/index.js";
import {
  SEMIF_HF_MODEL,
  SEMIF_HF_REVISION,
  SEMIF_SOURCE_REVISION,
  SEMIF_MLX_VERSION,
  SEMIF_MLX_LM_REVISION,
} from "../../../src/shared/semif/client.js";
import { semifEnv } from "../../../src/shared/semif/env.js";
import { z } from "../../../src/shared/zod-mini.js";
import { benefitKey } from "./benefit-key.js";
import { loadBenefitRows, openOtakaraD1 } from "./benefit-rows.js";
import { extractYenAmounts, qualifyCompanyPerGrantValue } from "./estimated-value-guard.js";
import { applyImportAtomically } from "./import-summary-results.js";
import { assertNotCommittable } from "./private-path.js";
import { SummaryResult, planSummaryImport, type ImportPlan } from "./summary-import.js";
import {
  parseTaskFile,
  selectSummaryTasks,
  serializeTasks,
  type BenefitRow,
  type SummaryTask,
} from "./summary-tasks.js";

const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const Generation = z.strictObject({
  taskId: z.string(),
  text: z.string(),
  finishReason: z.enum(["stop", "length"]),
  inputTokens: z.number().check(z.int(), z.positive()),
  outputTokens: z.number().check(z.int(), z.positive()),
  elapsedMs: z.number().check(z.int(), z.nonnegative()),
});
const InputRejected = z.strictObject({
  taskId: z.string(),
  error: z.literal("input_token_limit"),
  inputTokens: z.number().check(z.int(), z.minimum(16001)),
});
const Ready = z.strictObject({
  ready: z.literal(true),
  model: z.literal(SEMIF_HF_MODEL),
  revision: z.literal(SEMIF_HF_REVISION),
  sourceRevision: z.literal(SEMIF_SOURCE_REVISION),
  mlxVersion: z.literal(SEMIF_MLX_VERSION),
  mlxLmRevision: z.literal(SEMIF_MLX_LM_REVISION),
  maxInputTokens: z.literal(16000),
  maxOutputTokens: z.literal(512),
  promptSHA256: z.string().check(z.regex(/^[0-9a-f]{64}$/)),
  artifacts: z.record(z.string(), z.string().check(z.regex(/^[0-9a-f]{64}$/))),
});
const GeneratedSummary = z.strictObject({ shortSummary: z.string() });
export type LocalOptions = { limit: number; stateDir: string };

export function parseLocalArgs(argv: readonly string[]): LocalOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      limit: { type: "string", default: "60" },
      "state-dir": { type: "string" },
    },
  });
  if (!values["state-dir"] || !/^(?:[1-9]|[1-5][0-9]|60)$/.test(values.limit ?? "")) {
    throw new Error("--state-dir と1～60件の --limit が必要です。");
  }
  return {
    limit: Number(values.limit),
    stateDir: resolve(values["state-dir"]),
  };
}

/** Continue after the last attempted key, including rejected tasks, so a bad first60 cannot starve others. */
export function selectFairBatch(tasks: readonly SummaryTask[], cursor: string | null, limit: number): SummaryTask[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 60) throw new Error("invalid_limit");
  const index = cursor === null ? -1 : tasks.findIndex((task) => task.taskId === cursor);
  const start = index < 0 ? 0 : index + 1;
  return [...tasks.slice(start), ...tasks.slice(0, start)].slice(0, limit);
}

/** Never use an amount suggested by the generator. No maximum/tier/annual conversion. */
export function companyValue(task: SummaryTask): {
  value: number | null;
  reason: string;
} {
  const context = {
    minShares: task.recipients.map((r) => r.minShares),
    recordMonths: task.recipients.map((r) => r.recordMonth),
  };
  const candidates = [...new Set(extractYenAmounts(task.description))];
  const verdicts = candidates.map((value) => ({
    value,
    verdict: qualifyCompanyPerGrantValue(task.description, value, context),
  }));
  const accepted = verdicts.filter((v) => v.verdict.qualified);
  if (accepted.length === 1) return { value: accepted[0].value, reason: "qualified_company_per_grant" };
  return {
    value: null,
    reason:
      accepted.length > 1
        ? "ambiguous_qualified_amounts"
        : candidates.length === 0
          ? "no_source_yen_amount"
          : [...new Set(verdicts.map((v) => (v.verdict.qualified ? "qualified" : v.verdict.code)))].join(","),
  };
}

/** Conservative local-generation HOLD. Never fill a missing condition with a fixed summary. */
export function missingSummaryConditions(description: string, summary: string): string[] {
  const missing: string[] = [];
  const choice = /選[択べんぶび]|いずれか|または|又は/;
  if (choice.test(description) && !choice.test(summary)) missing.push("choice_condition_missing");
  const holding = /保有期間|継続保有|長期保有|以上|未満/;
  if (holding.test(description) && !/保有|継続|長期|以上|未満|条件別/.test(summary))
    missing.push("holding_condition_missing");
  if (/抽選|当選/.test(description) && !/抽選|当選/.test(summary)) missing.push("lottery_condition_missing");
  if (/応募/.test(description) && !/応募|抽選|当選/.test(summary)) missing.push("application_condition_missing");
  return missing;
}

/** Entire protocol must correspond to the issued batch. Individual malformed summaries stay pending. */
export function buildLocalResults(
  tasks: readonly SummaryTask[],
  protocol: string,
): {
  resultsText: string;
  amountReasons: { taskId: string; value: number | null; reason: string }[];
  generationRejections: { taskId: string; reason: string }[];
  modelCalls: number;
} {
  let lines: unknown[];
  try {
    lines = protocol
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
  } catch {
    throw new Error("generation_protocol_json");
  }
  const ready = Ready.safeParse(lines[0]);
  if (!ready.success || Object.keys(ready.data.artifacts).length === 0 || lines.length !== tasks.length + 1) {
    throw new Error("generation_protocol_binding");
  }
  const results: SummaryResult[] = [];
  const amountReasons: {
    taskId: string;
    value: number | null;
    reason: string;
  }[] = [];
  const generationRejections: { taskId: string; reason: string }[] = [];
  let modelCalls = 0;
  for (let i = 0; i < tasks.length; i++) {
    const inputRejected = InputRejected.safeParse(lines[i + 1]);
    if (inputRejected.success) {
      if (inputRejected.data.taskId !== tasks[i].taskId) throw new Error("generation_protocol_binding");
      generationRejections.push({
        taskId: tasks[i].taskId,
        reason: "input_token_limit",
      });
      continue;
    }
    const g = Generation.safeParse(lines[i + 1]);
    if (!g.success || g.data.taskId !== tasks[i].taskId || g.data.inputTokens > 16000 || g.data.outputTokens > 512) {
      throw new Error("generation_protocol_binding");
    }
    const task = tasks[i];
    modelCalls++;
    if (g.data.finishReason !== "stop") {
      generationRejections.push({
        taskId: task.taskId,
        reason: "output_token_limit",
      });
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(g.data.text);
    } catch {
      generationRejections.push({
        taskId: task.taskId,
        reason: "generated_json",
      });
      continue;
    }
    const summary = GeneratedSummary.safeParse(raw);
    if (!summary.success) {
      generationRejections.push({
        taskId: task.taskId,
        reason: "generated_schema",
      });
      continue;
    }
    const missingConditions = missingSummaryConditions(task.description, summary.data.shortSummary);
    if (missingConditions.length > 0) {
      generationRejections.push({ taskId: task.taskId, reason: missingConditions.join(",") });
      continue;
    }
    const amount = companyValue(task);
    amountReasons.push({ taskId: task.taskId, ...amount });
    results.push(
      SummaryResult.parse({
        taskId: task.taskId,
        contractVersion: task.contractVersion,
        shortSummary: summary.data.shortSummary,
        estimatedValue: amount.value,
      }),
    );
  }
  return {
    resultsText: results.map((r) => JSON.stringify(r)).join("\n") + (results.length ? "\n" : ""),
    amountReasons,
    generationRejections,
    modelCalls,
  };
}

function writePrivate(path: string, bytes: string | Uint8Array): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) !== 0 || s.uid !== process.getuid?.())
    throw new Error("private_state_required");
}

export type LocalDependencies = {
  loadRows: () => Promise<BenefitRow[]>;
  generate: (tasksPath: string, runDir: string) => Promise<string>;
  archive: (bytes: Uint8Array, clock: string, phase: "pre" | "post") => Promise<void>;
  apply: (rows: readonly BenefitRow[], plan: ImportPlan) => Promise<void>;
};
export type LocalReport = {
  selected: number;
  accepted: number;
  rejected: number;
  pendingBefore: number;
  pendingAfter: number;
  equivalent: number;
  toNull: number;
  modelCalls: number;
  modelResidents: 0 | 1;
  outcome: "empty" | "complete" | "partial_rejection";
};

export async function runLocalSummary(options: LocalOptions, deps: LocalDependencies): Promise<LocalReport> {
  const state = options.stateDir;
  assertNotCommittable(join(state, "progress.json"));
  privateDir(state);
  const pendingWrite = join(state, "pending-write.json");
  if (existsSync(pendingWrite)) throw new Error("previous_write_unresolved");
  const rows = await deps.loadRows();
  const allTasks = selectSummaryTasks(rows);
  if (allTasks.length === 0)
    return {
      selected: 0,
      accepted: 0,
      rejected: 0,
      pendingBefore: 0,
      pendingAfter: 0,
      equivalent: 0,
      toNull: 0,
      modelCalls: 0,
      modelResidents: 0,
      outcome: "empty",
    };
  let cursor: string | null = null;
  const cursorPath = join(state, "progress.json");
  if (existsSync(cursorPath)) {
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(cursorPath, "utf8"));
    } catch {
      throw new Error("invalid_progress");
    }
    const parsed = z.strictObject({ cursor: z.string().check(z.regex(/^[0-9a-f]{16}$/)) }).safeParse(saved);
    if (!parsed.success) throw new Error("invalid_progress");
    cursor = parsed.data.cursor;
  }
  const tasks = selectFairBatch(allTasks, cursor, options.limit);
  const clock = new Date().toISOString();
  const runDir = join(state, randomUUID());
  privateDir(runDir);
  const tasksText = serializeTasks(tasks);
  // Validate our exact emitted task bytes with the same importer contract.
  parseTaskFile(tasksText);
  writePrivate(join(runDir, "tasks.jsonl"), tasksText);
  writePrivate(
    join(runDir, "selected-pre.json"),
    JSON.stringify(rows.filter((r) => tasks.some((t) => t.taskId === benefitKey(r.stockCode, r.description)))),
  );
  const protocol = await deps.generate(join(runDir, "tasks.jsonl"), runDir);
  writePrivate(join(runDir, "generation.jsonl"), protocol);
  const generated = buildLocalResults(tasks, protocol);
  writePrivate(join(runDir, "results.jsonl"), generated.resultsText);
  writePrivate(join(runDir, "qualification.json"), JSON.stringify(generated));
  const fresh = await deps.loadRows();
  const plan = planSummaryImport({
    tasks,
    resultsText: generated.resultsText,
    currentRows: fresh,
  });
  writePrivate(join(runDir, "import-plan.json"), JSON.stringify(plan));
  // One lossless file contains the exact tasks, model protocol, results, and both preimages.
  const plain = Buffer.from(
    JSON.stringify({
      version: 1,
      clock,
      model: SEMIF_HF_MODEL,
      revision: SEMIF_HF_REVISION,
      tasksText,
      protocol,
      ...generated,
      plan,
      selectedPre: rows.filter((r) => tasks.some((t) => t.taskId === benefitKey(r.stockCode, r.description))),
      freshPre: fresh.filter((r) => tasks.some((t) => t.taskId === benefitKey(r.stockCode, r.description))),
    }),
  );
  const bundle = gzipSync(plain);
  if (!gunzipSync(bundle).equals(plain)) throw new Error("bundle_roundtrip");
  writePrivate(join(runDir, "pre-import.json.gz"), bundle);
  await deps.archive(bundle, clock, "pre"); // No D1 mutation if physical/archive/readback fails.
  const nextCursor = join(state, `progress-${randomUUID()}.json`);
  writePrivate(nextCursor, JSON.stringify({ cursor: tasks[tasks.length - 1].taskId }));
  renameSync(nextCursor, cursorPath);
  if (plan.updates.length > 0) {
    writePrivate(
      pendingWrite,
      JSON.stringify({
        clock,
        bundleSHA256: sha(bundle),
        run: runDir.split("/").at(-1),
      }),
    );
    await deps.apply(fresh, plan);
  }
  const post = plan.updates.length > 0 ? await deps.loadRows() : fresh;
  const updates = new Map(plan.updates.flatMap((u) => u.ids.map((id) => [id, u] as const)));
  if (post.length !== fresh.length || new Set(post.map((r) => r.id)).size !== post.length)
    throw new Error("summary_post_mismatch");
  for (const before of fresh) {
    const after = post.find((r) => r.id === before.id);
    const update = updates.get(before.id);
    if (!after) throw new Error("summary_post_mismatch");
    const expected =
      update === undefined
        ? before
        : {
            ...before,
            shortSummary: update.shortSummary,
            estimatedValue: update.estimatedValue,
            estimateValueSource: update.estimateValueSource,
            updatedAt: after.updatedAt,
          };
    if (
      !isDeepStrictEqual(after, expected) ||
      !Number.isSafeInteger(after.updatedAt) ||
      after.updatedAt < before.updatedAt
    ) {
      throw new Error("summary_post_mismatch");
    }
  }
  const rejected = tasks.length - plan.updates.length - plan.skippedEquivalent;
  const report: LocalReport = {
    selected: tasks.length,
    accepted: plan.updates.length,
    rejected,
    equivalent: plan.skippedEquivalent,
    toNull: plan.valueChanges.toNull,
    pendingBefore: allTasks.length,
    pendingAfter: selectSummaryTasks(post).length,
    modelCalls: generated.modelCalls,
    modelResidents: 1,
    outcome: rejected > 0 ? "partial_rejection" : "complete",
  };
  writePrivate(
    join(runDir, "post.json"),
    JSON.stringify(post.filter((r) => tasks.some((t) => t.taskId === benefitKey(r.stockCode, r.description)))),
  );
  writePrivate(join(runDir, "post-verified.json"), JSON.stringify(report));
  if (plan.updates.length > 0) {
    const postClock = new Date().toISOString();
    const postPlain = Buffer.from(
      JSON.stringify({
        version: 1,
        phase: "post",
        clock: postClock,
        preBundleSHA256: sha(bundle),
        report,
        post,
        updates: plan.updates,
      }),
    );
    const postBundle = gzipSync(postPlain);
    if (!gunzipSync(postBundle).equals(postPlain)) throw new Error("bundle_roundtrip");
    writePrivate(join(runDir, "post-import.json.gz"), postBundle);
    await deps.archive(postBundle, postClock, "post");
    unlinkSync(pendingWrite);
  }
  writePrivate(join(runDir, "complete.json"), JSON.stringify(report));
  return report;
}

function generate(tasksPath: string, runDir: string): Promise<string> {
  const python = semifEnv.SEMIF_PYTHON();
  return new Promise((ok, fail) => {
    execFile(
      python,
      [fileURLToPath(new URL("./generate-summary-local.py", import.meta.url)), "--tasks", tasksPath],
      {
        env: {
          ...process.env,
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1",
          HF_HUB_DISABLE_TELEMETRY: "1",
        },
        timeout: 29 * 60_000,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        try {
          writePrivate(join(runDir, "python-stdout.jsonl"), stdout);
          writePrivate(join(runDir, "python-stderr.log"), stderr);
          if (error !== null) {
            fail(new Error("local_generation_failed_no_retry"));
            return;
          }
          ok(stdout);
        } catch {
          fail(new Error("private_generation_save_failed"));
        }
      },
    );
  });
}

function dependencies(): LocalDependencies {
  const db = openOtakaraD1();
  return {
    loadRows: () => loadBenefitRows(db),
    generate,
    async archive(bytes, clock, phase) {
      const file = {
        filename: "summary-local.json.gz",
        contentType: "application/gzip",
        bytes,
      };
      const result = await recordPrimaryData({
        service: "otakara-yutai",
        key: `summary-local-${sha(bytes)}`,
        source: "D1 current benefits / pinned cached Qwen local generation",
        fetchedAt: clock,
        force: false,
        metadata: {
          clock,
          phase,
          bytes: bytes.length,
          sha256: sha(bytes),
          model: SEMIF_HF_MODEL,
          revision: SEMIF_HF_REVISION,
        },
        files: [file],
      });
      if (result.fileTooLarge || result.manifestMatch === "unknown") throw new Error("summary_archive_unqualified");
      await verifyArchivedAttachments(result.pageId, [file], "優待ローカル要約");
    },
    async apply(rows, plan) {
      // Rejected/equivalent groups are not yield-repair targets; keep their previous values.
      const targetIds = plan.updates.flatMap((u) => u.ids);
      await applyImportAtomically(db, createD1HttpBatchSender(), {
        targetIds,
        updates: plan.updates,
        verifiedBenefits: new Map(rows.filter((r) => targetIds.includes(r.id)).map((r) => [r.id, r])),
      });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  withBiztagWriter(async () => {
    const report = await runLocalSummary(parseLocalArgs(process.argv.slice(2)), dependencies());
    console.info(`[yutai:summary:local] ${JSON.stringify(report)}`);
    if (report.rejected > 0) process.exitCode = 1;
  }).catch(() => {
    // Shared exceptions may contain company text/private paths; keep terminal logs aggregate-only.
    console.error("[yutai:summary:local] STOP。私有証跡を確認してください。再試行しません。");
    process.exitCode = 1;
  });
}
