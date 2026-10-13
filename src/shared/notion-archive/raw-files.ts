/** ⑤の既存原本をSHA限定で読む。添付URLを外へ返さず、アップロードは行わない。 */
import { notionRequest } from "./client.js";
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
export async function findCanonicalRawFiles(shas: readonly string[]): Promise<Map<string, CanonicalRawFile>> {
  if (shas.length === 0 || shas.length > 50 || new Set(shas).size !== shas.length || shas.some((sha) => !/^[a-f0-9]{64}$/.test(sha))) throw new Error("⑤原本SHA照合は一意な1〜50件だけです");
  const dbId = notionEnv.NOTION_DB_RAW_FILES();
  const response = await notionRequest<{ results: unknown[]; has_more: boolean }>("POST", `/databases/${dbId}/query`, {
    filter: { or: shas.map((sha) => ({ property: "SHA256", rich_text: { equals: sha } })) }, page_size: 100,
  });
  if (response.has_more || response.results.length >= 100) throw new Error("⑤原本SHA照合が打ち切られました");
  const result = new Map<string, CanonicalRawFile>();
  for (const value of response.results) {
    const raw = parseCanonicalRawFile(value, dbId);
    if (!shas.includes(raw.sha256) || result.has(raw.sha256)) throw new Error("⑤原本SHA照合に未知/重複行があります");
    result.set(raw.sha256, raw);
  }
  return result;
}
