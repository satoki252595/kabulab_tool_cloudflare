import { readFileSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFinancials, parseFinancialCaptureArgs, projectFinancialPage, type FinancialCaptureOptions } from "./financial-null-capture.js";
const saved = JSON.parse(readFileSync(new URL("./fixtures/financial-null-634a.json", import.meta.url), "utf8"));
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const folders: string[] = [];
beforeEach(() => vi.stubEnv("NOTION_TOKEN", "declared-transport-test-token"));
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const folder of folders.splice(0)) await fs.rm(folder, { recursive: true }); });
async function options(extra: Partial<FinancialCaptureOptions> = {}) {
  const parent = await fs.mkdtemp(path.join(tmpdir(), "financial-capture-")); folders.push(parent);
  return { codes: ["634A"], codesSha256: sha('["634A"]'), offset: 0, maxCodes: 1, maxPages: 1,
    maxHttp: 2, deadline: new Date(Date.now() + 60_000).toISOString(), out: path.join(parent, "capture"), ...extra };
}
function transport(response: unknown = saved.response) {
  return vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes("/query") ? response : saved.schema), { status: 200 }));
}

describe("financial capture CLI arguments", () => {
  const argv = ["--codes=tmp/codes.json", `--codes-sha256=${sha('["634A"]')}`, "--offset=0",
    "--max-codes=1", "--max-pages=1", "--max-http=2", `--deadline=${new Date().toISOString()}`,
    "--out=tmp/capture", "--env-file=.env", "--python=pipeline/.venv/bin/python"];
  it("accepts every required normal CLI argument, including the SHA256 name", () => {
    const args = parseFinancialCaptureArgs(argv);
    expect(args.size).toBe(10);
    expect(args.get("codes-sha256")).toBe(sha('["634A"]'));
    expect(args.get("max-http")).toBe("2");
    expect(args.get("env-file")).toBe(".env");
  });
  it.each([
    [...argv, "--codes=tmp/other-codes.json"],
    [...argv, "--unknown=1"],
    argv.filter(arg => !arg.startsWith("--codes-sha256=")),
    argv.map(arg => arg.startsWith("--codes-sha256=") ? "--codes-sha256=" : arg),
  ])("rejects duplicate, unknown, missing or empty arguments", (...args) => {
    expect(() => parseFinancialCaptureArgs(args)).toThrow();
  });
});

describe("financial-only bounded capture (unchanged captured 634A facts)", () => {
  it("retains exact 31 properties, bitmap, response SHA, natural partition end and private permissions", async () => {
    const opts = await options(), fetch = transport(); vi.stubGlobal("fetch", fetch);
    const result = await captureFinancials(opts, saved.contract);
    expect(result).toMatchObject({ status: "complete", acceptedRows: 1, requests: 2, allHistoryClassified: false, writes: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
    const page = result.pages[0]!, bytes = await fs.readFile(path.join(opts.out, page.file));
    expect(sha(bytes)).toBe(page.sha256); expect(page).toMatchObject({ hasMore: false, nextCursor: null });
    expect(projectFinancialPage(saved.response.results[0], saved.contract.fields).nullBitmap).toBe("0000000100001111111");
    expect((await fs.stat(opts.out)).mode & 0o077).toBe(0);
    for (const file of await fs.readdir(opts.out)) expect((await fs.stat(path.join(opts.out, file))).mode & 0o077).toBe(0);
  });
  it("explicit incomplete is saved before shared rejection, not accepted or retried", async () => {
    // Declared envelope fault observed in the unpartitioned audit; financial facts stay unchanged.
    const response = { ...saved.response, request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" } };
    const opts = await options(), fetch = transport(response); vi.stubGlobal("fetch", fetch);
    const result = await captureFinancials(opts, saved.contract);
    expect(result).toMatchObject({ status: "stopped", acceptedRows: 0, requests: 2, pages: [], retry: 0 });
    expect(JSON.parse(await fs.readFile(path.join(opts.out, "http-0002.response.json"), "utf8")).request_status).toEqual(response.request_status);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("page cap retains cursor and partial; outside chunk and budget-unstarted codes remain unobserved", async () => {
    // Protocol-only pagination injection; no invented or repeated financial record.
    const response = { ...saved.response, has_more: true, next_cursor: "declared-next-page-control" };
    const opts = await options({ codes: ["634A", "624A", "593A"], maxCodes: 2 });
    vi.stubGlobal("fetch", transport(response));
    const result = await captureFinancials(opts, saved.contract);
    expect(result).toMatchObject({ status: "partial", unstartedSelectedCodes: ["624A"], codesOutsideThisRun: ["593A"], cohortFullyObservedThisRun: false });
    expect(result.partitions[0]).toMatchObject({ status: "partial", nextCursor: response.next_cursor, pages: 1 });
  });
  it("unknown metric type stays unknown, and expired/invalid scope fails before HTTP", async () => {
    const page = structuredClone(saved.response.results[0]); page.properties["ROA%"] = { type: "rich_text", rich_text: [] };
    expect(projectFinancialPage(page, saved.contract.fields).nullBitmap[7]).toBe("?");
    const fetch = transport(); vi.stubGlobal("fetch", fetch);
    await expect(captureFinancials(await options({ deadline: new Date(Date.now() - 1).toISOString() }), saved.contract)).rejects.toThrow();
    await expect(captureFinancials(await options({ codes: [] }), saved.contract)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("unknown transport sends once, preserves STOP and unstarted partitions", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("declared transport failure"); }); vi.stubGlobal("fetch", fetch);
    const result = await captureFinancials(await options(), saved.contract);
    expect(result).toMatchObject({ status: "stopped", requests: 1, acceptedRows: 0, unstartedSelectedCodes: ["634A"], retry: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
