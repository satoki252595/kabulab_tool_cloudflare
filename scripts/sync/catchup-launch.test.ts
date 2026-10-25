import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCatchupCodeLease, assertCatchupInvocation, installCatchupDeadline } from "./catchup-launch.js";
import { CATCHUP_JOIN_CUTOFF_TIME, CATCHUP_COMPLETION_CUTOFF_TIME } from "../../src/scheduler/stock.js";
import { currentScheduledDeadline } from "../../src/shared/scheduled-admission.js";

const date = "2026-10-14";
const now = Date.parse(`${date}T10:00:10Z`);
const event = (target: unknown = "scheduled-catchup", scheduled_date: unknown = date, scheduled_at: unknown = target === "scheduled-catchup" ? `${date}T10:00:10.000Z` : undefined) => ({
  inputs: scheduled_at === undefined ? { target, scheduled_date } : { target, scheduled_date, scheduled_at },
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("event ref/SHA・取得済main・実checkoutの同一leaseだけ通す", () => {
  const head = "049e39a44819f1ea72ac5c47ab0b91991c38cd2a";
  expect(() => assertCatchupCodeLease("refs/heads/main", head, `${head}\n${head}`)).not.toThrow();
  for (const [ref, sha, revisions] of [["refs/heads/other", head, `${head}\n${head}`], ["refs/heads/main", undefined, `${head}\n${head}`], ["refs/heads/main", head, head], ["refs/heads/main", head, `${head}\n${"0".repeat(40)}`]]) {
    expect(() => assertCatchupCodeLease(ref, sha, revisions!)).toThrow("revision");
  }
});

it("絶対締切は元signal/bodyを保持し期限後の全attemptをnative送信前に拒否する", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const native = vi.fn(async (_input: unknown, init?: RequestInit) => {
    init?.signal?.throwIfAborted(); return new Response("preserved");
  });
  vi.stubGlobal("fetch", native);
  const restore = installCatchupDeadline(now + 1000);
  try {
    expect(currentScheduledDeadline()?.deadline).toBe(now + 1000);
    const original = new AbortController();
    const response = await fetch("https://api.notion.com/v1/pages", { method: "POST", body: "physical-original", signal: original.signal });
    expect(await response.text()).toBe("preserved");
    expect(native.mock.calls[0][1]?.body).toBe("physical-original");
    const received = native.mock.calls[0][1]?.signal;
    expect(received).not.toBe(original.signal);
    original.abort(new Error("original-abort"));
    expect(received?.aborted).toBe(true);
    await expect(fetch("https://api.notion.com/v1/pages", { signal: original.signal })).rejects.toThrow("original-abort");
    const requestController = new AbortController();
    const request = new Request("https://api.notion.com/v1/pages", { signal: requestController.signal });
    await fetch(request);
    requestController.abort();
    expect(native.mock.calls[2][1]?.signal?.aborted).toBe(true);
    const count = native.mock.calls.length;
    vi.setSystemTime(now + 1000);
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) await expect(fetch("https://api.notion.com/v1/pages", { method })).rejects.toThrow("絶対締切");
    expect(native).toHaveBeenCalledTimes(count);
  } finally { restore(); }
  expect(currentScheduledDeadline()).toBeUndefined();
});

it("待機中fetchへ絶対signalを届け、native再送しない", async () => {
  const native = vi.fn(async (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }));
  vi.stubGlobal("fetch", native);
  const clock = Date.now();
  const restore = installCatchupDeadline(clock + 30);
  try {
    // AbortSignal.timeout自体はunref。テストだけalive handleを持つ。
    const alive = setTimeout(() => {}, 1000);
    try { await expect(fetch("https://api.notion.com/v1/pages")).rejects.toThrow(); }
    finally { clearTimeout(alive); }
    expect(native).toHaveBeenCalledTimes(1);
  } finally { restore(); }
});

it("実fetchのheaders受信後に止まったbodyも絶対締切で中断する（localhostのみ）", async () => {
  const server = createServer((_request, response) => { response.writeHead(200); response.write("original-partial"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("local wire address不正");
  const clock = Date.now();
  const restore = installCatchupDeadline(clock + 200);
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}`);
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
  } finally { restore(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

describe("catchup取得前の起動資格", () => {
  it("6境界:初回19時/5分境界と後続19:53を分け、最早外部終了19:54より前に閉じる", () => {
    const floor = Date.parse(`${date}T10:00:00Z`);
    const cutoff = Date.parse(`${date}T${CATCHUP_JOIN_CUTOFF_TIME}`);
    const initial = (scheduledMs: number, nowMs = scheduledMs) => assertCatchupInvocation("all", "workflow_dispatch", event("scheduled-catchup", date, new Date(scheduledMs).toISOString()), nowMs);
    expect(() => initial(floor - 1)).toThrow();
    expect(() => initial(floor)).not.toThrow();
    expect(() => initial(floor + 5 * 60_000)).not.toThrow();
    expect(() => initial(floor + 5 * 60_000 + 1)).toThrow();
    expect(() => initial(floor, floor + 5 * 60_000 + 1)).not.toThrow();
    expect(() => initial(floor, floor + 19 * 60_000)).not.toThrow();
    expect(assertCatchupInvocation("edinet", "workflow_dispatch", event(), cutoff - 1)).toBe(cutoff);
    expect(() => assertCatchupInvocation("edinet", "workflow_dispatch", event(), cutoff)).toThrow();
    const yml = readFileSync(new URL("../../.github/workflows/catchup.yml", import.meta.url), "utf8");
    const match = /timeout-minutes: \$\{\{ github.event.inputs.target == 'scheduled-catchup' && (\d+) \|\| (\d+) \}\}/.exec(yml);
    expect(match).not.toBeNull();
    const minutes = Number(match![1]);
    expect(cutoff).toBe(floor + 53 * 60_000);
    expect(cutoff + 60_000).toBe(floor + minutes * 60_000);
    expect(Date.parse(`${date}T${CATCHUP_COMPLETION_CUTOFF_TIME}`)).toBe(cutoff + 60_000);
    // job開始<=初回資格。最新許可資格をjob開始と置いても19:59がcancel上限。
    expect(floor + 5 * 60_000 + minutes * 60_000).toBe(Date.parse(`${date}T10:59:00Z`));
    expect(Number(match![2])).toBe(60);
    expect(assertCatchupInvocation("edinet", "workflow_dispatch", event("edinet", ""), Date.parse(`${date}T12:30:00Z`))).toBeUndefined();
  });
  it("定時両source/全体と従来手動を許可し、他sourceへ切替しない", () => {
    for (const part of ["all", "tdnet", "edinet"] as const) {
      expect(() => assertCatchupInvocation(part, "workflow_dispatch", event(), now)).not.toThrow();
      expect(() => assertCatchupInvocation(part, "workflow_dispatch", event("all", ""), now)).not.toThrow();
      expect(() => assertCatchupInvocation(part, undefined, undefined, now)).not.toThrow();
      expect(() => assertCatchupInvocation(part, "pull_request", undefined, now)).not.toThrow();
    }
    for (const part of ["tdnet", "edinet"] as const) {
      expect(() => assertCatchupInvocation("all", "workflow_dispatch", event(part, ""), now)).not.toThrow();
      expect(() => assertCatchupInvocation(part, "workflow_dispatch", event(part, ""), now)).not.toThrow();
    }
    expect(() => assertCatchupInvocation("edinet", "workflow_dispatch", event("tdnet"), now)).toThrow("一致");
  });
  it("旧schedule/欠落/未知target/無効日/週末/遅配/日跨ぎを拒否する", () => {
    expect(() => assertCatchupInvocation("all", "schedule", event(), now)).toThrow("旧catchup");
    for (const bad of [undefined, null, [], {}, { inputs: [] }, event("biztag"), event("unknown"), { inputs: { target: undefined } }, event("scheduled-catchup", "2026-02-30"), event("scheduled-catchup", "2026-10-17")]) {
      expect(() => assertCatchupInvocation("all", "workflow_dispatch", bad, now)).toThrow();
    }
    for (const clock of [NaN, now - 20_000, Date.parse(`${date}T10:53:00Z`), Date.parse("2026-10-15T10:00:00Z")]) {
      expect(() => assertCatchupInvocation("all", "workflow_dispatch", event(), clock)).toThrow();
    }
    expect(() => assertCatchupInvocation("edinet", "workflow_dispatch", event(), Date.parse(`${date}T10:52:59.999Z`))).not.toThrow();
    expect(() => assertCatchupInvocation("all", "workflow_dispatch", event(), Date.parse(`${date}T10:05:00.001Z`))).not.toThrow();
    expect(() => assertCatchupInvocation("all", "workflow_dispatch", event("scheduled-catchup", date, `${date}T10:05:00.001Z`), Date.parse(`${date}T10:05:00.001Z`))).toThrow();
  });
  it("実TDnet CLIの旧scheduleはsource/configより前に停止する", () => {
    const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/sync/ir-tdnet.ts"], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, GITHUB_EVENT_NAME: "schedule" }, encoding: "utf8", timeout: 10_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("旧catchup schedule");
    expect(child.stderr).not.toContain("CLOUDFLARE_API_TOKEN");
  });
});

it("CF専用入口は旧scheduleなし/main固定/定時54分・手動60分/独立source/Linuxbiztag skipを維持する", () => {
  const yml = readFileSync(new URL("../../.github/workflows/catchup.yml", import.meta.url), "utf8");
  expect(yml).not.toMatch(/^ {2}schedule:/m);
  expect(yml).toContain("- scheduled-catchup");
  expect(yml).toContain("ref: main");
  expect(yml).toContain("timeout-minutes: ${{ github.event.inputs.target == 'scheduled-catchup' && 54 || 60 }}");
  expect(yml).toContain("group: catchup\n  cancel-in-progress: false");
  expect(yml).toContain("!cancelled() && github.event_name == 'workflow_dispatch'");
  expect(yml.indexOf("name: catchup起動資格")).toBeLessThan(yml.indexOf("name: D1 / Notion"));
  expect(yml.indexOf("name: ir-catalog TDnet catchup")).toBeLessThan(yml.indexOf("name: yuho-quant EDINET catchup"));
  const biztag = yml.slice(yml.indexOf("  biztag:\n"));
  expect(biztag).not.toContain("scheduled-catchup");
  expect(biztag).toContain("exit 1");
});

it("TDnet失敗でEDINETをskipせず、共通資格失敗・取消では取得しない", () => {
  const yml = readFileSync(new URL("../../.github/workflows/catchup.yml", import.meta.url), "utf8");
  const admission = yml.slice(yml.indexOf("      - name: catchup起動資格"), yml.indexOf("      # 006 TDnet"));
  expect(admission).toContain("id: admission");
  expect(admission).toContain("id: storage");
  const edinet = yml.slice(yml.indexOf("      - name: yuho-quant EDINET catchup"), yml.indexOf("      # 定期ジョブ"));
  const condition = /if: >-\n([\s\S]*?)\n {8}run:/.exec(edinet)![1].trim().replaceAll(/\s+/g, " ");
  expect(condition).toBe("!cancelled() && steps.admission.outcome == 'success' && steps.storage.outcome == 'success' && github.event_name == 'workflow_dispatch' && (github.event.inputs.target == 'edinet' || github.event.inputs.target == 'all' || github.event.inputs.target == 'scheduled-catchup')");
  // 状態関数を含むためGitHubの暗黙success()が付かない。先行失敗を隠す設定も追加しない。
  expect(yml).not.toContain("continue-on-error:");
  expect(yml).toContain("if: failure()");
  expect(yml).not.toContain("Mac LaunchAgent");
  expect(yml).toContain("docs/mac-monthly-manual.md");
});
