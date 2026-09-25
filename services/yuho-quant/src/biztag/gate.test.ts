/**
 * gate.ts のテスト。設計 docs/005-yuho-quant-business-tags.md §6.3。
 * 4 つの関門 (形・出典・ゴールデン・変更量) がそれぞれ独立に落ちること、
 * 採用経路、変更量の上限、見直し期限 (8月第1月曜の計算含む)、
 * ゴールデン指標が null (測定不可) のときの扱い、`getBaseline` の遅延呼び出しを検査する。
 */
import { describe, expect, it, vi } from "vitest";
import type { LedgerEntry } from "../../../../src/shared/notion-archive/index.js";
import {
  MAX_CHANGED_RATIO,
  MAX_DEPRECATED_RATIO_PER_FAMILY,
  checkDeadline,
  evaluateProposal,
  firstMondayOfAugust,
  reviewDeadline,
  runGate,
  type GateChecks,
} from "./gate.js";
import type { GoldenMetrics } from "./golden.js";
import type { SourceCheckIssue } from "./sources-verify.js";
import { MINI_VOCAB } from "./vocabulary/__fixtures__/mini-vocab.js";
import type { Proposal } from "./vocabulary/proposal.js";

const OK_GOLDEN: GoldenMetrics = {
  precisionYes: 0.95,
  recallYes: 0.9,
  mustHitRecall: 0.9,
  mustNotViolations: 0,
  filterMissRate: 0.05,
};

function noIssues(): Promise<SourceCheckIssue[]> {
  return Promise.resolve([]);
}

/** getBaseline はテスト対象の関数そのものが「必要な時だけ」呼ぶことを前提にした lazy 関数。 */
function baselineOf(golden: GoldenMetrics): () => Promise<GoldenMetrics> {
  return () => Promise.resolve(golden);
}

function baseChecks(overrides: Partial<GateChecks> = {}): GateChecks {
  return {
    verifySources: overrides.verifySources ?? noIssues,
    evaluateGoldenForVocab: overrides.evaluateGoldenForVocab ?? (() => Promise.resolve(OK_GOLDEN)),
  };
}

/** 実在する語彙エントリを 1 つ deprecate する提案 (実際の単語帳データを使う)。 */
function deprecateProposal(id: string): Proposal {
  return {
    baseVersion: MINI_VOCAB.version,
    noChange: false,
    sourcesChecked: [
      { title: "日本標準産業分類", url: "https://www.soumu.go.jp/main_content/000941216.pdf", date: "2023-07" },
    ],
    changes: [
      {
        op: "deprecate",
        id,
        evidence: [
          {
            title: "日本標準産業分類 分類項目名、説明及び内容例示（令和５年７月告示 第14回改定）",
            url: "https://www.soumu.go.jp/main_content/000941216.pdf",
            date: "2023-07",
            section: "細分類2694 ロボット製造業",
            quote: "産業用ロボット",
          },
        ],
      },
    ],
  };
}

/** 1 語に keyword を1つ足すだけの提案 (変更量・系統別廃止量のどちらの上限にも触れない)。 */
function addKeywordsProposal(): Proposal {
  return {
    baseVersion: MINI_VOCAB.version,
    noChange: false,
    sourcesChecked: deprecateProposal("x").sourcesChecked,
    changes: [
      {
        op: "add_keywords",
        id: "B.MACH.MACHINE_TOOL",
        keywords: ["精密加工機"],
        evidence: deprecateProposal("x").changes[0]!.evidence,
      },
    ],
  };
}

describe("evaluateProposal", () => {
  it("noChange:true は形・出典・ゴールデン・変更量のどれも検査せず no_change を返す (getBaseline も呼ばない)", async () => {
    const getBaseline = vi.fn(baselineOf(OK_GOLDEN));
    const checks = baseChecks({
      verifySources: vi.fn(noIssues),
      evaluateGoldenForVocab: vi.fn(() => Promise.resolve(OK_GOLDEN)),
    });
    const proposal: Proposal = {
      baseVersion: MINI_VOCAB.version,
      noChange: true,
      reason: "今年は変更なし",
      sourcesChecked: [
        { title: "日本標準産業分類", url: "https://www.soumu.go.jp/main_content/000941216.pdf", date: "2023-07" },
      ],
      changes: [],
    };
    const decision = await evaluateProposal(MINI_VOCAB, getBaseline, proposal, checks);
    expect(decision.decision).toBe("no_change");
    // 理由列 (docs §3.2「関門の判定理由。コードが作る文。提案者の作文は
    // 入れない」) はコードが組み立てた文で始まり、提出者の申告理由は
    // 引用として埋め込む (提案者の作文をそのまま判定理由の顔で残さない)。
    expect(decision.reason).toBe("変更なしとして受理 (提出者の申告理由: 今年は変更なし)");
    expect(checks.verifySources).not.toHaveBeenCalled();
    expect(checks.evaluateGoldenForVocab).not.toHaveBeenCalled();
    expect(getBaseline).not.toHaveBeenCalled();
  });

  it("noChange:true なのに reason が無ければ throw する (ProposalSchema の refine 漏れの防御)", async () => {
    const checks = baseChecks({
      verifySources: vi.fn(noIssues),
      evaluateGoldenForVocab: vi.fn(() => Promise.resolve(OK_GOLDEN)),
    });
    // 型上は reason?: string だが、schema の refine で noChange:true のとき
    // 必須になる。ここでは「refine をすり抜けた」不正な値を意図的に作る。
    const proposal = {
      baseVersion: MINI_VOCAB.version,
      noChange: true,
      sourcesChecked: [
        { title: "日本標準産業分類", url: "https://www.soumu.go.jp/main_content/000941216.pdf", date: "2023-07" },
      ],
      changes: [],
    } as unknown as Proposal;
    await expect(evaluateProposal(MINI_VOCAB, vi.fn(), proposal, checks)).rejects.toThrow("reason");
  });

  it("① 形の検査: baseVersion が今の版と違えば rejected (getBaseline は呼ばない)", async () => {
    const getBaseline = vi.fn(baselineOf(OK_GOLDEN));
    const proposal = { ...deprecateProposal("B.MACH.INDUSTRIAL_ROBOT"), baseVersion: "v99" };
    const decision = await evaluateProposal(MINI_VOCAB, getBaseline, proposal, baseChecks());
    expect(decision.decision).toBe("rejected");
    expect(decision.reason).toContain("形の検査");
    expect(getBaseline).not.toHaveBeenCalled();
  });

  it("① 形の検査: 存在しない id の deprecate は rejected", async () => {
    const proposal = deprecateProposal("B.NOT.EXIST");
    const decision = await evaluateProposal(MINI_VOCAB, baselineOf(OK_GOLDEN), proposal, baseChecks());
    expect(decision.decision).toBe("rejected");
  });

  it("② 出典の検査に失敗したら rejected (出典・ゴールデンは順に評価され、出典で止まり getBaseline も呼ばない)", async () => {
    const goldenSpy = vi.fn(() => Promise.resolve(OK_GOLDEN));
    const getBaseline = vi.fn(baselineOf(OK_GOLDEN));
    const checks = baseChecks({
      verifySources: () =>
        Promise.resolve([
          { code: "quote_not_found", url: "https://example.test", quote: "…", label: "test", message: "引用なし" },
        ]),
      evaluateGoldenForVocab: goldenSpy,
    });
    const decision = await evaluateProposal(MINI_VOCAB, getBaseline, deprecateProposal("B.MACH.INDUSTRIAL_ROBOT"), checks);
    expect(decision.decision).toBe("rejected");
    expect(decision.reason).toContain("出典の検査");
    expect(goldenSpy).not.toHaveBeenCalled();
    expect(getBaseline).not.toHaveBeenCalled();
  });

  it("③ ゴールデンの precisionYes が null (「はい」判定0件で測定不可) なら rejected・getBaseline は呼ばない", async () => {
    const getBaseline = vi.fn(baselineOf(OK_GOLDEN));
    const checks = baseChecks({ evaluateGoldenForVocab: () => Promise.resolve({ ...OK_GOLDEN, precisionYes: null }) });
    const decision = await evaluateProposal(MINI_VOCAB, getBaseline, deprecateProposal("B.MACH.INDUSTRIAL_ROBOT"), checks);
    expect(decision.decision).toBe("rejected");
    expect(decision.reason).toContain("精度を測れません");
    expect(getBaseline).not.toHaveBeenCalled();
  });

  it("③ ゴールデン精度が基準 (0.9) を下回れば rejected・getBaseline は呼ばない (自身の基準未達で確定するため)", async () => {
    const getBaseline = vi.fn(baselineOf(OK_GOLDEN));
    const checks = baseChecks({ evaluateGoldenForVocab: () => Promise.resolve({ ...OK_GOLDEN, precisionYes: 0.5 }) });
    const decision = await evaluateProposal(MINI_VOCAB, getBaseline, deprecateProposal("B.MACH.INDUSTRIAL_ROBOT"), checks);
    expect(decision.decision).toBe("rejected");
    expect(decision.reason).toContain("精度");
    expect(getBaseline).not.toHaveBeenCalled();
  });

  it("③ ゴールデン精度が今の版から下がれば (基準は超えていても) rejected (この時点で getBaseline を呼ぶ)", async () => {
    const getBaseline = vi.fn(baselineOf({ ...OK_GOLDEN, precisionYes: 0.95 }));
    const checks = baseChecks({ evaluateGoldenForVocab: () => Promise.resolve({ ...OK_GOLDEN, precisionYes: 0.91 }) });
    const decision = await evaluateProposal(MINI_VOCAB, getBaseline, deprecateProposal("B.MACH.INDUSTRIAL_ROBOT"), checks);
    expect(decision.decision).toBe("rejected");
    expect(decision.reason).toContain("下がりました");
    expect(getBaseline).toHaveBeenCalledTimes(1);
  });

  it("③ 基準の precisionYes が null (測定不可) なら精度低下比較はスキップし、他の関門も通れば adopted", async () => {
    const getBaseline = vi.fn(baselineOf({ ...OK_GOLDEN, precisionYes: null }));
    const checks = baseChecks({ evaluateGoldenForVocab: () => Promise.resolve({ ...OK_GOLDEN, precisionYes: 0.91 }) });
    const decision = await evaluateProposal(MINI_VOCAB, getBaseline, addKeywordsProposal(), checks);
    expect(decision.decision).toBe("adopted");
  });

  it("③ 当てたい例の再現率 (mustHitRecall) が今の版から下がれば rejected", async () => {
    const getBaseline = vi.fn(baselineOf({ ...OK_GOLDEN, mustHitRecall: 0.9 }));
    const checks = baseChecks({ evaluateGoldenForVocab: () => Promise.resolve({ ...OK_GOLDEN, mustHitRecall: 0.5 }) });
    const decision = await evaluateProposal(MINI_VOCAB, getBaseline, deprecateProposal("B.MACH.INDUSTRIAL_ROBOT"), checks);
    expect(decision.decision).toBe("rejected");
    expect(decision.reason).toContain("再現率");
  });

  it("③ 提案側の mustHitRecall が null (基準は非null) でも再現率低下として rejected", async () => {
    const getBaseline = vi.fn(baselineOf({ ...OK_GOLDEN, mustHitRecall: 0.9 }));
    const checks = baseChecks({ evaluateGoldenForVocab: () => Promise.resolve({ ...OK_GOLDEN, mustHitRecall: null }) });
    const decision = await evaluateProposal(MINI_VOCAB, getBaseline, deprecateProposal("B.MACH.INDUSTRIAL_ROBOT"), checks);
    expect(decision.decision).toBe("rejected");
    expect(decision.reason).toContain("再現率");
  });

  it("③ 基準の mustHitRecall が null (測定不可) なら再現率比較はスキップし、他の関門も通れば adopted", async () => {
    const getBaseline = vi.fn(baselineOf({ ...OK_GOLDEN, mustHitRecall: null }));
    const checks = baseChecks({ evaluateGoldenForVocab: () => Promise.resolve({ ...OK_GOLDEN, mustHitRecall: null }) });
    const decision = await evaluateProposal(MINI_VOCAB, getBaseline, addKeywordsProposal(), checks);
    expect(decision.decision).toBe("adopted");
  });

  it("③ 外したい例の誤検出 (mustNotViolations) が今の版から増えれば rejected", async () => {
    const getBaseline = vi.fn(baselineOf({ ...OK_GOLDEN, mustNotViolations: 0 }));
    const checks = baseChecks({ evaluateGoldenForVocab: () => Promise.resolve({ ...OK_GOLDEN, mustNotViolations: 1 }) });
    const decision = await evaluateProposal(MINI_VOCAB, getBaseline, deprecateProposal("B.MACH.INDUSTRIAL_ROBOT"), checks);
    expect(decision.decision).toBe("rejected");
    expect(decision.reason).toContain("誤検出");
  });

  it("③ 取りこぼし率 (filterMissRate) が今の版から増えれば rejected", async () => {
    const getBaseline = vi.fn(baselineOf(OK_GOLDEN));
    const checks = baseChecks({ evaluateGoldenForVocab: () => Promise.resolve({ ...OK_GOLDEN, filterMissRate: 0.5 }) });
    const decision = await evaluateProposal(MINI_VOCAB, getBaseline, deprecateProposal("B.MACH.INDUSTRIAL_ROBOT"), checks);
    expect(decision.decision).toBe("rejected");
    expect(decision.reason).toContain("取りこぼし");
  });

  it("③ 基準の取りこぼし率が null (対象なし) でも、提案側で取りこぼしが発生 (>0) すれば増加扱いで rejected", async () => {
    const getBaseline = vi.fn(baselineOf({ ...OK_GOLDEN, filterMissRate: null }));
    const checks = baseChecks({ evaluateGoldenForVocab: () => Promise.resolve({ ...OK_GOLDEN, filterMissRate: 0.1 }) });
    const decision = await evaluateProposal(MINI_VOCAB, getBaseline, deprecateProposal("B.MACH.INDUSTRIAL_ROBOT"), checks);
    expect(decision.decision).toBe("rejected");
    expect(decision.reason).toContain("取りこぼし");
  });

  it("③ 基準・提案の取りこぼし率がどちらも null なら合格 (この項目では落ちず adopted)", async () => {
    const getBaseline = vi.fn(baselineOf({ ...OK_GOLDEN, filterMissRate: null }));
    const checks = baseChecks({ evaluateGoldenForVocab: () => Promise.resolve({ ...OK_GOLDEN, filterMissRate: null }) });
    const decision = await evaluateProposal(MINI_VOCAB, getBaseline, addKeywordsProposal(), checks);
    expect(decision.decision).toBe("adopted");
  });

  it("④ 変更量が上限 (2割) を超えれば rejected", async () => {
    // MINI_VOCAB は非廃止 business 7件 + theme 2件 = 9件。2割 = 1.8 → 2件廃止で超過。
    const proposal: Proposal = {
      baseVersion: MINI_VOCAB.version,
      noChange: false,
      sourcesChecked: deprecateProposal("x").sourcesChecked,
      changes: [
        { op: "deprecate", id: "B.MACH.MACHINE_TOOL", evidence: deprecateProposal("x").changes[0]!.evidence },
        { op: "deprecate", id: "B.MOBI.AUTO_OEM", evidence: deprecateProposal("x").changes[0]!.evidence },
      ],
    };
    const decision = await evaluateProposal(MINI_VOCAB, baselineOf(OK_GOLDEN), proposal, baseChecks());
    expect(decision.decision).toBe("rejected");
    expect(decision.reason).toContain("変更量");
    expect(MAX_CHANGED_RATIO).toBe(0.2);
  });

  it("④ 系統ごとの廃止量が上限 (1割) を超えれば rejected", async () => {
    // 分母は「非廃止 business 総数」(7件。診断は diff.ts の changeStats 参照)。
    // MACH 系統を 1 件廃止するだけで 1/7 ≒ 14.3% となり上限 (10%) を超える
    // (非廃止 business 総数が小さいフィクスチャのため)。
    const decision = await evaluateProposal(
      MINI_VOCAB,
      baselineOf(OK_GOLDEN),
      deprecateProposal("B.MACH.INDUSTRIAL_ROBOT"),
      baseChecks()
    );
    expect(decision.decision).toBe("rejected");
    expect(decision.reason).toContain("系統");
    expect(MAX_DEPRECATED_RATIO_PER_FAMILY).toBe(0.1);
  });

  it("全ての関門を通れば adopted (新しい単語帳・差分を返す)", async () => {
    const decision = await evaluateProposal(MINI_VOCAB, baselineOf(OK_GOLDEN), addKeywordsProposal(), baseChecks());
    expect(decision.decision).toBe("adopted");
    expect(decision.newVocab?.version).toBe("v2");
    expect(decision.diff?.changedTermIds).toEqual(["B.MACH.MACHINE_TOOL"]);
  });
});

describe("firstMondayOfAugust / reviewDeadline", () => {
  it.each([
    ["2024", "2024-08-05"],
    ["2025", "2025-08-04"],
    ["2026", "2026-08-03"],
    ["2027", "2027-08-02"],
    ["2028", "2028-08-07"],
    ["2029", "2029-08-06"],
    ["2030", "2030-08-05"],
  ])("%s年の第1月曜は %s", (year, expected) => {
    expect(firstMondayOfAugust(Number(year))).toBe(expected);
  });

  it("期限は第1月曜+7日", () => {
    expect(reviewDeadline(2027)).toBe("2027-08-09");
    expect(reviewDeadline(2026)).toBe("2026-08-10");
  });
});

function ledgerEntry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    pageId: "p",
    name: "x",
    kind: "提案",
    state: "未審査",
    version: null,
    hash: "h",
    recordedAt: "2026-01-01",
    reason: "",
    diff: "",
    rollbackFrom: null,
    ...overrides,
  };
}

describe("checkDeadline", () => {
  // 2026-09 に稼働した (台帳の最初の版) 前提。2027 年からが見直しの対象年。
  const v1 = ledgerEntry({ kind: "版", state: "有効", recordedAt: "2026-09-25" });

  it("期限前は通知不要", () => {
    const result = checkDeadline("2027-08-01", [v1]);
    expect(result.shouldNotify).toBe(false);
  });

  it("期限を過ぎて提案が無ければ通知が必要", () => {
    const result = checkDeadline("2027-08-10", [v1]);
    expect(result.shouldNotify).toBe(true);
    expect(result.year).toBe(2027);
    expect(result.deadline).toBe("2027-08-09");
    expect(result.notApplicable).toBeUndefined();
  });

  it("8/1以降に提案 (変更なしの提案含む) が記録済みなら通知不要", () => {
    const entries = [v1, ledgerEntry({ kind: "提案", state: "変更なし", recordedAt: "2027-08-03" })];
    const result = checkDeadline("2027-08-10", entries);
    expect(result.shouldNotify).toBe(false);
  });

  it("今年分の通知が既にあれば再通知しない (毎日は鳴らさない)", () => {
    const entries = [v1, ledgerEntry({ kind: "通知", state: "送信済", recordedAt: "2027-08-10" })];
    const result = checkDeadline("2027-08-15", entries);
    expect(result.shouldNotify).toBe(false);
  });

  it("去年の提案・通知は今年の判定に影響しない", () => {
    const entries = [
      ledgerEntry({ kind: "版", state: "有効", recordedAt: "2025-09-01" }),
      ledgerEntry({ kind: "提案", state: "変更なし", recordedAt: "2026-08-03" }),
      ledgerEntry({ kind: "通知", state: "送信済", recordedAt: "2026-08-11" }),
    ];
    const result = checkDeadline("2027-08-10", entries);
    expect(result.shouldNotify).toBe(true);
  });

  it("稼働した年 (見直し開始日の後に最初の版) は対象外で鳴らさない", () => {
    const result = checkDeadline("2026-09-25", [v1]);
    expect(result.shouldNotify).toBe(false);
    expect(result.notApplicable).toContain("2026-08-03");
  });

  it("台帳に版が無い (初回投入前) なら鳴らさない", () => {
    const result = checkDeadline("2027-08-10", []);
    expect(result.shouldNotify).toBe(false);
    expect(result.notApplicable).toBeDefined();
  });
});

describe("runGate", () => {
  function makeDeps(entries: LedgerEntry[], overrides: Partial<GateChecks> = {}) {
    const store = new Map(entries.map((e) => [e.pageId, e] as const));
    const jsonStore = new Map<string, unknown>();
    return {
      store,
      jsonStore,
      deps: {
        ledgerDbId: "ledger-db",
        listLedgerEntries: (
          _dbId: string,
          filter?: { kind?: LedgerEntry["kind"]; state?: LedgerEntry["state"] }
        ) =>
          Promise.resolve(
            [...store.values()].filter(
              (e) => (!filter?.kind || e.kind === filter.kind) && (!filter?.state || e.state === filter.state)
            )
          ),
        readLedgerJson: (entry: LedgerEntry) => Promise.resolve(jsonStore.get(entry.pageId)),
        createLedgerEntry: (
          _dbId: string,
          e: {
            name: string;
            kind: LedgerEntry["kind"];
            state: LedgerEntry["state"];
            version: string | null;
            reason: string;
            diff: string;
            rollbackFrom: string | null;
            json: unknown;
            recordedAt: string;
          }
        ) => {
          const entry = ledgerEntry({ ...e, pageId: `p-${store.size + 1}` });
          store.set(entry.pageId, entry);
          jsonStore.set(entry.pageId, e.json);
          return Promise.resolve(entry);
        },
        updateLedgerEntry: (
          pageId: string,
          patch: { state?: LedgerEntry["state"]; reason?: string; diff?: string }
        ) => {
          const cur = store.get(pageId);
          if (cur) store.set(pageId, { ...cur, ...patch });
          return Promise.resolve();
        },
        verifySources: overrides.verifySources ?? noIssues,
        evaluateGoldenForVocab: overrides.evaluateGoldenForVocab ?? (() => Promise.resolve(OK_GOLDEN)),
        recordedAt: "2026-09-25",
      },
    };
  }

  it("未審査の提案が無ければゴールデン再評価を行わずに終わる (jev 呼び出しゼロ)", async () => {
    const golden = vi.fn(() => Promise.resolve(OK_GOLDEN));
    const { deps } = makeDeps(
      [ledgerEntry({ pageId: "v1", kind: "版", state: "有効", version: "v1" })],
      { evaluateGoldenForVocab: golden }
    );
    const result = await runGate(deps);
    expect(result.reviewed).toBe(0);
    expect(golden).not.toHaveBeenCalled();
  });

  it("採用すると新しい版が有効になり、前の版は置換済になる", async () => {
    const { store, jsonStore, deps } = makeDeps([
      ledgerEntry({ pageId: "v1", kind: "版", state: "有効", version: "v1" }),
      ledgerEntry({ pageId: "prop1", kind: "提案", state: "未審査", version: "v1" }),
    ]);
    jsonStore.set("v1", MINI_VOCAB);
    jsonStore.set("prop1", {
      baseVersion: "v1",
      noChange: false,
      sourcesChecked: deprecateProposal("x").sourcesChecked,
      changes: [
        {
          op: "add_keywords",
          id: "B.MACH.MACHINE_TOOL",
          keywords: ["精密加工機"],
          evidence: deprecateProposal("x").changes[0]!.evidence,
        },
      ],
    });

    const result = await runGate(deps);
    expect(result.adopted).toEqual(["prop1"]);
    expect(store.get("v1")?.state).toBe("置換済");
    expect(store.get("prop1")?.state).toBe("採用");
    const newActive = [...store.values()].find((e) => e.kind === "版" && e.state === "有効");
    expect(newActive?.version).toBe("v2");
    expect(result.notify).toBeNull();
  });

  it("不採用になった提案は通知内容を返す", async () => {
    const { store, jsonStore, deps } = makeDeps(
      [
        ledgerEntry({ pageId: "v1", kind: "版", state: "有効", version: "v1" }),
        ledgerEntry({ pageId: "prop1", kind: "提案", state: "未審査", version: "v1", name: "提案A" }),
      ],
      { evaluateGoldenForVocab: () => Promise.resolve({ ...OK_GOLDEN, precisionYes: 0.5 }) }
    );
    jsonStore.set("v1", MINI_VOCAB);
    jsonStore.set("prop1", {
      baseVersion: "v1",
      noChange: false,
      sourcesChecked: deprecateProposal("x").sourcesChecked,
      changes: [
        {
          op: "add_keywords",
          id: "B.MACH.MACHINE_TOOL",
          keywords: ["精密加工機"],
          evidence: deprecateProposal("x").changes[0]!.evidence,
        },
      ],
    });

    const result = await runGate(deps);
    expect(result.rejected).toEqual(["prop1"]);
    expect(store.get("prop1")?.state).toBe("不採用");
    expect(result.notify?.summary).toContain("提案A");
  });

  it("変更なしの提案だけが残っている場合、ゴールデン再評価 (getBaseline) を一度も呼ばない", async () => {
    const golden = vi.fn(() => Promise.resolve(OK_GOLDEN));
    const { store, jsonStore, deps } = makeDeps(
      [
        ledgerEntry({ pageId: "v1", kind: "版", state: "有効", version: "v1" }),
        ledgerEntry({ pageId: "prop1", kind: "提案", state: "未審査", version: "v1", name: "提案A" }),
      ],
      { evaluateGoldenForVocab: golden }
    );
    jsonStore.set("v1", MINI_VOCAB);
    jsonStore.set("prop1", {
      baseVersion: "v1",
      noChange: true,
      reason: "変更なし",
      sourcesChecked: deprecateProposal("x").sourcesChecked,
      changes: [],
    });

    const result = await runGate(deps);
    expect(result.noChange).toEqual(["prop1"]);
    expect(store.get("prop1")?.state).toBe("変更なし");
    expect(golden).not.toHaveBeenCalled();
  });
});
