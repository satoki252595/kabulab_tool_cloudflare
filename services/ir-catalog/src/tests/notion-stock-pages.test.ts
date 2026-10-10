/**
 * ir_notion_stock_pages の写し。未登録は undefined。空 ID と表の欠落は throw。
 * マイグレーションは CREATE だけで、既存表の DROP / DELETE / UPDATE を含まない。
 */
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import type { Database } from "../db/client.js";
import * as irSchema from "../db/schema.js";
import { irNotionStockPageCache } from "../db/notion-stock-pages.js";
import { IR_NOTION_STOCK_PAGE_SCHEMA_VERSION } from "../../../../src/shared/notion-archive/dataset.js";

const MIGRATION = "drizzle/d1/0028_ir_notion_stock_pages.sql";

function migrationSql(): string {
  const text = readFileSync(MIGRATION, "utf8");
  const names = readdirSync("drizzle/d1").filter((name) => name.endsWith(".sql") && readFileSync(`drizzle/d1/${name}`, "utf8").includes("ir_notion_stock_pages"));
  expect(names).toEqual(["0028_ir_notion_stock_pages.sql"]);
  return text;
}

function createD1(sqlite: DatabaseSync): unknown {
  const prepare = (query: string) => {
    const make = (params: unknown[]) => ({
      all: async () => ({ results: sqlite.prepare(query).all(...(params as never[])), success: true, meta: {} }),
      run: async () => ({ results: [], success: true, meta: sqlite.prepare(query).run(...(params as never[])) }),
      raw: async () => {
        const statement = sqlite.prepare(query);
        const bound = params as never[];
        if (typeof statement.setReturnArrays === "function") {
          statement.setReturnArrays(true);
          return statement.all(...bound);
        }
        const rows = statement.all(...bound) as Array<Record<string, unknown>>;
        return rows.map((row) => Object.values(row));
      },
      bind: (...next: unknown[]) => make(next),
    });
    return make([]);
  };
  return { prepare };
}

function makeDb(sqlite: DatabaseSync): Database {
  return drizzle(createD1(sqlite) as never, { schema: { ...irSchema } }) as unknown as Database;
}

describe("ir_notion_stock_pages", () => {
  it("マイグレーションは新しい表の CREATE だけで、既存データの削除や更新を含まない", () => {
    const text = migrationSql();
    expect(text).toContain("CREATE TABLE `ir_notion_stock_pages`");
    expect(text).toContain("PRIMARY KEY(`service`, `ticker`)");
    expect(text).not.toMatch(/\b(DROP|DELETE|UPDATE|ALTER)\b/);
  });

  it("未登録は undefined、書いた対応は同じ ID で読め、上書きと破棄ができる", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(migrationSql().replace(/^--.*$/gm, ""));
    const cache = irNotionStockPageCache(makeDb(sqlite));
    expect(await cache.get("ir-catalog", "1001")).toBeUndefined();
    await cache.put("ir-catalog", "1001", {
      stockPageId: "stock-1",
      childDbId: "child-1",
      schemaVersion: IR_NOTION_STOCK_PAGE_SCHEMA_VERSION,
    });
    expect(await cache.get("ir-catalog", "1001")).toEqual({
      stockPageId: "stock-1",
      childDbId: "child-1",
      schemaVersion: IR_NOTION_STOCK_PAGE_SCHEMA_VERSION,
    });
    await cache.put("ir-catalog", "1001", {
      stockPageId: "stock-2",
      childDbId: "child-2",
      schemaVersion: IR_NOTION_STOCK_PAGE_SCHEMA_VERSION,
    });
    expect(await cache.get("ir-catalog", "1001")).toMatchObject({
      stockPageId: "stock-2",
      childDbId: "child-2",
    });
    expect(sqlite.prepare("SELECT count(*) AS n FROM ir_notion_stock_pages").get()).toEqual({ n: 1 });
    await cache.invalidate("ir-catalog", "1001");
    expect(await cache.get("ir-catalog", "1001")).toBeUndefined();
  });

  it("空の ID は書かず、表が無いときは適用漏れとして停止する", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(migrationSql().replace(/^--.*$/gm, ""));
    const cache = irNotionStockPageCache(makeDb(sqlite));
    await expect(cache.put("ir-catalog", "1001", {
      stockPageId: "  ",
      childDbId: "child-1",
      schemaVersion: IR_NOTION_STOCK_PAGE_SCHEMA_VERSION,
    })).rejects.toThrow(/空/);
    expect(sqlite.prepare("SELECT count(*) AS n FROM ir_notion_stock_pages").get()).toEqual({ n: 0 });

    sqlite.exec("INSERT INTO ir_notion_stock_pages (service, ticker, stock_page_id, child_db_id, schema_version) VALUES ('ir-catalog', '1002', '', 'child-x', 1)");
    await expect(cache.get("ir-catalog", "1002")).rejects.toThrow(/空/);

    const missing = irNotionStockPageCache(makeDb(new DatabaseSync(":memory:")));
    await expect(missing.get("ir-catalog", "1001")).rejects.toThrow(/ir_notion_stock_pages がありません/);
  });
});
