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
import { drizzle } from "drizzle-orm/sqlite-proxy";
import {
  _resetBatchRunIdForTests,
  archivePriceSyncBatch,
  buildPriceSyncBatch,
  categorizeSyncFailure,
  isDailySyncIncomplete,
  priceSyncBatchKey,
  priceSyncBatchRunId,
  runDailySync,
  type PriceSyncBatchInput,
} from "./daily.js";
import { fetchChart, fetchStockRawData } from "../shared/yahoo/client.js";
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
  it("実 reason から4分類する (一律 genuine にしない)", () => {
    expect(
      categorizeSyncFailure("1301: 対象 2026-09-28 の実日足が未取得です。古い日の指標を書き直しません。")
    ).toBe("genuine_source_gap");
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
    expect(body.categories).toMatchObject({ genuine_source_gap: 25 });
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
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split("--> statement-breakpoint")) {
      if (stmt.trim()) sqlite.exec(stmt);
    }
  }
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

describe("runDailySync 配線: 保管してから return/throw", () => {
  afterEach(() => {
    sqlite?.close();
  });

  it("例外時は元例外を保持し aborted バッチ (null 件数) を保管する", async () => {
    vi.mocked(fetchChart).mockResolvedValue(sessionChart("2026-09-25"));
    const db = freshDb();
    await expect(runDailySync(db, { stocksOnly: true })).rejects.toThrow(
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

  it("閾値超過の失敗でも結果 return 前に全件バッチを保管する (CLI throw の前)", async () => {
    vi.mocked(fetchChart).mockResolvedValue(sessionChart("2026-09-28"));
    vi.mocked(fetchStockRawData).mockRejectedValue(
      new Error("対象 2026-09-28 の実日足が未取得です。")
    );
    const db = freshDb();
    seedTarget(1, "1301");
    seedTarget(2, "1332");
    const result = await runDailySync(db, { stocksOnly: true });
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
    expect(body.categories).toMatchObject({ genuine_source_gap: 2 });
  });

  it("完了保管 fileTooLarge→例外同キー skip でも保管成功を偽らない (元例外で非0)", async () => {
    vi.mocked(fetchChart).mockResolvedValue(sessionChart("2026-09-28"));
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
    await expect(runDailySync(db, { stocksOnly: true })).rejects.toThrow(
      /fileTooLarge/
    );
    expect(vi.mocked(recordPrimaryData)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(recordPriceSyncLog)).toHaveBeenCalledWith(
      "test-db",
      expect.objectContaining({ status: "失敗", tradingDate: null })
    );
  });

  it("成功時も空バッチを保管して batchKey を返す", async () => {
    vi.mocked(fetchChart).mockResolvedValue(sessionChart("2026-09-28"));
    vi.mocked(fetchStockRawData).mockResolvedValue(stockRaw(260, "2026-09-28"));
    const db = freshDb();
    seedTarget(1, "1301");
    const result = await runDailySync(db, { stocksOnly: true });
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
});
