/**
 * 日足 OHLCV（全系列調整）のテスト。
 *
 * 数値は調整計算の合成例（2:1 分割のモデルケース）。実市場の値ではない。
 * D1 はスタブで、実通信はしない。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import privateApp from "../src/private";
import publicApp from "../src/public";
import { handleMcp } from "../src/shared/mcp";
import { adjustBar, adjustmentFactor, fetchAdjustedOhlcv } from "../src/shared/ohlcv";
import {
  OHLCV_CACHE_TTL_SECS,
  ohlcvCacheKey,
} from "../src/shared/ohlcv-cache";
import type { PrivateEnv, PublicEnv } from "../src/shared/types";
import { stubD1, stubR2 } from "./helpers";

const AUTH = { headers: { "X-API-Key": "secret-key" } };

const BARS = [
  // 2:1 分割後（係数 0.5）。出来高は倍になる。
  { date: "2026-09-10", open: 2000, high: 2100, low: 1990, close: 2050, volume: 1000, adj: 1025 },
  // 未調整バー（adj 欠落 → 係数 1 で素通し）。
  { date: "2026-09-11", open: 100, high: 110, low: 99, close: 105, volume: 500, adj: null },
];

function privateEnv(): PrivateEnv {
  return {
    DB: stubD1((sql) => {
      if (sql.includes("FROM core_stocks")) return [{ id: 7 }];
      return BARS;
    }),
    RAW: stubR2({}),
    SUPPLY: stubR2({}),
    SURFACE: "private",
    JSS_API_KEYS: "secret-key",
  };
}

describe("adjustmentFactor", () => {
  it("adj/close の比を返す", () => {
    expect(adjustmentFactor(2050, 1025)).toBe(0.5);
  });

  it("adj 欠落・close ゼロは係数 1（無調整）", () => {
    expect(adjustmentFactor(105, null)).toBe(1);
    expect(adjustmentFactor(0, 10)).toBe(1);
  });
});

describe("adjustBar", () => {
  it("2:1 分割で OHLC 半分・出来高 2 倍", () => {
    const bar = adjustBar(BARS[0]!);
    expect(bar.adj_close).toBe(1025);
    expect(bar.adj_open).toBe(1000);
    expect(bar.adj_high).toBe(1050);
    expect(bar.adj_low).toBe(995);
    expect(bar.adj_volume).toBe(2000);
    expect(bar.adjusted).toBe(true);
    // 生値は保持する
    expect(bar.open).toBe(2000);
    expect(bar.volume).toBe(1000);
  });

  it("adj 欠落は生値のまま adjusted=false", () => {
    const bar = adjustBar(BARS[1]!);
    expect(bar.adj_open).toBe(100);
    expect(bar.adj_volume).toBe(500);
    expect(bar.adj_close).toBeNull();
    expect(bar.adjusted).toBe(false);
  });
});

describe("GET /v1/ohlcv/:code", () => {
  it("調整済み系列を返す", async () => {
    const res = await privateApp.request("/v1/ohlcv/7203", AUTH, privateEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { code: string; bars: Array<Record<string, unknown>> };
      meta: { licenses: string[] };
    };
    expect(body.data.code).toBe("7203");
    expect(body.data.bars).toHaveLength(2);
    expect(body.data.bars[0]!.adj_open).toBe(1000);
    expect(body.meta.licenses).toEqual(["personal-only"]);
  });

  it("不正なコードは 400", async () => {
    const res = await privateApp.request("/v1/ohlcv/ABC", AUTH, privateEnv());
    expect(res.status).toBe(400);
  });

  it("書式違いの from は 400", async () => {
    const res = await privateApp.request("/v1/ohlcv/7203?from=2026/09/01", AUTH, privateEnv());
    expect(res.status).toBe(400);
  });

  it("未知の銘柄は 404", async () => {
    const env = privateEnv();
    env.DB = stubD1(() => []);
    const res = await privateApp.request("/v1/ohlcv/7203", AUTH, env);
    expect(res.status).toBe(404);
  });

  it("公開面には出さない（personal-only）", async () => {
    const pubEnv = { DB: stubD1(() => []), RAW: stubR2({}), SURFACE: "public" } as PublicEnv;
    const res = await publicApp.request("/v1/ohlcv/7203", {}, pubEnv);
    expect(res.status).toBe(404);
  });
});

describe("fetchAdjustedOhlcv", () => {
  it("limit が SQL に載る", async () => {
    const seen: unknown[][] = [];
    const db = stubD1((sql, params) => {
      seen.push(params);
      if (sql.includes("FROM core_stocks")) return [{ id: 7 }];
      return BARS;
    });
    await fetchAdjustedOhlcv(db, "7203", { limit: 10 });
    const ohlcvParams = seen.find((p) => p.includes(10));
    expect(ohlcvParams).toBeDefined();
  });
});

describe("MCP jp_ohlcv_range", () => {
  async function call(args: Record<string, unknown>) {
    const req = new Request("http://x/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "jp_ohlcv_range", arguments: args },
      }),
    });
    const res = await handleMcp(req, privateEnv());
    return (await res.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
  }

  it("調整済み系列を返す", async () => {
    const body = await call({ code: "7203" });
    expect(body.result.isError).toBeUndefined();
    const payload = JSON.parse(body.result.content[0]!.text) as {
      data: { bars: Array<Record<string, unknown>> };
    };
    expect(payload.data.bars[0]!.adj_open).toBe(1000);
  });

  it("不正なコードは isError", async () => {
    const body = await call({ code: "ABC" });
    expect(body.result.isError).toBe(true);
  });
});

describe("OHLCV edge キャッシュ", () => {
  let store: Map<string, Response>;
  let d1Calls: number;
  const realCaches = (globalThis as { caches?: unknown }).caches;

  beforeEach(() => {
    store = new Map();
    d1Calls = 0;
    (globalThis as { caches?: unknown }).caches = {
      default: {
        // 本物の Cache API と同じく match ごとに新しい実体を返す。
        // 同一 Response を使い回すと body が消費済みで落ちる。
        match: async (req: Request) => store.get(req.url)?.clone() ?? undefined,
        put: async (req: Request, res: Response) => {
          store.set(req.url, res.clone());
        },
      },
    };
  });

  afterEach(() => {
    if (realCaches === undefined) {
      delete (globalThis as { caches?: unknown }).caches;
    } else {
      (globalThis as { caches?: unknown }).caches = realCaches;
    }
  });

  function countingEnv(): PrivateEnv {
    return {
      DB: stubD1((sql) => {
        d1Calls += 1;
        if (sql.includes("FROM core_stocks")) return [{ id: 7 }];
        return BARS;
      }),
      RAW: stubR2({}),
      SUPPLY: stubR2({}),
      SURFACE: "private",
      JSS_API_KEYS: "secret-key",
    };
  }

  async function callMcp(args: Record<string, unknown>, env: PrivateEnv) {
    const req = new Request("http://x/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "jp_ohlcv_range", arguments: args },
      }),
    });
    const res = await handleMcp(req, env);
    return (await res.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
  }

  it("2回目は D1 を叩かず HIT", async () => {
    const env = countingEnv();
    const first = await privateApp.request("/v1/ohlcv/7203", AUTH, env);
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Cache")).toBe("MISS");
    expect(first.headers.get("Cache-Control")).toBe(
      `private, max-age=${OHLCV_CACHE_TTL_SECS}`,
    );
    const firstBody = await first.text();
    const second = await privateApp.request("/v1/ohlcv/7203", AUTH, env);
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Cache")).toBe("HIT");
    expect(await second.text()).toBe(firstBody);
    // 銘柄 lookup + 日足 select の 2 発だけ。2 回目は D1 に触れない。
    expect(d1Calls).toBe(2);
  });

  it("TTL 切れは再取得する", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    store.set(
      ohlcvCacheKey("7203", { limit: 250 }),
      new Response(
        JSON.stringify({
          cachedAt: nowSec - OHLCV_CACHE_TTL_SECS - 1,
          payload: { code: "7203", bars: [] },
        }),
      ),
    );
    const res = await privateApp.request("/v1/ohlcv/7203", AUTH, countingEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("MISS");
    expect(d1Calls).toBe(2);
  });

  it("パラメータ違いは別エントリ", async () => {
    const env = countingEnv();
    await privateApp.request("/v1/ohlcv/7203?limit=5", AUTH, env);
    await privateApp.request("/v1/ohlcv/7203?limit=10", AUTH, env);
    expect(store.size).toBe(2);
    expect(d1Calls).toBe(4);
  });

  it("401 は束ねない・数えない", async () => {
    const res = await privateApp.request("/v1/ohlcv/7203", {}, countingEnv());
    expect(res.status).toBe(401);
    expect(d1Calls).toBe(0);
    expect(store.size).toBe(0);
  });

  it("MCP と REST で束ねを共有する", async () => {
    const env = countingEnv();
    await privateApp.request("/v1/ohlcv/7203", AUTH, env);
    const body = await callMcp({ code: "7203" }, env);
    expect(body.result.isError).toBeUndefined();
    // REST で束ねた分が効き、MCP は D1 に触れない。
    expect(d1Calls).toBe(2);
  });

  it("404 は束ねない", async () => {
    const env = countingEnv();
    // core_stocks に居ない銘柄にする
    env.DB = stubD1((sql) => {
      d1Calls += 1;
      if (sql.includes("FROM core_stocks")) return [];
      return BARS;
    });
    const first = await privateApp.request("/v1/ohlcv/9999", AUTH, env);
    const second = await privateApp.request("/v1/ohlcv/9999", AUTH, env);
    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(second.headers.get("X-Cache")).toBeNull();
    expect(d1Calls).toBe(2);
    expect(store.size).toBe(0);
  });

  it("caches が無ければ素通しする", async () => {
    delete (globalThis as { caches?: unknown }).caches;
    const res = await privateApp.request("/v1/ohlcv/7203", AUTH, countingEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("MISS");
    expect(d1Calls).toBe(2);
  });
});
