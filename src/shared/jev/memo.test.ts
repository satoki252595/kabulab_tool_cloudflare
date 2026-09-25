import { describe, expect, it, vi } from "vitest";
import type { JevAskResult, JevClient, JevNoulQuestion } from "./client.js";
import { createMemoizedJevClient } from "./memo.js";

const q = (instructions: string): JevNoulQuestion => ({ instructions });

/** 呼ばれた順に回答を変える (jev の揺れを模す) 元クライアント。 */
function wobblyInner(): JevClient & { askNoul: ReturnType<typeof vi.fn> } {
  let call = 0;
  return {
    askNoul: vi.fn(async (_state: string, questions: Record<string, JevNoulQuestion>): Promise<JevAskResult> => {
      call += 1;
      const answers: Record<string, number> = {};
      for (const qid of Object.keys(questions)) answers[qid] = call === 1 ? 0.25 : 0.33;
      return { model: "jev-1.13.0", answers, inputTokens: 100, outputTokens: 0, latencyMs: 5, attempts: 1 };
    }),
  };
}

describe("createMemoizedJevClient", () => {
  it("同じ state・同じ質問は 2 回目以降 jev を呼ばず同じ回答を返す", async () => {
    const inner = wobblyInner();
    const client = createMemoizedJevClient(inner);
    const first = await client.askNoul("抜粋", { "bt.A": q("def A") });
    const second = await client.askNoul("抜粋", { "bt.A": q("def A") });
    expect(second.answers["bt.A"]).toBe(first.answers["bt.A"]);
    expect(inner.askNoul).toHaveBeenCalledTimes(1);
    expect(second.inputTokens).toBe(0);
    expect(second.attempts).toBe(0);
  });

  it("メモに無い問いだけをまとめて問い合わせる", async () => {
    const inner = wobblyInner();
    const client = createMemoizedJevClient(inner);
    await client.askNoul("抜粋", { "bt.A": q("def A") });
    const r = await client.askNoul("抜粋", { "bt.A": q("def A"), "bt.B": q("def B") });
    expect(inner.askNoul).toHaveBeenCalledTimes(2);
    expect(Object.keys(inner.askNoul.mock.calls[1][1])).toEqual(["bt.B"]);
    expect(r.answers).toEqual({ "bt.A": 0.25, "bt.B": 0.33 });
  });

  it("state が違えば別の問いとして問い直す", async () => {
    const inner = wobblyInner();
    const client = createMemoizedJevClient(inner);
    await client.askNoul("抜粋1", { "bt.A": q("def A") });
    await client.askNoul("抜粋2", { "bt.A": q("def A") });
    expect(inner.askNoul).toHaveBeenCalledTimes(2);
  });

  it("定義文が変われば同じ questionId でも問い直す (古い回答を流用しない)", async () => {
    const inner = wobblyInner();
    const client = createMemoizedJevClient(inner);
    await client.askNoul("抜粋", { "bt.A": q("def A") });
    const r = await client.askNoul("抜粋", { "bt.A": q("def A (改訂)") });
    expect(inner.askNoul).toHaveBeenCalledTimes(2);
    expect(r.answers["bt.A"]).toBe(0.33);
  });

  it("元クライアントの失敗はそのまま投げ、メモに何も残さない", async () => {
    const inner: JevClient = { askNoul: vi.fn(async () => Promise.reject(new Error("jev down"))) };
    const client = createMemoizedJevClient(inner);
    await expect(client.askNoul("抜粋", { "bt.A": q("def A") })).rejects.toThrow("jev down");
    await expect(client.askNoul("抜粋", { "bt.A": q("def A") })).rejects.toThrow("jev down");
    expect(inner.askNoul).toHaveBeenCalledTimes(2);
  });

  it("空の questions は実装ミスとして throw する", async () => {
    const client = createMemoizedJevClient(wobblyInner());
    await expect(client.askNoul("抜粋", {})).rejects.toThrow("questions が空");
  });
});
