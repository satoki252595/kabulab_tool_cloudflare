import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "../../src/shared/zod-mini.js";
import { canonicalRawKey } from "./raw-index-plan.js";
import { safeRawFailure, createRawDownloader, expectedRawIndex, inspectRawBackfill, parseRawManifest, readRawIndex, runRawBackfill, type BackfillIo, type RawBackfillOptions, type RawItem, type RawIndexRow } from "./raw-index-backfill.js";
import { sharedEnv } from "../../src/shared/env.js";
import { downloadArchivedFile, type ArchivedDownloadOptions } from "../../src/shared/notion-archive/archived-download.js";
import type { CanonicalRawFile } from "../../src/shared/notion-archive/raw-files.js";

// Protocol fixture only: raw binary fidelity/unknown transport tests, not financial facts.
const body = new Uint8Array([0, 255, 128, 42]);
const sha = createHash("sha256").update(body).digest("hex");
const raw: CanonicalRawFile = { pageId: "b".repeat(32), filename: "edinet_csv_1001_20261013.zip", sha256: sha, sizeBytes: body.length,
  source: "EDINET", datatype: "csv", scope: "1001", dataDate: "2026-10-13", fetchedAt: "2026-10-13T18:00:00+09:00",
  sourceUrl: "https://api.edinet-fsa.go.jp/api/v2/documents/S100TEST?type=5&secret=never-log", licenseTag: "commercial-ok", convertStatus: "完了", hostedAttachments: 1 };
const { sourceUrl: _sourceUrl, ...safe } = raw;
const item: RawItem = { ...safe, source: "EDINET", licenseTag: "commercial-ok", convertStatus: "完了", docId: "S100TEST" };
const key = canonicalRawKey(raw, item.docId), legacy = canonicalRawKey(raw, null);
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.resetModules(); });
const opts: RawBackfillOptions = { mode: "apply", planId: "test-plan", limit: 50, maxBytes: 67108864, maxSeconds: 1200, expectedCount: 1 };

describe("fixed SHA SELECT bounded native retry", () => {
  function credentials() {
    vi.spyOn(sharedEnv, "CLOUDFLARE_ACCOUNT_ID").mockReturnValue("explicit-transport-test-account");
    vi.spyOn(sharedEnv, "D1_DATABASE_ID").mockReturnValue("explicit-transport-test-database");
    vi.spyOn(sharedEnv, "CLOUDFLARE_API_TOKEN").mockReturnValue("explicit-transport-test-token");
  }
  const index = expectedRawIndex(item, "raw-bucket", key);
  const ok = () => new Response(JSON.stringify({ success: true, result: [{ success: true, results: [index] }] }), { status: 200 });
  it.each([502, 503, 504, "socket"])("%s retries the identical SELECT only after admission", async fault => {
    credentials(); const beforeRetry = vi.fn();
    const native = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      if (fault === "socket") throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      return new Response("EXPLICIT_GATEWAY_FAILURE", { status: fault as number });
    }).mockImplementationOnce(async () => { expect(beforeRetry).toHaveBeenCalledOnce(); return ok(); });
    expect(await readRawIndex(sha, { beforeRetry })).toEqual(index);
    expect(native).toHaveBeenCalledTimes(2);
    expect(native.mock.calls[1]).toEqual(native.mock.calls[0]);
    const request = JSON.parse(native.mock.calls[0][1]!.body as string);
    expect(request.sql).toMatch(/^SELECT .* FROM jss_raw_files WHERE sha256=\?$/);
    expect(request.params).toEqual([sha]);
  });
  it.each([403, 429, 500, "schema", "json"])("%s stops without retry", async fault => {
    credentials(); const beforeRetry = vi.fn();
    const native = vi.spyOn(globalThis, "fetch").mockResolvedValue(fault === "schema"
      ? new Response(JSON.stringify({ success: true, result: [] }))
      : fault === "json" ? new Response("EXPLICIT_INVALID_JSON") : new Response("EXPLICIT_REFUSAL", { status: fault as number }));
    await expect(readRawIndex(sha, { beforeRetry })).rejects.toThrow();
    expect(native).toHaveBeenCalledOnce(); expect(beforeRetry).not.toHaveBeenCalled();
  });
  it("second gateway failure and rejected admission never send a third/native second request", async () => {
    credentials(); const native = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("EXPLICIT_GATEWAY_FAILURE", { status: 502 }));
    await expect(readRawIndex(sha, { beforeRetry: vi.fn() })).rejects.toThrow("D1 read HTTP 502");
    expect(native).toHaveBeenCalledTimes(2); native.mockClear();
    await expect(readRawIndex(sha, { beforeRetry: () => { throw new Error("EXPLICIT_BUDGET_STOP"); } })).rejects.toThrow("EXPLICIT_BUDGET_STOP");
    expect(native).toHaveBeenCalledOnce(); native.mockClear();
    await expect(readRawIndex(sha)).rejects.toThrow("D1 read HTTP 502");
    expect(native).toHaveBeenCalledOnce();
  });
});

function fixture() {
  const objects = new Map<string, { body: Uint8Array; etag: string }>();
  const rows = new Map<string, RawIndexRow>();
  const events: string[] = [], emitted: object[] = [];
  let version = 0;
  const io: BackfillIo = {
    rawBucket: "raw-bucket", receiptBucket: "ops-bucket", now: () => Date.parse("2026-10-14T00:00:00.000Z"),
    list: vi.fn(async () => [raw]), download: vi.fn(async (_item, _cohort, options) => {
      await options!.onAttempt!({ attempt: 1, phase: "start", receivedBytes: 0 });
      events.push("hosted:GET");
      await options!.onAttempt!({ attempt: 1, phase: "complete", receivedBytes: body.length, status: 200 });
      return { body, wireBytes: body.length };
    }),
    get: vi.fn(async (target, bucket) => { events.push(`${bucket}:GET:${target}`); const found = objects.get(`${bucket}/${target}`); return found === undefined ? null : found; }),
    put: vi.fn(async (target, bytes, previous, bucket) => {
      events.push(`${bucket}:PUT:${target}`);
      const found = objects.get(`${bucket}/${target}`);
      if ((found === undefined ? null : found.etag) !== previous) throw new Error("CAS conflict");
      objects.set(`${bucket}/${target}`, { body: Uint8Array.from(bytes), etag: `"${++version}"` });
    }),
    index: vi.fn(async (digest) => { events.push("D1:GET"); const found = rows.get(digest); return found === undefined ? null : found; }),
    insert: vi.fn(async (row) => { events.push("D1:INSERT"); if (rows.has(row.sha256)) throw new Error("conflict"); rows.set(row.sha256, row); }),
    antiJoin: vi.fn(async (items: readonly RawItem[]) => ({ checked: items.length, missing: items.filter((row) => !rows.has(row.sha256)).length })),
    emit: vi.fn(async (record) => { events.push(`fsync:${(record as { phase: string }).phase}`); emitted.push(record); }),
  };
  const rawPuts = () => vi.mocked(io.put).mock.calls.filter((call) => call[3] === io.rawBucket);
  const state = () => JSON.parse(new TextDecoder().decode(objects.get("ops-bucket/ops/raw-index/test-plan/state.json")!.body));
  return { io, objects, rows, events, emitted, rawPuts, state };
}

describe("保存済⑤原本のbounded publisher", () => {
  it("基準日不明も全文照合して保存し、索引NULLと取得時計を維持する", async () => {
    const f = fixture();
    f.io.list = vi.fn(async () => [{ ...raw, dataDate: null }]);
    expect(await runRawBackfill(opts, f.io)).toMatchObject({ status: "snapshot_complete", verified: 1 });
    expect(f.rows.get(sha)).toMatchObject({ data_date: null, first_fetched_at: Math.floor(Date.parse(raw.fetchedAt) / 1000) });
    expect(f.rows.get(sha)?.r2_key).toContain("/nodate/nodate/");
  });
  it("dryはhosted全文SHAまで照合し、原本/index/receiptのmutationを送らない", async () => {
    const f = fixture();
    const result = await runRawBackfill({ ...opts, mode: "dry" }, f.io);
    expect(result).toMatchObject({ status: "partial", wouldPut: 1, wouldIndex: 1, verified: 0, rawGets: 2, rawPuts: 0, d1Inserts: 0, receiptPuts: 0, upstreamGets: 0 });
    expect(f.io.download).toHaveBeenCalledTimes(1);
    expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.insert).not.toHaveBeenCalled();
    expect(JSON.stringify(f.emitted)).not.toContain("never-log"); expect(JSON.stringify(f.emitted)).not.toContain("sourceUrl");
  });
  it("fsync+R2 inflight→単発CAS PUT→全文GET→atomic index→readback→cursorの順を守る", async () => {
    const f = fixture(), result = await runRawBackfill(opts, f.io);
    expect(result).toMatchObject({ status: "snapshot_complete", verified: 1, rawPuts: 1, d1Inserts: 1, remaining: 0 });
    expect(f.rawPuts()[0]?.[2]).toBeNull();
    expect(f.state()).toMatchObject({ cursor: 1, inflight: null });
    const rawPutAt = f.events.indexOf(`raw-bucket:PUT:${key}`), inserted = f.events.indexOf("D1:INSERT");
    expect(f.events.indexOf("fsync:raw_inflight")).toBeLessThan(rawPutAt);
    expect(f.events.indexOf(`raw-bucket:GET:${key}`, rawPutAt)).toBeLessThan(inserted);
    expect(f.events.indexOf("fsync:index_inflight")).toBeLessThan(inserted);
    expect(f.events.indexOf("D1:GET", inserted)).toBeGreaterThan(inserted);
    expect(f.rows.get(sha)).toEqual(expectedRawIndex(item, f.io.rawBucket, key));
    for (const stored of f.objects.values()) if (stored.body !== body) expect(new TextDecoder().decode(stored.body)).not.toContain("never-log");
  });
  it("通常経路は再SELECTの送信前予約も計数し、INSERT/PUTは増やさない", async () => {
    const baseline = await runRawBackfill(opts, fixture().io);
    const f = fixture(), index = f.io.index;
    f.io.index = vi.fn(async (digest, options) => {
      if (vi.mocked(f.io.index).mock.calls.length === 1) await options!.beforeRetry();
      return index(digest);
    });
    const result = await runRawBackfill(opts, f.io);
    expect(result).toMatchObject({ status: "snapshot_complete", d1Reads: baseline.d1Reads + 1,
      d1ReadsCountKind: "admitted_attempts_including_retry", rawPuts: 1, d1Inserts: 1 });
    expect(f.events.indexOf("fsync:d1_read_retry_inflight")).toBeLessThan(f.events.indexOf("D1:GET"));
    expect(f.io.insert).toHaveBeenCalledOnce(); expect(f.rawPuts()).toHaveLength(1);
  });
  it("再SELECTの予約保管失敗では原本PUT/索引INSERT/cursor進行をしない", async () => {
    const f = fixture(), emit = f.io.emit;
    f.io.index = vi.fn(async (_digest, options) => { await options!.beforeRetry(); return null; });
    f.io.emit = vi.fn(async record => {
      if ((record as { phase: string }).phase === "d1_read_retry_inflight") throw new Error("EXPLICIT_RECEIPT_FAILURE");
      await emit(record);
    });
    await expect(runRawBackfill(opts, f.io)).rejects.toThrow("EXPLICIT_RECEIPT_FAILURE");
    expect(f.io.index).toHaveBeenCalledOnce(); expect(f.io.insert).not.toHaveBeenCalled();
    expect(f.rawPuts()).toHaveLength(0); expect(f.state().cursor).toBe(0);
  });
  it("保存済同値はraw/index write0、取得履歴とderived metadataを上書きしない", async () => {
    const f = fixture();
    f.objects.set(`raw-bucket/${key}`, { body, etag: '"existing"' });
    f.rows.set(sha, { ...expectedRawIndex(item, f.io.rawBucket, key), first_fetched_at: 1, last_fetched_at: 2 });
    const result = await runRawBackfill(opts, f.io);
    expect(result).toMatchObject({ alreadyComplete: 1, rawPuts: 0, d1Inserts: 0, rawGets: 1, notionDownloads: 0 });
    expect(f.rawPuts()).toHaveLength(0); expect(f.io.insert).not.toHaveBeenCalled(); expect(f.io.download).not.toHaveBeenCalled();
    expect(f.rows.get(sha)?.first_fetched_at).toBe(1);
  });
  it("実在しSHA一致する旧キーは新原本を作らず索引する", async () => {
    const f = fixture(); f.objects.set(`raw-bucket/${legacy}`, { body, etag: '"legacy"' });
    expect(await runRawBackfill(opts, f.io)).toMatchObject({ rawPuts: 0, d1Inserts: 1, notionDownloads: 0 });
    expect(f.rows.get(sha)?.r2_key).toBe(legacy); expect(f.rawPuts()).toHaveLength(0);
  });
  it("TDnetのZIP番号からPDF文書IDを推測せず、既存writerのIDは未検証理由付きで保持する", async () => {
    const f = fixture(), tdnet: CanonicalRawFile = { ...raw, source: "TDnet", datatype: "tdnet_xbrl", filename: "tdnet_tdnet_xbrl_1001_20261013.zip",
      sourceUrl: "https://www.release.tdnet.info/inbs/081220261013575063.zip", licenseTag: "factual-cite" };
    const tdItem: RawItem = { ...item, source: "TDnet", datatype: tdnet.datatype, filename: tdnet.filename, licenseTag: "factual-cite", docId: null };
    const retainedKey = "raw/tdnet/tdnet_xbrl/2026/2026-10-13/1001/140120261013575063/retained.zip";
    f.io.list = vi.fn(async () => [tdnet]);
    f.objects.set(`raw-bucket/${retainedKey}`, { body, etag: '"existing"' });
    f.rows.set(sha, { ...expectedRawIndex(tdItem, f.io.rawBucket, retainedKey), doc_id: "140120261013575063" });
    expect(await runRawBackfill(opts, f.io)).toMatchObject({ alreadyComplete: 1, d1Inserts: 0, rawPuts: 0 });
    expect(f.rows.get(sha)?.doc_id).toBe("140120261013575063");
    expect(f.emitted).toContainEqual(expect.objectContaining({ phase: "verified", docIdStatus: "retained_existing_unverified" }));
  });
  it.each([true, false])("raw PUT結果不明（実適用=%s）で停止し、次runも読取照合以外の再送をしない", async (applied) => {
    const f = fixture(), put = f.io.put;
    f.io.put = vi.fn(async (...args: Parameters<BackfillIo["put"]>) => {
      if (args[3] === f.io.rawBucket) { if (applied) await put(...args); throw new Error("unknown PUT"); }
      await put(...args);
    });
    await expect(runRawBackfill(opts, f.io)).rejects.toThrow("unknown PUT");
    expect(f.state().inflight).toMatchObject({ phase: "raw_inflight", sha256: sha });
    expect(f.io.insert).not.toHaveBeenCalled();
    vi.mocked(f.io.put).mockClear(); vi.mocked(f.io.download).mockClear();
    if (applied) expect(await runRawBackfill(opts, f.io)).toMatchObject({ rawPuts: 0, d1Inserts: 1, status: "snapshot_complete" });
    else await expect(runRawBackfill(opts, f.io)).rejects.toThrow("再送せず保全停止");
    expect(f.rawPuts()).toHaveLength(0); expect(f.io.download).not.toHaveBeenCalled();
  });
  it.each([true, false])("index結果不明（実適用=%s）は次runで同値を回収、未確認は再INSERTしない", async (applied) => {
    const f = fixture(), insert = f.io.insert;
    f.io.insert = vi.fn(async (row) => { if (applied) await insert(row); throw new Error("unknown index"); });
    await expect(runRawBackfill(opts, f.io)).rejects.toThrow("unknown index");
    expect(f.state().inflight.phase).toBe("index_inflight");
    vi.mocked(f.io.insert).mockClear(); vi.mocked(f.io.put).mockClear();
    if (applied) expect(await runRawBackfill(opts, f.io)).toMatchObject({ rawPuts: 0, d1Inserts: 0, status: "snapshot_complete" });
    else await expect(runRawBackfill(opts, f.io)).rejects.toThrow("INSERTを再送せず");
    expect(f.io.insert).not.toHaveBeenCalled(); expect(f.rawPuts()).toHaveLength(0);
    expect(f.emitted).toContainEqual({ phase: "raw_verified", sha256: sha, bytes: body.length });
  });
  it("別plan-idで先行unknownを迂回しない", async () => {
    const f = fixture(); await runRawBackfill(opts, f.io);
    vi.mocked(f.io.put).mockClear(); vi.mocked(f.io.download).mockClear();
    await expect(runRawBackfill({ ...opts, planId: "new-plan" }, f.io)).rejects.toThrow("別planがactive");
    expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.download).not.toHaveBeenCalled();
  });
  it.each(["sha", "index-metadata", "indexed-missing"])("%s不一致は次原本や書込へ進めない", async (kind) => {
    const f = fixture();
    if (kind === "sha") f.objects.set(`raw-bucket/${key}`, { body: new Uint8Array([1, 2, 3, 4]), etag: '"bad"' });
    if (kind !== "sha") f.rows.set(sha, { ...expectedRawIndex(item, f.io.rawBucket, key), source: kind === "index-metadata" ? "TDnet" : "EDINET" });
    await expect(runRawBackfill(opts, f.io)).rejects.toThrow();
    expect(f.rawPuts()).toHaveLength(0); expect(f.io.insert).not.toHaveBeenCalled(); expect(f.io.download).not.toHaveBeenCalled();
  });
  it("dry/applyの起動時計が異なっても明示cutoffで同じ集合を使い、再開でも維持する", async () => {
    const f = fixture(), cutoff = "2026-10-13T18:31:00.000Z";
    let clock = Date.parse("2026-10-14T00:00:00.000Z"); f.io.now = () => clock;
    await runRawBackfill({ ...opts, cutoff, mode: "dry" }, f.io);
    clock += 3_600_000;
    await runRawBackfill({ ...opts, cutoff }, f.io);
    clock += 3_600_000;
    await runRawBackfill({ ...opts, cutoff }, f.io);
    expect(vi.mocked(f.io.list).mock.calls.map(([value]) => value)).toEqual([cutoff, cutoff]);
    const manifests = f.emitted.filter((r) => (r as { phase: string }).phase === "manifest") as Array<{ cutoff: string; manifestSha256: string }>;
    expect(manifests.map((r) => r.cutoff)).toEqual([cutoff, cutoff, cutoff]);
    expect(new Set(manifests.map((r) => r.manifestSha256)).size).toBe(1);
  });
  it("保存manifestと異なる明示cutoffは原本/索引/receiptを書かず停止する", async () => {
    const f = fixture(); await runRawBackfill({ ...opts, cutoff: "2026-10-13T18:31:00.000Z" }, f.io);
    vi.mocked(f.io.put).mockClear(); vi.mocked(f.io.insert).mockClear(); vi.mocked(f.io.list).mockClear(); vi.mocked(f.io.download).mockClear();
    await expect(runRawBackfill({ ...opts, cutoff: "2026-10-13T18:30:00.000Z" }, f.io)).rejects.toThrow("明示cutoffと保存manifest");
    expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.insert).not.toHaveBeenCalled(); expect(f.io.list).not.toHaveBeenCalled(); expect(f.io.download).not.toHaveBeenCalled();
  });
  it.each(["", "not-a-time", "2026-02-30T18:31:00.000Z", "2026-10-13T18:31:00+00:00", "2026-10-14T00:00:00.001Z"])("不正/UTCでない/未来のcutoff %s はリクエスト前に停止する", async (cutoff) => {
    const f = fixture();
    await expect(runRawBackfill({ ...opts, cutoff }, f.io)).rejects.toThrow("cutoff UTC ISO/未来日時");
    for (const fn of [f.io.get, f.io.list, f.io.download, f.io.put, f.io.index, f.io.insert]) expect(fn).not.toHaveBeenCalled();
  });

  it("母集団件数不一致はmanifest作成前に停止する", async () => {
    const f = fixture();
    await expect(runRawBackfill({ ...opts, expectedCount: 2 }, f.io)).rejects.toThrow("manifest集合");
    expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.download).not.toHaveBeenCalled();
  });
  it("bytes不足は原本を切り詰めずpartialとして次runへ残す", async () => {
    const f = fixture();
    expect(await runRawBackfill({ ...opts, maxBytes: 1 }, f.io)).toMatchObject({ stoppedByBudget: true, processed: 0, remaining: 1, status: "partial" });
    expect(f.io.download).not.toHaveBeenCalled(); expect(f.rawPuts()).toHaveLength(0); expect(f.io.index).not.toHaveBeenCalled();
  });
  it("receipt保存不明はraw送信前に停止する", async () => {
    const f = fixture(), put = f.io.put;
    f.io.put = vi.fn(async (...args: Parameters<BackfillIo["put"]>) => {
      if (args[0].endsWith("state.json") && new TextDecoder().decode(args[1]).includes("raw_inflight")) throw new Error("unknown receipt");
      await put(...args);
    });
    await expect(runRawBackfill(opts, f.io)).rejects.toThrow("unknown receipt");
    expect(f.rawPuts()).toHaveLength(0); expect(f.io.insert).not.toHaveBeenCalled();
  });
  it("全件cursorでもfresh anti-joinに穴があれば完了扱いしない", async () => {
    const f = fixture(); await runRawBackfill(opts, f.io); f.rows.delete(sha);
    await expect(runRawBackfill(opts, f.io)).rejects.toThrow("完了anti-joinに未索引");
  });
  it("URL更新はSHA cohort一括queryし、同batchの原本を個別page GETしない", async () => {
    const secondBody = new Uint8Array([255, 0, 128, 42]), secondSha = createHash("sha256").update(secondBody).digest("hex");
    const secondRaw = { ...raw, sha256: secondSha, pageId: "d".repeat(32) }, secondItem = { ...item, sha256: secondSha, pageId: secondRaw.pageId };
    const find = vi.fn(async () => new Map([[sha, { raw, file: { name: raw.filename, url: "https://hosted.example/1?signature=never-log" } }],
      [secondSha, { raw: secondRaw, file: { name: raw.filename, url: "https://hosted.example/2?signature=never-log" } }]]));
    const download = vi.fn(async (file: { name: string; url: string }, _context: string, options?: ArchivedDownloadOptions) => {
      const received = file.url.includes("/1?") ? body : secondBody;
      await options?.onAttempt?.({ attempt: 1, phase: "start", receivedBytes: 0 });
      await options?.onAttempt?.({ attempt: 1, phase: "complete", receivedBytes: received.length, status: 200 });
      return received;
    });
    const fetchBody = createRawDownloader(find, download), cohort = [item, secondItem];
    expect(await fetchBody(item, cohort)).toEqual({ body, wireBytes: body.length });
    expect(await fetchBody(secondItem, cohort)).toEqual({ body: secondBody, wireBytes: secondBody.length });
    expect(find).toHaveBeenCalledTimes(1); expect(find).toHaveBeenCalledWith([sha, secondSha]); expect(download).toHaveBeenCalledTimes(2);
  });
  it("hostedのpartial＋再GET全文を予約/実bytesへ数え、intent後は期限を跨いでも必要readbackを完結する", async () => {
    const reserved = item.sizeBytes * 5 + 2 * (Math.ceil(item.sizeBytes * 0.001) + 4096);
    const noRoom = fixture();
    expect(await runRawBackfill({ ...opts, mode: "dry", maxBytes: reserved - 1 }, noRoom.io)).toMatchObject({
      processed: 0, stoppedByBudget: true, budgetStopReason: "bytes", notionDownloadAttempts: 0 });
    expect(noRoom.io.download).not.toHaveBeenCalled();
    const f = fixture();
    let clock = f.io.now(); f.io.now = () => clock;
    const find = vi.fn(async () => new Map([[sha, { raw, file: { name: raw.filename, url: "https://file.notion.so/source.zip" } }]]));
    f.io.download = createRawDownloader(find, downloadArchivedFile);
    let reads = 0;
    const partial = new ReadableStream<Uint8Array>({ pull(controller) {
      if (reads++ === 0) controller.enqueue(body.subarray(0, 2)); else controller.error(new TypeError("terminated"));
    } });
    const get = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(partial)).mockResolvedValueOnce(new Response(body));
    const put = f.io.put;
    f.io.put = vi.fn(async (...args: Parameters<BackfillIo["put"]>) => { await put(...args); if (args[3] === f.io.rawBucket) clock += opts.maxSeconds * 1000 + 1; });
    expect(await runRawBackfill({ ...opts, maxBytes: reserved }, f.io)).toMatchObject({
      status: "partial", processed: 1, verified: 1, cursor: 1, notionDownloads: 1, notionDownloadAttempts: 2,
      notionDownloadBytes: 6, rawPutBytes: 4, rawGetBytes: 4, rawTransferBytes: 14,
      hostedBytesKind: "decoded_body_all_observed_attempts", httpHeadersAndErrorBodyBytesMeasured: false,
    });
    expect(get).toHaveBeenCalledTimes(2); expect(find).toHaveBeenCalledOnce();
    expect(f.rawPuts()).toHaveLength(1); expect(f.io.insert).toHaveBeenCalledOnce(); expect(f.state()).toMatchObject({ cursor: 1, inflight: null });
    expect(f.emitted.filter(r => (r as { phase: string }).phase === "hosted_read_attempt")).toMatchObject([
      { attempt: 1, attemptPhase: "start", receivedBytes: 0 }, { attempt: 1, attemptPhase: "transport-error", receivedBytes: 2 },
      { attempt: 2, attemptPhase: "start", receivedBytes: 0 }, { attempt: 2, attemptPhase: "complete", receivedBytes: 4 },
    ]);
  });
  it("hostedの原サイズ超過も実受信量を保存し、再GET/raw/index mutationへ進めない", async () => {
    const f = fixture();
    f.io.download = createRawDownloader(async () => new Map([[sha, { raw, file: { name: raw.filename, url: "https://file.notion.so/source.zip" } }]]));
    const get = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(Uint8Array.from([1, 2, 3, 4, 5])));
    await expect(runRawBackfill(opts, f.io)).rejects.toThrow("原本読取予算超過");
    expect(get).toHaveBeenCalledOnce(); expect(f.rawPuts()).toHaveLength(0); expect(f.io.insert).not.toHaveBeenCalled();
    expect(f.emitted.at(-1)).toMatchObject({ phase: "hosted_read_attempt", attemptPhase: "error", receivedBytes: 5,
      notionDownloadAttempts: 1, notionDownloadBytes: 5 });
  });
  it("時刻予算では開始済み1件を確定し、次の原本を開始せずpartialで再開できる", async () => {
    const f = fixture();
    let clock = Date.parse("2026-10-14T00:00:00.000Z"); f.io.now = () => clock;
    f.io.list = vi.fn(async () => [raw, { ...raw, sha256: "f".repeat(64), pageId: "d".repeat(32) }].sort((a, b) => a.sha256.localeCompare(b.sha256)));
    const emit = f.io.emit;
    f.io.emit = vi.fn(async (record) => { await emit(record); if ((record as { phase: string }).phase === "verified") clock += 1_200_001; });
    expect(await runRawBackfill({ ...opts, expectedCount: 2 }, f.io)).toMatchObject({ status: "partial", processed: 1, cursor: 1, remaining: 1, budgetStopReason: "seconds" });
    expect(f.state()).toMatchObject({ cursor: 1, inflight: null });
    expect(f.io.download).toHaveBeenCalledTimes(1); expect(f.io.insert).toHaveBeenCalledTimes(1);
  });
  it("最終原本直後の期限到達はremaining0でもpartial、次runでanti-joinだけ完了する", async () => {
    const f = fixture();
    let clock = Date.parse("2026-10-14T00:00:00.000Z"); f.io.now = () => clock;
    const emit = f.io.emit;
    f.io.emit = vi.fn(async (record) => { await emit(record); if ((record as { phase: string }).phase === "verified") clock += 1_200_001; });
    expect(await runRawBackfill(opts, f.io)).toMatchObject({ status: "partial", remaining: 0, indexAntiJoin: null, budgetStopReason: "seconds" });
    expect(f.io.antiJoin).not.toHaveBeenCalled();
    vi.mocked(f.io.download).mockClear(); vi.mocked(f.io.insert).mockClear(); vi.mocked(f.io.put).mockClear();
    expect(await runRawBackfill(opts, f.io)).toMatchObject({ status: "snapshot_complete", processed: 0, indexAntiJoin: { checked: 1, missing: 0 } });
    expect(f.io.download).not.toHaveBeenCalled(); expect(f.io.insert).not.toHaveBeenCalled(); expect(f.rawPuts()).toHaveLength(0);
  });
});


describe("人間判断後の単一索引reconcile", () => {
  async function interrupted() {
    const f = fixture(), insert = f.io.insert;
    f.io.insert = vi.fn(async () => { throw new Error("old send unknown"); });
    await expect(runRawBackfill(opts, f.io)).rejects.toThrow("old send unknown");
    f.io.insert = insert;
    const stateKey = "ops-bucket/ops/raw-index/test-plan/state.json", activeKey = "ops-bucket/ops/raw-index/active.json";
    const state = f.objects.get(stateKey)!, active = f.objects.get(activeKey)!;
    const reconcile: RawBackfillOptions = { ...opts, limit: 1, maxSeconds: 600, cutoff: "2026-10-14T00:00:00.000Z", reconcileSha256: sha,
      reconcileStateSha256: createHash("sha256").update(state.body).digest("hex") };
    for (const fn of [f.io.get, f.io.put, f.io.list, f.io.download, f.io.index, f.io.insert, f.io.antiJoin, f.io.emit]) vi.mocked(fn).mockClear();
    f.events.length = 0;
    return { ...f, reconcile, stateKey, activeKey, oldState: state, oldActive: active };
  }
  it("fresh原本SHA不一致はintent/INSERTを送らず停止する", async () => {
    const f = await interrupted();
    f.objects.set(`raw-bucket/${key}`, { body: new Uint8Array([1, 2, 3, 4]), etag: '"bad"' });
    await expect(runRawBackfill(f.reconcile, f.io)).rejects.toThrow("原本全body SHA/サイズ不一致");
    expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.insert).not.toHaveBeenCalled();
  });
  it.each(["state-sha", "fresh-state-etag"])("旧state %s 競合は送信0で停止する", async (kind) => {
    const f = await interrupted();
    if (kind === "state-sha") f.reconcile.reconcileStateSha256 = "0".repeat(64);
    else {
      const get = f.io.get; let reads = 0;
      f.io.get = vi.fn(async (target, bucket) => {
        if (`${bucket}/${target}` === f.stateKey && ++reads === 2) f.objects.set(f.stateKey, { ...f.oldState, etag: '"changed"' });
        return get(target, bucket);
      });
    }
    await expect(runRawBackfill(f.reconcile, f.io)).rejects.toThrow();
    expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.insert).not.toHaveBeenCalled();
  });
  it("fresh全SHA→absence→intent CAS/readback→unique1→全列readback、旧latch不変", async () => {
    const f = await interrupted();
    const result = await runRawBackfill(f.reconcile, f.io);
    expect(result).toMatchObject({ status: "manual_index_reconciliation_complete", originalSendUnknown: true,
      reconciliationInsertAttempts: 1, rawGets: 1, rawPuts: 0, d1Inserts: 1, receiptPuts: 2, oldLatchUnchanged: true,
      receiptGets: 13, r2Gets: 14, requests: 19, requestLimit: 19, d1ResponseBytesMeasured: false, sdkErrorResponseBytesMeasured: false });
    const gets = await Promise.all(vi.mocked(f.io.get).mock.results.map(call => call.value));
    const putBytes = vi.mocked(f.io.put).mock.calls.reduce((total, call) => total + call[1].length, 0);
    const readBytes = gets.reduce((total, got) => total + (got === null ? 0 : got.body.length), 0);
    expect(result).toMatchObject({ r2ReadBytes: readBytes, r2PutBytes: putBytes, r2TransferBytes: readBytes + putBytes });
    for (const call of vi.mocked(f.io.get).mock.calls) expect(call[2]).toMatchObject({ singleAttempt: true,
      maxBytes: expect.any(Number), abortSignal: expect.any(AbortSignal), beforeAttempt: expect.any(Function), onRead: expect.any(Function) });
    const manifestReads = vi.mocked(f.io.get).mock.calls.filter(call => call[0].endsWith("/manifest.json"));
    expect(manifestReads).toHaveLength(1); expect(manifestReads[0]![2]!.maxBytes).toBeGreaterThan(20 * 1024 ** 2);
    expect(f.io.insert).toHaveBeenCalledTimes(1); expect(f.io.insert).toHaveBeenCalledWith(expectedRawIndex(item, f.io.rawBucket, key));
    expect(f.io.list).not.toHaveBeenCalled(); expect(f.io.download).not.toHaveBeenCalled(); expect(f.io.antiJoin).not.toHaveBeenCalled();
    expect(f.objects.get(f.stateKey)).toEqual(f.oldState); expect(f.objects.get(f.activeKey)).toEqual(f.oldActive);
    expect(f.state()).toMatchObject({ cursor: 0, inflight: { phase: "index_inflight", sha256: sha } });
    const intentKey = `ops/raw-index/test-plan/resolutions/${sha}/intent.json`;
    const insertAt = f.events.indexOf("D1:INSERT"), intentAt = f.events.indexOf(`ops-bucket:PUT:${intentKey}`);
    expect(f.events.indexOf(`raw-bucket:GET:${key}`)).toBeLessThan(intentAt);
    expect(f.events.indexOf(`ops-bucket:GET:${intentKey}`, intentAt)).toBeLessThan(insertAt);
    expect(f.events.indexOf("fsync:index_reconciliation_insert_inflight")).toBeLessThan(insertAt);
    for (const call of vi.mocked(f.io.put).mock.calls) expect(call[2]).toBeNull();
    vi.mocked(f.io.put).mockClear(); vi.mocked(f.io.insert).mockClear();
    await expect(runRawBackfill(f.reconcile, f.io)).rejects.toThrow("intentが既存");
    expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.insert).not.toHaveBeenCalled();
  });
  it("manifestを含む全R2転送が残bytesを超える前に停止し、旧latchとINSERTを保持する", async () => {
    const f = await interrupted(), get = f.io.get;
    const manifest = f.objects.get("ops-bucket/ops/raw-index/test-plan/manifest.json")!;
    f.io.get = vi.fn(async (target, bucket, options) => {
      const got = await get(target, bucket, options);
      if (got !== null && got.body.length > options!.maxBytes!) throw new Error("R2 object exceeds read byte budget");
      return got;
    });
    await expect(runRawBackfill({ ...f.reconcile, maxBytes: manifest.body.length }, f.io)).rejects.toThrow("read byte budget");
    expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.insert).not.toHaveBeenCalled();
    expect(f.objects.get(f.stateKey)).toEqual(f.oldState); expect(f.objects.get(f.activeKey)).toEqual(f.oldActive);
  });
  it("manifest stream中断の元prefixを16KiBまで私有receiptへ残しmutation0で止める", async () => {
    const f = await interrupted(), get = f.io.get, partial = new Uint8Array(17 * 1024).fill(120);
    f.io.get = vi.fn(async (target, bucket, options) => {
      if (!target.endsWith("/manifest.json")) return get(target, bucket, options);
      await options!.beforeAttempt!();
      await options!.onRead!({ status: 200, etag: '"partial"', contentLength: 31579382,
        body: partial, receivedBytes: partial.length, complete: false });
      throw new Error("stream interrupted");
    });
    await expect(runRawBackfill(f.reconcile, f.io)).rejects.toThrow("stream interrupted");
    expect(f.emitted).toContainEqual(expect.objectContaining({ phase: "reconcile_partial_body", status: 200,
      complete: false, receivedBytes: partial.length, r2Gets: 2, prefixBase64: Buffer.from(partial.subarray(0, 16 * 1024)).toString("base64") }));
    expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.insert).not.toHaveBeenCalled();
  });
  it("600秒絶対期限へ65秒headroomが欠けた送信はintent PUT前に停止する", async () => {
    const f = await interrupted(), emit = f.io.emit;
    let now = f.io.now(); f.io.now = () => now;
    f.io.emit = vi.fn(async record => {
      await emit(record);
      if ((record as { phase: string }).phase === "resolution_receipt_inflight") now += 535001;
    });
    await expect(runRawBackfill(f.reconcile, f.io)).rejects.toThrow("65秒headroom不足");
    expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.insert).not.toHaveBeenCalled();
    expect(f.objects.get(f.stateKey)).toEqual(f.oldState);
  });
  it.each([{ maxSeconds: 601 }, { maxBytes: 64 * 1024 ** 2 + 1 }])("reconcile上限超過は最初のGET前に止める: %j", async extra => {
    const f = await interrupted();
    await expect(runRawBackfill({ ...f.reconcile, ...extra }, f.io)).rejects.toThrow("64MiB/600秒以下");
    expect(f.io.get).not.toHaveBeenCalled(); expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.insert).not.toHaveBeenCalled();
  });
  it.each([true, false])("明示INSERT unknown（実適用=%s）はintentを保持し二度目も送信0", async (applied) => {
    const f = await interrupted(), insert = f.io.insert;
    f.io.insert = vi.fn(async row => { if (applied) await insert(row); throw new Error("reconcile send unknown"); });
    await expect(runRawBackfill(f.reconcile, f.io)).rejects.toThrow("reconcile send unknown");
    expect(f.state().inflight.phase).toBe("index_inflight");
    expect(f.objects.has(`ops-bucket/ops/raw-index/test-plan/resolutions/${sha}/complete.json`)).toBe(false);
    vi.mocked(f.io.put).mockClear(); vi.mocked(f.io.insert).mockClear();
    await expect(runRawBackfill(f.reconcile, f.io)).rejects.toThrow("intentが既存");
    expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.insert).not.toHaveBeenCalled();
  });
  it("intent CASの結果不明はINSERT0、残ったintentで次の明示runも停止する", async () => {
    const f = await interrupted(), put = f.io.put;
    f.io.put = vi.fn(async (...args: Parameters<BackfillIo["put"]>) => { await put(...args); throw new Error("intent unknown"); });
    await expect(runRawBackfill(f.reconcile, f.io)).rejects.toThrow("intent unknown");
    expect(f.io.put).toHaveBeenCalledTimes(1); expect(f.io.insert).not.toHaveBeenCalled();
    vi.mocked(f.io.put).mockClear();
    await expect(runRawBackfill(f.reconcile, f.io)).rejects.toThrow("intentが既存");
    expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.insert).not.toHaveBeenCalled();
    expect(f.objects.get(f.stateKey)).toEqual(f.oldState);
  });
  it("full15列の取得時計不一致もcompleteにせず旧ラッチを残す", async () => {
    const f = await interrupted(), insert = f.io.insert;
    f.io.insert = vi.fn(async row => { await insert({ ...row, first_fetched_at: 1 }); });
    await expect(runRawBackfill(f.reconcile, f.io)).rejects.toThrow("全列readbackが不一致");
    expect(f.objects.has(`ops-bucket/ops/raw-index/test-plan/resolutions/${sha}/complete.json`)).toBe(false);
    expect(f.objects.get(f.stateKey)).toEqual(f.oldState);
  });
  it.each([
    { mode: "dry" }, { limit: 50 }, { cutoff: undefined }, { reconcileSha256: undefined },
    { reconcileStateSha256: undefined }, { reconcileSha256: "not-hex" },
  ] as Array<Partial<RawBackfillOptions>>)("独立optionの不正組合せ %j はGET前に停止する", async change => {
    const f = await interrupted();
    await expect(runRawBackfill({ ...f.reconcile, ...change }, f.io)).rejects.toThrow("明示reconcile");
    expect(f.io.get).not.toHaveBeenCalled(); expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.insert).not.toHaveBeenCalled();
  });
});

describe("人間判断後の単一raw reconcile", () => {
  async function interrupted() {
    const f = fixture(), put = f.io.put;
    f.io.put = vi.fn(async (...args: Parameters<BackfillIo["put"]>) => { if (args[3] === f.io.rawBucket) throw new Error("old raw send unknown"); await put(...args); });
    await expect(runRawBackfill(opts, f.io)).rejects.toThrow("old raw send unknown"); f.io.put = put;
    const stateKey = "ops-bucket/ops/raw-index/test-plan/state.json", activeKey = "ops-bucket/ops/raw-index/active.json";
    const oldState = f.objects.get(stateKey)!, oldActive = f.objects.get(activeKey)!;
    const reconcile: RawBackfillOptions = { ...opts, limit: 1, maxSeconds: 600, cutoff: "2026-10-14T00:00:00.000Z", reconcileSha256: sha,
      reconcileStateSha256: createHash("sha256").update(oldState.body).digest("hex") };
    for (const fn of [f.io.get, f.io.put, f.io.list, f.io.download, f.io.index, f.io.insert, f.io.antiJoin, f.io.emit]) vi.mocked(fn).mockClear();
    f.events.length = 0; f.emitted.length = 0;
    return { ...f, reconcile, stateKey, activeKey, oldState, oldActive };
  }
  it("同⑤fullSHA→intent CAS/fullGET→raw単発CAS/fullGET→complete、旧state/索引を変更しない", async () => {
    const f = await interrupted(), result = await runRawBackfill(f.reconcile, f.io);
    expect(result).toMatchObject({ status: "manual_raw_reconciliation_complete", rawPuts: 1, rawGets: 3, d1Reads: 3, d1Inserts: 0,
      receiptGets: 13, receiptPuts: 2, r2Gets: 16, requestLimit: 25, notionDownloadAttempts: 1, notionNativeRequestLimit: 3,
      oldLatchUnchanged: true, cursor: 0, stateResets: 0, upstreamGets: 0, notionApiResponseBytesMeasured: false, httpHeadersMeasured: false });
    expect(f.io.download).toHaveBeenCalledWith(item, [item], expect.objectContaining({ signal: expect.any(AbortSignal),
      notionRequestOptions: { singleAttempt: true, beforeRequest: expect.any(Function) }, onAttempt: expect.any(Function) }));
    expect(f.io.put).toHaveBeenCalledTimes(3); expect(f.rawPuts()).toHaveLength(1);
    expect(f.io.insert).not.toHaveBeenCalled(); expect(f.io.list).not.toHaveBeenCalled();
    expect(f.objects.get(f.stateKey)).toEqual(f.oldState); expect(f.objects.get(f.activeKey)).toEqual(f.oldActive);
    const intent = `ops/raw-index/test-plan/resolutions/${sha}/intent.json`;
    const intentAt = f.events.indexOf(`ops-bucket:PUT:${intent}`), rawAt = f.events.indexOf(`raw-bucket:PUT:${key}`);
    expect(f.events.indexOf("hosted:GET")).toBeLessThan(intentAt);
    expect(f.events.indexOf(`ops-bucket:GET:${intent}`, intentAt)).toBeLessThan(rawAt);
    expect(f.events.indexOf("fsync:raw_reconciliation_put_inflight")).toBeLessThan(rawAt);
    expect(f.objects.get(`raw-bucket/${key}`)!.body).toEqual(body);
    for (const call of vi.mocked(f.io.put).mock.calls) expect(call[2]).toBeNull();
    const reads = await Promise.all(vi.mocked(f.io.get).mock.results.map(result => result.value));
    expect(result).toMatchObject({ measuredPayloadBytes: reads.reduce((sum, read) => sum + (read === null ? 0 : read.body.length), 0) +
      vi.mocked(f.io.put).mock.calls.reduce((sum, call) => sum + call[1].length, 0) + body.length });
    vi.mocked(f.io.put).mockClear(); vi.mocked(f.io.download).mockClear();
    await expect(runRawBackfill(f.reconcile, f.io)).rejects.toThrow("intentが既存"); expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.download).not.toHaveBeenCalled();
  });
  it.each(["source-sha", "wire-count", "raw-existing", "index-existing", "state-sha"])("資格失敗 %s はintent/raw/INSERT0", async fault => {
    const f = await interrupted();
    if (fault === "source-sha") { const download = f.io.download; f.io.download = vi.fn(async (...args: Parameters<BackfillIo["download"]>) => ({ ...await download(...args), body: new Uint8Array([1, 2, 3, 4]) })); }
    if (fault === "wire-count") { const download = f.io.download; f.io.download = vi.fn(async (...args: Parameters<BackfillIo["download"]>) => ({ ...await download(...args), wireBytes: 999 })); }
    if (fault === "raw-existing") f.objects.set(`raw-bucket/${key}`, { body, etag: '"existing"' });
    if (fault === "index-existing") f.rows.set(sha, expectedRawIndex(item, f.io.rawBucket, key));
    if (fault === "state-sha") f.reconcile.reconcileStateSha256 = "0".repeat(64);
    await expect(runRawBackfill(f.reconcile, f.io)).rejects.toThrow(); expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.insert).not.toHaveBeenCalled();
  });
  it.each(["success-partial", "metadata-429", "metadata-extra", "hosted-wait-deadline"])("shared native実数/.25rps/待機後guard: %s", async fault => {
    const f = await interrupted();
    vi.resetModules(); vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] }); vi.setSystemTime(f.io.now());
    const current = await import("./raw-index-backfill.js"), client = await import("../../src/shared/notion-archive/client.js");
    const { notionEnv } = await import("../../src/shared/notion-archive/env.js");
    vi.spyOn(notionEnv, "NOTION_TOKEN").mockReturnValue("protocol-test-token"); vi.spyOn(notionEnv, "NOTION_MAX_RPS").mockReturnValue(1.6);
    client.setNotionMaxRps(0.25); f.io.now = Date.now;
    const starts: number[] = []; let hosted = 0;
    const native = vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
      starts.push(performance.now());
      if (String(input).startsWith("https://api.notion.com/")) {
        if (fault === "hosted-wait-deadline") vi.setSystemTime(Date.now() + 534000);
        return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), { status: fault === "metadata-429" ? 429 : 200 });
      }
      hosted++;
      if (fault === "success-partial" && hosted === 1) {
        let sent = false; return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
          if (!sent) { sent = true; controller.enqueue(body.subarray(0, 2)); } else controller.error(new TypeError("terminated"));
        } }));
      }
      return new Response(body);
    });
    const find = vi.fn(async (_shas: readonly string[], options?: Parameters<typeof client.notionRequest>[3]) => {
      await client.notionRequest("POST", `/databases/${"a".repeat(32)}/query`, {}, options);
      if (fault === "metadata-extra") await client.notionRequest("POST", `/databases/${"a".repeat(32)}/query`, {}, options);
      return new Map([[sha, { raw, file: { name: raw.filename, url: "https://file.notion.so/source.zip" } }]]);
    });
    f.io.download = current.createRawDownloader(find);
    const settled = current.runRawBackfill(f.reconcile, f.io).then(value => ({ value, error: null }), error => ({ value: null, error }));
    await vi.runAllTimersAsync(); const outcome = await settled;
    expect(find).toHaveBeenCalledOnce(); expect(client.notionStats().requests).toBe(1);
    if (fault === "success-partial") {
      expect(outcome.error).toBeNull(); expect(outcome.value).toMatchObject({ notionApiNativeRequests: 1, notionDownloadAttempts: 2,
        notionNativeRequests: 3, notionDownloadBytes: 6, requests: 25, requestLimit: 25 });
      expect(starts).toEqual([0, 4000, 8000]); expect(native).toHaveBeenCalledTimes(3); expect(f.rawPuts()).toHaveLength(1);
    } else {
      expect(outcome.error).toBeInstanceOf(Error); expect(starts).toEqual([0]); expect(native).toHaveBeenCalledOnce();
      expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.insert).not.toHaveBeenCalled();
      if (fault === "hosted-wait-deadline") expect(outcome.error.message).toContain("65秒headroom");
    }
    vi.resetModules();
  });
  it("明示metadata guardはcacheを再利用せず同SHAの現在値をqueryし直す", async () => {
    const find = vi.fn(async () => new Map([[sha, { raw, file: { name: raw.filename, url: "https://file.notion.so/source.zip" } }]]));
    const download = vi.fn(async (_file, _context, options?: ArchivedDownloadOptions) => {
      await options!.onAttempt!({ phase: "start", attempt: 1, receivedBytes: 0 });
      await options!.onAttempt!({ phase: "complete", attempt: 1, receivedBytes: body.length, status: 200 }); return body;
    });
    const get = createRawDownloader(find, download); await get(item, [item]);
    const options = { singleAttempt: true, beforeRequest: vi.fn() }; await get(item, [item], { notionRequestOptions: options });
    expect(find).toHaveBeenCalledTimes(2); expect(vi.mocked(find).mock.calls[1]).toEqual([[sha], options]);
  });
  it.each(["third-hosted", "hosted-bytes", "post-sha", "raw-race", "index-race", "state-race"])("有限予算/直前/POST %s は追加mutation0", async fault => {
    const f = await interrupted();
    if (fault.startsWith("third") || fault === "hosted-bytes") f.io.download = vi.fn(async (_item, _cohort, options) => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await options!.onAttempt!({ phase: "start", attempt, receivedBytes: 0 });
        await options!.onAttempt!({ phase: "complete", attempt, receivedBytes: fault === "hosted-bytes" ? 67108865 : 1, status: 200 });
      } return { body, wireBytes: 3 };
    });
    const get = f.io.get, index = f.io.index; let rawReads = 0, stateReads = 0, indexReads = 0;
    f.io.get = vi.fn(async (...args: Parameters<BackfillIo["get"]>) => {
      const found = await get(...args);
      if (args[0] === key && args[1] === f.io.rawBucket && ++rawReads === (fault === "raw-race" ? 2 : 3)) {
        if (fault === "raw-race") return { body, etag: '"concurrent"' };
        if (fault === "post-sha") return { ...found!, body: new Uint8Array([1, 2, 3, 4]) };
      }
      if (args[0].endsWith("state.json") && ++stateReads === 2 && fault === "state-race") return { ...found!, etag: '"changed"' };
      return found;
    });
    if (fault === "index-race") f.io.index = vi.fn(async digest => ++indexReads === 2 ? expectedRawIndex(item, f.io.rawBucket, key) : index(digest));
    await expect(runRawBackfill(f.reconcile, f.io)).rejects.toThrow(); expect(f.io.insert).not.toHaveBeenCalled();
    expect(f.rawPuts()).toHaveLength(fault === "post-sha" ? 1 : 0);
    expect(f.objects.has(`ops-bucket/ops/raw-index/test-plan/resolutions/${sha}/complete.json`)).toBe(false);
    expect(f.objects.get(f.stateKey)).toEqual(f.oldState);
    if (fault === "third-hosted") expect(f.emitted.filter(r => (r as { phase?: string; attemptPhase?: string }).phase === "hosted_read_attempt" && (r as { attemptPhase?: string }).attemptPhase === "start")).toHaveLength(2);
    if (fault === "hosted-bytes") expect(f.emitted).toContainEqual(expect.objectContaining({ phase: "hosted_read_attempt", notionDownloadBytes: 67108865 }));
  });
  it.each([true, false])("intent PUT unknown/実適用=%s はraw0・同run再送0（不在intentの再dispatchは禁止）", async applied => {
    const f = await interrupted(), put = f.io.put;
    f.io.put = vi.fn(async (...args: Parameters<BackfillIo["put"]>) => { if (applied) await put(...args); throw new Error("intent unknown"); });
    await expect(runRawBackfill(f.reconcile, f.io)).rejects.toThrow("intent unknown"); expect(f.io.put).toHaveBeenCalledTimes(1); expect(f.rawPuts()).toHaveLength(0);
    expect(f.emitted).toContainEqual(expect.objectContaining({ phase: "resolution_receipt_inflight" }));
    expect(f.objects.get(f.stateKey)).toEqual(f.oldState);
    if (applied) { vi.mocked(f.io.put).mockClear(); await expect(runRawBackfill(f.reconcile, f.io)).rejects.toThrow("intentが既存"); expect(f.io.put).not.toHaveBeenCalled(); }
    else expect(f.objects.has(`ops-bucket/ops/raw-index/test-plan/resolutions/${sha}/intent.json`)).toBe(false);
  });
  it.each([["raw", true], ["raw", false], ["complete", true], ["complete", false]] as const)("%s PUT unknown/実適用=%s は既知intentで次明示runも送信0", async (phase, applied) => {
    const f = await interrupted(), put = f.io.put;
    f.io.put = vi.fn(async (...args: Parameters<BackfillIo["put"]>) => {
      if (phase === "raw" ? args[3] === f.io.rawBucket : args[0].endsWith("/complete.json")) {
        if (applied) await put(...args); throw new Error("raw operation unknown");
      } await put(...args);
    });
    await expect(runRawBackfill(f.reconcile, f.io)).rejects.toThrow("raw operation unknown");
    expect(f.objects.get(f.stateKey)).toEqual(f.oldState); expect(f.io.insert).not.toHaveBeenCalled();
    vi.mocked(f.io.put).mockClear(); vi.mocked(f.io.download).mockClear();
    await expect(runRawBackfill(f.reconcile, f.io)).rejects.toThrow("intentが既存"); expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.download).not.toHaveBeenCalled();
  });
  it("raw送信前fsync後の待機で65秒余裕を失えばrawPUT0、intentを残す", async () => {
    const f = await interrupted(), emit = f.io.emit; let now = f.io.now(); f.io.now = () => now;
    f.io.emit = vi.fn(async record => { await emit(record); if ((record as { phase: string }).phase === "raw_reconciliation_put_inflight") now += 535001; });
    await expect(runRawBackfill(f.reconcile, f.io)).rejects.toThrow("65秒headroom"); expect(f.rawPuts()).toHaveLength(0); expect(f.io.insert).not.toHaveBeenCalled();
    expect(f.objects.has(`ops-bucket/ops/raw-index/test-plan/resolutions/${sha}/intent.json`)).toBe(true);
  });
  it.each([true, false])("通常apply/inspectは元raw_inflightで自動raw再送0（原本実在=%s）", async exists => {
    const f = await interrupted(); if (exists) f.objects.set(`raw-bucket/${key}`, { body, etag: '"existing"' });
    try { await runRawBackfill(opts, f.io); } catch { /* The absent original remains an unknown STOP. */ }
    expect(f.rawPuts()).toHaveLength(0); expect(f.io.download).not.toHaveBeenCalled();
    vi.mocked(f.io.put).mockClear();
    await inspectRawBackfill({ ...f.reconcile, mode: "inspect", reconcileSha256: undefined, reconcileStateSha256: undefined }, f.io);
    expect(f.io.put).not.toHaveBeenCalled();
  });
});

describe("raw停止診断の秘密非開示", () => {
  it("許可した固定⑤メッセージだけを表示し、URL/body/causeはSHAへ閉じ込める", () => {
    expect(safeRawFailure(new Error("⑤原本の基準日が欠測しています。キー日付を捏造せず停止")).detail).toContain("基準日が欠測");
    const error = new TypeError("https://hosted.invalid/raw?signature=secret-body", { cause: new Error("Authorization secret-cause") });
    const safe = safeRawFailure(error);
    expect(safe).toMatchObject({ detail: "contract_or_transport_error", errorClass: "TypeError" });
    expect(safe.messageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(safe.causeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(safe)).not.toMatch(/hosted|secret|Authorization|signature/);
    expect(safeRawFailure(new Error("[raw-backfill] https://hosted.invalid/secret")).detail).toBe("contract_or_transport_error");
    expect(safeRawFailure(new Error("⑤原本secretTokenが空です")).detail).toBe("contract_or_transport_error");
  });
  it("Zodはissue code/pathだけを出し、input・message・unknown keysを含めない", () => {
    try { z.strictObject({ items: z.array(z.strictObject({ fetchedAt: z.string() })) }).parse({ items: [{ fetchedAt: null, secretToken: "secret-value" }] }); }
    catch (error) { const safe = safeRawFailure(error); expect(safe.issues).toEqual(expect.arrayContaining([{ code: "invalid_type", path: ["items", 0, "fetchedAt"] }])); expect(JSON.stringify(safe)).not.toMatch(/secret|Expected|Invalid input/); return; }
    throw new Error("schema must reject test input");
  });
});


describe("PUT後の独立readを重ねても索引安全境界を維持する", () => {
  it("body GET完了待ち中にD1 readが開始され、両成功後だけ索引へ進む", async () => {
    const f = fixture(), get = f.io.get, index = f.io.index;
    let releaseBody!: () => void, overlapped = false;
    const bodyReady = new Promise<void>(resolve => { releaseBody = resolve; });
    f.io.get = vi.fn(async (target, bucket) => {
      const got = await get(target, bucket);
      if (bucket === f.io.rawBucket && target === key && f.rawPuts().length === 1) await bodyReady;
      return got;
    });
    f.io.index = vi.fn(async digest => {
      if (f.rawPuts().length === 1) { overlapped = true; releaseBody(); }
      return index(digest);
    });
    expect(await runRawBackfill(opts, f.io)).toMatchObject({ status: "snapshot_complete", verified: 1 });
    expect(overlapped).toBe(true); expect(f.io.insert).toHaveBeenCalledTimes(1);
    expect(f.state()).toMatchObject({ cursor: 1, inflight: null });
  });
  it.each(["full-sha", "body-throw", "d1-throw", "invalid-index"])("%sはindex CAS/INSERT0、原raw latchを保持する", async kind => {
    const f = fixture(), get = f.io.get, index = f.io.index;
    let postBodySettled = false, postIndexSettled = false;
    f.io.get = vi.fn(async (target, bucket) => {
      const got = await get(target, bucket);
      if (bucket === f.io.rawBucket && target === key && f.rawPuts().length === 1) {
        await Promise.resolve(); postBodySettled = true;
        if (kind === "body-throw") throw new Error("post body read failure");
        if (kind === "full-sha") return { ...got!, body: new Uint8Array([1, 2, 3, 4]) };
      }
      return got;
    });
    f.io.index = vi.fn(async digest => {
      if (f.rawPuts().length === 1) {
        await Promise.resolve(); postIndexSettled = true;
        if (kind === "d1-throw") throw new Error("post D1 read failure");
        if (kind === "invalid-index") return { ...expectedRawIndex(item, f.io.rawBucket, key), source: "TDnet" };
      }
      return index(digest);
    });
    await expect(runRawBackfill(opts, f.io)).rejects.toThrow();
    expect(postBodySettled).toBe(true); expect(postIndexSettled).toBe(true);
    expect(f.io.insert).not.toHaveBeenCalled();
    expect(f.events).not.toContain("fsync:index_inflight");
    expect(f.state()).toMatchObject({ cursor: 0, inflight: { phase: "raw_inflight", sha256: sha } });
    expect(f.rawPuts()).toHaveLength(1);
  });
});

describe("RAW結果不明のread-only inspect", () => {
  const inspectOpts: RawBackfillOptions = { ...opts, mode: "inspect", limit: 2, maxSeconds: 600, cutoff: "2026-10-14T00:00:00.000Z" };
  const stateObject = "ops-bucket/ops/raw-index/test-plan/state.json", completeObject = "ops-bucket/ops/raw-index/test-plan/complete.json";
  async function prepared(inflight?: "raw_inflight" | "index_inflight") {
    const f = fixture();
    await runRawBackfill(opts, f.io);
    if (inflight !== undefined) {
      f.objects.set(stateObject, { body: new TextEncoder().encode(JSON.stringify({ ...f.state(), cursor: 0, inflight: { phase: inflight, sha256: sha, key } })), etag: '"unknown-state"' });
      f.objects.delete(completeObject);
    }
    const original = new Map([...f.objects].map(([name, version]) => [name, { ...version, body: Uint8Array.from(version.body) }]));
    for (const method of ["put", "insert", "list", "download", "antiJoin"] as const) {
      vi.mocked(f.io[method]).mockClear();
      vi.mocked(f.io[method]).mockImplementation(async () => { throw new Error(`inspect called forbidden ${method}`); });
    }
    vi.mocked(f.io.get).mockClear(); vi.mocked(f.io.index).mockClear(); f.emitted.length = 0;
    const unchanged = () => {
      expect(f.objects).toEqual(original);
      for (const method of ["put", "insert", "list", "download", "antiJoin"] as const) expect(f.io[method]).not.toHaveBeenCalled();
    };
    return { ...f, unchanged };
  }
  it("active/manifest/state/complete/current raw/indexを全文照合し、末尾CAS読取まで8request・書込0", async () => {
    const f = await prepared(), result = await runRawBackfill(inspectOpts, f.io);
    expect(result).toMatchObject({ status: "read_only_inspection_complete", cursor: 1, remaining: 0,
      requests: 8, receiptGets: 6, rawGets: 1, d1Reads: 1, unknownCleared: false, oldStateUnchanged: true,
      subjects: [{ position: 0, sha256: sha, notionPageId: item.pageId, rawKey: key, rawFullShaVerified: true, indexPresent: true,
        indexMetadataVerified: true, indexDocIdStatus: "verified_archived_id" }], continuationAllowed: false,
      currentReceiptState: "no_persistent_inflight_observed", originalFailedReceiptAcknowledgement: "unavailable_original_payload_not_reconstructed" });
    expect(vi.mocked(f.io.get).mock.calls.filter(([target]) => target.endsWith("manifest.json"))).toHaveLength(1);
    for (const call of vi.mocked(f.io.get).mock.calls) expect(call[2]).toMatchObject({ singleAttempt: true, maxBytes: expect.any(Number), abortSignal: expect.any(AbortSignal) });
    expect(f.emitted.filter(record => (record as { phase?: string }).phase === "inspect_object")).toHaveLength(7);
    expect(JSON.stringify(result)).not.toContain("never-log"); expect(JSON.stringify(result)).not.toContain("sourceUrl"); expect(JSON.stringify(result)).not.toContain("bodyBase64");
    f.unchanged();
  });
  it.each(["raw_inflight", "index_inflight"] as const)("%sはresolution2receiptも予算に数え、raw/index実在でもunknownを解除しない", async phase => {
    const f = await prepared(phase), result = await inspectRawBackfill(inspectOpts, f.io);
    expect(result).toMatchObject({ cursor: 0, requests: 10, receiptGets: 8, rawGets: 1, d1Reads: 1, inflightPhase: phase, unknownCleared: false,
      currentReceiptState: "persistent_inflight_retained" });
    expect(result.receipts.filter(row => row.name.startsWith("resolution_"))).toEqual([
      { name: "resolution_intent", present: false }, { name: "resolution_complete", present: false }]);
    f.unchanged();
  });
  it("未知rawが実在しなくても欠測をそのまま報告し、原PUT/INSERT/clearへ進まない", async () => {
    const f = await prepared("raw_inflight");
    f.rows.delete(sha); f.objects.delete(`raw-bucket/${key}`);
    const state = Uint8Array.from(f.objects.get(stateObject)!.body);
    expect(await inspectRawBackfill(inspectOpts, f.io)).toMatchObject({ inflightPhase: "raw_inflight", unknownCleared: false,
      subjects: [{ indexPresent: false, rawPresent: false, rawFullShaVerified: false }] });
    expect(f.objects.get(stateObject)!.body).toEqual(state); expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.insert).not.toHaveBeenCalled();
  });
  it("current/previousを最大2件だけ読み、実legacy探索も1GETずつ予算へ数える", async () => {
    const f = await prepared(), encoder = new TextEncoder();
    const secondBody = new Uint8Array([1, 2, 3, 4]), secondSha = createHash("sha256").update(secondBody).digest("hex");
    const second = { ...item, sha256: secondSha, pageId: "c".repeat(32) };
    const items = [item, second].sort((a, b) => a.sha256.localeCompare(b.sha256));
    const manifestKey = "ops-bucket/ops/raw-index/test-plan/manifest.json", activeKey = "ops-bucket/ops/raw-index/active.json";
    const manifest = parseRawManifest({ ...JSON.parse(new TextDecoder().decode(f.objects.get(manifestKey)!.body)), expectedCount: 2, items }, { ...inspectOpts, expectedCount: 2 }, f.io.rawBucket);
    const bytes = encoder.encode(JSON.stringify(manifest)), manifestSha256 = createHash("sha256").update(bytes).digest("hex");
    f.objects.set(manifestKey, { body: bytes, etag: '"two"' });
    f.objects.set(activeKey, { body: encoder.encode(JSON.stringify({ version: 1, planId: opts.planId, manifestSha256 })), etag: '"active-two"' });
    f.objects.set(stateObject, { body: encoder.encode(JSON.stringify({ version: 1, manifestSha256, cursor: 1, inflight: null })), etag: '"state-two"' });
    f.objects.delete(completeObject); f.rows.clear();
    const previous = items[0]!, previousBody = previous.sha256 === sha ? body : secondBody, previousKey = canonicalRawKey({ ...previous, sourceUrl: null }, previous.docId);
    f.objects.set(`raw-bucket/${previousKey}`, { body: previousBody, etag: '"previous"' });
    f.rows.set(previous.sha256, expectedRawIndex(previous, f.io.rawBucket, previousKey));
    const current = items[1]!, currentKey = canonicalRawKey({ ...current, sourceUrl: null }, current.docId);
    f.objects.delete(`raw-bucket/${currentKey}`);
    const result = await inspectRawBackfill({ ...inspectOpts, expectedCount: 2 }, f.io);
    expect(result).toMatchObject({ requests: 11, receiptGets: 6, rawGets: 3, d1Reads: 2 });
    expect(result.subjects).toMatchObject([{ position: 1, indexPresent: false, rawPresent: false }, { position: 0, indexPresent: true, rawFullShaVerified: true }]);
    expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.insert).not.toHaveBeenCalled();
  });
  it("旧cursorが完了を主張する項目の索引欠測は診断成功にせずSTOP", async () => {
    const f = await prepared(); f.rows.delete(sha);
    await expect(inspectRawBackfill(inspectOpts, f.io)).rejects.toThrow("旧cursor完了項目が未検証"); f.unchanged();
  });
  it("安全なpath以外の旧keyはprivateだけに保持し、console summaryへ秘密を混ぜない", async () => {
    const f = await prepared("index_inflight"), unsafeKey = `${key}?secret=private-only`;
    f.rows.set(sha, { ...f.rows.get(sha)!, r2_key: unsafeKey });
    f.objects.set(`raw-bucket/${unsafeKey}`, { body, etag: '"unsafe-key"' });
    f.objects.set(stateObject, { body: new TextEncoder().encode(JSON.stringify({ ...f.state(), inflight: { phase: "index_inflight", sha256: sha, key: unsafeKey } })), etag: '"unsafe-state"' });
    const result = await inspectRawBackfill(inspectOpts, f.io);
    expect(result.subjects[0]).toMatchObject({ rawKey: null, rawKeyDisclosure: "private_only_not_safe_to_publish", rawFullShaVerified: true });
    expect(JSON.stringify(result)).not.toContain("private-only"); expect(JSON.stringify(f.emitted)).toContain("private-only");
    expect(f.io.put).not.toHaveBeenCalled(); expect(f.io.insert).not.toHaveBeenCalled();
  });
  it.each(["state-tail", "raw-sha", "index-metadata", "transport"])("%s faultでSTOPし、旧全object/latchとmutation0を保持", async fault => {
    const f = await prepared("index_inflight"), get = f.io.get, index = f.io.index;
    let stateReads = 0;
    f.io.get = vi.fn(async (...args: Parameters<BackfillIo["get"]>) => {
      const found = await get(...args);
      if (args[0].endsWith("state.json") && ++stateReads === 2 && fault === "state-tail") return { ...found!, etag: '"changed"' };
      if (args[1] === f.io.rawBucket) {
        if (fault === "raw-sha") return { ...found!, body: new Uint8Array([1, 2, 3, 4]) };
        if (fault === "transport") throw new Error("native GET unknown");
      }
      return found;
    });
    if (fault === "index-metadata") f.io.index = vi.fn(async digest => ({ ...(await index(digest))!, source: "TDnet" }));
    await expect(inspectRawBackfill(inspectOpts, f.io)).rejects.toThrow(); f.unchanged();
  });
  it("body途中失敗は16KiB prefix/complete=falseをprivate emitし、再GETしない", async () => {
    const f = await prepared(), get = f.io.get;
    f.io.get = vi.fn(async (...args: Parameters<BackfillIo["get"]>) => {
      if (args[0].endsWith("manifest.json")) {
        await args[2]!.onRead!({ status: 200, etag: '"partial"', contentLength: 50000, body: new Uint8Array(20000), receivedBytes: 20000, complete: false });
        throw new Error("stream interrupted");
      }
      return get(...args);
    });
    await expect(inspectRawBackfill(inspectOpts, f.io)).rejects.toThrow("stream interrupted");
    const partial = f.emitted.find(record => (record as { phase?: string }).phase === "inspect_partial_body") as { complete: boolean; prefixBase64: string; receivedBytes: number };
    expect(partial.complete).toBe(false); expect(Buffer.from(partial.prefixBase64, "base64")).toHaveLength(16384); expect(partial.receivedBytes).toBe(20000);
    expect(vi.mocked(f.io.get).mock.calls.filter(([target]) => target.endsWith("manifest.json"))).toHaveLength(1); f.unchanged();
  });
  it.each(["bytes", "time", "limit", "reconcile"])("%s予算/別modeの逸脱はsource mutationなしでSTOP", async fault => {
    const f = await prepared(), bad = { ...inspectOpts };
    if (fault === "bytes") bad.maxBytes = 1;
    if (fault === "time") bad.maxSeconds = 64;
    if (fault === "limit") bad.limit = 3;
    if (fault === "reconcile") { bad.reconcileSha256 = sha; bad.reconcileStateSha256 = sha; }
    await expect(inspectRawBackfill(bad, f.io)).rejects.toThrow(); f.unchanged();
  });
});
