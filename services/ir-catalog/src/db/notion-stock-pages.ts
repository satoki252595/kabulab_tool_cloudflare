/**
 * 銘柄 → Notion 会社ページ（銘柄ページ + 適時開示 DB）の D1 写し。
 *
 * catchup は実行のたびにプロセス内 Map が空から始まる。写しがある銘柄は
 * Notion の検索と子 DB の取得を省く。行が無いのは未ヒット（undefined）。
 * 表が無い・ID が空なのは欠損のまま throw する（Notion 解決で埋めない）。
 */
import { and, eq } from "drizzle-orm";
import type {
  NotionStockPageCache,
  NotionStockPageRef,
} from "../../../../src/shared/notion-archive/dataset.js";
import type { Database } from "./client.js";
import { notionStockPages } from "./schema.js";

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `\n${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

function requirePageId(value: string, field: string, service: string, ticker: string): string {
  if (value.trim() === "") {
    throw new Error(
      `ir_notion_stock_pages の ${field} が空です service=${service} ticker=${ticker}`
    );
  }
  return value;
}

export function irNotionStockPageCache(db: Database): NotionStockPageCache {
  return {
    async get(service, ticker) {
      let rows: Array<typeof notionStockPages.$inferSelect>;
      try {
        rows = await db
          .select()
          .from(notionStockPages)
          .where(and(
            eq(notionStockPages.service, service),
            eq(notionStockPages.ticker, ticker),
          ))
          .limit(1);
      } catch (error) {
        if (errorText(error).includes("no such table")) {
          throw new Error(
            "ir_notion_stock_pages がありません。drizzle/d1 の CREATE TABLE `ir_notion_stock_pages` を本番 D1 に適用してから catchup を動かしてください。",
            { cause: error },
          );
        }
        throw error;
      }
      const row = rows[0];
      if (row === undefined) return undefined;
      return {
        stockPageId: requirePageId(row.stockPageId, "stock_page_id", service, ticker),
        childDbId: requirePageId(row.childDbId, "child_db_id", service, ticker),
        schemaVersion: row.schemaVersion,
      };
    },

    async put(service, ticker, ref: NotionStockPageRef) {
      requirePageId(ref.stockPageId, "stock_page_id", service, ticker);
      requirePageId(ref.childDbId, "child_db_id", service, ticker);
      if (!Number.isInteger(ref.schemaVersion)) {
        throw new Error(
          `ir_notion_stock_pages の schema_version が整数ではありません service=${service} ticker=${ticker}`
        );
      }
      const updatedAt = new Date();
      await db
        .insert(notionStockPages)
        .values({
          service,
          ticker,
          stockPageId: ref.stockPageId,
          childDbId: ref.childDbId,
          schemaVersion: ref.schemaVersion,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: [notionStockPages.service, notionStockPages.ticker],
          set: {
            stockPageId: ref.stockPageId,
            childDbId: ref.childDbId,
            schemaVersion: ref.schemaVersion,
            updatedAt,
          },
        });
    },

    async invalidate(service, ticker) {
      await db
        .delete(notionStockPages)
        .where(and(
          eq(notionStockPages.service, service),
          eq(notionStockPages.ticker, ticker),
        ));
    },
  };
}
