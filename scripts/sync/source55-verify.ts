/**
 * source55 same-run verification (手動実行・未実行)。
 *
 * 既存 PR197 `loadRepairCustody` をそのまま呼び、固定 diag バッチの
 * 55 添付 (Chart 原文 54 + manifest 1) を Notion hosted から再取得して
 * 再照合する。Yahoo 0・D1 0・Notion mutation 0 (read-only)。
 * custody 本体 (件数・名前集合・manifest pinned-SHA・コード別 full-bytes
 * SHA・complete・未試行残・集合一致) の判定は既存 helper が行い、
 * 本 runner は native 上限の送信前強制と証跡だけを持つ。
 * 新規 framework・verifier・runner 機構は持たない。
 *
 * gate は archive adapter (`owner-2read-archive.ts` の createNotionGateFetch。
 * C baseline 抽出 + 固定差分) と同一機構で、route 表だけ read-only に
 * 絞る。判定は全て送信前。超過・表外・二重・redirect は送らず/追随せず STOP。
 *
 * 順序:
 * 0. attemptLog と reportOut が両方 absent でなければ開始しない
 *    (既存は fetch 前に STOP。unknown replay 防止)。
 *    対象 diag key は固定 (override なし)。
 * 1. preflight0 (local bytes のみ。送信 0・network 0):
 *    既存 const と frozen pin の一致・凍結 artifact 10 件の bytes/SHA・
 *    module pins 10 件・canonical env 存在。不一致は送信 0 で STOP
 *    (failPreflight 表記は preflight 専用。実行後の失敗は送信件数を主張しない)。
 * 2. gate を全 native 試行の前に設置 (pagination/retry 含む全 fetch
 *    が通過)。attempt log は事前確定 (creat + dir fsync) の上、
 *    forward 前に毎回 fsync 記録する。
 * 3. `loadRepairCustody()` 1 回。gate は全応答の SAME whole-body を
 *    helper 判定より前に wx0600+fsync で clone 保存 (API 応答も同一
 *    idiom。追加 GET なし)。3xx も raw 保存 + meta 記録の後に STOP
 *    (追随しない)。meta は status/bytes/SHA + 観測 finalUrl +
 *    requestedAt/receivedAt + allowlist 応答 header (cookie/auth なし)。
 *    既存の strict 照合が全件通過しなければ
 *    helper が throw して STOP (再送なし)。helper の失敗文は per-code
 *    詳細を含むため private 証跡へ退避し、stdout には safe label のみ。
 * 4. 保存 bytes を読み戻して manifest pin と照合 (SAME retention 確定)。
 *    保存 bytes を既存 replayRawBar で offline replay し、expected-40
 *    pin と既存 ohlcvSevenEqual で 40/40 照合する (追加 GET なし。
 *    chart の代替 parse なし)。不一致は明細を private へ退避して STOP。
 * 5. 照合済み custody の集計を private full report (wx0600+fsync) に
 *    persist してから public 集計を stdout へ出す。
 *
 * native 上限 (gate で送信前強制。logical 数と別会計。文書の単独主張なし):
 * - API 計 77・hosted 計 55 (exact)。
 * - rule 別 (attempts 会計。1 call ≤7 attempts = 初回 + retry 6):
 *   search ≤28 (cursor 4 頁×7)・children-scan ≤35 (helper 内 max 5 頁×7)・
 *   db-query ≤7 (1 call×7)・page-get ≤7 (1 call×7)。
 * - CREATE 系 (POST /pages・/databases・/file_uploads*)・PATCH・DELETE・
 *   complete・users-me・未知 path は表外として全面拒否。
 * - hosted は GET のみ・URL 毎 1 回。API/hosted とも redirect manual。
 *   3xx は追随せず STOP。非 2xx は既存 helper の契約で STOP。
 * - 全試行の前に durable attempt 記録。超過は STOP・再送なし。
 * - notionStats は計測のみ (enforcement 主張なし)。delta を返す。
 *
 * env は typed canonical (sharedEnv) のみ。dotenv は読まない
 * (canonical は node --env-file で渡す。2READ/archive と同一手順)。
 * stdout は counts/SHA のみ。pageId・URL・per-code 値/ID は出さない。
 * live 実行は `--execute --grant=<Root承認文>` が無いと起動しない。
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPAIR_DIAG_FILES,
  REPAIR_DIAG_KEY,
  REPAIR_DIAG_MANIFEST_SHA256,
  loadRepairCustody,
  ohlcvSevenEqual,
  replayRawBar,
  type OhlcvSeven,
} from "./stock-gap-repair.js";
import { API_BASE, notionStats, resetNotionStats } from "../../src/shared/notion-archive/client.js";
import { notionEnv } from "../../src/shared/notion-archive/env.js";

/** frozen pins (既存 const と preflight0 で突合)。 */
export const VERIFY_DIAG_KEY = "price-sync-diag-20260929-local-1790720602657";
export const VERIFY_DIAG_FILES = 55;
export const VERIFY_DIAG_CODES = 54;
export const VERIFY_DIAG_MANIFEST_SHA256 =
  "f509f5dbc2e1838d9073067b9b7059de8cee760ac4878f1da3df63f8e1af894d";

/** 凍結 artifact 10 件 (bytes + SHA。preflight0 で照合)。 */
export const PINNED_VERIFY_ARTIFACTS = {
  expectedPost: {
    path: "/tmp/price40-prep-20260930/expected-post-40-full.json",
    bytes: 5205,
    sha256: "5b722925d32371e81275ad1e2b9f7512771465d8b29f6d2fc5b27604727d3b15",
  },
  bodyHashes: {
    path: "/tmp/price40-prep-20260930/body-hashes.json",
    bytes: 3704,
    sha256: "24459b167e0284e69fd2d0f2d3427cb7479e9cb34db09e4aee79375037de771c",
  },
  tuples: {
    path: "/tmp/price40-prep-20260930/tuples.json",
    bytes: 2078,
    sha256: "af861e0d2e65f38b749c3c6f188bf93394df3227cb30a4f1215b200692851505",
  },
  chunkPlan: {
    path: "/tmp/price40-prep-20260930/chunk-plan.json",
    bytes: 1161,
    sha256: "fcfb7bcc2524140188a900977b8b6d18087617660f0c858d0e8b1d3a37254248",
  },
  budget: {
    path: "/tmp/price40-prep-20260930/budget.json",
    bytes: 1074,
    sha256: "7efbbe88d50a8f1b04036caedb12a627c101937b3f0e24fe564a263116e885ad",
  },
  eligibleGrant: {
    path: "/tmp/elig-p197-r2-20260930/eligible-r2-20260929.json",
    bytes: 1107,
    sha256: "643d017a66a86fa8a78a4d45f57b243aafe2e997987a24d4bbe5abcbcfee8e4b",
  },
  replay40: {
    path: "/tmp/elig-p197-r2-20260930/grant-B/replay-40-tuples.json",
    bytes: 8740,
    sha256: "2db97ff0e28aa9e210e9653938664e35895f061f84eb91e907a72fb91f3a15f1",
  },
  bpostFull11: {
    path: "/tmp/fresh-snapshot-read-20260930/post-read/post-snapshot.normalized.json",
    bytes: 1057631,
    sha256: "9bc6b50b7fa3ac86edd17bf87ef60625428423e72efa9df86de7ca741a5b1ec8",
  },
  r1Body: {
    path: "/tmp/owner-2read-live-20260930/attempt-001-R1-body.bin",
    bytes: 3505,
    sha256: "3187e4c8122279ba34802593f5d89869cb69b1f5d9209d7e4530b87b0dfafbe7",
  },
  r2Body: {
    path: "/tmp/owner-2read-live-20260930/attempt-002-R2-body.bin",
    bytes: 364,
    sha256: "497e22b7a6e5c244d0dc00f575a5f011ed91e7b0fcf8df56c2a9c85b7aed44fe",
  },
} as const;

/** pre-forward 上限 (native attempts 会計。hosted は exact 55)。 */
export const MAX_API_CALLS = 77;
export const MAX_HOSTED_GETS = 55;

/** runner が load する verify-path module の full SHA (preflight0 で照合)。 */
export const PINNED_VERIFY_MODULES = {
  stockGapRepair: "c190af5a63e6b0f138354912b5d5364d6f088de37184453f3ac68c4184330189",
  index: "6b1f4547c14cd35636d88f5e80e8d0cc5ad861cb8300beabef689106b3cfe6da",
  archive: "b4388151a2aa36cd6b70fabd4c22d1451641b39c7e7475e6b6c0e109573c5edf",
  client: "4a7f780053ad4bce844e40323e75f4d1713bc1a0c5affe8e4710002192346754",
  env: "de8449e3b8c5c217e206acac92ca3bfab5005d4a5fef3c7c0608f42a1f4ae1c0",
  pageFile: "48f8574f6b4eac3b8a23f83c343c7e52e1274b5c10fe437ebb59fb9d682a3f59",
  sha256: "da3711c4f39656b665f46aa2922adbdf41f3af5045fcf28301540da521a001de",
  yahooClient: "cf8294df95e187036753ee10ab98263aa14198d1536cddaacbb69c5f9e137bdf",
  yahooBarSanity: "0f7ec911bcfbb6abadf20bc4c2694554a04de96190c0f7ebf26a73aa6a55eea6",
  pnpmLock: "805dd5b36ca9ec385b29de1ded715305537eac514dbc7c77dfc55b2d56617e58",
} as const;

const HERE_VERIFY = dirname(fileURLToPath(import.meta.url));
export const VERIFY_MODULE_FILES = {
  stockGapRepair: join(HERE_VERIFY, "./stock-gap-repair.ts"),
  index: join(HERE_VERIFY, "../../src/shared/notion-archive/index.ts"),
  archive: join(HERE_VERIFY, "../../src/shared/notion-archive/archive.ts"),
  client: join(HERE_VERIFY, "../../src/shared/notion-archive/client.ts"),
  env: join(HERE_VERIFY, "../../src/shared/notion-archive/env.ts"),
  pageFile: join(HERE_VERIFY, "../../src/shared/notion-archive/page-file.ts"),
  sha256: join(HERE_VERIFY, "../../src/shared/sha256.ts"),
  yahooClient: join(HERE_VERIFY, "../../src/shared/yahoo/client.ts"),
  yahooBarSanity: join(HERE_VERIFY, "../../src/shared/yahoo/bar-sanity.ts"),
  pnpmLock: join(HERE_VERIFY, "../../pnpm-lock.yaml"),
} as const;

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function failPreflight(why: string): never {
  throw new Error(`source55 STOP: ${why} (送信 0)`);
}

/** 実行後フェーズ用。送信件数を主張しない。 */
function failLive(why: string): never {
  throw new Error(`source55 STOP: ${why}`);
}

export interface GateCounters {
  notion: number;
  hosted: number;
  rejected: number;
  perRule: Record<string, number>;
}

interface BudgetRule {
  label: string;
  method: string;
  path: string | RegExp;
  max: number;
}

/**
 * read-only の正常経路のみ許可する method/route 表。
 * CREATE 系・PATCH・DELETE・complete・users-me は表外で全面拒否。
 */
export const VERIFY_API_RULES: BudgetRule[] = [
  { label: "search", method: "POST", path: "/search", max: 28 },
  { label: "children-scan", method: "GET", path: /^\/blocks\/[^/]+\/children$/, max: 35 },
  { label: "db-query", method: "POST", path: /^\/databases\/[^/]+\/query$/, max: 7 },
  { label: "page-get", method: "GET", path: /^\/pages\/[^/]+$/, max: 7 },
];

const API_HOST = new URL(API_BASE).hostname;

/**
 * pre-forward gate + guard clone。archive adapter と同一機構
 * (route 表だけ read-only) に、受信 whole-body の即時 persist を足す。
 * 判定は全て送信前。超過・表外・二重・redirect は送らず/追随せず STOP。
 * shared client の retry 意味は変えない (gate は試行を数えるだけ。
 * pagination 試行も全て数える)。
 * helper の判定より前に SAME 応答 bytes を wx0600+fsync で保存し、
 * 同一 bytes を詰め直した Response を下流へ渡す (clone-before-judge)。
 * API 応答も同一 idiom で保存する (追加 GET なし)。
 */
export function createVerifyGateFetch(
  inner: typeof fetch,
  log: (rec: Record<string, unknown>) => void,
  counters: GateCounters,
  notionBudget: number,
  hostedBudget: number,
  saveDir: string
): typeof fetch {
  const hostedOnce = new Set<string>();
  const matchRule = (method: string, path: string): BudgetRule | null => {
    for (const r of VERIFY_API_RULES) {
      if (r.method !== method) continue;
      if (typeof r.path === "string" ? r.path === path : r.path.test(path)) return r;
    }
    return null;
  };
  return (async (url: unknown, init?: RequestInit) => {
    let u: URL;
    try {
      u = new URL(String(url));
    } catch {
      counters.rejected += 1;
      throw new Error("verify gate: URL 形状外のため送らない");
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const deny = (why: string): never => {
      counters.rejected += 1;
      log({ phase: "fetch-denied", method, host: u.hostname, why });
      throw new Error(`verify gate: ${why}のため送らない`);
    };
    let fileName: string;
    let ruleLabel = "";
    if (u.hostname !== API_HOST) {
      if (method !== "GET") deny("hosted 非GET");
      if (hostedOnce.has(u.href)) deny("hosted 二重取得");
      if (counters.hosted >= hostedBudget) deny(`hosted 上限 ${hostedBudget} 外`);
      counters.hosted += 1;
      hostedOnce.add(u.href);
      fileName = `hosted-${counters.hosted}.bin`;
    } else {
      const rule = matchRule(method, u.pathname.replace(/^\/v1/, "") || "/");
      if (rule === null) deny("表外 method/route");
      const rl: BudgetRule = rule as BudgetRule;
      const used = counters.perRule[rl.label] ?? 0;
      if (used >= rl.max) deny(`rule 上限 ${rl.label} 外`);
      if (counters.notion >= notionBudget) deny(`Notion 上限 ${notionBudget} 外`);
      counters.notion += 1;
      counters.perRule[rl.label] = used + 1;
      ruleLabel = rl.label;
      fileName = `api-${counters.notion + counters.hosted}.bin`;
    }
    const seq = counters.notion + counters.hosted;
    const requestedAt = new Date().toISOString();
    log({
      seq,
      host: u.hostname,
      method,
      at: requestedAt,
      phase: "send",
    });
    let res: Response;
    try {
      res = await inner(u.href, { ...init, signal: AbortSignal.timeout(60_000), redirect: "manual" });
    } catch (e) {
      counters.rejected += 1;
      log({ phase: "fetch-result", seq, error: "network-error" });
      throw e;
    }
    // guard clone: helper の判定より前に SAME bytes を即時 persist。
    // 3xx も raw 保存 + meta 記録の後に STOP (追随しない)。
    const body = new Uint8Array(await res.arrayBuffer());
    const receivedAt = new Date().toISOString();
    const bodySha = sha256Hex(body);
    writeExclusiveSync(join(saveDir, fileName), body);
    // allowlist された応答 header のみ記録 (cookie/auth 系は never)。
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "content-length", "etag", "last-modified", "date"]) {
      const v = res.headers.get(name);
      if (v !== null) headers[name] = v;
    }
    const meta: Record<string, unknown> = {
      phase: "fetch-result",
      seq,
      status: res.status,
      bytes: body.length,
      sha256: bodySha,
      file: fileName,
      rule: ruleLabel,
      requestedAt,
      receivedAt,
      finalUrl: res.url,
      headers,
    };
    if (res.status >= 300 && res.status < 400) {
      counters.rejected += 1;
      meta["note"] = "redirect-nofollow-STOP";
      log(meta);
      throw new Error("verify gate: redirect のため追随せず STOP");
    }
    log(meta);
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }) as typeof fetch;
}

function readOrFail(path: string, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    return failPreflight(`${what}を読めない ${path}`);
  }
}

/** local bytes の純粋検証 (送信 0・network 0)。 */
export function preflightVerify(): void {
  if (REPAIR_DIAG_KEY !== VERIFY_DIAG_KEY) failPreflight("既存 diag key が frozen pin と不一致");
  if (REPAIR_DIAG_FILES !== VERIFY_DIAG_FILES) failPreflight("既存 diag 件数が frozen pin と不一致");
  if (REPAIR_DIAG_MANIFEST_SHA256 !== VERIFY_DIAG_MANIFEST_SHA256) {
    failPreflight("既存 manifest pin が frozen pin と不一致");
  }
  for (const [name, pin] of Object.entries(PINNED_VERIFY_ARTIFACTS)) {
    const bytes = readOrFail(pin.path, `artifact ${name}`);
    if (bytes.length !== pin.bytes || sha256Hex(bytes) !== pin.sha256) {
      failPreflight(`artifact pin 不一致 ${name}`);
    }
  }
  for (const [name, path] of Object.entries(VERIFY_MODULE_FILES)) {
    const text: string = (() => {
      try {
        return readFileSync(path, "utf-8");
      } catch {
        return failPreflight(`module を読めない ${name}`);
      }
    })();
    const want = PINNED_VERIFY_MODULES[name as keyof typeof PINNED_VERIFY_MODULES];
    if (sha256Hex(text) !== want) failPreflight(`module pin 不一致 ${name}`);
  }
}

function writeExclusiveSync(path: string, data: Uint8Array): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dfd = openSync(dir, "r");
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

function appendAttemptSync(path: string, rec: Record<string, unknown>): void {
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, JSON.stringify(rec) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** canonical env の存在要求 (値は捨てる。存在のみ)。 */
export function assertCanonicalEnv(): void {
  try {
    void notionEnv.NOTION_TOKEN();
    void notionEnv.NOTION_ARCHIVE_PAGE_ID();
  } catch (e) {
    failPreflight(`canonical env 不在: ${(e as Error).message}`);
  }
}

export interface VerifyReport {
  result: "VERIFIED" | "HOLD";
  key: string;
  files: number;
  codes: number;
  manifestSha256: string;
  sends: { api: number; hosted: number };
  gate: { notion: number; hosted: number; rejected: number; perRule: Record<string, number> };
  statsDelta: { requests: number; transientRetries: number; rateLimited: number };
  reportPath: string;
  holds: string[];
}

export interface VerifyOpts {
  attemptLog: string;
  reportOut: string;
}

export async function runVerifyOnce(opts: VerifyOpts): Promise<VerifyReport> {
  // freshness: attemptLog と reportOut の両方が absent でなければ fetch 前に STOP。
  if (existsSync(opts.attemptLog)) failPreflight(`attemptLog 既存 (replay 防止)`);
  if (existsSync(opts.reportOut)) failPreflight(`reportOut 既存 (replay 防止)`);
  preflightVerify();
  assertCanonicalEnv();
  const clock = () => new Date().toISOString();
  resetNotionStats();
  const before = notionStats();
  // gate log を先に確定 (creat + dir fsync。以降の append は data durable)。
  initAttemptLog(opts.attemptLog);
  // guard-clone 保存先を確定 (0700 + dir fsync)。
  const saveDir = join(dirname(opts.reportOut), "responses");
  if (!existsSync(saveDir)) mkdirSync(saveDir, { recursive: true, mode: 0o700 });
  // read-only gate を全 native 試行の前に設置 (pagination/retry 含む全 fetch)。
  const gate: GateCounters = { notion: 0, hosted: 0, rejected: 0, perRule: {} };
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = createVerifyGateFetch(
    nativeFetch,
    (rec) => appendAttemptSync(opts.attemptLog, rec),
    gate,
    MAX_API_CALLS,
    MAX_HOSTED_GETS,
    saveDir
  );
  try {
    return await runVerifyInner(opts, saveDir, gate, clock, before);
  } finally {
    globalThis.fetch = nativeFetch;
  }
}

/** attempt log の事前確定 (creat + file/dir fsync)。 */
function initAttemptLog(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(path, "a", 0o600);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dfd = openSync(dir, "r");
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

async function runVerifyInner(
  opts: VerifyOpts,
  saveDir: string,
  gate: GateCounters,
  clock: () => string,
  before: { requests: number; transientRetries: number; rateLimited: number }
): Promise<VerifyReport> {
  // 既存 custody の再取得 + 再照合 (1 回。失敗は helper が throw)。
  appendAttemptSync(opts.attemptLog, { phase: "custody-attempt", key: VERIFY_DIAG_KEY, at: clock() });
  let custody: Awaited<ReturnType<typeof loadRepairCustody>>;
  try {
    custody = await loadRepairCustody();
  } catch (e) {
    // helper の失敗文は per-code 詳細を含む。attempt log には safe 段階のみ。
    appendAttemptSync(opts.attemptLog, { phase: "custody-failed", key: VERIFY_DIAG_KEY, at: clock() });
    throw e;
  }
  appendAttemptSync(opts.attemptLog, { phase: "custody-returned", key: VERIFY_DIAG_KEY, at: clock() });
  if (custody.manifest.codes.length !== VERIFY_DIAG_CODES) {
    failLive(`codes ${custody.manifest.codes.length} 件 ≠ 期待 ${VERIFY_DIAG_CODES} 件 (再送なし)`);
  }
  if (custody.rawByCode.size !== VERIFY_DIAG_CODES) {
    failLive(`raw ${custody.rawByCode.size} 件 ≠ 期待 ${VERIFY_DIAG_CODES} 件 (再送なし)`);
  }
  if (gate.hosted !== VERIFY_DIAG_FILES) {
    failLive(`hosted ${gate.hosted} 件 ≠ 期待 ${VERIFY_DIAG_FILES} 件 (再送なし)`);
  }
  // retention 確認: guard-clone 保存 bytes を読み戻し、manifest pin と照合。
  // helper は in-memory を pin 照合済み。保存 bytes も pin 一致なら SAME 確定。
  const readSaved = (file: string): Buffer => {
    try {
      return readFileSync(join(saveDir, file));
    } catch {
      return failLive(`保存 bytes を読めない ${file} (再送なし)`);
    }
  };
  const savedManifest = readSaved("hosted-1.bin");
  if (sha256Hex(savedManifest) !== VERIFY_DIAG_MANIFEST_SHA256) {
    failLive("保存 manifest が pin 不一致 (再送なし)");
  }
  // hosted 順序は既存 helper の逐次 DL 順と確定対応: manifest → codes 順。
  // 原文ファイル名も既存 helper の契約通り (`${key}-manifest.json` /
  // `${code}-chart-5y.json`)。provenance 対応を暗黙にせず記録する。
  const manifestFile = {
    name: `${VERIFY_DIAG_KEY}-manifest.json`,
    file: "hosted-1.bin",
    byteLength: savedManifest.length,
    sha256: VERIFY_DIAG_MANIFEST_SHA256,
  };
  const savedByCode = new Map<string, Buffer>();
  const codes = custody.manifest.codes.map((c, i) => {
    if (c.sha256 === null) failLive(`manifest SHA なし (再送なし)`);
    const file = `hosted-${i + 2}.bin`;
    const saved = readSaved(file);
    if (sha256Hex(saved) !== c.sha256) failLive(`保存 bytes が pin 不一致 (再送なし)`);
    savedByCode.set(c.code, saved);
    return {
      code: c.code,
      name: `${c.code}-chart-5y.json`,
      file,
      byteLength: saved.length,
      sha256: c.sha256 as string,
    };
  });
  appendAttemptSync(opts.attemptLog, {
    phase: "retained",
    key: VERIFY_DIAG_KEY,
    files: VERIFY_DIAG_FILES,
    at: clock(),
  });
  // offline replay-40: 保存 bytes を既存 replayRawBar で replay し、
  // expected-40 pin と ohlcvSevenEqual で 40/40 照合 (追加 GET なし)。
  const replayDetail: string[] = [];
  try {
    replayFortyAgainstExpected(savedByCode, replayDetail);
  } catch (e) {
    if (replayDetail.length > 0) saveErrorDetailHold(opts.reportOut, replayDetail.join("; "));
    throw e;
  }
  appendAttemptSync(opts.attemptLog, {
    phase: "replay40-matched",
    key: VERIFY_DIAG_KEY,
    compared: 40,
    at: clock(),
  });
  // private full report を wx0600+fsync で persist (per-code 明細は private)。
  writeExclusiveSync(
    opts.reportOut,
    new TextEncoder().encode(
      JSON.stringify(
        {
          key: VERIFY_DIAG_KEY,
          files: VERIFY_DIAG_FILES,
          codesCount: codes.length,
          manifestSha256: VERIFY_DIAG_MANIFEST_SHA256,
          replay40: { compared: 40, matched: 40 },
          manifestFile,
          codes,
          verifiedAt: clock(),
        },
        null,
        1
      ) + "\n"
    )
  );
  appendAttemptSync(opts.attemptLog, {
    phase: "verified",
    key: VERIFY_DIAG_KEY,
    files: VERIFY_DIAG_FILES,
    codes: codes.length,
    at: clock(),
  });
  const after = notionStats();

  return {
    result: "VERIFIED",
    key: VERIFY_DIAG_KEY,
    files: VERIFY_DIAG_FILES,
    codes: codes.length,
    manifestSha256: VERIFY_DIAG_MANIFEST_SHA256,
    sends: { api: gate.notion, hosted: gate.hosted },
    gate: { notion: gate.notion, hosted: gate.hosted, rejected: gate.rejected, perRule: gate.perRule },
    statsDelta: {
      requests: after.requests - before.requests,
      transientRetries: after.transientRetries - before.transientRetries,
      rateLimited: after.rateLimited - before.rateLimited,
    },
    reportPath: opts.reportOut,
    holds: [],
  };
}

/**
 * 保存 bytes の offline replay-40 照合 (純粋 local。network 0)。
 * eligible 40 の各 code を既存 replayRawBar で replay し、expected-post
 * pin と既存 ohlcvSevenEqual で照合する。chart の代替 parse はしない。
 * 不一致の明細は private へ退避し、throw は safe label のみ。
 */
function replayFortyAgainstExpected(savedByCode: ReadonlyMap<string, Buffer>, detail: string[]): void {
  const eligibleRaw = JSON.parse(
    readFileSync(PINNED_VERIFY_ARTIFACTS.eligibleGrant.path, "utf-8")
  ) as { codes?: unknown };
  const eligibleCodes = eligibleRaw.codes;
  if (!Array.isArray(eligibleCodes) || eligibleCodes.length !== 40) {
    failLive("eligible 40 形状不正 (再送なし)");
  }
  const expectedRaw = JSON.parse(
    readFileSync(PINNED_VERIFY_ARTIFACTS.expectedPost.path, "utf-8")
  ) as { count?: unknown; date?: unknown; tuples?: unknown };
  if (expectedRaw.count !== 40 || expectedRaw.date !== "2026-09-29") {
    failLive("expected-post 40 形状不正 (再送なし)");
  }
  if (!Array.isArray(expectedRaw.tuples) || expectedRaw.tuples.length !== 40) {
    failLive("expected-post tuples 40 件でない (再送なし)");
  }
  const expectedByCode = new Map<string, OhlcvSeven>();
  for (const t of expectedRaw.tuples as { code?: unknown; row?: unknown }[]) {
    if (typeof t.code !== "string" || !t.row || typeof t.row !== "object") {
      failLive("expected-post tuple 形状不正 (再送なし)");
    }
    const r = t.row as Record<string, unknown>;
    const num = (v: unknown): number | null =>
      v === null ? null : typeof v === "number" && Number.isFinite(v) ? v : failLive("expected 値不正 (再送なし)");
    if (r["date"] !== "2026-09-29") failLive("expected 日付不正 (再送なし)");
    expectedByCode.set(t.code, {
      date: "2026-09-29",
      open: num(r["open"]),
      high: num(r["high"]),
      low: num(r["low"]),
      close: num(r["close"]),
      volume: num(r["volume"]),
      adj: num(r["adj"]),
    });
  }
  for (const code of eligibleCodes as string[]) {
    if (typeof code !== "string") failLive("eligible code 形状不正 (再送なし)");
    const saved = savedByCode.get(code);
    if (!saved) failLive("eligible の保存 bytes なし (再送なし)");
    const expected = expectedByCode.get(code);
    if (!expected) failLive("eligible の expected 行なし (再送なし)");
    const outcome = replayRawBar(code, saved);
    if (outcome.kind !== "ok") {
      detail.push(`${code}: ${outcome.reason}`);
      failLive("replay-40 不一致 (再送なし)");
    }
    if (!ohlcvSevenEqual(outcome.row, expected)) {
      detail.push(`${code}: seven-mismatch`);
      failLive("replay-40 不一致 (再送なし)");
    }
  }
}

function argVal(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

function printScopeAndExit(): never {
  console.info(
    [
      "[source55-verify] one-shot custody re-verification (未実行)。",
      `対象: 固定 diag ${VERIFY_DIAG_KEY} の 55 添付のみ (read-only)。`,
      "順序: preflight(送信0) → loadRepairCustody 1 回 → private full report persist → 集計。",
      "live 実行には --execute --grant=<Root承認文> が必要です。CODE CLEAR まで実行しません。",
      "純粋検証は --preflight (送信 0・network 0)。",
    ].join("\n")
  );
  process.exit(2);
  throw new Error("unreachable");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--preflight")) {
    preflightVerify();
    assertCanonicalEnv();
    console.info(
      JSON.stringify(
        {
          result: "PREFLIGHT",
          key: VERIFY_DIAG_KEY,
          files: VERIFY_DIAG_FILES,
          codes: VERIFY_DIAG_CODES,
          manifestSha256: VERIFY_DIAG_MANIFEST_SHA256,
          artifactsMatch: true,
          modulesMatch: true,
          envOk: true,
          sends: 0,
        },
        null,
        2
      )
    );
    return;
  }
  const attemptLog = argVal(args, "--attempt-log");
  const reportOut = argVal(args, "--report-out");
  const grant = argVal(args, "--grant");
  if (!args.includes("--execute") || !grant || !attemptLog || !reportOut) {
    printScopeAndExit();
  }
  const report = await runVerifyOnce({
    attemptLog: attemptLog as string,
    reportOut: reportOut as string,
  });
  console.info(JSON.stringify(report, null, 2));
  if (report.result !== "VERIFIED" || report.holds.length > 0) process.exitCode = 1;
}

/** capture の holdPrivate 準拠: 詳細は private 0600 へ退避し、stdout には safe label のみ。 */
function saveErrorDetailHold(reportOut: string | undefined, msg: string): boolean {
  if (!reportOut) return false;
  try {
    const holdPath = join(dirname(reportOut), "hold-details.log");
    initAttemptLog(holdPath);
    appendAttemptSync(holdPath, { phase: "error-detail", detail: msg.slice(0, 500) });
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((e) => {
    const msg = (e as Error).message;
    // safe label のみ stdout/stderr へ。helper/provider 詳細は private 証跡へ退避。
    if (/^(source55 (STOP|gate):|verify gate:|HOLD:)/.test(msg)) {
      console.error("[source55-verify] エラー:", msg);
    } else {
      const kept = saveErrorDetailHold(argVal(process.argv.slice(2), "--report-out"), msg);
      console.error(
        "[source55-verify] エラー: 実行失敗" + (kept ? " (詳細は private 証跡)" : " (詳細の退避に失敗)")
      );
    }
    process.exit(1);
  });
}
