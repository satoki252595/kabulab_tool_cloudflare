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
import { listDocuments, EdinetListFetchError, EdinetDocumentFetchError } from "../../services/yuho-quant/src/services/edinet/client.js";
import { captureListSnapshot, EdinetListQualificationError } from "../../services/yuho-quant/src/services/edinet/list-snapshot.js";
import { ingestDocument } from "../../services/yuho-quant/src/services/ingest.js";
import { ExistingTextReadbackMismatchError } from "../../services/yuho-quant/src/services/text-backup.js";
import { rebuildYuhoGrowthProjection } from "../../services/yuho-quant/src/services/projection.js";
import { checkDocsCustody } from "../../services/yuho-quant/src/services/edinet/archive.js";
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
    const list = await client.listDocuments(date);
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
vi.mock("../../services/yuho-quant/src/services/edinet/archive.js", () => ({
  checkDocsCustody: vi.fn(async () => new Map()),
}));

vi.mock("../../services/yuho-quant/src/services/projection.js", () => ({
  rebuildYuhoGrowthProjection: vi.fn(async () => ({stocks: 0})),
}));

function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
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
  docID: `S100${code}`,
  secCode: `${code}0`,
  ordinanceCode: "010",
  docTypeCode: "120",
  formCode: "030000",
  filerName: `テスト${code}`,
});

async function runCatchup(now?: Date) {
  // 本体は sleep を挟む (60 日分)。setTimeout だけ偽物にして進める。
  vi.useFakeTimers({ toFake: now ? ["setTimeout", "Date"] : ["setTimeout"] });
  if (now) vi.setSystemTime(now);
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const running = runYuhoEdinetCatchup(db as unknown as YuhoDatabase);
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
  it("当日snapshotは翌日に再観測し後発docだけを取り込み、封印後はsource0", async () => {
    const day = "2026-10-04";
    const firstDoc = annualDoc("7203"), lateDoc = {...annualDoc("7203"), docID: "S1007203LATE"};
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
    const docs = Array.from({length: 61}, (_, i) => ({...annualDoc("7203"), docID: `S1007203${i}`}));
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
    const docs = ["FIRST", "HOLD", "LAST"].map((suffix) => ({ ...annualDoc("7203"), docID: `S1007203${suffix}` }));
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

  it("positive: 母集団外あり・失敗なし → errors 空・200", async () => {
    vi.mocked(listDocuments)
      .mockResolvedValueOnce({ results: [annualDoc("7203"), annualDoc("1208")] } as never)
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
