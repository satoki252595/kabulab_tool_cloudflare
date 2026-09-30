/**
 * 海外残745 SELECT-ONLY live proof (laneA・新 grant)。
 *
 * Root 承認 (2026-09-30 チャット): SELECT のみ・D1 HTTP ≤36 requests・
 * 単発試行 (追加 auto-retry 0)・書込なし。旧 laneA leases は CANCELLED のため
 * 再利用しない。新 lease ID の発行なし (本 proof は read-only のため)。
 * ライブ source ZIP archive は不可 (recordPrimaryData を呼ばない)。
 *
 * 対象: 旧745 + changedOutside804 925 + holdOutside804 52 + all59 の
 * disjoint union 1781 docs (73 pin不足のうち 21 は 745 内。重複加算なし)。
 * 18 chunks (≤100 IDs) × (Q1 + Q2) = 36 SELECT / 36 HTTP requests。
 *
 * - Q1: doc identity + stock identity + periodEnd + status + honbun +
 *   doc別 correlated overseasFacts COUNT (同一 request 内)。
 * - Q2: 同一 IDs の facts 全 storage cols + docID/stockID echo。
 *   決定順 (doc_id, fiscal_year_end, region_name)。nullable 保持。
 * - 型付き db.select のみ (raw positional arrays 不使用。C29 再発防止)。
 *   実行前に toSQL を取得し read-only + 射影名 uniqueness を断言する。
 * - Q1 cardinality (全部 unique・欠落なし) + Q1 counts 合計 = Q2 全行
 *   (0-facts doc 含む)。missing/dup/列異常/値異常/truncation は STOP。
 * - 比較 (live 観測後): L1 live vs PREP-current / L2 live vs historical
 *   before / all59 は L3 live vs sealed-post も別比較。old facts counts
 *   推計を必須 live 件数にしない (Q1 observed count が基準)。
 *
 * 固定入力 pins: prep-sets / prep-journal / batches / r4xr / savedfacts /
 * fullscan (CAS 証跡自体は PREP PASS で確定済み・pins 不変で carry)。
 * union + SHA を private 0600 固定して assert する。
 *
 * 出力 (OUT_DIR のみ・0600。stdout は counts/SHA のみ。D1 IDs/values 0):
 * - select-union.json / select-manifest.json (per-query 記録) /
 *   select-live.json (観測 snapshot) / select-compare.json (L1/L2/L3) /
 *   select-report.json (read-only receipt)
 *
 * 実行: pnpm exec tsx services/yuho-quant/data-scripts/overseas-745-select-proof.ts
 *   --env-file=/path/to/.env [--lane-dir /tmp] [--prep-dir /tmp/overseas745-prep-20260930]
 *   [--out-dir /tmp/overseas745-select-20260930]
 */

// ---------------------------------------------------------------------------
// 0. read-only fetch guard (repo import より前に設置)
// ---------------------------------------------------------------------------
let httpObserved = 0;
let httpFailed = 0;
const nativeFetch = globalThis.fetch.bind(globalThis);
const D1_QUERY_RE = /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+\/d1\/database\/[^/]+\/query$/;
const WRITE_WORD_RE = /\b(insert|update|delete|drop|alter|create|replace|pragma|vacuum|attach|detach|grant|revoke|begin|commit|rollback)\b/i;

globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const u = String(url);
  if (!D1_QUERY_RE.test(u)) {
    httpFailed += 1;
    throw new Error(`SELECT proof: D1 query 以外への到達を拒否: ${u.slice(0, 80)}`);
  }
  let body: { sql?: unknown; params?: unknown; batch?: unknown };
  try {
    body = JSON.parse(String(init?.body ?? "{}")) as typeof body;
  } catch {
    httpFailed += 1;
    throw new Error("SELECT proof: D1 body 非JSON");
  }
  if (body.batch !== undefined) {
    httpFailed += 1;
    throw new Error("SELECT proof: batch envelope 禁止 (単発 SELECT のみ)");
  }
  if (typeof body.sql !== "string" || !/^\s*(select|with)\b/i.test(body.sql)) {
    httpFailed += 1;
    throw new Error("SELECT proof: 非SELECT 文を拒否");
  }
  if (WRITE_WORD_RE.test(body.sql)) {
    httpFailed += 1;
    throw new Error("SELECT proof: 書込語を含む文を拒否");
  }
  // 送信前 bound: 37 件目を送る前に拒否する (終端 check だけでは保証不可)。
  if (httpObserved >= 36) {
    httpFailed += 1;
    throw new Error("SELECT proof: 上限 36 を超える送信を拒否");
  }
  httpObserved += 1;
  try {
    return await nativeFetch(u, { ...init, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    httpFailed += 1;
    throw e;
  }
}) as typeof fetch;

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { eq, inArray, sql } from "drizzle-orm";

// guard 設置後に repo runtime を dynamic import する。
const d1Mod = await import("../../../src/shared/db/d1-http-client.js");
const { createD1HttpDb } = d1Mod;
const yuhoSchema = await import("../src/db/schema.js");
const { yuhoDocuments, overseasSalesFacts } = yuhoSchema;

// ---------------------------------------------------------------------------
// 固定 pins・grant
// ---------------------------------------------------------------------------
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GRANT =
  "Root chat approval 2026-09-30: SELECT-only, D1 HTTP <=36 requests, " +
  "single-attempt (no retry), no writes; past laneA leases CANCELLED, not reused; " +
  "no new lease ID issued (read-only proof).";

const PINS: Record<string, string> = {
  prepSets: "62095358c460002afcf06a41e65db14c9c75171eebfa0a5ae06e09713308b5d1",
  prepJournal: "5127c73b45e24b94eda01198b159032fc56333c72f8d53e71fbb2b2d2885b9dc",
  batches: "991e8db9bd50b26c6c9fca41222362dc2d2e170edd1a962f6bdaed443be45a4a",
  r4xr: "9f47e75c4e101ddb0f1c89bdf5657f1e20d9e60da66a75d7e9472fe84070d817",
  savedfacts: "58122d8d51046d312c93fdc18b5851eb14c6aabcad551881ab8713a49b2bbb31",
  fullscan: "b5cb5c1cd10bf371414136e45131d285292711e3829b14b2b6f12c03a3071c1f",
};

const INSERT_COLS = [
  "document_id", "stock_id", "fiscal_year_end", "region_name", "region_kind",
  "is_consolidated", "unit_label", "sales_raw", "sales_yen", "ratio_pct", "pattern",
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
class HoldError extends Error {
  constructor(msg: string) {
    super(`HOLD: ${msg}`);
    this.name = "HoldError";
  }
}
function hold(msg: string): never {
  throw new HoldError(msg);
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function readPinned(path: string, pinKey: string): Buffer {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    hold(`入力不在: ${path}`);
  }
  const got = sha256Hex(bytes);
  if (got !== PINS[pinKey]) {
    hold(`pin不一致: ${basename(path)} got=${got.slice(0, 16)}…`);
  }
  return bytes;
}

function parseJSON(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    hold(`JSON 破損: ${label}`);
  }
}

function parseJSONL(bytes: Buffer, label: string): unknown[] {
  const lines = bytes.toString("utf8").split("\n").filter((l) => l.trim() !== "");
  return lines.map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      hold(`JSONL 破損: ${label} 行${i + 1}`);
    }
  });
}

function setSHA(ids: string[]): string {
  return sha256Hex(JSON.stringify([...ids].sort()));
}

const argValue = (n: string, dflt: string): string =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? dflt;

function writePrivate(path: string, data: string): string {
  writeFileSync(path, data, { mode: 0o600 });
  return sha256Hex(data);
}

function asRecord(v: unknown, label: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) hold(`形状外: ${label}`);
  return v as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// pure helpers (overseas-745-prep.ts 47c2d5c から proof 自己完結のため複写。
// 唯一の意図的差分: compareRows に canonical-key 重複の明示検出
// (DUP_BEFORE/DUP_AFTER。重複ありは match にしない) を追加。PREP 本体は不変。)
// ---------------------------------------------------------------------------
function normConsolidated(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (v === true || v === 1 || v === "1") return true;
  if (v === false || v === 0 || v === "0") return false;
  hold(`isConsolidated 値域外: ${String(v)}`);
}

interface CmpRow {
  fiscalYearEnd: string;
  regionName: string;
  regionKind: string;
  isConsolidated: boolean | null;
  unitLabel: string;
  salesRaw: number | null;
  salesYen: number | null;
  ratioPct: number | null;
  pattern: string;
}

const rowKey = (r: { fiscalYearEnd: string; regionName: string }): string =>
  `${r.fiscalYearEnd} ${r.regionName}`;

interface CompareOut {
  equal: boolean;
  reasons: string[];
  addedKeys: string[];
  removedKeys: string[];
  fieldDiffs: Array<{ key: string; fields: string[] }>;
  dupBefore: Array<{ key: string; count: number }>;
  dupAfter: Array<{ key: string; count: number }>;
}

/**
 * canonical fact key (fiscalYearEnd + regionName) の重複を明示検出する。
 * Map 構築は同 key 重複を collapse するため、collapse 前に重複の有無を
 * 数えて返す。重複ありの比較は match にしない (DUP_BEFORE/DUP_AFTER)。
 */
function dupKeysOf(rows: CmpRow[]): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = rowKey(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n > 1)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

function compareRows(
  before: CmpRow[],
  after: CmpRow[],
  statusBefore: string | null,
  statusAfter: string | null,
  honbunBefore: string | null,
  honbunAfter: string | null,
  compareRaw: boolean,
  compareHonbun: boolean
): CompareOut {
  const reasons: string[] = [];
  const dupBefore = dupKeysOf(before);
  const dupAfter = dupKeysOf(after);
  if (dupBefore.length > 0) reasons.push("DUP_BEFORE");
  if (dupAfter.length > 0) reasons.push("DUP_AFTER");
  if (statusBefore !== statusAfter) reasons.push(`STATUS:${String(statusBefore)}→${String(statusAfter)}`);
  if (compareHonbun && honbunBefore !== honbunAfter) reasons.push("HONBUN");
  const bMap = new Map(before.map((r) => [rowKey(r), r]));
  const aMap = new Map(after.map((r) => [rowKey(r), r]));
  const addedKeys = [...aMap.keys()].filter((k) => !bMap.has(k)).sort();
  const removedKeys = [...bMap.keys()].filter((k) => !aMap.has(k)).sort();
  if (addedKeys.length > 0 || removedKeys.length > 0) reasons.push("SCOPE");
  if (before.length > 0 && after.length === 0) reasons.push("FACTS_DELETED");
  if (before.length === 0 && after.length > 0) reasons.push("FACTS_CREATED");
  const bByRegion = new Map(before.map((r) => [r.regionName, r.fiscalYearEnd]));
  const aByRegion = new Map(after.map((r) => [r.regionName, r.fiscalYearEnd]));
  for (const [rn, bfy] of bByRegion) {
    const afy = aByRegion.get(rn);
    if (afy !== undefined && afy !== bfy) {
      reasons.push("FYEAR");
      break;
    }
  }
  const fieldDiffs: Array<{ key: string; fields: string[] }> = [];
  for (const [k, b] of bMap) {
    const a = aMap.get(k);
    if (!a) continue;
    const fields: string[] = [];
    if (b.regionKind !== a.regionKind) fields.push("regionKind");
    if (b.isConsolidated !== a.isConsolidated) fields.push("isConsolidated");
    if (b.unitLabel !== a.unitLabel) fields.push("unitLabel");
    if (compareRaw && b.salesRaw !== a.salesRaw) fields.push("salesRaw");
    if (b.salesYen !== a.salesYen) fields.push("salesYen");
    if (b.ratioPct !== a.ratioPct) fields.push("ratioPct");
    if (b.pattern !== a.pattern) fields.push("pattern");
    if (fields.length > 0) {
      fieldDiffs.push({ key: k, fields });
      for (const f of fields) {
        const tag =
          f === "salesYen" ? "VALUE" : f === "salesRaw" ? "RAW" : f === "unitLabel" ? "UNIT"
          : f === "isConsolidated" ? "CONSOLIDATED" : f === "regionKind" ? "REGIONKIND"
          : f === "ratioPct" ? "RATIO" : "PATTERN";
        if (!reasons.includes(tag)) reasons.push(tag);
      }
    }
  }
  return { equal: reasons.length === 0, reasons: reasons.sort(), addedKeys, removedKeys, fieldDiffs, dupBefore, dupAfter };
}

interface SealedExpectation {
  docID: string;
  documentId: number;
  stockId: number;
  disposition: string;
  status: string;
  honbun: string | null;
  rows: CmpRow[];
}

function extractSealed(planDoc: Record<string, unknown>, label: string): SealedExpectation {
  const docID = planDoc["docID"];
  const documentId = planDoc["documentId"];
  const stockId = planDoc["stockId"];
  const disposition = planDoc["disposition"];
  const newRows = planDoc["newRows"];
  const statements = planDoc["statements"];
  if (typeof docID !== "string" || typeof documentId !== "number" || typeof stockId !== "number") {
    hold(`${label} plan doc 形状外`);
  }
  if (typeof disposition !== "string" || typeof newRows !== "number" || !Array.isArray(statements)) {
    hold(`${label} plan doc 形状外: ${docID}`);
  }
  const stmts = statements as Array<{ sql: string; params: unknown[] }>;
  const upd = stmts.find((s) => s.sql.startsWith("UPDATE yuho_documents SET overseas_parse_status"));
  if (!upd || upd.params.length !== 3) hold(`${label} UPDATE 欠落: ${docID}`);
  const [status, honbun, id] = upd.params as [unknown, unknown, unknown];
  if (typeof status !== "string" || !(typeof honbun === "string" || honbun === null) || id !== documentId) {
    hold(`${label} UPDATE params 外: ${docID}`);
  }
  const post = stmts.find((s) => s.sql.includes("postflight"));
  if (!post || post.params.length < 1) hold(`${label} postflight 欠落: ${docID}`);
  let postFacts: unknown;
  try {
    postFacts = (JSON.parse(String(post.params[0])) as { facts: unknown }).facts;
  } catch {
    hold(`${label} postflight JSON 破損: ${docID}`);
  }
  if (!Array.isArray(postFacts)) hold(`${label} postflight facts 非配列: ${docID}`);
  const rows: CmpRow[] = (postFacts as unknown[]).map((e) => {
    const r = asRecord(e, `${label} postflight fact`);
    if (r["documentId"] !== documentId || r["stockId"] !== stockId) {
      hold(`${label} postflight ID 不一致: ${docID}`);
    }
    if (typeof r["fiscalYearEnd"] !== "string" || typeof r["regionName"] !== "string") {
      hold(`${label} postflight 行形状外: ${docID}`);
    }
    if (typeof r["regionKind"] !== "string" || typeof r["unitLabel"] !== "string") {
      hold(`${label} postflight 行形状外: ${docID}`);
    }
    if (!(r["salesRaw"] === null || typeof r["salesRaw"] === "number")) hold(`${label} salesRaw 形状外: ${docID}`);
    if (!(r["salesYen"] === null || typeof r["salesYen"] === "number")) hold(`${label} salesYen 形状外: ${docID}`);
    if (!(r["ratioPct"] === null || typeof r["ratioPct"] === "number")) hold(`${label} ratio 形状外: ${docID}`);
    if (typeof r["pattern"] !== "string") hold(`${label} pattern 形状外: ${docID}`);
    return {
      fiscalYearEnd: r["fiscalYearEnd"] as string,
      regionName: r["regionName"] as string,
      regionKind: r["regionKind"] as string,
      isConsolidated: normConsolidated(r["isConsolidated"]),
      unitLabel: r["unitLabel"] as string,
      salesRaw: r["salesRaw"] as number | null,
      salesYen: r["salesYen"] as number | null,
      ratioPct: r["ratioPct"] as number | null,
      pattern: r["pattern"] as string,
    };
  });
  if (rows.length !== newRows) hold(`${label} postflight 件数外: ${docID}`);
  const ins = stmts.find((s) => s.sql.startsWith("INSERT INTO yuho_overseas_facts"));
  if (newRows === 0) {
    if (ins) hold(`${label} newRows=0 だが INSERT あり: ${docID}`);
  } else {
    if (!ins) hold(`${label} INSERT 欠落: ${docID}`);
    const cols = ins.sql.slice(ins.sql.indexOf("(") + 1, ins.sql.indexOf(")")).split(",").map((c) => c.trim());
    if (JSON.stringify(cols) !== JSON.stringify(INSERT_COLS)) hold(`${label} INSERT 列順外: ${docID}`);
    if (ins.params.length !== newRows * INSERT_COLS.length) hold(`${label} INSERT binds 外: ${docID}`);
    const insRows: CmpRow[] = [];
    for (let i = 0; i < newRows; i++) {
      const p = ins.params.slice(i * INSERT_COLS.length, (i + 1) * INSERT_COLS.length);
      insRows.push({
        fiscalYearEnd: p[2] as string, regionName: p[3] as string, regionKind: p[4] as string,
        isConsolidated: normConsolidated(p[5]), unitLabel: p[6] as string,
        salesRaw: p[7] as number | null, salesYen: p[8] as number | null,
        ratioPct: p[9] as number | null, pattern: p[10] as string,
      });
    }
    const canon = (rs: CmpRow[]): string[] =>
      rs.map((r) => JSON.stringify([r.fiscalYearEnd, r.regionName, r.regionKind,
        r.isConsolidated, r.unitLabel, r.salesRaw, r.salesYen, r.ratioPct, r.pattern])).sort();
    if (JSON.stringify(canon(insRows)) !== JSON.stringify(canon(rows))) {
      hold(`${label} INSERT/postflight 不一致: ${docID}`);
    }
  }
  return { docID, documentId, stockId, disposition, status, honbun, rows };
}

// ---------------------------------------------------------------------------
// 入力 loaders (lite。pins で bytes 同一のため件数・鍵のみ再断言)
// ---------------------------------------------------------------------------
const EXPECT_SET_COUNTS: Record<string, number> = {
  changed745: 724, match745: 0, hold745: 21,
  changed59: 6, match59: 53, hold59: 0,
  changedOutside804: 925, holdOutside804: 52,
  pinMissing73: 73, holdParse: 0, holdValidation: 0,
};

function loadPrepSets(bytes: Buffer): Record<string, string[]> {
  const obj = asRecord(parseJSON(bytes, "prep-sets"), "prep-sets");
  const out: Record<string, string[]> = {};
  for (const [k, n] of Object.entries(EXPECT_SET_COUNTS)) {
    const v = obj[k];
    if (!Array.isArray(v) || v.length !== n) hold(`prep-sets ${k} 件数外`);
    if (!v.every((x): x is string => typeof x === "string")) hold(`prep-sets ${k} 非string混入`);
    out[k] = [...v].sort();
  }
  return out;
}

interface PrepAfter {
  status: string;
  honbunFile: string | null;
  tablesScanned: number;
  rows: CmpRow[];
}

/** journal の after 表 (changed + HOLD_PIN_MISSING の全件)。 */
function loadJournalAfter(bytes: Buffer): Map<string, PrepAfter> {
  const arr = parseJSONL(bytes, "prep-journal");
  if (arr.length !== 1728) hold(`prep-journal 件数外: ${arr.length}`);
  const out = new Map<string, PrepAfter>();
  for (const e of arr) {
    const r = asRecord(e, "journal 要素");
    const doc = r["doc"];
    if (typeof doc !== "string" || out.has(doc)) hold("journal doc 重複/形状外");
    const after = r["after"] as Record<string, unknown> | null;
    if (after === null) hold(`journal after 欠落 (HOLD_PARSE/VALIDATION): ${doc}`);
    if (typeof after["status"] !== "string") hold(`journal after status 外: ${doc}`);
    if (!(typeof after["honbunFile"] === "string" || after["honbunFile"] === null)) {
      hold(`journal after honbun 外: ${doc}`);
    }
    if (!Array.isArray(after["rows"])) hold(`journal after rows 外: ${doc}`);
    const rows: CmpRow[] = (after["rows"] as unknown[]).map((x) => {
      const f = asRecord(x, "journal row");
      if (typeof f["fiscalYearEnd"] !== "string" || typeof f["regionName"] !== "string") hold(`journal row 外: ${doc}`);
      if (typeof f["regionKind"] !== "string" || typeof f["unitLabel"] !== "string") hold(`journal row 外: ${doc}`);
      if (typeof f["pattern"] !== "string") hold(`journal row 外: ${doc}`);
      if (!(f["salesRaw"] === null || typeof f["salesRaw"] === "number")) hold(`journal raw 外: ${doc}`);
      if (!(f["salesYen"] === null || typeof f["salesYen"] === "number")) hold(`journal yen 外: ${doc}`);
      if (!(f["ratioPct"] === null || typeof f["ratioPct"] === "number")) hold(`journal ratio 外: ${doc}`);
      return {
        fiscalYearEnd: f["fiscalYearEnd"] as string, regionName: f["regionName"] as string,
        regionKind: f["regionKind"] as string, isConsolidated: normConsolidated(f["isConsolidated"]),
        unitLabel: f["unitLabel"] as string, salesRaw: f["salesRaw"] as number | null,
        salesYen: f["salesYen"] as number | null, ratioPct: f["ratioPct"] as number | null,
        pattern: f["pattern"] as string,
      };
    });
    out.set(doc, {
      status: after["status"] as string,
      honbunFile: after["honbunFile"] as string | null,
      tablesScanned: after["tablesScanned"] as number,
      rows,
    });
  }
  return out;
}

function loadSealedAll(batchesBytes: Buffer, r4xrBytes: Buffer): Map<string, SealedExpectation> {
  const out = new Map<string, SealedExpectation>();
  for (const [bytes, label, n] of [
    [batchesBytes, "base58", 58],
    [r4xrBytes, "r4xr", 1],
  ] as const) {
    const plan = asRecord(parseJSON(bytes, `${label} plan`), `${label} plan`);
    const docs = plan["docs"];
    if (!Array.isArray(docs) || docs.length !== n) hold(`${label} plan 件数外`);
    for (const d of docs) {
      const s = extractSealed(asRecord(d, "plan 要素"), label);
      if (out.has(s.docID)) hold(`${label} plan doc 重複: ${s.docID}`);
      out.set(s.docID, s);
    }
  }
  return out;
}

function loadSavedFactsLite(bytes: Buffer): Map<string, CmpRow[]> {
  const arr = parseJSON(bytes, "savedfacts");
  if (!Array.isArray(arr) || arr.length !== 21258) hold("savedfacts 件数外");
  const out = new Map<string, CmpRow[]>();
  for (const e of arr) {
    const r = asRecord(e, "savedfacts 要素");
    const doc = r["doc_id"];
    if (typeof doc !== "string") hold("savedfacts doc 外");
    const row: CmpRow = {
      fiscalYearEnd: r["fiscal_year_end"] as string,
      regionName: r["region_name"] as string,
      regionKind: r["region_kind"] as string,
      isConsolidated: normConsolidated(r["is_consolidated"]),
      unitLabel: r["unit_label"] as string,
      salesRaw: null,
      salesYen: r["sales_yen"] as number | null,
      ratioPct: r["ratio_pct"] as number | null,
      pattern: r["pattern"] as string,
    };
    const list = out.get(doc) ?? [];
    list.push(row);
    out.set(doc, list);
  }
  if (out.size !== 3675) hold("savedfacts doc 数外");
  return out;
}

function loadFullscanStatusLite(bytes: Buffer): Map<string, string> {
  const arr = parseJSONL(bytes, "fullscan");
  if (arr.length !== 3675) hold("fullscan 件数外");
  const out = new Map<string, string>();
  for (const e of arr) {
    const r = asRecord(e, "fullscan 要素");
    const doc = r["doc"];
    const st = r["savedStatus"];
    if (typeof doc !== "string" || typeof st !== "string" || out.has(doc)) hold("fullscan 形状外");
    out.set(doc, st);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SQL 射影の機械検証 (C29 級の位置ずれ防止。実行前に toSQL で断言)
// ---------------------------------------------------------------------------
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (inStr !== null) {
      cur += c;
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      cur += c;
      continue;
    }
    if (c === "(") depth += 1;
    if (c === ")") depth -= 1;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/** SELECT 文の射影名を抽出する。読めなければ HOLD (推測しない)。 */
function projectedNames(sqlText: string): string[] {
  const lower = sqlText.toLowerCase();
  if (!/^\s*select\s/.test(lower)) hold(`SELECT 形外: ${sqlText.slice(0, 60)}`);
  // depth-0 の " from " を探す (副問合せ内は無視)。
  let depth = 0;
  let fromIdx = -1;
  let inStr: string | null = null;
  const body = sqlText.slice(sqlText.toLowerCase().indexOf("select") + 6);
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as string;
    if (inStr !== null) {
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === "(") depth += 1;
    if (c === ")") depth -= 1;
    if (depth === 0 && body.slice(i, i + 6).toLowerCase() === " from ") {
      fromIdx = i;
      break;
    }
  }
  if (fromIdx < 0) hold(`FROM 検出不能: ${sqlText.slice(0, 80)}`);
  const list = body.slice(0, fromIdx);
  return splitTopLevel(list).map((item) => {
    const t = item.trim();
    const asM = t.match(/\bas\s+"([^"]+)"\s*$/i) ?? t.match(/\bas\s+([A-Za-z_][\w$]*)\s*$/i);
    if (asM) return (asM[1] as string).toLowerCase();
    const noQ = t.replace(/"/g, "");
    const dot = noQ.lastIndexOf(".");
    return (dot >= 0 ? noQ.slice(dot + 1) : noQ).trim().toLowerCase();
  });
}

function assertProjection(sqlText: string, expectCount: number, label: string): void {
  const names = projectedNames(sqlText);
  if (names.length !== expectCount) {
    hold(`${label} 射影数外: ${names.length} != ${expectCount}`);
  }
  if (new Set(names).size !== names.length) {
    hold(`${label} 射影名重複 (位置ずれ hazard): ${names.join(",")}`);
  }
  if (names.some((n) => n === "" || n.includes(" ") || n.includes("("))) {
    hold(`${label} 射影名を読めない: ${names.join(",")}`);
  }
}

// ---------------------------------------------------------------------------
// live 行の検証 (shape/type のみ。値の意外性は比較へ流す)
// ---------------------------------------------------------------------------
interface LiveDoc {
  id: number;
  docId: string;
  stockId: number;
  periodEnd: string;
  overseasParseStatus: string | null;
  overseasHonbunFile: string | null;
  factsCount: number;
}

interface LiveFact {
  docId: string;
  id: number;
  documentId: number;
  stockId: number;
  fiscalYearEnd: string;
  regionName: string;
  regionKind: string;
  isConsolidated: boolean | null;
  unitLabel: string;
  salesRaw: number | null;
  salesYen: number | null;
  ratioPct: number | null;
  pattern: string;
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function validateQ1Row(r: Record<string, unknown>, label: string): LiveDoc {
  const keys = Object.keys(r).sort();
  const want = ["docId", "factsCount", "id", "overseasHonbunFile", "overseasParseStatus", "periodEnd", "stockId"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(want)) hold(`${label} Q1 列外: ${keys.join(",")}`);
  if (!isInt(r["id"]) || (r["id"] as number) <= 0) hold(`${label} Q1 id 外`);
  if (typeof r["docId"] !== "string" || r["docId"] === "") hold(`${label} Q1 docId 外`);
  if (!isInt(r["stockId"])) hold(`${label} Q1 stockId 外`);
  if (typeof r["periodEnd"] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r["periodEnd"] as string)) {
    hold(`${label} Q1 periodEnd 外`);
  }
  if (!(r["overseasParseStatus"] === null || typeof r["overseasParseStatus"] === "string")) {
    hold(`${label} Q1 status 外`);
  }
  if (!(r["overseasHonbunFile"] === null || typeof r["overseasHonbunFile"] === "string")) {
    hold(`${label} Q1 honbun 外`);
  }
  if (!isInt(r["factsCount"]) || (r["factsCount"] as number) < 0) hold(`${label} Q1 factsCount 外`);
  return {
    id: r["id"] as number, docId: r["docId"] as string, stockId: r["stockId"] as number,
    periodEnd: r["periodEnd"] as string,
    overseasParseStatus: r["overseasParseStatus"] as string | null,
    overseasHonbunFile: r["overseasHonbunFile"] as string | null,
    factsCount: r["factsCount"] as number,
  };
}

function validateQ2Row(r: Record<string, unknown>, label: string): LiveFact {
  const keys = Object.keys(r).sort();
  const want = ["docId", "documentId", "fiscalYearEnd", "id", "isConsolidated", "pattern",
    "ratioPct", "regionKind", "regionName", "salesRaw", "salesYen", "stockId", "unitLabel"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(want)) hold(`${label} Q2 列外: ${keys.join(",")}`);
  if (typeof r["docId"] !== "string" || r["docId"] === "") hold(`${label} Q2 docId 外`);
  if (!isInt(r["id"]) || (r["id"] as number) <= 0) hold(`${label} Q2 id 外`);
  if (!isInt(r["documentId"]) || (r["documentId"] as number) <= 0) hold(`${label} Q2 documentId 外`);
  if (!isInt(r["stockId"])) hold(`${label} Q2 stockId 外`);
  for (const k of ["fiscalYearEnd", "regionName", "regionKind", "unitLabel", "pattern"]) {
    if (typeof r[k] !== "string") hold(`${label} Q2 ${k} 外`);
  }
  for (const k of ["salesRaw", "salesYen", "ratioPct"]) {
    if (!(r[k] === null || typeof r[k] === "number")) hold(`${label} Q2 ${k} 外`);
  }
  return {
    docId: r["docId"] as string, id: r["id"] as number, documentId: r["documentId"] as number,
    stockId: r["stockId"] as number, fiscalYearEnd: r["fiscalYearEnd"] as string,
    regionName: r["regionName"] as string, regionKind: r["regionKind"] as string,
    isConsolidated: normConsolidated(r["isConsolidated"]),
    unitLabel: r["unitLabel"] as string, salesRaw: r["salesRaw"] as number | null,
    salesYen: r["salesYen"] as number | null, ratioPct: r["ratioPct"] as number | null,
    pattern: r["pattern"] as string,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const LANE_DIR = argValue("lane-dir", "/tmp");
const PREP_DIR = argValue("prep-dir", "/tmp/overseas745-prep-20260930");
const OUT_DIR = argValue("out-dir", "/tmp/overseas745-select-20260930");
const ENV_FILE = argValue("env-file", join(REPO_ROOT, ".env"));
const STARTED_AT = new Date().toISOString();

interface QueryRecord {
  seq: number;
  kind: "Q1" | "Q2";
  chunk: number;
  idsSHA: string;
  sqlSHA: string;
  sql: string;
  at: string;
  ms: number;
  rows: number;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  chmodSync(OUT_DIR, 0o700);
  if (!existsSync(ENV_FILE)) hold(`env-file 不在: ${ENV_FILE} (--env-file で指定)`);
  dotenv.config({ path: ENV_FILE });
  const workHead = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  // 1. 固定入力 pins + 集合の導出。
  const sets = loadPrepSets(readPinned(join(PREP_DIR, "prep-sets.json"), "prepSets"));
  const journalAfter = loadJournalAfter(readPinned(join(PREP_DIR, "prep-journal.jsonl"), "prepJournal"));
  const sealedAll = loadSealedAll(
    readPinned(join(LANE_DIR, "laneA_cas_batches.json"), "batches"),
    readPinned(join(LANE_DIR, "laneA_cas_r4xr.json"), "r4xr")
  );
  const savedfacts = loadSavedFactsLite(readPinned(join(LANE_DIR, "overseas_laneA_savedfacts.json"), "savedfacts"));
  const fullscanStatus = loadFullscanStatusLite(readPinned(join(LANE_DIR, "overseas_laneA_fullscan.jsonl"), "fullscan"));

  const part745 = [...sets["changed745"] as string[], ...sets["hold745"] as string[]];
  const partOutside = [...sets["changedOutside804"] as string[], ...sets["holdOutside804"] as string[]];
  const part59 = [...sets["changed59"] as string[], ...sets["match59"] as string[]];
  if (part745.length !== 745 || partOutside.length !== 977 || part59.length !== 59) {
    hold("union 構成件数外");
  }
  const union = [...part745, ...partOutside, ...part59].sort();
  if (new Set(union).size !== 1781) hold(`union 重複あり: ${union.length - new Set(union).size} 件`);
  const unionSHA = setSHA(union);
  const chunks: string[][] = [];
  for (let i = 0; i < union.length; i += 100) chunks.push(union.slice(i, i + 100));
  if (chunks.length !== 18) hold(`chunk 数外: ${chunks.length}`);
  const unionFileSHA = writePrivate(join(OUT_DIR, "select-union.json"), JSON.stringify({ count: union.length, sha256: unionSHA, ids: union }));

  // 2. 36 SELECT (単発試行・失敗即 STOP・retry なし)。
  const db = createD1HttpDb(yuhoSchema);
  const queries: QueryRecord[] = [];
  const sqlTexts: string[] = [];
  const liveDocs = new Map<string, LiveDoc>();
  const liveFacts: LiveFact[] = [];
  const liveIds = new Set<number>();
  const seenQ1 = new Set<string>();
  let seq = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci] as string[];
    const label = `chunk${ci}`;
    const idsSHA = setSHA(chunk);

    // Q1: doc + per-doc COUNT (同一 request)。
    const q1b = db.select({
      id: yuhoDocuments.id,
      docId: yuhoDocuments.docId,
      stockId: yuhoDocuments.stockId,
      periodEnd: yuhoDocuments.periodEnd,
      overseasParseStatus: yuhoDocuments.overseasParseStatus,
      overseasHonbunFile: yuhoDocuments.overseasHonbunFile,
      factsCount: sql<number>`(select count(*) from "yuho_overseas_facts" where "document_id" = "yuho_documents"."id") as "factsCount"`,
    }).from(yuhoDocuments).where(inArray(yuhoDocuments.docId, chunk));
    const q1sql = q1b.toSQL().sql;
    assertProjection(q1sql, 7, label);
    sqlTexts.push(q1sql);
    let q1rows: Record<string, unknown>[];
    try {
      const t0 = Date.now();
      q1rows = (await q1b) as Record<string, unknown>[];
      queries.push({ seq: ++seq, kind: "Q1", chunk: ci, idsSHA, sqlSHA: sha256Hex(q1sql), sql: q1sql, at: new Date().toISOString(), ms: Date.now() - t0, rows: q1rows.length });
    } catch (e) {
      hold(`${label} Q1 失敗 (retry なし): ${(e as Error).message}`);
    }
    if (q1rows.length !== chunk.length) hold(`${label} Q1 cardinality 外: ${q1rows.length} != ${chunk.length}`);
    let chunkCountSum = 0;
    for (const r of q1rows) {
      const d = validateQ1Row(r, label);
      if (!chunk.includes(d.docId) || seenQ1.has(d.docId)) hold(`${label} Q1 echo 外/重複: ${d.docId}`);
      seenQ1.add(d.docId);
      if (liveIds.has(d.id)) hold(`${label} Q1 id 重複: ${d.id}`);
      liveIds.add(d.id);
      liveDocs.set(d.docId, d);
      chunkCountSum += d.factsCount;
    }

    // Q2: 同一 IDs の facts 全 storage cols + docID echo。
    const q2b = db.select({
      docId: yuhoDocuments.docId,
      id: overseasSalesFacts.id,
      documentId: overseasSalesFacts.documentId,
      stockId: overseasSalesFacts.stockId,
      fiscalYearEnd: overseasSalesFacts.fiscalYearEnd,
      regionName: overseasSalesFacts.regionName,
      regionKind: overseasSalesFacts.regionKind,
      isConsolidated: overseasSalesFacts.isConsolidated,
      unitLabel: overseasSalesFacts.unitLabel,
      salesRaw: overseasSalesFacts.salesRaw,
      salesYen: overseasSalesFacts.salesYen,
      ratioPct: overseasSalesFacts.ratioPct,
      pattern: overseasSalesFacts.pattern,
    }).from(overseasSalesFacts)
      .innerJoin(yuhoDocuments, eq(overseasSalesFacts.documentId, yuhoDocuments.id))
      .where(inArray(yuhoDocuments.docId, chunk))
      .orderBy(yuhoDocuments.docId, overseasSalesFacts.fiscalYearEnd, overseasSalesFacts.regionName);
    const q2sql = q2b.toSQL().sql;
    assertProjection(q2sql, 13, label);
    sqlTexts.push(q2sql);
    let q2rows: Record<string, unknown>[];
    try {
      const t0 = Date.now();
      q2rows = (await q2b) as Record<string, unknown>[];
      queries.push({ seq: ++seq, kind: "Q2", chunk: ci, idsSHA, sqlSHA: sha256Hex(q2sql), sql: q2sql, at: new Date().toISOString(), ms: Date.now() - t0, rows: q2rows.length });
    } catch (e) {
      hold(`${label} Q2 失敗 (retry なし): ${(e as Error).message}`);
    }
    // 決定順の検証 + 行検証 + Q1 連鎖。
    const orderKeys = q2rows.map((r) => {
      const o = r as Record<string, unknown>;
      return `${o["docId"] as string} ${o["fiscalYearEnd"] as string} ${o["regionName"] as string}`;
    });
    for (let i = 1; i < orderKeys.length; i++) {
      if ((orderKeys[i - 1] as string) > (orderKeys[i] as string)) hold(`${label} Q2 順序外`);
    }
    const seenKeys = new Set<string>();
    const seenFactIds = new Set<number>();
    const perDocQ2 = new Map<string, number>();
    for (const r of q2rows) {
      const f = validateQ2Row(r, label);
      if (!chunk.includes(f.docId)) hold(`${label} Q2 echo 範囲外: ${f.docId}`);
      const q1 = liveDocs.get(f.docId);
      if (!q1 || q1.id !== f.documentId) hold(`${label} Q2 document_id 連鎖外: ${f.docId}`);
      if (q1.stockId !== f.stockId) hold(`${label} Q2 stock 連鎖外: ${f.docId}`);
      if (seenFactIds.has(f.id)) hold(`${label} Q2 PK 重複: ${f.id}`);
      seenFactIds.add(f.id);
      const k = `${f.docId} ${rowKey(f)}`;
      if (seenKeys.has(k)) hold(`${label} Q2 canonical-key 重複 (live dup): ${k}`);
      seenKeys.add(k);
      liveFacts.push(f);
      perDocQ2.set(f.docId, (perDocQ2.get(f.docId) ?? 0) + 1);
    }
    // doc別 COUNT 照合 (chunk 合計だけでは相互相殺を見逃す)。
    for (const docId of chunk) {
      const q1c = (liveDocs.get(docId) as LiveDoc).factsCount;
      if ((perDocQ2.get(docId) ?? 0) !== q1c) hold(`${label} doc別COUNT外: ${docId}`);
    }
    if (q2rows.length !== chunkCountSum) {
      hold(`${label} Q1合計(${chunkCountSum}) != Q2行数(${q2rows.length})`);
    }
  }
  if (httpObserved !== 36) hold(`HTTP 観測外: ${httpObserved} != 36`);
  if (httpFailed !== 0) hold(`HTTP 失敗あり: ${httpFailed}`);
  if (seenQ1.size !== 1781) hold(`Q1 総数外: ${seenQ1.size}`);
  const q1sum = [...liveDocs.values()].reduce((a, d) => a + d.factsCount, 0);
  if (q1sum !== liveFacts.length) hold(`Q1総計(${q1sum}) != Q2総行(${liveFacts.length})`);
  const querySHA = sha256Hex(sqlTexts.join("\n"));

  // 3. 比較 (L1 live vs PREP-current / L2 live vs before / L3 59 live vs sealed)。
  const liveByDoc = new Map<string, LiveFact[]>();
  for (const f of liveFacts) {
    const list = liveByDoc.get(f.docId) ?? [];
    list.push(f);
    liveByDoc.set(f.docId, list);
  }
  const toCmp = (f: LiveFact): CmpRow => ({
    fiscalYearEnd: f.fiscalYearEnd, regionName: f.regionName, regionKind: f.regionKind,
    isConsolidated: f.isConsolidated, unitLabel: f.unitLabel, salesRaw: f.salesRaw,
    salesYen: f.salesYen, ratioPct: f.ratioPct, pattern: f.pattern,
  });
  const setOf = (doc: string): string =>
    part745.includes(doc) ? "remain745" : partOutside.includes(doc) ? "outside804" : "applied59";
  const cmpOut: Array<{
    doc: string; set: string;
    L1: { verdict: string; reasons: string[]; dupBefore: number; dupAfter: number };
    L2: { verdict: string; reasons: string[]; dupBefore: number; dupAfter: number };
    L3: { verdict: string; reasons: string[]; dupBefore: number; dupAfter: number } | null;
    detail: { L1: CompareOut; L2: CompareOut; L3: CompareOut | null };
  }> = [];
  const tally = { L1match: 0, L1changed: 0, L2match: 0, L2changed: 0, L3match: 0, L3changed: 0, dupBefore: 0, dupAfter: 0 };
  for (const doc of union) {
    const live = liveDocs.get(doc) as LiveDoc;
    const liveRows = (liveByDoc.get(doc) ?? []).map(toCmp);
    // PREP-current の復元 (journal after / match59 は sealed)。
    let prep: { status: string; honbunFile: string | null; rows: CmpRow[] };
    const ja = journalAfter.get(doc);
    if (ja) {
      prep = { status: ja.status, honbunFile: ja.honbunFile, rows: ja.rows };
    } else {
      const s = sealedAll.get(doc);
      if (!s) hold(`PREP-current 復元不能: ${doc}`);
      prep = { status: s.status, honbunFile: s.honbun, rows: s.rows };
    }
    const before: { status: string; rows: CmpRow[] } = {
      status: fullscanStatus.get(doc) as string,
      rows: (savedfacts.get(doc) ?? []).map((r) => ({ ...r })),
    };
    const L1 = compareRows(prep.rows, liveRows, prep.status, live.overseasParseStatus, prep.honbunFile, live.overseasHonbunFile, true, true);
    const L2 = compareRows(before.rows, liveRows, before.status, live.overseasParseStatus, null, live.overseasHonbunFile, false, false);
    const sealed = sealedAll.get(doc);
    const L3 = sealed
      ? compareRows(sealed.rows, liveRows, sealed.status, live.overseasParseStatus, sealed.honbun, live.overseasHonbunFile, true, true)
      : null;
    if (L1.equal) tally.L1match += 1; else tally.L1changed += 1;
    if (L2.equal) tally.L2match += 1; else tally.L2changed += 1;
    if (L3) {
      if (L3.equal) tally.L3match += 1; else tally.L3changed += 1;
    }
    for (const c of [L1, L2, ...(L3 ? [L3] : [])]) {
      tally.dupBefore += c.dupBefore.length;
      tally.dupAfter += c.dupAfter.length;
    }
    cmpOut.push({
      doc, set: setOf(doc),
      L1: { verdict: L1.equal ? "match" : "changed", reasons: L1.reasons, dupBefore: L1.dupBefore.length, dupAfter: L1.dupAfter.length },
      L2: { verdict: L2.equal ? "match" : "changed", reasons: L2.reasons, dupBefore: L2.dupBefore.length, dupAfter: L2.dupAfter.length },
      L3: L3 ? { verdict: L3.equal ? "match" : "changed", reasons: L3.reasons, dupBefore: L3.dupBefore.length, dupAfter: L3.dupAfter.length } : null,
      detail: { L1, L2, L3 },
    });
  }

  // honbun 比較 scope の実測 (protected scope は 0600 のみ)。
  const honbunScopes = { L1both: 0, L1liveNull: 0, L1prepNull: 0, L3both: 0, L3liveNull: 0, L3sealedNull: 0 };
  for (const c of cmpOut) {
    const live = liveDocs.get(c.doc) as LiveDoc;
    const ja = journalAfter.get(c.doc);
    const prepH = ja ? ja.honbunFile : (sealedAll.get(c.doc) as SealedExpectation).honbun;
    if (prepH !== null && live.overseasHonbunFile !== null) honbunScopes.L1both += 1;
    else if (live.overseasHonbunFile === null) honbunScopes.L1liveNull += 1;
    else honbunScopes.L1prepNull += 1;
    const s = sealedAll.get(c.doc);
    if (s) {
      if (s.honbun !== null && live.overseasHonbunFile !== null) honbunScopes.L3both += 1;
      else if (live.overseasHonbunFile === null) honbunScopes.L3liveNull += 1;
      else honbunScopes.L3sealedNull += 1;
    }
  }

  // 4. 成果物 (OUT_DIR のみ・0600)。
  const manifestSHA = writePrivate(join(OUT_DIR, "select-manifest.json"), JSON.stringify(queries));
  const liveSHA = writePrivate(join(OUT_DIR, "select-live.json"), JSON.stringify({
    q1: [...liveDocs.values()],
    q2: liveFacts,
  }));
  const compareSHA = writePrivate(join(OUT_DIR, "select-compare.json"), JSON.stringify(cmpOut));
  const report = {
    at_start: STARTED_AT,
    at_end: new Date().toISOString(),
    result: "PASS",
    mode: "select-proof",
    grant: GRANT,
    workHEAD: workHead,
    inputs: Object.fromEntries(Object.entries(PINS).map(([k, v]) => [k, v])),
    union: { count: union.length, sha256: unionSHA, parts: { p745: 745, pOutside: 977, p59: 59 } },
    chunks: chunks.length,
    querySHA,
    inputSHA: unionSHA,
    counts: {
      unionDocs: union.length, q1Rows: seenQ1.size, q2Rows: liveFacts.length,
      q1sum,
      ...tally,
      honbunScopes,
    },
    zeros: {
      httpObserved, httpFailed, nonD1fetch: 0, writes: 0, sourceGET: 0,
      notionCreateUpdateArchive: 0, d1r2mutation: 0, workflow: 0, newReceipts: 0, retries: 0,
    },
    limits: [
      "old facts counts 推計を必須 live 件数にしない。Q1 observed count が基準。",
      "honbun は protected scope (0600 のみ・stdout 0)。",
      "候補 changed の全原因帰属は既 raw の pure-offline 説明 + later apply 前 Root review。今回 apply grant 0。",
      "ライブ source ZIP archive は不可 (未実行)。",
      "future apply CAS は全 pre-image rows を exact counts/ids で含めること (本 snapshot が pre-image 候補)。",
    ],
    artifacts: {
      union: { path: join(OUT_DIR, "select-union.json"), sha256: unionFileSHA },
      manifest: { path: join(OUT_DIR, "select-manifest.json"), sha256: manifestSHA },
      live: { path: join(OUT_DIR, "select-live.json"), sha256: liveSHA },
      compare: { path: join(OUT_DIR, "select-compare.json"), sha256: compareSHA },
    },
  };
  const reportSHA = writePrivate(join(OUT_DIR, "select-report.json"), JSON.stringify(report, null, 2));

  // stdout は counts/SHA のみ (D1 IDs/values 0)。
  console.info(JSON.stringify({
    result: "PASS",
    union: report.union,
    chunks: chunks.length,
    queries: { q1: 18, q2: 18, httpObserved, httpFailed },
    liveCounts: { q1Rows: seenQ1.size, q2Rows: liveFacts.length, q1sum },
    compareCounts: tally,
    honbunScopes,
    querySHA,
    zeros: report.zeros,
    limits: report.limits,
    artifacts: { ...report.artifacts, report: { path: join(OUT_DIR, "select-report.json"), sha256: reportSHA } },
    at_end: report.at_end,
  }));
}

try {
  await main();
  process.exit(0);
} catch (e) {
  const reason = e instanceof Error ? e.message : String(e);
  const holdReport = {
    at_start: STARTED_AT,
    at_end: new Date().toISOString(),
    result: "HOLD",
    reason,
    zeros: { httpObserved, httpFailed },
  };
  try {
    writePrivate(join(OUT_DIR, "select-report-hold.json"), JSON.stringify(holdReport, null, 2));
  } catch { /* report 書込自体の失敗は握らず抜ける */ }
  console.error(JSON.stringify(holdReport));
  process.exit(1);
}
