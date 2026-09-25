/**
 * pipeline.ts (`runBiztag`) の dry-run スコープのテスト。
 * 設計: docs/005-yuho-quant-business-tags.md §2・§7・§9・§11.2。
 *
 * `dryRun: true` は「銘柄マスタ（補足）」への書込だけでなく、単語帳の関門
 * (`runGate`)・見直し期限の通知・見直し材料 (`refreshReviewPacketLedger`) の
 * 台帳書込も止めなければならない (レビュー指摘: dry-run でも実際に版が進んで
 * しまうバグの回帰テスト)。判定・審査そのもの (jev 呼び出し・出典検査・
 * 見直し材料の内容比較) は dry-run でも実データで行われる前提のため、この
 * テストでは「未審査の提案が無い」シナリオに絞り、以下の 2 経路だけを検証する:
 *
 *   1. 見直し期限が過ぎていて未通知なら「通知」を台帳に書く経路
 *   2. 「見直し材料」が台帳に無ければ新規作成する経路 (review.ts)
 *
 * どちらも本来はレビュー指摘前は dryRun に関わらず実際に notion-archive の
 * `createLedgerEntry` (raw import) を呼んでいた。ここでは notion-archive
 * モジュール全体をモックし、その raw な `createLedgerEntry`/`updateLedgerEntry`/
 * `replaceLedgerJson` が dry-run 時には一切呼ばれないことを確かめる。
 *
 * D1・jev・単語帳解決・ゴールデンセット等の重い依存は全てモックし、
 * `latest`/`rows` を空にして `processStock` 自体が呼ばれない最小シナリオにする
 * (この経路は process.test.ts が別途保証している)。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LedgerEntry, SupplementRow } from "../../../../src/shared/notion-archive/index.js";
import { makeBudgetedVerifySources } from "./sources-verify.js";
import { MINI_VOCAB } from "./vocabulary/__fixtures__/mini-vocab.js";
import { composeRunNotify, runBiztag, type RunSummary } from "./pipeline.js";

const notionMocks = vi.hoisted(() => ({
  createLedgerEntry: vi.fn(),
  updateLedgerEntry: vi.fn(),
  replaceLedgerJson: vi.fn(),
  listLedgerEntries: vi.fn(),
  // 版の影響判定 (buildVocabDiffResolver) が旧版の JSON を読む経路のデフォルト。
  // 中身は使わない (isImpacted は latest=[] のテストでは呼ばれない) が、
  // parseVocabulary が通る形である必要はある。
  readLedgerJson: vi.fn(async () => MINI_VOCAB),
  ensureLedgerDb: vi.fn(async () => "ledger-db-id"),
  ensureSupplementDb: vi.fn(async () => ({ dbId: "supplement-db-id", created: false, propertyIds: {} })),
  loadSupplementRows: vi.fn(
    async (
      _dbId?: string,
      _propertyIds?: Record<string, string>,
      _opts?: { textColumns?: string[]; codes?: string[] }
    ): Promise<SupplementRow[]> => []
  ),
  loadStockMasterIndex: vi.fn(async () => ({ index: new Map<string, string>(), duplicates: new Map<string, string[]>() })),
  createSupplementRow: vi.fn(async () => "new-page"),
  updateSupplementRow: vi.fn(async () => {}),
  replaceEvidenceBlock: vi.fn(async () => {}),
  readStockTextRow: vi.fn(async () => []),
  notionStats: vi.fn(() => ({ requests: 0, rateLimited: 0, transientRetries: 0 })),
  resetNotionStats: vi.fn(),
}));

vi.mock("../../../../src/shared/notion-archive/index.js", () => notionMocks);

vi.mock("../../../../src/shared/db/d1-http-client.js", () => ({
  createD1HttpDb: vi.fn(() => ({})),
}));

vi.mock("../../../../src/shared/jev/index.js", () => ({
  createJevClient: vi.fn(() => ({ askNoul: vi.fn(async () => { throw new Error("jev は呼ばれない想定"); }) })),
  estimateCostUsd: vi.fn(() => 0),
  jevEnv: { TYPESAFE_API_KEY: () => "test-key" },
}));

vi.mock("../db/schema.js", () => ({}));

vi.mock("./source.js", () => ({
  loadLatestDocs: vi.fn(async () => []),
}));

vi.mock("./active-vocab.js", () => ({
  resolveActiveVocabulary: vi.fn(async () => ({
    vocab: MINI_VOCAB,
    entry: { pageId: "ver-1" } as unknown as LedgerEntry,
    seeded: false,
  })),
}));

vi.mock("./date-jst.js", () => ({
  // 見直し期限 (8月第1月曜+7日) を確実に過ぎている固定日付にする。
  todayJst: vi.fn(() => "2026-09-25"),
  addDaysJst: vi.fn((d: string) => d),
}));

vi.mock("./sources-verify.js", () => ({
  verifySources: vi.fn(async () => []),
  DEFAULT_VERIFY_SOURCES_BUDGET_MS: 5 * 60_000,
  makeBudgetedVerifySources: vi.fn(() => async () => []),
}));

vi.mock("./golden.js", () => ({
  evaluateGolden: vi.fn(),
  goldenItemKey: vi.fn(),
  loadGoldenSet: vi.fn(),
}));

/** 台帳の「版・有効」1件 (実データ判定を通すための最小の版レコード)。 */
function versionEntry(): LedgerEntry {
  return {
    pageId: "ver-1",
    name: "版 v1",
    kind: "版",
    state: "有効",
    version: MINI_VOCAB.version,
    hash: "h",
    recordedAt: "2025-01-01",
    reason: "",
    diff: "",
    rollbackFrom: null,
  };
}

/**
 * 置換済の旧版 (v0)。版の影響判定 (`buildVocabDiffResolver`) が
 * `vocabVersion: "v0"` の行を見たときに台帳から引けるようにするための
 * 最小レコード (pipeline-golden-texts.test.ts 等とは無関係の別テスト用)。
 */
function oldVersionEntry(): LedgerEntry {
  return {
    pageId: "ver-0",
    name: "版 v0",
    kind: "版",
    state: "置換済",
    version: "v0",
    hash: "h0",
    recordedAt: "2024-01-01",
    reason: "",
    diff: "",
    rollbackFrom: null,
  };
}

/**
 * `listLedgerEntries` の最小実装: 「版」照会には有効版(v1)+旧版(v0)、
 * 「提案・未審査」には0件 (審査対象なし)、「見直し材料」には0件
 * (毎回新規作成させる) を返す。それ以外 (フィルタ無し = 期限検査用) も同じ。
 */
function setupListLedgerEntries(): void {
  notionMocks.listLedgerEntries.mockImplementation(
    async (_dbId: string, filter?: { kind?: string; state?: string }) => {
      if (filter?.kind === "提案") return [];
      if (filter?.kind === "見直し材料") return [];
      return [versionEntry(), oldVersionEntry()];
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setupListLedgerEntries();
});

describe("runBiztag dry-run スコープ", () => {
  it("dryRun: true では台帳への書込 (通知・見直し材料) を一切行わない", async () => {
    const summary = await runBiztag({
      budgetMs: 10_000,
      dryRun: true,
      thresholds: { yesMin: 0.8, noMax: 0.2 },
      model: "test-model",
    });

    // 期限切れ通知が「必要」と判定されていること (このテストの前提が成立している確認)。
    expect(summary.deadline.shouldNotify).toBe(true);
    // にもかかわらず、台帳への実書込 (raw な createLedgerEntry/updateLedgerEntry/
    // replaceLedgerJson) は一度も呼ばれない。
    expect(notionMocks.createLedgerEntry).not.toHaveBeenCalled();
    expect(notionMocks.updateLedgerEntry).not.toHaveBeenCalled();
    expect(notionMocks.replaceLedgerJson).not.toHaveBeenCalled();
    // 読み取り系 (listLedgerEntries) は実データで判定するため呼ばれる。
    expect(notionMocks.listLedgerEntries).toHaveBeenCalled();
    // 補足行の書込も (既存の保証だが) dry-run では行わない。
    expect(notionMocks.createSupplementRow).not.toHaveBeenCalled();
    expect(notionMocks.updateSupplementRow).not.toHaveBeenCalled();
  });

  it("dryRun を指定しない (実行) 場合は、同じ状況で台帳へ実際に書き込む", async () => {
    const summary = await runBiztag({
      budgetMs: 10_000,
      thresholds: { yesMin: 0.8, noMax: 0.2 },
      model: "test-model",
    });

    expect(summary.deadline.shouldNotify).toBe(true);
    // 通知1件 + 見直し材料の新規作成1件で、raw な createLedgerEntry が呼ばれる。
    expect(notionMocks.createLedgerEntry).toHaveBeenCalled();
    const kinds = notionMocks.createLedgerEntry.mock.calls.map(
      (c: unknown[]) => (c[1] as { kind: string }).kind
    );
    expect(kinds).toContain("通知");
    expect(kinds).toContain("見直し材料");
  });

  it("出典検査 (verifySources) に opts.budgetMs から切り出した時間予算を持たせる (関門の長時間化対策)", async () => {
    // レビュー指摘の回帰: runGate (出典検査を含む) が opts.budgetMs に縛られて
    // いなかったため、悪意/不注意な提案が catchup.yml (60分)/backfill.yml
    // (355分) のジョブタイムアウトまで実質ハングさせられた。
    await runBiztag({
      budgetMs: 1_000,
      thresholds: { yesMin: 0.8, noMax: 0.2 },
      model: "test-model",
    });
    // DEFAULT_VERIFY_SOURCES_BUDGET_MS (5分) より opts.budgetMs (1秒) の方が
    // 小さいので、その小さい方が使われる (budgetMs をそのまま食い潰さない
    // ための「独立した予算」であって「budgetMs を無視してよい」わけではない)。
    expect(makeBudgetedVerifySources).toHaveBeenCalledWith(1_000);
  });
});

/** テストで使う最小の SupplementRow (見ないフィールドは無害な既定値で埋める)。 */
function minimalRow(overrides: Partial<SupplementRow>): SupplementRow {
  return {
    pageId: `page-${overrides.stockCode ?? "0000"}`,
    stockCode: "0000",
    companyName: "テスト株式会社",
    sector33: null,
    docId: "S1000000",
    docType: "有報",
    periodEnd: "2026-03-31",
    submittedAt: "2026-06-25",
    textStatus: "取得済",
    tagStatus: null,
    tagDoc: null,
    vocabVersion: null,
    judgedAt: null,
    candidateCount: null,
    attempts: null,
    nextRetryAt: null,
    error: null,
    upstream: [],
    downstream: [],
    themes: [],
    uncertain: null,
    masterLinked: true,
    texts: {},
    ...overrides,
  };
}

describe("runBiztag — 版の影響判定 (stale rows) の本文列再取得", () => {
  it("版が違う判定済み行が一部だけの時、その銘柄コードだけ本文列つきで読み直す (全件を読み直さない)", async () => {
    // レビュー指摘の回帰: 旧実装は 1 行でも stale (判定済・版違い) なら
    // 補足 DB の全行 (数千件) を本文列つきで読み直していたため、版を上げた
    // 直後の移行期間 (数日〜数週間) の間、毎日の 20 分予算の大半が
    // 「stale ではない大多数の行の重い本文列」の再取得に消える問題があった。
    const stale = minimalRow({ stockCode: "1301", tagStatus: "判定済", vocabVersion: "v0" });
    const fresh = minimalRow({ stockCode: "6103", tagStatus: "判定済", vocabVersion: MINI_VOCAB.version });
    const notYetJudged = minimalRow({ stockCode: "9999", tagStatus: "本文なし", vocabVersion: null });
    notionMocks.loadSupplementRows
      .mockResolvedValueOnce([stale, fresh, notYetJudged])
      .mockResolvedValueOnce([{ ...stale, texts: { 事業の内容: "本文" } }]);

    await runBiztag({
      budgetMs: 10_000,
      thresholds: { yesMin: 0.8, noMax: 0.2 },
      model: "test-model",
    });

    expect(notionMocks.loadSupplementRows).toHaveBeenCalledTimes(2);
    // 1回目: 状態の列だけ (textColumns 無し)。
    expect(notionMocks.loadSupplementRows.mock.calls[0]?.[2]).toBeUndefined();
    // 2回目: stale な "1301" だけを codes で絞り、本文列つきで読む
    // ("6103"・"9999" を含めない = 全件を読み直さない)。
    expect(notionMocks.loadSupplementRows.mock.calls[1]?.[2]).toMatchObject({
      codes: ["1301"],
    });
    const textColumns = (notionMocks.loadSupplementRows.mock.calls[1]?.[2] as { textColumns?: string[] })
      ?.textColumns;
    expect(textColumns?.length).toBeGreaterThan(0);
  });

  it("stale な行が無ければ、本文列つきの読み直しは一切行わない (1回だけ読む)", async () => {
    const fresh = minimalRow({ stockCode: "6103", tagStatus: "判定済", vocabVersion: MINI_VOCAB.version });
    notionMocks.loadSupplementRows.mockResolvedValueOnce([fresh]);

    await runBiztag({
      budgetMs: 10_000,
      thresholds: { yesMin: 0.8, noMax: 0.2 },
      model: "test-model",
    });

    expect(notionMocks.loadSupplementRows).toHaveBeenCalledTimes(1);
  });

  it("stale な銘柄コードが90件を超えると、Notion の compound filter 上限を避けるため複数回に分けて問い合わせる", async () => {
    const staleRows = Array.from({ length: 95 }, (_, i) =>
      minimalRow({ stockCode: `S${String(i).padStart(3, "0")}`, tagStatus: "判定済", vocabVersion: "v0" })
    );
    notionMocks.loadSupplementRows
      .mockResolvedValueOnce(staleRows)
      .mockImplementationOnce(async (_dbId?: string, _propertyIds?: Record<string, string>, opts?: { codes?: string[] }) =>
        staleRows.filter((r) => opts?.codes?.includes(r.stockCode))
      )
      .mockImplementationOnce(async (_dbId?: string, _propertyIds?: Record<string, string>, opts?: { codes?: string[] }) =>
        staleRows.filter((r) => opts?.codes?.includes(r.stockCode))
      );

    await runBiztag({
      budgetMs: 10_000,
      thresholds: { yesMin: 0.8, noMax: 0.2 },
      model: "test-model",
    });

    // 1回目 (状態のみ) + チャンク分割された stale codes の問い合わせ (95件 ÷ 90件/チャンク → 2回)。
    expect(notionMocks.loadSupplementRows).toHaveBeenCalledTimes(3);
    const codesPerCall = notionMocks.loadSupplementRows.mock.calls
      .slice(1)
      .map((c) => (c[2] as { codes?: string[] }).codes?.length);
    expect(codesPerCall).toEqual([90, 5]);
  });
});

/**
 * `composeRunNotify` のテスト (レビュー指摘の回帰): docs §11.6 が約束する
 * 3 条件 (関門停止・見直し期限切れ・再試行上限到達) のうち、旧実装は
 * 「再試行上限到達」を一切計算しておらず、かつ gate/deadline が両方
 * 該当しないと `summary.failures` の内容ごと notify:false にして
 * 握りつぶしていた。
 */
function baseSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    startedAt: "2026-09-25T00:00:00.000Z",
    elapsedMs: 0,
    budgetMs: 0,
    dryRun: false,
    totalStocks: 0,
    processed: 0,
    remaining: 0,
    countsByKind: {},
    countsByTagStatus: {},
    coverage: { judged: 0, total: 0, ratio: 0 },
    jev: { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    notion: { requests: 0, rateLimited: 0, transientRetries: 0 },
    vocabVersion: "v1",
    vocabSeeded: false,
    gate: { reviewed: 0, adopted: [], rejected: [], noChange: [], notify: null },
    deadline: { shouldNotify: false, year: 2026, deadline: "2026-08-11" },
    failures: [],
    masterDuplicates: [],
    retryExhausted: [],
    ...overrides,
  };
}

describe("composeRunNotify", () => {
  it("関門・期限切れ・再試行上限・失敗のいずれも無ければ notify:false", () => {
    expect(composeRunNotify(baseSummary())).toEqual({ notify: false });
  });

  it("関門で提案が不採用になったら、その理由を通知する (最優先)", () => {
    const summary = baseSummary({
      gate: { reviewed: 1, adopted: [], rejected: ["提案A"], noChange: [], notify: { title: "[biztag] 単語帳の関門で不採用", summary: "出典が確認できませんでした" } },
    });
    const result = composeRunNotify(summary);
    expect(result).toEqual({ notify: true, title: "[biztag] 単語帳の関門で不採用", summary: "出典が確認できませんでした" });
  });

  it("見直し期限が切れていたら通知する", () => {
    const summary = baseSummary({ deadline: { shouldNotify: true, year: 2026, deadline: "2026-08-11" } });
    const result = composeRunNotify(summary);
    expect(result.notify).toBe(true);
    expect(result.title).toBe("[biztag] 単語帳の見直しが期限切れです");
    expect(result.summary).toContain("2026-08-11");
  });

  it("再試行上限に達したまま残っている銘柄があれば通知する (旧実装は検知していなかった3番目の条件)", () => {
    const summary = baseSummary({ retryExhausted: ["1301", "6103"] });
    const result = composeRunNotify(summary);
    expect(result.notify).toBe(true);
    expect(result.title).toBe("[biztag] 再試行上限に達したまま残っている銘柄があります");
    expect(result.summary).toContain("2 件");
    expect(result.summary).toContain("1301, 6103");
  });

  it("gate/deadline/retryExhausted のいずれも該当しなくても、失敗銘柄があれば通知する (旧実装は notify:false にして failures を握りつぶしていた)", () => {
    const summary = baseSummary({ failures: [{ stockCode: "9999", message: "想定外のエラー" }] });
    const result = composeRunNotify(summary);
    expect(result.notify).toBe(true);
    expect(result.summary).toContain("9999: 想定外のエラー");
  });

  it("① 銘柄マスタ重複だけでも通知する", () => {
    const summary = baseSummary({ masterDuplicates: ["7129", "3681"] });
    const result = composeRunNotify(summary);
    expect(result.notify).toBe(true);
    expect(result.summary).toContain("① 銘柄マスタ重複");
    expect(result.summary).toContain("7129, 3681");
  });

  it("主要因の通知 (期限切れ) にも、失敗・再試行上限・① 銘柄マスタ重複の詳細を書き足す (取りこぼさない)", () => {
    const summary = baseSummary({
      deadline: { shouldNotify: true, year: 2026, deadline: "2026-08-11" },
      failures: [{ stockCode: "9999", message: "エラー" }],
      retryExhausted: ["1301"],
      masterDuplicates: ["7129"],
    });
    const result = composeRunNotify(summary);
    expect(result.summary).toContain("期限");
    expect(result.summary).toContain("9999: エラー");
    expect(result.summary).toContain("1301");
    expect(result.summary).toContain("7129");
  });
});
