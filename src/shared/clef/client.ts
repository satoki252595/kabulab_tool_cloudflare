import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createLocalDecisionClient, type CreateSemifClientOptions, type SemifClient } from "../semif/client.js";
import { clefEnv } from "./env.js";

export const CLEF_MANIFEST = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8")) as {
  repo: string; revision: string; source_sha256: string;
  files: Array<{ path: string; size: number; sha256: string }>;
  runtime: { torch: string; transformers: string; safetensors: string };
};
export const CLEF_MODEL = `${CLEF_MANIFEST.repo}@${CLEF_MANIFEST.revision.slice(0, 8)}/torch-mps`;
export const CLEF_MAX_INPUT_TOKENS = 18_432;

export interface ClefContextQualification {
  qualified: true; fromMaxTokens: 16000; toMaxTokens: 18432; requestSha256: string;
  originalTokens: number; layout: Array<{ tokens: number; qids: string[] }>;
}

/** Closed, deterministic encode-only receipt. It contains no clock, PID or model answer. */
export function validateClefContextQualification(value: unknown, request: Uint8Array): ClefContextQualification {
  assert(value !== null && typeof value === "object");
  const proof = value as ClefContextQualification;
  assert.deepEqual(Object.keys(proof).sort(), ["fromMaxTokens", "layout", "originalTokens", "qualified", "requestSha256", "toMaxTokens"]);
  assert.equal(proof.qualified, true); assert.equal(proof.fromMaxTokens, 16000); assert.equal(proof.toMaxTokens, CLEF_MAX_INPUT_TOKENS);
  assert.equal(proof.requestSha256, createHash("sha256").update(request).digest("hex"));
  assert(Number.isSafeInteger(proof.originalTokens) && proof.originalTokens > 16000);
  const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request)) as { questions: Array<{ qid: string }> };
  assert(Array.isArray(proof.layout) && proof.layout.length > 0 && proof.layout.length <= input.questions.length);
  for (const part of proof.layout) {
    assert.deepEqual(Object.keys(part).sort(), ["qids", "tokens"]);
    assert(Number.isSafeInteger(part.tokens) && part.tokens > 0 && part.tokens <= CLEF_MAX_INPUT_TOKENS);
    assert(Array.isArray(part.qids) && part.qids.length > 0);
  }
  assert.deepEqual(proof.layout.flatMap(part => part.qids), input.questions.map(q => q.qid));
  return proof;
}

/** Qualify a known rejected full request without loading weights or running a forward. */
export function qualifyClefContextUpgrade(request: Uint8Array): ClefContextQualification {
  assert(request.length > 0 && request.length <= 1024 * 1024);
  try {
    const raw = execFileSync(clefEnv.python(), [fileURLToPath(new URL("../../../services/yuho-quant/scripts/clef_server.py", import.meta.url)),
      "--model", CLEF_MANIFEST.repo, "--revision", CLEF_MANIFEST.revision, "--max-tokens", String(CLEF_MAX_INPUT_TOKENS),
      "--model-path", clefEnv.modelPath(), "--qualify-context-upgrade"],
    { input: request, maxBuffer: 1024 * 1024, timeout: 45_000, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } });
    return validateClefContextQualification(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)), request);
  } catch { throw new Error("Clef context encode-only qualification failed; no model forward"); }
}

/** 固定Clefの原本重みと専用headを、1常駐プロセスでローカル実行する。 */
export function createClefClient(o: Omit<CreateSemifClientOptions, "hfModel" | "hfRevision"> & { modelPath?: string } = {}): SemifClient {
  return createLocalDecisionClient({ ...o,
    maxTokens: o.maxTokens ?? CLEF_MAX_INPUT_TOKENS,
    pythonBin: o.pythonBin ?? clefEnv.python(),
    serverScriptPath: o.serverScriptPath ?? fileURLToPath(new URL("../../../services/yuho-quant/scripts/clef_server.py", import.meta.url)),
    hfModel: CLEF_MANIFEST.repo,
    hfRevision: CLEF_MANIFEST.revision,
    model: CLEF_MODEL,
    serverArgs: ["--model-path", o.modelPath ?? clefEnv.modelPath()],
    expectedReady: { backend: "torch-mps", source_sha256: CLEF_MANIFEST.source_sha256,
      torch_version: CLEF_MANIFEST.runtime.torch, transformers_version: CLEF_MANIFEST.runtime.transformers,
      safetensors_version: CLEF_MANIFEST.runtime.safetensors },
  });
}
