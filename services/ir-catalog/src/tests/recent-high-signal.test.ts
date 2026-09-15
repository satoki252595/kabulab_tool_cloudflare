/**
 * `recentHighSignal` の部分索引駆動 (L-50) の検証。
 *
 * home/signals の「高シグナル最新 N 件」は `primary_tag` 索引で 7 タグ全件
 * (≈1.2 万行) を集めて TEMP B-TREE で並べ替えていた (12,485 rows_read)。
 * 部分索引 `ir_disclosures_high_signal_pubdate` (pubdate 順・高シグナル行
 * のみ) で引く。固定したい契約:
 *
 *   1. 高シグナル行だけが pubdate 降順で limit 件並ぶ (値)。
 *   2. WHERE の IN は束縛パラメータではなくリテラル列で、その集合は
 *      `HIGH_SIGNAL_TAGS` と一致する。`?` だと SQLite は部分索引の述語の
 *      含意を証明できず、部分索引を選ばない。
 *   3. 実行される SQL の形が、実際に部分索引を使う (EXPLAIN)。
 *      索引 DDL は生成マイグレーション (`drizzle/d1/*.sql`) から抜く —
 *      本番に当たる文そのものを見るため。
 *
 * 実 SQLite (node:sqlite) を D1 バインディング互換スタブに被せる
 * (services/swing-trading の signals 結合テストと同じ方式)。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as coreSchema from "../../../../src/shared/db/core-schema.js";
import * as irSchema from "../db/schema.js";
import { recentHighSignal } from "../services/query.js";
import { HIGH_SIGNAL_TAGS } from "../services/classify.js";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

/** recentHighSignal が触る列だけの手書き DDL */
const DDL = `
CREATE TABLE core_stocks (
  id integer PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  market text NOT NULL
);
CREATE TABLE ir_disclosures (
  id integer PRIMARY KEY AUTOINCREMENT,
  stock_id integer NOT NULL,
  tdnet_id text NOT NULL UNIQUE,
  title text NOT NULL,
  pubdate integer NOT NULL,
  document_url text NOT NULL,
  primary_tag text
);
CREATE INDEX ir_disclosures_stock_pubdate_idx ON ir_disclosures(stock_id, pubdate);
`;

/**
 * 生成マイグレーションから部分索引の CREATE 文を抜く。無ければ投げる
 * (索引が消えた・改名されたらテストごと落ちて気づく)。
 */
function partialIndexDdl(): string {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split("--> statement-breakpoint")) {
      const s = stmt.trim();
      if (s.startsWith("CREATE INDEX `ir_disclosures_high_signal_pubdate`")) return s;
    }
  }
  throw new Error("部分索引 ir_disclosures_high_signal_pubdate の CREATE 文が drizzle/d1/*.sql に無い");
}

function createD1(sqlite: DatabaseSync, executed: string[]): unknown {
  const prepare = (query: string) => {
    const make = (params: unknown[]) => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      all: async () => { executed.push(query); return { results: sqlite.prepare(query).all(...(params as any[])), success: true, meta: {} }; },
      raw: async () => {
        executed.push(query);
        const stmt = sqlite.prepare(query);
        const names = stmt.columns().map((col) => col.name);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = stmt.all(...(params as any[])) as Record<string, unknown>[];
        return rows.map((row) => names.map((n) => row[n]));
      },
      bind: (...next: unknown[]) => make(next),
    });
    return make([]);
  };
  return { prepare, batch: async () => [] };
}

let sqlite: DatabaseSync;
let executed: string[];

function makeDb(d1: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return drizzle(d1 as any, { schema: { ...coreSchema, ...irSchema } });
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(DDL);
  executed = [];
  const insStock = sqlite.prepare("INSERT INTO core_stocks (id, code, name, market) VALUES (?, ?, ?, ?)");
  insStock.run(1, "7203", "銘柄7203", "プライム");
  insStock.run(2, "7974", "銘柄7974", "プライム");
});

afterEach(() => {
  sqlite.close();
});

function seedDisclosure(stockId: number, tdnetId: string, tag: string | null, pubdate: number): void {
  sqlite.prepare(
    "INSERT INTO ir_disclosures (stock_id, tdnet_id, title, pubdate, document_url, primary_tag) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(stockId, tdnetId, `開示${tdnetId}`, pubdate, `https://example.invalid/${tdnetId}`, tag);
}

describe("recentHighSignal の部分索引駆動 (L-50)", () => {
  it("高シグナル行だけが pubdate 降順で limit 件並ぶ", async () => {
    seedDisclosure(1, "t1", "増配", 1000);
    seedDisclosure(2, "t2", "上方修正", 3000);
    seedDisclosure(1, "t3", "その他タグ", 9999); // 最新だが高シグナルではない
    seedDisclosure(2, "t4", null, 9998); // 未分類
    seedDisclosure(1, "t5", "自社株買い", 2000);

    const rows = await recentHighSignal(makeDb(createD1(sqlite, executed)), 2);

    expect(rows.map((r) => r.tdnetId)).toEqual(["t2", "t5"]);
    expect(rows[0].code).toBe("7974");
  });

  it("WHERE の IN は HIGH_SIGNAL_TAGS と一致するリテラル列 (束縛なし)", async () => {
    seedDisclosure(1, "t1", "増配", 1000);

    await recentHighSignal(makeDb(createD1(sqlite, executed)), 25);

    expect(executed).toHaveLength(1);
    const [query] = executed;
    // IN 句だけを抜く (LIMIT は束縛パラメータのまま)。
    const inClause = query.match(/IN \(([^)]*)\)/i)?.[1] ?? "";
    expect(inClause, "IN が束縛パラメータに戻っている (部分索引が使われない)").not.toContain("?");
    // 識別子はダブルクォートなので、シングルクォートは IN リストだけ。
    const literals = [...query.matchAll(/'((?:''|[^'])+)'/g)].map((m) => m[1].replace(/''/g, "'"));
    expect([...literals].sort()).toEqual([...HIGH_SIGNAL_TAGS].sort());
  });

  it("実行される SQL が部分索引を使う (EXPLAIN)", async () => {
    // 実規模の分布 (高シグナル約 1/3) + ANALYZE で planner に選ばせる。
    const tags = [...HIGH_SIGNAL_TAGS];
    const ins = sqlite.prepare(
      "INSERT INTO ir_disclosures (stock_id, tdnet_id, title, pubdate, document_url, primary_tag) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (let i = 0; i < 9000; i++) {
      const tag = i % 3 === 2 ? "その他タグ" : tags[i % tags.length];
      ins.run((i % 2) + 1, `bulk${i}`, `開示bulk${i}`, 1700000000 + i, `https://example.invalid/bulk${i}`, tag);
    }
    sqlite.exec(partialIndexDdl());
    sqlite.exec("ANALYZE");

    await recentHighSignal(makeDb(createD1(sqlite, executed)), 25);

    expect(executed).toHaveLength(1);
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${executed[0]}`).all() as Array<{ detail: string }>;
    const details = plan.map((r) => r.detail).join("\n");
    expect(details).toContain("USING INDEX ir_disclosures_high_signal_pubdate");
    expect(details).not.toContain("TEMP B-TREE");
  });
});
