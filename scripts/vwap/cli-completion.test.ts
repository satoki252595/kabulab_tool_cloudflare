import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Run the actual CLI entry in a separate Node process: unresolved Promises alone
// do not keep its event loop alive. No source/R2/Notion or financial fixtures.
const marker = "if (process.argv[1] === fileURLToPath(import.meta.url)) {";
function runEntry(kind: string, mainBody: string) {
  const source = readFileSync(new URL(`./ingest-${kind}.ts`, import.meta.url), "utf8");
  const entry = source.slice(source.lastIndexOf(marker));
  expect(entry.startsWith(marker)).toBe(true);
  const code = ts.transpileModule(`
    import { fileURLToPath } from "node:url";
    process.argv[1] = fileURLToPath(import.meta.url);
    const sanitizeLogText = (s: string) => s;
    async function main() { ${mainBody} }
    ${entry}
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5000 });
}

describe.each(["daily", "intra", "margin"])("%s CLI completion", (kind) => {
  it("unfinished operation cannot exit successfully", () => {
    const child = runEntry(kind, "await new Promise(() => {});");
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(2);
  });
  it("rejected operation is fatal", () => {
    const child = runEntry(kind, "throw new Error('operation rejected');");
    expect(child.status).toBe(2);
    expect(child.stderr).toContain(`ingest-${kind} fatal:`);
  });
  it("completed operation can exit successfully", () => {
    const child = runEntry(kind, kind === "margin" ? "return;" : "process.exitCode = 0;");
    expect(child.status).toBe(0);
  });
});

describe.each(["daily", "intra"])("%s completion accounting", (kind) => {
  it.each([1, 2])("preserves completed partial/fatal exit %i", (exit) => {
    expect(runEntry(kind, `process.exitCode = ${exit};`).status).toBe(exit);
  });
});

it("aborted pool drains settled work; unfinished inflight operation stays fatal", () => {
  const source = readFileSync(new URL("./lib/r2.ts", import.meta.url), "utf8");
  const pool = source.slice(source.indexOf("export async function mapLimit"), source.indexOf("export const sleep"));
  const setup = `${pool.replace("export ", "")}\nlet aborted = false;`;
  // One worker receives an abort result; the other already-started I/O remains
  // unresolved. The pool must not pretend that inflight work completed.
  expect(runEntry("daily", `${setup}
    await mapLimit([0, 1, 2], 2, async (_, i) => {
      if (aborted) return;
      if (i === 0) { await Promise.resolve(); aborted = true; return; }
      await new Promise(() => {});
    });
    process.exitCode = 0;
  `).status).toBe(2);
  expect(runEntry("daily", `${setup}
    await mapLimit([0, 1, 2], 2, async () => { if (!aborted) aborted = true; });
    process.exitCode = aborted ? 2 : 0;
  `).status).toBe(2);
});
