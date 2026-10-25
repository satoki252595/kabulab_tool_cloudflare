/** 合成入力・メモリR2境界のみ。モデル、業務API、実DBへ接続しない。 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { SHARED_WRITER_KEY, withSharedPublishingWriter, type PublishingStore } from "../../../../scripts/mechanical-publishing/shared-writer.js";
import * as publishing from "../../../../scripts/mechanical-publishing/shared-writer.js";
import * as d1 from "../../../../src/shared/db/d1-http-client.js";
import * as runtime from "../../../../scripts/biztag-local/runtime.js";
import { runMechanicalSummary } from "../../data-scripts/summary-mechanical.js";
import { main as runLocalCli, parseLocalArgs, readReviewedInput, runLocalSummary, type LocalDependencies, type LocalOptions } from "../../data-scripts/summary-local.js";
import { type ImportPlan } from "../../data-scripts/summary-import.js";
import { selectSummaryTasks, type BenefitRow } from "../../data-scripts/summary-tasks.js";

const dirs: string[] = [];
const cursorKey = "mechanical-publishing/v1/cursors/yutai-summary.json";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
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
          estimatedValue: update.estimatedValue, estimateValueSource: update.estimateValueSource, updatedAt: before.updatedAt + 1 };
      });
    }),
  };
  return { deps, rows: () => rows };
}

describe("Linux mechanical summary / shared writer", () => {
  it("モデル許可・不正limitをdeps生成やR2取得より前に拒否する", async () => {
    const { store } = storeFixture(); const create = vi.fn(() => dependencies([], []).deps);
    for (const options of [{ limit: 60, allowModel: true }, { limit: 61 }, { limit: 0 },
      { limit: 1, reviewedInput: { tasks: "unread", tasksSha256: "a".repeat(64), results: "unread", resultsSha256: "b".repeat(64) } }])
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

function reviewedOptions(initial: BenefitRow[], summary = "QUOカード3,000円分"): LocalOptions {
  const dir = realpathSync(state()), tasks = selectSummaryTasks(initial).slice(0, 1);
  const tasksText = JSON.stringify(tasks[0]) + "\n", resultsText = JSON.stringify({ taskId: tasks[0].taskId,
    contractVersion: tasks[0].contractVersion, shortSummary: summary, estimatedValue: 3000 }) + "\n";
  const tasksPath = join(dir, "tasks.jsonl"), resultsPath = join(dir, "results.jsonl");
  writeFileSync(tasksPath, tasksText, { mode: 0o600 }); writeFileSync(resultsPath, resultsText, { mode: 0o600 });
  return { stateDir: state(), limit: 1, reviewedInput: { tasks: tasksPath, results: resultsPath,
    tasksSha256: createHash("sha256").update(tasksText).digest("hex"), resultsSha256: createHash("sha256").update(resultsText).digest("hex") } };
}

function reviewedCliBoundary() {
  const options = reviewedOptions([row(1)]), files = options.reviewedInput!;
  const argv = ["--state-dir", options.stateDir, "--limit=1", "--reviewed-tasks", files.tasks,
    "--reviewed-tasks-sha256", files.tasksSha256, "--reviewed-results", files.results, "--reviewed-results-sha256", files.resultsSha256];
  for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID", "NOTION_TOKEN"]) vi.stubEnv(key, "controlled-test-credential");
  vi.stubEnv("NOTION_ARCHIVE_PAGE_ID", "0123456789abcdef0123456789abcdef"); vi.stubEnv("NOTION_MAX_RPS", undefined);
  const db = vi.spyOn(d1, "createD1HttpDb");
  const writer = vi.spyOn(publishing, "withSharedPublishingWriter").mockImplementation(async () => { throw new Error("test_writer_boundary"); });
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  return { argv, db, writer, fetch };
}

it.each(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID", "NOTION_TOKEN", "NOTION_ARCHIVE_PAGE_ID"])(
  "reviewed CLI missing %s stops before the shared owner or any fetch", async key => {
    const io = reviewedCliBoundary(); vi.stubEnv(key, "");
    await expect(runLocalCli(io.argv)).rejects.toThrow(key);
    expect(io.writer).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
  },
);
it.each(["invalid-id", "0", "2.7", "NaN"])("reviewed CLI invalid archive/pacing stops before owner (%s)", async value => {
  const io = reviewedCliBoundary(); vi.stubEnv(value === "invalid-id" ? "NOTION_ARCHIVE_PAGE_ID" : "NOTION_MAX_RPS", value);
  await expect(runLocalCli(io.argv)).rejects.toThrow(/Notion ID|Notion pacing|NOTION_MAX_RPS/);
  expect(io.writer).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
});
it("reviewed CLI rejects input SHA before constructing D1 or checking missing settings", async () => {
  const io = reviewedCliBoundary(); io.argv[io.argv.length - 1] = "0".repeat(64); vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  await expect(runLocalCli(io.argv)).rejects.toThrow("sha_mismatch");
  expect(io.db).not.toHaveBeenCalled(); expect(io.writer).not.toHaveBeenCalled(); expect(io.fetch).not.toHaveBeenCalled();
});
it("qualified reviewed CLI constructs dependencies without I/O before owner and needs no model/supplement settings", async () => {
  const io = reviewedCliBoundary();
  for (const key of ["NOTION_DB_STOCK_MASTER", "NOTION_YUHO_TEXT_DB_ID", "NOTION_STOCK_INFO_PAGE_ID", "NOTION_STOCK_SUPPLEMENT_DB_ID"]) vi.stubEnv(key, undefined);
  await expect(runLocalCli(io.argv)).rejects.toThrow("test_writer_boundary");
  expect(io.db).toHaveBeenCalledOnce(); expect(io.writer).toHaveBeenCalledOnce(); expect(io.fetch).not.toHaveBeenCalled();
});
it("normal local CLI keeps dependency creation after canonical runtime environment loading", async () => {
  const db = vi.spyOn(d1, "createD1HttpDb"), shared = vi.spyOn(publishing, "withSharedPublishingWriter"), fetch = vi.fn();
  vi.stubEnv("CLOUDFLARE_API_TOKEN", ""); vi.stubGlobal("fetch", fetch);
  const writer = vi.spyOn(runtime, "withBiztagWriter").mockImplementation(async () => { throw new Error("test_local_writer_boundary"); });
  await expect(runLocalCli(["--state-dir", state(), "--limit=1"])).rejects.toThrow("test_local_writer_boundary");
  expect(writer).toHaveBeenCalledOnce(); expect(db).not.toHaveBeenCalled(); expect(shared).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

describe("explicit reviewed results / same normal publisher", () => {
  const actual = join(ROOT, "tmp/yutai-reviewed-proof-v1");
  it.skipIf(!existsSync(join(actual, "TASKS.private.jsonl")))("保存実7502の手動結果を変更せず通常PRE/CAS/POSTへ通す（CIは私有fixture不在skip）", async () => {
    const tasks = join(actual, "TASKS.private.jsonl"), results = join(actual, "RESULTS.private.jsonl");
    const initial = JSON.parse(readFileSync(join(actual, "SAVED-ROWS.private.json"), "utf8")) as BenefitRow[];
    const options: LocalOptions = { stateDir: state(), limit: 1, reviewedInput: { tasks, results,
      tasksSha256: "cf0dc29b88652de80be97dc901122ce43b7d50f2195654234f967e1baf01c83a",
      resultsSha256: "a09a5416da7b1397c54c7061346003b257a0d24d9de414579dd5be3e267a2f2d" } };
    expect(createHash("sha256").update(readFileSync(join(actual, "SAVED-ROWS.private.json"))).digest("hex"))
      .toBe("a14280a14f1d465ae6fd5a5d2bb499aa8bb9c15afc252493d7d4f53f9c592cbb");
    const memory = storeFixture(), { deps, rows } = dependencies(initial, []);
    expect(await withSharedPublishingWriter(() => runLocalSummary(options, deps), memory.store))
      .toMatchObject({ accepted: 1, rejected: 0, reviewed: 1, modelCalls: 0, deterministic: 0 });
    expect(rows()[0].shortSummary).toBe(JSON.parse(readFileSync(results, "utf8")).shortSummary);
    expect(deps.generate).not.toHaveBeenCalled(); expect(memory.current()).toMatchObject({ owner: null, pending: null });
  });
  it("ファイル4指定・SHA・私有通常file・契約を検証し、モデルと混ぜない", () => {
    const options = reviewedOptions([row(1)]), files = options.reviewedInput!;
    const args = ["--state-dir", options.stateDir, "--limit=1", "--reviewed-tasks", files.tasks,
      "--reviewed-tasks-sha256", files.tasksSha256, "--reviewed-results", files.results, "--reviewed-results-sha256", files.resultsSha256];
    expect(readReviewedInput(parseLocalArgs(args))?.reviewed).toBe(1);
    expect(() => parseLocalArgs([...args, "--allow-model"])).toThrow();
    expect(() => parseLocalArgs(args.slice(0, -2))).toThrow();
    expect(() => readReviewedInput({ ...options, reviewedInput: { ...files, resultsSha256: "0".repeat(64) } })).toThrow("sha_mismatch");
    chmodSync(files.results, 0o644); expect(() => readReviewedInput(options)).toThrow("file_unqualified"); chmodSync(files.results, 0o600);
    const link = join(state(), "linked-results"); symlinkSync(files.results, link);
    expect(() => readReviewedInput({ ...options, reviewedInput: { ...files, results: link } })).toThrow("file_unqualified");
    const result = JSON.parse(readFileSync(files.results, "utf8")); result.contractVersion = "2026-10-25.1";
    const old = JSON.stringify(result); writeFileSync(files.results, old);
    expect(() => readReviewedInput({ ...options, reviewedInput: { ...files,
      resultsSha256: createHash("sha256").update(old).digest("hex") } })).toThrow("results_unqualified");
  });
  it("provided結果をcompilerで置換せず、同issuer全tier PRE/POSTとcursor不変を保つ", async () => {
    const initial = [row(1), { ...row(2, "図書カード 1,000円分"), stockCode: "9001", stockId: 1 }];
    const options = reviewedOptions(initial), memory = storeFixture(), { deps, rows } = dependencies(initial, memory.events);
    writeFileSync(join(options.stateDir, "progress.json"), "untouched", { mode: 0o600 });
    memory.values.set(cursorKey, { body: "untouched", etag: "cursor" });
    const archive = deps.archive;
    deps.archive = vi.fn(async (...args: Parameters<LocalDependencies["archive"]>) => {
      const bundle = JSON.parse(gunzipSync(args[0]).toString());
      if (args[2] === "pre") {
        expect(bundle).not.toHaveProperty("protocol"); expect(bundle).not.toHaveProperty("model");
        expect(bundle.reviewedInput).toMatchObject({ reviewed: 1, tasksSha256: options.reviewedInput!.tasksSha256,
          resultsSha256: options.reviewedInput!.resultsSha256 });
        expect(bundle.reviewedInput.resultsText).toBe(readFileSync(options.reviewedInput!.results, "utf8"));
        expect(bundle.selectedPre).toHaveLength(2); expect(bundle.freshPre).toHaveLength(2);
      }
      await archive(...args);
    });
    const report = await withSharedPublishingWriter(() => runLocalSummary(options, deps), memory.store);
    expect(report).toMatchObject({ accepted: 1, reviewed: 1, deterministic: 0, modelCalls: 0, modelResidents: 0 });
    expect(rows()[0].shortSummary).toBe("QUOカード3,000円分"); expect(rows()[1]).toEqual(initial[1]);
    expect(deps.generate).not.toHaveBeenCalled(); expect(deps.loadRows).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(deps.loadRows).mock.calls) expect(call).toEqual([["9001"]]);
    expect(memory.current()).toMatchObject({ owner: null, pending: null });
    expect(memory.store.get).not.toHaveBeenCalledWith(cursorKey, expect.anything());
    expect(memory.events).not.toContain(`put:${cursorKey}`);
    expect(readFileSync(join(options.stateDir, "progress.json"), "utf8")).toBe("untouched");
  });
  it.each(["inactive", "recipient", "fresh-count"] as const)("%sはempty成功や別対象へ読み替えない", async kind => {
    const initial = [row(1)], options = reviewedOptions(initial), memory = storeFixture(), { deps } = dependencies(initial, []);
    if (kind === "inactive") deps.loadRows = vi.fn(async () => []);
    if (kind === "recipient") deps.loadRows = vi.fn(async () => [{ ...initial[0], minShares: 200 }]);
    if (kind === "fresh-count") { let reads = 0; deps.loadRows = vi.fn(async () => ++reads === 1 ? initial : [...initial, { ...initial[0], id: 2 }]); }
    await expect(withSharedPublishingWriter(() => runLocalSummary(options, deps), memory.store)).rejects.toThrow("publishing_read_only_failed");
    expect(deps.archive).not.toHaveBeenCalled(); expect(deps.apply).not.toHaveBeenCalled(); expect(deps.generate).not.toHaveBeenCalled();
    expect(memory.current()).toMatchObject({ owner: null, pending: null });
  });
  it("unknownは共有owner/pendingを保持し、新state-dirで再送できない", async () => {
    const initial = [row(1)], options = reviewedOptions(initial), memory = storeFixture(), { deps } = dependencies(initial, []);
    deps.apply = vi.fn(async () => { throw new Error("unknown_apply"); });
    await expect(withSharedPublishingWriter(() => runLocalSummary(options, deps), memory.store)).rejects.toThrow("unknown_apply");
    expect(memory.current().pending.kind).toBe("yutai-summary"); expect(memory.current().owner).not.toBeNull();
    const next = vi.fn(() => runLocalSummary({ ...options, stateDir: state() }, deps));
    await expect(withSharedPublishingWriter(next, memory.store)).rejects.toThrow("未閉鎖"); expect(next).not.toHaveBeenCalled();
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
