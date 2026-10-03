/**
 * 共有 ingest の D1 batch backend 契約テスト (T0–T5)。
 *
 * 背景: `createD1HttpDb` (drizzle sqlite-proxy) の `db.batch` はメソッド自体は
 * 存在するが batch callback 未配線で実行時 TypeError になる。かつて upsert 先行
 * + 後続 batch の構成だったため、この未配線で「メタだけ埋まって facts 0 件」の
 * 部分行が残り、次回以降 skipped_existing で永久に埋まらなかった。
 * 対策: (1) 入口 preflight (明示 HTTP sender XOR 実 binding の有限 shape
 * ($client の prepare/batch + db.batch が呼び出し可能)。未知 backend は
 * fetch/remote save より前に止める)、(2) upsert・delete・全 insert の同一 batch
 * 化 + documentId の docId サブクエリ参照 (事前 upsert/id 取得の排除)。
 *
 * 本ファイルは実 ingestDocument を走らせる (mock は EDINET 取得と
 * Notion 側 3 関数。custody は呼出側指定で完備を渡し、単通照会はしない)。
 * CSV 入力は壊れバイト列で明示の parse_error 経路に入れ、書込形状だけを
 * 検証する (ソース fixture の捏造はしない。full raw replay もしない)。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy";
import { drizzle as drizzleD1, type AnyD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { ingestDocument } from "../services/ingest.js";
import type { Database } from "../db/client.js";
import { downloadDocument } from "../services/edinet/client.js";
import type { EdinetDoc } from "../services/edinet/types.js";
import type { D1BatchStatement } from "../../../../src/shared/db/d1-http-client.js";
import {
  findBackupRowsByKeys,
  recordPrimaryData,
  verifyArchivedAttachments,
} from "../../../../src/shared/notion-archive/index.js";

vi.mock("../services/edinet/client.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/edinet/client.js")>();
  return { ...mod, downloadDocument: vi.fn() };
});
vi.mock("../../../../src/shared/notion-archive/index.js", () => ({
  recordPrimaryData: vi.fn(),
  findBackupRowsByKeys: vi.fn(),
  verifyArchivedAttachments: vi.fn(),
}));

const download = vi.mocked(downloadDocument);

// raw-before-DB 既定 (archiveToNotion=true) のため Notion 側は静的成功。
// custody は呼出側指定で完備を渡す (T4/T5) ので単通照会は起きない。
vi.mocked(recordPrimaryData).mockResolvedValue({
  pageId: "page-batch",
  outcome: "recorded",
  fileTooLarge: false,
  manifestMatch: "written",
});
vi.mocked(findBackupRowsByKeys).mockResolvedValue([]);
vi.mocked(verifyArchivedAttachments).mockResolvedValue(undefined);

function annualDoc(): EdinetDoc {
  return {
    seqNumber: 1,
    docID: "S100TEST1",
    edinetCode: "E00001",
    secCode: "10010",
    JCN: null,
    filerName: "テスト提出者",
    ordinanceCode: "010",
    formCode: "030000",
    docTypeCode: "120",
    periodStart: "2024-04-01",
    periodEnd: "2025-03-31",
    submitDateTime: "2026-09-24 15:00",
    docDescription: "有価証券報告書",
    xbrlFlag: "1",
    csvFlag: "1",
    withdrawalStatus: "0",
  };
}

type ProxyCall = { sql: string; method: string };
function proxyDb(respond: (sql: string) => unknown[][]) {
  const calls: ProxyCall[] = [];
  const db = drizzleProxy(async (sqlStr, _params, method) => {
    calls.push({ sql: sqlStr, method });
    return { rows: respond(sqlStr) };
  });
  return { db, calls };
}

function senderDouble() {
  const calls: (readonly D1BatchStatement[])[] = [];
  let failNext: Error | null = null;
  const send = async (statements: readonly D1BatchStatement[]): Promise<void> => {
    calls.push(statements);
    if (failNext) {
      const e = failNext;
      failNext = null;
      throw e;
    }
  };
  return { calls, send, failOnce: (e: Error) => (failNext = e) };
}

function silenceConsole() {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  return () => {
    info.mockRestore();
    warn.mockRestore();
    err.mockRestore();
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("T0: 前提の固定 (sqlite-proxy の batch は未配線)", () => {
  it("createD1HttpDb と同一形 (callback + config) では $client 無し・batch は TypeError", async () => {
    const t = sqliteTable("t", { id: integer("id").primaryKey() });
    const db = drizzleProxy(async () => ({ rows: [] }), { schema: { t } });
    expect((db as unknown as { $client?: unknown }).$client).toBeUndefined();
    // typeof 判定が素通しする罠そのもの。preflight は $client の有限 shape
    // (prepare/batch 呼び出し可能) で判定する。有無だけでは null/{} が通る。
    expect(typeof db.batch).toBe("function");
    await expect(
      db.batch([db.delete(t).where(eq(t.id, 1))])
    ).rejects.toThrow(TypeError);
  });
});

describe("T1/T2: 入口 preflight (fetch/remote save より前)", () => {
  it("T1: sender 無しの proxy db は EDINET 取得・D1 利用ゼロで止まる", async () => {
    const restore = silenceConsole();
    try {
      download.mockRejectedValue(new Error("must-not-fetch"));
      const { db, calls } = proxyDb(() => {
        throw new Error("must-not-touch-d1");
      });
      await expect(
        ingestDocument(db as unknown as Database, {
          stockId: 11,
          stockCode: "1001",
          doc: annualDoc(),
        })
      ).rejects.toThrow(/batch backend/);
      expect(download).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    } finally {
      restore();
    }
  });

  it("T2: sender と binding の二重指定は sender 曖昧として止まる", async () => {
    const restore = silenceConsole();
    try {
      download.mockRejectedValue(new Error("must-not-fetch"));
      // 有限 shape を満たす $client = binding 相当。batch には到達しない。
      const db = drizzleD1(
        { prepare: () => {}, batch: async () => [] } as unknown as AnyD1Database
      );
      const sender = senderDouble();
      await expect(
        ingestDocument(db as unknown as Database, {
          stockId: 11,
          stockCode: "1001",
          doc: annualDoc(),
          d1HttpBatch: sender.send,
        })
      ).rejects.toThrow(/二重指定/);
      expect(download).not.toHaveBeenCalled();
      expect(sender.calls).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe("T3: 未知 backend 形 (null/{} の $client) は書込前に止まる", () => {
  it.each([["null", null], ["{}", {}]] as const)(
    "sender 無し + $client=%s は preflight で止まり fetch・D1 ゼロ",
    async (_label, client) => {
      const restore = silenceConsole();
      try {
        download.mockRejectedValue(new Error("must-not-fetch"));
        const db = drizzleD1(client as unknown as AnyD1Database);
        await expect(
          ingestDocument(db as unknown as Database, {
            stockId: 11,
            stockCode: "1001",
            doc: annualDoc(),
          })
        ).rejects.toThrow(/batch backend/);
        expect(download).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    }
  );
});

describe("T4: 原子失敗 (単一 batch・部分書込なし・再送なし・再実行で回復)", () => {
  it("sender 失敗で throw・proxy へ書込ゼロ・upsert 先頭・再実行で ingested", async () => {
    const restore = silenceConsole();
    try {
      download.mockResolvedValue(Buffer.from([0, 1, 2, 3]));
      const sender = senderDouble();
      sender.failOnce(new Error("D1 REST 500 (test)"));
      const { db, calls } = proxyDb(() => []);
      const args: Parameters<typeof ingestDocument>[1] = {
        stockId: 11,
        stockCode: "1001",
        doc: annualDoc(),
        d1HttpBatch: sender.send,
        custody: { t1: "complete", t5: "complete" },
      };

      await expect(ingestDocument(db as unknown as Database, args)).rejects.toThrow("D1 REST 500 (test)");
      // 単一 batch で再送なし。
      expect(sender.calls).toHaveLength(1);
      const batch = sender.calls[0];
      // 先頭が文書 upsert (batch 内包の証明) + delete 3 文。facts 0 件で insert 無し。
      expect(batch.length).toBe(4);
      expect(batch[0].sql).toMatch(/^insert into [`"]?yuho_documents/i);
      expect(batch[0].sql).toMatch(/on conflict/i);
      for (const st of batch.slice(1)) {
        expect(st.sql).toMatch(/^delete from/i);
        // documentId は docId サブクエリ参照 (JS の id 受け渡しなし)。
        expect(st.sql.toLowerCase()).toContain("select");
        expect(st.sql).toContain("yuho_documents");
        expect(st.sql).toContain("doc_id");
      }
      // サブクエリの束縛に docID 文字列が入る (行 id 数値の受け渡しではない)。
      expect(batch[1].params).toContain("S100TEST1");
      // proxy 経路へ書込は一切流れない (SELECT のみ = 部分書込なし)。
      const writes = calls.filter((c) => /^\s*(insert|update|delete)/i.test(c.sql));
      expect(writes).toEqual([]);
      expect(calls.length).toBeGreaterThan(0);

      // 同引数の再実行で回復する (sender 正常化後。回数は累積で 2)。
      const r = await ingestDocument(db as unknown as Database, args);
      expect(r.outcome).toBe("ingested");
      expect(sender.calls).toHaveLength(2);
    } finally {
      restore();
    }
  });
});

describe("T5: 同一入力の完了/再入場なし", () => {
  it.each([
    { parseStatus: "parse_error", overseasParseStatus: "parse_error", textParseStatus: "parse_error" },
    { parseStatus: "no_order_table", overseasParseStatus: null, textParseStatus: null },
  ] as const)("2 回目は保存状態 $parseStatus/$overseasParseStatus/$textParseStatus を保持し sender・EDINET 追加 0", async (saved) => {
    const restore = silenceConsole();
    try {
      download.mockResolvedValue(Buffer.from([0, 1, 2, 3]));
      const sender = senderDouble();
      // 1 回目: 未存在 → ingested。2 回目: 存在行 (text 未完でない) → skip。
      let exists = false;
      const { db } = proxyDb((sql) => {
        if (/^\s*select/i.test(sql) && /yuho_documents/.test(sql) && exists) {
          // 実 SELECT 順: id / 受注 / 海外 / 本文 / 会計期末 / Notion pointer。
          return [[7, saved.parseStatus, saved.overseasParseStatus, saved.textParseStatus,
            annualDoc().periodEnd, "page-x"]];
        }
        return [];
      });
      const args: Parameters<typeof ingestDocument>[1] = {
        stockId: 11,
        stockCode: "1001",
        doc: annualDoc(),
        d1HttpBatch: sender.send,
        custody: { t1: "complete", t5: "complete" },
      };

      const r1 = await ingestDocument(db as unknown as Database, args);
      expect(r1.outcome).toBe("ingested");
      expect(sender.calls).toHaveLength(1);
      expect(download).toHaveBeenCalledTimes(1);

      exists = true;
      const r2 = await ingestDocument(db as unknown as Database, args);
      expect(r2).toEqual({
        outcome: "skipped_existing",
        ...saved,
        factCount: 0,
        overseasFactCount: 0,
        textSectionCount: 0,
        periodEnd: annualDoc().periodEnd,
      });
      expect(sender.calls).toHaveLength(1);
      expect(download).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});
