import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as irSchema from "../db/schema.js";
import type { TdnetItemRaw } from "../services/tdnet/types.js";
import { normalizeTdnetItem } from "../services/tdnet/types.js";
import { loadIngestCodeToId } from "../../../../src/shared/db/active-equity.js";

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

// 原HTTPではなく、旧日次アーカイブの実prepared行抜粋。未保存update_historyは補作しない。
const actualBatch = JSON.parse(readFileSync(new URL("./fixtures/tdnet-daily-batch.actual.json", import.meta.url), "utf8")) as Array<{
  tdnet_id: string; ticker: string; company_code: string; company_name: string;
  pubdate: string; title: string; document_url: string; xbrl_url: string | null; markets: string | null;
}>;
const actualItems = actualBatch.map((row) => {
  const pubdate = new Date(Date.parse(row.pubdate) + 9 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  const item = normalizeTdnetItem({ id: row.tdnet_id, company_code: row.company_code,
    company_name: row.company_name, title: row.title, pubdate, document_url: row.document_url,
    url_xbrl: row.xbrl_url, markets_string: row.markets }, "saved prepared batch projection");
  if (item === null) throw new Error("実prepared行の必須fieldが欠けています");
  return item;
});

describe("ingestBatch の二次予算", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(DDL);
  });

  function runActual(items: TdnetItemRaw[], dailySnapshot?: true) {
    return ingestBatch(makeDb(createD1(sqlite)) as never, items, {
      batchKey: dailySnapshot ? "tdnet-daily-2026-10-14" : "tdnet-2026-10",
      dailySnapshot, source: "offline regression: saved actual prepared batch",
      archiveToNotion: true, notionByStock: true,
      codeToId: new Map(actualBatch.map((row, index) => [row.ticker, index + 1])),
    });
  }

  it("実日次行の部分集合が変わる時だけsnapshot keyが変わり、同じ内容は同じkeyへ戻る", async () => {
    for (const items of [actualItems.slice(0, 1), actualItems, actualItems.slice(0, 1)]) {
      await runActual(items, true);
    }
    const inputs = vi.mocked(recordPrimaryData).mock.calls.map(([input]) => input);
    for (const [index, input] of inputs.entries()) {
      const bytes = input.files![0].bytes;
      expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(index === 1 ? actualBatch : actualBatch.slice(0, 1));
      expect(input.key).toBe(`tdnet-daily-2026-10-14-${createHash("sha256").update(bytes).digest("hex")}`);
      expect(input.files![0].filename).toBe("tdnet-daily-2026-10-14.json");
      expect(input).not.toHaveProperty("force");
      expect(input).not.toHaveProperty("fetchedAt");
    }
    expect(inputs[0].key).toBe(inputs[2].key);
    expect(inputs[0].key).not.toBe(inputs[1].key);
    expect(inputs.some((input) => input.key === "tdnet-daily-2026-10-14")).toBe(false);
    expect(verifyArchivedAttachments).toHaveBeenCalledTimes(3);
    expect(sqlite.prepare("SELECT count(*) AS n FROM ir_disclosures").get()?.n).toBe(2);
  });

  it("月次callerは実行しても従来keyとファイル名を保持する", async () => {
    await runActual(actualItems);
    const input = vi.mocked(recordPrimaryData).mock.calls[0][0];
    expect(input.key).toBe("tdnet-2026-10");
    expect(input.files![0].filename).toBe("tdnet-2026-10.json");
  });

  it.each(["archive", "readback"])("日次snapshotの%s未知は再送せずD1/二次処理前に停止する", async (phase) => {
    const failure = new Error(`injected ${phase} unknown`);
    if (phase === "archive") vi.mocked(recordPrimaryData).mockRejectedValueOnce(failure);
    else vi.mocked(verifyArchivedAttachments).mockRejectedValueOnce(failure);
    await expect(runActual(actualItems, true)).rejects.toBe(failure);
    expect(recordPrimaryData).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare("SELECT count(*) AS n FROM ir_disclosures").get()?.n).toBe(0);
    expect(upsertDisclosuresByStock).not.toHaveBeenCalled();
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

  it("実保存2行からSELECT時にIDを限定し、元行を変えず期限付きで通常保管へ渡す", async () => {
    await runActual(actualItems);
    vi.clearAllMocks();
    const before = sqlite.prepare("SELECT * FROM ir_disclosures").all();
    // 非対象の実行はこのmapでは資格不足になる。JSで後から除外してはいけない。
    vi.mocked(loadIngestCodeToId).mockResolvedValueOnce(new Map([[actualBatch[0].ticker, 1]]));
    const d1 = createD1(sqlite) as {prepare: (query: string) => unknown};
    const selected = vi.spyOn(d1, "prepare");
    const deadlineMs = Date.now() + 60_000;
    await resumeNotionByStock(makeDb(d1) as never, new Date("2026-10-07T00:00:00+09:00"),
      new Date("2026-10-08T00:00:00+09:00"), {tdnetId: actualBatch[0].tdnet_id, deadlineMs});
    expect(selected.mock.calls[0][0]).toContain('"ir_disclosures"."tdnet_id" = ?');
    const input = vi.mocked(upsertDisclosuresByStock).mock.calls[0][0];
    expect(input.rows.map(row => row.key)).toEqual([actualBatch[0].tdnet_id]);
    expect(input.rows[0].documentUrl).toBe(actualBatch[0].document_url);
    expect(input.deadlineMs).toBe(deadlineMs);
    expect(recordPrimaryData).not.toHaveBeenCalled();
    expect(sqlite.prepare("SELECT * FROM ir_disclosures").all()).toEqual(before);
  });

  it.each(["missing", "invalid_id", "expired", "unbounded"])("単一再開の%sは通常保管前に停止", async mode => {
    const exact = {tdnetId: mode === "invalid_id" ? "0" : "1279652",
      deadlineMs: Date.now() + (mode === "expired" ? -1 : mode === "unbounded" ? 3_660_000 : 60_000)};
    const d1 = createD1(sqlite) as {prepare: (query: string) => unknown};
    const selected = vi.spyOn(d1, "prepare");
    await expect(resumeNotionByStock(makeDb(d1) as never, new Date("2026-09-08T00:00:00+09:00"),
      new Date("2026-09-09T00:00:00+09:00"), exact)).rejects.toThrow();
    expect(upsertDisclosuresByStock).not.toHaveBeenCalled();
    expect(recordPrimaryData).not.toHaveBeenCalled();
    if (mode !== "missing") expect(selected).not.toHaveBeenCalled();
  });

  it("保存行/主体の読取中に期限が切れた場合はNotion保管を開始しない", async () => {
    await runActual(actualItems);
    vi.clearAllMocks();
    const nowMs = Date.now();
    const deadlineMs = nowMs + 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    vi.mocked(loadIngestCodeToId).mockImplementationOnce(async () => {
      clock.mockReturnValue(deadlineMs);
      return new Map([[actualBatch[0].ticker, 1]]);
    });
    try {
      await expect(resumeNotionByStock(makeDb(createD1(sqlite)) as never,
        new Date("2026-10-07T00:00:00+09:00"), new Date("2026-10-08T00:00:00+09:00"),
        {tdnetId: actualBatch[0].tdnet_id, deadlineMs})).rejects.toThrow("絶対締切");
      expect(upsertDisclosuresByStock).not.toHaveBeenCalled();
      expect(recordPrimaryData).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it.each([{status:null,insertApplied:false,mismatch:false},{status:"pending",insertApplied:true,mismatch:false},{status:"ok",insertApplied:false,mismatch:false},{status:"pending",insertApplied:true,mismatch:true}])("通常budgetは7日外の本文INSERT未完を保存ページへ限定し、一致INSERT再送0 (%j)", async ({status,insertApplied,mismatch}) => {
    const db = makeDb(createD1(sqlite));
    await ingestBatch(db as never, [{...ITEM, pubdate: jstDaysAgo(30)}], {batchKey: "saved", source: "declared ACK fault",
      archiveToNotion: false, notionByStock: false, codeToId: new Map([["1001", 1]])});
    sqlite.prepare("UPDATE ir_disclosures SET notion_page_id='existing',pdf_text_status=?").run(status);
    const id = sqlite.prepare("SELECT id FROM ir_disclosures").get()!.id;
    const text = "保存済み本文𠮷";
    if (insertApplied) {
      sqlite.prepare("INSERT INTO ir_disclosure_texts(disclosure_id,tdnet_id,text,char_count) VALUES(?,?,?,?)").run(id as number,ITEM.id,mismatch ? "既存の別本文" : text,mismatch ? "既存の別本文".length : text.length);
      sqlite.exec("CREATE TRIGGER prevent_repeat BEFORE INSERT ON ir_disclosure_texts BEGIN SELECT RAISE(ABORT, 'repeat insert'); END;");
    }
    vi.mocked(upsertDisclosuresByStock).mockImplementationOnce(async input => {
      expect(input.rows.map(r=>r.key)).toEqual([ITEM.id]);
      expect([...input.recoverPdfTextPages!]).toEqual([[ITEM.id,"existing"]]);
      input.onPagePersisted?.(ITEM.id,"existing");
      input.onPdfClassified?.(ITEM.id,{sentiment:"unknown",method:null,score:null,text});
      return {parentDbId:"db1",stocksTouched:1,created:0,updated:0,skippedExisting:1,skippedNoFile:0,rejudged:0,rowErrors:0,reachedDeadline:false,deadlineRemainderKeys:[],skippedNoFileKeys:[]};
    });
    const opts = {batchKey:"normal",source:"test",archiveToNotion:false,notionByStock:true,notionByStockBudgetMs:60_000,unsavedLookbackDays:40,codeToId:new Map([["1001",1]])};
    if (mismatch) {
      // Declared prior judgment values must stay untouched when source text qualification fails.
      sqlite.exec("UPDATE ir_disclosures SET pdf_sentiment='positive',pdf_sentiment_method='rule_v1',pdf_sentiment_score=1,pdf_sentiment_at=1");
      const sentimentSql = "SELECT pdf_sentiment,pdf_sentiment_method,pdf_sentiment_score,pdf_sentiment_at FROM ir_disclosures";
      const beforeSentiment = sqlite.prepare(sentimentSql).all();
      const before = sqlite.prepare("SELECT * FROM ir_disclosure_texts").all();
      await expect(ingestBatch(db as never,[],opts)).rejects.toThrow("上書きなし");
      expect(sqlite.prepare("SELECT * FROM ir_disclosure_texts").all()).toEqual(before);
      expect(sqlite.prepare(sentimentSql).all()).toEqual(beforeSentiment);
      expect(sqlite.prepare("SELECT pdf_text_status FROM ir_disclosures").get()!.pdf_text_status).toBe("pending");
      expect(recordPrimaryData).not.toHaveBeenCalled();
      return;
    }
    await ingestBatch(db as never,[],opts);
    expect(sqlite.prepare("SELECT pdf_text_status FROM ir_disclosures").get()!.pdf_text_status).toBe("ok");
    expect(sqlite.prepare("SELECT text,char_count FROM ir_disclosure_texts").get()).toEqual({text,char_count:text.length});
    await ingestBatch(db as never,[],opts);
    expect(upsertDisclosuresByStock).toHaveBeenCalledTimes(1);
    expect(recordPrimaryData).not.toHaveBeenCalled();
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
      expect([...input.recoverPdfTextPages!.keys()]).toEqual([ITEM.id]);
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
    expect([...vi.mocked(upsertDisclosuresByStock).mock.calls[1][0].recoverPdfTextPages!.keys()]).toEqual([]);
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

  it("同じ公開時刻は tdnetId 昇順", () => {
    const same = "2026-10-01T00:00:00.000Z";
    const older = "2026-09-01T00:00:00.000Z";
    // olderUnsaved を先に積む。key 比較が無い安定ソートなら n-2 が n-10 より前に残る。
    const selected = selectNotionArchiveRows({
      batchRows: [
        disclosureRow("n-10", same),
        disclosureRow("n-9", older),
      ],
      archivedKeys: new Set(),
      olderUnsaved: [disclosureRow("n-2", same)],
      limitToUnsaved: true,
    });
    expect(selected.rows.map((row) => row.key)).toEqual(["n-9", "n-10", "n-2"]);
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

  it("本文終端の notion_page_id がある行だけでは Notion を呼ばない", async () => {
    const db = makeDb(createD1(sqlite));
    const base = {
      batchKey: "saved-only",
      source: "test",
      archiveToNotion: false,
      codeToId: new Map([["1001", 1]]),
    };
    await ingestBatch(db as never, [ITEM], { ...base, notionByStock: false });
    sqlite.exec("UPDATE ir_disclosures SET notion_page_id='page-1',pdf_text_status='no_text'");
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
    sqlite.exec("UPDATE ir_disclosures SET pdf_text_status='no_text' WHERE tdnet_id='SAVED'");
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
      expect(logged).toContain("OUT"); // Declared contradictory stock_id/code is still rejected after the SQL scope filter.
      expect(logged).not.toContain("ANCIENT");
    } finally {
      warn.mockRestore();
    }
  });

  function insertEpoch(tdnetId: string, epochSeconds: number) {
    sqlite.prepare(
      `INSERT INTO ir_disclosures
        (stock_id, tdnet_id, company_code, company_name, title, pubdate, document_url, tags, notion_page_id)
       VALUES (1, ?, '10010', 'テスト1001', ?, ?, ?, '[]', NULL)`
    ).run(tdnetId, tdnetId, epochSeconds, `https://example.test/${tdnetId}.pdf`);
  }

  function seedTiedPubdates() {
    const same = Math.floor(Date.now() / 1000) - 10 * 86_400;
    insertEpoch("n-2", same);
    insertEpoch("n-9", same - 86_400);
    insertEpoch("n-10", same);
  }

  async function runTiedLookback() {
    const db = makeDb(createD1(sqlite));
    await ingestBatch(db as never, [], {
      batchKey: "same-pubdate",
      source: "test",
      archiveToNotion: false,
      notionByStock: true,
      notionByStockBudgetMs: 60_000,
      unsavedLookbackDays: 40,
      codeToId: new Map([["1001", 1]]),
    });
  }

  it("同じ公開時刻の未保存クエリは pubdate の次に tdnetId 昇順", async () => {
    seedTiedPubdates();
    const queries: string[] = [];
    const original = sqlite.prepare.bind(sqlite);
    sqlite.prepare = (sql: string) => {
      queries.push(sql);
      return original(sql);
    };
    try {
      await runTiedLookback();
      const tails = queries.flatMap((sql) => {
        const tail = orderByTail(sql);
        return tail === undefined ? [] : [tail];
      });
      expect(tails).toContain(TIED_PUBDATE_ORDER);
      expect(tails.every((tail) => tail === TIED_PUBDATE_ORDER)).toBe(true);
      const source = queries.find((sql) => orderByTail(sql) === TIED_PUBDATE_ORDER);
      if (source === undefined) throw new Error("並びの SQL が無い");
      const raw = /order\s+by\s+([\s\S]+?)(?:\s+limit\b|\s+offset\b|$)/i.exec(source);
      if (raw === null) throw new Error("order by を取り出せない");
      const ordered = original(`SELECT tdnet_id FROM ir_disclosures ORDER BY ${raw[1].trim()}`).all();
      expect(readTdnetIds(ordered)).toEqual(["n-9", "n-10", "n-2"]);
    } finally {
      sqlite.prepare = original;
    }
  });

  it("同じ公開時刻の未保存は tdnetId 昇順で Notion に渡す", async () => {
    seedTiedPubdates();
    await runTiedLookback();
    expect(upsertDisclosuresByStock).toHaveBeenCalledTimes(1);
    const rows = vi.mocked(upsertDisclosuresByStock).mock.calls[0]![0]!.rows;
    expect(rows.map((row) => row.key)).toEqual(["n-9", "n-10", "n-2"]);
  });
});

const TIED_PUBDATE_ORDER = "pubdate asc, tdnet_id asc";

function orderByTail(sql: string): string | undefined {
  const matched = /order\s+by\s+([\s\S]+?)(?:\s+limit\b|\s+offset\b|$)/i.exec(sql);
  if (matched === null) return undefined;
  return matched[1]
    .replace(/"/g, "")
    .replace(/ir_disclosures\./gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function readTdnetIds(rows: ReadonlyArray<Record<string, SQLOutputValue>>): string[] {
  return rows.map((row) => {
    const id = row.tdnet_id;
    if (typeof id !== "string" || id === "") throw new Error("tdnet_id が文字列ではありません");
    return id;
  });
}
