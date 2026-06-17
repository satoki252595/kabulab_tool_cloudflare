/**
 * Notion ページの files プロパティから「現在の signed URL」を 1 件取得する
 * 薄いヘルパ (CLAUDE.md ルール6: Notion 通信窓口を notion-archive に一元化)。
 *
 * Notion の `file.url` は S3 pre-signed で **~1 時間で失効** するが、`GET
 * /pages/{id}` を呼ぶ度に新規発行される。なので呼び出し側 (UI のファイル
 * プロキシ等) はクリックの度にこの関数で最新 URL を取得して 302 リダイレクト
 * すれば永続的にアクセス可能になる (Notion 側で削除しない限り)。
 */
import { notionRequest } from "./client.js";

export interface PageFileRef {
  /** ファイル名 (例: 7203_2026-05-08_1244599.pdf) */
  name: string;
  /** 現在の signed URL (~1h 有効。即 302 する用) */
  url: string;
}

interface PagePropertiesResponse {
  properties: Record<
    string,
    {
      type: string;
      files?: Array<{
        name: string;
        type: "file" | "external" | string;
        file?: { url: string; expiry_time?: string };
        external?: { url: string };
      }>;
    }
  >;
}

/**
 * 指定ページの指定 files プロパティから最初のファイルを取得する。
 * 該当ファイルが無い (未添付/別状態) なら null を返す (捏造しない・ルール1)。
 */
export async function fetchPageFileUrl(
  pageId: string,
  propertyName: string
): Promise<PageFileRef | null> {
  const page = await notionRequest<PagePropertiesResponse>(
    "GET",
    `/pages/${pageId}`
  );
  const prop = page.properties?.[propertyName];
  if (!prop || prop.type !== "files") return null;
  const files = prop.files ?? [];
  if (files.length === 0) return null;
  const f = files[0];
  const url = f.file?.url ?? f.external?.url;
  if (!url) return null;
  return { name: f.name, url };
}
