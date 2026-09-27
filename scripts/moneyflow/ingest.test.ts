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
import { SOURCES, classifyRunStatus, parseOnlyArg, sectorMarketCapSkipDetail } from "./ingest.js";

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
});
