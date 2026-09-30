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
 * mock する境界は bytes→facts の橋渡し (download + 3 パーサ + CSV) と
 * Notion 側 (notion-archive 3 関数 + text-backup)。notion-archive は
 * key→pageId の stateful store で dedup (recorded/skipped_existing) と
 * custody 行を再現し、unique physical + readback 照合の通過を固定する。
 * パーサの戻す facts は全てコミット済み実 fixture を実パーサで解いた本物
 * (受注: patternB-1803-shimizu 10 件 / 海外: georows-2dproduct-sales
 * YBHC 非空 HOLD-clean 件。いずれも非空 + 保存集合検証 PASS を固定)。
 * dedup・保存集合検証・batch 構築・dispatch・skip 判定は全て本番コード。
 * bytes→facts の正しさ自体は parser 系テスト (order/overseas/text-sections)
 * が担う分担。既定の sections [] は「抽出できる節が無い」正規 outcome
 * (text 系は text-sections.test.ts / text-backup.test.ts の担当)。
 *
 * 第 2 describe は raw-before-DB 契約: 物理 ZIP の記録 (+同一 bytes 照合)
 * が DB batch より先で、失敗時は DB 旧値のまま throw すること、custody
 * 完備でも DB 書込ありは同一確認を通すこと (strict byte guard)、T1
 * 未提供の T5 単独と未知失敗の throw、text 本文の DBid 解決後保管を、
 * 実 SQLite の行と mock 呼出順で証明する。
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
import { describe, expect, it, vi, type Mock } from "vitest";
import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy";
import { ingestDocument } from "../services/ingest.js";
import { createDb, type Database } from "../db/client.js";
import {
  downloadDocument,
  EdinetNotFoundError,
} from "../services/edinet/client.js";
import {
  findBackupRowsByKeys,
  recordPrimaryData,
  verifyArchivedAttachments,
  type BackupRowState,
} from "../../../../src/shared/notion-archive/index.js";
import { backupDocTextToNotion } from "../services/text-backup.js";
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
vi.mock("../../../../src/shared/notion-archive/index.js", () => ({
  recordPrimaryData: vi.fn(),
  findBackupRowsByKeys: vi.fn(),
  verifyArchivedAttachments: vi.fn(),
}));
vi.mock("../services/text-backup.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/text-backup.js")>();
  return { ...mod, backupDocTextToNotion: vi.fn() };
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

/** Notion 側の stateful store (key → pageId)。dedup と custody 行を再現する。 */
const notionStore = new Map<string, string>();

function resetNotion(): void {
  notionStore.clear();
  vi.mocked(recordPrimaryData).mockReset();
  vi.mocked(findBackupRowsByKeys).mockReset();
  vi.mocked(verifyArchivedAttachments).mockReset();
  vi.mocked(recordPrimaryData).mockImplementation(async (input) => {
    const hit = notionStore.get(input.key);
    if (hit !== undefined && !input.force) {
      return {
        pageId: hit,
        outcome: "skipped_existing",
        fileTooLarge: false,
        manifestMatch: "unknown",
      } as const;
    }
    const pageId = `page-${input.key}`;
    notionStore.set(input.key, pageId);
    return {
      pageId,
      outcome: "recorded",
      fileTooLarge: false,
      manifestMatch: "written",
    } as const;
  });
  vi.mocked(findBackupRowsByKeys).mockImplementation(
    async (_service: string, keys: string[]): Promise<BackupRowState[]> =>
      keys
        .filter((k) => notionStore.has(k))
        .map((k) => ({ key: k, fileCount: 1, status: "recorded", metadata: {} }))
  );
  vi.mocked(verifyArchivedAttachments).mockResolvedValue(undefined);
}

/** 指定 docID の T5+T1 を保管済みとして事前 seed する (custody 完備の再現)。 */
function seedNotion(docID: string): void {
  notionStore.set(`${docID}:type5`, `page-${docID}:type5`);
  notionStore.set(`${docID}:type1`, `page-${docID}:type1`);
}

/** 全 mock 境界を既定に戻す (実 fixture 由来 facts + Notion 既定 + text 既定)。 */
function setupParserBridges(): void {
  vi.mocked(downloadDocument).mockReset();
  vi.mocked(parseEdinetCsvZip).mockReset();
  vi.mocked(parseOrderData).mockReset();
  vi.mocked(parseOverseasData).mockReset();
  vi.mocked(extractTextSections).mockReset();
  vi.mocked(backupDocTextToNotion).mockReset();
  resetNotion();
  const orderEx = parseOrderHtml(fx("patternB-1803-shimizu.html"), "2025-03-31");
  const overseasEx = parseOverseasHtml(
    fx("georows-2dproduct-sales-S100YBHC.html"),
    "2026-03-31"
  );
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
  vi.mocked(backupDocTextToNotion).mockResolvedValue({
    rowPageId: "text-row-1",
    outcome: "recorded",
  });
}

/** binding 経路の実 DB (stock 行つき) を 1 つ用意する。 */
function setupBindingDb(): {
  sqlite: DatabaseSync;
  db: Database;
  counters: { batches: number; batchStmts: number };
} {
  const sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
  sqlite
    .prepare(
      "INSERT INTO core_stocks (id, code, name, market, is_active, instrument_type, sector33) VALUES (11, '1001', 'テスト1001', 'プライム', 1, 'stock', '建設業')"
    )
    .run();
  const counters = { batches: 0, batchStmts: 0 };
  const db = createDb(
    createD1(sqlite, counters) as unknown as Parameters<typeof createDb>[0]
  );
  return { sqlite, db, counters };
}

/**
 * sender 経路の proxy + 実行 sender。allowRun=false は Phase B と同じく
 * proxy への書込を禁止し、sender 経由のみを構造証明する。text ポインタの
 * 書戻し (db.update) が要る試験だけ true にする。
 */
function setupSenderDb(sqlite: DatabaseSync, allowRun: boolean): {
  proxyDb: Database;
  sender: Mock<(statements: readonly D1BatchStatement[]) => Promise<void>>;
} {
  const proxyDb = drizzleProxy(async (sqlStr, params, method) => {
    if (method === "run") {
      if (!allowRun) {
        throw new Error("proxy への書込は禁止 (Node 書込は sender のみのはず)");
      }
      sqlite.prepare(sqlStr).run(...(params as never[]));
      return { rows: [] };
    }
    const stmt = sqlite.prepare(sqlStr);
    const names = stmt.columns().map((col) => col.name);
    const rows = (
      stmt.all(...(params as never[])) as Record<string, unknown>[]
    ).map((row) => names.map((n) => row[n]));
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  });
  const sender: Mock<(statements: readonly D1BatchStatement[]) => Promise<void>> =
    vi.fn(async (statements: readonly D1BatchStatement[]) => {
      for (const st of statements) {
        sqlite.prepare(st.sql).run(...(st.params as never[]));
      }
    });
  return { proxyDb: proxyDb as unknown as Database, sender };
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
      // W16I はその他 883 で地理未分類 HOLD のため、非空 facts には
      // clean な YBHC (P-2D 回復) を使う。原子性の意図は不変。
      const overseasEx = parseOverseasHtml(
        fx("georows-2dproduct-sales-S100YBHC.html"),
        "2026-03-31"
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
      vi.mocked(backupDocTextToNotion).mockResolvedValue({
        rowPageId: "text-row-1",
        outcome: "recorded",
      });
      resetNotion();

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
      // 故障 leg でも raw 記録は batch より先に完了 (record T5+T1 + verify)。
      expect(vi.mocked(recordPrimaryData).mock.calls.length).toBe(2);
      expect(vi.mocked(verifyArchivedAttachments).mock.calls.length).toBe(2);
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
      // 成功 leg: custody 完備でも DB 書込ありは同一確認を通す (guard +2)。
      expect(vi.mocked(recordPrimaryData).mock.calls.length).toBe(4);
      expect(vi.mocked(verifyArchivedAttachments).mock.calls.length).toBe(4);
      // 旧文書の行は無傷。
      expect(
        sqlite.prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100OLD001'").get()
      ).toEqual(beforeFault.docs[0]);

      // 再入 leg: 同一入力は skip で batch 追加 0・fetch 追加 0。
      const batchesAfterSuccess = counters.batches;
      const downloadsAfterSuccess = vi.mocked(downloadDocument).mock.calls.length;
      const recordsAfterSuccess = vi.mocked(recordPrimaryData).mock.calls.length;
      const rA2 = await ingestDocument(dbA, argsA);
      expect(rA2.outcome).toBe("skipped_existing");
      expect(counters.batches).toBe(batchesAfterSuccess);
      expect(vi.mocked(downloadDocument).mock.calls.length).toBe(downloadsAfterSuccess);
      // 既存 cache の再入は archive 呼出も 0 増 (早期 skip 維持)。
      expect(vi.mocked(recordPrimaryData).mock.calls.length).toBe(recordsAfterSuccess);

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
      // Phase B 新規通は custody 欠落 → 新規記録 +2。
      expect(vi.mocked(recordPrimaryData).mock.calls.length).toBe(6);
      expect(vi.mocked(verifyArchivedAttachments).mock.calls.length).toBe(6);
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
      expect(vi.mocked(recordPrimaryData).mock.calls.length).toBe(6);
      expect(vi.mocked(verifyArchivedAttachments).mock.calls.length).toBe(6);
    } finally {
      sqlite.close();
      restore();
    }
  });
});

describe("raw-before-DB 契約 (原本 mandatory)", () => {
  it("custody 完備 + DB 未取込でも parser 使用 bytes を同一確認してから DB へ (strict byte guard)", async () => {
    const restore = silenceConsole();
    const { sqlite } = setupBindingDb();
    try {
      setupParserBridges();
      seedNotion("S100GUARD1");
      const { proxyDb, sender } = setupSenderDb(sqlite, false);
      const r = await ingestDocument(proxyDb, {
        stockId: 11,
        stockCode: "1001",
        doc: annualDoc("S100GUARD1"),
        d1HttpBatch: sender,
      });
      expect(r.outcome).toBe("ingested");
      // guard: custody 完備でも type ごと 1 回の record (dedup skip) + verify。
      expect(vi.mocked(recordPrimaryData).mock.calls.length).toBe(2);
      expect(vi.mocked(verifyArchivedAttachments).mock.calls.length).toBe(2);
      expect(sender.mock.calls.length).toBe(1);
      const lastVerify = Math.max(
        ...vi.mocked(verifyArchivedAttachments).mock.invocationCallOrder
      );
      const firstBatch = Math.min(...sender.mock.invocationCallOrder);
      expect(lastVerify).toBeLessThan(firstBatch);
      // metadata は DBid 非依存。
      for (const c of vi.mocked(recordPrimaryData).mock.calls) {
        const meta = c[0].metadata as Record<string, unknown>;
        expect("docRowId" in meta).toBe(false);
        expect("documentId" in meta).toBe(false);
        expect(meta.docID).toBe("S100GUARD1");
      }
      // 実 DB 行が保存されている。
      const row = sqlite
        .prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100GUARD1'")
        .get() as { parse_status: string; overseas_parse_status: string };
      expect(row.parse_status).toBe("ok_pattern_b");
      expect(row.overseas_parse_status).toBe("ok_geo_rows");
    } finally {
      sqlite.close();
      restore();
    }
  });

  it("archiveToNotion=false は DB 書込前に明示 STOP し、fetch も DB も触らない", async () => {
    const restore = silenceConsole();
    const { sqlite, db, counters } = setupBindingDb();
    try {
      setupParserBridges();
      await expect(
        ingestDocument(db, {
          stockId: 11,
          stockCode: "1001",
          doc: annualDoc("S100NARG1"),
          archiveToNotion: false,
        })
      ).rejects.toThrow("raw-before-DB");
      expect(vi.mocked(downloadDocument).mock.calls.length).toBe(0);
      expect(counters.batches).toBe(0);
      expect(vi.mocked(recordPrimaryData).mock.calls.length).toBe(0);
      expect(vi.mocked(findBackupRowsByKeys).mock.calls.length).toBe(0);
      expect(
        sqlite.prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100NARG1'").get()
      ).toBeUndefined();
    } finally {
      sqlite.close();
      restore();
    }
  });

  it("record 失敗は DB 旧値のまま throw する (batch 0)", async () => {
    const restore = silenceConsole();
    const { sqlite, db, counters } = setupBindingDb();
    try {
      setupParserBridges();
      vi.mocked(recordPrimaryData).mockRejectedValueOnce(new Error("notion down"));
      await expect(
        ingestDocument(db, {
          stockId: 11,
          stockCode: "1001",
          doc: annualDoc("S100RECF1"),
        })
      ).rejects.toThrow("notion down");
      expect(counters.batches).toBe(0);
      expect(
        sqlite.prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100RECF1'").get()
      ).toBeUndefined();
    } finally {
      sqlite.close();
      restore();
    }
  });

  it("readback 照合の失敗は DB 旧値のまま throw する (batch 0)", async () => {
    const restore = silenceConsole();
    const { sqlite, db, counters } = setupBindingDb();
    try {
      setupParserBridges();
      vi.mocked(verifyArchivedAttachments).mockRejectedValueOnce(
        new Error("EDINET一次 S100VERF1:type5の readback 照合に失敗したため HOLD: SHA256 不一致")
      );
      await expect(
        ingestDocument(db, {
          stockId: 11,
          stockCode: "1001",
          doc: annualDoc("S100VERF1"),
        })
      ).rejects.toThrow("readback 照合に失敗");
      expect(counters.batches).toBe(0);
      expect(
        sqlite.prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100VERF1'").get()
      ).toBeUndefined();
    } finally {
      sqlite.close();
      restore();
    }
  });

  it("T1 未提供 (型付き 404) のみ T5 単独で進み、xbrlUnavailable を残す", async () => {
    const restore = silenceConsole();
    const { sqlite, db, counters } = setupBindingDb();
    try {
      setupParserBridges();
      vi.mocked(downloadDocument).mockImplementation(async (docId, docType) => {
        if (docType === 1) throw new EdinetNotFoundError(docId, docType);
        return Buffer.from("csv-bytes");
      });
      const r = await ingestDocument(db, {
        stockId: 11,
        stockCode: "1001",
        doc: annualDoc("S100T1NA1"),
      });
      expect(r.outcome).toBe("ingested");
      const keys = vi.mocked(recordPrimaryData).mock.calls.map((c) => c[0].key);
      expect(keys).toEqual(["S100T1NA1:type5"]);
      const meta = vi.mocked(recordPrimaryData).mock.calls[0][0]
        .metadata as Record<string, unknown>;
      expect(meta.xbrlUnavailable).toBe(true);
      expect(counters.batches).toBe(1);
      // XBRL なしで構造化不能 → parse_error を正直に記録し、facts は空。
      expect(r.parseStatus).toBe("parse_error");
      expect(r.overseasParseStatus).toBe("parse_error");
      expect(r.factCount).toBe(0);
      expect(r.overseasFactCount).toBe(0);
      const row = sqlite
        .prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100T1NA1'")
        .get() as { parse_status: string; overseas_parse_status: string };
      expect(row.parse_status).toBe("parse_error");
      expect(row.overseas_parse_status).toBe("parse_error");
      expect(vi.mocked(backupDocTextToNotion).mock.calls.length).toBe(0);
    } finally {
      sqlite.close();
      restore();
    }
  });

  it("T1 未知失敗は throw し、DB も記録も触らない (無断 T5 単独にしない)", async () => {
    const restore = silenceConsole();
    const { sqlite, db, counters } = setupBindingDb();
    try {
      setupParserBridges();
      vi.mocked(downloadDocument).mockImplementation(async (docId, docType) => {
        if (docType === 1) throw new Error(`edinet 500 docID=${docId}`);
        return Buffer.from("csv-bytes");
      });
      await expect(
        ingestDocument(db, {
          stockId: 11,
          stockCode: "1001",
          doc: annualDoc("S100T1UK1"),
        })
      ).rejects.toThrow("edinet 500");
      expect(counters.batches).toBe(0);
      expect(vi.mocked(recordPrimaryData).mock.calls.length).toBe(0);
      expect(
        sqlite.prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100T1UK1'").get()
      ).toBeUndefined();
    } finally {
      sqlite.close();
      restore();
    }
  });

  it("text 本文は DBid 解決後に保管し、実 id を渡して書戻す", async () => {
    const restore = silenceConsole();
    const { sqlite } = setupBindingDb();
    try {
      setupParserBridges();
      vi.mocked(extractTextSections).mockReturnValue([
        {
          sectionKey: "risks",
          text: "リスク本文",
          charCount: 5,
          elementId: "e1",
          itemName: "事業等のリスク",
          contextId: "c1",
        },
      ]);
      const { proxyDb, sender } = setupSenderDb(sqlite, true);
      const r = await ingestDocument(proxyDb, {
        stockId: 11,
        stockCode: "1001",
        doc: annualDoc("S100TEXT1"),
        d1HttpBatch: sender,
      });
      expect(r.outcome).toBe("ingested");
      expect(r.textParseStatus).toBe("ok");
      expect(sender.mock.calls.length).toBe(1);
      expect(vi.mocked(backupDocTextToNotion).mock.calls.length).toBe(1);
      // batch より後に text 保管 (順序)。
      const batchOrder = Math.min(...sender.mock.invocationCallOrder);
      const textOrder = Math.min(
        ...vi.mocked(backupDocTextToNotion).mock.invocationCallOrder
      );
      expect(batchOrder).toBeLessThan(textOrder);
      // 実 id の連携: SELECT の id と backup 引数が一致し、書戻しが残る。
      const row = sqlite
        .prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100TEXT1'")
        .get() as { id: number; notion_doc_page_id: string };
      expect(vi.mocked(backupDocTextToNotion).mock.calls[0][0].d1DocumentId).toBe(
        row.id
      );
      expect(row.notion_doc_page_id).toBe("text-row-1");
    } finally {
      sqlite.close();
      restore();
    }
  });
});
