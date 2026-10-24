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
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("独立更新は価格依存のsector-turnoverだけを除き、全取得元を重複なく分割する", () => {
    const independent = parseOnlyArg(["--only=independent"], SOURCES);
    expect(independent).toHaveLength(28);
    expect(independent).not.toContain("sector-turnover");
    expect([...independent, "sector-turnover"].sort()).toEqual([...SOURCES].sort());
    expect(() => parseOnlyArg(["--only=independent,sector-turnover"], SOURCES)).toThrow(/不明な取得元/);
  });

  it("使えない取得元名を指定すると throw する (推測でその場をしのがない)", () => {
    expect(() => parseOnlyArg(["--only=not-a-real-source"], SOURCES)).toThrow(/不明な取得元です: not-a-real-source/);
  });
  it("重複指定・重複sourceを取得前に拒否する", () => {
    expect(() => parseOnlyArg(["--only=global-indices,global-indices"], SOURCES)).toThrow("重複");
    expect(() => parseOnlyArg(["--only=global-indices", "--only=coingecko-global"], SOURCES)).toThrow("重複");
  });
});

describe("normal mainのlane分離とqueue後の実期限", () => {
  const originalArgv = [...process.argv];
  const dir = mkdtempSync(join(tmpdir(), "moneyflow-lane-"));
  afterEach(() => {
    process.argv = [...originalArgv]; process.exitCode = undefined;
    vi.doUnmock("../../src/shared/notion-archive/index.js"); vi.doUnmock("./lib/run-spec.js");
    vi.doUnmock("./lib/archived-files.js");
    vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetModules();
  });
  it("非Yahoo mainは同じrunSpecで選択sourceだけを処理し、実summaryを残す", async () => {
    vi.resetModules(); vi.stubEnv("GITHUB_RUN_ID", "38879272134"); vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    const path = join(dir, "non-yahoo.json");
    process.argv = [...originalArgv, "--only=global-indices,coingecko-global", "--lane=non-yahoo", `--summary=${path}`];
    const runSpec = vi.fn().mockResolvedValue("保存原本を全行確認");
    vi.doMock("./lib/run-spec.js", () => ({ runSpec }));
    vi.doMock("../../src/shared/notion-archive/index.js", async original => ({
      ...await original<typeof import("../../src/shared/notion-archive/index.js")>(),
      ensureIndicatorDefsDb: vi.fn(async () => ({ dbId: "defs" })),
      upsertIndicatorDef: vi.fn(async () => ({ pageId: "def" })),
      ensureRunLogDb: vi.fn(async () => ({ dbId: "logs" })), recordRunLog: vi.fn(async () => ({ pageId: "log" })),
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { main } = await import("./ingest.js"); await main();
    expect(runSpec).toHaveBeenCalledTimes(1);
    expect(runSpec.mock.calls[0][0].name).toBe("coingecko-global");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ runId: "38879272134.1", lane: "non-yahoo",
      requestedSources: ["global-indices", "coingecko-global"], only: ["coingecko-global"], notion: { requests: 0 } });
    rmSync(path);
  });
  it("Yahoo jobのqueue待ちで23:40超ならcatalog/source/summaryを開始しない", async () => {
    vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-16T14:40:00.001Z"));
    vi.stubEnv("GITHUB_RUN_ID", "38879272134"); vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    const path = join(dir, "late.json");
    process.argv = [...originalArgv, "--only=independent", "--lane=yahoo", `--summary=${path}`, "--scheduled-date=2026-10-16"];
    const runSpec = vi.fn(), catalog = vi.fn();
    vi.doMock("./lib/run-spec.js", () => ({ runSpec }));
    vi.doMock("../../src/shared/notion-archive/index.js", async original => ({
      ...await original<typeof import("../../src/shared/notion-archive/index.js")>(), ensureIndicatorDefsDb: catalog,
    }));
    const { main } = await import("./ingest.js");
    await expect(main()).rejects.toThrow("23:40");
    expect(catalog).not.toHaveBeenCalled(); expect(runSpec).not.toHaveBeenCalled(); expect(existsSync(path)).toBe(false);
  });
  it.each(["quality", "unknown"])("非Yahooの%s終了を保存summaryで区別し、unknownを後続資格にしない", async mode => {
    vi.resetModules(); vi.stubEnv("GITHUB_RUN_ID","38879272134"); vi.stubEnv("GITHUB_RUN_ATTEMPT","1");
    const path=join(dir,`${mode}.json`),output=join(dir,`${mode}-output`);writeFileSync(output,"");vi.stubEnv("GITHUB_OUTPUT",output);
    process.argv=[...originalArgv,"--only=global-indices,coingecko-global","--lane=non-yahoo",`--summary=${path}`];
    const {NotionUnknownResultError}=await import("../../src/shared/notion-archive/client.js");
    const failure=mode==="unknown"?new NotionUnknownResultError("declared mutation unknown"):new Error("declared source503");
    vi.doMock("./lib/run-spec.js",()=>({runSpec:vi.fn().mockRejectedValue(failure)}));
    vi.doMock("../../src/shared/notion-archive/index.js",async original=>({...await original<typeof import("../../src/shared/notion-archive/index.js")>(),
      ensureIndicatorDefsDb:vi.fn(async()=>({dbId:"defs"})),upsertIndicatorDef:vi.fn(async()=>({pageId:"def"})),
      ensureRunLogDb:vi.fn(async()=>({dbId:"logs"})),recordRunLog:vi.fn(async()=>({pageId:"log"}))}));
    vi.spyOn(console,"info").mockImplementation(()=>undefined);vi.spyOn(console,"error").mockImplementation(()=>undefined);
    const {main}=await import("./ingest.js");
    if(mode==="unknown") {await expect(main()).rejects.toBe(failure);expect(existsSync(path)).toBe(false);expect(readFileSync(output,"utf8")).toBe("");}
    else {await main();expect(process.exitCode).toBe(1);expect(JSON.parse(readFileSync(path,"utf8")).outcomes).toMatchObject([{source:"coingecko-global",ok:false}]);
      expect(console.info).toHaveBeenCalledWith(expect.stringContaining('"failedSources": 1'));
      expect(console.info).toHaveBeenCalledWith(expect.stringContaining('"notYetPublishedSources": 0'));
      expect(readFileSync(output,"utf8")).toBe("summary_closed=true\n");rmSync(path);}
    rmSync(output);
  });
  it.each(["not-yet-published", "custody-unknown"])("実CFTC未公表の%sを通常mainから保管・summaryへ渡し、観測成功にはしない", async mode => {
    vi.resetModules(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime("2026-10-03T00:00:00Z");
    vi.stubEnv("GITHUB_RUN_ID", "38879272134"); vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    const path = join(dir, `${mode}.json`), output = join(dir, `${mode}-output`);
    writeFileSync(output, ""); vi.stubEnv("GITHUB_OUTPUT", output);
    process.argv = [...originalArgv, "--only=cftc-cot-jpy", "--lane=non-yahoo", `--summary=${path}`];
    vi.doUnmock("./lib/run-spec.js");
    const { NotionUnknownResultError } = await import("../../src/shared/notion-archive/client.js");
    const unknown = new NotionUnknownResultError("CFTC custody result unknown");
    const recordPrimaryData = vi.fn(async () => ({ pageId: "primary-cftc", outcome: "recorded", fileTooLarge: false }));
    if (mode === "custody-unknown") recordPrimaryData.mockRejectedValueOnce(unknown);
    const recordRunLog = vi.fn(), upsertObservationBatch = vi.fn();
    vi.doMock("../../src/shared/notion-archive/index.js", async original => ({
      ...await original<typeof import("../../src/shared/notion-archive/index.js")>(),
      ensureIndicatorDefsDb: vi.fn(async () => ({ dbId: "defs" })), upsertIndicatorDef: vi.fn(async () => ({ pageId: "def" })),
      ensureRunLogDb: vi.fn(async () => ({ dbId: "logs" })), recordRunLog, recordPrimaryData, upsertObservationBatch,
    }));
    const verifyArchivedAttachments = vi.fn();
    vi.doMock("./lib/archived-files.js", async original => ({ ...await original<object>(), verifyArchivedAttachments }));
    const bytes = readFileSync(new URL("../../services/moneyflow/lib/sources/fixtures/public/cftc-cot-jpy/cftc-cot-jpy-legacy-futures-only.json", import.meta.url));
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(bytes));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { main } = await import("./ingest.js");
    if (mode === "custody-unknown") {
      await expect(main()).rejects.toBe(unknown);
      expect(existsSync(path)).toBe(false); expect(readFileSync(output, "utf8")).toBe(""); expect(recordRunLog).not.toHaveBeenCalled();
    } else {
      await main();
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(readFileSync(path, "utf8")).outcomes).toMatchObject([{ source: "cftc-cot-jpy", ok: false,
        reason: { code: "not_yet_published", period: "2026-W40", expectedAsOfDate: "2026-09-29", expectedReleaseDate: "2026-10-02", latestPublishedAsOfDate: "2026-09-22" } }]);
      expect(recordRunLog).toHaveBeenCalledWith("logs", expect.objectContaining({ status: "失敗", successCount: 0, failedCount: 1 }));
      expect(info).toHaveBeenCalledWith(expect.stringContaining('"notYetPublishedSources": 1'));
      expect(info).toHaveBeenCalledWith(expect.stringContaining('"failedSources": 0'));
      expect(info).toHaveBeenCalledWith(expect.stringContaining('"complete": false'));
      expect(readFileSync(output, "utf8")).toBe("summary_closed=true\n");
      expect(verifyArchivedAttachments).toHaveBeenCalledTimes(1); rmSync(path);
    }
    expect(fetch).toHaveBeenCalledTimes(1); expect(upsertObservationBatch).not.toHaveBeenCalled();
    expect(recordPrimaryData).toHaveBeenCalledTimes(1); rmSync(output);
  });
  it("stock後sector-turnoverは固定as-of/4指標順/原本relation NULLを変えず共通batchへ渡す", async () => {
    vi.resetModules();
    process.argv = [...originalArgv, "--only=sector-turnover", "--as-of=2026-09-28"];
    vi.stubEnv("WORKER_BASE_URL", "https://worker.invalid"); vi.stubEnv("CRON_SECRET", "test-secret");
    const batch = vi.fn().mockResolvedValue([]);
    vi.doMock("../../src/shared/notion-archive/index.js", async original => ({
      ...await original<typeof import("../../src/shared/notion-archive/index.js")>(),
      ensureIndicatorDefsDb: vi.fn(async () => ({ dbId: "defs" })),
      upsertIndicatorDef: vi.fn(async (_db, input) => ({ pageId: `def-${input.key}` })),
      ensureObservationsDb: vi.fn(async () => ({ dbId: "obs" })), upsertObservationBatch: batch,
      ensureRunLogDb: vi.fn(async () => ({ dbId: "logs" })), recordRunLog: vi.fn(async () => ({ pageId: "log" })),
    }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      from: "2026-09-28", to: "2026-09-28", coverage: { date: "2026-09-28", universe: 3700, covered: 3700 },
      sectors: [{ sector: "電気機器", turnover: 100, turnoverShare: 0.5, upTurnover: 60, downTurnover: 40, stockCount: 10 }],
    })));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { main } = await import("./ingest.js"); await main();
    expect(batch).toHaveBeenCalledTimes(1);
    const rows = batch.mock.calls[0][1];
    expect(rows.map((r: { indicatorKey: string }) => r.indicatorKey))
      .toEqual(["sector_turnover", "sector_turnover_share", "sector_up_turnover", "sector_down_turnover"]);
    expect(rows.map((r: { value: number }) => r.value)).toEqual([100, 0.5, 60, 40]);
    for (const row of rows) expect(row).toMatchObject({ period: "2026-W40", periodStart: "2026-09-28", periodEnd: "2026-09-28",
      category: "電気機器", changeFromPrev: null, primaryDataPageId: null, measureKind: "実測" });
  });
});

describe("main() の結果不明時の保全停止", () => {
  const originalArgv = [...process.argv];
  afterEach(() => {
    process.argv = [...originalArgv];
    process.exitCode = undefined;
    vi.doUnmock("../../src/shared/notion-archive/index.js");
    vi.doUnmock("./lib/run-spec.js");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function prepare(failure: "catalog_unknown" | "source_unknown" | "catalog_config" | "source_config" | "source_quality") {
    vi.resetModules();
    process.argv = [...originalArgv, "--only=coingecko-global,global-indices", "--as-of=2026-10-01"];
    const { NotionUnknownResultError } = await import("../../src/shared/notion-archive/client.js");
    const { NotionConfigError } = await import("../../src/shared/notion-archive/env.js");
    const error = failure === "source_quality" ? new Error("掲載原本のcoverage不足") :
      failure.endsWith("_config") ? new NotionConfigError("Notion設定不備") : new NotionUnknownResultError("送信結果不明");
    const upsertIndicatorDef = vi.fn().mockResolvedValue({ pageId: "def-1" });
    const runSpec = vi.fn().mockResolvedValue("保管済み原本を確認");
    if (failure.startsWith("catalog_")) upsertIndicatorDef.mockRejectedValueOnce(error);
    else runSpec.mockRejectedValueOnce(error);
    const ensureRunLogDb = vi.fn().mockResolvedValue({ dbId: "run-db" });
    const recordRunLog = vi.fn().mockResolvedValue({ pageId: "run-1" });
    vi.doMock("../../src/shared/notion-archive/index.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/shared/notion-archive/index.js")>()),
      ensureIndicatorDefsDb: vi.fn(async () => ({ dbId: "defs-db" })),
      upsertIndicatorDef, ensureRunLogDb, recordRunLog,
    }));
    vi.doMock("./lib/run-spec.js", () => ({ runSpec }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { main } = await import("./ingest.js");
    return { main, error, runSpec, ensureRunLogDb, recordRunLog };
  }

  it.each(["catalog_unknown", "source_unknown", "catalog_config", "source_config"] as const)("%s なら同型で停止し、後続sourceとrun-logを送信しない", async failure => {
    const { main, error, runSpec, ensureRunLogDb, recordRunLog } = await prepare(failure);
    await expect(main()).rejects.toBe(error);
    expect(runSpec).toHaveBeenCalledTimes(failure.startsWith("catalog_") ? 0 : 1);
    expect(ensureRunLogDb).not.toHaveBeenCalled();
    expect(recordRunLog).not.toHaveBeenCalled();
  });

  it("既知の原本品質不足は後続sourceを処理し、一部失敗を正直に記録する", async () => {
    const { main, runSpec, recordRunLog } = await prepare("source_quality");
    await main();
    expect(runSpec).toHaveBeenCalledTimes(2);
    expect(recordRunLog.mock.calls[0]?.[1]).toMatchObject({ status: "一部失敗", successCount: 1, failedCount: 1 });
    expect(recordRunLog.mock.calls[0]?.[1].reason).toContain("coverage不足");
    expect(process.exitCode).toBe(1);
  });
});

describe("main() の Phase1 原本保管失敗", () => {
  const originalArgv = [...process.argv];
  afterEach(() => {
    process.argv = [...originalArgv];
    process.exitCode = undefined;
    for (const path of [
      "../../services/moneyflow/lib/jpx-sector-marketcap.js",
      "../../services/moneyflow/lib/jpx-short-selling.js",
      "../../src/shared/notion-archive/index.js",
      "./lib/archived-files.js",
    ]) vi.doUnmock(path);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it.each([
    ["jpx-sector-marketcap", "too_large"],
    ["jpx-short-selling", "too_large"],
    ["jpx-sector-marketcap", "attachment_mismatch"],
    ["jpx-short-selling", "attachment_mismatch"],
  ])("%s の %s は観測値を書かず取込失敗を記録する", async (source, failure) => {
    vi.resetModules();
    process.argv = [...originalArgv, `--only=${source}`];
    const ensureObservationsDb = vi.fn(async () => ({ dbId: "obs-db" }));
    const upsertObservationBatch = vi.fn(async () => []);
    const recordRunLog = vi.fn().mockResolvedValue({ pageId: "run-1" });
    vi.doMock("../../src/shared/notion-archive/index.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../src/shared/notion-archive/index.js")>()),
      ensureIndicatorDefsDb: vi.fn(async () => ({ dbId: "defs-db" })),
      upsertIndicatorDef: vi.fn(async () => ({ pageId: "def-1" })),
      ensureRunLogDb: vi.fn(async () => ({ dbId: "run-db" })), recordRunLog,
      isArchived: vi.fn(async () => false),
      recordPrimaryData: vi.fn(async () => ({ pageId: "primary-1", fileTooLarge: failure === "too_large" })),
      ensureObservationsDb, upsertObservationBatch,
    }));
    vi.doMock("./lib/archived-files.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./lib/archived-files.js")>()),
      requirePrimaryDataDbId: vi.fn(async () => "primary-db"),
      listArchivedRecordsByPrefix: vi.fn(async () => []),
      verifyArchivedAttachments: vi.fn(async () => { throw new Error("attachment_mismatch"); }),
    }));
    vi.doMock("../../services/moneyflow/lib/jpx-sector-marketcap.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../services/moneyflow/lib/jpx-sector-marketcap.js")>()),
      latestSectorMarketCapPdfUrl: vi.fn(async () => ({ yearMonth: "202608" })),
      fetchSectorMarketCap: vi.fn(async () => ({ asOfDate: "2026-08-31", sectors: [
        { sector: "電気機器", companies: 123, marketCapMillionYen: 279_083_685 },
      ], segments: {}, pdfBytes: new Uint8Array(), pdfUrl: "https://www.jpx.co.jp/markets/statistics-equities/misc/202608.pdf" })),
    }));
    vi.doMock("../../services/moneyflow/lib/jpx-short-selling.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../services/moneyflow/lib/jpx-short-selling.js")>()),
      fetchShortSellingSector: vi.fn(async () => ({ date: "2026-09-25", sectors: [], other: {},
        pdfBytes: new Uint8Array(), pdfUrl: "https://www.jpx.co.jp/markets/statistics-equities/short-selling/260925-g.pdf" })),
      aggregateMonthlyShortSellingRatio: vi.fn(() => ({ month: "2026-09", sectors: [
        { sector: "電気機器", shortRatio: (902_200 + 416_524) / 3_290_330, totalTurnover: 3_290_330, tradingDays: 1 },
      ] })),
    }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const mod = await import("./ingest.js");
    await mod.main();
    expect(ensureObservationsDb).not.toHaveBeenCalled();
    expect(upsertObservationBatch).not.toHaveBeenCalled();
    expect(recordRunLog.mock.calls[0]?.[1]).toMatchObject({ status: "失敗", successCount: 0, failedCount: 1 });
    expect(recordRunLog.mock.calls[0]?.[1].reason).toContain(failure === "too_large" ? "file_too_large" : "attachment_mismatch");
    expect(process.exitCode).toBe(1);
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
  const coverage = (overrides: Record<string, unknown> = {}) => ({
    date: "2026-09-28",
    universe: 3700,
    covered: 3700,
    ...overrides,
  });
  const res = (sectors: ReturnType<typeof row>[], cov: ReturnType<typeof coverage>) => ({
    from: "2026-09-28",
    to: "2026-09-28",
    sectors,
    coverage: cov,
  });

  it("正常な結果は行を返す", () => {
    const out = verifySectorTurnoverResult({ from: "2026-09-28", to: "2026-09-28" }, res([row()], coverage()));
    expect(out).toHaveLength(1);
    expect(out[0].turnoverShare).toBe(0.5);
  });

  it("範囲 echo 不一致・空・share 未定義は throw する", () => {
    expect(() =>
      verifySectorTurnoverResult(
        { from: "2026-09-28", to: "2026-09-28" },
        { ...res([row()], coverage()), to: "2026-09-29" }
      )
    ).toThrow(/応答範囲が不一致/);
    expect(() =>
      verifySectorTurnoverResult({ from: "2026-09-28", to: "2026-09-28" }, res([], coverage()))
    ).toThrow(/売買代金合計が 0/);
    expect(() =>
      verifySectorTurnoverResult(
        { from: "2026-09-28", to: "2026-09-28" },
        res([row({ turnoverShare: null })], coverage())
      )
    ).toThrow(/売買代金合計が 0/);
  });

  it("as-of 日 coverage の不一致・母集団空・不足は throw する", () => {
    expect(() =>
      verifySectorTurnoverResult(
        { from: "2026-09-28", to: "2026-09-28" },
        res([row()], coverage({ date: "2026-09-27" }))
      )
    ).toThrow(/coverage がありません/);
    expect(() =>
      verifySectorTurnoverResult(
        { from: "2026-09-28", to: "2026-09-28" },
        res([row()], coverage({ universe: 0, covered: 0 }))
      )
    ).toThrow(/母集団が空/);
    expect(() =>
      verifySectorTurnoverResult(
        { from: "2026-09-28", to: "2026-09-28" },
        res([row()], coverage({ covered: 3699 }))
      )
    ).toThrow(/実日足が母集団に足りません/);
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
        "upsertObservationBatch",
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
    expect(process.exitCode).toBeUndefined();
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

  it("dry-run でも検証を先に通し、不合格は ok:false・exit 1 にする", async () => {
    vi.resetModules();
    process.argv = [...ORIGINAL_ARGV, "--dry-run", "--only=sector-turnover"];

    const prevWorkerBase = process.env.WORKER_BASE_URL;
    const prevCron = process.env.CRON_SECRET;
    const prevFetch = globalThis.fetch;
    process.env.WORKER_BASE_URL = "https://worker.invalid";
    process.env.CRON_SECRET = "test-secret";
    // coverage 不足の応答 (from/to は要求に合わせるのですり抜けない)。
    globalThis.fetch = (async (url: unknown) => {
      const u = new URL(String(url));
      const body = {
        from: u.searchParams.get("from"),
        to: u.searchParams.get("to"),
        sectors: [],
        coverage: { date: u.searchParams.get("to"), universe: 3700, covered: 3699 },
      };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
    }) as typeof fetch;

    const ensureObservationsDb = vi.fn();
    vi.doMock("../../src/shared/notion-archive/index.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../src/shared/notion-archive/index.js")>();
      return { ...actual, ensureObservationsDb };
    });

    try {
      const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const mod = await import("./ingest.js");
      await mod.main();
      const outcomes = consoleInfo.mock.calls
        .map((c) => {
          try {
            return JSON.parse(String(c[0])) as { outcomes?: Array<{ source: string; ok: boolean; detail: string }> };
          } catch {
            return {};
          }
        })
        .find((o) => Array.isArray(o.outcomes))?.outcomes;
      consoleInfo.mockRestore();
      consoleError.mockRestore();

      expect(outcomes).toHaveLength(1);
      expect(outcomes?.[0]?.source).toBe("sector-turnover");
      expect(outcomes?.[0]?.ok).toBe(false);
      expect(outcomes?.[0]?.detail).toMatch(/実日足が母集団に足りません/);
      expect(ensureObservationsDb).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      if (prevWorkerBase === undefined) delete process.env.WORKER_BASE_URL;
      else process.env.WORKER_BASE_URL = prevWorkerBase;
      if (prevCron === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prevCron;
      globalThis.fetch = prevFetch;
    }
  });
});
