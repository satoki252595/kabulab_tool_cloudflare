import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { main, parseShard } from "./yuho-edinet.js";
import { createD1HttpDb, createD1HttpBatchSender } from "../../src/shared/db/d1-http-client.js";
import { runYuhoEdinetCatchup } from "../../src/cron/yuho-edinet.js";
import { yuhoEnv } from "../../services/yuho-quant/src/env.js";
import { notionEnv } from "../../src/shared/notion-archive/env.js";
vi.mock("../../src/shared/db/d1-http-client.js", () => ({createD1HttpDb: vi.fn(), createD1HttpBatchSender: vi.fn()}));
vi.mock("../../src/cron/yuho-edinet.js", () => ({runYuhoEdinetCatchup: vi.fn(), catchupHttpStatus: (r: {listErrors: string[]; ingestErrors: string[]}) => r.listErrors.length || r.ingestErrors.length ? 500 : 200}));
vi.mock("../../services/yuho-quant/src/env.js", () => ({yuhoEnv: {EDINET_API_KEY: vi.fn()}}));
vi.mock("../../src/shared/notion-archive/env.js", () => ({notionEnv: {NOTION_TOKEN: vi.fn(), NOTION_ARCHIVE_PAGE_ID: vi.fn(), NOTION_YUHO_TEXT_DB_ID: vi.fn()}}));
beforeEach(() => vi.resetAllMocks());
describe("direct Node catchup", () => {
  it("validates shard without blank/partial/fraction/duplicate coercion", () => {
    expect(parseShard([])).toBeUndefined();
    expect(parseShard(["--part=0", "--of=8"])).toEqual({part: 0, of: 8});
    for (const args of [["--part"], ["--part=0"], ["--part=", "--of=8"], ["--part=0.1", "--of=8"], ["--part=8", "--of=8"], ["--part=0", "--part=1", "--of=8"]]) expect(() => parseShard(args)).toThrow();
  });
  it("uses the same Node DB and atomic sender; successful complete result only exits zero", async () => {
    const db = {}, sender = vi.fn();
    vi.mocked(createD1HttpDb).mockReturnValue(db as never);
    vi.mocked(createD1HttpBatchSender).mockReturnValue(sender);
    vi.mocked(runYuhoEdinetCatchup).mockResolvedValue({listErrors: [], ingestErrors: []} as never);
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      expect(await main(["--part=0", "--of=8"])).toBe(0);
      expect(runYuhoEdinetCatchup).toHaveBeenCalledWith(db, {part: 0, of: 8}, sender);
      vi.mocked(runYuhoEdinetCatchup).mockResolvedValue({listErrors: ["2026-09-30"], ingestErrors: []} as never);
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
});

it("actual Node CLI entry cannot report unfinished or rejected work as success", () => {
  const marker = "if (process.argv[1] === fileURLToPath(import.meta.url)) {";
  const source = readFileSync(new URL("./yuho-edinet.ts", import.meta.url), "utf8");
  const entry = source.slice(source.lastIndexOf(marker));
  expect(entry.startsWith(marker)).toBe(true);
  for (const [body, exit] of [["await new Promise(() => {});", 2], ["throw new Error('untrusted-secret');", 2], ["return 0;", 0], ["return 1;", 1]] as const) {
    const code = ts.transpileModule(`import {fileURLToPath} from "node:url"; process.argv[1]=fileURLToPath(import.meta.url); async function main(){${body}} ${entry}`, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext}}).outputText;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {encoding: "utf8", timeout: 5000});
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(exit);
    expect(child.stderr).not.toContain("untrusted-secret");
  }
});
