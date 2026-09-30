/**
 * Owner 2-READ 証拠の one-shot custody archive (手動実行・未実行)。
 *
 * 対象は freeze 済みの固定 key/ZIP/manifest のみ (HEAD 5b15483 の
 * custody freeze。key `owner-2read-evidence-20260930-c89721383ce0`)。
 * 共有 helper (recordPrimaryData / findBackupChildByTitle /
 * queryUniqueRow / verifyArchivedAttachments) を直接呼び、global な
 * baseline bundle (edinet 用) は呼ばない。最小 param 抽出のみで、
 * 新規 framework・verifier・runner 機構は持たない。
 *
 * gate は C baseline (`overseas-baseline-archive.ts` の
 * createNotionGateFetch。C WT。main 未収録) の抽出 + 固定差分
 * (route 表・hosted 各1回・redirect manual・3xx STOP)。
 *
 * 順序:
 * 0. attemptLog と receiptOut が両方 absent でなければ開始しない
 *    (既存は fetch 前に STOP。unknown replay 防止)。
 *    service は ARCHIVE_SERVICE 固定 (override なし。key scope 不変)。
 * 1. preflight0 (local bytes のみ。送信 0・network 0):
 *    ZIP/manifest の SHA・長・key/minusKey 連結・member 12 件・
 *    module pins 7 件・canonical env 存在。不一致は送信 0 で STOP
 *    (failPreflight 表記は preflight 専用。実行後の失敗は送信件数を主張しない)。
 * 2. gate を全 native 試行の前に設置 (pagination/retry 含む全 fetch
 *    が通過)。超過・表外・二重・redirect は送らず/追随せず STOP。
 *    attempt log は事前確定 (creat + dir fsync) の上、forward 前に
 *    毎回 fsync 記録する。
 * 3. record 1 回 (force:false)。返却値を即時 wx0600+fsync で persist
 *    (record-return receipt)。verify より前。以降の照合はこの known
 *    bytes との比較のみ。NotionUnknownResultError 時は unknown marker
 *    を残して再送せず throw。
 * 4. record 返却は recorded+written か skipped_existing+same のみ有効。
 *    それ以外 (unknown 含む) は STOP。skipped_existing+same は再利用
 *    確定として正直に報告する (HOLD なし)。
 * 5. unique 解決 1 回 + pageId 一致。fileTooLarge・unique 不一致は STOP。
 * 6. 共有 verifier で hosted 2 件を readback (各 1 回。retry なし)。
 *
 * native 上限 (gate で送信前強制。logical 数と別会計):
 * - API 計 96・hosted 計 2 (baseline NOTION_BUDGET 96 の踏襲)。
 * - rule 別: search ≤4・db-query ≤2・users-me ≤1・upload-create ≤2・
 *   upload-send ≤2・upload-status ≤8・page-create ≤1・db-create ≤1・
 *   db-get ≤1・page-get ≤1・children-scan ≤5。complete/PATCH/DELETE/
 *   未知 path は全面拒否。mutation は表内の granted record 経路のみ
 *   (単一論理 record の DB-create 1 回まで含む)。
 * - hosted は GET のみ・URL 毎 1 回。API/hosted とも redirect manual。
 *   3xx は追随せず STOP。非 2xx の扱いは共有契約のまま (全試行 gate 計数)。
 * - 1 call の HTTP attempts ≤7 (初回 + retry 6。client 定数)。
 *   非冪等 create は network/529/5xx で単発 Unknown・再送禁止。
 * - 全試行の前に durable attempt 記録。超過は STOP・再送なし。
 * - notionStats は計測のみ (enforcement 主張なし)。delta を返す。
 *
 * env は typed canonical (sharedEnv) のみ。dotenv は読まない
 * (canonical は node --env-file で渡す。2READ と同一手順)。
 * stdout は counts/SHA のみ。pageId・値は出さない。
 * live 実行は `--execute --grant=<Root承認文>` が無いと起動しない。
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  notionStats,
  recordPrimaryData,
  resetNotionStats,
  verifyArchivedAttachments,
} from "../../src/shared/notion-archive/index.js";
import { findBackupChildByTitle, queryUniqueRow } from "../../src/shared/notion-archive/archive.js";
import { API_BASE } from "../../src/shared/notion-archive/client.js";
import { notionEnv } from "../../src/shared/notion-archive/env.js";
import { NotionUnknownResultError } from "../../src/shared/notion-archive/client.js";

export const ARCHIVE_KEY = "owner-2read-evidence-20260930-c89721383ce0";
export const ARCHIVE_SERVICE = "owner-2read";
export const ARCHIVE_SOURCE = "owner 2-READ evidence custody freeze (HEAD 5b15483)";
export const ARCHIVE_ZIP_NAME = `${ARCHIVE_KEY}.zip`;
export const ARCHIVE_MANIFEST_NAME = "manifest.json";
export const ARCHIVE_ZIP_SHA =
  "c8c5a2a3623722f3b48b760315bc776698c71af5f3bbda1b8ed7219aa34537d5";
export const ARCHIVE_ZIP_BYTES = 20170;
export const ARCHIVE_MANIFEST_SHA =
  "3eb6b6fc967acf9e3f6932aedd36eb479da5e9f95b2abfa602fc5fbdcee05596";
export const ARCHIVE_MINUSKEY_SHA =
  "c89721383ce04a6307f9c09f008e27bbe85ea7c93b66443e22cf4d71f26bf3af";
export const ARCHIVE_MEMBER_COUNT = 12;
export const ARCHIVE_FETCHED_AT = "2026-09-30T09:37:29.448Z";
/** pre-forward 上限 (baseline NOTION_BUDGET 96 の踏襲 + hosted exact 2)。 */
export const MAX_API_CALLS = 96;
export const MAX_HOSTED_GETS = 2;

/** adapter が load する共有 module の full SHA (preflight0 で照合)。 */
export const PINNED_ARCHIVE_MODULES = {
  index: "6b1f4547c14cd35636d88f5e80e8d0cc5ad861cb8300beabef689106b3cfe6da",
  archive: "b4388151a2aa36cd6b70fabd4c22d1451641b39c7e7475e6b6c0e109573c5edf",
  client: "4a7f780053ad4bce844e40323e75f4d1713bc1a0c5affe8e4710002192346754",
  env: "de8449e3b8c5c217e206acac92ca3bfab5005d4a5fef3c7c0608f42a1f4ae1c0",
  fileUpload: "c63657f6357424c278ebbaee3656cc62f8bc3fc43ca2aa0fe485210998107f8f",
  pageFile: "48f8574f6b4eac3b8a23f83c343c7e52e1274b5c10fe437ebb59fb9d682a3f59",
  readback: "6bfde103d2cad0cacd942833d3caa1957e44de167a0ce18345bae492c2b2194c",
} as const;

const HERE_ARCHIVE = dirname(fileURLToPath(import.meta.url));
export const ARCHIVE_MODULE_FILES = {
  index: join(HERE_ARCHIVE, "../../src/shared/notion-archive/index.ts"),
  archive: join(HERE_ARCHIVE, "../../src/shared/notion-archive/archive.ts"),
  client: join(HERE_ARCHIVE, "../../src/shared/notion-archive/client.ts"),
  env: join(HERE_ARCHIVE, "../../src/shared/notion-archive/env.ts"),
  fileUpload: join(HERE_ARCHIVE, "../../src/shared/notion-archive/file-upload.ts"),
  pageFile: join(HERE_ARCHIVE, "../../src/shared/notion-archive/page-file.ts"),
  readback: join(HERE_ARCHIVE, "../../src/shared/notion-archive/readback.ts"),
} as const;

export interface ArchivePreflight {
  zipBytes: Uint8Array;
  manifestBytes: Uint8Array;
  memberNames: string[];
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function failPreflight(why: string): never {
  throw new Error(`archive STOP: ${why} (送信 0)`);
}

/** 実行後フェーズ用。送信件数を主張しない。 */
function failLive(why: string): never {
  throw new Error(`archive STOP: ${why}`);
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
 * granted record の正常経路のみ許可する method/route 表。
 * mutation (create/send/pages-create/DB-create) は表内の回数まで。
 * 表外 (PATCH/DELETE/complete/未知 path) は全面拒否。
 */
export const ARCHIVE_API_RULES: BudgetRule[] = [
  { label: "search", method: "POST", path: "/search", max: 4 },
  { label: "db-query", method: "POST", path: /^\/databases\/[^/]+\/query$/, max: 2 },
  { label: "users-me", method: "GET", path: "/users/me", max: 1 },
  { label: "upload-create", method: "POST", path: "/file_uploads", max: 2 },
  { label: "upload-send", method: "POST", path: /^\/file_uploads\/[^/]+\/send$/, max: 2 },
  { label: "upload-status", method: "GET", path: /^\/file_uploads\/[^/]+$/, max: 8 },
  { label: "page-create", method: "POST", path: "/pages", max: 1 },
  { label: "db-create", method: "POST", path: "/databases", max: 1 },
  { label: "db-get", method: "GET", path: /^\/databases\/[^/]+$/, max: 1 },
  { label: "page-get", method: "GET", path: /^\/pages\/[^/]+$/, max: 1 },
  { label: "children-scan", method: "GET", path: /^\/blocks\/[^/]+\/children$/, max: 5 },
];

const API_HOST = new URL(API_BASE).hostname;

/**
 * pre-forward gate。C baseline (`overseas-baseline-archive.ts` の
 * createNotionGateFetch。C WT。main 未収録) の抽出を土台に、本 custody
 * の固定差分 (route 表・hosted 各1回・redirect manual・3xx STOP) を足す。
 * 判定は全て送信前。超過・表外・二重・redirect は送らず/追随せず STOP。
 * shared client の retry 意味・Unknown 不再送は変えない
 * (gate は試行を数えるだけ。pagination 試行も全て数える)。
 */
export function createNotionGateFetch(
  inner: typeof fetch,
  log: (rec: Record<string, unknown>) => void,
  counters: GateCounters,
  notionBudget: number,
  hostedBudget: number
): typeof fetch {
  const hostedOnce = new Set<string>();
  const matchRule = (method: string, path: string): BudgetRule | null => {
    for (const r of ARCHIVE_API_RULES) {
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
      throw new Error("archive gate: URL 形状外のため送らない");
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const deny = (why: string): never => {
      counters.rejected += 1;
      log({ phase: "fetch-denied", method, host: u.hostname, why });
      throw new Error(`archive gate: ${why}のため送らない`);
    };
    if (u.hostname !== API_HOST) {
      if (method !== "GET") deny("hosted 非GET");
      if (hostedOnce.has(u.href)) deny("hosted 二重取得");
      if (counters.hosted >= hostedBudget) deny(`hosted 上限 ${hostedBudget} 外`);
      counters.hosted += 1;
      hostedOnce.add(u.href);
    } else {
      const rule = matchRule(method, u.pathname.replace(/^\/v1/, "") || "/");
      if (rule === null) deny("表外 method/route");
      const rl: BudgetRule = rule as BudgetRule;
      const used = counters.perRule[rl.label] ?? 0;
      if (used >= rl.max) deny(`rule 上限 ${rl.label} 外`);
      if (counters.notion >= notionBudget) deny(`Notion 上限 ${notionBudget} 外`);
      counters.notion += 1;
      counters.perRule[rl.label] = used + 1;
    }
    log({
      seq: counters.notion + counters.hosted,
      host: u.hostname,
      method,
      at: new Date().toISOString(),
      phase: "send",
    });
    let res: Response;
    try {
      res = await inner(u.href, { ...init, signal: AbortSignal.timeout(60_000), redirect: "manual" });
    } catch (e) {
      counters.rejected += 1;
      log({ phase: "fetch-result", error: "network-error" });
      throw e;
    }
    if (res.status >= 300 && res.status < 400) {
      counters.rejected += 1;
      log({ phase: "fetch-result", status: res.status, note: "redirect-nofollow-STOP" });
      throw new Error("archive gate: redirect のため追随せず STOP");
    }
    log({ phase: "fetch-result", status: res.status });
    return res;
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
export function preflightArchive(zipPath: string, manifestPath: string): ArchivePreflight {
  const zipBytes = readOrFail(zipPath, "ZIP");
  const manifestBytes = readOrFail(manifestPath, "manifest");
  if (zipBytes.length !== ARCHIVE_ZIP_BYTES || sha256Hex(zipBytes) !== ARCHIVE_ZIP_SHA) {
    failPreflight("ZIP bytes が frozen pin と不一致");
  }
  if (sha256Hex(manifestBytes) !== ARCHIVE_MANIFEST_SHA) {
    failPreflight("manifest bytes が frozen pin と不一致");
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf-8")) as Record<string, unknown>;
  } catch {
    failPreflight("manifest JSON 破損");
  }
  if (manifest["key"] !== ARCHIVE_KEY) failPreflight("manifest key 不一致");
  if (manifest["minusKeySha256"] !== ARCHIVE_MINUSKEY_SHA) failPreflight("manifest minusKey 不一致");
  if (!String(ARCHIVE_KEY).endsWith(String(manifest["minusKeySha256"]).slice(0, 12))) {
    failPreflight("key/minusKey 連結不正");
  }
  const inner = manifest["manifest"] as { members?: { name?: unknown; role?: unknown }[] } | undefined;
  const members = inner?.members;
  // minus-key 内は payload 11 件。12 件目は manifest.json 自身
  // (whole-file SHA で検証。自己言及の SHA は持たない)。
  if (!Array.isArray(members) || members.length !== ARCHIVE_MEMBER_COUNT - 1) {
    failPreflight(`payload member 11 件でない`);
  }
  const names = members.map((m) => String(m.name));
  if (new Set(names).size !== ARCHIVE_MEMBER_COUNT - 1) failPreflight("member 名重複");
  if (names.includes(ARCHIVE_MANIFEST_NAME)) failPreflight("manifest 自己言及");
  if (!names.includes("pins.json")) failPreflight("member 不足 (pins)");
  for (const [name, path] of Object.entries(ARCHIVE_MODULE_FILES)) {
    const text: string = (() => {
      try {
        return readFileSync(path, "utf-8");
      } catch {
        return failPreflight(`module を読めない ${name}`);
      }
    })();
    const want = PINNED_ARCHIVE_MODULES[name as keyof typeof PINNED_ARCHIVE_MODULES];
    if (sha256Hex(text) !== want) failPreflight(`module pin 不一致 ${name}`);
  }
  return { zipBytes, manifestBytes, memberNames: [...names, ARCHIVE_MANIFEST_NAME].sort() };
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

export interface ArchiveReport {
  result: "ARCHIVED" | "HOLD";
  key: string;
  outcome: string;
  manifestMatch: string;
  verified: boolean;
  sends: { record: number; unique: number; verifyDownloads: number };
  gate: { notion: number; hosted: number; rejected: number; perRule: Record<string, number> };
  zipSha256: string;
  manifestSha256: string;
  statsDelta: { requests: number; transientRetries: number; rateLimited: number };
  receiptPath: string;
  reused: boolean;
  holds: string[];
}

export interface ArchiveOpts {
  zipPath: string;
  manifestPath: string;
  receiptOut: string;
  attemptLog: string;
}

export async function runArchiveOnce(opts: ArchiveOpts): Promise<ArchiveReport> {
  // freshness: attemptLog と receiptOut の両方が absent でなければ fetch 前に STOP。
  if (existsSync(opts.attemptLog)) failPreflight(`attemptLog 既存 (replay 防止)`);
  if (existsSync(opts.receiptOut)) failPreflight(`receiptOut 既存 (replay 防止)`);
  const pf = preflightArchive(opts.zipPath, opts.manifestPath);
  assertCanonicalEnv();
  const clock = () => new Date().toISOString();
  resetNotionStats();
  const before = notionStats();
  // gate log を先に確定 (creat + dir fsync。以降の append は data durable)。
  initAttemptLog(opts.attemptLog);
  // budgeted gate を全 native 試行の前に設置 (pagination/retry 含む全 fetch)。
  const gate: GateCounters = { notion: 0, hosted: 0, rejected: 0, perRule: {} };
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = createNotionGateFetch(
    nativeFetch,
    (rec) => appendAttemptSync(opts.attemptLog, rec),
    gate,
    MAX_API_CALLS,
    MAX_HOSTED_GETS
  );
  try {
    return await runArchiveInner(opts, pf, gate, clock, before);
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

async function runArchiveInner(
  opts: ArchiveOpts,
  pf: ArchivePreflight,
  gate: GateCounters,
  clock: () => string,
  before: { requests: number; transientRetries: number; rateLimited: number }
): Promise<ArchiveReport> {
  // record 1 回 (force:false)。返却値を verify より前に即時 persist。
  appendAttemptSync(opts.attemptLog, { phase: "record-attempt", key: ARCHIVE_KEY, at: clock() });
  let rec: Awaited<ReturnType<typeof recordPrimaryData>>;
  try {
    rec = await recordPrimaryData({
      service: ARCHIVE_SERVICE,
      key: ARCHIVE_KEY,
      source: ARCHIVE_SOURCE,
      fetchedAt: ARCHIVE_FETCHED_AT,
      metadata: { key: ARCHIVE_KEY, zipSha256: ARCHIVE_ZIP_SHA, manifestSha256: ARCHIVE_MANIFEST_SHA },
      files: [
        { filename: ARCHIVE_ZIP_NAME, bytes: pf.zipBytes, contentType: "application/zip" },
        { filename: ARCHIVE_MANIFEST_NAME, bytes: pf.manifestBytes, contentType: "application/json" },
      ],
      force: false,
    });
  } catch (e) {
    if (e instanceof NotionUnknownResultError) {
      writeExclusiveSync(
        opts.receiptOut,
        new TextEncoder().encode(
          JSON.stringify(
            { key: ARCHIVE_KEY, outcome: "unknown", detail: "record-return unknown; no resend", at: clock() },
            null,
            1
          ) + "\n"
        )
      );
    }
    throw e;
  }
  writeExclusiveSync(
    opts.receiptOut,
    new TextEncoder().encode(
      JSON.stringify(
        {
          key: ARCHIVE_KEY,
          pageId: rec.pageId,
          outcome: rec.outcome,
          manifestMatch: rec.manifestMatch,
          fileTooLarge: rec.fileTooLarge,
          recordedAt: clock(),
        },
        null,
        1
      ) + "\n"
    )
  );
  appendAttemptSync(opts.attemptLog, {
    phase: "record-returned",
    key: ARCHIVE_KEY,
    outcome: rec.outcome,
    manifestMatch: rec.manifestMatch,
    at: clock(),
  });
  if (rec.fileTooLarge) failLive("fileTooLarge (再送なし)");
  // 有効 pair は recorded+written か skipped_existing+same のみ。他は STOP。
  const fresh = rec.outcome === "recorded" && rec.manifestMatch === "written";
  const reused = rec.outcome === "skipped_existing" && rec.manifestMatch === "same";
  if (!fresh && !reused) failLive("record 返却が想定 pair 外 (再送なし)");

  // unique 解決 1 回 + pageId 一致。
  appendAttemptSync(opts.attemptLog, { phase: "unique-attempt", key: ARCHIVE_KEY, at: clock() });
  const parentPageId = notionEnv.NOTION_ARCHIVE_PAGE_ID();
  const dbId = await findBackupChildByTitle({
    parentPageId,
    title: `一次データ｜${ARCHIVE_SERVICE}`,
    kind: "database",
  });
  if (!dbId) failLive("保管 DB 不在");
  const row = await queryUniqueRow<{ id: string }>(
    dbId,
    { property: "Key", title: { equals: ARCHIVE_KEY } },
    `archive: 同一 Key の重複 key=${ARCHIVE_KEY} を選ばず保全停止`
  );
  if (!row || row.id !== rec.pageId) failLive("unique pageId 不一致 (再送なし)");
  appendAttemptSync(opts.attemptLog, { phase: "unique-resolved", key: ARCHIVE_KEY, at: clock() });

  // hosted 2 件 readback (共有 verifier。各 1 回)。
  appendAttemptSync(opts.attemptLog, { phase: "verify-attempt", key: ARCHIVE_KEY, files: 2, at: clock() });
  await verifyArchivedAttachments(
    rec.pageId,
    [
      { filename: ARCHIVE_ZIP_NAME, bytes: pf.zipBytes },
      { filename: ARCHIVE_MANIFEST_NAME, bytes: pf.manifestBytes },
    ],
    `owner-2read ${ARCHIVE_KEY}`
  );
  appendAttemptSync(opts.attemptLog, { phase: "verified", key: ARCHIVE_KEY, files: 2, at: clock() });
  const after = notionStats();

  return {
    result: "ARCHIVED",
    key: ARCHIVE_KEY,
    outcome: rec.outcome,
    manifestMatch: rec.manifestMatch,
    verified: true,
    sends: { record: 1, unique: 1, verifyDownloads: 2 },
    gate: { notion: gate.notion, hosted: gate.hosted, rejected: gate.rejected, perRule: gate.perRule },
    zipSha256: ARCHIVE_ZIP_SHA,
    manifestSha256: ARCHIVE_MANIFEST_SHA,
    statsDelta: {
      requests: after.requests - before.requests,
      transientRetries: after.transientRetries - before.transientRetries,
      rateLimited: after.rateLimited - before.rateLimited,
    },
    receiptPath: opts.receiptOut,
    reused,
    holds: [],
  };
}

function argVal(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

function printScopeAndExit(): never {
  console.info(
    [
      "[owner-2read-archive] one-shot custody archive (未実行)。",
      `対象: 固定 key ${ARCHIVE_KEY} + ZIP + manifest のみ。`,
      "順序: preflight(送信0) → record 1 回 → 返却即時 persist → unique 1 回 → hosted 2 件 verify。",
      "live 実行には --execute --grant=<Root承認文> が必要です。CODE CLEAR まで実行しません。",
      "純粋検証は --preflight --zip= --manifest= (送信 0・network 0)。",
    ].join("\n")
  );
  process.exit(2);
  throw new Error("unreachable");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const zip = argVal(args, "--zip");
  const manifest = argVal(args, "--manifest");
  if (args.includes("--preflight")) {
    if (!zip || !manifest) printScopeAndExit();
    const pf = preflightArchive(zip as string, manifest as string);
    assertCanonicalEnv();
    console.info(
      JSON.stringify(
        {
          result: "PREFLIGHT",
          key: ARCHIVE_KEY,
          zipSha256: ARCHIVE_ZIP_SHA,
          zipBytes: ARCHIVE_ZIP_BYTES,
          manifestSha256: ARCHIVE_MANIFEST_SHA,
          minusKeySha256: ARCHIVE_MINUSKEY_SHA,
          memberCount: pf.memberNames.length,
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
  const receiptOut = argVal(args, "--receipt-out");
  const attemptLog = argVal(args, "--attempt-log");
  const grant = argVal(args, "--grant");
  if (!args.includes("--execute") || !grant || !zip || !manifest || !receiptOut || !attemptLog) {
    printScopeAndExit();
  }
  const report = await runArchiveOnce({
    zipPath: zip as string,
    manifestPath: manifest as string,
    receiptOut: receiptOut as string,
    attemptLog: attemptLog as string,
  });
  console.info(JSON.stringify(report, null, 2));
  if (report.result !== "ARCHIVED" || report.holds.length > 0) process.exitCode = 1;
}

/** capture の holdPrivate 準拠: 詳細は private 0600 へ退避し、stdout には safe label のみ。 */
function saveErrorDetailHold(receiptOut: string | undefined, msg: string): boolean {
  if (!receiptOut) return false;
  try {
    const holdPath = join(dirname(receiptOut), "hold-details.log");
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
    // safe label のみ stdout/stderr へ。provider 詳細は private 証跡へ退避。
    if (/^(archive (STOP|gate):|HOLD:)/.test(msg)) {
      console.error("[owner-2read-archive] エラー:", msg);
    } else {
      const kept = saveErrorDetailHold(argVal(process.argv.slice(2), "--receipt-out"), msg);
      console.error(
        "[owner-2read-archive] エラー: 実行失敗" + (kept ? " (詳細は private 証跡)" : " (詳細の退避に失敗)")
      );
    }
    process.exit(1);
  });
}
