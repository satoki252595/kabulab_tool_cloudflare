/**
 * Notion アーカイブ索引ページの確保・更新 (BACKUP 直下の「アーカイブ索引」)。
 *
 * 重複を作らないための多層防御 (2026-09-24 に Search index 遅延で重複作成
 * した実績があるため):
 *   1. NOTION_INDEX_PAGE_ID が設定されていれば Search を使わず直接更新
 *      (決定論的。初回作成後に .env へ ID を記録する運用)
 *   2. 未設定時は Search 発見を再試行してから作成 (index 遅延の吸収)
 *   3. 確保後に同名ページを全件列挙し、最古 (正本) 以外をアーカイブして
 *      1 ページへ収束させる (整理分は結果に明記し、黙って消さない)
 *
 * 内容の正本は map.ts。実行は `pnpm notion:update-index`。
 */
import {
  findAllBackupChildrenByTitle,
  findBackupChildByTitle,
  selectOldestPageId,
} from "./archive.js";
import { notionRequest } from "./client.js";
import { notionEnv } from "./env.js";
import { INDEX_PAGE_TITLE, buildIndexBlocks } from "./map.js";

/** 1 要求で付けられる children 上限 (作成・追記共通) */
const CHILDREN_PER_REQUEST = 100;
/** 作成前の Search 再試行の待ち (index 遅延吸収用) */
const DEFAULT_FIND_WAITS_MS = [5000, 15000];
/** 作成後の Search 索引化待ち (重複整理パス用) */
const DEFAULT_SETTLE_WAIT_MS = 30000;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

interface ChildrenResponse {
  results: Array<{ id: string; type: string }>;
  has_more: boolean;
  next_cursor: string | null;
}

export interface EnsureIndexPageResult {
  /** 維持対象の正本ページ ID (最古) */
  pageId: string;
  url: string;
  /** この実行でページを作成したか */
  outcome: "created" | "updated";
  /** 重複整理でアーカイブした同名ページ ID (通常は空) */
  archivedDuplicates: string[];
}

export interface EnsureIndexPageOptions {
  /** 作成前の Search 再試行待ち列 (既定 [5000, 15000]。テストは短縮可) */
  findWaitsMs?: number[];
  /** 作成後の索引化待ち ms (既定 30000。テストは短縮可) */
  settleWaitMs?: number;
}

/** ページ直下の子ブロック ID を全件列挙する */
async function listChildBlockIds(pageId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const qs: string =
      cursor !== null
        ? `?start_cursor=${cursor}&page_size=100`
        : "?page_size=100";
    const res: ChildrenResponse = await notionRequest<ChildrenResponse>(
      "GET",
      `/blocks/${pageId}/children${qs}`
    );
    for (const b of res.results) ids.push(b.id);
    if (!res.has_more || res.next_cursor === null) break;
    cursor = res.next_cursor;
  }
  return ids;
}

/** 子ブロック群を 100 件ずつ追記する (追記は PATCH。POST は不可) */
async function appendBlocks(pageId: string, blocks: unknown[]): Promise<void> {
  for (let i = 0; i < blocks.length; i += CHILDREN_PER_REQUEST) {
    await notionRequest("PATCH", `/blocks/${pageId}/children`, {
      children: blocks.slice(i, i + CHILDREN_PER_REQUEST),
    });
  }
}

/**
 * 既存索引ページの本文を置換する (子ブロック全削除 → 新規追記)。
 * 索引はフラットなブロック列のみ (ネストなし) のため直下の削除で足りる。
 */
export async function replacePageChildren(
  pageId: string,
  blocks: unknown[]
): Promise<void> {
  for (const id of await listChildBlockIds(pageId)) {
    await notionRequest("DELETE", `/blocks/${id}`);
  }
  await appendBlocks(pageId, blocks);
}

async function findOnce(backupPageId: string): Promise<string | null> {
  return findBackupChildByTitle({
    parentPageId: backupPageId,
    title: INDEX_PAGE_TITLE,
    kind: "page",
  });
}

/** Search index 遅延を吸収するため、待ちを挟んで再試行してから諦める */
async function findWithRetry(
  backupPageId: string,
  waitsMs: number[]
): Promise<string | null> {
  const first = await findOnce(backupPageId);
  if (first) return first;
  for (const wait of waitsMs) {
    await sleep(wait);
    const retry = await findOnce(backupPageId);
    if (retry) return retry;
  }
  return null;
}

async function createIndexPage(
  backupPageId: string,
  blocks: unknown[]
): Promise<{ id: string }> {
  const created = await notionRequest<{ id: string }>("POST", "/pages", {
    parent: { type: "page_id", page_id: backupPageId },
    properties: {
      title: [{ type: "text", text: { content: INDEX_PAGE_TITLE } }],
    },
    children: blocks.slice(0, CHILDREN_PER_REQUEST),
  });
  if (blocks.length > CHILDREN_PER_REQUEST) {
    await appendBlocks(created.id, blocks.slice(CHILDREN_PER_REQUEST));
  }
  return created;
}

/**
 * 索引ページを確保する。無ければ作成、あれば本文を最新に置換。
 * generatedAtISO 省略時は現在時刻 (テストは固定値を渡す)。
 */
export async function ensureIndexPage(
  generatedAtISO?: string,
  opts?: EnsureIndexPageOptions
): Promise<EnsureIndexPageResult> {
  const at = generatedAtISO ?? new Date().toISOString();
  const blocks = buildIndexBlocks(at);
  const backup = notionEnv.NOTION_BACKUP_PAGE_ID();
  const pinned = notionEnv.NOTION_INDEX_PAGE_ID();
  const archivedDuplicates: string[] = [];
  let outcome: "created" | "updated" = "updated";
  let id: string;
  let createdId: string | null = null;

  if (pinned) {
    id = pinned;
  } else {
    const found = await findWithRetry(
      backup,
      opts?.findWaitsMs ?? DEFAULT_FIND_WAITS_MS
    );
    if (found) {
      id = found;
    } else {
      const created = await createIndexPage(backup, blocks);
      id = created.id;
      createdId = created.id;
      outcome = "created";
      await sleep(opts?.settleWaitMs ?? DEFAULT_SETTLE_WAIT_MS);
    }
    // 同名ページを全件列挙し、最古以外をアーカイブして正本へ収束
    const hits = await findAllBackupChildrenByTitle({
      parentPageId: backup,
      title: INDEX_PAGE_TITLE,
      kind: "page",
    });
    const keep = selectOldestPageId(hits) ?? id;
    for (const h of hits) {
      if (h.id === keep) continue;
      await notionRequest("PATCH", `/pages/${h.id}`, { archived: true });
      archivedDuplicates.push(h.id);
    }
    id = keep;
  }

  // 作成したばかりの正本は本文済み。それ以外 (発見・固定・切替) は置換
  if (id !== createdId) {
    await replacePageChildren(id, blocks);
  }
  const page = await notionRequest<{ url: string }>("GET", `/pages/${id}`);
  return { pageId: id, url: page.url, outcome, archivedDuplicates };
}
