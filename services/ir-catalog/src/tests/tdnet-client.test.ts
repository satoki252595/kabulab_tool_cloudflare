import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordPrimaryData, verifyArchivedAttachments } from "../../../../src/shared/notion-archive/index.js";
import { notionEnv } from "../../../../src/shared/notion-archive/env.js";

vi.mock("../../../../src/shared/notion-archive/index.js", () => ({
  recordPrimaryData: vi.fn(),
  verifyArchivedAttachments: vi.fn(),
}));
vi.mock("../../../../src/shared/notion-archive/env.js", () => ({
  notionEnv: { NOTION_TOKEN: vi.fn(), NOTION_ARCHIVE_PAGE_ID: vi.fn() },
}));

const BODY = ' {"items":[{"Tdnet":{"id":"T1","pubdate":"2026-10-01 10:00:00","company_code":"10010","company_name":"試験","title":"試験開示","document_url":"https://example.test/1.pdf","uninterpreted":"原文保持"}}]}\n';

describe("TDnet HTTP 原文の物理保管境界", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(recordPrimaryData).mockReset().mockResolvedValue({ pageId: "p1", outcome: "recorded", fileTooLarge: false, manifestMatch: "written" });
    vi.mocked(verifyArchivedAttachments).mockReset().mockResolvedValue(undefined);
    vi.mocked(notionEnv.NOTION_TOKEN).mockReset();
    vi.mocked(notionEnv.NOTION_ARCHIVE_PAGE_ID).mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("ラッパ・未解釈 field・空白をそのまま保管してから正規化する", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(BODY));
    vi.stubGlobal("fetch", fetcher);
    const { listRange } = await import("../services/tdnet/client.js");
    const result = await listRange("20261001");
    expect(result).toHaveLength(1);
    const input = vi.mocked(recordPrimaryData).mock.calls[0][0];
    expect(new TextDecoder().decode(input.files![0].bytes)).toBe(BODY);
    expect(input.key).toMatch(/^tdnet-source-20261001-200-[0-9a-f]{64}$/);
    expect(verifyArchivedAttachments).toHaveBeenCalledWith("p1", input.files, "TDnet HTTP 原文");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["archive", "readback", "schema", "parse", "http"])("%s 失敗は次日・再GETを開始しない", async (phase) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(phase === "schema" ? '{"other":[]}' : phase === "parse" ? "invalid JSON" : BODY, { status: phase === "http" ? 503 : 200 }));
    vi.stubGlobal("fetch", fetcher);
    if (phase === "archive") vi.mocked(recordPrimaryData).mockRejectedValueOnce(new Error("archive unknown"));
    if (phase === "readback") vi.mocked(verifyArchivedAttachments).mockRejectedValueOnce(new Error("readback mismatch"));
    const { listRange } = await import("../services/tdnet/client.js");
    await expect(listRange("20261001-20261002")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(recordPrimaryData).toHaveBeenCalledTimes(1);
    if (phase === "http") {
      expect(new TextDecoder().decode(vi.mocked(recordPrimaryData).mock.calls[0][0].files![0].bytes)).toBe(BODY);
      expect(verifyArchivedAttachments).toHaveBeenCalledTimes(1);
    }
  });

  it("原文保管の設定不足は取得前に停止する", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    vi.mocked(notionEnv.NOTION_TOKEN).mockImplementationOnce(() => { throw new Error("missing config"); });
    const { listRange } = await import("../services/tdnet/client.js");
    await expect(listRange("20261001")).rejects.toThrow("missing config");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
