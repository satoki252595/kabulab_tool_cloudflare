import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyArchivedAttachments } from "./readback.js";
import { listPageFiles } from "./page-file.js";
import * as downloader from "./archived-download.js";
import * as sha from "../sha256.js";
import { installScheduledDeadline } from "../scheduled-admission.js";
vi.mock("./page-file.js", () => ({ listPageFiles: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("通常原本readbackのbounded同URL GET", () => {
  const expected = Uint8Array.from([1, 2, 3]);
  it("一度のnative切断後もexact length/fullSHAが揃ってからのみ完了する", async () => {
    vi.mocked(listPageFiles).mockResolvedValue([{ name: "saved.gz", kind: "file", url: "https://file.notion.so/saved.gz" }]);
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(new Response(expected));
    await expect(verifyArchivedAttachments("page", [{ filename: "saved.gz", bytes: expected }], "原本")).resolves.toBeUndefined();
    expect(listPageFiles).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("同長SHA不一致はGET1回でHOLD、余分なbyteもSTOPする", async () => {
    vi.mocked(listPageFiles).mockResolvedValue([{ name: "saved.gz", kind: "file", url: "https://file.notion.so/saved.gz" }]);
    const get = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 4]))).mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3, 4])));
    await expect(verifyArchivedAttachments("page", [{ filename: "saved.gz", bytes: expected }], "原本")).rejects.toThrow("SHA256");
    expect(get).toHaveBeenCalledOnce();
    await expect(verifyArchivedAttachments("page", [{ filename: "saved.gz", bytes: expected }], "原本")).rejects.toThrow("予算超過");
    expect(get).toHaveBeenCalledTimes(2);
  });
  it("通常verifierはbufferの正確長を時間枠へ渡し、SHA完了が親hard後なら成功にしない", async () => {
    vi.mocked(listPageFiles).mockResolvedValue([{ name: "saved.gz", kind: "file", url: "https://file.notion.so/saved.gz" }]);
    const get = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(expected));
    const download = vi.spyOn(downloader, "downloadArchivedFile");
    vi.useFakeTimers({ toFake: ["Date"] });
    const deadline = Date.now() + 10_000, hash = sha.sha256HexBytes;
    vi.spyOn(sha, "sha256HexBytes").mockImplementation(async bytes => {
      const result = await hash(bytes); vi.setSystemTime(deadline); return result;
    });
    const restore = installScheduledDeadline(deadline);
    try {
      await expect(verifyArchivedAttachments("page", [{ filename: "saved.gz", bytes: expected }], "原本")).rejects.toThrow("閉鎖期限");
      expect(download).toHaveBeenCalledWith(expect.anything(), "原本", { maxBytes: expected.length, expectedBytes: expected.length });
      expect(get).toHaveBeenCalledOnce();
    } finally { restore(); }
  });
});
