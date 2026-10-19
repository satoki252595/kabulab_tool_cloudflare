import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { describe, expect, it } from "vitest";
import { selectLatestHoldingsDocuments } from "./shareholdings-backfill.js";

describe("保有明細backfillの最新有報選択", () => {
  it("最新会計期末を優先し、同一期末の訂正を日時/PKで確定、active普通株の母集団とcursorを守る", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(readFileSync(new URL("../../../../drizzle/d1/0032_edinet_reported_changes.sql", import.meta.url), "utf8"));
    sqlite.exec(readFileSync(new URL("../../../../drizzle/d1/0034_edinet_reported_resolutions.sql", import.meta.url), "utf8"));
    sqlite.exec(`CREATE TABLE core_stocks (id INTEGER PRIMARY KEY, code TEXT, is_active INTEGER, instrument_type TEXT);
      CREATE UNIQUE INDEX core_stocks_code_unique ON core_stocks (code);
      CREATE TABLE yuho_documents (id INTEGER PRIMARY KEY, stock_id INTEGER, doc_id TEXT, edinet_code TEXT, filer_name TEXT, period_end TEXT, submitted_at INTEGER, doc_type_code TEXT);
      CREATE INDEX idx_core_stocks_active_market ON core_stocks (is_active);
      CREATE INDEX yuho_documents_stock_idx ON yuho_documents (stock_id);
      INSERT INTO core_stocks VALUES (1,'1001',1,'equity'),(2,'1002',1,'etf_etn'),(3,'1003',1,NULL),(4,'1004',0,NULL),(5,'1005',0,'equity'),(6,'1006',1,'equity'),(7,'1000',1,'equity'),(8,'1007',1,'equity');
      INSERT INTO yuho_documents VALUES
      (1,1,'S100CURRENT','E00001','STRUCTURAL','2026-03-31',100,'120'),
      (2,1,'S100OLDLATE','E00001','STRUCTURAL','2025-03-31',999,'130'),
      (3,1,'S100CORRECT1','E00001','STRUCTURAL','2026-03-31',101,'130'),
      (4,1,'S100CORRECT2','E00001','STRUCTURAL','2026-03-31',101,'130'),
      (5,2,'S100ETF','E00002','STRUCTURAL','2026-03-31',100,'120'),
      (6,3,'S100UNRESOLVED','E00003','STRUCTURAL','2026-03-31',100,'120'),
      (7,4,'S100INACTIVE','E00004','STRUCTURAL','2026-03-31',100,'120'),
      (8,5,'S100DELISTED','E00005','STRUCTURAL','2026-03-31',100,'120'),
      (9,6,'S100ACTIVE','E00006','STRUCTURAL','2026-03-31',100,'120'),
      (10,7,'S100NONANNUAL','E00007','STRUCTURAL','2026-03-31',100,'140');`);
    const queries: Array<{ sql: string; params: unknown[]; columns: string[] }> = [];
    const db = drizzle(async (statement, params) => {
      const query = { sql: statement, params, columns: [] as string[] };
      queries.push(query);
      const prepared = sqlite.prepare(statement);
      query.columns = prepared.columns().map(column => column.name);
      return { rows: (prepared.all(...params as never[]) as Record<string, unknown>[]).map(row => Object.values(row)) };
    });
    try {
      const first = await selectLatestHoldingsDocuments(db, { afterCode: null, limit: 1 });
      expect(queries).toHaveLength(1);
      expect(queries[0].columns.at(-1)).toBe("reported_hold");
      expect(first.more).toBe(true);
      expect(first.rows.map(row => [row.stockCode, row.docId])).toEqual([["1001", "S100CORRECT2"]]);
      const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${queries[0].sql}`).all(...queries[0].params as never[]) as Array<{ detail: string }>;
      expect(plan.some(row => row.detail.includes("SEARCH yuho_documents USING INDEX yuho_documents_stock_idx (stock_id=?)"))).toBe(true);
      expect(plan.some(row => /^SCAN yuho_documents\b/.test(row.detail))).toBe(false);
      expect(plan.some(row => row.detail.includes("USING INDEX core_stocks_code_unique"))).toBe(true);
      expect(plan.some(row => row.detail.includes("SEARCH core_stocks USING INTEGER PRIMARY KEY (rowid=?)"))).toBe(true);
      expect(plan.some(row => row.detail.includes("idx_core_stocks_active_market"))).toBe(false);
      const next = await selectLatestHoldingsDocuments(db, { afterCode: "1001", limit: 50 });
      expect(next.more).toBe(false);
      expect(next.rows.map(row => [row.stockCode, row.docId])).toEqual([["1006", "S100ACTIVE"]]);
      for (const [code, docId] of [["1001", "S100CORRECT2"], ["1006", "S100ACTIVE"]]) {
        const scoped = await selectLatestHoldingsDocuments(db, { afterCode: null, limit: 50, onlyCode: code });
        expect(scoped.more).toBe(false);
        expect(scoped.rows.map(row => [row.stockCode, row.docId])).toEqual([[code, docId]]);
      }
      for (const code of ["1000", "1002", "1003", "1004", "1005", "1007"]) {
        expect((await selectLatestHoldingsDocuments(db, { afterCode: null, limit: 50, onlyCode: code })).rows).toEqual([]);
      }
      expect(await selectLatestHoldingsDocuments(db, { afterCode: "1001", limit: 1, onlyCode: "1001" })).toEqual({ rows: [], more: false });
      expect(await selectLatestHoldingsDocuments(db, { afterCode: "1006", limit: 1 })).toEqual({ rows: [], more: false });
      sqlite.exec(`INSERT INTO yuho_documents VALUES
        (11,1,'S100NEXTFY','E00001','STRUCTURAL','2027-03-31',90,'120'),
        (12,1,'S100OTHERDOC','E00001','STRUCTURAL','2028-03-31',999,'140');`);
      expect((await selectLatestHoldingsDocuments(db, { afterCode: null, limit: 50, onlyCode: "1001" })).rows[0].docId).toBe("S100NEXTFY");
      sqlite.exec("UPDATE core_stocks SET is_active=0 WHERE code='1001'");
      expect((await selectLatestHoldingsDocuments(db, { afterCode: null, limit: 50, onlyCode: "1001" })).rows).toEqual([]);
      await expect(selectLatestHoldingsDocuments(db, { afterCode: "INVALID", limit: 50 })).rejects.toThrow();
      await expect(selectLatestHoldingsDocuments(db, { afterCode: null, limit: 51 })).rejects.toThrow();
      for (const onlyCode of ["INVALID", " 1001 ", null, 1001]) {
        await expect(selectLatestHoldingsDocuments(db, { afterCode: null, limit: 50, onlyCode: onlyCode as string })).rejects.toThrow();
      }
      // 必須索引の欠落時は同じ1 SQLが失敗し、代替問い合わせを送らない。
      sqlite.exec("DROP INDEX core_stocks_code_unique");
      const beforeMissingIndex = queries.length;
      await expect(selectLatestHoldingsDocuments(db, { afterCode: null, limit: 20 })).rejects.toMatchObject({
        cause: { message: "no such index: core_stocks_code_unique" },
      });
      expect(queries).toHaveLength(beforeMissingIndex + 1);
    } finally { sqlite.close(); }
  });
});
