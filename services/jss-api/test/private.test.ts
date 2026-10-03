import { describe, expect, it } from "vitest";

import app, { isAuthorized } from "../src/private";
import type { PrivateEnv } from "../src/shared/types";
import { stubD1, stubR2 } from "./helpers";

function env(overrides: Partial<PrivateEnv> = {}): PrivateEnv {
  return {
    DB: stubD1(() => [{ code: "7203", data_type: "jsf_zandaka", loan_bal: 100 }]),
    RAW: stubR2({}),
    SUPPLY: stubR2({
      "supply/7203.json": {
        code: "7203",
        updated: "2026-09-11",
        series: {
          jsf_zandaka: [
            { d: "2026-09-09", ex: "東証", loan_bal: 90 },
            { d: "2026-09-10", ex: "東証", loan_bal: 100 },
          ],
        },
      },
    }),
    SURFACE: "private",
    JSS_API_KEYS: "secret-key",
    ...overrides,
  };
}

const AUTH = { headers: { "X-API-Key": "secret-key" } };

describe("内部面の優待時期", () => {
  it("実月・随時・単発日を区別し、内部0を暦月として返さない", async () => {
    const rows = [
      { genre_id: 1, min_shares: 100, record_month: 3, record_date: null },
      { genre_id: 1, min_shares: 100, record_month: 0, record_date: null },
      { genre_id: 1, min_shares: 100, record_month: 9, record_date: "2026-09-02" },
    ];
    const res = await app.request("/v1/yutai/7203", AUTH, env({ DB: stubD1(() => rows) }));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown>[] };
    expect(body.data).toEqual([
      { ...rows[0], schedule: "monthly" },
      { ...rows[1], record_month: null, schedule: "anytime" },
      { ...rows[2], schedule: "one_off" },
    ]);
  });

  it("不正月や随時と単発日の混在を正常データとして配信しない", async () => {
    for (const schedule of [
      { record_month: 13, record_date: null },
      { record_month: 0, record_date: "2026-09-02" },
    ]) {
      const res = await app.request("/v1/yutai/7203", AUTH, env({
        DB: stubD1(() => [{ genre_id: 1, min_shares: 100, ...schedule }]),
      }));
      expect(res.status).toBe(500);
    }
  });
});

describe("内部面の認証", () => {
  it("APIキー未設定なら fail-closed で 503（素通しにしない）", async () => {
    const res = await app.request("/v1/supply/latest", {}, env({ JSS_API_KEYS: undefined }));
    expect(res.status).toBe(503);
  });

  it("空文字の設定も未設定として扱う", async () => {
    const res = await app.request("/v1/supply/latest", {}, env({ JSS_API_KEYS: "  " }));
    expect(res.status).toBe(503);
  });

  it("キーが違えば 401", async () => {
    const res = await app.request(
      "/v1/supply/latest", { headers: { "X-API-Key": "wrong" } }, env(),
    );
    expect(res.status).toBe(401);
  });

  it("キーが無ければ 401", async () => {
    const res = await app.request("/v1/supply/latest", {}, env());
    expect(res.status).toBe(401);
  });

  it("正しいキーなら 200", async () => {
    const res = await app.request("/v1/supply/latest", AUTH, env());
    expect(res.status).toBe(200);
  });

  it("health は認証なしで見える", async () => {
    const res = await app.request("/health", {}, env({ JSS_API_KEYS: undefined }));
    expect(res.status).toBe(200);
  });

  it("複数キーを受け付ける", () => {
    const e = env({ JSS_API_KEYS: "a,b , c" });
    expect(isAuthorized(e, "b")).toBe(true);
    expect(isAuthorized(e, "c")).toBe(true);
    expect(isAuthorized(e, "d")).toBe(false);
  });
});

describe("内部面の需給", () => {
  it("系列を期間で絞れる", async () => {
    const res = await app.request("/v1/supply/7203?from=2026-09-10", AUTH, env());
    const body = await res.json() as { data: { series: Record<string, unknown[]> } };
    expect(body.data.series.jsf_zandaka).toHaveLength(1);
  });

  it("personal-only であることを封筒に明示する", async () => {
    const res = await app.request("/v1/supply/7203", AUTH, env());
    const body = await res.json() as { meta: { licenses: string[] } };
    expect(body.meta.licenses).toContain("personal-only");
  });

  it("銘柄コードが4桁でなければ 400", async () => {
    const res = await app.request("/v1/supply/72031", AUTH, env());
    expect(res.status).toBe(400);
  });
});
