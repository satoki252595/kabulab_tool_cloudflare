/**
 * EDINET 日次 catchup の応答契約テスト (Sol HOLD2)。
 *
 * 一覧の取得失敗は result に集計し、非成功終了する。
 * 取込例外 (物理保管失敗を含む) は次の文書・L2 に進まず throw。母集団外・既取込は正当結果。cap/保留は非成功で次回再開。
 * 外部 (EDINET / 取込本体) は vi.mock で塞ぎ、D1 は本番と同じ
 * migration を流した in-memory SQLite に向ける (ingest-universe と同一方式)。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { ROOT } from "../shared/db/tests/source-scan.js";
import { INSTRUMENT_TYPES } from "../shared/jpx/instrument-type.js";
import { enqueueDates } from "../../services/yuho-quant/src/services/edinet/catchup-progress.js";
import * as reportedChanges from "../../services/yuho-quant/src/services/edinet/reported-changes.js";
import { listDocuments, EdinetListFetchError, EdinetDocumentFetchError } from "../../services/yuho-quant/src/services/edinet/client.js";
import { captureListSnapshot, EdinetListQualificationError } from "../../services/yuho-quant/src/services/edinet/list-snapshot.js";
import { ingestDocument } from "../../services/yuho-quant/src/services/ingest.js";
import { ExistingTextReadbackMismatchError } from "../../services/yuho-quant/src/services/text-backup.js";
import { rebuildYuhoGrowthProjection } from "../../services/yuho-quant/src/services/projection.js";
import { checkDocsCustody } from "../../services/yuho-quant/src/services/edinet/archive.js";
import { resumePendingShareholdings, resumePendingShareholdingsPrices, type HoldingPriceSourceLoader } from "../shared/notion-archive/shareholdings.js";
import type { ShareholdingsNotApplicable } from "../../services/yuho-quant/src/services/edinet/shareholdings.js";
import type { Database as YuhoDatabase } from "../../services/yuho-quant/src/db/client.js";
import {
  catchupHttpStatus,
  runYuhoEdinetCatchup,
} from "./yuho-edinet.js";

vi.mock("../../services/yuho-quant/src/services/edinet/client.js", () => ({
  listDocuments: vi.fn(),
  EdinetListFetchError: class EdinetListFetchError extends Error {},
  EdinetDocumentFetchError: class EdinetDocumentFetchError extends Error {
    constructor(_docId: string, _type: number, message: string) {super(message);}
  },
}));
vi.mock("../../services/yuho-quant/src/services/edinet/list-snapshot.js", async () => {
  const client = await import("../../services/yuho-quant/src/services/edinet/client.js");
  const original = await vi.importActual<typeof import("../../services/yuho-quant/src/services/edinet/list-snapshot.js")>("../../services/yuho-quant/src/services/edinet/list-snapshot.js");
  const saved = new Map<string, unknown>();
  return {...original, captureListSnapshot: vi.fn(async (date: string) => {
    const fixture = await client.listDocuments(date);
    // Declared protocol envelope: older tests supplied results only; production captures the full typed HTTP body.
    const list = {...fixture, metadata: { status: "200", resultset: { count: fixture.results.length } }};
    const pageId = `00000000-0000-4000-8000-${date.replaceAll("-", "").padStart(12,"0")}`;
    saved.set(pageId, list);
    return {list, snapshot: {date, pageId, filename: `edinet-list-${date}.json.gz`,
      gzipSha256: "0".repeat(64), rawSha256: "0".repeat(64), rawBytes: 1, httpStatus: 200, qualified: true,
      fetchedAt: new Date().toISOString()}};
  }), readListSnapshot: vi.fn(async (snapshot: {pageId: string}) => {
    if (!saved.has(snapshot.pageId)) throw new Error("snapshot missing");
    return saved.get(snapshot.pageId);
  })};
});
vi.mock("../../services/yuho-quant/src/services/ingest.js", () => ({
  ingestDocument: vi.fn(),
}));
vi.mock("../shared/notion-archive/shareholdings.js", async original => ({
  ...await original<typeof import("../shared/notion-archive/shareholdings.js")>(),
  resumePendingShareholdings: vi.fn(async () => ({ usedRows: 0, resumed: 0, held: 0, pending: false })),
  resumePendingShareholdingsPrices: vi.fn(async () => ({ usedRows: 0, resumed: 0, held: 0, pending: false, review: { scope: "initial-attention-sample-and-selected-window" as const, attentionHasMore: false, attentionSample: [], queueSize: 0, queueHasMore: false, queuedSourcePageIds: [], sources: [] } })),
}));
vi.mock("../../services/yuho-quant/src/services/edinet/archive.js", () => ({
  checkDocsCustody: vi.fn(async () => new Map()),
}));

vi.mock("../../services/yuho-quant/src/services/projection.js", () => ({
  rebuildYuhoGrowthProjection: vi.fn(async () => ({stocks: 0})),
}));

function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split("--> statement-breakpoint")) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

function makeProxyDb(target: DatabaseSync) {
  return drizzle(async (sqlStr, params, method) => {
    const stmt = target.prepare(sqlStr);
    const bind = params as (null | number | bigint | string | Uint8Array)[];
    if (method === "run") {
      stmt.run(...bind);
      return { rows: [] };
    }
    const rows = (stmt.all(...bind) as Record<string, unknown>[]).map((o) => Object.values(o));
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  });
}

let sqlite: DatabaseSync;
let db: ReturnType<typeof makeProxyDb>;

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
  sqlite
    .prepare(
      "INSERT INTO core_stocks (id, code, name, market, is_active, instrument_type) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(1, "7203", "テスト7203", "テスト市場", 1, INSTRUMENT_TYPES.equity);
  db = makeProxyDb(sqlite);
});

const annualDoc = (code: string) => ({
  seqNumber: 1,
  withdrawalStatus: "0",
  docID: `S100${code}`,
  secCode: `${code}0`,
  ordinanceCode: "010",
  docTypeCode: "120",
  formCode: "030000",
  filerName: `テスト${code}`,
});

async function runCatchup(now?: Date, priceLoader?: HoldingPriceSourceLoader, deadlineMs?: number, sourceStartDeadlineMs?: number) {
  // 本体は sleep を挟む (60 日分)。setTimeout だけ偽物にして進める。
  vi.useFakeTimers({ toFake: now ? ["setTimeout", "Date"] : ["setTimeout"] });
  if (now) vi.setSystemTime(now);
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const running = runYuhoEdinetCatchup(db as unknown as YuhoDatabase, undefined, undefined, priceLoader, deadlineMs,
      sourceStartDeadlineMs === undefined ? undefined : { observeIssuedShares: true, sourceStartDeadlineMs });
    const settled = running.then(value => ({value}), error => ({error}));
    await vi.runAllTimersAsync();
    const outcome = await settled;
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  } finally {
    vi.useRealTimers();
    info.mockRestore();
    err.mockRestore();
  }
}

describe("catchup 応答契約: 実失敗だけ非 2xx", () => {
  it("同日照合済みの実15IDのHOLDはqueue0でも消さず、未完内訳を出して500を保つ", async () => {
    // Saved official EDINET list metadata (2026-08-14〜09-30). This is a
    // conditional checkpoint-state regression, not a fresh production read.
    const held = [
      ["2026-08-14", ["S100YWCV"]],
      ["2026-08-28", ["S100YZ7E", "S100YZ9G", "S100YXGH", "S100YYYH"]],
      ["2026-09-25", ["S100Z3CI", "S100Z43C"]],
      ["2026-09-29", ["S100Z4R8", "S100Z3IX", "S100Z4UN", "S100Z4J5"]],
      ["2026-09-30", ["S100Z57K", "S100Z590", "S100Z5CH", "S100Z5HU"]],
    ] as const;
    await enqueueDates(db as unknown as YuhoDatabase, "main", "2026-10-14");
    sqlite.exec("UPDATE yuho_edinet_catchup_progress SET finished=1,sealed=1");
    for (const [date, ids] of held) {
      sqlite.prepare("INSERT INTO yuho_edinet_catchup_progress(scope,date,finished,sealed,pending_ids,pending_checked_date) VALUES ('main',?,1,1,?,'2026-10-14') ON CONFLICT(scope,date) DO UPDATE SET pending_ids=excluded.pending_ids,pending_checked_date=excluded.pending_checked_date")
        .run(date, JSON.stringify(ids.map(docId => ({docId, reason: "identity_unresolved"}))));
    }
    sqlite.exec("UPDATE yuho_edinet_catchup_progress SET sealed=0 WHERE date='2026-10-14'");
    const before = sqlite.prepare("SELECT * FROM yuho_edinet_catchup_progress ORDER BY date").all();
    vi.mocked(resumePendingShareholdings).mockResolvedValueOnce({usedRows: 0, resumed: 0, held: 1, pending: false});
    vi.mocked(rebuildYuhoGrowthProjection).mockResolvedValueOnce({stocks: 1407} as never);
    const result = await runCatchup(new Date("2026-10-14T13:46:32.476Z"));
    expect(result).toMatchObject({scannedDays: 0, matched: 0, ingested: 0, pendingDocuments: 15,
      reachedCap: true, projectionStocks: 1407, byStatus: {"holdings:requires_review": 1},
      sourceProgress: {queuedAtStart: 0, pendingDocuments: 15, queuedDays: 0,
        pendingRecheckDueDays: 0, sameDayPendingWaitDays: 5, futurePendingWaitDays: 0,
        unsealedTodayWaitDays: 1, inFlightDays: 0,
        pendingByReason: {identity_unresolved: 15, metadata_unresolved: 0, parse_error: 0, text_readback_mismatch: 0}}});
    expect(catchupHttpStatus(result)).toBe(500);
    expect(listDocuments).not.toHaveBeenCalled(); expect(captureListSnapshot).not.toHaveBeenCalled();
    expect(ingestDocument).not.toHaveBeenCalled(); expect(checkDocsCustody).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT * FROM yuho_edinet_catchup_progress ORDER BY date").all()).toEqual(before);
  });
  it("期限超過/無効deadlineはDB/source開始前に停止する", async () => {
    for (const deadline of [Date.now() - 1, NaN, Infinity]) {
      await expect(runYuhoEdinetCatchup(db as unknown as YuhoDatabase, undefined, undefined, undefined, deadline)).rejects.toThrow("絶対締切");
    }
    expect(listDocuments).not.toHaveBeenCalled(); expect(resumePendingShareholdings).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM yuho_edinet_catchup_progress").get()?.n).toBe(0);
  });
  it("定時の新規開始期限は有効なhard内だけ許可し、無効予算はDB/source前に拒否する", async () => {
    const now = Date.now(), deadline = now + 30 * 60_000;
    for (const [soft, hard] of [[NaN, deadline], [Infinity, deadline], [now - 1, deadline], [deadline + 1, deadline], [deadline - 1, undefined]]) {
      await expect(runYuhoEdinetCatchup(db as unknown as YuhoDatabase, undefined, undefined, undefined, hard,
        { observeIssuedShares: true, sourceStartDeadlineMs: soft })).rejects.toThrow("新規開始予算");
    }
    expect(listDocuments).not.toHaveBeenCalled(); expect(resumePendingShareholdings).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM yuho_edinet_catchup_progress").get()?.n).toBe(0);
  });
  it.each([[undefined, 1], [20 * 60_000, 2]] as const)("既定5分と明示した残時間予算%sを分け、開始済文書はsoft後も閉鎖する", async (budget, expected) => {
    const now = new Date("2026-10-14T10:20:00Z"), deadline = now.getTime() + 30 * 60_000;
    const docs = [annualDoc("7203"), { ...annualDoc("7203"), seqNumber: 2, docID: "S1007204" }];
    vi.mocked(listDocuments).mockResolvedValueOnce({ results: docs } as never).mockResolvedValue({ results: [] } as never);
    const success = { outcome: "ingested", parseStatus: "no_order_table", overseasParseStatus: "no_overseas_table", textParseStatus: "ok" } as never;
    vi.mocked(ingestDocument).mockImplementationOnce(async () => { vi.setSystemTime(now.getTime() + 6 * 60_000); return success; })
      .mockResolvedValue(success);
    const result = await runCatchup(now, undefined, deadline, budget === undefined ? undefined : now.getTime() + budget);
    expect(result.ingested).toBe(expected); expect(ingestDocument).toHaveBeenCalledTimes(expected);
    const firstDate = vi.mocked(listDocuments).mock.calls[0][0];
    const row = sqlite.prepare("SELECT completed_ids,in_flight_doc_id FROM yuho_edinet_catchup_progress WHERE date=?").get(firstDate);
    expect(JSON.parse(row?.completed_ids as string)).toEqual(docs.slice(0, expected).map(doc => doc.docID));
    expect(row?.in_flight_doc_id).toBeNull();
  });
  it("softに達した原本観測はhardまでINSERT/読戻しを閉じ、次の日付を開始しない", async () => {
    const now = new Date("2026-10-14T10:20:00Z"), soft = now.getTime() + 60_000, hard = soft + 10 * 60_000;
    vi.mocked(listDocuments).mockResolvedValue({ results: [{ ...annualDoc("7203"), docID: "S100YRSP", docTypeCode: "160", withdrawalStatus: "1" }] } as never);
    const original = reportedChanges.recordReportedChanges;
    const observe = vi.spyOn(reportedChanges, "recordReportedChanges").mockImplementationOnce(async (...args) => {
      vi.setSystemTime(soft + 1);
      expect(args[3]()).toBe(false);
      return original(...args);
    });
    try {
      const result = await runCatchup(now, undefined, hard, soft);
      expect(result.byStatus["edinet_reported:observations"]).toBe(1);
      expect(result.reachedCap).toBe(true); expect(listDocuments).toHaveBeenCalledTimes(1);
      expect(checkDocsCustody).not.toHaveBeenCalled(); expect(ingestDocument).not.toHaveBeenCalled();
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM yuho_edinet_catchup_progress WHERE in_flight_doc_id IS NOT NULL").get()?.n).toBe(0);
    } finally { observe.mockRestore(); }
  });
  it("終端の残り5分以下ではL2/別価格phaseを開始せず、未完理由を残す", async () => {
    const now = new Date("2026-10-14T10:00:00Z"), deadline = now.getTime() + 5 * 60_000;
    vi.mocked(listDocuments).mockResolvedValue({ results: [] } as never);
    const result = await runCatchup(now, vi.fn(), deadline);
    expect(rebuildYuhoGrowthProjection).not.toHaveBeenCalled(); expect(resumePendingShareholdingsPrices).not.toHaveBeenCalled();
    expect(result.byStatus).toMatchObject({ "time_budget:projection_deferred": 1, "time_budget:holdings_price_deferred": 1 });
    expect(catchupHttpStatus(result)).toBe(500);
  });
  it("source前の保存保有明細再開が締切へ到達したら一覧/進捗/L2/価格を開始しない", async () => {
    const now = new Date("2026-10-14T10:00:00Z"), deadline = now.getTime() + 1000;
    vi.mocked(resumePendingShareholdings).mockImplementationOnce(async (args) => {
      vi.setSystemTime(deadline); expect(args.shouldStop()).toBe(true);
      return { usedRows: 0, resumed: 0, held: 0, pending: true };
    });
    await expect(runCatchup(now, vi.fn(), deadline)).rejects.toThrow("絶対締切");
    expect(listDocuments).not.toHaveBeenCalled(); expect(rebuildYuhoGrowthProjection).not.toHaveBeenCalled();
    expect(resumePendingShareholdingsPrices).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM yuho_edinet_catchup_progress").get()?.n).toBe(0);
  });
  it("L2が絶対締切へ到達した場合は別300秒の価格phaseを開始せず未完にする", async () => {
    const now = new Date("2026-10-14T10:00:00Z"), deadline = now.getTime() + 6 * 60_000;
    vi.mocked(listDocuments).mockResolvedValue({ results: [] } as never);
    vi.mocked(rebuildYuhoGrowthProjection).mockImplementationOnce(async () => { vi.setSystemTime(deadline); return { stocks: 0 } as never; });
    const result = await runCatchup(now, vi.fn(), deadline);
    expect(rebuildYuhoGrowthProjection).toHaveBeenCalled(); expect(resumePendingShareholdingsPrices).not.toHaveBeenCalled();
    expect(result.reachedCap).toBe(true); expect(catchupHttpStatus(result)).toBe(500);
  });
  it("価格の新規処理は300秒以内でもhardの1分前に止め、残件を未完にする", async () => {
    const now = new Date("2026-10-14T10:00:00Z"), deadline = now.getTime() + 6 * 60_000;
    vi.mocked(listDocuments).mockResolvedValue({ results: [] } as never);
    vi.mocked(resumePendingShareholdingsPrices).mockImplementationOnce(async args => {
      vi.setSystemTime(deadline - 60_001); expect(args.shouldStop()).toBe(false);
      vi.setSystemTime(deadline - 60_000); expect(args.shouldStop()).toBe(true);
      return { usedRows: 0, resumed: 0, held: 0, pending: true, review: { scope: "initial-attention-sample-and-selected-window", attentionHasMore: false, attentionSample: [], queueSize: 0, queueHasMore: false, queuedSourcePageIds: [], sources: [] } };
    });
    const result = await runCatchup(now, vi.fn(), deadline);
    expect(result.byStatus["holdings_price:pending"]).toBe(1); expect(result.reachedCap).toBe(true);
  });
  it("締切中のdoc未知結果はinFlightを残し次runも同doc/sourceを再送しない", async () => {
    const now = new Date("2026-10-14T10:00:00Z"), deadline = now.getTime() + 60_000;
    vi.mocked(listDocuments).mockResolvedValueOnce({ results: [annualDoc("7203")] } as never);
    vi.mocked(ingestDocument).mockImplementationOnce(async () => { vi.setSystemTime(deadline); throw new Error("deadline native UNKNOWN"); });
    await expect(runCatchup(now, undefined, deadline)).rejects.toThrow("UNKNOWN");
    const row = sqlite.prepare("SELECT in_flight_doc_id FROM yuho_edinet_catchup_progress WHERE in_flight_doc_id IS NOT NULL").get();
    expect(row?.in_flight_doc_id).toBe("S1007203");
    const sourceCount = vi.mocked(listDocuments).mock.calls.length;
    await expect(runCatchup(new Date(deadline + 1), undefined, deadline + 60_000)).rejects.toThrow("in-flight");
    expect(listDocuments).toHaveBeenCalledTimes(sourceCount); expect(ingestDocument).toHaveBeenCalledTimes(1);
  });
  it("原本・L2完了を優先した後、Nodeの価格loaderだけを別予算で呼び未完を隠さない", async () => {
    const loader: HoldingPriceSourceLoader = vi.fn();
    vi.mocked(listDocuments).mockResolvedValue({ results: [] } as never);
    const review = { scope: "initial-attention-sample-and-selected-window" as const, attentionHasMore: true, attentionSample: [], queueSize: 1, queueHasMore: false, queuedSourcePageIds: [], sources: [] };
    vi.mocked(resumePendingShareholdingsPrices).mockResolvedValueOnce({ usedRows: 10, resumed: 1, held: 1, pending: true, review });
    const result = await runCatchup(undefined, loader);
    expect(resumePendingShareholdingsPrices).toHaveBeenLastCalledWith({ sourceDb: db, maxRows: 100, shouldStop: expect.any(Function),
      budget: { remainingChunks: 116, remainingBytes: 256 * 1024 * 1024 }, loadSources: loader });
    expect(vi.mocked(rebuildYuhoGrowthProjection).mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(resumePendingShareholdingsPrices).mock.invocationCallOrder.at(-1)!);
    expect(result.byStatus).toMatchObject({ "holdings_price:resumed": 1, "holdings_price:requires_review": 1, "holdings_price:pending": 1 });
    expect(result.holdingsPrices?.review).toEqual(review);
    expect(catchupHttpStatus(result)).toBe(500);
  });
  it("Workerの通常callerでは価格loader/S3処理を呼ばない", async () => {
    vi.mocked(listDocuments).mockResolvedValue({ results: [] } as never);
    await runCatchup();
    expect(resumePendingShareholdingsPrices).not.toHaveBeenCalled();
  });
  it("価格unknownでも先に確定したsource進捗とL2を戻さない", async () => {
    vi.mocked(listDocuments).mockResolvedValue({ results: [] } as never);
    vi.mocked(resumePendingShareholdingsPrices).mockRejectedValueOnce(new Error("PRICE_UNKNOWN"));
    await expect(runCatchup(undefined, vi.fn())).rejects.toThrow("PRICE_UNKNOWN");
    expect(rebuildYuhoGrowthProjection).toHaveBeenCalled();
    const rows = sqlite.prepare("SELECT in_flight_doc_id FROM yuho_edinet_catchup_progress").all();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.in_flight_doc_id === null)).toBe(true);
  });
  it("保存原本の保有明細再開をsource一覧より先に行い、残枠を新規ingestへ共有する", async () => {
    vi.mocked(resumePendingShareholdings).mockResolvedValueOnce({ usedRows: 30, resumed: 1, held: 0, pending: true });
    vi.mocked(listDocuments).mockResolvedValueOnce({ results: [annualDoc("7203")] } as never).mockResolvedValue({ results: [] } as never);
    vi.mocked(ingestDocument).mockResolvedValue({ outcome: "ingested", parseStatus: "no_order_table", overseasParseStatus: "no_overseas_table", textParseStatus: "no_text_sections" } as never);
    const result = await runCatchup();
    expect(vi.mocked(resumePendingShareholdings).mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(listDocuments).mock.invocationCallOrder[0]);
    expect(vi.mocked(ingestDocument).mock.calls[0][1].holdingsBudget).toEqual({ remainingRows: 70 });
    expect(result.byStatus["holdings:resumed"]).toBe(1);
    expect(catchupHttpStatus(result)).toBe(500);
  });
  it.each(["explicit", "held", "missing-proof", "null-proof", "empty-proof", "invalid-hash", "pending"])("新規保有明細%sは型付き不該当だけを未完から分離", async kind => {
    const proof = JSON.parse(readFileSync(join(ROOT, "services/yuho-quant/src/tests/fixtures/holdings-absence-cli/provenance.json"), "utf8")).items[0].notApplicable as ShareholdingsNotApplicable;
    vi.mocked(listDocuments).mockResolvedValueOnce({ results: [annualDoc("7203")] } as never).mockResolvedValue({ results: [] } as never);
    vi.mocked(ingestDocument).mockResolvedValue({ outcome: "ingested", parseStatus: "no_order_table", overseasParseStatus: "no_overseas_table", textParseStatus: "no_text_sections",
      holdings: { status: "held", parsed: 0, reason: "原本診断", ...(kind === "held" ? {} : { reasonCode: "explicit_not_applicable" }),
        ...(kind === "missing-proof" ? {} : { notApplicable: kind === "null-proof" ? null : kind === "empty-proof" ? {} : kind === "invalid-hash" ? { ...proof, zipSha256: "invalid" } : proof }),
        ...(kind === "pending" ? { pending: true } : {}) } } as never);
    const result = await runCatchup(new Date("2026-10-14T10:00:00Z"));
    expect(result.byStatus[kind === "explicit" ? "holdings:explicit_not_applicable" : "holdings:held"]).toBe(1);
    expect(catchupHttpStatus(result)).toBe(kind === "explicit" ? 200 : 500);
  });
  it("旧不該当の再資格件数だけなら未完にならず、実HOLD併存なら未完を維持", async () => {
    vi.mocked(listDocuments).mockResolvedValue({ results: [] } as never);
    vi.mocked(resumePendingShareholdings).mockResolvedValueOnce({ usedRows: 0, resumed: 0, held: 0, pending: false, explicitNotApplicable: 1 });
    const result = await runCatchup(new Date("2026-10-14T10:00:00Z"));
    expect(result.byStatus["holdings:explicit_not_applicable"]).toBe(1); expect(catchupHttpStatus(result)).toBe(200);
    vi.mocked(resumePendingShareholdings).mockResolvedValueOnce({ usedRows: 0, resumed: 0, held: 1, pending: false, explicitNotApplicable: 1 });
    expect(catchupHttpStatus(await runCatchup(new Date("2026-10-14T10:00:00Z")))).toBe(500);
  });
  it("資格済みの未知sourceは要確認を表示し、別会社の一覧・取込・L2は続ける", async () => {
    const unknown = { archivePageId: "3fbd74ff-84cd-81b8-9ffb-ede100e5ad51",
      source: { stockCode: "1911", docId: "S100Y1XP", edinetCode: "E00011", fiscalYearEnd: "2025-12-31" },
      sourcePageSha256: "182830d267c881598d02051eb8b532bf740084570aeb0f24811a317e7503c5bf", // Actual1911 stable source snapshot SHA.
      reasonCode: "unknown_source_isolated" as const, reason: "未知sourceを隔離。再送なし" };
    vi.mocked(resumePendingShareholdings).mockResolvedValueOnce({ usedRows: 0, resumed: 0, held: 1, pending: true, unknownSources: [unknown] });
    vi.mocked(listDocuments).mockResolvedValueOnce({ results: [annualDoc("7203")] } as never).mockResolvedValue({ results: [] } as never);
    vi.mocked(ingestDocument).mockResolvedValue({ outcome: "ingested", parseStatus: "no_order_table", overseasParseStatus: "no_overseas_table", textParseStatus: "no_text_sections" } as never);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await runCatchup();
      expect(result.byStatus).toMatchObject({ "holdings:requires_review": 1, "holdings:unknown_source_isolated": 1, "holdings:pending": 1 });
      expect(ingestDocument).toHaveBeenCalled(); expect(rebuildYuhoGrowthProjection).toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith("[yuho-edinet] 保有明細source隔離", JSON.stringify(unknown));
      expect(catchupHttpStatus(result)).toBe(500);
    } finally { warning.mockRestore(); }
  });
  it("未資格の保有明細unknownはEDINET一覧やL2へ進めず、そのまま停止する", async () => {
    vi.mocked(resumePendingShareholdings).mockRejectedValueOnce(new Error("HOLDINGS_UNKNOWN"));
    await expect(runCatchup()).rejects.toThrow("HOLDINGS_UNKNOWN");
    expect(listDocuments).not.toHaveBeenCalled();
    expect(rebuildYuhoGrowthProjection).not.toHaveBeenCalled();
  });
  it("当日snapshotは翌日に再観測し後発docだけを取り込み、封印後はsource0", async () => {
    const day = "2026-10-04";
    const firstDoc = annualDoc("7203"), lateDoc = {...annualDoc("7203"), seqNumber: 2, docID: "S1007203LATE"};
    let afterClose = false;
    vi.mocked(listDocuments).mockImplementation(async (date) => ({results: date === day
      ? (afterClose ? [firstDoc, lateDoc] : [firstDoc]) : []}) as never);
    vi.mocked(ingestDocument).mockResolvedValue({outcome: "ingested", parseStatus: "no_order_table",
      overseasParseStatus: "no_overseas_table", textParseStatus: "no_text_sections"} as never);
    await runCatchup(new Date("2026-10-04T11:00:00.000Z"));
    afterClose = true;
    await runCatchup(new Date("2026-10-05T11:00:00.000Z"));
    expect(vi.mocked(ingestDocument).mock.calls.map(([, a]) => a.doc.docID)).toEqual([firstDoc.docID, lateDoc.docID]);
    const sourceCalls = vi.mocked(listDocuments).mock.calls.filter(([date]) => date === day).length;
    expect(sourceCalls).toBe(2);
    await runCatchup(new Date("2026-10-05T12:00:00.000Z"));
    expect(vi.mocked(listDocuments).mock.calls.filter(([date]) => date === day)).toHaveLength(sourceCalls);
    expect(ingestDocument).toHaveBeenCalledTimes(2);
  });
  it("60件cap後は同snapshotの61件目から再開し、完了doc/日付一覧を再取得しない", async () => {
    const docs = Array.from({length: 61}, (_, i) => ({...annualDoc("7203"), seqNumber: i + 1, docID: `S1007203${i}`}));
    vi.mocked(listDocuments).mockResolvedValueOnce({results: docs} as never)
      .mockResolvedValue({results: []} as never);
    vi.mocked(ingestDocument).mockResolvedValue({outcome: "ingested", parseStatus: "no_order_table",
      overseasParseStatus: "no_overseas_table", textParseStatus: "no_text_sections"} as never);
    const first = await runCatchup();
    const sourceDate = vi.mocked(listDocuments).mock.calls[0][0];
    expect(first.ingested).toBe(60);
    expect(catchupHttpStatus(first)).toBe(500);
    expect((await runCatchup()).ingested).toBe(1);
    expect(vi.mocked(listDocuments).mock.calls.filter(([date]) => date === sourceDate)).toHaveLength(1);
    expect(vi.mocked(ingestDocument).mock.calls.map(([, args]) => args.doc.docID)).toEqual(docs.map((d) => d.docID));
  });

  it("未確定取込予約は次回も新source/取込なしで停止", async () => {
    vi.mocked(listDocuments).mockResolvedValueOnce({results: [annualDoc("7203")]} as never);
    vi.mocked(ingestDocument).mockRejectedValue(new Error("unknown send"));
    await expect(runCatchup()).rejects.toThrow("unknown send");
    const sourceCalls = vi.mocked(listDocuments).mock.calls.length;
    await expect(runCatchup()).rejects.toThrow("in-flight");
    expect(listDocuments).toHaveBeenCalledTimes(sourceCalls);
    expect(ingestDocument).toHaveBeenCalledTimes(1);
  });

  it("文書の既知源失敗だけ予約解除し、同run停止・次run同snapshotから再開", async () => {
    vi.mocked(listDocuments).mockResolvedValueOnce({results: [annualDoc("7203")]} as never)
      .mockResolvedValue({results: []} as never);
    vi.mocked(ingestDocument).mockRejectedValueOnce(new EdinetDocumentFetchError("S1007203", 5, "known source failure"))
      .mockResolvedValue({outcome: "ingested", parseStatus: "no_order_table",
        overseasParseStatus: "no_overseas_table", textParseStatus: "no_text_sections"} as never);
    await expect(runCatchup()).rejects.toThrow("known source failure");
    expect(ingestDocument).toHaveBeenCalledTimes(1);
    const date = vi.mocked(listDocuments).mock.calls[0][0];
    expect((await runCatchup()).ingested).toBe(1);
    expect(vi.mocked(listDocuments).mock.calls.filter(([d]) => d === date)).toHaveLength(1);
  });

  it("既存本文の純不一致は理由付きHOLDとし、完了集合を保持して次文書へ進む", async () => {
    const docs = ["FIRST", "HOLD", "LAST"].map((suffix, i) => ({ ...annualDoc("7203"), seqNumber: i + 1, docID: `S1007203${suffix}` }));
    vi.mocked(listDocuments).mockResolvedValueOnce({ results: docs } as never)
      .mockResolvedValue({ results: [] } as never);
    const success = { outcome: "skipped_existing", parseStatus: "no_order_table",
      overseasParseStatus: "no_overseas_table", textParseStatus: "ok" } as never;
    vi.mocked(ingestDocument).mockResolvedValueOnce(success)
      .mockRejectedValueOnce(new ExistingTextReadbackMismatchError()).mockResolvedValue(success);
    const first = await runCatchup();
    expect(first.pendingDocuments).toBe(1);
    expect(catchupHttpStatus(first)).toBe(500);
    expect(vi.mocked(ingestDocument).mock.calls.map(([, args]) => args.doc.docID)).toEqual(docs.map((doc) => doc.docID));
    const date = vi.mocked(listDocuments).mock.calls[0][0];
    const row = sqlite.prepare("SELECT completed_ids,pending_ids,in_flight_doc_id FROM yuho_edinet_catchup_progress WHERE date=?").get(date)!;
    expect(JSON.parse(row.completed_ids as string)).toEqual([docs[0].docID, docs[2].docID]);
    expect(JSON.parse(row.pending_ids as string)).toEqual([{ docId: docs[1].docID, reason: "text_readback_mismatch" }]);
    expect(row.in_flight_doc_id).toBeNull();
    const calls = vi.mocked(ingestDocument).mock.calls.length;
    expect((await runCatchup()).pendingDocuments).toBe(1);
    expect(ingestDocument).toHaveBeenCalledTimes(calls); // 当日はHOLDを再送しない。
  });

  it("既保存parse_errorは原本再取得せず保留に残し、その日に再実行しても成功扱いしない", async () => {
    vi.mocked(listDocuments).mockResolvedValueOnce({results: [annualDoc("7203")]} as never)
      .mockResolvedValue({results: []} as never);
    vi.mocked(ingestDocument).mockResolvedValue({outcome: "skipped_existing", parseStatus: "parse_error",
      overseasParseStatus: null, textParseStatus: "ok"} as never);
    expect((await runCatchup()).pendingDocuments).toBe(1);
    const calls = vi.mocked(ingestDocument).mock.calls.length;
    const again = await runCatchup();
    expect(again.pendingDocuments).toBe(1);
    expect(catchupHttpStatus(again)).toBe(500);
    expect(ingestDocument).toHaveBeenCalledTimes(calls);
  });
  it("new ingest zero still performs full global L2 for previous shard/backfill recovery", async () => {
    vi.mocked(listDocuments).mockResolvedValue({results: []} as never);
    await runCatchup();
    expect(rebuildYuhoGrowthProjection).toHaveBeenCalledExactlyOnceWith(db);
  });

  it("宣言した提出状態変更は物理capture後に観測保存し、金融ingest前の理由付きpendingへ分ける", async () => {
    vi.mocked(listDocuments).mockResolvedValueOnce({ results: [{ ...annualDoc("7203"), docInfoEditStatus: "1" }] } as never)
      .mockResolvedValue({ results: [] } as never);
    const result = await runCatchup();
    expect(result.byStatus).toMatchObject({ "edinet_reported:observations": 1, "edinet_reported:held": 1 });
    expect(result.pendingDocuments).toBe(1); expect(ingestDocument).not.toHaveBeenCalled();
    const row = sqlite.prepare("select doc_id,reported_state,observation_json from yuho_edinet_reported_changes").get();
    expect(row).toMatchObject({ doc_id: "S1007203", reported_state: "reported_status_unqualified" });
    const observation = JSON.parse(row!.observation_json as string);
    expect(observation.doc.docInfoEditStatus).toBe("1"); expect(observation.source.qualified).toBe(true);
    expect(observation.chainApplication).toBe("not_applied");
  });

  it("実withdrawn null型/提出者行もfilter前に保持し、親IDを金融失効へ読み替えない", async () => {
    const fixture = JSON.parse(readFileSync(join(ROOT, "services/yuho-quant/src/tests/fixtures/edinet-reported-lineage.json"), "utf8"));
    const original = fixture.entries.find((entry: { original: { docID: string } }) => entry.original.docID === "S100YRSP").original;
    vi.mocked(listDocuments).mockResolvedValueOnce({ results: [original] } as never).mockResolvedValue({ results: [] } as never);
    const result = await runCatchup(); expect(result.byStatus["edinet_reported:held"]).toBe(1);
    expect(sqlite.prepare("select doc_id,parent_doc_id,reported_state from yuho_edinet_reported_changes").get()).toEqual({
      doc_id: "S100YRSP", parent_doc_id: "S100VVJZ", reported_state: "reported_withdrawal" });
    expect(ingestDocument).not.toHaveBeenCalled(); expect(sqlite.prepare("select count(*) as n from yuho_documents").get()).toEqual({ n: 0 });
  });

  it("実SQLite観測INSERT後の宣言ACK消失は@listを保持し、次runへ同原本送信を継続しない", async () => {
    vi.mocked(listDocuments).mockResolvedValueOnce({ results: [{ ...annualDoc("7203"), docInfoEditStatus: "1" }] } as never);
    let inserts = 0;
    db = drizzle(async (query, args, method) => {
      const stmt = sqlite.prepare(query), params = args as (string | number | null)[];
      if (method === "run") {
        stmt.run(...params);
        if (query.startsWith('insert into "yuho_edinet_reported_changes"')) { inserts++; throw new Error("declared reported INSERT ACK unknown"); }
        return { rows: [] };
      }
      const rows = (stmt.all(...params) as Record<string, unknown>[]).map(row => Object.values(row));
      return { rows: method === "get" ? rows[0] : rows };
    });
    const result = await runCatchup(); expect(result.listErrors).toHaveLength(1); expect(inserts).toBe(1);
    const retained=sqlite.prepare("select in_flight_doc_id,snapshot from yuho_edinet_catchup_progress where in_flight_doc_id is not null").get()!;
    expect(retained.in_flight_doc_id).toBe("@list");
    expect(JSON.parse(retained.snapshot as string)).toEqual((await vi.mocked(captureListSnapshot).mock.results[0].value).snapshot);
    const requests = vi.mocked(captureListSnapshot).mock.calls.length;
    await expect(runCatchup()).rejects.toThrow("in-flight");
    expect(captureListSnapshot).toHaveBeenCalledTimes(requests); expect(ingestDocument).not.toHaveBeenCalled();
  });

  it("positive: 母集団外あり・失敗なし → errors 空・200", async () => {
    vi.mocked(listDocuments)
      .mockResolvedValueOnce({ results: [annualDoc("7203"), {...annualDoc("1208"), seqNumber: 2}] } as never)
      .mockResolvedValue({ results: [] } as never);
    vi.mocked(ingestDocument).mockResolvedValue({
      outcome: "ingested",
      parseStatus: "ok_pattern_a",
      overseasParseStatus: "no_segment_note",
      textParseStatus: "no_text",
    } as never);

    const r = await runCatchup();
    expect({ outOfUniverse: r.outOfUniverse, ingested: r.ingested }).toEqual({
      outOfUniverse: 0,
      ingested: 1,
    });
    expect(r.listErrors).toEqual([]);
    expect(r.ingestErrors).toEqual([]);
    expect(r.pendingDocuments).toBe(1);
    expect(catchupHttpStatus(r)).toBe(500);
  });

  it("negative: 一覧失敗の日 → listErrors に日付・500", async () => {
    vi.mocked(listDocuments)
      .mockRejectedValueOnce(new EdinetListFetchError("EDINET list down"))
      .mockResolvedValue({ results: [] } as never);
    vi.mocked(ingestDocument).mockResolvedValue({} as never);

    const r = await runCatchup();
    expect(r.listErrors).toHaveLength(1);
    expect(r.ingestErrors).toEqual([]);
    expect(catchupHttpStatus(r)).toBe(500);
    const failedDate = vi.mocked(listDocuments).mock.calls[0][0];
    const marker = sqlite.prepare("SELECT in_flight_doc_id FROM yuho_edinet_catchup_progress WHERE date=?").get(failedDate);
    expect(marker).toEqual({in_flight_doc_id: null});
    expect((await runCatchup()).listErrors).toEqual([]);
    expect(vi.mocked(listDocuments).mock.calls.filter(([date]) => date === failedDate)).toHaveLength(2);
  });

  it("negative: 取込失敗 (物理保管失敗を含む) → 即停止・次文書/L2なし", async () => {
    vi.mocked(listDocuments)
      .mockResolvedValueOnce({ results: [annualDoc("7203")] } as never)
      .mockResolvedValue({ results: [] } as never);
    vi.mocked(ingestDocument).mockRejectedValueOnce(new Error("Notion 記録失敗"));

    await expect(runCatchup()).rejects.toThrow("Notion 記録失敗");
    expect(ingestDocument).toHaveBeenCalledTimes(1);
    expect(listDocuments).toHaveBeenCalledTimes(1);
    expect(rebuildYuhoGrowthProjection).not.toHaveBeenCalled();
  });

  it("保管済み資格不成立の一覧は原本参照を残し、次の通常runで再観測", async () => {
    const date = "2026-08-06";
    vi.mocked(listDocuments).mockResolvedValue({results: []} as never);
    vi.mocked(captureListSnapshot).mockRejectedValueOnce(new EdinetListQualificationError({
      date, pageId: "00000000-0000-4000-8000-000000000001", filename: `edinet-list-${date}.json.gz`,
      gzipSha256: "0".repeat(64), rawSha256: "0".repeat(64), rawBytes: 1,
      httpStatus: 403, qualified: false, fetchedAt: "2026-10-04T00:00:00.000Z",
    }));
    expect((await runCatchup(new Date("2026-10-04T11:00:00.000Z"))).listErrors).toEqual([date]);
    const failed = sqlite.prepare("SELECT snapshot, in_flight_doc_id FROM yuho_edinet_catchup_progress WHERE date=?").get(date)!;
    expect(failed.in_flight_doc_id).toBeNull();
    expect(JSON.parse(failed.snapshot as string)).toMatchObject({httpStatus: 403, qualified: false});
    expect((await runCatchup(new Date("2026-10-04T12:00:00.000Z"))).listErrors).toEqual([]);
    expect(vi.mocked(captureListSnapshot).mock.calls.filter(([d]) => d === date)).toHaveLength(2);
  });

  it("一覧物理保管の結果不明はmarkerを保持し、次runの新sourceも停止", async () => {
    vi.mocked(captureListSnapshot).mockRejectedValueOnce(new Error("unknown archive send"));
    expect((await runCatchup()).listErrors).toHaveLength(1);
    const calls = vi.mocked(captureListSnapshot).mock.calls.length;
    await expect(runCatchup()).rejects.toThrow("in-flight");
    expect(captureListSnapshot).toHaveBeenCalledTimes(calls);
    expect(ingestDocument).not.toHaveBeenCalled();
  });

  it("境界: 完成済み既存 (skipped_existing) は skip 計数し状態計数に混ぜない", async () => {
    vi.mocked(listDocuments)
      .mockResolvedValueOnce({ results: [annualDoc("7203")] } as never)
      .mockResolvedValue({ results: [] } as never);
    vi.mocked(ingestDocument).mockResolvedValue({
      outcome: "skipped_existing",
      parseStatus: "no_order_table",
      overseasParseStatus: "no_overseas_table",
      textParseStatus: "no_text_sections",
    } as never);

    const r = await runCatchup();
    expect(r.ingested).toBe(0);
    expect(r.skippedExisting).toBe(1);
    expect(r.ingestErrors).toEqual([]);
    expect(r.byStatus).toEqual({});
    expect(catchupHttpStatus(r)).toBe(200);
  });

  it("境界: 日ごとの保管完成を一括取得して ingestDocument へ渡す", async () => {
    vi.mocked(listDocuments)
      .mockResolvedValueOnce({ results: [annualDoc("7203")] } as never)
      .mockResolvedValue({ results: [] } as never);
    vi.mocked(ingestDocument).mockResolvedValue({ outcome: "ingested" } as never);
    const custody = { t1: "complete", t5: "complete" } as const;
    vi.mocked(checkDocsCustody).mockResolvedValueOnce(
      new Map([["S1007203", custody]])
    );

    await runCatchup();
    expect(vi.mocked(checkDocsCustody).mock.calls.length).toBe(1);
    expect(vi.mocked(ingestDocument).mock.calls[0][1]).toMatchObject({ custody });
  });

  it("境界: cap/保留を成功としない", () => {
    expect(catchupHttpStatus({ reachedCap: false, pendingDocuments: 0, listErrors: [], ingestErrors: [] })).toBe(200);
    expect(catchupHttpStatus({reachedCap: true, pendingDocuments: 0, listErrors: [], ingestErrors: []})).toBe(500);
    expect(catchupHttpStatus({reachedCap: false, pendingDocuments: 1, listErrors: [], ingestErrors: []})).toBe(500);
    expect(catchupHttpStatus({ reachedCap: false, pendingDocuments: 0, listErrors: ["2026-09-01"], ingestErrors: [] })).toBe(500);
    expect(catchupHttpStatus({ reachedCap: false, pendingDocuments: 0, listErrors: [], ingestErrors: ["S1007203"] })).toBe(500);
  });
});

describe("進捗 checkpoint: 次回標準実行の段階特定 (#187)", () => {
  it("5 checkpoint が順序どおり出て秘密 (URL/キー) を含まない", async () => {
    vi.mocked(listDocuments)
      .mockResolvedValueOnce({ results: [annualDoc("7203")] } as never)
      .mockResolvedValue({ results: [] } as never);
    vi.mocked(ingestDocument).mockResolvedValue({ outcome: "ingested" } as never);

    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // mockRestore() は記録 calls も消すため、復元前に抜き出す。
    let lines: string[] = [];
    try {
      const running = runYuhoEdinetCatchup(db as unknown as YuhoDatabase);
      await vi.runAllTimersAsync();
      await running;
      lines = info.mock.calls.map((c) => String(c[0]));
    } finally {
      vi.useRealTimers();
      info.mockRestore();
      err.mockRestore();
    }

    // checkpoint・summary に URL・キー・認証ヘッダが出ない。
    for (const line of lines) {
      expect(line).not.toMatch(/Subscription-Key|Bearer|https?:\/\//i);
    }
    // 入口の到達順 = 開始 → list → custody → ingest → 投影 → 完了。
    // 前段の完了は次の checkpoint (または完了 summary) で判る。
    const at = (re: RegExp): number => {
      const i = lines.findIndex((l) => re.test(l));
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    const order = [
      at(/\[yuho-edinet\] 開始: shard=/),
      at(/\[yuho-edinet\] list 開始 \d{4}-\d{2}-\d{2}/),
      at(/\[yuho-edinet\] custody 照会 \d{4}-\d{2}-\d{2} 1件/),
      at(/\[yuho-edinet\] ingest 開始 \d{4}-\d{2}-\d{2} docID=S1007203/),
      at(/\[yuho-edinet\] 投影再生成 開始/),
      at(/\[yuho-edinet\] 完了: shard=/),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
