import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as irSchema from "../db/schema.js";
import type { TdnetItemRaw } from "../services/tdnet/types.js";

vi.mock("../../../../src/shared/notion-archive/index.js", () => ({
  recordPrimaryData: vi.fn().mockResolvedValue({
    pageId: "p1",
    outcome: "recorded",
    fileTooLarge: false,
  }),
  upsertDisclosuresByStock: vi.fn().mockResolvedValue({
    parentDbId: "db1",
    stocksTouched: 0,
    created: 0,
    updated: 0,
    skippedExisting: 0,
    skippedNoFile: 0,
    rejudged: 0,
    rowErrors: 0,
    reachedDeadline: false,
  }),
}));

/**
 * 二次投入の予算スレッドの回帰テスト。
 *
 * 2026-06 以降、日次の `notionByStockDeadlineMs` (ジョブ開始+50s) が
 * D1 フェーズに食われて二次投入が常時 0 件だった。相対予算
 * `notionByStockBudgetMs` は二次フェーズ開始から測ることを固定する。
 */
import {
  recordPrimaryData,
  upsertDisclosuresByStock,
} from "../../../../src/shared/notion-archive/index.js";
import { ingestBatch } from "../services/ingest.js";

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
`;

function createD1(sqlite: DatabaseSync): unknown {
  const prepare = (query: string) => {
    const make = (params: unknown[]) => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      all: async () => ({ results: sqlite.prepare(query).all(...(params as any[])), success: true, meta: {} }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: async () => ({ results: [], success: true, meta: sqlite.prepare(query).run(...(params as any[])) }),
      bind: (...next: unknown[]) => make(next),
    });
    return make([]);
  };
  return { prepare };
}

function makeDb(d1: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return drizzle(d1 as any, { schema: { ...irSchema } });
}

const ITEM: TdnetItemRaw = {
  id: "T0001",
  pubdate: "2026-09-18 20:00:00",
  company_code: "10010",
  company_name: "テスト1001",
  title: "テスト開示",
  document_url: "https://example.test/t0001.pdf",
  url_xbrl: null,
  markets_string: null,
  update_history: null,
};

describe("ingestBatch の二次予算", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(DDL);
  });

  async function run(opts: {
    notionByStockBudgetMs?: number;
    notionByStockDeadlineMs?: number;
  }) {
    const db = makeDb(createD1(sqlite));
    const r = await ingestBatch(db as never, [ITEM], {
      batchKey: "tdnet-test-1",
      source: "test",
      archiveToNotion: true,
      notionByStock: true,
      codeToId: new Map([["1001", 1]]),
      ...opts,
    });
    expect(r.upserted).toBe(1);
    expect(vi.mocked(recordPrimaryData)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(upsertDisclosuresByStock)).toHaveBeenCalledTimes(1);
    return vi.mocked(upsertDisclosuresByStock).mock.calls[0]![0]!;
  }

  it("相対予算は二次フェーズ開始から測る (D1 所要に依らない)", async () => {
    const before = Date.now();
    const input = await run({ notionByStockBudgetMs: 60_000 });
    const after = Date.now();
    expect(input.deadlineMs).toBeGreaterThanOrEqual(before + 60_000);
    expect(input.deadlineMs).toBeLessThanOrEqual(after + 60_000);
  });

  it("絶対 deadline 併用時は早い方を採用する", async () => {
    const input = await run({
      notionByStockBudgetMs: 60_000,
      notionByStockDeadlineMs: 1,
    });
    expect(input.deadlineMs).toBe(1);
  });

  it("絶対 deadline のみは素通し (backfill 互換)", async () => {
    const abs = Date.now() + 3_600_000;
    const input = await run({ notionByStockDeadlineMs: abs });
    expect(input.deadlineMs).toBe(abs);
  });
});
