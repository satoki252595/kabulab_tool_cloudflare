/**
 * backfill-missing-docs 1 通処理の raw-before-DB 契約テスト。
 *
 * 振る舞いの正本 lib/missing-backfill.ts processMissingDoc を、実
 * node:sqlite (+ 実 D1 マイグレーション) に対して走らせる。IO 境界
 * (download/record/sender/text-backup) は引数注入の mock、パーサ橋渡し
 * (CSV/受注/海外/定性) は ingest-atomic と同じ module mock + 実 fixture
 * 由来 facts。次を証明する:
 *
 *   - 物理 ZIP の記録 (T5+T1) が DB batch より先で、text 本文は DBid
 *     解決後 (mock 呼出順 + 実 SELECT の行で証明)。
 *   - 記録失敗は DB 旧値のまま tally.error (batch 0)。
 *   - T1 未提供 (型付き 404) のみ T5 単独で進み、未知失敗は throw
 *     (無断 T5 単独にしない)。
 *   - 記録 metadata は DBid 非依存。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  processMissingDoc,
  type MissingDocProcessDeps,
} from "../../data-scripts/lib/missing-backfill.js";
import { createDb, type Database } from "../db/client.js";
import {
  downloadDocument,
  EdinetNotFoundError,
  EdinetDocumentFetchError,
  EdinetDocumentArchiveError,
} from "../services/edinet/client.js";
import { recordEdinetZip } from "../services/edinet/archive.js";
import { backupDocTextToNotion } from "../services/text-backup.js";
import {
  parseEdinetCsvZip,
  type EdinetCsvRow,
} from "../services/edinet/csv.js";
import { parseOrderData, parseOrderHtml } from "../services/edinet/order-parser.js";
import {
  parseOverseasData,
  parseOverseasHtml,
} from "../services/overseas-parser.js";
import { extractTextSections } from "../services/edinet/text-sections.js";
import type { EdinetDoc } from "../services/edinet/types.js";
import type { D1BatchStatement } from "../../../../src/shared/db/d1-http-client.js";

vi.mock("../services/edinet/csv.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/edinet/csv.js")>();
  return { ...mod, parseEdinetCsvZip: vi.fn() };
});
vi.mock("../services/edinet/order-parser.js", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../services/edinet/order-parser.js")>();
  return { ...mod, parseOrderData: vi.fn() };
});
vi.mock("../services/overseas-parser.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/overseas-parser.js")>();
  return { ...mod, parseOverseasData: vi.fn() };
});
vi.mock("../services/edinet/text-sections.js", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../services/edinet/text-sections.js")>();
  return { ...mod, extractTextSections: vi.fn() };
});

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (n: string) => readFileSync(join(FX, n), "utf8");
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

// downloadDocument / recordEdinetZip / backupDocTextToNotion の実物は
// 呼ばない (型参照のみ)。注入する mock が下の setupDeps で作られる。
void downloadDocument;
void recordEdinetZip;
void backupDocTextToNotion;

function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split(
      "--> statement-breakpoint"
    )) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

/** drizzle-orm/d1 が触る範囲の D1Database シム。batch は実トランザクション。 */
function createD1(
  sqlite: DatabaseSync,
  counters: { batches: number; batchStmts: number }
): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spread = (params: unknown[]) => params as any[];
  const prepare = (query: string) => {
    const make = (params: unknown[]) => ({
      all: async () => ({ results: sqlite.prepare(query).all(...spread(params)) as unknown[], success: true, meta: {} }),
      raw: async () => {
        const stmt = sqlite.prepare(query);
        const names = stmt.columns().map((col) => col.name);
        const rows = stmt.all(...spread(params)) as Record<string, unknown>[];
        return rows.map((row) => names.map((n) => row[n]));
      },
      run: async () => {
        const r = sqlite.prepare(query).run(...spread(params));
        return {
          results: [],
          success: true,
          meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
        };
      },
      first: async (col?: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = sqlite.prepare(query).get(...spread(params)) as any;
        if (row === undefined) return null;
        return col === undefined ? row : row[col];
      },
      bind: (...next: unknown[]) => make(next),
      _testSql: query,
      _testParams: params,
    });
    return make([]);
  };
  return {
    prepare,
    batch: async (stmts: { _testSql: string; _testParams: unknown[] }[]) => {
      counters.batches += 1;
      counters.batchStmts += stmts.length;
      sqlite.exec("BEGIN");
      try {
        const out = stmts.map((s) => {
          const r = sqlite.prepare(s._testSql).run(...spread(s._testParams));
          return {
            success: true,
            meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
          };
        });
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

function annualDoc(docID: string): EdinetDoc {
  return {
    seqNumber: 1,
    docID,
    edinetCode: "E00001",
    secCode: "10010",
    JCN: null,
    filerName: "テスト提出者",
    ordinanceCode: "010",
    formCode: "030000",
    docTypeCode: "120",
    periodStart: "2024-04-01",
    periodEnd: "2025-03-31",
    submitDateTime: "2026-09-24 15:00",
    docDescription: "有価証券報告書",
    xbrlFlag: "1",
    csvFlag: "1",
    withdrawalStatus: "0",
  };
}

function silenceConsole() {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => {
    info.mockRestore();
    warn.mockRestore();
    err.mockRestore();
  };
}

function setupDb(): {
  sqlite: DatabaseSync;
  db: Database;
  counters: { batches: number; batchStmts: number };
} {
  const sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
  sqlite
    .prepare(
      "INSERT INTO core_stocks (id, code, name, market, is_active, instrument_type, sector33) VALUES (11, '1001', 'テスト1001', 'プライム', 1, 'stock', '建設業')"
    )
    .run();
  const counters = { batches: 0, batchStmts: 0 };
  const db = createDb(
    createD1(sqlite, counters) as unknown as Parameters<typeof createDb>[0]
  );
  return { sqlite, db, counters };
}

/** パーサ橋渡しを既定に戻す (実 fixture 由来 facts + CSV キーワード行)。 */
function setupParserBridges(): void {
  vi.mocked(parseEdinetCsvZip).mockReset();
  vi.mocked(parseOrderData).mockReset();
  vi.mocked(parseOverseasData).mockReset();
  vi.mocked(extractTextSections).mockReset();
  const orderEx = parseOrderHtml(fx("patternB-1803-shimizu.html"), "2025-03-31");
  const overseasEx = parseOverseasHtml(
    fx("georows-2dproduct-sales-S100YBHC.html"),
    "2026-03-31"
  );
  const csvRow = (itemName: string): EdinetCsvRow => ({
    elementId: "e1",
    itemName,
    contextId: "c1",
    relativeYear: "CurrentYearDuration",
    consolidatedOrNonConsolidated: "連結",
    periodOrInstant: "期間",
    unitId: "u1",
    unit: "円",
    value: "v",
  });
  vi.mocked(parseEdinetCsvZip).mockReturnValue([
    csvRow("受注高"),
    csvRow("海外売上高"),
  ]);
  vi.mocked(parseOrderData).mockReturnValue({
    ...orderEx,
    honbunFile: "test-honbun.html",
  });
  vi.mocked(parseOverseasData).mockReturnValue({
    ...overseasEx,
    honbunFile: "test-honbun.html",
  });
  vi.mocked(extractTextSections).mockReturnValue([]);
}

/** 注入 deps (既定は全成功) と tally 記録。sender は受信 SQL を実実行する。 */
function setupDeps(sqlite: DatabaseSync): {
  deps: MissingDocProcessDeps;
  download: Mock<typeof downloadDocument>;
  record: Mock<typeof recordEdinetZip>;
  sender: Mock<(statements: readonly D1BatchStatement[]) => Promise<void>>;
  backup: Mock<typeof backupDocTextToNotion>;
  tally: Record<string, number>;
} {
  const download: Mock<typeof downloadDocument> = vi.fn(async (_docId, docType) =>
    Buffer.from(`zip-type${docType}`)
  );
  const record: Mock<typeof recordEdinetZip> = vi.fn(async () => ({
    pageId: "page-x",
    outcome: "recorded",
    fileTooLarge: false,
    manifestMatch: "written",
  }) as const);
  const sender: Mock<(statements: readonly D1BatchStatement[]) => Promise<void>> =
    vi.fn(async (statements: readonly D1BatchStatement[]) => {
      for (const st of statements) {
        sqlite.prepare(st.sql).run(...(st.params as never[]));
      }
    });
  const backup: Mock<typeof backupDocTextToNotion> = vi.fn(async () => ({
    rowPageId: "text-row-9",
    outcome: "recorded",
  }) as const);
  const tally: Record<string, number> = {};
  const deps: MissingDocProcessDeps = {
    downloadDocument: download,
    recordEdinetZip: record,
    d1HttpBatch: sender,
    backupDocTextToNotion: backup,
    tally: (key) => {
      tally[key] = (tally[key] ?? 0) + 1;
    },
  };
  return { deps, download, record, sender, backup, tally };
}

describe("missing-docs raw-before-DB 契約", () => {
  it("typeごとに受信完了時刻を記録し、提出時刻や後続の保管時刻と混同しない", async () => {
    const restore = silenceConsole();
    const { sqlite, db } = setupDb();
    const csvReceivedAt = new Date();
    const xbrlReceivedAt = new Date(csvReceivedAt.getTime() + 1000);
    const archiveStartedAt = new Date(csvReceivedAt.getTime() + 2000);
    vi.useFakeTimers();
    try {
      setupParserBridges();
      const { deps, download, record } = setupDeps(sqlite);
      const downloadResponse = download.getMockImplementation()!;
      download.mockImplementation(async (...args) => {
        const bytes = await downloadResponse(...args);
        vi.setSystemTime(args[1] === 5 ? csvReceivedAt : xbrlReceivedAt);
        return bytes;
      });
      const archiveResponse = record.getMockImplementation()!;
      record.mockImplementation(async (...args) => {
        vi.setSystemTime(archiveStartedAt);
        return archiveResponse(...args);
      });
      const doc = annualDoc("S100MISS1");
      await processMissingDoc(db, deps, { doc, stockId: 11, force: false });
      expect(record.mock.calls.map(([args]) => [args.type, args.fetchedAt])).toEqual([
        [5, csvReceivedAt.toISOString()],
        [1, xbrlReceivedAt.toISOString()],
      ]);
      for (const [args] of record.mock.calls) {
        expect(args.fetchedAt).not.toBe(archiveStartedAt.toISOString());
        expect(args.metadata.submitDateTime).toBe(doc.submitDateTime);
        expect(args.fetchedAt.slice(0, 10)).not.toBe(doc.submitDateTime!.slice(0, 10));
      }
    } finally {
      vi.useRealTimers();
      sqlite.close();
      restore();
    }
  });

  it("記録 (T5+T1) → DB batch → text 保管の順で、metadata は DBid 非依存", async () => {
    const restore = silenceConsole();
    const { sqlite, db } = setupDb();
    try {
      setupParserBridges();
      vi.mocked(extractTextSections).mockReturnValue([
        {
          sectionKey: "risks",
          text: "リスク本文",
          charCount: 5,
          elementId: "e1",
          itemName: "事業等のリスク",
          contextId: "c1",
        },
      ]);
      const { deps, record, sender, backup, tally } = setupDeps(sqlite);
      await processMissingDoc(
        db,
        deps,
        { doc: annualDoc("S100MISS1"), stockId: 11, force: false }
      );
      expect(tally).toEqual({ ingested: 1 });
      // 記録は T5+T1 の 2 回、batch は 1 回、text は DBid 解決後の 1 回。
      expect(record.mock.calls.length).toBe(2);
      expect(record.mock.calls.map((c) => c[0].type)).toEqual([5, 1]);
      expect(sender.mock.calls.length).toBe(1);
      expect(backup.mock.calls.length).toBe(1);
      const lastRecord = Math.max(...record.mock.invocationCallOrder);
      const batchOrder = Math.min(...sender.mock.invocationCallOrder);
      const textOrder = Math.min(...backup.mock.invocationCallOrder);
      expect(lastRecord).toBeLessThan(batchOrder);
      expect(batchOrder).toBeLessThan(textOrder);
      // metadata は DBid 非依存。
      for (const c of record.mock.calls) {
        const meta = c[0].metadata as Record<string, unknown>;
        expect("docRowId" in meta).toBe(false);
        expect("documentId" in meta).toBe(false);
        expect(meta.docID).toBe("S100MISS1");
      }
      // 実 DB 行 + facts + ポインタ書戻し。
      const row = sqlite
        .prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100MISS1'")
        .get() as {
        id: number;
        parse_status: string;
        overseas_parse_status: string;
        notion_doc_page_id: string;
      };
      expect(row.parse_status).toBe("ok_pattern_b");
      expect(row.overseas_parse_status).toBe("ok_geo_rows");
      expect(row.notion_doc_page_id).toBe("text-row-9");
      expect(backup.mock.calls[0][0].d1DocumentId).toBe(row.id);
      const orderCount = (
        sqlite
          .prepare("SELECT COUNT(*) AS n FROM yuho_order_facts WHERE document_id = ?")
          .get(row.id) as { n: number }
      ).n;
      expect(orderCount).toBeGreaterThan(0);
    } finally {
      sqlite.close();
      restore();
    }
  });

  it("記録失敗は DB 旧値のまま tally.error (batch 0・text 0)", async () => {
    const restore = silenceConsole();
    const { sqlite, db } = setupDb();
    try {
      setupParserBridges();
      const { deps, record, sender, backup, tally } = setupDeps(sqlite);
      record.mockImplementation(async (args) => {
        if (args.type === 1) throw new Error("notion down (t1)");
        return {
          pageId: "page-t5",
          outcome: "recorded",
          fileTooLarge: false,
          manifestMatch: "written",
        } as const;
      });
      await processMissingDoc(
        db,
        deps,
        { doc: annualDoc("S100MISF1"), stockId: 11, force: false }
      );
      expect(tally).toEqual({ error: 1 });
      expect(record.mock.calls.length).toBe(2);
      expect(sender.mock.calls.length).toBe(0);
      expect(backup.mock.calls.length).toBe(0);
      expect(
        sqlite.prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100MISF1'").get()
      ).toBeUndefined();
    } finally {
      sqlite.close();
      restore();
    }
  });

  it("T1 未提供 (型付き 404) のみ T5 単独で進み、xbrlUnavailable を残す", async () => {
    const restore = silenceConsole();
    const { sqlite, db } = setupDb();
    try {
      setupParserBridges();
      const { deps, download, record, sender, tally } = setupDeps(sqlite);
      download.mockImplementation(async (docId, docType) => {
        if (docType === 1) throw new EdinetNotFoundError(docId, docType);
        return Buffer.from("zip-type5");
      });
      await processMissingDoc(
        db,
        deps,
        { doc: annualDoc("S100MITN1"), stockId: 11, force: false }
      );
      expect(tally).toEqual({ ingested: 1 });
      expect(record.mock.calls.map((c) => c[0].type)).toEqual([5]);
      const meta = record.mock.calls[0][0].metadata as Record<string, unknown>;
      expect(meta.xbrlUnavailable).toBe(true);
      expect(sender.mock.calls.length).toBe(1);
      const row = sqlite
        .prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100MITN1'")
        .get() as { parse_status: string; overseas_parse_status: string };
      expect(row.parse_status).toBe("parse_error");
      expect(row.overseas_parse_status).toBe("parse_error");
    } finally {
      sqlite.close();
      restore();
    }
  });

  it("T1 未知失敗は tally.error し、DB も記録も触らない", async () => {
    const restore = silenceConsole();
    const { sqlite, db } = setupDb();
    try {
      setupParserBridges();
      const { deps, download, record, sender, tally } = setupDeps(sqlite);
      download.mockImplementation(async (docId, docType) => {
        if (docType === 1) throw new Error(`edinet 500 docID=${docId}`);
        return Buffer.from("zip-type5");
      });
      await processMissingDoc(
        db,
        deps,
        { doc: annualDoc("S100MITU1"), stockId: 11, force: false }
      );
      expect(tally).toEqual({ error: 1 });
      expect(record.mock.calls.length).toBe(0);
      expect(sender.mock.calls.length).toBe(0);
      expect(
        sqlite.prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100MITU1'").get()
      ).toBeUndefined();
    } finally {
      sqlite.close();
      restore();
    }
  });

  it.each([false, true])("manual T1既知源失敗もCSV保管後STOP、保管未知をsource再開にしない (%s)", async (archiveUnknown) => {
    const restore = silenceConsole();
    const {sqlite, db} = setupDb();
    try {
      setupParserBridges();
      const {deps, download, record, sender, tally} = setupDeps(sqlite);
      const failure = new EdinetDocumentFetchError("S100MPART1", 1, "known source failure");
      download.mockImplementation(async (_docId, type) => {
        if (type === 1) throw failure;
        return Buffer.from("zip-type5");
      });
      if (archiveUnknown) record.mockRejectedValueOnce(new Error("unknown archive"));
      const run = processMissingDoc(db, deps, {doc: annualDoc("S100MPART1"), stockId: 11, force: false});
      if (archiveUnknown) await expect(run).rejects.toBeInstanceOf(EdinetDocumentArchiveError);
      else await expect(run).rejects.toBe(failure);
      expect(tally).toEqual({error: 1});
      expect(record.mock.calls.map(([a]) => a.type)).toEqual([5]);
      expect(sender).not.toHaveBeenCalled();
      expect(sqlite.prepare("SELECT count(*) AS n FROM yuho_documents").get()).toEqual({n: 0});
    } finally {sqlite.close(); restore();}
  });

  it("meta 不備は明示スキップし、fetch も DB も触らない", async () => {
    const restore = silenceConsole();
    const { sqlite, db } = setupDb();
    try {
      setupParserBridges();
      const { deps, download, record, sender, tally } = setupDeps(sqlite);
      const bad = annualDoc("S100MISK1");
      bad.filerName = "";
      await processMissingDoc(db, deps, { doc: bad, stockId: 11, force: false });
      expect(tally).toEqual({ skipped_invalid_meta: 1 });
      expect(download.mock.calls.length).toBe(0);
      expect(record.mock.calls.length).toBe(0);
      expect(sender.mock.calls.length).toBe(0);
    } finally {
      sqlite.close();
      restore();
    }
  });
});
