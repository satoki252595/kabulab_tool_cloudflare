import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STOCK41_CODES, STOCK41_DATE, loadStock41Sources, replayStock41Bar, runStock41Repair, type Stock41Io, type Stock41Pre, type Stock41Source } from "./stock41-price-repair.js";

// 財務データのfixtureではなく、単発publisherの通信/競合を検証する純構造double。
// 本番入口では固定refs SHA→33 gzip/member全SHA→実parserを通さなければ到達しない。
const sources: Stock41Source[] = STOCK41_CODES.map(code => ({ code,
  row: { date: STOCK41_DATE, open: 3535, high: 3535, low: 3535, close: 3535, volume: 0, adj: 3535 },
  source: { file: { archivePageId: "protocol-only", filename: "protocol-only.gz", sha256: "protocol-only", byteLength: 1 }, symbol: `${code}.T`, receivedAt: "2026-10-18T02:36:12.160Z", bodySha256: "protocol-only", bodyBytes: 1 },
}));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "stock41-protocol-")); dirs.push(dir);
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE core_stocks(id INTEGER PRIMARY KEY,code TEXT UNIQUE,is_active INTEGER,instrument_type TEXT); CREATE TABLE swing_daily_ohlcv(id INTEGER PRIMARY KEY,stock_id INTEGER,date TEXT,open REAL,high REAL,low REAL,close REAL,volume REAL,adj REAL,UNIQUE(stock_id,date));");
  STOCK41_CODES.forEach((code, i) => db.prepare("INSERT INTO core_stocks VALUES(?,?,1,'equity')").run(i + 1, code));
  const read = vi.fn(async (codes: readonly string[]) => new Map(codes.map(code => {
    const stockId = STOCK41_CODES.indexOf(code as typeof STOCK41_CODES[number]) + 1;
    const row = db.prepare("SELECT date,open,high,low,close,volume,adj FROM swing_daily_ohlcv WHERE stock_id=? AND date=?").get(stockId, STOCK41_DATE);
    return [code, { stockId, row: row === undefined ? null : row as unknown as NonNullable<Stock41Pre["row"]> }];
  })));
  const send = vi.fn<Stock41Io["send"]>(async statements => {
    db.exec("BEGIN");
    try { for (const statement of statements) db.prepare(statement.sql).all(...statement.params as SQLInputValue[]); db.exec("COMMIT"); }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  });
  const io: Stock41Io = { read, send, probeReceiptAbsent: vi.fn(async () => {}), recordReceipt: vi.fn(async () => {}) };
  return { dir, out: join(dir, "out.json"), db, io, read, send };
}

describe("固定41社の価格ONLY publisher", () => {
  it("最大12行の4原子batchとexact readback、同値はD1 write0・NULL不同はHOLD", async () => {
    const s = setup();
    s.db.prepare("INSERT INTO swing_daily_ohlcv(stock_id,date,open,high,low,close,volume,adj) VALUES(1,?,3535,3535,3535,3535,0,3535)").run(STOCK41_DATE);
    s.db.prepare("INSERT INTO swing_daily_ohlcv(stock_id,date) VALUES(2,?)").run(STOCK41_DATE);
    const report = await runStock41Repair(sources, s.dir, s.out, s.io);
    expect(report).toMatchObject({ status: "price_scope_held", applied: 39, write0: 1, held: ["1992"], financialSnapshotUpdated: false, rsiUpdated: false, wholeMarketComplete: false });
    expect(s.send).toHaveBeenCalledTimes(4);
    for (const [statements] of s.send.mock.calls) {
      expect(statements).toHaveLength(3);
      expect(statements[2].sql).toMatch(/^INSERT INTO swing_daily_ohlcv /);
      expect(statements[2].params.length).toBeLessThanOrEqual(96);
      expect(statements[2].sql).not.toMatch(/UPDATE|CONFLICT|financial|rsi|computed/i);
    }
    expect(s.db.prepare("SELECT close FROM swing_daily_ohlcv WHERE stock_id=2").get()).toEqual({ close: null });
    expect(statSync(join(s.dir, ".stock41-price-repair-20261016.completed.json")).mode & 0o777).toBe(0o600);
    const journal = readFileSync(`${s.out}.events.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(journal.filter(event => event.phase === "d1_send_intent")).toHaveLength(4);
    expect(journal.filter(event => event.phase === "d1_full_readback")).toHaveLength(4);
  });

  it("commit後応答不明は次chunkを送らず、出力名を変えても同scopeへ再入場しない", async () => {
    const s = setup(), nativeSend = s.io.send;
    s.io.send = vi.fn(async statements => { await nativeSend(statements); throw new Error("unknown after commit"); });
    await expect(runStock41Repair(sources, s.dir, s.out, s.io)).rejects.toThrow(/STOP/);
    expect(s.io.send).toHaveBeenCalledTimes(1); expect(s.read).toHaveBeenCalledTimes(1);
    expect(s.db.prepare("SELECT count(*) AS n FROM swing_daily_ohlcv").get()).toEqual({ n: 12 });
    expect(existsSync(join(s.dir, ".stock41-price-repair-20261016.pending.json"))).toBe(true);
    expect(s.io.recordReceipt).not.toHaveBeenCalled();
    await expect(runStock41Repair(sources, s.dir, join(s.dir, "different-output.json"), s.io)).rejects.toThrow(/既存証跡/);
    expect(s.io.send).toHaveBeenCalledTimes(1);
  });

  it("PRE後の競合を既不存在CASが検出し、既存行を上書きしない", async () => {
    const s = setup(), nativeSend = s.io.send;
    s.io.send = vi.fn(async statements => {
      s.db.prepare("INSERT INTO swing_daily_ohlcv(stock_id,date,close) VALUES(1,?,3535)").run(STOCK41_DATE);
      await nativeSend(statements);
    });
    await expect(runStock41Repair(sources, s.dir, s.out, s.io)).rejects.toThrow(/STOP/);
    expect(s.io.send).toHaveBeenCalledTimes(1);
    expect(s.db.prepare("SELECT count(*) AS n FROM swing_daily_ohlcv").get()).toEqual({ n: 1 });
    expect(s.io.recordReceipt).not.toHaveBeenCalled();
  });

  it("全41同値ならD1 write0。変更対象外の財務/RSIを成功とは記録しない", async () => {
    const s = setup();
    sources.forEach((source, i) => s.db.prepare("INSERT INTO swing_daily_ohlcv(stock_id,date,open,high,low,close,volume,adj) VALUES(?,?,?,?,?,?,?,?)").run(i + 1, source.row.date, source.row.open, source.row.high, source.row.low, source.row.close, source.row.volume, source.row.adj));
    const report = await runStock41Repair(sources, s.dir, s.out, s.io);
    expect(report).toMatchObject({ status: "price_scope_complete", applied: 0, write0: 41, financialSnapshotUpdated: false, rsiUpdated: false, wholeMarketComplete: false });
    expect(s.send).not.toHaveBeenCalled();
  });

  it("ACK後full readbackが欠ければ、後続chunk/receiptに進まずpendingを保持", async () => {
    const s = setup(), nativeRead = s.io.read;
    s.io.read = vi.fn(async codes => {
      const rows = await nativeRead(codes);
      if (codes.length !== 41) rows.delete(codes[0]);
      return rows;
    });
    await expect(runStock41Repair(sources, s.dir, s.out, s.io)).rejects.toThrow(/STOP/);
    expect(s.send).toHaveBeenCalledTimes(1); expect(s.io.recordReceipt).not.toHaveBeenCalled();
    expect(existsSync(join(s.dir, ".stock41-price-repair-20261016.pending.json"))).toBe(true);
  });
});

it("原文精度・実volume0を保ち、別日/範囲外コードを採用しない", () => {
  const chart = { chart: { error: null, result: [{ meta: { symbol: "1897.T", regularMarketPrice: 3535.125 }, timestamp: [Date.UTC(2026, 9, 16) / 1000], indicators: { quote: [{ open: [3535.125], high: [3535.125], low: [3535.125], close: [3535.125], volume: [0] }], adjclose: [{ adjclose: [3535.125] }] } }] } };
  const bytes = () => Buffer.from(JSON.stringify(chart));
  expect(replayStock41Bar("1897", bytes())).toMatchObject({ close: 3535.125, volume: 0, adj: 3535.125 });
  expect(() => replayStock41Bar("8303", bytes())).toThrow(/範囲外/);
  chart.chart.result[0].timestamp = [Date.UTC(2026, 9, 15) / 1000];
  expect(() => replayStock41Bar("1897", bytes())).toThrow(/一意/);
});

it("受入refsの1byte差は、原本読取・全native通信前にSTOP", async () => {
  const s = setup();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("native forbidden"); }));
  await expect(loadStock41Sources(s.out, s.dir)).rejects.toThrow(); // 存在しないrefsも採用しない。
  await expect(loadStock41Sources(import.meta.filename, s.dir)).rejects.toThrow(/SHA不一致/);
  expect(fetch).not.toHaveBeenCalled();
});

it("実CLIはsource-dir/outを変えても同checkoutの固定latchでnative前に停止", () => {
  const cli = resolve(import.meta.dirname, "stock41-price-repair.ts");
  const pending = resolve(import.meta.dirname, "../../tmp/stock-gap-repair/.stock41-price-repair-20261016.pending.json");
  // 固定latchの存在だけを子process内でdoubleにする。実pendingや.envは変更しない。
  const preload = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const native=fs.existsSync; fs.existsSync=p=>{if(String(p)===${JSON.stringify(pending)}){console.error('TEST_FIXED_LATCH_HIT');return true;}return native(p);}; syncBuiltinESMExports();
    globalThis.fetch=()=>{console.error('TEST_NATIVE_FORBIDDEN');throw new Error('native forbidden');};`;
  for (const suffix of ["one", "two"]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--import", `data:text/javascript,${encodeURIComponent(preload)}`, cli,
      "--execute", `--refs-file=/nonexistent-refs-${suffix}`, `--source-dir=/different-source-${suffix}`, `--out=/different-output-${suffix}`], { encoding: "utf8", timeout: 15_000 });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("TEST_FIXED_LATCH_HIT");
    expect(child.stderr).not.toContain("TEST_NATIVE_FORBIDDEN");
  }
});
