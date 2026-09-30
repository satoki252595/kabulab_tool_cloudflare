/**
 * 海外 closed-44 の guarded-CAS NEWPOST executor (PREP・WRITE 0 が既定)。
 *
 * 既定は preflight (送信 0・network 0): frozen packet の検証 + 全 44 通の
 * batch 組立 + bind 上限検査 + 0600 archive。`--live` でのみ D1 へ送る
 * (Root の exact grant が必要。grant 0 の今は preflight のみ)。
 *
 * 再使用のみ (新規 framework なし):
 * - 行組立: 共有 toOverseasSaveRows(facts, status) (6th caller)。
 * - 原子 batch: ingest idiom (docId subquery + DELETE-by-subquery +
 *   chunked INSERT + per-doc batch)。Node 送出は toD1BatchStatements +
 *   createD1HttpBatchSender。失敗 = D1 error-JSON throw で batch 全体
 *   no-op (既存 json-error mechanism + D1 batch 原子性の実証記録)。
 * - L2: 既存 rebuildYuhoGrowthProjection (scoped stockIds)。
 *   Node からの直接呼出の前例がなく Database 型が Worker 束縛のため、
 *   本 executor は L2 plan (10 stocks・1 group) の pin + applied-set の
 *   記録まで。L2 実行自体は follow-up の granted step (Worker 経路)。
 *
 * CAS 設計 (Root 承認済み契約):
 * - guard は DELETE/UPDATE の WHERE に一度だけ埋め込む
 *   (doc16 全列 + Q2 echo の NULL-safe 一致 + exact-set COUNT)。
 * - DELETE 後に OLD Q2 guard を再評価しない。INSERT に OLD-state guard
 *   を付けない (post-DELETE では 0 行化し partial no-op を招くため)。
 *   代わり: unique(doc/period/region) + batch 原子性 + post-read 検証。
 * - numeric 競合時: INSERT が unique 違反 → batch 全体 atomic no-op →
 *   json-error を HOLD として報告。再送なし。
 * - unknown 競合時: DELETE 0 行 + UPDATE の post-zero 断定で 0 行 →
 *   batch 成功・無変更 → post-read で HOLD 確定。
 * - pre-write SELECT 照合は必要だが単独では不十分 (TOCTOU)。WHERE  guard
 *   が race-proof の本体。post-read は適用/無変更の確定のみ。
 *
 * 32 unknown は empty facts + honest status + scoped L2 除去
 * (fake-zero なし・旧値全否定なし)。MATCH 15 は対象外 (no writes)。
 * order/text 列は非接触 (明示 boundary)。Notion/R2/dispatch 0。
 *
 * 使い方:
 *   npx tsx services/yuho-quant/data-scripts/overseas-closed44-execute.ts \
 *     --packet /tmp/overseas-closed44-qual-20260930/closed44-qual.json \
 *     --out /tmp/overseas-closed44-exec-20260930
 *   live (grant のみ): 上記 + --live
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, or, sql } from "drizzle-orm";
import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy";
import type { Database } from "../src/db/client.js";
import {
  overseasSalesFacts,
  yuhoDocuments,
} from "../src/db/schema.js";
import {
  toOverseasSaveRows,
  type OverseasSaveStatus,
} from "../src/services/overseas-save-rows.js";
import {
  createD1HttpBatchSender,
  createD1HttpDb,
  toD1BatchStatements,
  type D1BatchStatement,
} from "../../../src/shared/db/d1-http-client.js";
import * as yuhoSchema from "../src/db/schema.js";
import type { OverseasFact } from "../src/services/overseas-parser.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");

/** Frozen packet pin (bytes + full SHA256)。 */
const PACKET_PIN = {
  bytes: 322234,
  sha256:
    "c7c0b56fdd7bf1c06cf7d249e65df70c635e41ed95a323791c3272dad2c7f3dd",
};

/** 再使用 module の full SHA (preflight で照合)。 */
const MODULE_PINS: Readonly<Record<string, string>> = {
  "services/yuho-quant/src/services/ingest.ts":
    "89ec23f902a323c31111357ee3382dcbbe6a5482627e0dcc96a0431999baa3a0",
  "services/yuho-quant/src/services/projection.ts":
    "924b73c2fa0fe775edf09152c650e1ceaacf9b650e20c7f1afd0c39a3ab1d1f0",
  "services/yuho-quant/src/services/overseas-save-rows.ts":
    "00d873f055f40450317c113affcadaede86b79592eb3d53a98ee0ec1921303c0",
  "services/yuho-quant/src/db/schema.ts":
    "8adec13819c141b23044bce38ddfbbe9a933f5080972161993779ba62c473393",
  "src/shared/db/d1-http-client.ts":
    "5a50ec98aee0f7b1a2c5dbd7f831099847242acc875106919f2e8e0efd5e2d4a",
};

/** D1 bind 上限。文ごと。 */
const MAX_BINDS_PER_STMT = 100;
/** INSERT chunk (11 binds/行 → 8 行で 88)。 */
const INSERT_ROWS_PER_STMT = 8;
/** L2 group 上限。 */
const L2_GROUP_SIZE = 97;

const DOC16_KEYS = [
  "id",
  "stockId",
  "edinetCode",
  "docId",
  "docTypeCode",
  "filerName",
  "periodStart",
  "periodEnd",
  "submittedAt",
  "parseStatus",
  "honbunFile",
  "overseasParseStatus",
  "overseasHonbunFile",
  "textParseStatus",
  "notionDocPageId",
  "ingestedAt",
] as const;

/** Q2 行の packet key (docId は JOIN 付加の text・guard 対象外)。 */
const Q2_KEYS = [
  "docId",
  "id",
  "documentId",
  "stockId",
  "fiscalYearEnd",
  "regionName",
  "regionKind",
  "isConsolidated",
  "unitLabel",
  "salesRaw",
  "salesYen",
  "ratioPct",
  "pattern",
] as const;

/** facts guard の business 列 (runtime id・JOIN docId 除外)。 */
const FACT_GUARD_COLS = [
  "documentId",
  "stockId",
  "fiscalYearEnd",
  "regionName",
  "regionKind",
  "isConsolidated",
  "unitLabel",
  "salesRaw",
  "salesYen",
  "ratioPct",
  "pattern",
] as const;

const JFACT_KEYS = [
  "regionName",
  "regionKind",
  "salesAmount",
  "ratioPct",
  "unitLabel",
  "unitYenFactor",
  "fiscalYearEnd",
  "isConsolidated",
] as const;

export interface ValidDoc {
  docId: string;
  stockId: number;
  numeric: boolean;
  doc16: Record<string, unknown>;
  q2: Record<string, unknown>[];
  newStatus: OverseasSaveStatus;
  newHonbunFile: string;
  newFacts: OverseasFact[];
  casShas: { entire16SHA: string; protectedSHA: string; q2KeySHA: string; q2RowsSHA: string };
}

function fail(msg: string): never {
  throw new Error(`[closed44-exec] ${msg}`);
}

/** own exact key の assert 読出。欠落・余剰 key は不可。null は素通し。 */
function own<T extends Record<string, unknown>>(
  row: T,
  key: string,
  ctx: string
): unknown {
  if (!Object.hasOwn(row, key)) fail(`${ctx}: key 欠落 ${key}`);
  return row[key];
}

function ownString(row: Record<string, unknown>, key: string, ctx: string): string {
  const v = own(row, key, ctx);
  if (typeof v !== "string") fail(`${ctx}: ${key} 非 string`);
  return v;
}

function assertExactKeys(
  row: Record<string, unknown>,
  keys: readonly string[],
  ctx: string
): void {
  const have = Object.keys(row).sort();
  const want = [...keys].sort();
  if (have.length !== want.length || have.some((k, i) => k !== want[i])) {
    fail(`${ctx}: key 不一致 have=[${have.join(",")}]`);
  }
}

/** ISO string | int sec | Date → int sec。 */
export function toUnixSec(v: unknown, ctx: string): number {
  let n: number;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) fail(`${ctx}: 時刻 parse 不可`);
    n = Math.floor(ms / 1000);
  } else if (v instanceof Date) {
    n = Math.floor(v.getTime() / 1000);
  } else if (typeof v === "number" && Number.isInteger(v)) {
    n = v;
  } else {
    fail(`${ctx}: 時刻型外`);
  }
  return n;
}

function normBool(v: unknown, ctx: string): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (v === 0 || v === 1) return v === 1;
  fail(`${ctx}: bool 型外`);
}

function normNum(v: unknown, ctx: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${ctx}: 数値型外`);
  return v;
}

function normStr(v: unknown, ctx: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") fail(`${ctx}: 文字列型外`);
  return v;
}

const KNOWN_STATUS = new Set([
  "ok_geo_rows",
  "ok_geo_cols",
  "geo_present_unstructured",
  "no_overseas_table",
  "parse_error",
]);

/** packet 1 行の strict 検証。 */
export function validateDocRow(raw: unknown, index: number): ValidDoc {
  const ctx = `rows[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`${ctx}: 非 object`);
  }
  const row = raw as Record<string, unknown>;
  const doc = ownString(row, "doc", ctx);
  const stockId = own(row, "stockId", ctx);
  if (typeof stockId !== "number" || !Number.isInteger(stockId)) {
    fail(`${ctx}: stockId 型外`);
  }
  const qual = ownString(row, "qual", ctx);
  const numeric = qual === "OFFLINE_CANDIDATE_NUMERIC";
  if (!numeric && qual !== "OFFLINE_CANDIDATE_UNSTRUCTURED") fail(`${ctx}: qual 不明`);
  const pre = own(row, "preimage", ctx);
  if (typeof pre !== "object" || pre === null) fail(`${ctx}: preimage 非 object`);
  const doc16 = (pre as Record<string, unknown>)["doc16"];
  if (typeof doc16 !== "object" || doc16 === null) fail(`${ctx}: doc16 非 object`);
  const d16 = doc16 as Record<string, unknown>;
  assertExactKeys(d16, DOC16_KEYS, `${ctx}.doc16`);
  if (d16["docId"] !== doc) fail(`${ctx}: docId 不一致`);
  const q2raw = own(row, "q2", ctx);
  if (!Array.isArray(q2raw) || q2raw.length === 0) fail(`${ctx}: q2 空/非配列`);
  const q2 = (q2raw as unknown[]).map((r, i) => {
    if (typeof r !== "object" || r === null) fail(`${ctx}.q2[${i}]: 非 object`);
    const rec = r as Record<string, unknown>;
    assertExactKeys(rec, Q2_KEYS, `${ctx}.q2[${i}]`);
    return rec;
  });
  const journal = own(row, "journal", ctx);
  if (typeof journal !== "object" || journal === null) fail(`${ctx}: journal 非 object`);
  const j = journal as Record<string, unknown>;
  const newStatus = ownString(j, "status", `${ctx}.journal`);
  if (!KNOWN_STATUS.has(newStatus)) fail(`${ctx}: 未知 status ${newStatus}`);
  const newHonbunFile = ownString(j, "honbunFile", `${ctx}.journal`);
  const jf = own(j, "facts", `${ctx}.journal`);
  if (!Array.isArray(jf)) fail(`${ctx}: journal.facts 非配列`);
  const newFacts = (jf as unknown[]).map((f, i) => {
    if (typeof f !== "object" || f === null) fail(`${ctx}.facts[${i}]: 非 object`);
    const rec = f as Record<string, unknown>;
    assertExactKeys(rec, JFACT_KEYS, `${ctx}.facts[${i}]`);
    return {
      regionName: normStr(rec["regionName"], "regionName") as string,
      regionKind: normStr(rec["regionKind"], "regionKind") as string,
      salesAmount: normNum(rec["salesAmount"], "salesAmount"),
      ratioPct: normNum(rec["ratioPct"], "ratioPct"),
      unitLabel: normStr(rec["unitLabel"], "unitLabel") as string,
      unitYenFactor: normNum(rec["unitYenFactor"], "unitYenFactor") as number,
      fiscalYearEnd: normStr(rec["fiscalYearEnd"], "fiscalYearEnd") as string,
      isConsolidated: normBool(rec["isConsolidated"], "isConsolidated"),
    } as OverseasFact;
  });
  if (numeric && newFacts.length === 0) fail(`${ctx}: numeric で facts 0`);
  if (!numeric && newFacts.length !== 0) fail(`${ctx}: unknown で非空 facts`);
  const cas = own(row, "cas", ctx);
  if (typeof cas !== "object" || cas === null) fail(`${ctx}: cas 非 object`);
  const c = cas as Record<string, unknown>;
  if (c["reverified"] !== true) fail(`${ctx}: cas.reverified 非 true`);
  return {
    docId: doc,
    stockId,
    numeric,
    doc16: d16,
    q2,
    newStatus: newStatus as OverseasSaveStatus,
    newHonbunFile,
    newFacts,
    casShas: {
      entire16SHA: ownString(c, "entire16SHA", `${ctx}.cas`),
      protectedSHA: ownString(c, "protectedSHA", `${ctx}.cas`),
      q2KeySHA: ownString(c, "q2KeySHA", `${ctx}.cas`),
      q2RowsSHA: ownString(c, "q2RowsSHA", `${ctx}.cas`),
    },
  };
}

/** doc16 全列の厳密一致 (時刻は sec 正規化)。 */
export function doc16Equals(
  live: Record<string, unknown>,
  pre: Record<string, unknown>
): boolean {
  for (const k of DOC16_KEYS) {
    const a = live[k];
    const b = pre[k];
    if (k === "submittedAt" || k === "ingestedAt") {
      if (toUnixSec(a, k) !== toUnixSec(b, k)) return false;
    } else if (a === null || a === undefined || b === null || b === undefined) {
      if (!((a === null || a === undefined) && (b === null || b === undefined))) {
        return false;
      }
    } else if (a !== b) {
      return false;
    }
  }
  return true;
}

/** Q2 business 全列の厳密一致 (runtime id・JOIN docId 除外。順序不問)。 */
export function q2SetEquals(
  live: Record<string, unknown>[],
  pre: Record<string, unknown>[]
): boolean {
  if (live.length !== pre.length) return false;
  const key = (r: Record<string, unknown>): string =>
    FACT_GUARD_COLS.map((c) => {
      const v = c === "isConsolidated" ? normBool(r[c], c) : (r[c] ?? null);
      return v === null ? "∅" : typeof v === "string" ? `s:${v}` : `n:${v}`;
    }).join("|");
  const a = live.map(key).sort();
  const b = pre.map(key).sort();
  return a.every((v, i) => v === b[i]);
}

/** expected post: doc16 (overseas 2 列置換) + save-rows business。 */
export function expectedPost(doc: ValidDoc): {
  doc16: Record<string, unknown>;
  facts: Record<string, unknown>[];
} {
  const rows = toOverseasSaveRows(doc.newFacts, doc.newStatus).map((o) => ({
    fiscalYearEnd: o.fiscalYearEnd,
    regionName: o.regionName,
    regionKind: o.regionKind,
    isConsolidated: o.isConsolidated,
    unitLabel: o.unitLabel,
    salesRaw: o.salesRaw,
    salesYen: o.salesYen,
    ratioPct: o.ratioPct,
    pattern: o.pattern,
  }));
  return {
    doc16: {
      ...doc.doc16,
      overseasParseStatus: doc.newStatus,
      overseasHonbunFile: doc.newHonbunFile,
    },
    facts: rows,
  };
}

export type PostVerdict = "APPLIED" | "NOOP_PRESTATE" | "MISMATCH";

/** post-read 判定: 適用済み / 無変更 (prestate のまま) / 不明な不一致。 */
export function classifyPost(
  pre: { doc16: Record<string, unknown>; q2: Record<string, unknown>[] },
  post: { doc16: Record<string, unknown>; q2: Record<string, unknown>[] },
  expected: { doc16: Record<string, unknown>; facts: Record<string, unknown>[] }
): PostVerdict {
  const docPostOk = doc16Equals(post.doc16, expected.doc16);
  const postBiz = post.q2.map((r) => {
    const o: Record<string, unknown> = {};
    for (const c of [
      "fiscalYearEnd",
      "regionName",
      "regionKind",
      "isConsolidated",
      "unitLabel",
      "salesRaw",
      "salesYen",
      "ratioPct",
      "pattern",
    ] as const) {
      o[c] = r[c] ?? null;
    }
    return { ...o, documentId: r["documentId"], stockId: r["stockId"] };
  });
  const factsPostOk =
    postBiz.length === expected.facts.length &&
    q2SetEquals(
      postBiz,
      expected.facts.map((f) => ({
        ...f,
        documentId: pre.doc16["id"],
        stockId: pre.doc16["stockId"],
      }))
    );
  if (docPostOk && factsPostOk) return "APPLIED";
  if (doc16Equals(post.doc16, pre.doc16) && q2SetEquals(post.q2, pre.q2)) {
    return "NOOP_PRESTATE";
  }
  return "MISMATCH";
}

/** NULL-safe `col IS ?` 断片。bool は 0/1、時刻は sec int に正規化。 */
function isGuard(col: string, v: unknown, ctx: string): ReturnType<typeof sql> {
  let p: string | number | null;
  if (v === null || v === undefined) {
    p = null;
  } else if (typeof v === "boolean") {
    p = v ? 1 : 0;
  } else if (typeof v === "string" || typeof v === "number") {
    p = v;
  } else if (v instanceof Date) {
    p = Math.floor(v.getTime() / 1000);
  } else {
    fail(`${ctx}: bind 型外`);
  }
  return sql`${sql.raw(col)} IS ${p}`;
}

function docSubquery(docId: string): ReturnType<typeof sql> {
  return sql`(select ${yuhoDocuments.id} from ${yuhoDocuments} where ${yuhoDocuments.docId} = ${docId})`;
}

/**
 * 1 通の原子 batch を組立てる。文順: DELETE (exact-set guard) →
 * INSERT ×n (numeric のみ) → UPDATE (full16 guard [+ unknown post-zero])。
 * 実行はしない (呼出側が toSQL 化して sender へ)。
 */
export function buildDocBatch(
  db: Database,
  doc: ValidDoc
): { builders: Parameters<typeof toD1BatchStatements>[0]; kinds: string[] } {
  const sub = docSubquery(doc.docId);
  const rowGuards = doc.q2.map((r) =>
    and(
      isGuard("fiscal_year_end", r["fiscalYearEnd"], "fiscalYearEnd"),
      isGuard("region_name", r["regionName"], "regionName"),
      isGuard("region_kind", r["regionKind"], "regionKind"),
      isGuard("is_consolidated", normBool(r["isConsolidated"], "isConsolidated") === null ? null : (normBool(r["isConsolidated"], "isConsolidated") ? 1 : 0), "isConsolidated"),
      isGuard("unit_label", r["unitLabel"], "unitLabel"),
      isGuard("sales_raw", r["salesRaw"], "salesRaw"),
      isGuard("sales_yen", r["salesYen"], "salesYen"),
      isGuard("ratio_pct", r["ratioPct"], "ratioPct"),
      isGuard("pattern", r["pattern"], "pattern")
    )
  );
  const liveCount = sql`(select count(*) from ${overseasSalesFacts} where ${overseasSalesFacts.documentId} = ${docSubquery(doc.docId)})`;
  const del = db
    .delete(overseasSalesFacts)
    .where(
      and(
        eq(overseasSalesFacts.documentId, sub),
        eq(overseasSalesFacts.stockId, doc.stockId),
        or(...rowGuards),
        sql`${liveCount} = ${doc.q2.length}`
      )
    );
  const saveRows = toOverseasSaveRows(doc.newFacts, doc.newStatus).map((o) => ({
    documentId: sub,
    stockId: doc.stockId,
    ...o,
  }));
  const inserts: Parameters<typeof toD1BatchStatements>[0] = [];
  for (let i = 0; i < saveRows.length; i += INSERT_ROWS_PER_STMT) {
    inserts.push(
      db.insert(overseasSalesFacts).values(saveRows.slice(i, i + INSERT_ROWS_PER_STMT))
    );
  }
  const d = doc.doc16;
  const updWhere = and(
    eq(yuhoDocuments.docId, doc.docId),
    isGuard("id", d["id"], "id"),
    isGuard("stock_id", d["stockId"], "stockId"),
    isGuard("edinet_code", d["edinetCode"], "edinetCode"),
    isGuard("doc_type_code", d["docTypeCode"], "docTypeCode"),
    isGuard("filer_name", d["filerName"], "filerName"),
    isGuard("period_start", d["periodStart"], "periodStart"),
    isGuard("period_end", d["periodEnd"], "periodEnd"),
    isGuard("submitted_at", toUnixSec(d["submittedAt"], "submittedAt"), "submittedAt"),
    isGuard("parse_status", d["parseStatus"], "parseStatus"),
    isGuard("honbun_file", d["honbunFile"], "honbunFile"),
    isGuard("overseas_parse_status", d["overseasParseStatus"], "overseasParseStatus"),
    isGuard("overseas_honbun_file", d["overseasHonbunFile"], "overseasHonbunFile"),
    isGuard("text_parse_status", d["textParseStatus"], "textParseStatus"),
    isGuard("notion_doc_page_id", d["notionDocPageId"], "notionDocPageId"),
    isGuard("ingested_at", toUnixSec(d["ingestedAt"], "ingestedAt"), "ingestedAt"),
    // unknown のみ: post-DELETE の new-state 断定 (DELETE 0 行の race 時は
    // UPDATE も 0 行 → batch 成功・無変更 → post-read で HOLD 確定)。
    // OLD Q2 guard の再評価ではない。
    doc.numeric
      ? undefined
      : sql`(select count(*) from ${overseasSalesFacts} where ${overseasSalesFacts.documentId} = ${docSubquery(doc.docId)}) = 0`
  );
  const upd = db
    .update(yuhoDocuments)
    .set({
      overseasParseStatus: doc.newStatus,
      overseasHonbunFile: doc.newHonbunFile,
    })
    .where(updWhere);
  const kinds = ["DELETE", ...inserts.map(() => "INSERT"), "UPDATE"];
  return { builders: [del, ...inserts, upd], kinds };
}

/** 文を toSQL 化 + bind 上限検査。 */
export function freezeStatements(
  builders: Parameters<typeof toD1BatchStatements>[0],
  kinds: string[],
  docId: string
): D1BatchStatement[] {
  const stmts = toD1BatchStatements(builders);
  stmts.forEach((s, i) => {
    if (s.params.length > MAX_BINDS_PER_STMT) {
      fail(`${docId} ${kinds[i]}: binds ${s.params.length} > 100`);
    }
  });
  return stmts;
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function writeWx0600(path: string, data: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function appendFsync(path: string, line: string): void {
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface PacketDocs {
  docs: ValidDoc[];
  l2Stocks: number[];
}

export function loadPacket(packetPath: string): PacketDocs {
  const raw = readFileSync(packetPath);
  if (raw.length !== PACKET_PIN.bytes) {
    fail(`packet bytes ${raw.length} ≠ ${PACKET_PIN.bytes}`);
  }
  const sha = sha256Hex(raw);
  if (sha !== PACKET_PIN.sha256) fail(`packet SHA 不一致`);
  const p = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  const rows = p["rows"];
  if (!Array.isArray(rows) || rows.length !== 44) fail(`rows ≠ 44`);
  const docs = (rows as unknown[]).map((r, i) => validateDocRow(r, i));
  const l2 = p["l2"] as { numericStocks: number[]; unstructStocks: number[] } | undefined;
  if (!l2 || !Array.isArray(l2.numericStocks) || !Array.isArray(l2.unstructStocks)) {
    fail(`l2 stocks 欠落`);
  }
  const all = [...l2.numericStocks, ...l2.unstructStocks];
  if (l2.numericStocks.length !== 3 || l2.unstructStocks.length !== 7) {
    fail(`l2 内訳 ≠ 3+7`);
  }
  if (new Set(all).size !== 10 || !all.every((n) => Number.isInteger(n))) {
    fail(`l2 stocks 非 distinct/非 int`);
  }
  const docStocks = new Set(docs.map((d) => d.stockId));
  if (docStocks.size !== 10 || ![...all].every((n) => docStocks.has(n))) {
    fail(`l2 stocks ≠ docs 実 distinct`);
  }
  if (new Set(all).size > L2_GROUP_SIZE) fail(`l2 group 超過`);
  return { docs, l2Stocks: all };
}

function checkModulePins(): void {
  for (const [rel, pin] of Object.entries(MODULE_PINS)) {
    const sha = sha256Hex(readFileSync(join(ROOT, rel)));
    if (sha !== pin) fail(`module pin 不一致: ${rel}`);
  }
}

/** builder 専用 db (await されたら throw。toSQL は純粋)。 */
function buildOnlyDb(): Database {
  return drizzleProxy(async () => {
    throw new Error("builder が実行された (toSQL のみのはず)");
  }) as unknown as Database;
}

export interface PreflightSummary {
  docs: number;
  numeric: number;
  unstructured: number;
  statements: number;
  maxBinds: number;
  deletes: number;
  inserts: number;
  updates: number;
  packetSha: string;
  statementsSha: string;
  l2: { stocks: number[]; groups: number };
}

/** preflight (送信 0・network 0)。full SQL は 0600 archive のみ。 */
export async function runPreflight(
  packetPath: string,
  outDir: string
): Promise<PreflightSummary> {
  checkModulePins();
  const { docs, l2Stocks } = loadPacket(packetPath);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const db = buildOnlyDb();
  let statements = 0;
  let maxBinds = 0;
  let deletes = 0;
  let inserts = 0;
  let updates = 0;
  const stmtsAll: { doc: string; kinds: string[]; stmts: D1BatchStatement[] }[] = [];
  for (const doc of docs) {
    const { builders, kinds } = buildDocBatch(db, doc);
    const stmts = freezeStatements(builders, kinds, doc.docId);
    statements += stmts.length;
    for (const s of stmts) maxBinds = Math.max(maxBinds, s.params.length);
    deletes += kinds.filter((k) => k === "DELETE").length;
    inserts += kinds.filter((k) => k === "INSERT").length;
    updates += kinds.filter((k) => k === "UPDATE").length;
    const exp = expectedPost(doc);
    writeWx0600(
      join(outDir, `${doc.docId}.batch.json`),
      JSON.stringify({ doc: doc.docId, kinds, stmts, expected: exp }, null, 2)
    );
    stmtsAll.push({ doc: doc.docId, kinds, stmts });
  }
  const statementsSha = sha256Hex(JSON.stringify(stmtsAll));
  const summary: PreflightSummary = {
    docs: docs.length,
    numeric: docs.filter((d) => d.numeric).length,
    unstructured: docs.filter((d) => !d.numeric).length,
    statements,
    maxBinds,
    deletes,
    inserts,
    updates,
    packetSha: PACKET_PIN.sha256,
    statementsSha,
    l2: { stocks: [...l2Stocks].sort((a, b) => a - b), groups: 1 },
  };
  writeWx0600(join(outDir, "preflight-summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}

export type DocOutcome = "APPLIED" | "HOLD_PRESTATE" | "HOLD_NOOP" | "HOLD_BATCH_ERROR" | "ABORT";

export interface LiveDeps {
  queryDb: Database;
  sender: (statements: readonly D1BatchStatement[]) => Promise<void>;
}

async function readDocState(
  queryDb: Database,
  doc: ValidDoc
): Promise<{ doc16: Record<string, unknown>; q2: Record<string, unknown>[] }> {
  const docRows = (await queryDb
    .select()
    .from(yuhoDocuments)
    .where(eq(yuhoDocuments.docId, doc.docId))) as unknown as Record<string, unknown>[];
  if (docRows.length !== 1) fail(`${doc.docId}: doc 行 ≠ 1`);
  const live = docRows[0] as Record<string, unknown>;
  const id = live["id"];
  if (typeof id !== "number") fail(`${doc.docId}: live id 非 number`);
  const qRows = (await queryDb
    .select()
    .from(overseasSalesFacts)
    .where(eq(overseasSalesFacts.documentId, id))) as unknown as Record<string, unknown>[];
  return { doc16: live, q2: qRows };
}

/** live 1 通。HOLD は skip 継続の合図・輸送/unknown は ABORT を throw。 */
export async function applyOneDoc(
  deps: LiveDeps,
  buildDb: Database,
  doc: ValidDoc
): Promise<{ outcome: DocOutcome; detail: string }> {
  const pre = await readDocState(deps.queryDb, doc);
  if (!doc16Equals(pre.doc16, doc.doc16) || !q2SetEquals(pre.q2, doc.q2)) {
    return { outcome: "HOLD_PRESTATE", detail: "prestate 不一致 (送信なし)" };
  }
  const { builders, kinds } = buildDocBatch(buildDb, doc);
  const stmts = freezeStatements(builders, kinds, doc.docId);
  try {
    await deps.sender(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/D1 HTTP error|D1 batch|UNIQUE|unique/i.test(msg)) {
      return { outcome: "HOLD_BATCH_ERROR", detail: `batch 失敗→no-op: ${msg.slice(0, 200)}` };
    }
    throw e;
  }
  const post = await readDocState(deps.queryDb, doc);
  const verdict = classifyPost(pre, post, expectedPost(doc));
  if (verdict === "APPLIED") return { outcome: "APPLIED", detail: "post 一致" };
  if (verdict === "NOOP_PRESTATE") {
    return { outcome: "HOLD_NOOP", detail: "無変更 (guard 0 適用)" };
  }
  fail(`${doc.docId}: post MISMATCH (手動確認。自動再実行なし)`);
}

function argVal(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main(): Promise<void> {
  const packet = argVal("packet");
  const out = argVal("out");
  if (!packet || !out) fail(`--packet= --out= が必要`);
  const live = process.argv.includes("--live");
  if (!live) {
    const s = await runPreflight(packet, out);
    console.info(JSON.stringify({ mode: "preflight", sends: 0, ...s }));
    return;
  }
  checkModulePins();
  const { docs, l2Stocks } = loadPacket(packet);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const queryDb = createD1HttpDb(yuhoSchema) as unknown as Database;
  const sender = createD1HttpBatchSender();
  const buildDb = buildOnlyDb();
  const ledger = join(out, "ledger.jsonl");
  openSync(ledger, "wx", 0o600);
  closeSync(openSync(ledger, "r"));
  const appliedStocks = new Set<number>();
  const outcomes: Record<string, number> = {};
  for (const doc of docs) {
    const r = await applyOneDoc({ queryDb, sender }, buildDb, doc);
    if (r.outcome === "APPLIED") appliedStocks.add(doc.stockId);
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    appendFsync(ledger, JSON.stringify({ doc: doc.docId, ...r }) + "\n");
  }
  const receipt = {
    mode: "live",
    outcomes,
    appliedStocks: [...appliedStocks].sort((a, b) => a - b),
    l2plan: {
      fn: "rebuildYuhoGrowthProjection",
      allStocks: [...l2Stocks].sort((a, b) => a - b),
      groups: 1,
      note: "L2 実行は follow-up granted step (Worker 経路)。本 run は記録のみ。",
    },
  };
  writeWx0600(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.info(JSON.stringify(receipt));
}

const invoked = process.argv[1]?.endsWith("overseas-closed44-execute.ts") ?? false;
if (invoked) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
