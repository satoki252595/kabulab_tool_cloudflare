/**
 * jev クライアント (src/shared/jev/client.ts) のテスト。
 *
 * - 429 (Retry-After 尊重) / 529 / 5xx / ネットワークエラー / タイムアウト は
 *   指数バックオフで再試行し、リトライ上限で JevUnavailableError
 * - それ以外の 4xx は即座に JevUnavailableError (再試行しない)
 * - 応答の欠落・型不一致・範囲外・不正 JSON は必ず throw (既定値で埋めない)
 * - モデル名は応答の echo をそのまま使う
 * - 空の questions は呼び出し側のバグとして Error
 */
import { describe, expect, it } from "vitest";
import { JEV_ENDPOINT, JevUnavailableError, createJevClient } from "./client.js";
import type { JevNoulQuestion } from "./client.js";

interface ScriptEntry {
  status: number;
  retryAfter?: string;
  body?: unknown;
  rawText?: string;
}

function mockResponse(entry: ScriptEntry): Response {
  const headers = new Headers();
  if (entry.retryAfter !== undefined) headers.set("Retry-After", entry.retryAfter);
  const text = entry.rawText !== undefined ? entry.rawText : JSON.stringify(entry.body ?? {});
  return {
    ok: entry.status >= 200 && entry.status < 300,
    status: entry.status,
    headers,
    text: async () => text,
  } as Response;
}

function okBody(overrides?: {
  model?: string;
  answers?: Record<string, unknown>;
  inputTokens?: number;
  outputTokens?: number;
}) {
  return {
    model: overrides?.model ?? "jev-2026-09-test",
    answers: overrides?.answers ?? { "bt.a": { type: "noul", noul: 0.9 } },
    usage: {
      input_tokens: overrides?.inputTokens ?? 100,
      output_tokens: overrides?.outputTokens ?? 0,
    },
  };
}

/** テスト用の即時 sleep (実時間を消費しない)。呼ばれた ms を記録する。 */
function instantSleep(delays: number[]) {
  return async (ms: number) => {
    delays.push(ms);
  };
}

function makeScriptedFetch(script: ScriptEntry[], calls: Array<{ url: string; init: RequestInit }>) {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const entry = script.shift();
    if (!entry) throw new Error("テスト: 応答スクリプト枯渇");
    return mockResponse(entry);
  }) as typeof fetch;
}

const Q: Record<string, JevNoulQuestion> = {
  "bt.a": { instructions: "Does the company operate semiconductor packaging materials?" },
};

describe("createJevClient askNoul — 正常系・ワイヤ形式", () => {
  it("成功時は questionId ごとの noul 確率を返し、attempts=1", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = makeScriptedFetch([{ status: 200, body: okBody() }], calls);
    const client = createJevClient({
      apiKey: "test-key",
      model: "jev-2026-09",
      fetch: fetchFn,
      sleep: instantSleep([]),
      now: (() => {
        let t = 0;
        return () => (t += 5);
      })(),
    });

    const result = await client.askNoul("STATE TEXT", Q);
    expect(result.answers).toEqual({ "bt.a": 0.9 });
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
  });

  it("リクエストの URL・ヘッダ・body が仕様どおり", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = makeScriptedFetch(
      [
        {
          status: 200,
          body: okBody({
            answers: {
              "bt.a": { type: "noul", noul: 0.9 },
              "bt.b": { type: "noul", noul: 0.1 },
            },
          }),
        },
      ],
      calls
    );
    const client = createJevClient({
      apiKey: "secret-abc",
      model: "jev-2026-09",
      fetch: fetchFn,
      sleep: instantSleep([]),
    });

    await client.askNoul("STATE TEXT", {
      "bt.a": {
        instructions: "instr-a",
        criteria: { true: "criteria-true", false: "criteria-false" },
      },
      "bt.b": { instructions: "instr-b" },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0] as { url: string; init: RequestInit };
    expect(call.url).toBe(JEV_ENDPOINT);
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-abc");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(call.init.body as string);
    expect(body).toEqual({
      state: "STATE TEXT",
      model: "jev-2026-09",
      questions: {
        "bt.a": {
          type: "noul",
          instructions: "instr-a",
          criteria: { true: "criteria-true", false: "criteria-false" },
        },
        "bt.b": { type: "noul", instructions: "instr-b" },
      },
    });
  });

  it("モデル名は応答の echo をそのまま使う (依頼したモデルと異なっても)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = makeScriptedFetch(
      [{ status: 200, body: okBody({ model: "jev-2026-09-echoed" }) }],
      calls
    );
    const client = createJevClient({
      apiKey: "k",
      model: "jev-2026-09-requested",
      fetch: fetchFn,
      sleep: instantSleep([]),
    });

    const result = await client.askNoul("STATE", Q);
    expect(result.model).toBe("jev-2026-09-echoed");
  });

  it("questions が空なら呼び出し側バグとして (JevUnavailableError ではない) Error を投げる", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = makeScriptedFetch([], calls);
    const client = createJevClient({ apiKey: "k", model: "m", fetch: fetchFn });

    await expect(client.askNoul("STATE", {})).rejects.toThrow("questions が空");
    await expect(client.askNoul("STATE", {})).rejects.not.toBeInstanceOf(JevUnavailableError);
    expect(calls).toHaveLength(0);
  });
});

describe("createJevClient askNoul — リトライ", () => {
  it("429 は Retry-After (秒) を尊重して再試行し成功する", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = makeScriptedFetch(
      [
        { status: 429, retryAfter: "2" },
        { status: 200, body: okBody() },
      ],
      calls
    );
    const delays: number[] = [];
    const client = createJevClient({
      apiKey: "k",
      model: "m",
      fetch: fetchFn,
      sleep: instantSleep(delays),
    });

    const result = await client.askNoul("STATE", Q);
    expect(result.attempts).toBe(2);
    expect(delays).toEqual([2000]);
    expect(calls).toHaveLength(2);
  });

  it("529 は指数バックオフで再試行し成功する (Retry-After 無し)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = makeScriptedFetch(
      [{ status: 529 }, { status: 529 }, { status: 200, body: okBody() }],
      calls
    );
    const delays: number[] = [];
    const client = createJevClient({
      apiKey: "k",
      model: "m",
      fetch: fetchFn,
      baseDelayMs: 500,
      maxDelayMs: 8000,
      sleep: instantSleep(delays),
    });

    const result = await client.askNoul("STATE", Q);
    expect(result.attempts).toBe(3);
    expect(delays).toEqual([500, 1000]);
  });

  it.each([500, 502, 503, 504])("5xx (%d) は再試行対象", async (status) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = makeScriptedFetch([{ status }, { status: 200, body: okBody() }], calls);
    const client = createJevClient({
      apiKey: "k",
      model: "m",
      fetch: fetchFn,
      sleep: instantSleep([]),
    });

    const result = await client.askNoul("STATE", Q);
    expect(result.attempts).toBe(2);
  });

  it("ネットワークエラーは再試行し、上限で JevUnavailableError", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const client = createJevClient({
      apiKey: "k",
      model: "m",
      fetch: fetchFn,
      maxRetries: 2,
      sleep: instantSleep([]),
    });

    await expect(client.askNoul("STATE", Q)).rejects.toBeInstanceOf(JevUnavailableError);
    // 初回 + maxRetries(2) = 3 回試行
    expect(calls).toHaveLength(3);
  });

  it("タイムアウト (AbortController) はネットワークエラーと同様に再試行対象", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as typeof fetch;
    const client = createJevClient({
      apiKey: "k",
      model: "m",
      fetch: fetchFn,
      maxRetries: 1,
      timeoutMs: 10,
      sleep: instantSleep([]),
    });

    await expect(client.askNoul("STATE", Q)).rejects.toBeInstanceOf(JevUnavailableError);
    expect(calls).toHaveLength(2);
  });

  it("リトライ上限 (既定 maxRetries=3 → 最大4回試行) を超えると JevUnavailableError", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = makeScriptedFetch(
      Array.from({ length: 4 }, () => ({ status: 503 }) as ScriptEntry),
      calls
    );
    const client = createJevClient({
      apiKey: "k",
      model: "m",
      fetch: fetchFn,
      sleep: instantSleep([]),
    });

    await expect(client.askNoul("STATE", Q)).rejects.toThrow(/リトライ上限/);
    expect(calls).toHaveLength(4);
  });

  it("それ以外の 4xx (例: 400) は再試行せず即座に JevUnavailableError", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = makeScriptedFetch(
      [{ status: 400, body: { error: "invalid_request", message: "bad model" } }],
      calls
    );
    const client = createJevClient({
      apiKey: "k",
      model: "m",
      fetch: fetchFn,
      sleep: instantSleep([]),
    });

    const err = await client.askNoul("STATE", Q).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JevUnavailableError);
    expect((err as JevUnavailableError).status).toBe(400);
    expect((err as Error).message).toContain("bad model");
    expect(calls).toHaveLength(1);
  });

  it("401 (認証エラー) も即座に JevUnavailableError", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = makeScriptedFetch([{ status: 401, body: { error: "unauthorized" } }], calls);
    const client = createJevClient({
      apiKey: "k",
      model: "m",
      fetch: fetchFn,
      sleep: instantSleep([]),
    });

    await expect(client.askNoul("STATE", Q)).rejects.toBeInstanceOf(JevUnavailableError);
    expect(calls).toHaveLength(1);
  });
});

describe("createJevClient askNoul — 応答の検査 (既定値で埋めない)", () => {
  it("不正な JSON 応答は JevUnavailableError", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = makeScriptedFetch([{ status: 200, rawText: "not json{" }], calls);
    const client = createJevClient({
      apiKey: "k",
      model: "m",
      fetch: fetchFn,
      sleep: instantSleep([]),
    });

    await expect(client.askNoul("STATE", Q)).rejects.toBeInstanceOf(JevUnavailableError);
  });

  it("依頼した questionId の回答が欠けていたら JevUnavailableError", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = makeScriptedFetch([{ status: 200, body: okBody({ answers: {} }) }], calls);
    const client = createJevClient({
      apiKey: "k",
      model: "m",
      fetch: fetchFn,
      sleep: instantSleep([]),
    });

    await expect(client.askNoul("STATE", Q)).rejects.toThrow(/回答がありません/);
  });

  it("noul 型でない応答 (type 不一致) は JevUnavailableError", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = makeScriptedFetch(
      [{ status: 200, body: okBody({ answers: { "bt.a": { type: "choice", choice: "x" } } }) }],
      calls
    );
    const client = createJevClient({
      apiKey: "k",
      model: "m",
      fetch: fetchFn,
      sleep: instantSleep([]),
    });

    await expect(client.askNoul("STATE", Q)).rejects.toBeInstanceOf(JevUnavailableError);
  });

  it("noul が 0..1 の範囲外なら JevUnavailableError", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = makeScriptedFetch(
      [{ status: 200, body: okBody({ answers: { "bt.a": { type: "noul", noul: 1.5 } } }) }],
      calls
    );
    const client = createJevClient({
      apiKey: "k",
      model: "m",
      fetch: fetchFn,
      sleep: instantSleep([]),
    });

    await expect(client.askNoul("STATE", Q)).rejects.toBeInstanceOf(JevUnavailableError);
  });

  it("複数質問のうち 1 つでも欠落・範囲外があれば全体を throw する (部分成功として返さない)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = makeScriptedFetch(
      [
        {
          status: 200,
          body: okBody({
            answers: {
              "bt.a": { type: "noul", noul: 0.9 },
              "bt.b": { type: "noul", noul: -0.1 },
            },
          }),
        },
      ],
      calls
    );
    const client = createJevClient({
      apiKey: "k",
      model: "m",
      fetch: fetchFn,
      sleep: instantSleep([]),
    });

    await expect(
      client.askNoul("STATE", { "bt.a": Q["bt.a"] as JevNoulQuestion, "bt.b": { instructions: "b" } })
    ).rejects.toBeInstanceOf(JevUnavailableError);
  });
});
