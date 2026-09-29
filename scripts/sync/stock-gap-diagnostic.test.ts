import { afterEach, describe, expect, it, vi } from "vitest";
import { $ZodError } from "zod/v4/core";
import { fetchChart } from "../../src/shared/yahoo/client.js";
import {
  STOCK_GAP_54_CODES,
  buildDiagBatch,
  classifyGap,
  diagBatchKey,
  findDrift,
  parseCapturedChart,
  recordDiagBatch,
  resolveFetchOutcome,
  runGapDiagnostic,
  verifyDiagBatchAttachments,
  type DiagCodeEntry,
  type GapDiagFetchResult,
} from "./stock-gap-diagnostic.js";

/**
 * Issue #163 固定 54 診断のテスト。live なし:
 * - 分類は構造 double の Chart JSON を実 parse + 実 fetchChart で検証する。
 * - custody は fetch stub (Notion GET + 署名 URL DL) で検証する。
 * - runner は fetchOne/record を注入し、54 件・drift・partial を検証する。
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

function useProxy() {
  process.env.YAHOO_PROXY_BASE = "https://kabulab.example.test";
  process.env.CRON_SECRET = "test-secret";
}

const TS = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;
const D26 = TS(2026, 9, 26);
const D28 = TS(2026, 9, 28);
const D29 = TS(2026, 9, 29);
const D30 = TS(2026, 9, 30);

interface Bar {
  ts: number;
  o: number | null;
  h: number | null;
  l: number | null;
  c: number | null;
  v: number | null;
  adj: number | null;
}
const bar = (
  ts: number,
  c: number | null,
  v: number | null = 1000,
  adj: number | null | undefined = undefined
): Bar => ({
  ts,
  o: c === null ? null : c - 1,
  h: c === null ? null : c + 1,
  l: c === null ? null : c - 2,
  c,
  v,
  adj: adj === undefined ? c : adj,
});

function chartJson(bars: Bar[], metaPrice: number | null) {
  const col = (pick: (b: Bar) => number | null) => bars.map(pick);
  return {
    chart: {
      result: [
        {
          meta: { symbol: "0000.T", regularMarketPrice: metaPrice, previousClose: null },
          timestamp: bars.map((b) => b.ts),
          indicators: {
            quote: [
              {
                open: col((b) => b.o),
                high: col((b) => b.h),
                low: col((b) => b.l),
                close: col((b) => b.c),
                volume: col((b) => b.v),
              },
            ],
            adjclose: [{ adjclose: col((b) => b.adj) }],
          },
        },
      ],
      error: null,
    },
  };
}

/** 実 fetchChart (stub 経由) で取得し、hook capture と結果を返す。 */
async function fetchOk(code: string, json: unknown): Promise<GapDiagFetchResult> {
  useProxy();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(json), { status: 200 })));
  let capture: GapDiagFetchResult["capture"] = null;
  try {
    const chart = await fetchChart(code, "5y", {
      onRaw: (c) => {
        capture = { status: c.status, bytes: c.bytes };
      },
    });
    return { capture, chart, error: null };
  } catch (e) {
    return { capture, chart: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchStatus(code: string, status: number, body: string): Promise<GapDiagFetchResult> {
  useProxy();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
  let capture: GapDiagFetchResult["capture"] = null;
  try {
    const chart = await fetchChart(code, "5y", {
      onRaw: (c) => {
        capture = { status: c.status, bytes: c.bytes };
      },
    });
    return { capture, chart, error: null };
  } catch (e) {
    return { capture, chart: null, error: e instanceof Error ? e.message : String(e) };
  }
}

describe("resolveFetchOutcome + classifyGap", () => {
  it("9/29 正値バー保持 → has_real_bar (旧 run 原因は別途 undetermined)", async () => {
    const fetched = await fetchOk("1380", chartJson([bar(D28, 100), bar(D29, 101, 2000)], 101));
    const outcome = resolveFetchOutcome({ code: "1380", ...fetched });
    expect(outcome.kind).toBe("ok");
    const r = classifyGap("1380", outcome);
    expect(r.category).toBe("has_real_bar");
    expect(r.evidence.close).toBe(101);
    expect(r.stop).toBe(false);
  });

  it("9/29 close/adj null → source_gap", async () => {
    const fetched = await fetchOk("1380", chartJson([bar(D28, 100), bar(D29, null, 0, null)], 101));
    const r = classifyGap("1380", resolveFetchOutcome({ code: "1380", ...fetched }));
    expect(r.category).toBe("source_gap");
    expect(r.evidence.reason).toBe("null-or-nonpositive-close");
    expect(r.stop).toBe(false);
  });

  it("末尾が 9/29 より前 → stale", async () => {
    const fetched = await fetchOk("9914", chartJson([bar(D26 - 86400, 100), bar(D26, 101)], 101));
    const r = classifyGap("9914", resolveFetchOutcome({ code: "9914", ...fetched }));
    expect(r.category).toBe("stale");
    expect(r.evidence.tailDate).toBe("2026-09-26");
    expect(r.stop).toBe(false);
  });

  it("9/29 のみ欠け・末尾が後 → source_gap (末尾を鮮度に使わない)", async () => {
    const fetched = await fetchOk("1380", chartJson([bar(D28, 100), bar(D30, 102)], 102));
    const r = classifyGap("1380", resolveFetchOutcome({ code: "1380", ...fetched }));
    expect(r.category).toBe("source_gap");
    expect(r.evidence.reason).toBe("bar-missing");
    expect(r.stop).toBe(false);
  });

  it("raw 9/29 正値が sanitize 棄却 → priceguard (source absent と混同しない)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetched = await fetchOk("1909", chartJson([bar(D28, 100), bar(D29, 5000, 0)], 100));
      expect(fetched.error).toBeNull();
      const r = classifyGap("1909", resolveFetchOutcome({ code: "1909", ...fetched }));
      expect(r.category).toBe("priceguard");
      expect(r.evidence.reason).toBe("sanitize-rejected");
      expect(r.stop).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("応答全体の 10 倍超乖離 throw → priceguard", async () => {
    const fetched = await fetchOk("7082", chartJson([bar(D29, 100, 0)], 5000));
    expect(fetched.error).toMatch(/10倍超乖離/);
    const r = classifyGap("7082", resolveFetchOutcome({ code: "7082", ...fetched }));
    expect(r.category).toBe("priceguard");
    expect(r.evidence.reason).toBe("response-incoherent");
    expect(r.stop).toBe(false);
  });

  it("確定 HTTP (404) → http、継続する", async () => {
    const fetched = await fetchStatus("1380", 404, "not found");
    expect(fetched.error).toMatch(/Chart API HTTP エラー/);
    const r = classifyGap("1380", resolveFetchOutcome({ code: "1380", ...fetched }));
    expect(r.category).toBe("http");
    expect(r.evidence.status).toBe(404);
    expect(r.stop).toBe(false);
  });

  it("429 → unknown で STOP する", async () => {
    const fetched = await fetchStatus("1380", 429, "rate limited");
    const r = classifyGap("1380", resolveFetchOutcome({ code: "1380", ...fetched }));
    expect(r.category).toBe("unknown");
    expect(r.evidence.reason).toBe("transient-http");
    expect(r.stop).toBe(true);
  });

  it("200 の壊れた本文 → parse", async () => {
    useProxy();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{oops", { status: 200 })));
    let capture: GapDiagFetchResult["capture"] = null;
    let error: string | null = null;
    try {
      await fetchChart("1380", "5y", {
        onRaw: (c) => {
          capture = { status: c.status, bytes: c.bytes };
        },
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const r = classifyGap("1380", resolveFetchOutcome({ code: "1380", capture, chart: null, error }));
    expect(r.category).toBe("parse");
    expect(r.evidence.reason).toBe("malformed-body");
    expect(r.stop).toBe(false);
  });

  it("200 の zod 不正 shape → parse (unknown STOP にしない)", async () => {
    const fetched = await fetchOk("1380", { chart: { result: [{}] } });
    expect(fetched.error).toBeTruthy();
    const r = classifyGap("1380", resolveFetchOutcome({ code: "1380", ...fetched }));
    expect(r.category).toBe("parse");
    expect(r.evidence.reason).toBe("malformed-body");
    expect(r.stop).toBe(false);
  });

  it("200 の Chart error payload → http (upstream 確定)", async () => {
    const fetched = await fetchOk("1380", {
      chart: { result: null, error: { code: "Not Found", description: "no data" } },
    });
    expect(fetched.error).toMatch(/Chart API エラー/);
    const r = classifyGap("1380", resolveFetchOutcome({ code: "1380", ...fetched }));
    expect(r.category).toBe("http");
    expect(r.evidence.reason).toBe("upstream-error-payload");
    expect(r.stop).toBe(false);
  });

  it("応答なし (network throw) → unknown で STOP する", async () => {
    useProxy();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("fetch failed");
    }));
    let capture: GapDiagFetchResult["capture"] = null;
    let error: string | null = null;
    try {
      await fetchChart("1380", "5y", {
        onRaw: (c) => {
          capture = { status: c.status, bytes: c.bytes };
        },
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    expect(capture).toBeNull();
    const r = classifyGap("1380", resolveFetchOutcome({ code: "1380", capture, chart: null, error }));
    expect(r.category).toBe("unknown");
    expect(r.stop).toBe(true);
  });

  it("parseCapturedChart は本番と同一 parse (zod 不正は ZodError)", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(chartJson([bar(D29, 101)], 101)));
    const bars = parseCapturedChart("1380", bytes);
    expect(bars).toHaveLength(1);
    expect(bars[0]?.date).toBe("2026-09-29");
    const bad = new TextEncoder().encode(JSON.stringify({ chart: { result: [{}] } }));
    let caught: unknown = null;
    try {
      parseCapturedChart("1380", bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf($ZodError);
  });
});

describe("findDrift", () => {
  it("一致すれば空、ずれは missing/extra で返す", () => {
    expect(findDrift([...STOCK_GAP_54_CODES])).toEqual({ missing: [], extra: [] });
    const now = [...STOCK_GAP_54_CODES.filter((c) => c !== "1380"), "9999"];
    expect(findDrift(now)).toEqual({ missing: ["1380"], extra: ["9999"] });
  });
});

describe("buildDiagBatch", () => {
  const entry = (code: string): DiagCodeEntry => ({
    code,
    httpStatus: 200,
    sha256: "a".repeat(64),
    byteLength: 10,
    category: "has_real_bar",
    reason: "positive-bar-kept",
  });

  it("key・コード別添付 + manifest・metadata を作る", () => {
    expect(diagBatchKey("run-1")).toBe("price-sync-diag-20260929-run-1");
    const raw = new TextEncoder().encode("{}");
    const batch = buildDiagBatch({
      runId: "run-1",
      fetchedAt: "2026-09-30T00:00:00.000Z",
      entries: [entry("1380")],
      unattempted: [],
      rawByCode: new Map([["1380", raw]]),
      stopped: false,
      stopReason: null,
    });
    expect(batch.key).toBe("price-sync-diag-20260929-run-1");
    expect(batch.metadata["completeness"]).toBe("complete");
    expect(batch.files.map((f) => f.filename)).toEqual([
      "1380-chart-5y.json",
      "price-sync-diag-20260929-run-1-manifest.json",
    ]);
    const manifest = JSON.parse(new TextDecoder().decode(batch.files[1]?.bytes ?? new Uint8Array())) as {
      completeness: string;
      codes: unknown[];
      unattempted: unknown[];
      priorRunCausesUndetermined: boolean;
    };
    expect(manifest.completeness).toBe("complete");
    expect(manifest.codes).toHaveLength(1);
    expect(manifest.unattempted).toHaveLength(0);
    expect(manifest.priorRunCausesUndetermined).toBe(true);
    expect(batch.metadata["codes"]).toHaveLength(54);
  });

  it("未試行があれば partial にする", () => {
    const batch = buildDiagBatch({
      runId: "run-1",
      fetchedAt: "2026-09-30T00:00:00.000Z",
      entries: [entry("1380")],
      unattempted: [{ code: "1787", reason: "run-stopped(unknown/transient-http)" }],
      rawByCode: new Map([["1380", new TextEncoder().encode("{}")]]),
      stopped: true,
      stopReason: "1380:unknown/transient-http",
    });
    expect(batch.metadata["completeness"]).toBe("partial");
    expect(batch.metadata["unattempted"]).toEqual(["1787"]);
    expect(batch.metadata["stopped"]).toBe(true);
    expect(batch.metadata["stopReason"]).toBe("1380:unknown/transient-http");
  });

  it("停止あり・未試行なし (最終コード停止) でも partial にする", () => {
    const batch = buildDiagBatch({
      runId: "run-1",
      fetchedAt: "2026-09-30T00:00:00.000Z",
      entries: [entry("2180")],
      unattempted: [],
      rawByCode: new Map([["2180", new TextEncoder().encode("{}")]]),
      stopped: true,
      stopReason: "2180:unknown/transient-http",
    });
    expect(batch.metadata["completeness"]).toBe("partial");
    expect(batch.metadata["stopped"]).toBe(true);
  });
});

describe("recordDiagBatch", () => {
  const batch = {
    key: "price-sync-diag-20260929-run-1",
    source: "test",
    metadata: {},
    files: [{ filename: "m.json", bytes: new TextEncoder().encode("{}"), contentType: "application/json" }],
  };

  it("recorded のみ受理し、fileTooLarge・非 recorded は throw する", async () => {
    const ok = vi.fn(async () => ({ pageId: "diag-page", outcome: "recorded", fileTooLarge: false }));
    await expect(recordDiagBatch(batch, "2026-09-30T00:00:00.000Z", ok as never)).resolves.toEqual({
      pageId: "diag-page",
      key: batch.key,
    });
    expect(ok).toHaveBeenCalledWith(
      expect.objectContaining({ service: "stock-sync", key: batch.key, force: false })
    );
    const tooLarge = vi.fn(async () => ({ pageId: "p", outcome: "recorded", fileTooLarge: true }));
    await expect(recordDiagBatch(batch, "2026-09-30T00:00:00.000Z", tooLarge as never)).rejects.toThrow(
      /fileTooLarge/
    );
    const skipped = vi.fn(async () => ({ pageId: "p", outcome: "skipped_existing", fileTooLarge: false }));
    await expect(recordDiagBatch(batch, "2026-09-30T00:00:00.000Z", skipped as never)).rejects.toThrow(
      /outcome=skipped_existing/
    );
  });
});

describe("verifyDiagBatchAttachments", () => {
  function jsonResponse(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => body,
      text: async () => JSON.stringify(body),
      arrayBuffer: async () =>
        new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body)).buffer as ArrayBuffer,
    } as Response;
  }

  const pageId = "diag-page";
  const files = [
    { filename: "1380-chart-5y.json", bytes: new TextEncoder().encode("chart-bytes"), contentType: "application/json" },
    { filename: "k-manifest.json", bytes: new TextEncoder().encode("manifest-bytes"), contentType: "application/json" },
  ];
  const pageWith = (entries: unknown[]) => ({
    properties: { Files: { type: "files", files: entries } },
  });
  const hosted = (name: string) => ({
    name,
    type: "file",
    file: { url: `https://files.example.test/${name}` },
  });

  function stubFetch(pageEntries: unknown[], downloads: Record<string, string>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = new URL(String(url));
        if (u.pathname === `/v1/pages/${pageId}`) return jsonResponse(pageWith(pageEntries));
        const body = downloads[u.pathname.slice(1)];
        if (body === undefined) throw new Error(`未定義ルート: ${u.pathname}`);
        return jsonResponse(body);
      })
    );
  }

  it("件数・名前・hosted・全 bytes が一致すれば通る", async () => {
    process.env.NOTION_TOKEN = "dummy";
    stubFetch([hosted("1380-chart-5y.json"), hosted("k-manifest.json")], {
      "1380-chart-5y.json": "chart-bytes",
      "k-manifest.json": "manifest-bytes",
    });
    await expect(verifyDiagBatchAttachments(pageId, files)).resolves.toBeUndefined();
  });

  it("件数短縮・SHA 不一致は HOLD する", async () => {
    process.env.NOTION_TOKEN = "dummy";
    stubFetch([hosted("1380-chart-5y.json")], { "1380-chart-5y.json": "chart-bytes" });
    await expect(verifyDiagBatchAttachments(pageId, files)).rejects.toThrow(/添付 1 件 ≠ 記録 2 件/);
    stubFetch([hosted("1380-chart-5y.json"), hosted("k-manifest.json")], {
      "1380-chart-5y.json": "chart-bytex",
      "k-manifest.json": "manifest-bytes",
    });
    await expect(verifyDiagBatchAttachments(pageId, files)).rejects.toThrow(/SHA256 不一致/);
  });
});

describe("runGapDiagnostic", () => {
  const okBytes = () =>
    new TextEncoder().encode(JSON.stringify(chartJson([bar(D28, 100), bar(D29, 101, 2000)], 101)));

  const okFetchOne = vi.fn(async (code: string): Promise<GapDiagFetchResult> => {
    const bytes = okBytes();
    const rawBars = parseCapturedChart(code, bytes);
    return {
      capture: { status: 200, bytes },
      chart: { symbol: code, price: 101, previousClose: 100, dataDate: "2026-09-29", ohlcv: rawBars },
      error: null,
    };
  });

  function stubVerifyDownloads(recordedFiles: { filename: string; bytes: Uint8Array }[]) {
    const downloads: Record<string, string> = {};
    const entries = recordedFiles.map((f) => {
      downloads[f.filename] = new TextDecoder().decode(f.bytes);
      return {
        name: f.filename,
        type: "file",
        file: { url: `https://files.example.test/${f.filename}` },
      };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = new URL(String(url));
        if (u.pathname === "/v1/pages/diag-page") {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ properties: { Files: { type: "files", files: entries } } }),
          } as Response;
        }
        const body = downloads[u.pathname.slice(1)];
        if (body === undefined) throw new Error(`未定義ルート: ${u.pathname}`);
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
        } as Response;
      })
    );
  }

  it("drift があれば 1 GET もせず STOP する", async () => {
    const fetchOne = vi.fn(async (): Promise<GapDiagFetchResult> => {
      throw new Error("呼ばれてはならない");
    });
    const record = vi.fn(async () => ({ pageId: "p", outcome: "recorded", fileTooLarge: false }));
    const now = [...STOCK_GAP_54_CODES.filter((c) => c !== "1380")];
    await expect(runGapDiagnostic(now, "run-1", { fetchOne, record: record as never })).rejects.toThrow(
      /drift/
    );
    expect(fetchOne).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("54 件全件を complete 保管し、manifest と readback が一致する", async () => {
    process.env.NOTION_TOKEN = "dummy";
    okFetchOne.mockClear();
    const seen: {
      current: {
        key: string;
        metadata: Record<string, unknown>;
        files: { filename: string; bytes: Uint8Array }[];
      } | null;
    } = { current: null };
    const record = vi.fn(
      async (input: {
        key: string;
        metadata: Record<string, unknown>;
        files: { filename: string; bytes: Uint8Array }[];
      }) => {
        seen.current = { key: input.key, metadata: input.metadata, files: input.files };
        stubVerifyDownloads(seen.current.files);
        return { pageId: "diag-page", outcome: "recorded", fileTooLarge: false };
      }
    );
    const report = await runGapDiagnostic(
      [...STOCK_GAP_54_CODES],
      "run-1",
      { fetchOne: okFetchOne, record: record as never },
      () => "2026-09-30T00:00:00.000Z"
    );
    expect(okFetchOne).toHaveBeenCalledTimes(54);
    expect(report.completeness).toBe("complete");
    expect(report.stopped).toBe(false);
    expect(report.stopReason).toBeNull();
    expect(report.attempted).toBe(54);
    expect(report.categories.has_real_bar).toBe(54);
    expect(report.unattempted).toHaveLength(0);
    expect(report.priorRunCausesUndetermined).toBe(true);
    expect(record).toHaveBeenCalledTimes(1);
    expect(seen.current?.key).toBe("price-sync-diag-20260929-run-1");
    expect(seen.current?.files).toHaveLength(55);
    expect(seen.current?.metadata["completeness"]).toBe("complete");
    expect(seen.current?.metadata["perCode"] as unknown[]).toHaveLength(54);
  });

  it("429 は取得済み分を partial 保管し、残りを unknown 未試行で止める", async () => {
    process.env.NOTION_TOKEN = "dummy";
    const calls: string[] = [];
    const fetchOne = vi.fn(async (code: string): Promise<GapDiagFetchResult> => {
      calls.push(code);
      const bytes = okBytes();
      if (calls.length < 3) {
        const rawBars = parseCapturedChart(code, bytes);
        return {
          capture: { status: 200, bytes },
          chart: { symbol: code, price: 101, previousClose: 100, dataDate: "2026-09-29", ohlcv: rawBars },
          error: null,
        };
      }
      const errBytes = new TextEncoder().encode("rate limited");
      return {
        capture: { status: 429, bytes: errBytes },
        chart: null,
        error: `Chart API HTTP エラー [${code}]: 429 Too Many Requests; source=ingest-proxy`,
      };
    });
    const seen: {
      current: {
        metadata: Record<string, unknown>;
        files: { filename: string; bytes: Uint8Array }[];
      } | null;
    } = { current: null };
    const record = vi.fn(
      async (input: {
        metadata: Record<string, unknown>;
        files: { filename: string; bytes: Uint8Array }[];
      }) => {
        seen.current = { metadata: input.metadata, files: input.files };
        stubVerifyDownloads(seen.current.files);
        return { pageId: "diag-page", outcome: "recorded", fileTooLarge: false };
      }
    );
    const report = await runGapDiagnostic(
      [...STOCK_GAP_54_CODES],
      "run-1",
      { fetchOne, record: record as never },
      () => "2026-09-30T00:00:00.000Z"
    );
    expect(calls).toHaveLength(3);
    expect(report.completeness).toBe("partial");
    expect(report.stopped).toBe(true);
    expect(report.stopReason).toBe("1905:unknown/transient-http");
    expect(report.attempted).toBe(3);
    expect(report.categories.unknown).toBe(1);
    expect(report.unattempted).toHaveLength(51);
    expect(seen.current?.metadata["completeness"]).toBe("partial");
    // 取得済み 3 件 (429 本文含む) + manifest の 4 添付。
    expect(seen.current?.files).toHaveLength(4);
  });

  it("最終 2180 の 429 でも partial + STOP にする (complete 誤判定の回帰)", async () => {
    process.env.NOTION_TOKEN = "dummy";
    const fetchOne = vi.fn(async (code: string): Promise<GapDiagFetchResult> => {
      if (code !== "2180") {
        const bytes = okBytes();
        const rawBars = parseCapturedChart(code, bytes);
        return {
          capture: { status: 200, bytes },
          chart: { symbol: code, price: 101, previousClose: 100, dataDate: "2026-09-29", ohlcv: rawBars },
          error: null,
        };
      }
      return {
        capture: { status: 429, bytes: new TextEncoder().encode("rate limited") },
        chart: null,
        error: "Chart API HTTP エラー [2180]: 429 Too Many Requests; source=ingest-proxy",
      };
    });
    const seen: {
      current: {
        metadata: Record<string, unknown>;
        files: { filename: string; bytes: Uint8Array }[];
      } | null;
    } = { current: null };
    const record = vi.fn(
      async (input: {
        metadata: Record<string, unknown>;
        files: { filename: string; bytes: Uint8Array }[];
      }) => {
        seen.current = { metadata: input.metadata, files: input.files };
        stubVerifyDownloads(seen.current.files);
        return { pageId: "diag-page", outcome: "recorded", fileTooLarge: false };
      }
    );
    const report = await runGapDiagnostic(
      [...STOCK_GAP_54_CODES],
      "run-1",
      { fetchOne, record: record as never },
      () => "2026-09-30T00:00:00.000Z"
    );
    expect(fetchOne).toHaveBeenCalledTimes(54);
    // 未試行は空だが停止したので partial (CLI は exit 1)。complete 誤判定しない。
    expect(report.unattempted).toHaveLength(0);
    expect(report.completeness).toBe("partial");
    expect(report.stopped).toBe(true);
    expect(report.stopReason).toBe("2180:unknown/transient-http");
    expect(report.attempted).toBe(54);
    expect(report.categories.unknown).toBe(1);
    expect(seen.current?.metadata["completeness"]).toBe("partial");
    expect(seen.current?.metadata["stopReason"]).toBe("2180:unknown/transient-http");
    expect(seen.current?.files).toHaveLength(55);
  });

  it("保管失敗は runner を失敗させる (成功に偽らない)", async () => {
    const fetchOne = vi.fn(async (code: string): Promise<GapDiagFetchResult> => {
      const bytes = okBytes();
      const rawBars = parseCapturedChart(code, bytes);
      return {
        capture: { status: 200, bytes },
        chart: { symbol: code, price: 101, previousClose: 100, dataDate: "2026-09-29", ohlcv: rawBars },
        error: null,
      };
    });
    const record = vi.fn(async () => {
      throw new Error("Notion 書込失敗");
    });
    await expect(
      runGapDiagnostic([...STOCK_GAP_54_CODES], "run-1", { fetchOne, record: record as never })
    ).rejects.toThrow(/Notion 書込失敗/);
  });
});
