/** 合成入力・メモリR2境界のみ。モデル、業務API、実DBへ接続しない。 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHARED_WRITER_KEY, type PublishingStore } from "../../../../scripts/mechanical-publishing/shared-writer.js";
import { runMechanicalSummary } from "../../data-scripts/summary-mechanical.js";
import { type LocalDependencies } from "../../data-scripts/summary-local.js";
import { type ImportPlan } from "../../data-scripts/summary-import.js";
import { selectSummaryTasks, type BenefitRow } from "../../data-scripts/summary-tasks.js";

const dirs: string[] = [];
const cursorKey = "mechanical-publishing/v1/cursors/yutai-summary.json";
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function state() {
  const path = mkdtempSync(join(tmpdir(), "yutai-mechanical-unit-")); dirs.push(path); return path;
}
function row(id: number, description = "QUOカード 3,000円分"): BenefitRow {
  return { id, stockId: id, stockCode: String(9000 + id), stockName: "合成テスト社", description,
    shortSummary: null, estimatedValue: null, estimateValueSource: null, minShares: 100,
    recordMonth: 3, recordDate: null, updatedAt: 1 };
}
function storeFixture() {
  let version = 1;
  const values = new Map([[SHARED_WRITER_KEY, { etag: "1", body: JSON.stringify({ version: 1,
    baselineSha256: "a".repeat(64), owner: null, pending: null }) + "\n" }]]);
  const events: string[] = [];
  const store: PublishingStore = {
    get: vi.fn(async (key, maxBytes) => {
      const found = values.get(key); if (!found) return null;
      expect(Buffer.byteLength(found.body)).toBeLessThanOrEqual(maxBytes); return found;
    }),
    put: vi.fn(async (key, body, etag) => {
      expect(values.get(key)?.etag ?? null).toBe(etag);
      values.set(key, { body, etag: String(++version) }); events.push(`put:${key}`);
    }),
  };
  return { store, values, events, current: () => JSON.parse(values.get(SHARED_WRITER_KEY)!.body) };
}
function dependencies(initial: BenefitRow[], events: string[]) {
  let rows = structuredClone(initial);
  const deps: LocalDependencies = {
    loadRows: vi.fn(async () => structuredClone(rows)),
    generate: vi.fn(async () => { throw new Error("model_must_not_start"); }),
    archive: vi.fn(async (_bytes, _clock, phase) => { events.push(`archive-${phase}`); }),
    apply: vi.fn(async (_rows: readonly BenefitRow[], plan: ImportPlan) => {
      events.push("apply");
      rows = rows.map(before => {
        const update = plan.updates.find(item => item.ids.includes(before.id));
        return update === undefined ? before : { ...before, shortSummary: update.shortSummary,
          estimatedValue: update.estimatedValue, estimateValueSource: update.estimateValueSource, updatedAt: 2 };
      });
    }),
  };
  return { deps, rows: () => rows };
}

describe("Linux mechanical summary / shared writer", () => {
  it("モデル許可・不正limitをdeps生成やR2取得より前に拒否する", async () => {
    const { store } = storeFixture(); const create = vi.fn(() => dependencies([], []).deps);
    for (const options of [{ limit: 60, allowModel: true }, { limit: 61 }, { limit: 0 }])
      await expect(runMechanicalSummary({ stateDir: state(), ...options }, create, store)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled(); expect(store.get).not.toHaveBeenCalled(); expect(store.put).not.toHaveBeenCalled();
  });
  it("PRE前にexact snapshotを予約し、物理POST完了後だけshared cursorとownerを閉鎖する", async () => {
    const memory = storeFixture(); const { deps, rows } = dependencies([row(1)], memory.events); const dir = state();
    const archive = deps.archive;
    deps.archive = vi.fn(async (...args: Parameters<LocalDependencies["archive"]>) => {
      const current = memory.current(); expect(current.owner).not.toBeNull();
      expect(current.pending.kind).toBe("yutai-summary");
      const saved = memory.values.get(`${current.pending.key}/request.json`)!.body;
      if (args[2] === "pre") expect(saved).toBe(gunzipSync(args[0]).toString("utf8"));
      await archive(...args);
    });
    expect(await runMechanicalSummary({ stateDir: dir, limit: 60 }, () => deps, memory.store)).toMatchObject({
      accepted: 1, pendingAfter: 0, modelCalls: 0, modelResidents: 0, deterministic: 1 });
    expect(deps.generate).not.toHaveBeenCalled(); expect(rows()[0]).toMatchObject({ shortSummary: "QUOカード 3,000円分", estimatedValue: 3000 });
    const completed = memory.events.findIndex(event => event.endsWith("/completed.json"));
    expect(memory.events.indexOf("archive-pre")).toBeLessThan(memory.events.indexOf("apply"));
    expect(memory.events.indexOf("archive-post")).toBeLessThan(completed);
    expect(completed).toBeLessThan(memory.events.indexOf(`put:${cursorKey}`));
    expect(memory.current()).toMatchObject({ owner: null, pending: null });
    expect(memory.values.get(cursorKey)!.body).toBe(readFileSync(join(dir, "progress.json"), "utf8"));
    expect(readdirSync(dir)).not.toContain("pending-write.json");
  });
  it("未対応HOLDもmodel0・旧値維持で閉鎖し、別hostの古いcursorより共有cursorを優先する", async () => {
    const memory = storeFixture(); const initial = [row(1, "合成商品から選択・条件不明"), row(2, "合成商品から選択・条件不明")];
    const { deps, rows } = dependencies(initial, memory.events); const tasks = selectSummaryTasks(initial);
    expect(await runMechanicalSummary({ stateDir: state(), limit: 1 }, () => deps, memory.store)).toMatchObject({
      accepted: 0, held: 1, outcome: "partial_rejection", modelCalls: 0, modelResidents: 0 });
    const nextHost = state(); writeFileSync(join(nextHost, "progress.json"), JSON.stringify({ cursor: tasks[1].taskId }), { mode: 0o600 });
    expect(await runMechanicalSummary({ stateDir: nextHost, limit: 1 }, () => deps, memory.store)).toMatchObject({ held: 1 });
    expect(JSON.parse(memory.values.get(cursorKey)!.body)).toEqual({ cursor: tasks[1].taskId });
    const run = readdirSync(nextHost).find(name => name !== "progress.json")!;
    expect(readFileSync(join(nextHost, run, "tasks.jsonl"), "utf8")).toContain(tasks[1].taskId);
    expect(rows()).toEqual(initial); expect(deps.apply).not.toHaveBeenCalled(); expect(deps.generate).not.toHaveBeenCalled();
    expect(memory.events.filter(event => event === "archive-post")).toHaveLength(2);
  });
  it("予約前の純read失敗だけownerを閉じ、次hostの通常処理を許可する", async () => {
    const memory = storeFixture(); const { deps } = dependencies([row(1)], memory.events); const loadRows = deps.loadRows;
    deps.loadRows = vi.fn(async () => { throw new Error("read_failed"); });
    await expect(runMechanicalSummary({ stateDir: state(), limit: 60 }, () => deps, memory.store)).rejects.toThrow();
    expect(memory.current()).toMatchObject({ owner: null, pending: null });
    expect(deps.archive).not.toHaveBeenCalled(); expect(deps.apply).not.toHaveBeenCalled();
    deps.loadRows = loadRows;
    expect(await runMechanicalSummary({ stateDir: state(), limit: 60 }, () => deps, memory.store)).toMatchObject({ accepted: 1 });
  });
  it.each(["pre", "apply", "post-read", "post", "cursor"] as const)("%s結果不明はowner/local pendingを残し、別hostの再送を止める", async failure => {
    const memory = storeFixture(); const { deps } = dependencies([row(1)], memory.events); const dir = state();
    if (failure === "apply") deps.apply = vi.fn(async () => { throw new Error("unknown_apply"); });
    if (failure === "post-read") {
      const loadRows = deps.loadRows; let reads = 0;
      deps.loadRows = vi.fn(async () => { if (++reads === 3) throw new Error("unknown_post_read"); return loadRows(); });
    }
    if (failure === "pre" || failure === "post") {
      const archive = deps.archive;
      deps.archive = vi.fn(async (...args: Parameters<LocalDependencies["archive"]>) => { if (args[2] === failure) throw new Error("unknown_archive"); await archive(...args); });
    }
    if (failure === "cursor") {
      const put = memory.store.put;
      memory.store.put = vi.fn(async (...args: Parameters<PublishingStore["put"]>) => { await put(...args); if (args[0] === cursorKey) throw new Error("unknown_cursor"); });
    }
    const run = runMechanicalSummary({ stateDir: dir, limit: 60 }, () => deps, memory.store);
    if (failure === "post-read") await expect(run).rejects.toThrow();
    else await expect(run).rejects.toThrow("unknown_");
    expect(memory.current().owner).not.toBeNull(); expect(readdirSync(dir)).toContain("pending-write.json");
    if (failure !== "cursor") expect(memory.current().pending.kind).toBe("yutai-summary");
    const create = vi.fn(() => deps);
    await expect(runMechanicalSummary({ stateDir: state(), limit: 60 }, create, memory.store)).rejects.toThrow("未閉鎖");
    expect(create).not.toHaveBeenCalled(); expect(deps.generate).not.toHaveBeenCalled();
  });
});

it("expired batch admission stops before owner/deps; an already admitted atomic batch closes after soft", async () => {
  vi.useFakeTimers(); const start = Date.parse("2026-10-25T19:17:00.000Z"); vi.setSystemTime(start);
  const memory = storeFixture(), { deps } = dependencies([row(1)], memory.events), create = vi.fn(() => deps);
  await expect(runMechanicalSummary({ stateDir: state(), limit: 60, sourceDeadlineMs: start }, create, memory.store))
    .rejects.toThrow("start_deadline");
  expect(create).not.toHaveBeenCalled(); expect(memory.store.get).not.toHaveBeenCalled();
  const archive = deps.archive; deps.archive = vi.fn(async (...args: Parameters<LocalDependencies["archive"]>) => {
    vi.setSystemTime(start + 60_001); await archive(...args);
  });
  expect(await runMechanicalSummary({ stateDir: state(), limit: 60, sourceDeadlineMs: start + 60_000 }, create, memory.store))
    .toMatchObject({ accepted: 1, modelCalls: 0 });
  expect(memory.current()).toMatchObject({ owner: null, pending: null });
});
