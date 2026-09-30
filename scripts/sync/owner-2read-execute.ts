/**
 * Owner-after 2-READ executor (手動実行・PREP)。
 *
 * 承認済み exact packet (`docs/owner-2read-r1/r2-20260930.json`)
 * を 2 send 以内で実行する。R1 47 unfiltered identity/status →
 * R2 qualified-40 full OHLCV preimage。writes 0・dispatch 0。
 *
 * 送信路は既存再使用のみ (新規 framework なし):
 * `createBoundedFetch` (budget 2: D1 endpoint・単発 SELECT・書込語なし・
 * 上限前拒否) + `createCaptureFetch` (exact URL SHA + SQL SHA + params
 * idsSHA 照合 → wx0600 marker 予約 → attempt.log fsync → forward
 * redirect manual → strict の前に whole body bytes を wx0600 保存 +
 * safe receipt)。送信前 durable counter = attempt.log + marker。
 *
 * 送信前の固定 pin 照合 (いずれか不一致は STOP・sends 0):
 * (1) packet 正準 typed SHA (module pin)。
 * (2) typed D1_DATABASE_ID literal SHA (Root grant pin a7bcf8e2…。DB 取違え防止)。
 * (3) exact-forward query URL full SHA (endpoint 取違え防止。prefix 8 chars 不可)。
 * (4) 再使用 module 4 件の full SHA (capture/select-proof/d1-client/shared-env)。
 * (5) packet R1/R2 file bytes SHA (source pins)。
 * (6) owner actualPOST PASS 証跡 SHA (ownerpost pin)。
 * URL は共有の唯一組立式で作り、hash して照合し、同一物を送る。
 *
 * R1 guard (全 47。除外 7 も整形必須。非 active は許容、malformed は不可):
 * exact-4 射影・code 既知・欠落/重複なし・cardinality 47・id 整数正・
 * id global 一意・ownerpost identity (id/is_active/instrument_type)
 * の semantic 一致。違反は STOP (R2 の前に throw。whole body は保存済み)。
 * gate は active-equity のみ: 適格 40 全解決で R2 へ、未解決は HOLD 記録し
 * R2 を送らない。除外 7 は現状記録し false HOLD しない。
 * R2 guard: exact-8 射影・stock_id ∈解決 40・date 一致・(stock_id,date)
 * 重複 0・cardinality ≤40・OHLCV 6 値は有限数 or 明示 NULL (DDL 通り。
 * NULL 保持、0 埋めなし)。違反は STOP。sparse 欠落は許容し記録する。
 * ownerpost は hash のみでなく full source を parse し、47 identity 照合と
 * sector6 (適格 6) full-11 baseline proposal 入力 (private 0600) に使う。
 * STOP/HOLD の public 出力は safe label のみ。値・ID 詳細は private の
 * hold-details.log (既存 holdPrivate/durableAppend 再使用) にだけ残す。
 *
 * env は typed canonical (sharedEnv) のみ。dotenv は読まない。
 * stdout は counts/SHA のみ (HOLD 時は safe generic label)。全 report は
 * private 0600 の outDir にだけ残す。
 * 報告に ID 生値・env 値・価格値は載せない。
 *
 * live 実行は `--execute --grant=<Root承認文>` が無いと起動しない。
 * `--preflight` は純粋検証のみ (送信 0・FS 書込 0)。
 * Root review 境界までは実行しない (offline 実装のみ)。
 */
import { sha256HexBytes } from "../../src/shared/sha256.js";
import {
  assertBindableParams,
  assertD1SingleQueryResponse,
  d1HttpQueryUrlFor,
} from "../../src/shared/db/d1-http-client.js";
import { sharedEnv } from "../../src/shared/env.js";
import { stableStringify } from "./ipo-bridge-capture.js";
import {
  assertFreshOutDir,
  createCaptureFetch,
  durableAppend,
  holdPrivate,
  requireGrant,
  setAttempt,
  setSHA,
  sha256Hex,
  type BodyReceipt,
} from "../../services/yuho-quant/data-scripts/overseas-fresh-read-capture.js";
import {
  createBoundedFetch,
  type GuardCounters,
} from "../../services/yuho-quant/data-scripts/overseas-745-select-proof.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SENDS_CAP = 2;
export const R1_BINDS = 47;
export const R2_BINDS = 41;
export const R1_FILE = "owner-2read-r1-20260930.json";
export const R2_FILE = "owner-2read-r2-20260930.json";
/** sector6 適格 6 (freeze 提案の固定 scope を verbatim 再使用。提案 B 参照)。 */
export const SECTOR6_QUALIFIED = ["618A", "619A", "621A", "625A", "623A", "634A"] as const;
/** R1 exact-4 射影 (sorted)。 */
export const R1_PROJECTION = ["code", "id", "instrument_type", "is_active"];
/** R2 exact-8 射影 (sorted)。 */
export const R2_PROJECTION = ["adj", "close", "date", "high", "low", "open", "stock_id", "volume"];
/** R2 OHLCV 6 値 (DDL REAL nullable。有限数 or 明示 NULL)。 */
export const R2_NUMERIC_KEYS = ["open", "high", "low", "close", "volume", "adj"];

/** packet 正準 typed SHA (pure preflight で確定・Root へ hash-first 報告済みの値)。 */
export const PINNED_PACKET_SHA = "6c7fb424b175bf23e0d6b5ca827146e7b0167a85819d8b97a1df48b4d9079440";
/** typed D1_DATABASE_ID literal SHA (Root grant pin。DB 取違え防止)。 */
export const PINNED_DB_SHA = "a7bcf8e2f330e5c81f78e063131dc8837c90d7db9c07388ad7eeca4c8768ba0e";
/** exact-forward query URL full SHA (prefix 不可。pure preflight 確定・Root 報告済みの値)。 */
export const PINNED_URL_SHA = "8a2fc196212244e660668396fcdd92228f1b2120b6dd16145bbdeef321ddeb49";
/** 再使用 module 4 件の full SHA (pure preflight 確定・Root 報告済みの値)。 */
export const PINNED_MODULES = {
  capture: "3e25047d6c77a8c74626c0f67ac075923501e315612f0ab5c399643b91732060",
  selectProof: "6c864f43b8141162783368c311c2abd8e673e34dd58c82469618173e7a96bf05",
  d1Client: "2d16180bdf864bcade9f8850b922f99b768be8de3bcbe427900fc9ec7afda1c1",
  sharedEnv: "183af3b9847673b5ea3863f81b0866c7d078075193b702631bfd7941bb1e8d15",
  ipoBridge: "462c1219b923165ac8a949f479fe459542272e49c0c7ab73475aaaa251f055b7",
  pnpmLock: "805dd5b36ca9ec385b29de1ded715305537eac514dbc7c77dfc55b2d56617e58",
};
/** packet R1/R2 file bytes SHA (source pins。pure preflight 確定・Root 報告済みの値)。 */
export const PINNED_SOURCES = {
  r1: "997bcf8442ba0f7baddca249b30bea3e844d4cb47ae609acf955e6599fa5312e",
  r2: "d9e35a8d8a8fd18492f10588317d05f853046c2cce3f7f85252792ceb4bd8d0e",
};
/** owner actualPOST PASS 証跡 SHA (ownerpost pin。Root 提示の baseline 値)。 */
export const PINNED_OWNERPOST_SHA =
  "9bc6b50b7fa3ac86edd17bf87ef60625428423e72efa9df86de7ca741a5b1ec8";

const HERE = dirname(fileURLToPath(import.meta.url));
/** module pin 対象の実体 (tsx が実行する bytes + runtime 依存 lock)。 */
export const MODULE_FILES = {
  capture: join(HERE, "../../services/yuho-quant/data-scripts/overseas-fresh-read-capture.ts"),
  selectProof: join(HERE, "../../services/yuho-quant/data-scripts/overseas-745-select-proof.ts"),
  d1Client: join(HERE, "../../src/shared/db/d1-http-client.ts"),
  sharedEnv: join(HERE, "../../src/shared/env.ts"),
  ipoBridge: join(HERE, "./ipo-bridge-capture.ts"),
  pnpmLock: join(HERE, "../../pnpm-lock.yaml"),
} as const;

export interface PacketR1 {
  sql: string;
  binds: string[];
  eligible40: string[];
  excluded7: string[];
  counts: { sends: number; binds: number; expectedRowsMax: number };
}

export interface PacketR2 {
  sql: string;
  dateBind: string;
  idSlots: { slot: number; code: string; id: string }[];
  counts: { sends: number; binds: number; expectedRowsMax: number };
}

/**
 * packet 正準 typed target (pin 対象)。SQL + 型付き binds のみ。
 * 正準形: sorted-key compact JSON (UTF-8)。
 */
export function canonicalTypedTarget(r1: PacketR1, r2: PacketR2): string {
  return stableStringify({
    r1: { binds: r1.binds.map((v) => ({ t: "str", v })), sql: r1.sql },
    r2: {
      binds: [
        { t: "str", v: r2.dateBind },
        ...r2.idSlots.map((s) => ({ t: "id-slot", v: s.code })),
      ],
      sql: r2.sql,
    },
  });
}

export async function packetTargetSha(r1: PacketR1, r2: PacketR2): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(canonicalTypedTarget(r1, r2)));
}

/**
 * typed DB-target SHA (Root grant pin 照合用)。
 * 式: sha256hex(D1_DATABASE_ID literal)。既存 assertD1Target と同一式。
 */
export function dbTargetSha(databaseId: string): string {
  return sha256Hex(databaseId);
}

export function queryUrlSha(url: string): string {
  return sha256Hex(url);
}

export interface Owner2ReadPins {
  packetSha: string;
  dbPin: string;
  urlSha: string;
  modules: {
    capture: string;
    selectProof: string;
    d1Client: string;
    sharedEnv: string;
    ipoBridge: string;
    pnpmLock: string;
  };
  sources: { r1: string; r2: string };
  ownerpost: string;
}

export interface Owner2ReadDeps {
  readFile: (path: string) => Promise<string>;
  env: { accountId: string; databaseId: string; token: string };
}

export interface Owner2ReadOpts {
  packetDir: string;
  outDir: string;
  ownerpostPath: string;
  pins: Owner2ReadPins;
}

export interface Owner2ReadReport {
  packetSha: string;
  dbSha: string;
  dbShaMatch: boolean;
  urlSha: string;
  urlShaMatch: boolean;
  modulesMatch: boolean;
  sourcesMatch: boolean;
  ownerpostSha: string;
  ownerpostMatch: boolean;
  sends: number;
  responses: number;
  receipts: { seq: number; kind: string; sha256: string; bytes: number }[];
  r1: {
    rows: number;
    held: string[];
    excluded: { code: string; found: boolean; active: number | null; instrument: string | null }[];
    unrequested: number;
  };
  r2: { sent: boolean; rows: number; held: string[]; missing: string[] };
  sector6: { rows: number; missing: string[]; sha256: string };
  holds: string[];
}

/** ownerpost core 行の 47-identity 照合用 (code→id/status)。 */
export interface OwnerpostIdent {
  id: number;
  isActive: number;
  instrumentType: string | null;
}

export interface OwnerpostParsed {
  /** binds 47 全件の identity (欠落は preflight STOP)。 */
  ident47: Record<string, OwnerpostIdent>;
  /** sector6 適格 6 の full-11 行 (verbatim。欠落は missing に記録)。 */
  sector6Rows: Record<string, unknown>[];
  sector6Missing: string[];
}

/**
 * exact-SQL 単発送信。capture wrapper 経由 (attempt 照合 → marker 予約 →
 * attempt.log fsync → forward redirect manual → raw を strict の前に
 * wx0600 保存)。この関数の strict judge は保存確定後の bytes に対して行う。
 * 送信失敗は capture 後に holdPrivate で包む (console には safe label のみ。
 * provider body は private hold-details.log だけに残す)。
 */
export async function sendExactSingle(
  url: string,
  token: string,
  sql: string,
  params: (string | number | null)[],
  cap: typeof fetch,
  kind: "R1" | "R2",
  seq: number,
  outDir: string
): Promise<Record<string, unknown>[]> {
  const checked = [...params];
  assertBindableParams(checked);
  setAttempt({ seq, kind, chunk: 0, idsSHA: setSHA(checked.map((p) => String(p))), sqlSHA: sha256Hex(sql) });
  let res: Response;
  try {
    res = await cap(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params: checked }),
    });
  } catch (e) {
    holdPrivate(outDir, `${kind.toLowerCase()}-send-failed`, (e as Error).message);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    holdPrivate(outDir, `${kind.toLowerCase()}-http-${res.status}`, body);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (e) {
    holdPrivate(outDir, `${kind.toLowerCase()}-json-unparseable`, (e as Error).message);
  }
  try {
    return assertD1SingleQueryResponse(data);
  } catch (e) {
    holdPrivate(outDir, `${kind.toLowerCase()}-strict-reject`, (e as Error).message);
  }
}

function countPlaceholders(sql: string): number {
  return sql.split("?").length - 1;
}

export interface PreflightResult {
  packetSha: string;
  dbSha: string;
  urlSha: string;
  modules: Record<string, string>;
  sources: { r1: string; r2: string };
  ownerpostSha: string;
  ownerpost: OwnerpostParsed;
  r1: PacketR1;
  r2: PacketR2;
}

/**
 * ownerpost full source の semantic parse (hash 照合に加えて内容を読む)。
 * core[] から binds 47 の identity と sector6 適格 6 の full-11 行を取る。
 */
export function parseOwnerpost(ownerpostText: string, binds47: string[]): OwnerpostParsed {
  const fail = (why: string): never => {
    throw new Error(`2read STOP: ownerpost parse 不正 ${why} (送信 0)`);
  };
  let doc: unknown;
  try {
    doc = JSON.parse(ownerpostText);
  } catch {
    fail("JSON 破損");
  }
  const core = (doc as { core?: unknown }).core;
  if (!Array.isArray(core)) fail("core 非配列");
  const byCode = new Map<string, Record<string, unknown>>();
  for (const row of core as unknown[]) {
    const r = row as Record<string, unknown>;
    if (typeof r["code"] !== "string") fail("core 行 code 外");
    if (byCode.has(r["code"] as string)) fail(`core code 重複`);
    byCode.set(r["code"] as string, r);
  }
  const ident47: Record<string, OwnerpostIdent> = {};
  for (const code of binds47) {
    const r = byCode.get(code) ?? fail(`identity 欠落 ${code}`);
    if (
      typeof r["id"] !== "number" ||
      !Number.isInteger(r["id"]) ||
      (r["id"] as number) <= 0 ||
      typeof r["isActive"] !== "number" ||
      !Number.isInteger(r["isActive"]) ||
      !(typeof r["instrumentType"] === "string" || r["instrumentType"] === null)
    ) {
      fail(`identity 形状外 ${code}`);
    }
    ident47[code] = {
      id: r["id"] as number,
      isActive: r["isActive"] as number,
      instrumentType: r["instrumentType"] as string | null,
    };
  }
  const sector6Rows: Record<string, unknown>[] = [];
  const sector6Missing: string[] = [];
  for (const code of SECTOR6_QUALIFIED) {
    const r = byCode.get(code);
    if (!r) {
      sector6Missing.push(code);
      continue;
    }
    sector6Rows.push(r);
  }
  return { ident47, sector6Rows, sector6Missing };
}

/** HOLD 継続記録 (throw しない hold-details 残し。public には label のみ出す)。 */
function recordPrivate(outDir: string, label: string, detail: unknown): void {
  durableAppend(
    join(outDir, "hold-details.log"),
    JSON.stringify({ at: new Date().toISOString(), label, detail: String(detail) })
  );
}

/** pure preflight (送信 0・FS 書込 0)。全 pin 照合 + packet 構造検査。 */
export async function preflightOwner2Read(deps: Owner2ReadDeps, opts: Owner2ReadOpts): Promise<PreflightResult> {
  const r1Path = join(opts.packetDir, R1_FILE);
  const r2Path = join(opts.packetDir, R2_FILE);
  const r1Text = await deps.readFile(r1Path);
  const r2Text = await deps.readFile(r2Path);
  const r1 = JSON.parse(r1Text) as PacketR1;
  const r2 = JSON.parse(r2Text) as PacketR2;

  // (1) packet pin (改竄検出。送信 0)。
  const packetSha = await packetTargetSha(r1, r2);
  if (packetSha !== opts.pins.packetSha) {
    throw new Error("2read STOP: packet pin 不一致 (送信 0)");
  }
  // 構造検査 (数・一意・型・集合)。
  const fail = (why: string): never => {
    throw new Error(`2read STOP: packet 構造不正 ${why} (送信 0)`);
  };
  if (
    typeof r1.sql !== "string" ||
    !Array.isArray(r1.binds) ||
    r1.binds.length !== R1_BINDS ||
    new Set(r1.binds).size !== R1_BINDS ||
    r1.binds.some((c) => typeof c !== "string" || c.length === 0) ||
    countPlaceholders(r1.sql) !== R1_BINDS ||
    r1.counts?.binds !== R1_BINDS ||
    r1.counts?.sends !== 1
  ) {
    fail("R1");
  }
  const slotCodes = Array.isArray(r2.idSlots) ? r2.idSlots.map((s) => s.code) : [];
  if (
    typeof r2.sql !== "string" ||
    typeof r2.dateBind !== "string" ||
    r2.dateBind.length === 0 ||
    !Array.isArray(r2.idSlots) ||
    r2.idSlots.length !== R2_BINDS - 1 ||
    new Set(slotCodes).size !== R2_BINDS - 1 ||
    slotCodes.some((c) => typeof c !== "string" || c.length === 0) ||
    r2.idSlots.some((s, i) => s.slot !== i + 1 || s.id !== "<R1-actual>") ||
    countPlaceholders(r2.sql) !== R2_BINDS ||
    r2.counts?.binds !== R2_BINDS ||
    r2.counts?.sends !== 1
  ) {
    fail("R2");
  }
  if (
    new Set(r1.eligible40).size !== 40 ||
    new Set(r1.excluded7).size !== 7 ||
    JSON.stringify([...r1.eligible40].sort()) !== JSON.stringify([...slotCodes].sort()) ||
    JSON.stringify([...new Set(r1.binds)].filter((c) => !r1.eligible40.includes(c)).sort()) !==
      JSON.stringify([...r1.excluded7].sort())
  ) {
    fail("R1/R2 集合");
  }

  // (4) module pins (再使用物の取違え防止。送信 0)。
  const modules: Record<string, string> = {};
  for (const [name, path] of Object.entries(MODULE_FILES)) {
    modules[name] = sha256Hex(await deps.readFile(path));
    if (modules[name] !== (opts.pins.modules as Record<string, string>)[name]) {
      throw new Error(`2read STOP: module pin 不一致 ${name} (送信 0)`);
    }
  }
  // (5) source pins (packet file bytes。送信 0)。
  const sources = { r1: sha256Hex(r1Text), r2: sha256Hex(r2Text) };
  if (sources.r1 !== opts.pins.sources.r1 || sources.r2 !== opts.pins.sources.r2) {
    throw new Error("2read STOP: source pin 不一致 (送信 0)");
  }
  // (6) ownerpost pin (owner actualPOST PASS 証跡。送信 0)。
  // hash に加えて full source を parse し semantic 照合入力を作る。
  const ownerpostText = await deps.readFile(opts.ownerpostPath);
  const ownerpostSha = sha256Hex(ownerpostText);
  if (ownerpostSha !== opts.pins.ownerpost) {
    throw new Error("2read STOP: ownerpost pin 不一致 (送信 0)");
  }
  const ownerpost = parseOwnerpost(ownerpostText, r1.binds);
  // (2)(3) target pins (取違え防止。送信 0)。
  const dbSha = dbTargetSha(deps.env.databaseId);
  if (dbSha !== opts.pins.dbPin) throw new Error("2read STOP: DB target pin 不一致 (送信 0)");
  const url = d1HttpQueryUrlFor(deps.env.accountId, deps.env.databaseId);
  const urlSha = queryUrlSha(url);
  if (urlSha !== opts.pins.urlSha) {
    throw new Error("2read STOP: URL full-SHA 不一致 (送信 0)");
  }
  return { packetSha, dbSha, urlSha, modules, sources, ownerpostSha, ownerpost, r1, r2 };
}

export async function runOwner2Read(deps: Owner2ReadDeps, opts: Owner2ReadOpts): Promise<Owner2ReadReport> {
  const pf = await preflightOwner2Read(deps, opts);
  const { r1, r2 } = pf;
  const url = d1HttpQueryUrlFor(deps.env.accountId, deps.env.databaseId);

  assertFreshOutDir(opts.outDir);
  mkdirSync(opts.outDir, { recursive: false, mode: 0o700 });
  const counters: GuardCounters = { observed: 0, failed: 0 };
  const receipts: BodyReceipt[] = [];
  const bounded = createBoundedFetch(globalThis.fetch, SENDS_CAP, counters);
  const cap = createCaptureFetch(bounded, opts.outDir, counters, receipts, pf.urlSha);

  // R1 (send 1/2)。whole body は wrapper が全判定の前に保存済み。
  const outDir = opts.outDir;
  const r1Rows = await sendExactSingle(url, deps.env.token, r1.sql, r1.binds, cap, "R1", 1, outDir);
  // exact-4 射影 + 行 shape (既存 validateQ2Row と同一 idiom)。違反は STOP。
  const wantR1 = JSON.stringify(R1_PROJECTION);
  for (const [i, row] of r1Rows.entries()) {
    const keys = Object.keys(row).sort();
    if (JSON.stringify(keys) !== wantR1) {
      holdPrivate(outDir, `r1-projection(${i})`, `keys=${keys.join(",")}`);
    }
    const code = row["code"];
    const id = row["id"];
    if (typeof code !== "string" || code === "") holdPrivate(outDir, `r1-code(${i})`, `code=${String(code)}`);
    if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
      holdPrivate(outDir, `r1-id(${i})`, `id=${String(id)}`);
    }
    if (typeof row["is_active"] !== "number" || !Number.isInteger(row["is_active"])) {
      holdPrivate(outDir, `r1-is-active(${i})`, `is_active=${String(row["is_active"])}`);
    }
    if (!(typeof row["instrument_type"] === "string" || row["instrument_type"] === null)) {
      holdPrivate(outDir, `r1-instrument(${i})`, `instrument_type=${String(row["instrument_type"])}`);
    }
  }
  // subset + cardinality + per-code exact-1 (相互相殺なし)。除外 7 も整形必須。
  if (r1Rows.length !== R1_BINDS) {
    holdPrivate(outDir, "r1-cardinality", `rows=${r1Rows.length}`);
  }
  const byCode = new Map<string, Record<string, unknown>>();
  for (const row of r1Rows) {
    const code = row["code"] as string;
    if (!r1.binds.includes(code)) holdPrivate(outDir, "r1-unrequested", `code=${code}`);
    if (byCode.has(code)) holdPrivate(outDir, "r1-duplicate", `code=${code}`);
    byCode.set(code, row);
  }
  for (const code of r1.binds) {
    if (!byCode.has(code)) holdPrivate(outDir, "r1-missing", `code=${code}`);
  }
  // id global 一意 + ownerpost identity semantic 一致。違反は STOP。
  const seenIds = new Map<number, string>();
  for (const code of r1.binds) {
    const row = byCode.get(code) as Record<string, unknown>;
    const id = row["id"] as number;
    const prev = seenIds.get(id);
    if (prev !== undefined) holdPrivate(outDir, "r1-id-collision", `id=${id} codes=${prev},${code}`);
    seenIds.set(id, code);
    const pinned = pf.ownerpost.ident47[code];
    const liveActive = row["is_active"] as number;
    const liveInstr = row["instrument_type"] as string | null;
    if (id !== pinned.id || liveActive !== pinned.isActive || liveInstr !== pinned.instrumentType) {
      holdPrivate(
        outDir,
        "r1-ownerpost-mismatch",
        `code=${code} live=(${id},${liveActive},${String(liveInstr)}) pinned=(${pinned.id},${pinned.isActive},${String(pinned.instrumentType)})`
      );
    }
  }
  // gate は active-equity のみ。除外 7 は現状記録 (false HOLD なし)。
  const holds: string[] = [];
  const r1held: string[] = [];
  const excluded: Owner2ReadReport["r1"]["excluded"] = [];
  const resolved = new Map<string, number>();
  for (const code of r1.binds) {
    const row = byCode.get(code) as Record<string, unknown>;
    if (!r1.eligible40.includes(code)) {
      excluded.push({
        code,
        found: true,
        active: row["is_active"] as number,
        instrument: row["instrument_type"] as string | null,
      });
      continue;
    }
    if (row["is_active"] !== 1 || row["instrument_type"] !== "equity") {
      recordPrivate(outDir, `r1-gate:${code}`, JSON.stringify(row));
      r1held.push(`${code}:hold-inactive`);
      continue;
    }
    resolved.set(code, row["id"] as number);
  }
  holds.push(...r1held);

  // R2 前提: 適格 40 全解決。未解決があれば送らない。
  if (resolved.size !== r1.eligible40.length) {
    return finishReport(opts, pf, counters, receipts, {
      r1: { rows: r1Rows.length, held: r1held, excluded, unrequested: 0 },
      r2: { sent: false, rows: 0, held: [`r2-unsent:${r1.eligible40.length - resolved.size}`], missing: [] },
      holds: [...holds, `r2-unsent:${r1.eligible40.length - resolved.size}`],
    });
  }
  // R2 binds は R1 実測 id のみ (合成なし)。slot 順。
  const ids = r2.idSlots.map((s) => resolved.get(s.code) as number);
  const r2Rows = await sendExactSingle(url, deps.env.token, r2.sql, [r2.dateBind, ...ids], cap, "R2", 2, outDir);
  // R2 guard (既存 validateQ2Row と同一 idiom)。違反は STOP。
  const wantR2 = JSON.stringify(R2_PROJECTION);
  const idSet = new Set(ids);
  const seenKeys = new Set<string>();
  for (const [i, row] of r2Rows.entries()) {
    const keys = Object.keys(row).sort();
    if (JSON.stringify(keys) !== wantR2) {
      holdPrivate(outDir, `r2-projection(${i})`, `keys=${keys.join(",")}`);
    }
    const sid = row["stock_id"];
    if (typeof sid !== "number" || !Number.isInteger(sid) || !idSet.has(sid)) {
      holdPrivate(outDir, `r2-stock-id(${i})`, `stock_id=${String(sid)}`);
    }
    if (row["date"] !== r2.dateBind) holdPrivate(outDir, `r2-date(${i})`, `date=${String(row["date"])}`);
    const tup = `${String(sid)}|${String(row["date"])}`;
    if (seenKeys.has(tup)) holdPrivate(outDir, "r2-pk-duplicate", tup);
    seenKeys.add(tup);
    for (const k of R2_NUMERIC_KEYS) {
      const v = row[k];
      if (!(v === null || (typeof v === "number" && Number.isFinite(v)))) {
        holdPrivate(outDir, `r2-cell(${i})`, `${k}=${String(v)}`);
      }
    }
  }
  if (r2Rows.length > r1.eligible40.length) {
    holdPrivate(outDir, "r2-cardinality", `rows=${r2Rows.length}`);
  }
  // sparse 欠落は許容し記録する (NULL 保持、0 埋めなし)。
  const observedIds = new Set(r2Rows.map((r) => r["stock_id"] as number));
  const r2Missing = [...resolved.keys()].filter((c) => !observedIds.has(resolved.get(c) as number));
  if (r2Missing.length > 0) recordPrivate(outDir, "r2-sparse-missing", r2Missing.join(","));
  return finishReport(opts, pf, counters, receipts, {
    r1: { rows: r1Rows.length, held: r1held, excluded, unrequested: 0 },
    r2: { sent: true, rows: r2Rows.length, held: [], missing: r2Missing },
    holds,
  });
}

function finishReport(
  opts: Owner2ReadOpts,
  pf: PreflightResult,
  counters: GuardCounters,
  receipts: BodyReceipt[],
  parts: Pick<Owner2ReadReport, "r1" | "r2" | "holds">
): Owner2ReadReport {
  // sector6 full-11 baseline proposal 入力 (private 0600。値は public に出さない)。
  const sector6Proposal = {
    ownerpostSha: pf.ownerpostSha,
    scope: [...SECTOR6_QUALIFIED],
    rows: pf.ownerpost.sector6Rows,
    missing: pf.ownerpost.sector6Missing,
  };
  const sector6Bytes = new TextEncoder().encode(JSON.stringify(sector6Proposal, null, 2) + "\n");
  writeFileSync(join(opts.outDir, "sector6-baseline-proposal.json"), sector6Bytes, { mode: 0o600, flag: "wx" });
  const report: Owner2ReadReport = {
    packetSha: pf.packetSha,
    dbSha: pf.dbSha,
    dbShaMatch: true,
    urlSha: pf.urlSha,
    urlShaMatch: true,
    modulesMatch: true,
    sourcesMatch: true,
    ownerpostSha: pf.ownerpostSha,
    ownerpostMatch: true,
    sends: counters.observed,
    responses: receipts.length,
    receipts: receipts.map((r) => ({ seq: r.seq, kind: r.kind, sha256: r.sha256, bytes: r.bytes })),
    sector6: {
      rows: pf.ownerpost.sector6Rows.length,
      missing: pf.ownerpost.sector6Missing,
      sha256: sha256Hex(sector6Bytes),
    },
    ...parts,
  };
  writeFileSync(join(opts.outDir, "owner-2read-report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  return report;
}

/**
 * stdout 公開形 (counts/SHA のみ。per-code 配列は private 0600 にだけ残す。
 * HOLD 時は safe generic label のみ出す)。
 */
export function publicReport(report: Owner2ReadReport, outDir: string): Record<string, unknown> {
  const held = report.holds.length > 0 || !report.r2.sent;
  return {
    result: held ? "HOLD" : "READ",
    packetSha: report.packetSha,
    dbSha: report.dbSha,
    dbShaMatch: report.dbShaMatch,
    urlSha: report.urlSha,
    urlShaMatch: report.urlShaMatch,
    modulesMatch: report.modulesMatch,
    sourcesMatch: report.sourcesMatch,
    ownerpostSha: report.ownerpostSha,
    ownerpostMatch: report.ownerpostMatch,
    sends: report.sends,
    responses: report.responses,
    receipts: report.receipts,
    r1: {
      rows: report.r1.rows,
      heldCount: report.r1.held.length,
      excludedCount: report.r1.excluded.length,
      unrequested: report.r1.unrequested,
    },
    r2: { sent: report.r2.sent, rows: report.r2.rows, heldCount: report.r2.held.length, missingCount: report.r2.missing.length },
    sector6: { rows: report.sector6.rows, missingCount: report.sector6.missing.length, sha256: report.sector6.sha256 },
    holdsCount: report.holds.length,
    holds: held ? ["HOLD"] : [],
    privateReport: join(outDir, "owner-2read-report.json"),
  };
}

function argVal(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

function defaultPins(): Owner2ReadPins {
  return {
    packetSha: PINNED_PACKET_SHA,
    dbPin: PINNED_DB_SHA,
    urlSha: PINNED_URL_SHA,
    modules: { ...PINNED_MODULES },
    sources: { ...PINNED_SOURCES },
    ownerpost: PINNED_OWNERPOST_SHA,
  };
}

function printScopeAndExit(): never {
  console.info(
    [
      "[owner-2read] Owner-after 2-READ executor (PREP 実装)。",
      `入力: --packet-dir 内 ${R1_FILE} + ${R2_FILE}。`,
      `送信 cap ${SENDS_CAP} (R1 47 binds + R2 41 binds)。writes 0・dispatch 0。`,
      "pin: packet + typed DB literal + URL full + modules + sources + ownerpost (不一致は送信 0)。",
      "送信路: 既存 createBoundedFetch + createCaptureFetch (raw は strict の前に wx0600 保存)。",
      "live 実行には --execute --grant=<Root承認文> が必要です。Root review 境界までは実行しません。",
      "純粋検証は --preflight (送信 0・FS 書込 0)。",
    ].join("\n")
  );
  process.exit(2);
  throw new Error("unreachable");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dir = argVal(args, "--packet-dir");
  const outDir = argVal(args, "--out-dir");
  const ownerpostPath = argVal(args, "--ownerpost-path");
  if (args.includes("--preflight")) {
    if (!dir || !ownerpostPath) printScopeAndExit();
    const { readFile } = await import("node:fs/promises");
    const pf = await preflightOwner2Read(
      {
        readFile: (p: string) => readFile(p, "utf-8"),
        env: {
          accountId: sharedEnv.CLOUDFLARE_ACCOUNT_ID(),
          databaseId: sharedEnv.D1_DATABASE_ID(),
          token: sharedEnv.CLOUDFLARE_API_TOKEN(),
        },
      },
      { packetDir: dir as string, outDir: "", ownerpostPath: ownerpostPath as string, pins: defaultPins() }
    );
    console.info(
      JSON.stringify(
        {
          result: "PREFLIGHT",
          packetSha: pf.packetSha,
          dbSha: pf.dbSha,
          dbShaMatch: true,
          urlSha: pf.urlSha,
          urlShaMatch: true,
          modulesMatch: true,
          sourcesMatch: true,
          ownerpostSha: pf.ownerpostSha,
          ownerpostMatch: true,
          sends: 0,
        },
        null,
        2
      )
    );
    return;
  }
  if (!args.includes("--execute") || !dir || !outDir || !ownerpostPath) printScopeAndExit();
  requireGrant(args);
  const { readFile } = await import("node:fs/promises");
  const report = await runOwner2Read(
    {
      readFile: (p: string) => readFile(p, "utf-8"),
      env: {
        accountId: sharedEnv.CLOUDFLARE_ACCOUNT_ID(),
        databaseId: sharedEnv.D1_DATABASE_ID(),
        token: sharedEnv.CLOUDFLARE_API_TOKEN(),
      },
    },
    { packetDir: dir as string, outDir: outDir as string, ownerpostPath: ownerpostPath as string, pins: defaultPins() }
  );
  console.info(JSON.stringify(publicReport(report, outDir as string), null, 2));
  if (report.holds.length > 0 || !report.r2.sent) process.exitCode = 1;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((e) => {
    console.error("[owner-2read] エラー:", (e as Error).message);
    process.exit(1);
  });
}
