/**
 * closed-44 executor の実 SQLite 検証 (synthetic seeds のみ・network 0)。
 *
 * - validate: own exact keys・status 閉 domain・numeric/unknown facts 形状。
 * - build: DELETE→INSERT→UPDATE の組成・unknown の INSERT なし・bind ≤100。
 * - apply (実 SELECT 判定): clean → APPLIED 全一致 / prestate 不一致 →
 *   HOLD 送信 0 / race 余剰行 → exact-set guard が DELETE を 0 行化。
 * - classify: APPLIED / NOOP_PRESTATE / MISMATCH の 3 値。
 *
 * batch 輸送自体の原子性は D1 側の保証・実証記録の分担
 * (d1-http-client.ts)。本テストは組成 + guard 意味 + 判定を証明する。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy";
import type { Database } from "../db/client.js";
import {
  applyOneDoc,
  buildDocBatch,
  classifyPost,
  doc16Equals,
  expectedPost,
  freezeStatements,
  q2SetEquals,
  validateDocRow,
  type ValidDoc,
} from "../../data-scripts/overseas-closed44-execute.js";
import { toD1BatchStatements } from "../../../../src/shared/db/d1-http-client.js";

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

function openLocal(): {
  sqlite: DatabaseSync;
  queryDb: Database;
  buildDb: Database;
} {
  const sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
  const queryDb = drizzleProxy(async (sqlStr, params, method) => {
    const stmt = sqlite.prepare(sqlStr);
    if (method === "run") {
      stmt.run(...(params as never[]));
      return { rows: [] };
    }
    const names = stmt.columns().map((col) => col.name);
    const rows = (
      stmt.all(...(params as never[])) as Record<string, unknown>[]
    ).map((row) => names.map((n) => row[n]));
    return { rows: method === "get" ? (rows[0] ?? []) : rows };
  }) as unknown as Database;
  const buildDb = drizzleProxy(async () => {
    throw new Error("builder が実行された (toSQL のみのはず)");
  }) as unknown as Database;
  return { sqlite, queryDb, buildDb };
}

const STOCK = 9001;
const SUBMIT_SEC = 1719792000;
const INGEST_SEC = 1727000000;
const iso = (s: number) => new Date(s * 1000).toISOString();

function seedAll(sqlite: DatabaseSync): void {
  sqlite
    .prepare(
      "INSERT INTO core_stocks (id, code, name, market, is_active, instrument_type, sector33) VALUES (?, '9001', '合成9001', 'プライム', 1, 'stock', '建設業')"
    )
    .run(STOCK);
}

/** synthetic doc16 (packet 形・ISO 時刻)。値は形状のみ。 */
function doc16(docId: string, id: number): Record<string, unknown> {
  return {
    id,
    stockId: STOCK,
    edinetCode: "E99999",
    docId,
    docTypeCode: "120",
    filerName: "合成株式会社",
    periodStart: "2024-04-01",
    periodEnd: "2025-03-31",
    submittedAt: iso(SUBMIT_SEC),
    parseStatus: "ok_pattern_a",
    honbunFile: "syn/honbun.htm",
    overseasParseStatus: "ok_geo_rows",
    overseasHonbunFile: "syn/old.htm",
    textParseStatus: "ok",
    notionDocPageId: null,
    ingestedAt: iso(INGEST_SEC),
  };
}

function insertDoc(sqlite: DatabaseSync, d: Record<string, unknown>): void {
  const args = [
    d["id"],
    d["stockId"],
    d["edinetCode"],
    d["docId"],
    d["docTypeCode"],
    d["filerName"],
    d["periodStart"],
    d["periodEnd"],
    SUBMIT_SEC,
    d["parseStatus"],
    d["honbunFile"],
    d["overseasParseStatus"],
    d["overseasHonbunFile"],
    d["textParseStatus"],
    d["notionDocPageId"],
    INGEST_SEC,
  ];
  sqlite
    .prepare(
      `INSERT INTO yuho_documents (id, stock_id, edinet_code, doc_id, doc_type_code, filer_name,
       period_start, period_end, submitted_at, parse_status, honbun_file,
       overseas_parse_status, overseas_honbun_file, text_parse_status,
       notion_doc_page_id, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(...(args as never[]));
}

/** synthetic Q2 行 (packet 形)。 */
function q2row(
  docId: string,
  id: number,
  docDbId: number,
  region: string,
  sales: number | null
): Record<string, unknown> {
  return {
    docId,
    id,
    documentId: docDbId,
    stockId: STOCK,
    fiscalYearEnd: "2025-03-31",
    regionName: region,
    regionKind: "overseas",
    isConsolidated: true,
    unitLabel: "合成円",
    salesRaw: sales,
    salesYen: sales === null ? null : sales * 1000,
    ratioPct: null,
    pattern: "geo_rows",
  };
}

function insertFact(sqlite: DatabaseSync, r: Record<string, unknown>): void {
  const args = [
    r["id"],
    r["documentId"],
    r["stockId"],
    r["fiscalYearEnd"],
    r["regionName"],
    r["regionKind"],
    1,
    r["unitLabel"],
    r["salesRaw"],
    r["salesYen"],
    r["ratioPct"],
    r["pattern"],
  ];
  sqlite
    .prepare(
      `INSERT INTO yuho_overseas_facts (id, document_id, stock_id, fiscal_year_end, region_name,
       region_kind, is_consolidated, unit_label, sales_raw, sales_yen, ratio_pct, pattern)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(...(args as never[]));
}

function packetRow(opts: {
  doc: string;
  id: number;
  numeric: boolean;
  q2: Record<string, unknown>[];
  newFacts: Record<string, unknown>[];
  status: string;
}): Record<string, unknown> {
  return {
    doc: opts.doc,
    stockId: STOCK,
    qual: opts.numeric
      ? "OFFLINE_CANDIDATE_NUMERIC"
      : "OFFLINE_CANDIDATE_UNSTRUCTURED",
    preimage: { doc16: doc16(opts.doc, opts.id) },
    q2: opts.q2,
    journal: {
      status: opts.status,
      honbunFile: "syn/new.htm",
      facts: opts.newFacts,
    },
    cas: {
      entire16SHA: "e",
      protectedSHA: "p",
      q2KeySHA: "k",
      q2RowsSHA: "r",
      reverified: true,
    },
  };
}

function newFact(region: string, sales: number | null): Record<string, unknown> {
  return {
    regionName: region,
    regionKind: "overseas",
    salesAmount: sales,
    ratioPct: null,
    unitLabel: "合成円",
    unitYenFactor: 1000,
    fiscalYearEnd: "2025-03-31",
    isConsolidated: true,
  };
}

/** sender: 記録 + 実 sqlite へ逐次実行 (原子性は D1 側の分担)。 */
function recordingSender(sqlite: DatabaseSync): {
  calls: { sql: string; params: unknown[] }[][];
  sender: (stmts: readonly { sql: string; params: unknown[] }[]) => Promise<void>;
} {
  const calls: { sql: string; params: unknown[] }[][] = [];
  return {
    calls,
    sender: async (stmts) => {
      calls.push(stmts.map((s) => ({ sql: s.sql, params: [...s.params] })));
      for (const s of stmts) {
        sqlite.prepare(s.sql).run(...(s.params as never[]));
      }
    },
  };
}

describe("validate", () => {
  it("numeric/unknown の正規行を受理する", () => {
    const q = [q2row("S100T0001", 1, 101, "合成州", 7)];
    const n = validateDocRow(
      packetRow({
        doc: "S100T0001",
        id: 101,
        numeric: true,
        q2: q,
        newFacts: [newFact("合成州", 7)],
        status: "ok_geo_rows",
      }),
      0
    );
    expect(n.numeric).toBe(true);
    const u = validateDocRow(
      packetRow({
        doc: "S100T0002",
        id: 102,
        numeric: false,
        q2: q,
        newFacts: [],
        status: "geo_present_unstructured",
      }),
      1
    );
    expect(u.numeric).toBe(false);
  });

  it("未知 status・形状違反・key 欠落を拒否する", () => {
    const q = [q2row("S100T0001", 1, 101, "合成州", 7)];
    const base = () =>
      packetRow({
        doc: "S100T0001",
        id: 101,
        numeric: true,
        q2: q,
        newFacts: [newFact("合成州", 7)],
        status: "ok_geo_rows",
      });
    const bad1 = base();
    (bad1["journal"] as Record<string, unknown>)["status"] = "mystery";
    expect(() => validateDocRow(bad1, 0)).toThrow();
    const bad2 = base();
    (bad2["journal"] as Record<string, unknown>)["facts"] = [];
    expect(() => validateDocRow(bad2, 0)).toThrow();
    const bad3 = packetRow({
      doc: "S100T0002",
      id: 102,
      numeric: false,
      q2: q,
      newFacts: [newFact("合成州", 7)],
      status: "geo_present_unstructured",
    });
    expect(() => validateDocRow(bad3, 0)).toThrow();
    const bad4 = base();
    const bad4pre = bad4["preimage"] as Record<string, unknown>;
    delete bad4pre["doc16"];
    expect(() => validateDocRow(bad4, 0)).toThrow();
  });
});

describe("build", () => {
  it("組成と bind 上限 (unknown は INSERT なし)", () => {
    const { buildDb } = openLocal();
    const mk = (numeric: boolean): ValidDoc =>
      validateDocRow(
        packetRow({
          doc: numeric ? "S100T0001" : "S100T0002",
          id: numeric ? 101 : 102,
          numeric,
          q2: [
            q2row("S100T0", 1, 101, "合成州甲", 7),
            q2row("S100T0", 2, 101, "合成州乙", null),
          ],
          newFacts: numeric ? [newFact("合成州甲", 7)] : [],
          status: numeric ? "ok_geo_cols" : "geo_present_unstructured",
        }),
        0
      );
    const nb = buildDocBatch(buildDb, mk(true));
    expect(nb.kinds).toEqual(["DELETE", "INSERT", "UPDATE"]);
    const ub = buildDocBatch(buildDb, mk(false));
    expect(ub.kinds).toEqual(["DELETE", "UPDATE"]);
    for (const [b, k] of [
      [nb, "n"],
      [ub, "u"],
    ] as const) {
      const stmts = freezeStatements(b.builders, b.kinds, k);
      for (const s of stmts) expect(s.params.length).toBeLessThanOrEqual(100);
    }
    const delSql = toD1BatchStatements(nb.builders)[0]?.sql ?? "";
    expect(delSql).toMatch(/delete/i);
    expect(delSql).toMatch(/count\(\*\)/i);
  });
});

describe("apply (実 sqlite)", () => {
  it("numeric clean → APPLIED (doc 2 列のみ更新・facts 置換)", async () => {
    const { sqlite, queryDb, buildDb } = openLocal();
    seedAll(sqlite);
    const d = doc16("S100T0001", 101);
    insertDoc(sqlite, d);
    const q = [
      q2row("S100T0001", 1, 101, "合成州甲", 7),
      q2row("S100T0001", 2, 101, "合成州乙", 3),
    ];
    for (const r of q) insertFact(sqlite, r);
    const doc = validateDocRow(
      packetRow({
        doc: "S100T0001",
        id: 101,
        numeric: true,
        q2: q,
        newFacts: [newFact("合成州甲", 9)],
        status: "ok_geo_cols",
      }),
      0
    );
    const rec = recordingSender(sqlite);
    const r = await applyOneDoc(
      { queryDb, sender: rec.sender as never },
      buildDb,
      doc
    );
    expect(r.outcome).toBe("APPLIED");
    expect(rec.calls.length).toBe(1);
    const post = sqlite
      .prepare("SELECT * FROM yuho_documents WHERE doc_id = 'S100T0001'")
      .all() as Record<string, unknown>[];
    expect(post.length).toBe(1);
    expect(post[0]?.["overseas_parse_status"]).toBe("ok_geo_cols");
    expect(post[0]?.["overseas_honbun_file"]).toBe("syn/new.htm");
    expect(post[0]?.["filer_name"]).toBe("合成株式会社");
    const facts = sqlite
      .prepare("SELECT region_name, sales_raw FROM yuho_overseas_facts WHERE document_id = 101")
      .all() as Record<string, unknown>[];
    expect(facts).toEqual([{ region_name: "合成州甲", sales_raw: 9 }]);
  });

  it("unknown clean → APPLIED (facts 空・status 更新)", async () => {
    const { sqlite, queryDb, buildDb } = openLocal();
    seedAll(sqlite);
    insertDoc(sqlite, doc16("S100T0002", 102));
    const q = [q2row("S100T0002", 5, 102, "合成州", 7)];
    for (const r of q) insertFact(sqlite, r);
    const doc = validateDocRow(
      packetRow({
        doc: "S100T0002",
        id: 102,
        numeric: false,
        q2: q,
        newFacts: [],
        status: "geo_present_unstructured",
      }),
      0
    );
    const rec = recordingSender(sqlite);
    const r = await applyOneDoc(
      { queryDb, sender: rec.sender as never },
      buildDb,
      doc
    );
    expect(r.outcome).toBe("APPLIED");
    const n = sqlite
      .prepare("SELECT COUNT(*) AS c FROM yuho_overseas_facts WHERE document_id = 102")
      .get() as { c: number };
    expect(n.c).toBe(0);
    const st = sqlite
      .prepare("SELECT overseas_parse_status AS s FROM yuho_documents WHERE doc_id = 'S100T0002'")
      .get() as { s: string };
    expect(st.s).toBe("geo_present_unstructured");
  });

  it("prestate 不一致 → HOLD_PRESTATE・送信 0・無変更", async () => {
    const { sqlite, queryDb, buildDb } = openLocal();
    seedAll(sqlite);
    insertDoc(sqlite, doc16("S100T0001", 101));
    const q = [q2row("S100T0001", 1, 101, "合成州甲", 7)];
    for (const r of q) insertFact(sqlite, r);
    sqlite
      .prepare("UPDATE yuho_overseas_facts SET sales_raw = 999 WHERE id = 1")
      .run();
    const doc = validateDocRow(
      packetRow({
        doc: "S100T0001",
        id: 101,
        numeric: true,
        q2: q,
        newFacts: [newFact("合成州甲", 7)],
        status: "ok_geo_rows",
      }),
      0
    );
    const rec = recordingSender(sqlite);
    const r = await applyOneDoc(
      { queryDb, sender: rec.sender as never },
      buildDb,
      doc
    );
    expect(r.outcome).toBe("HOLD_PRESTATE");
    expect(rec.calls.length).toBe(0);
    const v = sqlite
      .prepare("SELECT sales_raw AS s FROM yuho_overseas_facts WHERE id = 1")
      .get() as { s: number };
    expect(v.s).toBe(999);
  });

  it("race 余剰行 → DELETE guard が 0 行化 (live 無傷)", () => {
    const { sqlite, buildDb } = openLocal();
    seedAll(sqlite);
    insertDoc(sqlite, doc16("S100T0002", 102));
    const q = [q2row("S100T0002", 5, 102, "合成州", 7)];
    for (const r of q) insertFact(sqlite, r);
    sqlite
      .prepare(
        "INSERT INTO yuho_overseas_facts (document_id, stock_id, fiscal_year_end, region_name, region_kind, is_consolidated, unit_label, sales_raw, sales_yen, ratio_pct, pattern) VALUES (102, ?, '2025-03-31', '競合州', 'overseas', 1, '合成円', 1, 1000, NULL, 'geo_rows')"
      )
      .run(STOCK);
    const doc = validateDocRow(
      packetRow({
        doc: "S100T0002",
        id: 102,
        numeric: false,
        q2: q,
        newFacts: [],
        status: "geo_present_unstructured",
      }),
      0
    );
    const { builders } = buildDocBatch(buildDb, doc);
    const stmts = toD1BatchStatements(builders);
    const before = (
      sqlite
        .prepare("SELECT COUNT(*) AS c FROM yuho_overseas_facts WHERE document_id = 102")
        .get() as { c: number }
    ).c;
    expect(before).toBe(2);
    sqlite.prepare(stmts[0]?.sql ?? "").run(...((stmts[0]?.params ?? []) as never[]));
    const after = (
      sqlite
        .prepare("SELECT COUNT(*) AS c FROM yuho_overseas_facts WHERE document_id = 102")
        .get() as { c: number }
    ).c;
    expect(after).toBe(2);
  });
});

describe("classify/compare", () => {
  it("APPLIED / NOOP_PRESTATE / MISMATCH", () => {
    const d = doc16("S100T0001", 101);
    const q = [q2row("S100T0001", 1, 101, "合成州甲", 7)];
    const doc = validateDocRow(
      packetRow({
        doc: "S100T0001",
        id: 101,
        numeric: true,
        q2: q,
        newFacts: [newFact("合成州甲", 7)],
        status: "ok_geo_rows",
      }),
      0
    );
    const exp = expectedPost(doc);
    expect(doc16Equals({ ...d }, d)).toBe(true);
    expect(q2SetEquals([...q], q)).toBe(true);
    const appliedPost = {
      doc16: exp.doc16,
      q2: exp.facts.map((f, i) => ({ ...f, id: 900 + i, documentId: 101, stockId: STOCK })),
    };
    expect(
      classifyPost({ doc16: d, q2: q }, appliedPost, exp)
    ).toBe("APPLIED");
    expect(classifyPost({ doc16: d, q2: q }, { doc16: d, q2: q }, exp)).toBe(
      "NOOP_PRESTATE"
    );
    const tampered = {
      doc16: { ...exp.doc16 },
      q2: [{ ...appliedPost.q2[0], salesRaw: 12345 }].filter(Boolean) as Record<string, unknown>[],
    };
    expect(classifyPost({ doc16: d, q2: q }, tampered, exp)).toBe("MISMATCH");
  });
});
