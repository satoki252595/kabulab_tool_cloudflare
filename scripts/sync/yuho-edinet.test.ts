import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseShard } from "./yuho-edinet.js";
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

it("actual Node CLI entry cannot report unfinished or rejected work as success", () => {
  const marker = "if (process.argv[1] === fileURLToPath(import.meta.url)) {";
  const source = readFileSync(new URL("./yuho-edinet.ts", import.meta.url), "utf8");
  const entry = source.slice(source.lastIndexOf(marker));
  expect(entry.startsWith(marker)).toBe(true);
  for (const [body, exit, failureCode] of [
    ["await new Promise(() => {});", 2, undefined],
    ["throw new Error('untrusted-secret');", 2, "unknown"],
    ["throw new Error('EDINET日付一覧gzip SHA不一致。');", 2, "snapshot_gzip_sha"],
    ["throw new Error('EDINET変更観測の原本/保存内容が不一致です（再送なし）');", 2, "reported_observation_mismatch"],
    ["throw new Error('EDINET日付一覧gzip SHA不一致。 untrusted-secret');", 2, "unknown"],
    ["return 0;", 0, undefined], ["return 1;", 1, undefined],
  ] as const) {
    const code = ts.transpileModule(`import {fileURLToPath} from "node:url"; process.argv[1]=fileURLToPath(import.meta.url); async function main(){${body}} ${entry}`, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {encoding: "utf8", timeout: 5000});
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(exit);
    expect(child.stderr).not.toContain("untrusted-secret");
    if (failureCode !== undefined) expect(child.stderr).toContain(`code=${failureCode} `);
  }
});
