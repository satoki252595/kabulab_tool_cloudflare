/**
 * scripts/vwap/ingest-margin.ts のテスト。
 *
 * トップレベル実行は `process.argv[1] === fileURLToPath(import.meta.url)` で
 * ガードされているため (import だけでは main() が走らない)、このテストは
 * 安全にモジュールを import できる (scripts/moneyflow/ingest.ts と同方式)。
 * main() の順序テストは依存を vi.doMock で差し替える (同 ingest.test.ts 方式)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWeekArg } from "./ingest-margin.js";

describe("parseWeekArg", () => {
  it("--week 未指定なら undefined (最新週)", () => {
    expect(parseWeekArg([])).toBeUndefined();
    expect(parseWeekArg(["node", "ingest-margin.js"])).toBeUndefined();
  });

  it("--week=YYYYMMDD をそのまま返す", () => {
    expect(parseWeekArg(["--week=20260904"])).toBe("20260904");
  });

  it("形式が違えば throw する (推測でその場をしのがない)", () => {
    expect(() => parseWeekArg(["--week=2026-09-04"])).toThrow(/形式が不正/);
    expect(() => parseWeekArg(["--week=2026090"])).toThrow(/形式が不正/);
    expect(() => parseWeekArg(["--week="])).toThrow(/形式が不正/);
  });
});

describe("main (検証 → 原本保管 → R2 PUT の順序)", () => {
  const ORIGINAL_ARGV = [...process.argv];

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    vi.doUnmock("../../services/vwap-analysis/lib/margin.js");
    vi.doUnmock("../../src/shared/notion-archive/index.js");
    vi.doUnmock("./lib/r2.js");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function runMain(archiveImpl: () => Promise<unknown>) {
    vi.resetModules();
    process.argv = ["node", "ingest-margin.js"];
    const order: string[] = [];
    const data = {
      week: "2026-09-18",
      rows: [{ code: "7203", sell: 1, sell_chg: 0, buy: 2, buy_chg: 0 }],
      pdfBytes: new Uint8Array([1, 2, 3]),
      pdfUrl: "https://www.jpx.co.jp/x.pdf",
    };
    vi.doMock("../../services/vwap-analysis/lib/margin.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../services/vwap-analysis/lib/margin.js")>();
      return {
        ...actual,
        fetchMargin: vi.fn(async () => data),
        marginArchiveInput: vi.fn((d: unknown) => ({ key: "k", data: d }) as never),
      };
    });
    const recordPrimaryData = vi.fn(async () => {
      order.push("archive");
      return archiveImpl();
    });
    vi.doMock("../../src/shared/notion-archive/index.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/shared/notion-archive/index.js")>();
      return { ...actual, recordPrimaryData };
    });
    const r2Put = vi.fn(async (key: string) => {
      order.push(`r2:${key}`);
    });
    vi.doMock("./lib/r2.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./lib/r2.js")>();
      return { ...actual, r2Get: vi.fn(async () => JSON.stringify(["2026-09-11"])), r2Put };
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const mod = await import("./ingest-margin.js");
      await mod.main();
    } finally {
      info.mockRestore();
      err.mockRestore();
    }
    return { order, r2Put, recordPrimaryData };
  }

  it("原本保管が全 R2 PUT より先に行われる", async () => {
    const { order } = await runMain(async () => ({ pageId: "p1" }));
    expect(order).toEqual(["archive", "r2:margin/2026-09-18.json", "r2:margin/weeks.json"]);
  });

  it("保管に失敗したら R2 へ何も保存しない (部分保存なし)", async () => {
    vi.resetModules();
    process.argv = ["node", "ingest-margin.js"];
    const data = {
      week: "2026-09-18",
      rows: [{ code: "7203", sell: 1, sell_chg: 0, buy: 2, buy_chg: 0 }],
      pdfBytes: new Uint8Array([1, 2, 3]),
      pdfUrl: "https://www.jpx.co.jp/x.pdf",
    };
    vi.doMock("../../services/vwap-analysis/lib/margin.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../services/vwap-analysis/lib/margin.js")>();
      return {
        ...actual,
        fetchMargin: vi.fn(async () => data),
        marginArchiveInput: vi.fn((d: unknown) => ({ key: "k", data: d }) as never),
      };
    });
    vi.doMock("../../src/shared/notion-archive/index.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/shared/notion-archive/index.js")>();
      return {
        ...actual,
        recordPrimaryData: vi.fn(async () => {
          throw new Error("archive down");
        }),
      };
    });
    const r2Put = vi.fn();
    vi.doMock("./lib/r2.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./lib/r2.js")>();
      return { ...actual, r2Get: vi.fn(async () => null), r2Put };
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const mod = await import("./ingest-margin.js");
      await expect(mod.main()).rejects.toThrow(/archive down/);
    } finally {
      info.mockRestore();
      err.mockRestore();
    }
    expect(r2Put).not.toHaveBeenCalled();
  });
});
