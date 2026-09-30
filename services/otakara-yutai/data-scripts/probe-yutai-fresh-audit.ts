/**
 * Yutai fresh audit probe (manual diagnostic CLI)。既定は prepare-only。
 *
 * 目的: 本番 D1 の現値を保存済み preimage/証跡と突き合わせる fresh 監査。
 * 既存の読取 chain (`openOtakaraD1` → `fetchYieldInputs` → `snapshotStockPreimages`)
 * をそのまま使い、新 SQL・新 API adapter は作らない。`loadBenefitRows`
 * (unbounded) は使わない。
 *
 * 送信なしの構造:
 * - 既定は plan 表示のみ (HTTP 0・env 0・file 0)。live 取得は --execute-live
 *   を付けた時だけ走り、root の grant (probe SHA + scope SHA + 件数 +
 *   private filenames + semantics + completeness の review) が前提。
 * - 8 POST は全て単発 {sql, params} の SELECT のみ。送信前に URL 完全一致・
 *   envelope 検査・SELECT 単文検査をする。batch 送信口は作らない。
 *   writer/sender は throw-if-called のみ。
 * - 8 連読は global transaction ではない (将来の apply は FULL CAS が別 gate)。
 * - 応答は raw bytes で保存し、shape/results/行型/必須列を厳密検証する。
 *   共有 client の missing-result→[] があっても監査は 0 同値を主張しない。
 *
 * 使い方:
 *   plan (offline): node --import tsx services/otakara-yutai/data-scripts/probe-yutai-fresh-audit.ts
 *   live (grant 後のみ): 同 + --execute-live
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openOtakaraD1 } from "./benefit-rows.js";
import {
  applyAtomicBatches,
  snapshotStockPreimages,
  planAtomicBatches,
  type AtomicBatchSender,
  type StockPreimage,
} from "./atomic-apply.js";
import {
  computeYieldEntries,
  fetchYieldInputs,
  type YieldInputs,
} from "./recompute-yields.js";
import {
  buildDescriptionUpdateStatements,
  classifyDescriptionRepair,
  planSummaryImport,
  type PlannedUpdate,
} from "./summary-import.js";
import {
  parseTaskFile,
  type BenefitRow,
  type SummaryTask,
} from "./summary-tasks.js";
import {
  PINS,
  parseAbcManifest,
  producePlannedUpdate,
  proveTargetCoverage,
  throwingSender,
} from "./verify-repair-reentry.js";
import { sharedEnv } from "../../../src/shared/env.js";
import type { D1BatchStatement } from "../../../src/shared/db/d1-http-client.js";

function fail(msg: string): never {
  throw new Error(`[fresh-probe] HOLD: ${msg}`);
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function readPinned(dir: string, name: string): string {
  const text = readFileSync(join(dir, name), "utf-8");
  if (sha256Hex(text) !== PINS[name]) fail(`SHA pin 不一致: ${name}`);
  return text;
}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`${what} が object ではない`);
  return v as Record<string, unknown>;
}

function asArray(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) fail(`${what} が配列ではない`);
  return v;
}

export type ProbeArgs = {
  dir: string;
  c45dir: string;
  upstream: string;
  physical: string;
  outDir: string;
  executeLive: boolean;
};

export function parseProbeArgs(argv: readonly string[]): ProbeArgs {
  const get = (flag: string, def: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] as string : def;
  };
  return {
    dir: get("--dir", "/tmp/yutai-src-repair-20260929"),
    c45dir: get("--c45dir", "/tmp/c45"),
    upstream: get("--upstream", "/tmp/c45/upstream"),
    physical: get("--physical", "/tmp/physical34/manifest-34.json"),
    outDir: get("--out", "/tmp/yutai-fresh-audit-20260930"),
    executeLive: argv.includes("--execute-live"),
  };
}

/** 出力 10 件の固定名 (01-08 raw + snapshot + metadata)。 */
export const RAW_NAMES = [
  "raw-response-01.json",
  "raw-response-02.json",
  "raw-response-03.json",
  "raw-response-04.json",
  "raw-response-05.json",
  "raw-response-06.json",
  "raw-response-07.json",
  "raw-response-08.json",
] as const;
export const SNAPSHOT_NAME = "fresh-snapshot.json";
export const METADATA_NAME = "metadata.json";

export const UNION_SIZE = 144;
export const CHUNK_SIZE = 80;
export const BENEFITS_CAP = 2000;

export type CallKind = "parent" | "fin" | "score" | "benefits";

/** fetchYieldInputs が chunk ごとに発行する 4 SELECT の固定順。 */
export const CALL_PLAN: { kind: CallKind; table: string }[] = [
  { kind: "parent", table: "core_stocks" },
  { kind: "fin", table: "otakara_stock_financials" },
  { kind: "score", table: "otakara_stock_scores" },
  { kind: "benefits", table: "yutai_benefits" },
];

/**
 * raw 応答行の期待キー (列順つき。共有 client が Object.values の列順に
 * 依存するため順序まで固定する)。実 bytes と違えば STOP (実値を保存)。
 */
export const EXPECTED_KEYS: Record<CallKind, readonly string[]> = {
  parent: ["id", "code", "is_active"],
  fin: [
    "stock_id",
    "price",
    "per",
    "pbr",
    "dividend_yield",
    "roe",
    "ma25",
    "rsi14",
    "macd",
    "macd_signal",
    "yutai_yield",
    "data_date",
    "fetched_at",
  ],
  score: ["stock_id", "fundamental_score", "technical_score", "total_score"],
  benefits: [
    "id",
    "stock_id",
    "min_shares",
    "record_month",
    "description",
    "short_summary",
    "estimated_value",
    "estimate_value_source",
    "updated_at",
  ],
};

export type ScopeStock = {
  stockId: number;
  code: string;
  sources: ("ABC" | "FT" | "N34")[];
};

export type FreshScope = {
  union: number[];
  chunks: [number[], number[]];
  perStock: Map<number, ScopeStock>;
  /** 全 benefitId→親 mapping (ABC preimage 1557 + row-manifest 349 の merge)。 */
  benefitMap: Map<number, { stockId: number; code: string }>;
  abcIds: number[];
  ftIds: number[];
  normalIds: number[];
  outside6: number[];
  scopeSha: string;
};

type NamedRowLite = { id: number; stockId: number; stockCode: string; oldDescription: string };

function parseRowManifestLite(text: string): NamedRowLite[] {
  const root = asRecord(JSON.parse(text), "row-manifest");
  const out: NamedRowLite[] = [];
  for (const e of asArray(root["rows"], "row-manifest.rows")) {
    const r = asRecord(e, "row-manifest row");
    if (
      typeof r["id"] !== "number" ||
      typeof r["stockId"] !== "number" ||
      typeof r["stockCode"] !== "string" ||
      typeof r["oldDescription"] !== "string"
    ) {
      fail("row-manifest 行の id/stockId/stockCode/oldDescription が不正");
    }
    out.push({
      id: r["id"] as number,
      stockId: r["stockId"] as number,
      stockCode: r["stockCode"] as string,
      oldDescription: r["oldDescription"] as string,
    });
  }
  return out;
}

function parseRowManifestFull(text: string): Map<number, { oldDescription: string; newFull: string }> {
  const root = asRecord(JSON.parse(text), "row-manifest");
  const out = new Map<number, { oldDescription: string; newFull: string }>();
  for (const e of asArray(root["rows"], "row-manifest.rows")) {
    const r = asRecord(e, "row-manifest row");
    if (typeof r["id"] !== "number" || typeof r["oldDescription"] !== "string" || typeof r["newFull"] !== "string") {
      fail("row-manifest 行の id/oldDescription/newFull が不正");
    }
    out.set(r["id"] as number, { oldDescription: r["oldDescription"] as string, newFull: r["newFull"] as string });
  }
  return out;
}

function parseFtBatched(text: string): Map<number, { newFull: string; old: string }> {
  const root = asRecord(JSON.parse(text), "fulltext-manifest");
  const batches = asArray(root["batches"], "fulltext-manifest.batches");
  if (batches.length !== 13) fail(`全文 batches stocks=${batches.length} (want 13)`);
  const out = new Map<number, { newFull: string; old: string }>();
  for (const b of batches) {
    const batch = asRecord(b, "fulltext batch");
    for (const s of asArray(batch["statements"], "fulltext statements").slice(1)) {
      const st = asRecord(s, "fulltext statement");
      const sql = st["sql"];
      if (typeof sql !== "string" || !sql.startsWith("UPDATE yutai_benefits SET description = ?")) {
        fail("全文の非 preflight 文が description UPDATE ではない");
      }
      const p = asArray(st["params"], "fulltext params");
      const id = p[1];
      if (typeof id !== "number" || typeof p[0] !== "string" || typeof p[2] !== "string") {
        fail("全文 params の [newFull, id, old] が不正");
      }
      if (out.has(id)) fail(`全文 ID ${id} の重複`);
      out.set(id, { newFull: p[0] as string, old: p[2] as string });
    }
  }
  if (out.size !== 62) fail(`全文 batched rows=${out.size} (want 62)`);
  return out;
}

function parseManifest34Codes(text: string): string[] {
  const root = asRecord(JSON.parse(text), "manifest-34");
  const out: string[] = [];
  for (const e of asArray(root["results"], "manifest-34.results")) {
    const code = asRecord(e, "manifest-34 result")["code"];
    if (typeof code !== "string") fail("manifest-34 result.code が文字列ではない");
    out.push(code);
  }
  if (out.length !== 34) fail(`manifest-34 codes=${out.length} (want 34)`);
  return out;
}

/**
 * 監査 scope の再導出 (offline)。ABC 131 + FT 13 + normal 34 → union 144、
 * A∩FT=6、normal-outside=6 を実値で検証する。違えば STOP (強制しない)。
 */
export function deriveScope(abcText: string, ftText: string, rowText: string, m34Text: string): FreshScope {
  const abc = parseAbcManifest(abcText);
  const abcIds = [...abc.preimages.keys()].sort((a, b) => a - b);
  if (abcIds.length !== 131) fail(`ABC stocks=${abcIds.length} (want 131)`);
  const rows = parseRowManifestLite(rowText);
  const id2stock = new Map(rows.map((r) => [r.id, r.stockId]));
  const code2stock = new Map<string, number>();
  for (const r of rows) {
    const prev = code2stock.get(r.stockCode);
    if (prev !== undefined && prev !== r.stockId) fail(`code=${r.stockCode} が複数 stockId に出現`);
    code2stock.set(r.stockCode, r.stockId);
  }
  const batched = parseFtBatched(ftText);
  const ftIds = [...new Set([...batched.keys()].map((id) => {
    const s = id2stock.get(id);
    if (s === undefined) fail(`全文 ID ${id} が row-manifest に無い`);
    return s!;
  }))].sort((a, b) => a - b);
  if (ftIds.length !== 13) fail(`FT stocks=${ftIds.length} (want 13)`);
  const normalIds = parseManifest34Codes(m34Text).map((code) => {
    const s = code2stock.get(code);
    if (s === undefined) fail(`manifest-34 code=${code} が row-manifest に無い`);
    return s!;
  });
  const normalSet = new Set(normalIds);
  if (normalSet.size !== 34) fail(`normal stocks unique=${normalSet.size} (want 34)`);
  const abcSet = new Set(abcIds);
  const ftSet = new Set(ftIds);
  const interAF = abcIds.filter((id) => ftSet.has(id));
  if (interAF.length !== 6) fail(`A∩FT=${interAF.length} (want 6): ${interAF.join(",")}`);
  const union = [...new Set([...abcIds, ...ftIds, ...normalIds])].sort((a, b) => a - b);
  if (union.length !== UNION_SIZE) fail(`union=${union.length} (want ${UNION_SIZE})`);
  const outside6 = normalIds.filter((id) => !abcSet.has(id) && !ftSet.has(id)).sort((a, b) => a - b);
  if (outside6.length !== 6) fail(`normal-outside=${outside6.length} (want 6): ${outside6.join(",")}`);
  // code 解決: row-manifest 優先、無ければ ABC preimage の parent.code。
  const codeById = new Map<number, string>();
  for (const [code, sid] of code2stock) {
    if (!codeById.has(sid)) codeById.set(sid, code);
  }
  for (const [sid, pre] of abc.preimages) {
    if (!codeById.has(sid)) codeById.set(sid, pre.parent.code);
    else if (codeById.get(sid) !== pre.parent.code) fail(`stockId=${sid} の code が preimage と row-manifest で不一致`);
  }
  const perStock = new Map<number, ScopeStock>();
  for (const sid of union) {
    const code = codeById.get(sid);
    if (code === undefined) fail(`stockId=${sid} の code が解決できない`);
    const sources: ScopeStock["sources"] = [];
    if (abcSet.has(sid)) sources.push("ABC");
    if (ftSet.has(sid)) sources.push("FT");
    if (normalSet.has(sid)) sources.push("N34");
    perStock.set(sid, { stockId: sid, code: code!, sources });
  }
  // benefitId→親 mapping の merge (衝突は STOP)。
  const benefitMap = new Map<number, { stockId: number; code: string }>();
  for (const [sid, pre] of abc.preimages) {
    for (const b of pre.benefits) {
      const prev = benefitMap.get(b.id);
      if (prev && prev.stockId !== sid) fail(`benefit ${b.id} の親が衝突: ${prev.stockId} vs ${sid}`);
      benefitMap.set(b.id, { stockId: sid, code: pre.parent.code });
    }
  }
  for (const r of rows) {
    const prev = benefitMap.get(r.id);
    if (prev && prev.stockId !== r.stockId) fail(`benefit ${r.id} の親が衝突: ${prev.stockId} vs ${r.stockId}`);
    benefitMap.set(r.id, { stockId: r.stockId, code: r.stockCode });
  }
  const chunks: [number[], number[]] = [union.slice(0, CHUNK_SIZE), union.slice(CHUNK_SIZE)];
  if (chunks[0].length !== 80 || chunks[1].length !== 64) {
    fail(`chunks=${chunks[0].length}+${chunks[1].length} (want 80+64)`);
  }
  const canonical = JSON.stringify({
    union: union.map((sid) => [sid, perStock.get(sid)!.code, perStock.get(sid)!.sources]),
    benefits: [...benefitMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bid, m]) => [bid, m.stockId, m.code]),
  });
  return {
    union,
    chunks,
    perStock,
    benefitMap,
    abcIds,
    ftIds,
    normalIds: [...normalSet].sort((a, b) => a - b),
    outside6,
    scopeSha: sha256Hex(canonical),
  };
}
/**
 * 送信前検査: URL 完全一致・単発 {sql, params} envelope・SELECT 単文。
 * batch 形・非 SELECT・複文 (;) は送らず STOP する。
 */
export function inspectSelectCall(
  url: string,
  bodyText: string,
  expectedUrl: string
): { sql: string; params: unknown[] } {
  if (url !== expectedUrl) fail("fetch 先 URL が想定 D1 と不一致 (DB exact 違反。URL 自体は出さない)");
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    fail("fetch body が JSON ではない");
  }
  const rec = asRecord(body, "fetch body");
  if ("batch" in rec) fail("batch 形の送信は禁止 (単発 SELECT のみ)");
  if (JSON.stringify(Object.keys(rec).sort()) !== JSON.stringify(["params", "sql"])) {
    fail(`fetch envelope が想定外: [${Object.keys(rec).join(",")}] (want [sql,params])`);
  }
  const sql = rec["sql"];
  const params = rec["params"];
  if (typeof sql !== "string") fail("fetch body.sql が文字列ではない");
  if (!Array.isArray(params)) fail("fetch body.params が配列ではない");
  if (!/^\s*select\b/i.test(sql as string)) fail(`非 SELECT の送信は禁止: ${(sql as string).slice(0, 60)}`);
  if ((sql as string).includes(";")) fail("複文 (;) の送信は禁止");
  return { sql: sql as string, params: params as unknown[] };
}

/** SQL 文中の物理テーブル名から call kind を判定する。 */
export function matchCallKind(sql: string): CallKind {
  for (const c of CALL_PLAN) {
    if (sql.includes(`"${c.table}"`)) return c.kind;
  }
  fail(`想定外テーブルへの SELECT: ${sql.slice(0, 120)}`);
}

export type CapturedCall = {
  index: number;
  kind: CallKind;
  chunk: number;
  sql: string;
  sqlSha: string;
  paramCount: number;
  paramSha: string;
  status: number;
  bytesLength: number;
  bytesSha: string;
  rowCount: number;
};

/** raw 応答行の列型 (scalar のみ。構造値は STOP)。 */
function assertScalar(v: unknown, what: string): asserts v is number | string | boolean | null {
  if (v !== null && typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean") {
    fail(`${what} が scalar ではない`);
  }
}

const COL_TYPES: Record<CallKind, Record<string, "number" | "string" | "number|null" | "string|null" | "boolnum">> = {
  parent: { id: "number", code: "string", is_active: "boolnum" },
  fin: {
    stock_id: "number",
    price: "number|null",
    per: "number|null",
    pbr: "number|null",
    dividend_yield: "number|null",
    roe: "number|null",
    ma25: "number|null",
    rsi14: "number|null",
    macd: "number|null",
    macd_signal: "number|null",
    yutai_yield: "number|null",
    data_date: "string",
    fetched_at: "number",
  },
  score: {
    stock_id: "number",
    fundamental_score: "number",
    technical_score: "number",
    total_score: "number",
  },
  benefits: {
    id: "number",
    stock_id: "number",
    min_shares: "number",
    record_month: "number",
    description: "string",
    short_summary: "string|null",
    estimated_value: "number|null",
    estimate_value_source: "string|null",
    updated_at: "number",
  },
};

function checkColType(kind: CallKind, key: string, v: unknown, what: string): void {
  assertScalar(v, what);
  const t = COL_TYPES[kind][key];
  if (t === "number" && typeof v !== "number") fail(`${what} が数値ではない`);
  if (t === "string" && typeof v !== "string") fail(`${what} が文字列ではない`);
  if (t === "number|null" && v !== null && typeof v !== "number") fail(`${what} が数値/null ではない`);
  if (t === "string|null" && v !== null && typeof v !== "string") fail(`${what} が文字列/null ではない`);
  if (t === "boolnum" && typeof v !== "boolean" && typeof v !== "number") fail(`${what} が真偽値/数値ではない`);
  if (t === "boolnum" && typeof v === "number" && v !== 0 && v !== 1) fail(`${what} が 0/1 ではない`);
}

export type ValidatedRows = {
  kind: CallKind;
  rows: Record<string, number | string | boolean | null>[];
};

/**
 * raw 応答 bytes の厳密検証。success/shape/results/行型/必須列/帰属を
 * 実 bytes から検証する。results の欠落を [] とは扱わない。
 */
export function validateRawResponse(kind: CallKind, bytes: Buffer, chunkIds: readonly number[]): ValidatedRows {
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString("utf-8"));
  } catch {
    fail(`${kind} 応答が JSON ではない`);
  }
  const root = asRecord(data, `${kind} 応答`);
  if (root["success"] !== true) fail(`${kind} 応答 success!=true`);
  const result = root["result"];
  if (!Array.isArray(result) || result.length === 0) fail(`${kind} 応答 result が非空配列ではない (欠落を [] とは扱わない)`);
  const first = asRecord(result[0], `${kind} 応答 result[0]`);
  const results = first["results"];
  if (!Array.isArray(results)) fail(`${kind} 応答 results が配列ではない (欠落を [] とは扱わない)`);
  const wantKeys = EXPECTED_KEYS[kind];
  const chunk = new Set(chunkIds);
  const rows: ValidatedRows["rows"] = [];
  const seen = new Set<number>();
  for (const [i, e] of (results as unknown[]).entries()) {
    const row = asRecord(e, `${kind} 行 ${i}`);
    const keys = Object.keys(row);
    if (JSON.stringify(keys) !== JSON.stringify(wantKeys)) {
      fail(`${kind} 行 ${i} の列が想定外: [${keys.join(",")}] (want [${wantKeys.join(",")}])`);
    }
    for (const k of keys) checkColType(kind, k, row[k], `${kind} 行 ${i}.${k}`);
    // 帰属: 行の銘柄が当該 chunk に属すること。一意性も同時に見る。
    const idKey = kind === "parent" ? "id" : "stock_id";
    const owner = row[idKey] as number;
    if (!chunk.has(owner)) fail(`${kind} 行 ${i} が chunk 外の銘柄 ${owner} に属する`);
    const uniqKey = kind === "benefits" ? "id" : idKey;
    const uniq = row[uniqKey] as number;
    if (seen.has(uniq)) fail(`${kind} で ${uniqKey}=${uniq} の重複`);
    seen.add(uniq);
    rows.push(row as ValidatedRows["rows"][number]);
  }
  return { kind, rows };
}

/** 8 連読の取得器。global fetch を検査・記録ラッパで包む。 */
export async function captureFreshReads(
  scope: FreshScope,
  expectedUrl: string
): Promise<{ inputs: YieldInputs; calls: CapturedCall[]; rawBytes: Buffer[] }> {
  const db = openOtakaraD1();
  const calls: CapturedCall[] = [];
  const rawBytes: Buffer[] = [];
  const realFetch = globalThis.fetch;
  let n = 0;
  const wrapped: typeof fetch = (async (input: unknown, init?: unknown) => {
    if (typeof input !== "string") fail("fetch 先が文字列 URL ではない");
    const initRec = asRecord(init ?? {}, "fetch init");
    if (initRec["method"] !== "POST") fail(`fetch method が POST ではない: ${String(initRec["method"])}`);
    if (typeof initRec["body"] !== "string") fail("fetch body が文字列ではない");
    n++;
    if (n > 8) fail(`9 件目の HTTP 呼び出し (extra HTTP 禁止)。8 件で打ち切る`);
    const { sql, params } = inspectSelectCall(input as string, initRec["body"] as string, expectedUrl);
    const want = CALL_PLAN[(n - 1) % 4];
    const kind = matchCallKind(sql);
    if (kind !== want.kind) fail(`${n} 件目の種別が ${kind} (want ${want.kind})`);
    const chunkNo = n <= 4 ? 0 : 1;
    const res = await realFetch(input as string, init as RequestInit);
    if (res.redirected) fail(`${n} 件目で redirect を検出 (redirect 禁止)`);
    const bytes = Buffer.from(await res.clone().arrayBuffer());
    const validated = validateRawResponse(kind, bytes, scope.chunks[chunkNo]);
    rawBytes.push(bytes);
    calls.push({
      index: n,
      kind,
      chunk: chunkNo,
      sql,
      sqlSha: sha256Hex(sql),
      paramCount: params.length,
      paramSha: sha256Hex(JSON.stringify(params)),
      status: res.status,
      bytesLength: bytes.length,
      bytesSha: sha256Hex(bytes),
      rowCount: validated.rows.length,
    });
    return res;
  }) as typeof fetch;
  let inputs: YieldInputs;
  try {
    globalThis.fetch = wrapped;
    inputs = await fetchYieldInputs(db, scope.union);
  } finally {
    globalThis.fetch = realFetch;
  }
  if (n !== 8) fail(`HTTP 呼び出しが ${n} 件 (want 8)。retry/欠落の疑い`);
  return { inputs, calls, rawBytes };
}
export type ParentProblem = {
  stockId: number;
  expectedCode: string;
  actual: string;
};

/**
 * 親の full scope/membership/NULL 完全比較。欠落・不活性・code 不一致を
 * 全件列挙する (truncate しない)。1 件でもあれば呼び出し側で STOP。
 */
export function checkFreshParents(scope: FreshScope, inputs: YieldInputs): ParentProblem[] {
  const problems: ParentProblem[] = [];
  for (const sid of scope.union) {
    const want = scope.perStock.get(sid)!.code;
    if (!inputs.parents.has(sid)) {
      problems.push({ stockId: sid, expectedCode: want, actual: "NO_ENTRY (map 欠落)" });
      continue;
    }
    const p = inputs.parents.get(sid)!;
    if (p === null) {
      problems.push({ stockId: sid, expectedCode: want, actual: "MISSING (非 active・非 equity・行無し)" });
      continue;
    }
    if (!p.isActive) problems.push({ stockId: sid, expectedCode: want, actual: `code=${p.code} isActive=false` });
    else if (p.code !== want) {
      problems.push({ stockId: sid, expectedCode: want, actual: `code=${p.code} isActive=true` });
    }
  }
  return problems;
}

export type AbcFreshDiff = {
  id: number;
  field: "row" | "shortSummary" | "estimatedValue" | "estimateValueSource" | "description" | "parent";
  planned: string;
  fresh: string;
};

export function compareAbcFresh(
  plannedById: Map<number, { shortSummary: string; estimatedValue: number | null; estimateValueSource: string | null }>,
  plannedIds: number[],
  fresh: Map<number, StockPreimage>,
  descExpected: Map<number, string>,
  benefitMap: Map<number, { stockId: number; code: string }>
): { diffs: AbcFreshDiff[]; descUncovered: number } {
  const freshById = new Map<number, { stockId: number; row: StockPreimage["benefits"][number] }>();
  for (const [sid, pre] of fresh) {
    for (const b of pre.benefits) freshById.set(b.id, { stockId: sid, row: b });
  }
  const diffs: AbcFreshDiff[] = [];
  let descUncovered = 0;
  const fmt = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
  for (const id of plannedIds) {
    const p = plannedById.get(id)!;
    const f = freshById.get(id);
    if (!f) {
      diffs.push({ id, field: "row", planned: "present", fresh: "MISSING" });
      continue;
    }
    if (f.row.shortSummary !== p.shortSummary) {
      diffs.push({ id, field: "shortSummary", planned: fmt(p.shortSummary), fresh: fmt(f.row.shortSummary) });
    }
    if (f.row.estimatedValue !== p.estimatedValue) {
      diffs.push({ id, field: "estimatedValue", planned: fmt(p.estimatedValue), fresh: fmt(f.row.estimatedValue) });
    }
    if (f.row.estimateValueSource !== p.estimateValueSource) {
      diffs.push({
        id,
        field: "estimateValueSource",
        planned: fmt(p.estimateValueSource),
        fresh: fmt(f.row.estimateValueSource),
      });
    }
    const wantParent = benefitMap.get(id)?.stockId;
    if (wantParent !== undefined && f.stockId !== wantParent) {
      diffs.push({ id, field: "parent", planned: `stockId=${wantParent}`, fresh: `stockId=${f.stockId}` });
    }
    const wantDesc = descExpected.get(id);
    if (wantDesc === undefined) descUncovered++;
    else if (f.row.description !== wantDesc) {
      diffs.push({ id, field: "description", planned: `sha=${sha256Hex(wantDesc)}`, fresh: `sha=${sha256Hex(f.row.description)}` });
    }
  }
  return { diffs, descUncovered };
}

export type FtFreshResult = {
  rows: number;
  applied: number;
  candidates: number;
  stops: number;
  missing: number[];
  descStatements: number;
  senderCalls: number;
};

export async function compareFtFresh(
  batched: Map<number, { newFull: string; old: string }>,
  freshDescById: Map<number, string>,
  freshUpdatedAtById: Map<number, number>,
  sender: AtomicBatchSender
): Promise<FtFreshResult> {
  let applied = 0;
  let candidates = 0;
  let stops = 0;
  const missing: number[] = [];
  const actual: D1BatchStatement[] = [];
  for (const [id, u] of batched) {
    const current = freshDescById.get(id);
    if (current === undefined) {
      missing.push(id);
      continue;
    }
    const cls = classifyDescriptionRepair({ current, oldDescription: u.old, newFull: u.newFull });
    if (cls === "ALREADY_APPLIED") {
      applied++;
      actual.push(
        ...buildDescriptionUpdateStatements(
          [{ id, oldDescription: current, updatedAt: freshUpdatedAtById.get(id)! }],
          u.newFull
        )
      );
    } else if (cls === "CANDIDATE") candidates++;
    else stops++;
  }
  let senderCalls = 0;
  const counting: AtomicBatchSender = async (statements) => {
    senderCalls++;
    return sender(statements);
  };
  if (actual.length > 0) await counting(actual);
  return { rows: batched.size, applied, candidates, stops, missing, descStatements: actual.length, senderCalls };
}

export type Normal45Fresh = {
  tasks: number;
  pendingTasks: number;
  pendingRows: number;
  sourceOnlyRows: number;
  skippedEquivalent: number;
  staleTaskIds: string[];
  unanswered: number;
};

export function compareNormal45Fresh(
  tasks: readonly SummaryTask[],
  resultsText: string,
  currentRows: readonly BenefitRow[]
): Normal45Fresh {
  const plan = planSummaryImport({ tasks, resultsText, currentRows });
  const resultById = new Map<string, { shortSummary: string; estimatedValue: number | null }>();
  for (const line of resultsText.split("\n")) {
    if (line.trim() === "") continue;
    const r = asRecord(JSON.parse(line), "results 行");
    resultById.set(r["taskId"] as string, {
      shortSummary: r["shortSummary"] as string,
      estimatedValue: (r["estimatedValue"] ?? null) as number | null,
    });
  }
  const taskById = new Map(tasks.map((t) => [t.taskId, t]));
  const rowByKey = new Map<string, BenefitRow[]>();
  for (const r of currentRows) {
    const k = `${r.stockCode}\n${r.description}`;
    const list = rowByKey.get(k);
    if (list) list.push(r);
    else rowByKey.set(k, [r]);
  }
  let pendingRows = 0;
  let sourceOnlyRows = 0;
  for (const u of plan.updates) {
    const t = taskById.get(u.taskId)!;
    const res = resultById.get(u.taskId)!;
    const plannedSource = res.estimatedValue !== null ? "company" : null;
    for (const r of rowByKey.get(`${t.stockCode}\n${t.description}`) ?? []) {
      pendingRows++;
      if (
        r.shortSummary === res.shortSummary &&
        r.estimatedValue === res.estimatedValue &&
        r.estimateValueSource !== plannedSource
      ) {
        sourceOnlyRows++;
      }
    }
  }
  const staleTaskIds: string[] = [];
  for (const r of plan.rejections) {
    if (r.reason === "stale" && r.taskId) staleTaskIds.push(r.taskId);
  }
  return {
    tasks: tasks.length,
    pendingTasks: plan.updates.length,
    pendingRows,
    sourceOnlyRows,
    skippedEquivalent: plan.skippedEquivalent,
    staleTaskIds,
    unanswered: plan.unansweredTaskIds.length,
  };
}

function writePrivateFile(dir: string, name: string, data: string | Buffer): void {
  writeFileSync(join(dir, name), data, { mode: 0o600 });
  chmodSync(join(dir, name), 0o600);
}

function selfSha(): string {
  const self = decodeURIComponent(new URL(import.meta.url).pathname);
  return sha256Hex(readFileSync(self));
}

function printPlan(scope: FreshScope, args: ProbeArgs): void {
  console.info(
    [
      `PLAN verdict=READY_FOR_GRANT (live NOT executed)`,
      `scope union=${scope.union.length} chunks=${scope.chunks[0].length}+${scope.chunks[1].length} ` +
        `A=${scope.abcIds.length} F=${scope.ftIds.length} N=${scope.normalIds.length} ` +
        `outside6=${scope.outside6.length} benefitMap=${scope.benefitMap.size}`,
      `scopeSha=${scope.scopeSha}`,
      `calls=${CALL_PLAN.map((c) => `${c.kind}:${c.table}`).join(",")} x2chunks (POST /query, SELECT only)`,
      `caps benefits<=${BENEFITS_CAP} parent/fin/score<=${UNION_SIZE} each`,
      `files=${[...RAW_NAMES, SNAPSHOT_NAME, METADATA_NAME].join(",")} under ${args.outDir} (0700/0600, write-once)`,
      `gates: --execute-live + root grant required; writes 0; seq reads are NOT a global transaction`,
    ].join("\n")
  );
}

async function runLive(args: ProbeArgs, scope: FreshScope): Promise<void> {
  // live のみ typed env を読む (plan は env に触らない)。
  const expectedUrl =
    `https://api.cloudflare.com/client/v4/accounts/${sharedEnv.CLOUDFLARE_ACCOUNT_ID()}` +
    `/d1/database/${sharedEnv.D1_DATABASE_ID()}/query`;
  const urlSha = sha256Hex(expectedUrl);
  if (existsSync(args.outDir) && readdirSync(args.outDir).length > 0) {
    fail(`出力先 ${args.outDir} が非空 (immutable。追記・上書きしない)`);
  }
  mkdirSync(args.outDir, { recursive: true, mode: 0o700 });
  chmodSync(args.outDir, 0o700);
  const calls: CapturedCall[] = [];
  const at = new Date().toISOString();
  const writeMeta = (meta: Record<string, unknown>): void => {
    writePrivateFile(args.outDir, METADATA_NAME, JSON.stringify(meta, null, 2));
  };
  const baseMeta = {
    at,
    probe: { file: "services/otakara-yutai/data-scripts/probe-yutai-fresh-audit.ts", sha: selfSha() },
    scope: {
      sha: scope.scopeSha,
      counts: {
        abc: scope.abcIds.length,
        ft: scope.ftIds.length,
        normal: scope.normalIds.length,
        union: scope.union.length,
        outside6: scope.outside6,
        benefitMap: scope.benefitMap.size,
      },
      chunks: [scope.chunks[0].length, scope.chunks[1].length],
    },
    urlSha,
    notes: [
      "8 sequential reads, NOT a global transaction (future apply needs FULL CAS, separate gate)",
      "writer/sender: throw-if-called only; batch sender never constructed",
      "Source GET 0 / Notion archive 0 (separate WRITE gate) / D1 R2 writes 0 / dispatch 0",
      "9 stale task IDs must NOT be repaired by rewriting task IDs (source re-certification required)",
    ],
  };
  // 取得 (raw は 1 件ずつ即時保存し、途中失敗でも残す)。
  let inputs: YieldInputs;
  try {
    const cap = await captureFreshReads(scope, expectedUrl);
    inputs = cap.inputs;
    for (const [i, b] of cap.rawBytes.entries()) {
      writePrivateFile(args.outDir, RAW_NAMES[i], b);
    }
    calls.push(...cap.calls);
  } catch (e) {
    writeMeta({ ...baseMeta, calls, verdict: { overall: "CAPTURE_STOP", error: String(e) } });
    throw e;
  }
  // caps。
  const benefitsTotal = calls.filter((c) => c.kind === "benefits").reduce((s, c) => s + c.rowCount, 0);
  for (const kind of ["parent", "fin", "score"] as const) {
    const total = calls.filter((c) => c.kind === kind).reduce((s, c) => s + c.rowCount, 0);
    if (total > UNION_SIZE) {
      writeMeta({ ...baseMeta, calls, verdict: { overall: "CAP_STOP", error: `${kind} rows=${total} (cap ${UNION_SIZE})` } });
      fail(`${kind} rows=${total} が cap ${UNION_SIZE} 超え (追加 query なしで STOP)`);
    }
  }
  if (benefitsTotal > BENEFITS_CAP) {
    writeMeta({ ...baseMeta, calls, verdict: { overall: "CAP_STOP", error: `benefits=${benefitsTotal} (cap ${BENEFITS_CAP})` } });
    fail(`benefits=${benefitsTotal} が cap ${BENEFITS_CAP} 超え (追加 query なしで STOP)`);
  }
  // 親の完全比較。
  const parentProblems = checkFreshParents(scope, inputs);
  if (parentProblems.length > 0) {
    writeMeta({ ...baseMeta, calls, verdict: { overall: "PARENT_STOP", parentProblems } });
    fail(`親に ${parentProblems.length} 件の問題 (全件保存。truncate なし)`);
  }
  const fresh = snapshotStockPreimages(inputs, scope.union);
  // 比較 ABC。
  const abcText = readPinned(args.dir, "yutai-abc-manifest.json");
  const abc = parseAbcManifest(abcText);
  const { plannedById, plannedIds } = proveTargetCoverage(abc.filed, abc.preimages);
  const rowFull = parseRowManifestFull(readPinned(args.dir, "yutai-row-manifest.json"));
  const batched = parseFtBatched(readPinned(args.dir, "yutai-fulltext-manifest.postabc.json"));
  const descExpected = new Map<number, string>();
  for (const [id, r] of rowFull) descExpected.set(id, batched.get(id)?.newFull ?? r.oldDescription);
  const abcCmp = compareAbcFresh(plannedById, plannedIds, fresh, descExpected, scope.benefitMap);
  // 利回り再計算 (fresh 入力)。
  const overlay = new Map<number, number | null>();
  for (const [id, t] of plannedById) overlay.set(id, t.estimatedValue);
  const yieldPlan = computeYieldEntries(scope.union, inputs, overlay);
  const yieldDiffs = yieldPlan.entries.filter((e) => e.changed || e.scoreChanged).map((e) => e.stockId);
  // 実 planner→実 apply (差が無ければ 0 送信)。
  const updates: PlannedUpdate[] = abc.filed.map((f) => producePlannedUpdate(f));
  const stockOfBenefit = new Map<number, number>();
  for (const [sid, pre] of fresh) {
    for (const b of pre.benefits) stockOfBenefit.set(b.id, sid);
  }
  const batches = planAtomicBatches({
    updates,
    yieldPlan,
    stockOfBenefit: (id) => stockOfBenefit.get(id),
    preimages: fresh,
  });
  let senderCalls = 0;
  const counting: AtomicBatchSender = async (statements) => {
    senderCalls++;
    return throwingSender(statements);
  };
  let applied = { stocks: 0, statements: 0 };
  let applyError: string | null = null;
  try {
    applied = await applyAtomicBatches(counting, batches);
  } catch (e) {
    applyError = String(e);
  }
  // 比較 FT。
  const freshDescById = new Map<number, string>();
  const freshUpdatedAtById = new Map<number, number>();
  for (const [, pre] of fresh) {
    for (const b of pre.benefits) {
      freshDescById.set(b.id, b.description);
      freshUpdatedAtById.set(b.id, b.updatedAt);
    }
  }
  const ftCmp = await compareFtFresh(batched, freshDescById, freshUpdatedAtById, throwingSender).catch((e) => {
    // throwingSender が投げた = 実 builder が文を出した (0-writes 構造どおり)。
    return { rows: batched.size, applied: -1, candidates: -1, stops: -1, missing: [] as number[], descStatements: -1, senderCalls: 1, error: String(e) } as const;
  });
  // 比較 normal45 (fresh 現行行 + 実 planner。37/50 は cross-check のみ)。
  const tasks = parseTaskFile(readFileSync(join(args.c45dir, "tasks-c45.jsonl"), "utf-8"));
  const resultsText = readFileSync(join(args.c45dir, "results-c45.jsonl"), "utf-8");
  const nameByCode = new Map<string, string>();
  const currentRows: BenefitRow[] = [];
  for (const sid of scope.normalIds) {
    const code = scope.perStock.get(sid)!.code;
    let name = nameByCode.get(code);
    if (name === undefined) {
      const uj = asRecord(
        JSON.parse(readFileSync(join(args.upstream, `${code}.json`), "utf-8")),
        `upstream ${code}.json`
      );
      if (typeof uj["name"] !== "string") fail(`upstream ${code}.json に name が無い`);
      name = uj["name"] as string;
      nameByCode.set(code, name);
    }
    for (const b of fresh.get(sid)?.benefits ?? []) {
      currentRows.push({
        id: b.id,
        stockId: sid,
        stockCode: code,
        stockName: name!,
        description: b.description,
        shortSummary: b.shortSummary,
        estimatedValue: b.estimatedValue,
        estimateValueSource: b.estimateValueSource,
        minShares: b.minShares,
        recordMonth: b.recordMonth,
        updatedAt: b.updatedAt,
      });
    }
  }
  const normalCmp = compareNormal45Fresh(tasks, resultsText, currentRows);
  // N6 outside の exact proof。
  const n6proof = scope.outside6.map((sid) => ({
    stockId: sid,
    code: scope.perStock.get(sid)!.code,
    parent: inputs.parents.get(sid),
    predicatePass: "activeEquityCondition (active+equity by construction; instrument_type value unread)",
    benefitIds: (fresh.get(sid)?.benefits ?? []).map((b) => b.id).sort((a, b) => a - b),
  }));
  const overall =
    abcCmp.diffs.length === 0 &&
    yieldDiffs.length === 0 &&
    applied.stocks === 0 &&
    applied.statements === 0 &&
    senderCalls === 0 &&
    applyError === null &&
    !("error" in ftCmp) &&
    ftCmp.candidates === 0 &&
    ftCmp.stops === 0 &&
    ftCmp.missing.length === 0 &&
    ftCmp.descStatements === 0
      ? "FRESH_MATCH"
      : "DIVERGED";
  const snapshot = {
    at,
    scopeSha: scope.scopeSha,
    calls,
    parents: [...inputs.parents.entries()].sort((a, b) => a[0] - b[0]),
    prices: [...inputs.prices.entries()].sort((a, b) => a[0] - b[0]),
    scores: [...inputs.scores.entries()].sort((a, b) => a[0] - b[0]),
    benefits: [...inputs.benefits.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([sid, list]) => [sid, [...list].sort((a, b) => a.rowId - b.rowId)]),
    preimages: [...fresh.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([sid, pre]) => [sid, pre]),
  };
  writePrivateFile(args.outDir, SNAPSHOT_NAME, JSON.stringify(snapshot));
  writeMeta({
    ...baseMeta,
    calls: calls.map((c) => ({
      index: c.index,
      kind: c.kind,
      chunk: c.chunk,
      sqlSha: c.sqlSha,
      paramCount: c.paramCount,
      paramSha: c.paramSha,
      status: c.status,
      bytesLength: c.bytesLength,
      bytesSha: c.bytesSha,
      rowCount: c.rowCount,
    })),
    caps: { benefitsTotal, benefitsCap: BENEFITS_CAP, parentFinScoreCap: UNION_SIZE },
    compare: {
      abc: { planned: plannedIds.length, diffs: abcCmp.diffs, descUncovered: abcCmp.descUncovered },
      yield: { changedStocks: yieldDiffs },
      apply: { batches: batches.length, applied, senderCalls, applyError },
      ft: ftCmp,
      normal45: {
        ...normalCmp,
        staleTasks: normalCmp.staleTaskIds.length,
        crossCheck: "offline 28pending/38src + 9stale/12 = 37/50 (reference only, unmeasured live)",
      },
      n6outside: n6proof,
    },
    verdict: { overall },
  });
  console.info(
    `DONE verdict=${overall} ` +
      `scope=${scope.scopeSha.slice(0, 12)} calls=8 benefits=${benefitsTotal} ` +
      `abcDiffs=${abcCmp.diffs.length} yieldDiffs=${yieldDiffs.length} apply=${applied.stocks}/${applied.statements}/${senderCalls} ` +
      `normal=pending${normalCmp.pendingTasks}/${normalCmp.pendingRows}rows stale${normalCmp.staleTaskIds.length}`
  );
  if (overall !== "FRESH_MATCH") process.exit(1);
}

async function main(): Promise<void> {
  const args = parseProbeArgs(process.argv.slice(2));
  const physicalText = readFileSync(args.physical, "utf-8");
  if (sha256Hex(physicalText) !== PINS["manifest-34.json"]) {
    fail("SHA pin 不一致: manifest-34.json");
  }
  const scope = deriveScope(
    readPinned(args.dir, "yutai-abc-manifest.json"),
    readPinned(args.dir, "yutai-fulltext-manifest.postabc.json"),
    readPinned(args.dir, "yutai-row-manifest.json"),
    physicalText
  );
  if (!args.executeLive) {
    printPlan(scope, args);
    return;
  }
  await runLive(args, scope);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("[fresh-probe] エラー:", e);
    process.exit(1);
  });
}
