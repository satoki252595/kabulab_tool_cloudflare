/**
 * 「一次データ｜moneyflow」に実体保管済みのファイルを取り直すヘルパ。
 *
 * 取込済みの月次/週次資料を毎回取得元へ取りに行かないため、保管済みファイル
 * (Notion の files プロパティ) から再解析する経路で使う (docs/moneyflow.md
 * 「取込の流れ」)。Notion の file.url は約 1 時間で失効する署名付き URL なので、
 * 取得したらすぐダウンロードする。
 */
import { listPageFiles, notionEnv } from "../../../src/shared/notion-archive/index.js";
import { notionRequest } from "../../../src/shared/notion-archive/client.js";
import { findBackupChildByTitle, queryUniqueRow } from "../../../src/shared/notion-archive/archive.js";
import { MONEYFLOW_PRIMARY_DB_TITLE } from "../../../src/shared/notion-archive/moneyflow.js";
import { sha256HexBytes } from "../../../src/shared/sha256.js";
import type { SpecFile } from "../../../services/moneyflow/lib/source-spec.js";

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

/**
 * 保管直後の付帯検証: 「一次データ｜moneyflow」ページの Files 添付が、
 * 取得バイト列と完全一致すること (件数・名前・バイト長・SHA256) を
 * 観測ログの書込前に確認する。不一致・外部添付・欠落は保全停止する
 * (観測ログを書かない。保管ページ自体の修正はしない — 手動確認用に残す)。
 */
export async function verifyArchivedAttachments(
  primaryDataPageId: string,
  context: string,
  key: string,
  expected: readonly SpecFile[]
): Promise<void> {
  const fail = (why: string): never => {
    throw new Error(`${context}: 保管検証に失敗 key=${key} (${why}) のため観測ログを書きません`);
  };
  const hosted = await listPageFiles(primaryDataPageId, "Files");
  if (hosted.length !== expected.length) {
    fail(`添付 ${hosted.length} 件 ≠ 取得 ${expected.length} 件`);
  }
  for (let i = 0; i < expected.length; i += 1) {
    const want = expected[i];
    const got = hosted[i];
    if (got.name !== want.filename) fail(`添付名不一致「${got.name}」≠「${want.filename}」`);
    if (got.kind !== "file") fail(`「${want.filename}」が Notion-hosted 添付ではありません`);
    const bytes = await downloadArchivedFile(got, context);
    if (bytes.length !== want.bytes.length) {
      fail(`「${want.filename}」のバイト長 ${bytes.length} ≠ ${want.bytes.length}`);
    }
    const [gotSha, wantSha] = await Promise.all([
      sha256HexBytes(Uint8Array.from(bytes)),
      sha256HexBytes(Uint8Array.from(want.bytes)),
    ]);
    if (gotSha !== wantSha) fail(`「${want.filename}」の SHA256 不一致`);
  }
}
