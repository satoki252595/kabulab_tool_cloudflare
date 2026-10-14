/** Explicit fixed-snapshot first activation. prepare is offline; apply requires exact reviewed plan SHA. */
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { priceSnapshotSchema, type PriceSnapshot } from "../../src/shared/holdings/price-registry.js";
import { bootstrapPriceSnapshot } from "../vwap/lib/holdings-price-registry.js";
import { readHoldingPriceFile } from "./holdings-price-sources.js";
import { HoldingsPriceIndex, parseHoldingsCodeList } from "../../services/yuho-quant/src/services/edinet/shareholdings-valuation.js";
import { jstDateSec } from "../../src/shared/vwap/proof.js";
import { sharedEnv } from "../../src/shared/env.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const sourcePaths = ["scripts/sync/bootstrap-holdings-price.ts", "scripts/sync/holdings-price-sources.ts", "scripts/vwap/lib/holdings-price-registry.ts",
  "scripts/vwap/lib/r2.ts", "src/shared/holdings/price-registry.ts", "scripts/moneyflow/lib/archived-files.ts", "src/shared/notion-archive/client.ts",
  "src/shared/notion-archive/env.ts", "src/shared/env.ts", "services/yuho-quant/src/services/edinet/shareholdings-valuation.ts",
  "services/yuho-quant/src/services/edinet/zip.ts", "services/yuho-quant/src/services/edinet/csv.ts", "src/shared/yahoo/client.ts", "src/shared/vwap/proof.ts", "package.json", "pnpm-lock.yaml"];
const pins = () => {
  const paths = new Set(sourcePaths), pending = [...paths];
  for (let i = 0; i < pending.length; i++) {
    const path = pending[i];
    if (!path.endsWith(".ts")) continue;
    for (const match of readFileSync(resolve(root, path), "utf8").matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.[^"']+)["']/g)) {
      const target = resolve(root, dirname(path), match[1].replace(/\.js$/, ".ts"));
      const name = relative(root, target); assert.ok(!name.startsWith("../"));
      if (!paths.has(name)) { paths.add(name); pending.push(name); }
    }
  }
  return Object.fromEntries([...paths].sort().map(path => [path, hash(readFileSync(resolve(root, path)))]));
};
function durable(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600, flush: true });
  const fd = openSync(dirname(path), "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
const fileKey = (ref: PriceSnapshot["members"][string]) => `${ref.file.archivePageId}/${ref.file.filename}/${ref.file.sha256}`;
export function assertFixedBootstrap(value: unknown): PriceSnapshot {
  const snapshot = priceSnapshotSchema.parse(value), members = Object.values(snapshot.members);
  assert.equal(snapshot.snapshotId, "37202207552.1"); assert.equal(snapshot.sessionDate, "2026-10-02");
  assert.equal(members.length, 3456); assert.equal(new Set(members.map(fileKey)).size, 116);
  assert.ok(members.every(ref => Date.parse(ref.receivedAt) >= Date.parse("2026-10-04T12:28:34.484Z") && Date.parse(ref.receivedAt) <= Date.parse("2026-10-04T13:53:00.889Z")));
  const unique = new Map(members.map(ref => [fileKey(ref), ref.file]));
  assert.equal([...unique.values()].reduce((sum, file) => sum + file.byteLength, 0), 173188326);
  assert.equal(snapshot.codeList.filename, "Edinetcode-20261014.zip");
  assert.equal(snapshot.codeList.archivePageId, "3f8d74ff-84cd-8188-9724-c64cf81e15e8");
  assert.equal(snapshot.codeList.sha256, "f65840ce54b4817583d02669cfbba8cbabf66d2225400a6ec0ee890450b86b0b");
  return snapshot;
}

/** All fixed chunks, not just a favorable subset. Original gzip is never rewritten. */
export async function verifyFixedBootstrapSources(snapshot: PriceSnapshot, read: typeof readHoldingPriceFile,
  onVerified: (proof: Record<string, unknown>) => void): Promise<void> {
  assertFixedBootstrap(snapshot);
  const codeList = await read(snapshot.codeList); parseHoldingsCodeList(codeList);
  onVerified({ kind: "code-list", pageId: codeList.archivePageId, sha256: codeList.sha256, bytes: codeList.bytes.length });
  const groups = new Map<string, Array<PriceSnapshot["members"][string]>>();
  for (const member of Object.values(snapshot.members)) {
    const key = fileKey(member), group = groups.get(key);
    if (group === undefined) groups.set(key, [member]); else group.push(member);
  }
  let verified = 0;
  for (const members of groups.values()) {
    const saved = await read(members[0].file);
    const priceMembers = Object.fromEntries(members.map(ref => [ref.symbol, { bodySha256: ref.bodySha256, bodyBytes: ref.bodyBytes, receivedAt: ref.receivedAt }]));
    const index = new HoldingsPriceIndex([{ ...saved, priceMembers }]);
    for (const member of members) {
      const candidates = index.candidates(member.symbol); assert.equal(candidates.length, 1);
      const { parsed } = await index.verifiedChart(candidates[0], member.symbol);
      assert.equal(parsed.proof.requestedRange, "10y"); assert.equal(parsed.proof.observedAt, member.receivedAt); assert.equal(parsed.proof.rawSha, member.bodySha256);
      assert.ok(parsed.proof.lastTs !== null); assert.equal(jstDateSec(parsed.proof.lastTs), snapshot.sessionDate);
    }
    verified += members.length;
    onVerified({ kind: "price-chunk", pageId: saved.archivePageId, filename: saved.filename, sha256: saved.sha256,
      bytes: saved.bytes.length, members: members.length, totalVerified: verified, lastSourceSession: snapshot.sessionDate });
  }
  assert.equal(verified, 3456);
}

async function main() {
  const args = new Map(process.argv.slice(2).map(arg => { assert.match(arg, /^--[a-z-]+=[^\n]+$/); const at = arg.indexOf("="); return [arg.slice(2, at), arg.slice(at + 1)]; }));
  assert.equal(args.size, process.argv.length - 2, "重複CLI引数は受け入れません");
  assert.ok([...args.keys()].every(key => ["mode", "candidate", "out", "approved-plan-sha"].includes(key)));
  const mode = args.get("mode"), outArg = args.get("out"); assert.ok(mode === "prepare" || mode === "apply"); assert.ok(outArg);
  const out = resolve(outArg), planPath = resolve(out, "plan.json");
  if (mode === "prepare") {
    const candidate = args.get("candidate"); assert.ok(candidate); assert.equal(args.has("approved-plan-sha"), false);
    const bytes = readFileSync(resolve(candidate)), snapshot = assertFixedBootstrap(JSON.parse(bytes.toString("utf8")));
    mkdirSync(out, { mode: 0o700 });
    writeFileSync(resolve(out, "candidate.json"), bytes, { flag: "wx", mode: 0o600, flush: true });
    durable(planPath, { version: 1, status: "NOT_ACTIVATED", candidateSHA: hash(bytes), sourcePins: pins(), preparedAt: new Date().toISOString(),
      snapshotId: snapshot.snapshotId, sourceSession: snapshot.sessionDate, sourceCaptureDate: "2026-10-04", files: 116, symbols: 3456,
      maxNativeReads: 117, maxHostedReads: 117, maxBytes: 256 * 1024 * 1024, maxSeconds: 1200, minSpacingMs: 2000,
      sourceGETs: 0, modelCalls: 0, businessWrites: 0, rawUploads: 0 });
    console.info(JSON.stringify({ status: "NOT_ACTIVATED", planSHA: hash(readFileSync(planPath)), sourceSession: snapshot.sessionDate }));
    return;
  }
  assert.equal(args.has("candidate"), false);
  assert.match(args.get("approved-plan-sha") ?? "", /^[a-f0-9]{64}$/);
  const planBytes = readFileSync(planPath); assert.equal(hash(planBytes), args.get("approved-plan-sha"));
  const plan = JSON.parse(planBytes.toString("utf8")); assert.equal(plan.version, 1); assert.equal(plan.status, "NOT_ACTIVATED");
  assert.equal(plan.maxNativeReads, 117); assert.equal(plan.maxHostedReads, 117); assert.equal(plan.maxBytes, 256 * 1024 * 1024);
  assert.equal(plan.maxSeconds, 1200); assert.equal(plan.minSpacingMs, 2000);
  assert.deepEqual(pins(), plan.sourcePins); assert.equal(sharedEnv.LOCAL_OUT(), undefined, "previewは本番activationとして受け入れません");
  const accepted = execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], { cwd: root, encoding: "utf8" }).trim();
  for (const [path, digest] of Object.entries(plan.sourcePins)) {
    assert.equal(hash(execFileSync("git", ["show", `${accepted}:${path}`], { cwd: root })), digest, "CI/main受入byteと実行byteが一致しません");
  }
  const candidateBytes = readFileSync(resolve(out, "candidate.json")); assert.equal(hash(candidateBytes), plan.candidateSHA);
  const snapshot = assertFixedBootstrap(JSON.parse(candidateBytes.toString("utf8")));
  durable(resolve(out, "attempt.json"), { planSHA: hash(planBytes), candidateSHA: plan.candidateSHA, acceptedMainSHA: accepted, startedAt: new Date().toISOString(), noReplay: true });
  const started = Date.now(); let lastRead = 0, reads = 0, bytes = 0;
  const journalPath = resolve(out, "source-verified.jsonl");
  writeFileSync(journalPath, "", { flag: "wx", mode: 0o600, flush: true });
  try {
    await bootstrapPriceSnapshot(snapshot, async () => {
      await verifyFixedBootstrapSources(snapshot, async file => {
        assert.ok(Date.now() - started < plan.maxSeconds * 1000 && reads < plan.maxNativeReads && bytes + file.byteLength <= plan.maxBytes, "bootstrap読取予算超過");
        const wait = plan.minSpacingMs - (Date.now() - lastRead); if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        lastRead = Date.now(); reads++; bytes += file.byteLength;
        return readHoldingPriceFile(file);
      }, proof => appendFileSync(journalPath, `${JSON.stringify(proof)}\n`, { flush: true }));
      assert.ok(Date.now() - started < plan.maxSeconds * 1000, "bootstrap時間予算超過");
    });
    durable(resolve(out, "complete.json"), { status: "ACTIVATED_OLD_20261002_SOURCE", snapshotId: snapshot.snapshotId, sourceSession: snapshot.sessionDate,
      nativeReads: reads, hostedReads: reads, bytes, elapsedSeconds: (Date.now() - started) / 1000, sourceGETs: 0, modelCalls: 0, businessWrites: 0, rawUploads: 0 });
    console.info(JSON.stringify({ status: "ACTIVATED_OLD_20261002_SOURCE", nativeReads: reads, bytes }));
  } catch (error) {
    durable(resolve(out, "STOP.json"), { status: "STOP_NO_REPLAY", errorClass: error instanceof Error ? error.name : typeof error,
      errorSHA: hash(error instanceof Error ? error.message : String(error)), nativeReadsStarted: reads, bytesReserved: bytes, noReplay: true });
    throw error;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(JSON.stringify({ status: "STOP_NO_REPLAY", errorClass: error instanceof Error ? error.name : typeof error })); process.exitCode = 1; }
}
