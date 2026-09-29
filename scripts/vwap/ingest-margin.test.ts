/**
 * scripts/vwap/ingest-margin.ts (日次) のテスト。
 *
 * トップレベル実行は `process.argv[1] === fileURLToPath(import.meta.url)` で
 * ガードされているため (import だけでは main() が走らない)、このテストは
 * 安全にモジュールを import できる。main() の順序テストは依存を vi.doMock
 * で差し替える (scripts/moneyflow/ingest.ts と同方式)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeDailyMarginDates, parseDateArg } from "./ingest-margin.js";

describe("parseDateArg", () => {
  it("--date 未指定なら undefined (最新)", () => {
    expect(parseDateArg([])).toBeUndefined();
    expect(parseDateArg(["node", "ingest-margin.js"])).toBeUndefined();
  });

  it("--date=YYYYMMDD をそのまま返す", () => {
    expect(parseDateArg(["--date=20260928"])).toBe("20260928");
  });

  it("形式が違えば throw する (推測でその場をしのがない)", () => {
    expect(() => parseDateArg(["--date=2026-09-28"])).toThrow(/形式が不正/);
    expect(() => parseDateArg(["--date=2026092"])).toThrow(/形式が不正/);
    expect(() => parseDateArg(["--date="])).toThrow(/形式が不正/);
  });
});

describe("mergeDailyMarginDates", () => {
  it("今回分を追加してソート・一意化する", () => {
    expect(mergeDailyMarginDates(["2026-09-25", "2026-09-28"], "2026-09-26")).toEqual([
      "2026-09-25",
      "2026-09-26",
      "2026-09-28",
    ]);
    expect(mergeDailyMarginDates(["2026-09-28"], "2026-09-28")).toEqual(["2026-09-28"]);
    expect(mergeDailyMarginDates([], "2026-09-28")).toEqual(["2026-09-28"]);
  });

  it("形式不正の日付が混ざっていたら throw する", () => {
    expect(() => mergeDailyMarginDates(["2026/09/25"], "2026-09-28")).toThrow(/形式が不正/);
    expect(() => mergeDailyMarginDates([], "20260928")).toThrow(/形式が不正/);
  });
});

describe("main (検証 → 原本保管 → R2 PUT の順序)", () => {
  const ORIGINAL_ARGV = [...process.argv];

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    vi.doUnmock("../../services/vwap-analysis/lib/margin.js");
    vi.doUnmock("../../services/vwap-analysis/lib/margin-daily.js");
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
      snapshot: {
        format: "jpx-margin-daily-v1",
        basisDate: "2026-09-28",
        publicationDate: "2026-09-29",
        sourceUrl: "https://www.jpx.co.jp/x.pdf",
        rawSha256: "0".repeat(64),
        rawPageId: null,
        rows: [],
        totals: [],
      },
      pdfBytes: new Uint8Array([1, 2, 3]),
      pdfUrl: "https://www.jpx.co.jp/x.pdf",
    };
    vi.doMock("../../services/vwap-analysis/lib/margin.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../services/vwap-analysis/lib/margin.js")>();
      return {
        ...actual,
        fetchDailyMargin: vi.fn(async () => data),
        dailyMarginArchiveInput: vi.fn((d: unknown) => ({ key: "k", data: d }) as never),
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
      return { ...actual, r2Get: vi.fn(async () => JSON.stringify(["2026-09-25"])), r2Put };
    });
    // 検証は純粋パーサのテストで担保済み。ここでは順序だけ見る。
    vi.doMock("../../services/vwap-analysis/lib/margin-daily.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../services/vwap-analysis/lib/margin-daily.js")>();
      return { ...actual, validateDailyMarginSnapshot: vi.fn() };
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
    expect(order).toEqual(["archive", "r2:margin/daily/2026-09-28.json", "r2:margin/dates.json"]);
  });

  it("保管に失敗したら R2 へ何も保存しない (部分保存なし)", async () => {
    vi.resetModules();
    process.argv = ["node", "ingest-margin.js"];
    const data = {
      snapshot: {
        format: "jpx-margin-daily-v1",
        basisDate: "2026-09-28",
        publicationDate: "2026-09-29",
        sourceUrl: "https://www.jpx.co.jp/x.pdf",
        rawSha256: "0".repeat(64),
        rawPageId: null,
        rows: [],
        totals: [],
      },
      pdfBytes: new Uint8Array([1, 2, 3]),
      pdfUrl: "https://www.jpx.co.jp/x.pdf",
    };
    vi.doMock("../../services/vwap-analysis/lib/margin.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../services/vwap-analysis/lib/margin.js")>();
      return {
        ...actual,
        fetchDailyMargin: vi.fn(async () => data),
        dailyMarginArchiveInput: vi.fn((d: unknown) => ({ key: "k", data: d }) as never),
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
    vi.doMock("../../services/vwap-analysis/lib/margin-daily.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../services/vwap-analysis/lib/margin-daily.js")>();
      return { ...actual, validateDailyMarginSnapshot: vi.fn() };
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
