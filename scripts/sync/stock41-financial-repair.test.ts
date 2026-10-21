import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { getTableColumns, getTableName } from "drizzle-orm";
import * as core from "../../src/shared/db/core-schema.js";
import * as rsi from "../../services/rsi-screening/src/db/schema.js";
import * as swing from "../../services/swing-trading/src/db/schema.js";
import * as projection from "../../src/shared/db/projection-schema.js";
import { STOCK41_CODES, STOCK41_DATE } from "./stock41-price-repair.js";
import { STOCK41_FINANCIAL_STATE_DIR, loadStock41FinancialSources, parseStock41FinancialPre, runStock41FinancialRepair, stock41FinancialReadStatement, type FinancialIo, type FinancialSource } from "./stock41-financial-repair.js";
import type * as Daily from "../../src/cron/daily.js";
import type { JssAnnualRow } from "../../src/shared/db/jss-financials.js";

// Protocol doubles only: no invented market data is accepted by the real CLI source loader.
// Shared normal SQL equivalence is tested separately; actual 82 source bytes are checked below when present.
vi.mock("../../src/cron/daily.js", async importOriginal => ({ ...await importOriginal<typeof Daily>(),
  buildStockSnapshot: (id: number, code: string, _sector: unknown, date: string) => ({ stockId: id, code, dataDate: date }),
}));
const schemas = [core.stockFinancials, rsi.stockRsiPercentile, swing.stockIndicators, projection.momentumProjection, swing.entrySignals, swing.dailyOhlcv];
const dirs: string[] = [], databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
const source: FinancialSource[] = STOCK41_CODES.map(code => ({ code, raw: { ohlcv: [{ date: STOCK41_DATE, open: 1, high: 1, low: 1, close: 1, volume: 0, adj: 1 }] } as FinancialSource["raw"],
  chart: { capture: { symbol: code, status: 200, bytes: new Uint8Array(), url: "protocol-only", headers: {}, receivedAt: "2026-10-18T07:38:26.950Z" }, expectedSha256: "protocol-only", expectedByteLength: 0 }, custody: [] }));
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "stock41-financial-protocol-")); dirs.push(dir);
  const db = new DatabaseSync(":memory:"); databases.push(db);
  db.exec("CREATE TABLE core_stocks(id INTEGER PRIMARY KEY,code TEXT UNIQUE,sector TEXT,is_active INTEGER,instrument_type TEXT); CREATE TABLE jss_financials(code TEXT,fiscal_period_end TEXT,consolidated TEXT,net_sales REAL,disclosure_type TEXT,license_tag TEXT); CREATE TABLE core_stock_annual_financials(stock_id INTEGER,fiscal_year INTEGER,revenue REAL); INSERT INTO core_stock_annual_financials VALUES(99,2025,1);");
  for (const table of schemas) {
    const fields = Object.values(getTableColumns(table)).map(column => `"${column.name}" ${column.getSQLType()}${column.name === "id" ? " PRIMARY KEY AUTOINCREMENT" : column.name === "stock_id" && table !== swing.entrySignals && table !== swing.dailyOhlcv ? " PRIMARY KEY" : ""}${["computed_at", "fetched_at"].includes(column.name) ? " DEFAULT (unixepoch())" : ""}`);
    db.exec(`CREATE TABLE "${getTableName(table)}" (${fields.join(",")})`);
  }
  [...STOCK41_CODES, "protocol-other"].forEach((code, i) => {
    const id = i + 1; db.prepare("INSERT INTO core_stocks VALUES(?,?,NULL,1,'equity')").run(id, code);
    for (const table of schemas.slice(0, 4)) db.prepare(`INSERT INTO "${getTableName(table)}"(stock_id) VALUES(?)`).run(id);
    db.prepare("INSERT INTO swing_daily_ohlcv(stock_id,date,open,high,low,close,volume,adj) VALUES(?,?,1,1,1,1,0,1)").run(id, STOCK41_DATE);
    db.prepare("INSERT INTO swing_entry_signals(stock_id,pattern,direction,entry_price,stop_loss,computed_at) VALUES(?,'protocol-only','long',1,1,0)").run(id);
  });
  const read = vi.fn<FinancialIo["read"]>(async code => { const q = stock41FinancialReadStatement(code); return parseStock41FinancialPre(db.prepare(q.sql).all(...q.params as SQLInputValue[]) as Record<string, unknown>[]); });
  const compile: FinancialIo["compile"] = (snapshot, runStartedSec) => {
    const expectedRows = schemas.slice(0, 4).map(table => {
      const name = getTableName(table), row: Record<string, unknown> = Object.fromEntries(Object.values(getTableColumns(table)).filter(c => c.name !== (table === core.stockFinancials ? "fetched_at" : table === projection.momentumProjection ? "" : "computed_at")).map(c => [c.name, null]));
      row.stock_id = snapshot.stockId;
      if (table === core.stockFinancials) { row.price = 1; row.data_date = STOCK41_DATE; }
      if (table === rsi.stockRsiPercentile) row.rsi_10 = 1;
      if (table === swing.stockIndicators) { row.latest_date = STOCK41_DATE; row.latest_close = 1; }
      if (table === projection.momentumProjection) Object.assign(row, { as_of: STOCK41_DATE, source_max_date: STOCK41_DATE, bars: 1, closes: "1", computed_at: runStartedSec });
      return { table: name, rows: [row] };
    });
    const statements = expectedRows.map(({ table, rows }) => {
      const row = rows[0], names = Object.keys(row), server = table === "core_stock_financials" ? "fetched_at" : table === "p_momentum" ? undefined : "computed_at";
      const fields = names.map(n => `"${n}"`), vals = names.map(() => "?"); if (server) { fields.push(`"${server}"`); vals.push("unixepoch()"); }
      return { sql: `insert into "${table}" (${fields.join(",")}) values (${vals.join(",")}) on conflict(stock_id) do update set ${fields.filter(f => f !== '"stock_id"').map(f => `${f}=excluded.${f}`).join(",")}`, params: Object.values(row) as (string | number | null)[] };
    });
    return { statements, expectedRows };
  };
  const send = vi.fn<FinancialIo["send"]>(async statements => { db.exec("BEGIN"); try { for (const q of statements) db.prepare(q.sql).all(...q.params as SQLInputValue[]); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; } });
  const io: FinancialIo = { read, compile, send, annual: async () => new Map(), probeReceiptAbsent: vi.fn(async () => {}), recordReceipt: vi.fn(async () => {}) };
  return { db, dir, out: join(dir, "out.json"), io, read, send };
}
// Declared protocol annual input, including an unselected scope/null and a future row.
function seedAnnual(s: ReturnType<typeof setup>) {
  const rows: JssAnnualRow[] = [
    { fiscalPeriodEnd: "2024-03-31", consolidated: "連結", revenue: 80 },
    { fiscalPeriodEnd: "2025-03-31", consolidated: "連結", revenue: 100 },
    { fiscalPeriodEnd: "2025-03-31", consolidated: "単体", revenue: null },
    { fiscalPeriodEnd: "2027-03-31", consolidated: "連結", revenue: 999 },
  ];
  for (const row of rows) s.db.prepare("INSERT INTO jss_financials VALUES('1897',?,?,?,'本決算','commercial-ok')").run(row.fiscalPeriodEnd, row.consolidated, row.revenue);
  s.io.annual = async () => new Map([["1897", rows]]);
}
describe("fixed41 normal-snapshot publisher protocol", () => {
  it("atomically updates 4 snapshots, clears zero-result signals only for each stock, and preserves all OHLCV/annual/other stocks", async () => {
    const s = setup(), before = s.db.prepare("SELECT * FROM swing_daily_ohlcv").all(), other = s.db.prepare("SELECT * FROM core_stock_financials WHERE stock_id=42").all();
    // Exercise full PRE/CAS with a REAL that SQLite json_object otherwise truncates to 15 digits.
    s.db.prepare("UPDATE rsi_percentile SET rsi_10=? WHERE stock_id=1").run(48.297719512737984);
    const report = await runStock41FinancialRepair(source, s.dir, s.out, s.io);
    expect(report).toMatchObject({ status: "stock41_snapshot_complete", annualWrites: 0, ohlcvWrites: 0, sourceFetches: 0, models: 0, wholeMarketComplete: false }); expect(report.applied).toHaveLength(41);
    expect(s.db.prepare("SELECT * FROM swing_daily_ohlcv").all()).toEqual(before); expect(s.db.prepare("SELECT * FROM core_stock_financials WHERE stock_id=42").all()).toEqual(other);
    expect(s.db.prepare("SELECT stock_id FROM swing_entry_signals").all()).toEqual([{ stock_id: 42 }]); expect(s.db.prepare("SELECT * FROM core_stock_annual_financials").all()).toEqual([{ stock_id: 99, fiscal_year: 2025, revenue: 1 }]);
    expect(s.send).toHaveBeenCalledTimes(41); for (const [batch] of s.send.mock.calls) expect(batch.every(q => q.params.length <= 100)).toBe(true);
    const uploaded = vi.mocked(s.io.recordReceipt).mock.calls[0][0]; expect(Buffer.from(uploaded)).toEqual(readFileSync(`${s.out}.receipt.json`));
    const events = readFileSync(`${s.out}.events.jsonl`, "utf8").trim().split("\n").map(v => JSON.parse(v));
    expect(events.filter(e => e.phase === "d1_send_intent")).toHaveLength(41); expect(events.filter(e => e.phase === "d1_full_post")).toHaveLength(41);
    expect(events.find(e => e.phase === "receipt_intent").sha256).toBe(createHash("sha256").update(uploaded).digest("hex"));
  });
  it("OHLCV different/NULL remains HOLD and is never overwritten", async () => {
    const s = setup(); s.db.prepare("UPDATE swing_daily_ohlcv SET close=NULL WHERE stock_id=1").run();
    const report = await runStock41FinancialRepair(source, s.dir, s.out, s.io); expect(report.held).toEqual(["1897"]); expect(report.applied).toHaveLength(40); expect(s.send).toHaveBeenCalledTimes(40);
    expect(s.db.prepare("SELECT close FROM swing_daily_ohlcv WHERE stock_id=1").get()).toEqual({ close: null }); expect(s.db.prepare("SELECT price FROM core_stock_financials WHERE stock_id=1").get()).toEqual({ price: null });
  });
  it("full old-row or annual drift rolls back the whole per-stock batch before signals or any snapshot change", async () => {
    const s = setup(), send = s.io.send; seedAnnual(s);
    s.io.send = vi.fn(async batch => { s.db.prepare("UPDATE jss_financials SET net_sales=1 WHERE code='1897' AND consolidated='単体'").run(); await send(batch); });
    await expect(runStock41FinancialRepair(source, s.dir, s.out, s.io)).rejects.toThrow(/STOP/); expect(s.io.send).toHaveBeenCalledTimes(1);
    expect(s.db.prepare("SELECT price FROM core_stock_financials WHERE stock_id=1").get()).toEqual({ price: null }); expect(s.db.prepare("SELECT COUNT(*) AS n FROM swing_entry_signals").get()).toEqual({ n: 42 }); expect(s.io.recordReceipt).not.toHaveBeenCalled();
  });
  it("nonempty annual input preserves every eligible scope/null and ignores only future periods", async () => {
    const s = setup(); seedAnnual(s); const annual = s.db.prepare("SELECT * FROM jss_financials").all();
    const report = await runStock41FinancialRepair(source, s.dir, s.out, s.io); expect(report.applied).toHaveLength(41);
    expect(s.db.prepare("SELECT * FROM jss_financials").all()).toEqual(annual);
    const firstGuard = s.send.mock.calls[0][0].find(q => q.sql.includes("FROM jss_financials"))!;
    expect(JSON.parse(String(firstGuard.params[0]))).toHaveLength(3);
    expect(JSON.parse(String(firstGuard.params[0]))).toContainEqual({ fiscalPeriodEnd: "2025-03-31", consolidated: "単体", revenue: null });
  });
  it("an absent momentum row is qualified before writing and fully verified after insertion", async () => {
    const s = setup(); s.db.prepare("DELETE FROM p_momentum WHERE stock_id=1").run(); const report = await runStock41FinancialRepair(source, s.dir, s.out, s.io); expect(report.applied).toHaveLength(41);
    expect(s.db.prepare("SELECT as_of,bars FROM p_momentum WHERE stock_id=1").get()).toEqual({ as_of: STOCK41_DATE, bars: 1 });
  });
  it("commit-then-unknown stops the next stock and changing out does not bypass the fixed latch", async () => {
    const s = setup(), send = s.io.send; s.io.send = vi.fn(async batch => { await send(batch); throw Error("declared unknown after commit"); });
    await expect(runStock41FinancialRepair(source, s.dir, s.out, s.io)).rejects.toThrow(/STOP/); expect(s.io.send).toHaveBeenCalledTimes(1); expect(s.read).toHaveBeenCalledTimes(1);
    await expect(runStock41FinancialRepair(source, s.dir, join(s.dir, "other.json"), s.io)).rejects.toThrow(/existing fixed-scope/); expect(s.io.recordReceipt).not.toHaveBeenCalled();
    expect(existsSync(join(s.dir, ".stock41-financial-repair-20261016.pending.json"))).toBe(true);
  });
  it("malformed cardinality and newer market rows are rejected before mutation", async () => {
    const s = setup(), compile = s.io.compile; s.io.compile = (snapshot, time) => { const plan = compile(snapshot, time); plan.expectedRows[0].rows.push(plan.expectedRows[0].rows[0]); return plan; };
    await expect(runStock41FinancialRepair(source, s.dir, s.out, s.io)).rejects.toThrow(/STOP/); expect(s.send).not.toHaveBeenCalled();
    const t = setup(); t.db.prepare("UPDATE core_stock_financials SET data_date='2026-10-19' WHERE stock_id=1").run();
    await expect(runStock41FinancialRepair(source, t.dir, t.out, t.io)).rejects.toThrow(/STOP/); expect(t.send).not.toHaveBeenCalled();
    const q = stock41FinancialReadStatement("1897"), rows = t.db.prepare(q.sql).all(...q.params as SQLInputValue[]) as Record<string, unknown>[];
    rows.push(rows.find(row => row.part === "core_stock_financials")!); expect(() => parseStock41FinancialPre(rows)).toThrow(/cardinality/);
    rows.pop(); const financial = rows.find(row => row.part === "core_stock_financials")!;
    financial.data = JSON.stringify({ ...JSON.parse(String(financial.data)), price: { $real: "Infinity" } }); expect(() => parseStock41FinancialPre(rows)).toThrow();
    const u = setup(), read = u.io.read; u.io.read = async code => { const pre = await read(code); pre.ohlcv[0].close = "malformed numeric"; return pre; };
    await expect(runStock41FinancialRepair(source, u.dir, u.out, u.io)).rejects.toThrow(/STOP/); expect(u.send).not.toHaveBeenCalled();
    expect(readFileSync(`${u.out}.events.jsonl`, "utf8")).not.toContain("held_existing_ohlcv");
  });
  it("foreign replay stock_id is rejected before intent and missing out parent leaves no pending or requests", async () => {
    const s = setup(), compile = s.io.compile; s.io.compile = (snapshot, time) => { const plan = compile(snapshot, time); plan.expectedRows[0].rows[0].stock_id = 42; return plan; };
    await expect(runStock41FinancialRepair(source, s.dir, s.out, s.io)).rejects.toThrow(/STOP/); expect(s.send).not.toHaveBeenCalled();
    expect(readFileSync(`${s.out}.events.jsonl`, "utf8")).not.toContain("d1_send_intent");
    const t = setup(); await expect(runStock41FinancialRepair(source, t.dir, join(t.dir, "missing", "out.json"), t.io)).rejects.toThrow(/output parent/);
    expect(existsSync(join(t.dir, ".stock41-financial-repair-20261016.pending.json"))).toBe(false); expect(t.io.probeReceiptAbsent).not.toHaveBeenCalled(); expect(t.read).not.toHaveBeenCalled();
  });
  it("real CLI rejects fixed pending before env/source/API, even after sourceDir and out both change", () => {
    const pending = join(STOCK41_FINANCIAL_STATE_DIR, ".stock41-financial-repair-20261016.pending.json"); expect(existsSync(pending)).toBe(false);
    mkdirSync(STOCK41_FINANCIAL_STATE_DIR, { recursive: true, mode: 0o700 }); writeFileSync(pending, '{"protocolOnly":true}\n', { flag: "wx", mode: 0o600 });
    try {
      for (const name of ["source-a", "source-b"]) {
        const child = spawnSync(process.execPath, ["--import", "tsx", resolve(import.meta.dirname, "stock41-financial-repair.ts"), "--execute", `--source-dir=${name}`, `--out=${name}.json`], { cwd: resolve(import.meta.dirname, "../.."), encoding: "utf8", timeout: 15_000 });
        expect(child.status).toBe(1); expect(child.stderr).toMatch(/preserve fixed pending/); expect(child.stdout).toBe("");
      }
    } finally { rmSync(pending); }
  });
  it("actual generated read SQL obeys workerd compound5/function32 limits and preserves appended NULL/REAL fields", () => {
    const s = setup(); seedAnnual(s);
    const precise = 48.297719512737984;
    const appendedReal = Object.values(getTableColumns(swing.stockIndicators)).filter(column => column.getSQLType() === "real").at(-1)!;
    s.db.prepare(`UPDATE swing_stock_indicators SET "${appendedReal.name}"=? WHERE stock_id=1`).run(precise);
    const schema = s.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string; sql: string }[];
    const q = stock41FinancialReadStatement("1897");
    const oldFlat = q.sql.replace(", group_a AS (", " ").replace("), group_b AS (", " UNION ALL ").replace(") SELECT * FROM group_a UNION ALL SELECT * FROM group_b", "");
    const program = `import json,sqlite3,sys
p=json.load(sys.stdin); c=sqlite3.connect(':memory:'); c.row_factory=sqlite3.Row
c.setlimit(sqlite3.SQLITE_LIMIT_COMPOUND_SELECT,5); c.setlimit(sqlite3.SQLITE_LIMIT_FUNCTION_ARG,32)
assert c.getlimit(sqlite3.SQLITE_LIMIT_COMPOUND_SELECT)==5 and c.getlimit(sqlite3.SQLITE_LIMIT_FUNCTION_ARG)==32
for t in p['tables']:
 c.execute(t['sql'])
 for row in t['rows']:
  keys=list(row); c.execute('INSERT INTO "'+t['name']+'" ('+','.join('"'+k+'"' for k in keys)+') VALUES ('+','.join('?' for k in keys)+')',[row[k] for k in keys])
try: c.execute(p['oldFlat'],p['params']); raise AssertionError('old flat query must exceed limit5')
except sqlite3.OperationalError as e: assert 'too many terms' in str(e)
try: c.execute('SELECT json_object('+','.join("'k%d',NULL"%i for i in range(17))+')'); raise AssertionError('old wide json_object must exceed limit32')
except sqlite3.OperationalError as e: assert 'too many arguments' in str(e)
print(json.dumps([dict(r) for r in c.execute(p['sql'],p['params'])]))
`;
    // Stdlib SQLite capabilities are asserted below; Node CI does not promise a versioned Python binary.
    const child = spawnSync("python3", ["-c", program], { input: JSON.stringify({ sql: q.sql, params: q.params, oldFlat, tables: schema.map(table => ({ ...table, rows: s.db.prepare(`SELECT * FROM "${table.name}"`).all() })) }), encoding: "utf8", timeout: 30_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const pre = parseStock41FinancialPre(JSON.parse(child.stdout));
    expect(pre.tables.swing_stock_indicators[0][appendedReal.name]).toBe(precise);
    expect(pre.tables.core_stock_financials[0].price).toBeNull(); expect(pre.ohlcv[0].volume).toBe(0);
    expect(pre.annual).toContainEqual({ fiscalPeriodEnd: "2025-03-31", consolidated: "単体", revenue: null });
  });
});

const savedDir = resolve(import.meta.dirname, "../../../../feature-audit-20261018/stock41-fresh5y-capture-v2");
it.skipIf(!existsSync(join(savedDir, "result.json")))("actual accepted 82 source bytes replay all41 normal calculations and SQL through the atomic publisher offline", async () => {
  const meta = JSON.parse(readFileSync(join(savedDir, "captured-source/1897-chart.json"), "utf8")), proxy = new URL(meta.url); proxy.pathname = ""; proxy.search = "";
  const sources = await loadStock41FinancialSources(savedDir, proxy.origin); expect(sources).toHaveLength(41);
  const actual = await vi.importActual<typeof Daily>("../../src/cron/daily.js"), db = drizzle(async () => { throw Error("offline compiler must execute zero queries"); });
  for (const [i, value] of sources.entries()) {
    const snapshot = actual.buildStockSnapshot(i + 1, value.code, null, STOCK41_DATE, value.raw, [], value.chart.capture);
    const replay = actual.buildStockSnapshotStatements(db as unknown as Parameters<typeof actual.buildStockSnapshotStatements>[0], snapshot, STOCK41_DATE, { writeAnnual: false, runStartedSec: Math.floor(Date.now() / 1000) });
    expect(replay.statements.every(q => q.params.length <= 100 && !/core_stock_annual_financials|swing_daily_ohlcv|delete /i.test(q.sql))).toBe(true);
  }
  // Explicit protocol JSS rows exercise the normal calculation; no claim about live annual qualification.
  const s = setup(); seedAnnual(s);
  for (const [i, value] of sources.entries()) {
    const bar = value.raw.ohlcv.at(-1)!;
    expect(bar.adj).not.toBeUndefined(); if (bar.adj === undefined) throw Error("actual source missing adjusted close");
    s.db.prepare("UPDATE swing_daily_ohlcv SET open=?,high=?,low=?,close=?,volume=?,adj=? WHERE stock_id=?").run(bar.open, bar.high, bar.low, bar.close, bar.volume, bar.adj, i + 1);
  }
  const mocked = await import("../../src/cron/daily.js"), spy = vi.spyOn(mocked, "buildStockSnapshot").mockImplementation(actual.buildStockSnapshot);
  s.io.compile = (snapshot, runStartedSec) => actual.buildStockSnapshotStatements(db as unknown as Parameters<typeof actual.buildStockSnapshotStatements>[0], snapshot, STOCK41_DATE, { writeAnnual: false, runStartedSec });
  try { const report = await runStock41FinancialRepair(sources, s.dir, s.out, s.io); expect(report.applied).toHaveLength(41); expect(report.held).toHaveLength(0); }
  finally { spy.mockRestore(); }
});
