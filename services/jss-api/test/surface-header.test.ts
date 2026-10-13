import { createHash, randomBytes } from "node:crypto";
import { expect, it } from "vitest";

import privateApp from "../src/private";
import publicApp from "../src/public";
import type { PrivateEnv, PublicEnv } from "../src/shared/types";
import { stubD1, stubR2 } from "./helpers";

it("認証後のMCP・REST・原本Responseにsurfaceを付け、401と公開面の境界を保つ", async () => {
  // Only transport plumbing is exercised; no market data or upstream requests.
  const content = new Uint8Array();
  const sha = createHash("sha256").update(content).digest("hex");
  const rawKey = "surface-header-regression";
  const common = {
    DB: stubD1(() => [{ r2_key: rawKey, license_tag: "commercial-ok" }]),
    RAW: {
      async get(key: string) {
        expect(key).toBe(rawKey);
        return { body: new Blob([content]).stream(), httpMetadata: { contentType: "application/octet-stream" } };
      },
    } as unknown as R2Bucket,
  };
  const key = randomBytes(32).toString("hex");
  const internal: PrivateEnv = { ...common, SUPPLY: stubR2({}), SURFACE: "private", JSS_API_KEYS: key };
  const external: PublicEnv = { ...common, SURFACE: "public" };
  const auth = { headers: { "X-API-Key": key } };
  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize" };
  const mcp = await privateApp.request("/mcp", {
    method: "POST", headers: { ...auth.headers, "Content-Type": "application/json" }, body: JSON.stringify(initialize),
  }, internal);
  expect(mcp.status).toBe(200);
  expect(mcp.headers.get("X-Surface")).toBe("private");
  const rpc = await mcp.json() as { jsonrpc: string; id: number; result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string } } };
  expect(rpc.jsonrpc).toBe("2.0");
  expect(rpc.id).toBe(1);
  expect(rpc.result.protocolVersion).toBe("2025-06-18");
  expect(rpc.result.capabilities.tools).toEqual({});
  expect(rpc.result.serverInfo.name).toBe("jp-stock-pipeline");

  const rest = await privateApp.request("/v1/meta/licenses", auth, internal);
  expect(rest.status).toBe(200);
  expect(rest.headers.get("X-Surface")).toBe("private");
  const path = `/v1/files/${sha}/content`;
  for (const rejectedPath of ["/mcp", path]) {
    const rejected = await privateApp.request(rejectedPath, rejectedPath === "/mcp" ? {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(initialize),
    } : {}, internal);
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("X-Surface")).toBeNull();
    expect(await rejected.json()).toMatchObject({ error: { code: "unauthorized" } });
  }

  const privateRaw = await privateApp.request(path, auth, internal);
  const publicRaw = await publicApp.request(path, {}, external);
  for (const [response, surface] of [[privateRaw, "private"], [publicRaw, "public"]] as const) {
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Surface")).toBe(surface);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(content);
    if (surface === "public") expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  }
});
