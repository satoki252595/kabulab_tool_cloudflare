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
import type { LedgerEntry } from "../../../../src/shared/notion-archive/index.js";
import { MINI_VOCAB } from "./vocabulary/__fixtures__/mini-vocab.js";
import { runBiztag } from "./pipeline.js";

const notionMocks = vi.hoisted(() => ({
  createLedgerEntry: vi.fn(),
  updateLedgerEntry: vi.fn(),
  replaceLedgerJson: vi.fn(),
  listLedgerEntries: vi.fn(),
  readLedgerJson: vi.fn(),
  ensureLedgerDb: vi.fn(async () => "ledger-db-id"),
  ensureSupplementDb: vi.fn(async () => ({ dbId: "supplement-db-id", created: false, propertyIds: {} })),
  loadSupplementRows: vi.fn(async () => []),
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
 * `listLedgerEntries` の最小実装: 「版」照会には有効版1件、「提案・未審査」
 * には0件 (審査対象なし)、「見直し材料」には0件 (毎回新規作成させる) を返す。
 * それ以外 (フィルタ無し = 期限検査用) は版1件を返す。
 */
function setupListLedgerEntries(): void {
  notionMocks.listLedgerEntries.mockImplementation(
    async (_dbId: string, filter?: { kind?: string; state?: string }) => {
      if (filter?.kind === "提案") return [];
      if (filter?.kind === "見直し材料") return [];
      return [versionEntry()];
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
});
