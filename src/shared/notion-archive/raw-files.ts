/** ⑤の既存原本を読む。アップロードは行わず、永続metadataに添付URLを含めない。 */
import { assertCursorProgress, notionRequest } from "./client.js";
import { notionEnv } from "./env.js";

export interface CanonicalRawFile {
  pageId: string;
  sha256: string;
  filename: string;
  sizeBytes: number;
  source: string;
  datatype: string;
  scope: string;
  dataDate: string | null;
  fetchedAt: string;
  sourceUrl: string | null;
  licenseTag: string;
  convertStatus: string;
  hostedAttachments: number;
}

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("⑤原本metadataがobjectではありません");
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (!Array.isArray(value) || value.length === 0) throw new Error("⑤原本metadataの文字列がありません");
  return value.map((fragment) => {
    const f = object(fragment);
    if (typeof f.plain_text !== "string") throw new Error("⑤原本metadataの文字列が不正です");
    return f.plain_text;
  }).join("");
};

export function parseCanonicalRawFile(value: unknown, dbId: string): CanonicalRawFile {
  const page = object(value), parent = object(page.parent), props = object(page.properties);
  const normalize = (id: unknown) => typeof id === "string" ? id.replaceAll("-", "").toLowerCase() : "";
  if (!/^[a-f0-9]{32}$/.test(normalize(page.id)) || page.object !== "page" || page.archived !== false || page.in_trash !== false ||
      parent.type !== "database_id" || normalize(parent.database_id) !== normalize(dbId)) throw new Error("⑤原本の所属/状態が不一致です");
  const prop = (name: string, type: string) => {
    const p = object(props[name]);
    if (p.type !== type || (p.has_more !== undefined && p.has_more !== false)) throw new Error(`⑤原本${name}の型/完全性が不正です`);
    return p;
  };
  const requiredText = (name: string, type = "rich_text") => {
    const result = text(prop(name, type)[type]);
    if (!result.trim()) throw new Error(`⑤原本${name}が空です`);
    return result;
  };
  const selected = (name: string, allowed: readonly string[]) => {
    const selection = object(prop(name, "select").select);
    if (typeof selection.name !== "string" || !allowed.includes(selection.name)) throw new Error(`⑤原本${name}が未知です`);
    return selection.name;
  };
  const sha256 = requiredText("SHA256"), filename = requiredText("ファイル名", "title"), sizeBytes = prop("サイズ", "number").number;
  if (!/^[a-f0-9]{64}$/.test(sha256) || /[/\\]/.test(filename) || filename === "." || filename === ".." ||
      typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new Error("⑤原本SHA/名前/サイズが不正です");
  const date = prop("データ基準日", "date").date;
  const dataDate = date === null ? null : object(date).start;
  if (dataDate !== null && (typeof dataDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dataDate) ||
      !Number.isFinite(Date.parse(dataDate)) || new Date(dataDate).toISOString().slice(0, 10) !== dataDate)) throw new Error("⑤原本の基準日が不正です");
  const fetchedAt = object(prop("取得日時", "date").date).start;
  if (typeof fetchedAt !== "string" || !Number.isFinite(Date.parse(fetchedAt))) throw new Error("⑤原本の取得日時が不正です");
  const sourceUrl = prop("取得URL", "url").url;
  if (sourceUrl !== null && typeof sourceUrl !== "string") throw new Error("⑤原本の取得URLが不正です");
  const attachments = prop("ファイル", "files").files;
  if (!Array.isArray(attachments) || attachments.length === 0) throw new Error("⑤原本の物理添付がありません");
  const names = new Set<string>();
  for (const value of attachments) {
    const attachment = object(value), file = object(attachment.file);
    if (attachment.type !== "file" || typeof attachment.name !== "string" || names.has(attachment.name) || typeof file.url !== "string") throw new Error("⑤原本の添付は一意なhosted fileではありません");
    const url = new URL(file.url);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("⑤原本hosted URLが不正です");
    names.add(attachment.name);
  }
  if (!names.has(filename) && !names.has(`${filename}.zip`)) throw new Error("⑤原本名と物理添付名が対応しません");
  return { pageId: page.id as string, sha256, filename, sizeBytes,
    source: selected("ソース", ["EDINET", "TDnet", "yfinance", "stooq", "JPX", "日証金", "計算"]),
    datatype: requiredText("データ種別"), scope: requiredText("対象銘柄コード"), dataDate: dataDate as string | null,
    fetchedAt, sourceUrl, licenseTag: selected("ライセンスタグ", ["commercial-ok", "factual-cite", "personal-only"]),
    convertStatus: selected("変換状態", ["完了", "失敗", "対象外"]), hostedAttachments: attachments.length };
}

/** OR<=50、応答<=100。欠測はmap不在、重複/打切り/未知行は停止する。 */
async function queryCanonicalRawPages(shas: readonly string[]): Promise<Map<string, { raw: CanonicalRawFile; page: unknown }>> {
  if (shas.length === 0 || shas.length > 50 || new Set(shas).size !== shas.length || shas.some((sha) => !/^[a-f0-9]{64}$/.test(sha))) throw new Error("⑤原本SHA照合は一意な1〜50件だけです");
  const dbId = notionEnv.NOTION_DB_RAW_FILES();
  const response = await notionRequest<{ results: unknown[]; has_more: boolean }>("POST", `/databases/${dbId}/query`, {
    filter: { or: shas.map((sha) => ({ property: "SHA256", rich_text: { equals: sha } })) }, page_size: 100,
  });
  if (response.has_more || response.results.length >= 100) throw new Error("⑤原本SHA照合が打ち切られました");
  const result = new Map<string, { raw: CanonicalRawFile; page: unknown }>();
  for (const value of response.results) {
    const raw = parseCanonicalRawFile(value, dbId);
    if (!shas.includes(raw.sha256) || result.has(raw.sha256)) throw new Error("⑤原本SHA照合に未知/重複行があります");
    result.set(raw.sha256, { raw, page: value });
  }
  return result;
}

export async function findCanonicalRawFiles(shas: readonly string[]): Promise<Map<string, CanonicalRawFile>> {
  return new Map([...await queryCanonicalRawPages(shas)].map(([sha, value]) => [sha, value.raw]));
}

export interface CanonicalRawAttachment { raw: CanonicalRawFile; file: { name: string; url: string } }
/** 既存SHA queryのfilesを再利用。署名URLは短命のメモリ内利用専用、log/manifestへ保存禁止。 */
export async function findCanonicalRawFileAttachments(shas: readonly string[]): Promise<Map<string, CanonicalRawAttachment>> {
  const result = new Map<string, CanonicalRawAttachment>();
  for (const [sha, { raw, page }] of await queryCanonicalRawPages(shas)) {
    const props = object(object(page).properties), attachments = object(props["ファイル"]).files as unknown[];
    const original = attachments.map(object).filter((file) => file.name === raw.filename || file.name === `${raw.filename}.zip`);
    if (original.length !== 1) throw new Error("⑤canonical原本添付を一意に確定できません");
    const file = original[0]!;
    result.set(sha, { raw, file: { name: file.name as string, url: object(file.file).url as string } });
  }
  return result;
}

export function assertCanonicalRawMetadata(expected: Omit<CanonicalRawFile, "sourceUrl">, fresh: CanonicalRawFile): void {
  const { sourceUrl: _sourceUrl, ...safe } = fresh;
  if ((Object.keys(safe) as Array<keyof typeof safe>).some((key) => safe[key] !== expected[key])) throw new Error("⑤原本metadataがmanifestから変化しました");
}

/**
 * created_time cutoffで集合を固定し、SHA hexで全域を重複なく分割する。
 * Notionのquery 10,000件打切りを正常終了と扱わず、そのpartitionを捨て再分割。
 * 小さいpilotでも全canonical集合の母集団を確認する。署名URLは返さない。
 */
export async function listCanonicalRawFiles(cutoff: string, guard: () => void): Promise<CanonicalRawFile[]> {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(cutoff) || !Number.isFinite(Date.parse(cutoff))) throw new Error("⑤棚卸しcutoffが不正です");
  const dbId = notionEnv.NOTION_DB_RAW_FILES();
  const all = new Map<string, CanonicalRawFile>(), pageIds = new Set<string>();
  async function partition(prefix: string): Promise<void> {
    const rows: CanonicalRawFile[] = [], seenCursors = new Set<string>(), seenShas = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      guard();
      const response: { results: unknown[]; has_more: boolean; next_cursor: string | null } = await notionRequest("POST", `/databases/${dbId}/query`, {
        filter: { and: [{ property: "SHA256", rich_text: { starts_with: prefix } }, { timestamp: "created_time", created_time: { on_or_before: cutoff } }] },
        sorts: [{ property: "SHA256", direction: "ascending" }], page_size: 100,
        ...(cursor === null ? {} : { start_cursor: cursor }),
      });
      for (const value of response.results) {
        const row = parseCanonicalRawFile(value, dbId);
        if (!row.sha256.startsWith(prefix) || seenShas.has(row.sha256)) throw new Error("⑤partitionに未知/重複SHAがあります");
        seenShas.add(row.sha256); rows.push(row);
      }
      if (rows.length >= 10_000) {
        if (prefix.length >= 64) throw new Error("⑤SHA partitionを再分割できません");
        for (const hex of "0123456789abcdef") await partition(prefix + hex);
        return;
      }
      if (!response.has_more) break; // shared clientがfalse/null pairingを検証済み。
      assertCursorProgress(seenCursors, response.next_cursor!);
      cursor = response.next_cursor;
    }
    for (const row of rows) {
      if (all.has(row.sha256) || pageIds.has(row.pageId)) throw new Error("⑤全域棚卸しに重複SHA/pageがあります");
      all.set(row.sha256, row); pageIds.add(row.pageId);
    }
  }
  for (const hex of "0123456789abcdef") await partition(hex);
  if (all.size === 0) throw new Error("⑤canonical集合が空です");
  return [...all.values()].sort((a, b) => a.sha256.localeCompare(b.sha256));
}
