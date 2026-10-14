/**
 * semif クライアント (src/shared/semif/client.ts) のテスト。
 * 実際の SemIf / モデルは一切ロードしない — `spawnFn` を偽の常駐プロセスに
 * 差し替え、標準入力/標準出力の JSONL 行プロトコルだけをテストする。
 *
 * - 起動は1回だけ (2回目以降の askNoul は同じプロセスを使い回す)
 * - state/questions を SemIf の行プロトコル (qid/question/options) に正しく
 *   変換する (criteria.true/false → options[0]/options[1])
 * - criteria が無い質問は SemIf へ変換できないため即座に throw (ルール2)
 * - サーバーの {id, error} 応答はバッチ全体を SemifUnavailableError として扱う
 * - 応答の質問id過不足・値域外は即座に throw (一部だけ既定値で埋めない)
 * - 起動応答 (ready 行) が不正/プロセスが落ちた場合も SemifUnavailableError
 * - 質問0件は呼び出し側の実装ミスとして Error (プロセスも起動しない)
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createSemifClient, SemifUnavailableError, SEMIF_MODEL, SEMIF_SOURCE_REVISION, SEMIF_MLX_VERSION, SEMIF_MLX_LM_REVISION, type LocalDecisionExchange } from "./client.js";
import type { JevNoulQuestion } from "../jev/client.js";
import { createClefClient, CLEF_MODEL, CLEF_MANIFEST } from "../clef/client.js";

interface FakeRequest {
  id: string;
  state: string;
  questions: Array<{ qid: string; question: string; options: [string, string] }>;
}

/** イベントベースの偽常駐プロセス。stdin.write を受けてリクエストに応じた行を stdout へ流す。 */
function makeFakeServerSpawn(opts: {
  readyLine?: unknown;
  respond: (req: FakeRequest) => unknown | "hang";
  chunks?: (line: Buffer) => Buffer[];
}) {
  const spawnCalls: Array<{ command: string; args: string[] }> = [];
  const writtenRequests: FakeRequest[] = [];
  const children: Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }> = [];

  const spawnFn = ((command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: (chunk: string) => void };
      kill: (signal?: string) => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (): boolean => true;
    child.stdin = {
      write: (chunk: string) => {
        const req = JSON.parse(chunk.trim()) as FakeRequest;
        writtenRequests.push(req);
        const resp = opts.respond(req);
        if (resp === "hang") return;
        queueMicrotask(() => {
          const line = Buffer.from(`${JSON.stringify(resp)}\n`);
          for (const chunk of opts.chunks ? opts.chunks(line) : [line]) child.stdout.emit("data", chunk);
        });
      },
    };
    children.push(child);
    queueMicrotask(() => {
      const ready = opts.readyLine ?? {
        ready: true,
        model: "Qwen/Qwen3.5-4B",
        revision: "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a",
        backend: "mlx",
        max_tokens: 16000,
        source_revision: SEMIF_SOURCE_REVISION,
        mlx_version: SEMIF_MLX_VERSION,
        mlx_lm_revision: SEMIF_MLX_LM_REVISION,
      };
      child.stdout.emit("data", Buffer.from(`${JSON.stringify(ready)}\n`));
    });
    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  }) as typeof import("node:child_process").spawn;

  return { spawnFn, spawnCalls, writtenRequests, children };
}

const Q: Record<string, JevNoulQuestion> = {
  "cp.7203": {
    instructions: "Does B compete with A? Company B: 本田技研工業",
    criteria: { true: "same market substitute", false: "supplier/customer/partner" },
  },
  "cp.9101": {
    instructions: "Does B compete with A? Company B: 日本郵船",
    criteria: { true: "same market substitute", false: "supplier/customer/partner" },
  },
};

describe("Clef native JSONL boundary", () => {
  const ready = { ready: true, model: CLEF_MANIFEST.repo, revision: CLEF_MANIFEST.revision,
    backend: "torch-mps", max_tokens: 16000, source_sha256: CLEF_MANIFEST.source_sha256,
    torch_version: CLEF_MANIFEST.runtime.torch, transformers_version: CLEF_MANIFEST.runtime.transformers,
    safetensors_version: CLEF_MANIFEST.runtime.safetensors };

  it("native pinsとモデル保存先を渡し、旧SemIf名に変換せず返す", async () => {
    const fake = makeFakeServerSpawn({ readyLine: ready,
      respond: (req) => ({ id: req.id, answers: Object.fromEntries(req.questions.map(q => [q.qid, 0.9])) }) });
    const client = createClefClient({ pythonBin: "/test/python", modelPath: "/test/clef", spawnFn: fake.spawnFn });
    try {
      expect((await client.askNoul("原文", Q)).model).toBe(CLEF_MODEL);
      expect(fake.spawnCalls[0].args.slice(-2)).toEqual(["--model-path", "/test/clef"]);
      await client.askNoul("原文", Q);
      expect(fake.spawnCalls).toHaveLength(1);
    } finally { client.close(); }
  });

  it.each(Object.keys(ready))("native readyの%s不一致は入力送信前に停止", async (key) => {
    const fake = makeFakeServerSpawn({ readyLine: { ...ready, [key]: "mismatch" }, respond: () => "hang" });
    const client = createClefClient({ pythonBin: "/test/python", modelPath: "/test/clef", spawnFn: fake.spawnFn });
    try {
      await expect(client.askNoul("原文", Q)).rejects.toThrow(SemifUnavailableError);
      expect(fake.writtenRequests).toHaveLength(0);
    } finally { client.close(); }
  });
});

describe("durable protocol faults — offline controls, no real process/model", () => {
  function sink(): LocalDecisionExchange {
    return { beforeSend: vi.fn(), response: vi.fn(), accepted: vi.fn() };
  }
  it("intent sink finishes before stdin; response sink finishes before accepted result", async () => {
    const order: string[] = [];
    const fake = makeFakeServerSpawn({ respond: req => { order.push("stdin"); return { id: req.id, answers: Object.fromEntries(req.questions.map(q => [q.qid, 0.5])) }; } });
    const exchange: LocalDecisionExchange = { beforeSend: () => { order.push("intent-fsynced"); }, response: () => { order.push("raw-fsynced"); }, accepted: () => { order.push("accepted-fsynced"); } };
    const client = createSemifClient({ pythonBin: "/offline-control/python", spawnFn: fake.spawnFn });
    await client.askNoul("offline protocol control", Q, exchange);
    expect(order).toEqual(["intent-fsynced", "stdin", "raw-fsynced", "accepted-fsynced"]); client.close();
  });
  it("UTF8 chunk split retains original response bytes and an error forbids the next forward", async () => {
    let original: Buffer | undefined;
    const fake = makeFakeServerSpawn({ respond: req => ({ id: req.id, error: Q["cp.7203"].instructions }), chunks: line => {
      original = line; const middle = line.indexOf(Buffer.from("本田")) + 1; return [line.subarray(0, middle), line.subarray(middle)];
    } });
    const exchange = sink(), client = createSemifClient({ pythonBin: "/offline-control/python", spawnFn: fake.spawnFn });
    await expect(client.askNoul("offline protocol control", Q, exchange)).rejects.toThrow(SemifUnavailableError);
    expect(exchange.response).toHaveBeenCalledWith(original, true); expect(exchange.accepted).not.toHaveBeenCalled();
    await expect(client.askNoul("next forward forbidden", Q, sink())).rejects.toThrow(SemifUnavailableError);
    expect(fake.writtenRequests).toHaveLength(1); expect(fake.spawnCalls).toHaveLength(1);
  });
  it("request fsync failure sends zero input and never respawns", async () => {
    const fake = makeFakeServerSpawn({ respond: () => "hang" }), exchange = sink();
    exchange.beforeSend = () => { throw new Error("offline intent fsync fault"); };
    const client = createSemifClient({ pythonBin: "/offline-control/python", spawnFn: fake.spawnFn });
    await expect(client.askNoul("offline protocol control", Q, exchange)).rejects.toThrow();
    await expect(client.askNoul("next forward forbidden", Q, sink())).rejects.toThrow();
    expect(fake.writtenRequests).toHaveLength(0); expect(fake.spawnCalls).toHaveLength(1);
  });
  it("broken response line is preserved incomplete and closes the request before a second forward", async () => {
    const fake = makeFakeServerSpawn({ respond: () => "hang" }), exchange = sink();
    const client = createSemifClient({ pythonBin: "/offline-control/python", spawnFn: fake.spawnFn });
    const pending = expect(client.askNoul("offline protocol control", Q, exchange)).rejects.toThrow(SemifUnavailableError);
    await vi.waitFor(() => expect(fake.writtenRequests).toHaveLength(1));
    const partial = Buffer.from(JSON.stringify({ id: "req-0", error: Q["cp.7203"].instructions }).slice(0, -2));
    fake.children[0].stdout.emit("data", partial); fake.children[0].emit("close", 1);
    await pending; expect(exchange.response).toHaveBeenCalledWith(partial, false); expect(exchange.accepted).not.toHaveBeenCalled();
    await expect(client.askNoul("next forward forbidden", Q, sink())).rejects.toThrow(); expect(fake.writtenRequests).toHaveLength(1);
  });
  it("response sink failure never accepts or starts another request", async () => {
    const fake = makeFakeServerSpawn({ respond: req => ({ id: req.id, answers: Object.fromEntries(req.questions.map(q => [q.qid, 0.5])) }) }), exchange = sink();
    exchange.response = () => { throw new Error("offline raw fsync fault"); };
    const client = createSemifClient({ pythonBin: "/offline-control/python", spawnFn: fake.spawnFn });
    await expect(client.askNoul("offline protocol control", Q, exchange)).rejects.toThrow("journal failed");
    await expect(client.askNoul("next forward forbidden", Q, sink())).rejects.toThrow();
    expect(exchange.accepted).not.toHaveBeenCalled(); expect(fake.writtenRequests).toHaveLength(1);
  });
});

describe("createSemifClient askNoul — 正常系", () => {
  it("closeは起動前にはspawnせず、起動後には解放し再起動しない", async () => {
    const { spawnFn, spawnCalls, children } = makeFakeServerSpawn({ respond: (req) => ({ id: req.id, answers: Object.fromEntries(req.questions.map(q => [q.qid, 0.5])) }) });
    const unopened = createSemifClient({ pythonBin: "/fake/python", spawnFn });
    unopened.close();
    await expect(unopened.askNoul("state", Q)).rejects.toThrow("終了");
    expect(spawnCalls).toHaveLength(0);
    const client = createSemifClient({ pythonBin: "/fake/python", spawnFn });
    await client.askNoul("state", Q);
    const kill = vi.spyOn(children[0] as unknown as { kill(signal?: string): boolean }, "kill");
    client.close();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    await expect(client.askNoul("state", Q)).rejects.toThrow("終了");
    expect(spawnCalls).toHaveLength(1);
  });

  it.each(["model", "revision", "backend", "max_tokens", "source_revision", "mlx_version", "mlx_lm_revision"])("readyの%sが較正対象と異なれば推論前STOP", async (key) => {
    const ready = { ready: true, model: "Qwen/Qwen3.5-4B", revision: "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a", backend: "mlx", max_tokens: 16000, source_revision: SEMIF_SOURCE_REVISION, mlx_version: SEMIF_MLX_VERSION, mlx_lm_revision: SEMIF_MLX_LM_REVISION };
    const { spawnFn, writtenRequests } = makeFakeServerSpawn({ readyLine: { ...ready, [key]: key === "max_tokens" ? 1 : "mismatch" }, respond: () => "hang" });
    const client = createSemifClient({ pythonBin: "/fake/python", spawnFn });
    await expect(client.askNoul("state", Q)).rejects.toThrow(SemifUnavailableError);
    expect(writtenRequests).toHaveLength(0);
  });
  it("state/questions を SemIf の行プロトコルへ変換し、p_yes をそのまま返す", async () => {
    const { spawnFn, spawnCalls, writtenRequests } = makeFakeServerSpawn({
      respond: (req) => ({
        id: req.id,
        answers: Object.fromEntries(req.questions.map((q, i) => [q.qid, i === 0 ? 0.9 : 0.1])),
      }),
    });
    const client = createSemifClient({ pythonBin: "/fake/python", spawnFn, now: () => 0 });

    const result = await client.askNoul("会社Aの状態抜粋", Q);

    expect(result.answers).toEqual({ "cp.7203": 0.9, "cp.9101": 0.1 });
    expect(result.model).toBe(SEMIF_MODEL);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.attempts).toBe(1);
    expect(spawnCalls).toHaveLength(1);

    const sent = writtenRequests[0];
    expect(sent.state).toBe("会社Aの状態抜粋");
    expect(sent.questions).toEqual([
      { qid: "cp.7203", question: Q["cp.7203"].instructions, options: ["same market substitute", "supplier/customer/partner"] },
      { qid: "cp.9101", question: Q["cp.9101"].instructions, options: ["same market substitute", "supplier/customer/partner"] },
    ]);
  });

  it("2回目以降の askNoul は同じプロセスを使い回す (再起動しない)", async () => {
    const { spawnFn, spawnCalls } = makeFakeServerSpawn({
      respond: (req) => ({
        id: req.id,
        answers: Object.fromEntries(req.questions.map((q) => [q.qid, 0.5])),
      }),
    });
    const client = createSemifClient({ pythonBin: "/fake/python", spawnFn });

    await client.askNoul("state1", Q);
    await client.askNoul("state2", Q);

    expect(spawnCalls).toHaveLength(1);
  });
});

describe("createSemifClient askNoul — 応答内容の不備は即座に throw (一部だけ既定値で埋めない)", () => {
  it("サーバーの {id, error} 応答は SemifUnavailableError", async () => {
    const { spawnFn } = makeFakeServerSpawn({
      respond: (req) => ({ id: req.id, error: "ValueError: Row cp.7203: 20000 input tokens exceed limit 16000; no truncation allowed" }),
    });
    const client = createSemifClient({ pythonBin: "/fake/python", spawnFn });

    await expect(client.askNoul("state", Q)).rejects.toThrow(SemifUnavailableError);
    await expect(client.askNoul("state", Q)).rejects.toThrow(/input tokens exceed limit/);
  });

  it("質問idが欠けている応答は SemifUnavailableError", async () => {
    const { spawnFn } = makeFakeServerSpawn({
      respond: (req) => ({ id: req.id, answers: { [req.questions[0].qid]: 0.5 } }),
    });
    const client = createSemifClient({ pythonBin: "/fake/python", spawnFn });

    await expect(client.askNoul("state", Q)).rejects.toThrow(SemifUnavailableError);
  });

  it("余分な質問idを含む応答は SemifUnavailableError", async () => {
    const { spawnFn } = makeFakeServerSpawn({
      respond: (req) => ({
        id: req.id,
        answers: { ...Object.fromEntries(req.questions.map((q) => [q.qid, 0.5])), "cp.9999": 0.1 },
      }),
    });
    const client = createSemifClient({ pythonBin: "/fake/python", spawnFn });

    await expect(client.askNoul("state", Q)).rejects.toThrow(SemifUnavailableError);
  });

  it("値域外 (0..1 を超える) の応答は SemifUnavailableError", async () => {
    const { spawnFn } = makeFakeServerSpawn({
      respond: (req) => ({
        id: req.id,
        answers: Object.fromEntries(req.questions.map((q) => [q.qid, 1.5])),
      }),
    });
    const client = createSemifClient({ pythonBin: "/fake/python", spawnFn });

    await expect(client.askNoul("state", Q)).rejects.toThrow(SemifUnavailableError);
  });
});

describe("createSemifClient askNoul — criteria が無い質問は変換できない", () => {
  it("criteria.true/false が無い質問は即座に throw", async () => {
    const { spawnFn } = makeFakeServerSpawn({
      respond: (req) => ({ id: req.id, answers: Object.fromEntries(req.questions.map((q) => [q.qid, 0.5])) }),
    });
    const client = createSemifClient({ pythonBin: "/fake/python", spawnFn });
    const badQ: Record<string, JevNoulQuestion> = { "cp.7203": { instructions: "no criteria here" } };

    await expect(client.askNoul("state", badQ)).rejects.toThrow(/criteria\.true\/criteria\.false/);
  });
});

describe("createSemifClient askNoul — 起動失敗", () => {
  it("起動応答 (ready 行) が想定した形式と一致しなければ SemifUnavailableError", async () => {
    const { spawnFn } = makeFakeServerSpawn({
      readyLine: { ready: false },
      respond: () => ({ id: "unused", answers: {} }),
    });
    const client = createSemifClient({ pythonBin: "/fake/python", spawnFn, readyTimeoutMs: 1000 });

    await expect(client.askNoul("state", Q)).rejects.toThrow(SemifUnavailableError);
  });

  it("応答が requestTimeoutMs 以内に届かなければ SemifUnavailableError", async () => {
    const { spawnFn } = makeFakeServerSpawn({ respond: () => "hang" });
    const client = createSemifClient({ pythonBin: "/fake/python", spawnFn, requestTimeoutMs: 20 });

    await expect(client.askNoul("state", Q)).rejects.toThrow(SemifUnavailableError);
  }, 10_000);
});

describe("createSemifClient askNoul — 呼び出し側のバグ", () => {
  it("questions が空ならプロセスを起動せず Error", async () => {
    const { spawnFn, spawnCalls } = makeFakeServerSpawn({
      respond: (req) => ({ id: req.id, answers: {} }),
    });
    const client = createSemifClient({ pythonBin: "/fake/python", spawnFn });

    await expect(client.askNoul("state", {})).rejects.toThrow("questions が空です");
    expect(spawnCalls).toHaveLength(0);
  });
});
