/**
 * price40 missing-only 9/29 CAS の fixed-packet executor (手動実行・未実行)。
 *
 * 既存 main の直接実行は live 不可 (frozen R1 と比較しない runtime
 * Map・55 件の ungated 再取得のため。PREP 訂正参照)。本 adapter は
 * 既存 `runGapRepair` の依存 seam 8 件だけを固定 packet 用に差し替え、
 * 既存の replay・builders・CAS・readback・receipt 順序は変えない。
 * 新規 framework・verifier・runner 機構は持たない。
 *
 * 差替:
 * - loadCustody: source55 retained 55 件 (bytes+SHA+manifest 全件照合)
 *   から既存 `parseDiagManifest` で復元。再取得 0。
 * - loadTargets: D1 bounded 47 query (1 SELECT・full4) を frozen
 *   R1-actual 47 行と exact 照合。重複・欠落・drift は write 前 STOP。
 *   通過分から承認済み ID で actual 40 の code→id を返す
 *   (runtime 新規採用なし)。B full11 は不変参照。
 * - readRows: 既存と同形の 99-chunk SELECT (preimage + readback)。
 * - sendBatch: frozen chunk bodies との exact-send guard を通過分だけ
 *   既存 sender で 1 POST。chunk 毎 1 回・4 chunk 上限。
 *   既存 3 文に B11 parent guard (既存 overlay 機構の scoped EXCEPT。
 *   承認 40 行/11 列/承認 IDs。state/events・非対象行なし) を 4 文目
 *   として追加し、同一 atomic batch で送る。parent drift は batch
 *   全体 rollback。
 * - probe/persist: 既存のまま (local)。
 * - record: 既存 `recordPrimaryData` + 返却の known-result 即時保存
 *   (verify の前) + archive gate 再使用で上限強制。
 * - verifyReceipt: 既存のまま + 同 gate。
 *
 * D1 送信は既存 capture stack を再使用する:
 * - SELECT 3 件は `createBoundedFetch` + `createCaptureFetch`
 *   (attempt 指定・targetSHA・marker 予約・durable・manual・retry0・
 *   whole-body wx・strict。drizzle 経由の確立 idiom)。
 * - batch POST 4 件は frozen-body exact allowlist + 同一 idiom の
 *   単発 wrapper (既存 bounded/capture は batch envelope を拒否する
 *   ため、allowlist 付きで包む。sender 本体は既存のまま)。
 * Notion receipt は archive adapter の `createNotionGateFetch` を
 * そのまま再使用する (既存 table・96/2 上限)。
 *
 * 順序:
 * 0. attemptLog・reportOut・d1dir が全て absent でなければ開始しない
 *    (既存は fetch 前に STOP。unknown replay 防止)。
 *    eligible・diag・bodies は frozen pin 内蔵 (override なし)。
 * 1. preflight0 (local bytes のみ。送信 0・network 0):
 *    既存 const 突合・凍結 artifact 17 件・responses 58 件・
 *    module pins 18 件・canonical env + D1 URL SHA。不一致は送信 0 で STOP
 *    (failPreflight 表記は preflight 専用。実行後の失敗は送信件数を主張しない)。
 * 2. `runGapRepair` 1 回。依存呼出の度に該当 guard を設置/復元する
 *    (D1 stack・batch wrapper・Notion gate は相互に排他)。
 *    超過・表外・不一致・drift は送らず STOP・再送なし。
 * 3. private full report を先に wx0600+fsync で persist してから
 *    public 集計を stdout へ出す。
 *
 * native budget (exact。code で強制):
 * - D1 SELECT 3 (targets47 1 + preimage 1 + readback 1)。
 * - D1 batch POST ≤4 (4 文/POST = 既存 3 + B11 parent guard。
 *   chunk 毎 exact body・各 1 回)。
 * - Notion: archive gate 96/2 内の receipt record 1 + verify。
 * - Yahoo 0・55 再取得 0。
 *
 * env は typed canonical のみ。dotenv は読まない
 * (canonical は node --env-file で渡す)。
 * stdout は counts/SHA のみ。pageId・URL・ID・値は出さない。
 * live 実行は `--execute --grant=<Root承認文>` が無いと起動しない。
 */
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import {
  REPAIR_DATE,
  REPAIR_DIAG_FILES,
  REPAIR_DIAG_KEY,
  REPAIR_DIAG_MANIFEST_SHA256,
  RECEIPT_PROOF_DIR,
  parseDiagManifest,
  parseEligibleFile,
  persistReceiptProofFile,
  probeReceiptProofAbsent,
  runGapRepair,
  verifyReceiptAttachment,
  type EligibleGrant,
  type GapRepairDeps,
  type OhlcvSeven,
  type RepairCustody,
} from "./stock-gap-repair.js";
import { OHLCV_REPAIR_CHUNK_ROWS } from "../../src/shared/repair-preflight.js";
import {
  createD1HttpBatchSender,
  d1HttpQueryUrl,
  type D1BatchStatement,
} from "../../src/shared/db/d1-http-client.js";
import { createDailyDb, priceSyncBatchRunId } from "../../src/cron/daily.js";
import {
  assertValidCoreRows,
  assertValidSnapshotShape,
  buildCoreRowsPreflightStatement,
  type OverlaySnapshot,
  type OverlaySnapshotCoreRow,
} from "../../src/cron/universe-overlay.js";
import * as coreSchema from "../../src/shared/db/core-schema.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import { sha256HexBytes } from "../../src/shared/sha256.js";
import { notionEnv } from "../../src/shared/notion-archive/env.js";
import { notionStats, recordPrimaryData, resetNotionStats } from "../../src/shared/notion-archive/index.js";
import {
  MAX_API_CALLS as ARCHIVE_MAX_API,
  MAX_HOSTED_GETS as ARCHIVE_MAX_HOSTED,
  createNotionGateFetch,
  type GateCounters,
} from "./owner-2read-archive.js";
import {
  createCaptureFetch,
  setAttempt,
  setSHA,
  sha256Hex as captureSha256Hex,
  type BodyReceipt,
} from "../../services/yuho-quant/data-scripts/overseas-fresh-read-capture.js";
import {
  assertProjection,
  createBoundedFetch,
  type GuardCounters,
} from "../../services/yuho-quant/data-scripts/overseas-745-select-proof.js";

/** frozen pins (既存 const と preflight0 で突合)。 */
export const PACKET_DIAG_KEY = "price-sync-diag-20260929-local-1790720602657";
export const PACKET_DIAG_FILES = 55;
export const PACKET_DIAG_CODES = 54;
export const PACKET_DIAG_MANIFEST_SHA256 =
  "f509f5dbc2e1838d9073067b9b7059de8cee760ac4878f1da3df63f8e1af894d";
export const PACKET_DATE = "2026-09-29";
export const PACKET_R1_ROWS = 47;
export const PACKET_ELIGIBLE_COUNT = 40;
/**
 * 期待 outside-eligible held 件数。
 * 導出: pinned manifest has_real_bar 47 − pinned eligible 40 = 7
 * (pure proof が actual retained custody で照合する)。
 */
export const PACKET_EXPECTED_OUTSIDE_HELD = 7;
/** D1 query URL の full SHA (canonical env で offline 確定)。 */
export const PACKET_D1_URL_SHA = "8a2fc196212244e660668396fcdd92228f1b2120b6dd16145bbdeef321ddeb49";

/** 凍結 artifact 17 件 (bytes + SHA。preflight0 で照合)。 */
export const PINNED_PACKET_ARTIFACTS = {
  s55report: { path: "/tmp/source55-verify-run-20260930/report.json", bytes: 10924, sha256: "54547fec770de7e7df1bf153eada653a8fd7b3f601dcf93407722cf9a092edbc" },
  s55attempt: { path: "/tmp/source55-verify-run-20260930/attempt.log", bytes: 126908, sha256: "ccfffba19ab1085dd37d8ffbffac96b94c3a02f7a818e376917b8cf1195c32bb" },
  s55manifest: { path: "/tmp/source55-verify-run-20260930/responses/hosted-1.bin", bytes: 10329, sha256: "f509f5dbc2e1838d9073067b9b7059de8cee760ac4878f1da3df63f8e1af894d" },
  r1body: { path: "/tmp/owner-2read-live-20260930/attempt-001-R1-body.bin", bytes: 3505, sha256: "3187e4c8122279ba34802593f5d89869cb69b1f5d9209d7e4530b87b0dfafbe7" },
  r2body: { path: "/tmp/owner-2read-live-20260930/attempt-002-R2-body.bin", bytes: 364, sha256: "497e22b7a6e5c244d0dc00f575a5f011ed91e7b0fcf8df56c2a9c85b7aed44fe" },
  packetR1: { path: "/tmp/owner-2read-custody-20260930/stage/packet-r1.json", bytes: 2213, sha256: "997bcf8442ba0f7baddca249b30bea3e844d4cb47ae609acf955e6599fa5312e" },
  packetR2: { path: "/tmp/owner-2read-custody-20260930/stage/packet-r2.json", bytes: 3929, sha256: "d9e35a8d8a8fd18492f10588317d05f853046c2cce3f7f85252792ceb4bd8d0e" },
  eligible: { path: "/tmp/elig-p197-r2-20260930/eligible-r2-20260929.json", bytes: 1107, sha256: "643d017a66a86fa8a78a4d45f57b243aafe2e997987a24d4bbe5abcbcfee8e4b" },
  expectedPost: { path: "/tmp/price40-prep-20260930/expected-post-40-full.json", bytes: 5205, sha256: "5b722925d32371e81275ad1e2b9f7512771465d8b29f6d2fc5b27604727d3b15" },
  bodyHashes: { path: "/tmp/price40-prep-20260930/body-hashes.json", bytes: 3704, sha256: "24459b167e0284e69fd2d0f2d3427cb7479e9cb34db09e4aee79375037de771c" },
  tuples: { path: "/tmp/price40-prep-20260930/tuples.json", bytes: 2078, sha256: "af861e0d2e65f38b749c3c6f188bf93394df3227cb30a4f1215b200692851505" },
  chunkPlan: { path: "/tmp/price40-prep-20260930/chunk-plan.json", bytes: 1161, sha256: "fcfb7bcc2524140188a900977b8b6d18087617660f0c858d0e8b1d3a37254248" },
  budget: { path: "/tmp/price40-prep-20260930/budget.json", bytes: 1074, sha256: "7efbbe88d50a8f1b04036caedb12a627c101937b3f0e24fe564a263116e885ad" },
  chunkBodies: { path: "/tmp/price40-prep-20260930/chunk-bodies-t40.json", bytes: 68276, sha256: "e33ed352439f818506aba93d88c24f526856c3a03bde568c58e31508c584616d" },
  budgetSend: { path: "/tmp/price40-prep-20260930/budget-send-t40.json", bytes: 1416, sha256: "fdc700a9608a63c4343ba4c78fb87547e7b7eac94f69da3c6c66b926892f39dd" },
  replay40: { path: "/tmp/elig-p197-r2-20260930/grant-B/replay-40-tuples.json", bytes: 8740, sha256: "2db97ff0e28aa9e210e9653938664e35895f061f84eb91e907a72fb91f3a15f1" },
  bpost: { path: "/tmp/fresh-snapshot-read-20260930/post-read/post-snapshot.normalized.json", bytes: 1057631, sha256: "9bc6b50b7fa3ac86edd17bf87ef60625428423e72efa9df86de7ca741a5b1ec8" },
} as const;
export const PACKET_S55_DIR = "/tmp/source55-verify-run-20260930/responses";
export const PACKET_S55_FILE_COUNT = 58;

/** D1 送信の exact budget。 */
export const PACKET_D1_SELECTS = 3;
export const PACKET_D1_POSTS = 4;

/** adapter が load する module の full SHA (preflight0 で照合)。 */
export const PINNED_PACKET_MODULES = {
  stockGapRepair: "c190af5a63e6b0f138354912b5d5364d6f088de37184453f3ac68c4184330189",
  repairPreflight: "da7e9b27acd1c943c480dfe4a9f3c03a12fb978da5c442d66e4ba47826d68d7e",
  d1client: "5a50ec98aee0f7b1a2c5dbd7f831099847242acc875106919f2e8e0efd5e2d4a",
  daily: "c1b03b625641cbda4bf73b1e46bc3ffbf5c7e39a7b796ab2260e9ce59aa12ee2",
  swingSchema: "fe9f19ceb13cf3a14704d9d66bda1981dfe64d1c834ca198228b73f1d504a8fa",
  coreSchema: "3393ccc640bdef58f1abd895e36b853d5afc764f9a3e464aa61a915f318e714d",
  index: "6b1f4547c14cd35636d88f5e80e8d0cc5ad861cb8300beabef689106b3cfe6da",
  archive: "b4388151a2aa36cd6b70fabd4c22d1451641b39c7e7475e6b6c0e109573c5edf",
  client: "4a7f780053ad4bce844e40323e75f4d1713bc1a0c5affe8e4710002192346754",
  env: "de8449e3b8c5c217e206acac92ca3bfab5005d4a5fef3c7c0608f42a1f4ae1c0",
  pageFile: "48f8574f6b4eac3b8a23f83c343c7e52e1274b5c10fe437ebb59fb9d682a3f59",
  sha256mod: "da3711c4f39656b665f46aa2922adbdf41f3af5045fcf28301540da521a001de",
  yahooClient: "60bca236229ecbb1f2ea13f9970b5f7e9bb87d3279aa7e901db90de40d6f1955",
  yahooBarSanity: "0f7ec911bcfbb6abadf20bc4c2694554a04de96190c0f7ebf26a73aa6a55eea6",
  archiveAdapter: "70b19e72de35a4af7d85018556ed070826d3f87e1eaf47bd85d6979fb1d538c3",
  freshCapture: "d349a80bc473fbe3a4dc415553c89a9cc2a7680746a80533f5dc40cd8420f944",
  selectProof: "cbb03a3aef6d73385c348478f686302d24a252da4d82aa1cd2d4b19f5b0faebd",
  universeOverlay: "c69c05363dacce3b6dd4199e4684718fec11f69a8f2b87c412e7ddc31c206e75",
  pnpmLock: "805dd5b36ca9ec385b29de1ded715305537eac514dbc7c77dfc55b2d56617e58",
} as const;

const HERE_PACKET = dirname(fileURLToPath(import.meta.url));
export const PACKET_MODULE_FILES = {
  stockGapRepair: join(HERE_PACKET, "./stock-gap-repair.ts"),
  repairPreflight: join(HERE_PACKET, "../../src/shared/repair-preflight.ts"),
  d1client: join(HERE_PACKET, "../../src/shared/db/d1-http-client.ts"),
  daily: join(HERE_PACKET, "../../src/cron/daily.ts"),
  swingSchema: join(HERE_PACKET, "../../services/swing-trading/src/db/schema.ts"),
  coreSchema: join(HERE_PACKET, "../../src/shared/db/core-schema.ts"),
  index: join(HERE_PACKET, "../../src/shared/notion-archive/index.ts"),
  archive: join(HERE_PACKET, "../../src/shared/notion-archive/archive.ts"),
  client: join(HERE_PACKET, "../../src/shared/notion-archive/client.ts"),
  env: join(HERE_PACKET, "../../src/shared/notion-archive/env.ts"),
  pageFile: join(HERE_PACKET, "../../src/shared/notion-archive/page-file.ts"),
  sha256mod: join(HERE_PACKET, "../../src/shared/sha256.ts"),
  yahooClient: join(HERE_PACKET, "../../src/shared/yahoo/client.ts"),
  yahooBarSanity: join(HERE_PACKET, "../../src/shared/yahoo/bar-sanity.ts"),
  archiveAdapter: join(HERE_PACKET, "./owner-2read-archive.ts"),
  freshCapture: join(HERE_PACKET, "../../services/yuho-quant/data-scripts/overseas-fresh-read-capture.ts"),
  selectProof: join(HERE_PACKET, "../../services/yuho-quant/data-scripts/overseas-745-select-proof.ts"),
  universeOverlay: join(HERE_PACKET, "../../src/cron/universe-overlay.ts"),
  pnpmLock: join(HERE_PACKET, "../../pnpm-lock.yaml"),
} as const;

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function failPreflight(why: string): never {
  throw new Error(`price40 STOP: ${why} (送信 0)`);
}

/** 実行後フェーズ用。送信件数を主張しない。 */
function failLive(why: string): never {
  throw new Error(`price40 STOP: ${why}`);
}

function readOrFail(path: string, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    return failPreflight(`${what}を読めない ${path}`);
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

/** canonical env + D1 URL SHA の存在要求 (値は捨てる。存在と SHA のみ)。 */
export function assertCanonicalEnv(): void {
  try {
    void notionEnv.NOTION_TOKEN();
    void notionEnv.NOTION_ARCHIVE_PAGE_ID();
  } catch (e) {
    failPreflight(`canonical env 不在: ${(e as Error).message}`);
  }
  if (sha256Hex(d1HttpQueryUrl()) !== PACKET_D1_URL_SHA) {
    failPreflight("D1 URL SHA が frozen pin と不一致");
  }
}

/** local bytes の純粋検証 (送信 0・network 0)。 */
export function preflightPacket(): void {
  if (REPAIR_DIAG_KEY !== PACKET_DIAG_KEY) failPreflight("既存 diag key が frozen pin と不一致");
  if (REPAIR_DIAG_FILES !== PACKET_DIAG_FILES) failPreflight("既存 diag 件数が frozen pin と不一致");
  if (REPAIR_DIAG_MANIFEST_SHA256 !== PACKET_DIAG_MANIFEST_SHA256) {
    failPreflight("既存 manifest pin が frozen pin と不一致");
  }
  if (REPAIR_DATE !== PACKET_DATE) failPreflight("既存 date が frozen pin と不一致");
  if (OHLCV_REPAIR_CHUNK_ROWS !== 12) failPreflight("既存 chunk const が frozen pin と不一致");
  for (const [name, pin] of Object.entries(PINNED_PACKET_ARTIFACTS)) {
    const bytes = readOrFail(pin.path, `artifact ${name}`);
    if (bytes.length !== pin.bytes || sha256Hex(bytes) !== pin.sha256) {
      failPreflight(`artifact pin 不一致 ${name}`);
    }
  }
  const s55files = readdirSync(PACKET_S55_DIR);
  if (s55files.length !== PACKET_S55_FILE_COUNT) {
    failPreflight(`retained responses ${s55files.length} 件 ≠ 期待 ${PACKET_S55_FILE_COUNT} 件`);
  }
  for (const [name, path] of Object.entries(PACKET_MODULE_FILES)) {
    const text: string = (() => {
      try {
        return readFileSync(path, "utf-8");
      } catch {
        return failPreflight(`module を読めない ${name}`);
      }
    })();
    const want = PINNED_PACKET_MODULES[name as keyof typeof PINNED_PACKET_MODULES];
    if (sha256Hex(text) !== want) failPreflight(`module pin 不一致 ${name}`);
  }
}

interface FrozenChunk {
  chunk: number;
  rows: number;
  codes: string[];
  stockIds: number[];
  binds: number[];
  statements: { sql: string; params: unknown[] }[];
}

interface PacketCtx {
  attemptLog: string;
  reportOut: string;
  d1dir: string;
  clock: () => string;
  frozenR1: Map<number, { code: string; isActive: number; instrumentType: string }>;
  frozenBodies: FrozenChunk[];
  parentGuard: D1BatchStatement;
  eligible: EligibleGrant;
  db: ReturnType<typeof createDailyDb>;
  sendBatchRaw: (statements: readonly D1BatchStatement[]) => Promise<void>;
  d1counters: GuardCounters;
  d1receipts: BodyReceipt[];
  d1seq: number;
  batchIndex: number;
  gate: GateCounters;
}

/** frozen R1-actual 47 行の復元 (raw D1 body から。exact-4)。 */
export function loadFrozenR1(): Map<number, { code: string; isActive: number; instrumentType: string }> {
  const raw = JSON.parse(
    readFileSync(PINNED_PACKET_ARTIFACTS.r1body.path, "utf-8")
  ) as { success: unknown; result: { results: unknown }[] };
  if (raw.success !== true) failPreflight("frozen R1 success でない");
  const rows = raw.result[0].results as { code: unknown; id: unknown; is_active: unknown; instrument_type: unknown }[];
  if (rows.length !== PACKET_R1_ROWS) failPreflight(`frozen R1 ${rows.length} 行 ≠ 47`);
  const out = new Map<number, { code: string; isActive: number; instrumentType: string }>();
  for (const r of rows) {
    if (typeof r.code !== "string" || typeof r.id !== "number") failPreflight("frozen R1 行形状不正");
    if (typeof r.is_active !== "number" || typeof r.instrument_type !== "string") {
      failPreflight("frozen R1 行形状不正");
    }
    if (out.has(r.id)) failPreflight("frozen R1 id 重複");
    out.set(r.id, { code: r.code, isActive: r.is_active, instrumentType: r.instrument_type });
  }
  return out;
}

/** frozen chunk bodies の復元。 */
function loadFrozenBodies(): FrozenChunk[] {
  const raw = JSON.parse(
    readFileSync(PINNED_PACKET_ARTIFACTS.chunkBodies.path, "utf-8")
  ) as { count: unknown; date: unknown; chunks: FrozenChunk[] };
  if (raw.count !== 40 || raw.date !== PACKET_DATE) failPreflight("frozen bodies 形状不正");
  if (!Array.isArray(raw.chunks) || raw.chunks.length !== 4) failPreflight("frozen bodies chunk 数不正");
  return raw.chunks;
}

/**
 * 承認 40 B rows からの scoped parent guard 復元 (既存 helper のみ)。
 * frozen Bpost bytes → 既存 full-shape 検証 → 承認 40 行抽出 →
 * 既存 core-rows 検証 → 既存 scoped EXCEPT guard。
 */
function loadFrozenParent(
  eligible: EligibleGrant,
  frozenR1: Map<number, { code: string; isActive: number; instrumentType: string }>
): D1BatchStatement {
  const snapshot = JSON.parse(
    readFileSync(PINNED_PACKET_ARTIFACTS.bpost.path, "utf-8")
  ) as OverlaySnapshot;
  try {
    assertValidSnapshotShape(snapshot);
  } catch (e) {
    failPreflight(`承認 B snapshot 形状不正: ${(e as Error).message}`);
  }
  const byId = new Map(snapshot.core.map((r) => [r.id, r]));
  const rows: OverlaySnapshotCoreRow[] = [];
  for (const code of eligible.codes) {
    const hit = [...frozenR1.entries()].find(([, v]) => v.code === code);
    if (!hit) failPreflight("承認 40 の R1 id なし");
    const row = byId.get(hit[0]);
    if (!row) failPreflight("承認 40 の B 行なし");
    rows.push(row);
  }
  if (rows.length !== PACKET_ELIGIBLE_COUNT) failPreflight("承認 40 B 行でない");
  rows.sort((a, b) => a.id - b.id);
  try {
    assertValidCoreRows(rows);
  } catch (e) {
    failPreflight(`承認 40 B rows 形状不正: ${(e as Error).message}`);
  }
  return buildCoreRowsPreflightStatement(rows);
}

/** frozen eligible の復元 (既存 parse + fileSha256。既存 main と同一)。 */
export async function loadFrozenEligible(): Promise<EligibleGrant> {
  const text = readFileSync(PINNED_PACKET_ARTIFACTS.eligible.path, "utf-8");
  const parsed = parseEligibleFile(text);
  if (parsed.codes.size !== PACKET_ELIGIBLE_COUNT) failPreflight("frozen eligible 40 件でない");
  return { ...parsed, fileSha256: await sha256HexBytes(Buffer.from(text, "utf-8")) };
}

/** retained custody 復元に必要な最小面 (pure proof 用。PacketCtx は構造的に満たす)。 */
export interface CustodyLoadCtx {
  attemptLog: string;
  clock: () => string;
}
/** dep: retained 55 件からの custody 復元 (再取得 0)。 */
export async function loadRetainedCustody(ctx: CustodyLoadCtx): Promise<RepairCustody> {
  appendAttemptSync(ctx.attemptLog, { phase: "custody-attempt", key: PACKET_DIAG_KEY, at: ctx.clock() });
  const report = JSON.parse(
    readFileSync(PINNED_PACKET_ARTIFACTS.s55report.path, "utf-8")
  ) as {
    manifestFile: { name: string; file: string; byteLength: number; sha256: string };
    codes: { code: string; name: string; file: string; byteLength: number; sha256: string }[];
  };
  const readSaved = (file: string): Buffer => {
    try {
      return readFileSync(join(PACKET_S55_DIR, file));
    } catch {
      return failLive(`retained bytes を読めない ${file} (再送なし)`);
    }
  };
  const manifestBytes = readSaved(report.manifestFile.file);
  if (manifestBytes.length !== report.manifestFile.byteLength) failLive("retained manifest 長不一致 (再送なし)");
  if (sha256Hex(manifestBytes) !== PACKET_DIAG_MANIFEST_SHA256) failLive("retained manifest pin 不一致 (再送なし)");
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestBytes.toString("utf-8"));
  } catch {
    failLive("retained manifest JSON 破損 (再送なし)");
  }
  const manifest = parseDiagManifest(manifestJson);
  if (manifest.completeness !== "complete") failLive("retained manifest 非 complete (再送なし)");
  if (manifest.unattempted.length > 0) failLive("retained manifest 未試行残 (再送なし)");
  if (manifest.codes.length !== PACKET_DIAG_CODES) failLive("retained codes 54 件でない (再送なし)");
  const byReport = new Map(report.codes.map((c) => [c.code, c]));
  const rawByCode = new Map<string, Uint8Array>();
  for (const entry of manifest.codes) {
    const rep = byReport.get(entry.code) ?? failLive("report 対応なし (再送なし)");
    const saved = readSaved(rep.file);
    if (saved.length !== rep.byteLength || sha256Hex(saved) !== rep.sha256) {
      failLive("retained raw が report 不一致 (再送なし)");
    }
    if (entry.sha256 === null || sha256Hex(saved) !== entry.sha256) {
      failLive("retained raw が manifest 不一致 (再送なし)");
    }
    rawByCode.set(entry.code, saved);
  }
  appendAttemptSync(ctx.attemptLog, { phase: "custody-returned", key: PACKET_DIAG_KEY, at: ctx.clock() });
  return { manifest, rawByCode };
}

/** D1 SELECT stack (既存 bounded + capture) の設置/復元。 */
async function withD1Select<T>(ctx: PacketCtx, fn: () => Promise<T>): Promise<T> {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = createCaptureFetch(
    createBoundedFetch(nativeFetch, PACKET_D1_SELECTS, ctx.d1counters),
    ctx.d1dir,
    ctx.d1counters,
    ctx.d1receipts,
    PACKET_D1_URL_SHA
  );
  try {
    return await fn();
  } finally {
    globalThis.fetch = nativeFetch;
  }
}

/** dep: bounded 47 query + frozen R1 exact 照合。承認済み ID で 40 を返す。 */
async function loadCheckedTargets(ctx: PacketCtx): Promise<{ id: number; code: string }[]> {
  appendAttemptSync(ctx.attemptLog, { phase: "targets-attempt", at: ctx.clock() });
  const frozenIds = [...ctx.frozenR1.keys()];
  const q = ctx.db
    .select({
      id: coreSchema.stocks.id,
      code: coreSchema.stocks.code,
      isActive: coreSchema.stocks.isActive,
      instrumentType: coreSchema.stocks.instrumentType,
    })
    .from(coreSchema.stocks)
    .where(inArray(coreSchema.stocks.id, frozenIds));
  const built = q.toSQL();
  // 既存 select-proof helper で full4 射影を確定 (違反は HOLD throw)。
  assertProjection(built.sql, 4, "targets47");
  ctx.d1seq += 1;
  setAttempt({
    seq: ctx.d1seq,
    kind: "R1",
    chunk: 0,
    idsSHA: setSHA((built.params as unknown[]).map((p) => String(p))),
    sqlSHA: captureSha256Hex(built.sql),
  });
  const rows = await withD1Select(ctx, async () => ((await q) as unknown) as {
    id: unknown; code: unknown; isActive: unknown; instrumentType: unknown;
  }[]);
  if (rows.length !== PACKET_R1_ROWS) failLive(`targets ${rows.length} 行 ≠ 47 (送信停止)`);
  // 実型の厳密検証 (drizzle boolean mode の bool のみ許容。Number() 矯正なし)。
  const seenIds = new Set<number>();
  const seenCodes = new Set<string>();
  for (const r of rows) {
    if (typeof r.id !== "number" || !Number.isInteger(r.id) || r.id <= 0) {
      failLive("targets id 型不正 (送信停止)");
    }
    if (typeof r.code !== "string" || r.code === "") failLive("targets code 型不正 (送信停止)");
    if (typeof r.isActive !== "boolean") failLive("targets isActive 型不正 (送信停止)");
    if (typeof r.instrumentType !== "string") failLive("targets instrumentType 型不正 (送信停止)");
    if (seenIds.has(r.id)) failLive("targets id 重複 (送信停止)");
    if (seenCodes.has(r.code)) failLive("targets code 重複 (送信停止)");
    seenIds.add(r.id);
    seenCodes.add(r.code);
    const frozen = ctx.frozenR1.get(r.id) ?? failLive("targets 未知 id (送信停止)");
    if (r.code !== frozen.code || (r.isActive ? 1 : 0) !== frozen.isActive || r.instrumentType !== frozen.instrumentType) {
      failLive("targets drift (送信停止)");
    }
  }
  appendAttemptSync(ctx.attemptLog, { phase: "targets-matched", rows: rows.length, at: ctx.clock() });
  // 承認済み ID (frozen) で actual 40 を返す。runtime 新規採用なし。
  const out: { id: number; code: string }[] = [];
  for (const code of ctx.eligible.codes) {
    const hit = [...ctx.frozenR1.entries()].find(([, v]) => v.code === code);
    if (!hit) failLive("eligible の承認済み id なし (送信停止)");
    out.push({ id: hit[0], code });
  }
  return out;
}

/** dep: 既存と同形の 99-chunk SELECT + 実行時形状検証。 */
async function readCheckedRows(
  ctx: PacketCtx,
  stockIds: readonly number[],
  date: string
): Promise<Map<number, OhlcvSeven>> {
  const out = new Map<number, OhlcvSeven>();
  const wantKeys = ["adj", "close", "date", "high", "low", "open", "stockId", "volume"];
  for (let i = 0; i < stockIds.length; i += 99) {
    const chunk = stockIds.slice(i, i + 99);
    const want = new Set(chunk);
    const q = ctx.db
      .select({
        stockId: swingSchema.dailyOhlcv.stockId,
        date: swingSchema.dailyOhlcv.date,
        open: swingSchema.dailyOhlcv.open,
        high: swingSchema.dailyOhlcv.high,
        low: swingSchema.dailyOhlcv.low,
        close: swingSchema.dailyOhlcv.close,
        volume: swingSchema.dailyOhlcv.volume,
        adj: swingSchema.dailyOhlcv.adj,
      })
      .from(swingSchema.dailyOhlcv)
      .where(and(eq(swingSchema.dailyOhlcv.date, date), inArray(swingSchema.dailyOhlcv.stockId, chunk)));
    const built = q.toSQL();
    // 既存 select-proof helper で exact-8 射影を確定 (違反は HOLD throw)。
    assertProjection(built.sql, 8, "ohlcv8");
    ctx.d1seq += 1;
    setAttempt({
      seq: ctx.d1seq,
      kind: "R1",
      chunk: 0,
      idsSHA: setSHA((built.params as unknown[]).map((p) => String(p))),
      sqlSHA: captureSha256Hex(built.sql),
    });
    const rows = await withD1Select(ctx, async () => ((await q) as unknown) as Record<string, unknown>[]);
    if (rows.length > chunk.length) failLive("ohlcv 行過多 (送信停止)");
    for (const r of rows) {
      // exact-8 列・型・null-or-finite・範囲・重複を検証してから map。
      const keys = Object.keys(r).sort();
      if (JSON.stringify(keys) !== JSON.stringify(wantKeys)) failLive("ohlcv 列外 (送信停止)");
      const sid = r["stockId"];
      if (typeof sid !== "number" || !Number.isInteger(sid) || sid <= 0 || !want.has(sid)) {
        failLive("ohlcv stockId 外 (送信停止)");
      }
      if (r["date"] !== date) failLive("ohlcv 日付外 (送信停止)");
      if (out.has(sid)) failLive("ohlcv id 重複 (送信停止)");
      const num = (k: string): number | null => {
        const v = r[k];
        if (v === null) return null;
        if (typeof v !== "number" || !Number.isFinite(v)) failLive("ohlcv 値外 (送信停止)");
        return v;
      };
      out.set(sid, {
        date, open: num("open"), high: num("high"), low: num("low"),
        close: num("close"), volume: num("volume"), adj: num("adj"),
      });
    }
  }
  return out;
}

/**
 * batch POST 用の単発 wrapper (capture idiom。frozen-body allowlist 付き)。
 * 既存 bounded/capture は batch envelope を拒否するため、同一 idiom
 * (targetSHA・marker 予約・durable・manual・retry0・whole-body wx・
 * strict は既存 sender) で包む。sender 本体は既存のまま。
 */
function createBatchPostFetch(
  inner: typeof fetch,
  d1dir: string,
  index: number,
  clock: () => string,
  attemptLog: string
): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    if (sha256Hex(String(url)) !== PACKET_D1_URL_SHA) {
      throw new Error("price40 gate: D1 target SHA 外のため送らない");
    }
    if ((init?.method ?? "GET").toUpperCase() !== "POST") {
      throw new Error("price40 gate: batch 非POST のため送らない");
    }
    appendAttemptSync(attemptLog, { phase: "batch-send", index, at: clock() });
    let res: Response;
    try {
      res = await inner(String(url), { ...init, signal: AbortSignal.timeout(60_000), redirect: "manual" });
    } catch (e) {
      appendAttemptSync(attemptLog, { phase: "batch-result", index, error: "network-error" });
      throw e;
    }
    const raw = Buffer.from(await res.clone().arrayBuffer());
    const bodyPath = join(d1dir, `batch-${index}-body.bin`);
    try {
      writeExclusiveSync(bodyPath, raw);
    } catch (e) {
      throw new Error(`price40 gate: batch body 保存失敗 (再入の可能性): ${(e as Error).message}`);
    }
    const safeHeaders: Record<string, string> = {};
    for (const k of ["content-type", "content-length", "cf-ray", "date"]) {
      const v = res.headers.get(k);
      if (v !== null) safeHeaders[k] = v;
    }
    appendAttemptSync(attemptLog, {
      phase: "batch-result", index, status: res.status,
      bytes: raw.length, sha256: sha256Hex(raw), bodyPath,
      receivedAt: clock(), headers: safeHeaders,
    });
    return res;
  }) as typeof fetch;
}

/** dep: frozen-body exact-send guard + B11 追加の既存 sender 単発 POST。 */
async function sendCheckedBatch(ctx: PacketCtx, statements: readonly D1BatchStatement[]): Promise<void> {
  const index = ctx.batchIndex;
  if (index >= PACKET_D1_POSTS) failLive("batch 上限 4 外 (送信停止)");
  if (statements.length !== 3) failLive(`chunk-${index} 3 文でない (送信前)`);
  const frozen = ctx.frozenBodies[index];
  const canon = JSON.stringify(statements.map((s) => ({ sql: s.sql, params: [...s.params] })));
  // frozen の先頭 3 文と exact 照合 (4 文目は B11 guard。別途照合)。
  if (canon !== JSON.stringify(frozen.statements.slice(0, 3))) {
    failLive(`chunk-${index} が frozen body 不一致 (送信前)`);
  }
  const frozenGuard = frozen.statements[3];
  if (
    !frozenGuard ||
    ctx.parentGuard.sql !== frozenGuard.sql ||
    JSON.stringify(ctx.parentGuard.params) !== JSON.stringify(frozenGuard.params)
  ) {
    failLive(`chunk-${index} の B11 guard が frozen 不一致 (送信前)`);
  }
  // marker 予約 (wx。二重送信は atomic に拒否)。
  try {
    writeExclusiveSync(
      join(ctx.d1dir, `batch-${index}-reserved`),
      new TextEncoder().encode(JSON.stringify({ index, at: ctx.clock() }) + "\n")
    );
  } catch {
    failLive(`batch-${index} 予約済み (再送なし)`);
  }
  ctx.batchIndex += 1;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = createBatchPostFetch(nativeFetch, ctx.d1dir, index, ctx.clock, ctx.attemptLog);
  try {
    // 既存 3 文 + B11 parent guard を同一 atomic batch で送る。
    await ctx.sendBatchRaw([...statements, ctx.parentGuard]);
  } finally {
    globalThis.fetch = nativeFetch;
  }
}

/** Notion gate (archive 再使用) の設置/復元。 */
async function withNotionGate<T>(ctx: PacketCtx, fn: () => Promise<T>): Promise<T> {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = createNotionGateFetch(
    nativeFetch,
    (rec) => appendAttemptSync(ctx.attemptLog, rec),
    ctx.gate,
    ARCHIVE_MAX_API,
    ARCHIVE_MAX_HOSTED
  );
  try {
    return await fn();
  } finally {
    globalThis.fetch = nativeFetch;
  }
}

/**
 * packet outcome 合格判定 (純関数)。
 * producer は source-real の outside-eligible 7 件を held
 * (reason `not-in-eligible-set`) に入れるため、held 空ではなく
 * 「eligible-held 0 + 期待 7 診断のみ」を合格とする。
 * held の事実は消さない (private report に全件保持・報告する)。
 * eligible-held・想定外 reason・件数 drift は HOLD。
 */
export function classifyPacketClean(
  rep: {
    aborted: boolean;
    unknown: readonly unknown[];
    held: readonly { code: string; reason: string }[];
    applied: number;
  },
  eligibleCodes: ReadonlySet<string>
): boolean {
  if (rep.aborted || rep.unknown.length > 0 || rep.applied !== PACKET_ELIGIBLE_COUNT) return false;
  if (rep.held.length !== PACKET_EXPECTED_OUTSIDE_HELD) return false;
  for (const h of rep.held) {
    if (eligibleCodes.has(h.code)) return false;
    if (h.reason !== "not-in-eligible-set") return false;
  }
  return true;
}

export interface PacketReport {
  result: "APPLIED" | "HOLD";
  date: string;
  runId: string;
  receiptKey: string | null;
  applied: number;
  unknown: number;
  write0: number;
  held: number;
  excluded: number;
  aborted: boolean;
  sends: { d1select: number; d1post: number; notionApi: number; notionHosted: number };
  d1failed: number;
  gate: { notion: number; hosted: number; rejected: number; perRule: Record<string, number> };
  statsDelta: { requests: number; transientRetries: number; rateLimited: number };
  chunkBodiesSha256: string;
  reportPath: string;
  holds: string[];
}

export interface PacketOpts {
  attemptLog: string;
  reportOut: string;
}

export async function runPacketOnce(opts: PacketOpts): Promise<PacketReport> {
  // freshness: attemptLog・reportOut・d1dir が全て absent でなければ fetch 前に STOP。
  if (existsSync(opts.attemptLog)) failPreflight(`attemptLog 既存 (replay 防止)`);
  if (existsSync(opts.reportOut)) failPreflight(`reportOut 既存 (replay 防止)`);
  const d1dir = join(dirname(opts.reportOut), "d1");
  if (existsSync(d1dir)) failPreflight(`d1dir 既存 (replay 防止)`);
  preflightPacket();
  assertCanonicalEnv();
  const clock = () => new Date().toISOString();
  resetNotionStats();
  const before = notionStats();
  initAttemptLog(opts.attemptLog);
  mkdirSync(d1dir, { recursive: true, mode: 0o700 });
  const frozenR1 = loadFrozenR1();
  const eligible = await loadFrozenEligible();
  const ctx: PacketCtx = {
    attemptLog: opts.attemptLog,
    reportOut: opts.reportOut,
    d1dir,
    clock,
    frozenR1,
    frozenBodies: loadFrozenBodies(),
    parentGuard: loadFrozenParent(eligible, frozenR1),
    eligible,
    db: createDailyDb(),
    sendBatchRaw: createD1HttpBatchSender(),
    d1counters: { observed: 0, failed: 0 },
    d1receipts: [],
    d1seq: 0,
    batchIndex: 0,
    gate: { notion: 0, hosted: 0, rejected: 0, perRule: {} },
  };
  // B full11 は不変参照 (preflight の SHA 照合のみ。書込対象外)。
  appendAttemptSync(opts.attemptLog, { phase: "packet-start", date: PACKET_DATE, at: clock() });
  const deps: GapRepairDeps = {
    loadCustody: () => loadRetainedCustody(ctx),
    loadTargets: () => loadCheckedTargets(ctx),
    readRows: (stockIds, date) => readCheckedRows(ctx, stockIds, date),
    sendBatch: (statements) => sendCheckedBatch(ctx, statements),
    record: (args) =>
      withNotionGate(ctx, async () => {
        const res = await recordPrimaryData(args);
        // known-result を verify の前に即時保存。
        writeExclusiveSync(
          join(dirname(opts.reportOut), "receipt-record.json"),
          new TextEncoder().encode(
            JSON.stringify(
              {
                key: args.key, pageId: res.pageId, outcome: res.outcome,
                manifestMatch: res.manifestMatch, fileTooLarge: res.fileTooLarge,
                recordedAt: clock(),
              },
              null,
              1
            ) + "\n"
          )
        );
        return res;
      }),
    persistProof: (proof) => persistReceiptProofFile(RECEIPT_PROOF_DIR, proof),
    verifyReceipt: (pageId, filename, bytes) =>
      withNotionGate(ctx, () => verifyReceiptAttachment(pageId, filename, bytes)),
    probeProofAbsent: (probeRunId) => probeReceiptProofAbsent(RECEIPT_PROOF_DIR, probeRunId),
  };
  const runId = priceSyncBatchRunId(Date.now());
  const rep = await runGapRepair(runId, ctx.eligible, deps, clock);
  const after = notionStats();
  // private full report を先に wx0600+fsync で persist (per-code 明細は private)。
  writeExclusiveSync(
    opts.reportOut,
    new TextEncoder().encode(
      JSON.stringify(
        {
          date: rep.date, runId: rep.runId, diagKey: rep.diagKey, receiptKey: rep.receiptKey,
          applied: rep.applied, unknown: rep.unknown, write0: rep.write0,
          held: rep.held, excluded: rep.excluded, aborted: rep.aborted, abortReason: rep.abortReason,
          sends: {
            d1select: ctx.d1counters.observed, d1post: ctx.batchIndex,
            notionApi: ctx.gate.notion, notionHosted: ctx.gate.hosted,
          },
          d1receipts: ctx.d1receipts,
          gate: ctx.gate,
          chunkBodiesSha256: PINNED_PACKET_ARTIFACTS.chunkBodies.sha256,
          finishedAt: clock(),
        },
        null,
        1
      ) + "\n"
    )
  );
  appendAttemptSync(opts.attemptLog, { phase: "packet-done", applied: rep.applied, at: clock() });
  const clean = classifyPacketClean(rep, eligible.codes);
  return {
    result: clean ? "APPLIED" : "HOLD",
    date: rep.date,
    runId: rep.runId,
    receiptKey: rep.receiptKey,
    applied: rep.applied,
    unknown: rep.unknown.length,
    write0: rep.write0.length,
    held: rep.held.length,
    excluded: rep.excluded.length,
    aborted: rep.aborted,
    sends: {
      d1select: ctx.d1counters.observed, d1post: ctx.batchIndex,
      notionApi: ctx.gate.notion, notionHosted: ctx.gate.hosted,
    },
    d1failed: ctx.d1counters.failed,
    gate: { notion: ctx.gate.notion, hosted: ctx.gate.hosted, rejected: ctx.gate.rejected, perRule: ctx.gate.perRule },
    statsDelta: {
      requests: after.requests - before.requests,
      transientRetries: after.transientRetries - before.transientRetries,
      rateLimited: after.rateLimited - before.rateLimited,
    },
    chunkBodiesSha256: PINNED_PACKET_ARTIFACTS.chunkBodies.sha256,
    reportPath: opts.reportOut,
    holds: clean ? [] : ["HOLD"],
  };
}

function argVal(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
}

function printScopeAndExit(): never {
  console.info(
    [
      "[price40-cas-execute] fixed-packet CAS executor (未実行)。",
      `対象: 固定 40 行 (9/29) のみ。custody 再取得 0・R1 exact・frozen body exact-send。`,
      "順序: preflight(送信0) → retained custody → R1 照合 → preimage → probe → batch ≤4 → readback → receipt。",
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
    preflightPacket();
    assertCanonicalEnv();
    console.info(
      JSON.stringify(
        {
          result: "PREFLIGHT",
          date: PACKET_DATE,
          count: PACKET_ELIGIBLE_COUNT,
          manifestSha256: PACKET_DIAG_MANIFEST_SHA256,
          d1UrlSha256: PACKET_D1_URL_SHA,
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
  const report = await runPacketOnce({
    attemptLog: attemptLog as string,
    reportOut: reportOut as string,
  });
  console.info(JSON.stringify(report, null, 2));
  if (report.result !== "APPLIED" || report.holds.length > 0) process.exitCode = 1;
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
    if (/^(price40 (STOP|gate):|archive gate:|HOLD:)/.test(msg)) {
      console.error("[price40-cas-execute] エラー:", msg);
    } else {
      const kept = saveErrorDetailHold(argVal(process.argv.slice(2), "--report-out"), msg);
      console.error(
        "[price40-cas-execute] エラー: 実行失敗" + (kept ? " (詳細は private 証跡)" : " (詳細の退避に失敗)")
      );
    }
    process.exit(1);
  });
}


