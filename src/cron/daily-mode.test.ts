import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { runDailySync, runMarketContextSync } from "./daily.js";
import type { OverlayCollectFn } from "./universe-overlay.js";
import { fakeOverlayCollect } from "./tests/overlay-batch.js";

const fakeCollect: OverlayCollectFn = fakeOverlayCollect;

import { fetchChart, fetchStockRawData } from "../shared/yahoo/client.js";
import { fetchNikkeiVi } from "../shared/yahoo/nikkei-vi.js";
import { ensurePriceSyncDb, recordPriceSyncLog } from "../shared/notion-archive/index.js";
import * as coreSchema from "../shared/db/core-schema.js";
import * as rsiSchema from "../../services/rsi-screening/src/db/schema.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import * as projectionSchema from "../shared/db/projection-schema.js";

vi.mock("../shared/yahoo/client.js", async (original) => ({
  ...await original<typeof import("../shared/yahoo/client.js")>(),
  fetchChart: vi.fn(), fetchStockRawData: vi.fn(),
}));
vi.mock("../shared/yahoo/nikkei-vi.js", () => ({ fetchNikkeiVi: vi.fn() }));
vi.mock("../shared/notion-archive/index.js", async (original) => ({
  ...await original<typeof import("../shared/notion-archive/index.js")>(),
  ensurePriceSyncDb: vi.fn(), recordPriceSyncLog: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-28T17:13:00Z"));
  vi.mocked(ensurePriceSyncDb).mockResolvedValue({ dbId: "test-db" });
});
afterEach(() => vi.useRealTimers());

function recordingDb() {
  const calls: string[] = [];
  const db = drizzle(async (sql) => { calls.push(sql); return { rows: [] }; }, {
    schema: { ...coreSchema, ...rsiSchema, ...swingSchema, ...projectionSchema },
  });
  return { calls, db: db as Parameters<typeof runMarketContextSync>[0] };
}
function chart(date: string | undefined) {
  return { symbol: "^N225", price: 100, previousClose: 99, dataDate: "2026-09-28",
    ohlcv: date === undefined ? [] : [{ date, open: 99, high: 100, low: 99,
      close: 100, volume: null, adj: 100 }] };
}

describe("株式とマクロの日次分離", () => {
  it.each(["2026-09-25", undefined])("実日足が対象日でなければD1を書かない (%s)", async (date) => {
    // dataDateが今日でも、実timestampの日足が無ければ祝日/障害を成功にしない。
    vi.mocked(fetchChart).mockResolvedValue(chart(date));
    const { db, calls } = recordingDb();
    await expect(runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect })).rejects.toThrow("日足を確認できません");
    expect(calls).toEqual([]);
    expect(fetchStockRawData).not.toHaveBeenCalled();
    expect(recordPriceSyncLog).toHaveBeenCalledWith("test-db", expect.objectContaining({
      status: "失敗", tradingDate: null,
    }));
  });

  it("実日足の日付が対象日でも実終値がなければD1を書かない (fresh null bar)", async () => {
    // 日付だけの gate では対象日の fresh null bar が通過し、古い終値で計算した
    // 指標を対象日付で保存してしまう (F-01)。checkFreshClose で実終値も要求する。
    vi.mocked(fetchChart).mockResolvedValue({
      symbol: "^N225", price: 100, previousClose: 99, dataDate: "2026-09-28",
      ohlcv: [{ date: "2026-09-28", open: null, high: null, low: null,
        close: null, volume: null, adj: null }],
    });
    const { db, calls } = recordingDb();
    await expect(runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect })).rejects.toThrow("日足を確認できません");
    expect(calls).toEqual([]);
    expect(fetchStockRawData).not.toHaveBeenCalled();
    expect(recordPriceSyncLog).toHaveBeenCalledWith("test-db", expect.objectContaining({
      status: "失敗", tradingDate: null,
    }));
  });

  it("NY取引中にマクロを朝の値へ書き直さない", async () => {
    const { db, calls } = recordingDb();
    await expect(runMarketContextSync(db)).rejects.toThrow("取引中");
    expect(calls).toEqual([]);
    expect(fetchChart).not.toHaveBeenCalled();
  });

  it("従来時刻のマクロ専用実行で全銘柄や株価完了記録に触れない", async () => {
    vi.setSystemTime(new Date("2026-09-28T21:00:00Z"));
    vi.mocked(fetchChart).mockResolvedValue(chart("2026-09-28"));
    vi.mocked(fetchNikkeiVi).mockResolvedValue({ price: 20, previousClose: 19,
      change: 1, changePct: 100 / 19, date: "2026-09-28", latestTimestamp: null });
    const { db, calls } = recordingDb();
    expect(await runMarketContextSync(db)).toBe(true);
    expect(fetchChart).toHaveBeenCalledTimes(4);
    expect(fetchStockRawData).not.toHaveBeenCalled();
    expect(recordPriceSyncLog).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('insert into "swing_market_context"');
  });

  it("N225 の実バー日が run 日と違えば書かず前回値を残す (F-06)", async () => {
    // 休場日 (N225 は金曜バー) の run は、米指数が新しくても書かない。
    // 異なる取引日の脚を混ぜた行キーで残さない。曜日もカレンダーも見ない。
    vi.setSystemTime(new Date("2026-09-28T21:00:00Z"));
    vi.mocked(fetchChart).mockImplementation(async (symbol: string) =>
      symbol === "^N225" ? chart("2026-09-25") : chart("2026-09-28")
    );
    vi.mocked(fetchNikkeiVi).mockResolvedValue({ price: 20, previousClose: 19,
      change: 1, changePct: 100 / 19, date: "2026-09-28", latestTimestamp: null });
    const { db, calls } = recordingDb();
    expect(await runMarketContextSync(db)).toBe(false);
    expect(calls).toEqual([]);
  });
});
