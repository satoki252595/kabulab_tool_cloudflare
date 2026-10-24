/** Publication protocol only. No source downloads, model calls, or financial fixtures. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PublishingStore } from "../../../../scripts/mechanical-publishing/shared-writer.js";
import { publishingStore, SHARED_WRITER_KEY } from "../../../../scripts/mechanical-publishing/shared-writer.js";
import { importCollectedYutaiData } from "../../data-scripts/fetch-yutai-full.js";

const io = vi.hoisted(() => ({
  store: undefined as PublishingStore | undefined,
  read: vi.fn(), apply: vi.fn(), archive: vi.fn(), verify: vi.fn(), retire: vi.fn(),
}));
vi.mock("../../../../scripts/mechanical-publishing/shared-writer.js", async original => {
  const actual = await original<typeof import("../../../../scripts/mechanical-publishing/shared-writer.js")>();
  return { ...actual, publishingStore: vi.fn(() => io.store!), withSharedPublishingWriter: (execute: () => Promise<void>, store?: PublishingStore) => {
    if (io.store === undefined) throw new Error("protocol store absent");
    return actual.withSharedPublishingWriter(execute, store === undefined ? io.store : store);
  } };
});
vi.mock("../../../../src/shared/db/d1-http-client.js", () => ({
  createD1HttpDb: () => ({ select: () => ({ from: io.read }) }), createD1HttpBatchSender: () => vi.fn(),
}));
vi.mock("../../../../src/shared/notion-archive/index.js", () => ({
  recordPrimaryData: io.archive, verifyArchivedAttachments: io.verify, moveToTrash: io.retire,
}));
vi.mock("../../data-scripts/yutai-full-import.js", () => ({ importYutaiFull: io.apply }));

let objects: Map<string, { body: string; etag: string }>;
let cwd: string, directory: string;
beforeEach(() => {
  vi.clearAllMocks();
  cwd = process.cwd(); directory = mkdtempSync(join(tmpdir(), "yutai-source-publication-")); process.chdir(directory);
  objects = new Map([[SHARED_WRITER_KEY, { body: JSON.stringify({ version: 1, baselineSha256: "0".repeat(64), owner: null, pending: null }), etag: "initial" }]]);
  let version = 0;
  io.store = {
    async get(key) { return objects.get(key) ?? null; },
    async put(key, body, etag) {
      if ((objects.get(key)?.etag ?? null) !== etag) throw new Error("412 protocol CAS");
      objects.set(key, { body, etag: `version-${++version}` });
    },
  };
  io.read.mockReset().mockResolvedValue([]);
  io.apply.mockReset().mockResolvedValue({ stockCount: 0, benefitCount: 0, outOfUniverse: [], abolishedCount: 0,
    droppedInterpretations: 0, failedCodes: [], recompute: { updated: 0, scoresUpdated: 0, skippedNoRow: [], skippedNoScore: [] } });
  io.archive.mockReset().mockImplementation(async () => {
    expect(JSON.parse(objects.get(SHARED_WRITER_KEY)!.body).pending.kind).toBe("yutai-source-import");
    return { pageId: "protocol-archive", outcome: "recorded", fileTooLarge: false };
  });
  io.verify.mockReset().mockResolvedValue(undefined); io.retire.mockReset().mockResolvedValue({ trashPageId: "protocol-retired" });
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { process.chdir(cwd); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("source import reserves before PRE and releases only after observed POST custody and retirement", async () => {
  await importCollectedYutaiData([], "protocol-run", "2026-10-25T00:00:00Z");
  expect(io.read).toHaveBeenCalledTimes(2); expect(io.apply).toHaveBeenCalledTimes(1);
  expect(io.archive).toHaveBeenCalledTimes(2); expect(io.verify).toHaveBeenCalledTimes(3);
  const request = JSON.parse([...objects].find(([key]) => key.endsWith("/request.json"))![1].body);
  expect(request).toMatchObject({ previous: [], allData: [], runId: "protocol-run" });
  const completed = JSON.parse([...objects].find(([key]) => key.endsWith("/completed.json"))![1].body);
  expect(completed.output).toMatchObject({ observedPostRows: 0, preArchivePageId: "protocol-archive", postArchivePageId: "protocol-archive" });
  expect(JSON.parse(objects.get(SHARED_WRITER_KEY)!.body)).toMatchObject({ owner: null, pending: null });
});

it.each(["pre-archive", "import-ack", "post-read", "post-archive"])("%s uncertainty preserves intent and blocks a later host before D1", async fault => {
  if (fault === "pre-archive") io.archive.mockRejectedValueOnce(new Error("protocol unknown"));
  if (fault === "import-ack") io.apply.mockRejectedValueOnce(new Error("protocol unknown"));
  if (fault === "post-read") io.read.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("protocol read failed"));
  if (fault === "post-archive") io.archive.mockResolvedValueOnce({ pageId: "protocol-pre", outcome: "recorded", fileTooLarge: false }).mockRejectedValueOnce(new Error("protocol unknown"));
  await expect(importCollectedYutaiData([], "protocol-run", "2026-10-25T00:00:00Z")).rejects.toThrow();
  const before = [...objects], reads = io.read.mock.calls.length, writes = io.apply.mock.calls.length;
  expect(JSON.parse(objects.get(SHARED_WRITER_KEY)!.body).pending.kind).toBe("yutai-source-import");
  await expect(importCollectedYutaiData([], "another-host", "2026-10-25T00:01:00Z")).rejects.toThrow("期限では解除しません");
  expect(io.read).toHaveBeenCalledTimes(reads); expect(io.apply).toHaveBeenCalledTimes(writes); expect([...objects]).toEqual(before);
});

it.each(["pre-archive", "import-ack"])("%s finishes at native hard: preserve pending, do not publish completion or start the next unit", async phase => {
  const start = Date.now(), deadline = start + 355 * 60_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(deadline - 1);
  vi.stubEnv("BATCH_JOB_STARTED_AT", new Date(start).toISOString());
  if (phase === "pre-archive") io.archive.mockImplementationOnce(async () => {
    clock.mockReturnValue(deadline);
    return { pageId: "known-pre", outcome: "recorded", fileTooLarge: false };
  });
  else {
    const result = io.apply.getMockImplementation()!;
    io.apply.mockImplementationOnce(async (...args) => { const saved = await result(...args); clock.mockReturnValue(deadline); return saved; });
  }
  await expect(importCollectedYutaiData([], "native-hard", new Date(start).toISOString())).rejects.toThrow("原本閉鎖期限");
  expect(publishingStore).toHaveBeenCalledWith(deadline);
  expect(io.apply).toHaveBeenCalledTimes(phase === "pre-archive" ? 0 : 1);
  expect(io.read).toHaveBeenCalledTimes(1);
  expect(JSON.parse(objects.get(SHARED_WRITER_KEY)!.body).pending.kind).toBe("yutai-source-import");
  expect([...objects.keys()].some(key => key.endsWith("/completed.json"))).toBe(false);
  const before = [...objects];
  await expect(importCollectedYutaiData([], "later-host", new Date(start).toISOString())).rejects.toThrow("原本閉鎖期限");
  expect([...objects]).toEqual(before);
});
