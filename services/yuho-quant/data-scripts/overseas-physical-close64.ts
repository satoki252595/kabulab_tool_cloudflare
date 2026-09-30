/**
 * Physical-64 closure runner (listing + hosted full-bytes readback)。
 *
 * 既存 69 complete 行のうち byte source のある 64 行 (Tier A 59 +
 * Tier B 5) を strict 共有 `verifyArchivedAttachments` で閉じる。
 * Tier C 5 行 (byte source なし) は scope 外・HOLD のまま。
 * missing 行は fresh GET の必要性を意味しない。
 *
 * 期待 bytes は packet 記載の local 原本から読む (Tier A は
 * metadata bytes/SHA と照合・Tier B は inventory 観測値と照合。
 * 不一致・不在は HOLD)。Tier B は hosted↔local same-bytes のみ
 * (metadata anchor なし・official 適格化しない)。
 *
 * Read-only の強制: native の前に guard を置き、以下以外を送らず
 * HOLD する。GET `/v1/pages/{id}` (packet の exact 64 pageIDs のみ。
 * query/body なし) + GET hosted (観測 host
 * `prod-files-secure.s3.us-west-2.amazonaws.com` のみ・https・
 * 署名 query は不透明・URL 単位で各 1 回)。search・POST・PATCH・
 * DELETE・record・source GET・D1/R2 は範囲外 (0)。
 *
 * Caps (closed): listing 64 論理 × retry 乗数 7 (MAX_RETRY 6) =
 * 448 native max・hosted 64 exact (verifier に hosted retry なし。
 * 失敗は HOLD・再送なし)。native 合計 512。page 単位で
 * listing→DL を pair する (hosted URL は署名付き失効制)。
 *
 * Capture: forward 前に reserved 行を fsync し、受信した同一
 * response を clone して whole bytes + safe 状態を判定の前に
 * private 保存する (余分 GET なし)。3xx は follow せず STOP。
 * 最初の verifier 失敗で STOP する (fail-fast・残行は未試行)。
 *
 * stdout は counts/SHA のみ (pageIDs・grant 文は 0600 のみ)。
 * READY 判定は Root (本 runner は same-bytes 閉鎖の成否のみ)。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function argValue(n: string, dflt: string): string {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? dflt;
}

const ENV_FILE = argValue("env-file", join(REPO_ROOT, ".env"));
const STARTED_AT = new Date().toISOString();

const PACKET_PATH = "/tmp/overseas-close69-prep-20260930/physical-close-69.json";
const OUT_DIR = "/tmp/overseas-physical-close64-20260930";
const ROWS_TOTAL = 69;
const SCOPE_N = 64;
const TIER_A_N = 59;
const TIER_B_N = 5;
const TIER_C_N = 5;
const LISTING_CAP = 448;
const HOSTED_N = 64;
const TOTAL_CAP = 512;
const HOSTED_HOST = "prod-files-secure.s3.us-west-2.amazonaws.com";

const PINS = {
  packetSHA: "16d5172071beb508d495aa8ad846c09898fda875e39b5d1516c30be4263bd4d8",
  // module pins は全て file bytes の full SHA256 (git blob 40char ではない)。
  modules: {
    closeSelf: "8d3b26481028894f92c2fe4b28fee83c31153052196e1ee29edc56c25ebf0d85",
    sharedReadback: "6bfde103d2cad0cacd942833d3caa1957e44de167a0ce18345bae492c2b2194c",
    sharedPageFile: "48f8574f6b4eac3b8a23f83c343c7e52e1274b5c10fe437ebb59fb9d682a3f59",
    sharedSha256: "da3711c4f39656b665f46aa2922adbdf41f3af5045fcf28301540da521a001de",
    sharedClient: "4a7f780053ad4bce844e40323e75f4d1713bc1a0c5affe8e4710002192346754",
    sharedEnv: "de8449e3b8c5c217e206acac92ca3bfab5005d4a5fef3c7c0608f42a1f4ae1c0",
    pnpmLock: "805dd5b36ca9ec385b29de1ded715305537eac514dbc7c77dfc55b2d56617e58",
  } as Record<string, string>,
};

const SELF_PATH = fileURLToPath(import.meta.url);
const MODULE_FILES: Record<string, string> = {
  closeSelf: SELF_PATH,
  sharedReadback: join(REPO_ROOT, "src/shared/notion-archive/readback.ts"),
  sharedPageFile: join(REPO_ROOT, "src/shared/notion-archive/page-file.ts"),
  sharedSha256: join(REPO_ROOT, "src/shared/sha256.ts"),
  sharedClient: join(REPO_ROOT, "src/shared/notion-archive/client.ts"),
  sharedEnv: join(REPO_ROOT, "src/shared/notion-archive/env.ts"),
  pnpmLock: join(REPO_ROOT, "pnpm-lock.yaml"),
};

export class HoldError extends Error {
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

function writePrivate(path: string, data: string): string {
  writeFileSync(path, data, { mode: 0o600 });
  return sha256Hex(data);
}

/** 追記 + fsync。 */
export function durableAppend(path: string, line: string): void {
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, line + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** grant-first: Root explicit grant なしに実行しない (fetch 0 のまま HOLD)。 */
export function requireGrant(argv: string[]): string {
  const g = argv.find((a) => a.startsWith("--grant="))?.split("=")[1] ?? "";
  if (!g) hold("grant なし: --grant=<Root explicit grant> を明示すること");
  return g;
}

/** OUT 再利用の拒否 (replay/上書き防止)。 */
export function assertFreshOutDir(outDir: string): void {
  if (existsSync(outDir)) hold(`OUT 既存のため拒否 (replay/上書き防止): ${outDir}`);
}

export function assertModules(): { moduleSHAs: Record<string, string>; scriptFullSHA: string } {
  const moduleSHAs: Record<string, string> = {};
  let scriptFullSHA = "";
  for (const [k, p] of Object.entries(MODULE_FILES)) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(p);
    } catch {
      hold(`module 不在: ${k}`);
    }
    if (k === "closeSelf") {
      scriptFullSHA = sha256Hex(new Uint8Array(bytes));
      bytes = Buffer.from(
        bytes.toString("utf8").replace(/closeSelf: "[0-9a-f]{64}"/, 'closeSelf: "TODO"'),
        "utf8"
      );
    }
    const got = sha256Hex(new Uint8Array(bytes));
    if (got !== PINS.modules[k]) {
      hold(`${k} module pin外: got=${got.slice(0, 16)}…`);
    }
    moduleSHAs[k] = got;
  }
  return { moduleSHAs, scriptFullSHA };
}

export interface ClosePacketRow {
  key: string;
  pageId: string;
  file: string | null;
  kind: string | null;
  /** Tier A: metadata 記録値。Tier B: null。 */
  bytes: number | null;
  sha256: string | null;
  edinetDocType: number | null;
  local: {
    path: string | null;
    exists: boolean;
    conventional?: boolean;
    size?: number;
    sha256?: string;
    sizeMatch?: boolean | null;
    shaMatch?: boolean | null;
  };
}

export interface CloseScope {
  /** 閉鎖対象 64 (packet 順)。 */
  scope: ClosePacketRow[];
  /** Tier C 5 (byte source なし・除外 HOLD)。 */
  held: ClosePacketRow[];
}

export function dashless(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

function isNotionId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-fA-F-]{32,36}$/.test(id) && /^[0-9a-f]{32}$/.test(dashless(id));
}

/**
 * Hash-first packet 読込 + 形状証明 (69 行・scope 64・Tier A59/B5/C5)。
 * packet の source/provenance/raw-local 記録は不変 (読むだけ)。
 */
export function loadPacket(packetPath: string, packetSHA: string): CloseScope {
  let raw: Buffer;
  try {
    raw = readFileSync(packetPath);
  } catch {
    hold(`packet 不在: ${packetPath}`);
  }
  if (sha256Hex(new Uint8Array(raw)) !== packetSHA) {
    hold("packet SHA 外 (physical-close-69 不一致)");
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw.toString("utf8"));
  } catch {
    hold("packet JSON 破損");
  }
  return assertPacketShape(obj);
}

export function assertPacketShape(obj: unknown): CloseScope {
  const rows = (obj as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length !== ROWS_TOTAL) hold(`packet 行数外: ${Array.isArray(rows) ? rows.length : "非配列"}`);
  const scope: ClosePacketRow[] = [];
  const held: ClosePacketRow[] = [];
  const seenKeys = new Set<string>();
  const seenPages = new Set<string>();
  let tierA = 0;
  let tierB = 0;
  for (const r of rows as Record<string, unknown>[]) {
    const key = r["key"];
    const pageId = r["pageId"];
    const file = r["file"];
    const kind = r["kind"];
    const local = r["local"] as ClosePacketRow["local"] | undefined;
    if (typeof key !== "string" || !/^.+?:type[15]$/.test(key)) hold("packet key 形状外");
    if (!isNotionId(pageId)) hold("packet pageId 形状外");
    if (typeof file !== "string" || file.length === 0) hold("packet file 形状外");
    if (kind !== "file") hold("packet kind 非hosted");
    if (seenKeys.has(key) || seenPages.has(dashless(pageId))) hold("packet key/page 重複");
    seenKeys.add(key);
    seenPages.add(dashless(pageId));
    if (!local || typeof local.exists !== "boolean") hold("packet local 形状外");
    const row = r as unknown as ClosePacketRow;
    if (!local.exists) {
      held.push(row);
      continue;
    }
    // Tier 分類: A = metadata anchor あり・B = 慣用 local のみ。
    if (local.conventional === true) {
      if (typeof local.size !== "number" || typeof local.sha256 !== "string") hold("packet TierB 観測値不足");
      tierB += 1;
    } else {
      if (typeof row.bytes !== "number" || typeof row.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.sha256)) {
        hold("packet TierA 記録値不足");
      }
      if (local.shaMatch !== true || local.sizeMatch !== true) hold("packet TierA inventory 未照合");
      tierA += 1;
    }
    scope.push(row);
  }
  if (scope.length !== SCOPE_N || held.length !== TIER_C_N || tierA !== TIER_A_N || tierB !== TIER_B_N) {
    hold(`packet scope 数外: scope=${scope.length} held=${held.length} A=${tierA} B=${tierB}`);
  }
  return { scope, held };
}

/**
 * 期待 bytes の local 読込 (network なし)。
 * Tier A: metadata bytes/SHA と照合 (不一致は HOLD)。
 * Tier B: inventory 観測 size/SHA と照合 (anchor なし・変化検出のみ)。
 */
export function loadExpectedBytes(row: ClosePacketRow): Uint8Array {
  const p = row.local.path;
  if (!row.local.exists || typeof p !== "string") hold(`期待原本なし (Tier C のはず): ${row.key}`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(p);
  } catch {
    hold(`期待原本不在: ${row.key}`);
  }
  if (row.local.conventional === true) {
    if (bytes.length !== row.local.size || sha256Hex(new Uint8Array(bytes)) !== row.local.sha256) {
      hold(`TierB 原本変化 (inventory 観測値不一致): ${row.key}`);
    }
    return new Uint8Array(bytes);
  }
  if (typeof row.bytes !== "number" || typeof row.sha256 !== "string") {
    hold(`TierA 記録値不足: ${row.key}`);
  }
  if (bytes.length !== row.bytes || sha256Hex(new Uint8Array(bytes)) !== row.sha256) {
    hold(`TierA 原本変化 (metadata 記録値不一致): ${row.key}`);
  }
  return new Uint8Array(bytes);
}

export interface GuardCounters {
  attempts: number;
  rejected: number;
  listing: number;
  hosted: number;
}

export interface GuardBindings {
  /** exact 64 pageIDs (dashless)。 */
  pageIds: ReadonlySet<string>;
}

const API_HOST = "api.notion.com";
const ID_SEG = "[A-Za-z0-9-]{32,36}";

/**
 * Read-only allow-list (閉鎖到達の2経路のみ)。
 * 許可: GET `/v1/pages/{id}` (query/body なし)・
 * GET hosted 観測 host (署名 query 不透明・各 URL 1 回)。
 * 拒否: search・POST・PATCH・DELETE・他 host・形状外全般。
 */
export function isAllowedRoute(method: string, url: URL): boolean {
  if (url.protocol !== "https:") return false;
  if (method.toUpperCase() !== "GET") return false;
  if (url.hostname === API_HOST) {
    return new RegExp(`^/v1/pages/${ID_SEG}$`).test(url.pathname) && url.search === "";
  }
  if (url.hostname === HOSTED_HOST) return true;
  return false;
}

/** 到達経路の tag (body 保存名用・ID なし)。 */
export function routeTag(url: URL): string {
  if (url.hostname === API_HOST) return "listing";
  if (url.hostname === HOSTED_HOST) return "hosted";
  return "other";
}

/**
 * Binding (allow-list の内側の第2関門)。
 * listing: pageID が exact 64 内 + body なし。
 * hosted: URL 単位で各 1 回 (重複は HOLD。再送なし)。
 */
export function assertRequestBindings(
  url: URL,
  init: RequestInit | undefined,
  bindings: GuardBindings,
  seenHosted: ReadonlySet<string>
): void {
  if (url.hostname === API_HOST) {
    const m = new RegExp(`^/v1/pages/(${ID_SEG})$`).exec(url.pathname);
    if (!m) hold("binding外: pages 形状外");
    if (init?.body !== undefined) hold("binding外: GET body 付き");
    if (!bindings.pageIds.has(dashless(m[1]))) hold("binding外: page 非packet64");
    return;
  }
  if (url.hostname === HOSTED_HOST) {
    if (init?.body !== undefined) hold("binding外: GET body 付き");
    if (seenHosted.has(url.href)) hold("binding外: hosted 重複 (各1回)");
    return;
  }
  hold("binding外: 未知 host");
}

/** whole-body wx0600 + fsync (capture idiom の小 wrapper)。 */
export function saveBodyWx(outDir: string, name: string, bytes: Uint8Array): string {
  const fd = openSync(join(outDir, name), "wx", 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return sha256Hex(bytes);
}

/**
 * Read-only guard (native の前)。
 * 順序: allow-list → binding → cap → reserve 行 fsync → forward
 * (redirect manual 強制)。listing の再送 (client 内部 retry) は
 * 同一 URL でも通す (cap 448 で有界)。hosted は各 URL 1 回のみ。
 * forward 後は同一 response を clone して判定の前に private 保存する。
 * 3xx は follow せず STOP。deny/cap/3xx/到達失敗は HOLD。
 */
export function createReadOnlyGuardFetch(
  inner: typeof fetch,
  outDir: string,
  counters: GuardCounters,
  bindings: GuardBindings
): typeof fetch {
  const seenHosted = new Set<string>();
  return (async (url: unknown, init?: RequestInit) => {
    let u: URL;
    try {
      u = new URL(String(url));
    } catch {
      counters.rejected += 1;
      throw new HoldError("close guard: URL 形状外のため送らない (詳細は private log 参照)");
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const tag = routeTag(u);
    const logLine = (line: Record<string, unknown>): void => {
      durableAppend(join(outDir, "guard-attempt.log"), JSON.stringify(line));
    };
    const deny = (why: string): never => {
      counters.rejected += 1;
      logLine({
        seq: counters.attempts + counters.rejected,
        decision: "deny",
        why,
        method,
        tag,
        host: u.hostname,
        path: u.pathname,
        at: new Date().toISOString(),
      });
      throw new HoldError(`close guard: 拒否のため送らない (${why}。詳細は private log 参照)`);
    };
    if (!isAllowedRoute(method, u)) deny("allow-list外");
    try {
      assertRequestBindings(u, init, bindings, seenHosted);
    } catch (e) {
      if (e instanceof HoldError) deny(e.message.replace(/^HOLD: /, ""));
      throw e;
    }
    if (tag === "hosted") {
      if (counters.hosted >= HOSTED_N) deny(`hosted cap外 (${HOSTED_N})`);
    } else if (counters.listing >= LISTING_CAP) {
      deny(`listing cap外 (${LISTING_CAP})`);
    }
    if (counters.attempts >= TOTAL_CAP) deny(`total cap外 (${TOTAL_CAP})`);
    counters.attempts += 1;
    if (tag === "hosted") {
      counters.hosted += 1;
      seenHosted.add(u.href);
    } else {
      counters.listing += 1;
    }
    const seq = counters.attempts + counters.rejected;
    // durable counter: forward の前に予約行を fsync する。
    logLine({
      seq, decision: "reserved", method, tag, host: u.hostname, path: u.pathname,
      at: new Date().toISOString(),
    });
    const fwdInit: RequestInit = { ...init, redirect: "manual" };
    let res: Response;
    try {
      res = await inner(url as string, fwdInit);
    } catch (e) {
      logLine({
        seq, decision: "forward-failed", method, tag, host: u.hostname, path: u.pathname,
        detail: String((e as Error)?.message ?? e), at: new Date().toISOString(),
      });
      throw new HoldError("close guard: native 到達失敗 (詳細は private log 参照)");
    }
    const receivedAt = new Date().toISOString();
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    const name = `attempt-${String(seq).padStart(3, "0")}-${tag}.bin`;
    const bodySHA = saveBodyWx(outDir, name, bytes);
    logLine({
      seq, decision: "captured", method, tag, host: u.hostname, path: u.pathname,
      status: res.status, bytes: bytes.length, bodySHA, file: name,
      contentType: res.headers.get("content-type"), contentLength: res.headers.get("content-length"),
      retryAfter: res.headers.get("retry-after"),
      receivedAt, at: new Date().toISOString(),
    });
    if (res.status >= 300 && res.status < 400) {
      logLine({ seq, decision: "redirect-stop", file: name, status: res.status, at: new Date().toISOString() });
      throw new HoldError("close guard: 3xx 受信のため STOP (follow なし。body 保存済み。詳細は private log 参照)");
    }
    return res;
  }) as typeof fetch;
}

async function main(): Promise<void> {
  const grant = requireGrant(process.argv);
  assertFreshOutDir(OUT_DIR);
  const { moduleSHAs, scriptFullSHA } = assertModules();
  if (!existsSync(ENV_FILE)) hold(`env-file 不在: ${ENV_FILE} (--env-file で指定)`);
  dotenv.config({ path: ENV_FILE, quiet: true });

  const nativeFetch = globalThis.fetch.bind(globalThis);
  const gate: GuardCounters = { attempts: 0, rejected: 0, listing: 0, hosted: 0 };
  const readbackMod = await import("../../../src/shared/notion-archive/readback.js");
  const { verifyArchivedAttachments } = readbackMod;
  const envMod = await import("../../../src/shared/notion-archive/env.js");
  const { notionEnv } = envMod;
  const statsMod = await import("../../../src/shared/notion-archive/index.js");
  const { notionStats, resetNotionStats } = statsMod;

  const { scope, held } = loadPacket(PACKET_PATH, PINS.packetSHA);
  try {
    notionEnv.NOTION_TOKEN();
  } catch {
    hold("notion env 不在 (NOTION_TOKEN)");
  }
  const bindings: GuardBindings = {
    pageIds: new Set(scope.map((r) => dashless(r.pageId))),
  };
  mkdirSync(OUT_DIR, { mode: 0o700, recursive: true });
  globalThis.fetch = createReadOnlyGuardFetch(nativeFetch, OUT_DIR, gate, bindings);

  resetNotionStats();
  const closed: Array<{ key: string; tier: string; bytes: number; sha256: string }> = [];
  try {
    for (const row of scope) {
      const expected = loadExpectedBytes(row);
      const tier = row.local.conventional === true ? "B-same-bytes-only" : "A-anchored";
      await verifyArchivedAttachments(
        row.pageId,
        [{ filename: row.file as string, bytes: expected }],
        `physical-close ${row.key}`
      );
      closed.push({ key: row.key, tier, bytes: expected.length, sha256: sha256Hex(expected) });
    }
  } catch (e) {
    writePrivate(
      join(OUT_DIR, "hold-detail.json"),
      JSON.stringify({ at: new Date().toISOString(), label: "physical close 失敗", closed: closed.length, detail: String((e as Error)?.message ?? e) })
    );
    hold("physical close 失敗 (fail-fast。詳細は private hold-detail.json 参照。attempt log 保持)");
  }
  if (closed.length !== SCOPE_N) hold(`閉鎖数外: ${closed.length}`);
  if (gate.hosted !== HOSTED_N) hold(`hosted 数外: ${gate.hosted}`);
  if (gate.attempts > TOTAL_CAP) hold(`total cap 外: ${gate.attempts}`);
  const stats = notionStats();

  const tierCounts: Record<string, number> = {};
  for (const c of closed) tierCounts[c.tier] = (tierCounts[c.tier] ?? 0) + 1;
  const workHead = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const logPath = join(OUT_DIR, "guard-attempt.log");
  if (!existsSync(logPath)) hold("attempt log 不在 (PASS 経路で到達不能のはず)");
  const attemptLogSHA = sha256Hex(new Uint8Array(readFileSync(logPath)));
  const bodyFiles = readdirSync(OUT_DIR).filter((f) => f.startsWith("attempt-") && f.endsWith(".bin")).sort();
  const findings = {
    at_start: STARTED_AT, at_end: new Date().toISOString(), result: "PASS",
    mode: "physical-close64", grant, workHEAD: workHead,
    scope: SCOPE_N, closed, held: held.map((r) => r.key),
    counts: { scope: SCOPE_N, tierA: TIER_A_N, tierB: TIER_B_N, tierC: TIER_C_N, tiers: tierCounts },
    scopeMeta: { packetSHA: PINS.packetSHA, modules: moduleSHAs, scriptFullSHA, listingCap: LISTING_CAP, hostedN: HOSTED_N, totalCap: TOTAL_CAP },
    gate,
    notionStats: stats,
    bodies: { count: bodyFiles.length, files: bodyFiles },
    attemptLogSHA,
    zeros: { search: 0, sourceGET: 0, d1read: 0, d1write: 0, r2: 0, dispatch: 0, writes: 0, records: 0 },
    limits: [
      "listing (GET pages exact 64) + hosted 64 each-once。strict verifyArchivedAttachments。",
      "Tier A = metadata-anchored same-bytes。Tier B = hosted↔local same-bytes のみ (official 適格化なし)。",
      "Tier C 5 は byte source なし・除外 HOLD。missing は fresh GET 必要性を意味しない。",
      "最初の verifier 失敗で STOP (fail-fast)。Unknown は再送しない。",
      "pageIDs・grant 文は 0600 のみ。stdout は counts/SHA のみ。",
      "READY 判定は Root (本 runner は same-bytes 閉鎖の成否のみ)。",
    ],
  };
  const findingsSHA = writePrivate(join(OUT_DIR, "close-findings.json"), JSON.stringify(findings, null, 2));

  console.info(JSON.stringify({
    result: "PASS", mode: "physical-close64", scope: SCOPE_N, closed: closed.length, held: held.length,
    tiers: tierCounts,
    packetSHA: PINS.packetSHA,
    modules: moduleSHAs, scriptFullSHA,
    gate, notionStats: stats, bodies: bodyFiles.length, attemptLogSHA,
    zeros: findings.zeros, limits: findings.limits,
    artifacts: {
      findings: { path: join(OUT_DIR, "close-findings.json"), sha256: findingsSHA },
      attemptLog: { path: logPath, sha256: attemptLogSHA },
    },
    at_end: findings.at_end,
  }));
}

/**
 * preflight: 純粋検証のみ (送信 0・FS 書込 0)。fetch は拒否で固定する。
 * pins + packet SHA + 形状 (64/59/5/5) + local 原本再照合 + TOKEN 存在。
 */
async function preflight(): Promise<void> {
  globalThis.fetch = (() => {
    throw new Error("preflight: network fetch denied");
  }) as typeof fetch;
  const { moduleSHAs, scriptFullSHA } = assertModules();
  const { scope, held } = loadPacket(PACKET_PATH, PINS.packetSHA);
  // local 原本の再照合 (Tier A: metadata / Tier B: inventory 観測値)。
  let tierA = 0;
  let tierB = 0;
  let bytesTotal = 0;
  for (const row of scope) {
    const expected = loadExpectedBytes(row);
    bytesTotal += expected.length;
    if (row.local.conventional === true) tierB += 1;
    else tierA += 1;
  }
  if (!existsSync(ENV_FILE)) hold(`env-file 不在: ${ENV_FILE}`);
  dotenv.config({ path: ENV_FILE, quiet: true });
  const envMod = await import("../../../src/shared/notion-archive/env.js");
  try {
    envMod.notionEnv.NOTION_TOKEN();
  } catch {
    hold("notion env 不在 (NOTION_TOKEN)");
  }
  console.info(JSON.stringify({
    result: "PREFLIGHT", sends: 0, writes: 0,
    mode: "physical-close64",
    packet: { rows: ROWS_TOTAL, scope: scope.length, held: held.length, tierA, tierB, tierC: held.length, bytesTotal },
    packetSHA: PINS.packetSHA,
    modules: moduleSHAs, scriptFullSHA,
    notionEnv: "present",
    budget: { listingCap: LISTING_CAP, hostedN: HOSTED_N, totalCap: TOTAL_CAP },
  }));
}

// CLI 実行時のみ main()/preflight() を走らせる。
const isCliMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliMain) {
  try {
    if (process.argv.includes("--preflight")) {
      await preflight();
      process.exit(0);
    }
    await main();
    process.exit(0);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ at_start: STARTED_AT, at_end: new Date().toISOString(), result: "HOLD", reason }));
    process.exit(1);
  }
}
