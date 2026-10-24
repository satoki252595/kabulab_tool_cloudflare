/**
 * 失敗バッチ一次保管 (price-sync-batch) の回帰境界。
 *
 * 固定したい契約:
 * - 失敗分類は実 reason 文字列からのみ導出する (一律 genuine 禁止)。
 * - バッチ JSON は failures 全件・切詰なし (CLI の 20 グループは要約)。
 * - 例外中断時は件数/日付 null・元例外保持 (0 件偽装しない)。
 * - 保管失敗は fail-closed (握りつぶさない)。skipped_existing は
 *   同一 invocation の二重防止が働いた正常系として受け入れる。
 * - run 一意キーで success/failure の二重記録を防ぐ。
 * - runDailySync 配線: 完了・例外どちらのパスでも保管してから
 *   return/throw する (CLI の 1% throw の前に物理保管あり)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import {
  _resetBatchRunIdForTests,
  archivePriceSyncBatch,
  buildPriceSyncBatch,
  buildStockSnapshot,
  categorizeSyncFailure,
  isDailySyncIncomplete,
  isTransientDailySyncFailure,
  priceSyncBatchKey,
  priceSyncBatchRunId,
  runDailySync,
  type PriceSyncBatchInput,
} from "./daily.js";
import type { OverlayCollectFn } from "./universe-overlay.js";
import { emptyUniverseBatch, fakeOverlayCollect } from "./tests/overlay-batch.js";
import { chartWithRaw, stockWithRaw } from "./tests/yahoo-capture.js";
import { archiveYahooRawBatch } from "../shared/yahoo/raw-custody.js";
import { collectOfficialRightsCustody, type OfficialRightsCustody } from "./rights-official-custody.js";
import * as jpLegModule from "./macro-jp-leg.js";
import { makeTxBatchSender } from "./tests/overlay-test-sender.js";
import { createD1HttpBatchSender } from "../shared/db/d1-http-client.js";

const fakeCollect: OverlayCollectFn = fakeOverlayCollect;

import { fetchChart, fetchStockRawData, parseSavedStockRawData, YahooRawTooLargeError } from "../shared/yahoo/client.js";
import "../shared/yahoo/nikkei-vi.js";
import {
  ensurePriceSyncDb,
  recordPriceSyncLog,
  recordPrimaryData,
} from "../shared/notion-archive/index.js";
import * as coreSchema from "../shared/db/core-schema.js";
import * as rsiSchema from "../../services/rsi-screening/src/db/schema.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import * as projectionSchema from "../shared/db/projection-schema.js";
import { INSTRUMENT_TYPES } from "../shared/jpx/instrument-type.js";

vi.mock("../shared/yahoo/client.js", async (original) => ({
  ...await original<typeof import("../shared/yahoo/client.js")>(),
  fetchChart: vi.fn(),
  fetchStockRawData: vi.fn(),
}));
vi.mock("../shared/yahoo/raw-custody.js", () => ({ archiveYahooRawBatch: vi.fn() }));
vi.mock("../shared/db/d1-http-client.js", async (original) => ({
  ...await original<typeof import("../shared/db/d1-http-client.js")>(),
  createD1HttpBatchSender: vi.fn(),
}));
vi.mock("./rights-official-custody.js", () => ({ collectOfficialRightsCustody: vi.fn() }));
vi.mock("../shared/yahoo/nikkei-vi.js", () => ({ fetchNikkeiVi: vi.fn() }));
vi.mock("../shared/notion-archive/index.js", async (original) => ({
  ...await original<typeof import("../shared/notion-archive/index.js")>(),
  ensurePriceSyncDb: vi.fn(),
  recordPriceSyncLog: vi.fn(),
  recordPrimaryData: vi.fn(),
}));

const NOW_MS = Date.parse("2026-09-28T17:13:00Z"); // 月曜・窓内

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
  _resetBatchRunIdForTests();
  vi.mocked(archiveYahooRawBatch).mockResolvedValue({ pages: ["raw-page"], rawBytes: 1, compressedBytes: 1 });
  vi.mocked(ensurePriceSyncDb).mockResolvedValue({ dbId: "test-db" });
  vi.mocked(recordPrimaryData).mockResolvedValue({
    pageId: "page-1",
    outcome: "recorded",
    fileTooLarge: false,
    manifestMatch: "written",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetBatchRunIdForTests();
});

describe("categorizeSyncFailure", () => {
  it("原本未提供・通信・保存等を区別し、無約定や真正欠損を推測しない", () => {
    expect(
      categorizeSyncFailure("1301: 対象 2026-09-28 の実日足が未取得です。古い日の指標を書き直しません。")
    ).toBe("source_unavailable");
    expect(
      categorizeSyncFailure("1909.T: 最新終値 16280000512 が meta 価格 3700 と10倍超乖離し出来高がありません。応答全体を採用しません。")
    ).toBe("priceguard");
    expect(
      categorizeSyncFailure("Chart API HTTP エラー [9503]: 429 Too Many Requests; retry-at-ms=1")
    ).toBe("networkparse");
    expect(categorizeSyncFailure("D1 HTTP 400: parse error near")).toBe(
      "savefailure"
    );
  });

  it("未知の文面は unknown (どれかに寄せない)", () => {
    expect(categorizeSyncFailure("何か変なエラー")).toBe("unknown");
  });
});

function batchInput(
  over: Partial<PriceSyncBatchInput> = {}
): PriceSyncBatchInput {
  return {
    mode: "stocks",
    runId: "test-run.1",
    startedAt: "2026-09-28T17:13:00.000Z",
    finishedAt: "2026-09-28T17:40:00.000Z",
    tradingDate: "2026-09-28",
    totalStocks: 3700,
    successStocks: 3646,
    failedStocks: 54,
    failures: [],
    failureCollection: "complete",
    originalError: null,
    ...over,
  };
}

function decodeFile(batch: ReturnType<typeof buildPriceSyncBatch>) {
  return JSON.parse(new TextDecoder().decode(batch.file.bytes)) as {
    failures: { code: string; error: string }[];
    stats: Record<string, number | null>;
    categories: Record<string, number>;
    failureCollection: string;
    originalError: string | null;
  };
}

describe("buildPriceSyncBatch", () => {
  it("failures 全件を切詰なしで載せる (20 超も全件)", () => {
    const failures = Array.from({ length: 25 }, (_, i) => ({
      code: `100${i}`,
      error: `100${i}: 対象 2026-09-28 の実日足が未取得です。`,
    }));
    const body = decodeFile(buildPriceSyncBatch(batchInput({ failures })));
    expect(body.failures).toHaveLength(25);
    expect(body.failures[24]).toEqual(failures[24]);
    expect(body.categories).toMatchObject({ source_unavailable: 25 });
  });

  it("例外時は件数/日付 null・元例外保持・収集中断を明示する", () => {
    const body = decodeFile(
      buildPriceSyncBatch(
        batchInput({
          tradingDate: null,
          totalStocks: null,
          successStocks: null,
          failedStocks: null,
          failureCollection: "aborted",
          originalError: "boom",
        })
      )
    );
    expect(body.stats).toEqual({
      totalStocks: null,
      successStocks: null,
      failedStocks: null,
    });
    expect(body.failureCollection).toBe("aborted");
    expect(body.originalError).toBe("boom");
  });

  it("キーは run 一意 (同一 invocation の success/failure 二重防止)", () => {
    expect(buildPriceSyncBatch(batchInput()).key).toBe(
      "price-sync-batch-test-run.1"
    );
    expect(priceSyncBatchKey("a")).not.toBe(priceSyncBatchKey("b"));
  });
});

describe("archivePriceSyncBatch", () => {
  it("recorded でキーを返す", async () => {
    const fake = vi.fn().mockResolvedValue({
      pageId: "p",
      outcome: "recorded",
      fileTooLarge: false,
    });
    await expect(
      archivePriceSyncBatch(batchInput(), fake)
    ).resolves.toBe("price-sync-batch-test-run.1");
    expect(fake).toHaveBeenCalledTimes(1);
    expect(fake.mock.calls[0][0]).toMatchObject({
      service: "stock-sync",
      key: "price-sync-batch-test-run.1",
      force: false,
    });
  });

  it("skipped_existing は物理証拠なしとして throw (二重防止≠保管成功)", async () => {
    const fake = vi.fn().mockResolvedValue({
      pageId: "p",
      outcome: "skipped_existing",
      fileTooLarge: false,
    });
    await expect(archivePriceSyncBatch(batchInput(), fake)).rejects.toThrow(
      /skipped_existing/
    );
  });

  it("fileTooLarge / recorder throw は握りつぶさず throw (fail-closed)", async () => {
    const tooLarge = vi.fn().mockResolvedValue({
      pageId: "p",
      outcome: "recorded",
      fileTooLarge: true,
    });
    await expect(archivePriceSyncBatch(batchInput(), tooLarge)).rejects.toThrow(
      /fileTooLarge/
    );
    const broken = vi.fn().mockRejectedValue(new Error("notion down"));
    await expect(archivePriceSyncBatch(batchInput(), broken)).rejects.toThrow(
      /notion down/
    );
  });
});

describe("priceSyncBatchRunId", () => {
  it("Actions は runID(.attempt)、同一 invocation で安定する", () => {
    vi.stubEnv("GITHUB_RUN_ID", "365");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "2");
    expect(priceSyncBatchRunId(100)).toBe("365.2");
    expect(priceSyncBatchRunId(200)).toBe("365.2");
  });

  it("ローカルは run 開始時刻で代替する", () => {
    vi.stubEnv("GITHUB_RUN_ID", "");
    expect(priceSyncBatchRunId(123)).toBe("local-123");
  });
});

// --- runDailySync 配線 (Yahoo + Notion mock, D1 は本物 sqlite-proxy) ---

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function proxyDb(sqlite: DatabaseSync) {
  return drizzle(
    async (sqlStr, params, method) => {
      const stmt = sqlite.prepare(sqlStr);
      const bind = params as (null | number | bigint | string | Uint8Array)[];
      if (method === "run") {
        stmt.run(...bind);
        return { rows: [] };
      }
      const objs = stmt.all(...bind) as Record<string, unknown>[];
      const rows = objs.map((o) => Object.values(o));
      return { rows: method === "get" ? (rows[0] ?? []) : rows };
    },
    {
      schema: { ...coreSchema, ...rsiSchema, ...swingSchema, ...projectionSchema },
    }
  );
}

type Db = Parameters<typeof runDailySync>[0];

let sqlite: DatabaseSync;

function freshDb(): Db {
  sqlite = new DatabaseSync(":memory:");
  // 共有 sender の通常 caller を同じ既存 SQLite batch protocol に接続する。
  vi.mocked(createD1HttpBatchSender).mockImplementation(() => makeTxBatchSender(sqlite, { sends: 0 }));
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split("--> statement-breakpoint")) {
      if (stmt.trim()) sqlite.exec(stmt);
    }
  }
  // overlay bootstrap base は確定済み (本 test は保管配線が対象)。
  sqlite.exec("INSERT INTO universe_overlay_state (id, base_as_of) VALUES (1, '2026-08-31')");
  // jss_financials は pipeline 所有で drizzle migration に無い
  // (daily-jss-annual.test.ts と同じ手書き DDL)。
  sqlite.exec(`
    CREATE TABLE jss_financials (
      code text NOT NULL,
      fiscal_period_end text NOT NULL,
      disclosure_type text NOT NULL,
      consolidated text NOT NULL,
      net_sales real,
      license_tag text NOT NULL,
      PRIMARY KEY (code, fiscal_period_end, disclosure_type, consolidated)
    );
  `);
  return proxyDb(sqlite) as unknown as Db;
}

function seedTarget(id: number, code: string): void {
  sqlite
    .prepare(
      "INSERT INTO core_stocks (id, code, name, market, sector, is_active, instrument_type) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(id, code, `銘柄${code}`, "プライム", "輸送用機器", 1, INSTRUMENT_TYPES.equity);
}

function sessionChart(date: string) {
  return {
    symbol: "^N225",
    price: 100,
    previousClose: 99,
    dataDate: "2026-09-28",
    ohlcv: [
      { date, open: 99, high: 100, low: 99, close: 100, volume: null, adj: 100 },
    ],
  };
}

function stockRaw(bars: number, lastDate: string) {
  const ohlcv = Array.from({ length: bars }, (_, i) => {
    const d = new Date(`${lastDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (bars - 1 - i));
    const c = 100 + (i % 7);
    return {
      date: d.toISOString().slice(0, 10),
      open: c - 1,
      high: c + 1,
      low: c - 2,
      close: c,
      volume: 1000,
      adj: c,
    };
  });
  return {
    price: 100,
    per: 10,
    pbr: 1,
    dividendYield: 2,
    eps: 5,
    bps: 50,
    roe: 8,
    roa: 4,
    marketCap: 1000,
    operatingMarginTtm: 5,
    dataDate: lastDate,
    ohlcv,
    annualFinancials: [],
  };
}

function saved8303Source(projectionBodies: Record<string, string>) {
  return Object.fromEntries((["chart", "quote-summary"] as const).map((api) => {
      const bytes = new TextEncoder().encode(projectionBodies[`8303-${api}`]);
      const expectedSha256 = api === "chart"
        ? "713a310eae4050629ad65572ff79e6afcd694cd7aecac5b3e9ecbdb889cd6b9f"
        : "fa010a5432d415c9b25303ccc15862df647a48ec4acaf9ff57df961cad0488a0";
      return [api === "chart" ? "chart" : "summary", { expectedSha256, expectedByteLength: bytes.byteLength,
        capture: { symbol: "8303", status: 200, bytes, headers: {},
          url: api === "chart"
            ? "https://query1.finance.yahoo.com/v8/finance/chart/8303.T?range=5y&interval=1d&events=split%2Cdiv"
            : "https://query1.finance.yahoo.com/v10/finance/quoteSummary/8303.T?modules=financialData,defaultKeyStatistics,summaryDetail,incomeStatementHistory",
          receivedAt: api === "chart" ? "2026-10-14T10:15:47.400Z" : "2026-10-14T10:15:48.285Z" } }];
    })) as Parameters<typeof parseSavedStockRawData>[1];
}

describe("runDailySync 配線: 保管してから return/throw", () => {
  afterEach(() => {
    sqlite?.close();
  });

  it("例外時は元例外を保持し aborted バッチ (null 件数) を保管する", async () => {
    vi.mocked(fetchChart).mockImplementation(chartWithRaw(sessionChart("2026-09-25")));
    const db = freshDb();
    await expect(runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect, sendOverlayBatch: makeTxBatchSender(sqlite, { sends: 0 }) })).rejects.toThrow(
      "日足を確認できません"
    );
    expect(vi.mocked(recordPriceSyncLog)).toHaveBeenCalledWith(
      "test-db",
      expect.objectContaining({ status: "失敗", tradingDate: null })
    );
    const input = vi.mocked(recordPrimaryData).mock.calls[0][0];
    expect(input.key).toMatch(/^price-sync-batch-/);
    const body = JSON.parse(
      new TextDecoder().decode(input.files![0].bytes)
    ) as {
      stats: Record<string, null>;
      failureCollection: string;
      failures: unknown[];
      originalError: string;
    };
    expect(body.stats).toEqual({
      totalStocks: null,
      successStocks: null,
      failedStocks: null,
    });
    expect(body.failureCollection).toBe("aborted");
    expect(body.failures).toEqual([]);
    expect(body.originalError).toMatch("日足を確認できません");
  });

  it("N225 が古くても公式上場廃止を先に適用し、株価は書かない", async () => {
    vi.mocked(fetchChart).mockImplementation(chartWithRaw(sessionChart("2026-09-25")));
    const db = freshDb();
    seedTarget(1, "1301");
    const collect: OverlayCollectFn = async (input) => {
      const batch = emptyUniverseBatch(input.baseAsOf, input.eligibilityAsOf);
      batch.sources.delisted.rows = [{ code: "1301", companyName: "銘柄1301", market: "プライム", effectiveDate: "2026-09-28", reason: "テスト上場廃止" }];
      return batch;
    };
    await expect(runDailySync(db, { stocksOnly: true, collectOverlay: collect,
      sendOverlayBatch: makeTxBatchSender(sqlite, { sends: 0 }) })).rejects.toThrow("日足を確認できません");
    expect(sqlite.prepare("SELECT is_active FROM core_stocks WHERE code = '1301'").get()).toEqual({ is_active: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM core_stock_financials").get()).toEqual({ n: 0 });
    expect(fetchStockRawData).not.toHaveBeenCalled();
  });

  it("閾値超過の失敗でも結果 return 前に全件バッチを保管する (CLI throw の前)", async () => {
    vi.mocked(fetchChart).mockImplementation(chartWithRaw(sessionChart("2026-09-28")));
    vi.mocked(fetchStockRawData).mockRejectedValue(
      new Error("対象 2026-09-28 の実日足が未取得です。")
    );
    const db = freshDb();
    seedTarget(1, "1301");
    seedTarget(2, "1332");
    const result = await runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect, sendOverlayBatch: makeTxBatchSender(sqlite, { sends: 0 }) });
    // core は throw しない (throw は CLI の 1% 判定)。物理保管が先。
    expect(isDailySyncIncomplete(result)).toBe(true);
    expect(result.batchKey).toMatch(/^price-sync-batch-/);
    const input = vi.mocked(recordPrimaryData).mock.calls[0][0];
    expect(input.key).toBe(result.batchKey);
    const body = JSON.parse(
      new TextDecoder().decode(input.files![0].bytes)
    ) as {
      failures: { code: string; error: string }[];
      categories: Record<string, number>;
    };
    expect(body.failures).toHaveLength(2);
    expect(body.failures.map((f) => f.code).sort()).toEqual(["1301", "1332"]);
    expect(body.categories).toMatchObject({ source_unavailable: 2 });
  });

  it("完了保管 fileTooLarge→例外同キー skip でも保管成功を偽らない (元例外で非0)", async () => {
    vi.mocked(fetchChart).mockImplementation(chartWithRaw(sessionChart("2026-09-28")));
    vi.mocked(fetchStockRawData).mockRejectedValue(
      new Error("対象 2026-09-28 の実日足が未取得です。")
    );
    vi.mocked(recordPrimaryData)
      .mockResolvedValueOnce({ pageId: "p", outcome: "recorded", fileTooLarge: true, manifestMatch: "written" })
      .mockResolvedValue({ pageId: "p", outcome: "skipped_existing", fileTooLarge: false, manifestMatch: "unknown" });
    const db = freshDb();
    seedTarget(1, "1301");
    seedTarget(2, "1332");
    // 完了パスの fileTooLarge が元例外。例外パスの同キー skip は
    // metadata-only の可能性があるため保管成功にしない。
    await expect(runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect, sendOverlayBatch: makeTxBatchSender(sqlite, { sends: 0 }) })).rejects.toThrow(
      /fileTooLarge/
    );
    expect(vi.mocked(recordPrimaryData)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(recordPriceSyncLog)).toHaveBeenCalledWith(
      "test-db",
      expect.objectContaining({ status: "失敗", tradingDate: null })
    );
  });

  it("成功時も空バッチを保管して batchKey を返す", async () => {
    vi.mocked(fetchChart).mockImplementation(chartWithRaw(sessionChart("2026-09-28")));
    vi.mocked(fetchStockRawData).mockImplementation(stockWithRaw(stockRaw(260, "2026-09-28")));
    const db = freshDb();
    seedTarget(1, "1301");
    const result = await runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect, sendOverlayBatch: makeTxBatchSender(sqlite, { sends: 0 }) });
    expect(result.failedStocks).toBe(0);
    expect(isDailySyncIncomplete(result)).toBe(false);
    expect(result.batchKey).toMatch(/^price-sync-batch-/);
    expect(vi.mocked(recordPrimaryData)).toHaveBeenCalledTimes(1);
    const input = vi.mocked(recordPrimaryData).mock.calls[0][0];
    const body = JSON.parse(
      new TextDecoder().decode(input.files![0].bytes)
    ) as { failures: unknown[] };
    expect(body.failures).toEqual([]);
  });

  it("JPX待機は実8303の主要write・Phase6・完了記録の後、以降の金融write0", async () => {
    const targetDate = "2026-10-14";
    vi.mocked(Date.now).mockReturnValue(Date.parse(`${targetDate}T10:16:00Z`));
    vi.stubEnv("STOCK_SYNC_TARGET", "scheduled-stocks"); vi.stubEnv("SCHEDULED_DATE", targetDate); vi.stubEnv("SCHEDULED_AT", `${targetDate}T10:16:00.000Z`);
    // N225/JPlegは既存harnessのtransport投影。8303金融値は保存実原本のまま。
    vi.mocked(fetchChart).mockImplementation(chartWithRaw(sessionChart(targetDate)));
    vi.spyOn(jpLegModule, "captureMacroJpLeg").mockResolvedValue({ ok: true, reason: "JP leg transport projection" });
    const bodies = JSON.parse(gunzipSync(readFileSync(new URL("../shared/yahoo/fixtures/stock-daily-scopes-20261014.json.gz", import.meta.url))).toString());
    const value = await parseSavedStockRawData("8303", saved8303Source(bodies));
    vi.mocked(fetchStockRawData).mockImplementation(stockWithRaw(value));
    const db = freshDb(); seedTarget(1, "8303"); let changesBeforeCustody: unknown;
    const diagnostic: OfficialRightsCustody = { family: "jpx-ex-rights", status: "incomplete", reason: "source", financialQualification: "unqualified", sourceCount: 1, completeSources: 0, archiveKey: null, archivePageId: null, physicalVerified: false, error: null };
    vi.mocked(collectOfficialRightsCustody).mockImplementationOnce(async () => {
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM core_stock_financials").get()).toEqual({ n: 1 });
      expect(recordPriceSyncLog).toHaveBeenCalledTimes(1); // completion is after Phase6 and the existing date guard.
      changesBeforeCustody = sqlite.prepare("SELECT total_changes() AS n").get();
      return diagnostic;
    });
    await runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect, sendOverlayBatch: makeTxBatchSender(sqlite, { sends: 0 }), jpLegStore: { get: async () => null, put: async () => { throw Error("unexpected JP write in transport projection"); } } });
    expect(collectOfficialRightsCustody).toHaveBeenCalledExactlyOnceWith("2026-10-14", expect.any(Function));
    expect(sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(changesBeforeCustody);
    const batch = vi.mocked(recordPrimaryData).mock.calls.find(([input]) => input.key.startsWith("price-sync-batch-"))![0];
    expect(JSON.parse(new TextDecoder().decode(batch.files![0].bytes)).officialRightsCustody).toEqual([diagnostic]);
  });

  it.each([[false, false], [true, false], [false, true]])("8303の旧RSI/原SHA保持、当日書込失敗=%s・fresh HOLD=%sを二重計数しない", async (saveFails, freshHold) => {
    const targetDate = freshHold ? "2026-10-15" : "2026-10-14";
    vi.mocked(Date.now).mockReturnValue(Date.parse(`${targetDate}T10:16:00Z`));
    vi.mocked(fetchChart).mockImplementation(chartWithRaw(sessionChart(targetDate)));
    const projectionBodies = JSON.parse(gunzipSync(readFileSync(new URL("../shared/yahoo/fixtures/stock-daily-scopes-20261014.json.gz", import.meta.url))).toString()) as Record<string, string>;
    const source = saved8303Source(projectionBodies);
    // 正常定時入口も同じpure builderへ接続。保存済みprojectionは原clockで解析しtransport0。
    const value = await parseSavedStockRawData("8303", source);
    const hold = value.rsiHistoryHold!;
    const snapshot = buildStockSnapshot(1, "8303", null, "2026-10-14", value, [], source.chart.capture);
    expect(snapshot).toMatchObject({ price: 1478.5, latestDate: "2026-10-14", rsiPercentile: null, rsiHistoryHold: hold });
    expect(snapshot.ohlcv6mo).toHaveLength(130);
    expect(() => buildStockSnapshot(1, "8303", null, "2026-10-15", value, [], source.chart.capture))
      .toThrow(/実日足が未取得/);
    vi.mocked(fetchStockRawData).mockImplementation(async (...args) => {
      const [symbol, , options] = args;
      for (const [api, hook] of [["chart", options?.onChartRaw], ["quote-summary", options?.onSummaryRaw]] as const) {
        await hook?.({ symbol, status: 200, bytes: new TextEncoder().encode(projectionBodies[`8303-${api}`]),
          url: `https://test.invalid/yahoo/${api}`, receivedAt: api === "chart" ? "2026-10-14T10:15:47.400Z" : "2026-10-14T10:15:48.285Z", headers: {} });
      }
      return value;
    });
    const db = freshDb(); seedTarget(1, "8303");
    sqlite.prepare("INSERT INTO rsi_percentile (stock_id, rsi_10, rsi_10_percentile, computed_at) VALUES (1, 30, 1, 1)").run();
    const pre = sqlite.prepare("SELECT * FROM rsi_percentile").get();
    if (saveFails) sqlite.exec("CREATE TRIGGER fail_stock_save BEFORE INSERT ON core_stock_financials BEGIN SELECT RAISE(ABORT, 'D1 HTTP 503 controlled save failure'); END;");
    const result = await runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect,
      sendOverlayBatch: makeTxBatchSender(sqlite, { sends: 0 }) });
    expect(result).toMatchObject({ totalStocks: 1, successStocks: 0, failedStocks: 1,
      currentUpdatedStocks: saveFails || freshHold ? 0 : 1, historyHeldStocks: freshHold ? 0 : 1 });
    expect(fetchStockRawData).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchStockRawData).mock.calls[0][2]).toMatchObject({ stockDailyScopes: true });
    expect(sqlite.prepare("SELECT * FROM rsi_percentile").get()).toEqual(pre);
    const input = vi.mocked(recordPrimaryData).mock.calls.at(-1)![0];
    const batch = JSON.parse(new TextDecoder().decode(input.files![0].bytes));
    expect(batch.stats).toEqual({ totalStocks: 1, successStocks: 0, failedStocks: 1 });
    expect(batch.currentUpdatedStocks).toBe(saveFails || freshHold ? 0 : 1);
    expect(batch.rsiHistoryHolds).toEqual(freshHold ? [] : [{ code: "8303", ...hold }]);
    expect(batch.corporateDiagnostics).toEqual([{ code: "8303", attempt: 0, expectedDate: targetDate, diagnostic: value.corporateDiagnostics }]);
    expect(batch.failures[0].error).toContain(freshHold ? "実日足が未取得" : hold.sourceSha256);
    expect(isDailySyncIncomplete(result)).toBe(true);
    if (freshHold) {
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM core_stock_financials").get()).toEqual({ n: 0 });
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM swing_stock_indicators").get()).toEqual({ n: 0 });
      return;
    }
    if (saveFails) {
      expect(batch.failures).toHaveLength(1);
      // 通常producerはretry:false。回収対象になり得る503でもcallbackへ入らず原本再取得0。
      expect(isTransientDailySyncFailure(batch.failures[0].error)).toBe(true);
      expect(batch.failures[0].error).toContain("当日書込未完");
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM core_stock_financials").get()).toEqual({ n: 0 });
      return;
    }
    const fin = sqlite.prepare("SELECT price, data_date, fetched_at FROM core_stock_financials").get();
    expect(fin).toMatchObject({ price: 1478.5, data_date: "2026-10-14", fetched_at: expect.any(Number) });
    expect(Number(fin?.fetched_at)).toBeGreaterThan(1);
    expect(Number.isInteger(fin?.fetched_at)).toBe(true);
    expect(sqlite.prepare("SELECT latest_date FROM swing_stock_indicators").get()).toEqual({ latest_date: "2026-10-14" });
    expect(sqlite.prepare("SELECT latest_adjclose, sma_25 FROM swing_stock_indicators").get())
      .toEqual({ latest_adjclose: snapshot.ohlcv6mo.at(-1)!.adj, sma_25: snapshot.sma25 });
    expect(sqlite.prepare("SELECT sma_5, sma_20, sma_75, atr_14, rsi_14, macd, macd_signal, pct_change_1d FROM swing_stock_indicators").get())
      .toEqual({ sma_5: snapshot.sma5, sma_20: snapshot.sma20, sma_75: snapshot.sma75,
        atr_14: snapshot.atr14, rsi_14: snapshot.rsi14, macd: snapshot.macd,
        macd_signal: snapshot.macdSignal, pct_change_1d: snapshot.pctChange1d });
    expect(sqlite.prepare("SELECT open, high, low, close, volume, adj FROM swing_daily_ohlcv WHERE date = '2026-10-14'").get())
      .toEqual({ open: 1481, high: 1489.5, low: 1461.5, close: 1478.5, volume: 3868600, adj: 1478.5 });
    const momentum = sqlite.prepare("SELECT as_of, bars, closes FROM p_momentum").get();
    expect(momentum).toMatchObject({ as_of: "2026-10-14", bars: 90 });
    expect(String(momentum?.closes).split(",").at(-1)).toBe("1478.5");
    // 初回は130本を保存し、既存の週次pruneで90本へ絞る (水曜はpruneしない)。
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM swing_daily_ohlcv").get()).toEqual({ n: 130 });
    expect(batch.categories.history_hold).toBe(1);
  });

  it("全inflight原本を待ち、初回原本保管/readback後だけD1をflushする", async () => {
    vi.mocked(fetchChart).mockImplementation(chartWithRaw(sessionChart("2026-09-28")));
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(fetchStockRawData).mockImplementation(async (...args) => {
      if (args[0] === "1332") await wait;
      return stockWithRaw(stockRaw(260, "2026-09-28"))(...args);
    });
    const db = freshDb(); seedTarget(1, "1301"); seedTarget(2, "1332");
    vi.mocked(archiveYahooRawBatch).mockImplementation(async (raw) => {
      if (raw.stage === "stocks-first") {
        expect(raw.captures).toHaveLength(4);
        expect(sqlite.prepare("SELECT count(*) AS n FROM swing_stock_indicators").get()).toMatchObject({ n: 0 });
      }
      return { pages: ["verified-page"], rawBytes: 1, compressedBytes: 1 };
    });
    const running = runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect, sendOverlayBatch: makeTxBatchSender(sqlite, { sends: 0 }) });
    await vi.waitFor(() => expect(fetchStockRawData).toHaveBeenCalledTimes(2));
    expect(vi.mocked(archiveYahooRawBatch).mock.calls.map(([r]) => r.stage)).toEqual(["stocks-session"]);
    release!();
    const result = await running;
    expect(result.successStocks).toBe(2);
    expect(sqlite.prepare("SELECT count(*) AS n FROM swing_stock_indicators").get()).toMatchObject({ n: 2 });
  });

  it.each(["archive unknown", "hosted SHA mismatch"])("初回 %s はD1株式write0でabort", async (reason) => {
    vi.mocked(fetchChart).mockImplementation(chartWithRaw(sessionChart("2026-09-28")));
    vi.mocked(fetchStockRawData).mockImplementation(stockWithRaw(stockRaw(260, "2026-09-28")));
    vi.mocked(archiveYahooRawBatch).mockImplementation(async (raw) => {
      if (raw.stage === "stocks-first") throw new Error(reason);
      return { pages: ["p"], rawBytes: 1, compressedBytes: 1 };
    });
    const db = freshDb(); seedTarget(1, "1301");
    await expect(runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect, sendOverlayBatch: makeTxBatchSender(sqlite, { sends: 0 }) })).rejects.toThrow(reason);
    expect(sqlite.prepare("SELECT count(*) AS n FROM core_stock_financials").get()).toMatchObject({ n: 0 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM swing_daily_ohlcv").get()).toMatchObject({ n: 0 });
    expect(fetchStockRawData).toHaveBeenCalledTimes(1);
  });

  it("session原本不明でも母集団更新は済ませ、株価write前STOP", async () => {
    vi.mocked(fetchChart).mockResolvedValue(sessionChart("2026-09-28"));
    const db = freshDb(); seedTarget(1, "1301");
    const send = makeTxBatchSender(sqlite, { sends: 0 });
    await expect(runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect, sendOverlayBatch: send })).rejects.toThrow("原本capture");
    expect(fetchStockRawData).not.toHaveBeenCalled();
    expect(vi.mocked(archiveYahooRawBatch).mock.calls[0][0]).toMatchObject({ stage: "stocks-session", captures: [], missing: [expect.objectContaining({ symbol: "^N225" })] });
    expect(sqlite.prepare("SELECT events_fetched_at AS clock FROM universe_overlay_state").get()).toMatchObject({ clock: "1970-01-01T00:00:00.000Z" });
  });

  it("parse成功でもChart/QuoteSummary capture不足は部分成功にせず全run STOP", async () => {
    vi.mocked(fetchChart).mockImplementation(chartWithRaw(sessionChart("2026-09-28")));
    vi.mocked(fetchStockRawData).mockResolvedValue(stockRaw(260, "2026-09-28"));
    const db = freshDb(); seedTarget(1, "1301"); seedTarget(2, "1332");
    await expect(runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect, sendOverlayBatch: makeTxBatchSender(sqlite, { sends: 0 }) })).rejects.toThrow("原本capture");
    expect(sqlite.prepare("SELECT count(*) AS n FROM swing_stock_indicators").get()).toMatchObject({ n: 0 });
    const first = vi.mocked(archiveYahooRawBatch).mock.calls.find(([r]) => r.stage === "stocks-first")![0];
    expect(first.captures).toEqual([]);
    expect(first.missing!.map((m) => m.api).sort()).toEqual(["chart", "quote-summary"]);
    expect(fetchStockRawData).toHaveBeenCalledTimes(1);
  });

  it("後続429でrun中断しても取得済みChartの権利診断をaborted batchへ残す", async () => {
    vi.mocked(Date.now).mockReturnValue(Date.parse("2026-10-14T10:16:00Z"));
    vi.mocked(fetchChart).mockImplementation(chartWithRaw(sessionChart("2026-10-14")));
    const bodies = JSON.parse(gunzipSync(readFileSync(new URL("../shared/yahoo/fixtures/stock-daily-scopes-20261014.json.gz", import.meta.url))).toString()) as Record<string, string>;
    const source = saved8303Source(bodies), value = await parseSavedStockRawData("8303", source);
    vi.mocked(fetchStockRawData).mockImplementationOnce(async (_code, _range, options) => {
      await options?.onChartRaw?.(source.chart.capture);
      await options?.onSummaryRaw?.(source.summary.capture);
      return value;
    }).mockRejectedValueOnce(new Error("Chart API HTTP エラー [1332]: 429 Too Many Requests"));
    const db = freshDb(); seedTarget(1, "8303"); seedTarget(2, "1332");
    await expect(runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect,
      sendOverlayBatch: makeTxBatchSender(sqlite, { sends: 0 }) })).rejects.toThrow("429");
    expect(fetchStockRawData).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare("SELECT count(*) AS n FROM swing_stock_indicators").get()).toEqual({ n: 1 });
    const input = vi.mocked(recordPrimaryData).mock.calls.at(-1)![0];
    const batch = JSON.parse(new TextDecoder().decode(input.files![0].bytes));
    expect(batch.failureCollection).toBe("aborted");
    expect(batch.corporateDiagnostics).toEqual([{ code: "8303", attempt: 0, expectedDate: "2026-10-14", diagnostic: value.corporateDiagnostics }]);
  });

  it("単一原文超過は新source GET停止/株式write0、実未取得診断を保管", async () => {
    vi.mocked(fetchChart).mockImplementation(chartWithRaw(sessionChart("2026-09-28")));
    vi.mocked(fetchStockRawData).mockRejectedValue(new YahooRawTooLargeError("1301"));
    const db = freshDb(); seedTarget(1, "1301"); seedTarget(2, "1332");
    await expect(runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect, sendOverlayBatch: makeTxBatchSender(sqlite, { sends: 0 }) })).rejects.toBeInstanceOf(YahooRawTooLargeError);
    expect(fetchStockRawData).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT count(*) AS n FROM swing_stock_indicators").get()).toMatchObject({ n: 0 });
    expect(vi.mocked(archiveYahooRawBatch).mock.calls.at(-1)![0].missing).toHaveLength(2);
  });

  it("custody待機中の21UTC到達は初回D1 write0", async () => {
    vi.mocked(fetchChart).mockImplementation(chartWithRaw(sessionChart("2026-09-28")));
    vi.mocked(fetchStockRawData).mockImplementation(stockWithRaw(stockRaw(260, "2026-09-28")));
    vi.mocked(archiveYahooRawBatch).mockImplementation(async (raw) => {
      if (raw.stage === "stocks-first") vi.mocked(Date.now).mockReturnValue(Date.parse("2026-09-28T21:00:00Z"));
      return { pages: ["p"], rawBytes: 1, compressedBytes: 1 };
    });
    const db = freshDb(); seedTarget(1, "1301");
    await expect(runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect, sendOverlayBatch: makeTxBatchSender(sqlite, { sends: 0 }) })).rejects.toThrow("21:00 UTC期限");
    expect(sqlite.prepare("SELECT count(*) AS n FROM core_stock_financials").get()).toMatchObject({ n: 0 });
  });

  it("一過性失敗は原本欠落を保管し、同runで再取得しない", async () => {
    vi.mocked(fetchChart).mockImplementation(chartWithRaw(sessionChart("2026-09-28")));
    vi.mocked(fetchStockRawData).mockRejectedValue(new Error("fetch failed"));
    const db = freshDb(); seedTarget(1, "1301"); seedTarget(2, "1332");
    const result = await runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect, sendOverlayBatch: makeTxBatchSender(sqlite, { sends: 0 }) });
    expect(fetchStockRawData).toHaveBeenCalledTimes(2);
    expect(vi.mocked(archiveYahooRawBatch).mock.calls.map(([r]) => r.stage)).toEqual(["stocks-session", "stocks-first"]);
    expect(vi.mocked(archiveYahooRawBatch).mock.calls.at(-1)![0].missing).toHaveLength(4);
    expect(result).toMatchObject({ failedStocks: 2, successStocks: 0 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM swing_stock_indicators").get()).toMatchObject({ n: 0 });
  });

  it.each([429, 503])("後続%sは新GETを止め、保管済み正常snapshotだけ保存して元例外を返す", async (status) => {
    vi.mocked(fetchChart).mockImplementation(chartWithRaw(sessionChart("2026-09-28")));
    const sourceError = new Error(`Chart API HTTP エラー [1332]: ${status} source stop`);
    vi.mocked(fetchStockRawData).mockImplementationOnce(stockWithRaw(stockRaw(260, "2026-09-28")))
      .mockRejectedValueOnce(sourceError);
    const db = freshDb(); seedTarget(1, "1301"); seedTarget(2, "1332"); seedTarget(3, "1333");
    vi.mocked(archiveYahooRawBatch).mockImplementation(async () => {
      expect(sqlite.prepare("SELECT count(*) AS n FROM swing_stock_indicators").get()).toEqual({ n: 0 });
      return { pages: ["verified-page"], rawBytes: 1, compressedBytes: 1 };
    });
    await expect(runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect, sendOverlayBatch: makeTxBatchSender(sqlite, { sends: 0 }) })).rejects.toBe(sourceError);
    expect(fetchStockRawData).toHaveBeenCalledTimes(2);
    const first = vi.mocked(archiveYahooRawBatch).mock.calls.at(-1)![0];
    expect(first.captures).toHaveLength(2);
    expect(first.missing).toHaveLength(2);
    expect(sqlite.prepare("SELECT stock_id,latest_date FROM swing_stock_indicators").all()).toEqual([{ stock_id: 1, latest_date: "2026-09-28" }]);
    expect(sqlite.prepare("SELECT stock_id,data_date FROM core_stock_financials").all()).toEqual([{ stock_id: 1, data_date: "2026-09-28" }]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM swing_daily_ohlcv").get()).toEqual({ n: 130 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM p_momentum").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM swing_sector_daily").get()).toEqual({ n: 0 });
    expect(collectOfficialRightsCustody).not.toHaveBeenCalled();
  });

  it.each(["scheduled", "manual"])("%sのsource停止でも実8303原本を閉鎖して正常金融writeを保存し、次銘柄は未取得のまま失敗する", async (mode) => {
    const db = freshDb(); seedTarget(1, "8303"); seedTarget(2, "1332");
    const date = "2026-10-14";
    const sourceStop = `${date}T${mode === "scheduled" ? "14:00:00" : "11:45:00"}.000Z`;
    vi.mocked(Date.now).mockReturnValue(Date.parse(sourceStop) - 1000);
    vi.stubEnv("STOCK_SYNC_TARGET", mode === "scheduled" ? "scheduled-stocks" : "stocks");
    if (mode === "scheduled") {
      vi.stubEnv("SCHEDULED_DATE", date);
      vi.stubEnv("SCHEDULED_AT", `${date}T09:00:00.000Z`);
    } else {
      vi.stubEnv("BATCH_JOB_STARTED_AT", `${date}T06:30:00.000Z`);
    }
    vi.mocked(fetchChart).mockImplementation(chartWithRaw(sessionChart(date)));
    vi.spyOn(jpLegModule, "captureMacroJpLeg").mockResolvedValue({ ok: true, reason: "JP leg transport projection" });
    const bodies = JSON.parse(gunzipSync(readFileSync(new URL("../shared/yahoo/fixtures/stock-daily-scopes-20261014.json.gz", import.meta.url))).toString());
    const source = saved8303Source(bodies);
    const actual = await parseSavedStockRawData("8303", source);
    vi.mocked(fetchStockRawData).mockImplementationOnce(async (...args) => {
      await stockWithRaw(actual)(...args);
      vi.mocked(Date.now).mockReturnValue(Date.parse(sourceStop));
      return actual;
    });
    await expect(runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect,
      sendOverlayBatch: makeTxBatchSender(sqlite, { sends: 0 }), jpLegStore: { get: async () => null, put: async () => {} } }))
      .rejects.toThrow("新規取得期限");
    expect(fetchStockRawData).toHaveBeenCalledTimes(1);
    expect(vi.mocked(archiveYahooRawBatch).mock.calls.at(-1)![0].stage).toBe("stocks-first");
    expect(sqlite.prepare("SELECT stock_id,data_date FROM core_stock_financials").all()).toEqual([{ stock_id: 1, data_date: date }]);
    expect(collectOfficialRightsCustody).not.toHaveBeenCalled();
  });

  it("後続429でも正常snapshotの原本保管が失敗したら株式write0", async () => {
    vi.mocked(fetchChart).mockImplementation(chartWithRaw(sessionChart("2026-09-28")));
    vi.mocked(fetchStockRawData).mockImplementationOnce(stockWithRaw(stockRaw(260, "2026-09-28")))
      .mockRejectedValueOnce(new Error("Chart API HTTP エラー [1332]: 429 Too Many Requests"));
    vi.mocked(archiveYahooRawBatch).mockImplementation(async (raw) => {
      if (raw.stage === "stocks-first") throw new Error("hosted SHA mismatch");
      return { pages: ["verified-page"], rawBytes: 1, compressedBytes: 1 };
    });
    const db = freshDb(); seedTarget(1, "1301"); seedTarget(2, "1332"); seedTarget(3, "1333");
    await expect(runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect, sendOverlayBatch: makeTxBatchSender(sqlite, { sends: 0 }) })).rejects.toThrow("hosted SHA mismatch");
    expect(fetchStockRawData).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare("SELECT count(*) AS n FROM swing_stock_indicators").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM core_stock_financials").get()).toEqual({ n: 0 });
  });

  it.each(["429 Too Many Requests", "503 Service Unavailable"])("最初の%s後は次対象の新GET/D1 write0、原文保管後STOP", async (status) => {
    vi.mocked(fetchChart).mockImplementation(chartWithRaw(sessionChart("2026-09-28")));
    vi.mocked(fetchStockRawData).mockRejectedValue(new Error(`Chart API HTTP エラー [1301]: ${status}`));
    const db = freshDb(); seedTarget(1, "1301"); seedTarget(2, "1332");
    await expect(runDailySync(db, { stocksOnly: true, collectOverlay: fakeCollect, sendOverlayBatch: makeTxBatchSender(sqlite, { sends: 0 }) })).rejects.toThrow(status);
    expect(fetchStockRawData).toHaveBeenCalledTimes(1);
    expect(vi.mocked(archiveYahooRawBatch).mock.calls.map(([r]) => r.stage)).toEqual(["stocks-session", "stocks-first"]);
    expect(vi.mocked(archiveYahooRawBatch).mock.calls.at(-1)![0].missing).toHaveLength(2);
    expect(sqlite.prepare("SELECT count(*) AS n FROM swing_stock_indicators").get()).toMatchObject({ n: 0 });
  });

});
