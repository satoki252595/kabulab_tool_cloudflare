/** Offline boundary controls: actual journal scan/shared CAS, mocked platform/env/kernel admission; no model or remote IO. */
import { chmodSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { assertClefJournalReady, createClefJournal, type ClefJournalInput } from "./clef-journal.js";
import { fencePublishingInitializationFromMac, withBiztagWriter } from "./runtime.js";
import { fenceUnconfirmedPublishingInitialization } from "../mechanical-publishing/shared-writer.js";
import { initializationMode } from "../mechanical-publishing/initialize.js";

const io = vi.hoisted(() => ({ directory: "", locked: false, gets: 0, puts: 0, version: 0, body: "", etag: "", order: [] as string[], fsyncActual: (_fd: number) => {} }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  io.fsyncActual = actual.fsyncSync;
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), realpathSync: (path: string) => path.endsWith("/.env") ? join(io.directory, ".env") : actual.realpathSync(path) };
});
vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
vi.mock("./env.js", () => ({ biztagLocalEnv: { acceptedRevision: () => "0".repeat(40) } }));
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual,
    execFileSync: (file: string, args: string[]) => {
      if (file === "which") return "/nix/store/offline-protocol-python/bin/python3.12\n";
      expect(file).toBe("git"); return args[0] === "rev-parse" ? "0".repeat(40) : "";
    },
    spawnSync: () => { io.locked = true; io.order.push("kernel-admitted"); return { status: 0, stdout: '{"locked":true}' }; },
  };
});
vi.mock("../mechanical-publishing/shared-writer.js", async original => {
  const actual = await original<typeof import("../mechanical-publishing/shared-writer.js")>();
  return { ...actual, fenceUnconfirmedPublishingInitialization: vi.fn<typeof actual.fenceUnconfirmedPublishingInitialization>(async () => { throw new Error("offline fence boundary"); }),
    withSharedPublishingWriter: (execute: () => Promise<unknown>) => actual.withSharedPublishingWriter(execute, {
    async get() { io.gets++; io.order.push("r2-get"); return { body: io.body, etag: io.etag }; },
    async put(_key, body, etag) { expect(etag).toBe(io.etag); io.puts++; io.body = body; io.etag = `version-${++io.version}`; },
  }) };
});
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!, arch = Object.getOwnPropertyDescriptor(process, "arch")!;
let state: string;
beforeEach(() => {
  io.directory = realpathSync(mkdtempSync(join(tmpdir(), "clef-pre-shared-control-")));
  writeFileSync(join(io.directory, ".env"), "# Offline environment admission control only\n", { mode: 0o600 });
  state = join(io.directory, "tmp/biztag-local"); mkdirSync(state, { recursive: true, mode: 0o700 });
  Object.assign(io, { locked: false, gets: 0, puts: 0, version: 0, etag: "initial", order: [],
    body: JSON.stringify({ version: 1, baselineSha256: "0".repeat(64), owner: null, pending: null }) + "\n" });
  Object.defineProperty(process, "platform", { value: "darwin" }); Object.defineProperty(process, "arch", { value: "arm64" });
  vi.mocked(fsyncSync).mockClear().mockImplementation(io.fsyncActual);
  vi.mocked(fenceUnconfirmedPublishingInitialization).mockClear().mockImplementation(async () => { throw new Error("offline fence boundary"); });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform); Object.defineProperty(process, "arch", arch);
  rmSync(io.directory, { recursive: true });
});
const check = (canonical: string) => {
  expect(io.locked).toBe(true); expect(canonical).toBe(state); io.order.push("clef-scan"); assertClefJournalReady(canonical);
};

it.each(["partial.json", "response-partial.raw", "unexpected-response.raw"])("known prior %s stops under the local lock before all shared IO and business", async name => {
  const directory = join(state, "clef-decisions/offline-protocol-control"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, name); writeFileSync(path, "offline protocol fault", { mode: 0o600 });
  const before = readFileSync(path), execute = vi.fn();
  await expect(withBiztagWriter(execute, false, check)).rejects.toThrow("prior unknown model output HOLD");
  expect(io.order).toEqual(["kernel-admitted", "clef-scan"]); expect(io.gets).toBe(0); expect(io.puts).toBe(0); expect(execute).not.toHaveBeenCalled();
  expect(readFileSync(path)).toEqual(before); expect(readdirSync(directory)).toEqual([name]);
  expect(JSON.parse(io.body)).toMatchObject({ owner: null, pending: null });
});

it("a previously closed real fixture passes the same scan and preserves normal shared entry/release without a new forward", async () => {
  const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/clef-native-1801-S100YDJC.json.gz", import.meta.url))).toString());
  const pins = { modelManifestSha256: sha(readFileSync(new URL("../../src/shared/clef/manifest.json", import.meta.url))),
    calibrationSha256: sha(readFileSync(new URL("../../services/yuho-quant/src/biztag/calibration.clef.json", import.meta.url))) };
  const input: ClefJournalInput = { stockCode: fixture.body.stockCode, periodEnd: fixture.body.fiscalYearEnd,
    receipt: { docId: fixture.body.docId, textPageId: fixture.body.textPageId, businessSha256: fixture.body.businessSha256,
      sectionsSha256: fixture.body.fourSectionSha256, stateSha256: fixture.source.inputSha256, vocabVersion: "v1", model: null },
    textsSha256: fixture.body.textsSha256, model: fixture.result.model, vocabHash: sha("offline vocabulary binding"), batchIndex: 0, state: fixture.request.state,
    questions: Object.fromEntries(fixture.request.questions.map((q: { qid: string; question: string; options: string[] }) => [q.qid, { instructions: q.question, criteria: { true: q.options[0], false: q.options[1] } }])) };
  const exchange = createClefJournal(state, pins)(input);
  exchange.beforeSend(Buffer.from(JSON.stringify({ ...fixture.request, id: "req-0" }) + "\n"));
  exchange.response(Buffer.from(JSON.stringify({ id: "req-0", answers: fixture.result.answers }) + "\n"), true); exchange.accepted(fixture.result);
  const directory = join(state, "clef-decisions", readdirSync(join(state, "clef-decisions"))[0]);
  const before = Object.fromEntries(readdirSync(directory).map(name => [name, sha(readFileSync(join(directory, name)))]));
  const execute = vi.fn(async () => "entered");
  await expect(withBiztagWriter(execute, false, check)).resolves.toBe("entered");
  expect(io.order.slice(0, 3)).toEqual(["kernel-admitted", "clef-scan", "r2-get"]); expect(execute).toHaveBeenCalledOnce();
  expect(io.puts).toBe(2); expect(JSON.parse(io.body)).toMatchObject({ owner: null, pending: null });
  expect(Object.fromEntries(readdirSync(directory).map(name => [name, sha(readFileSync(join(directory, name)))]))).toEqual(before);
});

it("preflight neither creates a model directory nor requires model configuration", () => {
  assertClefJournalReady(state); expect(existsSync(join(state, "clef-decisions"))).toBe(false);
  // Canonical state still must exist and be private; a replacement path is never created by the scanner.
  expect(() => assertClefJournalReady(join(io.directory, "absent"))).toThrow("ENOENT");
});

it("a generic writer without the tag callback retains its former path and does not inspect a model journal", async () => {
  const directory = join(state, "clef-decisions/offline-protocol-control"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "partial.json"), "offline protocol fault", { mode: 0o600 });
  await expect(withBiztagWriter(async () => "mechanical", true)).resolves.toBe("mechanical");
  expect(io.order).not.toContain("clef-scan"); expect(io.puts).toBe(2);
});

function failedMigrationLog() {
  // Existing canonical-directory qualification controls only, not a fabricated production migration.
  mkdirSync(join(state, "supplement-publications"), { mode: 0o700 });
  mkdirSync(join(io.directory, "tmp/yutai-local"), { mode: 0o700 });
  const path = join(state, "shared-publishing-initialize.log"), body = "[mechanical-publishing] initialization_stopped_no_retry\n";
  writeFileSync(path, body, { mode: 0o600 }); return { path, body, hash: sha(body) };
}
it("explicit fence fixes exact inputs durably before the shared helper and refuses a second attempt", async () => {
  const log = failedMigrationLog(), intentPath = join(state, "shared-publishing-initialization-fence.intent.json");
  vi.mocked(fenceUnconfirmedPublishingInitialization).mockImplementationOnce(async plan => {
    expect(io.locked).toBe(true); expect(vi.mocked(fsyncSync)).toHaveBeenCalledTimes(2);
    const intent = JSON.parse(readFileSync(intentPath, "utf8"));
    expect(intent).toMatchObject({ version: 1, failedLogSha256: log.hash, baselineSha256: sha(plan.baseline), plan });
    expect(statSync(intentPath).mode & 0o777).toBe(0o600); throw new Error("offline fence boundary");
  });
  await expect(fencePublishingInitializationFromMac(log.hash)).rejects.toThrow("offline fence boundary");
  const before = readFileSync(intentPath);
  await expect(fencePublishingInitializationFromMac(log.hash)).rejects.toThrow("EEXIST");
  expect(fenceUnconfirmedPublishingInitialization).toHaveBeenCalledOnce(); expect(readFileSync(intentPath)).toEqual(before);
  expect(readFileSync(log.path, "utf8")).toBe(log.body); expect(io.gets + io.puts).toBe(0);
});
it.each(["sha", "mode", "marker"])("invalid failed-log %s stops before intent or shared access", async kind => {
  const log = failedMigrationLog();
  if (kind === "mode") chmodSync(log.path, 0o644);
  if (kind === "marker") writeFileSync(log.path, "offline non-terminal log\n");
  await expect(fencePublishingInitializationFromMac(kind === "sha" ? "0".repeat(64) : sha(readFileSync(log.path)))).rejects.toThrow("失敗ログ");
  expect(fenceUnconfirmedPublishingInitialization).not.toHaveBeenCalled();
  expect(existsSync(join(state, "shared-publishing-initialization-fence.intent.json"))).toBe(false);
});
it.each([1, 2])("intent fsync failure at step %i preserves the intent without starting shared IO", async failAt => {
  const log = failedMigrationLog(); let syncs = 0;
  vi.mocked(fsyncSync).mockImplementation(fd => { if (++syncs === failAt) throw new Error("offline fsync failure"); io.fsyncActual(fd); });
  await expect(fencePublishingInitializationFromMac(log.hash)).rejects.toThrow("offline fsync failure");
  expect(existsSync(join(state, "shared-publishing-initialization-fence.intent.json"))).toBe(true);
  expect(fenceUnconfirmedPublishingInitialization).not.toHaveBeenCalled(); expect(io.gets + io.puts).toBe(0);
});
it("normal initialization and SHA-bound fence are separate explicit CLI modes", () => {
  expect(initializationMode(["--initialize-from-accepted-mac"])).toEqual({ kind: "normal" });
  expect(initializationMode(["--fence-unconfirmed-initialization", `--failed-log-sha256=${"a".repeat(64)}`])).toEqual({ kind: "fence", failedLogSha256: "a".repeat(64) });
  for (const args of [[], ["--fence-unconfirmed-initialization"], ["--initialize-from-accepted-mac", "--fence-unconfirmed-initialization"],
    ["--fence-unconfirmed-initialization", "--failed-log-sha256=invalid"], ["--initialize-from-accepted-mac", "--unknown"]]) expect(() => initializationMode(args)).toThrow();
});
