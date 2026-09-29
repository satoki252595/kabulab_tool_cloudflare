/**
 * `page-file.ts` の挙動維持 + 不正エントリの STOP。
 *
 * 既存 `fetchPageFileUrl` は Files 先頭に URL が無ければ null (2 番目へ
 * silent fallback しない)。この nullable 契約は変えない。
 * `listPageFiles` は不正エントリ (種別・名前・URL・構造の欠損) を黙って
 * 落とさず STOP する (valid1+malformed1 を refs1 に縮めない)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("notion-archive page-file (先頭/null 維持 + 不正 STOP)", () => {
  const ORIG_ENV = { ...process.env };
  let originalFetch: typeof globalThis.fetch;
  let originalNow: typeof Date.now;

  function mockFiles(files: unknown[]): void {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        properties: {
          Files: { type: "files", files },
        },
      }),
      text: async () => "{}",
    })) as unknown as typeof fetch;
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalNow = Date.now;
    process.env.NOTION_TOKEN = "dummy-token";
    let t = 1_000_000;
    Date.now = (() => (t += 10_000)) as typeof Date.now;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    process.env = { ...ORIG_ENV };
    vi.resetModules();
  });

  it("先頭 URL 無し→既存 API は null (nullable 契約は変えない)", async () => {
    mockFiles([
      { name: "first-no-url", type: "file" },
      { name: "second", type: "file", file: { url: "https://example.invalid/second" } },
    ]);
    const { fetchPageFileUrl } = await import("./page-file.js");
    expect(await fetchPageFileUrl("page-1", "Files")).toBeNull();
  });

  it("valid のみ→list は全件返す (既存挙動は変えない)", async () => {
    mockFiles([
      { name: "second", type: "file", file: { url: "https://example.invalid/second" } },
      { name: "ext", type: "external", external: { url: "https://example.invalid/ext" } },
    ]);
    const { listPageFiles } = await import("./page-file.js");
    expect(await listPageFiles("page-1", "Files")).toEqual([
      { name: "second", url: "https://example.invalid/second", kind: "file" },
      { name: "ext", url: "https://example.invalid/ext", kind: "external" },
    ]);
  });

  it("valid1 + URL 欠損1→list は STOP する (refs1 への縮小禁止)", async () => {
    mockFiles([
      { name: "ok", type: "file", file: { url: "https://example.invalid/ok" } },
      { name: "first-no-url", type: "file" },
    ]);
    const { listPageFiles } = await import("./page-file.js");
    await expect(listPageFiles("page-1", "Files")).rejects.toThrow(/URL がありません/);
  });

  it("不正 shape (external URL 無し・未知 type・空 name) は STOP する", async () => {
    const { listPageFiles } = await import("./page-file.js");
    mockFiles([{ name: "ext", type: "external" }]);
    await expect(listPageFiles("page-1", "Files")).rejects.toThrow(/URL がありません/);
    mockFiles([{ name: "weird", type: "unknown-shape" }]);
    await expect(listPageFiles("page-1", "Files")).rejects.toThrow(/種別が未知/);
    mockFiles([{ name: "", type: "file", file: { url: "https://example.invalid/x" } }]);
    await expect(listPageFiles("page-1", "Files")).rejects.toThrow(/名前が不正/);
  });
});
