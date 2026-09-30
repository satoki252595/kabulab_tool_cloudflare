/**
 * `createD1HttpDb` 単発 callback の厳密検証テスト (D1 には触らない)。
 * 実測 schema: top.success===true / result 配列 len1 /
 * entry object success===true / results 配列 / 全行 object。
 * explicit false は既存メッセージ、欠落・null・文字列・非 object は
 * outcome-unknown で throw し再送しない。bind は fetch 前に検証する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createD1HttpDb } from "./d1-http-client.js";
import * as coreSchema from "./core-schema.js";

const ORIG = {
  token: process.env.CLOUDFLARE_API_TOKEN,
  account: process.env.CLOUDFLARE_ACCOUNT_ID,
  db: process.env.D1_DATABASE_ID,
};

function useTestEnv(): void {
  process.env.CLOUDFLARE_API_TOKEN = "test-token";
  process.env.CLOUDFLARE_ACCOUNT_ID = "test-account";
  process.env.D1_DATABASE_ID = "test-db";
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of [
    ["CLOUDFLARE_API_TOKEN", ORIG.token],
    ["CLOUDFLARE_ACCOUNT_ID", ORIG.account],
    ["D1_DATABASE_ID", ORIG.db],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** drizzle は callback 例外を "Failed query" で wrap する。cause まで見る。 */
async function throwsWith(promise: Promise<unknown>, re: RegExp): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : null;
  const text = `${err instanceof Error ? err.message : String(err)} ${cause instanceof Error ? cause.message : ""}`;
  expect(text).toMatch(re);
}

function okSingle(results: unknown[]): Response {
  return new Response(
    JSON.stringify({
      success: true,
      result: [{ success: true, results, meta: { rows_read: results.length } }],
    }),
    { status: 200 }
  );
}

describe("createD1HttpDb strict response", () => {
  it("実測 shape の SELECT は行を位置配列で返す", async () => {
    useTestEnv();
    const fetch = vi.fn(async () => okSingle([{ id: 1, code: "1301" }, { id: 2, code: "1332" }]));
    vi.stubGlobal("fetch", fetch);
    const db = createD1HttpDb({});
    const rows = await db.select({ id: coreSchema.stocks.id, code: coreSchema.stocks.code }).from(coreSchema.stocks);
    expect(rows).toEqual([
      { id: 1, code: "1301" },
      { id: 2, code: "1332" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("results 空は正規 (all 空・get 空・write run)", async () => {
    useTestEnv();
    const fetch = vi.fn(async () => okSingle([]));
    vi.stubGlobal("fetch", fetch);
    const db = createD1HttpDb({});
    const rows = await db.select({ id: coreSchema.stocks.id }).from(coreSchema.stocks);
    expect(rows).toEqual([]);
    // get の空は drizzle が undefined field の object に map する (callback は [] を返す)。
    const one = await db.select({ id: coreSchema.stocks.id }).from(coreSchema.stocks).get();
    expect(one).toEqual({ id: undefined });
    await db.insert(coreSchema.stocks).values({ code: "1301", name: "n", market: "m" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("explicit false は既存メッセージ (top/entry)", async () => {
    useTestEnv();
    const topFalse = vi.fn(
      async () => new Response(JSON.stringify({ success: false, errors: [{ message: "boom" }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", topFalse);
    await throwsWith(
      createD1HttpDb({}).select({ id: coreSchema.stocks.id }).from(coreSchema.stocks),
      /D1 HTTP error/
    );
    const entryFalse = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: true, result: [{ success: false, error: "bad sql" }] }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", entryFalse);
    await throwsWith(
      createD1HttpDb({}).select({ id: coreSchema.stocks.id }).from(coreSchema.stocks),
      /D1 HTTP error/
    );
  });

  it("欠落/null/文字列/非 object は outcome-unknown (再送なし)", async () => {
    useTestEnv();
    const bodies: unknown[] = [
      // top。
      { result: [{ success: true, results: [] }] },
      { success: null, result: [{ success: true, results: [] }] },
      { success: "true", result: [{ success: true, results: [] }] },
      [{ success: true }],
      "ok",
      // result。
      { success: true },
      { success: true, result: null },
      { success: true, result: "ok" },
      { success: true, result: [] },
      { success: true, result: [{ success: true, results: [] }, { success: true, results: [] }] },
      // entry。
      { success: true, result: [null] },
      { success: true, result: ["ok"] },
      { success: true, result: [[{ success: true }]] },
      { success: true, result: [{}] },
      { success: true, result: [{ success: "true", results: [] }] },
      // results。
      { success: true, result: [{ success: true }] },
      { success: true, result: [{ success: true, results: null }] },
      { success: true, result: [{ success: true, results: "ok" }] },
      // row。
      { success: true, result: [{ success: true, results: [null] }] },
      { success: true, result: [{ success: true, results: ["ok"] }] },
      { success: true, result: [{ success: true, results: [[1]] }] },
    ];
    for (const body of bodies) {
      const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
      vi.stubGlobal("fetch", fetch);
      await throwsWith(
        createD1HttpDb({}).select({ id: coreSchema.stocks.id }).from(coreSchema.stocks),
        /再送なし/
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("不正 bind は fetch0 で止める (対照は送る)", async () => {
    useTestEnv();
    // undefined は drizzle が params から除去、配列は展開するため callback seam 到達不能。NaN/Infinity/object が到達する。
    const bad: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, { a: 1 }];
    for (const v of bad) {
      const fetch = vi.fn(async () => okSingle([]));
      vi.stubGlobal("fetch", fetch);
      await throwsWith(
        createD1HttpDb({}).select({ x: sql<number>`1 + ${v as never}` }).from(coreSchema.stocks),
        /非有限|対象外/
      );
      expect(fetch).not.toHaveBeenCalled();
    }
    const fetch = vi.fn(async () => okSingle([{ x: 1 }]));
    vi.stubGlobal("fetch", fetch);
    const rows = await createD1HttpDb({})
      .select({ x: sql<number>`1 + ${0}` })
      .from(coreSchema.stocks);
    expect(rows).toEqual([{ x: 1 }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
