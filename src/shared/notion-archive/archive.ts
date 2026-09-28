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
import { NotionUnknownResultError, notionRequest } from "./client.js";
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
  /**
   * 「一次データ｜<service>」DB を置く親ページ ID。省略時は従来どおり
   * `notionEnv.NOTION_ARCHIVE_PAGE_ID()` (「一次データ保管」ページ)。
   * 既定以外のページ配下に一次データを置きたいサービスが明示的に渡す
   * (`dbCache` のキーは親ページ ID を含めるため、既定と明示指定が同じ
   * service 名でも取り違えない)。
   */
  parentPageId?: string;
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

/**
 * 結果不明 create の回収専用: 完全一致 0=null停止・1=回収・複数=保全停止。
 * 通常探索 (`findBackupChildByTitle` の最古収束) とは意図的に分け、
 * `createDatabaseOrAdopt` の refind にだけ使う。Search 0 件時は保険走査
 * (先頭 500 件の bounded・一意性を保証できない) に戻らず null を返し、
 * 呼出側が元の結果不明エラーを投げて停止する (再送しない。次回の通常
 * 探索で収束する)。エラー文に ID は含めない (通常ログに出るため。
 * title は公開名のため可)。
 */
export async function findUniqueBackupChildByTitle(args: {
  parentPageId: string;
  title: string;
  kind: "page" | "database";
}): Promise<string | null> {
  const hits = await findAllBackupChildrenByTitle(args);
  if (hits.length > 1) {
    throw new Error(
      `Notion DB作成の結果不明回収: 同名が${hits.length}件あり特定できず保全停止 title=${args.title}`
    );
  }
  return hits[0]?.id ?? null;
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

/**
 * プロセス内 DB ID キャッシュ。キーは `"backup:<parentPageId>:<service>"` /
 * `"trash:<parentPageId>:<service>"`。親ページ ID をキーへ含めるのは、既定
 * (「一次データ保管」) と明示指定 (moneyflow 等の別ページ) が同じ service 名を
 * 使っても DB を取り違えないため (2026-09-27 `parentPageId` 対応)。
 */
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

/** 子 DB の完全一致ヒットを全件返す (全ページ走査。回収の多重検出用)。 */
export async function findAllChildDatabases(
  pageId: string,
  title: string
): Promise<string[]> {
  const hits: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
    const res: BlockChildren = await notionRequest<BlockChildren>(
      "GET",
      `/blocks/${pageId}/children${qs}`
    );
    for (const b of res.results) {
      if (b.type === "child_database" && b.child_database?.title === title) {
        hits.push(b.id);
      }
    }
    if (!res.has_more || !res.next_cursor) return hits;
    cursor = res.next_cursor;
  }
}

export async function findChildDatabase(
  pageId: string,
  title: string
): Promise<string | null> {
  const hits = await findAllChildDatabases(pageId, title);
  return hits[0] ?? null;
}

/**
 * 子 DB の結果不明回収専用: 0=null・1=回収・複数=保全停止。
 * `dataset.ts` の銘柄子 DB 等、children 直下の回収に使う。
 */
export async function findUniqueChildDatabaseForAdopt(
  pageId: string,
  title: string
): Promise<string | null> {
  const hits = await findAllChildDatabases(pageId, title);
  if (hits.length > 1) {
    throw new Error(
      `Notion 子DB作成の結果不明回収: 同名が${hits.length}件あり特定できず保全停止 title=${title}`
    );
  }
  return hits[0] ?? null;
}

/**
 * 回収 DB の必須列の存在と型を検証する (cache/return 前)。
 * 不足・型違いは保全停止。既存列の置換 (PATCH) はしない。
 * `moneyflow.ts` の `buildMissingPatch` と同じ型判定流儀。
 */
export function assertAdoptedDatabaseSchema(
  actual: Record<string, { type?: string }>,
  want: Record<string, unknown>,
  context: string
): void {
  for (const [name, wantDef] of Object.entries(want)) {
    const wantType = Object.keys(wantDef as Record<string, unknown>)[0];
    const cur = actual[name];
    if (!cur) {
      throw new Error(`${context}: 必須列「${name}」が無いため保全停止`);
    }
    if (cur.type !== wantType) {
      throw new Error(
        `${context}: 列「${name}」の型が ${cur.type} ですが ${wantType} を期待しています。` +
          `既存列を置換せず保全停止します。`
      );
    }
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

  const res = await createDatabaseOrAdopt<{ id: string }>(
    {
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: dbTitle } }],
      properties: DB_PROPERTIES,
    },
    () => findUniqueBackupChildByTitle({ parentPageId, title: dbTitle, kind: "database" })
  );
  if (res.created) {
    dbCache.set(cacheKey, res.id);
    return res.id;
  }
  // adopted → cache 前に必須列の型を検証 (同名の古い DB かもしれないため)。
  // 型違い・不足は保全停止し、既存列を置換しない。
  const schema = await notionRequest<{ properties: Record<string, { type: string }> }>(
    "GET",
    `/databases/${res.id}`
  );
  assertAdoptedDatabaseSchema(schema.properties, DB_PROPERTIES, `一次データDB「${dbTitle}」の回収`);
  dbCache.set(cacheKey, res.id);
  return res.id;
}

function backupDbTitle(service: string): string {
  return `一次データ｜${service}`;
}
function trashDbTitle(service: string): string {
  return `ごみ｜${service}`;
}

function ensureBackupDb(service: string, parentPageId?: string): Promise<string> {
  const parent = parentPageId ?? notionEnv.NOTION_ARCHIVE_PAGE_ID();
  return ensureDatabase(parent, backupDbTitle(service), `backup:${parent}:${service}`);
}
function ensureTrashDb(service: string, parentPageId?: string): Promise<string> {
  // 「ごみ｜<service>」も一次データ本体と同じ親ページ直下に置く (2026-09-25
  // 再配置でバックアップ/ごみの 2 ページ運用を 1 ページへ統合。命名 prefix
  // で見分けが付くため物理的に分けない判断。`parentPageId` 省略時は既定どおり
  // 「一次データ保管」ページ)。
  const parent = parentPageId ?? notionEnv.NOTION_ARCHIVE_PAGE_ID();
  return ensureDatabase(parent, trashDbTitle(service), `trash:${parent}:${service}`);
}

/**
 * filter 一致が1件の行を返す。0件なら null。2件以上 (または has_more) なら
 * どれかを黙って選ばず throw する (ルール2。Notion に一意制約は無いため、
 * `page_size: 1` + `results[0]` の先頭選択は重複時に行を取り違える)。
 * エラー文に databaseId は含めない (通常の GH ログに出るため private。
 * 公開キー・context のみ。ID は 0600 証跡にだけ残す)。
 */
export async function queryUniqueRow<T extends { id: string }>(
  databaseId: string,
  filter: Record<string, unknown>,
  context: string
): Promise<T | null> {
  const res = await notionRequest<{ results: T[]; has_more?: boolean }>(
    "POST",
    `/databases/${databaseId}/query`,
    { filter, page_size: 2 }
  );
  if (res.results.length > 1 || res.has_more) {
    throw new Error(context);
  }
  return res.results[0] ?? null;
}

/**
 * DB を作成する。結果不明 (`NotionUnknownResultError`) の場合は内部再送せず、
 * `refind` (回収専用の厳密探索: 0=null・1=回収・複数=throw) で確認し、
 * 見つかれば回収 (adopt) して返す。見つからなければ元のエラーをそのまま
 * throw する (自動再 create しない)。refind が複数検出で throw した場合は
 * その保全停止をそのまま伝える。戻り値の `created` が false の採用時は、
 * 呼び出し側が schema 検証へ進むこと (同名の古い DB を拾う可能性があるため)。
 */
export async function createDatabaseOrAdopt<T extends { id: string }>(
  body: Record<string, unknown>,
  refind: () => Promise<string | null>
): Promise<{ id: string; created: boolean; response?: T }> {
  try {
    const created = await notionRequest<T>("POST", "/databases", body);
    return { id: created.id, created: true, response: created };
  } catch (e) {
    if (!(e instanceof NotionUnknownResultError)) throw e;
    const found = await refind();
    if (!found) throw e;
    return { id: found, created: false };
  }
}

/** key 完全一致の既存ページを返す。複数なら保全物を勝手に選ばず停止する。 */
async function findByKey(
  databaseId: string,
  key: string
): Promise<string | null> {
  const row = await queryUniqueRow<{ id: string }>(
    databaseId,
    { property: "Key", title: { equals: key } },
    `Notion archive: 同一 Key の重複 key=${key} を選ばず保全停止`
  );
  return row?.id ?? null;
}

/**
 * 指定 key の一次データが既に Notion に記録済みかを軽量判定する
 * (バイト列を取得せずに済むため、再開可能なバックフィルで再 DL を避ける)。
 *
 * @param parentPageId 省略時は既定どおり `NOTION_ARCHIVE_PAGE_ID()` (「一次データ
 *   保管」ページ)。moneyflow 等、別ページ配下の「一次データ｜<service>」を見る
 *   ときに明示する。
 */
export async function isArchived(
  service: string,
  key: string,
  parentPageId?: string
): Promise<boolean> {
  const dbId = await ensureBackupDb(service, parentPageId);
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
  const dbId = await ensureBackupDb(input.service, input.parentPageId);

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
 * archived」で実現する。POST成功後のPATCH失敗は同じ退避先を再利用して完了する。
 * 元ページ・退避先の対応を確認できなければ throw (黙って継続しない)。
 */
export async function moveToTrash(args: {
  service: string;
  /** 退避対象の元 (バックアップ側) ページ ID */
  originPageId: string;
  /** 不要化の理由 (運用者が後から追える説明) */
  reason: string;
  /**
   * 「ごみ｜<service>」DB を置く親ページ ID。省略時は既定どおり
   * `NOTION_ARCHIVE_PAGE_ID()`。`originPageId` の一次データを記録した際に
   * 使った `parentPageId` と同じ値を渡すこと (別ページの「ごみ」に迷子で
   * 退避されるのを防ぐ)。
   */
  parentPageId?: string;
}): Promise<{ trashPageId: string }> {
  const origin = await notionRequest<{
    id: string;
    url: string;
    archived?: unknown;
    in_trash?: unknown;
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
  const fileEntries = (props.Files as { files?: NotionFileEntry[] } | undefined)?.files;
  const normalizeId = (id: string): string => id.replace(/-/g, "").toLowerCase();
  const readTrashState = (page: { archived?: unknown; in_trash?: unknown }): boolean => {
    if ((Object.hasOwn(page, "archived") && typeof page.archived !== "boolean") ||
      (Object.hasOwn(page, "in_trash") && typeof page.in_trash !== "boolean") ||
      (typeof page.archived !== "boolean" && typeof page.in_trash !== "boolean")) {
      throw new Error("moveToTrash: trash状態が未確認のため保全停止");
    }
    return page.archived === true || page.in_trash === true;
  };
  if (typeof origin.id !== "string" || normalizeId(origin.id) !== normalizeId(args.originPageId) ||
    (props.Service as { select?: { name?: string } } | undefined)?.select?.name !== args.service || !origin.url ||
    !Array.isArray(fileEntries)) {
    throw new Error("moveToTrash: 元ページのID・Service・URL・Filesが不一致のため保全停止");
  }
  const originTrashed = readTrashState(origin);

  // 元ページの物理ファイルを取得し直し、ごみ側へ再アップロードして実体保持
  const trashDb = await ensureTrashDb(args.service, args.parentPageId);
  const existing = await findByKey(trashDb, key);
  if (originTrashed && !existing) {
    throw new Error("moveToTrash: 元はtrashですが退避先が見つからないため保全停止");
  }

  const readFile = async (fe: NotionFileEntry): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> => {
    const url = fe.file?.url ?? fe.external?.url;
    if (!url) throw new Error(`moveToTrash: 物理ファイルURL欠損のため保全停止 name=${fe.name}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`moveToTrash: 物理ファイル取得失敗 name=${fe.name} status=${res.status}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  };
  // 全ファイルのbytesを保持せず1件ずつ取得し、小さいSHAだけを保持する。
  const fileHashes = async (files: NotionFileEntry[]): Promise<ArrayBuffer[]> => {
    const hashes: ArrayBuffer[] = [];
    for (const file of files) {
      const { bytes } = await readFile(file);
      hashes.push(await crypto.subtle.digest("SHA-256", bytes));
    }
    return hashes;
  };
  const verifyBytes = async (files: NotionFileEntry[], expected: ArrayBuffer[]): Promise<void> => {
    const actual = await fileHashes(files);
    if (actual.length !== expected.length || actual.some((hash, i) => {
      const known = new Uint8Array(expected[i]);
      return new Uint8Array(hash).some((byte, j) => byte !== known[j]);
    })) {
      throw new Error("moveToTrash: 退避先の物理ファイルSHA不一致のため元原本を保持して保全停止");
    }
  };
  // 再読した退避先のownershipと実体を確認してから元ページをtrashする。
  const verifyTrash = async (pageId: string): Promise<NotionFileEntry[]> => {
    const trash = await notionRequest<typeof origin>("GET", `/pages/${pageId}`);
    const tp = trash.properties as typeof props;
    const files = (tp.Files as { files?: NotionFileEntry[] } | undefined)?.files;
    if (typeof trash.id !== "string" || normalizeId(trash.id) !== normalizeId(pageId) || readTrashState(trash) ||
      readTitle(tp.Key as never) !== key ||
      (tp.Service as { select?: { name?: string } } | undefined)?.select?.name !== args.service ||
      (tp["Origin Page"] as { url?: string } | undefined)?.url !== origin.url ||
      (tp.Status as { select?: { name?: string } } | undefined)?.select?.name !== "obsoleted" ||
      readRich(tp.Source as never) !== source || readRich(tp.Metadata as never) !== metadata ||
      !files || files.length !== fileEntries.length ||
      files.some((f, i) => f.name !== fileEntries[i].name || f.type !== "file" || !f.file?.url)) {
      throw new Error("moveToTrash: 退避先の所有元・原本材料・添付が不一致のため保全停止");
    }
    return files;
  };
  const finishOrigin = async (): Promise<void> => {
    if (originTrashed) return;
    // source client の固定API版は2022-06-28。現行app版のin_trash要求とは異なる。
    await notionRequest("PATCH", `/pages/${args.originPageId}`, { archived: true });
    const retired = await notionRequest<typeof origin>("GET", `/pages/${args.originPageId}`);
    if (typeof retired.id !== "string" || normalizeId(retired.id) !== normalizeId(args.originPageId) || !readTrashState(retired)) {
      throw new Error("moveToTrash: 元ページのtrash完了を再読確認できず保全停止");
    }
  };
  if (existing) {
    const files = await verifyTrash(existing);
    if (!originTrashed) await verifyBytes(files, await fileHashes(fileEntries));
    // 既にtrashの元は再退避しない。元ファイルの再DL不能を考慮し、既知原本SHAは呼出元で再検証する。
    await finishOrigin();
    return { trashPageId: existing };
  }

  const fileRefs: Array<{ name: string; type: "file_upload"; file_upload: { id: string } }> = [];
  const expectedHashes: ArrayBuffer[] = [];
  for (const fe of fileEntries) {
    const { bytes, contentType } = await readFile(fe);
    expectedHashes.push(await crypto.subtle.digest("SHA-256", bytes));
    const id = await uploadFile({
      bytes,
      filename: fe.name,
      contentType,
    });
    fileRefs.push({ name: fe.name, type: "file_upload", file_upload: { id } });
  }

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

  await verifyBytes(await verifyTrash(created.id), expectedHashes);
  await finishOrigin();

  return { trashPageId: created.id };
}
