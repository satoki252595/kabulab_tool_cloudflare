import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { assertRevision } from "./runtime.js";
import { localJob } from "./main.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

it("優待要約は21時の専用jobで起動し、既存事業タグの時刻と未知job拒否を維持する", () => {
  expect(localJob(undefined)).toEqual(localJob("biztag"));
  expect(localJob("biztag").hour).toBe(20);
  expect(localJob("yutai-summary")).toMatchObject({ hour: 21,
    label: "com.kabulab-cf.yutai-summary", script: "services/otakara-yutai/data-scripts/summary-local.ts" });
  expect(() => localJob("unknown")).toThrow("job");
});

it("承認済みHEADの変更・追跡対象の変更ではwriterを開始しない", () => {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  expect(() => assertRevision(revision, revision, "")).not.toThrow();
  expect(() => assertRevision(revision, `${revision}changed`, "")).toThrow("HEAD");
  expect(() => assertRevision(revision, revision, " M package.json")).toThrow("変更");
});

it("helper終端後もNodeのOFDが同時writerを拒否し、Node終端後は残存ファイルから回復する", async () => {
  const state = mkdtempSync(join(tmpdir(), "biztag-kernel-lock-"));
  const helper = join(root, "scripts/biztag-local/writer-lock.py");
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const harness = join(state, "owner.mjs");
  writeFileSync(harness, `
import { openSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [state, helper, revision] = process.argv.slice(2);
const fd = openSync(state + '/writer.lock', 'a+', 0o600);
const acquired = spawnSync('python3', [helper, state, String(process.pid), revision], {stdio:['ignore','pipe','inherit',fd], encoding:'utf8'});
if (acquired.status !== 0) process.exit(1);
process.stdout.write(acquired.stdout);
process.stdin.resume();
`);
  const owner = spawn(process.execPath, [harness, state, helper, revision], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>((resolve) => owner.once("exit", () => resolve()));
  const reader = createInterface({ input: owner.stdout });
  try {
    const ready = await new Promise<string>((resolve, reject) => {
      reader.once("line", resolve);
      owner.once("exit", () => reject(new Error("ownerが排他取得前に終了しました")));
    });
    expect(JSON.parse(ready).locked).toBe(true);
    const attempt = (): { locked: boolean } => {
      const fd = openSync(join(state, "writer.lock"), "a+", 0o600);
      try {
        const result = spawnSync("python3", [helper, state, String(process.pid), revision], { stdio: ["ignore", "pipe", "pipe", fd], encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout) as { locked: boolean };
      } finally { closeSync(fd); }
    };
    expect(attempt().locked).toBe(false);
    owner.kill("SIGKILL");
    await exited;
    expect(existsSync(join(state, "writer.lock"))).toBe(true);
    expect(attempt().locked).toBe(true);
    expect(JSON.parse(readFileSync(join(state, "writer-history.jsonl"), "utf8")).previousHandleEnded).toBe(true);
  } finally {
    owner.kill("SIGKILL");
    reader.close();
    await exited;
    rmSync(state, { recursive: true });
  }
}, 15_000);

it("Linuxは日次biztagを起動せず、全backfill writerをcheckout前に拒否する", () => {
  const catchup = readFileSync(join(root, ".github/workflows/catchup.yml"), "utf8");
  const backfill = readFileSync(join(root, ".github/workflows/backfill.yml"), "utf8");
  expect(catchup).not.toContain("pnpm biztag");
  expect(catchup.slice(catchup.indexOf("  biztag:"))).toContain("github.event_name == 'workflow_dispatch'");
  const guard = backfill.indexOf('contains(fromJson(\'["biztag","biztag-golden","biztag-rollback","biztag-competitors"]\'), inputs.job)');
  expect(guard).toBeGreaterThan(0);
  expect(guard).toBeLessThan(backfill.indexOf("uses: actions/checkout"));
  expect(backfill).not.toContain("pnpm biztag");
  expect(`${catchup}\n${backfill}`).not.toContain("secrets.TYPESAFE_API_KEY");
});
