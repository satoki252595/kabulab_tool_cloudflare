import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyYuhoEdinetUnknownFailure, main, parseShard } from "./yuho-edinet.js";
import { createD1HttpDb, createD1HttpBatchSender } from "../../src/shared/db/d1-http-client.js";
import { runYuhoEdinetCatchup } from "../../src/cron/yuho-edinet.js";
import { yuhoEnv } from "../../services/yuho-quant/src/env.js";
import { notionEnv } from "../../src/shared/notion-archive/env.js";
import { createHoldingPriceSourceLoader } from "./holdings-price-sources.js";
import { sharedEnv } from "../../src/shared/env.js";
import * as launch from "./catchup-launch.js";
vi.mock("../../src/shared/db/d1-http-client.js", () => ({createD1HttpDb: vi.fn(), createD1HttpBatchSender: vi.fn()}));
vi.mock("../../src/cron/yuho-edinet.js", async () => ({...await vi.importActual<typeof import("../../src/cron/yuho-edinet.js")>("../../src/cron/yuho-edinet.js"), runYuhoEdinetCatchup: vi.fn()}));
vi.mock("../../services/yuho-quant/src/env.js", () => ({yuhoEnv: {EDINET_API_KEY: vi.fn()}}));
vi.mock("../../src/shared/notion-archive/env.js", () => ({notionEnv: {NOTION_TOKEN: vi.fn(), NOTION_ARCHIVE_PAGE_ID: vi.fn(), NOTION_YUHO_TEXT_DB_ID: vi.fn()}}));
vi.mock("./holdings-price-sources.js", () => ({createHoldingPriceSourceLoader: vi.fn(() => vi.fn())}));
vi.mock("../../src/shared/env.js", () => ({sharedEnv: {R2_ACCOUNT_ID: vi.fn(), R2_ACCESS_KEY_ID: vi.fn(), R2_SECRET_ACCESS_KEY: vi.fn(), R2_BUCKET: vi.fn()}}));
beforeEach(() => vi.resetAllMocks());
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe("direct Node catchup", () => {
  it("定時は19:53までの残時間から10分を終端へ残し、19:43以降は取得・設定前に延期する", async () => {
    const deadline = Date.parse("2026-10-14T10:53:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(deadline - 30 * 60_000);
    vi.spyOn(launch, "validateCatchupLaunch").mockReturnValue(deadline);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const db = {}, sender = vi.fn(), loader = Object.assign(vi.fn(), { currentSnapshotId: vi.fn(async () => null) });
    vi.mocked(createD1HttpDb).mockReturnValue(db as never);
    vi.mocked(createD1HttpBatchSender).mockReturnValue(sender);
    vi.mocked(createHoldingPriceSourceLoader).mockReturnValue(loader);
    vi.mocked(runYuhoEdinetCatchup).mockResolvedValue({ listErrors: [], ingestErrors: [], reachedCap: true, pendingDocuments: 0 } as never);
    expect(await main([])).toBe(1);
    expect(runYuhoEdinetCatchup).toHaveBeenCalledWith(db, undefined, sender, loader, deadline,
      { observeIssuedShares: true, sourceStartDeadlineMs: deadline - 10 * 60_000 });
    vi.clearAllMocks();
    vi.setSystemTime(deadline - 10 * 60_000);
    expect(await main([])).toBe(1);
    expect(console.info).toHaveBeenCalledWith("[yuho-edinet]", JSON.stringify({ status: "deferred_time_budget", sourceStarted: false,
      sourceStartDeadlineMs: deadline - 10 * 60_000, deadlineMs: deadline, complete: false }));
    expect(createD1HttpDb).not.toHaveBeenCalled(); expect(runYuhoEdinetCatchup).not.toHaveBeenCalled();
    expect(yuhoEnv.EDINET_API_KEY).not.toHaveBeenCalled(); expect(createHoldingPriceSourceLoader).not.toHaveBeenCalled();
  });
  it("obsolete scheduled runtime stops before source, configuration or DB", async () => {
    vi.stubEnv("GITHUB_EVENT_NAME", "schedule");
    await expect(main([])).rejects.toThrow("旧catchup schedule");
    expect(createD1HttpDb).not.toHaveBeenCalled();
    expect(runYuhoEdinetCatchup).not.toHaveBeenCalled();
    expect(yuhoEnv.EDINET_API_KEY).not.toHaveBeenCalled();
    expect(createHoldingPriceSourceLoader).not.toHaveBeenCalled();
  });
  it("validates shard without blank/partial/fraction/duplicate coercion", () => {
    expect(parseShard([])).toBeUndefined();
    expect(parseShard(["--part=0", "--of=8"])).toEqual({part: 0, of: 8});
    for (const args of [["--part"], ["--part=0"], ["--part=", "--of=8"], ["--part=0.1", "--of=8"], ["--part=8", "--of=8"], ["--part=0", "--part=1", "--of=8"]]) expect(() => parseShard(args)).toThrow();
  });
  it("uses the same Node DB and atomic sender; successful complete result only exits zero", async () => {
    const db = {}, sender = vi.fn();
    vi.mocked(createD1HttpDb).mockReturnValue(db as never);
    vi.mocked(createD1HttpBatchSender).mockReturnValue(sender);
    vi.mocked(runYuhoEdinetCatchup).mockResolvedValue({listErrors: [], ingestErrors: [], reachedCap: false, pendingDocuments: 0} as never);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await main(["--part=0", "--of=8"])).toBe(0);
      expect(runYuhoEdinetCatchup).toHaveBeenCalledWith(db, {part: 0, of: 8}, sender, undefined, undefined, { observeIssuedShares: true });
      expect(createHoldingPriceSourceLoader).not.toHaveBeenCalled();
      const loader = Object.assign(vi.fn(), { currentSnapshotId: vi.fn(async () => null) }); vi.mocked(createHoldingPriceSourceLoader).mockReturnValue(loader);
      expect(await main([])).toBe(0);
      expect(runYuhoEdinetCatchup).toHaveBeenLastCalledWith(db, undefined, sender, loader, undefined, { observeIssuedShares: true });
      expect(sharedEnv.R2_SECRET_ACCESS_KEY).toHaveBeenCalledTimes(1);
      vi.mocked(runYuhoEdinetCatchup).mockResolvedValue({listErrors: ["2026-09-30"], ingestErrors: []} as never);
      expect(await main([])).toBe(1);
      vi.mocked(runYuhoEdinetCatchup).mockResolvedValue({listErrors: [], ingestErrors: [], reachedCap: true, pendingDocuments: 0} as never);
      expect(await main([])).toBe(1);
      vi.mocked(runYuhoEdinetCatchup).mockResolvedValue({listErrors: [], ingestErrors: [], reachedCap: false, pendingDocuments: 1} as never);
      expect(await main([])).toBe(1);
    } finally { log.mockRestore(); }
  });
  it("missing source/archive config stops before DB or any source; thrown operation propagates", async () => {
    vi.mocked(yuhoEnv.EDINET_API_KEY).mockImplementationOnce(() => {throw new Error("missing");});
    await expect(main([])).rejects.toThrow("missing");
    expect(createD1HttpDb).not.toHaveBeenCalled();
    vi.mocked(notionEnv.NOTION_YUHO_TEXT_DB_ID).mockImplementationOnce(() => {throw new Error("missing archive");});
    await expect(main([])).rejects.toThrow("missing archive");
    expect(runYuhoEdinetCatchup).not.toHaveBeenCalled();
    vi.mocked(runYuhoEdinetCatchup).mockRejectedValueOnce(new Error("unknown"));
    await expect(main([])).rejects.toThrow("unknown");
    expect(runYuhoEdinetCatchup).toHaveBeenCalledTimes(1);
  });
  it("Node price configuration is validated before source/DB and no loader is substituted", async () => {
    vi.mocked(sharedEnv.R2_ACCESS_KEY_ID).mockImplementationOnce(() => { throw new Error("missing R2"); });
    await expect(main([])).rejects.toThrow("missing R2");
    expect(createD1HttpDb).not.toHaveBeenCalled(); expect(runYuhoEdinetCatchup).not.toHaveBeenCalled();
    expect(createHoldingPriceSourceLoader).not.toHaveBeenCalled();
  });
});

const sha12 = (message: string) => createHash("sha256").update(message).digest("hex").slice(0, 12);

describe("classifyYuhoEdinetUnknownFailure", () => {
  const packed = (diag: { name: string; kind: string; msgSha: string }) => `${diag.name}\n${diag.kind}\n${diag.msgSha}`;
  it("hashes the message and keeps only a 3-digit D1 status in kind", () => {
    const message = "D1 HTTP 503: https://api.cloudflare.com/client/v4 Subscription-Key SELECT secret-bind";
    const diag = classifyYuhoEdinetUnknownFailure(new Error(message));
    expect(diag).toEqual({ name: "Error", kind: "d1_http_503", msgSha: sha12(message) });
    expect(diag.msgSha).toMatch(/^[0-9a-f]{12}$/);
    expect(packed(diag)).not.toContain("https://");
    expect(packed(diag)).not.toContain("Subscription-Key");
    expect(packed(diag)).not.toContain("SELECT");
    expect(packed(diag)).not.toContain("secret-bind");
    expect(sha12("D1 HTTP 503: secret")).toBe("8156108c8dce");
    expect(classifyYuhoEdinetUnknownFailure(new Error("D1 HTTP 503: secret")).msgSha).toBe("8156108c8dce");
  });
  it("does not treat a non-3-digit D1 body or a later status as d1_http", () => {
    expect(classifyYuhoEdinetUnknownFailure(new Error("D1 HTTP error: [{\"message\":\"secret sql\"}]")).kind).toBe("other");
    expect(classifyYuhoEdinetUnknownFailure(new Error("D1 HTTP 50: secret")).kind).toBe("other");
    expect(classifyYuhoEdinetUnknownFailure(new Error("D1 HTTP 5030: secret")).kind).toBe("other");
    expect(classifyYuhoEdinetUnknownFailure(new Error("prefix D1 HTTP 500: secret")).kind).toBe("other");
    expect(classifyYuhoEdinetUnknownFailure(new Error("D1 HTTP 400: code 7500 ref 12345")).kind).toBe("d1_http_400");
    expect(classifyYuhoEdinetUnknownFailure(new Error("D1 HTTP 200")).kind).toBe("d1_http_200");
  });
  it("classifies EDINET before TypeError, and TypeError fetch failures as network", () => {
    const edinet = "EDINET日付一覧の続きに Subscription-Key と https://disclosure.edinet-fsa.go.jp がある";
    expect(classifyYuhoEdinetUnknownFailure(new Error(edinet))).toEqual({ name: "Error", kind: "edinet_other", msgSha: sha12(edinet) });
    expect(packed(classifyYuhoEdinetUnknownFailure(new TypeError(edinet)))).not.toContain("Subscription-Key");
    expect(classifyYuhoEdinetUnknownFailure(new TypeError(edinet)).kind).toBe("edinet_other");
    const fetchFailed = "fetch failed https://api.edinet-fsa.go.jp/api/v2 Subscription-Key";
    const network = classifyYuhoEdinetUnknownFailure(new TypeError(fetchFailed));
    expect(network).toEqual({ name: "TypeError", kind: "network", msgSha: sha12(fetchFailed) });
    expect(packed(network)).not.toContain("fetch failed");
    expect(packed(network)).not.toContain("https://");
    expect(classifyYuhoEdinetUnknownFailure(new TypeError("D1 HTTP 502: https://example.invalid/token")).kind).toBe("d1_http_502");
    expect(classifyYuhoEdinetUnknownFailure(new SyntaxError("secret syntax")).kind).toBe("other");
    expect(classifyYuhoEdinetUnknownFailure(new SyntaxError("secret syntax")).name).toBe("SyntaxError");
  });
  it("does not stringify non-errors or non-string message/name", () => {
    const secret = "Subscription-Key secret-value https://example.invalid SELECT";
    expect(classifyYuhoEdinetUnknownFailure(secret)).toEqual({ name: "string", kind: "other", msgSha: sha12("") });
    expect(packed(classifyYuhoEdinetUnknownFailure(secret))).not.toContain("Subscription");
    expect(classifyYuhoEdinetUnknownFailure({ message: secret, sql: "SELECT", url: "https://x" })).toEqual({ name: "object", kind: "other", msgSha: sha12("") });
    expect(classifyYuhoEdinetUnknownFailure(null)).toEqual({ name: "object", kind: "other", msgSha: "e3b0c44298fc" });
    expect(classifyYuhoEdinetUnknownFailure(undefined)).toEqual({ name: "undefined", kind: "other", msgSha: "e3b0c44298fc" });
    const named = new TypeError("fetch failed secret");
    Object.defineProperty(named, "name", { value: { token: secret } });
    const namedDiag = classifyYuhoEdinetUnknownFailure(named);
    expect(namedDiag.name).toBe("object");
    expect(namedDiag.kind).toBe("network");
    expect(packed(namedDiag)).not.toContain("secret");
    const body = new Error("temp");
    Object.defineProperty(body, "message", { value: { sql: secret } });
    expect(classifyYuhoEdinetUnknownFailure(body)).toEqual({ name: "Error", kind: "other", msgSha: sha12("") });
    const broken = new Error("line1\nsecret-body");
    broken.name = "Bad\nName";
    expect(classifyYuhoEdinetUnknownFailure(broken).name).toBe("BadName");
    expect(packed(classifyYuhoEdinetUnknownFailure(broken))).not.toContain("secret-body");
    expect(classifyYuhoEdinetUnknownFailure(new Error(""))).toEqual({ name: "Error", kind: "other", msgSha: "e3b0c44298fc" });
  });
});

it("actual Node CLI entry cannot report unfinished or rejected work as success", () => {
  const marker = "if (process.argv[1] === fileURLToPath(import.meta.url)) {";
  const helperMarker = "export function classifyYuhoEdinetUnknownFailure";
  const source = readFileSync(new URL("./yuho-edinet.ts", import.meta.url), "utf8");
  const entryAt = source.lastIndexOf(marker);
  const helperAt = source.indexOf(helperMarker);
  expect(helperAt).toBeGreaterThanOrEqual(0);
  expect(helperAt).toBeLessThan(entryAt);
  const helper = source.slice(helperAt, entryAt);
  const entry = source.slice(entryAt);
  expect(entry.startsWith(marker)).toBe(true);
  expect(helper).toContain("createHash(\"sha256\")");
  expect(helper).not.toContain(".stack");
  expect(helper).not.toContain(".cause");
  const catchAt = entry.indexOf("} catch (error) {");
  const catchBody = entry.slice(catchAt);
  expect(catchBody).not.toContain("process.exitCode");
  expect(catchBody).not.toContain("process.exit(");
  const unknownAt = catchBody.indexOf("if (code === undefined)");
  expect(unknownAt).toBeGreaterThan(0);
  expect(catchBody.slice(0, unknownAt)).toContain("[yuho-edinet] 失敗: code=${code === undefined ? \"unknown\" : code} 完了せず停止しました（再送なし）");
  expect(catchBody.slice(0, unknownAt)).not.toContain("[INC-20261019-kabulab_tool_cloudflare-yuho-edinet-exit2]");
  expect(catchBody.slice(unknownAt)).toContain("[INC-20261019-kabulab_tool_cloudflare-yuho-edinet-exit2] name=${diag.name} kind=${diag.kind} msgSha=${diag.msgSha}");
  expect(catchBody).not.toContain("elapsedMs");
  for (const [body, exit, failureCode] of [
    ["await new Promise(() => {});", 2, undefined],
    ["throw new Error('untrusted-secret');", 2, "unknown"],
    ["throw new Error('EDINET日付一覧gzip SHA不一致。');", 2, "snapshot_gzip_sha"],
    ["throw new Error('EDINET変更観測の原本/保存内容が不一致です（再送なし）');", 2, "reported_observation_mismatch"],
    ["throw new Error('EDINET日付一覧gzip SHA不一致。 untrusted-secret');", 2, "unknown"],
    ["return 0;", 0, undefined], ["return 1;", 1, undefined],
  ] as const) {
    const code = ts.transpileModule(`import { createHash } from "node:crypto"; import {fileURLToPath} from "node:url"; process.argv[1]=fileURLToPath(import.meta.url); async function main(){${body}} ${helper}\n${entry}`, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {encoding: "utf8", timeout: 5000});
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(exit);
    expect(child.stderr).not.toContain("untrusted-secret");
    if (failureCode !== undefined) expect(child.stderr).toContain(`code=${failureCode} `);
    const incLines = child.stderr.split(/\r?\n/).filter((line) => line.startsWith("[INC-20261019-kabulab_tool_cloudflare-yuho-edinet-exit2] "));
    if (failureCode === "unknown") {
      const message = body.includes("EDINET") ? "EDINET日付一覧gzip SHA不一致。 untrusted-secret" : "untrusted-secret";
      const kind = message.startsWith("EDINET") ? "edinet_other" : "other";
      expect(incLines).toEqual([`[INC-20261019-kabulab_tool_cloudflare-yuho-edinet-exit2] name=Error kind=${kind} msgSha=${sha12(message)}`]);
    } else {
      expect(incLines).toEqual([]);
    }
  }
});
