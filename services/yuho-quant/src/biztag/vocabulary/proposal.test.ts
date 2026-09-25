/**
 * ProposalSchema / applyProposal のテスト。
 *
 * 提案は Cursor Automation という外部から届く JSON なので、schema は
 * strictObject で余計なキーを弾く。`applyProposal` は「提案を機械的に
 * 単語帳へ当てはめるだけ」の純粋関数で、意味検査 (validateVocabulary) は
 * 別関数の責務 — ここでは apply の機械的な正しさと throw 条件だけを見る。
 *
 * 語の内容は実データ抜粋 (`MINI_VOCAB`) をベースに、`evidence`/`sourcesChecked`
 * だけ最小限のダミーではなく実在の出典 (fixture の sources をそのまま流用)
 * にして固定する。
 */
import { describe, expect, it } from "vitest";
import { MINI_VOCAB } from "./__fixtures__/mini-vocab.js";
import type { BusinessTerm, Source, ThemeTerm } from "./schema.js";
import { applyProposal, MAX_PROPOSAL_SOURCE_REFS, ProposalSchema, type Change, type Proposal } from "./proposal.js";

/** fixture 内の実在の出典を 1 件借りる (evidence/sourcesChecked のダミー捏造を避ける)。 */
const REAL_SOURCE: Source = structuredClone(MINI_VOCAB.business[0].sources[0]);

function noChangeProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    baseVersion: "v1",
    noChange: true,
    reason: "公的資料を確認したが追加・変更すべき事業領域は無かった",
    sourcesChecked: [
      { title: REAL_SOURCE.title, url: REAL_SOURCE.url, date: REAL_SOURCE.date },
    ],
    changes: [],
    ...overrides,
  };
}

function changeProposal(changes: Change[], overrides: Partial<Proposal> = {}): Proposal {
  return {
    baseVersion: "v1",
    noChange: false,
    sourcesChecked: [
      { title: REAL_SOURCE.title, url: REAL_SOURCE.url, date: REAL_SOURCE.date },
    ],
    changes,
    ...overrides,
  };
}

describe("ProposalSchema", () => {
  it("noChange:true (reason あり・changes 空) は通る", () => {
    const parsed = ProposalSchema.safeParse(noChangeProposal());
    expect(parsed.success).toBe(true);
  });

  it("noChange:true なのに changes が非空だと落ちる", () => {
    const change: Change = { op: "deprecate", id: "B.SEMI.SILICON_WAFER", evidence: [REAL_SOURCE] };
    const parsed = ProposalSchema.safeParse(noChangeProposal({ noChange: true, changes: [change] }));
    expect(parsed.success).toBe(false);
  });

  it("noChange:true なのに reason が無いと落ちる", () => {
    const p = noChangeProposal();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (p as any).reason;
    expect(ProposalSchema.safeParse(p).success).toBe(false);
  });

  it("noChange:false なのに changes が空だと落ちる", () => {
    const parsed = ProposalSchema.safeParse(changeProposal([]));
    expect(parsed.success).toBe(false);
  });

  it("余計なキーがあると strictObject が弾く", () => {
    const p = { ...noChangeProposal(), unexpectedField: "x" };
    expect(ProposalSchema.safeParse(p).success).toBe(false);
  });

  it("add_business の term に addedIn/deprecated を含めると弾く (applyProposal 側が確定させるフィールド)", () => {
    const term = { ...structuredClone(MINI_VOCAB.business[0]), id: "B.SEMI.NEW_TERM" };
    const change = { op: "add_business" as const, term, evidence: [REAL_SOURCE] };
    expect(ProposalSchema.safeParse(changeProposal([change])).success).toBe(false);
  });

  it("exampleCompanies は termId → 4 文字コード配列", () => {
    const p = changeProposal(
      [{ op: "deprecate", id: "B.SEMI.SILICON_WAFER", evidence: [REAL_SOURCE] }],
      { exampleCompanies: { "B.SEMI.SILICON_WAFER": ["7011"] } }
    );
    expect(ProposalSchema.safeParse(p).success).toBe(true);
  });

  it("exampleCompanies のコードが 4 文字でないと弾く", () => {
    const p = changeProposal(
      [{ op: "deprecate", id: "B.SEMI.SILICON_WAFER", evidence: [REAL_SOURCE] }],
      { exampleCompanies: { "B.SEMI.SILICON_WAFER": ["12"] } }
    );
    expect(ProposalSchema.safeParse(p).success).toBe(false);
  });
});

describe("applyProposal", () => {
  function newBusinessTerm(id: string): Omit<BusinessTerm, "addedIn" | "deprecated"> {
    const { addedIn: _a, deprecated: _d, ...rest } = structuredClone(MINI_VOCAB.business[0]);
    return { ...rest, id, labelJa: "臨時新規語" };
  }

  function newThemeTerm(id: string, members: string[]): Omit<ThemeTerm, "addedIn" | "deprecated"> {
    const { addedIn: _a, deprecated: _d, ...rest } = structuredClone(MINI_VOCAB.themes[0]);
    return { ...rest, id, labelJa: "臨時新規テーマ", members };
  }

  it("baseVersion が今の版と違うと throw する", () => {
    const p = noChangeProposal({ baseVersion: "v2" });
    expect(() => applyProposal(MINI_VOCAB, p, "v2")).toThrow();
  });

  it("add_business: 新版の addedIn・deprecated:false を確定して追加する", () => {
    const term = newBusinessTerm("B.SEMI.NEW_TERM");
    const p = changeProposal([{ op: "add_business", term, evidence: [REAL_SOURCE] }]);
    const next = applyProposal(MINI_VOCAB, p, "v2");
    const added = next.business.find((t) => t.id === "B.SEMI.NEW_TERM");
    expect(added).toMatchObject({ ...term, addedIn: "v2", deprecated: false });
    expect(next.version).toBe("v2");
    // 元は変更しない (純粋関数)
    expect(MINI_VOCAB.business.some((t) => t.id === "B.SEMI.NEW_TERM")).toBe(false);
  });

  it("add_business: 既に存在する id を追加しようとすると throw する", () => {
    const term = newBusinessTerm("B.SEMI.SILICON_WAFER");
    const p = changeProposal([{ op: "add_business", term, evidence: [REAL_SOURCE] }]);
    expect(() => applyProposal(MINI_VOCAB, p, "v2")).toThrow();
  });

  it("add_theme: 新版の addedIn・deprecated:false を確定して追加する", () => {
    const term = newThemeTerm("T.NEW_THEME", ["B.SEMI.SILICON_WAFER"]);
    const p = changeProposal([{ op: "add_theme", term, evidence: [REAL_SOURCE] }]);
    const next = applyProposal(MINI_VOCAB, p, "v2");
    const added = next.themes.find((t) => t.id === "T.NEW_THEME");
    expect(added).toMatchObject({ ...term, addedIn: "v2", deprecated: false });
  });

  it("update: business 語の keywords を patch できる", () => {
    const p = changeProposal([
      {
        op: "update",
        id: "B.SEMI.SILICON_WAFER",
        patch: { keywords: ["新キーワード"] },
        evidence: [REAL_SOURCE],
      },
    ]);
    const next = applyProposal(MINI_VOCAB, p, "v2");
    const t = next.business.find((x) => x.id === "B.SEMI.SILICON_WAFER");
    expect(t?.keywords).toEqual(["新キーワード"]);
  });

  it("update: id が見つからないと throw する", () => {
    const p = changeProposal([
      { op: "update", id: "B.NOT_EXIST.FOO", patch: { labelJa: "x" }, evidence: [REAL_SOURCE] },
    ]);
    expect(() => applyProposal(MINI_VOCAB, p, "v2")).toThrow();
  });

  it("update: business 語に members (theme 専用) を patch しようとすると throw する", () => {
    const p = changeProposal([
      {
        op: "update",
        id: "B.SEMI.SILICON_WAFER",
        patch: { members: ["B.SEMI.SILICON_WAFER"] },
        evidence: [REAL_SOURCE],
      },
    ]);
    expect(() => applyProposal(MINI_VOCAB, p, "v2")).toThrow();
  });

  it("update: theme に notionColumn (business 専用) を patch しようとすると throw する", () => {
    const p = changeProposal([
      {
        op: "update",
        id: "T.HYDROGEN",
        patch: { notionColumn: "upstream" },
        evidence: [REAL_SOURCE],
      },
    ]);
    expect(() => applyProposal(MINI_VOCAB, p, "v2")).toThrow();
  });

  it("update: 廃止済みの語は patch できない", () => {
    const base = structuredClone(MINI_VOCAB);
    const t = base.business.find((x) => x.id === "B.SEMI.SILICON_WAFER");
    if (!t) throw new Error("unreachable");
    t.deprecated = true;
    const p = changeProposal([
      { op: "update", id: "B.SEMI.SILICON_WAFER", patch: { labelJa: "新名前" }, evidence: [REAL_SOURCE] },
    ]);
    expect(() => applyProposal(base, p, "v2")).toThrow();
  });

  it("add_keywords: 既存の keywords に追記する (置き換えない)", () => {
    const before = MINI_VOCAB.business.find((t) => t.id === "B.SEMI.SILICON_WAFER");
    if (!before) throw new Error("unreachable");
    const p = changeProposal([
      { op: "add_keywords", id: "B.SEMI.SILICON_WAFER", keywords: ["追加語"], evidence: [REAL_SOURCE] },
    ]);
    const next = applyProposal(MINI_VOCAB, p, "v2");
    const after = next.business.find((t) => t.id === "B.SEMI.SILICON_WAFER");
    expect(after?.keywords).toEqual([...before.keywords, "追加語"]);
  });

  it("deprecate: business/theme のどちらも廃止できる", () => {
    const p = changeProposal([
      { op: "deprecate", id: "B.SEMI.SILICON_WAFER", evidence: [REAL_SOURCE] },
      { op: "deprecate", id: "T.HYDROGEN", evidence: [REAL_SOURCE] },
    ]);
    const next = applyProposal(MINI_VOCAB, p, "v2");
    expect(next.business.find((t) => t.id === "B.SEMI.SILICON_WAFER")?.deprecated).toBe(true);
    expect(next.themes.find((t) => t.id === "T.HYDROGEN")?.deprecated).toBe(true);
  });

  it("deprecate: 既に廃止済みの語を再度廃止しようとすると throw する", () => {
    const base = structuredClone(MINI_VOCAB);
    const t = base.business.find((x) => x.id === "B.SEMI.SILICON_WAFER");
    if (!t) throw new Error("unreachable");
    t.deprecated = true;
    const p = changeProposal([{ op: "deprecate", id: "B.SEMI.SILICON_WAFER", evidence: [REAL_SOURCE] }]);
    expect(() => applyProposal(base, p, "v2")).toThrow();
  });
});

/**
 * レビュー指摘の回帰: 出典検査 (`sources-verify.ts`) の逐次 fetch が
 * 長時間化しないよう、schema の時点で (url, quote) の合計に上限を課す。
 */
describe("ProposalSchema — 出典・根拠の量的上限 (関門の出典検査の長時間化対策)", () => {
  it("1つの変更の evidence が21件 (上限20件超) だと落ちる", () => {
    const evidence = Array.from({ length: 21 }, () => structuredClone(REAL_SOURCE));
    const p = changeProposal([{ op: "deprecate", id: "B.SEMI.SILICON_WAFER", evidence }]);
    expect(ProposalSchema.safeParse(p).success).toBe(false);
  });

  it("1つの変更の evidence が20件 (上限ちょうど) までは通る", () => {
    const evidence = Array.from({ length: 20 }, () => structuredClone(REAL_SOURCE));
    const p = changeProposal([{ op: "deprecate", id: "B.SEMI.SILICON_WAFER", evidence }]);
    expect(ProposalSchema.safeParse(p).success).toBe(true);
  });

  it(`(url, quote) の合計が ${MAX_PROPOSAL_SOURCE_REFS + 1} 件 (上限超過) だと落ちる`, () => {
    // changes を複数に分けて集める (1変更あたり evidence 20件までのため)。
    const perChange = 20;
    const numChanges = Math.ceil((MAX_PROPOSAL_SOURCE_REFS + 1) / perChange);
    const changes: Change[] = Array.from({ length: numChanges }, (_, i) => ({
      op: "deprecate" as const,
      id: i % 2 === 0 ? "B.SEMI.SILICON_WAFER" : "B.MACH.MACHINE_TOOL",
      evidence: Array.from({ length: perChange }, () => structuredClone(REAL_SOURCE)),
    }));
    const p = changeProposal(changes);
    const total = changes.reduce((sum, c) => sum + (c.op === "deprecate" ? c.evidence.length : 0), 0);
    expect(total).toBeGreaterThan(MAX_PROPOSAL_SOURCE_REFS);
    expect(ProposalSchema.safeParse(p).success).toBe(false);
  });

  it(`(url, quote) の合計がちょうど ${MAX_PROPOSAL_SOURCE_REFS} 件までは通る`, () => {
    const perChange = 20;
    const numChanges = Math.floor(MAX_PROPOSAL_SOURCE_REFS / perChange);
    const changes: Change[] = Array.from({ length: numChanges }, (_, i) => ({
      op: "deprecate" as const,
      id: i % 2 === 0 ? "B.SEMI.SILICON_WAFER" : "B.MACH.MACHINE_TOOL",
      evidence: Array.from({ length: perChange }, () => structuredClone(REAL_SOURCE)),
    }));
    const p = changeProposal(changes);
    expect(ProposalSchema.safeParse(p).success).toBe(true);
  });
});
