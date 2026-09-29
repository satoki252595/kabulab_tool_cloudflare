/**
 * 共有 ingest の実 SQLite 原子性チェック (HOLD2 の 1 meaningful runnable check)。
 *
 * 本番の ingestDocument を実 node:sqlite (+ 実 D1 マイグレーション適用) に対して
 * 走らせ、次の 2 点を DB の実状態 (SELECT) で証明する。SQL 文字列や mock の
 * 呼出順だけでは原子性の証明にならないため、検証は全て実 SELECT の行比較。
 *
 *   - 非空 facts を伴う batch の途中失敗で document + 全 facts が旧状態に戻る
 *     (rollback)。故障は AFTER INSERT トリガ (実 SQLite 機構) で海外 facts
 *     挿入時に起こし、トリガ自身が WHEN で「受注行が既に書かれた後」のみ発火
 *     するため、ABORT 自体が「途中」到達の証明になる。
 *   - 正常保存後の同一入力の再入は送信 0 (binding 経路は batch 0、
 *     Node sender 経路は sender 呼出 0) で skipped_existing。
 *
 * mock する境界は bytes→facts の橋渡しだけ (download + 3 パーサ + CSV)。
 * パーサの戻す facts は全てコミット済み実 fixture を実パーサで解いた本物
 * (受注: patternB-1803-shimizu 10 件 / 海外: georows-single-col-sen 7 件。
 * いずれも非空 + 保存集合検証 PASS をプローブ済み)。dedup・保存集合検証・
 * batch 構築・dispatch・skip 判定は全て本番コード。bytes→facts の正しさ自体は
 * parser 系テスト (order/overseas/text-sections) が担う分担。
 * 定性 sections は [] 固定 (「抽出できる節が無い」正規 outcome。text 系は
 * text-sections.test.ts / text-backup.test.ts の担当)。
 *
 * 前提の分担: batch 輸送自体の原子性は D1 binding `DB.batch` の文書保証と
 * D1 REST `{batch}` の実証記録 (d1-http-client.ts の docstring) が担う。
 * 本チェックは「同梱すべき文が全て 1 batch に入っている」組成を証明する。
 * Node sender 経路の試験 sender は受信 SQL を逐次実行するだけで、REST の
 * 原子性は主張しない (成功時の SQL 正当性 + 再入 sender0 のみ見る)。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy";
import { ingestDocument } from "../services/ingest.js";
import { createDb, type Database } from "../db/client.js";
import { downloadDocument } from "../services/edinet/client.js";
import {
  parseEdinetCsvZip,
  type EdinetCsvRow,
} from "../services/edinet/csv.js";
import { parseOrderData, parseOrderHtml } from "../services/edinet/order-parser.js";
import {
  parseOverseasData,
  parseOverseasHtml,
  validateOverseasSaveSet,
} from "../services/overseas-parser.js";
import { extractTextSections } from "../services/edinet/text-sections.js";
import type { EdinetDoc } from "../services/edinet/types.js";
import type { D1BatchStatement } from "../../../../src/shared/db/d1-http-client.js";

vi.mock("../services/edinet/client.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/edinet/client.js")>();
  return { ...mod, downloadDocument: vi.fn() };
});
vi.mock("../services/edinet/csv.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/edinet/csv.js")>();
  return { ...mod, parseEdinetCsvZip: vi.fn() };
});
vi.mock("../services/edinet/order-parser.js", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../services/edinet/order-parser.js")>();
  return { ...mod, parseOrderData: vi.fn() };
});
vi.mock("../services/overseas-parser.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/overseas-parser.js")>();
  return { ...mod, parseOverseasData: vi.fn() };
});
vi.mock("../services/edinet/text-sections.js", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../services/edinet/text-sections.js")>();
  return { ...mod, extractTextSections: vi.fn() };
});

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (n: string) => readFileSync(join(FX, n), "utf8");
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split(
      "--> statement-breakpoint"
    )) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

/** drizzle-orm/d1 が触る範囲の D1Database シム。batch は実トランザクション。 */
function createD1(
  sqlite: DatabaseSync,
  counters: { batches: number; batchStmts: number }
): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spread = (params: unknown[]) => params as any[];
  const prepare = (query: string) => {
    const make = (params: unknown[]) => ({
      all: async () => ({ results: sqlite.prepare(query).all(...spread(params)) as unknown[], success: true, meta: {} }),
      raw: async () => {
        const stmt = sqlite.prepare(query);
        const names = stmt.columns().map((col) => col.name);
        const rows = stmt.all(...spread(params)) as Record<string, unknown>[];
        return rows.map((row) => names.map((n) => row[n]));
      },
      run: async () => {
        const r = sqlite.prepare(query).run(...spread(params));
        return {
          results: [],
          success: true,
          meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
        };
      },
      first: async (col?: string) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = sqlite.prepare(query).get(...spread(params)) as any;
        if (row === undefined) return null;
        return col === undefined ? row : row[col];
      },
      bind: (...next: unknown[]) => make(next),
      // batch() が取り出すための実 SQL + 束縛値 (drizzle はこの bound
      // object をそのまま client.batch へ渡す。d1/session.js で確認)。
      _testSql: query,
      _testParams: params,
    });
    return make([]);
  };
  return {
    prepare,
    batch: async (stmts: { _testSql: string; _testParams: unknown[] }[]) => {
      counters.batches += 1;
      counters.batchStmts += stmts.length;
      sqlite.exec("BEGIN");
      try {
        const out = stmts.map((s) => {
          const r = sqlite.prepare(s._testSql).run(...spread(s._testParams));
          return {
            success: true,
            meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
          };
        });
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

function annualDoc(docID: string): EdinetDoc {
  return {
    seqNumber: 1,
    docID,
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

describe("実SQLite 原子性 (HOLD2)", () => {
  it("非空facts batch の途中失敗は document+全facts を rollback し、正常同入力の再入は送信0", async () => {
    const restore = silenceConsole();
    const sqlite = new DatabaseSync(":memory:");
    try {
      applyD1Migrations(sqlite);
      sqlite
        .prepare(
          "INSERT INTO core_stocks (id, code, name, market, is_active, instrument_type, sector33) VALUES (11, '1001', 'テスト1001', 'プライム', 1, 'stock', '建設業')"
        )
        .run();
      // 旧文書 + 旧 facts (rollback 後に無傷であるべき実状態)。
      sqlite
        .prepare(
          "INSERT INTO yuho_documents (stock_id, edinet_code, doc_id, doc_type_code, filer_name, period_start, period_end, submitted_at, parse_status, honbun_file, overseas_parse_status, overseas_honbun_file, text_parse_status, notion_doc_page_id) VALUES (11, 'E00001', 'S100OLD001', '120', '旧提出者', '2023-04-01', '2024-03-31', 1719792000, 'ok_pattern_a', 'old-honbun.html', 'ok_geo_rows', 'old-honbun.html', 'ok', 'page-old')"
        )
        .run();
      const oldId = (
        sqlite
          .prepare("SELECT id FROM yuho_documents WHERE doc_id = 'S100OLD001'")
          .get() as { id: number }
      ).id;
      sqlite
        .prepare(
          "INSERT INTO yuho_order_facts (document_id, stock_id, fiscal_year_end, segment_name, segment_kind, unit_label, pattern) VALUES (?, 11, '2024-03-31', '旧セグA', 'segment', '百万円', 'pattern_a'), (?, 11, '2024-03-31', '旧セグB', 'segment', '百万円', 'pattern_a')"
        )
        .run(oldId, oldId);
      sqlite
        .prepare(
          "INSERT INTO yuho_overseas_facts (document_id, stock_id, fiscal_year_end, region_name, region_kind, unit_label, pattern) VALUES (?, 11, '2024-03-31', '旧地域', 'overseas', '百万円', 'geo_rows')"
        )
        .run(oldId);
      sqlite
        .prepare(
          "INSERT INTO yuho_text_sections (document_id, stock_id, fiscal_year_end, section_key, element_id, item_name, context_id, char_count) VALUES (?, 11, '2024-03-31', 'risks', 'jpcrp_cor:BusinessRisksTextBlock', '事業等のリスク', 'ctx-old', 10)"
        )
        .run(oldId);

      // 実 fixture を実パーサで解いた本物の facts (非空 + 検証 PASS を固定)。
      const orderEx = parseOrderHtml(fx("patternB-1803-shimizu.html"), "2025-03-31");
      expect(orderEx.status).toBe("ok_pattern_b");
      expect(orderEx.facts.length).toBeGreaterThan(0);
      const overseasEx = parseOverseasHtml(
        fx("georows-single-col-sen-S100W16I.html"),
        "2025-03-31"
      );
      expect(overseasEx.status).toBe("ok_geo_rows");
      expect(overseasEx.facts.length).toBeGreaterThan(0);
      expect(() =>
        validateOverseasSaveSet(overseasEx.facts, overseasEx.proof)
      ).not.toThrow();

      // bytes→facts の橋渡しだけ mock (戻りは上記の本物)。
      vi.mocked(downloadDocument).mockResolvedValue(Buffer.from("unused-by-parser-mocks"));
      const csvRow = (itemName: string): EdinetCsvRow => ({
        elementId: "e1",
        itemName,
        contextId: "c1",
        relativeYear: "CurrentYearDuration",
        consolidatedOrNonConsolidated: "連結",
        periodOrInstant: "期間",
        unitId: "u1",
        unit: "円",
        value: "v",
      });
      vi.mocked(parseEdinetCsvZip).mockReturnValue([
        csvRow("受注高"),
        csvRow("海外売上高"),
      ]);
      vi.mocked(parseOrderData).mockReturnValue({
        ...orderEx,
        honbunFile: "test-honbun.html",
      });
      vi.mocked(parseOverseasData).mockReturnValue({
        ...overseasEx,
        honbunFile: "test-honbun.html",
      });
      vi.mocked(extractTextSections).mockReturnValue([]);

      const dumpTables = () => ({
        docs: sqlite.prepare("SELECT * FROM yuho_documents ORDER BY id").all(),
        order: sqlite.prepare("SELECT * FROM yuho_order_facts ORDER BY id").all(),
        overseas: sqlite.prepare("SELECT * FROM yuho_overseas_facts ORDER BY id").all(),
        text: sqlite.prepare("SELECT * FROM yuho_text_sections ORDER BY id").all(),
      });

      // ---- Phase A: binding 経路 (本番の日次 Worker と同一形)。
      const counters = { batches: 0, batchStmts: 0 };
      const dbA = createDb(
        createD1(sqlite, counters) as unknown as Parameters<typeof createDb>[0]
      );
      const argsA = {
        stockId: 11,
        stockCode: "1001",
        doc: annualDoc("S100TESTA1"),
      };

      // 故障 leg: 海外 facts 挿入時に実トリガで ABORT。WHEN が「受注行が
      // 既に書かれた後」のみ発火するため、失敗自体が途中到達の証明になる。
      sqlite.exec(
        "CREATE TRIGGER t_hold2_fail AFTER INSERT ON yuho_overseas_facts " +
          "WHEN (SELECT COUNT(*) FROM yuho_order_facts WHERE document_id = NEW.document_id) > 0 " +
          "BEGIN SELECT RAISE(ABORT, 'HOLD2 injected mid-batch fault'); END"
      );
      const beforeFault = dumpTables();
      await expect(ingestDocument(dbA, argsA)).rejects.toThrow(
        "HOLD2 injected mid-batch fault"
      );
      // batch は実行された (空振りでない) かつ全表が旧状態のまま。
      expect(counters.batches).toBe(1);
      expect(dumpTables()).toEqual(beforeFault);
      expect(
        sqlite.prepare("SELECT id FROM yuho_documents WHERE doc_id = 'S100TESTA1'").get()
      ).toBeUndefined();
      sqlite.exec("DROP TRIGGER t_hold2_fail");

      // 成功 leg: 同一入力で完成する。行集合が実パーサ出力と一致する。
      const rA = await ingestDocument(dbA, argsA);
      expect(rA.outcome).toBe("ingested");
      expect(rA.parseStatus).toBe("ok_pattern_b");
      expect(rA.overseasParseStatus).toBe("ok_geo_rows");
      const docA = sqlite
        .prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100TESTA1'")
        .get() as Record<string, unknown>;
      expect(docA["parse_status"]).toBe("ok_pattern_b");
      const orderRowsA = sqlite
        .prepare("SELECT * FROM yuho_order_facts WHERE document_id = ?")
        .all(docA["id"] as number) as Record<string, unknown>[];
      expect(orderRowsA.length).toBeGreaterThan(0);
      expect(orderRowsA.length).toBe(rA.factCount);
      expect(
        new Set(orderRowsA.map((r) => `${r["fiscal_year_end"]} ${r["segment_name"]}`))
      ).toEqual(
        new Set(orderEx.facts.map((f) => `${f.fiscalYearEnd} ${f.segmentName}`))
      );
      const overseasRowsA = sqlite
        .prepare("SELECT * FROM yuho_overseas_facts WHERE document_id = ?")
        .all(docA["id"] as number) as Record<string, unknown>[];
      expect(overseasRowsA.length).toBeGreaterThan(0);
      expect(overseasRowsA.length).toBe(rA.overseasFactCount);
      expect(
        new Set(overseasRowsA.map((r) => `${r["fiscal_year_end"]} ${r["region_name"]}`))
      ).toEqual(
        new Set(overseasEx.facts.map((f) => `${f.fiscalYearEnd} ${f.regionName}`))
      );
      // 旧文書の行は無傷。
      expect(
        sqlite.prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100OLD001'").get()
      ).toEqual(beforeFault.docs[0]);

      // 再入 leg: 同一入力は skip で batch 追加 0・fetch 追加 0。
      const batchesAfterSuccess = counters.batches;
      const downloadsAfterSuccess = vi.mocked(downloadDocument).mock.calls.length;
      const rA2 = await ingestDocument(dbA, argsA);
      expect(rA2.outcome).toBe("skipped_existing");
      expect(counters.batches).toBe(batchesAfterSuccess);
      expect(vi.mocked(downloadDocument).mock.calls.length).toBe(downloadsAfterSuccess);

      // ---- Phase B: Node sender 経路 (proxy 読取 + 明示 sender 書込)。
      // 試験 sender は受信した本番生成 SQL を実 SQLite へ逐次実行する。
      // REST `{batch}` 自体の原子性は主張しない (成功時の SQL 正当性と
      // 再入 sender0 のみ)。proxy への書込 (method=run) が来たら即 throw —
      // 通れば per-statement 書込が無いことの構造証明になる。
      const proxyDb = drizzleProxy(async (sqlStr, params, method) => {
        if (method === "run") {
          throw new Error("proxy への書込は禁止 (Node 書込は sender のみのはず)");
        }
        const stmt = sqlite.prepare(sqlStr);
        const names = stmt.columns().map((col) => col.name);
        const rows = (
          stmt.all(...(params as never[])) as Record<string, unknown>[]
        ).map((row) => names.map((n) => row[n]));
        return { rows: method === "get" ? (rows[0] ?? []) : rows };
      });
      const senderCalls: (readonly D1BatchStatement[])[] = [];
      const sendB = async (statements: readonly D1BatchStatement[]): Promise<void> => {
        senderCalls.push(statements);
        for (const st of statements) {
          sqlite.prepare(st.sql).run(...(st.params as never[]));
        }
      };
      const argsB = {
        stockId: 11,
        stockCode: "1001",
        doc: annualDoc("S100TESTB1"),
        d1HttpBatch: sendB,
      };
      const rB = await ingestDocument(proxyDb as unknown as Database, argsB);
      expect(rB.outcome).toBe("ingested");
      expect(senderCalls).toHaveLength(1);
      const docB = sqlite
        .prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100TESTB1'")
        .get() as Record<string, unknown>;
      expect(docB["parse_status"]).toBe("ok_pattern_b");
      const orderRowsB = sqlite
        .prepare("SELECT * FROM yuho_order_facts WHERE document_id = ?")
        .all(docB["id"] as number) as Record<string, unknown>[];
      expect(orderRowsB.length).toBe(rA.factCount);
      const overseasRowsB = sqlite
        .prepare("SELECT * FROM yuho_overseas_facts WHERE document_id = ?")
        .all(docB["id"] as number) as Record<string, unknown>[];
      expect(overseasRowsB.length).toBe(rA.overseasFactCount);

      const rB2 = await ingestDocument(proxyDb as unknown as Database, argsB);
      expect(rB2.outcome).toBe("skipped_existing");
      expect(senderCalls).toHaveLength(1);
    } finally {
      sqlite.close();
      restore();
    }
  });
});
