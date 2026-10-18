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
import { claimHoldingUpgradeReadOnlyStop, claimHoldingUpgradeZeroNative, claimPublicFactsUpgrade, parsePublicFactsHoldingUpgradeScope,
  planPublicFactsV1HoldingUpgrade, publicFactsUpgradeFilename, qualifyHoldingUpgradeReadOnlyStop, qualifyHoldingUpgradeZeroNative } from "../../data-scripts/backfill-public-facts.js";
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

/** 完全に手順専用のREAD packet。実Notion応答・本番データを装わない。 */
function readOnlyProtocol() {
  const f = protocol(); claimHoldingUpgradeZeroNative(f.state, f.directory, f.manifest, f.proofPath);
  const sidecarPath = join(f.state, "upgrade-v1-zero-native-resume-started.json"), at = Date.parse(read(sidecarPath).at),
    clock = (n: number) => new Date(at + n).toISOString(), attemptDir = join(f.root, "read-attempt"); mkdirSync(attemptDir, { mode: 0o700 });
  const priorObserver = write(join(f.root, "read-observer.json"), { proceduralReadOnly: true });
  const release = write(join(f.root, "read-release.json"), { status: "ROOT_RELEASED_NORMAL_HOLDING4_ZERO_NATIVE_RESUME_ONCE", codeRoot: f.root,
    sourceHead: "14ce552846fca288d4f4890a84f1f4afbaad48e9", wrapperSha256: sha(readFileSync(priorObserver)),
    qualificationSha256: sha(readFileSync(f.proofPath)), originalStartedSha256: sha(readFileSync(f.startedPath)) });
  const request = Buffer.from(JSON.stringify({ query: "一次データ｜otakara-yutai", filter: { property: "object", value: "database" }, page_size: 100 })),
    response = Buffer.from(JSON.stringify({ object: "list", results: [], has_more: false, next_cursor: null }));
  writeFileSync(join(attemptDir, "request-1.body"), request); writeFileSync(join(attemptDir, "response-1.body"), response);
  write(join(attemptDir, "attempt-once.json"), { at: clock(-1), sourceAPI: 0, models: 0, unknownResend: false, releaseSha256: sha(readFileSync(release)),
    sourceHead: read(release).sourceHead, codeRoot: f.root, sourcePins: { "read-observer.json": sha(readFileSync(priorObserver)) }, originalPins: f.proof.pins,
    qualificationSha256: sha(readFileSync(f.proofPath)), originalStartedSha256: sha(readFileSync(f.startedPath)) });
  write(join(attemptDir, "intent-1.json"), { at: clock(1), kind: "notion", method: "POST", path: "/v1/search", urlSha256: sha("https://api.notion.com/v1/search"), resend: 0, bytes: request.length, sha256: sha(request) });
  write(join(attemptDir, "response-1.json"), { at: clock(2), kind: "notion", status: 200, bytes: response.length, sha256: sha(response) });
  const counters = { seq: 1, notion: 1, hosted: 0, d1Read: 0, d1Batch: 0, responseBytes: response.length, observedResponseBytes: response.length };
  write(join(attemptDir, "NATIVE-STOP-0.json"), { at: clock(3), ...counters, name: "AssertionError", resend: 0 });
  write(join(attemptDir, "STOP.json"), { at: clock(4), ...counters, unknownResend: false });
  const qualification = { version: 1, kind: "holding-upgrade-single-read-stop", allOwnedProcessesTerminal: true, zeroNativeQualificationPath: f.proofPath,
    priorAttemptDir: attemptDir, priorReleasePath: release, priorObserverPath: priorObserver, priorSourceHead: read(release).sourceHead,
    pins: { ...f.proof.pins, ...Object.fromEntries([f.proofPath, sidecarPath, release, priorObserver, ...readdirSync(attemptDir).map(n => join(attemptDir, n))].map(p => [p, sha(readFileSync(p))])) } };
  const qualificationPath = write(join(f.root, "read-qualification.json"), qualification);
  return { ...f, sidecarPath, qualification, qualificationPath, priorAttemptDir: attemptDir };
}

describe("holding明示search READ1停止の一度再資格", () => {
  it("旧2intentを保持し、READ1全文ACK・全pinsだけ新sidecarへ束縛する", () => {
    const f = readOnlyProtocol(), old = readFileSync(f.startedPath), oldResume = readFileSync(f.sidecarPath), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(qualifyHoldingUpgradeReadOnlyStop(f.state, f.directory, f.manifest, f.qualificationPath)).toMatchObject({ priorReadRequests: 1, priorArchiveMutations: 0, priorD1Requests: 0 });
    claimHoldingUpgradeReadOnlyStop(f.state, f.directory, f.manifest, f.qualificationPath);
    expect(readFileSync(f.startedPath).equals(old)).toBe(true); expect(readFileSync(f.sidecarPath).equals(oldResume)).toBe(true);
    expect(readdirSync(f.state).sort()).toEqual(["upgrade-v1-read-only-resume-started.json", "upgrade-v1-started.json", "upgrade-v1-zero-native-resume-started.json"]);
    expect(() => claimHoldingUpgradeReadOnlyStop(f.state, f.directory, f.manifest, f.qualificationPath)).toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["extra-native", "mutation", "d1", "ack", "response-drift", "request-route", "new-directory", "old-sidecar", "missing-pin", "unclosed"])("%sをclaim/HTTP前に拒否する", kind => {
    const f = readOnlyProtocol(), fetch = vi.fn(); vi.stubGlobal("fetch", fetch); let directory = f.directory;
    const change = (path: string, value: unknown) => { write(path, value); f.qualification.pins[path] = sha(readFileSync(path)); };
    const stop = join(f.priorAttemptDir, "STOP.json"), response = join(f.priorAttemptDir, "response-1.json"), intent = join(f.priorAttemptDir, "intent-1.json");
    if (kind === "extra-native") write(join(f.priorAttemptDir, "intent-2.json"), { procedural: true });
    if (kind === "mutation") change(stop, { ...read(stop), notion: 2 });
    if (kind === "d1") change(stop, { ...read(stop), d1Batch: 1 });
    if (kind === "ack") change(response, { ...read(response), status: 500 });
    if (kind === "response-drift") write(join(f.priorAttemptDir, "response-1.body"), { changed: true });
    if (kind === "request-route") change(intent, { ...read(intent), path: "/v1/pages" });
    if (kind === "new-directory") { directory = join(f.root, "different"); mkdirSync(directory); }
    if (kind === "old-sidecar") change(f.sidecarPath, { ...read(f.sidecarPath), originalStartedSha256: "0".repeat(64) });
    if (kind === "missing-pin") delete f.qualification.pins[f.sidecarPath];
    if (kind === "unclosed") f.qualification.allOwnedProcessesTerminal = false;
    write(f.qualificationPath, f.qualification);
    expect(() => claimHoldingUpgradeReadOnlyStop(f.state, directory, f.manifest, f.qualificationPath)).toThrow();
    expect(existsSync(join(f.state, "upgrade-v1-read-only-resume-started.json"))).toBe(false); expect(fetch).not.toHaveBeenCalled();
  });
  it("通常CLI新modeだけ同じ計画へ進み、再開後エラーもprivateへ保持する", () => {
    const f = readOnlyProtocol(), old = readFileSync(f.startedPath), oldResume = readFileSync(f.sidecarPath), hook = join(f.root, "deny-fetch.mjs");
    writeFileSync(hook, "globalThis.fetch=async()=>{throw new Error('procedural transport denied; no native HTTP');};\n");
    expect(() => execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--import", hook,
      join(ROOT, "services/otakara-yutai/data-scripts/backfill-public-facts.ts"), "resume-upgrade-holding-v1-read-only-stop",
      f.sourcePath, f.directory, f.scopePath, f.qualificationPath], { cwd: f.root, env: { PATH: process.env.PATH, NODE_ENV: "test" }, stdio: "pipe", timeout: 10_000 })).toThrow();
    expect(readFileSync(f.startedPath).equals(old)).toBe(true); expect(readFileSync(f.sidecarPath).equals(oldResume)).toBe(true);
    expect(existsSync(join(f.state, "upgrade-v1-read-only-resume-started.json"))).toBe(true);
    const failure = readdirSync(f.directory).find(n => n.startsWith("upgrade-failure-")); expect(failure).toBeDefined();
    expect(read(join(f.directory, failure!)).mode).toBe("resume-upgrade-holding-v1-read-only-stop");
    expect(existsSync(join(f.directory, "apply-started.json"))).toBe(false);
  });
});

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
      f.sourcePath, f.directory, f.scopePath, f.proofPath], { cwd: f.root, env: { PATH: process.env.PATH, NODE_ENV: "test" }, stdio: "pipe", timeout: 10_000 })).toThrow();
    expect(readFileSync(f.startedPath).equals(old)).toBe(true); expect(existsSync(join(f.state, "upgrade-v1-zero-native-resume-started.json"))).toBe(true);
    const failures = readdirSync(f.directory).filter(n => n.startsWith("upgrade-failure-")); expect(failures).toHaveLength(1);
    expect(read(join(f.directory, failures[0]))).toMatchObject({ mode: "resume-upgrade-holding-v1-zero-native", error: { name: expect.any(String), message: expect.any(String) } });
    expect(existsSync(join(f.directory, "apply-started.json"))).toBe(false);
  });
});
