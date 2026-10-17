/** Procedural fixtures only: no network, no production state or financial-data claims. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { toNotionUpload } from "../../../../src/shared/notion-archive/file-upload.js";
import { benefitKey } from "../../data-scripts/benefit-key.js";
import { buildPublicBenefitFacts } from "../../data-scripts/public-facts.js";
import { claimHoldingUpgradeZeroNative, claimPublicFactsUpgrade, parsePublicFactsHoldingUpgradeScope,
  planPublicFactsV1HoldingUpgrade, publicFactsUpgradeFilename, qualifyHoldingUpgradeZeroNative } from "../../data-scripts/backfill-public-facts.js";
import holdingSaved from "./fixtures/holding-period-saved4.json";

const dirs: string[] = [], sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const write = (path: string, value: unknown) => { writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); return path; };
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); vi.unstubAllGlobals(); });
function protocol() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "holding-zero-native-protocol-"))); dirs.push(root);
  const env = join(root, ".env"); writeFileSync(env, "# Procedural test only; never used for native HTTP.\n", { mode: 0o600 });
  const state = join(root, "tmp/yutai-public-facts-v1-holding-upgrade"), directory = join(root, "plan"), attemptDir = join(root, "old-attempt");
  mkdirSync(dirname(state), { mode: 0o700 }); mkdirSync(directory, { mode: 0o700 }); mkdirSync(attemptDir, { mode: 0o700 });
  const description = '【種別："オンラインショップ・クーポン（長期保有者向け）"】\n【半年以上保有】\n1,000円相当';
  const next = buildPublicBenefitFacts({ code: "7203", description, context: { minShares: [100], recordMonths: [3] }, fetchedAt: null, batchFetchedAt: null });
  if (next.version !== 3) throw new Error("protocol v3 required");
  const { conditionStructure, ...old } = next; void conditionStructure;
  const rows = [{ id: 1, stockId: 1, stockCode: "7203", stockName: "手順試験専用", description, shortSummary: null,
    estimatedValue: 1000, estimateValueSource: "company_per_grant", minShares: 100, recordMonth: 3, recordDate: null,
    updatedAt: 2, genreId: 1, createdAt: 1, publicFacts: JSON.stringify({ ...old, version: 1 }) }];
  const source = { fetchedAt: "2026-10-13T16:48:46.724Z", rows: rows.map(({ genreId, createdAt, publicFacts, ...r }) => { void genreId; void createdAt; void publicFacts; return r; }) };
  const scope = parsePublicFactsHoldingUpgradeScope({ version: 1, kind: "single-holding-period-v1", groups: [{ code: "7203", taskId: benefitKey("7203", description), sourceSha256: sha(description), rows: 1, recipients: [{ minShares: 100, recordMonth: 3, recordDate: null }] }] });
  const plan = planPublicFactsV1HoldingUpgrade(source.rows, rows, scope);
  const sourcePath = write(join(directory, "source.json"), source), scopePath = write(join(directory, "scope.json"), scope);
  write(join(directory, "preimage.json"), rows); write(join(directory, "expected.json"), plan.expected); write(join(directory, "sql-plan.json"), plan.statements);
  const manifest = { version: 1, kind: "single-holding-period-v1", targetVersion: 3, preparedAt: "2026-10-17T06:01:06.678Z",
    sourceSha256: sha(readFileSync(sourcePath)), scopeSha256: sha(readFileSync(scopePath)), preimageSha256: sha(readFileSync(join(directory, "preimage.json"))),
    expectedSha256: sha(readFileSync(join(directory, "expected.json"))), planSha256: sha(readFileSync(join(directory, "sql-plan.json"))), rows: 1, targetRows: 1, groups: 1, codes: ["7203"] };
  const manifestPath = write(join(directory, "upgrade-manifest.json"), manifest), observerPath = write(join(root, "observer.json"), { procedural: true }),
    readPlanPath = write(join(root, "read-plan.json"), { sourceHead: "3b6990da5cbd1b4bbc54a8973bb47ad5d2c54494", envRealpath: env, envSha256: sha(readFileSync(env)), sourcePins: { [observerPath]: sha(readFileSync(observerPath)) }, inputPins: { [sourcePath]: sha(readFileSync(sourcePath)) } });
  const rootAudit = write(join(root, "root-pre-audit.json"), { acceptedMain: "3b6990da5cbd1b4bbc54a8973bb47ad5d2c54494", readPlanSha256: sha(readFileSync(readPlanPath)), manifestSha256: sha(readFileSync(manifestPath)) });
  const releasePath = write(join(root, "old-release.json"), { status: "ROOT_RELEASED_NORMAL_V1_HOLDING_UPGRADE4_APPLY_ONCE", sourceHead: "3b6990da5cbd1b4bbc54a8973bb47ad5d2c54494",
    applySha256: sha(readFileSync(observerPath)), canonicalStateRealpath: state, freshManifestSha256: sha(readFileSync(manifestPath)), rootPreAuditPath: rootAudit, rootPreAuditSha256: sha(readFileSync(rootAudit)) });
  const attemptPath = write(join(attemptDir, "attempt-once.json"), { at: "2026-10-17T06:10:03.117Z", sourceAPI: 0, models: 0, unknownResend: false, releaseSha256: sha(readFileSync(releasePath)) });
  const stopPath = write(join(attemptDir, "STOP.json"), { at: "2026-10-17T06:10:03.337Z", seq: 0, notion: 0, hosted: 0, d1Read: 0, d1Batch: 0, unknownResend: false });
  claimPublicFactsUpgrade(state, { at: "2026-10-17T06:10:03.315Z", kind: "single-holding-period-v1", targetVersion: 3, dir: directory, scopeSha256: manifest.scopeSha256, preimageSha256: manifest.preimageSha256, planSha256: manifest.planSha256 });
  const startedPath = join(state, "upgrade-v1-started.json"), proofPath = join(root, "qualification.json"), pins = Object.fromEntries([env, observerPath, readPlanPath, rootAudit, releasePath, attemptPath, stopPath, startedPath, ...readdirSync(directory).map(n => join(directory, n))].map(p => [p, sha(readFileSync(p))]));
  const proof = { version: 1, kind: "holding-upgrade-zero-native", allOwnedProcessesTerminal: true, directory, originalSourceHead: "3b6990da5cbd1b4bbc54a8973bb47ad5d2c54494", originalStartedSha256: sha(readFileSync(startedPath)), originalAttemptDir: attemptDir, originalReleasePath: releasePath, originalObserverPath: observerPath, originalReadPlanPath: readPlanPath, pins };
  write(proofPath, proof);
  return { root, state, directory, manifest, proof, proofPath, startedPath, sourcePath, scopePath, attemptDir, stopPath, releasePath };
}

describe("holding zero-nativeの明示再資格", () => {
  it("実4source SHAの両phase名が100字以内で完全SHAを維持し、旧choice名は同一", () => {
    for (const row of holdingSaved.groups) for (const phase of ["pre", "post"] as const) {
      expect(() => toNotionUpload(`yutai-v1-holding-upgrade-${phase}-${row.sourceSha256}.json.gz`, "application/gzip")).toThrow(/100文字/);
      const name = publicFactsUpgradeFilename(true, phase, row.sourceSha256);
      expect(name.length).toBeLessThanOrEqual(100); expect(name).toContain(row.sourceSha256);
      expect(publicFactsUpgradeFilename(false, phase, row.sourceSha256)).toBe(`yutai-v1-upgrade-${phase}-${row.sourceSha256}.json.gz`);
    }
  });
  it("旧startedを保持し、native0の同dir/全pinsだけ一度sidecarへ束縛する", () => {
    const f = protocol(), old = readFileSync(f.startedPath), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(qualifyHoldingUpgradeZeroNative(f.state, f.directory, f.manifest, f.proofPath)).toMatchObject({ originalACKInvented: false });
    claimHoldingUpgradeZeroNative(f.state, f.directory, f.manifest, f.proofPath);
    expect(readFileSync(f.startedPath).equals(old)).toBe(true);
    expect(readdirSync(f.state).sort()).toEqual(["upgrade-v1-started.json", "upgrade-v1-zero-native-resume-started.json"]);
    expect(() => claimHoldingUpgradeZeroNative(f.state, f.directory, f.manifest, f.proofPath)).toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["native", "extra-native", "new-directory", "changed-pin", "changed-manifest", "missing-pin", "unclosed"])("%sはsidecar/HTTP前に拒否する", kind => {
    const f = protocol(), old = readFileSync(f.startedPath), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    let directory = f.directory, manifest = f.manifest;
    if (kind === "native") { write(f.stopPath, { ...read(f.stopPath), d1Batch: 1 }); f.proof.pins[f.stopPath] = sha(readFileSync(f.stopPath)); write(f.proofPath, f.proof); }
    if (kind === "extra-native") write(join(f.attemptDir, "intent-1.json"), { procedural: true });
    if (kind === "new-directory") { directory = join(f.root, "different"); mkdirSync(directory); }
    if (kind === "changed-pin") write(f.sourcePath, {});
    if (kind === "changed-manifest") manifest = { ...manifest, planSha256: holdingSaved.groups[0].sourceSha256 };
    if (kind === "missing-pin") { delete f.proof.pins[f.startedPath]; write(f.proofPath, f.proof); }
    if (kind === "unclosed") write(f.proofPath, { ...f.proof, allOwnedProcessesTerminal: false });
    expect(() => claimHoldingUpgradeZeroNative(f.state, directory, manifest, f.proofPath)).toThrow();
    expect(readdirSync(f.state)).toEqual(["upgrade-v1-started.json"]); expect(readFileSync(f.startedPath).equals(old)).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });
  it("通常CLIの専用modeが同じ計画を再資格し、以降のエラーもprivateへ残す", () => {
    const f = protocol(), old = readFileSync(f.startedPath), hook = join(f.root, "deny-fetch.mjs");
    writeFileSync(hook, "globalThis.fetch=async()=>{throw new Error('procedural transport denied; no native HTTP');};\n");
    expect(() => execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--import", hook,
      join(ROOT, "services/otakara-yutai/data-scripts/backfill-public-facts.ts"), "resume-upgrade-holding-v1-zero-native",
      f.sourcePath, f.directory, f.scopePath, f.proofPath], { cwd: f.root, stdio: "pipe", timeout: 10_000 })).toThrow();
    expect(readFileSync(f.startedPath).equals(old)).toBe(true); expect(existsSync(join(f.state, "upgrade-v1-zero-native-resume-started.json"))).toBe(true);
    const failures = readdirSync(f.directory).filter(n => n.startsWith("upgrade-failure-")); expect(failures).toHaveLength(1);
    expect(read(join(f.directory, failures[0]))).toMatchObject({ mode: "resume-upgrade-holding-v1-zero-native", error: { name: expect.any(String), message: expect.any(String) } });
    expect(existsSync(join(f.directory, "apply-started.json"))).toBe(false);
  });
});
