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
import { describe, expect, it } from "vitest";
import { createSemifClient, SemifUnavailableError, SEMIF_MODEL } from "./client.js";
import type { JevNoulQuestion } from "../jev/client.js";

interface FakeRequest {
  id: string;
  state: string;
  questions: Array<{ qid: string; question: string; options: [string, string] }>;
}

/** イベントベースの偽常駐プロセス。stdin.write を受けてリクエストに応じた行を stdout へ流す。 */
function makeFakeServerSpawn(opts: {
  readyLine?: unknown;
  respond: (req: FakeRequest) => unknown | "hang";
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
          child.stdout.emit("data", Buffer.from(`${JSON.stringify(resp)}\n`));
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

describe("createSemifClient askNoul — 正常系", () => {
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
