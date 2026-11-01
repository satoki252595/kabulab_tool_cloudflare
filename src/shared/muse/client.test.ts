/**
 * muse クライアント (src/shared/muse/client.ts) のテスト。
 * 実際の muse CLI は起動しない — `spawnFn` を偽の子プロセスに差し替える。
 *
 * - 成功時は questionId ごとの確率を返し、attempts=1・トークンは0 (非計測)
 * - 非0終了・起動失敗・タイムアウトは有界リトライ後に MuseUnavailableError
 * - JSON として解釈できない・質問idの過不足・値域外の応答はリトライせず即座に throw
 * - シェルを介さない (spawnFn には常にコマンドと引数配列が渡る)
 * - 質問0件は呼び出し側の実装ミスとして Error
 */
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMuseClient, MuseUnavailableError } from "./client.js";
import type { JevNoulQuestion } from "../jev/client.js";

interface Call {
  command: string;
  args: string[];
  cwd: string;
  promptContent: string;
  schemaContent: unknown;
}

/** イベントベースの偽子プロセス。stdout/stderr は EventEmitter、kill は呼び出しを記録するだけ。 */
function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (signal?: string) => boolean;
    killed: boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = (): boolean => {
    child.killed = true;
    return true;
  };
  return child;
}

type Behavior =
  | { kind: "success"; stdout: string }
  | { kind: "exit_error"; code: number; stderr?: string }
  | { kind: "spawn_throw"; message: string }
  | { kind: "hang" }; // タイムアウトを起こす (close/error を発行しない)

/** `behaviors` を呼び出し順に1つずつ消費する偽 spawn。呼び出しごとの引数・渡されたファイルの中身を記録する。 */
function makeScriptedSpawn(behaviors: Behavior[], calls: Call[]) {
  let i = 0;
  return ((command: string, args: string[], options: { cwd: string }) => {
    const behavior = behaviors[Math.min(i, behaviors.length - 1)];
    i++;

    const schemaPathIdx = args.indexOf("--output-schema") + 1;
    const promptPathIdx = args.indexOf("--prompt-file") + 1;
    const schemaPath = args[schemaPathIdx];
    const promptPath = args[promptPathIdx];
    calls.push({
      command,
      args,
      cwd: options.cwd,
      promptContent: readFileSync(promptPath, "utf-8"),
      schemaContent: JSON.parse(readFileSync(schemaPath, "utf-8")),
    });

    if (behavior.kind === "spawn_throw") {
      throw new Error(behavior.message);
    }

    const child = makeFakeChild();
    queueMicrotask(() => {
      if (behavior.kind === "success") {
        child.stdout.emit("data", Buffer.from(behavior.stdout));
        child.emit("close", 0);
      } else if (behavior.kind === "exit_error") {
        if (behavior.stderr) child.stderr.emit("data", Buffer.from(behavior.stderr));
        child.emit("close", behavior.code);
      }
      // "hang" は何も発行しない (タイムアウトで回収される)。
    });
    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  }) as typeof import("node:child_process").spawn;
}

const Q: Record<string, JevNoulQuestion> = {
  "cp.7203": { instructions: "Does B compete with A?", criteria: { true: "same market", false: "supplier" } },
  "cp.9101": { instructions: "Does B compete with A?" },
};

describe("createMuseClient askNoul — 正常系", () => {
  it("成功時は questionId ごとの確率を返し、attempts=1・トークンは0 (非計測)", async () => {
    const calls: Call[] = [];
    const spawnFn = makeScriptedSpawn([{ kind: "success", stdout: '{"cp.7203":0.9,"cp.9101":0.1}' }], calls);
    const client = createMuseClient({ binPath: "/fake/muse", spawnFn, now: () => 0 });

    const result = await client.askNoul("会社Aの状態", Q);

    expect(result.answers).toEqual({ "cp.7203": 0.9, "cp.9101": 0.1 });
    expect(result.model).toBe("muse-spark-1.3-contributor@max");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.attempts).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("シェルを介さず、コマンド本体と引数配列を直接渡す (プロンプトはファイル経由)", async () => {
    const calls: Call[] = [];
    const spawnFn = makeScriptedSpawn([{ kind: "success", stdout: '{"cp.7203":0.5,"cp.9101":0.5}' }], calls);
    const client = createMuseClient({ binPath: "/fake/muse", spawnFn });

    await client.askNoul("会社Aの状態抜粋", Q);

    expect(calls[0].command).toBe("/fake/muse");
    expect(calls[0].args).toEqual([
      "exec",
      "--model",
      "muse-spark-1.3-contributor",
      "--reasoning-effort",
      "max",
      "--output-schema",
      expect.stringContaining("schema.json"),
      "--prompt-file",
      expect.stringContaining("prompt.txt"),
    ]);
    expect(calls[0].promptContent).toContain("会社Aの状態抜粋");
    expect(calls[0].promptContent).toContain("cp.7203");
    expect(calls[0].promptContent).toContain("Does B compete with A?");
    // 一時ディレクトリ (cwd) は毎回新規に作られる (workspace untrusted に入るため)。
    expect(calls[0].cwd).not.toBe(process.cwd());
  });

  it("出力スキーマは依頼した質問idを過不足なく number[0,1] で要求する", async () => {
    const calls: Call[] = [];
    const spawnFn = makeScriptedSpawn([{ kind: "success", stdout: '{"cp.7203":0.5,"cp.9101":0.5}' }], calls);
    const client = createMuseClient({ binPath: "/fake/muse", spawnFn });

    await client.askNoul("state", Q);

    const schema = calls[0].schemaContent as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { type: string; minimum: number; maximum: number }>;
    };
    expect(schema.required.sort()).toEqual(["cp.7203", "cp.9101"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties["cp.7203"]).toEqual({ type: "number", minimum: 0, maximum: 1 });
  });
});

describe("createMuseClient askNoul — プロセス失敗はリトライ", () => {
  it("非0終了は有界リトライし、途中で成功すれば attempts に反映する", async () => {
    const calls: Call[] = [];
    const spawnFn = makeScriptedSpawn(
      [
        { kind: "exit_error", code: 1, stderr: "boom" },
        { kind: "success", stdout: '{"cp.7203":0.7,"cp.9101":0.3}' },
      ],
      calls
    );
    const client = createMuseClient({ binPath: "/fake/muse", spawnFn, maxRetries: 2, timeoutMs: 1000 });

    const result = await client.askNoul("state", Q);

    expect(result.answers).toEqual({ "cp.7203": 0.7, "cp.9101": 0.3 });
    expect(result.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it("リトライ上限に達しても失敗し続けたら MuseUnavailableError", async () => {
    const calls: Call[] = [];
    const spawnFn = makeScriptedSpawn([{ kind: "exit_error", code: 1, stderr: "boom" }], calls);
    const client = createMuseClient({ binPath: "/fake/muse", spawnFn, maxRetries: 2, timeoutMs: 1000 });

    await expect(client.askNoul("state", Q)).rejects.toThrow(MuseUnavailableError);
    expect(calls).toHaveLength(3); // 初回 + リトライ2回
  });

  it("起動失敗 (spawn 自体が throw) も有界リトライ対象", async () => {
    const calls: Call[] = [];
    const spawnFn = makeScriptedSpawn(
      [
        { kind: "spawn_throw", message: "ENOENT" },
        { kind: "success", stdout: '{"cp.7203":0.2,"cp.9101":0.8}' },
      ],
      calls
    );
    const client = createMuseClient({ binPath: "/does/not/exist", spawnFn, maxRetries: 2, timeoutMs: 1000 });

    const result = await client.askNoul("state", Q);
    expect(result.attempts).toBe(2);
  });

  it("タイムアウトは有界リトライ対象", async () => {
    const calls: Call[] = [];
    const spawnFn = makeScriptedSpawn(
      [{ kind: "hang" }, { kind: "success", stdout: '{"cp.7203":0.6,"cp.9101":0.4}' }],
      calls
    );
    const client = createMuseClient({ binPath: "/fake/muse", spawnFn, maxRetries: 2, timeoutMs: 20 });

    const result = await client.askNoul("state", Q);
    expect(result.attempts).toBe(2);
  }, 10_000);
});

describe("createMuseClient askNoul — 応答内容の不備はリトライせず即座に throw", () => {
  it("JSON として解釈できない応答は1回で throw (プロセスは正常終了扱い)", async () => {
    const calls: Call[] = [];
    const spawnFn = makeScriptedSpawn([{ kind: "success", stdout: "not json" }], calls);
    const client = createMuseClient({ binPath: "/fake/muse", spawnFn, maxRetries: 2, timeoutMs: 1000 });

    await expect(client.askNoul("state", Q)).rejects.toThrow(MuseUnavailableError);
    expect(calls).toHaveLength(1);
  });

  it("質問idが欠けている応答は1回で throw", async () => {
    const calls: Call[] = [];
    const spawnFn = makeScriptedSpawn([{ kind: "success", stdout: '{"cp.7203":0.9}' }], calls);
    const client = createMuseClient({ binPath: "/fake/muse", spawnFn, maxRetries: 2, timeoutMs: 1000 });

    await expect(client.askNoul("state", Q)).rejects.toThrow(MuseUnavailableError);
    expect(calls).toHaveLength(1);
  });

  it("余分な質問idを含む応答は1回で throw (additionalProperties=false 相当を検証)", async () => {
    const calls: Call[] = [];
    const spawnFn = makeScriptedSpawn(
      [{ kind: "success", stdout: '{"cp.7203":0.9,"cp.9101":0.1,"cp.9999":0.5}' }],
      calls
    );
    const client = createMuseClient({ binPath: "/fake/muse", spawnFn, maxRetries: 2, timeoutMs: 1000 });

    await expect(client.askNoul("state", Q)).rejects.toThrow(MuseUnavailableError);
    expect(calls).toHaveLength(1);
  });

  it("値域外 (0..1 を超える) の応答は1回で throw", async () => {
    const calls: Call[] = [];
    const spawnFn = makeScriptedSpawn([{ kind: "success", stdout: '{"cp.7203":1.5,"cp.9101":0.1}' }], calls);
    const client = createMuseClient({ binPath: "/fake/muse", spawnFn, maxRetries: 2, timeoutMs: 1000 });

    await expect(client.askNoul("state", Q)).rejects.toThrow(MuseUnavailableError);
    expect(calls).toHaveLength(1);
  });
});

describe("createMuseClient askNoul — 呼び出し側のバグ", () => {
  it("questions が空ならプロセスを起動せず Error", async () => {
    const calls: Call[] = [];
    const spawnFn = makeScriptedSpawn([{ kind: "success", stdout: "{}" }], calls);
    const client = createMuseClient({ binPath: "/fake/muse", spawnFn });

    await expect(client.askNoul("state", {})).rejects.toThrow("questions が空です");
    expect(calls).toHaveLength(0);
  });
});

describe("createMuseClient — 一時ディレクトリの後始末", () => {
  it("実行後に一時ディレクトリを削除する", async () => {
    let capturedCwd = "";
    const calls: Call[] = [];
    const spawnFn = makeScriptedSpawn([{ kind: "success", stdout: '{"cp.7203":0.5,"cp.9101":0.5}' }], calls);
    const wrapped = ((command: string, args: string[], options: { cwd: string }) => {
      capturedCwd = options.cwd;
      return spawnFn(command, args, options);
    }) as typeof spawnFn;
    const client = createMuseClient({ binPath: "/fake/muse", spawnFn: wrapped });

    await client.askNoul("state", Q);

    const { existsSync } = await import("node:fs");
    expect(existsSync(capturedCwd)).toBe(false);
  });
});
