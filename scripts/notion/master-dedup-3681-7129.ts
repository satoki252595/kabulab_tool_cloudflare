import "dotenv/config";
// Issue #102: ①銘柄マスタ重複 (3681/7129) の単発解消 CLI。
//
//   既定 (plan): 読み取りのみ。ガード照合・移行 op 一覧・D1 照合・一次出典の
//     再確認を行い、結果を stdout + snapshot-dir/plan-*.json に出す (書込なし)。
//   --apply --window-confirmed: snapshot→一次データ保管→検証→relation 移行→
//     補足修復→D1 照合→退避→最終検証。writer の解放後に限る。
//
// 実行は nix 経由 (証拠の codelist 解析に pipeline の既存 reader を使う):
//   nix develop -c pnpm notion:master-dedup-3681-7129
//   nix develop -c pnpm notion:master-dedup-3681-7129 -- --apply --window-confirmed
//
// 共有 Notion 窓口 (src/shared/notion-archive) への変更は含まない。Notion への
// 要求は全て `notionRequest` (既存の直列化・最小間隔・再試行) を通り、財務
// writer と integration を共有するため既定で 2 秒の追加 pacing を挟む
// (約 0.5rps。--pace-ms で変更可)。D1/公開取得は別系統のため pacing 外。
//
// 終了コード: 0=成功 / 2=ガード・検証不一致 (apply はその時点までの receipt を
// 残して停止) / 3=使い方・設定エラー。
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sharedEnv } from "../../src/shared/env.js";
import {
  findAllBackupChildrenByTitle,
  moveToTrash,
  recordPrimaryData,
} from "../../src/shared/notion-archive/archive.js";
import { notionRequest } from "../../src/shared/notion-archive/client.js";
import { notionEnv } from "../../src/shared/notion-archive/env.js";
import {
  SUPPLEMENT_PROPS,
  updateSupplementRow,
} from "../../src/shared/notion-archive/stock-supplement.js";
import {
  ARCHIVE_SERVICE,
  FWD_PROP_RAW,
  LIFECYCLE_PATCH_3681_STATUS,
  MasterPageView,
  MigrationOp,
  REL_PROP_MASTER,
  REL_PROP_RELATED,
  RELATION_PATCH_BYTES_MAX,
  REVERSE_PROP_DISCLOSURES,
  REVERSE_PROP_FINANCIALS,
  SNAPSHOT_KEY,
  SUPPLEMENT_7129_PAGE_ID,
  TARGETS,
  allMigrated,
  emptyReceipt,
  guardMasterView,
  guardSupplement,
  normalizePageId,
  planMigration,
  propertiesEqualExcept,
  relationPatchBytes,
  selectKeepId,
  sha256HexBytes,
  sha256HexUtf8,
  stableStringify,
  verifyOpResult,
  verifyReverseUnion,
  type DedupReceipt,
  type IncomingDb,
  type SupplementView,
} from "./master-dedup.js";

const execFileAsync = promisify(execFile);
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, "../..");
const PIPELINE_DIR = path.join(REPO_ROOT, "pipeline");

const EDINET_CODELIST_URL =
  "https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip";
const JPX_DELISTED_URL = "https://www.jpx.co.jp/listing/stocks/delisted/";

// ---------------------------------------------------------------------------
// 引数・設定
// ---------------------------------------------------------------------------

interface CliOptions {
  apply: boolean;
  windowConfirmed: boolean;
  snapshotDir: string;
  paceMs: number;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    apply: false,
    windowConfirmed: false,
    snapshotDir: path.join(REPO_ROOT, "tmp/master-dedup-3681-7129"),
    paceMs: 2000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") opts.apply = true;
    else if (a === "--window-confirmed") opts.windowConfirmed = true;
    else if (a === "--snapshot-dir") {
      const v = argv[++i];
      if (!v) throw new Error("--snapshot-dir にはディレクトリを指定してください");
      opts.snapshotDir = path.resolve(v);
    } else if (a === "--pace-ms") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) throw new Error("--pace-ms には 0 以上の数値を指定してください");
      opts.paceMs = v;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`不明な引数: ${a} (--help を参照)`);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(
    [
      "用法:",
      "  plan (既定・読取のみ):  pnpm notion:master-dedup-3681-7129 [-- --snapshot-dir DIR] [--pace-ms MS]",
      "  apply (書込・要解放):    pnpm notion:master-dedup-3681-7129 -- --apply --window-confirmed",
      "",
      "apply は財務 writer の解放が親から通知された後に限り実行する。",
      "snapshot/receipt/plan は --snapshot-dir 配下 (既定 tmp/・git 除外) に置く。",
    ].join("\n")
  );
}

function ensureSnapshotDirOutsideGit(dir: string): void {
  const rel = path.relative(REPO_ROOT, dir);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`--snapshot-dir はリポジトリ内の tmp/ 配下にしてください: ${dir}`);
  }
  if (rel !== "tmp" && !rel.startsWith(`tmp${path.sep}`)) {
    throw new Error(`snapshot (raw/IDs 含む) は git 除外の tmp/ 配下に置きます: ${dir}`);
  }
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Notion 読み取り像
// ---------------------------------------------------------------------------

interface NotionPage {
  id: string;
  created_time: string;
  last_edited_time: string;
  archived?: boolean;
  in_trash?: boolean;
  url?: string;
  properties: Record<string, Record<string, unknown>>;
}
interface ChildrenResponse {
  results: Array<{
    id: string;
    type: string;
    child_database?: { title?: string };
  }>;
  has_more: boolean;
  next_cursor: string | null;
}
interface QueryResponse {
  results: NotionPage[];
  has_more: boolean;
  next_cursor: string | null;
}

function readTitleText(prop: Record<string, unknown> | undefined): string {
  const arr = (prop?.["title"] ?? prop?.["rich_text"] ?? []) as Array<{ plain_text?: string }>;
  if (!Array.isArray(arr)) return "";
  return arr.map((t) => t.plain_text ?? "").join("");
}

function readRelationIds(prop: Record<string, unknown> | undefined): string[] {
  const rel = prop?.["relation"];
  if (!Array.isArray(rel)) return [];
  return rel.map((r) => String((r as { id?: unknown }).id ?? "")).filter((s) => s !== "");
}

/** paced な notionRequest。共有 integration の負荷を抑える追加間隔つき。 */
async function paced<T>(paceMs: number, fn: () => Promise<T>): Promise<T> {
  if (paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
  return fn();
}

async function getPage(paceMs: number, pageId: string): Promise<NotionPage> {
  return paced(paceMs, () => notionRequest<NotionPage>("GET", `/pages/${pageId}`));
}

async function listChildrenFirst(
  paceMs: number,
  pageId: string
): Promise<ChildrenResponse> {
  return paced(paceMs, () =>
    notionRequest<ChildrenResponse>("GET", `/blocks/${pageId}/children?page_size=100`)
  );
}

async function queryDb(
  paceMs: number,
  dbId: string,
  filter: Record<string, unknown>,
  pageSize: number
): Promise<QueryResponse> {
  return paced(paceMs, () =>
    notionRequest<QueryResponse>("POST", `/databases/${dbId}/query`, {
      filter,
      page_size: pageSize,
    })
  );
}

/** relation プロパティの全 ID をページ送りで読む (数千件の ⑤ 対応)。 */
async function readFullRelation(
  paceMs: number,
  pageId: string,
  propId: string
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const res = await paced(paceMs, () =>
      notionRequest<{ results: Array<{ id: string }>; has_more: boolean; next_cursor: string | null }>(
        "GET",
        `/pages/${pageId}/properties/${propId}${qs}`
      )
    );
    for (const r of res.results) ids.push(r.id);
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return ids;
}

function toMasterView(page: NotionPage, children: ChildrenResponse): MasterPageView {
  const relations: MasterPageView["relations"] = {};
  for (const [name, prop] of Object.entries(page.properties)) {
    if (prop["type"] === "relation") {
      relations[name] = {
        ids: readRelationIds(prop),
        has_more: prop["has_more"] === true,
      };
    }
  }
  return {
    id: page.id,
    code: readTitleText(page.properties["銘柄コード"]),
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    archived: page.archived === true,
    in_trash: page.in_trash === true,
    listed: page.properties["上場状態"]?.["checkbox"] === true,
    status: (page.properties["状態"]?.["select"] as { name?: string } | null | undefined)?.name ?? null,
    relations,
    rawIds: readRelationIds(page.properties[FWD_PROP_RAW]),
    blockCount: children.results.length,
    childDatabases: children.results
      .filter((b) => b.type === "child_database")
      .map((b) => b.child_database?.title ?? ""),
  };
}

// ---------------------------------------------------------------------------
// D1 (jss_notion_pages の 2 コード照合。読取 + 必要時の 2 行更新のみ)
// ---------------------------------------------------------------------------

interface D1QueryResponse {
  success: boolean;
  errors?: unknown;
  result?: Array<{
    results?: Array<Record<string, unknown>>;
    meta?: { changes?: number };
  }>;
}

async function d1Query(
  sql: string,
  params: unknown[]
): Promise<{ rows: Array<Record<string, unknown>>; changes: number }> {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${sharedEnv.CLOUDFLARE_ACCOUNT_ID()}` +
    `/d1/database/${sharedEnv.D1_DATABASE_ID()}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${sharedEnv.CLOUDFLARE_API_TOKEN()}`,
    },
    body: JSON.stringify({ sql, params }),
  });
  if (!res.ok) {
    throw new Error(`D1 HTTP ${res.status} (sql 先頭: ${sql.slice(0, 60)})`);
  }
  const data = (await res.json()) as D1QueryResponse;
  if (!data.success) {
    throw new Error(`D1 エラー: ${JSON.stringify(data.errors)} (sql 先頭: ${sql.slice(0, 60)})`);
  }
  const first = data.result?.[0];
  return { rows: first?.results ?? [], changes: first?.meta?.changes ?? 0 };
}

async function readD1MasterMap(): Promise<Record<string, string>> {
  const { rows } = await d1Query(
    "SELECT code, page_id FROM jss_notion_pages WHERE db = ? AND code IN (?, ?)",
    ["stock_master", "3681", "7129"]
  );
  const out: Record<string, string> = {};
  for (const r of rows) {
    out[String(r["code"])] = String(r["page_id"]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 一次出典の再確認 (plan/apply とも読取のみ。判定の正当化ゲート)
// ---------------------------------------------------------------------------

interface EvidenceResult {
  edinet: {
    fetchedAt: string;
    sha256: string;
    bytes: number;
    listedCount: number;
    has3681: boolean;
    has7129: boolean;
  };
  jpx: { fetchedAt: string; sha256: string; bytes: number; rowFound: boolean };
}

async function fetchBytes(url: string): Promise<{ bytes: Uint8Array; fetchedAt: string }> {
  const res = await fetch(url, {
    headers: { "User-Agent": "kabulab-master-dedup-102/read-only" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`公開取得失敗 ${url}: HTTP ${res.status}`);
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * EDINET コードリストの内容判定は pipeline の既存 reader
 * (`collectors/edinet_codelist.py::parse_codelist`。上場区分・証券コード
 * 正規化の正本) に委ねる。新規の ZIP/CSV 解析は作らない。
 */
async function judgeCodelist(zipPath: string): Promise<{
  has3681: boolean;
  has7129: boolean;
  listedCount: number;
}> {
  const script = [
    "import json, sys",
    "from jp_stock_pipeline.collectors.edinet_codelist import parse_codelist",
    "recs = parse_codelist(open(sys.argv[1], 'rb').read())",
    "codes = {r.code for r in recs}",
    "print(json.dumps({'has3681': '3681' in codes, 'has7129': '7129' in codes, 'n': len(codes)}))",
  ].join("; ");
  let out: string;
  try {
    const r = await execFileAsync("uv", ["run", "--no-sync", "python", "-c", script, zipPath], {
      cwd: PIPELINE_DIR,
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
    });
    out = r.stdout;
  } catch (e) {
    throw new Error(
      `codelist 判定の既存 reader 実行に失敗 (nix develop + pipeline venv が必要): ${(e as Error).message}`
    );
  }
  const parsed = JSON.parse(out) as { has3681: boolean; has7129: boolean; n: number };
  if (
    typeof parsed.has3681 !== "boolean" ||
    typeof parsed.has7129 !== "boolean" ||
    typeof parsed.n !== "number"
  ) {
    throw new Error(`codelist 判定の出力形式が不正: ${out.slice(0, 200)}`);
  }
  return { has3681: parsed.has3681, has7129: parsed.has7129, listedCount: parsed.n };
}

function judgeJpxDelistedRow(htmlBytes: Uint8Array): boolean {
  const html = new TextDecoder("utf-8").decode(htmlBytes).replace(/\s+/g, " ");
  // 「3681」の出現のいずれかの近傍に効力日と社名・事由があること。
  let idx = html.indexOf("3681");
  while (idx >= 0) {
    const window = html.slice(Math.max(0, idx - 600), idx + 600);
    if (
      window.includes("2026/07/01") &&
      (window.includes("ブイキューブ") || window.includes("上場維持基準への不適合"))
    ) {
      return true;
    }
    idx = html.indexOf("3681", idx + 1);
  }
  return false;
}

/**
 * 証拠を取得・判定する。plan では検証後にバイト列を捨て、apply では
 * snapshot-dir に残して snapshot・一次データ保管へ添付する。
 */
async function collectEvidence(args: {
  keepDir: string | null;
}): Promise<{ result: EvidenceResult; zipBytes: Uint8Array; htmlBytes: Uint8Array }> {
  const zip = await fetchBytes(EDINET_CODELIST_URL);
  const magic = Buffer.from(zip.bytes.slice(0, 4)).toString("binary");
  if (magic !== "PK\u0003\u0004") {
    throw new Error("EDINET コードリスト応答が zip ではありません (エラーページの疑い)");
  }
  // 既存 reader に渡すため一時ファイル化する (private 領域のみ)。
  const tmpZip = args.keepDir
    ? path.join(args.keepDir, "Edinetcode.zip")
    : path.join(fs.mkdtempSync(path.join(REPO_ROOT, "tmp/evidence-")), "Edinetcode.zip");
  fs.mkdirSync(path.dirname(tmpZip), { recursive: true });
  fs.writeFileSync(tmpZip, zip.bytes);
  let judged: { has3681: boolean; has7129: boolean; listedCount: number };
  try {
    judged = await judgeCodelist(tmpZip);
  } finally {
    if (!args.keepDir) fs.rmSync(path.dirname(tmpZip), { recursive: true, force: true });
  }
  const html = await fetchBytes(JPX_DELISTED_URL);
  if (args.keepDir) fs.writeFileSync(path.join(args.keepDir, "jpx-delisted.html"), html.bytes);
  return {
    result: {
      edinet: {
        fetchedAt: zip.fetchedAt,
        sha256: sha256HexBytes(zip.bytes),
        bytes: zip.bytes.length,
        listedCount: judged.listedCount,
        has3681: judged.has3681,
        has7129: judged.has7129,
      },
      jpx: {
        fetchedAt: html.fetchedAt,
        sha256: sha256HexBytes(html.bytes),
        bytes: html.bytes.length,
        rowFound: judgeJpxDelistedRow(html.bytes),
      },
    },
    zipBytes: zip.bytes,
    htmlBytes: html.bytes,
  };
}

/** 証拠が lifecycle 決定 (3681: listed=false 維持・状態=上場廃止) を支えるか。 */
function guardEvidence(e: EvidenceResult): string[] {
  const problems: string[] = [];
  if (e.edinet.has3681) {
    problems.push("EDINET コードリストに 3681 が存在します (listed=false の前提崩れ)");
  }
  if (!e.edinet.has7129) {
    problems.push("EDINET コードリストに 7129 が存在しません (listed=true の前提崩れ)");
  }
  if (!e.jpx.rowFound) {
    problems.push("JPX 上場廃止一覧に 3681 の 2026/07/01 行を確認できません");
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 新鮮な状態の読み取り (plan/apply 共通の入口)
// ---------------------------------------------------------------------------

interface FreshState {
  views: Record<string, MasterPageView>;
  pages: Record<string, NotionPage>;
  supplement: SupplementView;
  supplementPages: Record<string, NotionPage>;
  d1: Record<string, string>;
  evidence: EvidenceResult;
}

async function readFreshState(
  paceMs: number,
  opts: { evidenceKeepDir: string | null }
): Promise<FreshState> {
  const views: Record<string, MasterPageView> = {};
  const pages: Record<string, NotionPage> = {};
  for (const t of TARGETS) {
    for (const id of [t.keepId, t.retireId]) {
      const page = await getPage(paceMs, id);
      const children = await listChildrenFirst(paceMs, id);
      if (children.has_more) {
        throw new Error(`子ブロックの列挙が打ち切られました page=${id} (has_more)`);
      }
      pages[id] = page;
      views[`${t.code}:${normalizePageId(id) === normalizePageId(t.keepId) ? "keep" : "retire"}`] =
        toMasterView(page, children);
    }
  }
  const supplementDb = notionEnv.NOTION_STOCK_SUPPLEMENT_DB_ID() ?? "";
  if (!supplementDb) {
    throw new Error("NOTION_STOCK_SUPPLEMENT_DB_ID が未設定です (.env を確認してください)");
  }
  const byCode: SupplementView["byCode"] = {};
  const supplementPages: Record<string, NotionPage> = {};
  for (const code of ["3681", "7129"]) {
    const q = await queryDb(
      paceMs,
      supplementDb,
      { property: SUPPLEMENT_PROPS.code, rich_text: { equals: code } },
      10
    );
    if (q.has_more) throw new Error(`補足の code=${code} 検索が打ち切られました (has_more)`);
    byCode[code] = q.results.map((r) => ({
      pageId: r.id,
      masterIds: readRelationIds(r.properties[SUPPLEMENT_PROPS.master]),
    }));
    for (const r of q.results) supplementPages[r.id] = r;
  }
  const rowsReferencingTargets: SupplementView["rowsReferencingTargets"] = [];
  for (const t of TARGETS) {
    for (const id of [t.keepId, t.retireId]) {
      const q = await queryDb(
        paceMs,
        supplementDb,
        { property: SUPPLEMENT_PROPS.master, relation: { contains: id } },
        10
      );
      if (q.has_more) throw new Error(`補足の relation 検索が打ち切られました (has_more)`);
      for (const r of q.results) {
        rowsReferencingTargets.push({
          pageId: r.id,
          code: readTitleText(r.properties[SUPPLEMENT_PROPS.code]),
        });
      }
    }
  }
  const d1 = await readD1MasterMap();
  const { result: evidence } = await collectEvidence({ keepDir: opts.evidenceKeepDir });
  return {
    views,
    pages,
    supplement: { byCode, rowsReferencingTargets },
    supplementPages,
    d1,
    evidence,
  };
}

interface GuardReport {
  problems: string[];
  alreadyApplied: boolean;
  /** D1 が退避候補を指すコード (apply が 2 行更新で直す・plan では報告のみ)。 */
  d1PendingFix: string[];
}

function guardFreshState(state: FreshState): GuardReport {
  const problems: string[] = [];
  // 最古規則と定数の一致 (全 writer の共通規則)。
  for (const t of TARGETS) {
    try {
      selectKeepId(t);
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  const keepsActive = TARGETS.every((t) => {
    const keep = state.views[`${t.code}:keep`];
    return !keep.archived && !keep.in_trash;
  });
  const retiresArchived = TARGETS.every((t) => {
    const retire = state.views[`${t.code}:retire`];
    return retire.archived || retire.in_trash;
  });
  const alreadyApplied = keepsActive && retiresArchived;
  if (!alreadyApplied) {
    for (const t of TARGETS) {
      problems.push(...guardMasterView(t, "keep", state.views[`${t.code}:keep`]));
      problems.push(...guardMasterView(t, "retire", state.views[`${t.code}:retire`]));
    }
    problems.push(...guardSupplement(state.supplement));
  }
  const d1PendingFix: string[] = [];
  for (const t of TARGETS) {
    const got = state.d1[t.code];
    if (got === undefined) {
      problems.push(`D1 stock_master に ${t.code} の行がありません`);
    } else if (normalizePageId(got) === normalizePageId(t.keepId)) {
      // 正常
    } else if (normalizePageId(got) === normalizePageId(t.retireId)) {
      d1PendingFix.push(t.code);
    } else {
      problems.push(`D1 stock_master の ${t.code} が想定外の ID を指しています got=${got}`);
    }
  }
  problems.push(...guardEvidence(state.evidence));
  return { problems, alreadyApplied, d1PendingFix };
}

// ---------------------------------------------------------------------------
// plan (読取のみ)
// ---------------------------------------------------------------------------

function tsTag(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function runPlan(opts: CliOptions): Promise<number> {
  const state = await readFreshState(opts.paceMs, { evidenceKeepDir: null });
  const { problems, alreadyApplied, d1PendingFix } = guardFreshState(state);
  const preview = TARGETS.map((t) => {
    const retire = state.views[`${t.code}:retire`];
    return {
      code: t.code,
      keep: t.keepId,
      retire: t.retireId,
      retiringRows: {
        disclosures: retire.relations[REVERSE_PROP_DISCLOSURES]?.ids ?? [],
        financials: retire.relations[REVERSE_PROP_FINANCIALS]?.ids ?? [],
        raws: state.pages[t.retireId]
          ? readRelationIds(state.pages[t.retireId].properties[FWD_PROP_RAW])
          : [],
      },
      lifecycle:
        t.code === "3681"
          ? { prop: "状態", before: state.views["3681:keep"].status, after: LIFECYCLE_PATCH_3681_STATUS }
          : { prop: "状態", before: null, after: null },
    };
  });
  const plan = {
    mode: "plan",
    takenAt: new Date().toISOString(),
    alreadyApplied,
    problems,
    targets: preview,
    supplement: {
      fix7129: { pageId: SUPPLEMENT_7129_PAGE_ID, masterAfter: TARGETS[1].keepId },
      rows3681: (state.supplement.byCode["3681"] ?? []).length,
    },
    d1: state.d1,
    d1PendingFix,
    evidence: state.evidence,
  };
  const outPath = path.join(opts.snapshotDir, `plan-${tsTag()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(plan, null, 2));
  console.log(JSON.stringify({ plan: outPath, alreadyApplied, d1PendingFix, problems }, null, 2));
  if (alreadyApplied) {
    console.log("すでに適用済みの状態です (保持先のみ有効・退避候補は archived)。");
    return 0;
  }
  if (problems.length > 0) {
    console.log(`ガード不一致 ${problems.length} 件のため apply 不可。plan のみ保存しました。`);
    return 2;
  }
  console.log("ガード合格。writer 解放後に --apply --window-confirmed で適用できます。");
  return 0;
}

// ---------------------------------------------------------------------------
// apply (書込。要 --window-confirmed)
// ---------------------------------------------------------------------------

function receiptPath(snapshotDir: string): string {
  return path.join(snapshotDir, "receipt.json");
}

function loadReceipt(snapshotDir: string): DedupReceipt {
  const p = receiptPath(snapshotDir);
  if (!fs.existsSync(p)) return emptyReceipt();
  const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as DedupReceipt;
  if (parsed.version !== 1 || typeof parsed.migrated !== "object" || typeof parsed.retired !== "object") {
    throw new Error(`receipt が壊れています (手動確認が必要): ${p}`);
  }
  return parsed;
}

function saveReceipt(snapshotDir: string, receipt: DedupReceipt): void {
  const tmp = `${receiptPath(snapshotDir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(receipt, null, 2));
  fs.renameSync(tmp, receiptPath(snapshotDir));
}

interface SnapshotDoc {
  version: 1;
  takenAt: string;
  masters: Record<string, { code: string; role: "keep" | "retire"; page: NotionPage; children: ChildrenResponse }>;
  incoming: Record<string, { db: IncomingDb; prop: string; page: NotionPage; relationFull: string[] }>;
  supplement: Record<string, NotionPage>;
  d1: Record<string, string>;
  evidence: EvidenceResult;
  sha256: string;
}

function snapshotWithoutHash(s: SnapshotDoc): Record<string, unknown> {
  const { sha256: _drop, ...rest } = s;
  void _drop;
  return rest as Record<string, unknown>;
}

async function takeSnapshot(
  paceMs: number,
  snapshotDir: string,
  state: FreshState
): Promise<{ snapshot: SnapshotDoc; file: string }> {
  const file = path.join(snapshotDir, `snapshot-${tsTag()}.json`);
  const masters: SnapshotDoc["masters"] = {};
  const freshViews: Record<string, MasterPageView> = {};
  for (const t of TARGETS) {
    for (const [role, id] of [["keep", t.keepId], ["retire", t.retireId]] as const) {
      // ガードから snapshot までの隙間を塞ぐため master 4 ページを取り直す。
      const page = await getPage(paceMs, id);
      const children = await listChildrenFirst(paceMs, id);
      if (children.has_more) {
        throw new Error(`snapshot 中止: 子ブロックが打ち切られました page=${id} (has_more)`);
      }
      masters[id] = { code: t.code, role, page, children };
      freshViews[`${t.code}:${role}`] = toMasterView(page, children);
    }
  }
  for (const t of TARGETS) {
    const p = [
      ...guardMasterView(t, "keep", freshViews[`${t.code}:keep`]),
      ...guardMasterView(t, "retire", freshViews[`${t.code}:retire`]),
    ];
    if (p.length > 0) {
      throw new Error(`snapshot 中止: ガード後の master 変化を検出: ${p.join(" / ")}`);
    }
  }
  // 移行対象の incoming 行 (退避候補の逆 relation + 原本)。
  const incoming: SnapshotDoc["incoming"] = {};
  const expectRetireLink: Array<{ rowPageId: string; db: IncomingDb; prop: string }> = [];
  for (const t of TARGETS) {
    const retireView = freshViews[`${t.code}:retire`];
    for (const rowId of retireView.relations[REVERSE_PROP_DISCLOSURES]?.ids ?? []) {
      expectRetireLink.push({ rowPageId: rowId, db: "disclosures", prop: REL_PROP_MASTER });
    }
    for (const rowId of retireView.relations[REVERSE_PROP_FINANCIALS]?.ids ?? []) {
      expectRetireLink.push({ rowPageId: rowId, db: "financials", prop: REL_PROP_MASTER });
    }
    for (const rawId of readRelationIds(masters[t.retireId].page.properties[FWD_PROP_RAW])) {
      expectRetireLink.push({ rowPageId: rawId, db: "raw_files", prop: REL_PROP_RELATED });
    }
  }
  // 決定論的順序 (DB 種別→page id)。
  const dbOrder: Record<IncomingDb, number> = { disclosures: 0, financials: 1, raw_files: 2 };
  expectRetireLink.sort(
    (a, b) => dbOrder[a.db] - dbOrder[b.db] || (a.rowPageId < b.rowPageId ? -1 : 1)
  );
  for (const exp of expectRetireLink) {
    const page = await getPage(paceMs, exp.rowPageId);
    const prop = page.properties[exp.prop];
    if (!prop || prop["type"] !== "relation") {
      throw new Error(
        `snapshot 中止: row=${exp.rowPageId} に relation「${exp.prop}」がありません (スキーマ変化)`
      );
    }
    let relationFull = readRelationIds(prop);
    const propId = String(prop["id"] ?? "");
    if (prop["has_more"] === true) {
      if (!propId) throw new Error(`snapshot 中止: relation プロパティ ID 不明 row=${exp.rowPageId}`);
      relationFull = await readFullRelation(paceMs, exp.rowPageId, propId);
    }
    const hasRetire = relationFull.some((id) =>
      TARGETS.some((t) => normalizePageId(id) === normalizePageId(t.retireId))
    );
    if (!hasRetire) {
      throw new Error(
        `snapshot 中止: row=${exp.rowPageId} の実配列に退避 ID がありません (同時変更の疑い)`
      );
    }
    incoming[exp.rowPageId] = { db: exp.db, prop: exp.prop, page, relationFull };
  }
  const supplement: SnapshotDoc["supplement"] = {};
  for (const [id, page] of Object.entries(state.supplementPages)) {
    supplement[id] = page;
  }
  const doc: SnapshotDoc = {
    version: 1,
    takenAt: new Date().toISOString(),
    masters,
    incoming,
    supplement,
    d1: state.d1,
    evidence: state.evidence,
    sha256: "",
  };
  doc.sha256 = sha256HexUtf8(stableStringify(snapshotWithoutHash(doc)));
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  // 書き直し読みで hash を再確認する。
  const reread = JSON.parse(fs.readFileSync(file, "utf8")) as SnapshotDoc;
  const rehash = sha256HexUtf8(stableStringify(snapshotWithoutHash(reread)));
  if (rehash !== doc.sha256) throw new Error("snapshot の再読 hash が一致しません");
  return { snapshot: doc, file };
}

function buildMigrationOps(snapshot: SnapshotDoc): MigrationOp[] {
  const ops: MigrationOp[] = [];
  for (const t of TARGETS) {
    // このコードの退避候補にぶら下がる行だけを対象にする。
    const retireRows = Object.entries(snapshot.incoming).filter(([, v]) =>
      v.relationFull.some((id) => normalizePageId(id) === normalizePageId(t.retireId))
    );
    ops.push(
      ...planMigration({
        retireId: t.retireId,
        keepId: t.keepId,
        rows: retireRows.map(([rowPageId, v]) => ({
          rowPageId,
          db: v.db,
          prop: v.prop,
          actualBefore: v.relationFull,
        })),
      })
    );
  }
  return ops;
}

/** snapshot を一次データ保管へ記録し、再読で検証する。 */
async function archiveSnapshot(
  snapshotDir: string,
  file: string,
  snapshot: SnapshotDoc,
  receipt: DedupReceipt
): Promise<DedupReceipt> {
  if (receipt.snapshot) {
    const page = await notionRequest<NotionPage>("GET", `/pages/${receipt.snapshot.archivePageId}`);
    verifyArchivePage(page, receipt.snapshot.sha256);
    return receipt;
  }
  const snapshotBytes = new Uint8Array(fs.readFileSync(file));
  const zipBytes = new Uint8Array(fs.readFileSync(path.join(snapshotDir, "Edinetcode.zip")));
  const htmlBytes = new Uint8Array(fs.readFileSync(path.join(snapshotDir, "jpx-delisted.html")));
  const dateTag = snapshot.takenAt.slice(0, 10);
  const res = await recordPrimaryData({
    service: ARCHIVE_SERVICE,
    key: SNAPSHOT_KEY,
    source: "Notion ①③④⑤ + D1 jss_notion_pages + JPX/EDINET 公開取得 (Issue #102 単発解消)",
    fetchedAt: snapshot.takenAt,
    metadata: {
      snapshotSha256: snapshot.sha256,
      snapshotFile: path.basename(file),
      masters: Object.keys(snapshot.masters).length,
      incomingRows: Object.keys(snapshot.incoming).length,
      supplementRows: Object.keys(snapshot.supplement).length,
      decisions: {
        keep3681: TARGETS[0].keepId,
        retire3681: TARGETS[0].retireId,
        keep7129: TARGETS[1].keepId,
        retire7129: TARGETS[1].retireId,
        lifecycle3681: { listedStaysFalse: true, statusAfter: LIFECYCLE_PATCH_3681_STATUS },
      },
      evidence: snapshot.evidence,
    },
    files: [
      { bytes: snapshotBytes, filename: `master-dedup-snapshot-${dateTag}.json`, contentType: "application/json" },
      { bytes: zipBytes, filename: `Edinetcode-${dateTag}.zip`, contentType: "application/zip" },
      { bytes: htmlBytes, filename: `jpx-delisted-${dateTag}.html`, contentType: "text/html" },
    ],
  });
  if (res.fileTooLarge) {
    throw new Error("一次データ保管に上限超過ファイルあり。正直に停止します (snapshot 未確定)");
  }
  const page = await notionRequest<NotionPage>("GET", `/pages/${res.pageId}`);
  verifyArchivePage(page, snapshot.sha256);
  receipt.snapshot = {
    file: path.basename(file),
    sha256: snapshot.sha256,
    archivePageId: res.pageId,
    archiveVerifiedAt: new Date().toISOString(),
  };
  saveReceipt(snapshotDir, receipt);
  return receipt;
}

function verifyArchivePage(page: NotionPage, wantSha: string): void {
  const status = (page.properties["Status"]?.["select"] as { name?: string } | null)?.name;
  if (status !== "recorded") {
    throw new Error(`一次データ保管の再読: Status=${status} (recorded でない) page=${page.id}`);
  }
  const files = page.properties["Files"]?.["files"];
  if (!Array.isArray(files) || files.length !== 3) {
    throw new Error(`一次データ保管の再読: Files が 3 件でありません page=${page.id}`);
  }
  const meta = readTitleText(page.properties["Metadata"]);
  if (!meta.includes(wantSha)) {
    throw new Error(`一次データ保管の再読: Metadata に snapshot sha がありません page=${page.id}`);
  }
}

async function applyLifecycle3681(
  paceMs: number,
  snapshotDir: string,
  snapshot: SnapshotDoc,
  receipt: DedupReceipt
): Promise<DedupReceipt> {
  const keepId = TARGETS[0].keepId;
  const before = snapshot.masters[keepId].page.properties as Record<string, unknown>;
  const checkRemote = async (): Promise<"done" | "todo" | "diverged"> => {
    const fresh = await getPage(paceMs, keepId);
    const props = fresh.properties as Record<string, unknown>;
    const status = (fresh.properties["状態"]?.["select"] as { name?: string } | null)?.name ?? null;
    if (status === LIFECYCLE_PATCH_3681_STATUS && propertiesEqualExcept("状態", before, props)) {
      const listed = fresh.properties["上場状態"]?.["checkbox"] === true;
      return !listed ? "done" : "diverged";
    }
    if (status === null && propertiesEqualExcept("状態", before, props)) return "todo";
    return "diverged";
  };
  const remote = await checkRemote();
  if (remote === "done") {
    if (!receipt.lifecycle3681) {
      receipt.lifecycle3681 = { patchedAt: "prior", verifiedAt: new Date().toISOString() };
      saveReceipt(snapshotDir, receipt);
    }
    return receipt;
  }
  if (remote === "diverged") {
    throw new Error("3681 保持先が snapshot と不一致 (同時変更の疑い)。lifecycle 更新を停止します");
  }
  await paced(paceMs, () =>
    notionRequest("PATCH", `/pages/${keepId}`, {
      properties: { 状態: { select: { name: LIFECYCLE_PATCH_3681_STATUS } } },
    })
  );
  const after = await checkRemote();
  if (after !== "done") throw new Error("3681 lifecycle 更新の再読検証に失敗しました");
  receipt.lifecycle3681 = {
    patchedAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
  };
  saveReceipt(snapshotDir, receipt);
  return receipt;
}

async function applyMigrations(
  paceMs: number,
  snapshotDir: string,
  snapshot: SnapshotDoc,
  ops: MigrationOp[],
  receipt: DedupReceipt
): Promise<DedupReceipt> {
  for (const op of ops) {
    const size = relationPatchBytes(op.prop, op.after);
    if (size > RELATION_PATCH_BYTES_MAX) {
      throw new Error(
        `relation PATCH が上限超過のため切り詰めず停止します row=${op.rowPageId} bytes=${size}`
      );
    }
    const snapProps = snapshot.incoming[op.rowPageId].page.properties as Record<string, unknown>;
    const recorded = receipt.migrated[op.rowPageId];
    const fresh = await getPage(paceMs, op.rowPageId);
    const current = readRelationIds(fresh.properties[op.prop]);
    const eqNorm = (a: string[], b: string[]) =>
      JSON.stringify(a.map(normalizePageId)) === JSON.stringify(b.map(normalizePageId));
    if (recorded) {
      if (eqNorm(current, recorded.after) && propertiesEqualExcept(op.prop, snapProps, fresh.properties)) {
        continue;
      }
      if (
        !eqNorm(current, recorded.before) ||
        !propertiesEqualExcept(op.prop, snapProps, fresh.properties)
      ) {
        throw new Error(
          `receipt 済み行が想定外の状態です (再開不能のため停止): row=${op.rowPageId}`
        );
      }
      // PATCH が失われ before に戻っている → 安全に再適用する。
    } else {
      if (!eqNorm(current, op.before) || !propertiesEqualExcept(op.prop, snapProps, fresh.properties)) {
        throw new Error(`移行前に行が変化しています (同時変更の疑い): row=${op.rowPageId}`);
      }
    }
    await paced(paceMs, () =>
      notionRequest("PATCH", `/pages/${op.rowPageId}`, {
        properties: { [op.prop]: { relation: op.after.map((id) => ({ id })) } },
      })
    );
    const reread = await getPage(paceMs, op.rowPageId);
    const problem = verifyOpResult(op, readRelationIds(reread.properties[op.prop]));
    if (problem) throw new Error(problem);
    if (!propertiesEqualExcept(op.prop, snapProps, reread.properties)) {
      throw new Error(`移行対象外のプロパティが変化しました row=${op.rowPageId}`);
    }
    receipt.migrated[op.rowPageId] = {
      db: op.db,
      prop: op.prop,
      before: op.before,
      after: op.after,
      verifiedAt: new Date().toISOString(),
    };
    saveReceipt(snapshotDir, receipt);
  }
  return receipt;
}

async function applySupplement7129(
  paceMs: number,
  snapshotDir: string,
  snapshot: SnapshotDoc,
  receipt: DedupReceipt
): Promise<DedupReceipt> {
  const keepId = TARGETS[1].keepId;
  const snapPage = snapshot.supplement[SUPPLEMENT_7129_PAGE_ID];
  if (!snapPage) throw new Error("snapshot に 7129 補足行がありません");
  const snapProps = snapPage.properties as Record<string, unknown>;
  const fresh = await getPage(paceMs, SUPPLEMENT_7129_PAGE_ID);
  const current = readRelationIds(fresh.properties[SUPPLEMENT_PROPS.master]);
  const isDone =
    current.length === 1 &&
    normalizePageId(current[0]) === normalizePageId(keepId) &&
    propertiesEqualExcept(SUPPLEMENT_PROPS.master, snapProps, fresh.properties);
  if (isDone) {
    if (!receipt.supplement7129) {
      receipt.supplement7129 = { pageId: SUPPLEMENT_7129_PAGE_ID, verifiedAt: new Date().toISOString() };
      saveReceipt(snapshotDir, receipt);
    }
    return receipt;
  }
  if (current.length !== 0 || !propertiesEqualExcept(SUPPLEMENT_PROPS.master, snapProps, fresh.properties)) {
    throw new Error("7129 補足行が snapshot と不一致 (同時変更の疑い)。修復を停止します");
  }
  await updateSupplementRow(SUPPLEMENT_7129_PAGE_ID, { masterPageId: keepId });
  const reread = await getPage(paceMs, SUPPLEMENT_7129_PAGE_ID);
  const afterIds = readRelationIds(reread.properties[SUPPLEMENT_PROPS.master]);
  if (afterIds.length !== 1 || normalizePageId(afterIds[0]) !== normalizePageId(keepId)) {
    throw new Error("7129 補足の master 修復の再読検証に失敗しました");
  }
  if (!propertiesEqualExcept(SUPPLEMENT_PROPS.master, snapProps, reread.properties)) {
    throw new Error("7129 補足の対象外プロパティが変化しました");
  }
  receipt.supplement7129 = { pageId: SUPPLEMENT_7129_PAGE_ID, verifiedAt: new Date().toISOString() };
  saveReceipt(snapshotDir, receipt);
  return receipt;
}

async function applyD1Check(
  snapshotDir: string,
  receipt: DedupReceipt
): Promise<DedupReceipt> {
  const fixed: string[] = [...(receipt.d1?.fixed ?? [])];
  const map = await readD1MasterMap();
  for (const t of TARGETS) {
    const got = map[t.code];
    if (got === undefined) throw new Error(`D1 stock_master に ${t.code} の行がありません`);
    if (normalizePageId(got) === normalizePageId(t.keepId)) continue;
    if (normalizePageId(got) !== normalizePageId(t.retireId)) {
      throw new Error(`D1 stock_master の ${t.code} が想定外の ID を指しています got=${got}`);
    }
    const now = Math.floor(Date.now() / 1000);
    await d1Query("UPDATE jss_notion_pages SET page_id = ?, updated_at = ? WHERE db = ? AND code = ?", [
      t.keepId,
      now,
      "stock_master",
      t.code,
    ]);
    const reread = await readD1MasterMap();
    if (normalizePageId(reread[t.code] ?? "") !== normalizePageId(t.keepId)) {
      throw new Error(`D1 ${t.code} 更新の再読検証に失敗しました`);
    }
    if (!fixed.includes(t.code)) fixed.push(t.code);
  }
  receipt.d1 = {
    checkedAt: receipt.d1?.checkedAt ?? new Date().toISOString(),
    fixed,
    verifiedAt: new Date().toISOString(),
  };
  saveReceipt(snapshotDir, receipt);
  return receipt;
}

function retireReason(code: "3681" | "7129", keepId: string, receipt: DedupReceipt): string {
  const basis =
    code === "3681"
      ? "JPX 上場廃止 (効力 2026-07-01) 確定・EDINET 該当 0 のため保持先 listed=false 維持・状態=上場廃止を移行"
      : "保持先 listed=true・状態 null を維持 (退避側は旧原本のみ)";
  return (
    `#102 ①重複解消: ${code} の退避候補を保持先 ${keepId} へ統合。` +
    `snapshot=${receipt.snapshot?.archivePageId} sha256=${receipt.snapshot?.sha256} ` +
    `(service=${ARCHIVE_SERVICE} key=${SNAPSHOT_KEY})。${basis}。` +
    `移行 ${Object.keys(receipt.migrated).length} 行・補足7129・lifecycle・D1 を再読済み。`
  );
}

async function recoverTrashPageId(retireId: string): Promise<string | null> {
  const parent = notionEnv.NOTION_ARCHIVE_PAGE_ID();
  const hits = await findAllBackupChildrenByTitle({
    parentPageId: parent,
    title: `ごみ｜${ARCHIVE_SERVICE}`,
    kind: "database",
  });
  if (hits.length === 0) return null;
  const trashDb = hits.map((h) => h.id).sort()[0];
  const q = await notionRequest<QueryResponse>("POST", `/databases/${trashDb}/query`, {
    filter: { property: "Key", title: { equals: retireId } },
    page_size: 5,
  });
  return q.results[0]?.id ?? null;
}

function verifyTrashPage(page: NotionPage, keepId: string): void {
  const status = (page.properties["Status"]?.["select"] as { name?: string } | null)?.name;
  if (status !== "obsoleted") throw new Error(`退避行の Status が obsoleted でありません page=${page.id}`);
  if (!page.properties["Obsoleted At"]?.["date"]) {
    throw new Error(`退避行に Obsoleted At がありません page=${page.id}`);
  }
  const reason = readTitleText(page.properties["Obsoleted Reason"]);
  if (!reason.includes(keepId)) {
    throw new Error(`退避行の理由に保持先 ID がありません page=${page.id}`);
  }
  if (!page.properties["Origin Page"]?.["url"]) {
    throw new Error(`退避行に Origin Page がありません page=${page.id}`);
  }
}

async function applyRetire(
  paceMs: number,
  snapshotDir: string,
  ops: MigrationOp[],
  receipt: DedupReceipt
): Promise<DedupReceipt> {
  for (const t of TARGETS) {
    const recorded = receipt.retired[t.retireId];
    if (recorded) {
      const trash = await getPage(paceMs, recorded.trashPageId);
      verifyTrashPage(trash, t.keepId);
      const origin = await getPage(paceMs, t.retireId);
      if (!origin.archived && !origin.in_trash) {
        throw new Error(`退避済みのはずの元ページが有効です: ${t.retireId}`);
      }
      continue;
    }
    // 順序の強制: snapshot 確定・移行・補足・lifecycle・D1 が全て完了後のみ退避する。
    if (!receipt.snapshot?.archiveVerifiedAt) {
      throw new Error("snapshot なしで退避しません (moveToTrash 前に一次データ保管が必須)");
    }
    if (!allMigrated(ops, receipt) || !receipt.lifecycle3681 || !receipt.supplement7129 || !receipt.d1) {
      throw new Error("移行・補足・lifecycle・D1 の完了前に退避しません");
    }
    const origin = await getPage(paceMs, t.retireId);
    if (origin.archived || origin.in_trash) {
      // receipt 欠落のまま既に退避済み → 二重退避せず既存の退避行を探す。
      const found = await recoverTrashPageId(t.retireId);
      if (!found) {
        throw new Error(
          `元ページは archived だが退避行が見つかりません (二重退避を避けるため停止): ${t.retireId}`
        );
      }
      const trash = await getPage(paceMs, found);
      verifyTrashPage(trash, t.keepId);
      receipt.retired[t.retireId] = { trashPageId: found, verifiedAt: new Date().toISOString() };
      saveReceipt(snapshotDir, receipt);
      continue;
    }
    const { trashPageId } = await moveToTrash({
      service: ARCHIVE_SERVICE,
      originPageId: t.retireId,
      reason: retireReason(t.code, t.keepId, receipt),
    });
    const trash = await getPage(paceMs, trashPageId);
    verifyTrashPage(trash, t.keepId);
    const reread = await getPage(paceMs, t.retireId);
    if (!reread.archived && !reread.in_trash) {
      throw new Error(`退避後の元ページが archived になっていません: ${t.retireId}`);
    }
    receipt.retired[t.retireId] = { trashPageId, verifiedAt: new Date().toISOString() };
    saveReceipt(snapshotDir, receipt);
  }
  return receipt;
}

async function finalVerify(
  paceMs: number,
  snapshot: SnapshotDoc,
  receipt: DedupReceipt
): Promise<string[]> {
  const problems: string[] = [];
  const masterDb = notionEnv.NOTION_DB_STOCK_MASTER();
  for (const t of TARGETS) {
    const q = await queryDb(paceMs, masterDb, { property: "銘柄コード", rich_text: { equals: t.code } }, 10);
    const activeIds = q.results.map((r) => r.id);
    if (q.has_more || activeIds.length !== 1 || normalizePageId(activeIds[0]) !== normalizePageId(t.keepId)) {
      problems.push(`${t.code}: 有効行が保持先のみ 1 件になりません got=${activeIds.join(",")}`);
    }
    const retire = await getPage(paceMs, t.retireId);
    if (!retire.archived && !retire.in_trash) {
      problems.push(`${t.code}: 退避候補が archived になっていません`);
    }
    const keepFresh = await getPage(paceMs, t.keepId);
    const keepChildren = await listChildrenFirst(paceMs, t.keepId);
    const keepAfter = toMasterView(keepFresh, keepChildren);
    const snapKeep = snapshot.masters[t.keepId];
    const snapRetire = snapshot.masters[t.retireId];
    const beforeView = (m: SnapshotDoc["masters"][string]): MasterPageView =>
      toMasterView(m.page, m.children);
    for (const prop of [REVERSE_PROP_DISCLOSURES, REVERSE_PROP_FINANCIALS]) {
      const p = verifyReverseUnion({
        label: `${t.code}/${prop}`,
        keepBefore: beforeView(snapKeep).relations[prop]?.ids ?? [],
        retireBefore: beforeView(snapRetire).relations[prop]?.ids ?? [],
        keepAfter: keepAfter.relations[prop]?.ids ?? [],
        retireId: t.retireId,
        keepId: t.keepId,
      });
      if (p) problems.push(p);
    }
    if (t.code === "3681") {
      const status = (keepFresh.properties["状態"]?.["select"] as { name?: string } | null)?.name ?? null;
      const listed = keepFresh.properties["上場状態"]?.["checkbox"] === true;
      if (status !== LIFECYCLE_PATCH_3681_STATUS || listed) {
        problems.push(`3681: 保持先が listed=false・状態=上場廃止 になっていません`);
      }
    }
  }
  const supp = await getPage(paceMs, SUPPLEMENT_7129_PAGE_ID);
  const masterIds = readRelationIds(supp.properties[SUPPLEMENT_PROPS.master]);
  if (masterIds.length !== 1 || normalizePageId(masterIds[0]) !== normalizePageId(TARGETS[1].keepId)) {
    problems.push("7129: 補足の master が保持先のみ 1 件になっていません");
  }
  const d1 = await readD1MasterMap();
  for (const t of TARGETS) {
    if (normalizePageId(d1[t.code] ?? "") !== normalizePageId(t.keepId)) {
      problems.push(`D1 stock_master の ${t.code} が保持先を指していません`);
    }
  }
  void receipt;
  return problems;
}

function loadLatestSnapshot(snapshotDir: string): { snapshot: SnapshotDoc; file: string } {
  const files = fs
    .readdirSync(snapshotDir)
    .filter((f) => f.startsWith("snapshot-") && f.endsWith(".json"))
    .sort();
  if (files.length === 0) throw new Error(`snapshot がありません: ${snapshotDir}`);
  const file = path.join(snapshotDir, files[files.length - 1]);
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8")) as SnapshotDoc;
  const rehash = sha256HexUtf8(stableStringify(snapshotWithoutHash(snapshot)));
  if (rehash !== snapshot.sha256) throw new Error(`snapshot の hash が一致しません: ${file}`);
  return { snapshot, file };
}

async function runApply(opts: CliOptions): Promise<number> {
  let receipt = loadReceipt(opts.snapshotDir);
  if (receipt.completedAt) {
    console.log("receipt は完了済みです。再検証のみ行います (書込なし)。");
  }
  const state = await readFreshState(opts.paceMs, { evidenceKeepDir: opts.snapshotDir });
  const { problems, alreadyApplied } = guardFreshState(state);
  if (alreadyApplied) {
    // 適用済み状態では master/補足の事前ガードは走らず、problems は D1・証拠のみ。
    const evidenceProblems = guardEvidence(state.evidence);
    const d1Problems = problems.filter((p) => !evidenceProblems.includes(p));
    if (evidenceProblems.length > 0 || d1Problems.length > 0) {
      console.log(JSON.stringify({ alreadyApplied: true, problems }, null, 2));
      return 2;
    }
    // D1 の遅れ (退避候補指し) だけは直してから再検証する (apply 許可域の書込)。
    receipt = await applyD1Check(opts.snapshotDir, receipt);
    try {
      const { snapshot } = loadLatestSnapshot(opts.snapshotDir);
      const verifyProblems = await finalVerify(opts.paceMs, snapshot, receipt);
      if (verifyProblems.length > 0) {
        console.log(JSON.stringify({ alreadyApplied: true, verifyProblems }, null, 2));
        return 2;
      }
    } catch (e) {
      console.log(
        JSON.stringify({ alreadyApplied: true, note: `最終検証を省略: ${(e as Error).message}` }, null, 2)
      );
      return receipt.completedAt ? 0 : 2;
    }
    if (!receipt.completedAt) {
      receipt.completedAt = new Date().toISOString();
      saveReceipt(opts.snapshotDir, receipt);
    }
    console.log("すでに適用済み・再検証合格のため書込 0 で終了します。");
    return 0;
  }
  if (problems.length > 0) {
    console.log(JSON.stringify({ problems }, null, 2));
    console.log("ガード不一致のため書込せず停止します。");
    return 2;
  }
  // snapshot 取得 (ガード合格直後の新鮮な読み取り)。
  let snapshot: SnapshotDoc;
  let snapshotFile: string;
  if (receipt.snapshot) {
    const loaded = loadLatestSnapshot(opts.snapshotDir);
    if (loaded.snapshot.sha256 !== receipt.snapshot.sha256) {
      throw new Error("receipt の snapshot sha と最新の snapshot が一致しません (手動確認が必要)");
    }
    snapshot = loaded.snapshot;
    snapshotFile = loaded.file;
  } else {
    const taken = await takeSnapshot(opts.paceMs, opts.snapshotDir, state);
    snapshot = taken.snapshot;
    snapshotFile = taken.file;
  }
  const ops = buildMigrationOps(snapshot);
  console.log(
    JSON.stringify(
      { snapshot: snapshotFile, sha256: snapshot.sha256, ops: ops.length, byDb: countByDb(ops) },
      null,
      2
    )
  );
  receipt = await archiveSnapshot(opts.snapshotDir, snapshotFile, snapshot, receipt);
  receipt = await applyLifecycle3681(opts.paceMs, opts.snapshotDir, snapshot, receipt);
  receipt = await applyMigrations(opts.paceMs, opts.snapshotDir, snapshot, ops, receipt);
  receipt = await applySupplement7129(opts.paceMs, opts.snapshotDir, snapshot, receipt);
  receipt = await applyD1Check(opts.snapshotDir, receipt);
  receipt = await applyRetire(opts.paceMs, opts.snapshotDir, ops, receipt);
  const verifyProblems = await finalVerify(opts.paceMs, snapshot, receipt);
  if (verifyProblems.length > 0) {
    console.log(JSON.stringify({ verifyProblems }, null, 2));
    return 2;
  }
  receipt.completedAt = new Date().toISOString();
  saveReceipt(opts.snapshotDir, receipt);
  console.log("適用完了。次回 biztag run で重複 0 を確認してください。");
  return 0;
}

function countByDb(ops: MigrationOp[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const op of ops) out[op.db] = (out[op.db] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`使い方エラー: ${(e as Error).message}`);
    process.exit(3);
  }
  try {
    ensureSnapshotDirOutsideGit(opts.snapshotDir);
  } catch (e) {
    console.error(`設定エラー: ${(e as Error).message}`);
    process.exit(3);
  }
  if (opts.apply && !opts.windowConfirmed) {
    console.error("apply には --window-confirmed が必要です (writer 解放の通知後に実行)。");
    process.exit(3);
  }
  if (opts.apply) {
    const code = await runApply(opts);
    process.exit(code);
  }
  const code = await runPlan(opts);
  process.exit(code);
}

main().catch((e) => {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
});


