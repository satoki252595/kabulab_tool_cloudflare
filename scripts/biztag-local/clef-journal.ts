/** Normal Mac biztag only. Immutable, bounded local model inputs/raw outputs; no network. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { JevAskResult, JevNoulQuestion } from "../../src/shared/jev/client.js";
import type { LocalDecisionExchange } from "../../src/shared/semif/client.js";
import type { InputReceipt } from "../../services/yuho-quant/src/biztag/plan.js";
import { canonicalJson } from "../../services/yuho-quant/src/biztag/vocabulary/hash.js";

export interface ClefJournalInput {
  stockCode: string; periodEnd: string; receipt: InputReceipt; textsSha256: string;
  model: string; vocabHash: string; batchIndex: number;
  state: string; questions: Record<string, JevNoulQuestion>;
}
const FILE_MAX = 1024 * 1024, RUN_MAX = 64 * FILE_MAX, STORE_MAX = 1024 * FILE_MAX;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
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

export function createClefJournal(state: string, pins: { modelManifestSha256: string; calibrationSha256: string }): (input: ClefJournalInput) => LocalDecisionExchange {
  let written = 0, stored: number | undefined, stopped = false;
  const root = join(state, "clef-decisions");
  const incomplete = (directory: string) => ["response-partial.raw", "partial.json", "unexpected-response.raw"].some(name => existsSync(join(directory, name)));
  const read = (path: string): Buffer => {
    privatePath(path, false); assert(lstatSync(path).size <= FILE_MAX, "journal file size HOLD"); return readFileSync(path);
  };
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
        stored = 0;
        const directories = readdirSync(root).map(entry => join(root, entry));
        for (const directory of directories) {
          privatePath(directory, true);
          for (const name of readdirSync(directory)) { const path = join(directory, name); privatePath(path, false); stored += lstatSync(path).size; }
        }
        assert(stored <= STORE_MAX, "journal storage full; preserve old evidence and HOLD");
        // A previous run's unresolved request stops every later forward, including other stocks.
        for (const directory of directories) {
          assert(!incomplete(directory), "prior unknown model output HOLD");
          const accepted = jsonLine(read(join(directory, "accepted.json")));
          for (const name of ["input.json", "intent.json", "request.raw", "send.json", "response.raw"]) privatePath(join(directory, name), false);
          for (const name of ["inputSha256", "requestSha256", "responseSha256"]) assert(typeof accepted[name] === "string" && /^[a-f0-9]{64}$/.test(accepted[name] as string), "prior incomplete accepted marker HOLD");
        }
      }
      assert.equal(sha(input.state), input.receipt.stateSha256);
      const questions = Object.entries(input.questions).map(([qid, q]) => {
        assert(q.criteria); return { qid, question: q.instructions, options: [q.criteria.true, q.criteria.false] };
      });
      const binding = { ...input, questions, ...pins }, bindingRaw = canonicalJson(binding) + "\n";
      const key = sha(canonicalJson({ stockCode: input.stockCode, docId: input.receipt.docId,
        sectionsSha256: input.receipt.sectionsSha256, batchIndex: input.batchIndex }));
      const directory = join(root, key), path = (name: string) => join(directory, name);
      const qids = questions.map(q => q.qid);
      if (existsSync(directory)) {
        privatePath(directory, true);
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
