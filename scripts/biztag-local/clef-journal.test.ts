/** Real saved Clef values; all filesystem/protocol faults are isolated offline controls. */
import { createHash } from "node:crypto";
import { existsSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClefJournal, type ClefJournalInput } from "./clef-journal.js";
import { createClefClient } from "../../src/shared/clef/client.js";
import { vocabularyHash } from "../../services/yuho-quant/src/biztag/vocabulary/hash.js";

vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});
const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/clef-native-1801-S100YDJC.json.gz", import.meta.url))).toString());
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const pins = { modelManifestSha256: sha(readFileSync(new URL("../../src/shared/clef/manifest.json", import.meta.url))),
  calibrationSha256: sha(readFileSync(new URL("../../services/yuho-quant/src/biztag/calibration.clef.json", import.meta.url))) };
const input: ClefJournalInput = { stockCode: fixture.body.stockCode, periodEnd: fixture.body.fiscalYearEnd,
  receipt: { docId: fixture.body.docId, textPageId: fixture.body.textPageId, businessSha256: fixture.body.businessSha256,
    sectionsSha256: fixture.body.fourSectionSha256, stateSha256: fixture.source.inputSha256, vocabVersion: "v1", model: null },
  textsSha256: fixture.body.textsSha256, model: fixture.result.model,
  vocabHash: await vocabularyHash(JSON.parse(readFileSync(new URL("../../services/yuho-quant/src/biztag/vocabulary/v1.json", import.meta.url), "utf8"))),
  batchIndex: 0, state: fixture.request.state,
  questions: Object.fromEntries(fixture.request.questions.map((q: { qid: string; question: string; options: string[] }) => [q.qid, { instructions: q.question, criteria: { true: q.options[0], false: q.options[1] } }])) };
// This wire is deliberately reconstructed for protocol testing; actual numeric answers are unchanged.
const request = Buffer.from(JSON.stringify({ ...fixture.request, id: "req-0" }) + "\n");
const response = Buffer.from(JSON.stringify({ id: "req-0", answers: fixture.result.answers }) + "\n");
const temporary: string[] = [];
function state(): string { const p = mkdtempSync(join(tmpdir(), "clef-journal-")); temporary.push(p); return p; }
function directory(root: string): string { return join(root, "clef-decisions", readdirSync(join(root, "clef-decisions"))[0]); }
afterEach(() => { vi.mocked(fsyncSync).mockClear(); for (const p of temporary.splice(0)) rmSync(p, { recursive: true, force: true }); });

describe("normal Clef durable output", () => {
  it("stores exact full request/response privately before acceptance; complete saved output reuses without spawn", async () => {
    const root = state(), journal = createClefJournal(root, pins), exchange = journal(input);
    exchange.beforeSend(request); exchange.response(response, true); exchange.accepted(fixture.result);
    expect(Number.isFinite(Date.parse(exchange.decidedAt!))).toBe(true);
    const d = directory(root);
    expect(readFileSync(join(d, "request.raw"))).toEqual(request); expect(readFileSync(join(d, "response.raw"))).toEqual(response);
    for (const file of readdirSync(d)) expect(statSync(join(d, file)).mode & 0o777).toBe(0o600);
    expect(statSync(d).mode & 0o777).toBe(0o700);
    const spawnFn = vi.fn(() => { throw new Error("saved output must never start a model"); });
    const client = createClefClient({ pythonBin: "/offline-control/python", modelPath: "/offline-control/clef", spawnFn });
    const saved = createClefJournal(root, pins)(input);
    expect(saved.decidedAt).toBe(exchange.decidedAt);
    const replay = await client.askNoul(input.state, input.questions, saved);
    expect(replay).toEqual({ ...fixture.result, reused: true }); expect(spawnFn).not.toHaveBeenCalled(); client.close();
  });
  it("uncompleted intent stays immutable and prevents this run's next batch", () => {
    const root = state(), first = createClefJournal(root, pins)(input); first.beforeSend(request);
    const before = readFileSync(join(directory(root), "request.raw"));
    const resumed = createClefJournal(root, pins);
    expect(() => resumed(input)).toThrow(); expect(() => resumed({ ...input, batchIndex: 1 })).toThrow("sticky STOP");
    expect(readFileSync(join(directory(root), "request.raw"))).toEqual(before);
    // A new normal run must not forward for an unrelated stock before encountering this latch.
    expect(() => createClefJournal(root, pins)({ ...input, stockCode: "OFFLINE_OTHER_STOCK_CONTROL" })).toThrow();
  });
  it("partial response is explicitly incomplete and never eligible for replay", () => {
    const root = state(), exchange = createClefJournal(root, pins)(input); exchange.beforeSend(request);
    const partial = response.subarray(0, response.length - 5); exchange.response(partial, false);
    const d = directory(root); expect(readFileSync(join(d, "response-partial.raw"))).toEqual(partial);
    expect(JSON.parse(readFileSync(join(d, "partial.json"), "utf8"))).toMatchObject({ complete: false, truncated: false, noReplay: true });
    expect(() => exchange.accepted(fixture.result)).toThrow(); expect(() => createClefJournal(root, pins)(input)).toThrow();
    expect(existsSync(join(d, "accepted.json"))).toBe(false);
  });
  it("response fsync failure preserves raw bytes but no accepted marker; later forward stays stopped", () => {
    const root = state(), journal = createClefJournal(root, pins), exchange = journal(input); exchange.beforeSend(request);
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error("offline fsync fault after file write"); });
    expect(() => exchange.response(response, true)).toThrow("fsync fault");
    expect(readFileSync(join(directory(root), "response.raw"))).toEqual(response);
    expect(() => exchange.accepted(fixture.result)).toThrow(); expect(() => journal({ ...input, batchIndex: 1 })).toThrow("sticky STOP");
    expect(() => createClefJournal(root, pins)(input)).toThrow();
  });
  it("a partial raw fsync failure after acceptance blocks same-key reuse and other stocks across runs", () => {
    const root = state(), journal = createClefJournal(root, pins), exchange = journal(input);
    exchange.beforeSend(request); exchange.response(response, true); exchange.accepted(fixture.result);
    const d = directory(root), accepted = readFileSync(join(d, "accepted.json"));
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error("offline partial raw fsync fault"); });
    expect(() => exchange.response(response.subarray(0, 10), false)).toThrow("fsync fault");
    expect(existsSync(join(d, "response-partial.raw"))).toBe(true); expect(existsSync(join(d, "partial.json"))).toBe(false);
    expect(() => journal(input)).toThrow("sticky STOP");
    expect(() => createClefJournal(root, pins)(input)).toThrow("unknown model output");
    expect(() => createClefJournal(root, pins)({ ...input, stockCode: "OFFLINE_OTHER_STOCK_CONTROL" })).toThrow("unknown model output");
    expect(readFileSync(join(d, "accepted.json"))).toEqual(accepted); expect(readdirSync(join(root, "clef-decisions"))).toHaveLength(1);
  });
  it.each(["state", "questions", "textsSha256", "vocabHash", "model", "modelManifestSha256", "calibrationSha256"])("%s mismatch never creates another forward latch", key => {
    const root = state(), exchange = createClefJournal(root, pins)(input); exchange.beforeSend(request); exchange.response(response, true); exchange.accepted(fixture.result);
    const changed = structuredClone(input), changedPins = { ...pins };
    if (key === "state") { changed.state += "\n"; changed.receipt.stateSha256 = sha(changed.state); }
    else if (key === "questions") changed.questions[Object.keys(changed.questions)[0]].instructions += "\n";
    else if (key === "modelManifestSha256") changedPins.modelManifestSha256 = pins.calibrationSha256;
    else if (key === "calibrationSha256") changedPins.calibrationSha256 = pins.modelManifestSha256;
    else if (key === "textsSha256") changed.textsSha256 = pins.modelManifestSha256;
    else if (key === "vocabHash") changed.vocabHash = pins.modelManifestSha256;
    else changed.model = "OFFLINE_INVALID_MODEL_CONTROL";
    expect(() => createClefJournal(root, changedPins)(changed)).toThrow("differs");
    expect(readdirSync(join(root, "clef-decisions"))).toHaveLength(1);
  });
  it("raw hash or qid corruption is not substituted by the accepted JSON", () => {
    const root = state(), exchange = createClefJournal(root, pins)(input); exchange.beforeSend(request); exchange.response(response, true); exchange.accepted(fixture.result);
    const bad = { ...fixture.result.answers }; delete bad[Object.keys(bad)[0]];
    writeFileSync(join(directory(root), "response.raw"), JSON.stringify({ id: "req-0", answers: bad }) + "\n");
    expect(() => createClefJournal(root, pins)(input)).toThrow();
  });
  it("existing storage budget rejects before a new intent, and preserves old artifacts", () => {
    const root = state(), old = join(root, "clef-decisions", "offline-budget-control"); mkdirSync(old, { recursive: true, mode: 0o700 });
    const path = join(old, "old.raw"); writeFileSync(path, "", { mode: 0o600 }); truncateSync(path, 1024 ** 3 + 1);
    const journal = createClefJournal(root, pins); expect(() => journal(input)).toThrow("storage full");
    expect(() => journal({ ...input, batchIndex: 1 })).toThrow("sticky STOP");
    expect(statSync(path).size).toBe(1024 ** 3 + 1); expect(readdirSync(join(root, "clef-decisions"))).toEqual(["offline-budget-control"]);
  });
});
