/**
 * 記録再生 jev クライアント (recorded.ts) のテスト。
 *
 * CLAUDE.md ルール1 (ダミーデータ禁止) の機械的強制: 記録に無い
 * (state, questionId) は既定値へフォールバックせず必ず throw する。
 */
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../sha256.js";
import { createRecordedJevClient, jevRecordingKey } from "./recorded.js";

describe("createRecordedJevClient", () => {
  it("記録済みの state/questionId には noul 確率をそのまま返す", async () => {
    const state = "銘柄コード: 1234\n事業の内容: 半導体パッケージ材料を製造する。";
    const stateHash = await sha256Hex(state);
    const recordings = {
      [jevRecordingKey(stateHash, "bt.a")]: 0.93,
      [jevRecordingKey(stateHash, "bt.b")]: 0.12,
    };
    const client = createRecordedJevClient(recordings, "jev-2026-09-recorded");

    const result = await client.askNoul(state, {
      "bt.a": { instructions: "instr-a" },
      "bt.b": { instructions: "instr-b" },
    });

    expect(result).toEqual({
      model: "jev-2026-09-recorded",
      answers: { "bt.a": 0.93, "bt.b": 0.12 },
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      attempts: 1,
    });
  });

  it("記録に無い組み合わせは throw する (既定値で埋めない)", async () => {
    const state = "銘柄コード: 5678\n事業の内容: 精密機械部品を製造する。";
    const stateHash = await sha256Hex(state);
    const recordings = { [jevRecordingKey(stateHash, "bt.a")]: 0.5 };
    const client = createRecordedJevClient(recordings, "jev-2026-09-recorded");

    await expect(
      client.askNoul(state, { "bt.b": { instructions: "instr-b" } })
    ).rejects.toThrow(/記録にない/);
  });

  it("state が違えばハッシュも変わり同じ questionId でも記録が見つからない", async () => {
    const stateA = "会社Aの事業の内容。";
    const stateB = "会社Bの事業の内容。";
    const hashA = await sha256Hex(stateA);
    const recordings = { [jevRecordingKey(hashA, "bt.a")]: 0.8 };
    const client = createRecordedJevClient(recordings, "jev-2026-09-recorded");

    await expect(client.askNoul(stateB, { "bt.a": { instructions: "x" } })).rejects.toThrow(
      /記録にない/
    );
  });

  it("questions が空なら Error (呼び出し側バグ)", async () => {
    const client = createRecordedJevClient({}, "jev-2026-09-recorded");
    await expect(client.askNoul("state", {})).rejects.toThrow("questions が空");
  });
});
