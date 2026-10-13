import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkKnownRawObject } from "./raw-object-check.js";
import { r2GetBytesVersion } from "../vwap/lib/r2.js";
vi.mock("../vwap/lib/r2.js", () => ({ r2GetBytesVersion: vi.fn() }));
vi.mock("../../src/shared/env.js", () => ({ sharedEnv: {
  LOCAL_OUT: () => undefined, R2_BUCKET_RAW: () => "raw-bucket", CLOUDFLARE_ACCOUNT_ID: () => "a".repeat(32),
  CLOUDFLARE_API_TOKEN: () => "test-token", D1_DATABASE_ID: () => "b".repeat(32),
} }));
const bytes = new Uint8Array([0, 255, 128, 42]), digest = createHash("sha256").update(bytes).digest("hex");
const index = { sha256: digest, r2_key: "raw/known-object.zip", size_bytes: bytes.length, r2_bucket: "raw-bucket" };
function d1(rows: unknown[]) {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, result: [{ success: true, results: rows }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });
describe("GH原本認証診断は既存索引1件のread-only", () => {
  it("D1 SELECTとR2単発GETだけで全文SHAを確認し、key/bodyを結果へ出さない", async () => {
    const fetch = d1([index]);
    vi.mocked(r2GetBytesVersion).mockResolvedValue({ body: bytes, etag: '"native"' });
    const result = await checkKnownRawObject();
    expect(result).toMatchObject({ status: "verified", bytes: 4, sha256: digest, observedETagPresent: true, r2Gets: 1, sourceGets: 0, mutations: 0 });
    expect(JSON.stringify(result)).not.toContain(index.r2_key);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(r2GetBytesVersion).toHaveBeenCalledExactlyOnceWith(index.r2_key, "raw-bucket", { singleAttempt: true });
    const request = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const payload = JSON.parse(request[1].body as string) as { sql: string };
    expect(payload.sql.startsWith("SELECT ")).toBe(true);
    expect(payload.sql).toContain("LIMIT 1");
  });
  it.each(["tuple", "missing", "oversize"])("%s索引ではR2へ進まない", async (kind) => {
    d1(kind === "tuple" ? [Object.values(index)] : kind === "missing" ? [] : [{ ...index, size_bytes: 1048577 }]);
    await expect(checkKnownRawObject()).rejects.toThrow();
    expect(r2GetBytesVersion).not.toHaveBeenCalled();
  });
  it.each(["missing", "mismatch", "unknown"])("R2 %sを成功にせず再読しない", async (kind) => {
    d1([index]);
    if (kind === "unknown") vi.mocked(r2GetBytesVersion).mockRejectedValue(new Error("unknown"));
    else vi.mocked(r2GetBytesVersion).mockResolvedValue(kind === "missing" ? null : { body: new Uint8Array([1, 2, 3, 4]), etag: '"native"' });
    await expect(checkKnownRawObject()).rejects.toThrow();
    expect(r2GetBytesVersion).toHaveBeenCalledTimes(1);
  });
});
