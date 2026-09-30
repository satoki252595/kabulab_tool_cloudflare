/**
 * Source-custody query runner round1 (query-only, 20 docs / 40 keys).
 *
 * 既存 helper `checkDocsCustody(service, docIDs)` を使い、1 chunk
 * (20 通・`{doc}:type1`/`:type5` の 40 keys) の TypeCustody を照会する。
 * verdict は行プロパティ由来 (complete = 行存在 + hosted fileCount>0)。
 *
 * Query-only の強制: read-only route guard を native の前に置き、
 * allow-list (POST /v1/search・GET /v1/blocks/{id}/children・
 * POST /v1/databases/{id}/query・GET /v1/databases/{id}) 以外を
 * 送らず HOLD する。特に POST /v1/databases (ensureDatabase の
 * CREATE 経路)・POST /v1/pages・PATCH・DELETE は拒否する。
 * DB 不在は CREATE せず HOLD する (fail-closed)。
 * さらに body/query を exact 値へ束縛する (query filter 全 key が
 * manifest 40 内・page_size 厳密・search title/filter 固定・
 * children 親 typed 一致・DB id 単一 pin)。
 *
 * Redirect: 同一 request に redirect manual を強制し、3xx は
 * follow せず STOP する (default follow の boundary bypass を塞ぐ)。
 * STOP 判定の前に受信 body を保存する (失敗 response も証跡)。
 *
 * Capture: forward した同一 response を clone し、HTTP bytes +
 * status/safe headers (content-type/length・retry-after のみ。
 * session/cookie 系なし)/actual clock を helper 判定の前に
 * private 保存する (余分 GET なし。次段 closure・lookup 証跡用。
 * 全行 NULL/metadata を保全し、projection で代替しない)。
 *
 * Caps (closed): native 試行 ≤ 96 (導出: 論理 worst
 * search ≤4 + scan ≤5 + query 1 + schema 1 = 11 × retry 乗数 7
 * (MAX_RETRY 6) = 77 + 余白 19。超過は HOLD)。
 * helper 内の 41 は query ROWS 上限 (has_more で HOLD)。
 * listing/DL は本 round の範囲外 (別 stage・別 caps)。
 *
 * complete ≠ same-bytes 検証済み。full-ZIP readback
 * (listing + hosted DL + length/SHA) は別途 future stage。
 * primary READY は query-only のため常に 0 (complete でも適格化しない)。
 * Unknown は再送しない (shared client 契約)。
 *
 * fixed scope: docs 厳密 20・keys 厳密 40 (key manifest SHA 照合)。
 * grant-first・OUT-fresh・durable attempt log (0600 fsync)。
 * stdout は counts/SHA のみ (docIDs・pageId は 0600 のみ)。
 */
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

const PACKET_FILE = argValue(
  "packet",
  "/tmp/overseas-current3675-compare2-20260930/custody-keys-20.json"
);
const OUT_DIR = argValue("out-dir", "/tmp/overseas-custody-query-20260930");
const ENV_FILE = argValue("env-file", join(REPO_ROOT, ".env"));
const STARTED_AT = new Date().toISOString();

const SERVICE = "yuho-quant";
const ROUND_DOCS = 20;
const ROUND_KEYS = 40;
const NOTION_ATTEMPT_CAP = 96;

const PINS = {
  keyManifestSHA: "f2f348d51e311ec57f9ecbd7e90125fe89877f331dc07f8676f30907ac76158f",
  parentSHA: "4896af08d92d1510861d6288ea92080b1d1548f48a8c2ee20d3ed08d01da2205",
  // module pins は全て file bytes の full SHA256 (git blob 40char ではない)。
  modules: {
    custodySelf: "482e65f28bc0a5aee16b4b9bc322b55279f76d6030f35902f095cc8cb4f73649",
    edinetArchive: "a02f24f632ea6309a68899bc59b2c3760b2fd7686f26501894f7f5fc7c53fbc5",
    sharedArchive: "b4388151a2aa36cd6b70fabd4c22d1451641b39c7e7475e6b6c0e109573c5edf",
    sharedClient: "4a7f780053ad4bce844e40323e75f4d1713bc1a0c5affe8e4710002192346754",
    sharedEnv: "de8449e3b8c5c217e206acac92ca3bfab5005d4a5fef3c7c0608f42a1f4ae1c0",
    pnpmLock: "805dd5b36ca9ec385b29de1ded715305537eac514dbc7c77dfc55b2d56617e58",
  } as Record<string, string>,
};

const SELF_PATH = fileURLToPath(import.meta.url);
const MODULE_FILES: Record<string, string> = {
  custodySelf: SELF_PATH,
  edinetArchive: join(REPO_ROOT, "services/yuho-quant/src/services/edinet/archive.ts"),
  sharedArchive: join(REPO_ROOT, "src/shared/notion-archive/archive.ts"),
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
  if (g === "") hold("grant 不在: Root explicit grant なしに実行しない (--grant=<Root承認文>)");
  return g;
}

/** OUT 再利用の拒否 (replay/上書き防止)。 */
export function assertFreshOutDir(outDir: string): void {
  if (existsSync(outDir)) hold(`OUT 既存のため拒否 (replay/上書き防止): ${outDir}`);
}

export interface GuardCounters {
  attempts: number;
  rejected: number;
}

/** request binding (round1 固定・body/query を exact 値へ束縛)。 */
export interface GuardBindings {
  manifestKeys: ReadonlySet<string>;
  typedParentDashless: string;
  expectedTitle: string;
}

export function dashless(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

const API_HOST = "api.notion.com";
const API_PROTO = "https:";
const ID_SEG = "[A-Za-z0-9-]{32,36}";

/**
 * Read-only allow-list (round1 の到達経路のみ)。
 * 許可: POST /v1/search・POST /v1/databases/{id}/query・
 * GET /v1/databases/{id}・GET /v1/blocks/{id}/children
 * (後者のみ start_cursor/page_size の query 許可)。
 * 拒否: POST /v1/databases・POST /v1/pages・PATCH・DELETE・
 * 非 Notion host・形状外 (空 ID・traversal・余分 params 含む)。
 */
export function isAllowedRoute(method: string, url: URL): boolean {
  if (url.protocol !== API_PROTO || url.hostname !== API_HOST) return false;
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "POST") return false;
  const p = url.pathname;
  if (m === "POST" && p === "/v1/search" && url.search === "") return true;
  if (
    m === "POST" &&
    new RegExp(`^/v1/databases/${ID_SEG}/query$`).test(p) &&
    url.search === ""
  ) {
    return true;
  }
  if (
    m === "GET" &&
    new RegExp(`^/v1/databases/${ID_SEG}$`).test(p) &&
    url.search === ""
  ) {
    return true;
  }
  if (m === "GET" && new RegExp(`^/v1/blocks/${ID_SEG}/children$`).test(p)) {
    for (const k of url.searchParams.keys()) {
      if (k !== "start_cursor" && k !== "page_size") return false;
    }
    return true;
  }
  return false;
}

/** round1 到達経路の tag (body 保存名用・ID なし)。 */
export function routeTag(method: string, path: string): string {
  if (method === "POST" && path === "/v1/search") return "search";
  if (method === "POST" && path.endsWith("/query")) return "query";
  if (method === "GET" && path.endsWith("/children")) return "children";
  if (method === "GET") return "dbget";
  return "other";
}

/**
 * Body/query の exact binding (allow-list の内側の第2関門)。
 * query: body filter の全 key が manifest 40 内 + page_size 厳密 41 +
 * DB id の単一 pin (初回確定・以後 drift 拒否)。
 * search: query が backup DB title 厳密一致 + filter database +
 * page_size 厳密 100 (start_cursor のみ可変)。
 * children: 親が typed parent 厳密一致 (dashless)。
 * dbget: pin 済み DB id 厳密一致 (未 pin 時は到達不能として拒否)。
 */
export function assertRequestBindings(
  method: string,
  url: URL,
  init: RequestInit | undefined,
  bindings: GuardBindings,
  pinnedDbId: string | null
): string | null {
  const p = url.pathname;
  const seg = (re: RegExp): string | null => {
    const m = re.exec(p);
    return m ? m[1] : null;
  };
  if (method === "POST" && p === "/v1/search") {
    const body = parseJsonBody(init);
    if (body["query"] !== bindings.expectedTitle) hold("binding外: search query 非固定");
    const filter = body["filter"] as Record<string, unknown> | undefined;
    if (!filter || filter["property"] !== "object" || filter["value"] !== "database") {
      hold("binding外: search filter 非固定");
    }
    if (body["page_size"] !== 100) hold("binding外: search page_size 非固定");
    for (const k of Object.keys(body)) {
      if (k !== "query" && k !== "filter" && k !== "page_size" && k !== "start_cursor") {
        hold("binding外: search 余分 key");
      }
    }
    return pinnedDbId;
  }
  const qid = method === "POST" ? seg(/^\/v1\/databases\/([A-Za-z0-9-]{32,36})\/query$/) : null;
  if (qid) {
    const body = parseJsonBody(init);
    if (body["page_size"] !== 41) hold("binding外: query page_size 非41");
    const filter = body["filter"] as Record<string, unknown> | undefined;
    const or = filter?.["or"];
    if (!filter || !Array.isArray(or) || or.length === 0) hold("binding外: query filter 非OR");
    for (const e of or as unknown[]) {
      const r = e as Record<string, unknown>;
      const title = r?.["title"] as Record<string, unknown> | undefined;
      const key = title?.["equals"];
      if (r?.["property"] !== "Key" || typeof key !== "string" || !bindings.manifestKeys.has(key)) {
        hold("binding外: query key 非manifest");
      }
    }
    if (pinnedDbId === null) return qid;
    if (qid !== pinnedDbId) hold("binding外: DB drift");
    return pinnedDbId;
  }
  const cid = method === "GET" ? seg(/^\/v1\/blocks\/([A-Za-z0-9-]{32,36})\/children$/) : null;
  if (cid) {
    if (init?.body !== undefined) hold("binding外: GET body 付き");
    if (dashless(cid) !== bindings.typedParentDashless) hold("binding外: 親非typed");
    if (url.searchParams.get("page_size") !== null && url.searchParams.get("page_size") !== "100") {
      hold("binding外: children page_size 非固定");
    }
    return pinnedDbId;
  }
  const gid = method === "GET" ? seg(/^\/v1\/databases\/([A-Za-z0-9-]{32,36})$/) : null;
  if (gid) {
    if (init?.body !== undefined) hold("binding外: GET body 付き");
    if (pinnedDbId === null || gid !== pinnedDbId) hold("binding外: DB 未pin/不一致");
    return pinnedDbId;
  }
  hold("binding外: 未知経路");
}

function parseJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  const b = init?.body;
  if (typeof b !== "string") hold("binding外: body 非string");
  try {
    const v: unknown = JSON.parse(b as string);
    if (!v || typeof v !== "object" || Array.isArray(v)) hold("binding外: body 非object");
    return v as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HoldError) throw e;
    hold("binding外: body 非JSON");
  }
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
 * 順序: allow-list → binding → cap → forward (redirect manual 強制)。
 * forward 後は同一 response を clone して HTTP bytes + safe 状態を
 * helper 判定の前に private 保存する (次段 closure・lookup 証跡用。
 * 余分 GET なし)。3xx は follow せず STOP する。
 * deny/cap/3xx/到達失敗は送らず (or 送り返さず) HOLD する。
 * reject 理由の stdout/stderr 表現は safe label のみ。
 */
export function createReadOnlyGuardFetch(
  inner: typeof fetch,
  outDir: string,
  counters: GuardCounters,
  cap: number,
  bindings: GuardBindings
): typeof fetch {
  let pinnedDbId: string | null = null;
  return (async (url: unknown, init?: RequestInit) => {
    let u: URL;
    try {
      u = new URL(String(url));
    } catch {
      counters.rejected += 1;
      throw new HoldError("query guard: URL 形状外のため送らない (詳細は private log 参照)");
    }
    const method = (init?.method ?? "GET").toUpperCase();
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
        host: u.hostname,
        path: u.pathname,
        at: new Date().toISOString(),
      });
      throw new HoldError(`query guard: 拒否のため送らない (${why}。詳細は private log 参照)`);
    };
    if (!isAllowedRoute(method, u)) deny("allow-list外");
    try {
      pinnedDbId = assertRequestBindings(method, u, init, bindings, pinnedDbId);
    } catch (e) {
      if (e instanceof HoldError) deny(e.message.replace(/^HOLD: /, ""));
      throw e;
    }
    if (counters.attempts >= cap) deny(`attempt cap外 (${cap})`);
    counters.attempts += 1;
    const seq = counters.attempts + counters.rejected;
    // redirect manual を同一 request に強制し、default follow の
    // boundary bypass を塞ぐ。
    const fwdInit: RequestInit = { ...init, redirect: "manual" };
    let res: Response;
    try {
      res = await inner(url as string, fwdInit);
    } catch (e) {
      logLine({
        seq, decision: "forward-failed", method, host: u.hostname, path: u.pathname,
        detail: String((e as Error)?.message ?? e), at: new Date().toISOString(),
      });
      throw new HoldError("query guard: native 到達失敗 (詳細は private log 参照)");
    }
    // 受信した全 response (失敗含む) を判定の前に保存する。3xx の
    // STOP 判定は保存後に行う (follow なし・余分 GET なし)。
    const tag = routeTag(method, u.pathname);
    const receivedAt = new Date().toISOString();
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    const name = `attempt-${String(seq).padStart(3, "0")}-${tag}.bin`;
    const bodySHA = saveBodyWx(outDir, name, bytes);
    logLine({
      seq, decision: "captured", method, host: u.hostname, path: u.pathname,
      status: res.status, bytes: bytes.length, bodySHA, file: name,
      contentType: res.headers.get("content-type"), contentLength: res.headers.get("content-length"),
      retryAfter: res.headers.get("retry-after"),
      receivedAt, at: new Date().toISOString(),
    });
    if (res.status >= 300 && res.status < 400) {
      logLine({ seq, decision: "redirect-stop", file: name, status: res.status, at: new Date().toISOString() });
      throw new HoldError("query guard: 3xx 受信のため STOP (follow なし。body 保存済み。詳細は private log 参照)");
    }
    return res;
  }) as typeof fetch;
}

export interface CustodyPacket {
  docs: string[];
  keys: string[];
}

const DOC_SHAPE = /^S[0-9A-Z]{7}$/;

/**
 * Hash-first packet 読込: 40 exact keys の SHA 照合 + docs 導出の
 * 形状証明 (20 通・各通 type1+type5・key 再導出一致)。補完なし。
 */
export function loadPacket(
  path: string,
  keyFn: (docID: string, type: 1 | 5) => string
): CustodyPacket {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    hold(`packet 不在: ${path}`);
  }
  if (sha256Hex(new Uint8Array(raw)) !== PINS.keyManifestSHA) {
    hold("packet SHA 外 (round1 key manifest 不一致)");
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw.toString("utf8"));
  } catch {
    hold("packet JSON 破損");
  }
  return assertPacketShape(obj, keyFn);
}

/**
 * Packet 形状証明 (純粋・SHA 照合後)。20 通・40 keys・各通対・
 * key 再導出一致。補完なし。
 */
export function assertPacketShape(
  obj: unknown,
  keyFn: (docID: string, type: 1 | 5) => string
): CustodyPacket {
  const rec = obj as Record<string, unknown>;
  if (!rec || typeof rec !== "object" || !Array.isArray(rec["keys"])) hold("packet keys 非配列");
  const keys = rec["keys"] as unknown[];
  if (keys.length !== ROUND_KEYS) hold(`packet keys 数外: ${keys.length}`);
  if (rec["service"] !== SERVICE) hold("packet service 外");
  const docs: string[] = [];
  for (const k of keys) {
    if (typeof k !== "string") hold("packet key 非string");
    const m = /^(.+):type([15])$/.exec(k);
    if (!m || !DOC_SHAPE.test(m[1])) hold("packet key 形状外");
    docs.push(m[1]);
  }
  const uniq = [...new Set(docs)].sort();
  if (uniq.length !== ROUND_DOCS) hold(`packet docs 数外: ${uniq.length}`);
  for (const d of uniq) {
    const t1 = `${d}:type1`;
    const t5 = `${d}:type5`;
    if (!keys.includes(t1) || !keys.includes(t5)) hold("packet key 対欠落");
    if (keyFn(d, 1) !== t1 || keyFn(d, 5) !== t5) hold("packet key 再導出不一致");
  }
  return { docs: uniq, keys: keys as string[] };
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
    if (k === "custodySelf") {
      scriptFullSHA = sha256Hex(new Uint8Array(bytes));
      bytes = Buffer.from(
        bytes.toString("utf8").replace(/custodySelf: "[0-9a-f]{64}"/, 'custodySelf: "TODO"'),
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

const CUSTODY_DOMAIN = ["complete", "metadata-only", "missing", "not-applicable"] as const;

async function main(): Promise<void> {
  const grant = requireGrant(process.argv);
  assertFreshOutDir(OUT_DIR);
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  chmodSync(OUT_DIR, 0o700);

  // 先に file/env の純粋検証 (fetch なし) を済ませ、binding を確定して
  // から guard を native の前に設置し、repo runtime を load する。
  const { moduleSHAs, scriptFullSHA } = assertModules();
  if (!existsSync(ENV_FILE)) hold(`env-file 不在: ${ENV_FILE} (--env-file で指定)`);
  dotenv.config({ path: ENV_FILE, quiet: true });

  const nativeFetch = globalThis.fetch.bind(globalThis);
  const gate: GuardCounters = { attempts: 0, rejected: 0 };
  const edinetMod = await import("../src/services/edinet/archive.js");
  const { checkDocsCustody, edinetArchiveKey } = edinetMod;
  const envMod = await import("../../../src/shared/notion-archive/env.js");
  const { notionEnv } = envMod;
  const statsMod = await import("../../../src/shared/notion-archive/index.js");
  const { notionStats, resetNotionStats } = statsMod;

  const packet = loadPacket(PACKET_FILE, edinetArchiveKey);
  let parentId: string;
  try {
    notionEnv.NOTION_TOKEN();
    parentId = notionEnv.NOTION_ARCHIVE_PAGE_ID() as string;
  } catch {
    hold("notion env 不在 (NOTION_TOKEN / NOTION_ARCHIVE_PAGE_ID)");
  }
  const parentSHA = sha256Hex(parentId);
  if (parentSHA !== PINS.parentSHA) hold("typed parent 外 (canonical target 不一致)");
  const bindings: GuardBindings = {
    manifestKeys: new Set(packet.keys),
    typedParentDashless: dashless(parentId),
    expectedTitle: `一次データ｜${SERVICE}`,
  };
  globalThis.fetch = createReadOnlyGuardFetch(nativeFetch, OUT_DIR, gate, NOTION_ATTEMPT_CAP, bindings);

  resetNotionStats();
  let verdicts: Map<string, { t1: string; t5: string }>;
  try {
    verdicts = await checkDocsCustody(SERVICE, packet.docs);
  } catch (e) {
    writePrivate(
      join(OUT_DIR, "hold-detail.json"),
      JSON.stringify({ at: new Date().toISOString(), label: "custody query 失敗", detail: String((e as Error)?.message ?? e) })
    );
    hold("custody query 失敗 (詳細は private hold-detail.json 参照。attempt log 保持)");
  }
  if (verdicts.size !== ROUND_DOCS) hold(`verdict 数外: ${verdicts.size}`);
  for (const d of packet.docs) {
    const v = verdicts.get(d);
    if (!v || !CUSTODY_DOMAIN.includes(v.t1 as never) || !CUSTODY_DOMAIN.includes(v.t5 as never)) {
      hold("verdict 形状外 (通欠落・値域外)");
    }
  }
  if (gate.attempts > NOTION_ATTEMPT_CAP) hold(`attempt cap 外: ${gate.attempts}`);
  const stats = notionStats();

  const t1: Record<string, number> = {};
  const t5: Record<string, number> = {};
  for (const v of verdicts.values()) {
    t1[v.t1] = (t1[v.t1] ?? 0) + 1;
    t5[v.t5] = (t5[v.t5] ?? 0) + 1;
  }
  const workHead = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const logPath = join(OUT_DIR, "guard-attempt.log");
  if (!existsSync(logPath)) hold("attempt log 不在 (PASS 経路で到達不能のはず)");
  const attemptLogSHA = sha256Hex(new Uint8Array(readFileSync(logPath)));
  const bodyFiles = readdirSync(OUT_DIR).filter((f) => f.startsWith("attempt-") && f.endsWith(".bin")).sort();
  const findings = {
    at_start: STARTED_AT, at_end: new Date().toISOString(), result: "PASS",
    mode: "custody-query-round1", grant, workHEAD: workHead, service: SERVICE,
    ready: 0,
    docs: packet.docs,
    verdicts: [...verdicts.entries()].map(([doc, v]) => ({ doc, ...v })),
    counts: { docs: ROUND_DOCS, keys: ROUND_KEYS, t1, t5 },
    scope: { keyManifestSHA: PINS.keyManifestSHA, parentSHA, modules: moduleSHAs, scriptFullSHA, attemptCap: NOTION_ATTEMPT_CAP },
    gate,
    notionStats: stats,
    bodies: { count: bodyFiles.length, files: bodyFiles },
    attemptLogSHA,
    zeros: { sourceGET: 0, d1read: 0, d1write: 0, r2: 0, dispatch: 0, writes: 0 },
    limits: [
      "query-only round1 (20 docs/40 keys)。TypeCustody は行プロパティ由来。",
      "complete = 行存在 + hosted fileCount>0。same-bytes 検証ではない。",
      "primary READY 0 (query-only。complete でも適格化しない)。",
      "full-ZIP readback (listing + hosted DL + length/SHA) は別途 future stage (別 caps)。",
      "attempt cap 96 = native 試行 (retry 乗数込)。超過・deny・DB 不在は HOLD (CREATE なし)。",
      "Unknown は再送しない (shared client 契約)。",
      "docIDs・grant 文は 0600 のみ。stdout は counts/SHA のみ。",
    ],
  };
  const findingsSHA = writePrivate(join(OUT_DIR, "custody-findings.json"), JSON.stringify(findings, null, 2));

  console.info(JSON.stringify({
    result: "PASS", service: SERVICE, docs: ROUND_DOCS, keys: ROUND_KEYS, ready: 0,
    t1, t5,
    keyManifestSHA: PINS.keyManifestSHA, parentSHA,
    modules: moduleSHAs, scriptFullSHA,
    gate, notionStats: stats, bodies: bodyFiles.length, attemptLogSHA,
    zeros: findings.zeros, limits: findings.limits,
    artifacts: {
      findings: { path: join(OUT_DIR, "custody-findings.json"), sha256: findingsSHA },
      attemptLog: { path: logPath, sha256: attemptLogSHA },
    },
    at_end: findings.at_end,
  }));
}

/**
 * preflight: 純粋検証のみ (送信 0・FS 書込 0)。fetch は拒否で固定する。
 * pins + packet SHA + key 導出 + typed env (TOKEN + PAGE_ID + parentSHA)。
 */
async function preflight(): Promise<void> {
  globalThis.fetch = (() => {
    throw new Error("preflight: network fetch denied");
  }) as typeof fetch;
  const edinetMod = await import("../src/services/edinet/archive.js");
  const { edinetArchiveKey } = edinetMod;
  const envMod = await import("../../../src/shared/notion-archive/env.js");
  const { notionEnv } = envMod;
  const { moduleSHAs, scriptFullSHA } = assertModules();
  const packet = loadPacket(PACKET_FILE, edinetArchiveKey);
  if (!existsSync(ENV_FILE)) hold(`env-file 不在: ${ENV_FILE}`);
  dotenv.config({ path: ENV_FILE, quiet: true });
  let parentSHA: string;
  try {
    notionEnv.NOTION_TOKEN();
    parentSHA = sha256Hex(notionEnv.NOTION_ARCHIVE_PAGE_ID() as string);
  } catch {
    hold("notion env 不在 (NOTION_TOKEN / NOTION_ARCHIVE_PAGE_ID)");
  }
  if (parentSHA !== PINS.parentSHA) hold("typed parent 外 (canonical target 不一致)");
  console.info(JSON.stringify({
    result: "PREFLIGHT", sends: 0, writes: 0,
    service: SERVICE, docs: packet.docs.length, keys: packet.keys.length,
    keyManifestSHA: PINS.keyManifestSHA, parentSHA,
    modules: moduleSHAs, scriptFullSHA,
    notionEnv: "present",
    budget: { notionAttempts: NOTION_ATTEMPT_CAP, queryRows: 41 },
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
