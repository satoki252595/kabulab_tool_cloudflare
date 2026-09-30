/**
 * Closed44 repair PREP compiler. CLI performs local pin validation and freezes
 * atomic SQL; --live always STOPs before IO. It has no operational grant.
 *
 * Each atomic batch starts with the full16 document / all12 existing-facts
 * JSON1 assertion (counts + two-way EXCEPT, including runtime fact IDs).
 * A mismatch throws before DELETE/INSERT/UPDATE. DML never rechecks deleted
 * old facts. Any sender/post failure aborts; UNKNOWN is never a no-op.
 *
 * Local actual-source tests exercise the same applyOneDoc with SQLite only:
 * qualified12 numeric /32 honest unknown, race rollback and ACTUAL NEWPOST
 * reentry MATCH with no send. Normal producers already atomically replace
 * facts; their shared canonical toOverseasSaveRows remains unchanged.
 *
 * Operational capture/full HTTP, physical PRE custody, and scoped10 L2
 * closure remain separate required PREP. No live READY or write claim.
 * Source raw/private facts never belong in Git or stdout.
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
import { eq, sql } from "drizzle-orm";
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
  toD1BatchStatements,
  type D1BatchStatement,
} from "../../../src/shared/db/d1-http-client.js";
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
  "src/cron/universe-overlay.ts":
    "c69c05363dacce3b6dd4199e4684718fec11f69a8f2b87c412e7ddc31c206e75",
};

/** D1 bind 上限。文ごと。 */
const MAX_BINDS_PER_STMT = 100;
/** INSERT chunk (11 binds/行 → 8 行で 88)。 */
const INSERT_ROWS_PER_STMT = 8;
/** L2 group 上限。 */
const L2_GROUP_SIZE = 97;
/** docID の strict 形 (SQL literal 埋込のため charset 固定)。 */
const DOCID_RE = /^S100[0-9A-Z]{4}$/;

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

/** Q2 行の packet key (docId は JOIN 付加の text)。 */
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

/** FIRST 断定の doc 列 (SQL 順。exp/act 同一順序)。 */
const ASSERT_DOC_SQL_COLS = [
  "id",
  "stock_id",
  "edinet_code",
  "doc_id",
  "doc_type_code",
  "filer_name",
  "period_start",
  "period_end",
  "submitted_at",
  "parse_status",
  "honbun_file",
  "overseas_parse_status",
  "overseas_honbun_file",
  "text_parse_status",
  "notion_doc_page_id",
  "ingested_at",
] as const;
const ASSERT_DOC_JSON_KEYS = [
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

/** FIRST 断定の Q2 列 (all12・id 含む。SQL 順)。 */
const ASSERT_Q2_SQL_COLS = [
  "id",
  "document_id",
  "stock_id",
  "fiscal_year_end",
  "region_name",
  "region_kind",
  "is_consolidated",
  "unit_label",
  "sales_raw",
  "sales_yen",
  "ratio_pct",
  "pattern",
] as const;
const ASSERT_Q2_JSON_KEYS = [
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
  /** source44 actual-cells lineage (pre-archive 用に保持)。 */
  lineage: {
    custody: string;
    manifestMatch: boolean;
    hostedSHA: string;
    manifestSha: string;
    qual: string;
    citation: unknown;
  };
}

function fail(msg: string): never {
  throw new Error(`[closed44-exec] ${msg}`);
}

/** own exact key の assert 読出。欠落は不可。null は素通し。 */
function own(row: Record<string, unknown>, key: string, ctx: string): unknown {
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

/** own-key 必須読出。欠落・undefined は STOP (null 化しない)。 */
function reqOwn(rec: Record<string, unknown>, key: string, ctx: string): unknown {
  if (!Object.hasOwn(rec, key)) fail(`${ctx}: key 欠落 ${key}`);
  const v = rec[key];
  if (v === undefined) fail(`${ctx}: ${key} undefined (STOP)`);
  return v;
}

function normBool(v: unknown, ctx: string): boolean | null {
  if (v === undefined) fail(`${ctx}: 欠落 (STOP。null 化しない)`);
  if (v === null) return null;
  if (typeof v === "boolean") return v;
  if (v === 0 || v === 1) return v === 1;
  fail(`${ctx}: bool 型外`);
}

function normNum(v: unknown, ctx: string): number | null {
  if (v === undefined) fail(`${ctx}: 欠落 (STOP。null 化しない)`);
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`${ctx}: 数値型外`);
  return v;
}

function normStr(v: unknown, ctx: string): string | null {
  if (v === undefined) fail(`${ctx}: 欠落 (STOP。null 化しない)`);
  if (v === null) return null;
  if (typeof v !== "string") fail(`${ctx}: 文字列型外`);
  return v;
}

function reqStr(v: unknown, ctx: string): string {
  if (v === undefined) fail(`${ctx}: 欠落 (STOP)`);
  if (typeof v !== "string") fail(`${ctx}: 文字列型外`);
  return v;
}

function normInt(v: unknown, ctx: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) fail(`${ctx}: int 型外`);
  return v;
}

const KNOWN_STATUS = new Set([
  "ok_geo_rows",
  "ok_geo_cols",
  "geo_present_unstructured",
  "no_overseas_table",
  "parse_error",
]);

/** packet 1 行の strict 検証 + primary physical gate。 */
export function validateDocRow(raw: unknown, index: number): ValidDoc {
  const ctx = `rows[${index}]`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`${ctx}: 非 object`);
  }
  const row = raw as Record<string, unknown>;
  const doc = ownString(row, "doc", ctx);
  if (!DOCID_RE.test(doc)) fail(`${ctx}: docID 形式外`);
  const stockId = own(row, "stockId", ctx);
  if (typeof stockId !== "number" || !Number.isInteger(stockId)) {
    fail(`${ctx}: stockId 型外`);
  }
  // primary physical gate: Tier A anchored + manifest 照合 + hosted 所在。
  if (own(row, "custody", ctx) !== "A-anchored-same-bytes") {
    fail(`${ctx}: custody 非 Tier-A`);
  }
  if (own(row, "manifestMatch", ctx) !== true) fail(`${ctx}: manifest 非照合`);
  const hostedSHA = ownString(row, "hostedSHA", ctx);
  if (hostedSHA.length === 0) fail(`${ctx}: hostedSHA 空`);
  const manifestSha = ownString(row, "manifestSha", ctx);
  if (manifestSha.length === 0) fail(`${ctx}: manifestSha 空`);
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
    lineage: {
      custody: ownString(row, "custody", ctx),
      manifestMatch: own(row, "manifestMatch", ctx) as boolean,
      hostedSHA,
      manifestSha,
      qual,
      citation: own(row, "citation", ctx),
    },
  };
}

/** frozen doc 値 (JSON bind 用。null は actual NULL のまま保持)。 */
export interface FrozenDoc {
  id: number;
  stockId: number;
  edinetCode: string;
  docId: string;
  docTypeCode: string;
  filerName: string;
  periodStart: string | null;
  periodEnd: string;
  submittedAt: number;
  parseStatus: string;
  honbunFile: string | null;
  overseasParseStatus: string | null;
  overseasHonbunFile: string | null;
  textParseStatus: string | null;
  notionDocPageId: string | null;
  ingestedAt: number;
}

/** frozen Q2 値 (all12・id 含む。bool は 0/1、null 保持)。 */
export interface FrozenQ2 {
  id: number;
  documentId: number;
  stockId: number;
  fiscalYearEnd: string;
  regionName: string;
  regionKind: string;
  isConsolidated: number | null;
  unitLabel: string;
  salesRaw: number | null;
  salesYen: number | null;
  ratioPct: number | null;
  pattern: string;
}

/**
 * full16 の own-key 完備 norm。欠落・undefined は STOP。
 * actual NULL は null のまま保持する (SQL 側は EXCEPT の NULL-safe
 * 比較 = IS 意味論で照合する)。
 */
export function normDoc(rec: Record<string, unknown>, ctx: string): FrozenDoc {
  assertExactKeys(rec, DOC16_KEYS, ctx);
  return {
    id: normInt(reqOwn(rec, "id", ctx), `${ctx}.id`),
    stockId: normInt(reqOwn(rec, "stockId", ctx), `${ctx}.stockId`),
    edinetCode: reqStr(reqOwn(rec, "edinetCode", ctx), `${ctx}.edinetCode`),
    docId: reqStr(reqOwn(rec, "docId", ctx), `${ctx}.docId`),
    docTypeCode: reqStr(reqOwn(rec, "docTypeCode", ctx), `${ctx}.docTypeCode`),
    filerName: reqStr(reqOwn(rec, "filerName", ctx), `${ctx}.filerName`),
    periodStart: normStr(reqOwn(rec, "periodStart", ctx), `${ctx}.periodStart`),
    periodEnd: reqStr(reqOwn(rec, "periodEnd", ctx), `${ctx}.periodEnd`),
    submittedAt: toUnixSec(reqOwn(rec, "submittedAt", ctx), `${ctx}.submittedAt`),
    parseStatus: reqStr(reqOwn(rec, "parseStatus", ctx), `${ctx}.parseStatus`),
    honbunFile: normStr(reqOwn(rec, "honbunFile", ctx), `${ctx}.honbunFile`),
    overseasParseStatus: normStr(reqOwn(rec, "overseasParseStatus", ctx), `${ctx}.overseasParseStatus`),
    overseasHonbunFile: normStr(reqOwn(rec, "overseasHonbunFile", ctx), `${ctx}.overseasHonbunFile`),
    textParseStatus: normStr(reqOwn(rec, "textParseStatus", ctx), `${ctx}.textParseStatus`),
    notionDocPageId: normStr(reqOwn(rec, "notionDocPageId", ctx), `${ctx}.notionDocPageId`),
    ingestedAt: toUnixSec(reqOwn(rec, "ingestedAt", ctx), `${ctx}.ingestedAt`),
  };
}

/** Q2 all12 の own-key 完備 norm (id/documentId/stockId 含む)。 */
export function normQ2(rec: Record<string, unknown>, ctx: string): FrozenQ2 {
  assertExactKeys(rec, Object.hasOwn(rec, "docId") ? Q2_KEYS : LIVE_Q2_KEYS, ctx);
  const b01 = (v: unknown, c: string): number | null => {
    const b = normBool(v, c);
    return b === null ? null : b ? 1 : 0;
  };
  return {
    id: normInt(reqOwn(rec, "id", ctx), `${ctx}.id`),
    documentId: normInt(reqOwn(rec, "documentId", ctx), `${ctx}.documentId`),
    stockId: normInt(reqOwn(rec, "stockId", ctx), `${ctx}.stockId`),
    fiscalYearEnd: reqStr(reqOwn(rec, "fiscalYearEnd", ctx), `${ctx}.fiscalYearEnd`),
    regionName: reqStr(reqOwn(rec, "regionName", ctx), `${ctx}.regionName`),
    regionKind: reqStr(reqOwn(rec, "regionKind", ctx), `${ctx}.regionKind`),
    isConsolidated: b01(reqOwn(rec, "isConsolidated", ctx), `${ctx}.isConsolidated`),
    unitLabel: reqStr(reqOwn(rec, "unitLabel", ctx), `${ctx}.unitLabel`),
    salesRaw: normNum(reqOwn(rec, "salesRaw", ctx), `${ctx}.salesRaw`),
    salesYen: normNum(reqOwn(rec, "salesYen", ctx), `${ctx}.salesYen`),
    ratioPct: normNum(reqOwn(rec, "ratioPct", ctx), `${ctx}.ratioPct`),
    pattern: reqStr(reqOwn(rec, "pattern", ctx), `${ctx}.pattern`),
  };
}

/** Q2 集合の正準直列化 (frozen bind・digest・pre-archive 用)。 */
export function serializeQ2(rows: Record<string, unknown>[], ctx: string): string {
  return JSON.stringify(rows.map((r, i) => normQ2(r, `${ctx}[${i}]`)));
}

/** doc16 全列の厳密一致 (IS 意味論・時刻は sec 正規化)。欠落は STOP。 */
export function doc16Equals(
  live: Record<string, unknown>,
  pre: Record<string, unknown>
): boolean {
  for (const k of DOC16_KEYS) {
    const a = reqOwn(live, k, "live-doc16");
    const b = reqOwn(pre, k, "pre-doc16");
    if (k === "submittedAt" || k === "ingestedAt") {
      if (toUnixSec(a, k) !== toUnixSec(b, k)) return false;
    } else if (a === null || b === null) {
      if (!(a === null && b === null)) return false;
    } else if (a !== b) {
      return false;
    }
  }
  return true;
}

/** Q2 business 全列の厳密一致 (IS 意味論。順序不問)。欠落は STOP。 */
export function q2SetEquals(
  live: Record<string, unknown>[],
  pre: Record<string, unknown>[]
): boolean {
  if (live.length !== pre.length) return false;
  const key = (r: Record<string, unknown>, ctx: string): string =>
    JSON.stringify(normQ2(r, ctx));
  const a = live.map((r, i) => key(r, `live-q2[${i}]`)).sort();
  const b = pre.map((r, i) => key(r, `pre-q2[${i}]`)).sort();
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

/** post-read 判定。成功 batch 後は APPLIED のみ正規 (他は ABORT)。 */
export function classifyPost(
  pre: { doc16: Record<string, unknown>; q2: Record<string, unknown>[] },
  post: { doc16: Record<string, unknown>; q2: Record<string, unknown>[] },
  expected: { doc16: Record<string, unknown>; facts: Record<string, unknown>[] }
): PostVerdict {
  const docPostOk = doc16Equals(post.doc16, expected.doc16);
  const postBiz = post.q2.map((r, i): Record<string, unknown> => {
    normQ2(r, `post-q2[${i}]`);
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
      o[c] = reqOwn(r, c, `post-q2[${i}]`);
    }
    return {
      ...o,
      documentId: reqOwn(r, "documentId", `post-q2[${i}]`),
      stockId: reqOwn(r, "stockId", `post-q2[${i}]`),
    };
  });
  const factsPostOk =
    postBiz.length === expected.facts.length &&
    JSON.stringify(postBiz.map((f) => stableStringify({
      ...f, isConsolidated: normBool(f["isConsolidated"], "post-bool"),
    })).sort()) === JSON.stringify(expected.facts.map((f) => stableStringify({
        ...f,
        isConsolidated: normBool(f["isConsolidated"], "expected-bool"),
        documentId: reqOwn(pre.doc16, "id", "pre-doc16"),
        stockId: reqOwn(pre.doc16, "stockId", "pre-doc16"),
      })).sort());
  if (docPostOk && factsPostOk) return "APPLIED";
  if (doc16Equals(post.doc16, pre.doc16) && q2SetEquals(post.q2, pre.q2)) {
    return "NOOP_PRESTATE";
  }
  return "MISMATCH";
}

function docSubquery(docId: string): ReturnType<typeof sql> {
  return sql`(select ${yuhoDocuments.id} from ${yuhoDocuments} where ${yuhoDocuments.docId} = ${docId})`;
}

/**
 * FIRST prestate 断定文。既存 `buildCoreRowsPreflightStatement` と同一機構
 * (frozen JSON 1 bind + 件数 + 両方向 EXCEPT + `json('')` の SQL エラーで
 * batch 全体 rollback)。bound のみ full-doc16 + Q2 all12 (id 含む) に
 * 一般化。SQL は固定・docID literal は strict 検証済み。
 */
export function buildAssertStatement(doc: ValidDoc): D1BatchStatement {
  const frozen = {
    doc: normDoc(doc.doc16, `${doc.docId}.doc`),
    q2: doc.q2.map((r, i) => normQ2(r, `${doc.docId}.q2[${i}]`)),
    q2count: doc.q2.length,
  };
  const literal = `'${doc.docId}'`;
  const docCols = ASSERT_DOC_SQL_COLS.join(", ");
  const docJson = ASSERT_DOC_JSON_KEYS.map(
    (k) => `json_extract((SELECT j FROM snap), '$.doc.${k}')`
  ).join(", ");
  const qCols = ASSERT_Q2_SQL_COLS.join(", ");
  const qJson = ASSERT_Q2_JSON_KEYS.map(
    (k) => `json_extract(value,'$.${k}')`
  ).join(", ");
  const sqlText = [
    "-- preflight: prestate 不一致は SQL エラーで batch 全体 rollback",
    "WITH snap(j) AS (VALUES (?)),",
    `exp_doc(${docCols}) AS (SELECT ${docJson}),`,
    `act_doc(${docCols}) AS (SELECT ${docCols} FROM yuho_documents WHERE doc_id = ${literal}),`,
    `exp_q2(${qCols}) AS (SELECT ${qJson} FROM json_each(json_extract((SELECT j FROM snap), '$.q2'))),`,
    `act_q2(${qCols}) AS (SELECT ${qCols} FROM yuho_overseas_facts WHERE document_id = (SELECT id FROM yuho_documents WHERE doc_id = ${literal}))`,
    "SELECT json(CASE WHEN",
    "  (SELECT COUNT(*) FROM act_doc) = 1",
    "  AND (SELECT COUNT(*) FROM exp_doc) = 1",
    "  AND NOT EXISTS (SELECT * FROM act_doc EXCEPT SELECT * FROM exp_doc)",
    "  AND NOT EXISTS (SELECT * FROM exp_doc EXCEPT SELECT * FROM act_doc)",
    "  AND (SELECT COUNT(*) FROM act_q2) = json_extract((SELECT j FROM snap), '$.q2count')",
    "  AND (SELECT COUNT(*) FROM exp_q2) = json_extract((SELECT j FROM snap), '$.q2count')",
    "  AND (SELECT COUNT(*) FROM act_q2) = (SELECT COUNT(*) FROM exp_q2)",
    "  AND NOT EXISTS (SELECT * FROM act_q2 EXCEPT SELECT * FROM exp_q2)",
    "  AND NOT EXISTS (SELECT * FROM exp_q2 EXCEPT SELECT * FROM act_q2)",
    "THEN 'null' ELSE '' END)",
  ].join("\n");
  return { sql: sqlText, params: [JSON.stringify(frozen)] };
}

/**
 * 1 通の原子 batch: FIRST 断定 + 通常 DML (old-guard 再検査なし)。
 * 文順: ASSERT → DELETE → INSERT ×n (numeric のみ) → UPDATE。
 * 実行はしない (呼出側が sender へ)。
 */
export function buildDocBatch(
  db: Database,
  doc: ValidDoc
): {
  first: D1BatchStatement;
  builders: Parameters<typeof toD1BatchStatements>[0];
  kinds: string[];
} {
  const first = buildAssertStatement(doc);
  const sub = docSubquery(doc.docId);
  const del = db
    .delete(overseasSalesFacts)
    .where(eq(overseasSalesFacts.documentId, sub));
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
  const upd = db
    .update(yuhoDocuments)
    .set({
      overseasParseStatus: doc.newStatus,
      overseasHonbunFile: doc.newHonbunFile,
    })
    .where(eq(yuhoDocuments.docId, doc.docId));
  const kinds = ["ASSERT", "DELETE", ...inserts.map(() => "INSERT"), "UPDATE"];
  return { first, builders: [del, ...inserts, upd], kinds };
}

/** 文を確定 + bind 上限検査。 */
export function freezeStatements(
  first: D1BatchStatement,
  builders: Parameters<typeof toD1BatchStatements>[0],
  kinds: string[],
  docId: string
): D1BatchStatement[] {
  const rest = toD1BatchStatements(builders);
  const stmts = [first, ...rest];
  if (stmts.length !== kinds.length) fail(`${docId}: 文数/kinds 不一致`);
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

/** key 順に依存しない正準直列化。 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "∅";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const rec = v as Record<string, unknown>;
  return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(",")}}`;
}

/** 値非開示の正準 digest (ledger/判定の比較用。財務値は出さない)。 */
export function stateDigest(o: unknown): string {
  return sha256Hex(stableStringify(o));
}

/** live Q2 行の exact key set (camelCase 12 列・JOIN なし)。 */
const LIVE_Q2_KEYS = [
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

/** live grant の bounded mandatory 検査。 */
export function assertGrant(v: string | undefined): string {
  if (typeof v !== "string" || v.length === 0) {
    fail("live には --grant=<Root-grant-id> が必須");
  }
  if (v.length > 128 || !/^[\x20-\x7E]+$/.test(v)) {
    fail("--grant 形式外 (printable ≤128)");
  }
  return v;
}

export interface PreflightSummary {
  docs: number;
  numeric: number;
  unstructured: number;
  statements: number;
  maxBinds: number;
  asserts: number;
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
  let asserts = 0;
  let deletes = 0;
  let inserts = 0;
  let updates = 0;
  const stmtsAll: { doc: string; kinds: string[]; stmts: D1BatchStatement[] }[] = [];
  for (const doc of docs) {
    const { kinds, stmts } = prefreezeDoc(db, doc);
    statements += stmts.length;
    for (const s of stmts) maxBinds = Math.max(maxBinds, s.params.length);
    asserts += kinds.filter((k) => k === "ASSERT").length;
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
    asserts,
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

export type DocOutcome = "APPLIED" | "MATCH" | "HOLD_PRESTATE";

export interface LiveDeps {
  queryDb: Database;
  sender: (statements: readonly D1BatchStatement[]) => Promise<void>;
  ledger: string;
  outDir: string;
  counters: { idx: number; total: number; sent: number; applied: number; held: number };
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
  assertExactKeys(live, DOC16_KEYS, `${doc.docId}.live-doc16`);
  const id = live["id"];
  if (typeof id !== "number") fail(`${doc.docId}: live id 非 number`);
  const qRows = (await queryDb
    .select()
    .from(overseasSalesFacts)
    .where(eq(overseasSalesFacts.documentId, id))) as unknown as Record<string, unknown>[];
  qRows.forEach((r, i) => assertExactKeys(r, LIVE_Q2_KEYS, `${doc.docId}.live-q2[${i}]`));
  if (new Set(qRows.map((r) => r["id"])).size !== qRows.length) {
    fail(`${doc.docId}: duplicate live fact id`);
  }
  for (const row of qRows) {
    const fact = normQ2(row, `${doc.docId}.live-q2`);
    if (fact.documentId !== id || fact.stockId !== live["stockId"]) {
      fail(`${doc.docId}: fact parent identity drift`);
    }
  }
  return { doc16: live, q2: qRows };
}

/** 1 通の確定 batch (prebuild 用。送信内容と archive の同一性を保証)。 */
export interface PrefrozenDoc {
  kinds: string[];
  stmts: D1BatchStatement[];
}

export function prefreezeDoc(buildDb: Database, doc: ValidDoc): PrefrozenDoc {
  const { first, builders, kinds } = buildDocBatch(buildDb, doc);
  const stmts = freezeStatements(first, builders, kinds, doc.docId);
  return { kinds, stmts };
}

/**
 * live 1 通。pre-send 不一致は HOLD skip (送信なし)。
 * 送信後の失敗 (HTTP/batch/UNIQUE)・post 不一致は ABORT throw
 * (raw + counter を ledger 保存。再送・noop/continue 分類なし)。
 */
export async function applyOneDoc(
  deps: LiveDeps,
  doc: ValidDoc,
  prebuilt: PrefrozenDoc
): Promise<{ outcome: DocOutcome; detail: string }> {
  const c = deps.counters;
  c.idx += 1;
  const pre = await readDocState(deps.queryDb, doc);
  if (classifyPost({ doc16: doc.doc16, q2: doc.q2 }, pre, expectedPost(doc)) === "APPLIED") {
    appendFsync(deps.ledger, JSON.stringify({ phase: "doc", idx: c.idx, doc: doc.docId, outcome: "MATCH" }) + "\n");
    return { outcome: "MATCH", detail: "actual post already matches (no send)" };
  }
  if (!doc16Equals(pre.doc16, doc.doc16) || !q2SetEquals(pre.q2, doc.q2)) {
    c.held += 1;
    appendFsync(
      deps.ledger,
      JSON.stringify({ phase: "doc", idx: c.idx, doc: doc.docId, outcome: "HOLD_PRESTATE" }) + "\n"
    );
    return { outcome: "HOLD_PRESTATE", detail: "prestate 不一致 (送信なし)" };
  }
  const { kinds, stmts } = prebuilt;
  // preforward: 送信前に全文書 + ledger を確定する。
  const fwdSha = stateDigest(stmts);
  writeWx0600(
    join(deps.outDir, `${doc.docId}.prefwd.json`),
    JSON.stringify({ doc: doc.docId, kinds, stmts }, null, 2)
  );
  appendFsync(
    deps.ledger,
    JSON.stringify({
      phase: "preforward",
      idx: c.idx,
      total: c.total,
      doc: doc.docId,
      stmts: stmts.length,
      binds: stmts.map((s) => s.params.length),
      sha: fwdSha,
    }) + "\n"
  );
  c.sent += 1;
  try {
    await deps.sender(stmts);
  } catch (e) {
    const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    appendFsync(
      deps.ledger,
      JSON.stringify({
        phase: "abort",
        idx: c.idx,
        total: c.total,
        doc: doc.docId,
        reason: "sender-throw",
        raw,
        counters: { ...c },
      }) + "\n"
    );
    throw e;
  }
  const post = await readDocState(deps.queryDb, doc);
  const verdict = classifyPost(pre, post, expectedPost(doc));
  if (verdict !== "APPLIED") {
    appendFsync(
      deps.ledger,
      JSON.stringify({
        phase: "abort",
        idx: c.idx,
        total: c.total,
        doc: doc.docId,
        reason: `post-${verdict}`,
        postSha: stateDigest(post),
        preSha: stateDigest(pre),
        counters: { ...c },
      }) + "\n"
    );
    fail(`${doc.docId}: post ${verdict} (成功 batch 後に非 APPLIED。手動確認。自動再実行なし)`);
  }
  c.applied += 1;
  appendFsync(
    deps.ledger,
    JSON.stringify({ phase: "doc", idx: c.idx, doc: doc.docId, outcome: "APPLIED" }) + "\n"
  );
  return { outcome: "APPLIED", detail: "post 一致" };
}

function argVal(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main(): Promise<void> {
  // PREP is reversible local work. No operational wire/custody closure is
  // present in this compiler, so an argument string cannot authorize live IO.
  if (process.argv.includes("--live")) {
    fail("PREP only: live execution is disabled; bounded capture, physical pre-archive and scoped L2 packet are not closed");
  }
  const packet = argVal("packet");
  const out = argVal("out");
  if (!packet || !out) fail("--packet= --out= are required");
  const summary = await runPreflight(packet, out);
  console.info(JSON.stringify({ mode: "preflight", sends: 0, ...summary }));
}

const invoked = process.argv[1]?.endsWith("overseas-closed44-execute.ts") ?? false;
if (invoked) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
