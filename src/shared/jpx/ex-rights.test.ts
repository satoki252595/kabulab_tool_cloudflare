/** Actual official bytes; mutations below are malformed-input tests, never financial fixtures. */
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { assertExRightsIndexUrl, EX_RIGHTS_LIMITS, fetchExRightsSource, parseExRightsIndex } from "./ex-rights.js";

export const INDEX_URL = "https://www.jpx.co.jp/listing/others/ex-rights/index.html";
const html = gunzipSync(readFileSync(new URL("./__fixtures__/ex-rights-20261016/index.html.gz", import.meta.url)));
const xls = readFileSync(new URL("./__fixtures__/ex-rights-20261016/20261016.xls", import.meta.url));
afterEach(() => vi.unstubAllGlobals());

it("実index/XLSの全SHA・唯一5版を原文日付とhrefから取得する", () => {
  expect(createHash("sha256").update(html).digest("hex")).toBe("c583791ea619206f91fdb53f708b0321e7821afdbca91bb2d734c759f0ebb43a");
  expect(createHash("sha256").update(xls).digest("hex")).toBe("e5bb8034f993b5a9e664edfe2ea646d577b35e7fb7902cabdd9f197307e3cd0a");
  const versions = parseExRightsIndex(html, "2026-10-17", INDEX_URL);
  expect(versions.map(v => v.announcedDate)).toEqual(["2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13", "2026-10-09"]);
  expect(versions[0].url).toBe("https://www.jpx.co.jp/listing/others/ex-rights/nlsgeu000004rws9-att/20261016.xls");
});

it("別source family/未来日/同日重複/日付とhref不一致/表欠測を拒否する", () => {
  expect(() => assertExRightsIndexUrl(INDEX_URL + "?other=1")).toThrow();
  expect(() => parseExRightsIndex(html, "2026-10-15", INDEX_URL)).toThrow();
  for (const [from, to] of [["2026年10月16日", "2026年10月15日"], ["20261016.xls", "20261015.xls"], ["component-file", "other-file"]]) {
    expect(() => parseExRightsIndex(new TextEncoder().encode(html.toString().replace(from, to)), "2026-10-17", INDEX_URL)).toThrow();
  }
});

it("実XLSの全bytesとheadersを受領し、別URLを送る前に拒否する", async () => {
  const send = vi.fn(async () => new Response(xls, { headers: { "content-type": "application/vnd.ms-excel", "last-modified": "Fri, 16 Oct 2026 04:00:29 GMT" } }));
  vi.stubGlobal("fetch", send);
  const version = parseExRightsIndex(html, "2026-10-17", INDEX_URL)[0];
  const result = await fetchExRightsSource(INDEX_URL, version);
  expect(result).toMatchObject({ complete: true, failure: null, lastModified: "Fri, 16 Oct 2026 04:00:29 GMT" });
  expect(Buffer.from(result.bytes!)).toEqual(xls); expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]).toHaveLength(2);
  await expect(fetchExRightsSource(INDEX_URL, { ...version, url: version.url + "?other=1" })).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(1);
});

it.each([429, 302])("HTTP %sも全受領bytesを残してretry/redirectしない", async status => {
  const send = vi.fn(async () => new Response(html, { status, headers: { "content-type": "text/html" } })); vi.stubGlobal("fetch", send);
  const result = await fetchExRightsSource(INDEX_URL, null);
  expect(result).toMatchObject({ status, complete: true, failure: "http" });
  expect(Buffer.from(result.bytes!)).toEqual(html); expect(send).toHaveBeenCalledTimes(1);
});

it("容量超過はprefixだけ/全原本false、transportは原本無し、偽XLSはformat不明", async () => {
  const send = vi.fn(async () => new Response(new Uint8Array(EX_RIGHTS_LIMITS.indexBytes + 1), { headers: { "content-type": "text/html" } })); vi.stubGlobal("fetch", send);
  const limited = await fetchExRightsSource(INDEX_URL, null);
  expect(limited).toMatchObject({ complete: false, failure: "body-limit" }); expect(limited.bytes!.length).toBe(EX_RIGHTS_LIMITS.indexBytes);
  send.mockImplementationOnce(async () => { throw new Error("transport test"); });
  expect(await fetchExRightsSource(INDEX_URL, null)).toMatchObject({ status: null, bytes: null, complete: false, failure: "transport" });
  send.mockImplementationOnce(async () => new Response(html, { headers: { "content-type": "application/vnd.ms-excel" } }));
  expect(await fetchExRightsSource(INDEX_URL, parseExRightsIndex(html, "2026-10-17", INDEX_URL)[0])).toMatchObject({ complete: true, failure: "format" });
});
