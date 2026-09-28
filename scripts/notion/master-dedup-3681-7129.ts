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
import { joinRichText } from "../../src/shared/notion-archive/rich-text.js";
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
  SNAPSHOT_KEY_V2,
  SUPPLEMENT_7129_PAGE_ID,
  TARGETS,
  allMigrated,
  decideMigrationAction,
  decideRetireAction,
  decideSnapshotAction,
  emptyReceipt,
  guardIncomingSchema,
  guardKeeperIncomingIds,
  guardMasterView,
  guardSupplement,
  hasSnapshotProgress,
  incomingRelationProblems,
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
  type IncomingOrigin,
  type IncomingSchemaEvidence,
  type IncomingSchemaHit,
  type KeeperIncomingBaseline,
  type KeeperRowProof,
  type MasterTarget,
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
    if (!res.has_more) break;
    if (!res.next_cursor) {
      throw new Error(`relation 列挙が欠落のため停止します page=${pageId} (has_more なのに next_cursor なし)`);
    }
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
    if (!res.has_more) break;
    if (!res.next_cursor) {
      throw new Error(`DB query 列挙が欠落のため停止します db=${dbId} (has_more なのに next_cursor なし)`);
    }
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

// ---------------------------------------------------------------------------
// 本文・添付の完全 capture (v2 snapshot の proof。本文の打切り・添付の欠落禁止)
// ---------------------------------------------------------------------------

/** block children の生要素 (text/file 抽出に要る最小限以外は opaque)。 */
export interface RawBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [k: string]: unknown;
}

interface ChildrenListResponse {
  results: RawBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

/** file/image 系の 1 添付の inventory (安定 origin + 名前 + 実バイト列 SHA)。 */
export interface CapturedFileRef {
  /** files プロパティ名 (本文ブロックの添付は CapturedBlock.file 側に保持)。 */
  where: string;
  name: string;
  /** 安定 origin。Notion ホストは "hosted"、外部は外部 URL そのもの (署名 URL は揮発のため保持しない)。 */
  origin: string;
  bytesSha256: string;
}

/** 1 ブロックの capture (原構造 + 全文 + 添付 + 同 raw digest)。 */
export interface CapturedBlock {
  id: string;
  type: string;
  hasChildren: boolean;
  /** rich_text/caption/title の結合平文 (構造ブロックは "")。 */
  text: string;
  /** 原 block 構造 (annotations/link/checked 等を保持。揮発 URL のみ除去)。 */
  raw: unknown;
  file?: { name: string; origin: string; bytesSha256: string };
  /** child_page/child_database の安定参照 (中身には踏み込まない)。 */
  refTitle?: string;
  children?: CapturedBlock[];
  /** raw と同一正規化の digest (構造変化の検出用)。 */
  digest: string;
}

export interface BodyCapture {
  fullCapture: true;
  blocks: CapturedBlock[];
  sha256: string;
}

export interface FilesCapture {
  complete: true;
  files: CapturedFileRef[];
  sha256: string;
}

/**
 * 子ブロックの全ページ送り (100 件超も欠落させない)。
 * has_more なのに next_cursor が無ければ STOP (欠落を full と誤称しない)。
 */
export async function listAllBlocks(paceMs: number, blockId: string): Promise<RawBlock[]> {
  const out: RawBlock[] = [];
  let cursor: string | undefined;
  for (;;) {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const res = await paced(paceMs, () =>
      notionRequest<ChildrenListResponse>("GET", `/blocks/${blockId}/children${qs}`)
    );
    out.push(...res.results);
    if (!res.has_more) break;
    if (!res.next_cursor) {
      throw new Error(`子ブロック列挙が欠落のため停止します block=${blockId} (has_more なのに next_cursor なし)`);
    }
    cursor = res.next_cursor;
  }
  return out;
}

/** rich_text/caption 様の配列を平文へ (形が違えば ""。digest が raw を pin するため text は補助)。 */
function richArrayText(v: unknown): string {
  if (!Array.isArray(v)) return "";
  return joinRichText(v as Array<{ plain_text?: string; text?: { content: string } }>);
}

/** ブロックの平文 (既知の rich_text/caption/title 位置のみ。未知形状は digest が pin)。 */
export function blockTextOf(block: RawBlock): string {
  const payload = block[block.type] as Record<string, unknown> | undefined;
  if (block.type === "child_page" || block.type === "child_database") {
    const title = payload?.["title"];
    return typeof title === "string" ? title : "";
  }
  if (!payload || typeof payload !== "object") return "";
  return richArrayText(payload["rich_text"]) + richArrayText(payload["caption"]);
}

/**
 * digest 用の正規化 raw。揮発する署名 URL/expiry だけを除き、他は全文 pin する
 * (注釈・checked・言語・時刻・ユーザ等の構造変化も検出できる)。
 * 外部 URL は利用者指定の安定値のため残す。
 */
export function normalizedBlockForDigest(block: RawBlock): unknown {
  const clone = JSON.parse(JSON.stringify(block)) as Record<string, unknown>;
  const payload = clone[clone["type"] as string];
  if (payload && typeof payload === "object") {
    const file = (payload as Record<string, unknown>)["file"];
    if (file && typeof file === "object") {
      delete (file as Record<string, unknown>)["url"];
      delete (file as Record<string, unknown>)["expiry_time"];
    }
  }
  return clone;
}

/** file/image 系ブロックの添付参照 (URL なしは STOP。欠落を黙って飛ばさない)。 */
export function blockFileRefOf(block: RawBlock): { name: string; origin: string; url: string } | null {
  switch (block.type) {
    case "image":
    case "file":
    case "video":
    case "pdf":
    case "audio":
      break;
    default:
      return null;
  }
  const payload = block[block.type] as Record<string, unknown> | undefined;
  const kind = payload?.["type"];
  const nameRaw = payload?.["name"];
  const name = typeof nameRaw === "string" && nameRaw !== "" ? nameRaw : block.id;
  if (kind === "external") {
    const url = (payload?.["external"] as { url?: unknown } | undefined)?.url;
    if (typeof url !== "string" || url === "") {
      throw new Error(`添付の外部 URL が無いため停止します block=${block.id}`);
    }
    return { name, origin: url, url };
  }
  const url = (payload?.["file"] as { url?: unknown } | undefined)?.url;
  if (typeof url !== "string" || url === "") {
    throw new Error(`添付の実体 URL が無いため停止します block=${block.id}`);
  }
  return { name, origin: "hosted", url };
}

/** files プロパティの全エントリの添付参照 (URL なしは STOP)。 */
export function pageFilesRefsOf(page: NotionPage): Array<{ prop: string; name: string; origin: string; url: string }> {
  const out: Array<{ prop: string; name: string; origin: string; url: string }> = [];
  for (const [prop, pv] of Object.entries(page.properties)) {
    if (pv["type"] !== "files") continue;
    const files = pv["files"];
    if (!Array.isArray(files)) {
      throw new Error(`files プロパティの形が不正のため停止します page=${page.id} prop=${prop}`);
    }
    for (const f of files) {
      const e = f as { name?: unknown; type?: unknown; file?: { url?: unknown }; external?: { url?: unknown } };
      const name = typeof e.name === "string" && e.name !== "" ? e.name : `${prop}/${out.length}`;
      if (e.type === "external") {
        if (typeof e.external?.url !== "string" || e.external.url === "") {
          throw new Error(`添付の外部 URL が無いため停止します page=${page.id} prop=${prop} name=${name}`);
        }
        out.push({ prop, name, origin: e.external.url, url: e.external.url });
      } else {
        if (typeof e.file?.url !== "string" || e.file.url === "") {
          throw new Error(`添付の実体 URL が無いため停止します page=${page.id} prop=${prop} name=${name}`);
        }
        out.push({ prop, name, origin: "hosted", url: e.file.url });
      }
    }
  }
  return out;
}

/** 添付バイト列の snapshotDir 上の固定パス (SHA 決定論的・同 bytes は重複保存しない)。 */
export function attachmentDiskName(sha256: string): string {
  return `attachment-${sha256}.bin`;
}

/**
 * 添付 1 件の実ダウンロード + SHA + snapshotDir へ pin 留め。
 * 既存同名ファイルは SHA 再検証して再利用 (不一致はすり替えとして STOP)。
 */
async function pinAttachmentBytes(
  paceMs: number,
  snapshotDir: string,
  url: string,
  label: string
): Promise<{ bytes: Uint8Array; sha256: string }> {
  const bytes = await paced(paceMs, () => downloadNotionFileBytes(url, label));
  const sha256 = sha256HexBytes(bytes);
  const diskPath = path.join(snapshotDir, attachmentDiskName(sha256));
  if (fs.existsSync(diskPath)) {
    const existing = new Uint8Array(fs.readFileSync(diskPath));
    if (sha256HexBytes(existing) !== sha256) {
      throw new Error(`添付の既存 pin が SHA 不一致のため停止します (すり替えの疑い): ${label}`);
    }
    return { bytes: existing, sha256 };
  }
  fs.writeFileSync(diskPath, bytes);
  return { bytes, sha256 };
}

/** 1 ブロックの capture (has_children は再帰。child_page/child_database は安定参照のみ)。 */
async function captureBlock(
  paceMs: number,
  snapshotDir: string,
  block: RawBlock
): Promise<CapturedBlock> {
  if (block.type === "unsupported") {
    throw new Error(`未対応ブロックがあるため full capture できません block=${block.id} (STOP)`);
  }
  const hasChildren = block.has_children === true;
  const raw = normalizedBlockForDigest(block);
  const out: CapturedBlock = {
    id: block.id,
    type: block.type,
    hasChildren,
    text: blockTextOf(block),
    raw,
    digest: sha256HexUtf8(stableStringify(raw)),
  };
  if (block.type === "child_page" || block.type === "child_database") {
    // 子 DB/子ページの中身 (業務行) には踏み込まない。全 walk は不要。
    // ID + type + title の安定参照だけ保持する (7129 技術履歴の ID/ref 維持)。
    out.refTitle = blockTextOf(block);
    return out;
  }
  const fileRef = blockFileRefOf(block);
  if (fileRef) {
    const pinned = await pinAttachmentBytes(paceMs, snapshotDir, fileRef.url, `block ${block.id} (${fileRef.name})`);
    out.file = { name: fileRef.name, origin: fileRef.origin, bytesSha256: pinned.sha256 };
  }
  if (hasChildren) {
    // 子 body が取得できなければ例外が飛び STOP する (full と誤称しない)。
    const kids = await listAllBlocks(paceMs, block.id);
    out.children = [];
    for (const k of kids) out.children.push(await captureBlock(paceMs, snapshotDir, k));
  }
  return out;
}

/**
 * incoming 候補の membership 判定 (純粋関数)。
 * 対応 retire への完全 membership で判定する。FWD-only 由来の absence
 * (full 配列で証明済み) は no-op evidence として snapshot に保持する
 * (ops 除外は retire 絞りで成立)。reverse 由来の absence は DB 種別に
 * かかわらず同時変更として STOP (kind raw というだけの許容はしない)。
 * membership 未取得・不完全 cursor は到達前に readRelationFull が STOP する。
 */
export function classifyIncomingMembership(
  origin: IncomingOrigin,
  hasCorrespondingRetire: boolean,
  rowPageId: string
): "linked" | "detached-fwd-evidence" {
  if (hasCorrespondingRetire) return "linked";
  if (origin === "fwd") return "detached-fwd-evidence";
  throw new Error(`incoming 行に対応退避 ID がありません (同時変更の疑い): ${rowPageId}`);
}

/**
 * 1 ページの完全 proof (本文全 capture + files 添付 inventory)。
 * 全ページ送り・再帰・実ダウンロードを通し、欠落があれば STOP する。
 */
export async function capturePageProof(
  paceMs: number,
  snapshotDir: string,
  pageId: string,
  page: NotionPage
): Promise<{ body: BodyCapture; files: FilesCapture }> {
  const blocks = await listAllBlocks(paceMs, pageId);
  const captured: CapturedBlock[] = [];
  for (const b of blocks) captured.push(await captureBlock(paceMs, snapshotDir, b));
  const body: BodyCapture = {
    fullCapture: true,
    blocks: captured,
    sha256: sha256HexUtf8(stableStringify(captured)),
  };
  const refs = pageFilesRefsOf(page);
  const files: CapturedFileRef[] = [];
  for (const r of refs) {
    const pinned = await pinAttachmentBytes(paceMs, snapshotDir, r.url, `page ${pageId} prop ${r.prop} (${r.name})`);
    files.push({ where: r.prop, name: r.name, origin: r.origin, bytesSha256: pinned.sha256 });
  }
  files.sort((a, b) => (a.where < b.where ? -1 : a.where > b.where ? 1 : a.name < b.name ? -1 : 1));
  return { body, files: { complete: true, files, sha256: sha256HexUtf8(stableStringify(files)) } };
}

/**
 * snapshot proof と fresh proof の内容一致 (純粋比較)。
 * 本文は原構造込み SHA、添付は inventory SHA で比べ、同数の内容変更も検出する。
 */
export function pageProofsEqual(
  snap: { body?: BodyCapture | undefined; files?: FilesCapture | undefined },
  fresh: { body: BodyCapture; files: FilesCapture }
): boolean {
  if (!snap.body || !snap.files) return false;
  return snap.body.sha256 === fresh.body.sha256 && snap.files.sha256 === fresh.files.sha256;
}

/**
 * 更新直前の fresh proof 照合。fresh を取り直して snapshot proof と比べ、
 * 不一致なら同時変更として STOP する (全 mutation/recovery の直前・直後に接続)。
 */
export async function verifyFreshPageProof(
  paceMs: number,
  snapshotDir: string,
  pageId: string,
  page: NotionPage,
  label: string,
  snapBody: BodyCapture | undefined,
  snapFiles: FilesCapture | undefined
): Promise<void> {
  const fresh = await capturePageProof(paceMs, snapshotDir, pageId, page);
  if (!pageProofsEqual({ body: snapBody, files: snapFiles }, fresh)) {
    throw new Error(`${label}が snapshot と不一致です (同時変更の疑い): ${pageId}`);
  }
}

/**
 * entry 共通の fresh proof 再検証 (resume/already-applied の D1 前に接続)。
 * master 全ページ + 補足全ページ + incoming 全件の fresh を取り直し、
 * snapshot proof と照合する。relation の増減は proof 対象外 (本文・添付のみ)
 * のため、移行中間状態でも比較できる。
 */
async function verifyEntryFreshProofs(
  paceMs: number,
  snapshotDir: string,
  snapshot: SnapshotDoc,
  state: FreshState,
  receipt: DedupReceipt
): Promise<void> {
  for (const id of Object.keys(snapshot.masters)) {
    const freshPage = state.pages[id];
    if (!freshPage) {
      throw new Error(`fresh master が無いため照合できません (STOP): ${id}`);
    }
    const m = snapshot.masters[id];
    await verifyFreshPageProof(paceMs, snapshotDir, id, freshPage, "master の本文・添付", m.body, m.files);
  }
  for (const id of Object.keys(snapshot.supplement)) {
    const freshPage = state.supplementPages[id];
    if (!freshPage) {
      throw new Error(`fresh 補足行が無いため照合できません (STOP): ${id}`);
    }
    const p = snapshot.supplementProof?.[id];
    await verifyFreshPageProof(paceMs, snapshotDir, id, freshPage, "補足の本文・添付", p?.body, p?.files);
  }
  // incoming 全件の fresh proof + relation/properties CAS 照合。
  // relation は移行で変わるが、意図済みの before/after 差だけ許容する。
  const ops = buildMigrationOps(snapshot);
  const opByRow = new Map(ops.map((o) => [o.rowPageId, o]));
  for (const rowId of Object.keys(snapshot.incoming)) {
    const freshPage = await getPage(paceMs, rowId);
    const e = snapshot.incoming[rowId];
    await verifyFreshPageProof(paceMs, snapshotDir, rowId, freshPage, "incoming の本文・添付", e.body, e.files);
    // 非対象 properties 不変 (既存 helper)。
    if (!propertiesEqualExcept(e.prop, e.page.properties, freshPage.properties)) {
      throw new Error(`incoming の移行対象外プロパティが snapshot と不一致です: ${rowId}`);
    }
    // target relation 完全配列の照合 (full pagination。不完全は STOP)。
    const freshFull = await readRelationFull(paceMs, rowId, freshPage, e.prop);
    const problems = incomingRelationProblems({
      rowPageId: rowId,
      snapRelationFull: e.relationFull,
      freshFull,
      op: opByRow.get(rowId),
      recorded: receipt.migrated[rowId],
    });
    if (problems.length > 0) throw new Error(problems.join(" / "));
  }
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

interface DbPropDef {
  id: string;
  type: string;
  relation?: { database_id?: string; type?: string };
}

interface SearchDbResponse {
  results: Array<{
    id: string;
    archived?: boolean;
    in_trash?: boolean;
    title?: string | Array<{ plain_text?: string }>;
    /** /search が database の schema を返す場合に保持する (返さない場合もある)。 */
    properties?: Record<string, DbPropDef>;
  }>;
  has_more: boolean;
  next_cursor: string | null;
}

interface DbSchemaResponse {
  id: string;
  title?: Array<{ plain_text?: string }>;
  properties: Record<string, DbPropDef>;
}

function dbTitleOf(
  title: string | Array<{ plain_text?: string }> | undefined
): string {
  if (typeof title === "string") return title;
  if (!Array.isArray(title)) return "";
  return title.map((t) => t.plain_text ?? "").join("");
}

/**
 * schema が incoming 判定に使える完全形か (純粋判定)。
 * 全 def が id+type を持ち、全 relation def が target database_id を持つこと。
 * /search 応答の schema がこの形なら GET を省略し、欠ければ GET する。
 */
export function isSearchSchemaUsable(properties: unknown): properties is Record<string, DbPropDef> {
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return false;
  const entries = Object.entries(properties as Record<string, unknown>);
  if (entries.length === 0) return false;
  for (const [, def] of entries) {
    if (!def || typeof def !== "object") return false;
    const d = def as { id?: unknown; type?: unknown; relation?: { database_id?: unknown } };
    if (typeof d.id !== "string" || d.id === "" || typeof d.type !== "string" || d.type === "") {
      return false;
    }
    if (d.type === "relation") {
      if (typeof d.relation?.database_id !== "string" || d.relation.database_id === "") return false;
    }
  }
  return true;
}

/**
 * 1 DB の schema から master 向け relation を抽出する (純粋関数)。
 * target の無い relation 定義は黙って飛ばさず STOP する (master 向けか
 * 判定不能なまま進む schema 省略を禁止。fail closed)。
 */
export function extractMasterHits(
  dbId: string,
  dbTitle: string,
  properties: Record<string, DbPropDef>,
  masterDb: string
): IncomingSchemaHit[] {
  const hits: IncomingSchemaHit[] = [];
  for (const [propName, def] of Object.entries(properties)) {
    if (def.type !== "relation") continue;
    const target = def.relation?.database_id;
    if (!target) {
      throw new Error(
        `incoming 判定不能のため停止します: db=${dbTitle} (${dbId}) prop=${propName} の relation target が不明です (schema 省略禁止)`
      );
    }
    if (normalizePageId(target) !== normalizePageId(masterDb)) continue;
    const relType =
      def.relation?.type === "single_property"
        ? "single_property"
        : def.relation?.type === "dual_property"
          ? "dual_property"
          : "unknown";
    hits.push({ dbId, dbTitle, propName, relType });
  }
  return hits;
}

/**
 * integration が見える全 DB の schema を列挙し、master 向け relation を検出する。
 * single_property (逆向きに現れない片方向) の未知 incoming を止めるための
 * 一度だけの列挙。全 DB 全行 scan は不要 (schema のみ)。
 * /search 応答が完全 schema を含む DB はそのまま使い、含まない・不完全な DB
 * だけ GET する (旧 id/title のみ保持 + 全 DB GET の繰返しをやめる)。
 * 呼び出し側は `guardIncomingSchema` で未知を STOP し、証拠を snapshot に残す。
 */
export async function enumerateMasterIncoming(
  paceMs: number
): Promise<IncomingSchemaEvidence> {
  const masterDb = normalizePageId(notionEnv.NOTION_DB_STOCK_MASTER());
  const dbIds: Array<{ id: string; title: string; properties: unknown }> = [];
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
      dbIds.push({ id: r.id, title: dbTitleOf(r.title), properties: r.properties });
    }
    if (!res.has_more) break;
    if (!res.next_cursor) {
      throw new Error("DB schema 列挙が欠落のため停止します (search の has_more なのに next_cursor なし)");
    }
    cursor = res.next_cursor;
  }
  const hits: IncomingSchemaHit[] = [];
  let searchSchemaUsed = 0;
  let getSchemaUsed = 0;
  for (const db of dbIds) {
    if (isSearchSchemaUsable(db.properties)) {
      hits.push(...extractMasterHits(db.id, db.title, db.properties, masterDb));
      searchSchemaUsed++;
      continue;
    }
    // search が schema を返さない・不完全な DB だけ GET する (必要 GET)。
    const schema = await paced(paceMs, () =>
      notionRequest<DbSchemaResponse>("GET", `/databases/${db.id}`)
    );
    if (!isSearchSchemaUsable(schema.properties)) {
      throw new Error(
        `incoming 判定不能のため停止します: db=${db.id} の schema が GET でも不完全です (schema 省略禁止)`
      );
    }
    const title = dbTitleOf(schema.title) || db.title;
    hits.push(...extractMasterHits(db.id, title, schema.properties, masterDb));
    getSchemaUsed++;
  }
  hits.sort((a, b) =>
    a.dbTitle < b.dbTitle ? -1 : a.dbTitle > b.dbTitle ? 1 : a.propName < b.propName ? -1 : 1
  );
  return {
    enumeratedAt: new Date().toISOString(),
    dbCount: dbIds.length,
    hits,
    schemaProvenance: { searchSchemaUsed, getSchemaUsed },
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
  let keeperBaseline: Record<string, KeeperIncomingBaseline> | null = null;
  if (!alreadyApplied) {
    // 保持先 ④③ は集合ガード (readonly。baseline は実 receipt+v1 から実行時読取)。
    // 読取失敗も throw せず problems に載せる (plan は報告が仕事)。
    try {
      keeperBaseline = await loadKeeperBaseline(opts.paceMs, opts.snapshotDir);
    } catch (e) {
      problems.push(`保持先 baseline の読取に失敗: ${(e as Error).message}`);
    }
  }
  if (keeperBaseline) {
    for (const t of TARGETS) {
      const b = keeperBaseline[t.code];
      const keepPage = state.pages[t.keepId];
      if (!b) {
        problems.push(`${t.code}: 保持先 baseline がありません`);
        continue;
      }
      if (!keepPage) {
        problems.push(`${t.code}: 保持先ページの fresh 読取がありません`);
        continue;
      }
      problems.push(...(await guardKeeperIncomingLive(opts.paceMs, t, keepPage, b)));
    }
  }
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
    keeperBaseline: keeperBaseline
      ? Object.fromEntries(
          Object.entries(keeperBaseline).map(([code, b]) => [
            code,
            { disclosures: b.disclosures.length, financials: b.financials.length },
          ])
        )
      : null,
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
  /** 1=旧 (props+子 first/count/name のみ) / 2=完全 proof (本文全 capture+添付 inventory)。v1 ファイルは不変のまま読めるが apply 駆動は v2 のみ。 */
  version: 1 | 2;
  takenAt: string;
  masters: Record<
    string,
    {
      code: string;
      role: "keep" | "retire";
      page: NotionPage;
      children: ChildrenResponse;
      body?: BodyCapture;
      files?: FilesCapture;
    }
  >;
  incoming: Record<
    string,
    {
      db: IncomingDb;
      prop: string;
      page: NotionPage;
      relationFull: string[];
      blockCount: number;
      childDatabases: string[];
      body?: BodyCapture;
      files?: FilesCapture;
    }
  >;
  supplement: Record<string, NotionPage>;
  /** v2 の補足 proof (v1 ファイルには無い。page 自体は supplement 側)。 */
  supplementProof?: Record<string, { body: BodyCapture; files: FilesCapture }>;
  /**
   * v2 の保持先 incoming 固定集合 (take 時の全 ID + 直後再読一致。v1 には無い)。
   * key は銘柄コード。件数ではなく ID 集合そのものを固定する。
   */
  keeperIncoming?: Record<string, { disclosures: string[]; financials: string[] }>;
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

// ---------------------------------------------------------------------------
// 保持先 baseline (v1 snapshot + keep11 実 receipt。件数固定の置換)
// ---------------------------------------------------------------------------

/** snapshotDir 直下の keep11 実 receipt (private 0600・git 除外)。 */
const KEEP11_BASELINE_FILE = "keep11-baseline-20260928.json";

/** keep11 実 receipt の検証済み内容 (7129 keep 開示の証明済み集合)。 */
export interface Keep11ReceiptEvidence {
  code: string;
  rowIds: string[];
  v1sha256: string;
}

/**
 * keep11 実 receipt の検証と抽出 (純粋)。
 * verdict・全行の keep-only membership・issuer・原本を熟読し、1 件でも
 * 欠ければ throw する (未検証の baseline を使わない。件数は問わない)。
 */
export function parseKeep11Receipt(json: unknown): Keep11ReceiptEvidence {
  const r = json as Record<string, unknown>;
  if (!r || typeof r !== "object") throw new Error("keep11 receipt の形が不正です (object でない)");
  if (r["kind"] !== "keep11-investigation") {
    throw new Error(`keep11 receipt の kind が不正です got=${String(r["kind"])}`);
  }
  if (r["verdict"] !== "valid-addition") {
    throw new Error(`keep11 receipt の verdict が valid-addition でありません got=${String(r["verdict"])}`);
  }
  const rows = r["rows"];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("keep11 receipt に rows がありません");
  }
  const v1 = r["v1baseline"] as { snapshotSha256?: unknown } | undefined;
  const v1sha256 = v1?.snapshotSha256;
  if (typeof v1sha256 !== "string" || !/^[0-9a-f]{64}$/.test(v1sha256)) {
    throw new Error("keep11 receipt の v1baseline.snapshotSha256 が 64hex でありません");
  }
  const rowIds: string[] = [];
  let code: string | null = null;
  for (const row of rows) {
    const o = row as Record<string, unknown>;
    const rowPageId = o["rowPageId"];
    if (typeof rowPageId !== "string" || rowPageId === "") {
      throw new Error("keep11 receipt の行に rowPageId がありません");
    }
    const m = o["masterMembership"] as Record<string, unknown> | undefined;
    if (
      !m ||
      m["fullComplete"] !== true ||
      m["hasKeep"] !== true ||
      m["hasRetire"] !== false ||
      m["otherCount"] !== 0
    ) {
      throw new Error(`keep11 receipt の行の membership 証明が不完全です row=${rowPageId}`);
    }
    const props = o["props"] as Record<string, Record<string, unknown>> | undefined;
    const issuer = props?.["銘柄コード"];
    const issuerText = typeof issuer?.["text"] === "string" ? (issuer["text"] as string) : null;
    if (!issuerText) {
      throw new Error(`keep11 receipt の行に発行者実値がありません row=${rowPageId}`);
    }
    if (code === null) code = issuerText;
    if (issuerText !== code) {
      throw new Error(`keep11 receipt の行の発行者が混在しています row=${rowPageId} got=${issuerText}`);
    }
    const origin = props?.["原本"];
    if (origin?.["has_more"] !== false || typeof origin?.["count"] !== "number" || (origin["count"] as number) < 1) {
      throw new Error(`keep11 receipt の行に原本の実証がありません row=${rowPageId}`);
    }
    rowIds.push(rowPageId);
  }
  return { code: code as string, rowIds, v1sha256 };
}

/**
 * v1 snapshot から保持先 baseline 集合を抽出する (純粋)。
 * v1 バイト列の CAS 自己検証 + receipt の v1 SHA 照合 + 開示集合の突合せを
 * 通し、1 つでも欠ければ throw する ( baseline のすり替え・欠落を許さない)。
 */
export function extractKeeperBaselineFromV1(
  v1doc: unknown,
  receipt: Keep11ReceiptEvidence
): Record<string, KeeperIncomingBaseline> {
  const v1 = v1doc as SnapshotDoc;
  if (!v1 || typeof v1 !== "object" || v1.version !== 1) {
    throw new Error("v1 snapshot の version が 1 でありません");
  }
  const rehash = sha256HexUtf8(stableStringify(snapshotWithoutHash(v1)));
  if (rehash !== v1.sha256) {
    throw new Error("v1 snapshot の CAS 自己検証に失敗しました (hash 不一致)");
  }
  if (v1.sha256 !== receipt.v1sha256) {
    throw new Error("v1 snapshot が receipt の v1 SHA と不一致です (別 snapshot の疑い)");
  }
  const out: Record<string, KeeperIncomingBaseline> = {};
  for (const t of TARGETS) {
    const m = v1.masters[t.keepId];
    if (!m) throw new Error(`v1 snapshot に保持先がありません: ${t.code}`);
    const view = toMasterView(m.page, m.children);
    const disc = view.relations[REVERSE_PROP_DISCLOSURES];
    const fin = view.relations[REVERSE_PROP_FINANCIALS];
    if (!disc || !fin) {
      throw new Error(`v1 snapshot の保持先に逆 relation がありません: ${t.code}`);
    }
    if (disc.has_more || fin.has_more) {
      throw new Error(`v1 snapshot の保持先 baseline が未完です (has_more): ${t.code}`);
    }
    out[t.code] = { disclosures: [...disc.ids], financials: [...fin.ids] };
  }
  // 開示集合の突合せ: v1 と実 receipt の 11 集合が完全一致すること。
  const v1keep = out[receipt.code];
  if (!v1keep) {
    throw new Error(`receipt の code ${receipt.code} が v1 baseline にありません`);
  }
  const norm = (ids: string[]) => ids.map(normalizePageId).sort();
  const v1disc = norm(v1keep.disclosures);
  const rcDisc = norm(receipt.rowIds);
  if (JSON.stringify(v1disc) !== JSON.stringify(rcDisc)) {
    throw new Error(
      `v1 と実 receipt の開示集合が不一致です (baseline 不一致のため停止): ` +
        `v1=${v1disc.length}件 receipt=${rcDisc.length}件`
    );
  }
  return out;
}

/**
 * 保持先 baseline の実行時読取。snapshotDir の実 receipt (private) と
 * 一次データ保管の v1 snapshot (readonly DL+CAS 検証) から証明済み集合を
 * 得る。ID 一覧をコード・Git 証跡に埋め込まない。
 */
export async function loadKeeperBaseline(
  paceMs: number,
  snapshotDir: string
): Promise<Record<string, KeeperIncomingBaseline>> {
  const p = path.join(snapshotDir, KEEP11_BASELINE_FILE);
  if (!fs.existsSync(p)) {
    throw new Error(
      `保持先 baseline 証跡が無いため停止します: ${p} (keep11 実 receipt を snapshotDir へ配置してください)`
    );
  }
  const receipt = parseKeep11Receipt(JSON.parse(fs.readFileSync(p, "utf8")));
  const dbIds = await findAllArchiveDbIds(ARCHIVE_SERVICE, "backup");
  const hits = dbIds.length === 0 ? [] : await queryArchiveByKeyAll(paceMs, dbIds, SNAPSHOT_KEY);
  if (hits.length === 0) {
    throw new Error("v1 snapshot が一次データ保管にありません (baseline 取得不可のため停止)");
  }
  if (hits.length >= 2) {
    throw new Error(
      `v1 snapshot が重複しています (どれが正か決めず停止) ids=${hits.map((h) => h.id).join(",")}`
    );
  }
  const listed = await listPageFiles(hits[0].id, "Files");
  const snaps = listed.filter((f) => f.name.startsWith("snapshot-") && f.name.endsWith(".json"));
  if (snaps.length !== 1) {
    throw new Error(
      `v1 snapshot JSON が一意に定まりません got=[${listed.map((f) => f.name).join(",")}] page=${hits[0].id}`
    );
  }
  const bytes = await downloadNotionFileBytes(snaps[0].url, snaps[0].name);
  const v1doc = JSON.parse(Buffer.from(bytes).toString("utf8")) as SnapshotDoc;
  return extractKeeperBaselineFromV1(v1doc, receipt);
}

/**
 * 保持先 incoming 1 行の live 証明を取得する (readonly)。
 * issuer は行の「銘柄コード」実値のみ (title 等の metadata を代用しない)。
 * master relation は全 pagination。原本の打切り・欠測は証明に載せて
 * 判定側で止める (ここで握り潰さない)。
 */
export async function fetchKeeperRowProof(paceMs: number, rowPageId: string): Promise<KeeperRowProof> {
  const page = await getPage(paceMs, rowPageId);
  let issuerCode: string | null = null;
  const codeProp = page.properties["銘柄コード"];
  if (codeProp && codeProp["type"] === "rich_text" && Array.isArray(codeProp["rich_text"])) {
    const text = joinRichText(
      codeProp["rich_text"] as Array<{ plain_text?: string; text?: { content: string } }>
    );
    issuerCode = text === "" ? null : text;
  }
  const originProp = page.properties["原本"];
  if (!originProp || originProp["type"] !== "relation") {
    throw new Error(`row=${rowPageId} に原本 relation がありません (スキーマ変化)`);
  }
  const originHasMore = originProp["has_more"] === true;
  const originCount = originHasMore
    ? (await readRelationFull(paceMs, rowPageId, page, "原本")).length
    : readRelationIds(originProp).length;
  const masterIdsFull = await readRelationFull(paceMs, rowPageId, page, REL_PROP_MASTER);
  return { rowPageId, issuerCode, originHasMore, originCount, masterIdsFull };
}

/**
 * 保持先 incoming の live 集合ガード (guardMasterView の keep ④③分)。
 * keeper 頁の逆 relation を全 pagination で読み、baseline と集合比較する。
 * 追加行だけ live 証明 (issuer/原本/keep-only) を取得して判定する。
 * 未完 pagination・取得失敗は問題として返す (呼出側が STOP する)。
 */
export async function guardKeeperIncomingLive(
  paceMs: number,
  t: MasterTarget,
  keepPage: NotionPage,
  baseline: KeeperIncomingBaseline
): Promise<string[]> {
  const problems: string[] = [];
  const pairs = [
    { db: "disclosures", prop: REVERSE_PROP_DISCLOSURES, baselineIds: baseline.disclosures },
    { db: "financials", prop: REVERSE_PROP_FINANCIALS, baselineIds: baseline.financials },
  ] as const;
  for (const { db, prop, baselineIds } of pairs) {
    let liveIds: string[];
    try {
      liveIds = await readRelationFull(paceMs, t.keepId, keepPage, prop);
    } catch (e) {
      problems.push(`${t.code}/keep/${db}: live 列挙に失敗: ${(e as Error).message}`);
      continue;
    }
    const baseSet = new Set(baselineIds.map(normalizePageId));
    const added = liveIds.filter((id) => !baseSet.has(normalizePageId(id)));
    const addedProofs: KeeperRowProof[] = [];
    let proofFailed = false;
    for (const id of added) {
      try {
        addedProofs.push(await fetchKeeperRowProof(paceMs, id));
      } catch (e) {
        problems.push(`${t.code}/keep/${db}: 追加行の証明取得に失敗: ${(e as Error).message}`);
        proofFailed = true;
      }
    }
    if (proofFailed) continue;
    const p = guardKeeperIncomingIds({
      tag: `${t.code}/keep/${prop}`,
      code: t.code,
      keepId: t.keepId,
      liveIds,
      baselineIds,
      addedProofs,
    });
    if (p) problems.push(p);
  }
  return problems;
}

async function takeSnapshot(
  paceMs: number,
  snapshotDir: string,
  state: FreshState,
  baseline: Record<string, KeeperIncomingBaseline>
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
      // v2: 本文全 capture + 添付 inventory (打切り・欠落は capture 側で STOP)。
      const proof = await capturePageProof(paceMs, snapshotDir, id, page);
      masters[id] = { code: t.code, role, page, children, body: proof.body, files: proof.files };
      freshViews[`${t.code}:${role}`] = toMasterView(page, children);
    }
  }
  for (const t of TARGETS) {
    const b = baseline[t.code];
    if (!b) throw new Error(`snapshot 中止: 保持先 baseline がありません: ${t.code}`);
    const p = [
      ...guardMasterView(t, "keep", freshViews[`${t.code}:keep`]),
      ...guardMasterView(t, "retire", freshViews[`${t.code}:retire`]),
      ...(await guardKeeperIncomingLive(paceMs, t, masters[t.keepId].page, b)),
    ];
    if (p.length > 0) {
      throw new Error(`snapshot 中止: ガード後の master 変化を検出: ${p.join(" / ")}`);
    }
  }
  // 保持先 incoming 全 ID を snapshot へ固定し、直後再読で完全一致を要求する
  // (固定と再読の間に変われば同時変更として STOP する)。
  const keeperIncoming: NonNullable<SnapshotDoc["keeperIncoming"]> = {};
  for (const t of TARGETS) {
    const first = {
      disclosures: await readRelationFull(paceMs, t.keepId, masters[t.keepId].page, REVERSE_PROP_DISCLOSURES),
      financials: await readRelationFull(paceMs, t.keepId, masters[t.keepId].page, REVERSE_PROP_FINANCIALS),
    };
    const rereadPage = await getPage(paceMs, t.keepId);
    const second = {
      disclosures: await readRelationFull(paceMs, t.keepId, rereadPage, REVERSE_PROP_DISCLOSURES),
      financials: await readRelationFull(paceMs, t.keepId, rereadPage, REVERSE_PROP_FINANCIALS),
    };
    const sortNorm = (ids: string[]) => ids.map(normalizePageId).sort();
    for (const db of ["disclosures", "financials"] as const) {
      if (JSON.stringify(sortNorm(first[db])) !== JSON.stringify(sortNorm(second[db]))) {
        throw new Error(
          `snapshot 中止: 保持先 incoming が固定と再読で不一致 ${t.code}/keep/${db} (同時変更の疑い)`
        );
      }
    }
    const byNorm = (ids: string[]) =>
      [...ids].sort((a, b) => (normalizePageId(a) < normalizePageId(b) ? -1 : 1));
    keeperIncoming[t.code] = { disclosures: byNorm(first.disclosures), financials: byNorm(first.financials) };
  }
  // 移行対象の incoming 行 (退避候補の逆 relation + 原本)。
  const incoming: SnapshotDoc["incoming"] = {};
  // 候補 Map: 対応 retireID + 由来 (reverse/fwd) を保持。同一行の重複は
  // reverse 優先 (FWD では上書きしない。DB kind だけの判定をしない)。
  const candidates = new Map<
    string,
    { db: IncomingDb; prop: string; origin: IncomingOrigin; retireId: string }
  >();
  for (const t of TARGETS) {
    const retireView = freshViews[`${t.code}:retire`];
    for (const rowId of retireView.relations[REVERSE_PROP_DISCLOSURES]?.ids ?? []) {
      if (!candidates.has(rowId)) {
        candidates.set(rowId, { db: "disclosures", prop: REL_PROP_MASTER, origin: "reverse", retireId: t.retireId });
      }
    }
    for (const rowId of retireView.relations[REVERSE_PROP_FINANCIALS]?.ids ?? []) {
      if (!candidates.has(rowId)) {
        candidates.set(rowId, { db: "financials", prop: REL_PROP_MASTER, origin: "reverse", retireId: t.retireId });
      }
    }
  }
  for (const t of TARGETS) {
    for (const rawId of readRelationIds(masters[t.retireId].page.properties[FWD_PROP_RAW])) {
      if (!candidates.has(rawId)) {
        candidates.set(rawId, { db: "raw_files", prop: REL_PROP_RELATED, origin: "fwd", retireId: t.retireId });
      }
    }
  }
  // 決定論的順序 (DB 種別→page id)。
  const dbOrder: Record<IncomingDb, number> = { disclosures: 0, financials: 1, raw_files: 2 };
  const expectRetireLink = [...candidates.entries()].map(([rowPageId, c]) => ({ rowPageId, ...c }));
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
    // 対応 retire への完全 membership で判定する (どちらかの retire ではない)。
    const hasCorresponding = relationFull.some(
      (id) => normalizePageId(id) === normalizePageId(exp.retireId)
    );
    // FWD-only 由来の absence (実配列で証明済み。preview のみでは到達しない)
    // は no-op evidence として snapshot に保持する (本文・添付は complete
    // 取得。全履歴・別 stock refs も relationFull に保存)。
    // reverse 由来の absence は DB 種別にかかわらず STOP。
    classifyIncomingMembership(exp.origin, hasCorresponding, exp.rowPageId);
    // 非対象 body の後判定用に子ブロック像も物理 snapshot する。
    const children = await listChildrenFirst(paceMs, exp.rowPageId);
    if (children.has_more) {
      throw new Error(`snapshot 中止: 子ブロックが打ち切られました row=${exp.rowPageId} (has_more)`);
    }
    // v2: 本文全 capture + 添付 inventory (Files hosted 等の physical は pin 留め)。
    const proof = await capturePageProof(paceMs, snapshotDir, exp.rowPageId, page);
    incoming[exp.rowPageId] = {
      db: exp.db,
      prop: exp.prop,
      page,
      relationFull,
      blockCount: children.results.length,
      childDatabases: children.results
        .filter((b) => b.type === "child_database")
        .map((b) => b.child_database?.title ?? ""),
      body: proof.body,
      files: proof.files,
    };
  }
  const supplement: SnapshotDoc["supplement"] = {};
  const supplementProof: NonNullable<SnapshotDoc["supplementProof"]> = {};
  for (const [id, page] of Object.entries(state.supplementPages)) {
    supplement[id] = page;
    // v2: 補足行も本文・添付の完全 proof (全 page 対象)。
    supplementProof[id] = await capturePageProof(paceMs, snapshotDir, id, page);
  }
  const doc: SnapshotDoc = {
    version: 2,
    takenAt: new Date().toISOString(),
    masters,
    incoming,
    supplement,
    supplementProof,
    keeperIncoming,
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

/** snapshot.incoming から移行 ops を導出する。退避を含まない行 (no-op evidence) は ops 対象外。 */
export function buildMigrationOps(snapshot: SnapshotDoc): MigrationOp[] {
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
  expected: { names: string[]; shas: Record<string, string> }
): Promise<void> {
  const listed = await listPageFiles(archivePageId, "Files");
  if (listed.length !== expected.names.length) {
    throw new Error(
      `一次データ保管の実ダウンロード: Files が ${expected.names.length} 件でありません got=${listed.length} page=${archivePageId}`
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

/** v2 snapshot JSON の保管名 (v1 と同日でも別名。混同しない)。 */
export function v2SnapshotArchiveName(dateTag: string): string {
  return `master-dedup-snapshot-v2-${dateTag}.json`;
}

/** snapshot 全体から添付 inventory を集める (純粋抽出。本文ブロックは再帰)。 */
export function collectAttachmentInventory(
  snapshot: SnapshotDoc
): Array<{ name: string; origin: string; bytesSha256: string }> {
  const out: Array<{ name: string; origin: string; bytesSha256: string }> = [];
  const walkBlocks = (blocks: CapturedBlock[]): void => {
    for (const b of blocks) {
      if (b.file) out.push({ name: b.file.name, origin: b.file.origin, bytesSha256: b.file.bytesSha256 });
      if (b.children) walkBlocks(b.children);
    }
  };
  for (const m of Object.values(snapshot.masters)) {
    for (const f of m.files?.files ?? []) {
      out.push({ name: f.name, origin: f.origin, bytesSha256: f.bytesSha256 });
    }
    if (m.body) walkBlocks(m.body.blocks);
  }
  for (const e of Object.values(snapshot.incoming)) {
    for (const f of e.files?.files ?? []) {
      out.push({ name: f.name, origin: f.origin, bytesSha256: f.bytesSha256 });
    }
    if (e.body) walkBlocks(e.body.blocks);
  }
  for (const p of Object.values(snapshot.supplementProof ?? {})) {
    for (const f of p.files.files) {
      out.push({ name: f.name, origin: f.origin, bytesSha256: f.bytesSha256 });
    }
    walkBlocks(p.body.blocks);
  }
  return out;
}

/**
 * 添付の保管名を決める (純粋関数)。同名同 SHA は 1 件に畳み重複保管しない。
 * 同名異 SHA・base 3 名との衝突は黙って改名せず STOP する (ルール2)。
 */
export function mapAttachmentArchiveNames(
  baseNames: string[],
  inventory: Array<{ name: string; bytesSha256: string }>
): Array<{ archiveName: string; sha256: string }> {
  const byName = new Map<string, string>();
  for (const e of inventory) {
    const prev = byName.get(e.name);
    if (prev === undefined) {
      byName.set(e.name, e.bytesSha256);
    } else if (prev !== e.bytesSha256) {
      throw new Error(`添付名の衝突のため停止します (同名異 SHA。改名しません): ${e.name}`);
    }
  }
  for (const n of byName.keys()) {
    if (baseNames.includes(n)) {
      throw new Error(`添付名が snapshot/証拠名と衝突のため停止します (改名しません): ${n}`);
    }
  }
  return [...byName.entries()]
    .map(([archiveName, sha256]) => ({ archiveName, sha256 }))
    .sort((a, b) => (a.archiveName < b.archiveName ? -1 : 1));
}

/**
 * v2 snapshot を一次データ保管へ記録し、実ダウンロードで検証する。
 * v1 レコード (SNAPSHOT_KEY) は触らず、別キー (SNAPSHOT_KEY_V2) の
 * 別レコードに snapshot JSON + 証拠 2 件 + 添付 physical 全件を入れる。
 * v1 の skipped_existing を new full proof として採用しない。
 */
export async function archiveSnapshotV2(
  paceMs: number,
  snapshotDir: string,
  file: string,
  snapshot: SnapshotDoc,
  receipt: DedupReceipt
): Promise<DedupReceipt> {
  if (snapshot.version !== 2) {
    throw new Error("v2 保管に v1 snapshot を渡さないでください (完全 proof なし)");
  }
  const dateTag = snapshot.takenAt.slice(0, 10);
  const baseNames = [v2SnapshotArchiveName(dateTag), `Edinetcode-${dateTag}.zip`, `jpx-delisted-${dateTag}.html`];
  const inventory = collectAttachmentInventory(snapshot);
  const attachments = mapAttachmentArchiveNames(baseNames, inventory);
  const names = [...baseNames, ...attachments.map((a) => a.archiveName)];
  const snapshotBytes = new Uint8Array(fs.readFileSync(file));
  const zipBytes = new Uint8Array(fs.readFileSync(path.join(snapshotDir, "Edinetcode.zip")));
  const htmlBytes = new Uint8Array(fs.readFileSync(path.join(snapshotDir, "jpx-delisted.html")));
  const localShas: Record<string, string> = {
    [names[0]]: sha256HexBytes(snapshotBytes),
    [names[1]]: sha256HexBytes(zipBytes),
    [names[2]]: sha256HexBytes(htmlBytes),
  };
  const attachmentFiles: Array<{ bytes: Uint8Array; filename: string; contentType: string }> = [];
  for (const a of attachments) {
    const diskPath = path.join(snapshotDir, attachmentDiskName(a.sha256));
    if (!fs.existsSync(diskPath)) {
      throw new Error(`添付の pin が無いため停止します (capture 時の実バイト列が必須): ${a.archiveName}`);
    }
    const bytes = new Uint8Array(fs.readFileSync(diskPath));
    if (sha256HexBytes(bytes) !== a.sha256) {
      throw new Error(`添付の pin が SHA 不一致のため停止します (すり替えの疑い): ${a.archiveName}`);
    }
    localShas[a.archiveName] = a.sha256;
    attachmentFiles.push({ bytes, filename: a.archiveName, contentType: "application/octet-stream" });
  }
  if (localShas[names[1]] !== snapshot.evidence.edinet.sha256) {
    throw new Error("Edinetcode.zip の SHA が snapshot 証拠と不一致 (すり替えの疑い)");
  }
  if (localShas[names[2]] !== snapshot.evidence.jpx.sha256) {
    throw new Error("jpx-delisted.html の SHA が snapshot 証拠と不一致 (すり替えの疑い)");
  }
  if (receipt.snapshotV2) {
    // 再開時も実ダウンロードで元バイト列一致を確認してから移行する。
    const page = await notionRequest<NotionPage>("GET", `/pages/${receipt.snapshotV2.archivePageId}`);
    verifyArchivePage(page, receipt.snapshotV2.sha256, names.length);
    const wantShas: Record<string, string> = {};
    for (const n of names) {
      wantShas[n] =
        n === names[0]
          ? (receipt.snapshotV2.snapshotBytesSha256 ?? localShas[n])
          : n === names[1]
            ? (receipt.snapshotV2.zipSha256 ?? localShas[n])
            : n === names[2]
              ? (receipt.snapshotV2.htmlSha256 ?? localShas[n])
              : (receipt.snapshotV2.attachmentShas?.[n] ?? localShas[n]);
    }
    await verifyArchiveDownload(receipt.snapshotV2.archivePageId, { names, shas: wantShas });
    if (!receipt.snapshotV2.snapshotBytesSha256) {
      receipt.snapshotV2.snapshotBytesSha256 = localShas[names[0]];
      receipt.snapshotV2.zipSha256 = localShas[names[1]];
      receipt.snapshotV2.htmlSha256 = localShas[names[2]];
      receipt.snapshotV2.attachmentShas = Object.fromEntries(attachments.map((a) => [a.archiveName, a.sha256]));
      receipt.snapshotV2.fileNames = [...names];
      receipt.snapshotV2.archiveVerifiedAt = new Date().toISOString();
      saveReceipt(snapshotDir, receipt);
    }
    return receipt;
  }
  // 非冪等 create 前に full 検索で既存を確認する (findByKey page_size 1 依存禁止)。
  const dbIds = await findAllArchiveDbIds(ARCHIVE_SERVICE, "backup");
  const hits = dbIds.length === 0 ? [] : await queryArchiveByKeyAll(paceMs, dbIds, SNAPSHOT_KEY_V2);
  const decision = decideSnapshotAction({
    backupHits: hits.length,
    hasMarker: receipt.snapshotV2Issued !== undefined,
  });
  if (decision === "stop") {
    if (hits.length >= 2) {
      throw new Error(
        `一次データ保管に v2 snapshot が ${hits.length} 件重複しています (二重作成の疑い)。どれが正か決めず停止します ids=${hits.map((h) => h.id).join(",")}`
      );
    }
    throw new Error(
      "v2 snapshot の create 結果不明のため停止します (marker あり・full query 0 件)。自動解除・再 create しません。後日 Notion を再読してください"
    );
  }
  if (decision === "recover") {
    const hit = hits[0];
    verifyArchivePage(hit, snapshot.sha256, names.length);
    await verifyArchiveDownload(hit.id, { names, shas: localShas });
    receipt.snapshotV2 = {
      file: path.basename(file),
      sha256: snapshot.sha256,
      archivePageId: hit.id,
      archiveVerifiedAt: new Date().toISOString(),
      snapshotBytesSha256: localShas[names[0]],
      zipSha256: localShas[names[1]],
      htmlSha256: localShas[names[2]],
      attachmentShas: Object.fromEntries(attachments.map((a) => [a.archiveName, a.sha256])),
      fileNames: [...names],
    };
    saveReceipt(snapshotDir, receipt);
    return receipt;
  }
  // create: helper 呼出前に key+snapshotHash+issuedAt を atomic 保存する。
  receipt.snapshotV2Issued = {
    key: SNAPSHOT_KEY_V2,
    snapshotHash: snapshot.sha256,
    issuedAt: new Date().toISOString(),
  };
  saveReceipt(snapshotDir, receipt);
  const res = await recordPrimaryData({
    service: ARCHIVE_SERVICE,
    key: SNAPSHOT_KEY_V2,
    source: "Notion ①③④⑤ + D1 jss_notion_pages + JPX/EDINET 公開取得 + 添付 physical (Issue #102 単発解消 v2)",
    fetchedAt: snapshot.takenAt,
    metadata: {
      snapshotSha256: snapshot.sha256,
      snapshotFile: path.basename(file),
      snapshotVersion: 2,
      masters: Object.keys(snapshot.masters).length,
      incomingRows: Object.keys(snapshot.incoming).length,
      supplementRows: Object.keys(snapshot.supplement).length,
      attachments: attachments.map((a) => ({ name: a.archiveName, sha256: a.sha256 })),
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
      ...attachmentFiles,
    ],
  });
  if (res.fileTooLarge) {
    throw new Error("一次データ保管に上限超過ファイルあり。正直に停止します (v2 snapshot 未確定)");
  }
  const page = await notionRequest<NotionPage>("GET", `/pages/${res.pageId}`);
  verifyArchivePage(page, snapshot.sha256, names.length);
  await verifyArchiveDownload(res.pageId, { names, shas: localShas });
  receipt.snapshotV2 = {
    file: path.basename(file),
    sha256: snapshot.sha256,
    archivePageId: res.pageId,
    archiveVerifiedAt: new Date().toISOString(),
    snapshotBytesSha256: localShas[names[0]],
    zipSha256: localShas[names[1]],
    htmlSha256: localShas[names[2]],
    attachmentShas: Object.fromEntries(attachments.map((a) => [a.archiveName, a.sha256])),
    fileNames: [...names],
  };
  saveReceipt(snapshotDir, receipt);
  return receipt;
}

export function verifyArchivePage(page: NotionPage, wantSha: string, expectedCount = 3): void {
  const status = (page.properties["Status"]?.["select"] as { name?: string } | null)?.name;
  if (status !== "recorded") {
    throw new Error(`一次データ保管の再読: Status=${status} (recorded でない) page=${page.id}`);
  }
  const files = page.properties["Files"]?.["files"];
  if (!Array.isArray(files) || files.length !== expectedCount) {
    throw new Error(`一次データ保管の再読: Files が ${expectedCount} 件でありません page=${page.id}`);
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
  const snapKeep = snapshot.masters[keepId];
  const checkRemote = async (): Promise<"done" | "todo" | "diverged"> => {
    const fresh = await getPage(paceMs, keepId);
    const props = fresh.properties as Record<string, unknown>;
    // 更新前後の fresh proof 照合 (同数の内容変更も検出。不一致は diverged)。
    const freshProof = await capturePageProof(paceMs, snapshotDir, keepId, fresh);
    const proofOk = pageProofsEqual({ body: snapKeep?.body, files: snapKeep?.files }, freshProof);
    const status = (fresh.properties["状態"]?.["select"] as { name?: string } | null)?.name ?? null;
    if (status === LIFECYCLE_PATCH_3681_STATUS && propertiesEqualExcept("状態", before, props)) {
      const listed = fresh.properties["上場状態"]?.["checkbox"] === true;
      return !listed && proofOk ? "done" : "diverged";
    }
    if (status === null && propertiesEqualExcept("状態", before, props)) return proofOk ? "todo" : "diverged";
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
    // 更新直前の fresh proof 照合 (同数の内容変更も検出。打切りは capture 側で STOP)。
    const freshProof = await capturePageProof(paceMs, snapshotDir, op.rowPageId, fresh);
    const bodyUnchanged = pageProofsEqual(snapEntry, freshProof);
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
    // 移行直後の fresh proof 照合 (同数の内容変更も検出)。
    await verifyFreshPageProof(
      paceMs,
      snapshotDir,
      op.rowPageId,
      reread,
      "移行対象外の本文・添付",
      snapEntry.body,
      snapEntry.files
    );
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
  const snapProof = snapshot.supplementProof?.[SUPPLEMENT_7129_PAGE_ID];
  const fresh = await getPage(paceMs, SUPPLEMENT_7129_PAGE_ID);
  // 更新直前の fresh proof 照合 (同数の内容変更も検出)。
  await verifyFreshPageProof(
    paceMs,
    snapshotDir,
    SUPPLEMENT_7129_PAGE_ID,
    fresh,
    "7129 補足の本文・添付",
    snapProof?.body,
    snapProof?.files
  );
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
  // 修復直後の fresh proof 照合 (同数の内容変更も検出)。
  await verifyFreshPageProof(
    paceMs,
    snapshotDir,
    SUPPLEMENT_7129_PAGE_ID,
    reread,
    "7129 補足の本文・添付",
    snapProof?.body,
    snapProof?.files
  );
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
 * 退避直前の原像突合。fresh の非 relation props + body/添付 proof が
 * 物理 snapshot と一致しなければ同時変更として停止する。
 * 逆 relation は移行後に空になるため比較対象外 (relation 除外)。
 * proofs 付きの場合は内容一致 (同数の変更も検出) を要求する。
 */
export function verifyRetirePreimage(args: {
  retireId: string;
  snapProps: Record<string, unknown>;
  snapBlockCount: number;
  snapChildDbs: string[];
  freshProps: Record<string, unknown>;
  freshBlockCount: number;
  freshChildDbs: string[];
  proofs?: {
    snapBody: BodyCapture | undefined;
    snapFiles: FilesCapture | undefined;
    freshBody: BodyCapture;
    freshFiles: FilesCapture;
  };
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
  if (args.proofs) {
    const p = args.proofs;
    if (!pageProofsEqual({ body: p.snapBody, files: p.snapFiles }, { body: p.freshBody, files: p.freshFiles })) {
      throw new Error(`退避直前に元ページの本文・添付が変化しています: ${args.retireId}`);
    }
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
    // v2 の一次データ保管が必須 (v1 保管済みは new full proof にならない)。
    if (!receipt.snapshotV2?.archiveVerifiedAt) {
      throw new Error("v2 snapshot なしで退避しません (archive 前に一次データ保管が必須)");
    }
    if (!allMigrated(ops, receipt) || !receipt.lifecycle3681 || !receipt.supplement7129 || !receipt.d1) {
      throw new Error("移行・補足・lifecycle・D1 の完了前に退避しません");
    }
    const snapMasters = snapshot.masters[t.retireId];
    if (!snapMasters) throw new Error(`snapshot に退避元がありません: ${t.retireId}`);
    const origin = await getPage(paceMs, t.retireId);
    // 退避直前の fresh proof capture (打切りは capture 側で STOP)。
    const originProof = await capturePageProof(paceMs, snapshotDir, t.retireId, origin);
    const originChildDbs = originProof.body.blocks
      .filter((b) => b.type === "child_database")
      .map((b) => b.refTitle ?? "");
    // 退避直前の原像突合 (非 relation + body/添付 proof)。変化があれば同時変更として停止。
    verifyRetirePreimage({
      retireId: t.retireId,
      snapProps: snapMasters.page.properties as Record<string, unknown>,
      snapBlockCount: snapMasters.children.results.length,
      snapChildDbs: snapMasters.children.results
        .filter((b) => b.type === "child_database")
        .map((b) => b.child_database?.title ?? ""),
      freshProps: origin.properties as Record<string, unknown>,
      freshBlockCount: originProof.body.blocks.length,
      freshChildDbs: originChildDbs,
      proofs: {
        snapBody: snapMasters.body,
        snapFiles: snapMasters.files,
        freshBody: originProof.body,
        freshFiles: originProof.files,
      },
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
    const snapKeepSets = snapshot.keeperIncoming?.[t.code];
    if (!snapKeepSets) {
      throw new Error(`${t.code}: snapshot に keeperIncoming がありません (v2 完全 proof なし)`);
    }
    const snapRetire = snapshot.masters[t.retireId];
    const beforeView = (m: SnapshotDoc["masters"][string]): MasterPageView =>
      toMasterView(m.page, m.children);
    // 最終 reread も実配列 (全 pagination) で検証する。preview 25 では欠落を見逃す。
    // keep 側の before は take 固定の全 ID 集合 (preview 由来ではない)。
    for (const [prop, db] of [
      [REVERSE_PROP_DISCLOSURES, "disclosures"],
      [REVERSE_PROP_FINANCIALS, "financials"],
    ] as const) {
      let keepAfterFull: string[];
      try {
        keepAfterFull = await readRelationFull(paceMs, t.keepId, keepFresh, prop);
      } catch (e) {
        problems.push(`${t.code}/${prop}: 最終 reread に失敗: ${(e as Error).message}`);
        continue;
      }
      const p = verifyReverseUnion({
        label: `${t.code}/${prop}`,
        keepBefore: snapKeepSets[db],
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
  if (snapshot.version !== 1 && snapshot.version !== 2) {
    throw new Error(`snapshot の version が不正です: ${file}`);
  }
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
    receipt.snapshotV2?.sha256 ??
    receipt.snapshotV2Issued?.snapshotHash ??
    receipt.snapshot?.sha256 ??
    receipt.snapshotIssued?.snapshotHash ??
    Object.values(receipt.retireIssued ?? {})[0]?.snapshotHash;
  if (!want) {
    throw new Error("再開に必要な snapshot hash が receipt にありません (手動確認が必要)");
  }
  // 全 marker の hash が一致すること (混在は手動確認)。
  const hashes = new Set<string>();
  if (receipt.snapshotV2) hashes.add(receipt.snapshotV2.sha256);
  if (receipt.snapshotV2Issued) hashes.add(receipt.snapshotV2Issued.snapshotHash);
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

/**
 * 完全 proof/CAS gate (全 apply 入口の共通関門。一箇所)。
 * 初期・resume・already-applied の全 entry が snapshot 確定後に必ず通す。
 * 不完全な body/schema/attachment proof・CAS drift があれば STOP する。
 * v1 snapshot (props+子 first/count/name のみ) は proof 不完全として STOP し、
 * v1 の保管済みを new full proof として採用しない。
 */
export function requireCompleteSnapshotProof(snapshot: SnapshotDoc, receipt: DedupReceipt): void {
  if (snapshot.version !== 2) {
    throw new Error(
      `旧 v${snapshot.version} snapshot のため停止します (body/files proof なし)。` +
        "新規 snapshot-dir で fresh v2 を取得してください (v1 ファイル自体は不変)"
    );
  }
  const rehash = sha256HexUtf8(stableStringify(snapshotWithoutHash(snapshot)));
  if (rehash !== snapshot.sha256) {
    throw new Error("snapshot の CAS 自己検証に失敗しました (hash 不一致・すり替えの疑い)");
  }
  // receipt↔snapshot の CAS 対応。v1 系の記録があれば混在として STOP する。
  if (receipt.snapshot !== undefined || receipt.snapshotIssued !== undefined) {
    throw new Error(
      "v1 系の receipt 記録があるため停止します (v1/v2 混在不可)。新規 snapshot-dir で fresh v2 から始めてください"
    );
  }
  if (receipt.snapshotV2 !== undefined && receipt.snapshotV2.sha256 !== snapshot.sha256) {
    throw new Error("receipt の v2 snapshot hash が snapshot と不一致です (CAS drift のため停止)");
  }
  if (receipt.snapshotV2Issued !== undefined && receipt.snapshotV2Issued.snapshotHash !== snapshot.sha256) {
    throw new Error("receipt の v2 marker hash が snapshot と不一致です (CAS drift のため停止)");
  }
  for (const m of Object.values(receipt.retireIssued ?? {})) {
    if (m.snapshotHash !== snapshot.sha256) {
      throw new Error("receipt の退避 marker hash が snapshot と不一致です (CAS drift のため停止)");
    }
  }
  const needPageProof = (label: string, body: BodyCapture | undefined, files: FilesCapture | undefined): void => {
    if (body?.fullCapture !== true || typeof body.sha256 !== "string" || body.sha256 === "") {
      throw new Error(`body proof が不完全のため停止します: ${label}`);
    }
    if (files?.complete !== true || typeof files.sha256 !== "string" || files.sha256 === "") {
      throw new Error(`attachment proof が不完全のため停止します: ${label}`);
    }
    for (const f of files.files) {
      if (typeof f.bytesSha256 !== "string" || f.bytesSha256 === "") {
        throw new Error(`attachment proof (実バイト列 SHA) が不完全のため停止します: ${label} ${f.name}`);
      }
    }
  };
  for (const [id, m] of Object.entries(snapshot.masters)) {
    needPageProof(`master ${id}`, m.body, m.files);
  }
  for (const [rowId, e] of Object.entries(snapshot.incoming)) {
    needPageProof(`incoming ${rowId}`, e.body, e.files);
  }
  for (const id of Object.keys(snapshot.supplement)) {
    const p = snapshot.supplementProof?.[id];
    needPageProof(`supplement ${id}`, p?.body, p?.files);
  }
  // keeper proof: take 固定の保持先 incoming 全 ID (両コード・両 DB)。
  for (const t of TARGETS) {
    const k = snapshot.keeperIncoming?.[t.code];
    if (!k || !Array.isArray(k.disclosures) || !Array.isArray(k.financials)) {
      throw new Error(`keeper proof が不完全のため停止します: ${t.code} (keeperIncoming なし)`);
    }
    for (const id of [...k.disclosures, ...k.financials]) {
      if (typeof id !== "string" || id === "") {
        throw new Error(`keeper proof が不完全のため停止します: ${t.code} (空 ID)`);
      }
    }
  }
  // schema proof: 既知のみ + 取得経路の完全会計 (省略なし)。
  if (!snapshot.incomingSchema || !Array.isArray(snapshot.incomingSchema.hits)) {
    throw new Error("schema proof が無いため停止します (incomingSchema なし)");
  }
  const unknown = guardIncomingSchema(snapshot.incomingSchema.hits);
  if (unknown.length > 0) {
    throw new Error(`未知 incoming のため停止します: ${unknown.join(" / ")}`);
  }
  const prov = snapshot.incomingSchema.schemaProvenance;
  if (
    !prov ||
    !Number.isInteger(prov.searchSchemaUsed) ||
    !Number.isInteger(prov.getSchemaUsed) ||
    prov.searchSchemaUsed + prov.getSchemaUsed !== snapshot.incomingSchema.dbCount
  ) {
    throw new Error("schema proof の取得経路が不完全のため停止します (provenance 欠落・不一致)");
  }
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
      requireCompleteSnapshotProof(loaded.snapshot, receipt);
      await verifyEntryFreshProofs(opts.paceMs, opts.snapshotDir, loaded.snapshot, state, receipt);
      receipt = await archiveSnapshotV2(opts.paceMs, opts.snapshotDir, loaded.file, loaded.snapshot, receipt);
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
    requireCompleteSnapshotProof(snapshot, receipt);
    await verifyEntryFreshProofs(opts.paceMs, opts.snapshotDir, snapshot, state, receipt);
  } else {
    const { problems } = guardFreshState(state);
    if (problems.length > 0) {
      console.log(JSON.stringify({ problems }, null, 2));
      console.log("ガード不一致のため書込せず停止します。");
      return 2;
    }
    // 保持先 ④③ は集合ガード (baseline は実 receipt+v1 から実行時読取)。
    const baseline = await loadKeeperBaseline(opts.paceMs, opts.snapshotDir);
    const keeperProblems: string[] = [];
    for (const t of TARGETS) {
      const b = baseline[t.code];
      const keepPage = state.pages[t.keepId];
      if (!b) {
        keeperProblems.push(`${t.code}: 保持先 baseline がありません`);
        continue;
      }
      if (!keepPage) {
        keeperProblems.push(`${t.code}: 保持先ページの fresh 読取がありません`);
        continue;
      }
      keeperProblems.push(...(await guardKeeperIncomingLive(opts.paceMs, t, keepPage, b)));
    }
    if (keeperProblems.length > 0) {
      console.log(JSON.stringify({ keeperProblems }, null, 2));
      console.log("保持先ガード不一致のため書込せず停止します。");
      return 2;
    }
    // 初回のみ fresh 証拠を snapshotDir へ保存する (再開時は既存原本を保持)。
    saveFreshEvidence(opts.snapshotDir, state.evidenceBytes);
    const taken = await takeSnapshot(opts.paceMs, opts.snapshotDir, state, baseline);
    snapshot = taken.snapshot;
    snapshotFile = taken.file;
    requireCompleteSnapshotProof(snapshot, receipt);
  }
  const ops = buildMigrationOps(snapshot);
  console.log(
    JSON.stringify(
      { snapshot: snapshotFile, sha256: snapshot.sha256, ops: ops.length, byDb: countByDb(ops) },
      null,
      2
    )
  );
  receipt = await archiveSnapshotV2(opts.paceMs, opts.snapshotDir, snapshotFile, snapshot, receipt);
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


