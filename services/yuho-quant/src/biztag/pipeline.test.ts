import { createClefClient, CLEF_MODEL } from "../../../../src/shared/clef/client.js";
/**
 * 実I/Oを置き換えてrunの境界を検証する。
 * dry-runは台帳/補足を書かず新規の有料判定をHOLD。
 * 既存は保存済みマスタをコード参照し、未設定・失敗だけ機械判定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createJevClient, jevEnv } from "../../../../src/shared/jev/index.js";
import { assertLatestDocCurrent, loadLatestDocs, loadNewStockEligibility, type LatestDoc } from "./source.js";
import type { LedgerEntry, SupplementRow, SupplementRowInput } from "../../../../src/shared/notion-archive/index.js";
import type { StockTextSection } from "../../../../src/shared/notion-archive/stock-text.js";
import { makeBudgetedVerifySources } from "./sources-verify.js";
import { MINI_VOCAB } from "./vocabulary/__fixtures__/mini-vocab.js";
import { composeRunNotify, isBillingBlockedError, runBiztag, type RunSummary } from "./pipeline.js";
import { readInputReceipt, readTextSyncReceipt, withInputReceipt, withTextSyncReceipt } from "./plan.js";
import { PREFILTER_SECTIONS } from "./prefilter.js";
import { TEXT_SECTIONS } from "../services/edinet/text-sections.js";
import { NotionUnknownResultError } from "../../../../src/shared/notion-archive/client.js";
import { createSupplementPublicationJournal } from "../../../../scripts/biztag-local/publication-journal.js";

vi.mock("../../../../scripts/biztag-local/publication-journal.js", () => ({ createSupplementPublicationJournal: vi.fn(() => ({ assertReady: vi.fn(), reserve: vi.fn() })) }));
const notionMocks = vi.hoisted(() => ({
  createLedgerEntry: vi.fn(),
  updateLedgerEntry: vi.fn(),
  replaceLedgerJson: vi.fn(),
  listLedgerEntries: vi.fn(),
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
  createSupplementRow: vi.fn(async (_dbId: string, _row: SupplementRowInput) => "new-page"),
  updateSupplementRow: vi.fn(async (_pageId: string, _row: SupplementRowInput) => {}),
  replaceEvidenceBlock: vi.fn(async (_pageId: string, _block: unknown, _input: SupplementRowInput, _expected: Record<string, unknown>, guard: () => Promise<void>) => { await guard(); }),
  readStockTextRow: vi.fn(async (): Promise<StockTextSection[]> => []),
  notionStats: vi.fn(() => ({ requests: 0, rateLimited: 0, transientRetries: 0 })),
  resetNotionStats: vi.fn(),
}));

vi.mock("../../../../src/shared/notion-archive/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../src/shared/notion-archive/index.js")>(),
  ...notionMocks,
}));

vi.mock("../../../../src/shared/db/d1-http-client.js", () => ({
  createD1HttpDb: vi.fn(() => ({})),
}));

vi.mock("../../../../src/shared/jev/index.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../src/shared/jev/index.js")>(),
  // 停止 preflight は shared/jev/policy.test.ts の実 guard が検証する。
  assertTypeSafeEnabled: vi.fn(),
  createJevClient: vi.fn(() => ({ askNoul: vi.fn(async () => { throw new Error("jev は呼ばれない想定"); }) })),
  estimateCostUsd: vi.fn(() => 0),
  jevEnv: { TYPESAFE_API_KEY: vi.fn(() => "test-key") },
}));

vi.mock("../../../../src/shared/clef/client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../src/shared/clef/client.js")>(),
  createClefClient: vi.fn(() => ({ askNoul: vi.fn(async () => { throw new Error("Clef-Flash は呼ばれない想定"); }), close: vi.fn() })),
}));

vi.mock("../db/schema.js", () => ({}));

vi.mock("./source.js", () => ({
  assertLatestDocCurrent: vi.fn(async () => {}),
  loadLatestDocs: vi.fn(async () => []),
  loadNewStockEligibility: vi.fn(async () => ({ eligibleCodes: new Set<string>(), heldCodes: new Set<string>() })),
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
  todayJst: vi.fn((now?: () => number) => now ? new Date(now() + 9 * 60 * 60_000).toISOString().slice(0, 10) : "2026-09-25"),
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
 * 置換済の旧版 (v0)。保存済みタグ参照では本文・JSONを読み直さない。
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
  vi.stubEnv("BIZTAG_NEW_LISTING_FROM", "2026-09-01");
  vi.mocked(loadLatestDocs).mockResolvedValue([]);
  vi.mocked(loadNewStockEligibility).mockResolvedValue({ eligibleCodes: new Set(), heldCodes: new Set() });
  setupListLedgerEntries();
});
afterEach(() => vi.unstubAllEnvs());

describe("runBiztag dry-run スコープ", () => {
  it("prior publisher unknown stops before all metadata and model factories", async () => {
    vi.mocked(createSupplementPublicationJournal).mockImplementationOnce(() => { throw new NotionUnknownResultError("saved publisher intent incomplete"); });
    await expect(runBiztag({ budgetMs: 10_000, thresholds: { yesMin: 0.8, noMax: 0.2 }, model: CLEF_MODEL })).rejects.toThrow("publisher intent incomplete");
    expect(loadNewStockEligibility).not.toHaveBeenCalled(); expect(loadLatestDocs).not.toHaveBeenCalled();
    expect(notionMocks.ensureLedgerDb).not.toHaveBeenCalled(); expect(createClefClient).not.toHaveBeenCalled();
  });
  it("dryRun: true では台帳への書込 (通知・見直し材料) を一切行わない", async () => {
    const summary = await runBiztag({
      budgetMs: 10_000,
      dryRun: true,
      thresholds: { yesMin: 0.8, noMax: 0.2 },
      model: CLEF_MODEL,
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
      model: CLEF_MODEL,
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

  it("通常runは語彙の有料審査・golden・キー取得を行わず停止を明示する", async () => {
    const summary = await runBiztag({
      budgetMs: 1_000,
      thresholds: { yesMin: 0.8, noMax: 0.2 },
      model: CLEF_MODEL,
    });
    expect(makeBudgetedVerifySources).not.toHaveBeenCalled();
    expect(createJevClient).not.toHaveBeenCalled();
    expect(createClefClient).not.toHaveBeenCalled();
    expect(summary.gate).toBeNull();
    expect(summary.gateSkippedReason).toContain("停止中");
    expect(jevEnv.TYPESAFE_API_KEY).not.toHaveBeenCalled();
  });
});

describe("runBiztag 新規と既存の外部判定境界", () => {
  const latest: LatestDoc = { stockCode: "0001", companyName: "判定境界テスト", sector33: null,
    doc: { docId: "TEST_DOC", docTypeCode: "120", periodEnd: "2026-03-31",
      submittedAt: "2026-06-25T00:00:00.000Z", notionDocPageId: "test-text", textParseStatus: "ok" } };
  const opts = { budgetMs: 10_000, thresholds: { yesMin: 0.8, noMax: 0.2 }, model: CLEF_MODEL };
  const text = [{ itemName: "事業の内容", sectionKey: "business", text: "工作機械を製造・販売しております。" }];

  it("既存の課金失敗は機械で復旧し、新規key/clientに触れない", async () => {
    vi.mocked(loadLatestDocs).mockResolvedValue([latest]);
    notionMocks.loadSupplementRows.mockResolvedValueOnce([minimalRow({ stockCode: "0001", docId: "TEST_DOC",
      tagStatus: "判定不能", attempts: 5, nextRetryAt: "2027-01-01", error: "status=402" })]);
    notionMocks.readStockTextRow.mockResolvedValueOnce(text);
    const summary = await runBiztag(opts);
    expect(createJevClient).not.toHaveBeenCalled();
    expect(createClefClient).not.toHaveBeenCalled();
    expect(jevEnv.TYPESAFE_API_KEY).not.toHaveBeenCalled();
    expect(summary.jev.calls).toBe(0);
    expect(summary.billingBlocked).toEqual([]);
    expect(notionMocks.replaceEvidenceBlock.mock.calls[0][2].judgeInput).toContain("機械照合");
  });

  it("新規資格成立の初回だけClef-Flashを起動し、終了後に解放する", async () => {
    vi.mocked(loadLatestDocs).mockResolvedValue([latest]);
    vi.mocked(loadNewStockEligibility).mockResolvedValue({ eligibleCodes: new Set(["0001"]), heldCodes: new Set() });
    notionMocks.readStockTextRow.mockResolvedValueOnce(text);
    const askNoul = vi.fn(async () => ({ model: CLEF_MODEL, answers: { "bt.B.MACH.MACHINE_TOOL": 0.95 },
      inputTokens: 50, outputTokens: 0, latencyMs: 1, attempts: 1 }));
    const close = vi.fn();
    vi.mocked(createClefClient).mockReturnValueOnce({ askNoul, close });
    const summary = await runBiztag(opts);
    expect(jevEnv.TYPESAFE_API_KEY).not.toHaveBeenCalled();
    expect(createJevClient).not.toHaveBeenCalled();
    expect(createClefClient).toHaveBeenCalledWith();
    expect(close).toHaveBeenCalledTimes(1);
    expect(summary.judge).toMatchObject({ provider: "clef", externalApiCalls: 0, costMetering: "not_metered_local", tokens: null, hardwareCostUsd: null });
    expect(askNoul).toHaveBeenCalledTimes(1);
    expect(summary.jev.calls).toBe(1);
    expect(notionMocks.createSupplementRow.mock.calls[0][1].judgeInput).toMatch(/^Clef-Flash新規銘柄の初回判定/);
  });

  it.each(["dryRun", "mechanicalOnly"] as const)("新規の%sは推論も機械への代替もせず保留する", async (mode) => {
    vi.mocked(loadLatestDocs).mockResolvedValue([latest]);
    vi.mocked(loadNewStockEligibility).mockResolvedValue({ eligibleCodes: new Set(["0001"]), heldCodes: new Set() });
    const summary = await runBiztag({ ...opts, [mode]: true });
    expect(createJevClient).not.toHaveBeenCalled();
    expect(createClefClient).not.toHaveBeenCalled();
    expect(jevEnv.TYPESAFE_API_KEY).not.toHaveBeenCalled();
    expect(notionMocks.readStockTextRow).not.toHaveBeenCalled();
    expect(notionMocks.createSupplementRow).not.toHaveBeenCalled();
    expect(summary.qualificationHeld).toEqual(["0001"]);
    expect(summary.countsByKind[mode === "mechanicalOnly" ? "initial_judge_mechanical_hold" : "initial_judge_dry_run_hold"]).toBe(1);
  });

  it("mechanical-onlyの本文同期は旧判定を保持し、較正・モデルに触れず共通publisherを使う", async () => {
    vi.mocked(loadLatestDocs).mockResolvedValue([latest]);
    notionMocks.loadSupplementRows.mockResolvedValueOnce([minimalRow({ stockCode: "0001", docId: "TEST_DOC",
      tagStatus: "判定済", tagDoc: "TEST_DOC 2026年3月期", vocabVersion: MINI_VOCAB.version, judgeInput: "保存済み旧判定" })]);
    notionMocks.readStockTextRow.mockResolvedValueOnce(text);
    const summary = await runBiztag({ ...opts, mechanicalOnly: true, get thresholds(): typeof opts.thresholds { throw new Error("機械処理では較正を読まない"); } });
    expect(summary.mechanicalOnly).toBe(true);
    expect(summary.countsByKind.sync_text).toBe(1);
    expect(summary.judge?.calls).toBe(0);
    expect(summary.failures).toEqual([]);
    expect(notionMocks.replaceEvidenceBlock).toHaveBeenCalledTimes(1);
    expect(notionMocks.replaceEvidenceBlock.mock.calls[0][2].judgeInput).toContain("保存済み旧判定");
    expect(notionMocks.replaceEvidenceBlock.mock.calls[0][2].upstream).toBeUndefined();
    expect(createClefClient).not.toHaveBeenCalled();
    expect(createJevClient).not.toHaveBeenCalled();
  });

  it("実保存215Aの旧receiptは既定skip、固定finite refreshだけ通常planner→同producer/publisherへ進む", async () => {
    const actual = JSON.parse(gunzipSync(readFileSync(new URL("./competitors/fixtures/prepare-actual-20261017.json.gz", import.meta.url))).toString());
    const latest = actual.latest[0] as LatestDoc, page = actual.pages[0];
    const rich = (name: string) => page.properties[name].rich_text.map((t: { plain_text: string }) => t.plain_text).join("");
    const row = minimalRow({ stockCode: latest.stockCode, companyName: latest.companyName, sector33: latest.sector33,
      docId: latest.doc!.docId, docType: latest.doc!.docTypeCode === "120" ? "有報" : "訂正有報", periodEnd: latest.doc!.periodEnd,
      submittedAt: latest.doc!.submittedAt, tagStatus: "判定済", tagDoc: rich("事業タグの根拠書類"),
      vocabVersion: page.properties["単語帳の版"].select.name, judgeInput: rich("判定入力") });
    // その他の保存tag/根拠は判断し直さず、既存fixtureのlegacy入力を保持する。
    vi.mocked(loadLatestDocs).mockResolvedValue([latest]); notionMocks.loadSupplementRows.mockResolvedValue([row]);
    notionMocks.readStockTextRow.mockResolvedValue(TEXT_SECTIONS.flatMap(s => rich(s.title) === "" ? [] : [{ sectionKey: s.key, itemName: s.title, text: rich(s.title) }]));
    const finite = { ...opts, codes: [latest.stockCode], limit: 1, mechanicalOnly: true };
    expect((await runBiztag(finite)).countsByKind.skip).toBe(1);
    expect(notionMocks.readStockTextRow).not.toHaveBeenCalled(); expect(notionMocks.replaceEvidenceBlock).not.toHaveBeenCalled();
    const summary = await runBiztag({ ...finite, refreshTextReceipt: true });
    expect(summary).toMatchObject({ refreshTextReceipt: true, countsByKind: { sync_text: 1 }, failures: [] });
    expect(notionMocks.readStockTextRow).toHaveBeenCalledOnce(); expect(notionMocks.replaceEvidenceBlock).toHaveBeenCalledOnce();
    expect(notionMocks.replaceEvidenceBlock.mock.calls[0][2].judgeInput).toContain("notionTextsSha256");
    expect(createClefClient).not.toHaveBeenCalled(); expect(createJevClient).not.toHaveBeenCalled();
  });

  it.each([
    { mechanicalOnly: false, codes: ["215A"], limit: 1, budgetMs: 1000 },
    { mechanicalOnly: true, codes: undefined, limit: 1, budgetMs: 1000 },
    { mechanicalOnly: true, codes: ["215A"], limit: undefined, budgetMs: 1000 },
    { mechanicalOnly: true, codes: ["215A"], limit: 1, budgetMs: Infinity },
    { mechanicalOnly: true, codes: ["215A", "215A"], limit: 1, budgetMs: 1000 },
  ])("非finite refreshを全native/モデル前に停止: %o", async invalid => {
    await expect(runBiztag({ ...opts, ...invalid, refreshTextReceipt: true })).rejects.toThrow("mechanical-only");
    expect(loadLatestDocs).not.toHaveBeenCalled(); expect(loadNewStockEligibility).not.toHaveBeenCalled();
    expect(notionMocks.ensureSupplementDb).not.toHaveBeenCalled(); expect(createClefClient).not.toHaveBeenCalled();
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
    judgeInput: null,
    attempts: null,
    nextRetryAt: null,
    error: null,
    upstream: [],
    downstream: [],
    distribution: [],
    themes: [],
    uncertain: null,
    evidenceText: null,
    masterLinked: true,
    texts: {},
    ...overrides,
  };
}

describe("runBiztag — 保存済みマスタの参照", () => {
  it.each([
    { docId: "TEST_DOC", vocabVersion: "v0", dryRun: false },
    { docId: "TEST_DOC", vocabVersion: "v0", dryRun: true },
  ])("本文同期済みならdoc=$docId/版=$vocabVersion/dryRun=$dryRunでも保存タグ・根拠を保持し、本文を再読しない", async ({ docId, vocabVersion, dryRun }) => {
    vi.mocked(loadLatestDocs).mockResolvedValue([{ stockCode: "6103", companyName: "保存タグ確認",
      sector33: null, doc: { docId: "TEST_DOC", docTypeCode: "120", periodEnd: "2026-03-31",
        submittedAt: "2026-06-25T00:00:00.000Z", notionDocPageId: "test-text", textParseStatus: "ok" } }]);
    notionMocks.loadSupplementRows.mockResolvedValueOnce([minimalRow({ stockCode: "6103", docId,
      tagStatus: "判定済", tagDoc: docId, vocabVersion, upstream: ["工作機械"], evidenceText: "保存済み根拠",
      judgeInput: withTextSyncReceipt("保存済み判定説明", { docId, textPageId: "test-text", textsSha256: "1".repeat(64) }) })]);
    const summary = await runBiztag({ budgetMs: 10_000, dryRun,
      get thresholds(): never { throw new Error("保存タグ再利用はAI較正を読まない"); }, model: CLEF_MODEL });
    expect(summary.countsByKind.skip).toBe(1);
    expect(summary.coverage.judged).toBe(1);
    expect(notionMocks.loadSupplementRows).toHaveBeenCalledTimes(1);
    expect(notionMocks.loadSupplementRows.mock.calls[0]?.[2]).toBeUndefined();
    expect(notionMocks.readStockTextRow).not.toHaveBeenCalled();
    expect(notionMocks.readLedgerJson).not.toHaveBeenCalled();
    expect(notionMocks.updateSupplementRow).not.toHaveBeenCalled();
    expect(notionMocks.replaceEvidenceBlock).not.toHaveBeenCalled();
    expect(createJevClient).not.toHaveBeenCalled();
    expect(createClefClient).not.toHaveBeenCalled();
  });

  it("HOLD行の保存済み状態を現在の受入済み件数に加算しない", async () => {
    vi.mocked(loadLatestDocs).mockResolvedValue([{ stockCode: "6103", companyName: "保留確認", sector33: null, doc: null }]);
    vi.mocked(loadNewStockEligibility).mockResolvedValue({ eligibleCodes: new Set(), heldCodes: new Set(["6103"]) });
    notionMocks.loadSupplementRows.mockResolvedValueOnce([minimalRow({ stockCode: "6103", tagStatus: "判定済" })]);
    const summary = await runBiztag({ budgetMs: 10_000, thresholds: { yesMin: 0.8, noMax: 0.2 }, model: CLEF_MODEL });
    expect(summary.qualificationHeld).toEqual(["6103"]);
    expect(summary.countsByTagStatus["判定済"]).toBe(1);
    expect(summary.coverage.judged).toBe(0);
    expect(notionMocks.updateSupplementRow).not.toHaveBeenCalled();
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
    billingBlocked: [],
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

  it("課金切れブロッカーだけでも通知する (remaining:0 の green に埋もれさせない)", () => {
    const summary = baseSummary({ billingBlocked: ["4326", "3457"] });
    const result = composeRunNotify(summary);
    expect(result.notify).toBe(true);
    expect(result.summary).toContain("課金切れ");
    expect(result.summary).toContain("4326, 3457");
  });
});

describe("isBillingBlockedError", () => {
  it("402/billing_error 含有は true", () => {
    expect(
      isBillingBlockedError(
        "jev 判定に失敗: jev API がエラーを返しました（status=402）: {\"detail\":{\"error_type\":\"billing_error\"}}"
      )
    ).toBe(true);
  });

  it("null・空・他エラーは false", () => {
    expect(isBillingBlockedError(null)).toBe(false);
    expect(isBillingBlockedError("")).toBe(false);
    expect(isBillingBlockedError("jev API がタイムアウトしました")).toBe(false);
  });
});

describe("runBiztag — billingBlocked 集計", () => {
  it("判定不能+課金エラーの行を再試行上限到達・期日未来も含めて集計する", async () => {
    notionMocks.loadSupplementRows.mockResolvedValue([
      minimalRow({
        stockCode: "4326",
        tagStatus: "判定不能",
        error: "jev 判定に失敗（status=402）",
        attempts: 1,
        nextRetryAt: "2099-01-01",
      }),
      minimalRow({
        stockCode: "9999",
        tagStatus: "判定不能",
        error: "jev API がタイムアウトしました",
        attempts: 1,
      }),
      minimalRow({
        stockCode: "8888",
        tagStatus: "判定不能",
        error: "jev 判定に失敗（status=402）",
        attempts: 5,
      }),
    ]);
    const summary = await runBiztag({
      budgetMs: 10_000,
      dryRun: true,
      thresholds: { yesMin: 0.8, noMax: 0.2 },
      model: CLEF_MODEL,
    });
    expect(summary.billingBlocked).toEqual(["4326", "8888"]);
  });
});


describe("runBiztag input-change safety", () => {
  it.each(["mechanicalOnly", "dryRun"] as const)("%s compares real saved39 known four-section inputs before semantic factories", async mode => {
    const actual = JSON.parse(gunzipSync(readFileSync(new URL("./competitors/fixtures/prepare-actual-20261017.json.gz", import.meta.url))).toString());
    const latest = actual.latest[0] as LatestDoc, page = actual.pages[0];
    const rich = (name: string) => page.properties[name].rich_text.map((t: { plain_text: string }) => t.plain_text).join("");
    const sections = TEXT_SECTIONS.flatMap(s => rich(s.title) === "" ? [] : [{ sectionKey: s.key, itemName: s.title, text: rich(s.title) }]);
    const text = new Map(sections.map(s => [s.sectionKey, s.text])), sha = (s: string) => createHash("sha256").update(s).digest("hex");
    // 実保存39本文のprotocol投影。歴史的に存在しない判定入力の回復とは扱わない。
    const judgeInput = withInputReceipt(rich("判定入力"), { docId: latest.doc!.docId, textPageId: "previous-pointer",
      businessSha256: sha(text.get("business")!), sectionsSha256: sha(JSON.stringify(PREFILTER_SECTIONS.map(key => [key, text.has(key) ? text.get(key) : null]))),
      stateSha256: null, vocabVersion: page.properties["単語帳の版"].select.name, model: null });
    const row = minimalRow({ stockCode: latest.stockCode, companyName: latest.companyName, sector33: latest.sector33,
      docId: latest.doc!.docId, tagDoc: rich("事業タグの根拠書類"), tagStatus: "判定済",
      vocabVersion: page.properties["単語帳の版"].select.name, judgeInput });
    const before = structuredClone(row), localJournal = vi.fn(() => { throw new Error("no journal for mechanical comparison"); });
    vi.mocked(loadLatestDocs).mockResolvedValue([latest]); notionMocks.loadSupplementRows.mockResolvedValue([row]);
    notionMocks.readStockTextRow.mockResolvedValue(sections);
    const opts = { budgetMs: 10_000, [mode]: true, model: CLEF_MODEL, localJournal,
      get thresholds(): never { throw new Error("no calibration for mechanical comparison"); } };
    const same = await runBiztag(opts);
    expect(same).toMatchObject({ countsByKind: { retag: 1 }, qualificationHeld: [], failures: [], judge: { calls: 0 }, coverage: { judged: 1 } });
    expect(notionMocks.readStockTextRow).toHaveBeenCalledTimes(1);
    if (mode === "mechanicalOnly") {
      const written = notionMocks.replaceEvidenceBlock.mock.calls[0][2];
      expect(readInputReceipt(written.judgeInput)).toEqual(readInputReceipt(judgeInput));
      expect(readTextSyncReceipt(written.judgeInput)?.equivalentJudgmentInputSha256).toBe(readInputReceipt(judgeInput)!.sectionsSha256);
      for (const key of ["upstream", "tagStatus", "tagDoc", "vocabVersion", "judgedAt", "evidenceText"]) expect(written).not.toHaveProperty(key);
    }
    notionMocks.replaceEvidenceBlock.mockClear(); notionMocks.readStockTextRow.mockClear();
    // 別の実保存社の本文で差分を注入する負例。旧入力の別社への転用ではない。
    const otherBusiness = actual.pages[1].properties["事業の内容"].rich_text.map((t: { plain_text: string }) => t.plain_text).join("");
    notionMocks.readStockTextRow.mockResolvedValue(sections.map(s => s.sectionKey === "business" ? { ...s, text: otherBusiness } : s));
    const different = await runBiztag(opts);
    expect(different).toMatchObject({ countsByKind: { retag: 1 }, qualificationHeld: [latest.stockCode], failures: [], judge: { calls: 0 }, coverage: { judged: 0 } });
    expect(notionMocks.readStockTextRow).toHaveBeenCalledTimes(1); expect(notionMocks.replaceEvidenceBlock).not.toHaveBeenCalled();
    expect(row).toEqual(before); expect(localJournal).not.toHaveBeenCalled();
    expect(createClefClient).not.toHaveBeenCalled(); expect(createJevClient).not.toHaveBeenCalled(); expect(jevEnv.TYPESAFE_API_KEY).not.toHaveBeenCalled();
  });
  function changedSource() {
    vi.mocked(loadLatestDocs).mockResolvedValue([{ stockCode: "6103", companyName: "オークマ", sector33: "機械",
      doc: { docId: "S100YFQC", docTypeCode: "120", periodEnd: "2026-03-31", submittedAt: "2026-06-25T00:00:00Z", notionDocPageId: "new-text", textParseStatus: "ok" } }]);
    notionMocks.loadSupplementRows.mockResolvedValueOnce([minimalRow({ stockCode: "6103", docId: "S100OLD", tagDoc: "S100OLD 2025年3月期", tagStatus: "判定済", vocabVersion: "v0", upstream: ["工作機械"], evidenceText: "保存済み根拠" })]);
  }
  it.each(["dryRun", "mechanicalOnly"] as const)("%s source changes do not read fulltext, infer, or change existing values", async (mode) => {
    changedSource();
    const summary = await runBiztag({ budgetMs: 10_000, [mode]: true, thresholds: { yesMin: 0.8, noMax: 0.2 }, model: CLEF_MODEL });
    expect(summary.countsByKind[mode === "mechanicalOnly" ? "source_change_mechanical_hold" : "source_change_dry_run_hold"]).toBe(1);
    expect(summary.qualificationHeld).toEqual(["6103"]);
    expect(summary.coverage.judged).toBe(0);
    expect(notionMocks.readStockTextRow).not.toHaveBeenCalled();
    expect(notionMocks.replaceEvidenceBlock).not.toHaveBeenCalled();
    expect(createClefClient).not.toHaveBeenCalled(); expect(createJevClient).not.toHaveBeenCalled();
  });
  it("write直前latest guard失敗を旧判定済のcurrent coverageへ加算しない", async () => {
    changedSource();
    notionMocks.readStockTextRow.mockResolvedValueOnce([{ sectionKey: "business", itemName: "事業の内容", text: "工作機械の製造・販売を行っています。" }]);
    vi.mocked(createClefClient).mockReturnValueOnce({ askNoul: async () => ({ model: "mock", answers: { "bt.B.MACH.MACHINE_TOOL": 0.95 }, inputTokens: 1, outputTokens: 0, latencyMs: 1, attempts: 1 }), close: async () => {} });
    vi.mocked(assertLatestDocCurrent).mockRejectedValueOnce(new Error("最新pointer変更 HOLD"));
    const summary = await runBiztag({ budgetMs: 10_000, thresholds: { yesMin: 0.8, noMax: 0.2 }, model: CLEF_MODEL });
    expect(summary.qualificationHeld).toEqual(["6103"]); expect(summary.coverage.judged).toBe(0);
    expect(summary.failures[0].message).toContain("最新pointer変更"); expect(summary.judge?.calls).toBe(1);
    expect(notionMocks.updateSupplementRow).not.toHaveBeenCalled(); expect(assertLatestDocCurrent).toHaveBeenCalledTimes(1);
  });
  it("unknown inference preserves old values and stops before the next item or ledger tail", async () => {
    changedSource();
    notionMocks.readStockTextRow.mockResolvedValueOnce([{ sectionKey: "business", itemName: "事業の内容", text: "工作機械の製造・販売を行っています。" }]);
    vi.mocked(createClefClient).mockReturnValueOnce({ askNoul: async () => { throw new Error("unknown local result"); }, close: async () => {} });
    await expect(runBiztag({ budgetMs: 10_000, thresholds: { yesMin: 0.8, noMax: 0.2 }, model: CLEF_MODEL })).rejects.toThrow("unknown local result");
    expect(notionMocks.readStockTextRow).toHaveBeenCalledTimes(1);
    expect(notionMocks.updateSupplementRow).not.toHaveBeenCalled(); expect(notionMocks.replaceEvidenceBlock).not.toHaveBeenCalled();
    expect(createJevClient).not.toHaveBeenCalled();
    expect(notionMocks.listLedgerEntries.mock.calls.some(([, filter]) => filter?.kind === "見直し材料")).toBe(false);
  });
  it("publisher unknown stops all later inference and ordinary packet writes", async () => {
    changedSource();
    const first = (await loadLatestDocs({} as never))[0];
    // Explicit queue-order control. A second occurrence is never processed after unknown.
    vi.mocked(loadLatestDocs).mockResolvedValue([first, first]);
    notionMocks.readStockTextRow.mockResolvedValue([{ sectionKey: "business", itemName: "事業の内容", text: "工作機械の製造・販売を行っています。" }]);
    const askNoul = vi.fn(async () => ({ model: CLEF_MODEL, answers: { "bt.B.MACH.MACHINE_TOOL": 0.95 }, inputTokens: 0, outputTokens: 0, latencyMs: 1, attempts: 1 }));
    vi.mocked(createClefClient).mockReturnValueOnce({ askNoul, close: vi.fn() });
    notionMocks.replaceEvidenceBlock.mockRejectedValueOnce(new NotionUnknownResultError("append ACK unknown"));
    await expect(runBiztag({ budgetMs: 10_000, thresholds: { yesMin: 0.8, noMax: 0.2 }, model: CLEF_MODEL })).rejects.toThrow("ACK unknown");
    expect(askNoul).toHaveBeenCalledTimes(1); expect(notionMocks.readStockTextRow).toHaveBeenCalledTimes(1);
    expect(notionMocks.listLedgerEntries.mock.calls.some(([, filter]) => filter?.kind === "見直し材料")).toBe(false);
  });
  it("normal journal receives actual input receipt and records reuse as forward0", async () => {
    changedSource();
    notionMocks.readStockTextRow.mockResolvedValueOnce([{ sectionKey: "business", itemName: "事業の内容", text: "工作機械の製造・販売を行っています。" }]);
    const localJournal = vi.fn((_input: unknown) => ({ decidedAt: "2026-09-24T14:59:59Z", beforeSend: vi.fn(), response: vi.fn(), accepted: vi.fn() }));
    vi.mocked(createClefClient).mockReturnValueOnce({ askNoul: async () => ({ model: CLEF_MODEL, answers: { "bt.B.MACH.MACHINE_TOOL": 0.95 }, inputTokens: 0, outputTokens: 0, latencyMs: 1, attempts: 1, reused: true }), close: vi.fn() });
    const summary = await runBiztag({ budgetMs: 10_000, thresholds: { yesMin: 0.8, noMax: 0.2 }, model: CLEF_MODEL, localJournal });
    expect(localJournal).toHaveBeenCalledTimes(1);
    expect(localJournal.mock.calls[0][0]).toMatchObject({ stockCode: "6103", periodEnd: "2026-03-31", model: CLEF_MODEL, batchIndex: 0,
      receipt: { docId: "S100YFQC", textPageId: "new-text", model: null } });
    expect(summary.judge).toMatchObject({ calls: 0, reusedOutputs: 1 });
    expect(notionMocks.replaceEvidenceBlock.mock.calls[0][2]).toMatchObject({ judgedAt: "2026-09-24" });
  });
});
