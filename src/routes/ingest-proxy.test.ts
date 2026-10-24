import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createFinmathD1, type FinmathD1 } from "../../services/financial-math/src/tests/helpers/finmath-d1.js";

vi.mock("../shared/yahoo/client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../shared/yahoo/client.js")>();
  return { ...actual, yahooFetchDirect: vi.fn() };
});

import { ingestProxyRoute } from "./ingest-proxy.js";
import {
  YahooRateLimitError,
  yahooFetchDirect,
} from "../shared/yahoo/client.js";

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;
const fetchYahoo = vi.mocked(yahooFetchDirect);
let d1: FinmathD1;
function request(url: string, init?: RequestInit) {
  return ingestProxyRoute.request(url, init, { DB: d1.binding });
}

beforeEach(() => {
  d1 = createFinmathD1(readFileSync(new URL("../../drizzle/d1/0033_yahoo_proxy_cooldown.sql", import.meta.url), "utf8"));
  process.env.CRON_SECRET = "test-secret";
  fetchYahoo.mockReset();
});

afterEach(() => {
  d1.close();
  vi.restoreAllMocks();
  if (ORIGINAL_CRON_SECRET === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  }
});

describe("GET /yahoo", () => {
  const target = "https://proxy.example.test/yahoo?u=" + encodeURIComponent("https://query1.finance.yahoo.com/v8/finance/chart/7203.T");
  const init = { headers: { Authorization: "Bearer test-secret" } };

  it("実SQLiteの競合UPSERTは長い期限を短縮せず、別requestをYahoo取得前に止める", async () => {
    const now = 1_790_727_043_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    let finishLong!: (response: Response) => void, finishShort!: (response: Response) => void;
    fetchYahoo.mockReturnValueOnce(new Promise(resolve => { finishLong = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { finishShort = resolve; }));
    const long = request(target, init), short = request(target, init);
    await vi.waitFor(() => expect(fetchYahoo).toHaveBeenCalledTimes(2));
    finishLong(new Response("original long 429", { status: 429, headers: { "Retry-After": "3600" } }));
    expect(await (await long).text()).toBe("original long 429");
    finishShort(new Response("original short 503", { status: 503, headers: { "Retry-After": "2" } }));
    expect(await (await short).text()).toBe("original short 503");
    expect(d1.sqlite.prepare("SELECT * FROM yahoo_proxy_cooldown").all()).toEqual([{ id: 1, retry_at_ms: now + 3_600_000, upstream_status: 429 }]);
    const stopped = await request(target, init);
    expect(stopped.status).toBe(429);
    expect(stopped.headers.get("Retry-After")).toBe("3600");
    expect(stopped.headers.get("X-Kabulab-Yahoo-Cooldown")).toBe("active");
    expect(stopped.headers.get("X-Kabulab-Yahoo-Stage")).toBe("shared-cooldown");
    expect(stopped.headers.get("X-Kabulab-Yahoo-Status")).toBeNull(); // 新しい上流応答ではない
    expect(fetchYahoo).toHaveBeenCalledTimes(2);
    expect(d1.executed.filter(sql => sql.startsWith("SELECT"))).toHaveLength(3);
    expect(d1.executed.filter(sql => sql.startsWith("INSERT"))).toHaveLength(2);
    expect(() => d1.sqlite.exec("INSERT INTO yahoo_proxy_cooldown VALUES (2,0,NULL)")).toThrow();
    expect(() => d1.sqlite.exec("UPDATE yahoo_proxy_cooldown SET upstream_status=NULL")).toThrow();
  });

  it.each(["DELETE FROM yahoo_proxy_cooldown", "DROP TABLE yahoo_proxy_cooldown"])("共有状態の欠損・読取失敗でYahoo通信0: %s", async sql => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    d1.sqlite.exec(sql);
    const response = await request(target, init);
    expect(response.status).toBe(502);
    expect(response.headers.get("X-Kabulab-Yahoo-Cooldown")).toBe("read-failed");
    expect(fetchYahoo).not.toHaveBeenCalled();
  });

  it("不正deadlineは取得前に拒否し、期限切れはSELECTだけで通す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    d1.sqlite.exec("PRAGMA ignore_check_constraints=ON");
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      d1.sqlite.prepare("UPDATE yahoo_proxy_cooldown SET retry_at_ms=?,upstream_status=429").run(value);
      expect((await request(target, init)).status).toBe(502);
      expect(fetchYahoo).not.toHaveBeenCalled();
    }
    d1.sqlite.exec("UPDATE yahoo_proxy_cooldown SET retry_at_ms=1,upstream_status=503");
    fetchYahoo.mockResolvedValue(new Response("expired, allowed"));
    expect(await (await request(target, init)).text()).toBe("expired, allowed");
    expect(d1.executed.filter(sql => sql.startsWith("INSERT"))).toHaveLength(0);
  });

  it.each([429, 503])("共有保存障害でも元%s本文・headerを中継し、失敗markerと安全logを残す", async status => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchYahoo.mockImplementation(async () => {
      // preflight後の行消失でもruntimeが自動seedしない。
      d1.sqlite.exec("DELETE FROM yahoo_proxy_cooldown");
      return new Response("source body untouched", { status, headers: { "Retry-After": "120", "Content-Type": "text/plain", "Set-Cookie": "secret-cookie" } });
    });
    const response = await request(target, init);
    expect(response.status).toBe(status);
    expect(response.headers.get("Retry-After")).toBe("120");
    expect(response.headers.get("X-Kabulab-Yahoo-Status")).toBe(String(status));
    expect(response.headers.get("X-Kabulab-Yahoo-Stage")).toBe("chart");
    expect(response.headers.get("X-Kabulab-Yahoo-Cooldown")).toBe("persist-failed");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await response.text()).toBe("source body untouched");
    expect(d1.sqlite.prepare("SELECT COUNT(*) AS n FROM yahoo_proxy_cooldown").get()).toEqual({ n: 0 });
    expect(JSON.parse(String(consoleError.mock.calls[0][0]))).toEqual({ event: "yahoo_ingest_proxy_cooldown_failed", source: "ingest-proxy", operation: "persist", globalCooldownGuaranteed: false });
  });

  it("安全整数を超える期限は短縮保存せず元429を残し、過去期限は負TTLにしない", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_790_727_043_000);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchYahoo.mockResolvedValueOnce(new Response("long", { status: 429, headers: { "Retry-After": "9007199254740991" } }));
    const long = await request(target, init);
    expect(long.status).toBe(429);
    expect(long.headers.get("X-Kabulab-Yahoo-Cooldown")).toBe("persist-failed");
    expect(long.headers.get("Retry-After")).toBe("9007199254740991");
    expect(await long.text()).toBe("long");
    expect(d1.sqlite.prepare("SELECT retry_at_ms FROM yahoo_proxy_cooldown").get()).toEqual({ retry_at_ms: 0 });
    fetchYahoo.mockRejectedValueOnce(new YahooRateLimitError(503, null, 1));
    const response = await request(target, init);
    expect(response.headers.get("Retry-After")).toBe("0");
    expect(d1.sqlite.prepare("SELECT retry_at_ms FROM yahoo_proxy_cooldown").get()).toEqual({ retry_at_ms: 1 });
  });

  it("不正なtyped status・deadlineは共有状態へ保存しない", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const error of [new YahooRateLimitError(500, 1000, null), new YahooRateLimitError(429, null, NaN), new YahooRateLimitError(503, -1, null)]) {
      fetchYahoo.mockRejectedValueOnce(error);
      const response = await request(target, init);
      expect(response.status).toBe(502);
      expect(response.headers.get("X-Kabulab-Yahoo-Cooldown")).toBe("persist-failed");
    }
    expect(d1.executed.filter(sql => sql.startsWith("INSERT"))).toHaveLength(0);
  });

  it.each([
    "https://query1.finance.yahoo.com/v1/test/getcrumb",
    "http://query1.finance.yahoo.com/v8/finance/chart/7203.T",
    "https://query1.finance.yahoo.com/v8/finance/chart/7203.T?crumb=injected",
    "https://query1.finance.yahoo.com/v8/finance/chart/x%2F..%2F..%2Fv1%2Ftest%2Fgetcrumb",
    "https://query1.finance.yahoo.com/v8/finance/chart/x%252Fgetcrumb",
  ])("許可外endpointではYahoo通信0: %s", async (url) => {
    const response = await request(
      `https://proxy.example.test/yahoo?u=${encodeURIComponent(url)}`,
      { headers: { Authorization: "Bearer test-secret" } }
    );
    expect(response.status).toBe(403);
    expect(fetchYahoo).not.toHaveBeenCalled();
  });

  it("壊れたpercent encodeもYahoo通信前に拒否する", async () => {
    const response = await request(
      `https://proxy.example.test/yahoo?u=${encodeURIComponent("https://query1.finance.yahoo.com/v8/finance/chart/%")}`,
      { headers: { Authorization: "Bearer test-secret" } }
    );
    expect(response.status).toBe(400);
    expect(fetchYahoo).not.toHaveBeenCalled();
  });

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

    const response = await request(
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

    const response = await request(
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

  it("YahooRateLimitError は 429 + Retry-After + 診断marker を返す", async () => {
    const retryAt = Date.now() + 5_000;
    fetchYahoo.mockRejectedValue(new YahooRateLimitError(429, 5_000, retryAt, "auth-crumb"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const target = encodeURIComponent(
      "https://query1.finance.yahoo.com/v8/finance/chart/7203.T"
    );

    const response = await request(
      `https://proxy.example.test/yahoo?u=${target}`,
      { headers: { Authorization: "Bearer test-secret" } }
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(response.headers.get("X-Kabulab-Yahoo-Status")).toBe("429");
    expect(response.headers.get("X-Kabulab-Yahoo-Stage")).toBe("auth-crumb");
    const body = await response.json();
    expect(body.error).toContain("yahoo rate limited");
    expect(body.error).toContain(`retry-at-ms=${retryAt}`);
    expect(body.error).not.toContain("A1=");
    expect(d1.sqlite.prepare("SELECT retry_at_ms,upstream_status FROM yahoo_proxy_cooldown").get()).toEqual({ retry_at_ms: retryAt, upstream_status: 429 });
    expect(consoleError).toHaveBeenCalledTimes(1);
    const log = String(consoleError.mock.calls[0]?.[0]);
    expect(JSON.parse(log)).toMatchObject({
      event: "yahoo_ingest_proxy_rate_limited",
      source: "ingest-proxy",
      status: 429,
      retryAfterSec: 5,
    });
  });

  it("typed 503 は503と停止期限を伝播する", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    fetchYahoo.mockRejectedValue(new YahooRateLimitError(503, null, null));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const target = encodeURIComponent(
      "https://query1.finance.yahoo.com/v8/finance/chart/7203.T"
    );

    const response = await request(
      `https://proxy.example.test/yahoo?u=${target}`,
      { headers: { Authorization: "Bearer test-secret" } }
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("900");
    expect(response.headers.get("X-Kabulab-Yahoo-Status")).toBe("503");
    expect((await response.json()).error).toContain("yahoo rate limited");
    expect(d1.sqlite.prepare("SELECT retry_at_ms,upstream_status FROM yahoo_proxy_cooldown").get()).toEqual({ retry_at_ms: now + 900_000, upstream_status: 503 });
  });

  it("相対 deadline のみでも 429 + Retry-After を返す", async () => {
    fetchYahoo.mockRejectedValue(new YahooRateLimitError(429, 3_000, null));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const target = encodeURIComponent(
      "https://query1.finance.yahoo.com/v8/finance/chart/7203.T"
    );

    const response = await request(
      `https://proxy.example.test/yahoo?u=${target}`,
      { headers: { Authorization: "Bearer test-secret" } }
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("3");
    expect(response.headers.get("X-Kabulab-Yahoo-Status")).toBe("429");
  });
});

describe("GET /moneyflow-sector", () => {
  it("認証が無ければ 401 を返す (D1 バインディングへは触れない)", async () => {
    const response = await request(
      "https://proxy.example.test/moneyflow-sector?week=2026-W38",
      { headers: {} }
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("誤った Bearer token でも 401 を返す", async () => {
    const response = await request(
      "https://proxy.example.test/moneyflow-sector?week=2026-W38",
      { headers: { Authorization: "Bearer wrong-secret" } }
    );
    expect(response.status).toBe(401);
  });

  it("week も from/to も無ければ 400 を返す (どちらを既定にするか黙って決めない)", async () => {
    const response = await request("https://proxy.example.test/moneyflow-sector", {
      headers: { Authorization: "Bearer test-secret" },
    });
    expect(response.status).toBe(400);
  });

  it("week と from/to を同時指定すると 400 を返す", async () => {
    const response = await request(
      "https://proxy.example.test/moneyflow-sector?week=2026-W38&from=2026-09-14&to=2026-09-20",
      { headers: { Authorization: "Bearer test-secret" } }
    );
    expect(response.status).toBe(400);
  });

  it("実在しない ISO 週番号は 400 を返す", async () => {
    const response = await request(
      "https://proxy.example.test/moneyflow-sector?week=2025-W53",
      { headers: { Authorization: "Bearer test-secret" } }
    );
    expect(response.status).toBe(400);
  });

  it("from が to より後なら 400 を返す", async () => {
    const response = await request(
      "https://proxy.example.test/moneyflow-sector?from=2026-09-20&to=2026-09-14",
      { headers: { Authorization: "Bearer test-secret" } }
    );
    expect(response.status).toBe(400);
  });
});
