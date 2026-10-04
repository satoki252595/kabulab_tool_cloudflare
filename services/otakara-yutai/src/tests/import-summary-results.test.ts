/**
 * `import-summary-results.ts` の CLI 引数の配線と書き込み口を固定する。
 *
 * このファイルを import しても `main()` は走らない (D1 アクセス・`process.exit`
 * が無い) — `import-summary-results.ts` 側の実行ガードが対象。走ってしまうと
 * このテスト自体が CI で D1 に触ろうとしたり、`process.exit` でテストプロセスを
 * 落としたりする。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import {
  makeSummaryWriter,
  parseImportArgs,
  resolveTargetIds,
} from "../../data-scripts/import-summary-results.js";
import { loadBenefitRows, type OtakaraD1 } from "../../data-scripts/benefit-rows.js";
import { benefitKey } from "../../data-scripts/benefit-key.js";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";

function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split("--> statement-breakpoint")) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

describe("parseImportArgs", () => {
  it("--show-text / --apply を付けなければ既定で false", () => {
    const args = parseImportArgs(["--tasks", "t.jsonl", "--results", "r.jsonl"]);
    expect(args).toEqual({ tasks: "t.jsonl", results: "r.jsonl", apply: false, showText: false });
  });

  it("--show-text を付けると showText だけ true になる", () => {
    const args = parseImportArgs(["--tasks", "t.jsonl", "--results", "r.jsonl", "--show-text"]);
    expect(args.showText).toBe(true);
    expect(args.apply).toBe(false);
  });

  it("--apply を付けると apply だけ true になる", () => {
    const args = parseImportArgs(["--tasks", "t.jsonl", "--results", "r.jsonl", "--apply"]);
    expect(args.apply).toBe(true);
    expect(args.showText).toBe(false);
  });

  it("--tasks / --results を欠くとエラー", () => {
    expect(() => parseImportArgs(["--tasks", "t.jsonl"])).toThrow(/--tasks .* --results/);
    expect(() => parseImportArgs([])).toThrow(/--tasks .* --results/);
  });

  it("未知のオプションは strict:true ではじかれる (ERR_PARSE_ARGS_UNKNOWN_OPTION)", () => {
    expect(() => parseImportArgs(["--tasks", "t.jsonl", "--results", "r.jsonl", "--show-txt"])).toThrow();
  });
});

describe("resolveTargetIds", () => {
  const rows = [
    { id: 1, stockCode: "9101", description: "架空ギフト 1,000円相当" },
    { id: 2, stockCode: "9101", description: "架空ギフト 1,000円相当" },
    { id: 3, stockCode: "9102", description: "架空クーポン 500円相当" },
  ];

  it("書き込み予定があればその行だけ", () => {
    expect(resolveTargetIds([], rows, [{ ids: [3] }])).toEqual([3]);
  });

  it("予定が無ければタスク対象の行 (中断からの再開用)", () => {
    const tasks = [{ taskId: benefitKey("9101", "架空ギフト 1,000円相当") }];
    expect(resolveTargetIds(tasks, rows, [])).toEqual([1, 2]);
  });

  it("stale (今の D1 に無いキー) は寄与しない", () => {
    expect(resolveTargetIds([{ taskId: "0123456789abcdef" }], rows, [])).toEqual([]);
  });

  it("混合再開: 書き込み予定とタスク対象の和集合 (前回書込・今回 reject の行も追随)", () => {
    // 前回: 行 1,2 の要約を書いて中断。今回: 行 3 だけ updates (行 1,2 は reject)。
    // updates だけ見ると行 1,2 の利回りが置き去りになる
    const tasks = [{ taskId: benefitKey("9101", "架空ギフト 1,000円相当") }];
    expect(resolveTargetIds(tasks, rows, [{ ids: [3] }])).toEqual([3, 1, 2]);
  });
});

describe("makeSummaryWriter", () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    applyD1Migrations(sqlite);
    sqlite
      .prepare(
        "INSERT INTO core_stocks (id, code, name, market, is_active, is_yutai, instrument_type) VALUES (1, '9101', 'テスト', 'テスト市場', 1, 1, 'equity')"
      )
      .run();
    sqlite
      .prepare("INSERT INTO yutai_genres (id, name, slug, description) VALUES (1, 'その他', 'other', '')")
      .run();
    sqlite
      .prepare(
        "INSERT INTO yutai_benefits (id, stock_id, genre_id, description, min_shares, record_month, created_at, updated_at) VALUES (1, 1, 1, '架空', 100, 3, 1, 1)"
      )
      .run();
  });

  afterEach(() => {
    sqlite.close();
  });

  it.each([
    { isActive: 0, instrumentType: "equity" },
    { isActive: 1, instrumentType: "etf" },
  ])("要約対象は正常母集団に絞り、全行退避では母集団外を保持する ($isActive/$instrumentType)", async ({ isActive, instrumentType }) => {
    sqlite.prepare("UPDATE core_stocks SET is_active = ?, instrument_type = ? WHERE id = 1")
      .run(isActive, instrumentType);
    const before = sqlite.prepare("SELECT * FROM yutai_benefits").all();
    const db = drizzle(async (query, params) => {
      const stmt = sqlite.prepare(query);
      stmt.setReturnArrays(true);
      return { rows: stmt.all(...params as (null | number | bigint | string | Uint8Array)[]) };
    }) as unknown as OtakaraD1;
    expect(await loadBenefitRows(db, "active-equity")).toEqual([]);
    expect(await loadBenefitRows(db)).toHaveLength(1);
    sqlite.prepare("UPDATE core_stocks SET is_active = 1, instrument_type = 'equity' WHERE id = 1").run();
    expect(await loadBenefitRows(db, "active-equity")).toHaveLength(1);
    expect(sqlite.prepare("SELECT * FROM yutai_benefits").all()).toEqual(before);
  });

  it("4 列 (要約・推定値・出典・更新日時) を書く", async () => {
    const db = drizzle(async (sqlStr, params, method) => {
      const stmt = sqlite.prepare(sqlStr);
      const bind = params as (null | number | bigint | string | Uint8Array)[];
      if (method === "run") {
        stmt.run(...bind);
        return { rows: [] };
      }
      return { rows: [] };
    }) as unknown as BaseSQLiteDatabase<"async", unknown, Record<string, unknown>>;

    await makeSummaryWriter(db).update([1], {
      shortSummary: "要約",
      estimatedValue: 3000,
      estimateValueSource: "company",
    });

    const row = sqlite
      .prepare("SELECT short_summary, estimated_value, estimate_value_source, updated_at FROM yutai_benefits WHERE id = 1")
      .get() as {
      short_summary: string;
      estimated_value: number;
      estimate_value_source: string;
      updated_at: number;
    };
    expect(row.short_summary).toBe("要約");
    expect(row.estimated_value).toBe(3000);
    expect(row.estimate_value_source).toBe("company");
    // updated_at が打ち直される (旧値は 1)。いつ取り込んだか追えることが要点
    expect(row.updated_at).toBeGreaterThan(1);
  });
});
