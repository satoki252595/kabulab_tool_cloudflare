/**
 * process.ts のテスト。設計 docs/005-yuho-quant-business-tags.md §5。
 * 依存は全てモック (実際の Notion/jev を叩かない)。実データは
 * オークマ 2026-03-31 期有報 S100YFQC「事業の内容」を使う。
 */
import { describe, expect, it, vi } from "vitest";
import type { SupplementRow, SupplementRowInput } from "../../../../src/shared/notion-archive/index.js";
import { JevUnavailableError, type JevAskResult, type JevClient } from "../../../../src/shared/jev/index.js";
import { TEXT_SECTIONS } from "../services/edinet/text-sections.js";
import type { WorkItem } from "./plan.js";
import { processStock, type ProcessDeps } from "./process.js";
import type { LatestDoc } from "./source.js";
import { MINI_VOCAB } from "./vocabulary/__fixtures__/mini-vocab.js";

/** 39本文列が全て null (=明示的に空) であることを確かめる。 */
function expectAllTextColumnsCleared(texts: Record<string, string | null> | undefined): void {
  expect(texts).toBeDefined();
  const keys = Object.keys(texts ?? {}).sort();
  expect(keys).toEqual(TEXT_SECTIONS.map((s) => s.title).sort());
  for (const s of TEXT_SECTIONS) {
    expect(texts?.[s.title]).toBeNull();
  }
}

const THRESHOLDS = { yesMin: 0.8, noMax: 0.2 };
const TODAY = "2026-09-25";

/** 実在する有報の文 (オークマ 2026-03-31 期 有報 S100YFQC「事業の内容」全文)。 */
const OKUMA_BUSINESS_TEXT =
  "３ 【事業の内容】当グループは、当社、連結子会社16社、非連結子会社15社で構成され、ＮＣ旋盤、" +
  "マシニングセンタ、複合加工機、ＮＣ研削盤等の工作機械の製造・販売を主な事業内容としております。";
/** 実在する有報の文 (極洋 2026-03-31 期 有報 S100YE8K「事業の内容」冒頭)。 */
const KYOKUYO_BUSINESS_TEXT =
  "３ 【事業の内容】当社及び当社の関係会社は、株式会社極洋(当社)、子会社36社、関連会社５社及び" +
  "非連結子会社１社により構成され、水産事業、生鮮事業、食品事業、物流サービス事業を主として行っております。";

function docOf(overrides: Partial<NonNullable<LatestDoc["doc"]>> = {}): NonNullable<LatestDoc["doc"]> {
  return {
    docId: "S100YFQC",
    docTypeCode: "120",
    periodEnd: "2026-03-31",
    submittedAt: "2026-06-25T00:00:00.000Z",
    notionDocPageId: "notion-page-okuma",
    textParseStatus: "ok",
    ...overrides,
  };
}

function itemOf(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    kind: "sync_and_tag",
    stockCode: "6103",
    companyName: "オークマ",
    sector33: "機械",
    doc: docOf(),
    row: null,
    reason: "test",
    ...overrides,
  };
}

function rowOf(overrides: Partial<SupplementRow> = {}): SupplementRow {
  return {
    pageId: "page-6103",
    stockCode: "6103",
    companyName: "オークマ",
    sector33: "機械",
    docId: null,
    docType: null,
    periodEnd: null,
    submittedAt: null,
    textStatus: null,
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

interface RecordedWrite {
  pageId: string | "created";
  input: SupplementRowInput;
}

function makeDeps(overrides: Partial<ProcessDeps> = {}) {
  const created: RecordedWrite[] = [];
  const updated: RecordedWrite[] = [];
  const evidenceCalls: Array<{ pageId: string; block: unknown }> = [];
  const deps: ProcessDeps = {
    vocab: MINI_VOCAB,
    thresholds: THRESHOLDS,
    jevClient: { askNoul: () => Promise.reject(new Error("jev は呼ばれない想定")) },
    today: TODAY,
    resolveMasterPageId: () => "master-page-1",
    readStockTextRow: () => Promise.reject(new Error("readStockTextRow は呼ばれない想定")),
    createSupplementRow: (input) => {
      created.push({ pageId: "created", input });
      return Promise.resolve("new-page-id");
    },
    updateSupplementRow: (pageId, input) => {
      updated.push({ pageId, input });
      return Promise.resolve();
    },
    replaceEvidenceBlock: (pageId, block) => {
      evidenceCalls.push({ pageId, block });
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, created, updated, evidenceCalls };
}

function jevAnswering(answers: Record<string, number>): JevClient {
  return {
    askNoul: async (_state, questions): Promise<JevAskResult> => {
      const resolved: Record<string, number> = {};
      for (const qid of Object.keys(questions)) {
        if (!(qid in answers)) throw new Error(`未設定の質問: ${qid}`);
        resolved[qid] = answers[qid] as number;
      }
      return { model: "mock", answers: resolved, inputTokens: 50, outputTokens: 0, latencyMs: 1, attempts: 1 };
    },
  };
}

describe("processStock", () => {
  it("skip: 何も書き込まない", async () => {
    const { deps, created, updated, evidenceCalls } = makeDeps();
    const row = rowOf({ tagStatus: "判定済", candidateCount: 3 });
    const outcome = await processStock(itemOf({ kind: "skip", row }), deps);
    expect(outcome.outcome).toBe("skipped");
    expect(outcome.tagStatus).toBe("判定済");
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
    expect(evidenceCalls).toHaveLength(0);
  });

  it("create_row: 本文なし状態で行を作るだけ (masterPageId を解決する)", async () => {
    const { deps, created } = makeDeps();
    const outcome = await processStock(itemOf({ kind: "create_row", doc: null }), deps);
    expect(outcome.outcome).toBe("created");
    expect(outcome.tagStatus).toBe("本文なし");
    expect(created).toHaveLength(1);
    expect(created[0]?.input).toMatchObject({
      textStatus: "本文なし",
      tagStatus: "本文なし",
      masterPageId: "master-page-1",
      docId: null,
    });
  });

  it("no_text: 既存行を本文なし状態に更新し、根拠ブロックを削除する", async () => {
    const { deps, updated, evidenceCalls } = makeDeps();
    const row = rowOf({ docId: "S100OLD", tagStatus: "判定済", upstream: ["工作機械"] });
    const outcome = await processStock(itemOf({ kind: "no_text", doc: null, row }), deps);
    expect(outcome.tagStatus).toBe("本文なし");
    expect(updated[0]?.input).toMatchObject({ textStatus: "本文なし", tagStatus: "本文なし", upstream: [], downstream: [] });
    // 旧書類の39本文列が残らず、明示的に全て空になる (設計の状態遷移表)。
    expectAllTextColumnsCleared(updated[0]?.input.texts);
    expect(evidenceCalls).toEqual([{ pageId: row.pageId, block: null }]);
  });

  describe("sync_and_tag (実データ: オークマ 工作機械)", () => {
    it("判定成功: タグ・根拠・判定日を書き込む (判定済)", async () => {
      const jevClient = jevAnswering({ "bt.B.MACH.MACHINE_TOOL": 0.95 });
      const { deps, created, evidenceCalls } = makeDeps({
        jevClient,
        readStockTextRow: () =>
          Promise.resolve([{ itemName: "事業の内容", sectionKey: "business", text: OKUMA_BUSINESS_TEXT }]),
      });
      const outcome = await processStock(itemOf(), deps);
      expect(outcome.tagStatus).toBe("判定済");
      expect(outcome.candidateCount).toBe(1);
      expect(outcome.jevCalls).toBe(1);
      const write = created[0]?.input;
      expect(write?.tagStatus).toBe("判定済");
      expect(write?.upstream).toEqual(["工作機械"]);
      expect(write?.themes).toEqual(["工作機械・産業用ロボット"]);
      expect(write?.tagDoc).toBe("S100YFQC 2026年3月期");
      expect(write?.vocabVersion).toBe(MINI_VOCAB.version);
      expect(write?.judgedAt).toBe(TODAY);
      expect(write?.error).toBeNull();
      expect(write?.attempts).toBe(0);
      // 根拠ブロックが実際に書かれる (該当語 1 件以上あるため null ではない)。
      expect(evidenceCalls).toHaveLength(1);
      expect(evidenceCalls[0]?.block).not.toBeNull();
    });

    it("候補語 0 件 (極洋): 判定済のまま該当タグ無し・根拠は無し", async () => {
      const jevClient: JevClient = { askNoul: () => Promise.reject(new Error("候補が無ければ jev を呼ばない")) };
      const { deps, created, evidenceCalls } = makeDeps({
        jevClient,
        readStockTextRow: () =>
          Promise.resolve([{ itemName: "事業の内容", sectionKey: "business", text: KYOKUYO_BUSINESS_TEXT }]),
      });
      const item = itemOf({
        stockCode: "1301",
        companyName: "極洋",
        doc: docOf({ docId: "S100YE8K", notionDocPageId: "notion-page-kyokuyo" }),
      });
      const outcome = await processStock(item, deps);
      expect(outcome.tagStatus).toBe("判定済");
      expect(outcome.candidateCount).toBe(0);
      expect(created[0]?.input).toMatchObject({ upstream: [], downstream: [], themes: [], uncertain: null });
      expect(evidenceCalls).toEqual([{ pageId: "new-page-id", block: null }]);
    });

    it("書類が変わったとき、古い書類のタグを引き継がず新しい書類のタグで置き換える (不変条件)", async () => {
      const jevClient = jevAnswering({ "bt.B.MACH.MACHINE_TOOL": 0.95 });
      const { deps, updated } = makeDeps({
        jevClient,
        readStockTextRow: () =>
          Promise.resolve([{ itemName: "事業の内容", sectionKey: "business", text: OKUMA_BUSINESS_TEXT }]),
      });
      // 既存行は古い書類 (別 docId) の下で「防衛」タグが付いていた想定。
      const oldRow = rowOf({
        docId: "S100OLD",
        tagStatus: "判定済",
        upstream: [],
        downstream: ["小火器・火砲"],
        vocabVersion: "v1",
        tagDoc: "S100OLD 2025年3月期",
      });
      const outcome = await processStock(itemOf({ kind: "sync_and_tag", row: oldRow }), deps);
      expect(outcome.outcome).toBe("updated");
      const write = updated.find((u) => u.pageId === oldRow.pageId)?.input;
      expect(write?.docId).toBe("S100YFQC");
      expect(write?.downstream).toEqual([]); // 古い「小火器・火砲」は残らない
      expect(write?.upstream).toEqual(["工作機械"]);
      expect(write?.tagDoc).toBe("S100YFQC 2026年3月期");
    });

    it("読込失敗: Notion 読取が例外を投げたら 読込失敗 + attempts+1 + 次回再試行日", async () => {
      const { deps, updated, evidenceCalls } = makeDeps({
        readStockTextRow: () => Promise.reject(new Error("Notion API error: 500")),
      });
      const row = rowOf({ attempts: 1 });
      const outcome = await processStock(itemOf({ row }), deps);
      expect(outcome.tagStatus).toBe("読込失敗");
      const write = updated.find((u) => u.pageId === row.pageId)?.input;
      expect(write?.textStatus).toBe("読込失敗");
      expect(write?.tagStatus).toBe("読込失敗");
      expect(write?.attempts).toBe(2); // 1回目失敗からの2回目
      expect(write?.nextRetryAt).toBe("2026-09-27"); // 2^(2-1)=2日後
      expect(write?.upstream).toEqual([]);
      expect(write?.error).toContain("読込に失敗");
      // 本文の読込自体に失敗しているので、旧書類の39本文列を残さず明示的に空にする。
      expectAllTextColumnsCleared(write?.texts);
      expect(evidenceCalls).toEqual([{ pageId: row.pageId, block: null }]);
    });

    it("jev 判定不能: JevUnavailableError なら 判定不能 + attempts+1 + 次回再試行日 (テキストは保存する)", async () => {
      const jevClient: JevClient = {
        askNoul: () => Promise.reject(new JevUnavailableError("jev がリトライ上限に達した", { status: 529 })),
      };
      const { deps, updated } = makeDeps({
        jevClient,
        readStockTextRow: () =>
          Promise.resolve([{ itemName: "事業の内容", sectionKey: "business", text: OKUMA_BUSINESS_TEXT }]),
      });
      const row = rowOf({ attempts: 0 });
      const outcome = await processStock(itemOf({ row }), deps);
      expect(outcome.tagStatus).toBe("判定不能");
      const write = updated.find((u) => u.pageId === row.pageId)?.input;
      expect(write?.textStatus).toBe("取得済"); // 本文の読込自体は成功している
      expect(write?.tagStatus).toBe("判定不能");
      expect(write?.attempts).toBe(1);
      expect(write?.nextRetryAt).toBe("2026-09-26"); // 2^(1-1)=1日後
      expect(write?.candidateCount).toBe(1); // 絞り込みまでは成功した事実を残す
      expect(write?.upstream).toEqual([]);
      expect(write?.error).toContain("jev 判定に失敗");
    });

    it("jev 以外の例外はそのまま伝播する (判定不能に丸め込まない)", async () => {
      const jevClient: JevClient = { askNoul: () => Promise.reject(new Error("想定外のバグ")) };
      const { deps } = makeDeps({
        jevClient,
        readStockTextRow: () =>
          Promise.resolve([{ itemName: "事業の内容", sectionKey: "business", text: OKUMA_BUSINESS_TEXT }]),
      });
      await expect(processStock(itemOf(), deps)).rejects.toThrow("想定外のバグ");
    });
  });

  it("version_bump: 版とテーマ列だけ更新し jev は呼ばない", async () => {
    const jevClient: JevClient = { askNoul: () => Promise.reject(new Error("version_bump では jev を呼ばない")) };
    const { deps, updated } = makeDeps({ jevClient });
    const row = rowOf({
      docId: "S100YFQC",
      tagStatus: "判定済",
      vocabVersion: "v0",
      upstream: ["工作機械"],
    });
    const outcome = await processStock(itemOf({ kind: "version_bump", row }), deps);
    expect(outcome.outcome).toBe("updated");
    expect(updated[0]?.input).toEqual({ themes: ["工作機械・産業用ロボット"], vocabVersion: MINI_VOCAB.version });
  });

  it("version_bump: 今の単語帳に無いラベルなら不変条件違反として throw する", async () => {
    const { deps } = makeDeps();
    const row = rowOf({ docId: "S100YFQC", tagStatus: "判定済", upstream: ["もう無いラベル"] });
    await expect(processStock(itemOf({ kind: "version_bump", row }), deps)).rejects.toThrow(/不変条件違反/);
  });

  it.each(["sync_and_tag", "retag", "retry"] as const)("%s に最新有報が無ければ throw する", async (kind) => {
    const { deps } = makeDeps();
    await expect(processStock(itemOf({ kind, doc: null }), deps)).rejects.toThrow();
  });

  it("no_text に既存行が無ければ throw する", async () => {
    const { deps } = makeDeps();
    await expect(processStock(itemOf({ kind: "no_text", doc: null, row: null }), deps)).rejects.toThrow();
  });

  it("version_bump に行または書類が無ければ throw する", async () => {
    const { deps } = makeDeps();
    await expect(processStock(itemOf({ kind: "version_bump", row: null }), deps)).rejects.toThrow();
  });
});

describe("processStock (spy 呼び出し回数)", () => {
  it("create_row では readStockTextRow / jev を一切呼ばない", async () => {
    const readSpy = vi.fn(() => Promise.reject(new Error("呼ばれない想定")));
    const askSpy = vi.fn(() => Promise.reject(new Error("呼ばれない想定")));
    const { deps } = makeDeps({ readStockTextRow: readSpy, jevClient: { askNoul: askSpy } });
    await processStock(itemOf({ kind: "create_row", doc: null }), deps);
    expect(readSpy).not.toHaveBeenCalled();
    expect(askSpy).not.toHaveBeenCalled();
  });
});
