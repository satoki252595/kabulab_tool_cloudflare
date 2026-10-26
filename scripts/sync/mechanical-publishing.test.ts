import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { main, mechanicalPublishingAssertionDiagnostic, mechanicalPublishingWindow, parseMechanicalPublishingArgs } from "./mechanical-publishing.js";
import * as publishing from "../mechanical-publishing/shared-writer.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const required = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID", "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_RAW", "NOTION_TOKEN", "NOTION_ARCHIVE_PAGE_ID"];
const controlId = "0123456789abcdef0123456789abcdef";
function preflightBoundary() {
  for (const key of required) vi.stubEnv(key, key === "NOTION_ARCHIVE_PAGE_ID" ? controlId : "controlled-test-credential");
  for (const key of ["NOTION_DB_STOCK_MASTER", "NOTION_YUHO_TEXT_DB_ID", "NOTION_STOCK_SUPPLEMENT_DB_ID", "NOTION_STOCK_INFO_PAGE_ID"]) vi.stubEnv(key, controlId);
  vi.stubEnv("GITHUB_EVENT_NAME", undefined); vi.stubEnv("BATCH_JOB_STARTED_AT", undefined); vi.stubEnv("NOTION_MAX_RPS", "0.8");
  const store = vi.spyOn(publishing, "publishingStore").mockImplementation(() => { throw new Error("test_writer_boundary"); });
  const writer = vi.spyOn(publishing, "withSharedPublishingWriter"), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  return { store, writer, fetch };
}

it.each(required)("missing %s stops before the shared owner or any fetch", async key => {
  const io = preflightBoundary(); vi.stubEnv(key, "");
  await expect(main(["--target=supplement"])).rejects.toThrow(key);
  expect(io.store).not.toHaveBeenCalled(); expect(io.writer).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
});
it.each(["", "invalid-id"])("missing/invalid master relation stops before the shared owner (%s)", async value => {
  const io = preflightBoundary(); vi.stubEnv("NOTION_DB_STOCK_MASTER", value);
  await expect(main(["--target=supplement"])).rejects.toThrow(/NOTION_DB_STOCK_MASTER|Notion ID/);
  expect(io.store).not.toHaveBeenCalled(); expect(io.writer).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
});
it.each(["0", "2.7", "NaN"])("invalid optional Notion pacing stops before the shared owner (%s)", async value => {
  const io = preflightBoundary(); vi.stubEnv("NOTION_MAX_RPS", value);
  await expect(main(["--target=supplement"])).rejects.toThrow(/Notion pacing|NOTION_MAX_RPS/);
  expect(io.store).not.toHaveBeenCalled(); expect(io.writer).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
});
it("yutai does not require supplement-only settings or optional pacing", async () => {
  const io = preflightBoundary();
  for (const key of ["NOTION_DB_STOCK_MASTER", "NOTION_YUHO_TEXT_DB_ID", "NOTION_STOCK_SUPPLEMENT_DB_ID", "NOTION_STOCK_INFO_PAGE_ID", "NOTION_MAX_RPS"]) vi.stubEnv(key, undefined);
  await expect(main(["--target=yutai", "--state-dir=private"])).rejects.toThrow("test_writer_boundary");
  expect(io.store).toHaveBeenCalledOnce(); expect(io.writer).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
});
it.each([true, false])("supplement keeps the fixed DB optional and only needs a parent for discovery (%s)", async fixed => {
  const io = preflightBoundary();
  vi.stubEnv("NOTION_STOCK_SUPPLEMENT_DB_ID", fixed ? controlId : undefined);
  vi.stubEnv("NOTION_STOCK_INFO_PAGE_ID", fixed ? undefined : controlId);
  await expect(main(["--target=supplement"])).rejects.toThrow("test_writer_boundary");
  expect(io.store).toHaveBeenCalledOnce(); expect(io.writer).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
});
it("an invalid optional fixed DB or missing discovery parent stops before the shared owner", async () => {
  const io = preflightBoundary(); vi.stubEnv("NOTION_STOCK_SUPPLEMENT_DB_ID", "invalid-id");
  await expect(main(["--target=supplement"])).rejects.toThrow("Notion ID");
  vi.stubEnv("NOTION_STOCK_SUPPLEMENT_DB_ID", undefined); vi.stubEnv("NOTION_STOCK_INFO_PAGE_ID", undefined);
  await expect(main(["--target=supplement"])).rejects.toThrow("NOTION_STOCK_INFO_PAGE_ID");
  expect(io.store).not.toHaveBeenCalled(); expect(io.writer).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
});
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
  const artifact = yutai.slice(yutai.indexOf("      - name: 優待の対象metadata"));
  expect(artifact).toContain("if: always()");
  expect(artifact).toContain("uses: actions/upload-artifact@v4");
  expect(artifact).toContain("retention-days: 7");
  expect(artifact).toContain("if-no-files-found: warn");
  expect([...artifact.matchAll(/^ {12}(.+)$/gm)].map(match => match[1])).toEqual(
    ["task-metadata.json", "post-verified.json", "complete.json"].map(name =>
      `\${{ runner.temp }}/yutai-mechanical/*/${name}`));
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

it("logs an AssertionError message and only its first frame", () => {
  const marker = "INC-20261026-kabulab_tool_cloudflare-mechpub-fail";
  const clipped = new Error(`${"あ".repeat(299)}\n${"い".repeat(10)}`);
  clipped.stack = "AssertionError: clipped\n    at run (file:///workspace/scripts/mechanical-publishing/shared-writer.ts:141:3)\n    at later (file:///workspace/scripts/sync/mechanical-publishing.ts:79:5)";
  const line = mechanicalPublishingAssertionDiagnostic(clipped);
  expect(line).toBe(`[${marker}] assert=${"あ".repeat(299)}  at=file:///workspace/scripts/mechanical-publishing/shared-writer.ts:141:3`);
  expect(line).not.toContain("い");
  expect(line).not.toContain("mechanical-publishing.ts:79");
  const missing = new Error("only");
  missing.stack = undefined;
  expect(mechanicalPublishingAssertionDiagnostic(missing)).toBe(`[${marker}] assert=only at=不明`);
  const unparsed = new Error("only");
  unparsed.stack = "AssertionError: only\n    at not-a-frame\n    at real (file:///workspace/scripts/mechanical-publishing/shared-writer.ts:141:3)";
  expect(mechanicalPublishingAssertionDiagnostic(unparsed)).toBe(`[${marker}] assert=only at=不明`);
  let caught: unknown;
  try { assert.equal("refs/heads/topic", "refs/heads/main"); }
  catch (error) { caught = error; }
  if (!(caught instanceof Error) || caught.name !== "AssertionError") throw new Error("expected AssertionError");
  const actual = mechanicalPublishingAssertionDiagnostic(caught);
  expect(actual.startsWith(`[${marker}] assert=`)).toBe(true);
  expect(actual).toContain("refs/heads/topic");
  expect(actual).toContain("refs/heads/main");
  expect(actual).toMatch(/ at=\S+:\d+:\d+$/);
  expect(actual.includes("\n")).toBe(false);
});
