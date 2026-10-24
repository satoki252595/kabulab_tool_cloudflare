import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { main, parseMechanicalPublishingArgs } from "./mechanical-publishing.js";

afterEach(() => vi.unstubAllEnvs());
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
  const [supplement, yutai] = workflow.split("  supplement:\n")[1].split("  yutai:\n");
  expect(supplement).toContain("MECHANICAL_PUBLISHING_ENABLED");
  expect(yutai).toContain("needs: supplement"); expect(yutai).toContain("!cancelled()");
  for (const job of [supplement, yutai]) {
    expect(job).toContain("timeout-minutes: 30");
    expect(job).toContain("ref: ${{ github.sha }}");
    expect(job).not.toMatch(/allow-model|pip |uv |mlx|clef/);
  }
});
