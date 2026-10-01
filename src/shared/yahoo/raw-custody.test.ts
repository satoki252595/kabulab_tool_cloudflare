import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveYahooRawBatch, type YahooRawAttempt, type YahooRawBatchInput } from "./raw-custody.js";
import { MAX_YAHOO_RAW_BYTES } from "./client.js";
import { recordPrimaryData, verifyArchivedAttachments, type RecordPrimaryDataInput } from "../notion-archive/index.js";
import { sha256HexBytes } from "../sha256.js";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSummaryLocal } from "../../../scripts/vwap/lib/ingest-guard.js";

let localDir: string;
vi.mock("../../../scripts/vwap/lib/ingest-guard.js", async (original) => ({
  ...await original<typeof import("../../../scripts/vwap/lib/ingest-guard.js")>(), writeSummaryLocal: vi.fn(),
}));

vi.mock("../notion-archive/index.js", () => ({ recordPrimaryData: vi.fn(), verifyArchivedAttachments: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  localDir = mkdtempSync(join(tmpdir(), "yahoo-custody-test-"));
  vi.mocked(writeSummaryLocal).mockImplementation((summary) => {
    const dir = localDir;
    // privateローカル保管の実関数を使用。archive mockとは別境界。
    return realLocalWriter(summary, dir);
  });
  vi.mocked(recordPrimaryData).mockResolvedValue({ pageId: "physical-page", outcome: "recorded", fileTooLarge: false, manifestMatch: "written" });
  vi.mocked(verifyArchivedAttachments).mockResolvedValue(undefined);
});
afterEach(() => rmSync(localDir, { recursive: true, force: true }));
const { writeSummaryLocal: realLocalWriter } = await vi.importActual<typeof import("../../../scripts/vwap/lib/ingest-guard.js")>("../../../scripts/vwap/lib/ingest-guard.js");
const attempt = (symbol: string, bytes = new Uint8Array([0, 255, 10, 123])): YahooRawAttempt => ({
  api: "chart", attempt: 0, capture: { symbol, status: 429, bytes,
    receivedAt: "2026-10-01T17:13:20.123Z", headers: { contentType: "application/octet-stream" },
    url: "https://test.invalid/api?crumb=secret&symbol=1301" },
});
const input = (captures: YahooRawAttempt[]): YahooRawBatchInput => ({ service: "stock-sync", runId: "12345.1",
  stage: "stocks-first", expectedDate: "2026-10-01", captures });
async function body(record: RecordPrimaryDataInput) {
  const file = record.files![0];
  const stream = new Blob([Uint8Array.from(file.bytes)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

describe("Yahoo原文batchの物理保管境界", () => {
  it("invalid JSONやHTTP失敗本文も無改変でgzip内SHA照合し、Notion原bytes readbackを待つ", async () => {
    const raw = new Uint8Array([0, 255, 10, 123]);
    const events: string[] = [];
    vi.mocked(recordPrimaryData).mockImplementation(async () => {
      events.push("archive"); return { pageId: "p", outcome: "recorded", fileTooLarge: false, manifestMatch: "written" };
    });
    vi.mocked(verifyArchivedAttachments).mockImplementation(async () => { events.push("readback"); });
    const result = await archiveYahooRawBatch(input([attempt("1301", raw)]));
    events.push("return");
    expect(events).toEqual(["archive", "readback", "return"]);
    const record = vi.mocked(recordPrimaryData).mock.calls[0][0];
    expect(record.force).toBe(false);
    expect(statSync(localDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(localDir, record.files![0].filename)).mode & 0o777).toBe(0o600);
    expect(record.fetchedAt).toBe("2026-10-01T17:13:20.123Z");
    const wrapper = await body(record);
    const member = wrapper.members[0];
    expect(Uint8Array.from(atob(member.bodyBase64), (c) => c.charCodeAt(0))).toEqual(raw);
    expect(member.sha256).toBe(await sha256HexBytes(raw));
    expect(member.status).toBe(429);
    expect(member.url).not.toContain("secret");
    expect(member.url).toContain("symbol=1301");
    expect(result.pages).toEqual(["p"]);
    expect(result.rawBytes).toBe(raw.length);
    expect(verifyArchivedAttachments).toHaveBeenCalledWith("p", [{ filename: record.files![0].filename, bytes: record.files![0].bytes }], "Yahoo原本batch");
  });

  it("元raw合計8MiB境界で固定分割し、memberを一度ずつ保管する", async () => {
    await archiveYahooRawBatch(input([attempt("1301", new Uint8Array(MAX_YAHOO_RAW_BYTES)), attempt("1332", new Uint8Array([7]))]));
    expect(recordPrimaryData).toHaveBeenCalledTimes(2);
    const wrappers = await Promise.all(vi.mocked(recordPrimaryData).mock.calls.map(([r]) => body(r)));
    expect(wrappers.map((w) => w.members.map((m: { symbol: string }) => m.symbol))).toEqual([["1301"], ["1332"]]);
    expect(wrappers.map((w) => [w.part, w.parts])).toEqual([[0, 2], [1, 2]]);
    expect(verifyArchivedAttachments).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["単一raw上限超過", () => input([attempt("1301", new Uint8Array(MAX_YAHOO_RAW_BYTES + 1))])],
    ["capture clock不明", () => input([{ ...attempt("1301"), capture: { ...attempt("1301").capture, receivedAt: "" } }])],
    ["重複attempt", () => input([attempt("1301"), attempt("1301")])],
    ["取得なし", () => input([])],
  ])("%s はPOST前STOP", async (_name, make) => {
    await expect(archiveYahooRawBatch(make())).rejects.toThrow();
    expect(recordPrimaryData).not.toHaveBeenCalled();
  });

  it("skipped/manifest unknownは新規物理保管の証明にせず再POST0", async () => {
    vi.mocked(recordPrimaryData).mockResolvedValue({ pageId: "p", outcome: "skipped_existing",
      fileTooLarge: false, manifestMatch: "unknown" });
    await expect(archiveYahooRawBatch(input([attempt("1301")]))).rejects.toThrow("再送せずSTOP");
    expect(recordPrimaryData).toHaveBeenCalledTimes(1);
    expect(verifyArchivedAttachments).not.toHaveBeenCalled();
  });

  it("fileTooLargeおよびhosted attachment不一致は成功にしない", async () => {
    vi.mocked(recordPrimaryData).mockResolvedValueOnce({ pageId: "p", outcome: "recorded", fileTooLarge: true, manifestMatch: "written" });
    await expect(archiveYahooRawBatch(input([attempt("1301")]))).rejects.toThrow("STOP");
    vi.mocked(verifyArchivedAttachments).mockRejectedValueOnce(new Error("hosted SHA mismatch"));
    await expect(archiveYahooRawBatch({ ...input([attempt("1332")]), stage: "stocks-recovery" })).rejects.toThrow("hosted SHA mismatch");
    expect(recordPrimaryData).toHaveBeenCalledTimes(2);
  });

  it("bodyなしtransportは実失敗clock/理由だけ保管しraw本文を捏造しない", async () => {
    await archiveYahooRawBatch({ ...input([]), missing: [{ api: "quote-summary", symbol: "1301", attempt: 2,
      failedAt: "2026-10-01T17:14:20.500Z", error: "fetch failed https://test.invalid/?crumb=secret" }] });
    const record = vi.mocked(recordPrimaryData).mock.calls[0][0];
    const wrapper = await body(record);
    expect(wrapper.members).toEqual([]);
    expect(wrapper.missing).toHaveLength(1);
    expect(wrapper.missing[0].error).not.toContain("secret");
    expect(record.metadata).toMatchObject({ captures: 0, missing: 1, rawBytes: 0 });
    expect(record.fetchedAt).toBe("2026-10-01T17:14:20.500Z");
  });
});


describe("private local全parts保管", () => {
  it("後半POST unknownでも全partsが残り、そのPOSTを再送しない", async () => {
    vi.mocked(recordPrimaryData).mockImplementation(async () => {
      expect(readdirSync(localDir)).toHaveLength(2);
      if (vi.mocked(recordPrimaryData).mock.calls.length === 2) throw new Error("POST result unknown");
      return { pageId: "p", outcome: "recorded", fileTooLarge: false, manifestMatch: "written" };
    });
    await expect(archiveYahooRawBatch(input([attempt("1301", new Uint8Array(MAX_YAHOO_RAW_BYTES)), attempt("1332", new Uint8Array([1]))])))
      .rejects.toThrow("POST result unknown");
    expect(recordPrimaryData).toHaveBeenCalledTimes(2);
    expect(verifyArchivedAttachments).toHaveBeenCalledTimes(1);
    expect(readdirSync(localDir)).toHaveLength(2);
  });
  it("private local保存失敗はNotion送信0", async () => {
    vi.mocked(writeSummaryLocal).mockReturnValue({ ok: false, reason: "disk full" });
    await expect(archiveYahooRawBatch(input([attempt("1301")]))).rejects.toThrow("Notion送信前STOP");
    expect(recordPrimaryData).not.toHaveBeenCalled();
  });
});
