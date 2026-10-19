/** Tests only: real SQLite migration with no reported changes; never a production source substitute. */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { ReportedSourceDb } from "../../../services/yuho-quant/src/services/edinet/reported-changes.js";

export function createReportedSourceTestDb() {
  const sqlite = new DatabaseSync(":memory:");
  const originalSchema=readFileSync(new URL("../../../drizzle/d1/0000_clean_tag.sql",import.meta.url),"utf8");
  const documentDdl=originalSchema.match(/CREATE TABLE `yuho_documents` \([\s\S]*?\n\);/);
  if(!documentDdl)throw new Error("actual document schema missing");
  sqlite.exec(documentDdl[0]);
  sqlite.exec(readFileSync(new URL("../../../drizzle/d1/0032_edinet_reported_changes.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../../../drizzle/d1/0034_edinet_reported_resolutions.sql", import.meta.url), "utf8"));
  const db = drizzle(async (query, args, method) => {
    const stmt = sqlite.prepare(query);
    const params = args as (string | number | null)[];
    if (method === "run") { stmt.run(...params); return { rows: [] }; }
    const rows = (stmt.all(...params) as Record<string, unknown>[]).map(row => Object.values(row));
    return { rows: method === "get" ? rows[0] : rows };
  }) as ReportedSourceDb;
  return { sqlite, db };
}
