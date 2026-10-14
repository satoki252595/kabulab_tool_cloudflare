import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { YahooRawCapture } from "./client.js";

const fixture = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/stock-daily-scopes-20261014.json.gz", import.meta.url))).toString()) as Record<string, string>;
const proof = JSON.parse(readFileSync(new URL("./fixtures/stock-daily-scopes-20261014.provenance.json", import.meta.url), "utf8")) as {
  members: { key: string; sourceSha256: string; projectionSha256: string }[];
};
let client: typeof import("./client.js");
beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("YAHOO_PROXY_BASE", "https://kabulab.example.test");
  vi.stubEnv("CRON_SECRET", "test-secret");
  client = await import("./client.js");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

function serve(code: string, chart = fixture[`${code}-chart`]) {
  const fetch = vi.fn(async (input: string) => new Response(
    input.includes("quoteSummary") ? fixture[`${code}-quote-summary`] : chart,
    { status: 200, headers: { "Content-Type": "application/json" } }
  ));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("通常株式日次の用途別資格 (実原典の最小projection・追加取得0)", () => {
  it("8303実原典の最小projectionから当日/130本を採用し、過去adj異常をprojection SHA付きHOLDにする", async () => {
    const fetch = serve("8303");
    const captures: YahooRawCapture[] = [];
    const raw = await client.fetchStockRawData("8303", "5y", {
      stockDailyScopes: true, onChartRaw: (c) => { captures.push(c); }, onSummaryRaw: (c) => { captures.push(c); },
    });
    expect(fetch).toHaveBeenCalledTimes(2); // Chart1 + QuoteSummary1 (再送/代替rangeなし)
    expect(captures).toHaveLength(2);
    const chartSha = createHash("sha256").update(captures[0].bytes).digest("hex");
    expect(chartSha).toBe(proof.members.find((m) => m.key === "8303-chart")!.projectionSha256);
    expect(raw.rsiHistoryHold).toEqual({ scope: "rsi-5y", reasonCode: "non_positive_adjusted_close",
      invalidBars: 1, firstDate: "2022-03-30", lastDate: "2022-03-30", sourceSha256: chartSha });
    expect(raw.ohlcv).toHaveLength(130);
    expect(raw.ohlcv[0].date).toBe("2026-04-02");
    expect(raw.ohlcv.at(-1)).toMatchObject({ date: "2026-10-14", open: 1481, high: 1489.5,
      low: 1461.5, close: 1478.5, volume: 3868600, adj: 1478.5 });
    expect(raw.price).toBe(1478.5);
  });

  it("既存full5y callerは8303の過去実異常を含むprojectionも引き続き拒否する", async () => {
    serve("8303");
    await expect(client.fetchChart("8303", "5y")).rejects.toThrow(/raw adj\[0\].*非正/);
    await expect(client.fetchStockRawData("8303", "5y")).rejects.toThrow(/raw adj\[0\].*非正/);
  });

  it("正常7203の最小projectionの全バー/メタ/結果は従来と完全一致する", async () => {
    serve("7203");
    const strict = await client.fetchChart("7203", "5y");
    const scoped = await client.fetchChart("7203", "5y", { stockDailyScopes: true, onRaw: () => undefined });
    expect(scoped).toEqual(strict);
    expect(scoped.rsiHistoryHold).toBeUndefined();
  });

  it("直近adj異常・過去raw OHLC異常を部分成功へ変換しない", async () => {
    const source = JSON.parse(fixture["8303-chart"]);
    const latestBad = structuredClone(source);
    // 明示fault injection: 元原典に実在した負adjを直近位置へ移す。生成価格は使わない。
    const adj = latestBad.chart.result[0].indicators.adjclose[0].adjclose;
    adj[adj.length - 1] = adj[0];
    serve("8303", JSON.stringify(latestBad));
    await expect(client.fetchChart("8303", "5y", { stockDailyScopes: true, onRaw: () => undefined }))
      .rejects.toThrow(/raw adj.*非正/);
    source.chart.result[0].indicators.quote[0].close[0] = source.chart.result[0].indicators.adjclose[0].adjclose[0];
    serve("8303", JSON.stringify(source));
    await expect(client.fetchChart("8303", "5y", { stockDailyScopes: true, onRaw: () => undefined }))
      .rejects.toThrow(/raw c\[0\].*非正/);
  });

  it("日本株/5y/原文capture契約違反は送信前に拒否する", async () => {
    const fetch = serve("8303");
    for (const [code, range, onRaw] of [["^N225", "5y", () => undefined], ["8303", "1y", () => undefined], ["8303", "5y", undefined]] as const) {
      await expect(client.fetchChart(code, range, { stockDailyScopes: true, onRaw })).rejects.toThrow(/独立scope/);
      await expect(client.fetchStockRawData(code, range, { stockDailyScopes: true, onChartRaw: onRaw })).rejects.toThrow(/独立scope/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
