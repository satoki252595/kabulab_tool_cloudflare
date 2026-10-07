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
  verifyArchivedAttachments: vi.fn().mockResolvedValue(undefined),
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
  verifyArchivedAttachments,
  upsertDisclosuresByStock,
} from "../../../../src/shared/notion-archive/index.js";
vi.mock("../../../../src/shared/db/active-equity.js", () => ({
  loadIngestCodeToId: vi.fn(async () => new Map([["1001", 1]])),
}));

import { ingestBatch, resumeNotionByStock, selectNotionArchiveRows } from "../services/ingest.js";

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
`;

function createD1(sqlite: DatabaseSync): unknown {
  const prepare = (query: string) => {
    const make = (params: unknown[]) => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      all: async () => ({ results: sqlite.prepare(query).all(...(params as any[])), success: true, meta: {} }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: async () => ({ results: [], success: true, meta: sqlite.prepare(query).run(...(params as any[])) }),
      // SELECT の列順を D1 raw() と同じ配列で返す。
      raw: async () => {
        const statement = sqlite.prepare(query);
        statement.setReturnArrays(true);
        return statement.all(...params as never[]);
      },
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

  it("保存済み入力の再開は一次取得/再投入なしで全件の二次保管へ渡す", async () => {
    const db = makeDb(createD1(sqlite));
    await ingestBatch(db as never, [ITEM], {batchKey: "saved", source: "test",
      archiveToNotion: false, notionByStock: false, codeToId: new Map([["1001", 1]])});
    const before = sqlite.prepare("SELECT * FROM ir_disclosures").all();
    await resumeNotionByStock(db as never, new Date("2026-09-18T00:00:00+09:00"), new Date("2026-09-19T00:00:00+09:00"));
    expect(recordPrimaryData).not.toHaveBeenCalled();
    expect(upsertDisclosuresByStock).toHaveBeenCalledTimes(1);
    const input = vi.mocked(upsertDisclosuresByStock).mock.calls[0][0];
    expect(input.rows).toEqual([expect.objectContaining({key: ITEM.id, ticker: "1001", title: ITEM.title,
      documentUrl: ITEM.document_url, pubdate: "2026-09-18T11:00:00.000Z"})]);
    expect(input.deadlineMs).toBeUndefined();
    expect(sqlite.prepare("SELECT * FROM ir_disclosures").all()).toEqual(before);
  });

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

  it("一次添付の全 bytes 読戻しを D1 書込前に完了する", async () => {
    vi.mocked(verifyArchivedAttachments).mockImplementationOnce(async (_page, files) => {
      expect(sqlite.prepare("SELECT count(*) AS n FROM ir_disclosures").get()?.n).toBe(0);
      expect(files).toEqual(vi.mocked(recordPrimaryData).mock.calls[0][0].files);
    });
    await run({});
    expect(verifyArchivedAttachments).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT count(*) AS n FROM ir_disclosures").get()?.n).toBe(1);
  });

  it.each(["record", "readback", "too_large"])("一次 %s 失敗は D1・二次取得より前に停止", async (phase) => {
    if (phase === "record") vi.mocked(recordPrimaryData).mockRejectedValueOnce(new Error("archive unknown"));
    if (phase === "readback") vi.mocked(verifyArchivedAttachments).mockRejectedValueOnce(new Error("readback mismatch"));
    if (phase === "too_large") vi.mocked(recordPrimaryData).mockResolvedValueOnce({
      pageId: "p1", outcome: "recorded", fileTooLarge: true,
      manifestMatch: "written",
    });
    await expect(run({})).rejects.toThrow();
    expect(sqlite.prepare("SELECT count(*) AS n FROM ir_disclosures").get()?.n).toBe(0);
    expect(upsertDisclosuresByStock).not.toHaveBeenCalled();
  });

  it("二次記録の例外も成功結果に変換しない", async () => {
    const failure = new Error("secondary unknown");
    vi.mocked(upsertDisclosuresByStock).mockRejectedValueOnce(failure);
    await expect(run({})).rejects.toBe(failure);
  });

  it.each(["write_failure", "missing_row"])("PDF 本文の %s は状態補作・黙殺で成功化しない", async (phase) => {
    vi.mocked(upsertDisclosuresByStock).mockImplementationOnce(async (input) => {
      input.onPdfClassified?.("T0001", { sentiment: "unknown", method: null, score: null, text: "試験本文𠮷" });
      if (phase === "missing_row") sqlite.exec("DELETE FROM ir_disclosures");
      return { parentDbId: "db1", stocksTouched: 1, created: 1, updated: 0, skippedExisting: 0, skippedNoFile: 0, rejudged: 0, rowErrors: 0, reachedDeadline: false, deadlineRemainderKeys: [], skippedNoFileKeys: [] };
    });
    if (phase === "write_failure") sqlite.exec(`CREATE TRIGGER fail_text BEFORE INSERT ON ir_disclosure_texts
      BEGIN SELECT RAISE(ABORT, 'write failed'); END;`);
    await expect(run({})).rejects.toThrow();
    const hit = sqlite.prepare("SELECT pdf_text_status FROM ir_disclosures").get();
    expect(hit === undefined || hit.pdf_text_status === null).toBe(true);
  });

  it("本文 INSERT 後の中断は全文一致を確認し、添付済みキーだけを再開して INSERT を重ねない", async () => {
    const db = makeDb(createD1(sqlite));
    await ingestBatch(db as never, [ITEM], {batchKey: "saved", source: "test",
      archiveToNotion: false, notionByStock: false, codeToId: new Map([["1001", 1]])});
    const id = sqlite.prepare("SELECT id FROM ir_disclosures").get()!.id;
    const text = "保存済み本文𠮷";
    sqlite.prepare("INSERT INTO ir_disclosure_texts(disclosure_id,tdnet_id,text,char_count) VALUES(?,?,?,?)")
      .run(id as number, ITEM.id, text, text.length);
    sqlite.exec("UPDATE ir_disclosures SET notion_page_id='existing'");
    sqlite.exec(`CREATE TRIGGER prevent_repeat BEFORE INSERT ON ir_disclosure_texts
      BEGIN SELECT RAISE(ABORT, 'repeat insert'); END;`);
    vi.mocked(upsertDisclosuresByStock).mockImplementationOnce(async (input) => {
      expect([...input.recoverPdfTextKeys!]).toEqual([ITEM.id]);
      input.onPagePersisted?.(ITEM.id, "existing");
      input.onPdfClassified?.(ITEM.id, {sentiment: "unknown", method: null, score: null, text});
      return {parentDbId: "db1", stocksTouched: 1, created: 0, updated: 0,
        skippedExisting: 1, skippedNoFile: 0, rejudged: 0, rowErrors: 0, reachedDeadline: false,
        deadlineRemainderKeys: [], skippedNoFileKeys: []};
    });
    await resumeNotionByStock(db as never, new Date("2026-09-18T00:00:00+09:00"), new Date("2026-09-19T00:00:00+09:00"));
    expect(sqlite.prepare("SELECT pdf_text_status FROM ir_disclosures").get()!.pdf_text_status).toBe("ok");
    expect(sqlite.prepare("SELECT text,char_count FROM ir_disclosure_texts").get()).toEqual({text, char_count: text.length});
    await resumeNotionByStock(db as never, new Date("2026-09-18T00:00:00+09:00"), new Date("2026-09-19T00:00:00+09:00"));
    expect([...vi.mocked(upsertDisclosuresByStock).mock.calls[1][0].recoverPdfTextKeys!]).toEqual([]);
  });
});

function disclosureRow(key: string, pubdate: string) {
  return {
    key,
    ticker: "1001",
    companyName: "テスト1001",
    companyUrl: "https://example.test/1001",
    tags: [] as string[],
    primaryTag: null,
    pubdate,
    title: key,
    documentUrl: `https://example.test/${key}.pdf`,
    markets: null,
  };
}

describe("二次投入の対象", () => {
  it("保存済みを外し、未保存は公開が古い順", () => {
    const selected = selectNotionArchiveRows({
      batchRows: [
        disclosureRow("NEW", "2026-10-01T00:00:00.000Z"),
        disclosureRow("SAVED", "2026-09-01T00:00:00.000Z"),
      ],
      archivedKeys: new Set(["SAVED"]),
      olderUnsaved: [disclosureRow("OLD", "2026-08-01T00:00:00.000Z")],
      limitToUnsaved: true,
    });
    expect(selected.rows.map((row) => row.key)).toEqual(["OLD", "NEW"]);
    expect(selected.excludedArchivedKeys).toEqual(["SAVED"]);
  });

  it("再判定のないバックフィルは保存済みも渡す", () => {
    const selected = selectNotionArchiveRows({
      batchRows: [
        disclosureRow("NEW", "2026-10-01T00:00:00.000Z"),
        disclosureRow("SAVED", "2026-09-01T00:00:00.000Z"),
      ],
      archivedKeys: new Set(["SAVED"]),
      olderUnsaved: [disclosureRow("OLD", "2026-08-01T00:00:00.000Z")],
      limitToUnsaved: false,
    });
    expect(selected.rows.map((row) => row.key)).toEqual(["NEW", "SAVED"]);
    expect(selected.excludedArchivedKeys).toEqual([]);
  });
});

function jstDaysAgo(days: number): string {
  const t = new Date(Date.now() - days * 86_400_000 + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

describe("予算付き二次投入の D1 選択", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(DDL);
  });

  function insertRaw(tdnetId: string, daysAgo: number, pageId: string | null, companyCode = "10010") {
    sqlite.prepare(
      `INSERT INTO ir_disclosures
        (stock_id, tdnet_id, company_code, company_name, title, pubdate, document_url, tags, notion_page_id)
       VALUES (1, ?, ?, 'テスト1001', ?, ?, ?, '[]', ?)`
    ).run(
      tdnetId,
      companyCode,
      tdnetId,
      Math.floor((Date.now() - daysAgo * 86_400_000) / 1000),
      `https://example.test/${tdnetId}.pdf`,
      pageId
    );
  }

  it("notion_page_id がある行だけでは Notion を呼ばない", async () => {
    const db = makeDb(createD1(sqlite));
    const base = {
      batchKey: "saved-only",
      source: "test",
      archiveToNotion: false,
      codeToId: new Map([["1001", 1]]),
    };
    await ingestBatch(db as never, [ITEM], { ...base, notionByStock: false });
    sqlite.exec("UPDATE ir_disclosures SET notion_page_id='page-1'");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await ingestBatch(db as never, [ITEM], {
        ...base,
        batchKey: "saved-only-2",
        notionByStock: true,
        notionByStockBudgetMs: 60_000,
      });
      expect(upsertDisclosuresByStock).not.toHaveBeenCalled();
      const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("[INC-20261008-kabulab_tool_cloudflare-ir-pdf-502] archived-skipped-notion-query");
      expect(logged).toContain(ITEM.id);
    } finally {
      warn.mockRestore();
    }
  });

  it("保持日内の古い未保存を先に渡し、期限外と保存済みは渡さない", async () => {
    insertRaw("OLD", 30, null);
    insertRaw("ANCIENT", 100, null);
    insertRaw("OUT", 10, null, "99990");
    insertRaw("SAVED", 2, "page-saved");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = makeDb(createD1(sqlite));
      await ingestBatch(db as never, [
        { ...ITEM, id: "NEW", pubdate: jstDaysAgo(1), title: "新しい開示" },
        { ...ITEM, id: "SAVED", pubdate: jstDaysAgo(2), title: "保存済み開示" },
      ], {
        batchKey: "lookback",
        source: "test",
        archiveToNotion: false,
        notionByStock: true,
        notionByStockBudgetMs: 60_000,
        unsavedLookbackDays: 40,
        codeToId: new Map([["1001", 1]]),
      });
      expect(upsertDisclosuresByStock).toHaveBeenCalledTimes(1);
      const rows = vi.mocked(upsertDisclosuresByStock).mock.calls[0]![0]!.rows;
      expect(rows.map((row) => row.key)).toEqual(["OLD", "NEW"]);
      const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
      expect(logged).toContain("archived-skipped-notion-query");
      expect(logged).toContain("SAVED");
      expect(logged).toContain("universe-excluded");
      expect(logged).toContain("OUT");
      expect(logged).not.toContain("ANCIENT");
    } finally {
      warn.mockRestore();
    }
  });
});
