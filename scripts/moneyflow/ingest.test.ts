/**
 * scripts/moneyflow/ingest.ts の純関数と DRY_RUN 契約のテスト。
 *
 * トップレベル実行は `process.argv[1] === fileURLToPath(import.meta.url)` で
 * ガードされているため (import だけでは main() が走らない)、このテストは
 * 安全にモジュールを import できる。DRY_RUN/ONLY はモジュール読込時に
 * `process.argv` から一度だけ計算される設計のため、既定値と異なる argv で
 * 検証したいテストは `vi.resetModules()` + 動的 import で argv を差し替える
 * (src/shared/notion-archive/moneyflow.test.ts の env 差し替えパターンと同じ)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SOURCES, classifyRunStatus, parseAsOfArg, parseOnlyArg, sectorMarketCapSkipDetail, sectorTurnoverRange, verifySectorTurnoverResult } from "./ingest.js";

describe("parseOnlyArg", () => {
  it("--only 未指定なら全取得元を返す", () => {
    expect(parseOnlyArg([], SOURCES)).toEqual([...SOURCES]);
  });

  it("--only=a,b を指定した取得元だけの配列に解析する", () => {
    expect(parseOnlyArg(["node", "ingest.js", "--only=jpx-sector-marketcap,sector-turnover"], SOURCES)).toEqual([
      "jpx-sector-marketcap",
      "sector-turnover",
    ]);
  });

  it("使えない取得元名を指定すると throw する (推測でその場をしのがない)", () => {
    expect(() => parseOnlyArg(["--only=not-a-real-source"], SOURCES)).toThrow(/不明な取得元です: not-a-real-source/);
  });
});

describe("classifyRunStatus", () => {
  it("失敗0件なら「完了」", () => {
    expect(classifyRunStatus(3, 0)).toBe("完了");
  });

  it("成功と失敗が混在すれば「一部失敗」", () => {
    expect(classifyRunStatus(2, 1)).toBe("一部失敗");
  });

  it("成功0件・失敗のみなら「失敗」", () => {
    expect(classifyRunStatus(0, 3)).toBe("失敗");
  });
});

describe("parseAsOfArg", () => {
  it("--as-of 未指定なら null", () => {
    expect(parseAsOfArg([])).toBeNull();
    expect(parseAsOfArg(["node", "ingest.js", "--dry-run"])).toBeNull();
  });

  it("--as-of=YYYY-MM-DD をそのまま返す", () => {
    expect(parseAsOfArg(["--as-of=2026-09-28"])).toBe("2026-09-28");
  });

  it("形式違い・実在しない日付は throw する", () => {
    expect(() => parseAsOfArg(["--as-of=2026-9-28"])).toThrow(/YYYY-MM-DD/);
    expect(() => parseAsOfArg(["--as-of=2026-13-01"])).toThrow(/実在しない日付/);
    expect(() => parseAsOfArg(["--as-of=2026-02-30"])).toThrow(/実在しない日付/);
  });
});

describe("sectorTurnoverRange", () => {
  it("as-of 週の月曜〜as-of・ISO 週ラベルを返す", () => {
    // 2026-09-28 は月曜。to=as-of・from=同日・period=W40。
    expect(sectorTurnoverRange("2026-09-28")).toEqual({ from: "2026-09-28", to: "2026-09-28", period: "2026-W40" });
    // 2026-09-30 は水曜。from=週の月曜。
    expect(sectorTurnoverRange("2026-09-30")).toEqual({ from: "2026-09-28", to: "2026-09-30", period: "2026-W40" });
  });
});

describe("verifySectorTurnoverResult", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    sector: "電気機器",
    turnover: 100,
    turnoverShare: 0.5,
    upTurnover: 60,
    downTurnover: 40,
    stockCount: 10,
    ...overrides,
  });

  it("正常な結果は行を返す", () => {
    const out = verifySectorTurnoverResult(
      { from: "2026-09-28", to: "2026-09-28" },
      { from: "2026-09-28", to: "2026-09-28", sectors: [row()] }
    );
    expect(out).toHaveLength(1);
    expect(out[0].turnoverShare).toBe(0.5);
  });

  it("範囲 echo 不一致・空・share 未定義は throw する", () => {
    expect(() =>
      verifySectorTurnoverResult({ from: "2026-09-28", to: "2026-09-28" }, { from: "2026-09-28", to: "2026-09-29", sectors: [row()] })
    ).toThrow(/応答範囲が不一致/);
    expect(() =>
      verifySectorTurnoverResult({ from: "2026-09-28", to: "2026-09-28" }, { from: "2026-09-28", to: "2026-09-28", sectors: [] })
    ).toThrow(/売買代金合計が 0/);
    expect(() =>
      verifySectorTurnoverResult(
        { from: "2026-09-28", to: "2026-09-28" },
        { from: "2026-09-28", to: "2026-09-28", sectors: [row({ turnoverShare: null })] }
      )
    ).toThrow(/売買代金合計が 0/);
  });

  it("日足なし・売買代金 0 の業種は部分週として throw する", () => {
    expect(() =>
      verifySectorTurnoverResult(
        { from: "2026-09-28", to: "2026-09-28" },
        { from: "2026-09-28", to: "2026-09-28", sectors: [row({ stockCount: 0 })] }
      )
    ).toThrow(/日足がありません/);
    expect(() =>
      verifySectorTurnoverResult(
        { from: "2026-09-28", to: "2026-09-28" },
        { from: "2026-09-28", to: "2026-09-28", sectors: [row({ turnover: 0 })] }
      )
    ).toThrow(/売買代金が 0/);
  });
});

describe("sectorMarketCapSkipDetail", () => {
  it("月次未更新でPDF再取得をスキップした旨と対象期間を含む", () => {
    const detail = sectorMarketCapSkipDetail("2026-08");
    expect(detail).toContain("2026-08");
    expect(detail).toMatch(/PDF再取得なし/);
  });
});

describe("main() の --dry-run 契約", () => {
  const ORIGINAL_ARGV = [...process.argv];

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    process.exitCode = undefined;
    vi.doUnmock("../../services/moneyflow/lib/jpx-sector-marketcap.js");
    vi.doUnmock("../../src/shared/notion-archive/index.js");
    vi.resetModules();
  });

  it("--dry-run では Notion 書込系関数を一切呼ばない (JPX からの取得・解析はするが永続化しない)", async () => {
    // ファイル先頭の静的 import で ingest.js は DRY_RUN=false のまま評価・キャッシュ
    // 済み。ここでキャッシュを捨てないと動的 import が同じインスタンスを返し、
    // argv 差し替えも doMock も効かない (dry-run なのに Notion を叩きに行く)。
    vi.resetModules();
    process.argv = [...ORIGINAL_ARGV, "--dry-run", "--only=jpx-sector-marketcap"];

    const fixture = {
      asOfDate: "2026-08-31",
      sectors: [{ sector: "電気機器", companies: 1, marketCapMillionYen: 100 }],
      segments: {
        prime: { companies: 1, marketCapMillionYen: 100 },
        standard: { companies: 0, marketCapMillionYen: 0 },
        growth: { companies: 0, marketCapMillionYen: 0 },
        tokyoProMarket: { companies: 0, marketCapMillionYen: 0 },
        total: { companies: 1, marketCapMillionYen: 100 },
      },
      pdfBytes: new Uint8Array(),
      pdfUrl: "https://www.jpx.co.jp/markets/statistics-equities/misc/202608.pdf",
    };
    vi.doMock("../../services/moneyflow/lib/jpx-sector-marketcap.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../services/moneyflow/lib/jpx-sector-marketcap.js")>();
      return { ...actual, fetchSectorMarketCap: vi.fn().mockResolvedValue(fixture) };
    });

    const spies: Record<string, ReturnType<typeof vi.fn>> = {};
    vi.doMock("../../src/shared/notion-archive/index.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../src/shared/notion-archive/index.js")>();
      for (const name of [
        "recordPrimaryData",
        "ensureObservationsDb",
        "upsertObservation",
        "ensureIndicatorDefsDb",
        "upsertIndicatorDef",
        "ensureRunLogDb",
        "recordRunLog",
        "isArchived",
      ] as const) {
        spies[name] = vi.fn((actual as Record<string, unknown>)[name] as (...args: unknown[]) => unknown);
      }
      return { ...actual, ...spies };
    });

    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const mod = await import("./ingest.js");
    await mod.main();
    consoleInfo.mockRestore();

    for (const name of Object.keys(spies)) {
      expect(spies[name], `${name} が呼ばれていないこと`).not.toHaveBeenCalled();
    }
  });

  it("指標カタログの同期に失敗したら取込ログへ「失敗」を記録して exit 1 (無痕跡にしない)", async () => {
    vi.resetModules();
    process.argv = [...ORIGINAL_ARGV, "--only=jpx-sector-marketcap"];

    const fetchSectorMarketCap = vi.fn();
    vi.doMock("../../services/moneyflow/lib/jpx-sector-marketcap.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../services/moneyflow/lib/jpx-sector-marketcap.js")>();
      return { ...actual, fetchSectorMarketCap };
    });

    const recordRunLog = vi.fn().mockResolvedValue({ pageId: "runlog-1" });
    const upsertIndicatorDef = vi.fn();
    vi.doMock("../../src/shared/notion-archive/index.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../src/shared/notion-archive/index.js")>();
      return {
        ...actual,
        ensureIndicatorDefsDb: vi.fn().mockRejectedValue(new Error("DB down")),
        upsertIndicatorDef,
        ensureRunLogDb: vi.fn().mockResolvedValue({ dbId: "runlog-db" }),
        recordRunLog,
      };
    });

    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mod = await import("./ingest.js");
    await mod.main();
    consoleInfo.mockRestore();
    consoleError.mockRestore();

    expect(fetchSectorMarketCap).not.toHaveBeenCalled();
    expect(upsertIndicatorDef).not.toHaveBeenCalled();
    expect(recordRunLog).toHaveBeenCalledTimes(1);
    expect(recordRunLog.mock.calls[0]![1]).toMatchObject({
      status: "失敗",
      sources: "jpx-sector-marketcap",
      successCount: 0,
      failedCount: 1,
    });
    expect(String(recordRunLog.mock.calls[0]![1].reason)).toContain("indicator-catalog");
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});
