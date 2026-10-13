import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { describe, expect, it } from "vitest";
import { selectLatestHoldingsDocuments } from "./shareholdings-backfill.js";

describe("保有明細backfillの最新有報選択", () => {
  it("最新会計期末を優先し、同一期末の訂正を日時/PKで確定、既存開示母集団とcursorを守る", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`CREATE TABLE core_stocks (id INTEGER, code TEXT, is_active INTEGER, instrument_type TEXT);
      CREATE TABLE yuho_documents (id INTEGER, stock_id INTEGER, doc_id TEXT, edinet_code TEXT, filer_name TEXT, period_end TEXT, submitted_at INTEGER, doc_type_code TEXT);
      INSERT INTO core_stocks VALUES (1,'1001',1,'equity'),(2,'1002',1,'etf_etn'),(3,'1003',1,NULL),(4,'1004',0,NULL);
      INSERT INTO yuho_documents VALUES
      (1,1,'S100CURRENT','E00001','STRUCTURAL','2026-03-31',100,'120'),
      (2,1,'S100OLDLATE','E00001','STRUCTURAL','2025-03-31',999,'130'),
      (3,1,'S100CORRECT1','E00001','STRUCTURAL','2026-03-31',101,'130'),
      (4,1,'S100CORRECT2','E00001','STRUCTURAL','2026-03-31',101,'130'),
      (5,2,'S100ETF','E00002','STRUCTURAL','2026-03-31',100,'120'),
      (6,3,'S100UNRESOLVED','E00003','STRUCTURAL','2026-03-31',100,'120'),
      (7,4,'S100INACTIVE','E00004','STRUCTURAL','2026-03-31',100,'120');`);
    const db = drizzle(async (statement, params) => ({ rows: (sqlite.prepare(statement).all(...params as never[]) as Record<string, unknown>[]).map(row => Object.values(row)) }));
    try {
      const first = await selectLatestHoldingsDocuments(db, { afterCode: null, limit: 1 });
      expect(first.more).toBe(true);
      expect(first.rows.map(row => [row.stockCode, row.docId])).toEqual([["1001", "S100CORRECT2"]]);
      const next = await selectLatestHoldingsDocuments(db, { afterCode: "1001", limit: 50 });
      expect(next.more).toBe(false);
      expect(next.rows.map(row => [row.stockCode, row.docId])).toEqual([["1004", "S100INACTIVE"]]);
      await expect(selectLatestHoldingsDocuments(db, { afterCode: "INVALID", limit: 50 })).rejects.toThrow();
      await expect(selectLatestHoldingsDocuments(db, { afterCode: null, limit: 51 })).rejects.toThrow();
    } finally { sqlite.close(); }
  });
});
