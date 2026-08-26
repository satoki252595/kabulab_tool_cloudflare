import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/yahoo/client.js", () => ({
  yahooFetchDirect: vi.fn(),
}));

import { ingestProxyRoute } from "./ingest-proxy.js";
import { yahooFetchDirect } from "../shared/yahoo/client.js";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;
const fetchYahoo = vi.mocked(yahooFetchDirect);

beforeEach(() => {
  process.env.CRON_SECRET = "test-secret";
  fetchYahoo.mockReset();
});

afterEach(() => {
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
});
