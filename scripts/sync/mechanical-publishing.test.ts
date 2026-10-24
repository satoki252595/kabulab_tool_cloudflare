import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { main, mechanicalPublishingWindow, parseMechanicalPublishingArgs } from "./mechanical-publishing.js";

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
it("explicit finite targets reject model, unbounded scope and accidental full-market codes", () => {
  expect(parseMechanicalPublishingArgs(["--target=supplement"])).toMatchObject({ limit: 50, budgetMs: 600_000 });
  expect(parseMechanicalPublishingArgs(["--target=yutai", "--state-dir=private"])).toMatchObject({ limit: 60 });
  for (const argv of [[], ["--target=supplement", "--allow-model"], ["--target=supplement", "--limit=51"],
    ["--target=yutai"], ["--target=yutai", "--state-dir=private", "--codes=6103"], ["--target=supplement", "--codes=6103,6103"],
    ["--target=supplement", "--budget-min=16"]]) expect(() => parseMechanicalPublishingArgs(argv)).toThrow();
});
it("a non-main GitHub invocation is rejected before R2 config or source initialization", async () => {
  vi.stubEnv("GITHUB_EVENT_NAME", "workflow_dispatch"); vi.stubEnv("GITHUB_REF", "refs/heads/unaccepted-protocol-branch");
  vi.stubEnv("R2_BUCKET_RAW", "");
  await expect(main(["--target=supplement"])).rejects.toThrow("refs/heads/main");
});
it("Linux DAG reserves setup/closure time and lets yutai run after known supplement failure without model dependencies", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/mechanical-publishing.yml", import.meta.url), "utf8");
  expect(workflow).toContain("R2_BUCKET_RAW: ${{ secrets.R2_BUCKET_RAW }}");
  expect(workflow).toContain("actions: read");
  const [supplement, yutai] = workflow.split("  supplement:\n")[1].split("  yutai:\n");
  expect(supplement).toContain("MECHANICAL_PUBLISHING_ENABLED");
  expect(yutai).toContain("needs: supplement"); expect(yutai).toContain("!cancelled()");
  for (const job of [supplement, yutai]) {
    expect(job).toContain("timeout-minutes: 30");
    expect(job.indexOf("./.github/actions/record-job-clock")).toBeGreaterThan(job.indexOf("actions/checkout@v4"));
    expect(job.indexOf("./.github/actions/record-job-clock")).toBeLessThan(job.indexOf("pnpm/action-setup@v4"));
    expect(job).toContain("ref: ${{ github.sha }}");
    expect(job).not.toMatch(/allow-model|pip |uv |mlx|clef/);
  }
});

it("native setup time shortens only the absolute window, preserving five-minute closure and the requested budget", () => {
  const started = Date.parse("2026-10-25T19:17:00.000Z"), now = started + 11 * 60_000;
  const options = parseMechanicalPublishingArgs(["--target=yutai", "--state-dir=private", "--budget-min=15"]);
  expect(mechanicalPublishingWindow(options.budgetMs, now, new Date(started).toISOString(), true))
    .toEqual({ sourceDeadline: started + 20 * 60_000, deadline: started + 25 * 60_000 });
  expect(options.budgetMs).toBe(15 * 60_000);
  expect(mechanicalPublishingWindow(600_000, now, undefined, false))
    .toEqual({ sourceDeadline: now + 600_000, deadline: now + 900_000 });
  expect(() => mechanicalPublishingWindow(600_000, now, undefined, true)).toThrow("job開始時計");
  expect(() => mechanicalPublishingWindow(600_000, started + 20 * 60_000, new Date(started).toISOString(), true)).toThrow("予算が残っていません");
  expect(() => mechanicalPublishingWindow(600_000, now, new Date(now + 1).toISOString(), true)).toThrow("未来");
});
it("a GitHub job without native clock stops before shared owner configuration or source creation", async () => {
  vi.stubEnv("GITHUB_EVENT_NAME", "schedule"); vi.stubEnv("GITHUB_REF", "refs/heads/main");
  vi.stubEnv("BATCH_JOB_STARTED_AT", ""); vi.stubEnv("R2_BUCKET_RAW", "");
  await expect(main(["--target=supplement"])).rejects.toThrow("job開始時計");
});
