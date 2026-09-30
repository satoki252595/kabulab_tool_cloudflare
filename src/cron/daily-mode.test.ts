import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { runDailySync, runMarketContextSync } from "./daily.js";
import {
  fetchChart,
  fetchStockRawData,
  parseChartResponse,
  type ChartResult,
  type FetchChartOptions,
} from "../shared/yahoo/client.js";
import {
  fetchNikkeiVi,
  type FetchNikkeiViOptions,
} from "../shared/yahoo/nikkei-vi.js";
import { guardChartBars } from "../shared/yahoo/bar-sanity.js";
import {
  ensurePriceSyncDb,
  recordPriceSyncLog,
  recordPrimaryData,
  verifyArchivedAttachments,
  type RecordPrimaryDataInput,
} from "../shared/notion-archive/index.js";
import { selectConfirmedCloses } from "./macro-session.js";
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
  recordPrimaryData: vi.fn(), verifyArchivedAttachments: vi.fn(),
}));

const FX = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__/macro-canonical"
);
const fxBytes = (name: string): Uint8Array => readFileSync(join(FX, name));

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-28T17:13:00Z"));
  vi.mocked(ensurePriceSyncDb).mockResolvedValue({ dbId: "test-db" });
  vi.mocked(recordPrimaryData).mockResolvedValue({
    pageId: "test-page",
    outcome: "recorded",
    fileTooLarge: false,
    manifestMatch: "written",
  });
  vi.mocked(verifyArchivedAttachments).mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

function recordingDb() {
  const calls: string[] = [];
  const params: unknown[][] = [];
  const db = drizzle(
    async (sql, p) => {
      calls.push(sql);
      params.push([...p]);
      return { rows: [] };
    },
    {
      schema: { ...coreSchema, ...rsiSchema, ...swingSchema, ...projectionSchema },
    }
  );
  return { calls, params, db: db as Parameters<typeof runMarketContextSync>[0] };
}
function chart(date: string | undefined) {
  return { symbol: "^N225", price: 100, previousClose: 99, dataDate: "2026-09-28",
    ohlcv: date === undefined ? [] : [{ date, open: 99, high: 100, low: 99,
      close: 100, volume: null, adj: 100 }] };
}

/** fixture 原文から本番相当の ChartResult を組む (共有 parse+guard)。 */
function chartFromFixture(symbol: string, file: string): ChartResult {
  const raw = fxBytes(file);
  const json = JSON.parse(new TextDecoder().decode(raw));
  const parsed = parseChartResponse(json, symbol);
  const { bars } = guardChartBars(
    parsed.bars,
    parsed.meta.regularMarketPrice,
    symbol
  );
  const closes = parsed.closePrices.filter((p): p is number => p !== null);
  return {
    symbol,
    price: parsed.meta.regularMarketPrice ?? closes.at(-1) ?? null,
    previousClose: parsed.meta.previousClose ?? null,
    dataDate: bars.at(-1)?.date ?? "",
    ohlcv: [...bars],
  };
}

function mockMacro(
  files: Record<string, string>,
  opts?: { viDate?: string; noRaw?: string[]; noRawVI?: boolean }
) {
  vi.mocked(fetchChart).mockImplementation(
    async (symbol: string, _range?: string, options?: FetchChartOptions) => {
      const f = files[symbol];
      if (!f) throw new Error(`テスト: 未定義 symbol ${symbol}`);
      if (!opts?.noRaw?.includes(symbol)) {
        await options?.onRaw?.({ symbol, status: 200, bytes: fxBytes(f) });
      }
      return chartFromFixture(symbol, f);
    }
  );
  vi.mocked(fetchNikkeiVi).mockImplementation(
    async (options?: FetchNikkeiViOptions) => {
      if (!opts?.noRawVI) {
        await options?.onRaw?.({ status: 200, bytes: fxBytes("vi-symbolic.html") });
      }
      return {
        price: 20, previousClose: 19, change: 1, changePct: 100 / 19,
        date: opts?.viDate ?? "2026-09-29",
        latestTimestamp: "2026-09-29T15:00:00+09:00",
      };
    }
  );
}

const ALIGNED: Record<string, string> = {
  "^N225": "n225-20260930.json",
  "^GSPC": "gspc-20260930.json",
  "^VIX": "vix-20260930.json",
  "NIY=F": "niy-20260930.json",
};

function macroArchiveInputs(): RecordPrimaryDataInput[] {
  return vi
    .mocked(recordPrimaryData)
    .mock.calls.map(([input]) => input)
    .filter((input) => input.key.startsWith("macro-source-batch-"));
}

function manifestOf(input: RecordPrimaryDataInput): {
  gate: { ok: boolean; key: string | null; reason: string };
  draft: {
    charts: Record<string, { price: number | null; prevClose: number | null; date: string | null }>;
    nikkeiVi: number | null;
    nikkeiViDate: string | null;
  };
  attempts: Array<{
    target: string; attempt: number; requestedAt: string; completedAt: string;
    status: number | null; byteLength: number | null; sha256: string | null;
    filename: string | null; noBodyReason: string | null;
  }>;
} {
  const m = input.files?.find((f) => f.filename === "macro-manifest.json");
  if (!m) throw new Error("テスト: macro-manifest.json が無い");
  return JSON.parse(new TextDecoder().decode(m.bytes));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe("株式とマクロの日次分離", () => {
  it.each(["2026-09-25", undefined])("実日足が対象日でなければD1を書かない (%s)", async (date) => {
    // dataDateが今日でも、実timestampの日足が無ければ祝日/障害を成功にしない。
    vi.mocked(fetchChart).mockResolvedValue(chart(date));
    const { db, calls } = recordingDb();
    await expect(runDailySync(db, { stocksOnly: true })).rejects.toThrow("日足を確認できません");
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
    await expect(runDailySync(db, { stocksOnly: true })).rejects.toThrow("日足を確認できません");
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

  it("確定日一致のマクロ専用実行でGSPCキー行を書き原本6点を保管する", async () => {
    // 01:55Z 捕捉相当 (NY 引け後)。N225 の 9/30 形成中バーは除外され、
    // GSPC/N225/VIX 確定 9/29 + VI 9/29 でキー 9/29 の行を書く。
    // 保管 payload は取得原文と一致する (source=generation)。
    vi.setSystemTime(new Date("2026-09-30T01:55:26Z"));
    mockMacro(ALIGNED);
    const { db, calls, params } = recordingDb();
    expect(await runMarketContextSync(db)).toBe(true);
    expect(fetchChart).toHaveBeenCalledTimes(4);
    expect(fetchStockRawData).not.toHaveBeenCalled();
    expect(recordPriceSyncLog).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('insert into "swing_market_context"');
    expect(params[0][0]).toBe("2026-09-29");

    const archived = macroArchiveInputs();
    expect(archived).toHaveLength(1);
    const files = archived[0].files ?? [];
    expect(files.map((f) => f.filename).sort()).toEqual([
      "macro-GSPC-attempt0.json",
      "macro-N225-attempt0.json",
      "macro-NIY-attempt0.json",
      "macro-VI-attempt0.html",
      "macro-VIX-attempt0.json",
      "macro-manifest.json",
    ]);
    // source=generation: 保管 bytes は取得原文と一致。
    const byName = new Map(files.map((f) => [f.filename, f.bytes]));
    expect(bytesEqual(byName.get("macro-N225-attempt0.json")!, fxBytes("n225-20260930.json"))).toBe(true);
    expect(bytesEqual(byName.get("macro-GSPC-attempt0.json")!, fxBytes("gspc-20260930.json"))).toBe(true);
    expect(bytesEqual(byName.get("macro-VIX-attempt0.json")!, fxBytes("vix-20260930.json"))).toBe(true);
    expect(bytesEqual(byName.get("macro-NIY-attempt0.json")!, fxBytes("niy-20260930.json"))).toBe(true);
    expect(bytesEqual(byName.get("macro-VI-attempt0.html")!, fxBytes("vi-symbolic.html"))).toBe(true);
    const manifest = manifestOf(archived[0]);
    expect(manifest.gate).toEqual({ ok: true, key: "2026-09-29", reason: "確定日・必須値が一致" });
    expect(manifest.attempts).toHaveLength(5);
    for (const a of manifest.attempts) {
      expect(a.attempt).toBe(0);
      expect(typeof a.requestedAt).toBe("string");
      expect(typeof a.completedAt).toBe("string");
      expect(a.status).toBe(200);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.noBodyReason).toBeNull();
    }
    // draft mapping: N225 は helper の確定値、NIY は snapshot。
    const n225 = selectConfirmedCloses(
      fxBytes("n225-20260930.json"),
      chartFromFixture("^N225", "n225-20260930.json").ohlcv,
      "^N225"
    );
    expect(manifest.draft.charts["^N225"]).toEqual({
      price: n225.value, prevClose: n225.prev, date: "2026-09-29",
    });
    const niyJson = JSON.parse(new TextDecoder().decode(fxBytes("niy-20260930.json")));
    expect(manifest.draft.charts["NIY=F"].price).toBe(
      niyJson.chart.result[0].meta.regularMarketPrice
    );
    expect(manifest.draft.nikkeiViDate).toBe("2026-09-29");
    expect(verifyArchivedAttachments).toHaveBeenCalledTimes(1);
    expect(verifyArchivedAttachments).toHaveBeenCalledWith(
      "test-page", expect.arrayContaining([]), "マクロ一次原本"
    );
  });

  it("N225 の確定日が GSPC キーと違えば書かず前回値を残す (F-06)", async () => {
    // 異なる取引日の脚を混ぜた行キーで残さない。HOLD でも実取得の
    // 原本は保管する。曜日もカレンダーも見ない。
    vi.setSystemTime(new Date("2026-09-30T01:55:26Z"));
    mockMacro({ ...ALIGNED, "^N225": "n225-friday-stale.symbolic.json" });
    const { db, calls } = recordingDb();
    expect(await runMarketContextSync(db)).toBe(false);
    expect(calls).toEqual([]);
    const archived = macroArchiveInputs();
    expect(archived).toHaveLength(1);
    expect(manifestOf(archived[0]).gate.ok).toBe(false);
    expect(manifestOf(archived[0]).gate.reason).toMatch(/N225 確定日 2026-09-25 ≠ GSPC 2026-09-29/);
  });

  it("VI 日付が GSPC キーと違えば書かない (VI 異日付 HOLD)", async () => {
    // VI 9/30 live と確定 N225 9/29 を黙って混ぜない。実取得の原本は保管。
    vi.setSystemTime(new Date("2026-09-30T01:55:26Z"));
    mockMacro(ALIGNED, { viDate: "2026-09-30" });
    const { db, calls } = recordingDb();
    expect(await runMarketContextSync(db)).toBe(false);
    expect(calls).toEqual([]);
    const archived = macroArchiveInputs();
    expect(archived).toHaveLength(1);
    expect(manifestOf(archived[0]).gate.reason).toMatch(/VI 日付 2026-09-30 ≠ GSPC 2026-09-29/);
  });

  it("VIX の確定日が GSPC キーと違えば書かない", async () => {
    vi.setSystemTime(new Date("2026-09-30T01:55:26Z"));
    mockMacro({ ...ALIGNED, "^VIX": "vix-friday-stale.symbolic.json" });
    const { db, calls } = recordingDb();
    expect(await runMarketContextSync(db)).toBe(false);
    expect(calls).toEqual([]);
    expect(macroArchiveInputs()).toHaveLength(1);
  });

  it("原文 capture が無ければ確定日を決められず HOLD する (meta HOLD)", async () => {
    vi.setSystemTime(new Date("2026-09-30T01:55:26Z"));
    mockMacro(ALIGNED, { noRaw: ["^GSPC"] });
    const { db, calls } = recordingDb();
    expect(await runMarketContextSync(db)).toBe(false);
    expect(calls).toEqual([]);
    const archived = macroArchiveInputs();
    expect(archived).toHaveLength(1);
    const manifest = manifestOf(archived[0]);
    expect(manifest.gate.reason).toMatch(/GSPC 確定日が無い/);
    const gspc = manifest.attempts.find((a) => a.target === "^GSPC");
    expect(gspc?.filename).toBeNull();
    expect(gspc?.noBodyReason).toMatch(/onRaw 未発火/);
  });

  it("NIY 原文 capture なしは snapshot を採用せず HOLD する", async () => {
    // 原本必須は NIY snapshot も例外にしない。回収要求は出さず
    // (fetch 失敗ではない)、実取得の原本は保管する。
    vi.setSystemTime(new Date("2026-09-30T01:55:26Z"));
    mockMacro(ALIGNED, { noRaw: ["NIY=F"] });
    const { db, calls } = recordingDb();
    expect(await runMarketContextSync(db)).toBe(false);
    expect(calls).toEqual([]);
    expect(fetchChart).toHaveBeenCalledTimes(4);
    const archived = macroArchiveInputs();
    expect(archived).toHaveLength(1);
    const manifest = manifestOf(archived[0]);
    expect(manifest.gate.reason).toMatch(/NIY snapshotが無い/);
    const niy = manifest.attempts.find((a) => a.target === "NIY=F");
    expect(niy?.filename).toBeNull();
    expect(niy?.noBodyReason).toMatch(/onRaw 未発火/);
    expect(manifest.draft.charts["NIY=F"].price).toBeNull();
  });

  it("VI 原文 capture なしは採用せず HOLD する", async () => {
    vi.setSystemTime(new Date("2026-09-30T01:55:26Z"));
    mockMacro(ALIGNED, { noRawVI: true });
    const { db, calls } = recordingDb();
    expect(await runMarketContextSync(db)).toBe(false);
    expect(calls).toEqual([]);
    const archived = macroArchiveInputs();
    expect(archived).toHaveLength(1);
    const manifest = manifestOf(archived[0]);
    expect(manifest.gate.reason).toMatch(/VI 日付が無い/);
    expect(manifest.draft.nikkeiVi).toBeNull();
    expect(manifest.draft.nikkeiViDate).toBeNull();
  });

  it("GSPC 確定バー close null は HOLD する (partial 除外)", async () => {
    vi.setSystemTime(new Date("2026-09-30T01:55:26Z"));
    mockMacro({ ...ALIGNED, "^GSPC": "gspc-nullclose.symbolic.json" });
    const { db, calls } = recordingDb();
    expect(await runMarketContextSync(db)).toBe(false);
    expect(calls).toEqual([]);
    expect(macroArchiveInputs()).toHaveLength(1);
  });

  it("旧 N225 (9/28 候補 null) は HOLD し 9/25 に戻さない", async () => {
    vi.setSystemTime(new Date("2026-09-30T01:55:26Z"));
    mockMacro({ ...ALIGNED, "^N225": "n225-20260929.json" });
    const { db, calls } = recordingDb();
    expect(await runMarketContextSync(db)).toBe(false);
    expect(calls).toEqual([]);
    const archived = macroArchiveInputs();
    expect(archived).toHaveLength(1);
    const manifest = manifestOf(archived[0]);
    expect(manifest.draft.charts["^N225"].date).toBeNull();
    expect(manifest.gate.reason).toMatch(/N225 確定日が無い/);
  });

  it("09:10 境界の symbolic N225 は直前実バー 9/29 で確定する", async () => {
    // 09:10 JST (NY 引け後)。session 形成中の 9/30 バーを除外し、
    // 「昨日決め打ち」ではなく直前実バーで確定する。
    vi.setSystemTime(new Date("2026-09-30T00:10:00Z"));
    mockMacro({ ...ALIGNED, "^N225": "n225-0910-forming.symbolic.json" });
    const { db, calls, params } = recordingDb();
    expect(await runMarketContextSync(db)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(params[0][0]).toBe("2026-09-29");
  });

  it("保管失敗は throw し D1 マクロを書かない (context-only caller)", async () => {
    vi.setSystemTime(new Date("2026-09-30T01:55:26Z"));
    mockMacro(ALIGNED);
    vi.mocked(recordPrimaryData).mockRejectedValueOnce(new Error("notion down"));
    const { db, calls } = recordingDb();
    await expect(runMarketContextSync(db)).rejects.toThrow("notion down");
    expect(calls).toEqual([]);
    expect(verifyArchivedAttachments).not.toHaveBeenCalled();
  });

  it("保管失敗は throw し D1 マクロを書かない (daily caller)", async () => {
    vi.setSystemTime(new Date("2026-09-30T01:55:26Z"));
    mockMacro(ALIGNED);
    vi.mocked(recordPrimaryData).mockRejectedValue(new Error("notion down"));
    const { db, calls } = recordingDb();
    await expect(runDailySync(db, {})).rejects.toThrow("notion down");
    expect(calls.filter((sql) => sql.includes("swing_market_context"))).toEqual([]);
  });
});
