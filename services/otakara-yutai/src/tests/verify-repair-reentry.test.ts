/**
 * verify-repair-reentry.ts の純粋部品の回帰テスト (合成 fixture)。
 * 実データ由来の形状 (filed 文 params 配置・3 値比較・分類) だけを使い、
 * 原文・ID 実値は持ち込まない。実証跡での結合実行は手動 + 私的証跡。
 */
import { describe, expect, it } from "vitest";
import type { StockPreimage } from "../../data-scripts/atomic-apply.js";
import {
  parseAbcManifest,
  producePlannedUpdate,
  proveFulltextReentry,
  proveTargetCoverage,
  simulatePostBenefits,
  throwingSender,
} from "../../data-scripts/verify-repair-reentry.js";

const pre = (benefits: StockPreimage["benefits"]): StockPreimage => ({
  stockId: 101,
  parent: { code: "1001", isActive: true },
  benefits,
  financial: null,
  scores: null,
});

const row = (id: number, shortSummary: string | null, estimatedValue: number | null, estimateValueSource: string | null) => ({
  id,
  stockId: 101,
  minShares: 100,
  recordMonth: 3,
  description: `掲載文${id}`,
  shortSummary,
  estimatedValue,
  estimateValueSource,
  updatedAt: 1000,
});

describe("producePlannedUpdate (filed 文→DISTINCT 更新)", () => {
  it("出典 (null 含む) を保存し ids を複写する", () => {
    const ids = [11, 12];
    const u = producePlannedUpdate({
      stockId: 101,
      index: 0,
      shortSummary: "要約",
      estimatedValue: 1000,
      estimateValueSource: null,
      ids,
    });
    expect(u).toMatchObject({
      taskId: "abc-filed:101:0",
      shortSummary: "要約",
      estimatedValue: 1000,
      estimateValueSource: null,
    });
    expect(u.ids).toEqual([11, 12]);
    expect(u.ids).not.toBe(ids);
  });

  it("想定外の出典文字列は投げる", () => {
    expect(() =>
      producePlannedUpdate({
        stockId: 101,
        index: 0,
        shortSummary: "要約",
        estimatedValue: 1000,
        estimateValueSource: "other",
        ids: [11],
      })
    ).toThrow(/出典が想定外/);
  });
});

describe("proveTargetCoverage (473 式の被覆・一意)", () => {
  const preimages = new Map([[101, pre([row(11, "旧", 100, null), row(12, "旧", 100, null)])]]);
  const filedOf = (ids: number[], summary = "新") =>
    [{ stockId: 101, index: 0, shortSummary: summary, estimatedValue: 100, estimateValueSource: null as string | null, ids }];

  it("正常系は ID 集合と target を返す", () => {
    const { plannedIds, plannedById } = proveTargetCoverage(filedOf([11, 12]), preimages);
    expect(plannedIds).toEqual([11, 12]);
    expect(plannedById.get(11)).toMatchObject({ shortSummary: "新" });
  });

  it("重複 ID は一致不一致にかかわらず投げる", () => {
    const dup = [
      ...filedOf([11]),
      { stockId: 101, index: 1, shortSummary: "新", estimatedValue: 100, estimateValueSource: null as string | null, ids: [11] },
    ];
    expect(() => proveTargetCoverage(dup, preimages)).toThrow(/複数文に出現/);
  });

  it("衝突 target は投げる", () => {
    const conflict = [
      ...filedOf([11], "新A"),
      { stockId: 101, index: 1, shortSummary: "新B", estimatedValue: 100, estimateValueSource: null as string | null, ids: [11] },
    ];
    expect(() => proveTargetCoverage(conflict, preimages)).toThrow(/衝突/);
  });

  it("preimage に無い ID は投げる", () => {
    expect(() => proveTargetCoverage(filedOf([99]), preimages)).toThrow(/被覆欠落/);
  });
});

describe("simulatePostBenefits (post 模擬)", () => {
  it("planned 3 値だけ適用し他行は不変", () => {
    const post = simulatePostBenefits(
      new Map([[101, pre([row(11, "旧", 100, null), row(12, "他", 200, "company")])]]),
      new Map([[11, { shortSummary: "新", estimatedValue: 100, estimateValueSource: null }]])
    );
    const rows = post.get(101)!.benefits;
    expect(rows.find((b) => b.id === 11)).toMatchObject({ shortSummary: "新" });
    expect(rows.find((b) => b.id === 12)).toMatchObject({ shortSummary: "他", estimateValueSource: "company" });
  });
});

describe("proveFulltextReentry (全文分類再入)", () => {
  const rows = [
    { id: 21, stockCode: "1001", oldDescription: "旧文A", newFull: "新全文A", updatedAt: 100 },
    { id: 22, stockCode: "1001", oldDescription: "旧文B", newFull: "新全文B", updatedAt: 200 },
  ];

  it("全行適用済みで 0 文、wouldWrite は行数", () => {
    const r = proveFulltextReentry(rows, new Map([[21, "新全文A"], [22, "新全文B"]]));
    expect(r).toMatchObject({ rows: 2, applied: 2, candidates: 0, stops: 0, descStatements: 0, wouldWrite: 2 });
  });

  it("未適用・drift・同一文は投げる", () => {
    expect(() => proveFulltextReentry(rows, new Map([[21, "新全文A"], [22, "旧文B"]]))).toThrow(/未適用/);
    expect(() => proveFulltextReentry(rows, new Map([[21, "新全文A"], [22, "第三文"]]))).toThrow(/STOP/);
    expect(() =>
      proveFulltextReentry(
        [{ id: 23, stockCode: "1001", oldDescription: "同一", newFull: "同一", updatedAt: 300 }],
        new Map([[23, "同一"]])
      )
    ).toThrow(/同一/);
  });
});

describe("parseAbcManifest (形状検証)", () => {
  it("preflight+短文 UPDATE を分類し yield entry を読む", () => {
    const text = JSON.stringify({
      batches: {
        perStock: [
          {
            stockId: 101,
            statements: [
              { sql: "-- preflight", params: [JSON.stringify(pre([row(11, "旧", 100, null)]))] },
              { sql: "UPDATE yutai_benefits SET short_summary = ?, x", params: ["新", 100, null, 11] },
              { sql: "UPDATE otakara_stock_financials SET yutai_yield = ?, x", params: [1.5, 101] },
            ],
          },
        ],
      },
      yield: {
        entries: [{ stockId: 101, prev: 1.0, next: 1.5, changed: true, scorePrev: null, scoreNext: null, scoreChanged: false }],
        skippedNoRow: [],
        skippedNoScore: [],
        changed: 1,
        scoreChanged: 0,
      },
    });
    const abc = parseAbcManifest(text);
    expect(abc.preimages.size).toBe(1);
    expect(abc.filed).toHaveLength(1);
    expect(abc.benefitUpdateCount).toBe(1);
    expect(abc.yieldStmts).toEqual([{ stockId: 101, next: 1.5 }]);
    expect(abc.yieldEntries).toHaveLength(1);
  });

  it("想定外の文は投げる", () => {
    const text = JSON.stringify({
      batches: {
        perStock: [
          {
            stockId: 101,
            statements: [
              { sql: "-- preflight", params: [JSON.stringify(pre([]))] },
              { sql: "DELETE FROM yutai_benefits", params: [] },
            ],
          },
        ],
      },
      yield: { entries: [], skippedNoRow: [], skippedNoScore: [], changed: 0, scoreChanged: 0 },
    });
    expect(() => parseAbcManifest(text)).toThrow(/想定外/);
  });
});

describe("throwingSender (送信口)", () => {
  it("呼ばれたら throw する", async () => {
    await expect(throwingSender([])).rejects.toThrow(/0 writes 違反/);
  });
});
