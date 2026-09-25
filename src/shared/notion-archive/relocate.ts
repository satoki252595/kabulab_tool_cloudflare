/**
 * 一次データ Notion アーカイブの再配置 (2026-09-25) 専用ヘルパー。
 *
 * 背景: 旧「バックアップ」ページは銘柄コード毎の子ページ+子DB
 * (「有報テキスト」) が数千件累積して Notion 上で開けなくなり、ユーザが
 * 当該ページをトラッシュする事態になった。再配置後は「一次データ保管」
 * ページ 1 つに、一次データ本体 DB・銘柄別 DB・ごみ DB を集約する
 * (`NOTION_ARCHIVE_PAGE_ID`)。
 *
 * ここに置く関数群は `scripts/notion/relocate-archive.ts` (一度きりの
 * 移行スクリプト) 専用。通常のサービスコードはここを使わない。ルール6
 * (api.notion.com を notion-archive/ 外から直叩きしない) を移行スクリプト
 * からも守るための窓口として `client.ts` の `notionRequest`/`movePage`/
 * `moveDatabase` をラップして再輸出する。
 */
import { movePage, moveDatabase, notionRequest } from "./client.js";
import type { MovePageParent } from "./client.js";

export { movePage, moveDatabase };
export type { MovePageParent };

interface SearchDbResult {
  id: string;
  parent?: { type?: string; page_id?: string };
  title?: Array<{ plain_text?: string }>;
  archived?: boolean;
  in_trash?: boolean;
}
interface SearchResponse {
  results: SearchDbResult[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface FoundDatabase {
  id: string;
  title: string;
}

/**
 * 指定親ページ直下の database を、タイトル前方一致で列挙する
 * (`一次データ｜`/`銘柄一覧｜`/`ごみ｜` 等の prefix を持つサービス別 DB を
 * 探す用)。Search は全 workspace 対象のため、親ページ ID の一致で厳密に
 * 絞る (誤って他ページ配下の同名 DB を拾わない)。
 */
export async function findDatabasesByTitlePrefix(
  parentPageId: string,
  prefix: string
): Promise<FoundDatabase[]> {
  const wantParent = parentPageId.replace(/-/g, "");
  const hits: FoundDatabase[] = [];
  let cursor: string | null = null;
  for (;;) {
    const body: Record<string, unknown> = {
      query: prefix,
      filter: { property: "object", value: "database" },
      page_size: 100,
    };
    if (cursor) body.start_cursor = cursor;
    const res = await notionRequest<SearchResponse>("POST", "/search", body);
    for (const r of res.results) {
      if (r.archived === true || r.in_trash === true) continue;
      if (r.parent?.type !== "page_id") continue;
      if ((r.parent.page_id ?? "").replace(/-/g, "") !== wantParent) continue;
      const title = (r.title ?? []).map((t) => t.plain_text ?? "").join("");
      if (!title.startsWith(prefix)) continue;
      hits.push({ id: r.id, title });
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return hits;
}

interface DbParentResponse {
  parent?: { type?: string; page_id?: string };
}

/** GET /databases/{id} してその親ページ ID を返す (移動済み判定用) */
export async function getDatabaseParentPageId(
  databaseId: string
): Promise<string | null> {
  const res = await notionRequest<DbParentResponse>(
    "GET",
    `/databases/${databaseId}`
  );
  if (res.parent?.type !== "page_id") return null;
  return res.parent.page_id ?? null;
}

export interface PageParent {
  type: string;
  page_id?: string;
  data_source_id?: string;
  database_id?: string;
}

/**
 * GET /pages/{id} の parent を返す (有報テキスト行の移動済み判定用)。
 * 2025-09-03 の Notion-Version で問い合わせる (データソースモデルで
 * `data_source_id` 形式の parent が返る)。
 */
export async function getPageParent(pageId: string): Promise<PageParent> {
  const res = await notionRequest<{ parent: PageParent }>(
    "GET",
    `/pages/${pageId}`,
    undefined,
    { notionVersion: "2025-09-03" }
  );
  return res.parent;
}

interface ChildBlock {
  id: string;
  type: string;
  child_page?: { title?: string };
  child_database?: { title?: string };
}
interface ChildrenResponse {
  results: ChildBlock[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface RemainingChild {
  id: string;
  type: string;
  title: string;
}

/**
 * ページ直下の子ブロックを列挙する (再配置後の残存確認用)。
 *
 * 注意: block children のページ送りは約1万件で打ち切られる実測がある
 * (P6 重複事件の教訓。`archive.ts` の `findBackupChildByTitle` 参照)。
 * 旧「バックアップ」直下の子ページ総数がそれを超える場合、本関数は
 * 「全件」を保証しない — 呼び出し側 (移行スクリプト) が上限到達を
 * ログに残し、運営に周知すること。
 */
export async function listDirectChildren(
  pageId: string,
  maxPages = 200
): Promise<{ children: RemainingChild[]; truncated: boolean }> {
  const children: RemainingChild[] = [];
  let cursor: string | null = null;
  let truncated = true;
  for (let p = 0; p < maxPages; p++) {
    const qs: string =
      cursor !== null
        ? `?start_cursor=${cursor}&page_size=100`
        : "?page_size=100";
    const res: ChildrenResponse = await notionRequest<ChildrenResponse>(
      "GET",
      `/blocks/${pageId}/children${qs}`
    );
    for (const b of res.results) {
      children.push({
        id: b.id,
        type: b.type,
        title: b.child_page?.title ?? b.child_database?.title ?? "",
      });
    }
    if (!res.has_more || !res.next_cursor) {
      truncated = false;
      break;
    }
    cursor = res.next_cursor;
  }
  // 実測 (2026-09-24 P6 重複事件): block children のページ送りは has_more を
  // 正直に返さず約1万件付近で打ち切られることがある。件数がその近辺に
  // 達していたら has_more の値に関わらず「打ち切られた疑いあり」として
  // 正直に報告する (黙って「全件確認済み」と扱わない — ルール2)。
  if (children.length >= 9500) truncated = true;
  return { children, truncated };
}
