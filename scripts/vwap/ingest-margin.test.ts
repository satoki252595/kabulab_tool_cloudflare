/**
 * scripts/vwap/ingest-margin.ts (日次) のテスト。
 *
 * トップレベル実行は `process.argv[1] === fileURLToPath(import.meta.url)` で
 * ガードされているため (import だけでは main() が走らない)、このテストは
 * 安全にモジュールを import できる。main() の順序テストは依存を vi.doMock
 * で差し替える (scripts/moneyflow/ingest.ts と同方式)。
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mergeDailyMarginDates,
  parseDateArg,
  planDailyMarginPuts,
} from "./ingest-margin.js";

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

describe("planDailyMarginPuts", () => {
  it("同値スナップショット + 同値 index は PUT0", () => {
    expect(planDailyMarginPuts("{}", "{}", ["2026-09-28"], ["2026-09-28"])).toEqual({
      putSnapshot: false,
      putDates: false,
    });
  });

  it("初回 (既存なし) は両方 PUT", () => {
    expect(planDailyMarginPuts(null, "{}", [], ["2026-09-28"])).toEqual({
      putSnapshot: true,
      putDates: true,
    });
  });

  it("部分一致は差分だけ PUT する", () => {
    expect(planDailyMarginPuts("{}", "{}", ["2026-09-25"], ["2026-09-25", "2026-09-28"])).toEqual({
      putSnapshot: false,
      putDates: true,
    });
    expect(planDailyMarginPuts("{}", '{"a":1}', ["2026-09-28"], ["2026-09-28"])).toEqual({
      putSnapshot: true,
      putDates: false,
    });
  });
});

describe("main (検証 → 原本保管 → 実体確認 → R2 PUT の順序)", () => {
  const ORIGINAL_ARGV = [...process.argv];
  const PDF = new Uint8Array([1, 2, 3]);
  const PDF_SHA = createHash("sha256").update(PDF).digest("hex");
  const FILENAME = "margin-daily-2026-09-28.pdf";

  afterEach(() => {
    process.argv = [...ORIGINAL_ARGV];
    vi.doUnmock("../../services/vwap-analysis/lib/margin.js");
    vi.doUnmock("../../services/vwap-analysis/lib/margin-daily.js");
    vi.doUnmock("../../src/shared/notion-archive/index.js");
    vi.doUnmock("./lib/r2.js");
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  interface RunOpts {
    archiveImpl?: () => Promise<unknown>;
    /** r2 の初期内容。 */
    seed?: Record<string, string>;
    /** 保管実体 fullDL が返すバイト列。未指定なら PDF と同一。 */
    custodyBytes?: Uint8Array;
    /** 保管実体の添付名。未指定なら FILENAME。null なら添付なし。 */
    custodyName?: string | null;
    /** 保管 Files の全添付を直接指定 (複数・外部の検査用)。 */
    custodyFiles?: Array<{ name: string; url: string; kind: "file" | "external" }>;
    /** 単一添付の kind。未指定なら file。 */
    custodyKind?: "file" | "external";
    /** true なら snapshot の readback を破損させる。 */
    corruptReadback?: boolean;
    /** true なら dates.json の readback を破損させる。 */
    corruptDatesReadback?: boolean;
  }

  async function runMain(opts: RunOpts = {}) {
    vi.resetModules();
    process.argv = ["node", "ingest-margin.js"];
    const order: string[] = [];
    const data = {
      snapshot: {
        format: "jpx-margin-daily-v1",
        basisDate: "2026-09-28",
        publicationDate: "2026-09-29",
        sourceUrl: "https://www.jpx.co.jp/x.pdf",
        rawSha256: PDF_SHA,
        rawPageId: null,
        rows: [],
        totals: [],
      },
      pdfBytes: PDF,
      pdfUrl: "https://www.jpx.co.jp/x.pdf",
    };
    vi.doMock("../../services/vwap-analysis/lib/margin.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../services/vwap-analysis/lib/margin.js")>();
      return {
        ...actual,
        fetchDailyMargin: vi.fn(async () => data),
        dailyMarginArchiveInput: vi.fn(
          () => ({ key: "k", files: [{ filename: FILENAME }] }) as never
        ),
      };
    });
    const recordPrimaryData = vi.fn(async () => {
      order.push("archive");
      return opts.archiveImpl ? opts.archiveImpl() : { pageId: "p1", fileTooLarge: false };
    });
    const listPageFiles = vi.fn(async () => {
      if (opts.custodyFiles !== undefined) return opts.custodyFiles;
      if (opts.custodyName === null) return [];
      return [{ name: opts.custodyName ?? FILENAME, url: "https://example.invalid/f", kind: opts.custodyKind ?? "file" }];
    });
    vi.doMock("../../src/shared/notion-archive/index.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../src/shared/notion-archive/index.js")>();
      return { ...actual, recordPrimaryData, listPageFiles };
    });
    const store = new Map<string, string>(Object.entries(opts.seed ?? {}));
    const r2Get = vi.fn(async (key: string) => {
      order.push(`get:${key}`);
      if (opts.corruptReadback && key === "margin/daily/2026-09-28.json" && store.has(key)) {
        const gets = order.filter((o) => o === `get:${key}`).length;
        if (gets >= 2) return '{"corrupted":true}';
      }
      if (opts.corruptDatesReadback && key === "margin/dates.json" && store.has(key)) {
        const gets = order.filter((o) => o === `get:${key}`).length;
        if (gets >= 2) return '["1999-01-01"]';
      }
      return store.has(key) ? (store.get(key) as string) : null;
    });
    const r2Put = vi.fn(async (key: string, body: string) => {
      order.push(`r2:${key}`);
      store.set(key, body);
    });
    vi.doMock("./lib/r2.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./lib/r2.js")>();
      return { ...actual, r2Get, r2Put };
    });
    // 検証は純粋パーサのテストで担保済み。ここでは順序だけ見る。
    vi.doMock("../../services/vwap-analysis/lib/margin-daily.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../services/vwap-analysis/lib/margin-daily.js")>();
      return { ...actual, validateDailyMarginSnapshot: vi.fn() };
    });
    const dlBytes = opts.custodyBytes ?? PDF;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ arrayBuffer: async () => new Uint8Array(dlBytes).buffer as ArrayBuffer }))
    );
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let rejected: unknown = null;
    try {
      const mod = await import("./ingest-margin.js");
      await mod.main();
    } catch (e) {
      rejected = e;
    }
    const infoCalls = info.mock.calls.map((c) => String(c[0]));
    info.mockRestore();
    return { order, r2Put, recordPrimaryData, infoCalls, data, rejected };
  }

  it("原本保管が全 R2 PUT より先、dates.json は全 PUT より先に読む", async () => {
    const { order, rejected } = await runMain({
      seed: { "margin/dates.json": JSON.stringify(["2026-09-25"]) },
    });
    expect(rejected).toBeNull();
    expect(order).toEqual([
      "get:margin/dates.json",
      "archive",
      "get:margin/daily/2026-09-28.json",
      "r2:margin/daily/2026-09-28.json",
      "get:margin/daily/2026-09-28.json",
      "r2:margin/dates.json",
      "get:margin/dates.json",
    ]);
  });

  it("保管に失敗したら R2 へ何も保存しない (部分保存なし)", async () => {
    const { r2Put, rejected } = await runMain({
      archiveImpl: async () => {
        throw new Error("archive down");
      },
    });
    expect(String(rejected)).toMatch(/archive down/);
    expect(r2Put).not.toHaveBeenCalled();
  });

  it("fileTooLarge (metadata-only) は STOP し R2 へ何も保存しない", async () => {
    const { r2Put, rejected } = await runMain({
      archiveImpl: async () => ({ pageId: "p1", fileTooLarge: true }),
    });
    expect(String(rejected)).toMatch(/metadata-only/);
    expect(r2Put).not.toHaveBeenCalled();
  });

  it("同値再入は PUT0 する", async () => {
    const snap = {
      format: "jpx-margin-daily-v1",
      basisDate: "2026-09-28",
      publicationDate: "2026-09-29",
      sourceUrl: "https://www.jpx.co.jp/x.pdf",
      rawSha256: PDF_SHA,
      rawPageId: "p1",
      rows: [],
      totals: [],
    };
    const { r2Put, infoCalls, rejected } = await runMain({
      seed: {
        "margin/daily/2026-09-28.json": JSON.stringify(snap),
        "margin/dates.json": JSON.stringify(["2026-09-25", "2026-09-28"]),
      },
    });
    expect(rejected).toBeNull();
    expect(r2Put).not.toHaveBeenCalled();
    expect(infoCalls.join("\n")).toMatch(/PUT0/);
  });

  it("保管実体の SHA が合わなければ STOP する", async () => {
    const { r2Put, rejected } = await runMain({ custodyBytes: new Uint8Array([9, 9, 9]) });
    expect(String(rejected)).toMatch(/SHA 不一致/);
    expect(r2Put).not.toHaveBeenCalled();
  });

  it("保管実体の添付がなければ STOP する (過去の metadata-only 再入を含む)", async () => {
    const { r2Put, rejected } = await runMain({ custodyName: null });
    expect(String(rejected)).toMatch(/添付数が異常/);
    expect(r2Put).not.toHaveBeenCalled();
  });

  it("Files が複数添付なら STOP する (先頭だけ見て通さない)", async () => {
    const { r2Put, rejected } = await runMain({
      custodyFiles: [
        { name: FILENAME, url: "https://example.invalid/f", kind: "file" },
        { name: "extra.pdf", url: "https://example.invalid/x", kind: "file" },
      ],
    });
    expect(String(rejected)).toMatch(/添付数が異常/);
    expect(r2Put).not.toHaveBeenCalled();
  });

  it("外部リンク添付は STOP する (hosted 要求)", async () => {
    const { r2Put, rejected } = await runMain({ custodyKind: "external" });
    expect(String(rejected)).toMatch(/外部添付/);
    expect(r2Put).not.toHaveBeenCalled();
  });

  it("dates.json が配列でなければ STOP する", async () => {
    const { r2Put, rejected } = await runMain({
      seed: { "margin/dates.json": '{"a":1}' },
    });
    expect(String(rejected)).toMatch(/形状が不正/);
    expect(r2Put).not.toHaveBeenCalled();
  });

  it("R2 readback が一致しなければ STOP する", async () => {
    const { rejected } = await runMain({
      seed: { "margin/dates.json": JSON.stringify(["2026-09-25"]) },
      corruptReadback: true,
    });
    expect(String(rejected)).toMatch(/readback 不一致/);
  });

  it("dates.json の readback が一致しなければ STOP する", async () => {
    const { rejected } = await runMain({
      seed: { "margin/dates.json": JSON.stringify(["2026-09-25"]) },
      corruptDatesReadback: true,
    });
    expect(String(rejected)).toMatch(/dates\.json readback 不一致/);
  });
});
