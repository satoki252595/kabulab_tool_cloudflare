import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as irSchema from "../db/schema.js";
import type { Database } from "../db/client.js";
import type { TdnetItemRaw } from "../services/tdnet/types.js";
import {
  NotionUnknownResultError,
  notionRequest,
} from "../../../../src/shared/notion-archive/client.js";
import {
  findBackupChildByTitle,
  queryUniqueRow,
} from "../../../../src/shared/notion-archive/archive.js";
import { uploadFile } from "../../../../src/shared/notion-archive/file-upload.js";
import { verifyArchivedAttachments } from "../../../../src/shared/notion-archive/readback.js";

vi.mock("../../../../src/shared/notion-archive/client.js", async (original) => ({
  ...(await original<typeof import("../../../../src/shared/notion-archive/client.js")>()),
  notionRequest: vi.fn(),
}));
vi.mock("../../../../src/shared/notion-archive/env.js", async (original) => {
  const mod = await original<typeof import("../../../../src/shared/notion-archive/env.js")>();
  return {
    ...mod,
    notionEnv: {
      ...mod.notionEnv,
      NOTION_ARCHIVE_PAGE_ID: () => "a".repeat(32),
    },
  };
});
vi.mock("../../../../src/shared/notion-archive/archive.js", async (original) => {
  const mod = await original<typeof import("../../../../src/shared/notion-archive/archive.js")>();
  return {
    ...mod,
    findBackupChildByTitle: vi.fn(async () => "parent-db"),
    queryUniqueRow: vi.fn(async () => ({ id: "stock-page" })),
  };
});
vi.mock("../../../../src/shared/notion-archive/file-upload.js", async (original) => ({
  ...(await original<typeof import("../../../../src/shared/notion-archive/file-upload.js")>()),
  uploadFile: vi.fn(async () => "upload-1"),
}));
vi.mock("../../../../src/shared/notion-archive/readback.js", () => ({
  verifyArchivedAttachments: vi.fn(async () => undefined),
}));

/**
 * INC-20261028-kabulab_tool_cloudflare-catchup-notion-502
 *
 * 開示ループの途中で POST /pages が 502 になると、それより前に作った
 * notion_page_id と PDF 本文が D1 に残ること。書き戻しがループ後の1回だけ
 * だと、このテストは落ちる。
 */

const CHILD_PROPERTIES = [
  "開示表題",
  "タグ",
  "代表タグ",
  "IR発表日",
  "市場",
  "資料",
  "IR資料",
  "IR取得来歴",
  "IR資料状態",
  "PDF判定",
  "TDnet ID",
] as const;

/** disclosure-text.test.ts と同じ、テキストを1つ含む最小 PDF。 */
const MINIMAL_PDF = [
  "%PDF-1.4",
  "1 0 obj << /Type /Catalog /Pages 2 0 R >>",
  "endobj",
  "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "endobj",
  "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  "endobj",
  "4 0 obj << /Length 44 >>",
  "stream",
  "BT /F1 12 Tf 10 10 Td (Hello test) Tj ET",
  "endstream",
  "endobj",
  "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  "endobj",
  "trailer << /Root 1 0 R >>",
].join("\n");

const DDL = `
CREATE TABLE ir_disclosures (
  id integer PRIMARY KEY AUTOINCREMENT,
  stock_id integer NOT NULL,
  tdnet_id text NOT NULL UNIQUE,
  company_code text NOT NULL,
  company_name text NOT NULL,
  title text NOT NULL,
  pubdate integer NOT NULL,
  document_url text NOT NULL,
  xbrl_url text,
  markets_string text,
  tags text NOT NULL,
  primary_tag text,
  notion_page_id text,
  pdf_sentiment text,
  pdf_sentiment_method text,
  pdf_sentiment_score real,
  pdf_sentiment_at integer,
  pdf_text_status text,
  ingested_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE ir_disclosure_texts (
  id integer PRIMARY KEY AUTOINCREMENT,
  disclosure_id integer NOT NULL UNIQUE,
  tdnet_id text NOT NULL,
  text text NOT NULL,
  char_count integer NOT NULL,
  created_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE ir_notion_stock_pages (
  service text NOT NULL,
  ticker text NOT NULL,
  stock_page_id text NOT NULL,
  child_db_id text NOT NULL,
  schema_version integer NOT NULL,
  updated_at integer NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (service, ticker)
);
`;

function sqlParams(params: readonly unknown[]): SQLInputValue[] {
  return params.map((value, index) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    const kind = value === undefined ? "undefined" : typeof value;
    throw new Error(`D1 シムのバインド値が SQLite に渡せません index=${index} type=${kind}`);
  });
}

function createD1(sqlite: DatabaseSync): D1Database {
  const prepare = (query: string) => {
    const make = (params: readonly unknown[]) => ({
      bind: (...next: unknown[]) => make(next),
      all: async () => ({
        success: true,
        meta: {},
        results: sqlite.prepare(query).all(...sqlParams(params)),
      }),
      run: async () => {
        sqlite.prepare(query).run(...sqlParams(params));
        return { success: true, meta: {}, results: [] };
      },
      raw: async () => {
        const statement = sqlite.prepare(query);
        statement.setReturnArrays(true);
        return statement.all(...sqlParams(params));
      },
      first: async () => sqlite.prepare(query).get(...sqlParams(params)) ?? null,
    });
    return make([]);
  };
  // node:sqlite は D1 の meta を持たない。drizzle はこのテストで meta を読まない。
  return {
    prepare,
    dump: () => Promise.reject(new Error("D1 シムは dump を実装していません")),
    batch: () => Promise.reject(new Error("D1 シムは batch を実装していません")),
    exec: () => Promise.reject(new Error("D1 シムは exec を実装していません")),
  } as unknown as D1Database;
}

function makeDb(sqlite: DatabaseSync): Database {
  return drizzle(createD1(sqlite), { schema: { ...irSchema } }) as Database;
}

function item(id: string, pubdate: string): TdnetItemRaw {
  return {
    id,
    pubdate,
    company_code: "10010",
    company_name: "テスト1001",
    title: `開示 ${id}`,
    document_url: `https://example.test/${id}.pdf`,
    url_xbrl: null,
    markets_string: null,
    update_history: null,
  };
}

describe("catchup の Notion 502 でも作成済み分は D1 に残る", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(DDL);
    vi.mocked(findBackupChildByTitle).mockResolvedValue("parent-db");
    vi.mocked(queryUniqueRow).mockResolvedValue({ id: "stock-page" } as never);
    vi.mocked(uploadFile).mockResolvedValue("upload-1");
    vi.mocked(verifyArchivedAttachments).mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(MINIMAL_PDF, { headers: { "content-type": "application/pdf" } }))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ループ途中の POST /pages 502 より前に作った notion_page_id と PDF 本文を D1 に書く", async () => {
    const failure = new NotionUnknownResultError(
      "Notion 非冪等create (POST /pages) の結果不明のため再送しません (status=502)。full query で確認してください"
    );
    let pagePosts = 0;
    vi.mocked(notionRequest).mockImplementation(async (method, path) => {
      if (method === "GET" && path.startsWith("/blocks/stock-page/children")) {
        return {
          results: [{
            id: "child-db",
            type: "child_database",
            child_database: { title: "適時開示｜1001" },
          }],
          has_more: false,
          next_cursor: null,
        } as never;
      }
      if (method === "GET" && path === "/databases/child-db") {
        return {
          properties: Object.fromEntries(CHILD_PROPERTIES.map((name) => [name, { type: "rich_text" }])),
          is_inline: true,
          parent: { type: "page_id", page_id: "stock-page" },
        } as never;
      }
      if (method === "POST" && path === "/databases/child-db/query") {
        return { results: [], has_more: false, next_cursor: null } as never;
      }
      if (method === "POST" && path === "/pages") {
        pagePosts += 1;
        if (pagePosts === 1) return { id: "page-created-before-502" } as never;
        throw failure;
      }
      if (method === "GET" && path === "/pages/page-created-before-502") {
        return { properties: {} } as never;
      }
      throw new Error(`想定外の Notion 呼び出しです: ${method} ${path}`);
    });

    const { ingestBatch } = await import("../services/ingest.js");
    const pending = ingestBatch(makeDb(sqlite), [
      item("T0002", "2026-09-18 20:00:00"),
      item("T0001", "2026-09-18 10:00:00"),
    ], {
      batchKey: "tdnet-502-regression",
      source: "INC-20261028 regression",
      archiveToNotion: false,
      notionByStock: true,
      codeToId: new Map([["1001", 1]]),
    });

    await expect(pending).rejects.toBe(failure);
    expect(pagePosts).toBe(2);
    expect(vi.mocked(notionRequest).mock.calls.filter(([method, path]) => method === "POST" && path === "/pages")).toHaveLength(2);

    const rows = sqlite.prepare(
      "SELECT tdnet_id, notion_page_id, pdf_text_status FROM ir_disclosures ORDER BY tdnet_id"
    ).all();
    expect(rows).toEqual([
      { tdnet_id: "T0001", notion_page_id: "page-created-before-502", pdf_text_status: "ok" },
      { tdnet_id: "T0002", notion_page_id: null, pdf_text_status: null },
    ]);
    const texts = sqlite.prepare(
      "SELECT tdnet_id, text, char_count FROM ir_disclosure_texts ORDER BY tdnet_id"
    ).all() as Array<{ tdnet_id: string; text: string; char_count: number }>;
    expect(texts).toHaveLength(1);
    expect(texts[0]?.tdnet_id).toBe("T0001");
    expect(texts[0]?.text).toContain("Hello test");
    expect(texts[0]?.char_count).toBe(texts[0]?.text.length);
  });
});
