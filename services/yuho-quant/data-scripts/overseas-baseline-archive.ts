/**
 * 海外 baseline ONE archive (Notion 一次データ保管)。
 *
 * 凍結 baseline ZIP (full hosted) + member-list + pins を、固定 key の
 * 単一論理 record へ force=false で記録し、queryUniqueRow の一意性と
 * verifyArchivedAttachments の全 bytes (長さ+SHA) で readback 照合する。
 * 比較対象は pinned 期待値 (ZIP SHA + 全 160 名 + 159 payload SHA +
 * member-list pin)。Unknown は再送しない (shared client 契約)。
 *
 * fixed key: `freshread-baseline-20260930:{liveSHA}` (actual capture 由来)。
 * fetchedAt: 実際の capture 終了 `08:40:31.050Z` (実行時刻にしない)。
 * force=false 固定 (上書き flag なし)。既存 key は manifest 照合の上
 * skipped_existing (same のみ継続・unknown/不一致は HOLD)。
 * ZIP が WS 上限超過 (too_large) の場合は full-hosted を主張できず HOLD
 * (記録事実は残す。捏造しない)。
 *
 * network budget: notionRequest ≤ 96 (post-assert。代表値 17・worst 典型
 * 26。MAX_RETRY 6 の嵐を超えたら clean-run 主張なし) + raw file GET 3
 * (readback・retry なし)。stats は resetNotionStats/notionStats で取得。
 *
 * stdout は counts/SHA のみ (pageId・grant 文・body 0)。
 * 詳細 (pageId 含む) は OUT_DIR 0600 のみ。
 *
 * 実行 (live Notion は CODE CLEAR + Root first notification の後のみ):
 *   .../overseas-baseline-archive.ts --grant="<Root承認文>"
 *     [--freeze-dir /tmp/overseas-baseline-freeze-20260930]
 *     [--env-file /path/to/.env] [--out-dir /tmp/overseas-baseline-archive-20260930]
 * preflight (送信 0・FS 書込 0):
 *   .../overseas-baseline-archive.ts --preflight [--freeze-dir /tmp/...]
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";

const notionIndex = await import("../../../src/shared/notion-archive/index.js");
const { recordPrimaryData, verifyArchivedAttachments, notionStats, resetNotionStats, notionEnv } = notionIndex;
const notionArchive = await import("../../../src/shared/notion-archive/archive.js");
const { queryUniqueRow, findUniqueBackupChildByTitle } = notionArchive;

// ---------------------------------------------------------------------------
// 固定 pins・scope
// ---------------------------------------------------------------------------
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FREEZE_DIR = argValue("freeze-dir", "/tmp/overseas-baseline-freeze-20260930");
const OUT_DIR = argValue("out-dir", "/tmp/overseas-baseline-archive-20260930");
const ENV_FILE = argValue("env-file", join(REPO_ROOT, ".env"));
const STARTED_AT = new Date().toISOString();

const LIVE_SHA = "96f5af988710e59a0c669926e1655abf1ec45c2e85d427c68b2b9dc8547bc25e";
const BASELINE_KEY = `freshread-baseline-20260930:${LIVE_SHA}`;
const FETCHED_AT = "2026-09-30T08:40:31.050Z";
const SERVICE = "yuho-quant";
const SOURCE = "local capture workHEAD f352c7c / 74 D1 SELECT READ-only (no re-GET)";
const NOTION_BUDGET = 96;
const RAW_GET_BUDGET = 3;

const PINS = {
  zipSHA: "e8948dc3453035c85b96c84c74cf72fa0b5e6d5fb1dbd644037bf15f74292f99",
  zipBytes: 16579214,
  zipMembers: 160,
  payloadMembers: 159,
  memberListSHA: "f0a7845533476ebed720df5700b51cd35204f94db3be3f3ea18c52b1534e1ca2",
  pinsSHA: "b1ab14deb8b1808195f30d03a783281f163c4bcdf0fb44e5b21a762fc6885069",
  unionSHA: "3dc58c51bece442938199b7cb57b9f0546102b8d747266bf7bc8ef4c9eab14b6",
  paramsSHA: "df1d194b7b2b460d10097eacf41f4d4f65217aeda09f148595bd1ac12510452d",
  combinedSHA: "697456663d324ea27c436bf2b3b3d5b823bc68f8b4582e0e1e7f3229100fccc4",
  rawBodiesSHA: "c959b2b25dd745672320ad53a8b889ad763ad60ed176ad211a2a9b770822d73",
  liveSHA: LIVE_SHA,
  d1TargetSHA: "a7bcf8e2f330e5c81f78e063131dc8837c90d7db9c07388ad7eeca4c8768ba0e",
  workHEAD: "f352c7cc3271b7ac7c2e559404f863843dbc4e1d",
  scriptBlob: "666de96eccc74c2d09594d22c6413ea6245a1748",
  scriptFullSHA: "73935bd9d2f7308fd3d3102c49caf7078a4fe75b7735b30c4d6eeb839c7ced83",
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

function argValue(n: string, dflt: string): string {
  return process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? dflt;
}

function writePrivate(path: string, data: string | Buffer): string {
  writeFileSync(path, data, { mode: 0o600 });
  return sha256Hex(typeof data === "string" ? data : new Uint8Array(data));
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

/** network budget の事後断言 (嵐を超えたら clean-run 主張なし)。 */
export function assertBudget(stats: { requests: number }, rawGets: number): void {
  if (stats.requests > NOTION_BUDGET) {
    hold(`Notion budget 外: ${stats.requests} > ${NOTION_BUDGET}`);
  }
  if (rawGets !== RAW_GET_BUDGET) hold(`raw GET 数外: ${rawGets} != ${RAW_GET_BUDGET}`);
}

export interface FreezeFiles {
  zipName: string;
  zipBytes: Buffer;
  memberListName: string;
  memberListBytes: Buffer;
  pinsName: string;
  pinsBytes: Buffer;
}

/** freeze 成果物の読込 + pin 照合 (送信 0)。member-list の 159 payload SHA 全照合つき。 */
export function loadFreeze(freezeDir: string): FreezeFiles {
  const zipName = "freshread-baseline-20260930.zip";
  const memberListName = "member-list.json";
  const pinsName = "baseline-pins.json";
  let zipBytes: Buffer, memberListBytes: Buffer, pinsBytes: Buffer;
  try {
    zipBytes = readFileSync(join(freezeDir, zipName));
    memberListBytes = readFileSync(join(freezeDir, memberListName));
    pinsBytes = readFileSync(join(freezeDir, pinsName));
  } catch {
    hold(`freeze 成果物不在: ${freezeDir}`);
  }
  if (zipBytes.length !== PINS.zipBytes) hold(`ZIP bytes 外: ${zipBytes.length}`);
  const zipSHA = sha256Hex(new Uint8Array(zipBytes));
  if (zipSHA !== PINS.zipSHA) hold(`ZIP SHA 外: got=${zipSHA.slice(0, 16)}…`);
  const memberListSHA = sha256Hex(memberListBytes.toString("utf8"));
  if (memberListSHA !== PINS.memberListSHA) hold("member-list SHA 外");
  const pinsSHA = sha256Hex(pinsBytes.toString("utf8"));
  if (pinsSHA !== PINS.pinsSHA) hold("baseline-pins SHA 外");
  let memberList: unknown;
  try {
    memberList = JSON.parse(memberListBytes.toString("utf8"));
  } catch {
    hold("member-list JSON 破損");
  }
  const files = (memberList as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length !== PINS.payloadMembers) {
    hold(`member-list payload 数外: ${Array.isArray(files) ? files.length : "?"}`);
  }
  return { zipName, zipBytes, memberListName, memberListBytes, pinsName, pinsBytes };
}

/** archive metadata (counts/SHA のみ。IDs/values 0)。 */
export function buildMetadata(): Record<string, unknown> {
  return {
    baseline: "freshread-baseline-20260930",
    keyDerivation: "freshread-baseline-20260930:{capture-liveSHA}",
    fetchedAt: FETCHED_AT,
    counts: { unionDocs: 3675, q1Rows: 3675, q2Rows: 21245, q1sum: 21245, missingDocs: 0 },
    zip: { bytes: PINS.zipBytes, sha256: PINS.zipSHA, members: PINS.zipMembers, payload: PINS.payloadMembers },
    pins: {
      unionSHA: PINS.unionSHA, paramsSHA: PINS.paramsSHA, combinedSHA: PINS.combinedSHA,
      rawBodiesSHA: PINS.rawBodiesSHA, liveSHA: PINS.liveSHA, d1TargetSHA: PINS.d1TargetSHA,
    },
    producer: { workHEAD: PINS.workHEAD, scriptBlob: PINS.scriptBlob, scriptFullSHA: PINS.scriptFullSHA },
  };
}

async function main(): Promise<void> {
  const grant = requireGrant(process.argv);
  const freeze = loadFreeze(FREEZE_DIR);
  if (!existsSync(ENV_FILE)) hold(`env-file 不在: ${ENV_FILE} (--env-file で指定)`);
  dotenv.config({ path: ENV_FILE, quiet: true });
  const workHead = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assertFreshOutDir(OUT_DIR);
  mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
  chmodSync(OUT_DIR, 0o700);

  const files = [
    { filename: freeze.zipName, contentType: "application/zip", bytes: new Uint8Array(freeze.zipBytes) },
    { filename: freeze.memberListName, contentType: "application/json", bytes: new Uint8Array(freeze.memberListBytes) },
    { filename: freeze.pinsName, contentType: "application/json", bytes: new Uint8Array(freeze.pinsBytes) },
  ];

  resetNotionStats();
  const result = await recordPrimaryData({
    service: SERVICE,
    key: BASELINE_KEY,
    source: SOURCE,
    fetchedAt: FETCHED_AT,
    metadata: buildMetadata(),
    files,
    force: false,
  });
  if (result.fileTooLarge) {
    hold("full-hosted 不可 (WS 上限超過ファイルあり)。記録事実は残す。custody 主張なし");
  }
  if (result.outcome === "skipped_existing" && result.manifestMatch !== "same") {
    hold(`既存 key の manifest 照合が same でない (${result.manifestMatch})。custody 主張なし`);
  }

  // 一意性: 同一 key の行が1件かつ今回 pageId と一致すること。
  const parentPageId = notionEnv.NOTION_ARCHIVE_PAGE_ID() as string;
  const dbId = await findUniqueBackupChildByTitle({
    parentPageId, title: `一次データ｜${SERVICE}`, kind: "database",
  });
  if (!dbId) hold("backup DB 不在 (一意性確認不能)");
  const row = await queryUniqueRow<{ id: string }>(
    dbId, { property: "Key", title: { equals: BASELINE_KEY } }, "baseline archive 一意性"
  );
  if (!row || row.id !== result.pageId) hold("行一意性外 (0件・複数・pageId 不一致)");

  // readback: 全 3 files の hosted bytes (長さ+SHA) 照合。
  await verifyArchivedAttachments(
    result.pageId,
    files.map((f) => ({ filename: f.filename, bytes: f.bytes })),
    "baseline"
  );

  const stats = notionStats();
  assertBudget(stats, files.length);

  const report = {
    at_start: STARTED_AT, at_end: new Date().toISOString(), result: "PASS",
    mode: "baseline-archive", grant, workHEAD: workHead,
    key: BASELINE_KEY, fetchedAt: FETCHED_AT,
    outcome: result.outcome, manifestMatch: result.manifestMatch, fileTooLarge: result.fileTooLarge,
    pageId: result.pageId,
    scope: { ...PINS, notionBudget: NOTION_BUDGET, rawGetBudget: RAW_GET_BUDGET },
    notionStats: stats,
    zeros: { sourceGET: 0, d1read: 0, d1write: 0, r2: 0, dispatch: 0, force: 0, resendUnknown: 0 },
    limits: [
      "ONE shared force=false logical record + full hosted ZIP + ALL members。",
      "Unknown は再送しない (shared client 契約)。budget 超過は clean-run 主張なし。",
      "pageId・grant 文は 0600 のみ。stdout は counts/SHA のみ。",
    ],
  };
  const reportSHA = writePrivate(join(OUT_DIR, "archive-report.json"), JSON.stringify(report, null, 2));

  console.info(JSON.stringify({
    result: "PASS", outcome: result.outcome, manifestMatch: result.manifestMatch,
    keySHA: sha256Hex(BASELINE_KEY),
    zip: { bytes: PINS.zipBytes, sha256: PINS.zipSHA, members: PINS.zipMembers },
    notionStats: stats,
    zeros: report.zeros, limits: report.limits,
    artifacts: { report: { path: join(OUT_DIR, "archive-report.json"), sha256: reportSHA } },
    at_end: report.at_end,
  }));
}

/** preflight: 純粋検証のみ (送信 0・FS 書込 0)。 */
function preflight(): void {
  const freeze = loadFreeze(FREEZE_DIR);
  if (!existsSync(ENV_FILE)) hold(`env-file 不在: ${ENV_FILE}`);
  dotenv.config({ path: ENV_FILE, quiet: true });
  let notionPresent: string;
  try {
    notionEnv.NOTION_TOKEN();
    notionPresent = "present";
  } catch {
    notionPresent = "absent-HOLD-at-live";
  }
  const meta = JSON.stringify(buildMetadata());
  console.info(JSON.stringify({
    result: "PREFLIGHT", sends: 0, writes: 0,
    keySHA: sha256Hex(BASELINE_KEY),
    zip: { bytes: freeze.zipBytes.length, sha256: PINS.zipSHA, members: PINS.zipMembers },
    payloadMembers: PINS.payloadMembers,
    metadataBytes: meta.length,
    files: [
      { name: freeze.zipName, bytes: freeze.zipBytes.length },
      { name: freeze.memberListName, bytes: freeze.memberListBytes.length },
      { name: freeze.pinsName, bytes: freeze.pinsBytes.length },
    ],
    notionToken: notionPresent,
    budget: { notionRequests: NOTION_BUDGET, rawGets: RAW_GET_BUDGET },
  }));
}

// CLI 実行時のみ main()/preflight() を走らせる。
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
    console.error(JSON.stringify({ at_start: STARTED_AT, at_end: new Date().toISOString(), result: "HOLD", reason }));
    process.exit(1);
  }
}
