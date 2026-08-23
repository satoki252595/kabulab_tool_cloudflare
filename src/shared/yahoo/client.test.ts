import { afterEach, describe, expect, it } from "vitest";
import { yahooHttpErrorMessage } from "./client.js";

const ORIGINAL_PROXY_BASE = process.env.YAHOO_PROXY_BASE;

afterEach(() => {
  if (ORIGINAL_PROXY_BASE === undefined) {
    delete process.env.YAHOO_PROXY_BASE;
  } else {
    process.env.YAHOO_PROXY_BASE = ORIGINAL_PROXY_BASE;
  }
});

describe("yahooHttpErrorMessage", () => {
  it("Yahoo upstreamの本文先頭だけを秘密値なしで記録する", async () => {
    process.env.YAHOO_PROXY_BASE = "https://kabulab.example.test";
    const response = new Response(
      `url=https://query1.finance.yahoo.com/?crumb=secret-crumb\n` +
        `Authorization: Bearer secret-token\n` +
        `Cookie: A1=secret-cookie\n${"x".repeat(400)} END`,
      {
        status: 502,
        statusText: "Bad Gateway",
        headers: {
          "CF-Ray": "not-grouped-for-upstream",
          "X-Kabulab-Yahoo-Status": "502",
        },
      }
    );

    const message = await yahooHttpErrorMessage("Yahoo HTTP エラー", response);

    expect(message).toContain("502 Bad Gateway");
    expect(message).toContain("source=yahoo-upstream");
    expect(message).toContain("yahoo-status=502");
    expect(message).toContain("crumb=[redacted]");
    expect(message).toContain("Bearer [redacted]");
    expect(message).toContain("Cookie: [redacted]");
    expect(message).not.toContain("secret-crumb");
    expect(message).not.toContain("secret-token");
    expect(message).not.toContain("secret-cookie");
    expect(message).not.toContain("not-grouped-for-upstream");
    expect(message).not.toContain("END");
  });

  it("markerのない500を取込プロキシ内部障害としてCF-Ray付きで記録する", async () => {
    process.env.YAHOO_PROXY_BASE = "https://kabulab.example.test";
    const response = new Response("worker internal error", {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "CF-Ray": "abc123-NRT" },
    });

    const message = await yahooHttpErrorMessage("Yahoo HTTP エラー", response);

    expect(message).toContain("source=ingest-proxy");
    expect(message).toContain("cf-ray=abc123-NRT");
    expect(message).toContain('body="worker internal error"');
  });
});
