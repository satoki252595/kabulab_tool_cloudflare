/**
 * Yutai fresh audit probe (manual diagnostic CLI)。既定は prepare-only。
 *
 * 目的: 本番 D1 の現値を保存済み preimage/証跡と突き合わせる fresh 監査。
 * 既存の読取 chain (`openOtakaraD1` → `fetchYieldInputs` → `snapshotStockPreimages`)
 * をそのまま使い、新 SQL・新 API adapter は作らない。`loadBenefitRows`
 * (unbounded) は使わない。比較は既存 verify CLI の parser/producer/planner
 * を再利用し、判定の複写はしない (小 read capture + 既存 compare 再利用)。
 *
 * 送信なしの構造:
 * - 既定は plan 表示のみ (HTTP 0・env 0・file 0)。live 取得は --execute-live
 *   を付けた時だけ走り、root の grant (probe SHA + scope SHA + 件数 +
 *   private filenames + semantics + completeness の review) が前提。
 * - 8 POST は全て単発 {sql, params} の SELECT のみ。送信前に URL 完全一致・
 *   envelope 検査・SELECT 単文検査・既存実 builder の .toSQL() との完全一致
 *   (SQL・params・件数) をする。batch 送信口は作らない。
 *   writer/sender は throw-if-called のみ。redirect は manual (follow 0)。
 * - 8 連読は global transaction ではない (将来の apply は FULL CAS が別 gate)。
 * - 応答は capture 直後に immutable 保存し、shape/results/行型/必須列を
 *   厳密検証する。共有 client の missing-result→[] があっても監査は
 *   0 同値を主張しない。
 *
 * 使い方:
 *   plan (offline): node --import tsx services/otakara-yutai/data-scripts/probe-yutai-fresh-audit.ts
 *   live (grant 後のみ): 同 + --execute-live
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { and, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";
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
} from "./summary-tasks.js";
import {
  PINS,
  parseAbcManifest,
  parseFtBatchedUpdates,
  parseManifest34Results,
  parseRowManifest,
  producePlannedUpdate,
  proveNormal45,
  proveTargetCoverage,
  throwingSender,
  type FtBatchedUpdate,
  type NamedRow,
} from "./verify-repair-reentry.js";
import { sharedEnv } from "../../../src/shared/env.js";
import type { D1BatchStatement } from "../../../src/shared/db/d1-http-client.js";
import { activeEquityCondition } from "../../../src/shared/db/active-equity.js";
import { stocks as coreStocks } from "../../../src/shared/db/core-schema.js";
import { stockFinancials, stockScores, yutaiBenefits } from "../src/db/schema.js";

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

/** 出力の固定名 (01-08 raw + snapshot + metadata + partial ledger)。 */
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
export const LEDGER_NAME = "partial-ledger.jsonl";

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
 * 物理列名は schema 定義どおり (ma_25 / rsi_14 に注意)。
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
    "ma_25",
    "rsi_14",
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

/**
 * 監査 scope の再導出 (offline)。ABC 131 + FT 13 + normal 34 → union 144、
 * A∩FT=6、normal-outside=6 を実値で検証する。違えば STOP (強制しない)。
 * parser は既存 verify CLI の共有品を使う (複写しない)。
 */
export function deriveScope(abcText: string, ftText: string, rowText: string, m34Text: string): FreshScope {
  const abc = parseAbcManifest(abcText);
  const abcIds = [...abc.preimages.keys()].sort((a, b) => a - b);
  if (abcIds.length !== 131) fail(`ABC stocks=${abcIds.length} (want 131)`);
  const rowById = parseRowManifest(rowText);
  const id2stock = new Map([...rowById.values()].map((r) => [r.id, r.stockId]));
  const code2stock = new Map<string, number>();
  for (const r of rowById.values()) {
    const prev = code2stock.get(r.stockCode);
    if (prev !== undefined && prev !== r.stockId) fail(`code=${r.stockCode} が複数 stockId に出現`);
    code2stock.set(r.stockCode, r.stockId);
  }
  const batched = parseFtBatchedUpdates(ftText);
  const ftIds = [...new Set([...batched.keys()].map((id) => {
    const s = id2stock.get(id);
    if (s === undefined) fail(`全文 ID ${id} が row-manifest に無い`);
    return s!;
  }))].sort((a, b) => a - b);
  if (ftIds.length !== 13) fail(`FT stocks=${ftIds.length} (want 13)`);
  const normalIds = parseManifest34Results(m34Text).map((e) => {
    const s = code2stock.get(e.code);
    if (s === undefined) fail(`manifest-34 code=${e.code} が row-manifest に無い`);
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
  for (const r of rowById.values()) {
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

export type ExpectedCall = { kind: CallKind; chunk: number; sql: string; params: unknown[] };

/**
 * 既存実 builder と同一の select 式 (同一 schema・同一述語) から .toSQL() で
 * 期待の 8 文を生成する。同一 drizzle builder のため env も network も要らない。
 * 送信文言との完全一致で照合する (式の乖離は runtime で STOP する)。
 * 注意: parent は chunkIDs + active 真偽 + equity リテラルで chunk+2 params
 * (80 chunk なら 82。80 total と思わないこと)。
 */
export function buildExpectedCalls(chunks: [number[], number[]]): ExpectedCall[] {
  const db = drizzle(async () => {
    fail("toSQL 生成中に query が実行された (ありえない)");
  });
  const out: ExpectedCall[] = [];
  chunks.forEach((chunk, ci) => {
    const parent = db
      .select({ stockId: coreStocks.id, code: coreStocks.code, isActive: coreStocks.isActive })
      .from(coreStocks)
      .where(and(inArray(coreStocks.id, chunk), activeEquityCondition()))
      .toSQL();
    out.push({ kind: "parent", chunk: ci, sql: parent.sql, params: [...parent.params] });
    const fin = db
      .select({
        stockId: stockFinancials.stockId,
        price: stockFinancials.price,
        per: stockFinancials.per,
        pbr: stockFinancials.pbr,
        dividendYield: stockFinancials.dividendYield,
        roe: stockFinancials.roe,
        ma25: stockFinancials.ma25,
        rsi14: stockFinancials.rsi14,
        macd: stockFinancials.macd,
        macdSignal: stockFinancials.macdSignal,
        yutaiYield: stockFinancials.yutaiYield,
        dataDate: stockFinancials.dataDate,
        fetchedAt: stockFinancials.fetchedAt,
      })
      .from(stockFinancials)
      .where(inArray(stockFinancials.stockId, chunk))
      .toSQL();
    out.push({ kind: "fin", chunk: ci, sql: fin.sql, params: [...fin.params] });
    const score = db
      .select({
        stockId: stockScores.stockId,
        fundamentalScore: stockScores.fundamentalScore,
        technicalScore: stockScores.technicalScore,
        totalScore: stockScores.totalScore,
      })
      .from(stockScores)
      .where(inArray(stockScores.stockId, chunk))
      .toSQL();
    out.push({ kind: "score", chunk: ci, sql: score.sql, params: [...score.params] });
    const ben = db
      .select({
        rowId: yutaiBenefits.id,
        stockId: yutaiBenefits.stockId,
        minShares: yutaiBenefits.minShares,
        recordMonth: yutaiBenefits.recordMonth,
        description: yutaiBenefits.description,
        shortSummary: yutaiBenefits.shortSummary,
        estimatedValue: yutaiBenefits.estimatedValue,
        estimateValueSource: yutaiBenefits.estimateValueSource,
        updatedAt: yutaiBenefits.updatedAt,
      })
      .from(yutaiBenefits)
      .where(inArray(yutaiBenefits.stockId, chunk))
      .toSQL();
    out.push({ kind: "benefits", chunk: ci, sql: ben.sql, params: [...ben.params] });
  });
  return out;
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
    ma_25: "number|null",
    rsi_14: "number|null",
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

export type CaptureSink = {
  /** capture 直後・validate 前に呼ばれる (raw の即時保存用)。 */
  onRaw(index: number, bytes: Buffer): void;
  /** validate の成否 (失敗も残す)。 */
  onValidated(index: number, rowCount: number, error: string | null): void;
};

/** partial ledger への追記 (0600。失敗時も残る)。 */
export function appendLedgerLine(dir: string, entry: Record<string, unknown>): void {
  appendFileSync(join(dir, LEDGER_NAME), JSON.stringify(entry) + "\n", { mode: 0o600 });
  chmodSync(join(dir, LEDGER_NAME), 0o600);
}

/**
 * 8 連読の取得器。global fetch を検査・記録ラッパで包む。
 * - 送信前: URL・envelope・SELECT・期待 SQL/params 完全一致を検査する。
 * - 送信は redirect manual (follow による extra HTTP を構造的に封じる)。
 * - capture 直後に sink へ raw を渡し (validate 前の immutable 保存)、
 *   validate 成否も sink へ残す。途中失敗でも取得済み bytes は失わない。
 */
export async function captureFreshReads(
  scope: FreshScope,
  expectedUrl: string,
  sink?: CaptureSink
): Promise<{ inputs: YieldInputs; calls: CapturedCall[]; rawBytes: Buffer[] }> {
  const db = openOtakaraD1();
  const expected = buildExpectedCalls(scope.chunks);
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
    if (n > 8) fail(`9 件目の HTTP 呼び出し (extra HTTP 禁止)。送らず打ち切る`);
    const { sql, params } = inspectSelectCall(input as string, initRec["body"] as string, expectedUrl);
    const want = CALL_PLAN[(n - 1) % 4];
    const kind = matchCallKind(sql);
    if (kind !== want.kind) fail(`${n} 件目の種別が ${kind} (want ${want.kind})`);
    const exp = expected[n - 1];
    if (sql !== exp.sql || JSON.stringify(params) !== JSON.stringify(exp.params)) {
      fail(
        `${n} 件目の送信が期待文と不一致 ` +
          `(sql actual=${sha256Hex(sql).slice(0, 12)} want=${sha256Hex(exp.sql).slice(0, 12)}, ` +
          `params ${params.length}/${(exp.params as unknown[]).length})`
      );
    }
    const chunkNo = n <= 4 ? 0 : 1;
    const res = await realFetch(input as string, { ...(init as RequestInit), redirect: "manual" });
    if (res.redirected) fail(`${n} 件目で redirect を検出 (redirect 禁止)`);
    if (res.status >= 300 && res.status < 400) fail(`${n} 件目が redirect 応答 ${res.status} (follow せず STOP)`);
    const bytes = Buffer.from(await res.clone().arrayBuffer());
    sink?.onRaw(n, bytes);
    let validated: ValidatedRows;
    try {
      validated = validateRawResponse(kind, bytes, scope.chunks[chunkNo]);
    } catch (e) {
      sink?.onValidated(n, -1, String(e));
      throw e;
    }
    sink?.onValidated(n, validated.rows.length, null);
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

export type ExpectedBenefitRow = {
  id: number;
  stockId: number;
  minShares: number;
  recordMonth: number;
  description: string;
  shortSummary: string | null;
  estimatedValue: number | null;
  estimateValueSource: string | null;
  updatedAtPre: number;
  repaired: boolean;
};

export type PlannedTriple = {
  shortSummary: string;
  estimatedValue: number | null;
  estimateValueSource: string | null;
};

/**
 * 保存全行の期待 post を組む (ABC 3 値 + FT 掲載文 + 不変行の pre 値)。
 * 473 planned だけでなく benefitMap 全行 (1668) が対象。源が無い行は STOP。
 */
export function buildExpectedPost(
  benefitMap: Map<number, { stockId: number; code: string }>,
  preimages: Map<number, StockPreimage>,
  rowById: Map<number, NamedRow>,
  plannedById: Map<number, PlannedTriple>,
  batched: Map<number, FtBatchedUpdate>
): Map<number, ExpectedBenefitRow> {
  const preById = new Map<number, StockPreimage["benefits"][number]>();
  for (const pre of preimages.values()) {
    for (const b of pre.benefits) preById.set(b.id, b);
  }
  const out = new Map<number, ExpectedBenefitRow>();
  for (const [bid, m] of benefitMap) {
    const pre = preById.get(bid);
    const nm = rowById.get(bid);
    const planned = plannedById.get(bid);
    const triple = planned ?? pre ?? nm;
    if (!triple) fail(`benefit ${bid} の期待 3 値の源が無い`);
    const desc = batched.get(bid)?.newFull ?? nm?.oldDescription ?? pre?.description;
    if (desc === undefined) fail(`benefit ${bid} の期待掲載文の源が無い`);
    const minShares = pre?.minShares ?? nm?.minShares;
    const recordMonth = pre?.recordMonth ?? nm?.recordMonth;
    const updatedAtPre = pre?.updatedAt ?? nm?.updatedAt;
    if (minShares === undefined || recordMonth === undefined || updatedAtPre === undefined) {
      fail(`benefit ${bid} の期待行属性の源が無い`);
    }
    out.set(bid, {
      id: bid,
      stockId: m.stockId,
      minShares,
      recordMonth,
      description: desc,
      shortSummary: triple.shortSummary,
      estimatedValue: triple.estimatedValue,
      estimateValueSource: triple.estimateValueSource as string | null,
      updatedAtPre,
      repaired: planned !== undefined || batched.has(bid),
    });
  }
  return out;
}

export type ContentDiff = { id: number; field: string; expected: string; fresh: string };
export type DriftDiff = {
  scope: "fin" | "score" | "updatedAt" | "yield";
  stockId: number;
  id?: number;
  field: string;
  expected: string;
  fresh: string;
};

/**
 * 保存全行集合の比較 (NULL-safe ===、full membership 双方向、親帰属)。
 * content: 修復 scope の差 (1 件でも MATCH 不成立)。
 * drift: runtime 由来の差 (untouched 行の updatedAt 等。独立計数し、
 * full match への丸めは 0。修復行の receipt 違反は content 扱い)。
 */
export function compareBenefitFullSet(
  expected: Map<number, ExpectedBenefitRow>,
  fresh: Map<number, StockPreimage>
): { content: ContentDiff[]; drift: DriftDiff[] } {
  const freshById = new Map<number, { stockId: number; row: StockPreimage["benefits"][number] }>();
  for (const [sid, pre] of fresh) {
    for (const b of pre.benefits) freshById.set(b.id, { stockId: sid, row: b });
  }
  const content: ContentDiff[] = [];
  const drift: DriftDiff[] = [];
  const fmt = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
  for (const [bid, e] of expected) {
    const f = freshById.get(bid);
    if (!f) {
      content.push({ id: bid, field: "row", expected: "present", fresh: "MISSING" });
      continue;
    }
    if (f.stockId !== e.stockId) {
      content.push({ id: bid, field: "parent", expected: `stockId=${e.stockId}`, fresh: `stockId=${f.stockId}` });
    }
    if (f.row.minShares !== e.minShares) {
      content.push({ id: bid, field: "minShares", expected: fmt(e.minShares), fresh: fmt(f.row.minShares) });
    }
    if (f.row.recordMonth !== e.recordMonth) {
      content.push({ id: bid, field: "recordMonth", expected: fmt(e.recordMonth), fresh: fmt(f.row.recordMonth) });
    }
    if (f.row.description !== e.description) {
      content.push({ id: bid, field: "description", expected: e.description, fresh: f.row.description });
    }
    if (f.row.shortSummary !== e.shortSummary) {
      content.push({ id: bid, field: "shortSummary", expected: fmt(e.shortSummary), fresh: fmt(f.row.shortSummary) });
    }
    if (f.row.estimatedValue !== e.estimatedValue) {
      content.push({
        id: bid,
        field: "estimatedValue",
        expected: fmt(e.estimatedValue),
        fresh: fmt(f.row.estimatedValue),
      });
    }
    if (f.row.estimateValueSource !== e.estimateValueSource) {
      content.push({
        id: bid,
        field: "estimateValueSource",
        expected: fmt(e.estimateValueSource),
        fresh: fmt(f.row.estimateValueSource),
      });
    }
    if (e.repaired) {
      // 修復行は書込 receipt として updated_at が進んでいること (内容一致が前提)。
      if (!(f.row.updatedAt > e.updatedAtPre)) {
        content.push({
          id: bid,
          field: "updatedAt-receipt",
          expected: `>${e.updatedAtPre}`,
          fresh: `${f.row.updatedAt}`,
        });
      }
    } else if (f.row.updatedAt !== e.updatedAtPre) {
      drift.push({
        scope: "updatedAt",
        stockId: f.stockId,
        id: bid,
        field: "updatedAt",
        expected: `${e.updatedAtPre}`,
        fresh: `${f.row.updatedAt}`,
      });
    }
  }
  for (const [bid, f] of freshById) {
    if (!expected.has(bid)) {
      content.push({ id: bid, field: "row", expected: "absent", fresh: `ADDED stockId=${f.stockId}` });
    }
  }
  return { content, drift };
}

/**
 * 保護 fin/score の full property 比較。差は全て runtime drift として
 * 独立計数する (正当な夜間更新もありうる。正直報告し、0 に丸めない)。
 * preimage を持つ ABC 131 銘柄のみ期待がある。他は uncovered として数える。
 */
export function compareProtectedFinScores(
  preimages: Map<number, StockPreimage>,
  fresh: Map<number, StockPreimage>
): { drift: DriftDiff[]; uncovered: number } {
  const drift: DriftDiff[] = [];
  let uncovered = 0;
  const fmt = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
  for (const [sid, pre] of preimages) {
    const f = fresh.get(sid);
    if (!f) {
      drift.push({ scope: "fin", stockId: sid, field: "preimage", expected: "present", fresh: "MISSING" });
      continue;
    }
    const finKeys = [
      "yutaiYield",
      "dataDate",
      "price",
      "per",
      "pbr",
      "dividendYield",
      "roe",
      "ma25",
      "rsi14",
      "macd",
      "macdSignal",
      "fetchedAt",
    ] as const;
    if (pre.financial === null && f.financial !== null) {
      drift.push({ scope: "fin", stockId: sid, field: "row", expected: "null", fresh: "ADDED" });
    } else if (pre.financial !== null && f.financial === null) {
      drift.push({ scope: "fin", stockId: sid, field: "row", expected: "present", fresh: "MISSING" });
    } else if (pre.financial && f.financial) {
      for (const k of finKeys) {
        if (pre.financial[k] !== f.financial[k]) {
          drift.push({ scope: "fin", stockId: sid, field: k, expected: fmt(pre.financial[k]), fresh: fmt(f.financial[k]) });
        }
      }
    }
    const scoreKeys = ["fundamentalScore", "technicalScore", "totalScore"] as const;
    if (pre.scores === null && f.scores !== null) {
      drift.push({ scope: "score", stockId: sid, field: "row", expected: "null", fresh: "ADDED" });
    } else if (pre.scores !== null && f.scores === null) {
      drift.push({ scope: "score", stockId: sid, field: "row", expected: "present", fresh: "MISSING" });
    } else if (pre.scores && f.scores) {
      for (const k of scoreKeys) {
        if (pre.scores[k] !== f.scores[k]) {
          drift.push({ scope: "score", stockId: sid, field: k, expected: fmt(pre.scores[k]), fresh: fmt(f.scores[k]) });
        }
      }
    }
  }
  for (const sid of fresh.keys()) {
    if (!preimages.has(sid)) uncovered++;
  }
  return { drift, uncovered };
}

export type FtFreshResult = {
  rows: number;
  applied: number;
  candidates: number;
  stops: number;
  missing: number[];
  parentMismatches: { id: number; expected: string; fresh: string }[];
  descStatements: number;
  senderCalls: number;
};

/**
 * FT 62 の fresh 比較。分類に加え、全 62 行の親 (stockId/code/benefit-table
 * identity) を証明する。scope 内の別親＋同文のすり抜けは許さない。
 */
export async function compareFtFresh(
  batched: Map<number, FtBatchedUpdate>,
  freshById: Map<number, { description: string; updatedAt: number; stockId: number }>,
  expectedParent: Map<number, { stockId: number; code: string }>,
  freshCodeByStock: Map<number, string>,
  sender: AtomicBatchSender
): Promise<FtFreshResult> {
  let applied = 0;
  let candidates = 0;
  let stops = 0;
  const missing: number[] = [];
  const parentMismatches: FtFreshResult["parentMismatches"] = [];
  const actual: D1BatchStatement[] = [];
  for (const [id, u] of batched) {
    const f = freshById.get(id);
    if (f === undefined) {
      missing.push(id);
      continue;
    }
    const want = expectedParent.get(id)!;
    const freshCode = freshCodeByStock.get(f.stockId);
    if (f.stockId !== want.stockId || freshCode !== want.code) {
      parentMismatches.push({
        id,
        expected: `stockId=${want.stockId} code=${want.code}`,
        fresh: `stockId=${f.stockId} code=${freshCode ?? "MISSING"}`,
      });
    }
    const cls = classifyDescriptionRepair({ current: f.description, oldDescription: u.old, newFull: u.newFull });
    if (cls === "ALREADY_APPLIED") {
      applied++;
      actual.push(
        ...buildDescriptionUpdateStatements(
          [{ id, oldDescription: f.description, updatedAt: f.updatedAt }],
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
  return { rows: batched.size, applied, candidates, stops, missing, parentMismatches, descStatements: actual.length, senderCalls };
}

/**
 * fresh 現行行から preFT 行を再構成する (FT 62 行の掲載文を pinned mapping で
 * 旧文へ戻す)。fresh 掲載文が新全文と違えば再構成不能として STOP する
 * (drift 調査が必要。黙って旧文を置かない)。
 */
export function reconstructPreFtRows(
  freshRows: readonly BenefitRow[],
  batched: Map<number, FtBatchedUpdate>
): BenefitRow[] {
  return freshRows.map((r) => {
    const u = batched.get(r.id);
    if (!u) return r;
    if (r.description !== u.newFull) {
      fail(`行 ${r.id} の fresh 掲載文が新全文と不一致 (preFT 再構成不能)`);
    }
    return { ...r, description: u.old };
  });
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
  const expected = buildExpectedCalls(scope.chunks);
  console.info(
    [
      `PLAN verdict=READY_FOR_GRANT (live NOT executed)`,
      `scope union=${scope.union.length} chunks=${scope.chunks[0].length}+${scope.chunks[1].length} ` +
        `A=${scope.abcIds.length} F=${scope.ftIds.length} N=${scope.normalIds.length} ` +
        `outside6=${scope.outside6.length} benefitMap=${scope.benefitMap.size}`,
      `scopeSha=${scope.scopeSha}`,
      `calls=${CALL_PLAN.map((c) => `${c.kind}:${c.table}`).join(",")} x2chunks (POST /query, SELECT only)`,
      `sqlSha=${expected.map((e) => sha256Hex(e.sql).slice(0, 8)).join(",")}`,
      `params=${expected.map((e) => (e.params as unknown[]).length).join(",")}`,
      `caps benefits<=${BENEFITS_CAP} parent/fin/score<=${UNION_SIZE} each`,
      `files=${[...RAW_NAMES, SNAPSHOT_NAME, METADATA_NAME, LEDGER_NAME].join(",")} under ${args.outDir} (0700/0600, write-once)`,
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
  // 取得 (raw は capture 直後に immutable 保存し、validate 成否も ledger へ)。
  const sink: CaptureSink = {
    onRaw: (index, bytes) => {
      writePrivateFile(args.outDir, RAW_NAMES[index - 1], bytes);
      appendLedgerLine(args.outDir, {
        index,
        phase: "captured",
        bytesLength: bytes.length,
        bytesSha: sha256Hex(bytes),
        at: new Date().toISOString(),
      });
    },
    onValidated: (index, rowCount, error) => {
      appendLedgerLine(args.outDir, {
        index,
        phase: error ? "FAILED" : "validated",
        rowCount,
        error,
        at: new Date().toISOString(),
      });
    },
  };
  let inputs: YieldInputs;
  try {
    const cap = await captureFreshReads(scope, expectedUrl, sink);
    inputs = cap.inputs;
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
  // 期待 post の構築と比較 (保存全行集合)。
  const abcText = readPinned(args.dir, "yutai-abc-manifest.json");
  const abc = parseAbcManifest(abcText);
  const { plannedById, plannedIds } = proveTargetCoverage(abc.filed, abc.preimages);
  const rowById = parseRowManifest(readPinned(args.dir, "yutai-row-manifest.json"));
  const batched = parseFtBatchedUpdates(readPinned(args.dir, "yutai-fulltext-manifest.postabc.json"));
  const expectedPost = buildExpectedPost(scope.benefitMap, abc.preimages, rowById, plannedById, batched);
  const fullCmp = compareBenefitFullSet(expectedPost, fresh);
  const finCmp = compareProtectedFinScores(abc.preimages, fresh);
  const drift: DriftDiff[] = [...fullCmp.drift, ...finCmp.drift];
  // 利回り再計算 (fresh 入力)。変化は runtime drift として独立計数する。
  const overlay = new Map<number, number | null>();
  for (const [id, t] of plannedById) overlay.set(id, t.estimatedValue);
  const yieldPlan = computeYieldEntries(scope.union, inputs, overlay);
  for (const e of yieldPlan.entries) {
    const stored = inputs.prices.get(e.stockId)?.yutaiYield ?? null;
    if (e.changed) {
      drift.push({
        scope: "yield",
        stockId: e.stockId,
        field: "yutaiYield",
        expected: `stored=${JSON.stringify(stored)}`,
        fresh: `recomputed=${JSON.stringify(e.next)}`,
      });
    }
    if (e.scoreChanged) {
      drift.push({
        scope: "yield",
        stockId: e.stockId,
        field: "score",
        expected: "stored",
        fresh: `recomputed=${JSON.stringify(e.scoreNext)}`,
      });
    }
  }
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
  // 比較 FT (分類 + 全 62 行の親 identity)。
  const freshById = new Map<number, { description: string; updatedAt: number; stockId: number }>();
  const freshCodeByStock = new Map<number, string>();
  for (const [sid, pre] of fresh) {
    freshCodeByStock.set(sid, pre.parent.code);
    for (const b of pre.benefits) {
      freshById.set(b.id, { description: b.description, updatedAt: b.updatedAt, stockId: sid });
    }
  }
  let ftCmp: FtFreshResult & { error?: string };
  try {
    ftCmp = await compareFtFresh(batched, freshById, scope.benefitMap, freshCodeByStock, throwingSender);
  } catch (e) {
    // throwingSender が投げた = 実 builder が文を出した (0-writes 構造どおり)。
    ftCmp = {
      rows: batched.size,
      applied: -1,
      candidates: -1,
      stops: -1,
      missing: [],
      parentMismatches: [],
      descStatements: -1,
      senderCalls: 1,
      error: String(e),
    };
  }
  // 比較 normal45 (既存 proveNormal45 を fresh 現行行 + preFT 再構成で再利用)。
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
  let normalCmp: ReturnType<typeof proveNormal45> | null = null;
  let normalError: string | null = null;
  try {
    normalCmp = proveNormal45(tasks, resultsText, currentRows, reconstructPreFtRows(currentRows, batched));
  } catch (e) {
    normalError = String(e);
  }
  // 却下の全理由と taskId (既存 planner の再利用。複写しない)。
  const rawPlan = planSummaryImport({ tasks, resultsText, currentRows });
  const rejectionIds: Record<string, string[]> = {};
  for (const r of rawPlan.rejections) {
    const list = rejectionIds[r.reason] ?? [];
    if (r.taskId) list.push(r.taskId);
    rejectionIds[r.reason] = list;
  }
  const normalCrossCheckPass =
    normalError === null &&
    normalCmp !== null &&
    normalCmp.pendingTasks + normalCmp.stale === 37 &&
    normalCmp.sourceOnlyRows + normalCmp.staleSourceOnlyRows === 50;
  // N6 outside の exact proof。
  const n6proof = scope.outside6.map((sid) => ({
    stockId: sid,
    code: scope.perStock.get(sid)!.code,
    parent: inputs.parents.get(sid),
    predicatePass: "activeEquityCondition (active+equity by construction; instrument_type value unread)",
    benefitIds: (fresh.get(sid)?.benefits ?? []).map((b) => b.id).sort((a, b) => a - b),
  }));
  const ftClean =
    !("error" in ftCmp) &&
    ftCmp.candidates === 0 &&
    ftCmp.stops === 0 &&
    ftCmp.missing.length === 0 &&
    ftCmp.parentMismatches.length === 0 &&
    ftCmp.descStatements === 0 &&
    ftCmp.senderCalls === 0;
  const overall =
    fullCmp.content.length === 0 &&
    drift.length === 0 &&
    applied.stocks === 0 &&
    applied.statements === 0 &&
    senderCalls === 0 &&
    applyError === null &&
    ftClean &&
    normalCrossCheckPass
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
      fullSet: {
        expected: expectedPost.size,
        planned: plannedIds.length,
        content: fullCmp.content,
        drift,
        finScoreUncovered: finCmp.uncovered,
      },
      apply: { batches: batches.length, applied, senderCalls, applyError },
      ft: ftCmp,
      normal45: {
        result: normalCmp,
        error: normalError,
        rejectionIds,
        crossCheckPass: normalCrossCheckPass,
        crossCheckNote: "offline 28pending/38src + 9stale/12 = 37/50 (deterministic consequence of full content match)",
      },
      n6outside: n6proof,
    },
    verdict: { overall },
  });
  console.info(
    `DONE verdict=${overall} ` +
      `scope=${scope.scopeSha.slice(0, 12)} calls=8 benefits=${benefitsTotal} ` +
      `content=${fullCmp.content.length} drift=${drift.length} apply=${applied.stocks}/${applied.statements}/${senderCalls} ` +
      `normal=${normalCmp ? `pending${normalCmp.pendingTasks} stale${normalCmp.stale} xcheck${normalCrossCheckPass ? "pass" : "DIFF"}` : `ERROR`}`
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
