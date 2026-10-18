import { SemifUnavailableError } from "../../../../src/shared/semif/index.js";
/**
 * process.ts のテスト。設計 docs/005-yuho-quant-business-tags.md §5。
 * 依存は全てモック (実際の Notion/jev を叩かない)。実データは
 * オークマ 2026-03-31 期有報 S100YFQC「事業の内容」を使う。
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { SupplementRow, SupplementRowInput } from "../../../../src/shared/notion-archive/index.js";
import { type JevAskResult, type JevClient } from "../../../../src/shared/jev/index.js";
import { INPUT_RECEIPT_PREFIX, readInputReceipt, readTextSyncReceipt, withInputReceipt, withTextSyncReceipt, type WorkItem } from "./plan.js";
import { TEXT_SECTIONS } from "../services/edinet/text-sections.js";
import { PREFILTER_SECTIONS } from "./prefilter.js";
import { buildSupplementProperties } from "../../../../src/shared/notion-archive/stock-supplement.js";
import { processStock, type ProcessDeps } from "./process.js";
import type { LatestDoc } from "./source.js";
import { MINI_VOCAB } from "./vocabulary/__fixtures__/mini-vocab.js";

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

interface RecordedWrite {
  pageId: string | "created";
  input: SupplementRowInput;
}

function makeDeps(overrides: Partial<ProcessDeps> = {}) {
  const created: RecordedWrite[] = [];
  const updated: RecordedWrite[] = [];
  const evidenceCalls: Array<{ pageId: string; block: unknown }> = [];
  // 呼び出し順序を横断で確認するための共有ログ (findings: 既存行は
  // 根拠ブロックの置き換え → プロパティ更新の順で呼ばれる必要がある)。
  const callOrder: Array<"createSupplementRow" | "updateSupplementRow" | "replaceEvidenceBlock"> = [];
  const deps: ProcessDeps = {
    vocab: MINI_VOCAB,
    thresholds: THRESHOLDS,
    model: "Qwen3.5-4B@851bf6e/semif-mlx",
    jevClient: { askNoul: () => Promise.reject(new Error("jev は呼ばれない想定")) },
    today: TODAY,
    resolveMasterPageId: () => "master-page-1",
    readStockTextRow: () => Promise.reject(new Error("readStockTextRow は呼ばれない想定")),
    assertLatestDocCurrent: async () => {},
    createSupplementRow: (input, evidence) => {
      callOrder.push("createSupplementRow");
      created.push({ pageId: "created", input });
      if (evidence !== undefined) evidenceCalls.push({ pageId: "new-page-id", block: evidence });
      return Promise.resolve("new-page-id");
    },
    updateSupplementRow: (pageId, input) => {
      callOrder.push("updateSupplementRow");
      updated.push({ pageId, input });
      return Promise.resolve();
    },
    replaceEvidenceBlock: async (pageId, block, input, _expected, guard) => {
      await guard();
      callOrder.push("replaceEvidenceBlock");
      evidenceCalls.push({ pageId, block });
      callOrder.push("updateSupplementRow");
      updated.push({ pageId, input });
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, created, updated, evidenceCalls, callOrder };
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
  it("本文なしでも基本metaだけ補完し、正規null/sourceguard・旧HOLD/タグ/receiptを保持", async () => {
    const row = rowOf({ docId: null, sector33: null, masterLinked: false, textStatus: "本文なし", tagStatus: "本文なし", judgeInput: null });
    const current = vi.fn(async () => {}), source = vi.fn(async () => { throw Error("no document must not read body"); });
    const { deps, updated, evidenceCalls } = makeDeps({ assertLatestDocCurrent: current, readStockTextRow: source });
    const outcome = await processStock(itemOf({ kind: "sync_metadata", basicMetadataOnly: true, qualificationHeld: true, doc: null, row }), deps);
    expect(outcome).toMatchObject({ outcome: "updated", metadataRepaired: true, qualificationHeld: true }); expect(outcome).not.toHaveProperty("textChecked");
    expect(updated[0].input).toEqual({ docId: null, sector33: "機械", masterPageId: "master-page-1" });
    expect(evidenceCalls[0].block).toBeUndefined(); expect(current).toHaveBeenCalledWith("6103", null, { companyName: "オークマ", sector33: "機械" }); expect(source).not.toHaveBeenCalled();
    expect(updated[0].input).not.toHaveProperty("textStatus"); expect(updated[0].input).not.toHaveProperty("judgeInput"); expect(updated[0].input).not.toHaveProperty("texts");
  });
  it("同じ現有報のメタ欠落だけをshared publisherで補完し、本文・旧判定・モデルを触らない", async () => {
    const doc = docOf(), row = rowOf({ docId: doc.docId, companyName: "", sector33: null, masterLinked: false, tagStatus: "判定済", judgeInput: "保存済み判定入力" });
    const guard = vi.fn(async () => {}), source = vi.fn(async () => { throw Error("metadata must not read source"); }), ask = vi.fn();
    const { deps, updated, evidenceCalls } = makeDeps({ assertLatestDocCurrent: guard, readStockTextRow: source, jevClient: { askNoul: ask } });
    const outcome = await processStock(itemOf({ kind: "sync_metadata", row }), deps);
    expect(outcome).toMatchObject({ outcome: "updated", metadataRepaired: true, jevCalls: 0 });
    expect(updated[0].input).toEqual({ docId: doc.docId, companyName: "オークマ", sector33: "機械", docType: "有報", periodEnd: doc.periodEnd, submittedAt: doc.submittedAt, textStatus: "取得済", masterPageId: "master-page-1" });
    expect(evidenceCalls[0].block).toBeUndefined(); expect(guard).toHaveBeenCalledOnce(); expect(source).not.toHaveBeenCalled(); expect(ask).not.toHaveBeenCalled();
    const repaired = { ...row, companyName: "オークマ", sector33: "機械", docType: "有報" as const, periodEnd: doc.periodEnd, submittedAt: doc.submittedAt, textStatus: "取得済" as const, masterLinked: true };
    updated.length = 0; expect(await processStock(itemOf({ kind: "sync_metadata", row: repaired }), deps)).toMatchObject({ outcome: "skipped", metadataRepaired: false }); expect(updated).toHaveLength(0);
  });

  it("同期receipt同値でも現在39の欠落を原本SHA確認後に復旧し、次回はsource/PATCH0。異なる原本はHOLD", async () => {
    const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex"), doc = docOf();
    const raw = TEXT_SECTIONS.map(({ key, title }) => [title, key === "business" ? OKUMA_BUSINESS_TEXT : null]);
    const input = withTextSyncReceipt("保存済み判定は不変", { docId: doc.docId, textPageId: doc.notionDocPageId!, textsSha256: hash(raw), notionTextsSha256: hash(raw) });
    const row = rowOf({ docId: doc.docId, docType: "有報", periodEnd: doc.periodEnd, submittedAt: doc.submittedAt, textStatus: "取得済", tagStatus: "判定済", judgeInput: input });
    let target = { ...row, texts: Object.fromEntries(TEXT_SECTIONS.map(({ title }) => [title, ""])) };
    const source = vi.fn(async () => [{ sectionKey: "business", itemName: "事業の内容", text: OKUMA_BUSINESS_TEXT }]), ask = vi.fn();
    const { deps, updated, evidenceCalls } = makeDeps({ readSupplementRowFully: async () => target, readStockTextRow: source, jevClient: { askNoul: ask } });
    const item = itemOf({ kind: "verify_text", row });
    expect(await processStock(item, deps)).toMatchObject({ textChecked: true, textMismatch: true, textRepaired: true, outcome: "updated" });
    expect(updated[0].input.texts?.["事業の内容"]).toBe(OKUMA_BUSINESS_TEXT); expect(evidenceCalls[0].block).toBeUndefined(); expect(updated[0].input.upstream).toBeUndefined(); expect(ask).not.toHaveBeenCalled();
    target = { ...target, judgeInput: updated[0].input.judgeInput!, texts: Object.fromEntries(raw.map(([title, text]) => [title, text === null ? "" : text])) };
    updated.length = 0;
    expect(await processStock({ ...item, row: target }, deps)).toMatchObject({ textChecked: true, textMismatch: false, outcome: "skipped" }); expect(updated).toHaveLength(0); expect(source).toHaveBeenCalledOnce();
    target = { ...target, texts: Object.fromEntries(TEXT_SECTIONS.map(({ title }) => [title, ""])) }; source.mockResolvedValue([{ sectionKey: "business", itemName: "事業の内容", text: KYOKUYO_BUSINESS_TEXT }]);
    expect(await processStock({ ...item, row: target }, deps)).toMatchObject({ textChecked: true, textMismatch: true, textRepaired: false, qualificationHeld: true }); expect(updated).toHaveLength(0);
  });

  it("9273実U+200B単一節の投影は原39 SHAを保持し、明示再資格で別送信SHAと実readbackを照合。再実行はNOOP", async () => {
    const actual = JSON.parse(readFileSync(new URL("../../../../src/shared/notion-archive/fixtures/9273-s100z2z6-notion-zero-width.json", import.meta.url), "utf8"));
    const sha = (x: string) => createHash("sha256").update(x).digest("hex");
    expect(sha(actual.rawText)).toBe(actual.provenance.rawTextSha256);
    const texts = TEXT_SECTIONS.map(({ key, title }) => [title, key === "sustainability" ? actual.rawText : null]);
    const rawSha = sha(JSON.stringify(texts)); // 他38節は未供与のテスト投影。実有報全39の回復証明ではない。
    const doc = docOf({ docId: actual.provenance.docId, periodEnd: actual.provenance.periodEnd, notionDocPageId: actual.provenance.textPageId });
    const oldInput = withTextSyncReceipt(actual.oldJudgeInput, { docId: doc.docId, textPageId: doc.notionDocPageId!, textsSha256: rawSha });
    const row = rowOf({ stockCode: actual.provenance.stockCode, docId: doc.docId, docType: "有報", periodEnd: doc.periodEnd, submittedAt: doc.submittedAt, textStatus: "取得済", tagStatus: "判定済", judgeInput: oldInput });
    const ask = vi.fn(), { deps, updated } = makeDeps({ jevClient: { askNoul: ask }, readStockTextRow: async () =>
      [{ sectionKey: actual.provenance.sectionKey, itemName: actual.provenance.property, text: actual.rawText }] });
    const item = itemOf({ stockCode: row.stockCode, doc, row, kind: "sync_text", refreshTextReceipt: true });
    expect(await processStock(item, deps)).toMatchObject({ outcome: "updated", jevCalls: 0 });
    const written = updated[0].input, receipt = readTextSyncReceipt(written.judgeInput)!;
    expect(receipt.textsSha256).toBe(rawSha); expect(receipt.notionTextsSha256).not.toBe(rawSha);
    const expected = texts.map(([title, value]) => [title, value === null ? null : String(value).replaceAll("\u200B", "")]);
    expect(receipt.notionTextsSha256).toBe(sha(JSON.stringify(expected)));
    expect(written.texts).toBeUndefined(); // 明示refreshは現在39本文をguardしてreceiptだけを書く。
    const props = buildSupplementProperties({ texts: { [actual.provenance.property]: actual.rawText } });
    const sent = (props[actual.provenance.property] as { rich_text: Array<{ text: { content: string } }> }).rich_text.map(t => t.text.content).join("");
    expect(sent).toBe(actual.notionReadbackText); expect(sha(sent)).toBe(actual.provenance.notionReadbackTextSha256);
    expect(readInputReceipt(written.judgeInput)).toBeNull(); expect(written.judgeInput!.startsWith(actual.oldJudgeInput)).toBe(true);
    updated.length = 0;
    expect(await processStock({ ...item, row: { ...row, judgeInput: written.judgeInput! } }, deps)).toMatchObject({ outcome: "skipped" });
    expect(updated).toHaveLength(1); // 同じpublisherへ現在39 guardを渡す。実mutation NOOPは共有suiteで検証。
    updated.length = 0; expect(ask).not.toHaveBeenCalled();
    expect(await processStock({ ...item, row: { ...row, judgeInput: withTextSyncReceipt(actual.oldJudgeInput,
      { docId: doc.docId, textPageId: doc.notionDocPageId!, textsSha256: actual.provenance.rawTextSha256 }) } }, deps))
      .toMatchObject({ qualificationHeld: true, outcome: "skipped" });
    expect(updated).toHaveLength(0);
    deps.readSupplementRowFully = async () => ({ ...row, texts: Object.fromEntries(expected.map(([title, value]) => [title, value === null ? "" : String(value)])) });
    const legacy = await processStock({ ...item, kind: "verify_text", refreshTextReceipt: false }, deps);
    expect(legacy).toMatchObject({ textChecked: true, textMismatch: false, textRepaired: false, outcome: "updated" });
    expect(updated[0].input.texts).toBeUndefined(); // 旧原SHA→wireSHAのreceipt再資格だけ。正常な本文を欠落修復と数えない。
    expect(readTextSyncReceipt(updated[0].input.judgeInput)?.notionTextsSha256).toBe(sha(JSON.stringify(expected)));
    expect(ask).not.toHaveBeenCalled();
  });

  it.each(["same", "business-diff", "four-diff"])("実オークマ原4と旧businessの%sでは証明できた対応付けだけ保存し旧判定JSONは保持", async fault => {
    const sha = (x: string) => createHash("sha256").update(x).digest("hex");
    const four = PREFILTER_SECTIONS.map(key => [key, key === "business" ? OKUMA_BUSINESS_TEXT : null]);
    const old = withInputReceipt("実原文の入力来歴を固定するprotocol検査", { docId: "S100YFQC", textPageId: "notion-page-okuma",
      businessSha256: sha(fault === "business-diff" ? KYOKUYO_BUSINESS_TEXT : OKUMA_BUSINESS_TEXT),
      sectionsSha256: fault === "four-diff" ? sha(JSON.stringify([])) : sha(JSON.stringify(four)),
      stateSha256: null, vocabVersion: "v1", model: null });
    const row = rowOf({ docId: "S100YFQC", tagStatus: "判定済", judgeInput: old });
    const { deps, updated } = makeDeps({ readStockTextRow: async () => [{ sectionKey: "business", itemName: "事業の内容", text: OKUMA_BUSINESS_TEXT }] });
    await processStock(itemOf({ kind: "sync_text", row }), deps);
    const written = updated[0].input, sync = readTextSyncReceipt(written.judgeInput)!;
    expect(written.judgeInput!.split(INPUT_RECEIPT_PREFIX)[1]).toBe(old.split(INPUT_RECEIPT_PREFIX)[1]);
    expect(sync.notionTextsSha256).toBeDefined();
    if (fault === "same") {
      expect(sync.equivalentJudgmentInputSha256).toBe(readInputReceipt(old)!.sectionsSha256);
      expect(sync.equivalentJudgmentBusinessSha256).toBe(readInputReceipt(old)!.businessSha256);
      expect(sync.notionSectionsSha256).toBe(readInputReceipt(old)!.sectionsSha256);
      expect(sync.notionBusinessSha256).toBe(readInputReceipt(old)!.businessSha256);
    } else {
      expect(sync.notionSectionsSha256).toBeUndefined(); expect(sync.notionBusinessSha256).toBeUndefined();
      const refreshed = itemOf({ kind: "sync_text", refreshTextReceipt: true, row: { ...row, judgeInput: written.judgeInput! } });
      updated.length = 0;
      expect(await processStock(refreshed, deps)).toMatchObject({ qualificationHeld: true, outcome: "skipped" });
      expect(updated).toHaveLength(0);
    }
  });
  it("同docの39本文だけを同期し、旧model/4SHA/タグ/根拠/判定時刻を変更しない。二回目はNOOP", async () => {
    const legacy = withInputReceipt("SemIf入力変更の再判定：保存済み説明", { docId: "S100YFQC", textPageId: "old-pointer", businessSha256: null,
      sectionsSha256: "a".repeat(64), stateSha256: null, vocabVersion: "v1", model: "Qwen3.5-4B@851bf6e/semif-mlx" });
    const row = rowOf({ docId: "S100YFQC", docType: "有報", periodEnd: "2026-03-31", submittedAt: "2026-06-25T00:00:00.000Z", textStatus: "取得済", tagDoc: "S100YFQC 2026年3月期", tagStatus: "判定済", vocabVersion: "v1",
      judgedAt: "2026-09-24", upstream: ["工作機械"], evidenceText: "保存済み根拠", judgeInput: legacy });
    const ask = vi.fn(), latest = vi.fn(async () => {});
    const { deps, updated, evidenceCalls } = makeDeps({ jevClient: { askNoul: ask }, assertLatestDocCurrent: latest,
      readStockTextRow: async () => [{ sectionKey: "business", itemName: "事業の内容", text: OKUMA_BUSINESS_TEXT }] });
    expect(await processStock(itemOf({ kind: "sync_text", row }), deps)).toMatchObject({ outcome: "updated", jevCalls: 0 });
    const input = updated[0].input;
    expect(Object.keys(input.texts!)).toHaveLength(39);
    expect(input.texts!["事業の内容"]).toBe(OKUMA_BUSINESS_TEXT);
    for (const key of ["upstream", "tagStatus", "tagDoc", "vocabVersion", "judgedAt", "evidenceText", "attempts", "error"]) expect(input).not.toHaveProperty(key);
    expect(evidenceCalls[0].block).toBeUndefined();
    expect(input.judgeInput!.split(INPUT_RECEIPT_PREFIX)[1]).toBe(legacy.split(INPUT_RECEIPT_PREFIX)[1]);
    expect(readInputReceipt(input.judgeInput)).toEqual(readInputReceipt(legacy));
    expect(readTextSyncReceipt(input.judgeInput)).toMatchObject({ docId: "S100YFQC", textPageId: "notion-page-okuma" });
    updated.length = 0; evidenceCalls.length = 0;
    expect(await processStock(itemOf({ kind: "sync_text", row: { ...row, judgeInput: input.judgeInput! } }), deps))
      .toMatchObject({ outcome: "skipped", jevCalls: 0 });
    expect(updated).toHaveLength(0); expect(evidenceCalls).toHaveLength(0); expect(ask).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(2);
  });

  it("旧判定SHA不明でも39同期markerだけを作り、歴史的判定receiptを生成しない", async () => {
    const { deps, updated } = makeDeps({ readStockTextRow: async () => [{ sectionKey: "business", itemName: "事業の内容", text: OKUMA_BUSINESS_TEXT }] });
    await processStock(itemOf({ kind: "sync_text", row: rowOf({ docId: "S100YFQC", tagStatus: "判定済", judgeInput: null }) }), deps);
    expect(readInputReceipt(updated[0].input.judgeInput)).toBeNull();
    expect(readTextSyncReceipt(updated[0].input.judgeInput)).not.toBeNull();
  });

  it("実clientがClefの新規初回失敗はClefと記録し、旧SemIfへ代替しない", async () => {
    const { deps, updated, created } = makeDeps({ model: "Cloudflare/clef-flash@explicit-test/torch-mps",
      readStockTextRow: async () => [{ sectionKey: "business", itemName: "事業の内容", text: OKUMA_BUSINESS_TEXT }],
      jevClient: { askNoul: async () => { throw new SemifUnavailableError("専用headの読取失敗"); } } });
    await processStock(itemOf({ initialSemif: true }), deps);
    expect(updated).toHaveLength(0);
    expect(created[0].input.judgeInput).toMatch(/^Clef-Flash新規銘柄の初回判定/);
    expect(created[0].input.error).toContain("Clef-Flash 判定に失敗");
  });

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

  it("新規行では根拠ブロックを別リクエストで置き換えず、作成の1回に同梱する (非atomicな2段階書込を作らない)", async () => {
    const jevClient = jevAnswering({ "bt.B.MACH.MACHINE_TOOL": 0.95 });
    const { deps, callOrder } = makeDeps({
      jevClient,
      readStockTextRow: () =>
        Promise.resolve([{ itemName: "事業の内容", sectionKey: "business", text: OKUMA_BUSINESS_TEXT }]),
    });
    await processStock(itemOf(), deps); // row: null (デフォルト) → 新規作成
    expect(callOrder).toEqual(["createSupplementRow"]);
  });

  it("no_text: 既存書類・タグ・根拠を保持して保留する", async () => {
    const { deps, updated, evidenceCalls, callOrder } = makeDeps();
    const row = rowOf({ docId: "S100OLD", tagStatus: "判定済", upstream: ["工作機械"] });
    const outcome = await processStock(itemOf({ kind: "no_text", doc: null, row }), deps);
    expect(outcome.outcome).toBe("skipped");
    expect(outcome.tagStatus).toBe("判定済");
    expect(updated).toEqual([]);
    expect(evidenceCalls).toEqual([]);
    expect(callOrder).toEqual([]);
  });

  describe("sync_and_tag (実データ: オークマ 工作機械)", () => {
    it("新規初回のAI判定成功: タグ・根拠・判定日を書き込む", async () => {
      const jevClient = jevAnswering({ "bt.B.MACH.MACHINE_TOOL": 0.95 });
      const { deps, created, evidenceCalls } = makeDeps({
        jevClient,
        readStockTextRow: () =>
          Promise.resolve([{ itemName: "事業の内容", sectionKey: "business", text: OKUMA_BUSINESS_TEXT }]),
      });
      const outcome = await processStock(itemOf({ initialSemif: true }), deps);
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

    it("本文列は TEXT_SECTIONS の項目名で書く (有報テキスト行の生の項目名「… [テキストブロック]」を列名にしない)", async () => {
      // 2026-09-25 本番試験で発覚: Notion の有報テキスト行の itemName は CSV の生の項目名
      // (「事業の内容 [テキストブロック]」) で、そのまま列名にすると Notion が 400 を返した。
      const jevClient = jevAnswering({ "bt.B.MACH.MACHINE_TOOL": 0.95 });
      const { deps, created } = makeDeps({
        jevClient,
        readStockTextRow: () =>
          Promise.resolve([
            { itemName: "事業の内容 [テキストブロック]", sectionKey: "business", text: OKUMA_BUSINESS_TEXT },
          ]),
      });
      await processStock(itemOf(), deps);
      const texts = created[0]?.input.texts;
      expect(texts?.["事業の内容"]).toBe(OKUMA_BUSINESS_TEXT);
      expect(Object.keys(texts ?? {}).some((k) => k.includes("[テキストブロック]"))).toBe(false);
      // 書類に無い項目も 39 列すべてを明示的に空にする (前の書類の本文を残さない)
      expect(Object.keys(texts ?? {})).toHaveLength(39);
      expect(texts?.["事業等のリスク"]).toBeNull();
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
      const { deps, updated, callOrder } = makeDeps({
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
      // 既存行は根拠ブロックを先に置き換えてから (中断されても「判定済なのに
      // 根拠は古い書類のまま」を作らない)、プロパティを更新する。
      expect(callOrder).toEqual(["replaceEvidenceBlock", "updateSupplementRow"]);
    });

    it("既存の本文読込失敗はタグや根拠を消さず保留する", async () => {
      const { deps, updated, evidenceCalls, callOrder } = makeDeps({
        readStockTextRow: () => Promise.reject(new Error("Notion API error: 500")),
      });
      const row = rowOf({ attempts: 1 });
      await expect(processStock(itemOf({ row }), deps)).rejects.toThrow("有報本文の読込を保留");
      expect(updated).toEqual([]);
      expect(evidenceCalls).toEqual([]);
      expect(callOrder).toEqual([]);
    });

    it("SemIf 判定不能: SemifUnavailableError なら 判定不能 + attempts+1 + 次回再試行日 (テキストは保存する)", async () => {
      const jevClient: JevClient = {
        askNoul: () => Promise.reject(new SemifUnavailableError("SemIf 推論が失敗した")),
      };
      const { deps, updated } = makeDeps({
        jevClient,
        readStockTextRow: () =>
          Promise.resolve([{ itemName: "事業の内容", sectionKey: "business", text: OKUMA_BUSINESS_TEXT }]),
      });
      const row = rowOf({ attempts: 0 });
      const outcome = await processStock(itemOf({ row, initialSemif: true }), deps);
      expect(outcome.tagStatus).toBe("判定不能");
      const write = updated.find((u) => u.pageId === row.pageId)?.input;
      expect(write?.textStatus).toBe("取得済"); // 本文の読込自体は成功している
      expect(write?.tagStatus).toBe("判定不能");
      expect(write?.attempts).toBe(1);
      expect(write?.nextRetryAt).toBe("2026-09-26"); // 2^(1-1)=1日後
      expect(write?.candidateCount).toBe(1); // 絞り込みまでは成功した事実を残す
      expect(write?.upstream).toEqual([]);
      expect(write?.error).toContain("SemIf 判定に失敗");
      expect(write?.judgeInput).toMatch(/^SemIf新規銘柄の初回判定/);
      expect(outcome.error).toContain("SemIf 判定に失敗");
    });

    it("jev 以外の例外はそのまま伝播する (判定不能に丸め込まない)", async () => {
      const jevClient: JevClient = { askNoul: () => Promise.reject(new Error("想定外のバグ")) };
      const { deps } = makeDeps({
        jevClient,
        readStockTextRow: () =>
          Promise.resolve([{ itemName: "事業の内容", sectionKey: "business", text: OKUMA_BUSINESS_TEXT }]),
      });
      await expect(processStock(itemOf({ initialSemif: true }), deps)).rejects.toThrow("想定外のバグ");
    });
  });

  it("version_bump: 版とテーマ列だけ更新し jev は呼ばない", async () => {
    const jevClient: JevClient = { askNoul: () => Promise.reject(new Error("version_bump では jev を呼ばない")) };
    const { deps, updated, evidenceCalls, callOrder } = makeDeps({ jevClient });
    const currentGuard = vi.fn(async () => {}); deps.assertLatestDocCurrent = currentGuard;
    const row = rowOf({
      docId: "S100YFQC",
      tagStatus: "判定済",
      vocabVersion: "v0",
      upstream: ["工作機械"],
    });
    const outcome = await processStock(itemOf({ kind: "version_bump", row }), deps);
    expect(outcome.outcome).toBe("updated");
    expect(updated[0]?.input).toEqual({ docId: "S100YFQC", themes: ["工作機械・産業用ロボット"], vocabVersion: MINI_VOCAB.version });
    expect(evidenceCalls).toEqual([{ pageId: row.pageId, block: undefined }]);
    expect(callOrder).toEqual(["replaceEvidenceBlock", "updateSupplementRow"]);
    expect(currentGuard).toHaveBeenCalledOnce();
  });

  it("version_bump cannot bind old tags to a different source document", async () => {
    const { deps, updated, evidenceCalls } = makeDeps();
    const row = rowOf({ docId: "S100OLD" });
    await expect(processStock(itemOf({ kind: "version_bump", row }), deps)).rejects.toThrow(/別有報/);
    expect(updated).toEqual([]); expect(evidenceCalls).toEqual([]);
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
  it.each(["sync_and_tag", "retag", "retry"] as const)("既存%sは機械照合し、API・確率を使わない", async (kind) => {
    const askSpy = vi.fn(() => Promise.reject(new Error("既存の有料判定禁止")));
    const { deps, updated, evidenceCalls } = makeDeps({
      jevClient: { askNoul: askSpy },
      readStockTextRow: async () => [{ itemName: "事業の内容", sectionKey: "business", text: OKUMA_BUSINESS_TEXT }],
    });
    const outcome = await processStock(itemOf({ kind, row: rowOf({ attempts: 5, error: "status=402" }) }), deps);
    expect(askSpy).not.toHaveBeenCalled();
    expect(outcome.jevCalls).toBe(0);
    expect(updated[0].input.upstream).toEqual(["工作機械"]);
    expect(updated[0].input.judgeInput).toContain("機械照合");
    expect(updated[0].input.evidenceText).toContain("キーワード一致");
    expect(updated[0].input.evidenceText).not.toContain("0.95");
    expect(JSON.stringify(evidenceCalls)).toContain("キーワード一致");
  });

  it.each([{ sections: [] }, { sections: [{ itemName: "事業の内容", sectionKey: "business", text: "　 " }] }])("対象本文が空なら不一致判定や書込をせず保留する (%j)", async ({ sections }) => {
    const askSpy = vi.fn();
    const { deps, created, updated } = makeDeps({
      jevClient: { askNoul: askSpy }, readStockTextRow: async () => sections,
    });
    await expect(processStock(itemOf(), deps)).rejects.toThrow("事業タグ対象の本文がありません");
    expect(askSpy).not.toHaveBeenCalled();
    expect(created).toEqual([]);
    expect(updated).toEqual([]);
  });

  it("create_row では readStockTextRow / jev を一切呼ばない", async () => {
    const readSpy = vi.fn(() => Promise.reject(new Error("呼ばれない想定")));
    const askSpy = vi.fn(() => Promise.reject(new Error("呼ばれない想定")));
    const { deps } = makeDeps({ readStockTextRow: readSpy, jevClient: { askNoul: askSpy } });
    await processStock(itemOf({ kind: "create_row", doc: null }), deps);
    expect(readSpy).not.toHaveBeenCalled();
    expect(askSpy).not.toHaveBeenCalled();
  });
});

describe("input-change local rejudgment", () => {
  const saved = () => rowOf({ docId: "S100OLD", tagStatus: "判定済", tagDoc: "S100OLD 2025年3月期",
    upstream: ["保存済みタグ"], evidenceText: "保存済み根拠", vocabVersion: "v0", judgedAt: "2025-06-25", judgeInput: "旧入力SHA未記録" });
  const sections = [{ itemName: "事業の内容", sectionKey: "business", text: OKUMA_BUSINESS_TEXT }];
  it("uses local judge, synchronizes all39 canonical columns, and saves actual input SHA/doc/pointer/model", async () => {
    const ask = vi.fn(jevAnswering({ "bt.B.MACH.MACHINE_TOOL": 0.95 }).askNoul);
    const { deps, updated } = makeDeps({ jevClient: { askNoul: ask }, readStockTextRow: async () => sections });
    const commit = vi.fn(deps.replaceEvidenceBlock); deps.replaceEvidenceBlock = commit;
    await processStock(itemOf({ kind: "retag", row: saved(), sourceChangedLocalJudge: true }), deps);
    expect(commit.mock.calls[0][3]).toMatchObject({ "有報書類ID": { rich_text: [{ type: "text", text: { content: "S100OLD" } }] }, "単語帳の版": { select: { name: "v0" } } });
    expect(ask).toHaveBeenCalledTimes(1);
    const write = updated[0].input;
    expect(Object.keys(write.texts ?? {})).toHaveLength(39);
    expect(write.texts?.["事業の内容"]).toBe(OKUMA_BUSINESS_TEXT);
    expect(write.tagDoc).toBe("S100YFQC 2026年3月期");
    expect(write.judgeInput).toMatch(/^SemIf入力変更の再判定/);
    expect(write.judgeInput).toContain('"textPageId":"notion-page-okuma"');
    expect(write.judgeInput).toMatch(/"businessSha256":"[0-9a-f]{64}"/);
    expect(write.judgeInput).toMatch(/"stateSha256":"[0-9a-f]{64}"/);
    expect(write.judgeInput).toContain('"model":"mock"');
  });
  it.each([new SemifUnavailableError("local busy"), new Error("unknown judgment result")])("failed/unknown inference keeps all existing values and evidence (%s)", async (failure) => {
    const row = saved(), before = structuredClone(row);
    const { deps, updated, created, evidenceCalls } = makeDeps({
      jevClient: { askNoul: async () => { throw failure; } }, readStockTextRow: async () => sections,
    });
    const run = processStock(itemOf({ kind: "retag", row, sourceChangedLocalJudge: true }), deps);
    if (failure instanceof SemifUnavailableError) expect(await run).toMatchObject({ outcome: "skipped", qualificationHeld: true, tagStatus: "判定済" });
    else await expect(run).rejects.toThrow("unknown judgment result");
    expect(row).toEqual(before);
    expect(updated).toEqual([]); expect(created).toEqual([]); expect(evidenceCalls).toEqual([]);
  });
  it.each(["latest pointer changed", "latest read failed"])("model待ち後の最終guard失敗は旧値を保持し、追加model/writeを行わない (%s)", async (reason) => {
    const ask = vi.fn(jevAnswering({ "bt.B.MACH.MACHINE_TOOL": 0.95 }).askNoul);
    const guard = vi.fn(async () => { throw new Error(reason); });
    const row = saved(), before = structuredClone(row);
    const { deps, updated, created, evidenceCalls } = makeDeps({ jevClient: { askNoul: ask },
      readStockTextRow: async () => sections, assertLatestDocCurrent: guard });
    expect(await processStock(itemOf({ kind: "retag", row, sourceChangedLocalJudge: true }), deps)).toMatchObject({ qualificationHeld: true, outcome: "skipped", jevCalls: 1, error: expect.stringContaining(reason) });
    expect(ask).toHaveBeenCalledTimes(1); expect(guard).toHaveBeenCalledTimes(1);
    expect(updated).toEqual([]); expect(created).toEqual([]); expect(evidenceCalls).toEqual([]); expect(row).toEqual(before);
  });
  it("初回の新規createにも最新doc guardを通し、変更時は行を作らない", async () => {
    const { deps, created, updated } = makeDeps({ jevClient: jevAnswering({ "bt.B.MACH.MACHINE_TOOL": 0.95 }),
      readStockTextRow: async () => sections, assertLatestDocCurrent: async () => { throw new Error("new latest document"); } });
    expect(await processStock(itemOf({ initialSemif: true }), deps)).toMatchObject({ qualificationHeld: true, outcome: "skipped", error: expect.stringContaining("new latest document") });
    expect(created).toEqual([]); expect(updated).toEqual([]);
  });
  it("a missing model answer stops before any replacement", async () => {
    const { deps, updated, evidenceCalls } = makeDeps({ readStockTextRow: async () => sections,
      jevClient: { askNoul: async () => ({ model: "mock", answers: {}, inputTokens: 1, outputTokens: 0, latencyMs: 1, attempts: 1 }) },
    });
    await expect(processStock(itemOf({ kind: "retag", row: saved(), sourceChangedLocalJudge: true }), deps)).rejects.toThrow("応答が無い");
    expect(updated).toEqual([]); expect(evidenceCalls).toEqual([]);
  });
  it.each([false, true])("same-doc known four-section SHA synchronizes without semantic dependencies (mechanicalOnly=%s)", async (mechanicalOnly) => {
    const first = makeDeps({ readStockTextRow: async () => sections });
    await processStock(itemOf({ row: rowOf() }), first.deps);
    const previousInput = first.updated[0].input.judgeInput as string;
    const row = saved(); row.docId = docOf().docId; row.tagDoc = "S100YFQC 2026年3月期";
    row.judgeInput = previousInput.replaceAll("notion-page-okuma", "old-pointer");
    const ask = vi.fn();
    const { deps, updated, evidenceCalls } = makeDeps({ mechanicalOnly, readStockTextRow: async () => sections, jevClient: { askNoul: ask } });
    for (const key of ["vocab", "thresholds", "localJudgeInput", "localJudgeDate"] as const) {
      Object.defineProperty(deps, key, { get: () => { throw new Error(`same input must not read ${key}`); } });
    }
    await processStock(itemOf({ kind: "retag", row, sourceChangedLocalJudge: true, checkSourceInput: true }), deps);
    expect(ask).not.toHaveBeenCalled(); expect(evidenceCalls).toEqual([{ pageId: row.pageId, block: undefined }]);
    expect(updated[0].input.upstream).toBeUndefined(); expect(updated[0].input.tagDoc).toBeUndefined();
    expect(updated[0].input.vocabVersion).toBeUndefined(); expect(updated[0].input.judgedAt).toBeUndefined();
    expect(Object.keys(updated[0].input.texts ?? {})).toHaveLength(39);
    expect(updated[0].input.judgeInput).toContain('"textPageId":"notion-page-okuma"');
    expect(updated[0].input.judgeInput!.split(INPUT_RECEIPT_PREFIX)[1]).toBe(row.judgeInput.split(INPUT_RECEIPT_PREFIX)[1]);
    expect(readTextSyncReceipt(updated[0].input.judgeInput)?.equivalentJudgmentInputSha256).toBe(readInputReceipt(row.judgeInput)?.sectionsSha256);
  });
  it("mechanical-only holds actual four-section differences before vocabulary, calibration, journal or model and preserves all old props", async () => {
    const first = makeDeps({ readStockTextRow: async () => sections });
    await processStock(itemOf({ row: rowOf() }), first.deps);
    const row = { ...saved(), docId: docOf().docId, tagDoc: "S100YFQC 2026年3月期",
      judgeInput: first.updated[0].input.judgeInput!.replaceAll("notion-page-okuma", "old-pointer") };
    const before = structuredClone(row), ask = vi.fn();
    // 実在する別社の本文を差分プロトコルとして渡す。実有報の訂正とは扱わない。
    const { deps, updated, created, evidenceCalls } = makeDeps({ mechanicalOnly: true, jevClient: { askNoul: ask },
      readStockTextRow: async () => [{ ...sections[0], text: KYOKUYO_BUSINESS_TEXT }] });
    for (const key of ["vocab", "thresholds", "localJudgeInput", "localJudgeDate"] as const) {
      Object.defineProperty(deps, key, { get: () => { throw new Error(`HOLD must not read ${key}`); } });
    }
    expect(await processStock(itemOf({ kind: "retag", row, sourceChangedLocalJudge: true, checkSourceInput: true }), deps))
      .toMatchObject({ outcome: "skipped", qualificationHeld: true, tagStatus: row.tagStatus, candidateCount: row.candidateCount,
        jevCalls: 0, jevInputTokens: 0, jevOutputTokens: 0 });
    expect(row).toEqual(before); expect(updated).toEqual([]); expect(created).toEqual([]); expect(evidenceCalls).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
  });
  it("same-doc changed known input calls SemIf instead of silently reusing old tags", async () => {
    const first = makeDeps({ readStockTextRow: async () => sections });
    await processStock(itemOf({ row: rowOf() }), first.deps);
    const previousInput = first.updated[0].input.judgeInput as string;
    const row = saved(); row.docId = docOf().docId; row.tagDoc = "S100YFQC 2026年3月期";
    row.judgeInput = previousInput.replaceAll("notion-page-okuma", "old-pointer");
    const ask = vi.fn(jevAnswering({ "bt.B.MACH.MACHINE_TOOL": 0.95 }).askNoul);
    const { deps, updated } = makeDeps({ jevClient: { askNoul: ask },
      readStockTextRow: async () => [{ ...sections[0], text: OKUMA_BUSINESS_TEXT + "\n" + OKUMA_BUSINESS_TEXT }] });
    await processStock(itemOf({ kind: "retag", row, sourceChangedLocalJudge: true, checkSourceInput: true }), deps);
    expect(ask).toHaveBeenCalledTimes(1); expect(updated[0].input.tagStatus).toBe("判定済");
    expect(updated[0].input.judgeInput).toContain("SemIf入力変更の再判定");
  });
  it.each(["旧入力SHA未記録", `old${INPUT_RECEIPT_PREFIX}{}`])("mechanical-only unknown/malformed old SHA stops without semantic dependencies (%s)", async judgeInput => {
    const { deps, updated, evidenceCalls } = makeDeps({ mechanicalOnly: true, readStockTextRow: async () => sections });
    for (const key of ["vocab", "thresholds", "localJudgeInput", "jevClient"] as const) {
      Object.defineProperty(deps, key, { get: () => { throw new Error(`invalid receipt must not read ${key}`); } });
    }
    await expect(processStock(itemOf({ kind: "retag", row: { ...saved(), judgeInput }, sourceChangedLocalJudge: true, checkSourceInput: true }), deps))
      .rejects.toThrow(judgeInput.includes(INPUT_RECEIPT_PREFIX) ? "入力来歴が不正" : "旧SHAがありません");
    expect(updated).toEqual([]); expect(evidenceCalls).toEqual([]);
  });
});
