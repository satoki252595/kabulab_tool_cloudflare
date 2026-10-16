import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedYahooRawCapture, YahooRawCapture } from "./client.js";

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
  it("実projectionの調整値を明示的に欠損させると、過去RSIはHOLD・直近指標は通常終値で補完せずSTOP", async () => {
    const { buildStockSnapshot } = await import("../../cron/daily.js");
    const { requiredAdjustedClose } = await import("./bar-sanity.js");
    for (const position of [0, -1]) {
      const code = "8303";
      const fault = JSON.parse(fixture[`${code}-chart`]);
      const values = fault.chart.result[0].indicators.adjclose[0].adjclose;
      expect(values.length).toBeGreaterThan(position === 0 ? 130 : 1);
      values[position === -1 ? values.length - 1 : position] = null;
      const fetch = serve(code, JSON.stringify(fault));
      const raw = await client.fetchStockRawData(code, "5y", {
        stockDailyScopes: true, onChartRaw: () => undefined, onSummaryRaw: () => undefined,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(raw.rsiHistoryHold).toMatchObject({
        reasonCode: position === 0 ? "missing_adjusted_close" : "non_positive_adjusted_close", invalidBars: 1,
      });
      const build = () => buildStockSnapshot(1, code, null, raw.ohlcv.at(-1)!.date, raw, []);
      if (position === 0) expect(build()).toMatchObject({ rsiPercentile: null, rsiHistoryHold: raw.rsiHistoryHold });
      else expect(build).toThrow(/調整済み終値.*通常終値で補完しません/);
    }
    const actual = JSON.parse(fixture["7203-chart"]).chart.result[0];
    const close = actual.indicators.quote[0].close.at(-1);
    const adj = actual.indicators.adjclose[0].adjclose.at(-1);
    const bar = { date: "2026-10-14", open: close, high: close, low: close, close, volume: 0, adj };
    expect(requiredAdjustedClose(bar)).toBe(adj);
    expect(requiredAdjustedClose({ ...bar, close: null, adj: null })).toBeNull();
    expect(() => requiredAdjustedClose({ ...bar, adj: null })).toThrow(/調整済み終値/);
  });

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


function savedSource() {
  function member(api: "chart" | "quote-summary", receivedAt: string): SavedYahooRawCapture {
    const bytes = new TextEncoder().encode(fixture[`8303-${api}`]);
    const url = api === "chart"
      ? "https://query1.finance.yahoo.com/v8/finance/chart/8303.T?range=5y&interval=1d&events=split%2Cdiv"
      : "https://query1.finance.yahoo.com/v10/finance/quoteSummary/8303.T?modules=financialData,defaultKeyStatistics,summaryDetail,incomeStatementHistory";
    return { capture: { symbol: "8303", status: 200, bytes, url, receivedAt, headers: {} },
      expectedSha256: createHash("sha256").update(bytes).digest("hex"), expectedByteLength: bytes.byteLength };
  }
  return { chart: member("chart", "2026-10-14T10:15:47.400Z"),
    summary: member("quote-summary", "2026-10-14T10:15:48.285Z") };
}

describe("保存原本と通常定時取得の共通計算", () => {
  it("実8303の投影は同一応答のadjcloseを使い、通常取得/replay同値・通常終値/clock保持", async () => {
    const { buildMomentumRow, buildStockSnapshot, writeStockSnapshot } = await import("../../cron/daily.js");
    const { drizzle } = await import("drizzle-orm/sqlite-proxy");
    const { decodeCloses } = await import("../indicators/momentum-series.js");
    const { calcMomentum } = await import("../../../services/financial-math/src/services/emh.js");
    serve("8303");
    const normal = await client.fetchStockRawData("8303", "5y", {
      stockDailyScopes: true, onChartRaw: () => undefined, onSummaryRaw: () => undefined,
    });
    const source = savedSource();
    const beforeSource = structuredClone(source);
    const fetch = vi.fn(() => { throw new Error("保存原本の再取得は禁止"); });
    vi.stubGlobal("fetch", fetch);
    const saved = await client.parseSavedStockRawData("8303", source);
    const beforeRaw = structuredClone(saved);
    const row = buildMomentumRow(saved.ohlcv);
    const expected = saved.ohlcv.slice(-90).map(b => b.adj as number);
    expect(row).toEqual(buildMomentumRow(normal.ohlcv));
    expect(decodeCloses(row!.closes)).toEqual(expected);
    expect(expected).not.toEqual(saved.ohlcv.slice(-90).map(b => b.close));
    expect(calcMomentum(decodeCloses(row!.closes), 60)).toEqual(calcMomentum(expected, 60));
    expect(row).toMatchObject({ bars: 90, asOf: "2026-10-14" });
    const snapshot = buildStockSnapshot(1, "8303", null, "2026-10-14", saved);
    expect(snapshot).toEqual(buildStockSnapshot(1, "8303", null, "2026-10-14", normal));
    expect(snapshot.latestClose).toBe(1478.5);
    // 明示fault injection: 元原典の別日の調整終値を末尾へ置き、raw closeとの差を作る。
    const changed = structuredClone(saved);
    changed.ohlcv.at(-1)!.adj = changed.ohlcv.at(-3)!.adj;
    const trend = buildStockSnapshot(1, "8303", null, "2026-10-14", changed);
    expect(trend.sma5).toBeLessThan(trend.latestClose!);
    expect(trend.sma5).toBeGreaterThan(changed.ohlcv.at(-1)!.adj!);
    expect(trend.sma5).toBeLessThan(trend.sma20!);
    expect(trend.trendShort).toBe(true);
    expect(trend.latestClose).toBe(snapshot.latestClose);
    expect(trend.ohlcv6mo.at(-1)!.close).toBe(snapshot.ohlcv6mo.at(-1)!.close);
    // 同じsnapshotのスクリーニング保存もadj/SMAで判定し、価格列は受領closeを保持する。
    const savedIndicators: Record<string, unknown> = {};
    const db = drizzle(async (sql, params) => {
      const insert = sql.match(/insert into "swing_stock_indicators" \(([^)]+)\)/);
      if (insert !== null) {
        insert[1].split(", ").forEach((column, i) => { savedIndicators[column.replaceAll('"', "")] = params[i]; });
      }
      return { rows: [] };
    }) as Parameters<typeof writeStockSnapshot>[0];
    await writeStockSnapshot(db, trend, undefined, { runStartedSec: 1 });
    expect(savedIndicators).toMatchObject({ trend_short: 1, trend_ok_short: 1, latest_close: 1478.5 });
    for (const adj of [undefined, null, 0, -1, NaN, Infinity]) {
      const missing = structuredClone(saved.ohlcv);
      missing.at(-1)!.adj = adj;
      expect(() => buildMomentumRow(missing)).toThrow(/調整済み終値.*通常終値で補完しません/);
    }
    expect(saved).toEqual(beforeRaw);
    expect(source).toEqual(beforeSource);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("実projectionの結果が通常取得と全列同値で、原clock/bytesを変更せずtransport0", async () => {
    serve("8303");
    const normal = await client.fetchStockRawData("8303", "5y", {
      stockDailyScopes: true, onChartRaw: () => undefined, onSummaryRaw: () => undefined,
    });
    const source = savedSource();
    const before = structuredClone(source);
    const fetch = vi.fn(() => { throw new Error("保存原本の再取得は禁止"); });
    vi.stubGlobal("fetch", fetch);
    const saved = await client.parseSavedStockRawData("8303", source);
    expect(saved).toEqual(normal);
    const directRedactedCrumb = structuredClone(source);
    directRedactedCrumb.chart.capture.url += "&crumb=%3Credacted%3E";
    expect(await client.parseSavedStockRawData("8303", directRedactedCrumb)).toEqual(normal);
    expect(source).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
    const proxied = structuredClone(source);
    for (const saved of Object.values(proxied)) {
      saved.capture.url = `https://kabulab.example.test/api/ingest/yahoo?u=${encodeURIComponent(saved.capture.url)}`;
    }
    expect(await client.parseSavedStockRawData("8303", proxied, { proxyBase: "https://kabulab.example.test" })).toEqual(normal);
    await expect(client.parseSavedStockRawData("8303", proxied)).rejects.toThrow(/要求銘柄/);
  });

  it("HTTP/credential/port/hash proxy設定と重複uは正規HTTPS内URLでも拒否する", async () => {
    const fetch = vi.fn(() => { throw new Error("transportは禁止"); });
    vi.stubGlobal("fetch", fetch);
    for (const proxyBase of ["http://kabulab.example.test", "https://user:pass@kabulab.example.test",
      "https://kabulab.example.test:444", "https://kabulab.example.test#hash", "https://kabulab.example.test?extra=1"]) {
      const source = savedSource();
      for (const saved of Object.values(source)) {
        const base = new URL(proxyBase);
        saved.capture.url = `${base.origin}/api/ingest/yahoo?u=${encodeURIComponent(saved.capture.url)}`;
      }
      await expect(client.parseSavedStockRawData("8303", source, { proxyBase })).rejects.toThrow(/HTTPS・proxy設定/);
    }
    for (const change of [
      (url: string) => url.replace("https:", "http:"),
      (url: string) => url.replace("https://", "https://user:pass@"),
      (url: string) => url.replace(".test/", ".test:444/"),
      (url: string) => `${url}#hash`,
      (url: string) => `${url}&u=${encodeURIComponent(new URL(url).searchParams.get("u")!)}`,
    ]) {
      const source = savedSource();
      for (const saved of Object.values(source)) {
        saved.capture.url = change(`https://kabulab.example.test/api/ingest/yahoo?u=${encodeURIComponent(saved.capture.url)}`);
      }
      await expect(client.parseSavedStockRawData("8303", source, { proxyBase: "https://kabulab.example.test" })).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("全SHA/bytes/HTTP/銘柄/要求窓/実clockが崩れた保存原本はtransport0でSTOP", async () => {
    const fetch = vi.fn(() => { throw new Error("transportは禁止"); });
    vi.stubGlobal("fetch", fetch);
    const mutations: ((source: ReturnType<typeof savedSource>) => void)[] = [
      s => { s.chart.expectedSha256 = s.summary.expectedSha256; },
      s => { s.chart.capture.bytes[0] ^= 1; },
      s => { s.summary.expectedByteLength++; },
      s => { s.summary.capture.status = 503; },
      s => { s.chart.capture.headers.upstreamStatus = "503"; },
      s => { s.chart.capture.symbol = "7203"; },
      s => { s.chart.capture.url = s.chart.capture.url.replace("8303.T", "7203.T"); },
      s => { s.chart.capture.url = s.chart.capture.url.replace("5y", "1y"); },
      s => { s.chart.capture.url += "&range=5y"; },
      s => { s.chart.capture.url += "&toString=1"; },
      s => { s.summary.capture.url = s.summary.capture.url.replace("incomeStatementHistory", "price"); },
      s => { s.chart.capture.receivedAt = "not-a-clock"; },
      s => { s.summary.capture.receivedAt = s.chart.capture.receivedAt.replace("47.400", "46.400"); },
      s => { s.chart.capture.receivedAt = "2026-10-13T10:15:47.400Z"; },
    ];
    for (const mutate of mutations) {
      const source = savedSource(); mutate(source);
      await expect(client.parseSavedStockRawData("8303", source)).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
