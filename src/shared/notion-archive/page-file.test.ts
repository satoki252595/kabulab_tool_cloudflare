/**
 * `page-file.ts` の既存挙動維持 (先頭エントリ/null)。
 *
 * 既存 `fetchPageFileUrl` は Files 先頭に URL が無ければ null (2 番目へ
 * silent fallback しない)。新規 `listPageFiles` の追加でこの挙動を変えない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("notion-archive page-file (先頭/null 維持)", () => {
  const ORIG_ENV = { ...process.env };
  let originalFetch: typeof globalThis.fetch;
  let originalNow: typeof Date.now;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalNow = Date.now;
    process.env.NOTION_TOKEN = "dummy-token";
    let t = 1_000_000;
    Date.now = (() => (t += 10_000)) as typeof Date.now;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        properties: {
          Files: {
            type: "files",
            files: [
              { name: "first-no-url", type: "file" },
              { name: "second", type: "file", file: { url: "https://example.invalid/second" } },
              { name: "ext", type: "external", external: { url: "https://example.invalid/ext" } },
            ],
          },
        },
      }),
      text: async () => "{}",
    })) as unknown as typeof fetch;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    process.env = { ...ORIG_ENV };
    vi.resetModules();
  });

  it("先頭 URL 無し・2 番目あり→既存 API は null (新規 list は 2 番目を返す)", async () => {
    const { fetchPageFileUrl, listPageFiles } = await import("./page-file.js");
    expect(await fetchPageFileUrl("page-1", "Files")).toBeNull();
    expect(await listPageFiles("page-1", "Files")).toEqual([
      { name: "second", url: "https://example.invalid/second", kind: "file" },
      { name: "ext", url: "https://example.invalid/ext", kind: "external" },
    ]);
  });
});
