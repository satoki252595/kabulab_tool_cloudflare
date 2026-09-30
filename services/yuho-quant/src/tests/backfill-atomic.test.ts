/**
 * 同根 2 backfill (text-sections / missing-docs) の実 SQLite 原子性チェック。
 *
 * 両 CLI は top-level await で import できないため、D1 書込の正本は
 * data-scripts/lib/ の builder 関数に切り出してある。本ファイルはその正本を
 * 実 node:sqlite (+ 実 D1 マイグレーション適用) に対して走らせ、DB の実状態で
 * 証明する (ingest-atomic.test.ts と同一方式)。
 *
 *   - text: 通常選定が ok+pointer-NULL 通を含むこと (既存 173 と同一の再開条件)
 *   - text/missing: 非空 facts を伴う batch の途中失敗 (実トリガ) で
 *     status + 旧 facts が全 rollback されること
 *   - text/missing: 同一入力の通常再実行で完成すること (通常再開)
 *
 * facts は全て本物: 受注・海外はコミット済み実 fixture を実パーサで解いた出力、
 * 定性は最小構造 CSV 行 (text-sections.test.ts と同一方式) を実抽出器で解いた
 * 出力。batch 輸送自体の原子性は D1 REST `{batch}` の実証記録
 * (d1-http-client.ts の docstring) が担い、試験 sender はそれを模した
 * BEGIN/COMMIT/ROLLBACK で実行する — 組成 (同梱すべき文が全て 1 batch 内)
 * の証明が本チェックの対象。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy";
import type { Database } from "../db/client.js";
import { yuhoDocuments } from "../db/schema.js";
import { toD1BatchStatements } from "../../../../src/shared/db/d1-http-client.js";
import {
  buildTextBackfillStatements,
  textBackfillWhere,
} from "../../data-scripts/lib/text-backfill.js";
import {
  buildMissingDocStatements,
  dedupeOrders,
} from "../../data-scripts/lib/missing-backfill.js";
import { parseOrderHtml } from "../services/edinet/order-parser.js";
import {
  parseOverseasHtml,
  validateOverseasSaveSet,
} from "../services/overseas-parser.js";
import {
  extractTextSections,
  TEXT_SECTIONS,
} from "../services/edinet/text-sections.js";
import type { EdinetCsvRow } from "../services/edinet/csv.js";

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

function csvRow(partial: Partial<EdinetCsvRow> & { value: string }): EdinetCsvRow {
  return {
    elementId: "jpcrp_cor:BusinessRisksTextBlock",
    itemName: "事業等のリスク [テキストブロック]",
    contextId: "提出日時点",
    relativeYear: "提出日時点",
    consolidatedOrNonConsolidated: "その他",
    periodOrInstant: "時点",
    unitId: "",
    unit: "",
    ...partial,
  };
}

function silenceConsole() {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => warn.mockRestore();
}

function openDb(): {
  sqlite: DatabaseSync;
  /** SELECT 実行用 (選定テスト)。書込が来たら throw (構造証明)。 */
  execDb: ReturnType<typeof drizzleProxy>;
  /** builder 構築用。await されたら throw (toSQL は純粋なはず)。 */
  buildDb: Database;
} {
  const sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
  const execDb = drizzleProxy(async (sqlStr, params, method) => {
    if (method === "run") {
      throw new Error("proxy への書込は禁止 (書込は sender batch のみのはず)");
    }
    const stmt = sqlite.prepare(sqlStr);
    const names = stmt.columns().map((col) => col.name);
    const rows = (
      stmt.all(...(params as never[])) as Record<string, unknown>[]
    ).map((row) => names.map((n) => row[n]));
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  });
  const buildDb = drizzleProxy(async () => {
    throw new Error("builder が実行された (toSQL のみのはず)");
  }) as unknown as Database;
  return { sqlite, execDb, buildDb };
}

function seedStock(sqlite: DatabaseSync): void {
  sqlite
    .prepare(
      "INSERT INTO core_stocks (id, code, name, market, is_active, instrument_type, sector33) VALUES (11, '1001', 'テスト1001', 'プライム', 1, 'stock', '建設業')"
    )
    .run();
}

describe("text-sections: 通常選定 (ok+pointer-NULL 再開)", () => {
  it("未処理と ok+pointer-NULL を拾い、完成済みを外す", async () => {
    const { sqlite, execDb } = openDb();
    try {
      seedStock(sqlite);
      const seed = (docId: string, status: string | null, page: string | null) =>
        sqlite
          .prepare(
            "INSERT INTO yuho_documents (stock_id, edinet_code, doc_id, doc_type_code, filer_name, period_end, submitted_at, parse_status, text_parse_status, notion_doc_page_id) VALUES (11, 'E00001', ?, '120', 'テスト', '2025-03-31', 1719792000, 'ok_pattern_a', ?, ?)"
          )
          .run(docId, status, page);
      seed("S100NULL01", null, null);
      seed("S100OKNOPTR", "ok", null);
      seed("S100OKPTR", "ok", "page-x");
      seed("S100NOTEXT", "no_text_sections", null);

      const pick = async (docFilter: string[] | null, force: boolean) =>
        (
          await execDb
            .select({ docId: yuhoDocuments.docId })
            .from(yuhoDocuments)
            .where(textBackfillWhere(docFilter, force))
        ).map((r) => r.docId as string);

      // 通常: 未処理 + ok+pointer-NULL (Notion 失敗後の force 不要な復帰)。
      expect(new Set(await pick(null, false))).toEqual(
        new Set(["S100NULL01", "S100OKNOPTR"])
      );
      // --doc 絞り (force 無し): 選定条件と docFilter の積。
      expect(new Set(await pick(["S100OKNOPTR", "S100OKPTR"], false))).toEqual(
        new Set(["S100OKNOPTR"])
      );
      // force: 全件。
      expect(new Set(await pick(null, true))).toEqual(
        new Set(["S100NULL01", "S100OKNOPTR", "S100OKPTR", "S100NOTEXT"])
      );
    } finally {
      sqlite.close();
    }
  });
});

describe("text-sections: batch 途中失敗は status+旧索引を rollback し通常再開で完成", () => {
  it("実トリガ失敗→全表旧状態→再実行で 9 節完成→ok+NULL で再選定", async () => {
    const restore = silenceConsole();
    const { sqlite, execDb, buildDb } = openDb();
    try {
      seedStock(sqlite);
      sqlite
        .prepare(
          "INSERT INTO yuho_documents (stock_id, edinet_code, doc_id, doc_type_code, filer_name, period_end, submitted_at, parse_status, text_parse_status, notion_doc_page_id) VALUES (11, 'E00001', 'S100TEXT01', '120', 'テスト', '2025-03-31', 1719792000, 'ok_pattern_a', NULL, NULL)"
        )
        .run();
      const target = (
        sqlite
          .prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100TEXT01'")
          .get() as { id: number }
      ).id;
      sqlite
        .prepare(
          "INSERT INTO yuho_text_sections (document_id, stock_id, fiscal_year_end, section_key, element_id, item_name, context_id, char_count) VALUES (?, 11, '2025-03-31', 'risks', 'e-old', '旧リスク', 'ctx-old', 5)"
        )
        .run(target);

      // 実抽出器による 9 節 (2 insert 文に分割される非空集合)。
      const sections = extractTextSections(
        TEXT_SECTIONS.slice(0, 9).map((d, i) =>
          csvRow({
            elementId: `jpcrp_cor:Section${i}TextBlock`,
            itemName: d.title,
            value: `<p>${d.title}の本文${i}</p>`,
          })
        )
      );
      expect(sections).toHaveLength(9);

      const runBatch = () => {
        const statements = buildTextBackfillStatements(
          buildDb,
          {
            id: target,
            stockId: 11,
            docId: "S100TEXT01",
            periodEnd: "2025-03-31",
            filerName: "テスト",
          },
          "ok",
          sections
        );
        // [update, delete, insert×2] の 4 文 (batch 輸送は検証済み包みで実行)。
        const batch = toD1BatchStatements(statements);
        expect(batch).toHaveLength(4);
        sqlite.exec("BEGIN");
        try {
          for (const st of batch) {
            sqlite.prepare(st.sql).run(...(st.params as never[]));
          }
          sqlite.exec("COMMIT");
        } catch (e) {
          sqlite.exec("ROLLBACK");
          throw e;
        }
      };

      const dump = () => ({
        docs: sqlite.prepare("SELECT * FROM yuho_documents ORDER BY id").all(),
        text: sqlite.prepare("SELECT * FROM yuho_text_sections ORDER BY id").all(),
      });

      // 故障 leg: 2 行目挿入で ABORT (update+delete+insert 途中まで実行済み)。
      sqlite.exec(
        "CREATE TRIGGER t_text_fail AFTER INSERT ON yuho_text_sections " +
          "WHEN (SELECT COUNT(*) FROM yuho_text_sections WHERE document_id = NEW.document_id) > 0 " +
          "BEGIN SELECT RAISE(ABORT, 'text injected mid-batch fault'); END"
      );
      const before = dump();
      expect(() => runBatch()).toThrow("text injected mid-batch fault");
      expect(dump()).toEqual(before);
      sqlite.exec("DROP TRIGGER t_text_fail");

      // 通常再開 leg: 同一入力で完成する。
      runBatch();
      const doc = sqlite
        .prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100TEXT01'")
        .get() as Record<string, unknown>;
      expect(doc["text_parse_status"]).toBe("ok");
      const rows = sqlite
        .prepare("SELECT * FROM yuho_text_sections WHERE document_id = ?")
        .all(target) as Record<string, unknown>[];
      expect(new Set(rows.map((r) => r["section_key"]))).toEqual(
        new Set(sections.map((s) => s.sectionKey))
      );

      // Notion 未保管 (pointer NULL) のままなら次回通常選定で再び拾われる。
      const picked = (
        await execDb
          .select({ docId: yuhoDocuments.docId })
          .from(yuhoDocuments)
          .where(textBackfillWhere(null, false))
      ).map((r) => r.docId as string);
      expect(picked).toContain("S100TEXT01");
    } finally {
      sqlite.close();
      restore();
    }
  });
});

describe("missing-docs: batch 途中失敗は文書+3表を rollback し通常再開で完成", () => {
  it("実トリガ失敗→全表旧状態+文書未作成→再実行で 3 表完成→再入冪等", async () => {
    const restore = silenceConsole();
    const { sqlite, buildDb } = openDb();
    try {
      seedStock(sqlite);
      sqlite
        .prepare(
          "INSERT INTO yuho_documents (stock_id, edinet_code, doc_id, doc_type_code, filer_name, period_end, submitted_at, parse_status, honbun_file, overseas_parse_status, text_parse_status) VALUES (11, 'E00001', 'S100OLDM01', '120', '旧提出者', '2024-03-31', 1719792000, 'ok_pattern_a', 'old.html', 'ok_geo_rows', 'ok')"
        )
        .run();
      const oldId = (
        sqlite
          .prepare("SELECT id FROM yuho_documents WHERE doc_id = 'S100OLDM01'")
          .get() as { id: number }
      ).id;
      sqlite
        .prepare(
          "INSERT INTO yuho_order_facts (document_id, stock_id, fiscal_year_end, segment_name, segment_kind, unit_label, pattern) VALUES (?, 11, '2024-03-31', '旧セグ', 'segment', '百万円', 'pattern_a')"
        )
        .run(oldId);
      sqlite
        .prepare(
          "INSERT INTO yuho_overseas_facts (document_id, stock_id, fiscal_year_end, region_name, region_kind, unit_label, pattern) VALUES (?, 11, '2024-03-31', '旧地域', 'overseas', '百万円', 'geo_rows')"
        )
        .run(oldId);
      sqlite
        .prepare(
          "INSERT INTO yuho_text_sections (document_id, stock_id, fiscal_year_end, section_key, element_id, item_name, context_id, char_count) VALUES (?, 11, '2024-03-31', 'risks', 'e-old', '旧', 'ctx', 1)"
        )
        .run(oldId);

      // 実パーサ由来の非空 facts + 実抽出器の 3 節。
      const orderEx = parseOrderHtml(fx("patternB-1803-shimizu.html"), "2025-03-31");
      const deduped = dedupeOrders(orderEx.facts, "S100MISS01");
      expect(deduped.length).toBeGreaterThan(0);
      // W16I はその他 883 で地理未分類 HOLD のため、非空 facts には
      // clean な YBHC (P-2D 回復) を使う。原子性の意図は不変。
      const overseasEx = parseOverseasHtml(
        fx("georows-2dproduct-sales-S100YBHC.html"),
        "2026-03-31"
      );
      expect(overseasEx.facts.length).toBeGreaterThan(0);
      expect(() =>
        validateOverseasSaveSet(overseasEx.facts, overseasEx.proof)
      ).not.toThrow();
      const sections = extractTextSections(
        TEXT_SECTIONS.slice(0, 3).map((d, i) =>
          csvRow({
            elementId: `jpcrp_cor:Section${i}TextBlock`,
            itemName: d.title,
            value: `<p>${d.title}の本文${i}</p>`,
          })
        )
      );
      expect(sections).toHaveLength(3);

      const runBatch = () => {
        const statements = buildMissingDocStatements(buildDb, {
          stockId: 11,
          docId: "S100MISS01",
          edinetCode: "E00001",
          docTypeCode: "120",
          filerName: "テスト提出者",
          periodStart: "2024-04-01",
          periodEnd: "2025-03-31",
          submittedAt: new Date(Date.UTC(2026, 8, 24, 15, 0)),
          parseStatus: "ok_pattern_b",
          honbunFile: "test-honbun.html",
          overseasParseStatus: "ok_geo_rows",
          overseasHonbunFile: "test-honbun.html",
          textParseStatus: "ok",
          deduped,
          overseasFacts: overseasEx.facts,
          sections,
        });
        const batch = toD1BatchStatements(statements);
        // upsert + 受注(del+ins×2) + 海外(del+ins) + 定性(del+ins) = 8 文。
        expect(batch).toHaveLength(8);
        sqlite.exec("BEGIN");
        try {
          for (const st of batch) {
            sqlite.prepare(st.sql).run(...(st.params as never[]));
          }
          sqlite.exec("COMMIT");
        } catch (e) {
          sqlite.exec("ROLLBACK");
          throw e;
        }
      };

      const dump = () => ({
        docs: sqlite.prepare("SELECT * FROM yuho_documents ORDER BY id").all(),
        order: sqlite.prepare("SELECT * FROM yuho_order_facts ORDER BY id").all(),
        overseas: sqlite.prepare("SELECT * FROM yuho_overseas_facts ORDER BY id").all(),
        text: sqlite.prepare("SELECT * FROM yuho_text_sections ORDER BY id").all(),
      });

      // 故障 leg: 海外挿入で ABORT (受注行が書かれた後 = 途中到達の証明)。
      sqlite.exec(
        "CREATE TRIGGER t_missing_fail AFTER INSERT ON yuho_overseas_facts " +
          "WHEN (SELECT COUNT(*) FROM yuho_order_facts WHERE document_id = NEW.document_id) > 0 " +
          "BEGIN SELECT RAISE(ABORT, 'missing injected mid-batch fault'); END"
      );
      const before = dump();
      expect(() => runBatch()).toThrow("missing injected mid-batch fault");
      expect(dump()).toEqual(before);
      expect(
        sqlite.prepare("SELECT id FROM yuho_documents WHERE doc_id = 'S100MISS01'").get()
      ).toBeUndefined();
      sqlite.exec("DROP TRIGGER t_missing_fail");

      // 通常再開 leg: 同一入力で文書 + 3 表が完成する。
      runBatch();
      const doc = sqlite
        .prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100MISS01'")
        .get() as Record<string, unknown>;
      expect(doc["parse_status"]).toBe("ok_pattern_b");
      expect(doc["overseas_parse_status"]).toBe("ok_geo_rows");
      expect(doc["text_parse_status"]).toBe("ok");
      const docId = doc["id"] as number;
      const orderRows = sqlite
        .prepare("SELECT * FROM yuho_order_facts WHERE document_id = ?")
        .all(docId) as Record<string, unknown>[];
      expect(
        new Set(orderRows.map((r) => `${r["fiscal_year_end"]} ${r["segment_name"]}`))
      ).toEqual(new Set(deduped.map((f) => `${f.fiscalYearEnd} ${f.segmentName}`)));
      const overseasRows = sqlite
        .prepare("SELECT * FROM yuho_overseas_facts WHERE document_id = ?")
        .all(docId) as Record<string, unknown>[];
      expect(overseasRows.length).toBe(overseasEx.facts.length);
      const textRows = sqlite
        .prepare("SELECT * FROM yuho_text_sections WHERE document_id = ?")
        .all(docId) as Record<string, unknown>[];
      expect(
        new Set(textRows.map((r) => r["section_key"]))
      ).toEqual(new Set(sections.map((s) => s.sectionKey)));

      // 再入冪等: 同一 batch の再実行で文書 1 行・内容集合は不変。
      runBatch();
      expect(
        sqlite
          .prepare("SELECT COUNT(*) AS n FROM yuho_documents WHERE doc_id = 'S100MISS01'")
          .get()
      ).toEqual({ n: 1 });
      const orderRows2 = sqlite
        .prepare("SELECT * FROM yuho_order_facts WHERE document_id = ?")
        .all(docId) as Record<string, unknown>[];
      expect(
        new Set(orderRows2.map((r) => `${r["fiscal_year_end"]} ${r["segment_name"]}`))
      ).toEqual(new Set(deduped.map((f) => `${f.fiscalYearEnd} ${f.segmentName}`)));
    } finally {
      sqlite.close();
      restore();
    }
  });
});
