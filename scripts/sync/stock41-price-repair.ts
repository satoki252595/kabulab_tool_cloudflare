/** 10/16の価格欠測41社だけを、通常VWAPが10/18に物理保管した10y原文から補完する。 */
import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { sharedEnv } from "../../src/shared/env.js";
import { assertD1SingleQueryResponse, createD1HttpBatchSender, d1HttpQueryUrl, type D1BatchStatement } from "../../src/shared/db/d1-http-client.js";
import { parseChartResponse, parseDailyChart } from "../../src/shared/yahoo/client.js";
import { guardChartBars } from "../../src/shared/yahoo/bar-sanity.js";
import { OHLCV_REPAIR_CHUNK_ROWS, buildOhlcvInsertStatement, buildOhlcvNonexistencePreflightStatement, buildStockIdentityPreflightStatement, type OhlcvInsertRow } from "../../src/shared/repair-preflight.js";
import { findUniqueBackupChildByTitle, queryUniqueRow } from "../../src/shared/notion-archive/archive.js";
import { recordPrimaryData } from "../../src/shared/notion-archive/index.js";
import { notionEnv } from "../../src/shared/notion-archive/env.js";
import { ohlcvSevenEqual, verifyReceiptAttachment, type OhlcvSeven } from "./stock-gap-repair.js";

export const STOCK41_DATE = "2026-10-16";
export const STOCK41_REFS_SHA256 = "8adc58c052b734d454430a6e024fb66f7f825fb550ff9cf197a15de1cc2f7311";
export const STOCK41_CODES = ["1897", "1992", "2349", "2876", "3184", "3583", "3816", "3945", "4102", "4247", "5458", "5753", "5918", "5921", "5945", "6042", "6342", "6346", "6360", "6396", "6772", "6797", "7031", "7297", "7345", "7413", "7509", "7521", "8139", "9012", "9049", "9087", "9311", "9361", "9408", "9476", "9635", "9636", "9767", "9895", "9929"] as const;
const RECEIPT_KEY = "price-sync-repair-20261016-stock41-8adc58c052b7";
const LATCH_NAME = ".stock41-price-repair-20261016.pending.json";
// source-dir/out/CWDを変えても同checkoutの固定scope latchを迂回できない。
const STATE_DIR = fileURLToPath(new URL("../../tmp/stock-gap-repair/", import.meta.url));
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const clock = () => new Date().toISOString();
type SourceRef = { file: { archivePageId: string; filename: string; sha256: string; byteLength: number }; symbol: string; receivedAt: string; bodySha256: string; bodyBytes: number };
export type Stock41Source = { code: string; row: OhlcvSeven; source: SourceRef };
export type Stock41Pre = { stockId: number; row: OhlcvSeven | null };
export interface Stock41Io {
  read: (codes: readonly string[]) => Promise<Map<string, Stock41Pre>>;
  send: (statements: readonly D1BatchStatement[]) => Promise<void>;
  probeReceiptAbsent: () => Promise<void>;
  recordReceipt: (bytes: Uint8Array) => Promise<void>;
}

/** 既9/29 repairと同じ全履歴guard。VWAPの丸め済み価格は保存へ流用しない。 */
export function replayStock41Bar(code: string, bytes: Uint8Array): OhlcvSeven {
  assert.ok((STOCK41_CODES as readonly string[]).includes(code), "固定41社の範囲外");
  const parsed = parseChartResponse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), code);
  const guarded = guardChartBars(parsed.bars, parsed.meta.regularMarketPrice, code);
  const raw = parsed.bars.filter(bar => bar.date === STOCK41_DATE);
  const kept = guarded.bars.filter(bar => bar.date === STOCK41_DATE);
  assert.equal(raw.length, 1, "対象日の原文バーが一意でない");
  assert.equal(kept.length, 1, "対象日のguard通過バーが一意でない");
  assert.ok(raw[0].close !== null && Number.isFinite(raw[0].close) && raw[0].close > 0, "原文終値が正有限でない");
  for (const key of ["open", "high", "low", "close", "volume", "adj"] as const) assert.equal(kept[0][key], raw[0][key], "guardが原値を変えた");
  const bar = kept[0];
  assert.ok(bar.adj !== undefined, "調整終値の資格が不明");
  for (const key of ["open", "high", "low", "close", "volume", "adj"] as const) assert.ok(typeof bar[key] === "number" && Number.isFinite(bar[key]) && (key === "volume" ? bar[key] >= 0 : bar[key] > 0), "対象日の原値が有効でない");
  return { date: STOCK41_DATE, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, adj: bar.adj };
}

/** 固定受入refsだけを読み、41社に必要な33物理原本だけを検証する。HTTPは呼ばない。 */
export async function loadStock41Sources(refsFile: string, sourceDir: string): Promise<Stock41Source[]> {
  assert.ok(statSync(refsFile).size <= 16 * 1024 ** 2, "refs byte上限");
  const bytes = readFileSync(refsFile);
  assert.equal(sha(bytes), STOCK41_REFS_SHA256, "受入refsのSHA不一致");
  // SHA一致後にだけ、この受入済み文書の既知schemaを読む。
  const refs = JSON.parse(bytes.toString("utf8")) as { originalRunId: string; sessionDate: string; normalOriginalPhysicalArchiveAccepted: boolean; references: Record<string, SourceRef> };
  assert.equal(refs.originalRunId, "local-9fe26841");
  assert.equal(refs.sessionDate, STOCK41_DATE);
  assert.equal(refs.normalOriginalPhysicalArchiveAccepted, true);
  const byFile = new Map<string, string[]>();
  for (const code of STOCK41_CODES) {
    const ref = refs.references[code];
    assert.equal(ref.symbol, `${code}.T`);
    assert.match(ref.receivedAt, /^2026-10-18T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(new Date(ref.receivedAt).toISOString(), ref.receivedAt);
    assert.equal(basename(ref.file.filename), ref.file.filename);
    const codes = byFile.get(ref.file.filename);
    if (codes === undefined) byFile.set(ref.file.filename, [code]); else codes.push(code);
  }
  assert.equal(byFile.size, 33, "固定物理原本33件と不一致");
  const result: Stock41Source[] = [];
  let gzipBytes = 0;
  for (const [filename, codes] of byFile) {
    const ref = refs.references[codes[0]], filePath = join(sourceDir, filename);
    assert.ok(ref.file.byteLength > 0 && ref.file.byteLength <= 8 * 1024 ** 2);
    assert.equal(statSync(filePath).size, ref.file.byteLength, "gzip長不一致");
    const gz = readFileSync(filePath); gzipBytes += gz.length;
    assert.ok(gzipBytes <= 64 * 1024 ** 2, "gzip合計byte上限");
    assert.equal(sha(gz), ref.file.sha256, "gzip全SHA不一致");
    const part = JSON.parse(gunzipSync(gz, { maxOutputLength: 32 * 1024 ** 2 }).toString("utf8")) as {
      runId: string; service: string; stage: string; members: { api: string; symbol: string; status: number; receivedAt: string; byteLength: number; sha256: string; bodyBase64: string }[];
    };
    assert.equal(part.runId, refs.originalRunId); assert.equal(part.service, "vwap-analysis");
    assert.match(part.stage, /^vwap-daily-\d+$/);
    for (const code of codes) {
      const source = refs.references[code];
      assert.deepEqual(source.file, ref.file, "同一gzipの来歴不一致");
      const members = part.members.filter(member => member.api === "daily" && member.symbol === source.symbol);
      assert.equal(members.length, 1, "原文memberが一意でない");
      const member = members[0], body = Buffer.from(member.bodyBase64, "base64");
      assert.equal(member.status, 200); assert.equal(member.receivedAt, source.receivedAt);
      assert.equal(body.length, source.bodyBytes); assert.equal(body.length, member.byteLength);
      assert.equal(sha(body), source.bodySha256); assert.equal(sha(body), member.sha256);
      // 同じ本番parserでsymbol/range echo・原文全OHLCV・CA構造を確認する。
      await parseDailyChart(source.symbol, "10y", body, source.receivedAt);
      result.push({ code, row: replayStock41Bar(code, body), source });
    }
  }
  return STOCK41_CODES.map(code => { const value = result.find(row => row.code === code); assert.ok(value); return value; });
}

function syncParent(file: string): void {
  const fd = openSync(dirname(file), constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function saveNew(file: string, value: unknown): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  syncParent(file);
}

/** D1送信前から固定scopeをlatchする。unknown後はpendingを残し、再入場・再送しない。 */
export async function runStock41Repair(sources: readonly Stock41Source[], stateDir: string, out: string, io: Stock41Io) {
  assert.deepEqual(sources.map(value => value.code), [...STOCK41_CODES], "固定41社集合/順序の不一致");
  for (const value of sources) assert.equal(value.row.date, STOCK41_DATE);
  const pending = join(stateDir, LATCH_NAME), journal = `${out}.events.jsonl`, receiptPath = `${out}.receipt.json`, completed = join(stateDir, ".stock41-price-repair-20261016.completed.json");
  assert.equal([out, journal, receiptPath, pending, completed].some(file => existsSync(file)), false, "既存証跡は再送せず読取照合する");
  saveNew(pending, { version: 1, scope: "stock41_price_only", refsSha256: STOCK41_REFS_SHA256, out: resolve(out), journal: resolve(journal), startedAt: clock(), noAutomaticReplay: true, sources });
  saveNew(journal, { phase: "start", time: clock(), pendingSha256: sha(readFileSync(pending)) });
  const append = (event: object) => {
    const fd = openSync(journal, constants.O_WRONLY | constants.O_APPEND);
    try { writeFileSync(fd, JSON.stringify({ time: clock(), ...event }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  };
  try {
    await io.probeReceiptAbsent();
    const pre = await io.read(STOCK41_CODES);
    assert.equal(pre.size, STOCK41_CODES.length, "現在のactive equity同一性が不明");
    assert.equal(new Set([...pre.values()].map(value => value.stockId)).size, STOCK41_CODES.length, "stockId重複");
    const inserts: OhlcvInsertRow[] = [], write0: string[] = [], held: string[] = [], applied: string[] = [];
    for (const value of sources) {
      const current = pre.get(value.code); assert.ok(current);
      assert.ok(Number.isSafeInteger(current.stockId) && current.stockId > 0);
      if (current.row === null) inserts.push({ stockId: current.stockId, code: value.code, ...value.row });
      else if (ohlcvSevenEqual(current.row, value.row)) write0.push(value.code);
      else held.push(value.code); // NULL行も上書きしない。
    }
    append({ phase: "current_pre_and_plan", pre: [...pre], inserts, write0, held });
    for (let offset = 0; offset < inserts.length; offset += OHLCV_REPAIR_CHUNK_ROWS) {
      const chunk = inserts.slice(offset, offset + OHLCV_REPAIR_CHUNK_ROWS);
      const statements = [buildStockIdentityPreflightStatement(chunk), buildOhlcvNonexistencePreflightStatement(chunk), buildOhlcvInsertStatement(chunk)];
      append({ phase: "d1_send_intent", chunk: offset / OHLCV_REPAIR_CHUNK_ROWS, statements });
      await io.send(statements); // 単発。throw後の後続chunk/readback/再送は行わない。
      append({ phase: "d1_ack", chunk: offset / OHLCV_REPAIR_CHUNK_ROWS });
      const post = await io.read(chunk.map(row => row.code));
      assert.equal(post.size, chunk.length, "readback銘柄数不一致");
      for (const row of chunk) {
        const value = post.get(row.code);
        assert.ok(value !== undefined && value.stockId === row.stockId && value.row !== null && ohlcvSevenEqual(value.row, row), "D1 full tuple readback不一致");
        applied.push(row.code);
      }
      append({ phase: "d1_full_readback", chunk: offset / OHLCV_REPAIR_CHUNK_ROWS, post: [...post] });
    }
    const receipt = { version: 1, scope: "stock41_price_only", key: RECEIPT_KEY, marketDate: STOCK41_DATE, range: "10y", refsSha256: STOCK41_REFS_SHA256,
      generatedAt: clock(), sources, currentPre: [...pre], applied, write0, held, financialSnapshotUpdated: false, rsiUpdated: false, wholeMarketComplete: false };
    saveNew(receiptPath, receipt);
    const receiptBytes = readFileSync(receiptPath);
    append({ phase: "notion_receipt_send_intent", key: RECEIPT_KEY, receiptSha256: sha(receiptBytes), receiptPath: resolve(receiptPath) });
    await io.recordReceipt(receiptBytes);
    append({ phase: "notion_receipt_full_readback", key: RECEIPT_KEY });
    const report = { status: held.length === 0 ? "price_scope_complete" : "price_scope_held", scope: "stock41_price_only", marketDate: STOCK41_DATE,
      selected: sources.length, applied: applied.length, write0: write0.length, held, sourceRequests: 0, models: 0,
      receiptKey: RECEIPT_KEY, receiptSha256: sha(receiptBytes), journalSha256: sha(readFileSync(journal)), financialSnapshotUpdated: false, rsiUpdated: false, wholeMarketComplete: false };
    saveNew(out, report);
    linkSync(pending, completed); syncParent(completed); unlinkSync(pending); syncParent(pending);
    return report;
  } catch {
    append({ phase: "stopped_no_replay", pendingPreserved: true });
    throw new Error("価格補完STOP。pending/intentを保全しました。再送せず読取照合してください");
  }
}

/** 41社だけのcurrent PRE/full readback。存在しないOHLCV行と既存NULL行を区別する。 */
async function readCurrent(codes: readonly string[]): Promise<Map<string, Stock41Pre>> {
  assert.ok(codes.length > 0 && codes.length <= 41 && new Set(codes).size === codes.length);
  for (const code of codes) assert.ok((STOCK41_CODES as readonly string[]).includes(code));
  const response = await fetch(d1HttpQueryUrl(), { method: "POST", signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${sharedEnv.CLOUDFLARE_API_TOKEN()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql: `SELECT s.id AS stockId,s.code,o.id AS presentId,o.date,o.open,o.high,o.low,o.close,o.volume,o.adj FROM core_stocks s LEFT JOIN swing_daily_ohlcv o ON o.stock_id=s.id AND o.date=? WHERE s.is_active=1 AND s.instrument_type='equity' AND s.code IN (${codes.map(() => "?").join(",")})`, params: [STOCK41_DATE, ...codes] }) });
  assert.equal(response.status, 200, "D1読取HTTP失敗");
  assert.ok(response.body, "D1読取body欠測");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.length; assert.ok(length <= 1024 ** 2, "D1読取byte上限"); chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  const rows = assertD1SingleQueryResponse(JSON.parse(Buffer.concat(chunks, length).toString("utf8"))), out = new Map<string, Stock41Pre>();
  for (const raw of rows) {
    assert.ok(typeof raw.code === "string" && codes.includes(raw.code) && !out.has(raw.code), "D1銘柄同一性不一致");
    assert.ok(typeof raw.stockId === "number" && Number.isSafeInteger(raw.stockId) && raw.stockId > 0);
    let row: OhlcvSeven | null = null;
    if (raw.presentId !== null) {
      assert.ok(typeof raw.presentId === "number" && Number.isSafeInteger(raw.presentId) && raw.presentId > 0);
      assert.equal(raw.date, STOCK41_DATE);
      for (const key of ["open", "high", "low", "close", "volume", "adj"] as const) assert.ok(raw[key] === null || (typeof raw[key] === "number" && Number.isFinite(raw[key])), "D1値shape不一致");
      row = { date: STOCK41_DATE, open: raw.open as number | null, high: raw.high as number | null, low: raw.low as number | null, close: raw.close as number | null, volume: raw.volume as number | null, adj: raw.adj as number | null };
    }
    out.set(raw.code, { stockId: raw.stockId, row });
  }
  assert.equal(out.size, codes.length, "D1現在銘柄数不一致");
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  assert.equal(args.length, 4, "--execute --refs-file=... --source-dir=... --out=... が必要");
  assert.equal(args.filter(arg => arg === "--execute").length, 1);
  const flag = (name: string) => { const found = args.filter(arg => arg.startsWith(`${name}=`)); assert.equal(found.length, 1); const value = found[0].slice(name.length + 1); assert.ok(value.length > 0); return value; };
  const refsFile = flag("--refs-file"), sourceDir = flag("--source-dir"), out = flag("--out");
  assert.equal([join(STATE_DIR, LATCH_NAME), join(STATE_DIR, ".stock41-price-repair-20261016.completed.json")].some(file => existsSync(file)), false, "固定scopeの既存証跡は再送せず読取照合する");
  sharedEnv.CLOUDFLARE_API_TOKEN(); sharedEnv.CLOUDFLARE_ACCOUNT_ID(); sharedEnv.D1_DATABASE_ID();
  notionEnv.NOTION_TOKEN(); notionEnv.NOTION_ARCHIVE_PAGE_ID();
  assert.equal(sharedEnv.LOCAL_OUT(), undefined, "本番D1補完にLOCAL_OUTは使わない");
  const sources = await loadStock41Sources(refsFile, sourceDir);
  const send = createD1HttpBatchSender();
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const report = await runStock41Repair(sources, STATE_DIR, out, {
    read: readCurrent, send,
    probeReceiptAbsent: async () => {
      const db = await findUniqueBackupChildByTitle({ parentPageId: notionEnv.NOTION_ARCHIVE_PAGE_ID(), title: "一次データ｜stock-sync", kind: "database" });
      assert.ok(db, "既存stock-sync原本DBがない");
      const row = await queryUniqueRow(db, { property: "Key", title: { equals: RECEIPT_KEY } }, "価格補完receipt重複");
      assert.equal(row, null, "既存receiptは再送せず読取照合する");
    },
    recordReceipt: async bytes => {
      const receipt = await recordPrimaryData({ service: "stock-sync", key: RECEIPT_KEY, source: "10/18 custodied Yahoo 10y → 10/16 OHLCV only",
        fetchedAt: clock(), metadata: { scope: "stock41_price_only", marketDate: STOCK41_DATE, refsSha256: STOCK41_REFS_SHA256, selected: 41 },
        files: [{ filename: `${RECEIPT_KEY}.json`, bytes, contentType: "application/json" }], force: false });
      assert.equal(receipt.outcome, "recorded"); assert.equal(receipt.fileTooLarge, false);
      await verifyReceiptAttachment(receipt.pageId, `${RECEIPT_KEY}.json`, bytes);
    },
  });
  console.info(JSON.stringify(report));
  if (report.held.length > 0) process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("[stock41-price-repair] STOP。既存pending/intentを保全し、再送せず確認してください"); process.exitCode = 1; });
}
