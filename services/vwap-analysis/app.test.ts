/**
 * VWAP Analysis 公開 API (app.ts) の /api/margin のテスト。
 * R2 (BUCKET) を差し替えた Hono app.request で、崩壊週の除外と正常週の
 * 保護を確かめる。週ファイルの中身は合成 (実 R2 の行の形だけ真似る)。
 */
import { describe, expect, it } from "vitest";
import app from "./app.js";

function bucket(files: Record<string, unknown>) {
  return {
    get: async (key: string) => {
      if (!(key in files)) return null;
      const text = JSON.stringify(files[key]);
      return { body: null, text: async () => text };
    },
  };
}

const NORMAL_WEEK = {
  week: "2026-09-11",
  rows: [
    { code: "2593", sell: 100, sell_chg: 1, buy: 200, buy_chg: 2 },
    { code: "25935", sell: 10, sell_chg: 0, buy: 20, buy_chg: 0 },
    { code: "7203", sell: 300, sell_chg: 3, buy: 400, buy_chg: 4 },
  ],
};

// 実測の崩壊形 (2026-09-04 の R2): 同一 4 桁コードの複数行。
const COLLAPSED_WEEK = {
  week: "2026-09-04",
  rows: [
    { code: "2593", sell: 77200, sell_chg: -78300, buy: 244500, buy_chg: -38100 },
    { code: "2593", sell: 100, sell_chg: -200, buy: 17500, buy_chg: 3000 },
    { code: "7203", sell: 310, sell_chg: 3, buy: 410, buy_chg: 4 },
  ],
};

const BUCKET = bucket({
  "margin/weeks.json": ["2026-09-04", "2026-09-11"],
  "margin/2026-09-04.json": COLLAPSED_WEEK,
  "margin/2026-09-11.json": NORMAL_WEEK,
});

describe("GET /api/margin (崩壊週の除外と正常週の保護)", () => {
  it("崩壊コードは崩壊週を除外して ambiguousWeeks に明示し、正常週は返す", async () => {
    const res = await app.request("/api/margin?code=2593", {}, { BUCKET } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code: string;
      weeks: Array<{ week: string; sell: number; buy: number }>;
      ambiguousWeeks: string[];
    };
    expect(body.code).toBe("2593");
    // 崩壊週 (09-04) の値は出さず、除外週として明示する
    expect(body.weeks.map((w) => w.week)).toEqual(["2026-09-11"]);
    expect(body.weeks[0]).toMatchObject({ week: "2026-09-11", sell: 100, buy: 200 });
    expect(body.ambiguousWeeks).toEqual(["2026-09-04"]);
  });

  it("同じ崩壊週でも正常な銘柄は全週返す (保護)", async () => {
    const res = await app.request("/api/margin?code=7203", {}, { BUCKET } as never);
    const body = (await res.json()) as {
      weeks: Array<{ week: string; sell: number }>;
      ambiguousWeeks: string[];
    };
    expect(body.weeks.map((w) => w.week)).toEqual(["2026-09-04", "2026-09-11"]);
    expect(body.weeks[0]).toMatchObject({ week: "2026-09-04", sell: 310 });
    expect(body.ambiguousWeeks).toEqual([]);
  });

  it("存在しない銘柄は空の週列 (従来どおり) + 空の除外週", async () => {
    const res = await app.request("/api/margin?code=9999", {}, { BUCKET } as never);
    const body = (await res.json()) as { weeks: unknown[]; ambiguousWeeks: unknown[] };
    expect(body.weeks).toEqual([]);
    expect(body.ambiguousWeeks).toEqual([]);
  });

  it("weeks.json が無ければ空 (従来どおり) + 空の除外週", async () => {
    const res = await app.request("/api/margin?code=2593", {}, { BUCKET: bucket({}) } as never);
    const body = (await res.json()) as { weeks: unknown[]; ambiguousWeeks: unknown[] };
    expect(body.weeks).toEqual([]);
    expect(body.ambiguousWeeks).toEqual([]);
  });

  it("n の範囲外・不正コードは 400 (従来どおり)", async () => {
    expect((await app.request("/api/margin?code=2593&n=999", {}, { BUCKET } as never)).status).toBe(400);
    expect((await app.request("/api/margin?code=259", {}, { BUCKET } as never)).status).toBe(400);
  });
});
