import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as coreSchema from "../../../../src/shared/db/core-schema.js";
import * as irSchema from "../db/schema.js";
import { classifyPdfSentimentWithText } from "../services/pdf-sentiment/index.js";
import { getDisclosureText } from "../services/disclosure-text-query.js";

/**
 * 開示 PDF 本文テキストの抽出返却と読み取り。
 * PDF バイト列はテスト用の最小構造データ (本番経路のダミーではない)。
 */

describe("classifyPdfSentimentWithText", () => {
  it("非 PDF は unknown + null を返す (判定不能を正直に)", async () => {
    const { result, text } = await classifyPdfSentimentWithText(
      new TextEncoder().encode("not a pdf"),
      "決算短信"
    );
    expect(result.sentiment).toBe("unknown");
    expect(text).toBeNull();
  });

  it("最小 PDF からテキストを抜いて判定に回す (抽出は 1 回)", async () => {
    const pdf = [
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
    const { result, text } = await classifyPdfSentimentWithText(
      new TextEncoder().encode(pdf),
      "決算短信"
    );
    expect(text).toContain("Hello test");
    // 短信タグは判定対象外 → skipped (テキスト自体は返る)
    expect(result.sentiment).toBe("skipped");
  });
});

/** getDisclosureText が触る列だけの手書き DDL */
const DDL = `
CREATE TABLE core_stocks (
  id integer PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL
);
CREATE TABLE ir_disclosures (
  id integer PRIMARY KEY AUTOINCREMENT,
  stock_id integer NOT NULL,
  tdnet_id text NOT NULL UNIQUE,
  title text NOT NULL
);
CREATE TABLE ir_disclosure_texts (
  id integer PRIMARY KEY AUTOINCREMENT,
  disclosure_id integer NOT NULL UNIQUE,
  tdnet_id text NOT NULL,
  text text NOT NULL,
  char_count integer NOT NULL
);
`;

/** drizzle-orm/d1 が触る範囲だけの D1Database シム。 */
function createD1(sqlite: DatabaseSync): unknown {
  const prepare = (query: string) => {
    const make = (params: unknown[]) => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      all: async () => ({ results: sqlite.prepare(query).all(...(params as any[])), success: true, meta: {} }),
      raw: async () => {
        const stmt = sqlite.prepare(query);
        const names = stmt.columns().map((col) => col.name);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = stmt.all(...(params as any[])) as Record<string, unknown>[];
        return rows.map((row) => names.map((n) => row[n]));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: async () => ({ results: [], success: true, meta: sqlite.prepare(query).run(...(params as any[])) }),
      first: async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = sqlite.prepare(query).get(...(params as any[]));
        return row ?? null;
      },
      bind: (...next: unknown[]) => make(next),
    });
    return make([]);
  };
  return { prepare };
}

function makeDb(d1: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return drizzle(d1 as any, { schema: { ...coreSchema, ...irSchema } });
}

describe("disclosure-text-query", () => {
  let sqlite: DatabaseSync;
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(DDL);
    sqlite
      .prepare("INSERT INTO core_stocks (id, code, name) VALUES (1, '1001', 'テスト1001')")
      .run();
    sqlite
      .prepare(
        "INSERT INTO ir_disclosures (id, stock_id, tdnet_id, title) VALUES (10, 1, 'T0001', '決算短信')"
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO ir_disclosures (id, stock_id, tdnet_id, title) VALUES (11, 1, 'T0002', '説明資料')"
      )
      .run();
    sqlite
      .prepare(
        "INSERT INTO ir_disclosure_texts (disclosure_id, tdnet_id, text, char_count) VALUES (10, 'T0001', '短信の本文テキスト', 9)"
      )
      .run();
    db = makeDb(createD1(sqlite));
  });

  it("本文ありは 1 件、なし・不明は null", async () => {
    const hit = await getDisclosureText(db, "T0001");
    expect(hit!.text).toBe("短信の本文テキスト");
    expect(hit!.title).toBe("決算短信");
    expect(await getDisclosureText(db, "T0002")).toBeNull();
    expect(await getDisclosureText(db, "T9999")).toBeNull();
  });
});
