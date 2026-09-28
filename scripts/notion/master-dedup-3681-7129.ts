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
  recordPrimaryData,
} from "../../src/shared/notion-archive/archive.js";
import { notionRequest } from "../../src/shared/notion-archive/client.js";
import { notionEnv } from "../../src/shared/notion-archive/env.js";
import { listPageFiles } from "../../src/shared/notion-archive/page-file.js";
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
  REVERSE_PROP_JUKYU,
  REVERSE_PROP_YUTAI,
  SNAPSHOT_KEY,
  SUPPLEMENT_7129_PAGE_ID,
  TARGETS,
  allMigrated,
  decideMigrationAction,
  decideRetireAction,
  decideSnapshotAction,
  emptyReceipt,
  guardIncomingSchema,
  guardMasterView,
  guardSupplement,
  hasSnapshotProgress,
  nonRelationPropsEqual,
  normalizePageId,
  planMigration,
  propertiesEqualExcept,
  relationPatchBytes,
  selectKeepId,
  sha256HexBytes,
  sha256HexUtf8,
  stableStringify,
  verifyIntermediateUnion,
  verifyOpResult,
  verifyReverseUnion,
  type DedupReceipt,
  type IncomingDb,
  type IncomingSchemaEvidence,
  type IncomingSchemaHit,
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

export interface NotionPage {
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

/**
 * ページの relation プロパティを全ページ送りで読む。preview (25 件) ではなく
 * 実配列を返す。has_more=false なら preview が実配列そのもの。
 * 実 flow の適用・再読は必ずこちらを使う (preview 比較は ⑤ で誤判定する)。
 */
export async function readRelationFull(
  paceMs: number,
  pageId: string,
  page: NotionPage,
  propName: string
): Promise<string[]> {
  const prop = page.properties[propName];
  if (!prop || prop["type"] !== "relation") {
    throw new Error(`row=${pageId} に relation「${propName}」がありません (スキーマ変化)`);
  }
  if (prop["has_more"] !== true) return readRelationIds(prop);
  const propId = String(prop["id"] ?? "");
  if (!propId) throw new Error(`relation プロパティ ID 不明 row=${pageId} prop=${propName}`);
  return readFullRelation(paceMs, pageId, propId);
}

/** DB query の全件をページ送りで読む (二重作成の full 検索用。page_size 1 依存禁止)。 */
export async function queryDbAll(
  paceMs: number,
  dbId: string,
  filter: Record<string, unknown>
): Promise<NotionPage[]> {
  const out: NotionPage[] = [];
  let cursor: string | undefined;
  for (;;) {
    const body: Record<string, unknown> = { filter, page_size: 100 };
    if (cursor) body["start_cursor"] = cursor;
    const res = await paced(paceMs, () =>
      notionRequest<QueryResponse>("POST", `/databases/${dbId}/query`, body)
    );
    out.push(...res.results);
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return out;
}

/**
 * Notion files の signed URL (S3) からバイト列を取得する。
 * 署名 URL への GET は api.notion.com ではないため共有 notionRequest ではなく
 * 素の fetch でよい (共有 archive.ts の既存流儀と同じ)。
 */
export async function downloadNotionFileBytes(url: string, label: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label} の実ダウンロード失敗 status=${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
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
// incoming スキーマ列挙 (/search→accessible DB schema→master 向け検出)
// ---------------------------------------------------------------------------

interface SearchDbResponse {
  results: Array<{
    id: string;
    archived?: boolean;
    in_trash?: boolean;
    title?: string | Array<{ plain_text?: string }>;
  }>;
  has_more: boolean;
  next_cursor: string | null;
}

interface DbSchemaResponse {
  id: string;
  title?: Array<{ plain_text?: string }>;
  properties: Record<
    string,
    {
      id: string;
      type: string;
      relation?: { database_id?: string; type?: string };
    }
  >;
}

function dbTitleOf(
  title: string | Array<{ plain_text?: string }> | undefined
): string {
  if (typeof title === "string") return title;
  if (!Array.isArray(title)) return "";
  return title.map((t) => t.plain_text ?? "").join("");
}

/**
 * integration が見える全 DB の schema を列挙し、master 向け relation を検出する。
 * single_property (逆向きに現れない片方向) の未知 incoming を止めるための
 * 一度だけの列挙。全 DB 全行 scan は不要 (schema のみ)。
 * 呼び出し側は `guardIncomingSchema` で未知を STOP し、証拠を snapshot に残す。
 */
export async function enumerateMasterIncoming(
  paceMs: number
): Promise<IncomingSchemaEvidence> {
  const masterDb = normalizePageId(notionEnv.NOTION_DB_STOCK_MASTER());
  const dbIds: Array<{ id: string; title: string }> = [];
  let cursor: string | null = null;
  for (;;) {
    const body: Record<string, unknown> = {
      filter: { property: "object", value: "database" },
      page_size: 100,
    };
    if (cursor) body["start_cursor"] = cursor;
    const res = await paced(paceMs, () =>
      notionRequest<SearchDbResponse>("POST", "/search", body)
    );
    for (const r of res.results) {
      if (r.archived === true || r.in_trash === true) continue;
      dbIds.push({ id: r.id, title: dbTitleOf(r.title) });
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  const hits: IncomingSchemaHit[] = [];
  for (const db of dbIds) {
    const schema = await paced(paceMs, () =>
      notionRequest<DbSchemaResponse>("GET", `/databases/${db.id}`)
    );
    const title = dbTitleOf(schema.title) || db.title;
    for (const [propName, def] of Object.entries(schema.properties)) {
      if (def.type !== "relation") continue;
      const target = def.relation?.database_id;
      if (!target) continue;
      if (normalizePageId(target) !== masterDb) continue;
      const relType =
        def.relation?.type === "single_property"
          ? "single_property"
          : def.relation?.type === "dual_property"
            ? "dual_property"
            : "unknown";
      hits.push({ dbId: db.id, dbTitle: title, propName, relType });
    }
  }
  hits.sort((a, b) =>
    a.dbTitle < b.dbTitle ? -1 : a.dbTitle > b.dbTitle ? 1 : a.propName < b.propName ? -1 : 1
  );
  return { enumeratedAt: new Date().toISOString(), dbCount: dbIds.length, hits };
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

export interface FreshState {
  views: Record<string, MasterPageView>;
  pages: Record<string, NotionPage>;
  supplement: SupplementView;
  supplementPages: Record<string, NotionPage>;
  d1: Record<string, string>;
  evidence: EvidenceResult;
  incomingSchema: IncomingSchemaEvidence;
  /** fresh 証拠バイト列 (再開時は一時領域のみ。snapshotDir の原本を上書きしない)。 */
  evidenceBytes?: { zipBytes: Uint8Array; htmlBytes: Uint8Array };
}

async function readFreshState(paceMs: number): Promise<FreshState> {
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
  // fresh 証拠は一時領域のみ (snapshotDir の原本 3 ファイルを上書きしない。
  // 再開でも fresh ZIP は hash が変わるため、上書きすると旧 snapshot SHA 確認が
  // STOP になり元原本も失われる。初回のみ呼出側が snapshotDir へ保存する)。
  const { result: evidence, zipBytes, htmlBytes } = await collectEvidence({ keepDir: null });
  const incomingSchema = await enumerateMasterIncoming(paceMs);
  return {
    views,
    pages,
    supplement: { byCode, rowsReferencingTargets },
    supplementPages,
    d1,
    evidence,
    incomingSchema,
    evidenceBytes: { zipBytes, htmlBytes },
  };
}

/** 初回 apply のみ fresh 証拠バイト列を snapshotDir へ保存する (再開時は呼ばない)。 */
export function saveFreshEvidence(
  snapshotDir: string,
  evidenceBytes: { zipBytes: Uint8Array; htmlBytes: Uint8Array } | undefined
): void {
  if (!evidenceBytes) throw new Error("fresh 証拠バイト列がありません (手動確認が必要)");
  fs.writeFileSync(path.join(snapshotDir, "Edinetcode.zip"), evidenceBytes.zipBytes);
  fs.writeFileSync(path.join(snapshotDir, "jpx-delisted.html"), evidenceBytes.htmlBytes);
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
  const alreadyApplied = isAlreadyAppliedViews(state.views);
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
  problems.push(...guardIncomingSchema(state.incomingSchema.hits));
  return { problems, alreadyApplied, d1PendingFix };
}

export function isAlreadyAppliedViews(views: Record<string, MasterPageView>): boolean {
  const keepsActive = TARGETS.every((t) => {
    const keep = views[`${t.code}:keep`];
    return keep && !keep.archived && !keep.in_trash;
  });
  const retiresArchived = TARGETS.every((t) => {
    const retire = views[`${t.code}:retire`];
    return retire && (retire.archived || retire.in_trash);
  });
  return keepsActive && retiresArchived;
}

/**
 * 中間状態ガード (再開用)。initial ガードとは分離し、receipt+snapshot に記録された
 * before/after のみ許可する。lifecycle-only・部分 relation・片方退避後も再開可能。
 * D1 は fixed 済みなら keep 必須、未 fixed なら keep/candidate の両方を許可し、
 * candidate は fresh 原値を snapshot が保持している前提で pendingFix として返す
 * (入口で keep を必須にすると candidate→keep 修復分岐が dead になるため)。
 */
export function guardIntermediateState(args: {
  state: FreshState;
  snapshot: SnapshotDoc;
  receipt: DedupReceipt;
  ops: MigrationOp[];
}): GuardReport {
  const { state, snapshot, receipt, ops } = args;
  const problems: string[] = [];
  for (const t of TARGETS) {
    try {
      selectKeepId(t);
    } catch (e) {
      problems.push((e as Error).message);
    }
  }
  // incoming schema は snapshot 証拠と完全一致 + 未知なし (再列挙と比較)。
  if (!snapshot.incomingSchema || !Array.isArray(snapshot.incomingSchema.hits)) {
    problems.push("snapshot に incomingSchema 証拠がありません (旧 snapshot・手動確認が必要)");
  } else {
    const snapHits = [...snapshot.incomingSchema.hits].sort((a, b) =>
      a.dbTitle < b.dbTitle ? -1 : a.dbTitle > b.dbTitle ? 1 : a.propName < b.propName ? -1 : 1
    );
    const freshHits = [...state.incomingSchema.hits].sort((a, b) =>
      a.dbTitle < b.dbTitle ? -1 : a.dbTitle > b.dbTitle ? 1 : a.propName < b.propName ? -1 : 1
    );
    if (JSON.stringify(freshHits) !== JSON.stringify(snapHits)) {
      problems.push(
        `incoming schema が snapshot 時と変化しています (snap=${snapHits.length} fresh=${freshHits.length})`
      );
    }
    problems.push(...guardIncomingSchema(state.incomingSchema.hits));
  }
  problems.push(...guardEvidence(state.evidence));
  const snapViewOf = (id: string): MasterPageView => {
    const m = snapshot.masters[id];
    if (!m) throw new Error(`snapshot に master がありません: ${id}`);
    return toMasterView(m.page, m.children);
  };
  for (const t of TARGETS) {
    for (const role of ["keep", "retire"] as const) {
      const id = role === "keep" ? t.keepId : t.retireId;
      const fresh = state.views[`${t.code}:${role}`];
      const tag = `${t.code}/${role}(中間)`;
      let snap: MasterPageView;
      try {
        snap = snapViewOf(id);
      } catch (e) {
        problems.push((e as Error).message);
        continue;
      }
      if (normalizePageId(fresh.id) !== normalizePageId(id)) {
        problems.push(`${tag}: page id 不一致 got=${fresh.id}`);
        continue;
      }
      if (fresh.code !== t.code) problems.push(`${tag}: 銘柄コード不一致 got=${fresh.code}`);
      if (fresh.created_time !== snap.created_time) {
        problems.push(`${tag}: created_time 不一致 (不変のはず) got=${fresh.created_time}`);
      }
      // archived: keep は常に active、retire は receipt に従う。
      if (role === "keep") {
        if (fresh.archived || fresh.in_trash) {
          problems.push(`${tag}: 保持先が archived/in_trash になっています`);
        }
      } else {
        const retired = receipt.retired[t.retireId] !== undefined;
        const marked = receipt.retireIssued?.[t.retireId] !== undefined;
        if (retired) {
          if (!fresh.archived && !fresh.in_trash) {
            problems.push(`${tag}: 退避済みのはずが有効です`);
          }
        } else if (marked) {
          // marker ありは active/archived の両方を許す (PATCH 断 or receipt 断)。
          // applyRetire が fresh の archived 状態で repatch/recover を決める。
        } else if (fresh.archived || fresh.in_trash) {
          problems.push(`${tag}: receipt/marker なしに archived になっています`);
        }
      }
      // listed/状態: 3681 keep のみ lifecycle の before/after を許す。
      if (t.code === "3681" && role === "keep") {
        if (receipt.lifecycle3681) {
          if (fresh.listed !== false || fresh.status !== LIFECYCLE_PATCH_3681_STATUS) {
            problems.push(`${tag}: lifecycle 済みのはずが listed=${fresh.listed} 状態=${fresh.status}`);
          }
        } else if (fresh.listed !== false || fresh.status !== null) {
          problems.push(`${tag}: 初期 listed=false・状態 null でありません got listed=${fresh.listed} 状態=${fresh.status}`);
        }
      } else if (fresh.listed !== snap.listed || fresh.status !== snap.status) {
        problems.push(`${tag}: listed/状態が snapshot と不一致 got listed=${fresh.listed} 状態=${fresh.status}`);
      }
      // last_edited: 変更したページのみ検査を外す (それ以外は snapshot と完全一致)。
      const lifecycleTouched = t.code === "3681" && role === "keep" && receipt.lifecycle3681 !== undefined;
      const retireTouched =
        role === "retire" &&
        (receipt.retired[t.retireId] !== undefined || receipt.retireIssued?.[t.retireId] !== undefined);
      if (!lifecycleTouched && !retireTouched && fresh.last_edited_time !== snap.last_edited_time) {
        problems.push(`${tag}: last_edited_time 不一致 got=${fresh.last_edited_time} want=${snap.last_edited_time}`);
      }
      // 逆 relation: 未移行なら snapshot 件数、移行中なら和の保存 + 記録一致。
      for (const prop of [REVERSE_PROP_DISCLOSURES, REVERSE_PROP_FINANCIALS]) {
        const f = fresh.relations[prop];
        const s = snap.relations[prop];
        if (!f || !s) {
          problems.push(`${tag}: 逆 relation ${prop} が見つかりません`);
          continue;
        }
        if (f.has_more) {
          problems.push(`${tag}: 逆 relation ${prop} に has_more=true (件数を信用できない)`);
          continue;
        }
      }
      // 原本 (順方向) は不変。
      if (fresh.rawIds.length !== snap.rawIds.length) {
        problems.push(`${tag}: 原本の件数不一致 got=${fresh.rawIds.length} want=${snap.rawIds.length}`);
      } else {
        const norm = (ids: string[]) => ids.map(normalizePageId).sort();
        if (JSON.stringify(norm(fresh.rawIds)) !== JSON.stringify(norm(snap.rawIds))) {
          problems.push(`${tag}: 原本の ID が snapshot と不一致`);
        }
      }
      // body (blockCount/子 DB) は不変 (archived でも消えない)。
      if (fresh.blockCount !== snap.blockCount) {
        problems.push(`${tag}: blockCount 不一致 got=${fresh.blockCount} want=${snap.blockCount}`);
      }
      const wantChildren = [...snap.childDatabases].sort();
      const gotChildren = [...fresh.childDatabases].sort();
      if (JSON.stringify(gotChildren) !== JSON.stringify(wantChildren)) {
        problems.push(`${tag}: 子 DB 不一致 got=[${gotChildren.join(",")}]`);
      }
    }
    // 和の保存 + 記録一致 (部分移行を許す)。
    const freshKeep = state.views[`${t.code}:keep`];
    const freshRetire = state.views[`${t.code}:retire`];
    const snapKeep = snapViewOf(t.keepId);
    const snapRetire = snapViewOf(t.retireId);
    const opsForCode = ops.filter((op) =>
      op.before.some((id) => normalizePageId(id) === normalizePageId(t.retireId))
    );
    const migratedForCode = opsForCode.filter((op) => receipt.migrated[op.rowPageId] !== undefined);
    if (migratedForCode.length === 0) {
      for (const prop of [REVERSE_PROP_DISCLOSURES, REVERSE_PROP_FINANCIALS]) {
        const fKeep = freshKeep.relations[prop]?.ids.length ?? -1;
        const sKeep = snapKeep.relations[prop]?.ids.length ?? -2;
        const fRetire = freshRetire.relations[prop]?.ids.length ?? -1;
        const sRetire = snapRetire.relations[prop]?.ids.length ?? -2;
        if (fKeep !== sKeep || fRetire !== sRetire) {
          problems.push(
            `${t.code}/${prop}(中間): 未移行のはずが件数変化 keep ${sKeep}→${fKeep} retire ${sRetire}→${fRetire}`
          );
        }
      }
    } else {
      for (const prop of [REVERSE_PROP_DISCLOSURES, REVERSE_PROP_FINANCIALS]) {
        const p = verifyIntermediateUnion({
          label: `${t.code}/${prop}(中間)`,
          snapKeep: snapKeep.relations[prop]?.ids ?? [],
          snapRetire: snapRetire.relations[prop]?.ids ?? [],
          freshKeep: freshKeep.relations[prop]?.ids ?? [],
          freshRetire: freshRetire.relations[prop]?.ids ?? [],
        });
        if (p) problems.push(p);
      }
      // 記録一致: 移行済みは keep 側、未移行は retire 側にあること (③④のみ)。
      const normSet = (ids: string[]) => new Set(ids.map(normalizePageId));
      for (const prop of [REVERSE_PROP_DISCLOSURES, REVERSE_PROP_FINANCIALS]) {
        const keepSet = normSet(freshKeep.relations[prop]?.ids ?? []);
        const retireSet = normSet(freshRetire.relations[prop]?.ids ?? []);
        for (const op of opsForCode.filter((o) => o.db === "disclosures" || o.db === "financials")) {
          const inKeep = keepSet.has(normalizePageId(op.rowPageId));
          const inRetire = retireSet.has(normalizePageId(op.rowPageId));
          // 逆向き表示名と DB の対応 (開示書類=disclosures・財務サマリ=financials)。
          const propDb = prop === REVERSE_PROP_DISCLOSURES ? "disclosures" : "financials";
          if (op.db !== propDb) continue;
          if (receipt.migrated[op.rowPageId]) {
            if (!inKeep || inRetire) {
              problems.push(`${t.code}/${prop}(中間): 移行済み ${op.rowPageId} が keep 側にありません`);
            }
          } else if (!inRetire || inKeep) {
            problems.push(`${t.code}/${prop}(中間): 未移行 ${op.rowPageId} が retire 側にありません`);
          }
        }
      }
    }
    for (const name of [REVERSE_PROP_JUKYU, REVERSE_PROP_YUTAI]) {
      for (const role of ["keep", "retire"] as const) {
        const f = state.views[`${t.code}:${role}`].relations[name];
        if (!f) {
          problems.push(`${t.code}/${role}(中間): 逆 relation ${name} が見つかりません`);
        } else if (f.has_more || f.ids.length !== 0) {
          problems.push(`${t.code}/${role}(中間): ${name} に想定外の参照`);
        }
      }
    }
  }
  // 補足: receipt に応じて before/after のみ許可する。
  if (receipt.supplement7129) {
    const rows7129 = state.supplement.byCode["7129"] ?? [];
    if (
      rows7129.length !== 1 ||
      rows7129[0].masterIds.length !== 1 ||
      normalizePageId(rows7129[0].masterIds[0]) !== normalizePageId(TARGETS[1].keepId)
    ) {
      problems.push("補足7129(中間): 修復済みのはずが keep のみ 1 件でありません");
    }
    if ((state.supplement.byCode["3681"] ?? []).length !== 0) {
      problems.push("補足3681(中間): 想定外の行あり");
    }
    const refs = state.supplement.rowsReferencingTargets;
    if (refs.length !== 1 || normalizePageId(refs[0].pageId) !== normalizePageId(SUPPLEMENT_7129_PAGE_ID)) {
      problems.push(`補足(中間): 対象参照が修復後の 7129 行のみ 1 件でありません got=${refs.length}`);
    }
  } else {
    problems.push(...guardSupplement(state.supplement).map((p) => `${p}(中間)`));
  }
  const d1PendingFix: string[] = [];
  for (const t of TARGETS) {
    const got = state.d1[t.code];
    if (got === undefined) {
      problems.push(`D1 stock_master に ${t.code} の行がありません`);
    } else if (receipt.d1?.fixed.includes(t.code)) {
      if (normalizePageId(got) !== normalizePageId(t.keepId)) {
        problems.push(`D1 stock_master の ${t.code} が fixed のはずが keep を指していません got=${got}`);
      }
    } else if (normalizePageId(got) === normalizePageId(t.keepId)) {
      // 未 fixed だが既に keep (no-op の見込み)。許可する。
    } else if (normalizePageId(got) === normalizePageId(t.retireId)) {
      // 未 fixed の candidate は fresh 原値 (snapshot.d1 が保持) を前提に許可し、
      // applyD1Check の candidate→keep 修復へ進める。入口で keep 必須にしない。
      d1PendingFix.push(t.code);
    } else {
      problems.push(`D1 stock_master の ${t.code} が想定外の ID を指しています got=${got}`);
    }
  }
  return { problems, alreadyApplied: false, d1PendingFix };
}

// ---------------------------------------------------------------------------
// plan (読取のみ)
// ---------------------------------------------------------------------------

function tsTag(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function runPlan(opts: CliOptions): Promise<number> {
  const state = await readFreshState(opts.paceMs);
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
    incomingSchema: state.incomingSchema,
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

export interface SnapshotDoc {
  version: 1;
  takenAt: string;
  masters: Record<string, { code: string; role: "keep" | "retire"; page: NotionPage; children: ChildrenResponse }>;
  incoming: Record<
    string,
    {
      db: IncomingDb;
      prop: string;
      page: NotionPage;
      relationFull: string[];
      blockCount: number;
      childDatabases: string[];
    }
  >;
  supplement: Record<string, NotionPage>;
  d1: Record<string, string>;
  evidence: EvidenceResult;
  incomingSchema: IncomingSchemaEvidence;
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
    // 非対象 body の後判定用に子ブロック像も物理 snapshot する。
    const children = await listChildrenFirst(paceMs, exp.rowPageId);
    if (children.has_more) {
      throw new Error(`snapshot 中止: 子ブロックが打ち切られました row=${exp.rowPageId} (has_more)`);
    }
    incoming[exp.rowPageId] = {
      db: exp.db,
      prop: exp.prop,
      page,
      relationFull,
      blockCount: children.results.length,
      childDatabases: children.results
        .filter((b) => b.type === "child_database")
        .map((b) => b.child_database?.title ?? ""),
    };
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
    incomingSchema: state.incomingSchema,
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

// ---------------------------------------------------------------------------
// 一次データ保管の full 検索 + 実ダウンロード検証 (二重作成の検出・回収用)
// ---------------------------------------------------------------------------

/** 保管/ごみ DB の全 ID (重複 title も全て。最古だけに頼らない)。 */
export async function findAllArchiveDbIds(
  service: string,
  kind: "backup" | "trash"
): Promise<string[]> {
  const parent = notionEnv.NOTION_ARCHIVE_PAGE_ID();
  const title = kind === "backup" ? `一次データ｜${service}` : `ごみ｜${service}`;
  const hits = await findAllBackupChildrenByTitle({
    parentPageId: parent,
    title,
    kind: "database",
  });
  return hits.map((h) => h.id);
}

/** Key 完全一致の全件 (全 DB×全ページ送り。page_size 1 依存禁止)。 */
export async function queryArchiveByKeyAll(
  paceMs: number,
  dbIds: string[],
  key: string
): Promise<NotionPage[]> {
  const out: NotionPage[] = [];
  for (const dbId of dbIds) {
    out.push(
      ...(await queryDbAll(paceMs, dbId, { property: "Key", title: { equals: key } }))
    );
  }
  out.sort((a, b) => (a.id < b.id ? -1 : 1));
  return out;
}

/** 保管ファイル名の期待値 (snapshot takenAt の日付タグから決定論的)。 */
export function expectedArchiveFileNames(dateTag: string): [string, string, string] {
  return [
    `master-dedup-snapshot-${dateTag}.json`,
    `Edinetcode-${dateTag}.zip`,
    `jpx-delisted-${dateTag}.html`,
  ];
}

/**
 * 保管ページの Files 3 件を実ダウンロードし、元バイト列 SHA と突合する。
 * Metadata 文字列・Files 件数のみではすり替え・欠損を検出できないため、
 * 移行前に必ず実バイト列で確認する。既存 `listPageFiles` (共有窓口) 再利用。
 */
export async function verifyArchiveDownload(
  archivePageId: string,
  expected: { names: [string, string, string]; shas: Record<string, string> }
): Promise<void> {
  const listed = await listPageFiles(archivePageId, "Files");
  if (listed.length !== 3) {
    throw new Error(
      `一次データ保管の実ダウンロード: Files が 3 件でありません got=${listed.length} page=${archivePageId}`
    );
  }
  for (const name of expected.names) {
    const hit = listed.find((f) => f.name === name);
    if (!hit) {
      throw new Error(
        `一次データ保管の実ダウンロード: ${name} がありません got=[${listed.map((f) => f.name).join(",")}] page=${archivePageId}`
      );
    }
    const bytes = await downloadNotionFileBytes(hit.url, name);
    const gotSha = sha256HexBytes(bytes);
    const wantSha = expected.shas[name];
    if (gotSha !== wantSha) {
      throw new Error(
        `一次データ保管の実ダウンロード: ${name} の SHA 不一致 got=${gotSha.slice(0, 12)}… want=${wantSha.slice(0, 12)}… page=${archivePageId}`
      );
    }
  }
}

/** snapshot を一次データ保管へ記録し、実ダウンロードで検証する。 */
export async function archiveSnapshot(
  paceMs: number,
  snapshotDir: string,
  file: string,
  snapshot: SnapshotDoc,
  receipt: DedupReceipt
): Promise<DedupReceipt> {
  const snapshotBytes = new Uint8Array(fs.readFileSync(file));
  const zipBytes = new Uint8Array(fs.readFileSync(path.join(snapshotDir, "Edinetcode.zip")));
  const htmlBytes = new Uint8Array(fs.readFileSync(path.join(snapshotDir, "jpx-delisted.html")));
  const dateTag = snapshot.takenAt.slice(0, 10);
  const names = expectedArchiveFileNames(dateTag);
  const localShas: Record<string, string> = {
    [names[0]]: sha256HexBytes(snapshotBytes),
    [names[1]]: sha256HexBytes(zipBytes),
    [names[2]]: sha256HexBytes(htmlBytes),
  };
  // 証拠 SHA は snapshot の正本と一致すること (すり替え検出)。
  if (localShas[names[1]] !== snapshot.evidence.edinet.sha256) {
    throw new Error("Edinetcode.zip の SHA が snapshot 証拠と不一致 (すり替えの疑い)");
  }
  if (localShas[names[2]] !== snapshot.evidence.jpx.sha256) {
    throw new Error("jpx-delisted.html の SHA が snapshot 証拠と不一致 (すり替えの疑い)");
  }
  if (receipt.snapshot) {
    // 再開時も実ダウンロードで元バイト列一致を確認してから移行する。
    const page = await notionRequest<NotionPage>("GET", `/pages/${receipt.snapshot.archivePageId}`);
    verifyArchivePage(page, receipt.snapshot.sha256);
    const wantShas: Record<string, string> = {
      [names[0]]: receipt.snapshot.snapshotBytesSha256 ?? localShas[names[0]],
      [names[1]]: receipt.snapshot.zipSha256 ?? localShas[names[1]],
      [names[2]]: receipt.snapshot.htmlSha256 ?? localShas[names[2]],
    };
    await verifyArchiveDownload(receipt.snapshot.archivePageId, { names, shas: wantShas });
    // 旧 receipt (bytes SHA なし) は今回の検証で埋める。
    if (!receipt.snapshot.snapshotBytesSha256) {
      receipt.snapshot.snapshotBytesSha256 = localShas[names[0]];
      receipt.snapshot.zipSha256 = localShas[names[1]];
      receipt.snapshot.htmlSha256 = localShas[names[2]];
      receipt.snapshot.fileNames = [...names];
      receipt.snapshot.archiveVerifiedAt = new Date().toISOString();
      saveReceipt(snapshotDir, receipt);
    }
    return receipt;
  }
  // 非冪等 create 前に full 検索で既存を確認する (findByKey page_size 1 依存禁止)。
  const dbIds = await findAllArchiveDbIds(ARCHIVE_SERVICE, "backup");
  const hits = dbIds.length === 0 ? [] : await queryArchiveByKeyAll(paceMs, dbIds, SNAPSHOT_KEY);
  const decision = decideSnapshotAction({
    backupHits: hits.length,
    hasMarker: receipt.snapshotIssued !== undefined,
  });
  if (decision === "stop") {
    if (hits.length >= 2) {
      throw new Error(
        `一次データ保管に snapshot が ${hits.length} 件重複しています (二重作成の疑い)。どれが正か決めず停止します ids=${hits.map((h) => h.id).join(",")}`
      );
    }
    throw new Error(
      "snapshot の create 結果不明のため停止します (marker あり・full query 0 件)。自動解除・再 create しません。後日 Notion を再読してください"
    );
  }
  if (decision === "recover") {
    const hit = hits[0];
    verifyArchivePage(hit, snapshot.sha256);
    await verifyArchiveDownload(hit.id, { names, shas: localShas });
    receipt.snapshot = {
      file: path.basename(file),
      sha256: snapshot.sha256,
      archivePageId: hit.id,
      archiveVerifiedAt: new Date().toISOString(),
      snapshotBytesSha256: localShas[names[0]],
      zipSha256: localShas[names[1]],
      htmlSha256: localShas[names[2]],
      fileNames: [...names],
    };
    saveReceipt(snapshotDir, receipt);
    return receipt;
  }
  // create: helper 呼出前に key+snapshotHash+issuedAt を atomic 保存する。
  receipt.snapshotIssued = {
    key: SNAPSHOT_KEY,
    snapshotHash: snapshot.sha256,
    issuedAt: new Date().toISOString(),
  };
  saveReceipt(snapshotDir, receipt);
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
      { bytes: snapshotBytes, filename: names[0], contentType: "application/json" },
      { bytes: zipBytes, filename: names[1], contentType: "application/zip" },
      { bytes: htmlBytes, filename: names[2], contentType: "text/html" },
    ],
  });
  if (res.fileTooLarge) {
    throw new Error("一次データ保管に上限超過ファイルあり。正直に停止します (snapshot 未確定)");
  }
  const page = await notionRequest<NotionPage>("GET", `/pages/${res.pageId}`);
  verifyArchivePage(page, snapshot.sha256);
  await verifyArchiveDownload(res.pageId, { names, shas: localShas });
  receipt.snapshot = {
    file: path.basename(file),
    sha256: snapshot.sha256,
    archivePageId: res.pageId,
    archiveVerifiedAt: new Date().toISOString(),
    snapshotBytesSha256: localShas[names[0]],
    zipSha256: localShas[names[1]],
    htmlSha256: localShas[names[2]],
    fileNames: [...names],
  };
  saveReceipt(snapshotDir, receipt);
  return receipt;
}

export function verifyArchivePage(page: NotionPage, wantSha: string): void {
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

export async function applyMigrations(
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
    const snapEntry = snapshot.incoming[op.rowPageId];
    if (!snapEntry) throw new Error(`snapshot に行がありません row=${op.rowPageId}`);
    const snapProps = snapEntry.page.properties as Record<string, unknown>;
    const recorded = receipt.migrated[op.rowPageId];
    const fresh = await getPage(paceMs, op.rowPageId);
    // 実配列で比較する (preview 25 では ⑤ の 3818 件を誤判定する)。
    const freshFull = await readRelationFull(paceMs, op.rowPageId, fresh, op.prop);
    const freshChildren = await listChildrenFirst(paceMs, op.rowPageId);
    if (freshChildren.has_more) {
      throw new Error(`子ブロックの列挙が打ち切られました row=${op.rowPageId} (has_more)`);
    }
    const freshChildDbs = freshChildren.results
      .filter((b) => b.type === "child_database")
      .map((b) => b.child_database?.title ?? "")
      .sort();
    const snapChildDbs = [...snapEntry.childDatabases].sort();
    const bodyUnchanged =
      freshChildren.results.length === snapEntry.blockCount &&
      JSON.stringify(freshChildDbs) === JSON.stringify(snapChildDbs);
    const propsUnchanged = propertiesEqualExcept(op.prop, snapProps, fresh.properties);
    const decision = decideMigrationAction({
      recorded: recorded ? { before: recorded.before, after: recorded.after } : undefined,
      opBefore: op.before,
      opAfter: op.after,
      freshFull,
      nonTargetUnchanged: propsUnchanged && bodyUnchanged,
    });
    if (decision === "skip") continue;
    if (decision === "recover") {
      // PATCH 成功→receipt 断で fresh after。PATCH 再送せず receipt 回収する。
      receipt.migrated[op.rowPageId] = {
        db: op.db,
        prop: op.prop,
        before: op.before,
        after: op.after,
        verifiedAt: new Date().toISOString(),
      };
      saveReceipt(snapshotDir, receipt);
      continue;
    }
    if (decision === "stop") {
      if (recorded) {
        throw new Error(
          `receipt 済み行が想定外の状態です (再開不能のため停止): row=${op.rowPageId}`
        );
      }
      throw new Error(`移行前に行が変化しています (同時変更の疑い): row=${op.rowPageId}`);
    }
    // patch / repatch (recorded だが before に戻っている PATCH 消失を含む)。
    await paced(paceMs, () =>
      notionRequest("PATCH", `/pages/${op.rowPageId}`, {
        properties: { [op.prop]: { relation: op.after.map((id) => ({ id })) } },
      })
    );
    const reread = await getPage(paceMs, op.rowPageId);
    const rereadFull = await readRelationFull(paceMs, op.rowPageId, reread, op.prop);
    const problem = verifyOpResult(op, rereadFull);
    if (problem) throw new Error(problem);
    if (!propertiesEqualExcept(op.prop, snapProps, reread.properties)) {
      throw new Error(`移行対象外のプロパティが変化しました row=${op.rowPageId}`);
    }
    const rereadChildren = await listChildrenFirst(paceMs, op.rowPageId);
    if (rereadChildren.has_more) {
      throw new Error(`移行後の子ブロック列挙が打ち切られました row=${op.rowPageId} (has_more)`);
    }
    const rereadChildDbs = rereadChildren.results
      .filter((b) => b.type === "child_database")
      .map((b) => b.child_database?.title ?? "")
      .sort();
    if (
      rereadChildren.results.length !== snapEntry.blockCount ||
      JSON.stringify(rereadChildDbs) !== JSON.stringify(snapChildDbs)
    ) {
      throw new Error(`移行対象外の本文が変化しました row=${op.rowPageId}`);
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
  const current = await readRelationFull(paceMs, SUPPLEMENT_7129_PAGE_ID, fresh, SUPPLEMENT_PROPS.master);
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
  const afterIds = await readRelationFull(paceMs, SUPPLEMENT_7129_PAGE_ID, reread, SUPPLEMENT_PROPS.master);
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

/**
 * 退避候補の archive 完了検証。対象 ID の一致と archived/in_trash を確認する。
 * master ページは一次データ保管のレコードではないため moveToTrash の対象外
 * (共有 helper が Service 不一致で保全停止する)。pipeline の重複収束
 * (converge_created_page) と同じく直接 archive し、内容の証拠は snapshot
 * (一次データ保管・SHA 検証済み) + receipt で保つ。ごみ DB は作らない。
 */
export function verifyArchivedPage(page: NotionPage, retireId: string): void {
  if (normalizePageId(page.id) !== normalizePageId(retireId)) {
    throw new Error(`archive 検証の対象 ID が退避元と一致しません got=${page.id} want=${retireId}`);
  }
  if (!page.archived && !page.in_trash) {
    throw new Error(`退避候補が archived になっていません page=${page.id}`);
  }
}

/**
 * 退避直前の原像突合。fresh の非 relation props + body (blockCount/子 DB) が
 * 物理 snapshot と一致しなければ同時変更として停止する。
 * 逆 relation は移行後に空になるため比較対象外 (relation 除外)。
 */
export function verifyRetirePreimage(args: {
  retireId: string;
  snapProps: Record<string, unknown>;
  snapBlockCount: number;
  snapChildDbs: string[];
  freshProps: Record<string, unknown>;
  freshBlockCount: number;
  freshChildDbs: string[];
}): void {
  if (!nonRelationPropsEqual(args.snapProps, args.freshProps)) {
    throw new Error(`退避直前に元ページが変化しています (非 relation 不一致): ${args.retireId}`);
  }
  const snapSorted = [...args.snapChildDbs].sort();
  const freshSorted = [...args.freshChildDbs].sort();
  if (
    args.freshBlockCount !== args.snapBlockCount ||
    JSON.stringify(freshSorted) !== JSON.stringify(snapSorted)
  ) {
    throw new Error(`退避直前に元ページの本文が変化しています: ${args.retireId}`);
  }
}

export async function applyRetire(
  paceMs: number,
  snapshotDir: string,
  snapshot: SnapshotDoc,
  ops: MigrationOp[],
  receipt: DedupReceipt
): Promise<DedupReceipt> {
  for (const t of TARGETS) {
    const recorded = receipt.retired[t.retireId];
    if (recorded) {
      // 旧形式 (moveToTrash 方式の trashPageId) の receipt は系統が違うため
      // 引き継がず停止する (当該方式で完了した実行は存在しないはず)。
      if (typeof recorded.archivedAt !== "string") {
        throw new Error(`旧形式の退避記録のため停止します (手動確認が必要): ${t.retireId}`);
      }
      const origin = await getPage(paceMs, t.retireId);
      verifyArchivedPage(origin, t.retireId);
      continue;
    }
    // 順序の強制: snapshot 確定・移行・補足・lifecycle・D1 が全て完了後のみ退避する。
    if (!receipt.snapshot?.archiveVerifiedAt) {
      throw new Error("snapshot なしで退避しません (archive 前に一次データ保管が必須)");
    }
    if (!allMigrated(ops, receipt) || !receipt.lifecycle3681 || !receipt.supplement7129 || !receipt.d1) {
      throw new Error("移行・補足・lifecycle・D1 の完了前に退避しません");
    }
    const snapMasters = snapshot.masters[t.retireId];
    if (!snapMasters) throw new Error(`snapshot に退避元がありません: ${t.retireId}`);
    const origin = await getPage(paceMs, t.retireId);
    const originChildren = await listChildrenFirst(paceMs, t.retireId);
    if (originChildren.has_more) {
      throw new Error(`子ブロックの列挙が打ち切られました page=${t.retireId} (has_more)`);
    }
    // 退避直前の原像突合 (非 relation + body)。変化があれば同時変更として停止。
    verifyRetirePreimage({
      retireId: t.retireId,
      snapProps: snapMasters.page.properties as Record<string, unknown>,
      snapBlockCount: snapMasters.children.results.length,
      snapChildDbs: snapMasters.children.results
        .filter((b) => b.type === "child_database")
        .map((b) => b.child_database?.title ?? ""),
      freshProps: origin.properties as Record<string, unknown>,
      freshBlockCount: originChildren.results.length,
      freshChildDbs: originChildren.results
        .filter((b) => b.type === "child_database")
        .map((b) => b.child_database?.title ?? ""),
    });
    const decision = decideRetireAction({
      originArchived: origin.archived === true || origin.in_trash === true,
      hasMarker: receipt.retireIssued?.[t.retireId] !== undefined,
    });
    if (decision === "stop") {
      throw new Error(
        `退避候補が外部で archived になっています (marker なし)。系統不明のため停止します: ${t.retireId}。人手で確認してください`
      );
    }
    if (decision === "recover") {
      // marker あり・archived 済み: 終状態は検証済み (原像突合 + archived)。
      // 再読して記録を回収する。
      const reread = await getPage(paceMs, t.retireId);
      verifyArchivedPage(reread, t.retireId);
      receipt.retired[t.retireId] = {
        archivedAt: reread.last_edited_time,
        verifiedAt: new Date().toISOString(),
      };
      saveReceipt(snapshotDir, receipt);
      continue;
    }
    // create/repatch: PATCH 呼出前に key+origin+snapshotHash+issuedAt を atomic 保存する。
    // archive PATCH は冪等 (複製物を作らない) のため、repatch の再送は安全。
    if (decision === "create") {
      receipt.retireIssued = {
        ...(receipt.retireIssued ?? {}),
        [t.retireId]: {
          key: t.retireId,
          origin: t.retireId,
          snapshotHash: snapshot.sha256,
          issuedAt: new Date().toISOString(),
        },
      };
      saveReceipt(snapshotDir, receipt);
    }
    await paced(paceMs, () =>
      notionRequest("PATCH", `/pages/${t.retireId}`, { archived: true })
    );
    const reread = await getPage(paceMs, t.retireId);
    verifyArchivedPage(reread, t.retireId);
    receipt.retired[t.retireId] = {
      archivedAt: reread.last_edited_time,
      verifiedAt: new Date().toISOString(),
    };
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
    const all = await queryDbAll(
      paceMs,
      masterDb,
      { property: "銘柄コード", rich_text: { equals: t.code } }
    );
    const activeIds = all.map((r) => r.id);
    if (activeIds.length !== 1 || normalizePageId(activeIds[0]) !== normalizePageId(t.keepId)) {
      problems.push(`${t.code}: 有効行が保持先のみ 1 件になりません got=${activeIds.join(",")}`);
    }
    const retire = await getPage(paceMs, t.retireId);
    if (!retire.archived && !retire.in_trash) {
      problems.push(`${t.code}: 退避候補が archived になっていません`);
    }
    const keepFresh = await getPage(paceMs, t.keepId);
    const keepChildren = await listChildrenFirst(paceMs, t.keepId);
    if (keepChildren.has_more) {
      problems.push(`${t.code}: 保持先の子ブロック列挙が打ち切られました (has_more)`);
      continue;
    }
    const snapKeep = snapshot.masters[t.keepId];
    const snapRetire = snapshot.masters[t.retireId];
    const beforeView = (m: SnapshotDoc["masters"][string]): MasterPageView =>
      toMasterView(m.page, m.children);
    // 最終 reread も実配列 (全 pagination) で検証する。preview 25 では欠落を見逃す。
    for (const prop of [REVERSE_PROP_DISCLOSURES, REVERSE_PROP_FINANCIALS]) {
      let keepAfterFull: string[];
      try {
        keepAfterFull = await readRelationFull(paceMs, t.keepId, keepFresh, prop);
      } catch (e) {
        problems.push(`${t.code}/${prop}: 最終 reread に失敗: ${(e as Error).message}`);
        continue;
      }
      const p = verifyReverseUnion({
        label: `${t.code}/${prop}`,
        keepBefore: beforeView(snapKeep).relations[prop]?.ids ?? [],
        retireBefore: beforeView(snapRetire).relations[prop]?.ids ?? [],
        keepAfter: keepAfterFull,
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
  let masterIds: string[];
  try {
    masterIds = await readRelationFull(paceMs, SUPPLEMENT_7129_PAGE_ID, supp, SUPPLEMENT_PROPS.master);
  } catch (e) {
    problems.push(`7129: 補足の最終 reread に失敗: ${(e as Error).message}`);
    masterIds = [];
  }
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
  return loadSnapshotFile(file);
}

function loadSnapshotFile(file: string): { snapshot: SnapshotDoc; file: string } {
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8")) as SnapshotDoc;
  const rehash = sha256HexUtf8(stableStringify(snapshotWithoutHash(snapshot)));
  if (rehash !== snapshot.sha256) throw new Error(`snapshot の hash が一致しません: ${file}`);
  if (snapshot.version !== 1) throw new Error(`snapshot の version が不正です: ${file}`);
  if (!snapshot.incomingSchema || !Array.isArray(snapshot.incomingSchema.hits)) {
    throw new Error(`旧 snapshot のため再開できません (incomingSchema なし・手動確認が必要): ${file}`);
  }
  for (const [rowId, v] of Object.entries(snapshot.incoming ?? {})) {
    if (typeof (v as { blockCount?: unknown }).blockCount !== "number") {
      throw new Error(`旧 snapshot のため再開できません (incoming body なし row=${rowId}): ${file}`);
    }
  }
  return { snapshot, file };
}

/**
 * 再開用の snapshot 固定。receipt の確定 hash (snapshot/marker) に対応する
 * 既存 local snapshot を再利用し、新規作成で hash がずれて回収停止するのを防ぐ。
 * snapshotIssued-only (POST 結果不明) の再開では marker hash のファイルを探す。
 */
export function loadSnapshotForResume(
  snapshotDir: string,
  receipt: DedupReceipt
): { snapshot: SnapshotDoc; file: string } {
  const want =
    receipt.snapshot?.sha256 ??
    receipt.snapshotIssued?.snapshotHash ??
    Object.values(receipt.retireIssued ?? {})[0]?.snapshotHash;
  if (!want) {
    throw new Error("再開に必要な snapshot hash が receipt にありません (手動確認が必要)");
  }
  // 全 marker の hash が一致すること (混在は手動確認)。
  const hashes = new Set<string>();
  if (receipt.snapshot) hashes.add(receipt.snapshot.sha256);
  if (receipt.snapshotIssued) hashes.add(receipt.snapshotIssued.snapshotHash);
  for (const m of Object.values(receipt.retireIssued ?? {})) hashes.add(m.snapshotHash);
  if (hashes.size > 1) {
    throw new Error("receipt 内の snapshot hash が混在しています (手動確認が必要)");
  }
  const files = fs
    .readdirSync(snapshotDir)
    .filter((f) => f.startsWith("snapshot-") && f.endsWith(".json"))
    .sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const file = path.join(snapshotDir, files[i]);
    try {
      const loaded = loadSnapshotFile(file);
      if (loaded.snapshot.sha256 === want) return loaded;
    } catch {
      continue;
    }
  }
  throw new Error(`marker 対応の snapshot ファイルがありません want=${want.slice(0, 12)}… (手動確認が必要)`);
}

async function runApply(opts: CliOptions): Promise<number> {
  let receipt = loadReceipt(opts.snapshotDir);
  if (receipt.completedAt) {
    console.log("receipt は完了済みです。再検証のみ行います (書込なし)。");
  }
  const state = await readFreshState(opts.paceMs);
  if (isAlreadyAppliedViews(state.views)) {
    // 適用済み状態では master/補足の事前ガードは走らず、problems は D1・証拠・schema のみ。
    const { problems } = guardFreshState(state);
    if (problems.length > 0) {
      console.log(JSON.stringify({ alreadyApplied: true, problems }, null, 2));
      return 2;
    }
    try {
      // 保存 snapshot/receipt で物理 archive の実 DL+SHA 再検証を D1 修正前に通す
      // (再開でも元原本再読を必須とする。bypass しない)。
      const loaded = hasSnapshotProgress(receipt)
        ? loadSnapshotForResume(opts.snapshotDir, receipt)
        : loadLatestSnapshot(opts.snapshotDir);
      receipt = await archiveSnapshot(opts.paceMs, opts.snapshotDir, loaded.file, loaded.snapshot, receipt);
      // D1 の遅れ (退避候補指し) だけは直してから再検証する (apply 許可域の書込)。
      receipt = await applyD1Check(opts.snapshotDir, receipt);
      const verifyProblems = await finalVerify(opts.paceMs, loaded.snapshot, receipt);
      if (verifyProblems.length > 0) {
        console.log(JSON.stringify({ alreadyApplied: true, verifyProblems }, null, 2));
        return 2;
      }
    } catch (e) {
      // 最終検証の失敗・省略は完了済み receipt があってもサイレント成功にしない
      // (ルール2: 検証なしの 0 終了は禁止)。必ず非 0 で止め、運用者が再読する。
      console.log(
        JSON.stringify({ alreadyApplied: true, note: `最終検証を省略: ${(e as Error).message}` }, null, 2)
      );
      return 2;
    }
    if (!receipt.completedAt) {
      receipt.completedAt = new Date().toISOString();
      saveReceipt(opts.snapshotDir, receipt);
    }
    console.log("すでに適用済み・再検証合格のため書込 0 で終了します。");
    return 0;
  }
  // snapshot 取得 (再開時は receipt+snapshot に基づく中間ガード、初回は初期ガード)。
  let snapshot: SnapshotDoc;
  let snapshotFile: string;
  if (hasSnapshotProgress(receipt)) {
    // marker hash 対応の既存 local snapshot を再利用して固定する (新規作成で
    // hash がずれると 1hit 回収が停止するため)。既存原本 3 ファイルも保持する。
    const loaded = loadSnapshotForResume(opts.snapshotDir, receipt);
    snapshot = loaded.snapshot;
    snapshotFile = loaded.file;
    const opsForGuard = buildMigrationOps(snapshot);
    const inter = guardIntermediateState({ state, snapshot, receipt, ops: opsForGuard });
    if (inter.problems.length > 0) {
      console.log(JSON.stringify({ resume: true, problems: inter.problems }, null, 2));
      console.log("中間状態ガード不一致のため書込せず停止します。");
      return 2;
    }
  } else {
    const { problems } = guardFreshState(state);
    if (problems.length > 0) {
      console.log(JSON.stringify({ problems }, null, 2));
      console.log("ガード不一致のため書込せず停止します。");
      return 2;
    }
    // 初回のみ fresh 証拠を snapshotDir へ保存する (再開時は既存原本を保持)。
    saveFreshEvidence(opts.snapshotDir, state.evidenceBytes);
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
  receipt = await archiveSnapshot(opts.paceMs, opts.snapshotDir, snapshotFile, snapshot, receipt);
  receipt = await applyLifecycle3681(opts.paceMs, opts.snapshotDir, snapshot, receipt);
  receipt = await applyMigrations(opts.paceMs, opts.snapshotDir, snapshot, ops, receipt);
  receipt = await applySupplement7129(opts.paceMs, opts.snapshotDir, snapshot, receipt);
  receipt = await applyD1Check(opts.snapshotDir, receipt);
  receipt = await applyRetire(opts.paceMs, opts.snapshotDir, snapshot, ops, receipt);
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

// CLI として直接実行された場合のみ main() を走らせる (import だけでは走らない —
// 実 flow 回帰テストがこのモジュールを安全に import できるようにするためのガード)。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`FAILED: ${(e as Error).message}`);
    process.exit(1);
  });
}


