/**
 * 「事業タグ単語帳（台帳）」の Notion 保管 (005 yuho-quant 事業タグ)。
 * 設計: docs/005-yuho-quant-business-tags.md §3.2。
 *
 * 1 行 = 1 記録 (版／提案／見直し材料／通知)。本文に JSON を code block
 * (2,000 字ずつ) で置き、プロパティ「ハッシュ」に SHA-256 を持つ。読むときは
 * ハッシュを照合し、一致しなければ throw する (Notion 上で手で書き換えた
 * 値を黙って読み戻さない — ルール2)。
 */
import { findBackupChildByTitle } from "./archive.js";
import { notionRequest } from "./client.js";
import type { NotionSelectColor } from "./dataset.js";
import { notionEnv } from "./env.js";
import { joinRichText, splitRichText } from "./rich-text.js";
import { sha256Hex, timingSafeEqualHex } from "../sha256.js";

export const LEDGER_DB_TITLE = "事業タグ単語帳（台帳）";

export type LedgerKind = "版" | "提案" | "見直し材料" | "通知";
export type LedgerState =
  | "有効"
  | "置換済"
  | "未審査"
  | "採用"
  | "不採用"
  | "変更なし"
  | "最新"
  | "送信済";

const LEDGER_KINDS: readonly LedgerKind[] = ["版", "提案", "見直し材料", "通知"];
const LEDGER_STATES: readonly LedgerState[] = [
  "有効",
  "置換済",
  "未審査",
  "採用",
  "不採用",
  "変更なし",
  "最新",
  "送信済",
];

function isLedgerKind(v: unknown): v is LedgerKind {
  return typeof v === "string" && (LEDGER_KINDS as readonly string[]).includes(v);
}
function isLedgerState(v: unknown): v is LedgerState {
  return typeof v === "string" && (LEDGER_STATES as readonly string[]).includes(v);
}

export interface LedgerEntry {
  pageId: string;
  name: string;
  kind: LedgerKind;
  state: LedgerState;
  version: string | null;
  hash: string;
  recordedAt: string;
  reason: string;
  diff: string;
  rollbackFrom: string | null;
}

/** 本文ハッシュ照合失敗・記録本文欠落 (Notion 上の手編集を黙って読み戻さない) */
export class LedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerIntegrityError";
  }
}

const PROP = {
  name: "名前",
  kind: "種別",
  state: "状態",
  version: "版",
  hash: "ハッシュ",
  recordedAt: "記録日",
  reason: "理由",
  diff: "差分",
  rollbackFrom: "巻き戻し元",
} as const;

const KIND_OPTIONS: Array<{ name: LedgerKind; color: NotionSelectColor }> = [
  { name: "版", color: "blue" },
  { name: "提案", color: "yellow" },
  { name: "見直し材料", color: "purple" },
  { name: "通知", color: "orange" },
];
const STATE_OPTIONS: Array<{ name: LedgerState; color: NotionSelectColor }> = [
  { name: "有効", color: "green" },
  { name: "置換済", color: "gray" },
  { name: "未審査", color: "yellow" },
  { name: "採用", color: "green" },
  { name: "不採用", color: "red" },
  { name: "変更なし", color: "gray" },
  { name: "最新", color: "blue" },
  { name: "送信済", color: "gray" },
];

const LEDGER_PROPERTIES: Record<string, unknown> = {
  [PROP.name]: { title: {} },
  [PROP.kind]: { select: { options: KIND_OPTIONS } },
  [PROP.state]: { select: { options: STATE_OPTIONS } },
  [PROP.version]: { rich_text: {} },
  [PROP.hash]: { rich_text: {} },
  [PROP.recordedAt]: { date: {} },
  [PROP.reason]: { rich_text: {} },
  [PROP.diff]: { rich_text: {} },
  [PROP.rollbackFrom]: { rich_text: {} },
};

/** 本文中の JSON code block 群の目印見出し (heading_2) */
const LEDGER_JSON_MARKER = "記録本文（JSON）";

let cachedLedgerDbId: string | null = null;

/**
 * 「事業タグ単語帳（台帳）」DB を確保する (無ければ作成、あれば不足列だけ足す)。
 * 発見順: `NOTION_BIZTAG_LEDGER_DB_ID` (固定) → Search 完全一致 → 新規作成。
 */
export async function ensureLedgerDb(): Promise<string> {
  if (cachedLedgerDbId) return cachedLedgerDbId;

  let dbId = notionEnv.NOTION_BIZTAG_LEDGER_DB_ID() ?? null;
  if (!dbId) {
    dbId = await findBackupChildByTitle({
      parentPageId: notionEnv.NOTION_STOCK_INFO_PAGE_ID(),
      title: LEDGER_DB_TITLE,
      kind: "database",
    });
  }

  if (!dbId) {
    const created = await notionRequest<{ id: string }>("POST", "/databases", {
      parent: { type: "page_id", page_id: notionEnv.NOTION_STOCK_INFO_PAGE_ID() },
      title: [{ type: "text", text: { content: LEDGER_DB_TITLE } }],
      properties: LEDGER_PROPERTIES,
    });
    cachedLedgerDbId = created.id;
    return created.id;
  }

  const schema = await notionRequest<{ properties: Record<string, { id: string }> }>(
    "GET",
    `/databases/${dbId}`
  );
  const missing: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(LEDGER_PROPERTIES)) {
    if (!(name in schema.properties)) missing[name] = def;
  }
  if (Object.keys(missing).length > 0) {
    await notionRequest("PATCH", `/databases/${dbId}`, { properties: missing });
  }
  cachedLedgerDbId = dbId;
  return dbId;
}

interface LedgerPageProperty {
  title?: Array<{ plain_text?: string }>;
  rich_text?: Array<{ plain_text?: string }>;
  select?: { name?: string } | null;
  date?: { start?: string } | null;
}
interface LedgerPage {
  id: string;
  properties: Record<string, LedgerPageProperty>;
}
interface QueryResponse {
  results: LedgerPage[];
  has_more: boolean;
  next_cursor: string | null;
}

function parseLedgerPage(page: LedgerPage): LedgerEntry {
  const p = page.properties;
  const name = (p[PROP.name]?.title ?? []).map((t) => t.plain_text ?? "").join("");
  const kind = p[PROP.kind]?.select?.name;
  const state = p[PROP.state]?.select?.name;
  if (!isLedgerKind(kind)) {
    throw new Error(`listLedgerEntries: 想定外の種別です (pageId=${page.id}): ${kind}`);
  }
  if (!isLedgerState(state)) {
    throw new Error(`listLedgerEntries: 想定外の状態です (pageId=${page.id}): ${state}`);
  }
  const recordedAt = p[PROP.recordedAt]?.date?.start;
  if (!recordedAt) {
    throw new Error(`listLedgerEntries: 記録日が未設定です (pageId=${page.id})`);
  }
  const hash = joinRichText(p[PROP.hash]?.rich_text);
  if (!hash) {
    throw new Error(`listLedgerEntries: ハッシュが未設定です (pageId=${page.id})`);
  }
  const version = joinRichText(p[PROP.version]?.rich_text);
  const rollbackFrom = joinRichText(p[PROP.rollbackFrom]?.rich_text);
  return {
    pageId: page.id,
    name,
    kind,
    state,
    version: version === "" ? null : version,
    hash,
    recordedAt,
    reason: joinRichText(p[PROP.reason]?.rich_text),
    diff: joinRichText(p[PROP.diff]?.rich_text),
    rollbackFrom: rollbackFrom === "" ? null : rollbackFrom,
  };
}

/** 台帳の行を 記録日→作成時刻 の昇順で返す。 */
export async function listLedgerEntries(
  dbId: string,
  filter?: { kind?: LedgerKind; state?: LedgerState }
): Promise<LedgerEntry[]> {
  const andFilters: unknown[] = [];
  if (filter?.kind) andFilters.push({ property: PROP.kind, select: { equals: filter.kind } });
  if (filter?.state) andFilters.push({ property: PROP.state, select: { equals: filter.state } });

  const entries: LedgerEntry[] = [];
  let cursor: string | undefined;
  for (;;) {
    const body: Record<string, unknown> = {
      page_size: 100,
      sorts: [
        { property: PROP.recordedAt, direction: "ascending" },
        { timestamp: "created_time", direction: "ascending" },
      ],
    };
    if (andFilters.length === 1) body.filter = andFilters[0];
    else if (andFilters.length > 1) body.filter = { and: andFilters };
    if (cursor) body.start_cursor = cursor;

    const res = await notionRequest<QueryResponse>("POST", `/databases/${dbId}/query`, body);
    for (const page of res.results) entries.push(parseLedgerPage(page));
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return entries;
}

interface BodyBlock {
  id: string;
  type: string;
  heading_2?: { rich_text?: Array<{ plain_text?: string }> };
  code?: { rich_text?: Array<{ plain_text?: string }> };
}
interface ChildrenResponse {
  results: BodyBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

async function loadChildren(pageId: string): Promise<BodyBlock[]> {
  const blocks: BodyBlock[] = [];
  let cursor: string | undefined;
  for (;;) {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const res = await notionRequest<ChildrenResponse>("GET", `/blocks/${pageId}/children${qs}`);
    blocks.push(...res.results);
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return blocks;
}

/**
 * 記録本文 (JSON) を読み、ハッシュ照合してから JSON.parse する。
 * 見出しが無い・ハッシュ不一致は `LedgerIntegrityError` (Notion 上の手編集を
 * 黙って読み戻さない)。
 */
export async function readLedgerJson(entry: LedgerEntry): Promise<unknown> {
  const blocks = await loadChildren(entry.pageId);
  const markerIdx = blocks.findIndex(
    (b) =>
      b.type === "heading_2" &&
      joinRichText(b.heading_2?.rich_text).startsWith(LEDGER_JSON_MARKER)
  );
  if (markerIdx === -1) {
    throw new LedgerIntegrityError(
      `readLedgerJson: 記録本文の見出しが見つかりません (pageId=${entry.pageId})`
    );
  }
  let text = "";
  for (const b of blocks.slice(markerIdx + 1)) {
    if (b.type !== "code") break;
    text += joinRichText(b.code?.rich_text);
  }
  const hash = await sha256Hex(text);
  if (!timingSafeEqualHex(hash, entry.hash)) {
    throw new LedgerIntegrityError(
      `readLedgerJson: ハッシュ不一致です (pageId=${entry.pageId})。Notion 上で本文が手編集された可能性があります。`
    );
  }
  return JSON.parse(text);
}

/**
 * オブジェクトのキーをコードポイント順に再帰的に並べ替える (配列の要素順は
 * 意味を持つため変えない)。`services/yuho-quant/.../vocabulary/hash.ts` の
 * `canonicalize` と同じ規則を、shared ライブラリを特定サービスのモジュールへ
 * 依存させないためここで独立に持つ。
 */
function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForHash);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = canonicalizeForHash(record[key]);
    return sorted;
  }
  return value;
}

/**
 * 本文ハッシュの入力文字列を作る。「種別 = 版」の行だけ、外部連携向け契約
 * (docs/005-yuho-quant-business-tags-contract.md §8) が明示的に約束している
 * 「正規化 (キー順固定・空白無し) JSON の SHA-256」に合わせる。他の種別
 * (提案・見直し材料・通知) は内部利用のみで契約の対象外のため、通常の
 * JSON.stringify のままでよい (キー順を変える実益が無い)。
 * ハッシュと本文 (code block) は必ず同じ文字列から作る — 別々にすると
 * 読み戻し時のハッシュ照合 (readLedgerJson) が常に不一致になってしまう。
 */
function serializeForHash(kind: LedgerKind, json: unknown): string {
  return kind === "版" ? JSON.stringify(canonicalizeForHash(json)) : JSON.stringify(json);
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** マーカー見出し + JSON 本文の code block 群 (2,000 字ずつ・サロゲート安全) */
function jsonBodyBlocks(text: string): unknown[] {
  const blocks: unknown[] = [
    {
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: LEDGER_JSON_MARKER } }] },
    },
  ];
  const chunks =
    text.length > 0 ? splitRichText(text) : [{ type: "text" as const, text: { content: "" } }];
  for (const c of chunks) {
    blocks.push({ object: "block", type: "code", code: { language: "json", rich_text: [c] } });
  }
  return blocks;
}

/** 台帳へ 1 行記録する (本文 JSON + ハッシュ + メタ列を同時に確定させる)。 */
export async function createLedgerEntry(
  dbId: string,
  e: {
    name: string;
    kind: LedgerKind;
    state: LedgerState;
    version: string | null;
    reason: string;
    diff: string;
    rollbackFrom: string | null;
    json: unknown;
    recordedAt: string;
  }
): Promise<LedgerEntry> {
  const text = serializeForHash(e.kind, e.json);
  const hash = await sha256Hex(text);
  const blocks = jsonBodyBlocks(text);
  const [first, ...rest] = chunkArray(blocks, 100);

  const created = await notionRequest<{ id: string }>("POST", "/pages", {
    parent: { database_id: dbId },
    properties: {
      [PROP.name]: { title: [{ type: "text", text: { content: e.name } }] },
      [PROP.kind]: { select: { name: e.kind } },
      [PROP.state]: { select: { name: e.state } },
      [PROP.version]: { rich_text: e.version ? splitRichText(e.version) : [] },
      [PROP.hash]: { rich_text: splitRichText(hash) },
      [PROP.recordedAt]: { date: { start: e.recordedAt } },
      [PROP.reason]: { rich_text: splitRichText(e.reason) },
      [PROP.diff]: { rich_text: splitRichText(e.diff) },
      [PROP.rollbackFrom]: { rich_text: e.rollbackFrom ? splitRichText(e.rollbackFrom) : [] },
    },
    children: first ?? [],
  });
  for (const part of rest) {
    await notionRequest("PATCH", `/blocks/${created.id}/children`, { children: part });
  }

  return {
    pageId: created.id,
    name: e.name,
    kind: e.kind,
    state: e.state,
    version: e.version,
    hash,
    recordedAt: e.recordedAt,
    reason: e.reason,
    diff: e.diff,
    rollbackFrom: e.rollbackFrom,
  };
}

/** メタ列 (状態・理由・差分) だけを更新する (本文 JSON は触らない)。 */
export async function updateLedgerEntry(
  pageId: string,
  patch: { state?: LedgerState; reason?: string; diff?: string }
): Promise<void> {
  const properties: Record<string, unknown> = {};
  if (patch.state !== undefined) properties[PROP.state] = { select: { name: patch.state } };
  if (patch.reason !== undefined) properties[PROP.reason] = { rich_text: splitRichText(patch.reason) };
  if (patch.diff !== undefined) properties[PROP.diff] = { rich_text: splitRichText(patch.diff) };
  if (Object.keys(properties).length === 0) return;
  await notionRequest("PATCH", `/pages/${pageId}`, { properties });
}

/**
 * 記録本文 (JSON) を丸ごと差し替える (例: 見直し材料の再生成)。
 * 既存の子ブロックを全削除してから新しい本文を追記し、ハッシュ・記録日を更新する。
 */
export async function replaceLedgerJson(
  entry: LedgerEntry,
  json: unknown,
  recordedAt: string
): Promise<LedgerEntry> {
  const existing = await loadChildren(entry.pageId);
  for (const b of existing) {
    await notionRequest("DELETE", `/blocks/${b.id}`);
  }

  const text = serializeForHash(entry.kind, json);
  const hash = await sha256Hex(text);
  const blocks = jsonBodyBlocks(text);
  const parts = chunkArray(blocks, 100);
  for (const part of parts) {
    await notionRequest("PATCH", `/blocks/${entry.pageId}/children`, { children: part });
  }
  await notionRequest("PATCH", `/pages/${entry.pageId}`, {
    properties: {
      [PROP.hash]: { rich_text: splitRichText(hash) },
      [PROP.recordedAt]: { date: { start: recordedAt } },
    },
  });

  return { ...entry, hash, recordedAt };
}
