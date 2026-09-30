import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_PROXY_BASE = process.env.YAHOO_PROXY_BASE;
const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pageResponse(cookie: string): Response {
  return new Response("", { headers: { "Set-Cookie": cookie } });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input.toString();
}

beforeEach(() => {
  vi.resetModules();
  delete process.env.YAHOO_PROXY_BASE;
  delete process.env.CRON_SECRET;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (ORIGINAL_PROXY_BASE === undefined) {
    delete process.env.YAHOO_PROXY_BASE;
  } else {
    process.env.YAHOO_PROXY_BASE = ORIGINAL_PROXY_BASE;
  }
  if (ORIGINAL_CRON_SECRET === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = ORIGINAL_CRON_SECRET;
  }
});

describe("yahooFetchDirect credential coordination", () => {
  it("同時2 requestでもbootstrapをisolate内で1回だけ実行する", async () => {
    const page = deferred<Response>();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL): Promise<Response> => {
        const url = requestUrl(input);
        if (url === "https://finance.yahoo.com/quote/AAPL") {
          return page.promise;
        }
        if (url === "https://query2.finance.yahoo.com/v1/test/getcrumb") {
          return new Response("crumb-1");
        }
        if (url.includes("query1.finance.yahoo.com/v8/test/")) {
          return new Response("ok");
        }
        throw new Error(`unexpected fetch: ${url}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const { yahooFetchDirect } = await import("./client.js");

    const first = yahooFetchDirect(
      "https://query1.finance.yahoo.com/v8/test/first"
    );
    const second = yahooFetchDirect(
      "https://query1.finance.yahoo.com/v8/test/second"
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    page.resolve(pageResponse("A1=cookie-1; Path=/"));

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const urls = fetchMock.mock.calls.map(([input]) => requestUrl(input));
    expect(
      urls.filter((url) => url === "https://finance.yahoo.com/quote/AAPL")
    ).toHaveLength(1);
    expect(
      urls.filter(
        (url) =>
          url === "https://query2.finance.yahoo.com/v1/test/getcrumb"
      )
    ).toHaveLength(1);
    expect(urls.filter((url) => url.includes("crumb=crumb-1"))).toHaveLength(
      2
    );
  });

  it("bootstrap失敗を全waiterへ伝え、次のrequestだけが再取得できる", async () => {
    const firstPage = deferred<Response>();
    let pageCalls = 0;
    let crumbCalls = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL): Promise<Response> => {
        const url = requestUrl(input);
        if (url === "https://finance.yahoo.com/quote/AAPL") {
          pageCalls++;
          return pageCalls === 1
            ? firstPage.promise
            : pageResponse("A1=recovered-cookie; Path=/");
        }
        if (url === "https://query2.finance.yahoo.com/v1/test/getcrumb") {
          crumbCalls++;
          return crumbCalls === 1
            ? new Response("temporary failure", {
                status: 500,
                statusText: "Internal Server Error",
              })
            : new Response("recovered-crumb");
        }
        if (url.includes("query1.finance.yahoo.com/v8/test/")) {
          return new Response("ok");
        }
        throw new Error(`unexpected fetch: ${url}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const { yahooFetchDirect } = await import("./client.js");

    const first = yahooFetchDirect(
      "https://query1.finance.yahoo.com/v8/test/first"
    );
    const second = yahooFetchDirect(
      "https://query1.finance.yahoo.com/v8/test/second"
    );
    await vi.waitFor(() => expect(pageCalls).toBe(1));
    firstPage.resolve(pageResponse("A1=failed-cookie; Path=/"));

    const failed = await Promise.allSettled([first, second]);
    expect(failed).toHaveLength(2);
    for (const result of failed) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(String(result.reason)).toContain(
          "Yahoo crumb HTTP エラー: 500 Internal Server Error"
        );
      }
    }
    expect(pageCalls).toBe(1);
    expect(crumbCalls).toBe(1);

    const recovered = await yahooFetchDirect(
      "https://query1.finance.yahoo.com/v8/test/recovered"
    );
    expect(recovered.status).toBe(200);
    expect(pageCalls).toBe(2);
    expect(crumbCalls).toBe(2);
  });

  it("後続attemptの失敗が先行waiterの失敗結果を上書きしない", async () => {
    vi.useFakeTimers();
    try {
      const firstCrumb = deferred<Response>();
      const secondCrumb = deferred<Response>();
      const firstCrumbRequested = deferred<void>();
      const secondCrumbRequested = deferred<void>();
      let pageCalls = 0;
      let crumbCalls = 0;
      const fetchMock = vi.fn(
        async (input: RequestInfo | URL): Promise<Response> => {
          const url = requestUrl(input);
          if (url === "https://finance.yahoo.com/quote/AAPL") {
            pageCalls++;
            return pageResponse(`A1=cookie-${pageCalls}; Path=/`);
          }
          if (url === "https://query2.finance.yahoo.com/v1/test/getcrumb") {
            crumbCalls++;
            if (crumbCalls === 1) {
              firstCrumbRequested.resolve(undefined);
              return firstCrumb.promise;
            }
            secondCrumbRequested.resolve(undefined);
            return secondCrumb.promise;
          }
          throw new Error(`unexpected fetch: ${url}`);
        }
      );
      vi.stubGlobal("fetch", fetchMock);
      const { yahooFetchDirect } = await import("./client.js");

      const firstOwner = yahooFetchDirect(
        "https://query1.finance.yahoo.com/v8/test/first-owner"
      ).catch((error: unknown) => error);
      const firstWaiter = yahooFetchDirect(
        "https://query1.finance.yahoo.com/v8/test/first-waiter"
      ).catch((error: unknown) => error);
      await firstCrumbRequested.promise;
      firstCrumb.resolve(
        new Response("failure-one", {
          status: 500,
          statusText: "Internal Server Error",
        })
      );
      expect(String(await firstOwner)).toContain("failure-one");

      const secondOwner = yahooFetchDirect(
        "https://query1.finance.yahoo.com/v8/test/second-owner"
      ).catch((error: unknown) => error);
      await secondCrumbRequested.promise;
      secondCrumb.resolve(
        new Response("failure-two", {
          status: 500,
          statusText: "Internal Server Error",
        })
      );
      expect(String(await secondOwner)).toContain("failure-two");

      await vi.advanceTimersByTimeAsync(100);
      expect(String(await firstWaiter)).toContain("failure-one");
      expect(pageCalls).toBe(2);
      expect(crumbCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("終了しないownerを30秒でfail-closedにし、次requestで再取得できる", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-31T00:00:00.000Z"));
      const stalledPage = deferred<Response>();
      let pageCalls = 0;
      let crumbCalls = 0;
      const fetchMock = vi.fn(
        async (input: RequestInfo | URL): Promise<Response> => {
          const url = requestUrl(input);
          if (url === "https://finance.yahoo.com/quote/AAPL") {
            pageCalls++;
            return pageCalls === 1
              ? stalledPage.promise
              : pageResponse("A1=recovered-cookie; Path=/");
          }
          if (url === "https://query2.finance.yahoo.com/v1/test/getcrumb") {
            crumbCalls++;
            return new Response("recovered-crumb");
          }
          if (url.includes("query1.finance.yahoo.com/v8/test/")) {
            return new Response("ok");
          }
          throw new Error(`unexpected fetch: ${url}`);
        }
      );
      vi.stubGlobal("fetch", fetchMock);
      const { yahooFetchDirect } = await import("./client.js");

      const ownerResult = yahooFetchDirect(
        "https://query1.finance.yahoo.com/v8/test/owner"
      ).catch((error: unknown) => error);
      const waiterResult = yahooFetchDirect(
        "https://query1.finance.yahoo.com/v8/test/waiter"
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(String(await waiterResult)).toContain(
        "Yahoo credential refresh timed out after 30000ms"
      );
      expect(pageCalls).toBe(1);
      expect(crumbCalls).toBe(0);

      const recovered = await yahooFetchDirect(
        "https://query1.finance.yahoo.com/v8/test/recovered"
      );
      expect(recovered.status).toBe(200);
      expect(pageCalls).toBe(2);
      expect(crumbCalls).toBe(1);

      stalledPage.resolve(pageResponse("A1=stale-cookie; Path=/"));
      expect(String(await ownerResult)).toContain(
        "Yahoo credential refresh ownership expired"
      );
      expect(crumbCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("遅延した旧generationの401が更新済みcredentialを無効化しない", async () => {
    const firstUnauthorized = deferred<Response>();
    const secondUnauthorized = deferred<Response>();
    let pageCalls = 0;
    let crumbCalls = 0;
    const urls: string[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL): Promise<Response> => {
        const url = requestUrl(input);
        urls.push(url);
        if (url === "https://finance.yahoo.com/quote/AAPL") {
          pageCalls++;
          return pageResponse(
            pageCalls === 1
              ? "A1=old-cookie; Path=/"
              : "A1=new-cookie; Path=/"
          );
        }
        if (url === "https://query2.finance.yahoo.com/v1/test/getcrumb") {
          crumbCalls++;
          return new Response(crumbCalls === 1 ? "old-crumb" : "new-crumb");
        }
        if (url.includes("/v8/test/first") && url.includes("old-crumb")) {
          return firstUnauthorized.promise;
        }
        if (url.includes("/v8/test/second") && url.includes("old-crumb")) {
          return secondUnauthorized.promise;
        }
        if (url.includes("new-crumb")) return new Response("ok");
        throw new Error(`unexpected fetch: ${url}`);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const { yahooFetchDirect } = await import("./client.js");

    const first = yahooFetchDirect(
      "https://query1.finance.yahoo.com/v8/test/first"
    );
    const second = yahooFetchDirect(
      "https://query1.finance.yahoo.com/v8/test/second"
    );
    await vi.waitFor(() => {
      expect(
        urls.filter((url) => url.includes("old-crumb") && url.includes("/v8/"))
      ).toHaveLength(2);
    });

    firstUnauthorized.resolve(new Response("unauthorized", { status: 401 }));
    await vi.waitFor(() => {
      expect(
        urls.some(
          (url) => url.includes("/v8/test/first") && url.includes("new-crumb")
        )
      ).toBe(true);
    });
    secondUnauthorized.resolve(new Response("unauthorized", { status: 401 }));

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(pageCalls).toBe(2);
    expect(crumbCalls).toBe(2);
    expect(
      urls.filter(
        (url) => url.includes("/v8/test/") && url.includes("new-crumb")
      )
    ).toHaveLength(2);
  });
});

describe("crumb 429 cooldown", () => {
  const PAGE = "https://finance.yahoo.com/quote/AAPL";
  const CRUMB = "https://query2.finance.yahoo.com/v1/test/getcrumb";
  const TARGET = "https://query1.finance.yahoo.com/v8/test/target";

  it("crumb 429 は絶対 deadline 付き typed error を投げる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = requestUrl(input);
        if (url === PAGE) return pageResponse("A1=secret-cookie; Path=/");
        if (url === CRUMB) return new Response("slow down", { status: 429 });
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    const { yahooFetchDirect, YahooRateLimitError } = await import("./client.js");
    const before = Date.now();
    const err = await yahooFetchDirect(TARGET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YahooRateLimitError);
    const typed = err as InstanceType<typeof YahooRateLimitError>;
    expect(typed.status).toBe(429);
    expect(typed.retryAtMs).toBeGreaterThanOrEqual(before + 5_000 - 100);
    expect(typed.retryAtMs).toBeLessThanOrEqual(Date.now() + 5_000);
    expect(String(err)).toContain(`retry-at-ms=${typed.retryAtMs}`);
    expect(String(err)).not.toContain("secret-cookie");
  });

  it("crumb 429 の Retry-After を deadline に使う", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = requestUrl(input);
        if (url === PAGE) return pageResponse("A1=c; Path=/");
        if (url === CRUMB) {
          return new Response("slow down", {
            status: 429,
            headers: { "Retry-After": "2" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    const { yahooFetchDirect, YahooRateLimitError } = await import("./client.js");
    const before = Date.now();
    const err = await yahooFetchDirect(TARGET).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YahooRateLimitError);
    const typed = err as InstanceType<typeof YahooRateLimitError>;
    expect(typed.retryAtMs).toBeGreaterThanOrEqual(before + 2_000 - 100);
    expect(typed.retryAtMs).toBeLessThanOrEqual(Date.now() + 2_000);
  });

  it("同時 waiter は同一 typed error を共有し bootstrap は 1 回", async () => {
    const page = deferred<Response>();
    let pageCalls = 0;
    let crumbCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = requestUrl(input);
        if (url === PAGE) {
          pageCalls++;
          return page.promise;
        }
        if (url === CRUMB) {
          crumbCalls++;
          return new Response("slow down", { status: 429 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    const { yahooFetchDirect, YahooRateLimitError } = await import("./client.js");
    const first = yahooFetchDirect(TARGET).catch((e: unknown) => e);
    const second = yahooFetchDirect(TARGET).catch((e: unknown) => e);
    await vi.waitFor(() => expect(pageCalls).toBe(1));
    page.resolve(pageResponse("A1=c; Path=/"));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBeInstanceOf(YahooRateLimitError);
    expect(b).toBe(a);
    expect(pageCalls).toBe(1);
    expect(crumbCalls).toBe(1);
  });

  it("期限内 reentry は bootstrap 0 で同一 deadline を投げる", async () => {
    let pageCalls = 0;
    let crumbCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = requestUrl(input);
        if (url === PAGE) {
          pageCalls++;
          return pageResponse("A1=c; Path=/");
        }
        if (url === CRUMB) {
          crumbCalls++;
          return new Response("slow down", { status: 429 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    const { yahooFetchDirect, YahooRateLimitError } = await import("./client.js");
    const first = await yahooFetchDirect(TARGET).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(YahooRateLimitError);
    const second = await yahooFetchDirect(TARGET).catch((e: unknown) => e);
    expect(second).toBe(first);
    expect((second as InstanceType<typeof YahooRateLimitError>).retryAtMs).toBe(
      (first as InstanceType<typeof YahooRateLimitError>).retryAtMs
    );
    expect(pageCalls).toBe(1);
    expect(crumbCalls).toBe(1);
  });

  it("長い合法 Retry-After は実期限で冷却し、期限切れ後に回復する", async () => {
    let now = 1_790_727_043_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let pageCalls = 0;
    let crumbCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = requestUrl(input);
        if (url === PAGE) {
          pageCalls++;
          return pageResponse(`A1=c${pageCalls}; Path=/`);
        }
        if (url === CRUMB) {
          crumbCalls++;
          return crumbCalls === 1
            ? new Response("slow down", {
                status: 429,
                headers: { "Retry-After": "120" },
              })
            : new Response(`crumb-${crumbCalls}`);
        }
        if (url.includes("query1.finance.yahoo.com/v8/test/")) {
          return new Response("ok");
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    const { yahooFetchDirect, YahooRateLimitError } = await import("./client.js");
    const failed = await yahooFetchDirect(TARGET).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(YahooRateLimitError);
    // 30 秒に短縮せず source 実期限 (120 秒) を保持する。
    expect((failed as InstanceType<typeof YahooRateLimitError>).retryAtMs).toBe(
      now + 120_000
    );
    // 期限前 reentry は bootstrap しない。
    now += 30_000;
    const cooled = await yahooFetchDirect(TARGET).catch((e: unknown) => e);
    expect(cooled).toBe(failed);
    expect(pageCalls).toBe(1);
    expect(crumbCalls).toBe(1);
    // 期限切れ後は fresh bootstrap で回復する。
    now += 91_000;
    const recovered = await yahooFetchDirect(TARGET);
    expect(recovered.status).toBe(200);
    expect(pageCalls).toBe(2);
    expect(crumbCalls).toBe(2);
  });

  it("期限切れ後は fresh bootstrap で回復する", async () => {
    let now = 1_790_727_043_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let pageCalls = 0;
    let crumbCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = requestUrl(input);
        if (url === PAGE) {
          pageCalls++;
          return pageResponse(`A1=c${pageCalls}; Path=/`);
        }
        if (url === CRUMB) {
          crumbCalls++;
          return crumbCalls === 1
            ? new Response("slow down", { status: 429 })
            : new Response(`crumb-${crumbCalls}`);
        }
        if (url.includes("query1.finance.yahoo.com/v8/test/")) {
          return new Response("ok");
        }
        throw new Error(`unexpected fetch: ${url}`);
      })
    );
    const { yahooFetchDirect, YahooRateLimitError } = await import("./client.js");
    const failed = await yahooFetchDirect(TARGET).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(YahooRateLimitError);
    now += 6_000;
    const recovered = await yahooFetchDirect(TARGET);
    expect(recovered.status).toBe(200);
    expect(pageCalls).toBe(2);
    expect(crumbCalls).toBe(2);
  });
});
