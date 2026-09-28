/**
 * 「一次データ｜moneyflow」に実体保管済みのファイルを取り直すヘルパ。
 *
 * 取込済みの月次/週次資料を毎回取得元へ取りに行かないため、保管済みファイル
 * (Notion の files プロパティ) から再解析する経路で使う (docs/moneyflow.md
 * 「取込の流れ」)。Notion の file.url は約 1 時間で失効する署名付き URL なので、
 * 取得したらすぐダウンロードする。
 */
import { notionEnv } from "../../../src/shared/notion-archive/index.js";
import { notionRequest } from "../../../src/shared/notion-archive/client.js";
import { findBackupChildByTitle, queryUniqueRow } from "../../../src/shared/notion-archive/archive.js";
import { MONEYFLOW_PRIMARY_DB_TITLE } from "../../../src/shared/notion-archive/moneyflow.js";

/**
 * 「一次データ保管」配下の「一次データ｜moneyflow」DB の ID を取得する (無ければ throw。
 * recordPrimaryData を先に呼んでいることが前提 — 推測で relation 先を作らない、ルール2)。
 */
export async function requirePrimaryDataDbId(context: string): Promise<string> {
  const primaryDbId = await findBackupChildByTitle({
    parentPageId: notionEnv.NOTION_ARCHIVE_PAGE_ID(),
    title: MONEYFLOW_PRIMARY_DB_TITLE,
    kind: "database",
  });
  if (!primaryDbId) {
    throw new Error(`${context}: 「${MONEYFLOW_PRIMARY_DB_TITLE}」DB が見つかりません (recordPrimaryData 直後のはず)`);
  }
  return primaryDbId;
}

export interface ArchivedFileLink {
  name: string;
  url: string;
}

export interface ArchivedRecord {
  pageId: string;
  key: string;
  files: ArchivedFileLink[];
}

interface PrimaryRowResponse {
  results: Array<{
    id: string;
    properties: {
      Key?: { title?: Array<{ plain_text?: string }> };
      Files?: { files?: Array<{ name: string; file?: { url: string }; external?: { url: string } }> };
    };
  }>;
  has_more: boolean;
  next_cursor: string | null;
}

function toArchivedRecord(r: PrimaryRowResponse["results"][number]): ArchivedRecord {
  const key = (r.properties.Key?.title ?? []).map((t) => t.plain_text ?? "").join("");
  const files = (r.properties.Files?.files ?? []).map((f) => {
    const url = f.file?.url ?? f.external?.url;
    if (!url) {
      throw new Error(`一次データ page ${r.id} (key=${key}) のファイル「${f.name}」に URL がありません`);
    }
    return { name: f.name, url };
  });
  return { pageId: r.id, key, files };
}

/** key 完全一致の保管済みレコードを 1 件探す (無ければ null)。 */
export async function findArchivedRecordByKey(primaryDbId: string, key: string): Promise<ArchivedRecord | null> {
  const r = await queryUniqueRow<PrimaryRowResponse["results"][number]>(
    primaryDbId,
    { property: "Key", title: { equals: key } },
    `一次データの保管済みレコードの重複 key=${key} を選ばず保全停止`
  );
  return r ? toArchivedRecord(r) : null;
}

/** key が prefix で始まる保管済みレコードを全件列挙する (key 昇順)。 */
export async function listArchivedRecordsByPrefix(primaryDbId: string, prefix: string): Promise<ArchivedRecord[]> {
  const out: ArchivedRecord[] = [];
  let cursor: string | null = null;
  for (;;) {
    const body: Record<string, unknown> = {
      filter: { property: "Key", title: { starts_with: prefix } },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const res: PrimaryRowResponse = await notionRequest<PrimaryRowResponse>(
      "POST",
      `/databases/${primaryDbId}/query`,
      body
    );
    for (const r of res.results) out.push(toArchivedRecord(r));
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/** 保管済みファイル 1 件をダウンロードする (取得元ではなく Notion から)。 */
export async function downloadArchivedFile(file: ArchivedFileLink, context: string): Promise<Uint8Array> {
  const res = await fetch(file.url);
  if (!res.ok) {
    throw new Error(`${context}: 保管済みファイル ${file.name} の再取得に失敗 status=${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}
