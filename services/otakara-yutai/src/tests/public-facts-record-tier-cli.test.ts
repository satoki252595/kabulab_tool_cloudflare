/** Normal CLI with structural D1/archive adapters; no network or production writes. */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { benefitKey } from "../../data-scripts/benefit-key.js";
import { buildPublicBenefitFacts } from "../../data-scripts/public-facts.js";
import { runPublicFactsBackfillCLI, type PublicFactsPreimage } from "../../data-scripts/backfill-public-facts.js";
import type { D1BatchStatement } from "../../../../src/shared/db/d1-http-client.js";
import type { RecordResult } from "../../../../src/shared/notion-archive/archive.js";

const adapter = vi.hoisted(() => ({ envPath: "", rows: [] as PublicFactsPreimage[], after: [] as PublicFactsPreimage[],
  reads: 0, batches: [] as D1BatchStatement[][], archives: [] as { key: string; metadata: Record<string, unknown>; files: { filename: string; bytes: Uint8Array }[] }[], unknown: false }));
vi.mock("node:fs", async load => {
  const actual = await load<typeof import("node:fs")>();
  return { ...actual, realpathSync: (path: Parameters<typeof actual.realpathSync>[0]) => path === ".env" ? adapter.envPath : actual.realpathSync(path) };
});
vi.mock("../../data-scripts/benefit-rows.js", () => ({ openOtakaraD1: () => ({ select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ orderBy: () => ({ limit: async () => { adapter.reads++; return structuredClone(adapter.rows); } }) }) }) }) }) }) }));
vi.mock("../../../../src/shared/db/d1-http-client.js", () => ({ createD1HttpBatchSender: () => async (statements: D1BatchStatement[]) => {
  adapter.batches.push(structuredClone(statements)); if (adapter.unknown) throw Error("protocol sender unknown"); adapter.rows = structuredClone(adapter.after);
} }));
vi.mock("../../../../src/shared/notion-archive/index.js", () => ({ recordPrimaryData: vi.fn(async input => {
  adapter.archives.push(input); return { pageId: `protocol-archive-${adapter.archives.length}`, outcome: "recorded", fileTooLarge: false, manifestMatch: "written" } satisfies RecordResult;
}), verifyArchivedAttachments: vi.fn(async () => undefined) }));

const originalArgv = process.argv;
const directories: string[] = [];
afterEach(() => { process.argv = originalArgv; for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); });

function inputs(literals = false) {
  const base = mkdtempSync(join(tmpdir(), "yutai-record-tier-cli-")); directories.push(base);
  const description = '【種別："QUOカード"】\n【1年未満保有株主】\n2,000円相当\n【1年以上保有株主】\n5,000円相当\n■継続保有期間について\n1年以上継続保有:株主名簿に3回以上記載または記録\n\n■贈呈時期\n毎年3月下旬発送予定' + (literals ? '\n※同じ株主番号が必要' : '');
  const facts = buildPublicBenefitFacts({ code: "1899", description, context: { minShares: [200], recordMonths: [12] }, fetchedAt: null, batchFetchedAt: null });
  if (facts.version !== (literals ? 5 : 4)) throw Error("protocol version required");
  const { conditionStructure, ...fields } = facts; void conditionStructure;
  const row: PublicFactsPreimage = { id: 1, stockId: 1, stockCode: "1899", stockName: "文法試験", description, genreId: 1, createdAt: 1, updatedAt: 2,
    shortSummary: null, estimatedValue: null, estimateValueSource: null, minShares: 200, recordMonth: 12, recordDate: null, publicFacts: JSON.stringify({ ...fields, version: 1 }) };
  adapter.envPath = join(base, ".env"); writeFileSync(adapter.envPath, "", { mode: 0o600 });
  mkdirSync(join(base, "tmp"), { mode: 0o700 });
  adapter.rows = [row]; adapter.after = []; adapter.reads = 0; adapter.batches = []; adapter.archives = []; adapter.unknown = false;
  const { genreId, createdAt, publicFacts, ...sourceRow } = row; void genreId; void createdAt; void publicFacts;
  const sourcePath = join(base, "source.json"), scopePath = join(base, "scope.json"), dir = join(base, "prepared");
  writeFileSync(sourcePath, JSON.stringify({ fetchedAt: "2026-10-17T00:00:00.000Z", rows: [sourceRow] }));
  writeFileSync(scopePath, JSON.stringify({ version: 1, ...(literals ? {} : { kind: "holding-record-tiers-v1" }), groups: [{ code: row.stockCode, taskId: benefitKey(row.stockCode, description), sourceSha256: facts.conditionStructure.sourceSha256, rows: 1, recipients: [{ minShares: 200, recordMonth: 12, recordDate: null }] }] }));
  const run = (mode: string) => { process.argv = ["node", "backfill-public-facts.ts", mode, sourcePath, dir, scopePath]; return runPublicFactsBackfillCLI(); };
  return { base, dir, run, state: join(base, literals ? "tmp/yutai-public-facts-v1-tier-literals-upgrade" : "tmp/yutai-public-facts-v1-record-tier-upgrade") };
}

describe("通常CLIの明示v1→v4有限入口", () => {
  it("同じ全列CAS/物理PREPOSTを呼び、元v1と旧mode stateを保持して正常完了する", async () => {
    const { base, dir, run, state } = inputs(), native = vi.fn(); vi.stubGlobal("fetch", native);
    for (const name of ["yutai-public-facts-v1-upgrade", "yutai-public-facts-v1-holding-upgrade"]) {
      const old = join(base, "tmp", name); mkdirSync(old, { recursive: true, mode: 0o700 }); writeFileSync(join(old, "old-unknown"), "preserve");
    }
    const before = structuredClone(adapter.rows);
    await run("prepare-upgrade-record-tier-v1"); expect(adapter.reads).toBe(1); expect(adapter.archives).toHaveLength(0); expect(existsSync(state)).toBe(false);
    const manifest = JSON.parse(readFileSync(join(dir, "upgrade-manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ kind: "holding-record-tiers-v1", targetVersion: 4, groups: 1, targetRows: 1, codes: ["1899"] });
    adapter.after = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
    await run("apply-upgrade-record-tier-v1");
    expect(adapter.batches).toEqual([JSON.parse(readFileSync(join(dir, "sql-plan.json"), "utf8"))]); expect(adapter.batches[0]).toHaveLength(3);
    expect(adapter.reads).toBe(2); expect(adapter.archives).toHaveLength(2);
    for (const [index, phase] of ["pre", "post"].entries()) {
      const archive = adapter.archives[index]; expect(archive.key).toMatch(new RegExp(`^yutai-v1-record-tier-upgrade-${phase}-[a-f0-9]{64}$`));
      expect(archive.metadata).toMatchObject({ kind: "holding-record-tiers-v1", targetVersion: 4 });
      expect(archive.files[0].filename.length).toBeLessThanOrEqual(100);
      expect(JSON.parse(gunzipSync(archive.files[0].bytes).toString()).rows).toEqual(index === 0 ? before : adapter.after);
    }
    expect(JSON.parse(readFileSync(join(state, "upgrade-v1-completed.json"), "utf8"))).toMatchObject({ kind: "holding-record-tiers-v1", targetVersion: 4 });
    await expect(run("apply-upgrade-record-tier-v1")).rejects.toThrow(/開始済み/); expect(adapter.batches).toHaveLength(1);
    for (const name of ["yutai-public-facts-v1-upgrade", "yutai-public-facts-v1-holding-upgrade"]) expect(readFileSync(join(base, "tmp", name, "old-unknown"), "utf8")).toBe("preserve");
    expect(native).not.toHaveBeenCalled();
  });
  it("D1結果不明では新mode intentだけを保ち、POST/completion/別run再送へ進まない", async () => {
    const native = vi.fn(() => { throw Error("network forbidden"); }); vi.stubGlobal("fetch", native);
    const { dir, run, state } = inputs(); await run("prepare-upgrade-record-tier-v1");
    adapter.after = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")); adapter.unknown = true;
    await expect(run("apply-upgrade-record-tier-v1")).rejects.toThrow(/unknown/);
    expect(adapter.archives).toHaveLength(1); expect(existsSync(join(state, "upgrade-v1-started.json"))).toBe(true);
    expect(existsSync(join(state, "upgrade-v1-completed.json"))).toBe(false);
    const pending = readFileSync(join(state, "upgrade-v1-started.json"));
    await expect(run("apply-upgrade-record-tier-v1")).rejects.toThrow(); expect(adapter.batches).toHaveLength(1); expect(adapter.reads).toBe(1);
    expect(readFileSync(join(state, "upgrade-v1-started.json")).equals(pending)).toBe(true);
    expect(native).not.toHaveBeenCalled();
  });
});

// 通常CLIの同じadapterでv5を通し、前batchの壊れた完了を迂回しない。
it("期間行v5を同じ物理PRE/POST・限定CASで更新し、壊れた前completionでは再送しない", async () => {
  const { dir, run, state } = inputs(true), native = vi.fn(); vi.stubGlobal("fetch", native);
  await run("prepare-upgrade-tier-literals-v1");
  adapter.after = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
  await run("apply-upgrade-tier-literals-v1");
  expect(adapter.batches).toHaveLength(1);
  expect(adapter.batches[0][0].sql).toContain("json_extract(b.public_facts,'$.sourceGroup') IN");
  expect(adapter.archives).toHaveLength(2);
  expect(adapter.archives[0].metadata).toMatchObject({ kind: "holding-tier-lines-v1", targetVersion: 5 });
  const prior = join(state, readdirSync(state)[0]);
  const completed = JSON.parse(readFileSync(join(prior, "upgrade-v1-completed.json"), "utf8"));
  expect(completed.kind).toBe("holding-tier-lines-v1");
  writeFileSync(join(prior, "upgrade-v1-completed.json"), JSON.stringify({ ...completed, intentSha256: "0".repeat(64) }));
  await expect(run("apply-upgrade-tier-literals-v1")).rejects.toThrow(/receipt/);
  expect(adapter.batches).toHaveLength(1); expect(native).not.toHaveBeenCalled();
});
