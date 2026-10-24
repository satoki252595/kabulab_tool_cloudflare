/** Normal Mac biztag only. Immutable, bounded local model inputs/raw outputs; no network. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { JevAskResult, JevNoulQuestion } from "../../src/shared/jev/client.js";
import type { LocalDecisionExchange } from "../../src/shared/semif/client.js";
import type { InputReceipt } from "../../services/yuho-quant/src/biztag/plan.js";
import { canonicalJson } from "../../services/yuho-quant/src/biztag/vocabulary/hash.js";
import { validateClefContextQualification, type ClefContextQualification } from "../../src/shared/clef/client.js";

export interface ClefJournalInput {
  stockCode: string; periodEnd: string; receipt: InputReceipt; textsSha256: string;
  model: string; vocabHash: string; batchIndex: number;
  state: string; questions: Record<string, JevNoulQuestion>;
}
const FILE_MAX = 1024 * 1024, RUN_MAX = 64 * FILE_MAX, STORE_MAX = 1024 * FILE_MAX;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
type Pins = { modelManifestSha256: string; calibrationSha256: string };
interface ContextRecipe { oldKey: string; oldHashes: Record<string, string>; qualification: ClefContextQualification }
export interface ClefContextUpgrade {
  stockCode: string; oldKey: string; previousCalibrationSha256: string;
  qualify: (request: Uint8Array) => ClefContextQualification;
}
function journalKey(input: Record<string, unknown>): string {
  const receipt = input.receipt as InputReceipt;
  const base = { stockCode: input.stockCode, docId: receipt.docId, sectionsSha256: receipt.sectionsSha256, batchIndex: input.batchIndex };
  // One context admission per original rejection. Recipe drift must hit the same latch and HOLD.
  return sha(canonicalJson(input.contextUpgrade === undefined ? base : { ...base,
    contextUpgrade: { oldKey: (input.contextUpgrade as ContextRecipe).oldKey } }));
}
export function syncParent(path: string): void {
  const fd = openSync(dirname(path), "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function privatePath(path: string, directory: boolean): void {
  const s = lstatSync(path);
  assert(directory ? s.isDirectory() : s.isFile(), "journal path type/symlink HOLD");
  assert.equal(s.mode & 0o077, 0, "journal permissions HOLD");
  assert.equal(s.uid, process.getuid?.(), "journal owner HOLD");
}
function jsonLine(raw: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as Record<string, unknown>;
}
function answers(value: unknown, qids: string[]): Record<string, number> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  const record = value as Record<string, number>;
  assert.deepEqual(Object.keys(record).sort(), [...qids].sort());
  assert(Object.values(record).every(p => typeof p === "number" && Number.isFinite(p) && p >= 0 && p <= 1));
  return record;
}

/** Explicit operator ACK of a complete error, never an accepted judgment or a retry permit. */
function rejectedInput(directory: string): Record<string, string> {
  privatePath(directory, true);
  assert.deepEqual(readdirSync(directory).filter(name => name !== "rejected.json").sort(),
    ["input.json", "intent.json", "request.raw", "response.raw", "send.json"]);
  const hashes: Record<string, string> = {}, values: Record<string, Record<string, unknown>> = {};
  for (const name of ["input.json", "intent.json", "request.raw", "response.raw", "send.json"]) {
    const path = join(directory, name); privatePath(path, false);
    assert(lstatSync(path).size <= FILE_MAX, "rejected journal file size HOLD");
    const raw = readFileSync(path); hashes[name] = sha(raw); values[name] = jsonLine(raw);
  }
  const input = values["input.json"], request = values["request.raw"], response = values["response.raw"];
  const receipt = input.receipt as InputReceipt;
  assert.equal(basename(dirname(directory)), "clef-decisions");
  assert.equal(basename(directory), journalKey(input));
  assert.equal(typeof request.id, "string"); assert.match(request.id as string, /^req-[0-9]+$/);
  assert.deepEqual(Object.keys(response).sort(), ["error", "id"]);
  assert.equal(response.id, request.id);
  assert(["clef_contract_or_runtime_error", "clef_input_token_limit"].includes(response.error as string));
  assert.equal(canonicalJson({ state: request.state, questions: request.questions }),
    canonicalJson({ state: input.state, questions: input.questions }));
  assert.equal(typeof input.state, "string"); assert.equal(sha(input.state as string), receipt.stateSha256);
  assert.equal(values["intent.json"].inputSha256, hashes["input.json"]);
  assert.equal(values["send.json"].requestSha256, hashes["request.raw"]);
  const clocks = [values["intent.json"].at, values["send.json"].at].map(value => {
    assert.equal(typeof value, "string"); const at = Date.parse(value as string); assert(Number.isFinite(at)); return at;
  });
  assert(clocks[0] <= clocks[1] && clocks[1] <= Date.now(), "rejected journal clock HOLD");
  return hashes;
}

function readJournalFile(path: string): Buffer {
  privatePath(path, false); assert(lstatSync(path).size <= FILE_MAX, "journal file size HOLD"); return readFileSync(path);
}
const incomplete = (directory: string) => ["response-partial.raw", "partial.json", "unexpected-response.raw"].some(name => existsSync(join(directory, name)));
/** The same bounded scan used before a forward. No directory creation, writes, fsync, model or configuration reads. */
function inspectClefJournal(state: string) {
  privatePath(state, true);
  const root = join(state, "clef-decisions"), rejected: Array<{ directory: string; hashes: Record<string, string> }> = [];
  if (!existsSync(root)) return { stored: 0, rejected };
  privatePath(root, true);
  const directories = readdirSync(root).map(entry => join(root, entry));
  let stored = 0;
  for (const directory of directories) {
    privatePath(directory, true);
    for (const name of readdirSync(directory)) { const path = join(directory, name); privatePath(path, false); stored += lstatSync(path).size; }
  }
  assert(stored <= STORE_MAX, "journal storage full; preserve old evidence and HOLD");
  for (const directory of directories) {
    assert(!incomplete(directory), "prior unknown model output HOLD");
    if (existsSync(join(directory, "rejected.json"))) {
      const marker = jsonLine(readJournalFile(join(directory, "rejected.json")));
      assert.equal(marker.noReinference, true);
      assert.equal(typeof marker.at, "string"); assert(Number.isFinite(Date.parse(marker.at as string)));
      const hashes = rejectedInput(directory); assert.deepEqual(marker.hashes, hashes);
      rejected.push({ directory, hashes });
    } else {
      const accepted = jsonLine(readJournalFile(join(directory, "accepted.json")));
      for (const name of ["input.json", "intent.json", "request.raw", "send.json", "response.raw"]) privatePath(join(directory, name), false);
      for (const name of ["inputSha256", "requestSha256", "responseSha256"]) assert(typeof accepted[name] === "string" && /^[a-f0-9]{64}$/.test(accepted[name] as string), "prior incomplete accepted marker HOLD");
    }
  }
  return { stored, rejected };
}

/** Normal tag CLI only, under its canonical kernel lock and before acquiring the cross-host publisher. */
export function assertClefJournalReady(state: string): void { inspectClefJournal(state); }

export function acknowledgeClefError(state: string, key: string, responseSha256: string): void {
  assert.match(key, /^[a-f0-9]{64}$/); assert.match(responseSha256, /^[a-f0-9]{64}$/);
  privatePath(state, true); const root = join(state, "clef-decisions"); privatePath(root, true);
  const directory = join(root, key), marker = join(directory, "rejected.json");
  assert(!existsSync(marker), "error ACK already exists; no repeated operation");
  const hashes = rejectedInput(directory); assert.equal(hashes["response.raw"], responseSha256);
  // A prior fsync failure is not silently treated as durable: explicitly sync the exact pinned files now.
  for (const name of Object.keys(hashes)) {
    const fd = openSync(join(directory, name), "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  const fd = openSync(marker, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify({ at: new Date().toISOString(), hashes, noReinference: true }) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  syncParent(marker);
}

export function createClefJournal(state: string, pins: Pins, upgrade?: ClefContextUpgrade): (input: ClefJournalInput) => LocalDecisionExchange {
  let written = 0, stored: number | undefined, stopped = false;
  const root = join(state, "clef-decisions");
  const read = readJournalFile;
  const put = (path: string, value: string | Uint8Array): void => {
    const raw = Buffer.from(value);
    assert(raw.length <= FILE_MAX && written + raw.length <= RUN_MAX && stored !== undefined && stored + written + raw.length <= STORE_MAX, "journal byte budget STOP");
    written += raw.length; // partial fsync/write still consumes this run's conservative budget
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, raw); fsyncSync(fd); } finally { closeSync(fd); }
    syncParent(path);
  };
  return input => {
    assert.equal(stopped, false, "model journal sticky STOP (no forward)");
    try {
      privatePath(state, true);
      if (!existsSync(root)) { mkdirSync(root, { mode: 0o700 }); syncParent(root); }
      privatePath(root, true);
      if (stored === undefined) {
        const inspected = inspectClefJournal(state); stored = inspected.stored;
        for (const { directory, hashes } of inspected.rejected) {
          // Establish ACK durability before a new forward even if an earlier marker/parent fsync failed.
          for (const name of [...Object.keys(hashes), "rejected.json"]) {
            const fd = openSync(join(directory, name), "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
          }
          syncParent(join(directory, "rejected.json"));
        }
      }
      assert.equal(sha(input.state), input.receipt.stateSha256);
      const questions = Object.entries(input.questions).map(([qid, q]) => {
        assert(q.criteria); return { qid, question: q.instructions, options: [q.criteria.true, q.criteria.false] };
      });
      let contextUpgrade: ContextRecipe | undefined;
      if (upgrade !== undefined) {
        assert.match(upgrade.oldKey, /^[a-f0-9]{64}$/);
        assert.match(upgrade.previousCalibrationSha256, /^[a-f0-9]{64}$/);
        assert.equal(input.stockCode, upgrade.stockCode); assert.equal(input.batchIndex, 0, "context upgrade is one complete request only");
        const old = join(root, upgrade.oldKey), hashes = rejectedInput(old);
        const marker = read(join(old, "rejected.json")), ack = jsonLine(marker);
        assert.equal(ack.noReinference, true); assert.deepEqual(ack.hashes, hashes);
        const prior = jsonLine(read(join(old, "input.json")));
        assert.equal(prior.contextUpgrade, undefined, "context upgrade cannot be chained");
        assert.equal(prior.modelManifestSha256, pins.modelManifestSha256);
        assert.equal(prior.calibrationSha256, upgrade.previousCalibrationSha256, "context upgrade requires the qualified old16000 calibration");
        assert.notEqual(prior.calibrationSha256, pins.calibrationSha256, "context upgrade requires the newly qualified calibration");
        // batchIndex is invocation-local; every semantic/source binding stays exact.
        for (const key of ["stockCode", "periodEnd", "receipt", "textsSha256", "model", "vocabHash", "state", "questions"] as const) {
          assert.equal(sha(canonicalJson(prior[key])), sha(canonicalJson(key === "questions" ? questions : input[key])), "context upgrade source/input changed HOLD");
        }
        const request = read(join(old, "request.raw"));
        const qualification = validateClefContextQualification(upgrade.qualify(request), request);
        assert.deepEqual(rejectedInput(old), hashes); assert.equal(sha(read(join(old, "rejected.json"))), sha(marker));
        contextUpgrade = { oldKey: upgrade.oldKey, oldHashes: { ...hashes, "rejected.json": sha(marker) }, qualification };
      }
      const binding = { ...input, questions, ...pins, ...(contextUpgrade === undefined ? {} : { contextUpgrade }) };
      const bindingRaw = canonicalJson(binding) + "\n", key = journalKey(binding);
      const directory = join(root, key), path = (name: string) => join(directory, name);
      const qids = questions.map(q => q.qid);
      if (existsSync(directory)) {
        privatePath(directory, true);
        assert(!existsSync(path("rejected.json")), "saved Clef error acknowledged; same input HOLD, no reinference");
        assert(!incomplete(directory), "incomplete/unknown raw output HOLD");
        assert.equal(read(path("input.json")).toString("utf8"), bindingRaw, "saved model input/recipe differs; HOLD, no new forward");
        const requestRaw = read(path("request.raw")), responseRaw = read(path("response.raw"));
        const accepted = jsonLine(read(path("accepted.json")));
        const intent = jsonLine(read(path("intent.json"))), sent = jsonLine(read(path("send.json")));
        const request = jsonLine(requestRaw), response = jsonLine(responseRaw);
        assert.equal(canonicalJson({ state: request.state, questions: request.questions }), canonicalJson({ state: input.state, questions }));
        assert.equal(typeof request.id, "string"); assert.equal(response.id, request.id);
        assert.deepEqual(Object.keys(response).sort(), ["answers", "id"]);
        const probabilities = answers(response.answers, qids), result = accepted.result as JevAskResult;
        assert.equal(accepted.inputSha256, sha(bindingRaw)); assert.equal(accepted.requestSha256, sha(requestRaw)); assert.equal(accepted.responseSha256, sha(responseRaw));
        assert.equal(intent.inputSha256, sha(bindingRaw)); assert.equal(sent.requestSha256, sha(requestRaw));
        const clocks = [intent.at, sent.at, accepted.at].map(v => { assert.equal(typeof v, "string"); const n = Date.parse(v as string); assert(Number.isFinite(n)); return n; });
        assert(clocks[0] <= clocks[1] && clocks[1] <= clocks[2]);
        assert.equal(result.model, input.model); assert.equal(canonicalJson(answers(result.answers, qids)), canonicalJson(probabilities));
        assert.equal(result.attempts, 1); assert.equal(result.inputTokens, 0); assert.equal(result.outputTokens, 0);
        assert(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
        return { replay: result, decidedAt: accepted.at as string, beforeSend: () => { throw new Error("saved output forbids forward"); }, response: () => { throw new Error("saved output forbids forward"); }, accepted: () => { throw new Error("saved output is immutable"); } };
      }
      // Reserve the complete bounded model tail before starting Python or writing stdin.
      assert(written + 6 * FILE_MAX <= RUN_MAX && stored + written + 6 * FILE_MAX <= STORE_MAX, "journal complete-tail budget HOLD");
      mkdirSync(directory, { mode: 0o700 }); syncParent(directory);
      put(path("input.json"), bindingRaw);
      const intentAt = new Date().toISOString();
      put(path("intent.json"), JSON.stringify({ at: intentAt, inputSha256: sha(bindingRaw), noAutomaticReinference: true }) + "\n");
      let sendAt: string | undefined;
      const guard = (action: () => void): void => { try { assert.equal(stopped, false); action(); } catch (error) { stopped = true; throw error; } };
      const exchange: LocalDecisionExchange = {
        beforeSend: line => guard(() => {
          const request = jsonLine(line);
          assert.equal(canonicalJson({ state: request.state, questions: request.questions }), canonicalJson({ state: input.state, questions }));
          assert.equal(typeof request.id, "string"); put(path("request.raw"), line);
          sendAt = new Date().toISOString(); assert(Date.parse(sendAt) >= Date.parse(intentAt), "model send clock rollback HOLD");
          put(path("send.json"), JSON.stringify({ at: sendAt, requestSha256: sha(line) }) + "\n");
        }),
        response: (line, complete) => guard(() => {
          if (complete) {
            if (existsSync(path("response.raw"))) {
              put(path("unexpected-response.raw"), line);
              throw new Error("duplicate/unknown response line; STOP");
            }
            put(path("response.raw"), line);
          }
          else {
            put(path("response-partial.raw"), line.subarray(0, FILE_MAX));
            put(path("partial.json"), JSON.stringify({ complete: false, capturedBytes: Math.min(line.length, FILE_MAX), observedAtLeastBytes: line.length, truncated: line.length > FILE_MAX, noReplay: true }) + "\n");
            stopped = true;
          }
        }),
        accepted: result => guard(() => {
          const requestRaw = read(path("request.raw")), responseRaw = read(path("response.raw"));
          const request = jsonLine(requestRaw), response = jsonLine(responseRaw);
          assert.equal(response.id, request.id); assert.deepEqual(Object.keys(response).sort(), ["answers", "id"]);
          assert.equal(result.model, input.model);
          assert.equal(canonicalJson(answers(result.answers, qids)), canonicalJson(answers(response.answers, qids)));
          const at = new Date().toISOString();
          assert(sendAt !== undefined && Date.parse(at) >= Date.parse(sendAt), "model completion clock rollback HOLD");
          put(path("accepted.json"), JSON.stringify({ at, inputSha256: sha(bindingRaw), requestSha256: sha(requestRaw), responseSha256: sha(responseRaw), qids, result }) + "\n");
          exchange.decidedAt = at;
        }),
      };
      return exchange;
    } catch (error) { stopped = true; throw error; }
  };
}
