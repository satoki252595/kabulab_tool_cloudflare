/** Real saved6963 rows; transport/parser bridges and concurrent reported-state faults are offline controls. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openActualSnapshot, readSnapshot } from "./lib/saved-overseas-atomic.js";
import { parseOverseasHtml } from "../src/services/overseas-parser.js";
import type { D1BatchStatement } from "../../../src/shared/db/d1-http-client.js";

const io = vi.hoisted(() => ({ db: undefined as unknown, batch: vi.fn(), download: vi.fn(),
  archive: vi.fn(), backup: vi.fn(), retire: vi.fn(), overseas: undefined as unknown }));
vi.mock("../../../src/shared/db/d1-http-client.js", async original => ({
  ...await original<typeof import("../../../src/shared/db/d1-http-client.js")>(),
  createD1HttpDb: () => io.db, createD1HttpBatchSender: () => io.batch,
}));
vi.mock("../../../src/shared/db/active-equity.js", async original => ({
  ...await original<typeof import("../../../src/shared/db/active-equity.js")>(),
  loadIngestCodeToId: async () => new Map([["6963", 4104]]),
}));
vi.mock("../src/services/edinet/client.js", async original => ({
  ...await original<typeof import("../src/services/edinet/client.js")>(), downloadDocument: io.download,
}));
vi.mock("../src/services/edinet/archive.js", async original => ({
  ...await original<typeof import("../src/services/edinet/archive.js")>(), recordEdinetZip: io.archive,
}));
vi.mock("../src/services/overseas-parser.js", async original => ({
  ...await original<typeof import("../src/services/overseas-parser.js")>(), parseOverseasData: () => io.overseas,
}));
vi.mock("../src/services/edinet/csv.js", async original => ({
  ...await original<typeof import("../src/services/edinet/csv.js")>(), parseEdinetCsvZip: () => [],
}));
vi.mock("../src/services/edinet/text-sections.js", async original => ({
  ...await original<typeof import("../src/services/edinet/text-sections.js")>(),
  // Declared structural section: deliberately not presented as a source quotation.
  extractTextSections: () => [{ sectionKey: "business", elementId: "e-control", itemName: "事業の内容",
    contextId: "control", text: "並行HOLDの構造検証", charCount: 11 }],
}));
vi.mock("../src/services/text-backup.js", () => ({ backupDocTextToNotion: io.backup }));
vi.mock("../../../src/shared/notion-archive/index.js", async original => ({
  ...await original<typeof import("../../../src/shared/notion-archive/index.js")>(), retireStockTextRow: io.retire,
}));
const root = fileURLToPath(new URL("../../..", import.meta.url));
const fixture = JSON.parse(readFileSync(new URL("../src/tests/fixtures/ingest-csv-reingest-6963/saved-business.json", import.meta.url), "utf8"));
const argv = process.argv, exitCode = process.exitCode;
beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
  vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { process.argv = argv; process.exitCode = exitCode; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(["overseas", "text"].flatMap(mode => ["reported_withdrawal", "reported_status_unqualified"].flatMap(state =>
  ["before-download", "before-batch"].map(phase => ({ mode, state, phase })))))("$mode entry preserves all old facts/text/pointer when $state arrives $phase", async ({ mode, state, phase }) => {
  const sqlite = openActualSnapshot(root, fixture.d1);
  try {
    io.db = drizzle(async (query, params, method) => {
      const statement = sqlite.prepare(query), names = statement.columns().map(column => column.name);
      const rows = (statement.all(...params as never[]) as Record<string, unknown>[]).map(row => names.map(name => row[name]));
      return { rows: method === "get" ? rows[0] : rows };
    });
    const hold = () => sqlite.prepare("INSERT INTO yuho_edinet_reported_changes (source_page_id,seq_number,source_raw_sha256,doc_id,reported_state,observation_json) VALUES ('offline-concurrent-report',0,?,?,?,'{}')")
      .run("0".repeat(64), fixture.item.docId, state);
    const before = readSnapshot(sqlite, fixture.item.stockId);
    io.download.mockResolvedValue(Buffer.from("offline byte/parser transport bridge"));
    io.overseas = parseOverseasHtml(readFileSync(new URL("../src/tests/fixtures/georows-2dproduct-sales-S100YBHC.html", import.meta.url), "utf8"), fixture.item.periodEnd);
    io.archive.mockImplementation(async () => { hold(); return { pageId: fixture.item.archivePageId, manifestMatch: "match" }; });
    io.backup.mockImplementation(async () => { hold(); return { rowPageId: "offline-new-pointer", replacedRowPageId: "offline-old-pointer", outcome: "recorded" }; });
    io.batch.mockImplementation(async (batch: D1BatchStatement[]) => {
      sqlite.exec("BEGIN");
      try { for (const statement of batch) sqlite.prepare(statement.sql).run(...statement.params as never[]); sqlite.exec("COMMIT"); }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    });
    if (phase === "before-download") hold();
    process.argv = [argv[0], "backfill-control.ts", "--force", "--limit=1"];
    const run = mode === "overseas" ? import("./backfill-overseas.js") : import("./backfill-text-sections.js");
    if (mode === "overseas") await expect(run).rejects.toThrow("overseas_saved_cohort_required");
    else { await run; expect(process.exitCode).toBe(1); }
    // 廃止した海外取得入口は、並行状態の到着段階によらず通信・書込前に拒否する。
    const calls = mode === "overseas" || phase === "before-download" ? 0 : 1;
    expect(io.download).toHaveBeenCalledTimes(calls);
    expect(io.batch).toHaveBeenCalledTimes(calls);
    expect(io.retire).not.toHaveBeenCalled();
    expect(readSnapshot(sqlite, fixture.item.stockId)).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  } finally { sqlite.close(); }
});
