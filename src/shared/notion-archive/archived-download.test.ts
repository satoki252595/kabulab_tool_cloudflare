import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadArchivedFile } from "./archived-download.js";

const file = { name: "bounded-source.zip", url: "https://file.notion.so/bounded-source.zip" };
afterEach(() => vi.restoreAllMocks());

describe("保存Notion原本のbounded download", () => {
  it("Content-Length欠測でもstreamを上限内で読み、宣言サイズのある完全bodyも同値", async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(bytes))
      .mockResolvedValueOnce(new Response(bytes, { headers: { "Content-Length": "3" } }));
    expect(await downloadArchivedFile(file, "bounded", { maxBytes: 3 })).toEqual(bytes);
    expect(await downloadArchivedFile(file, "bounded", { maxBytes: 3 })).toEqual(bytes);
    expect(fetch).toHaveBeenCalledWith(file.url, { redirect: "error", signal: expect.any(AbortSignal) });
  });
  it.each(["4", "invalid"])("過大/不正Content-Length=%sはbodyを読み始めずcancelする", async length => {
    const response = new Response(Uint8Array.from([1]), { headers: { "Content-Length": length } });
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    await expect(downloadArchivedFile(file, "bounded", { maxBytes: 3 })).rejects.toThrow("サイズ");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("Content-Length欠測の途中超過でもstreamをcancelし、partialは返さない", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(Uint8Array.from([1, 2])); controller.enqueue(Uint8Array.from([3, 4]));
    }, cancel });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream));
    await expect(downloadArchivedFile(file, "bounded", { maxBytes: 3 })).rejects.toThrow("予算超過");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("宣言より短い/長いbodyと途中通信失敗を完全原本へ見せない", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(Uint8Array.from([1]), { headers: { "Content-Length": "2" } }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2]), { headers: { "Content-Length": "1" } }))
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new Error("BODY_UNKNOWN")); } })));
    await expect(downloadArchivedFile(file, "bounded", { maxBytes: 3 })).rejects.toThrow("実バイト長");
    await expect(downloadArchivedFile(file, "bounded", { maxBytes: 3 })).rejects.toThrow("実バイト長");
    await expect(downloadArchivedFile(file, "bounded", { maxBytes: 3 })).rejects.toThrow("BODY_UNKNOWN");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("HTTP gzipのwire長をデコード済body長と比較せず、実body上限は守る", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3]), {
      headers: { "Content-Length": "23", "Content-Encoding": "gzip" },
    })).mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3, 4]), {
      headers: { "Content-Length": "24", "Content-Encoding": "gzip" },
    }));
    expect(await downloadArchivedFile(file, "bounded", { maxBytes: 3 })).toEqual(Uint8Array.from([1, 2, 3]));
    await expect(downloadArchivedFile(file, "bounded", { maxBytes: 3 })).rejects.toThrow("予算超過");
  });
  it("外部origin/credentials/不正予算は通信前STOP", async () => {
    vi.spyOn(globalThis, "fetch");
    for (const url of ["https://untrusted.invalid/source", "http://file.notion.so/source", "https://user@file.notion.so/source"]) {
      await expect(downloadArchivedFile({ ...file, url }, "bounded", { maxBytes: 3 })).rejects.toThrow("URL資格");
    }
    await expect(downloadArchivedFile(file, "bounded", { maxBytes: 0 })).rejects.toThrow("予算");
    expect(fetch).not.toHaveBeenCalled();
  });
});
