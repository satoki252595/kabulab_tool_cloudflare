import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/yahoo/client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../shared/yahoo/client.js")>();
  return { ...actual, yahooFetchDirect: vi.fn() };
});

import { ingestProxyRoute } from "./ingest-proxy.js";
import { yahooFetchDirect } from "../shared/yahoo/client.js";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;
const fetchYahoo = vi.mocked(yahooFetchDirect);

beforeEach(() => {
  process.env.CRON_SECRET = "test-secret";
  fetchYahoo.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_CRON_SECRET === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  }
});

describe("GET /yahoo", () => {
  it("Yahooのstatus・許可ヘッダ・本文と診断markerだけを中継する", async () => {
    fetchYahoo.mockResolvedValue(
      new Response('{"error":"upstream"}', {
        status: 502,
        statusText: "Bad Gateway",
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          "Retry-After": "2",
          "Set-Cookie": "must-not-leak=1",
        },
      })
    );
    const target = encodeURIComponent(
      "https://query1.finance.yahoo.com/v8/finance/chart/7203.T"
    );

    const response = await ingestProxyRoute.request(
      `https://proxy.example.test/yahoo?u=${target}`,
      { headers: { Authorization: "Bearer test-secret" } }
    );

    expect(response.status).toBe(502);
    expect(response.statusText).toBe("Bad Gateway");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(response.headers.get("X-Kabulab-Yahoo-Status")).toBe("502");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await response.text()).toBe('{"error":"upstream"}');
  });

  it("内部例外を秘密値のない構造化logと502へ分類する", async () => {
    fetchYahoo.mockRejectedValue(
      new Error(
        "fetch failed: https://query1.finance.yahoo.com/?crumb=secret-crumb " +
          "Authorization: Bearer secret-token Cookie: A1=secret-cookie"
      )
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const target = encodeURIComponent(
      "https://query1.finance.yahoo.com/v8/finance/chart/7203.T"
    );

    const response = await ingestProxyRoute.request(
      `https://proxy.example.test/yahoo?u=${target}`,
      { headers: { Authorization: "Bearer test-secret" } }
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("X-Kabulab-Yahoo-Status")).toBeNull();
    expect(await response.json()).toEqual({
      error: "yahoo ingest proxy failed",
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    const log = String(consoleError.mock.calls[0]?.[0]);
    expect(JSON.parse(log)).toMatchObject({
      event: "yahoo_ingest_proxy_error",
      source: "ingest-proxy",
    });
    expect(log).toContain("crumb=[redacted]");
    expect(log).toContain("Bearer [redacted]");
    expect(log).toContain("Cookie: [redacted]");
    expect(log).not.toContain("secret-crumb");
    expect(log).not.toContain("secret-token");
    expect(log).not.toContain("secret-cookie");
  });
});
