import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([
  ["import-summary-results.ts", ["--tasks", "not-read.json", "--results", "not-read.json", "--apply"], "standalone_summary_apply_retired"],
  ["backfill-public-facts.ts", ["apply", "not-read.json", "not-created"], "単体適用は停止済み"],
  ["backfill-public-facts.ts", ["resume-upgrade-holding-v1-read-only-stop", "not-read.json", "not-created"], "単体適用は停止済み"],
])("retired standalone mutation %s stops before env/file/D1/Notion initialization (%j)", (script, args, diagnostic) => {
  const directory = mkdtempSync(join(tmpdir(), "publishing-retired-"));
  try {
    const child = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"),
      fileURLToPath(new URL(`../../data-scripts/${script}`, import.meta.url)), ...args], { cwd: directory, env: {}, encoding: "utf8", timeout: 15_000 });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
    expect(child.stderr).toContain(diagnostic); expect(child.stderr).not.toMatch(/ENOENT|NOTION_TOKEN|R2_BUCKET|CLOUDFLARE/);
    expect(readdirSync(directory)).toEqual([]);
  } finally { rmSync(directory, { recursive: true }); }
});
