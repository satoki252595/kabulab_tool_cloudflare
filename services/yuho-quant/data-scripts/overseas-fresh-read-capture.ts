/**
 * 海外 fresh full READ capture (3675全通・READ-only)。
 *
 * Q1F (yuho_documents 全16列 + correlated facts COUNT = 17射影) と
 * Q2F (facts 全12 storage列 + docId echo = 13射影) を 37 chunks (≤100 IDs)
 * × 2 = 上限 74 SELECT で取得し、0600 に raw capture する。比較・CAS・L2・
 * 書込は含まない (READ-only)。post-facts の IDs は business key +
 * expected NEW 表で照合する (削除済み旧 fact IDs の存続は要求しない)。
 * doc 側は全16列の capture が preimage となる (将来 repair は
 * protected14 不変 + overseas 2列 (status/honbun) の正規変更を期待)。
 *
 * 実行条件 (fail-closed):
 * - `--grant=<Root承認文>` が無いと起動しない (fetch 0 のまま HOLD)。
 * - preflight (`--preflight`) は純粋検証のみ (送信 0・FS 書込 0)。
 * - 1 query 1 attempt・total max 74・retry 0。失敗/unknown は STOP し
 *   既保存 raw を残す (extra query 0)。
 *
 * 送信路 (既存再使用 + capture 層):
 * - `createBoundedFetch` (budget 74): D1 query endpoint・単発 SELECT・
 *   書込語なし・budget 超過の送信前拒否。
 * - capture 層: 実 forward 内容を pinned grant (D1 target SHA +
 *   attempt SQL SHA + params idsSHA) と照合してから attempt を
 *   durable log へ fsync し forward (redirect manual)。strict judge の
 *   前に whole HTTP body bytes を wx0600 保存 + safe receipt
 *   (bodySHA/path/rawBytes/sendAt/receivedAt) を log。request 側
 *   (Authorization/params 値) は log しない。
 * - stdout-safety: D1 IDs/values・provider body を含み得る detail は
 *   0600 の hold-details.log にだけ残し、stdout (counts/SHA 契約) には
 *   safe label のみ出す。
 *
 * 再使用 (新規 framework なし): select-proof の `createBoundedFetch` /
 * `assertPerDocCounts` / `assertProjection` / `validateQ2Row`、共有
 * `createD1HttpDb` (strict judge・outcome-unknown 再送なし)、正準
 * target `d1HttpQueryUrl`。
 *
 * 出力 (OUT_DIR のみ・0600。stdout は counts/SHA のみ):
 * - capture-union.json / capture-manifest.json (per-query 記録) /
 *   capture-live.json (q1f/q2f/missing raw) / capture-report.json /
 *   attempt.log (fsync) / attempt-*-body.bin (wx0600 whole body)
 *
 * 実行 (live は Root explicit grant 後のみ):
 *   pnpm exec tsx services/yuho-quant/data-scripts/overseas-fresh-read-capture.ts
 *     --grant="<Root承認文>" [--lane-dir /tmp] [--env-file /path/to/.env]
 *     [--out-dir /tmp/overseas-freshread-capture-20260930]
 * preflight (送信 0・書込 0):
 *   .../overseas-fresh-read-capture.ts --preflight [--lane-dir /tmp]
 */

// ---------------------------------------------------------------------------
// 0. native fetch 確保 (repo import より前に設置)
// ---------------------------------------------------------------------------
const nativeFetch = globalThis.fetch.bind(globalThis);

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { eq, inArray, sql } from "drizzle-orm";

// guard 設置後に repo runtime を dynamic import する (select-proof と同一順序)。
// (select-proof の import は同梱の budget-36 guard を global に置くが、本
// runner が budget-74 の capture guard で上書きするため無害。)
const selectProofMod = await import("./overseas-745-select-proof.js");
const { createBoundedFetch, assertPerDocCounts, assertProjection, validateQ2Row } = selectProofMod;
const d1Mod = await import("../../../src/shared/db/d1-http-client.js");
const { createD1HttpDb, d1HttpQueryUrl } = d1Mod;
const envMod = await import("../../../src/shared/env.js");
const { sharedEnv } = envMod;
const yuhoSchema = await import("../src/db/schema.js");
const { yuhoDocuments, overseasSalesFacts } = yuhoSchema;

// ---------------------------------------------------------------------------
// 固定 pins・scope (preflight + live 起動で全断言。送信前に固定)
// ---------------------------------------------------------------------------
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url);
const BUDGET = 74;
const CHUNK_SIZE = 100;

const PINS = {
  okdocs: "034cefad5a7986f874fdc453c0e6a28f23d1ffe565be1ada5a65020718298735",
  /** 正準 D1 target = typed D1_DATABASE_ID 値の SHA (Root 指定・実 env 照合済み)。 */
  d1Target: "a7bcf8e2f330e5c81f78e063131dc8837c90d7db9c07388ad7eeca4c8768ba0e",
  q1f100: "24d06c43837f1189b3ee8d33414717d9163f0327988922b2c6887967a92afa4f",
  q1f75: "66c5bb367ff3dcaceac0b42a9b3d3257400dea38fa07a2c17248a2c1120dd443",
  q2f100: "b411e068c8fea1dc6ed47bb00e472ed898bea0cce331bd682865f628f11e3672",
  q2f75: "0d18c03f406436b4c3b606fedbc311cf79fa0f967b4cf56fc98c9c6e7addb8d6",
  /** 74 concrete SQL (chunk 順・Q1F→Q2F) を \n 結合した SHA。 */
  combined74: "697456663d324ea27c436bf2b3b3d5b823bc68f8b4582e0e1e7f3229100fccc4",
  /** 37 per-chunk idsSHA を結合した SHA (params 固定)。 */
  params37: "df1d194b7b2b460d10097eacf41f4d4f65217aeda09f148595bd1ac12510452d",
  modules: {
    captureSelf: "a435b3b13b57576d9bd02531d69fb26b20c61dd718ef4a9f631040b2fa73cc3c",
    selectProof: "6c864f43b8141162783368c311c2abd8e673e34dd58c82469618173e7a96bf05",
    d1Client: "2d16180bdf864bcade9f8850b922f99b768be8de3bcbe427900fc9ec7afda1c1",
    yuhoSchema: "8adec13819c141b23044bce38ddfbbe9a933f5080972161993779ba62c473393",
    coreSchema: "3393ccc640bdef58f1abd895e36b853d5afc764f9a3e464aa61a915f318e714d",
    sharedEnv: "183af3b9847673b5ea3863f81b0866c7d078075193b702631bfd7941bb1e8d15",
    pnpmLock: "805dd5b36ca9ec385b29de1ded715305537eac514dbc7c77dfc55b2d56617e58",
  } as Record<string, string>,
};

const MODULE_FILES: Record<string, string> = {
  captureSelf: SELF_PATH,
  selectProof: join(dirname(SELF_PATH), "overseas-745-select-proof.ts"),
  d1Client: join(REPO_ROOT, "src/shared/db/d1-http-client.ts"),
  yuhoSchema: join(REPO_ROOT, "services/yuho-quant/src/db/schema.ts"),
  coreSchema: join(REPO_ROOT, "src/shared/db/core-schema.ts"),
  sharedEnv: join(REPO_ROOT, "src/shared/env.ts"),
  pnpmLock: join(REPO_ROOT, "pnpm-lock.yaml"),
};

// ---------------------------------------------------------------------------
// helpers (select-proof と同一)
// ---------------------------------------------------------------------------
export class HoldError extends Error {
  constructor(msg: string) {
    super(`HOLD: ${msg}`);
    this.name = "HoldError";
  }
}
function hold(msg: string): never {
  throw new HoldError(msg);
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function setSHA(ids: string[]): string {
  return sha256Hex(JSON.stringify([...ids].sort()));
}

const argValue = (n: string, dflt: string): string =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? dflt;

function writePrivate(path: string, data: string | Buffer): string {
  writeFileSync(path, data, { mode: 0o600 });
  return sha256Hex(data);
}

/** 追記 + fsync (forward 前の durable attempt log 用)。 */
export function durableAppend(path: string, line: string): void {
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, line + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** OUT 再利用の拒否 (replay・artifact 上書き防止。fetch の前に判定)。 */
export function assertFreshOutDir(outDir: string): void {
  if (existsSync(outDir)) hold(`OUT 既存のため拒否 (replay/上書き防止): ${outDir}`);
}

/**
 * private 保持の HOLD。D1 IDs/values・provider body を含み得る detail は
 * 0600 の hold-details.log にだけ残し、stdout (counts/SHA 契約) には
 * safe label のみ出す。
 */
export function holdPrivate(outDir: string, label: string, detail: unknown): never {
  durableAppend(
    join(outDir, "hold-details.log"),
    JSON.stringify({ at: new Date().toISOString(), label, detail: String(detail) })
  );
  hold(`${label} (詳細は private hold-details.log 参照)`);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

function asRecord(v: unknown, label: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) hold(`形状外: ${label}`);
  return v as Record<string, unknown>;
}

/** grant-first: Root explicit grant なしに実行しない (fetch 0 のまま HOLD)。 */
export function requireGrant(argv: string[]): string {
  const g = argv.find((a) => a.startsWith("--grant="))?.split("=")[1] ?? "";
  if (g === "") hold("grant 不在: Root explicit grant なしに実行しない (--grant=<Root承認文>)");
  return g;
}

export function chunkIds(ids: string[], size: number): string[][] {
  if (!Number.isInteger(size) || size <= 0) hold(`chunk size 外: ${size}`);
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/**
 * Q1 exact set partition: observed は unique かつ chunk の subset、
 * missing = chunk − observed。重複・echo 範囲外は STOP。
 * rows == all IDs は要求しない (missing HOLD 継続と両立しないため)。
 */
export function partitionChunk(
  chunk: string[],
  observed: string[],
  label: string
): { observed: string[]; missing: string[] } {
  const cset = new Set(chunk);
  const seen = new Set<string>();
  for (const d of observed) {
    if (!cset.has(d)) hold(`${label} echo 範囲外: ${d}`);
    if (seen.has(d)) hold(`${label} Q1 重複: ${d}`);
    seen.add(d);
  }
  return { observed: [...seen], missing: chunk.filter((d) => !seen.has(d)) };
}

// ---------------------------------------------------------------------------
// Q1F/Q2F builders (typed db.select のみ。offline toSQL 可)
// ---------------------------------------------------------------------------
type ProxyDb = SqliteRemoteDatabase<Record<string, unknown>>;

/** Q1F: yuho_documents 全16列 + correlated facts COUNT = 17射影。 */
export function buildQ1F(db: ProxyDb, chunk: string[]) {
  return db
    .select({
      id: yuhoDocuments.id,
      stockId: yuhoDocuments.stockId,
      edinetCode: yuhoDocuments.edinetCode,
      docId: yuhoDocuments.docId,
      docTypeCode: yuhoDocuments.docTypeCode,
      filerName: yuhoDocuments.filerName,
      periodStart: yuhoDocuments.periodStart,
      periodEnd: yuhoDocuments.periodEnd,
      submittedAt: yuhoDocuments.submittedAt,
      parseStatus: yuhoDocuments.parseStatus,
      honbunFile: yuhoDocuments.honbunFile,
      overseasParseStatus: yuhoDocuments.overseasParseStatus,
      overseasHonbunFile: yuhoDocuments.overseasHonbunFile,
      textParseStatus: yuhoDocuments.textParseStatus,
      notionDocPageId: yuhoDocuments.notionDocPageId,
      ingestedAt: yuhoDocuments.ingestedAt,
      factsCount: sql<number>`(select count(*) from "yuho_overseas_facts" where "document_id" = "yuho_documents"."id") as "factsCount"`,
    })
    .from(yuhoDocuments)
    .where(inArray(yuhoDocuments.docId, chunk));
}

/** Q2F: facts 全12 storage列 + docId echo = 13射影 (select-proof Q2 と同一形)。 */
export function buildQ2F(db: ProxyDb, chunk: string[]) {
  return db
    .select({
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
    })
    .from(overseasSalesFacts)
    .innerJoin(yuhoDocuments, eq(overseasSalesFacts.documentId, yuhoDocuments.id))
    .where(inArray(yuhoDocuments.docId, chunk))
    .orderBy(yuhoDocuments.docId, overseasSalesFacts.fiscalYearEnd, overseasSalesFacts.regionName);
}

/** 送信不能の offline drizzle (toSQL 専用。呼ばれたら throw)。 */
export function offlineDb(): ProxyDb {
  return drizzle(async () => {
    throw new Error("capture: offline builder (送信不可)");
  }, { schema: {} });
}

// ---------------------------------------------------------------------------
// Q1F 行検証 (shape/type のみ。NULL 保持。timestamps は ISO へ lossless 変換)
// ---------------------------------------------------------------------------
export interface LiveDocF {
  id: number;
  stockId: number;
  edinetCode: string;
  docId: string;
  docTypeCode: string;
  filerName: string;
  periodStart: string | null;
  periodEnd: string;
  submittedAt: string;
  parseStatus: string;
  honbunFile: string | null;
  overseasParseStatus: string | null;
  overseasHonbunFile: string | null;
  textParseStatus: string | null;
  notionDocPageId: string | null;
  ingestedAt: string;
  factsCount: number;
}

function epochToISO(v: unknown, label: string): string {
  if (v instanceof Date) {
    const t = v.getTime();
    if (!Number.isFinite(t)) hold(`${label} 時刻外`);
    return v.toISOString();
  }
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) {
    return new Date(v * 1000).toISOString();
  }
  hold(`${label} 時刻外`);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

export function validateQ1FRow(r: Record<string, unknown>, label: string): LiveDocF {
  const keys = Object.keys(r).sort();
  const want = ["docId", "docTypeCode", "edinetCode", "factsCount", "filerName", "honbunFile",
    "id", "ingestedAt", "notionDocPageId", "overseasHonbunFile", "overseasParseStatus",
    "parseStatus", "periodEnd", "periodStart", "stockId", "submittedAt", "textParseStatus"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(want)) hold(`${label} Q1F 列外: ${keys.join(",")}`);
  if (!isInt(r["id"]) || (r["id"] as number) <= 0) hold(`${label} Q1F id 外`);
  if (!isInt(r["stockId"])) hold(`${label} Q1F stockId 外`);
  if (!nonEmpty(r["edinetCode"])) hold(`${label} Q1F edinetCode 外`);
  if (!nonEmpty(r["docId"])) hold(`${label} Q1F docId 外`);
  if (!nonEmpty(r["docTypeCode"])) hold(`${label} Q1F docTypeCode 外`);
  if (typeof r["filerName"] !== "string") hold(`${label} Q1F filerName 外`);
  if (!(r["periodStart"] === null || typeof r["periodStart"] === "string")) {
    hold(`${label} Q1F periodStart 外`);
  }
  if (typeof r["periodEnd"] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r["periodEnd"] as string)) {
    hold(`${label} Q1F periodEnd 外`);
  }
  if (typeof r["parseStatus"] !== "string") hold(`${label} Q1F parseStatus 外`);
  for (const k of ["honbunFile", "overseasParseStatus", "overseasHonbunFile", "textParseStatus", "notionDocPageId"]) {
    if (!(r[k] === null || typeof r[k] === "string")) hold(`${label} Q1F ${k} 外`);
  }
  if (!isInt(r["factsCount"]) || (r["factsCount"] as number) < 0) hold(`${label} Q1F factsCount 外`);
  return {
    id: r["id"] as number, stockId: r["stockId"] as number,
    edinetCode: r["edinetCode"] as string, docId: r["docId"] as string,
    docTypeCode: r["docTypeCode"] as string, filerName: r["filerName"] as string,
    periodStart: r["periodStart"] as string | null,
    periodEnd: r["periodEnd"] as string,
    submittedAt: epochToISO(r["submittedAt"], `${label} Q1F submittedAt`),
    parseStatus: r["parseStatus"] as string,
    honbunFile: r["honbunFile"] as string | null,
    overseasParseStatus: r["overseasParseStatus"] as string | null,
    overseasHonbunFile: r["overseasHonbunFile"] as string | null,
    textParseStatus: r["textParseStatus"] as string | null,
    notionDocPageId: r["notionDocPageId"] as string | null,
    ingestedAt: epochToISO(r["ingestedAt"], `${label} Q1F ingestedAt`),
    factsCount: r["factsCount"] as number,
  };
}

// ---------------------------------------------------------------------------
// capture 送信層 (fsync-first log + whole-body wx0600 + safe receipt)
// ---------------------------------------------------------------------------
export interface GuardCounters {
  observed: number;
  failed: number;
}

export interface AttemptCtx {
  seq: number;
  kind: "Q1F" | "Q2F" | "R1" | "R2";
  chunk: number;
  idsSHA: string;
  sqlSHA: string;
}

/** whole body の receipt (strict judge の前に確定)。 */
export interface BodyReceipt {
  seq: number;
  kind: "Q1F" | "Q2F" | "R1" | "R2";
  path: string;
  sha256: string;
  bytes: number;
}

let currentAttempt: AttemptCtx | null = null;

/**
 * bound 済み fetch (createBoundedFetch 産) を包み、実 forward 内容を
 * pinned grant (D1 target SHA + attempt SQL SHA + params idsSHA) と
 * 照合してから durable log へ fsync し forward する。広い endpoint
 * regex だけでは送らない。strict judge の前に whole body bytes を
 * wx0600 保存 + safe receipt を log する。request 側の秘密
 * (Authorization 等)・params 値は log しない。redirect は manual
 * (追随せず STOP)。
 */
export function createCaptureFetch(
  inner: typeof fetch,
  outDir: string,
  counters: GuardCounters,
  receipts: BodyReceipt[],
  targetSHA: string,
  attemptSource: () => AttemptCtx | null = () => currentAttempt,
  clearAttempt: () => void = () => {
    currentAttempt = null;
  }
): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    const at = attemptSource();
    if (at === null) {
      counters.failed += 1;
      throw new Error("capture: attempt context 不在 (main 経路外の送信を拒否)");
    }
    // exact grant 照合 (log/forward の前。不一致は attempt に数えない)。
    if (sha256Hex(String(url)) !== targetSHA) {
      counters.failed += 1;
      throw new Error("capture: D1 target SHA 外 (pinned target 以外へ送らない)");
    }
    const { sql: bodySql, params: bodyParams } = ((): { sql: string; params: unknown[] } => {
      try {
        const parsed = JSON.parse(String(init?.body ?? "")) as { sql?: unknown; params?: unknown };
        if (typeof parsed.sql !== "string" || !Array.isArray(parsed.params)) {
          throw new Error("shape");
        }
        return { sql: parsed.sql, params: parsed.params };
      } catch {
        counters.failed += 1;
        throw new Error("capture: body 形状外 (sql/params を読めないため送らない)");
      }
    })();
    if (sha256Hex(bodySql) !== at.sqlSHA) {
      counters.failed += 1;
      throw new Error("capture: SQL SHA 外 (attempt 指定と異なる文を送らない)");
    }
    if (setSHA(bodyParams.map((p) => String(p))) !== at.idsSHA) {
      counters.failed += 1;
      throw new Error("capture: params idsSHA 外 (attempt 指定と異なる IDs を送らない)");
    }
    if (!tryReserveAttemptMarker(outDir, at)) {
      counters.failed += 1;
      throw new Error(`capture: attempt 重複 (seq=${at.seq} ${at.kind} 予約済み・再送なし)`);
    }
    const t0 = Date.now();
    durableAppend(
      join(outDir, "attempt.log"),
      JSON.stringify({ ...at, sendAt: new Date().toISOString(), phase: "send" })
    );
    let res: Response;
    try {
      res = await inner(String(url), { ...init, redirect: "manual" });
    } catch (e) {
      counters.failed += 1;
      throw new Error(`capture: 送信失敗: ${(e as Error).message}`, { cause: e });
    }
    const ms = Date.now() - t0;
    const raw = Buffer.from(await res.clone().arrayBuffer());
    const bodySHA = sha256Hex(raw);
    const bodyPath = join(outDir, `attempt-${String(at.seq).padStart(3, "0")}-${at.kind}-body.bin`);
    try {
      writeFileSync(bodyPath, raw, { mode: 0o600, flag: "wx" });
    } catch (e) {
      counters.failed += 1;
      throw new Error(`capture: body 保存失敗 (再入の可能性): ${(e as Error).message}`, { cause: e });
    }
    receipts.push({ seq: at.seq, kind: at.kind, path: bodyPath, sha256: bodySHA, bytes: raw.length });
    const safeHeaders: Record<string, string> = {};
    for (const k of ["content-type", "content-length", "cf-ray", "date"]) {
      const v = res.headers.get(k);
      if (v !== null) safeHeaders[k] = v;
    }
    // receivedAt は body 保存確定時の実 clock (sendAt と対。両方保持)。
    const receivedAt = new Date().toISOString();
    durableAppend(
      join(outDir, "attempt.log"),
      JSON.stringify({
        ...at, phase: "receipt", status: res.status,
        reqBytes: String(init?.body ?? "").length, rawBytes: raw.length,
        bodySHA, bodyPath, ms, receivedAt,
        headers: safeHeaders,
      })
    );
    clearAttempt();
    return res;
  }) as typeof fetch;
}

export function setAttempt(at: AttemptCtx): void {
  currentAttempt = at;
}

/**
 * per-seq attempt marker の予約 (wx0600 + fsync)。forward の前に置き、
 * 重複 attempt を native 到達前に拒否する (replay は send 0)。
 * 予約は失敗時も残す (unknown/failed attempt は永久予約・retry 0)。
 * 予約済みなら false (TOCTOU のため存在確認 + 作成は wx の原子性に任せる)。
 */
function tryReserveAttemptMarker(outDir: string, at: AttemptCtx): boolean {
  const markerPath = join(outDir, `attempt-${String(at.seq).padStart(3, "0")}-${at.kind}-reserved`);
  const line = JSON.stringify({ ...at, reservedAt: new Date().toISOString() });
  let fd: number;
  try {
    fd = openSync(markerPath, "wx", 0o600);
  } catch {
    return false;
  }
  try {
    writeSync(fd, line + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

// ---------------------------------------------------------------------------
// 静的 scope 固定 (preflight + live 起動で全断言。送信前に固定)
// ---------------------------------------------------------------------------
export interface StaticScope {
  chunks: string[][];
  unionSHA: string;
  idsSHAs: string[];
  paramsSHA: string;
  sqlOf: Record<string, string>;
  combinedSHA: string;
  moduleSHAs: Record<string, string>;
  /** capture script の実 full-file bytes SHA (報告のみ。pin 不可のため Root が外部 pin)。 */
  scriptFullSHA: string;
}

function loadOkDocIds(laneDir: string): string[] {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(laneDir, "overseas_laneA_okdocs.json"));
  } catch {
    hold("入力不在: overseas_laneA_okdocs.json");
  }
  const got = sha256Hex(bytes);
  if (got !== PINS.okdocs) hold(`pin不一致: okdocs got=${got.slice(0, 16)}…`);
  let arr: unknown;
  try {
    arr = JSON.parse(bytes.toString("utf8"));
  } catch {
    hold("JSON 破損: okdocs");
  }
  if (!Array.isArray(arr) || arr.length !== 3675) hold("okdocs 件数外");
  const ids = (arr as unknown[]).map((e) => {
    const r = asRecord(e, "okdocs 要素");
    if (!nonEmpty(r["doc_id"])) hold("okdocs doc_id 形状外");
    return r["doc_id"] as string;
  });
  if (new Set(ids).size !== 3675) hold("okdocs doc 重複あり");
  return ids.sort();
}

export function assertStaticScope(laneDir: string): StaticScope {
  const ids = loadOkDocIds(laneDir);
  const chunks = chunkIds(ids, CHUNK_SIZE);
  if (chunks.length !== 37) hold(`chunk 数外: ${chunks.length}`);
  if (chunks.some((c) => c.length === 0 || c.length > CHUNK_SIZE)) hold("chunk 件数外");
  for (let i = 1; i < chunks.length; i++) {
    const prev = (chunks[i - 1] as string[])[0] as string;
    const cur = (chunks[i] as string[])[0] as string;
    if (prev > cur) hold("chunk 順序外 (sorted 前提)");
  }
  const unionSHA = setSHA(ids);
  const idsSHAs = chunks.map((c) => setSHA(c));
  const paramsSHA = sha256Hex(idsSHAs.join("\n"));
  if (paramsSHA !== PINS.params37) hold(`params37 pin外: got=${paramsSHA.slice(0, 16)}…`);

  // builders の toSQL を実生成し、per-SQL + combined を pin 照合する。
  const db = offlineDb();
  const sizes = [100, 75];
  const sqlOf: Record<string, string> = {};
  for (const n of sizes) {
    const sample = ids.slice(0, n);
    const q1 = buildQ1F(db, sample).toSQL();
    const q2 = buildQ2F(db, sample).toSQL();
    if (q1.params.length !== n || q2.params.length !== n) hold(`binds 外: ${n}`);
    assertProjection(q1.sql, 17, `preflight-Q1F${n}`);
    assertProjection(q2.sql, 13, `preflight-Q2F${n}`);
    if (!/^\s*select\b/i.test(q1.sql) || !/^\s*select\b/i.test(q2.sql)) hold("非SELECT 形");
    sqlOf[`q1f${n}`] = q1.sql;
    sqlOf[`q2f${n}`] = q2.sql;
  }
  for (const [k, pinKey] of [["q1f100", "q1f100"], ["q1f75", "q1f75"], ["q2f100", "q2f100"], ["q2f75", "q2f75"]] as const) {
    const got = sha256Hex(sqlOf[k] as string);
    if (got !== PINS[pinKey]) hold(`${k} pin外: got=${got.slice(0, 16)}…`);
  }
  const concrete: string[] = [];
  for (const c of chunks) {
    concrete.push(sqlOf[`q1f${c.length}`] as string, sqlOf[`q2f${c.length}`] as string);
  }
  if (concrete.length !== 74) hold("concrete SQL 数外");
  const combinedSHA = sha256Hex(concrete.join("\n"));
  if (combinedSHA !== PINS.combined74) hold(`combined74 pin外: got=${combinedSHA.slice(0, 16)}…`);

  // loaded modules の bytes SHA (ts ソース。drizzle 本体は lockfile 固定)。
  // self pin は正準化形 (pin 行を TODO に戻した bytes) であり full-file SHA
  // ではない。正準化 pin は pin 行以外の drift を検出する。実 full-file SHA
  // は別途報告し (循環 self-hash 主張なし)、Root が外部 pin する。
  const moduleSHAs: Record<string, string> = {};
  let scriptFullSHA = "";
  for (const [k, p] of Object.entries(MODULE_FILES)) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(p);
    } catch {
      hold(`module 不在: ${k}`);
    }
    if (k === "captureSelf") {
      scriptFullSHA = sha256Hex(bytes);
      bytes = Buffer.from(
        bytes.toString("utf8").replace(/captureSelf: "[0-9a-f]{64}"/, 'captureSelf: "TODO"'),
        "utf8"
      );
    }
    const got = sha256Hex(bytes);
    if (got !== PINS.modules[k]) hold(`${k} module pin外: got=${got.slice(0, 16)}…`);
    moduleSHAs[k] = got;
  }
  return { chunks, unionSHA, idsSHAs, paramsSHA, sqlOf, combinedSHA, moduleSHAs, scriptFullSHA };
}

/** 正準 D1 target (typed D1_DATABASE_ID 値) の SHA 照合。env 不在は HOLD。 */
export function assertD1Target(): string {
  let id: string;
  try {
    id = sharedEnv.D1_DATABASE_ID() as string;
  } catch (e) {
    hold(`D1 target 取得不能 (env 不在): ${(e as Error).message}`);
  }
  const got = sha256Hex(id);
  if (got !== PINS.d1Target) hold(`D1 target 外: got=${got.slice(0, 16)}…`);
  return got;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const LANE_DIR = argValue("lane-dir", "/tmp");
const OUT_DIR = argValue("out-dir", "/tmp/overseas-freshread-capture-20260930");
const ENV_FILE = argValue("env-file", join(REPO_ROOT, ".env"));
const STARTED_AT = new Date().toISOString();

interface QueryRecord {
  seq: number;
  kind: "Q1F" | "Q2F";
  chunk: number;
  idsSHA: string;
  sqlSHA: string;
  at: string;
  ms: number;
  rows: number;
}

const rowKey = (r: { fiscalYearEnd: string; regionName: string }): string =>
  `${r.fiscalYearEnd} ${r.regionName}`;

async function main(): Promise<void> {
  // grant-first (fetch 0 のまま HOLD)。
  const grant = requireGrant(process.argv);
  // 静的 scope + target を送信前に固定する。
  const scope = assertStaticScope(LANE_DIR);
  if (!existsSync(ENV_FILE)) hold(`env-file 不在: ${ENV_FILE} (--env-file で指定)`);
  dotenv.config({ path: ENV_FILE, quiet: true });
  assertD1Target();
  const workHead = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  assertFreshOutDir(OUT_DIR);
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  chmodSync(OUT_DIR, 0o700);

  // capture guard: bound(74) → native を包む。drizzle 経路のみ送信する。
  // forward は pinned D1 target SHA + attempt SQL/params 照合つき。
  const counters: GuardCounters = { observed: 0, failed: 0 };
  const receipts: BodyReceipt[] = [];
  const bounded = createBoundedFetch(nativeFetch, BUDGET, counters);
  // forward 先は同一 typed accessors の正準 URL と exact 照合する
  // (DB-ID pin とは別軸。両方で exact grant)。
  const targetUrlSHA = sha256Hex(d1HttpQueryUrl());
  globalThis.fetch = createCaptureFetch(bounded, OUT_DIR, counters, receipts, targetUrlSHA);
  const db = createD1HttpDb(yuhoSchema);

  // live 検証の stdout-safety: D1 IDs/values・provider body を含み得る
  // detail は holdPrivate (0600) にだけ残し、stdout には safe label のみ。
  const guardLive = <T>(label: string, fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      holdPrivate(OUT_DIR, label, e instanceof Error ? e.message : String(e));
    }
  };
  const guardLiveAsync = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      holdPrivate(OUT_DIR, label, e instanceof Error ? e.message : String(e));
    }
  };

  const queries: QueryRecord[] = [];
  const liveQ1: LiveDocF[] = [];
  const liveQ2: Array<ReturnType<typeof validateQ2Row>> = [];
  const missing: Array<{ chunk: number; docId: string }> = [];
  const liveIds = new Set<number>();
  const seenQ1 = new Set<string>();
  // facts PK は全 37 chunks 横断の一集合で UNIQUE を断言する
  // (chunk-local では文書跨ぎの重複 PK を見逃す)。
  const seenFactIds = new Set<number>();
  let seq = 0;

  for (let ci = 0; ci < scope.chunks.length; ci++) {
    const chunk = scope.chunks[ci] as string[];
    const label = `chunk${ci}`;
    const idsSHA = scope.idsSHAs[ci] as string;

    // Q1F。
    const q1b = buildQ1F(db as ProxyDb, chunk);
    const q1sql = q1b.toSQL().sql;
    assertProjection(q1sql, 17, label);
    if (!/^\s*select\b/i.test(q1sql)) hold(`${label} Q1F 非SELECT`);
    const q1sqlSHA = sha256Hex(q1sql);
    setAttempt({ seq: seq + 1, kind: "Q1F", chunk: ci, idsSHA, sqlSHA: q1sqlSHA });
    const q1at = new Date().toISOString();
    const q1t0 = Date.now();
    const q1rows = await guardLiveAsync(`${label} Q1F 送信失敗`, async () => (await q1b) as unknown[]);
    const q1ms = Date.now() - q1t0;
    queries.push({ seq: ++seq, kind: "Q1F", chunk: ci, idsSHA, sqlSHA: q1sqlSHA, at: q1at, ms: q1ms, rows: q1rows.length });
    if (q1rows.length > chunk.length) hold(`${label} Q1F cardinality 外: ${q1rows.length} > ${chunk.length}`);
    const { part, q1docs, q1counts } = guardLive(`${label} Q1F 行検証失敗`, () => {
      const docs = new Map<string, LiveDocF>();
      const counts = new Map<string, number>();
      const observedRaw: string[] = [];
      for (const r of q1rows) {
        const d = validateQ1FRow(asRecord(r, `${label} Q1F 行`), label);
        observedRaw.push(d.docId);
        if (liveIds.has(d.id)) hold(`${label} Q1F id 重複: ${d.id}`);
        liveIds.add(d.id);
        docs.set(d.docId, d);
        counts.set(d.docId, d.factsCount);
      }
      const p = partitionChunk(chunk, observedRaw, label);
      for (const d of p.observed) {
        if (seenQ1.has(d)) hold(`${label} Q1F chunk 跨ぎ重複: ${d}`);
        seenQ1.add(d);
        liveQ1.push(docs.get(d) as LiveDocF);
      }
      for (const m of p.missing) missing.push({ chunk: ci, docId: m });
      return { part: p, q1docs: docs, q1counts: counts };
    });
    const observedSet = new Set(part.observed);

    // Q2F。
    const q2b = buildQ2F(db as ProxyDb, chunk);
    const q2sql = q2b.toSQL().sql;
    assertProjection(q2sql, 13, label);
    if (!/^\s*select\b/i.test(q2sql)) hold(`${label} Q2F 非SELECT`);
    const q2sqlSHA = sha256Hex(q2sql);
    setAttempt({ seq: seq + 1, kind: "Q2F", chunk: ci, idsSHA, sqlSHA: q2sqlSHA });
    const q2at = new Date().toISOString();
    const q2t0 = Date.now();
    const q2rows = await guardLiveAsync(`${label} Q2F 送信失敗`, async () => (await q2b) as unknown[]);
    const q2ms = Date.now() - q2t0;
    queries.push({ seq: ++seq, kind: "Q2F", chunk: ci, idsSHA, sqlSHA: q2sqlSHA, at: q2at, ms: q2ms, rows: q2rows.length });
    const orderKeys = q2rows.map((r) => {
      const o = asRecord(r, `${label} Q2F 行`);
      return `${o["docId"] as string} ${o["fiscalYearEnd"] as string} ${o["regionName"] as string}`;
    });
    for (let i = 1; i < orderKeys.length; i++) {
      if ((orderKeys[i - 1] as string) > (orderKeys[i] as string)) hold(`${label} Q2F 順序外`);
    }
    const chunkFactDocIds: string[] = [];
    guardLive(`${label} Q2F 行検証失敗`, () => {
      // canonical-key は docId を含むため chunk-local で全域と等価。
      const seenKeys = new Set<string>();
      for (const r of q2rows) {
        const f = validateQ2Row(asRecord(r, `${label} Q2F 行`), label);
        if (!observedSet.has(f.docId)) hold(`${label} Q2F 未観測 echo: ${f.docId}`);
        const q1 = q1docs.get(f.docId) as LiveDocF;
        if (q1.id !== f.documentId) hold(`${label} Q2F document_id 連鎖外: ${f.docId}`);
        if (q1.stockId !== f.stockId) hold(`${label} Q2F stock 連鎖外: ${f.docId}`);
        if (seenFactIds.has(f.id)) hold(`${label} Q2F PK 重複 (全 chunks 横断): ${f.id}`);
        seenFactIds.add(f.id);
        const k = `${f.docId} ${rowKey(f)}`;
        if (seenKeys.has(k)) hold(`${label} Q2F canonical-key 重複: ${k}`);
        seenKeys.add(k);
        liveQ2.push(f);
        chunkFactDocIds.push(f.docId);
      }
      assertPerDocCounts(part.observed, q1counts, chunkFactDocIds, label);
    });
  }

  if (counters.observed !== 74) hold(`HTTP 観測外: ${counters.observed} != 74`);
  if (counters.failed !== 0) hold(`HTTP 失敗あり: ${counters.failed}`);
  const q1sum = liveQ1.reduce((a, d) => a + d.factsCount, 0);
  if (q1sum !== liveQ2.length) hold(`Q1総計(${q1sum}) != Q2総行(${liveQ2.length})`);

  // 成果物 (OUT_DIR のみ・0600)。
  const unionSHA = writePrivate(
    join(OUT_DIR, "capture-union.json"),
    JSON.stringify({
      count: 3675, sha256: scope.unionSHA,
      chunks: scope.chunks.map((c, i) => ({ chunk: i, count: c.length, sha256: scope.idsSHAs[i] })),
    })
  );
  const manifestSHA = writePrivate(join(OUT_DIR, "capture-manifest.json"), JSON.stringify(queries));
  const liveSHA = writePrivate(
    join(OUT_DIR, "capture-live.json"),
    JSON.stringify({ q1f: liveQ1, q2f: liveQ2, missing })
  );
  const report = {
    at_start: STARTED_AT,
    at_end: new Date().toISOString(),
    result: "PASS",
    mode: "fresh-read-capture",
    grant,
    workHEAD: workHead,
    inputs: { okdocs: PINS.okdocs },
    d1TargetSHA: PINS.d1Target,
    scope: {
      chunks: scope.chunks.length, budget: BUDGET,
      unionSHA: scope.unionSHA, paramsSHA: scope.paramsSHA, combinedSHA: scope.combinedSHA,
      modules: scope.moduleSHAs, scriptFullSHA: scope.scriptFullSHA,
    },
    counts: {
      unionDocs: 3675, q1Rows: liveQ1.length, q2Rows: liveQ2.length, q1sum,
      missingDocs: missing.length,
    },
    zeros: {
      httpObserved: counters.observed, httpFailed: counters.failed,
      nonD1fetch: 0, writes: 0, sourceGET: 0,
      notionCreateUpdateArchive: 0, d1r2mutation: 0, workflow: 0, newReceipts: 0, retries: 0,
    },
    limits: [
      "READ-only。比較・CAS・L2・書込なし。旧事実 preimage は将来 CAS guard 専用。",
      "post-facts 照合は business key + expected NEW 表 (削除済み旧 fact IDs の存続は要求しない)。doc は full16 preimage capture・protected14 不変 + overseas 2列は expected 変更比較。",
      "Q1 行数 ≤ chunk。missing は exact partition + per-doc MISSING_IDENTITY (READ 継続・CAS で HOLD)。",
      "0-rows は正当な不在観測。NULL 保持。shape/type 外・unknown は STOP。",
      "attempt 全件に fsync-first log + whole body wx0600 + safe receipt。redirect manual・retry 0。",
    ],
    artifacts: {
      union: { path: join(OUT_DIR, "capture-union.json"), sha256: unionSHA },
      manifest: { path: join(OUT_DIR, "capture-manifest.json"), sha256: manifestSHA },
      live: { path: join(OUT_DIR, "capture-live.json"), sha256: liveSHA },
      rawBodies: receipts,
    },
  };
  const reportSHA = writePrivate(join(OUT_DIR, "capture-report.json"), JSON.stringify(report, null, 2));

  // stdout は counts/SHA のみ (D1 IDs/values・grant 文 0)。
  const rawBodiesSHA = sha256Hex(receipts.map((r) => r.sha256).join("\n"));
  console.info(JSON.stringify({
    result: "PASS",
    union: { count: 3675, sha256: scope.unionSHA },
    chunks: scope.chunks.length,
    queries: { q1f: 37, q2f: 37, httpObserved: counters.observed, httpFailed: counters.failed },
    liveCounts: { q1Rows: liveQ1.length, q2Rows: liveQ2.length, q1sum, missingDocs: missing.length },
    combinedSHA: scope.combinedSHA,
    paramsSHA: scope.paramsSHA,
    modules: scope.moduleSHAs,
    scriptFullSHA: scope.scriptFullSHA,
    rawBodies: { count: receipts.length, sha256: rawBodiesSHA },
    zeros: report.zeros,
    limits: report.limits,
    artifacts: { ...report.artifacts, report: { path: join(OUT_DIR, "capture-report.json"), sha256: reportSHA } },
    at_end: report.at_end,
  }));
}

/**
 * preflight: 純粋検証のみ (送信 0・FS 書込 0)。静的 pins + 正準 target の
 * 全断言が通ったときのみ exit 0。target 不一致/env 不在は HOLD (nonzero)。
 * PASS-like の UNVERIFIED exit 0 は出さない。
 */
function preflight(): void {
  globalThis.fetch = (() => {
    throw new Error("preflight: network fetch denied");
  }) as typeof fetch;
  const scope = assertStaticScope(LANE_DIR);
  if (!existsSync(ENV_FILE)) hold(`env-file 不在: ${ENV_FILE}`);
  dotenv.config({ path: ENV_FILE, quiet: true });
  const target = assertD1Target();
  console.info(JSON.stringify({
    result: "PREFLIGHT",
    sends: 0,
    writes: 0,
    union: { count: 3675, sha256: scope.unionSHA },
    chunks: scope.chunks.length,
    chunkSizes: scope.chunks.map((c) => c.length),
    paramsSHA: scope.paramsSHA,
    sqlSHAs: {
      q1f100: sha256Hex(scope.sqlOf["q1f100"] as string),
      q1f75: sha256Hex(scope.sqlOf["q1f75"] as string),
      q2f100: sha256Hex(scope.sqlOf["q2f100"] as string),
      q2f75: sha256Hex(scope.sqlOf["q2f75"] as string),
    },
    combinedSHA: scope.combinedSHA,
    modules: scope.moduleSHAs,
    scriptFullSHA: scope.scriptFullSHA,
    d1Target: target,
  }));
}

// CLI 実行時のみ main()/preflight() を走らせる (select-proof と同一形)。
const isCliMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliMain) {
  try {
    if (process.argv.includes("--preflight")) {
      preflight();
      process.exit(0);
    }
    await main();
    process.exit(0);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const holdReport = {
      at_start: STARTED_AT,
      at_end: new Date().toISOString(),
      result: "HOLD",
      reason,
    };
    console.error(JSON.stringify(holdReport));
    process.exit(1);
  }
}


