/**
 * `createD1HttpBatchSender` の回帰テスト (D1 には触らない。`fetch` を差し替える)。
 *
 * 固定するのは「実証時と同一の payload 形」: endpoint は単発と同じ `/query`、
 * body は `{batch: [{sql, params}, ...]}` (公式 REST 文書の MultipleQueries 形。
 * 隔離の一時 D1 でこの形の全文ロールバック・全適用を観測済み。一時 D1 は削除済み)。
 * generic な batch 名前ではなく envelope の形そのものを完全一致で見る。
 * 失敗時は throw (黙って部分適用を返さない)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createD1HttpBatchSender } from "./d1-http-client.js";

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

function okBatch(n: number): Response {
  return new Response(
    JSON.stringify({
      success: true,
      result: Array.from({ length: n }, () => ({ success: true, meta: { changes: 1 } })),
    }),
    { status: 200 }
  );
}

describe("createD1HttpBatchSender", () => {
  it("単発と同じ /query へ {batch:[{sql,params}]} を 1 リクエストで送る", async () => {
    useTestEnv();
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return okBatch(2);
      })
    );

    await createD1HttpBatchSender()([
      { sql: "UPDATE yutai_benefits SET short_summary = ? WHERE id = ?", params: ["要約", 11] },
      { sql: "UPDATE otakara_stock_financials SET yutai_yield = ? WHERE stock_id = ?", params: [1.5, 101] },
    ]);

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/test-account/d1/database/test-db/query"
    );
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer test-token",
    });
    // 実証時と同一の envelope。配列直送りでも複文連結でもない。
    expect(JSON.parse(seen[0].init.body as string)).toEqual({
      batch: [
        { sql: "UPDATE yutai_benefits SET short_summary = ? WHERE id = ?", params: ["要約", 11] },
        { sql: "UPDATE otakara_stock_financials SET yutai_yield = ? WHERE stock_id = ?", params: [1.5, 101] },
      ],
    });
  });

  it("文が 0 件なら送らずに投げる", async () => {
    useTestEnv();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(createD1HttpBatchSender()([])).rejects.toThrow(/0 件/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("HTTP 非 200 / success:false は投げる", async () => {
    useTestEnv();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(createD1HttpBatchSender()([{ sql: "SELECT 1", params: [] }])).rejects.toThrow(
      /D1 HTTP 500/
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ success: false, errors: ["bad"] }), { status: 200 }))
    );
    await expect(createD1HttpBatchSender()([{ sql: "SELECT 1", params: [] }])).rejects.toThrow(
      /D1 HTTP error/
    );
  });

  it("応答件数の不一致・文別の失敗は投げる (部分適用を成功扱いしない)", async () => {
    useTestEnv();
    vi.stubGlobal("fetch", vi.fn(async () => okBatch(1)));
    await expect(
      createD1HttpBatchSender()([
        { sql: "SELECT 1", params: [] },
        { sql: "SELECT 2", params: [] },
      ])
    ).rejects.toThrow(/一致しません/);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            success: true,
            result: [{ success: true }, { success: false, error: "no such table" }],
          }),
          { status: 200 }
        );
      })
    );
    await expect(
      createD1HttpBatchSender()([
        { sql: "SELECT 1", params: [] },
        { sql: "SELECT 2", params: [] },
      ])
    ).rejects.toThrow(/2 件目の文が失敗/);
  });
});
