/**
 * 一次データ Notion アーカイブの高レベル API (CLAUDE.md ルール6)。
 *
 *   recordPrimaryData() : API/ファイル取得時にメタデータ + 物理ファイルを
 *                         「一次データ保管」配下のサービス別 DB に冪等記録
 *   moveToTrash()       : input 変更等で不要化した元データを同ページ直下の
 *                         「ごみ｜<service>」DB へ物理ファイルごと退避し、
 *                         元レコードは Notion ゴミ箱へ
 *
 * (2026-09-25 再配置: 旧「バックアップ」ページは per-stock 子ページ+子DB が
 * 数千件累積して開けなくなり trash 事件が起きた教訓から、「一次データ保管」
 * ページ 1 つに統合。`NOTION_ARCHIVE_PAGE_ID` が正のソース)。
 *
 * 設計 (CLAUDE.md):
 *   - 冪等: 同一 key の再記録はスキップ (5 年バックフィルが再開可能)。
 *   - フォールバック禁止: 失敗は throw。Notion 上限超過のみ「アップロード不可」
 *     という正直なステータスを記録 (捏造値ではなく事実 / 運用者可視)。
 *   - メタデータ全文はページ本文の code block に必ず原文保存し欠落させない。
 */
import { notionRequest } from "./client.js";
import { notionEnv } from "./env.js";
import { NotionFileTooLargeError, uploadFile } from "./file-upload.js";

/** Notion rich_text 1 オブジェクトの上限 */
const RICH_TEXT_MAX = 2000;

export interface PrimaryFile {
  bytes: Uint8Array;
  filename: string;
  contentType: string;
}

export interface RecordPrimaryDataInput {
  /** サービス識別子 (例: "yuho-quant") */
  service: string;
  /** 冪等キー (例: EDINET docId)。同一 key の再記録はスキップ */
  key: string;
  /** 取得元 (例: "EDINET API v2 /documents/{docId}") */
  source: string;
  /** 取得時刻。省略時は現在 (ISO 8601) */
  fetchedAt?: string;
  /** 任意メタデータ。全文はページ本文に原文保存される */
  metadata: Record<string, unknown>;
  /** 物理ファイル (取得した実体)。0 件可 (純 JSON 取得時など) */
  files?: PrimaryFile[];
  /** true なら既存 key でも上書き再アップロード (既定 false = 冪等スキップ) */
  force?: boolean;
}

export interface RecordResult {
  pageId: string;
  outcome: "recorded" | "skipped_existing";
  /** 一部/全部のファイルが Notion 上限超過でアップロードできなかった場合 true */
  fileTooLarge: boolean;
}

interface BlockChildren {
  results: Array<{
    id: string;
    type: string;
    child_database?: { title: string };
    child_page?: { title?: string };
  }>;
  has_more: boolean;
  next_cursor: string | null;
}

/** /search 応答のうち使う部分だけの形状 */
interface SearchResponse {
  results: Array<{
    id: string;
    archived?: boolean;
    in_trash?: boolean;
    created_time?: string;
    parent?: { type?: string; page_id?: string };
    properties?: {
      title?: {
        type?: string;
        title?: Array<{ plain_text?: string }>;
      };
    };
    /** database オブジェクトはトップレベルに title を持つ */
    title?: string | Array<{ plain_text?: string }>;
  }>;
  has_more: boolean;
  next_cursor: string | null;
}

export interface BackupChildHit {
  id: string;
  createdTime: string;
}

/** 完全一致ヒットから最古 (正本) を選ぶ。純粋関数。 */
export function selectOldestPageId(
  hits: ReadonlyArray<BackupChildHit>
): string | null {
  let best: BackupChildHit | null = null;
  for (const h of hits) {
    if (!best || h.createdTime < best.createdTime) best = h;
  }
  return best?.id ?? null;
}

function searchResultTitle(
  r: SearchResponse["results"][number],
  kind: "page" | "database"
): string {
  if (kind === "page") {
    const t = r.properties?.title;
    if (t?.type !== "title" || !Array.isArray(t.title)) return "";
    return t.title.map((x) => x.plain_text ?? "").join("");
  }
  if (typeof r.title === "string") return r.title;
  if (!Array.isArray(r.title)) return "";
  return r.title.map((x) => x.plain_text ?? "").join("");
}

/**
 * BACKUP/TRASH 直下の子ページ・子 DB を Search API で完全一致検索し、
 * 全ヒットを返す (重複整理など「最古以外も要る」用途向け)。
 *
 * フィルタ条件は findBackupChildByTitle と同一 (非アーカイブ・親一致・
 * タイトル完全一致)。Search index 遅延への保険走査は含まない
 * (保険走査は「1 件発見」用で全件列挙を保証しないため)。
 */
export async function findAllBackupChildrenByTitle(args: {
  parentPageId: string;
  title: string;
  kind: "page" | "database";
}): Promise<BackupChildHit[]> {
  const { parentPageId, title, kind } = args;
  const wantParent = parentPageId.replace(/-/g, "");
  const hits: BackupChildHit[] = [];
  let cursor: string | null = null;
  for (;;) {
    const body: Record<string, unknown> = {
      query: title,
      filter: { property: "object", value: kind },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const res: SearchResponse = await notionRequest<SearchResponse>(
      "POST",
      "/search",
      body
    );
    for (const r of res.results) {
      if (r.archived === true || r.in_trash === true) continue;
      if (r.parent?.type !== "page_id") continue;
      if ((r.parent.page_id ?? "").replace(/-/g, "") !== wantParent) continue;
      if (searchResultTitle(r, kind) !== title) continue;
      hits.push({ id: r.id, createdTime: r.created_time ?? "\uffff" });
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return hits;
}

/**
 * BACKUP/TRASH 直下の子ページ・子 DB を Search API で完全一致検索する。
 *
 * 経緯 (P6 重複事件 2026-09-24): block children のページ送りは約1万件で
 * 打ち切られる実測があり、全走査では見落とした銘柄親を重複作成した
 * (2086 タイトル以上が重複)。Search は件数制限を受けないため正本発見に使う。
 * 複数ヒット時は最古 (最初に作られた正本) を返し、以後はそこへ収束させる。
 * Search index 遅延 (作成直後を見落とす) への保険として、未ヒット時は
 * children の先頭 500 件だけ走査してから諦める。並列プロセスの同時作成
 * レース自体は防げない (現行の並列度では無視可能。監査で検出する)。
 */
export async function findBackupChildByTitle(args: {
  parentPageId: string;
  title: string;
  kind: "page" | "database";
}): Promise<string | null> {
  const oldest = selectOldestPageId(await findAllBackupChildrenByTitle(args));
  if (oldest) return oldest;
  return scanFirstChildrenForTitle(args.parentPageId, args.title, args.kind);
}

/** children 先頭の bounded 走査 (Search index 遅延の保険) */
async function scanFirstChildrenForTitle(
  parentPageId: string,
  title: string,
  kind: "page" | "database",
  maxPages = 5
): Promise<string | null> {
  let cursor: string | null = null;
  for (let p = 0; p < maxPages; p++) {
    const qs: string =
      cursor !== null
        ? `?start_cursor=${cursor}&page_size=100`
        : "?page_size=100";
    const res: BlockChildren = await notionRequest<BlockChildren>(
      "GET",
      `/blocks/${parentPageId}/children${qs}`
    );
    for (const b of res.results) {
      if (
        kind === "database" &&
        b.type === "child_database" &&
        b.child_database?.title === title
      ) {
        return b.id;
      }
      if (
        kind === "page" &&
        b.type === "child_page" &&
        b.child_page?.title === title
      ) {
        return b.id;
      }
    }
    if (!res.has_more || !res.next_cursor) return null;
    cursor = res.next_cursor;
  }
  return null;
}

/** プロセス内 DB ID キャッシュ ("backup:service" / "trash:service") */
const dbCache = new Map<string, string>();

// Status は運用者の最重要シグナル。色を固定し、要手当ての file_too_large を
// 常に赤で目立たせる (Notion 自動採番だと色が毎回変わり視認性が落ちる)。
const STATUS_OPTIONS = [
  { name: "recorded", color: "green" },
  { name: "recorded_partial_file", color: "orange" },
  { name: "file_too_large", color: "red" },
  { name: "obsoleted", color: "gray" },
] as const;

const DB_PROPERTIES = {
  Key: { title: {} },
  Service: { select: {} },
  Source: { rich_text: {} },
  "Fetched At": { date: {} },
  Status: { select: { options: STATUS_OPTIONS } },
  Metadata: { rich_text: {} },
  Files: { files: {} },
  "Obsoleted At": { date: {} },
  "Obsoleted Reason": { rich_text: {} },
  "Origin Page": { url: {} },
} as const;

export async function findChildDatabase(
  pageId: string,
  title: string
): Promise<string | null> {
  let cursor: string | null = null;
  for (;;) {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const res: BlockChildren = await notionRequest<BlockChildren>(
      "GET",
      `/blocks/${pageId}/children${qs}`
    );
    for (const b of res.results) {
      if (b.type === "child_database" && b.child_database?.title === title) {
        return b.id;
      }
    }
    if (!res.has_more || !res.next_cursor) return null;
    cursor = res.next_cursor;
  }
}

/** 親ページ配下にサービス別 DB を確保 (無ければ作成)。Search 完全一致で
 *  発見する (block children 全走査は約1万件で打ち切られる実測があるため)。
 *  Search index 遅延への保険は findBackupChildByTitle 内の bounded 走査。 */
async function ensureDatabase(
  parentPageId: string,
  dbTitle: string,
  cacheKey: string
): Promise<string> {
  const cached = dbCache.get(cacheKey);
  if (cached) return cached;

  const existing = await findBackupChildByTitle({
    parentPageId,
    title: dbTitle,
    kind: "database",
  });
  if (existing) {
    dbCache.set(cacheKey, existing);
    return existing;
  }

  const created = await notionRequest<{ id: string }>("POST", "/databases", {
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: dbTitle } }],
    properties: DB_PROPERTIES,
  });
  dbCache.set(cacheKey, created.id);
  return created.id;
}

function backupDbTitle(service: string): string {
  return `一次データ｜${service}`;
}
function trashDbTitle(service: string): string {
  return `ごみ｜${service}`;
}

function ensureBackupDb(service: string): Promise<string> {
  return ensureDatabase(
    notionEnv.NOTION_ARCHIVE_PAGE_ID(),
    backupDbTitle(service),
    `backup:${service}`
  );
}
function ensureTrashDb(service: string): Promise<string> {
  // 「ごみ｜<service>」も「一次データ保管」ページ直下に置く (2026-09-25
  // 再配置でバックアップ/ごみの 2 ページ運用を 1 ページへ統合。命名 prefix
  // で見分けが付くため物理的に分けない判断)。
  return ensureDatabase(
    notionEnv.NOTION_ARCHIVE_PAGE_ID(),
    trashDbTitle(service),
    `trash:${service}`
  );
}

/** key 完全一致の既存ページを 1 件返す (冪等判定用) */
async function findByKey(
  databaseId: string,
  key: string
): Promise<string | null> {
  const res = await notionRequest<{ results: Array<{ id: string }> }>(
    "POST",
    `/databases/${databaseId}/query`,
    { filter: { property: "Key", title: { equals: key } }, page_size: 1 }
  );
  return res.results[0]?.id ?? null;
}

/**
 * 指定 key の一次データが既に Notion に記録済みかを軽量判定する
 * (バイト列を取得せずに済むため、再開可能なバックフィルで再 DL を避ける)。
 */
export async function isArchived(
  service: string,
  key: string
): Promise<boolean> {
  const dbId = await ensureBackupDb(service);
  return (await findByKey(dbId, key)) !== null;
}

/** 文字列を rich_text 上限で分割 (欠落させない) */
function splitRichText(s: string): Array<{ text: { content: string } }> {
  const out: Array<{ text: { content: string } }> = [];
  for (let i = 0; i < s.length; i += RICH_TEXT_MAX) {
    out.push({ text: { content: s.slice(i, i + RICH_TEXT_MAX) } });
  }
  return out.length ? out : [{ text: { content: "" } }];
}

/** メタデータ全文を本文 code block 群に分割 (1 block 内 rich_text ≤2000) */
function metadataBodyBlocks(json: string): unknown[] {
  const blocks: unknown[] = [];
  for (let i = 0; i < json.length; i += RICH_TEXT_MAX) {
    blocks.push({
      object: "block",
      type: "code",
      code: {
        language: "json",
        rich_text: [
          { type: "text", text: { content: json.slice(i, i + RICH_TEXT_MAX) } },
        ],
      },
    });
  }
  return blocks;
}

/**
 * 一次データ 1 件を Notion に冪等記録する。
 * ファイルは物理アップロードして Files プロパティへ添付。
 */
export async function recordPrimaryData(
  input: RecordPrimaryDataInput
): Promise<RecordResult> {
  const dbId = await ensureBackupDb(input.service);

  if (!input.force) {
    const existing = await findByKey(dbId, input.key);
    if (existing) {
      return { pageId: existing, outcome: "skipped_existing", fileTooLarge: false };
    }
  }

  // 物理ファイルを実体アップロード。上限超過は捏造せず事実を記録 (ルール2)。
  // 注: ファイル群アップロード成功後に /pages 作成が失敗した場合、その
  // file_upload は未添付のまま残るが、Notion は未添付 file_upload を約 1
  // 時間で自動失効・破棄するため恒久的なストレージリークにはならない。
  // 再実行時は findByKey がページ未作成のため再アップロードする (冪等)。
  const fileRefs: Array<{ name: string; type: "file_upload"; file_upload: { id: string } }> = [];
  const tooLarge: string[] = [];
  for (const f of input.files ?? []) {
    try {
      const id = await uploadFile(f);
      fileRefs.push({ name: f.filename, type: "file_upload", file_upload: { id } });
    } catch (e) {
      if (e instanceof NotionFileTooLargeError) {
        tooLarge.push(`${f.filename} (${f.bytes.length}B > WS上限)`);
        continue;
      }
      throw e;
    }
  }

  const fetchedAt = input.fetchedAt ?? new Date().toISOString();
  const metaJson = JSON.stringify(
    { ...input.metadata, ...(tooLarge.length ? { _fileTooLarge: tooLarge } : {}) },
    null,
    0
  );
  const status = tooLarge.length
    ? input.files && tooLarge.length === input.files.length
      ? "file_too_large"
      : "recorded_partial_file"
    : "recorded";

  const created = await notionRequest<{ id: string }>("POST", "/pages", {
    parent: { database_id: dbId },
    properties: {
      Key: { title: [{ text: { content: input.key } }] },
      Service: { select: { name: input.service } },
      Source: { rich_text: splitRichText(input.source) },
      "Fetched At": { date: { start: fetchedAt } },
      Status: { select: { name: status } },
      Metadata: { rich_text: splitRichText(metaJson) },
      Files: { files: fileRefs },
    },
    children: metadataBodyBlocks(metaJson),
  });

  return {
    pageId: created.id,
    outcome: "recorded",
    fileTooLarge: tooLarge.length > 0,
  };
}

interface NotionFileEntry {
  name: string;
  type: string;
  file?: { url: string };
  external?: { url: string };
}

/**
 * input 変更等で不要化した元データを「ごみ」配下へ物理ファイルごと退避し、
 * 元レコードを Notion ゴミ箱へ送る (archived:true)。
 *
 * Notion は DB 間のページ移動を直接サポートしないため「ごみ DB に複製
 * (物理ファイルは元ページから取得し再アップロードして実体保持) → 元ページを
 * archived」で実現する。元ページが見つからなければ throw (黙って継続しない)。
 */
export async function moveToTrash(args: {
  service: string;
  /** 退避対象の元 (バックアップ側) ページ ID */
  originPageId: string;
  /** 不要化の理由 (運用者が後から追える説明) */
  reason: string;
}): Promise<{ trashPageId: string }> {
  const origin = await notionRequest<{
    id: string;
    url: string;
    properties: Record<string, unknown>;
  }>("GET", `/pages/${args.originPageId}`);

  const props = origin.properties as Record<string, { type: string } & Record<string, unknown>>;
  const readTitle = (p?: { title?: Array<{ plain_text: string }> }): string =>
    (p?.title ?? []).map((t) => t.plain_text).join("");
  const readRich = (p?: { rich_text?: Array<{ plain_text: string }> }): string =>
    (p?.rich_text ?? []).map((t) => t.plain_text).join("");

  const key = readTitle(props.Key as never) || origin.id;
  const source = readRich(props.Source as never);
  const metadata = readRich(props.Metadata as never);

  // 元ページの物理ファイルを取得し直し、ごみ側へ再アップロードして実体保持
  const fileEntries =
    ((props.Files as { files?: NotionFileEntry[] } | undefined)?.files) ?? [];
  const fileRefs: Array<{ name: string; type: "file_upload"; file_upload: { id: string } }> = [];
  for (const fe of fileEntries) {
    const url = fe.file?.url ?? fe.external?.url;
    if (!url) {
      throw new Error(
        `moveToTrash: ファイル URL を取得できません name=${fe.name} (原本欠損 — 黙って継続しない)`
      );
    }
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `moveToTrash: 元ファイル取得失敗 ${fe.name} status=${res.status}`
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const id = await uploadFile({
      bytes,
      filename: fe.name,
      contentType:
        res.headers.get("content-type") ?? "application/octet-stream",
    });
    fileRefs.push({ name: fe.name, type: "file_upload", file_upload: { id } });
  }

  const trashDb = await ensureTrashDb(args.service);
  const created = await notionRequest<{ id: string }>("POST", "/pages", {
    parent: { database_id: trashDb },
    properties: {
      Key: { title: [{ text: { content: key } }] },
      Service: { select: { name: args.service } },
      Source: { rich_text: splitRichText(source) },
      Metadata: { rich_text: splitRichText(metadata) },
      "Obsoleted At": { date: { start: new Date().toISOString() } },
      "Obsoleted Reason": { rich_text: splitRichText(args.reason) },
      "Origin Page": { url: origin.url },
      Files: { files: fileRefs },
      Status: { select: { name: "obsoleted" } },
    },
  });

  // 元ページを Notion ゴミ箱へ (DB から除去・物理ファイルは複製済)
  await notionRequest("PATCH", `/pages/${args.originPageId}`, {
    archived: true,
  });

  return { trashPageId: created.id };
}
