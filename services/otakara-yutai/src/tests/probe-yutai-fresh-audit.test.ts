/**
 * probe-yutai-fresh-audit.ts の純粋部品の回帰テスト (合成 fixture)。
 * live HTTP は一切触らない。実データ由来の形状 (envelope・列順・scope 検証)
 * だけを使い、原文・ID 実値は持ち込まない。
 */
import { describe, expect, it } from "vitest";
import type { AtomicBatchSender, StockPreimage } from "../../data-scripts/atomic-apply.js";
import { benefitKey } from "../../data-scripts/benefit-key.js";
import type { YieldInputs } from "../../data-scripts/recompute-yields.js";
import { SUMMARY_CONTRACT_VERSION } from "../../data-scripts/summary-contract.js";
import type { BenefitRow, SummaryTask } from "../../data-scripts/summary-tasks.js";
import {
  checkFreshParents,
  compareAbcFresh,
  compareFtFresh,
  compareNormal45Fresh,
  deriveScope,
  inspectSelectCall,
  matchCallKind,
  parseProbeArgs,
  validateRawResponse,
  type FreshScope,
} from "../../data-scripts/probe-yutai-fresh-audit.js";

const URL = "https://api.cloudflare.com/client/v4/accounts/A/d1/database/D/query";

describe("parseProbeArgs", () => {
  it("既定は plan (executeLive false)", () => {
    const a = parseProbeArgs([]);
    expect(a.executeLive).toBe(false);
    expect(a.outDir).toBe("/tmp/yutai-fresh-audit-20260930");
  });

  it("--execute-live でのみ live になる", () => {
    expect(parseProbeArgs(["--execute-live"]).executeLive).toBe(true);
    expect(parseProbeArgs(["--out", "/tmp/x"]).outDir).toBe("/tmp/x");
  });
});

describe("inspectSelectCall (送信前検査)", () => {
  const body = JSON.stringify({ sql: 'select "id" from "core_stocks" where "id" in (?)', params: [7] });

  it("単発 SELECT を通す", () => {
    const r = inspectSelectCall(URL, body, URL);
    expect(r.params).toEqual([7]);
  });

  it("URL 不一致・batch・非 SELECT・複文・余分キーは止める", () => {
    expect(() => inspectSelectCall(URL + "x", body, URL)).toThrow(/DB exact/);
    expect(() => inspectSelectCall(URL, JSON.stringify({ batch: [] }), URL)).toThrow(/batch/);
    expect(() =>
      inspectSelectCall(URL, JSON.stringify({ sql: "update t set a=1", params: [] }), URL)
    ).toThrow(/非 SELECT/);
    expect(() => inspectSelectCall(URL, JSON.stringify({ sql: "select 1; select 2", params: [] }), URL)).toThrow(
      /複文/
    );
    expect(() => inspectSelectCall(URL, JSON.stringify({ sql: "select 1", params: [], extra: 1 }), URL)).toThrow(
      /envelope/
    );
    expect(() => inspectSelectCall(URL, "not json", URL)).toThrow(/JSON/);
  });
});

describe("matchCallKind", () => {
  it("4 テーブルを判定し、想定外は止める", () => {
    expect(matchCallKind('select "id" from "core_stocks"')).toBe("parent");
    expect(matchCallKind('select "stock_id" from "otakara_stock_financials"')).toBe("fin");
    expect(matchCallKind('select "stock_id" from "otakara_stock_scores"')).toBe("score");
    expect(matchCallKind('select "id" from "yutai_benefits"')).toBe("benefits");
    expect(() => matchCallKind('select "id" from "other_table"')).toThrow(/想定外テーブル/);
  });
});

describe("validateRawResponse (raw bytes 厳密検証)", () => {
  const wrap = (results: unknown): Buffer =>
    Buffer.from(JSON.stringify({ success: true, result: [{ results }] }), "utf-8");

  it("parent/benefits の正常形を通す", () => {
    const p = validateRawResponse("parent", wrap([{ id: 7, code: "7000", is_active: 1 }]), [7]);
    expect(p.rows).toHaveLength(1);
    const b = validateRawResponse(
      "benefits",
      wrap([
        {
          id: 11,
          stock_id: 7,
          min_shares: 100,
          record_month: 3,
          description: "架空文",
          short_summary: "架空要約",
          estimated_value: 1000,
          estimate_value_source: null,
          updated_at: 9,
        },
      ]),
      [7]
    );
    expect(b.rows).toHaveLength(1);
  });

  it("success 偽・result 欠落・results 欠落は [] 扱いせず止める", () => {
    const badSuccess = Buffer.from(JSON.stringify({ success: false, result: [] }), "utf-8");
    expect(() => validateRawResponse("parent", badSuccess, [7])).toThrow(/success/);
    const noResult = Buffer.from(JSON.stringify({ success: true }), "utf-8");
    expect(() => validateRawResponse("parent", noResult, [7])).toThrow(/欠落を \[\] とは扱わない/);
    const noResults = Buffer.from(JSON.stringify({ success: true, result: [{}] }), "utf-8");
    expect(() => validateRawResponse("parent", noResults, [7])).toThrow(/欠落を \[\] とは扱わない/);
  });

  it("列違い・型違い・chunk 外・重複は止める", () => {
    expect(() => validateRawResponse("parent", wrap([{ code: "7000", id: 7, is_active: 1 }]), [7])).toThrow(
      /列が想定外/
    );
    expect(() => validateRawResponse("parent", wrap([{ id: "7", code: "7000", is_active: 1 }]), [7])).toThrow(
      /数値ではない/
    );
    expect(() => validateRawResponse("parent", wrap([{ id: 8, code: "7000", is_active: 1 }]), [7])).toThrow(
      /chunk 外/
    );
    expect(() =>
      validateRawResponse(
        "parent",
        wrap([
          { id: 7, code: "7000", is_active: 1 },
          { id: 7, code: "7000", is_active: 1 },
        ]),
        [7]
      )
    ).toThrow(/重複/);
    expect(() => validateRawResponse("parent", wrap([{ id: 7, code: "7000", is_active: 2 }]), [7])).toThrow(
      /0\/1/
    );
  });
});

const scopeOf = (union: number[], codes: Record<number, string>): FreshScope => ({
  union,
  chunks: [union.slice(0, 80), union.slice(80)],
  perStock: new Map(union.map((sid) => [sid, { stockId: sid, code: codes[sid], sources: ["ABC" as const] }])),
  benefitMap: new Map(),
  abcIds: union,
  ftIds: [],
  normalIds: [],
  outside6: [],
  scopeSha: "test",
});

const inputsOf = (parents: YieldInputs["parents"]): YieldInputs => ({
  prices: new Map(),
  benefits: new Map(),
  scoreInputs: new Map(),
  scores: new Map(),
  parents,
});

describe("checkFreshParents (親の完全比較)", () => {
  it("全件一致で問題なし", () => {
    const scope = scopeOf([7, 8], { 7: "7000", 8: "8000" });
    const inputs = inputsOf(
      new Map([
        [7, { code: "7000", isActive: true }],
        [8, { code: "8000", isActive: true }],
      ])
    );
    expect(checkFreshParents(scope, inputs)).toEqual([]);
  });

  it("欠落・不活性・code 不一致・map 欠落を全件列挙する", () => {
    const scope = scopeOf([7, 8, 9, 10], { 7: "7000", 8: "8000", 9: "9000", 10: "1000" });
    const inputs = inputsOf(
      new Map([
        [7, null],
        [8, { code: "8000", isActive: false }],
        [9, { code: "9999", isActive: true }],
      ])
    );
    const problems = checkFreshParents(scope, inputs);
    expect(problems.map((p) => p.stockId)).toEqual([7, 8, 9, 10]);
    expect(problems[0].actual).toMatch(/MISSING/);
    expect(problems[3].actual).toMatch(/NO_ENTRY/);
  });
});

const preimageOf = (benefits: StockPreimage["benefits"]): StockPreimage => ({
  stockId: 7,
  parent: { code: "7000", isActive: true },
  benefits,
  financial: null,
  scores: null,
});

describe("compareAbcFresh", () => {
  const plannedById = new Map([[11, { shortSummary: "要約", estimatedValue: 1000, estimateValueSource: null }]]);
  const row = {
    id: 11,
    stockId: 7,
    minShares: 100,
    recordMonth: 3,
    description: "架空文",
    shortSummary: "要約",
    estimatedValue: 1000,
    estimateValueSource: null,
    updatedAt: 9,
  };

  it("一致で差なし", () => {
    const { diffs, descUncovered } = compareAbcFresh(
      plannedById,
      [11],
      new Map([[7, preimageOf([{ ...row }])]]),
      new Map([[11, "架空文"]]),
      new Map([[11, { stockId: 7, code: "7000" }]])
    );
    expect(diffs).toEqual([]);
    expect(descUncovered).toBe(0);
  });

  it("3 値・行欠落・親・掲載文の差を列挙し、期待なしは数えるだけ", () => {
    const { diffs, descUncovered } = compareAbcFresh(
      plannedById,
      [11],
      new Map([[7, preimageOf([{ ...row, estimatedValue: 999, description: "別文" }])]]),
      new Map(),
      new Map([[11, { stockId: 8, code: "8000" }]])
    );
    expect(diffs.map((d) => d.field).sort()).toEqual(["estimatedValue", "parent"]);
    expect(descUncovered).toBe(1);
  });

  it("行欠落は MISSING 差", () => {
    const { diffs } = compareAbcFresh(plannedById, [11], new Map([[7, preimageOf([])]]), new Map(), new Map());
    expect(diffs).toEqual([{ id: 11, field: "row", planned: "present", fresh: "MISSING" }]);
  });
});

describe("compareFtFresh", () => {
  const batched = new Map([
    [21, { newFull: "新全文A", old: "旧文A" }],
    [22, { newFull: "新全文B", old: "旧文B" }],
  ]);
  it("適用済みは実 builder 0 文・送信 0 回", async () => {
    let calls = 0;
    const sender: AtomicBatchSender = async () => {
      calls++;
    };
    const r = await compareFtFresh(
      batched,
      new Map([
        [21, "新全文A"],
        [22, "新全文B"],
      ]),
      new Map([
        [21, 1],
        [22, 2],
      ]),
      sender
    );
    expect(r).toMatchObject({ applied: 2, candidates: 0, stops: 0, descStatements: 0, senderCalls: 0 });
    expect(r.missing).toEqual([]);
    expect(calls).toBe(0);
  });

  it("未適用・drift・欠落を数える", async () => {
    const sender: AtomicBatchSender = async () => {};
    const r = await compareFtFresh(
      new Map([
        ...batched,
        [23, { newFull: "新全文C", old: "旧文C" }],
        [24, { newFull: "新全文D", old: "旧文D" }],
      ]),
      new Map([
        [21, "新全文A"],
        [22, "旧文B"],
        [23, "第三文"],
      ]),
      new Map([
        [21, 1],
        [22, 2],
        [23, 3],
      ]),
      sender
    );
    expect(r).toMatchObject({ applied: 1, candidates: 1, stops: 1, missing: [24] });
  });
});

describe("compareNormal45Fresh", () => {
  const DESC = "架空優待 1,000円相当の掲載文";
  const task = (over: Partial<SummaryTask> = {}): SummaryTask => ({
    taskId: benefitKey("9990", DESC),
    contractVersion: SUMMARY_CONTRACT_VERSION,
    reason: "missing",
    violations: [],
    stockCode: "9990",
    stockName: "架空",
    description: DESC,
    rowCount: 1,
    ...over,
  });
  const brow = (over: Partial<BenefitRow> = {}): BenefitRow => ({
    id: 11,
    stockId: 7,
    stockCode: "9990",
    stockName: "架空",
    description: DESC,
    shortSummary: "架空ギフト 1,000円相当",
    estimatedValue: 1000,
    estimateValueSource: null,
    minShares: 100,
    recordMonth: 3,
    updatedAt: 1,
    ...over,
  });

  it("出典のみ差は pending として数える", () => {
    const t = task();
    const resultsText = JSON.stringify({
      taskId: t.taskId,
      contractVersion: SUMMARY_CONTRACT_VERSION,
      shortSummary: "架空ギフト 1,000円相当",
      estimatedValue: 1000,
    });
    const r = compareNormal45Fresh([t], resultsText, [brow()]);
    expect(r).toMatchObject({ tasks: 1, pendingTasks: 1, pendingRows: 1, sourceOnlyRows: 1 });
    expect(r.staleTaskIds).toEqual([]);
  });

  it("キー不一致は stale として taskId を残す", () => {
    const t = task();
    const resultsText = JSON.stringify({
      taskId: t.taskId,
      contractVersion: SUMMARY_CONTRACT_VERSION,
      shortSummary: "架空ギフト 1,000円相当",
      estimatedValue: 1000,
    });
    const r = compareNormal45Fresh([t], resultsText, [brow({ description: "別文" })]);
    expect(r.pendingTasks).toBe(0);
    expect(r.staleTaskIds).toEqual([t.taskId]);
  });
});

describe("deriveScope", () => {
  it("件数が違えば実値を添えて止める", () => {
    const abcEmpty = JSON.stringify({
      batches: { perStock: [] },
      yield: { entries: [], skippedNoRow: [], skippedNoScore: [], changed: 0, scoreChanged: 0 },
    });
    expect(() => deriveScope(abcEmpty, "{}", "{}", "{}")).toThrow(/ABC stocks=0/);
  });
});
