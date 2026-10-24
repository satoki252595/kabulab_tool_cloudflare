/** Shared Linux/Actions tools, bounded independently of Clef/monthly manual processing. */
import "dotenv/config";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { sharedEnv } from "../../src/shared/env.js";
import { nativeJobExecutionWindow, installScheduledDeadline } from "../../src/shared/scheduled-admission.js";
import { parseStockCode } from "../../src/shared/jpx/stock-code.js";
import { runMechanicalPublishing } from "../../services/yuho-quant/src/biztag/mechanical-publishing.js";
import { runMechanicalSummary } from "../../services/otakara-yutai/data-scripts/summary-mechanical.js";
import { publishingStore, withSharedPublishingWriter } from "../mechanical-publishing/shared-writer.js";
import { launchEnv } from "./catchup-launch.js";

export function parseMechanicalPublishingArgs(argv: string[]) {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    target: { type: "string" }, limit: { type: "string" }, "budget-min": { type: "string", default: "10" },
    codes: { type: "string" }, "state-dir": { type: "string" },
  } });
  assert(values.target === "supplement" || values.target === "yutai", "targetをsupplement/yutaiで明示してください");
  const maximum = values.target === "supplement" ? 50 : 60;
  const limit = values.limit === undefined ? maximum : Number(values.limit), budgetMs = Number(values["budget-min"]) * 60_000;
  assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= maximum);
  assert(Number.isSafeInteger(budgetMs) && budgetMs > 0 && budgetMs <= 15 * 60_000);
  const codes = values.codes === undefined ? undefined : values.codes.split(",");
  if (codes !== undefined) assert(values.target === "supplement" && codes.length > 0 && codes.length <= limit && new Set(codes).size === codes.length && codes.every(code => parseStockCode(code) === code));
  assert(values.target === "supplement" ? values["state-dir"] === undefined : values["state-dir"] !== undefined && values["state-dir"].trim().length > 0);
  return { target: values.target, limit, budgetMs, codes, stateDir: values["state-dir"] };
}

/** 元のCLI予算とnative killの両方から、同じsoft/hardを各publisherへ渡す。 */
export function mechanicalPublishingWindow(budgetMs: number, nowMs: number, jobStartedAt: string | undefined,
  github: boolean) {
  assert(Number.isSafeInteger(budgetMs) && budgetMs > 0 && budgetMs <= 15 * 60_000);
  assert(!github || jobStartedAt !== undefined, "GitHub job開始時計がありません。取得前に停止します");
  const native = nativeJobExecutionWindow(nowMs, jobStartedAt, 30, 5);
  const requested = nowMs + budgetMs + 5 * 60_000;
  const deadline = native === undefined ? requested : Math.min(requested, native.deadline);
  const sourceDeadline = deadline - 5 * 60_000;
  assert(Number.isSafeInteger(deadline) && sourceDeadline > nowMs, "機械同期の新規開始予算が残っていません");
  return { sourceDeadline, deadline };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseMechanicalPublishingArgs(argv);
  if (launchEnv.eventName() !== undefined) {
    assert(["schedule", "workflow_dispatch"].includes(launchEnv.eventName()!));
    assert.equal(launchEnv.eventRef(), "refs/heads/main");
    assert(sharedEnv.BATCH_JOB_STARTED_AT() !== undefined, "GitHub job開始時計がありません。取得前に停止します");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(head, launchEnv.eventSha()); execFileSync("git", ["diff", "--quiet", "HEAD", "--"], { stdio: "ignore" });
  }
  const window = mechanicalPublishingWindow(options.budgetMs, Date.now(), sharedEnv.BATCH_JOB_STARTED_AT(), launchEnv.eventName() !== undefined);
  const restore = installScheduledDeadline(window.deadline);
  try {
    const store = publishingStore(window.deadline);
    const result = options.target === "supplement"
      ? await withSharedPublishingWriter(() => runMechanicalPublishing({ limit: options.limit, budgetMs: options.budgetMs, codes: options.codes, sourceDeadlineMs: window.sourceDeadline, deadlineMs: window.deadline }), store)
      : await runMechanicalSummary({ limit: options.limit, stateDir: resolve(options.stateDir!), allowModel: false, sourceDeadlineMs: window.sourceDeadline }, undefined, store);
    console.info(`[mechanical-publishing] ${JSON.stringify({ target: options.target, ...result })}`);
    return options.target === "supplement" && "held" in result && (Array.isArray(result.held) && result.held.length > 0 || "unstarted" in result && result.unstarted > 0) ||
      "rejected" in result && result.rejected > 0 ? 1 : 0;
  } finally { restore(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(); }
  catch (error) {
    const name = error instanceof Error && ["NotionConfigError", "NotionUnknownResultError", "PublishingReadOnlyError", "R2PutRejectedError", "R2PutUnknownError", "AssertionError"].includes(error.name) ? error.name : "unexpected_failure";
    console.error(`[mechanical-publishing] stopped_no_automatic_retry class=${name}`); process.exitCode = 2;
  }
}
