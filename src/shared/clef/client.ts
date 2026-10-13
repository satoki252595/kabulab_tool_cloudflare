import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLocalDecisionClient, type CreateSemifClientOptions, type SemifClient } from "../semif/client.js";
import { clefEnv } from "./env.js";

export const CLEF_MANIFEST = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8")) as {
  repo: string; revision: string; source_sha256: string;
  files: Array<{ path: string; size: number; sha256: string }>;
  runtime: { torch: string; transformers: string; safetensors: string };
};
export const CLEF_MODEL = `${CLEF_MANIFEST.repo}@${CLEF_MANIFEST.revision.slice(0, 8)}/torch-mps`;

/** 固定Clefの原本重みと専用headを、1常駐プロセスでローカル実行する。 */
export function createClefClient(o: Omit<CreateSemifClientOptions, "hfModel" | "hfRevision"> & { modelPath?: string } = {}): SemifClient {
  return createLocalDecisionClient({ ...o,
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
