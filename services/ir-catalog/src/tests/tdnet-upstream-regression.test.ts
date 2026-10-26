/**
 * INC-20261026: 当日のやのしんが HTTP 200 / items:[] でも成功扱いにしない。
 * 修正前は空配列を返してこのテストが失敗する。
 */
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

function jstYmd(ms: number): string {
  const wall = new Date(ms + 9 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${wall.getUTCFullYear()}${p(wall.getUTCMonth() + 1)}${p(wall.getUTCDate())}`;
}

describe("当日 items:[] は upstream stopped", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(recordPrimaryData).mockReset().mockResolvedValue({
      pageId: "p1", outcome: "recorded", fileTooLarge: false, manifestMatch: "written",
    });
    vi.mocked(verifyArchivedAttachments).mockReset().mockResolvedValue(undefined);
    vi.mocked(notionEnv.NOTION_TOKEN).mockReset();
    vi.mocked(notionEnv.NOTION_ARCHIVE_PAGE_ID).mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("HTTP 200 の空配列を取りこぼし無しの 0 件にしない", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"items":[]}')));
    const { listRange } = await import("../services/tdnet/client.js");
    await expect(listRange(jstYmd(Date.now()))).rejects.toThrow(/upstream stopped/);
  });
});
