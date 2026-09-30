/**
 * probe-yutai-fresh-audit.ts の純粋部品の回帰テスト (合成 fixture)。
 * live HTTP は一切触らない。実データ由来の形状 (envelope・列順・scope 検証)
 * だけを使い、原文・ID 実値は持ち込まない。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AtomicBatchSender, StockPreimage } from "../../data-scripts/atomic-apply.js";
import { benefitKey } from "../../data-scripts/benefit-key.js";
import type { YieldInputs } from "../../data-scripts/recompute-yields.js";
import { SUMMARY_CONTRACT_VERSION } from "../../data-scripts/summary-contract.js";
import type { BenefitRow, SummaryTask } from "../../data-scripts/summary-tasks.js";
import {
  appendLedgerLine,
  buildExpectedCalls,
  buildExpectedPost,
  checkFreshParents,
  compareBenefitFullSet,
  compareFtFresh,
  compareProtectedFinScores,
  deriveScope,
  inspectSelectCall,
  matchCallKind,
  parseProbeArgs,
  reconstructPreFtRows,
  validateRawResponse,
  type FreshScope,
} from "../../data-scripts/probe-yutai-fresh-audit.js";
import { proveNormal45 } from "../../data-scripts/verify-repair-reentry.js";

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

describe("buildExpectedCalls (実 builder の toSQL)", () => {
  const chunk80 = Array.from({ length: 80 }, (_, i) => 1000 + i);
  const chunk64 = Array.from({ length: 64 }, (_, i) => 2000 + i);

  it("8 文を固定順で生成する", () => {
    const calls = buildExpectedCalls([chunk80, chunk64]);
    expect(calls.map((c) => `${c.chunk}:${c.kind}`)).toEqual([
      "0:parent",
      "0:fin",
      "0:score",
      "0:benefits",
      "1:parent",
      "1:fin",
      "1:score",
      "1:benefits",
    ]);
    for (const c of calls) {
      expect(c.sql.toLowerCase()).toMatch(/^\s*select\b/);
      expect(c.sql).not.toContain(";");
    }
  });

  it("parent は chunkIDs + active + equity の chunk+2 params (80 を 80 total と思わない)", () => {
    const calls = buildExpectedCalls([chunk80, chunk64]);
    expect(calls[0].params).toHaveLength(82);
    expect(calls[4].params).toHaveLength(66);
    expect(calls[1].params).toHaveLength(80);
    expect(calls[5].params).toHaveLength(64);
    // 先頭 chunk 分は ID そのもの。
    expect((calls[0].params as unknown[]).slice(0, 80)).toEqual(chunk80);
  });
});

describe("validateRawResponse (raw bytes 厳密検証)", () => {
  const wrap = (results: unknown): Buffer =>
    Buffer.from(JSON.stringify({ success: true, result: [{ results }] }), "utf-8");

  it("parent/fin/benefits の正常形を通す (物理列名 ma_25/rsi_14)", () => {
    const p = validateRawResponse("parent", wrap([{ id: 7, code: "7000", is_active: 1 }]), [7]);
    expect(p.rows).toHaveLength(1);
    const f = validateRawResponse(
      "fin",
      wrap([
        {
          stock_id: 7,
          price: 1000,
          per: null,
          pbr: null,
          dividend_yield: null,
          roe: null,
          ma_25: null,
          rsi_14: null,
          macd: null,
          macd_signal: null,
          yutai_yield: null,
          data_date: "2026-09-29",
          fetched_at: 3,
        },
      ]),
      [7]
    );
    expect(f.rows).toHaveLength(1);
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

  it("列違い (ma25 誤記含む)・型違い・chunk 外・重複は止める", () => {
    expect(() => validateRawResponse("parent", wrap([{ code: "7000", id: 7, is_active: 1 }]), [7])).toThrow(
      /列が想定外/
    );
    const wrongKey = {
      stock_id: 7,
      price: 1000,
      per: null,
      pbr: null,
      dividend_yield: null,
      roe: null,
      ma25: null,
      rsi14: null,
      macd: null,
      macd_signal: null,
      yutai_yield: null,
      data_date: "2026-09-29",
      fetched_at: 3,
    };
    expect(() => validateRawResponse("fin", wrap([wrongKey]), [7])).toThrow(/列が想定外/);
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
  });
});

describe("appendLedgerLine", () => {
  it("追記で残る", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    try {
      appendLedgerLine(dir, { index: 1, phase: "captured" });
      appendLedgerLine(dir, { index: 1, phase: "FAILED", error: "x" });
      const lines = readFileSync(join(dir, "partial-ledger.jsonl"), "utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1]).phase).toBe("FAILED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

const brow = (over: Partial<StockPreimage["benefits"][number]> = {}): StockPreimage["benefits"][number] => ({
  id: 11,
  stockId: 7,
  minShares: 100,
  recordMonth: 3,
  description: "架空文",
  shortSummary: "要約",
  estimatedValue: 1000,
  estimateValueSource: null,
  updatedAt: 9,
  ...over,
});

describe("buildExpectedPost + compareBenefitFullSet (保存全行集合)", () => {
  const benefitMap = new Map([
    [11, { stockId: 7, code: "7000" }],
    [12, { stockId: 7, code: "7000" }],
  ]);
  const preimages = new Map([[7, preimageOf([brow({ id: 11 }), brow({ id: 12, shortSummary: "旧要約" })])]]);
  const rowById = new Map();
  const plannedById = new Map([[11, { shortSummary: "新要約", estimatedValue: 1000, estimateValueSource: null }]]);
  const batched = new Map();

  it("一致で差なし (planned 優先 + untouched は pre 値)", () => {
    const expected = buildExpectedPost(benefitMap, preimages, rowById, plannedById, batched);
    expect(expected.get(11)).toMatchObject({ shortSummary: "新要約", repaired: true });
    expect(expected.get(12)).toMatchObject({ shortSummary: "旧要約", repaired: false });
    const fresh = new Map([
      [7, preimageOf([brow({ id: 11, shortSummary: "新要約", updatedAt: 10 }), brow({ id: 12, shortSummary: "旧要約" })])],
    ]);
    const { content, drift } = compareBenefitFullSet(expected, fresh);
    expect(content).toEqual([]);
    expect(drift).toEqual([]);
  });

  it("3 値・親・minShares・掲載文・欠落・追加を content に列挙する", () => {
    const expected = buildExpectedPost(benefitMap, preimages, rowById, plannedById, batched);
    const fresh = new Map([
      [
        7,
        preimageOf([
          brow({ id: 11, shortSummary: "別要約", minShares: 200, description: "別文", updatedAt: 10 }),
          brow({ id: 13, shortSummary: "追加行" }),
        ]),
      ],
    ]);
    const { content } = compareBenefitFullSet(expected, fresh);
    const fields = content.map((d) => `${d.id}:${d.field}`).sort();
    expect(fields).toContain("11:shortSummary");
    expect(fields).toContain("11:minShares");
    expect(fields).toContain("11:description");
    expect(fields).toContain("12:row");
    expect(fields).toContain("13:row");
  });

  it("null は null と一致し、値との差は拾う (NULL-safe)", () => {
    const expected = buildExpectedPost(benefitMap, preimages, rowById, plannedById, batched);
    const fresh = new Map([
      [
        7,
        preimageOf([
          brow({ id: 11, shortSummary: "新要約", estimatedValue: null, updatedAt: 10 }),
          brow({ id: 12, shortSummary: "旧要約" }),
        ]),
      ],
    ]);
    const { content } = compareBenefitFullSet(expected, fresh);
    expect(content.map((d) => `${d.id}:${d.field}`)).toEqual(["11:estimatedValue"]);
  });

  it("修復行の receipt 違反は content、untouched の更新は drift", () => {
    const expected = buildExpectedPost(benefitMap, preimages, rowById, plannedById, batched);
    const fresh = new Map([
      [
        7,
        preimageOf([
          brow({ id: 11, shortSummary: "新要約", updatedAt: 9 }),
          brow({ id: 12, shortSummary: "旧要約", updatedAt: 99 }),
        ]),
      ],
    ]);
    const { content, drift } = compareBenefitFullSet(expected, fresh);
    expect(content.map((d) => `${d.id}:${d.field}`)).toEqual(["11:updatedAt-receipt"]);
    expect(drift.map((d) => `${d.id}:${d.field}`)).toEqual(["12:updatedAt"]);
  });
});

describe("compareProtectedFinScores", () => {
  const fin = {
    yutaiYield: null,
    dataDate: "2026-09-29",
    price: 1000,
    per: null,
    pbr: null,
    dividendYield: null,
    roe: null,
    ma25: null,
    rsi14: null,
    macd: null,
    macdSignal: null,
    fetchedAt: 1,
  };
  const scores = { fundamentalScore: 1, technicalScore: 2, totalScore: 3 };

  it("一致で drift なし", () => {
    const pre = new Map([[7, { ...preimageOf([]), financial: { ...fin }, scores: { ...scores } }]]);
    const fresh = new Map([[7, { ...preimageOf([]), financial: { ...fin }, scores: { ...scores } }]]);
    expect(compareProtectedFinScores(pre, fresh)).toEqual({ drift: [], uncovered: 0 });
  });

  it("全列の差を行欠落含め drift に列挙し、preimage 無しは uncovered", () => {
    const pre = new Map([[7, { ...preimageOf([]), financial: { ...fin }, scores: { ...scores } }]]);
    const fresh = new Map([
      [7, { ...preimageOf([]), financial: { ...fin, price: 999 }, scores: null }],
      [8, preimageOf([])],
    ]);
    const { drift, uncovered } = compareProtectedFinScores(pre, fresh);
    expect(drift.map((d) => `${d.scope}:${d.field}`).sort()).toEqual(["fin:price", "score:row"]);
    expect(uncovered).toBe(1);
  });
});

describe("compareFtFresh (分類 + 親 identity)", () => {
  const batched = new Map([
    [21, { newFull: "新全文A", old: "旧文A", updatedAt: 1 }],
    [22, { newFull: "新全文B", old: "旧文B", updatedAt: 2 }],
  ]);
  const expectedParent = new Map([
    [21, { stockId: 7, code: "7000" }],
    [22, { stockId: 7, code: "7000" }],
  ]);
  const codes = new Map([[7, "7000"]]);

  it("適用済みは実 builder 0 文・送信 0 回・親一致", async () => {
    let calls = 0;
    const sender: AtomicBatchSender = async () => {
      calls++;
    };
    const r = await compareFtFresh(
      batched,
      new Map([
        [21, { description: "新全文A", updatedAt: 1, stockId: 7 }],
        [22, { description: "新全文B", updatedAt: 2, stockId: 7 }],
      ]),
      expectedParent,
      codes,
      sender
    );
    expect(r).toMatchObject({ applied: 2, candidates: 0, stops: 0, descStatements: 0, senderCalls: 0 });
    expect(r.missing).toEqual([]);
    expect(r.parentMismatches).toEqual([]);
    expect(calls).toBe(0);
  });

  it("同文でも別親は parentMismatch、未適用・drift・欠落も数える", async () => {
    const sender: AtomicBatchSender = async () => {};
    const r = await compareFtFresh(
      new Map([
        ...batched,
        [23, { newFull: "新全文C", old: "旧文C", updatedAt: 3 }],
        [24, { newFull: "新全文D", old: "旧文D", updatedAt: 4 }],
      ]),
      new Map([
        [21, { description: "新全文A", updatedAt: 1, stockId: 8 }],
        [22, { description: "旧文B", updatedAt: 2, stockId: 7 }],
        [23, { description: "第三文", updatedAt: 3, stockId: 7 }],
      ]),
      new Map([...expectedParent, [23, { stockId: 7, code: "7000" }], [24, { stockId: 7, code: "7000" }]]),
      new Map([
        [7, "7000"],
        [8, "8000"],
      ]),
      sender
    );
    expect(r).toMatchObject({ applied: 1, candidates: 1, stops: 1, missing: [24] });
    expect(r.parentMismatches).toHaveLength(1);
    expect(r.parentMismatches[0].id).toBe(21);
  });
});

describe("reconstructPreFtRows", () => {
  const row = (over: Partial<BenefitRow> = {}): BenefitRow => ({
    id: 21,
    stockId: 7,
    stockCode: "7000",
    stockName: "架空",
    description: "新全文A",
    shortSummary: "要約",
    estimatedValue: 1000,
    estimateValueSource: null,
    minShares: 100,
    recordMonth: 3,
    updatedAt: 2,
    ...over,
  });

  it("新全文一致の行だけ旧文へ戻す", () => {
    const out = reconstructPreFtRows(
      [row(), row({ id: 22, description: "無関係文" })],
      new Map([[21, { newFull: "新全文A", old: "旧文A", updatedAt: 1 }]])
    );
    expect(out[0].description).toBe("旧文A");
    expect(out[1].description).toBe("無関係文");
  });

  it("新全文と違えば再構成不能で止める", () => {
    expect(() =>
      reconstructPreFtRows([row({ description: "drift文" })], new Map([[21, { newFull: "新全文A", old: "旧文A", updatedAt: 1 }]]))
    ).toThrow(/preFT 再構成不能/);
  });
});

describe("proveNormal45 再利用 (fresh 正常系)", () => {
  const DESC = "架空優待 1,000円相当の掲載文";
  const task = (): SummaryTask => ({
    taskId: benefitKey("9990", DESC),
    contractVersion: SUMMARY_CONTRACT_VERSION,
    reason: "missing",
    violations: [],
    stockCode: "9990",
    stockName: "架空",
    description: DESC,
    rowCount: 1,
  });
  const crow = (): BenefitRow => ({
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
  });

  it("出典のみ差は pending として数え、全理由を保持する", () => {
    const t = task();
    const resultsText = JSON.stringify({
      taskId: t.taskId,
      contractVersion: SUMMARY_CONTRACT_VERSION,
      shortSummary: "架空ギフト 1,000円相当",
      estimatedValue: 1000,
    });
    const rows = [crow()];
    const r = proveNormal45([t], resultsText, rows, rows);
    expect(r).toMatchObject({ tasks: 1, pendingTasks: 1, pendingRows: 1, sourceOnlyRows: 1, stale: 0 });
    expect(r.rejected).toEqual({});
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
