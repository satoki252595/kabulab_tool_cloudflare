import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createFinmathD1, type FinmathD1 } from "../../services/financial-math/src/tests/helpers/finmath-d1.js";
vi.mock("../../src/shared/yahoo/client.js", async original => ({
  ...await original<typeof import("../../src/shared/yahoo/client.js")>(), yahooFetchDirect: vi.fn(),
}));
import { fetchChart, fetchStockRawData, YahooRateLimitError, yahooFetchDirect } from "../../src/shared/yahoo/client.js";
import { YahooSharedCooldownError, YAHOO_COOLDOWN_SELECT, YAHOO_COOLDOWN_UPSERT } from "../../src/shared/yahoo/shared-cooldown.js";
import { ingestProxyRoute } from "../../src/routes/ingest-proxy.js";
import { createStockYahooDirectTransport } from "./yahoo-direct.js";
import { installStockSyncDeadline } from "../../src/shared/stock-sync-window.js";

const now = Date.parse("2026-10-14T09:00:00Z"), target = "https://query1.finance.yahoo.com/v8/finance/chart/7203.T";
let d1: FinmathD1;
const direct = vi.mocked(yahooFetchDirect);
let requests: Array<{ sql: string; params: number[] }>;
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(now);
  for (const key of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "D1_DATABASE_ID", "CRON_SECRET"]) vi.stubEnv(key, "protocol-test-only");
  vi.stubEnv("YAHOO_PROXY_BASE", "https://proxy.test.invalid");
  d1 = createFinmathD1(readFileSync(new URL("../../drizzle/d1/0033_yahoo_proxy_cooldown.sql", import.meta.url), "utf8"));
  requests = [];
  direct.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (input, init) => {
    expect(String(input)).toBe("https://api.cloudflare.com/client/v4/accounts/protocol-test-only/d1/database/protocol-test-only/query");
    const q = JSON.parse(String(init?.body)); requests.push(q);
    const statement = d1.sqlite.prepare(q.sql);
    const results = q.sql.startsWith("SELECT") ? statement.all(...q.params) : [];
    const changes = q.sql.startsWith("SELECT") ? 0 : Number(statement.run(...q.params).changes);
    return Response.json({ success: true, result: [{ success: true, results, meta: { changes } }] });
  }));
});
afterEach(() => { d1.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Actions株式の明示direct transport", () => {
  it("現在の共有停止を読み、Yahooもproxyも取得しない", async () => {
    d1.sqlite.prepare("UPDATE yahoo_proxy_cooldown SET retry_at_ms=?,upstream_status=503").run(now + 120_000);
    const response = await createStockYahooDirectTransport()(target);
    expect(response.status).toBe(503);
    expect(response.headers.get("X-Kabulab-Yahoo-Cooldown")).toBe("active");
    expect(response.headers.get("X-Kabulab-Yahoo-Status")).toBeNull();
    expect(direct).not.toHaveBeenCalled(); expect(requests).toEqual([{ sql: YAHOO_COOLDOWN_SELECT, params: [] }]);
    await expect(fetchChart("7203", "5y", { transport: createStockYahooDirectTransport() }))
      .rejects.toThrow("source=shared-cooldown");
    expect(direct).not.toHaveBeenCalled();
  });

  it.each(["missing", "malformed", "unknown"])("共有read %sは専用typed STOP、Yahoo0、SQL/例外を公開しない", async fault => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    if (fault === "missing") d1.sqlite.exec("DELETE FROM yahoo_proxy_cooldown");
    if (fault === "malformed") { d1.sqlite.exec("PRAGMA ignore_check_constraints=ON"); d1.sqlite.exec("UPDATE yahoo_proxy_cooldown SET retry_at_ms=-1"); }
    if (fault === "unknown") vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private SQL/token must not escape")));
    await expect(createStockYahooDirectTransport()(target)).rejects.toEqual(new YahooSharedCooldownError());
    expect(direct).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
  });

  it.each([429, 503])("同じD1行へ%s停止を保存し、Chartの全原文capture後にtyped停止する", async status => {
    const onRaw = vi.fn();
    const source = new Response("unaltered source bytes", { status, headers: { "Retry-After": "120", "Set-Cookie": "private-test-cookie" } });
    Object.defineProperty(source, "url", { value: target + "?crumb=protocol-test-only" });
    direct.mockResolvedValue(source);
    await expect(fetchChart("7203", "5y", { transport: createStockYahooDirectTransport(), onRaw }))
      .rejects.toMatchObject({ name: "YahooRateLimitError", status, retryAtMs: now + 120_000 });
    expect(new TextDecoder().decode(onRaw.mock.calls[0][0].bytes)).toBe("unaltered source bytes");
    expect(onRaw.mock.calls[0][0].url).toBe(target + "?crumb=[redacted]");
    expect(d1.sqlite.prepare("SELECT * FROM yahoo_proxy_cooldown").get()).toEqual({ id: 1, retry_at_ms: now + 120_000, upstream_status: status });
    const proxy = await ingestProxyRoute.request("https://proxy.test.invalid/yahoo?u=" + encodeURIComponent(target),
      { headers: { Authorization: "Bearer protocol-test-only" } }, { DB: d1.binding });
    expect(proxy.status).toBe(status); expect(direct).toHaveBeenCalledTimes(1); // 別hostも同じ行で停止。
    expect(requests.map(q => q.sql)).toEqual([YAHOO_COOLDOWN_SELECT, YAHOO_COOLDOWN_UPSERT]);
  });

  it("authの既知絶対期限を延長せず保存し、短い遅着期限で既存長期停止を縮めない", async () => {
    const error = new YahooRateLimitError(429, 1000, now + 1000, "auth-crumb");
    direct.mockImplementation(async () => {
      d1.sqlite.prepare("UPDATE yahoo_proxy_cooldown SET retry_at_ms=?,upstream_status=503").run(now + 3600_000);
      throw error;
    });
    await expect(createStockYahooDirectTransport()(target)).rejects.toBe(error);
    expect(requests[1].params).toEqual([now + 1000, 429]);
    expect(d1.sqlite.prepare("SELECT retry_at_ms,upstream_status FROM yahoo_proxy_cooldown").get())
      .toEqual({ retry_at_ms: now + 3600_000, upstream_status: 503 });
  });

  it.each([429, 503])("停止保存unknownでも元%s本文をcaptureし、markerと固定logの後STOPする", async status => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {}), onRaw = vi.fn();
    direct.mockImplementation(async () => {
      d1.sqlite.exec("DELETE FROM yahoo_proxy_cooldown"); // preflight後の行消失。再seedしない。
      return new Response("source preserved after unknown persist", { status });
    });
    await expect(fetchChart("7203", "5y", { transport: createStockYahooDirectTransport(), onRaw }))
      .rejects.toMatchObject({ name: "YahooRateLimitError", status });
    expect(new TextDecoder().decode(onRaw.mock.calls[0][0].bytes)).toBe("source preserved after unknown persist");
    expect(onRaw.mock.calls[0][0].headers.cooldown).toBe("persist-failed");
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({ event: "yahoo_stock_direct_cooldown_failed", operation: "persist", globalCooldownGuaranteed: false });
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM yahoo_proxy_cooldown").get()).toEqual({ n: 0 });
  });

  it("D1待機後のsource期限で止まり、別transportへ切り替えない", async () => {
    const before = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error("source deadline"); });
    await expect(createStockYahooDirectTransport()(target, before)).rejects.toThrow("source deadline");
    expect(direct).not.toHaveBeenCalled(); expect(requests).toHaveLength(1);
  });

  it("Chartの共有DB不明でQuoteSummaryのD1再IOも送らない", async () => {
    const native = vi.fn().mockRejectedValue(new Error("D1 result unknown"));
    vi.stubGlobal("fetch", native);
    await expect(fetchStockRawData("7203", "5y", { transport: createStockYahooDirectTransport() }))
      .rejects.toBeInstanceOf(YahooSharedCooldownError);
    expect(native).toHaveBeenCalledTimes(1); expect(direct).not.toHaveBeenCalled();
  });

  it("D1待機中のclock停止は元の停止型を保持する", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("deadline", "TimeoutError")));
    const stopped = new Error("declared source clock stop");
    const before = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw stopped; });
    await expect(createStockYahooDirectTransport()(target, before)).rejects.toBe(stopped);
    expect(direct).not.toHaveBeenCalled();
  });

  it("既存hard wrapperはdirectの開始済みHTTPにも残signalを渡し、復元する", async () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-14T14:30:00Z") - 50);
    const d1Fetch = globalThis.fetch;
    const source: { signal: AbortSignal | null } = { signal: null };
    const native = vi.fn<typeof fetch>((input, init) => String(input).startsWith("https://api.cloudflare.com/") ? d1Fetch(input, init) : new Promise((_resolve, reject) => {
      source.signal = init!.signal!;
      if (source.signal.aborted) reject(source.signal.reason);
      else source.signal.addEventListener("abort", () => reject(source.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", native);
    direct.mockImplementation(url => fetch(url)); // 認証/値は扱わない、transportの未完HTTPだけ。
    const restore = installStockSyncDeadline("2026-10-14", { scheduled: true });
    try {
      await expect(createStockYahooDirectTransport()(target)).rejects.toMatchObject({ name: "TimeoutError" });
      expect(source.signal?.aborted).toBe(true); expect(native).toHaveBeenCalledTimes(2);
    } finally { restore(); }
    expect(globalThis.fetch).toBe(native);
  });

  it.each([403, 500])("実directの%sはproxy envが残ってもupstream障害と記録し、応答原文を保持する", async status => {
    const onRaw = vi.fn();
    direct.mockResolvedValue(new Response("direct upstream failure", { status }));
    await expect(fetchChart("7203", "5y", { transport: createStockYahooDirectTransport(), onRaw }))
      .rejects.toThrow(`source=yahoo-upstream; yahoo-status=${status}; yahoo-stage=chart`);
    expect(onRaw.mock.calls[0][0].status).toBe(status);
    expect(onRaw.mock.calls[0][0].headers.upstreamStatus).toBe(String(status));
    expect(new TextDecoder().decode(onRaw.mock.calls[0][0].bytes)).toBe("direct upstream failure");
    expect(requests).toHaveLength(1); expect(direct).toHaveBeenCalledTimes(1);
  });

  it.each(["https://other.test/v8/finance/chart/7203.T", target + "?crumb=not-allowed"])("対象外URLはD1/Yahoo前に拒否: %s", async url => {
    await expect(createStockYahooDirectTransport()(url)).rejects.toThrow("not allowed");
    expect(requests).toHaveLength(0); expect(direct).not.toHaveBeenCalled();
  });
});
