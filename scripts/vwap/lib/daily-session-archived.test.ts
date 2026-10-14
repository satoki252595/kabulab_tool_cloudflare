import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMacroJpLeg } from "../../../src/cron/macro-jp-leg.js";
import { fetchChart, parseChartResponse } from "../../../src/shared/yahoo/client.js";
import { guardChartBars } from "../../../src/shared/yahoo/bar-sanity.js";
import { archiveYahooRawBatch } from "../../../src/shared/yahoo/raw-custody.js";
import { notionRequest } from "../../../src/shared/notion-archive/client.js";
import { downloadArchivedFile } from "../../moneyflow/lib/archived-files.js";
import { r2GetVersion, r2Put } from "./r2.js";
import { loadArchivedDailySessionReference, qualifyDailySessionReference, resolveDailySessionSource } from "./daily-session.js";

vi.mock("../../../src/cron/macro-jp-leg.js", async (original) => ({ ...await original<typeof import("../../../src/cron/macro-jp-leg.js")>(), loadMacroJpLeg: vi.fn() }));
vi.mock("../../../src/shared/yahoo/client.js", async (original) => ({ ...await original<typeof import("../../../src/shared/yahoo/client.js")>(), fetchChart: vi.fn() }));
vi.mock("../../../src/shared/yahoo/raw-custody.js", () => ({ archiveYahooRawBatch: vi.fn() }));
vi.mock("../../../src/shared/notion-archive/client.js", async (original) => ({ ...await original<typeof import("../../../src/shared/notion-archive/client.js")>(), notionRequest: vi.fn() }));
vi.mock("../../moneyflow/lib/archived-files.js", () => ({ downloadArchivedFile: vi.fn() }));
vi.mock("./r2.js", async (original) => ({ ...await original<typeof import("./r2.js")>(), r2GetVersion: vi.fn(), r2Put: vi.fn() }));
const date = "2026-10-14", clock = "2026-10-14T09:02:12.223Z", now = "2026-10-14T10:20:00.000Z";
const raw = readFileSync(new URL("./__fixtures__/n225-20261014-close.json", import.meta.url));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const pageId = "3f9d74ff-84cd-815b-a772-c5f3536ce88a", runId = "structural-test";
const filename = `yahoo-raw-${runId}-stocks-session-part-0.json.gz`;
const nativeText = (kind: string, content: string) => ({ type: kind, [kind]: [{ type: "text", plain_text: content, text: { content } }] });
function physical(change?: (wrapper: { members: Array<{ bodyBase64: string; receivedAt: string; symbol: string }> }) => void) {
  // Wire envelope is a mechanism fixture around the unchanged actual response.
  const wrapper = { version: 1, service: "stock-sync", runId, stage: "stocks-session", expectedDate: date, part: 0, parts: 1,
    members: [{ api: "chart", attempt: 0, symbol: "^N225", status: 200, receivedAt: clock, byteLength: raw.length, sha256: sha(raw), bodyBase64: raw.toString("base64"),
      url: "https://query1.finance.yahoo.com/v8/finance/chart/%5EN225?range=1mo&interval=1d" }], missing: [] };
  change?.(wrapper);
  const gzip = gzipSync(JSON.stringify(wrapper));
  const metadata = { runId, stage: "stocks-session", expectedDate: date, part: 0, parts: 1, captures: 1, missing: 0,
    _fileManifest: { version: 1, inputFingerprint: sha(gzip), files: [{ originalFilename: filename, uploadFilename: filename, upload: "uploaded", byteLength: gzip.length, sha256: sha(gzip) }] } };
  const page = { object: "page", id: pageId, archived: false, in_trash: false, parent: { type: "database_id", database_id: "1".repeat(32) }, properties: {
    Key: nativeText("title", filename.slice(0, -8)), Metadata: nativeText("rich_text", JSON.stringify(metadata)), Status: { type: "select", select: { name: "recorded" } },
    Files: { type: "files", files: [{ name: filename, type: "file", file: { url: "https://file.notion.so/structural-test" } }] },
  } };
  return { gzip, page };
}
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date(now));
  const envelope = physical(); vi.mocked(notionRequest).mockResolvedValue(envelope.page); vi.mocked(downloadArchivedFile).mockResolvedValue(envelope.gzip);
  const cache = { n225: { bodyBase64: raw.toString("base64"), status: 200, receivedAt: clock }, archive: { manifestBase64: Buffer.from(JSON.stringify({ runId })).toString("base64") } };
  vi.mocked(r2GetVersion).mockResolvedValue({ body: JSON.stringify(cache), etag: "observed" });
  vi.mocked(loadMacroJpLeg).mockImplementation(async (store, d) => {
    expect(d).toBe(date); await store.get(`macro/jp-close/${date}.json`);
    return { n225: { value: 67744.2890625, prev: 67777.5234375, date }, nikkeiVi: 28.09, nikkeiViDate: date,
      reference: { kind: "archived-jp-leg", expectedDate: date, cacheKey: `macro/jp-close/${date}.json`, archivePageId: "3f9d74ff-84cd-8115-a6fc-f4d19bacd5ae", manifestSha256: "8f39a04649109715fc1cad4669d27b411b7f13c25bc8662f04de9c086285d81e",
        n225: { sha256: sha(raw), receivedAt: clock, archivePages: [pageId] }, vi: { sha256: "bff9db7d529c02e87168c165ee7fa4718b0a30bf53f6bf6111081bb3013eb418", receivedAt: "2026-10-14T09:02:16.025Z", status: 200 } } };
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("explicit same-day archived JP benchmark", () => {
  it("qualifies the unchanged real 18:02 capture with the existing direct-source math", () => {
    const parsed = parseChartResponse(JSON.parse(raw.toString()), "^N225");
    const { bars } = guardChartBars(parsed.bars, parsed.meta.regularMarketPrice, "^N225");
    expect(sha(raw)).toBe("82343be04851794a5dfe682e22a8cb7a731159aaf256a8a9e993f02ba1d38772");
    expect(qualifyDailySessionReference({ bytes: raw, symbol: "^N225", status: 200, receivedAt: clock }, bars)).toEqual({ date, observedAt: clock, rawSha: sha(raw) });
  });
  it("keeps the original clock/SHA after one cache read and full physical N225 read, with no source or archive mutation", async () => {
    const result = await loadArchivedDailySessionReference(date);
    expect(result.reference).toEqual({ date, observedAt: clock, rawSha: sha(raw) });
    expect(result.custody.n225ArchivePageId).toBe(pageId); expect(result.custody.n225Filename).toBe(filename);
    expect(r2GetVersion).toHaveBeenCalledTimes(1); expect(notionRequest).toHaveBeenCalledTimes(1); expect(downloadArchivedFile).toHaveBeenCalledTimes(1);
    expect(fetchChart).not.toHaveBeenCalled(); expect(archiveYahooRawBatch).not.toHaveBeenCalled(); expect(r2Put).not.toHaveBeenCalled();
  });
  it.each([
    ["changed body", (w: { members: Array<{ bodyBase64: string; receivedAt: string; symbol: string }> }) => { w.members[0].bodyBase64 = Buffer.from("changed").toString("base64"); }],
    ["changed original clock", (w: { members: Array<{ bodyBase64: string; receivedAt: string; symbol: string }> }) => { w.members[0].receivedAt = now; }],
    ["wrong target", (w: { members: Array<{ bodyBase64: string; receivedAt: string; symbol: string }> }) => { w.members[0].symbol = "^GSPC"; }],
  ])("%s stops without a direct-source retry", async (_name, change) => {
    const e = physical(change); vi.mocked(notionRequest).mockResolvedValue(e.page); vi.mocked(downloadArchivedFile).mockResolvedValue(e.gzip);
    await expect(loadArchivedDailySessionReference(date)).rejects.toThrow();
    expect(fetchChart).not.toHaveBeenCalled(); expect(archiveYahooRawBatch).not.toHaveBeenCalled(); expect(r2GetVersion).toHaveBeenCalledTimes(1);
  });
  it("cache missing or failed physical transport remains a STOP, never a fallback", async () => {
    vi.mocked(loadMacroJpLeg).mockResolvedValueOnce(null);
    await expect(loadArchivedDailySessionReference(date)).rejects.toThrow("保存JP原本");
    expect(notionRequest).not.toHaveBeenCalled(); expect(fetchChart).not.toHaveBeenCalled();
    vi.mocked(downloadArchivedFile).mockRejectedValueOnce(new Error("unknown read"));
    await expect(loadArchivedDailySessionReference(date)).rejects.toThrow("unknown read");
    expect(downloadArchivedFile).toHaveBeenCalledTimes(1); expect(fetchChart).not.toHaveBeenCalled();
  });
  it("rejects mismatched gzip SHA and stops if the physical read crosses midnight", async () => {
    vi.mocked(downloadArchivedFile).mockResolvedValueOnce(new Uint8Array([1]));
    await expect(loadArchivedDailySessionReference(date)).rejects.toThrow();
    vi.mocked(downloadArchivedFile).mockImplementationOnce(async () => { vi.setSystemTime(new Date("2026-10-14T15:00:00.000Z")); return physical().gzip; });
    await expect(loadArchivedDailySessionReference(date)).rejects.toThrow("同日date");
    expect(fetchChart).not.toHaveBeenCalled();
  });
  it("validates source/date before any read and preserves the old direct default", async () => {
    expect(resolveDailySessionSource(undefined, undefined, now)).toEqual({ kind: "yahoo-direct" });
    for (const [source, d] of [["archived-jp-leg", undefined], ["archived-jp-leg", "2026-10-13"], ["archived-jp-leg", "2026-10-15"], ["yahoo-direct", date], ["unknown", date]]) {
      expect(() => resolveDailySessionSource(source, d, now)).toThrow();
    }
    await expect(loadArchivedDailySessionReference("2026-10-13")).rejects.toThrow();
    expect(r2GetVersion).not.toHaveBeenCalled(); expect(notionRequest).not.toHaveBeenCalled(); expect(fetchChart).not.toHaveBeenCalled();
  });
});
