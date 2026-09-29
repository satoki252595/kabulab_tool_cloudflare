/**
 * jpx-margin-sector (33 業種別信用残高) の取得・解析テスト。
 *
 * 合成 snapshot (行の形だけ実 PDF に合わせ、銘柄・数値は架空) +
 * 合成 mapping で純粋集計を検証する。D1 読み (`loadMarginSectorMaps`) は
 * moneyflow-sector.test.ts と同方式の node:sqlite + D1 マイグレーションで
 * 実 SQL (activeEquityCondition) を検証する。R2/JPX への取得はしない。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as coreSchema from "../../../../src/shared/db/core-schema.js";
import { JPX_33_SECTORS } from "../sector-names.js";
import {
  aggregateMarginSectors,
  buildMarginSectorInput,
  loadMarginSectorMaps,
  parseMarginSectorInput,
} from "./jpx-margin-sector.js";
import {
  synthSectorFixture,
  synthSnapshot,
} from "./margin-sector-fixture.js";

describe("buildMarginSectorInput", () => {
  it("coverage を正しく分類する (matched/除外4種/重複/未分類)", () => {
    const { rows, tickerSector, master } = synthSectorFixture();
    const mapping = buildMarginSectorInput(synthSnapshot(rows) as never, tickerSector, master);
    expect(mapping.coverage.universe).toBe(38);
    // 33 + 複数行 1 + 未分類 1 = 35 行 matched。
    expect(mapping.coverage.matched).toBe(35);
    expect(mapping.coverage.excludedNoTicker).toEqual(["14900"]);
    expect(mapping.coverage.excludedNotInMaster).toEqual(["9999"]);
    expect(mapping.coverage.excludedOutsideActiveEquity).toEqual(["8888"]);
    expect(mapping.coverage.duplicateTickers).toEqual([{ ticker: "1001", codes: ["10010", "10011"] }]);
    expect(mapping.coverage.unclassifiedRows).toBe(1);
    expect(mapping.snapshotKey).toBe("margin/daily/2026-09-28.json");
  });
});

describe("aggregateMarginSectors", () => {
  it("33 業種 + 未分類を集計し、合計 + 除外 = 総合計が一致する", () => {
    const { rows, tickerSector, master } = synthSectorFixture();
    const snapshot = synthSnapshot(rows) as never;
    const mapping = buildMarginSectorInput(snapshot, tickerSector, master);
    const { sectors, reconcile } = aggregateMarginSectors(snapshot, mapping);
    expect(sectors).toHaveLength(34);
    expect(sectors.map((s) => s.sector)).toEqual([...JPX_33_SECTORS, "未分類"]);
    // 水産・農林業 (1001): 2 行合算 (100+7, 200+8)。
    const fish = sectors[0]!;
    expect(fish.stockCount).toBe(1);
    expect(fish.rowCount).toBe(2);
    expect(fish.shares.sell).toBe(107);
    expect(fish.shares.buy).toBe(208);
    expect(fish.amounts.sell).toBe(107000);
    // 化学 (null 混じり): 前日比は null 伝播、残高は合算。
    const chem = sectors.find((s) => s.sector === "化学")!;
    expect(chem.shares.sell).toBe(106);
    expect(chem.sharesChg.sell).toBeNull();
    expect(chem.sharesChg.buy).toBe(2);
    // 未分類。
    const un = sectors.find((s) => s.sector === "未分類")!;
    expect(un.rowCount).toBe(1);
    expect(un.shares.sell).toBe(3);
    // 照合: セクター合計 + 除外 = 総合計。
    const totalSell = rows.reduce((a, r) => a + r.shares.sellOutstanding, 0);
    expect(reconcile.shares.sell + reconcile.excludedShares.sell).toBe(totalSell);
    expect(reconcile.grandShares.sell).toBe(totalSell);
  });

  it("33 業種のいずれかが空なら STOP する", () => {
    const { rows, tickerSector, master } = synthSectorFixture();
    // 海運業 (index 21) の行を落とす。
    const cut = rows.filter((r) => r.sourceCode !== "10220");
    const snapshot = synthSnapshot(cut) as never;
    const mapping = buildMarginSectorInput(snapshot, tickerSector, master);
    expect(() => aggregateMarginSectors(snapshot, mapping)).toThrow(/33 業種と一致しません/);
  });

  it("capture coverage の改竄は replay 不一致で STOP する", () => {
    const { rows, tickerSector, master } = synthSectorFixture();
    const snapshot = synthSnapshot(rows) as never;
    const mapping = buildMarginSectorInput(snapshot, tickerSector, master);
    const tampered = { ...mapping, coverage: { ...mapping.coverage, matched: 34 } };
    expect(() => aggregateMarginSectors(snapshot, tampered)).toThrow(/replay が一致しません/);
  });

  it("parseMarginSectorInput は形状違反を STOP する", () => {
    const { rows, tickerSector, master } = synthSectorFixture();
    const mapping = buildMarginSectorInput(synthSnapshot(rows) as never, tickerSector, master);
    expect(parseMarginSectorInput(JSON.parse(JSON.stringify(mapping)))).toMatchObject({
      basisDate: "2026-09-28",
    });
    expect(() => parseMarginSectorInput({ ...mapping, format: "x" })).toThrow(/形式タグ/);
    expect(() => parseMarginSectorInput({ ...mapping, pdfSha256: "zz" })).toThrow(/pdfSha256/);
  });
});

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split("--> statement-breakpoint")) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

let sqlite: DatabaseSync;

function makeProxyDb(target: DatabaseSync) {
  return drizzle(
    async (sqlStr, params, method) => {
      const stmt = target.prepare(sqlStr);
      const bind = params as (null | number | bigint | string | Uint8Array)[];
      if (method === "run") {
        stmt.run(...bind);
        return { rows: [] };
      }
      const objs = stmt.all(...bind) as Record<string, unknown>[];
      const rows = objs.map((o) => Object.values(o));
      return { rows: method === "get" ? (rows[0] ?? []) : rows };
    },
    { schema: { ...coreSchema } },
  );
}

describe("loadMarginSectorMaps (実 SQL)", () => {
  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    applyD1Migrations(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  function seedStock(opts: {
    id: number;
    code: string;
    sector: string | null;
    active?: boolean;
    instrumentType?: string | null;
  }): void {
    sqlite
      .prepare(
        "INSERT INTO core_stocks (id, code, name, market, sector, is_active, instrument_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        opts.id,
        opts.code,
        `銘柄${opts.id}`,
        "プライム",
        opts.sector,
        opts.active === false ? 0 : 1,
        opts.instrumentType === undefined ? "equity" : opts.instrumentType,
      );
  }

  it("active かつ equity だけ mapping に載り、master は全件", async () => {
    seedStock({ id: 1, code: "1001", sector: "化学" });
    seedStock({ id: 2, code: "1002", sector: null });
    seedStock({ id: 3, code: "1003", sector: "化学", active: false });
    seedStock({ id: 4, code: "1004", sector: "化学", instrumentType: "etf" });
    seedStock({ id: 5, code: "1005", sector: "化学", instrumentType: null });
    const db = makeProxyDb(sqlite);
    const { tickerSector, master } = await loadMarginSectorMaps(db as never);
    expect([...tickerSector.entries()].sort()).toEqual([
      ["1001", "化学"],
      ["1002", null],
    ]);
    expect([...master].sort()).toEqual(["1001", "1002", "1003", "1004", "1005"]);
  });
});
