/**
 * closed-44 executor の検証。
 *
 * 常時実行 (fixture 不要): 不正入力の fail-closed + grant gate。
 * actual44 (private fixture 必要): 全 44 通の build 固定 + 実 SQLite
 * での APPLIED 適用 + FIRST-断定 trip 時の atomic rollback 回帰。
 * fixture (0600 private packet) 不在の環境 (CI) では actual44 を
 * 明示 skip する。
 *
 * 合成の金融値・会社名 seed は使わない。DB-backed の全値は private
 * packet の actual captured 行由来 (in-memory のみ・repo に書かない)。
 * 失敗時出力に財務値が出ないよう、比較は正準 SHA・件数・ラベルのみ。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy";
import type { Database } from "../db/client.js";
import { parseOverseasData } from "../services/overseas-parser.js";
import { toOverseasSaveRows } from "../services/overseas-save-rows.js";
import {
  applyOneDoc,
  assertGrant,
  classifyPost,
  expectedPost,
  loadPacket,
  normDoc,
  normQ2,
  prefreezeDoc,
  serializeQ2,
  stateDigest,
  toUnixSec,
  validateDocRow,
  type LiveDeps,
  type ValidDoc,
} from "../../data-scripts/overseas-closed44-execute.js";
import type { D1BatchStatement } from "../../../../src/shared/db/d1-http-client.js";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const FIXTURE = "/tmp/overseas-closed44-qual-20260930/closed44-qual.json";
/** preflight 固定 pin との cross-lock (設計変更時は CODE review で更新)。 */


function tryLoadFixture(): { docs: ValidDoc[]; l2Stocks: number[] } | null {
  if (!existsSync(FIXTURE)) return null;
  return loadPacket(FIXTURE);
}

const FIX = tryLoadFixture();
const HAS_FIXTURE = FIX !== null;

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

function openLocal(): { sqlite: DatabaseSync; queryDb: Database; buildDb: Database } {
  const sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
  // This regression isolates document/fact CAS; no invented core parent rows.
  sqlite.exec("PRAGMA foreign_keys = OFF");
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

/** packet actual 行を live seed する (値は全て packet 由来)。 */
function seedActual(sqlite: DatabaseSync, doc: ValidDoc): void {
  const d = doc.doc16;
  sqlite
    .prepare(
      `INSERT INTO yuho_documents (id, stock_id, edinet_code, doc_id, doc_type_code, filer_name,
       period_start, period_end, submitted_at, parse_status, honbun_file,
       overseas_parse_status, overseas_honbun_file, text_parse_status,
       notion_doc_page_id, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(...([
      d["id"],
      d["stockId"],
      d["edinetCode"],
      d["docId"],
      d["docTypeCode"],
      d["filerName"],
      d["periodStart"],
      d["periodEnd"],
      toUnixSec(d["submittedAt"], "seed"),
      d["parseStatus"],
      d["honbunFile"],
      d["overseasParseStatus"],
      d["overseasHonbunFile"],
      d["textParseStatus"],
      d["notionDocPageId"],
      toUnixSec(d["ingestedAt"], "seed"),
    ] as never[]));
  for (const r of doc.q2) {
    const b = r["isConsolidated"];
    sqlite
      .prepare(
        `INSERT INTO yuho_overseas_facts (id, document_id, stock_id, fiscal_year_end, region_name,
         region_kind, is_consolidated, unit_label, sales_raw, sales_yen, ratio_pct, pattern)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(...([
        r["id"],
        r["documentId"],
        r["stockId"],
        r["fiscalYearEnd"],
        r["regionName"],
        r["regionKind"],
        b === null ? null : b ? 1 : 0,
        r["unitLabel"],
        r["salesRaw"],
        r["salesYen"],
        r["ratioPct"],
        r["pattern"],
      ] as never[]));
  }
}

/** live 全行の正準 SHA (値非開示の同一性比較用)。 */
function liveSnapshotSha(sqlite: DatabaseSync, docDbId: number): string {
  const doc = sqlite.prepare("SELECT * FROM yuho_documents WHERE id = ?").all(docDbId);
  const facts = sqlite
    .prepare("SELECT * FROM yuho_overseas_facts WHERE document_id = ? ORDER BY id")
    .all(docDbId);
  return stateDigest({ doc, facts });
}

function mkOutDir(tag: string): string {
  const dir = join(tmpdir(), `closed44-exec-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function mkDeps(sqlite: DatabaseSync, queryDb: Database, tag: string): LiveDeps {
  const outDir = mkOutDir(tag);
  // D1 batch 原子性の local 等価: BEGIN/COMMIT・失敗時 ROLLBACK。
  // (D1 REST batch 自体の原子性は d1-http-client の実証記録の分担。
  // 本テストは FIRST-trip-before-mutation の文順 + 無変更を証明する。)
  const sender = async (stmts: readonly D1BatchStatement[]): Promise<void> => {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const s of stmts) {
        sqlite.prepare(s.sql).run(...(s.params as never[]));
      }
      sqlite.exec("COMMIT");
    } catch (e) {
      sqlite.exec("ROLLBACK");
      throw e;
    }
  };
  return {
    queryDb,
    sender,
    ledger: join(outDir, "ledger.jsonl"),
    outDir,
    counters: { idx: 0, total: 1, sent: 0, applied: 0, held: 0 },
  };
}

/** sender 呼出回数の記録 wrapper。 */
function counting(deps: LiveDeps): { deps: LiveDeps; calls: () => number } {
  let n = 0;
  const inner = deps.sender;
  deps.sender = (async (s) => { n += 1; await inner(s); }) as LiveDeps["sender"];
  return { deps, calls: () => n };
}

describe("fail-closed garbage (fixture 不要)", () => {
  it("非 object・空・欠落を拒否する", () => {
    for (const bad of [null, undefined, 42, "x", [], {}]) {
      expect(() => validateDocRow(bad, 0)).toThrow();
    }
    expect(() => normDoc({}, "t")).toThrow();
    expect(() => normQ2({}, "t")).toThrow();
    expect(() => normDoc({ id: 1 }, "t")).toThrow();
    // undefined は null 化せず STOP。
    expect(() => normQ2({ id: undefined }, "t")).toThrow();
  });

  it("grant gate: 必須・bounded・printable", () => {
    expect(() => assertGrant(undefined)).toThrow();
    expect(() => assertGrant("")).toThrow();
    expect(() => assertGrant("x".repeat(129))).toThrow();
    expect(() => assertGrant("a\nb")).toThrow();
    expect(assertGrant("root-grant-1")).toBe("root-grant-1");
    expect(serializeQ2([], "t")).toBe("[]");
  });

  it("fixture 有無を明示する", () => {
    console.info(`[closed44-exec-test] actual44 fixture: ${HAS_FIXTURE ? "present" : "absent (skip)"}`);
    expect(typeof HAS_FIXTURE).toBe("boolean");
  });
});

describe.skipIf(!HAS_FIXTURE)("actual44 (private fixture)", () => {
  const docs = (FIX?.docs ?? []) as ValidDoc[];
  const numericDoc = docs.find((d) => d.numeric) as ValidDoc;
  const unknownDoc = docs.find((d) => !d.numeric) as ValidDoc;

  it("normal parser actual44 matches qualified12 and honest unknown32", () => {
    let numeric = 0;
    let unknown = 0;
    for (const doc of docs) {
      const raw = readFileSync(`/tmp/overseas_laneA_raw/${doc.docId}_t1.zip`);
      const parsed = parseOverseasData(raw, doc.doc16["periodEnd"] as string);
      // SHA-only comparisons prevent private financial values appearing in failures.
      expect(parsed.status === doc.newStatus).toBe(true);
      expect(parsed.honbunFile === doc.newHonbunFile).toBe(true);
      const actual = toOverseasSaveRows(parsed.facts, parsed.status).map(stateDigest).sort();
      const qualified = toOverseasSaveRows(doc.newFacts, doc.newStatus).map(stateDigest).sort();
      expect(stateDigest(actual) === stateDigest(qualified)).toBe(true);
      if (doc.numeric) numeric += 1;
      else { unknown += 1; expect(parsed.facts.length).toBe(0); }
    }
    expect(numeric).toBe(12);
    expect(unknown).toBe(32);
  }, 180_000);

  it("packet 44/44 + 内訳 12/32 + L2 10", () => {
    expect(docs.length).toBe(44);
    expect(docs.filter((d) => d.numeric).length).toBe(12);
    expect(docs.filter((d) => !d.numeric).length).toBe(32);
    const stocks = new Set(docs.map((d) => d.stockId));
    expect(stocks.size).toBe(10);
    for (const d of docs) {
      expect(d.q2.length).toBeGreaterThanOrEqual(1);
      expect(d.lineage.custody).toBe("A-anchored-same-bytes");
    }
  });

  it("numeric clean → APPLIED (post 正準一致)", async () => {
    const { sqlite, queryDb, buildDb } = openLocal();
    seedActual(sqlite, numericDoc);
    const { deps, calls } = counting(mkDeps(sqlite, queryDb, "num-apply"));
    const r = await applyOneDoc(deps, numericDoc, prefreezeDoc(buildDb, numericDoc));
    expect(r.outcome).toBe("APPLIED");
    expect(calls()).toBe(1);
    // post は expected と一致 (件数・label のみ比較。値は開示しない)。
    const docDbId = numericDoc.doc16["id"] as number;
    const liveDoc = sqlite.prepare("SELECT * FROM yuho_documents WHERE doc_id = ?").get(numericDoc.docId) as Record<string, unknown>;
    expect(liveDoc["overseas_parse_status"]).toBe(numericDoc.newStatus);
    expect(liveDoc["overseas_honbun_file"]).toBe(numericDoc.newHonbunFile);
    const n = sqlite.prepare("SELECT COUNT(*) AS c FROM yuho_overseas_facts WHERE document_id = ?").get(docDbId) as { c: number };
    expect(n.c).toBe(numericDoc.newFacts.length);
    // business 集合の正準ダイジェスト一致。
    const postBiz = (sqlite.prepare("SELECT fiscal_year_end, region_name, region_kind, is_consolidated, unit_label, sales_raw, sales_yen, ratio_pct, pattern FROM yuho_overseas_facts WHERE document_id = ? ORDER BY id").all(docDbId) as Record<string, unknown>[])
      .map((o) => stateDigest(o)).sort();
    const expBiz = expectedPost(numericDoc).facts
      .map((f) => stateDigest({
        fiscal_year_end: f["fiscalYearEnd"],
        region_name: f["regionName"],
        region_kind: f["regionKind"],
        is_consolidated: f["isConsolidated"] === null ? null : f["isConsolidated"] ? 1 : 0,
        unit_label: f["unitLabel"],
        sales_raw: f["salesRaw"],
        sales_yen: f["salesYen"],
        ratio_pct: f["ratioPct"],
        pattern: f["pattern"],
      })).sort();
    expect(postBiz).toEqual(expBiz);
  });

  it("actual NEWPOST reentry uses same writer and sends zero", async () => {
    const { sqlite, queryDb, buildDb } = openLocal();
    seedActual(sqlite, numericDoc);
    const batch = prefreezeDoc(buildDb, numericDoc);
    const first = counting(mkDeps(sqlite, queryDb, "post-first"));
    await applyOneDoc(first.deps, numericDoc, batch);
    const actualPost = liveSnapshotSha(sqlite, numericDoc.doc16["id"] as number);
    const second = counting(mkDeps(sqlite, queryDb, "post-reentry"));
    expect((await applyOneDoc(second.deps, numericDoc, batch)).outcome).toBe("MATCH");
    expect(second.calls()).toBe(0);
    expect(liveSnapshotSha(sqlite, numericDoc.doc16["id"] as number)).toBe(actualPost);
  });

  it.each(["doc", "one-fact", "fact-id", "membership"])("race %s throws before DML and preserves actual state", async (kind) => {
    const { sqlite, queryDb, buildDb } = openLocal();
    seedActual(sqlite, numericDoc);
    const id = numericDoc.doc16["id"] as number;
    const deps = mkDeps(sqlite, queryDb, `race-${kind}`);
    const realSender = deps.sender;
    let sends = 0;
    let raced = "";
    deps.sender = async (stmts) => {
      sends += 1;
      if (kind === "doc") sqlite.prepare("UPDATE yuho_documents SET filer_name = filer_name || '_fault' WHERE id = ?").run(id);
      else if (kind === "one-fact") sqlite.prepare("UPDATE yuho_overseas_facts SET sales_raw = COALESCE(sales_raw,0)+1 WHERE id = (SELECT MIN(id) FROM yuho_overseas_facts WHERE document_id = ?)").run(id);
      else if (kind === "fact-id") sqlite.prepare("UPDATE yuho_overseas_facts SET id = id + 10000000 WHERE document_id = ?").run(id);
      else sqlite.prepare("DELETE FROM yuho_overseas_facts WHERE id = (SELECT MIN(id) FROM yuho_overseas_facts WHERE document_id = ?)").run(id);
      raced = liveSnapshotSha(sqlite, id);
      await realSender(stmts);
    };
    await expect(applyOneDoc(deps, numericDoc, prefreezeDoc(buildDb, numericDoc))).rejects.toThrow();
    expect(sends).toBe(1);
    expect(deps.counters.applied).toBe(0);
    expect(liveSnapshotSha(sqlite, id)).toBe(raced);
  });

  it("unknown HTTP failure aborts instead of no-op classification", async () => {
    const { sqlite, queryDb, buildDb } = openLocal();
    seedActual(sqlite, numericDoc);
    const deps = mkDeps(sqlite, queryDb, "http-unknown");
    deps.sender = async () => { throw new Error("D1 HTTP error: unknown outcome"); };
    await expect(applyOneDoc(deps, numericDoc, prefreezeDoc(buildDb, numericDoc))).rejects.toThrow("unknown outcome");
    expect(deps.counters.sent).toBe(1);
    expect(deps.counters.applied).toBe(0);
  });

  it("prestate 不一致 → HOLD_PRESTATE・送信 0・無変更", async () => {
    const { sqlite, queryDb, buildDb } = openLocal();
    seedActual(sqlite, numericDoc);
    const id = numericDoc.doc16["id"] as number;
    const before = liveSnapshotSha(sqlite, id);
    sqlite.prepare("UPDATE yuho_overseas_facts SET sales_raw = COALESCE(sales_raw, 0) + 1 WHERE document_id = ?").run(id);
    const { deps, calls } = counting(mkDeps(sqlite, queryDb, "hold"));
    const r = await applyOneDoc(deps, numericDoc, prefreezeDoc(buildDb, numericDoc));
    expect(r.outcome).toBe("HOLD_PRESTATE");
    expect(calls()).toBe(0);
    const tampered = liveSnapshotSha(sqlite, id);
    expect(tampered).not.toBe(before);
  });

  it("FIRST trip → batch 全体 rollback・live 無傷", () => {
    const { sqlite, buildDb } = openLocal();
    seedActual(sqlite, numericDoc);
    const id = numericDoc.doc16["id"] as number;
    sqlite.prepare("UPDATE yuho_documents SET filer_name = filer_name || '_x' WHERE id = ?").run(id);
    const snap = liveSnapshotSha(sqlite, id);
    const { stmts } = prefreezeDoc(buildDb, numericDoc);
    // FIRST 単独でも trip する。
    expect(() => sqlite.prepare(stmts[0]?.sql ?? "").get(...((stmts[0]?.params ?? []) as never[]))).toThrow();
    // batch 全体は ROLLBACK で無変更。
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (const s of stmts) {
        sqlite.prepare(s.sql).run(...(s.params as never[]));
      }
      sqlite.exec("COMMIT");
      throw new Error("trip せず COMMIT した (障害)");
    } catch (e) {
      sqlite.exec("ROLLBACK");
      if ((e as Error).message.includes("trip せず")) throw e;
    }
    expect(liveSnapshotSha(sqlite, id)).toBe(snap);
    const n = sqlite.prepare("SELECT COUNT(*) AS c FROM yuho_overseas_facts WHERE document_id = ?").get(id) as { c: number };
    expect(n.c).toBe(numericDoc.q2.length);
  });

  it("unknown clean → APPLIED (facts 0・honest status)", async () => {
    const { sqlite, queryDb, buildDb } = openLocal();
    seedActual(sqlite, unknownDoc);
    const deps = mkDeps(sqlite, queryDb, "unk-apply");
    const r = await applyOneDoc(deps, unknownDoc, prefreezeDoc(buildDb, unknownDoc));
    expect(r.outcome).toBe("APPLIED");
    const id = unknownDoc.doc16["id"] as number;
    const n = sqlite.prepare("SELECT COUNT(*) AS c FROM yuho_overseas_facts WHERE document_id = ?").get(id) as { c: number };
    expect(n.c).toBe(0);
    const st = sqlite.prepare("SELECT overseas_parse_status AS s FROM yuho_documents WHERE id = ?").get(id) as { s: string };
    expect(st.s).toBe(unknownDoc.newStatus);
  });

  it("classify: post/expected の 3 値 (label のみ)", () => {
    const exp = expectedPost(numericDoc);
    const appliedQ2 = exp.facts.map((f, i) => ({ ...f, id: 100000 + i, documentId: numericDoc.doc16["id"], stockId: numericDoc.doc16["stockId"] }));
    expect(classifyPost({ doc16: numericDoc.doc16, q2: numericDoc.q2 }, { doc16: exp.doc16, q2: appliedQ2 }, exp)).toBe("APPLIED");
    expect(classifyPost({ doc16: numericDoc.doc16, q2: numericDoc.q2 }, { doc16: numericDoc.doc16, q2: numericDoc.q2 }, exp)).toBe("NOOP_PRESTATE");
    const first = { ...(appliedQ2[0] as Record<string, unknown>) };
    first["salesRaw"] = ((first["salesRaw"] as number | null) ?? 0) + 1;
    const tampered = { doc16: { ...exp.doc16 }, q2: [first] };
    expect(classifyPost({ doc16: numericDoc.doc16, q2: numericDoc.q2 }, tampered, exp)).toBe("MISMATCH");
  });

  it("norm/serialize: own-key 完備・undefined STOP・NULL 保持", () => {
    const d = normDoc(numericDoc.doc16, "t");
    expect(Object.keys(d).length).toBe(16);
    const q = normQ2(numericDoc.q2[0] as Record<string, unknown>, "t");
    expect(Object.keys(q).length).toBe(12);
    const s = serializeQ2(numericDoc.q2, "t");
    expect(JSON.parse(s).length).toBe(numericDoc.q2.length);
    const missing = { ...numericDoc.doc16 } as Record<string, unknown>;
    delete missing["filerName"];
    expect(() => normDoc(missing, "t")).toThrow();
    const undef = { ...numericDoc.q2[0] } as Record<string, unknown>;
    undef["salesRaw"] = undefined;
    expect(() => normQ2(undef, "t")).toThrow();
  });
});
