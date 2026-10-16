/**
 * 1 銘柄ぶんの同期・判定・書き込み。設計: docs/005-yuho-quant-business-tags.md §5。
 *
 * I/O は全て `ProcessDeps` 経由で注入する (テストでは実際の Notion/jev を叩かない)。
 *
 * **不変条件**: `事業タグの状態 = 判定済` になるのは、実際に判定が完了し
 * `事業タグの根拠書類` の docID が (今書き込む) `有報書類ID` と一致するときだけ
 * (§3.1)。書類が変わったとき (`sync_and_tag`/`retag`) は、書き込む
 * `SupplementRowInput` が常にタグ列 (`upstream`/`downstream`/`themes`/`uncertain`)
 * を明示的な新しい値 (空配列/null を含む) で置き換えるため、古い書類のタグが
 * 新しい書類のものとして残ることは無い。
 */
import {
  buildEvidenceBlock,
  buildSupplementProperties,
  SUPPLEMENT_PROPS,
  type DocTypeLabel,
  type EvidenceBlockInput,
  type SupplementRowInput,
  type TagStatus,
} from "../../../../src/shared/notion-archive/index.js";
import { normalizeSupplementText, SupplementWriteHeldError } from "../../../../src/shared/notion-archive/stock-supplement.js";
import type { StockTextSection } from "../../../../src/shared/notion-archive/stock-text.js";
import type { JevClient } from "../../../../src/shared/jev/index.js";
import { SemifUnavailableError } from "../../../../src/shared/semif/index.js";
import { addDaysJst } from "./date-jst.js";
import { docTypeLabelOf } from "./doc-type.js";
import { formatPeriodJa } from "./evidence.js";
import { buildJudgeInput, type DocMeta } from "./excerpt.js";
import { judgeCandidates, type BtThresholds } from "./judge.js";
import { INITIAL_CLEF_INPUT_PREFIX, INITIAL_SEMIF_INPUT_PREFIX, readInputReceipt, readTextSyncReceipt,
  withInputReceipt, withTextSyncReceipt, type InputReceipt, type TextSyncReceipt, type WorkItem } from "./plan.js";
import { sha256Hex } from "../../../../src/shared/sha256.js";
import { isPrefilterSection, prefilter, PREFILTER_SECTIONS, type PrefilterSectionKey } from "./prefilter.js";
import { summarizeJudgments, summarizeKeywordMatches, type TagOutcome } from "./row.js";
import type { LatestDoc } from "./source.js";
import { deriveThemes } from "./themes.js";
import type { Vocabulary } from "./vocabulary/schema.js";
import { TEXT_SECTIONS } from "../services/edinet/text-sections.js";

type Doc = NonNullable<LatestDoc["doc"]>;

export interface ProcessDeps {
  vocab: Vocabulary;
  thresholds: BtThresholds;
  jevClient: JevClient;
  /** 実際に構成した判定clientのモデルID。旧receiptのmodelを代入しない。 */
  model: string;
  /** 判定原本の来歴を通常Node journalへ渡す。旧receiptは変更しない。 */
  localJudgeInput?: (receipt: InputReceipt, textsSha256: string) => void;
  localJudgeDate?: () => string;
  /** 判定日・再試行日の基準 (JST, YYYY-MM-DD) */
  today: string;
  /** ① 銘柄マスタのページ ID 解決 (無ければ null。relation を張らない) */
  resolveMasterPageId: (stockCode: string) => string | null;
  /** Notion 有報テキスト行の読取 (`notionDocPageId` → セクション列) */
  readStockTextRow: (rowPageId: string) => Promise<StockTextSection[]>;
  /** モデル待ち後、business writeの直前に最新doc/本文pointerを1社だけ照合する。 */
  assertLatestDocCurrent: (stockCode: string, doc: Doc) => Promise<void>;
  createSupplementRow: (input: SupplementRowInput, evidence?: unknown | null) => Promise<string>;
  updateSupplementRow: (pageId: string, input: SupplementRowInput) => Promise<void>;
  replaceEvidenceBlock: (pageId: string, block: unknown | null, input: SupplementRowInput, expectedProperties: Record<string, unknown>, beforeWrite: () => Promise<void>) => Promise<void>;
}

export interface ProcessOutcome {
  stockCode: string;
  kind: WorkItem["kind"];
  outcome: "created" | "updated" | "skipped";
  tagStatus: TagStatus | null;
  candidateCount: number | null;
  jevCalls: number;
  jevInputTokens: number;
  jevOutputTokens: number;
  /** 判定不能/読込失敗をサマリの失敗通知へ渡す。 */
  error?: string;
  /** 旧判定が残っていても新入力に対する判定完了には数えない。 */
  qualificationHeld?: boolean;
}

const ZERO_JEV_STATS = { jevCalls: 0, jevInputTokens: 0, jevOutputTokens: 0 };

/** 失敗 n 回目の後の再試行間隔 = 2^(n-1) 日 (1, 2, 4, 8, 16 日。§5.2)。 */
function nextRetryDate(today: string, attemptsAfter: number): string {
  return addDaysJst(today, 2 ** (attemptsAfter - 1));
}

/**
 * 行を書き込む (properties + 根拠ブロック)。既存行は共有二段階helperが
 * PRE物理保管→新根拠全文verify→properties/readback→旧根拠退役を行う。
 * 新規行はPOSTに根拠をchildrenとして同梱する。
 */
function savedRowGuard(row: NonNullable<WorkItem["row"]>): Record<string, unknown> {
  if (row.judgeInput === undefined) throw new Error("旧判定入力の読取が不明。旧値を保持してHOLD");
  return {
    ...buildSupplementProperties({ companyName: row.companyName, stockCode: row.stockCode, sector33: row.sector33,
      docId: row.docId, docType: row.docType, periodEnd: row.periodEnd, submittedAt: row.submittedAt,
      upstream: row.upstream, downstream: row.downstream, distribution: row.distribution, themes: row.themes,
      uncertain: row.uncertain, evidenceText: row.evidenceText, tagDoc: row.tagDoc, vocabVersion: row.vocabVersion,
      judgedAt: row.judgedAt, candidateCount: row.candidateCount, judgeInput: row.judgeInput,
      attempts: row.attempts, nextRetryAt: row.nextRetryAt, error: row.error }),
    [SUPPLEMENT_PROPS.textStatus]: { select: row.textStatus === null ? null : { name: row.textStatus } },
    [SUPPLEMENT_PROPS.tagStatus]: { select: row.tagStatus === null ? null : { name: row.tagStatus } },
  };
}

async function writeRowWithEvidence(
  item: WorkItem,
  deps: ProcessDeps,
  input: SupplementRowInput,
  evidenceBlock: unknown | null,
  expectedTexts?: Record<string, string | null>
): Promise<string> {
  if (item.doc === null) throw new Error("書込前照合に必要な有報がありません");
  const doc = item.doc;
  const beforeWrite = async () => {
    try { await deps.assertLatestDocCurrent(item.stockCode, doc); }
    catch (cause) { throw new SupplementWriteHeldError(`書込直前の最新有報照合をHOLD: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }); }
  };
  if (item.row) {
    const expected = savedRowGuard(item.row);
    if (expectedTexts !== undefined) Object.assign(expected, buildSupplementProperties({ texts: expectedTexts }));
    await deps.replaceEvidenceBlock(item.row.pageId, evidenceBlock, input, expected, beforeWrite);
    return item.row.pageId;
  }
  await beforeWrite();
  return deps.createSupplementRow(input, evidenceBlock);
}

function outcomeKindOf(item: WorkItem): "created" | "updated" {
  return item.row ? "updated" : "created";
}

/**
 * 39本文列を明示的に全て空にする値。`texts` を省略すると
 * (buildSupplementProperties の仕様上) 既存値がそのまま残るため、
 * 「最新有報が無い／本文が読めない」→「本文列は空」(設計 §状態遷移表) を
 * 実際に成立させるには、旧書類の本文をこれで明示的に上書きする必要がある。
 */
const TITLE_BY_SECTION_KEY = new Map<string, string>(TEXT_SECTIONS.map((d) => [d.key, d.title]));

function allTextColumnsCleared(): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const s of TEXT_SECTIONS) out[s.title] = null;
  return out;
}

function textColumnsOf(sections: StockTextSection[]): Record<string, string | null> {
  const texts = allTextColumnsCleared(), seen = new Set<string>();
  for (const s of sections) {
    const title = TITLE_BY_SECTION_KEY.get(s.sectionKey);
    if (title === undefined || seen.has(s.sectionKey) || typeof s.text !== "string") throw new Error("有報本文の節キー/本文が不正です");
    seen.add(s.sectionKey);
    texts[title] = s.text;
  }
  return texts;
}

async function textReceipt(doc: Doc, texts: Record<string, string | null>, judgment: InputReceipt | null) {
  if (doc.notionDocPageId === null) throw new Error("39本文同期のpointerがありません");
  const notionText = (value: string | null) => { const normalized = normalizeSupplementText(value); return normalized === "" ? null : normalized; };
  const receipt: TextSyncReceipt = { docId: doc.docId, textPageId: doc.notionDocPageId,
    textsSha256: await sha256Hex(JSON.stringify(TEXT_SECTIONS.map(({ title }) => [title, texts[title]]))),
    notionTextsSha256: await sha256Hex(JSON.stringify(TEXT_SECTIONS.map(({ title }) => [title, notionText(texts[title])]))),
  };
  if (judgment === null || judgment.docId !== doc.docId) return receipt;
  const four = PREFILTER_SECTIONS.map(key => {
    const title = TITLE_BY_SECTION_KEY.get(key); if (title === undefined) throw new Error("判定節の列定義がありません");
    return [key, texts[title]] as const;
  });
  const businessTitle = TITLE_BY_SECTION_KEY.get("business"); if (businessTitle === undefined) throw new Error("事業本文の列定義がありません");
  const business = texts[businessTitle];
  // 旧原4と原businessの両方を実原文で照合した場合だけ送信表現へ対応付ける。
  if (business !== null && judgment.sectionsSha256 === await sha256Hex(JSON.stringify(four)) &&
      judgment.businessSha256 === await sha256Hex(business)) {
    receipt.equivalentJudgmentInputSha256 = judgment.sectionsSha256;
    receipt.equivalentJudgmentBusinessSha256 = judgment.businessSha256;
    receipt.notionSectionsSha256 = await sha256Hex(JSON.stringify(four.map(([key, value]) => [key, notionText(value)])));
    receipt.notionBusinessSha256 = await sha256Hex(normalizeSupplementText(business)!);
  }
  return receipt;
}

function localJudgeName(deps: ProcessDeps): "Clef-Flash" | "SemIf" {
  if (deps.model.startsWith("Cloudflare/clef-flash@")) return "Clef-Flash";
  if (deps.model.startsWith("Qwen3.5-4B@")) return "SemIf";
  throw new Error(`ローカル判定modelが不明です: ${deps.model}`);
}

async function syncTexts(item: WorkItem, deps: ProcessDeps): Promise<ProcessOutcome> {
  if (item.row === null || item.doc === null || item.doc.notionDocPageId === null || item.row.docId !== item.doc.docId || item.row.judgeInput === undefined) {
    throw new Error("39本文のみの同期には同じ有報の既存補足行が必要です");
  }
  const sections = await deps.readStockTextRow(item.doc.notionDocPageId);
  if (sections.length === 0) throw new Error("39本文の同期元が空です。旧値を保持してHOLD");
  const judgment = readInputReceipt(item.row.judgeInput);
  const texts = textColumnsOf(sections), receipt = await textReceipt(item.doc, texts, judgment);
  const previous = readTextSyncReceipt(item.row.judgeInput);
  if (item.refreshTextReceipt && (previous === null || previous.docId !== receipt.docId ||
      previous.textPageId !== receipt.textPageId || previous.textsSha256 !== receipt.textsSha256)) {
    return { stockCode: item.stockCode, kind: item.kind, outcome: "skipped", tagStatus: item.row.tagStatus,
      candidateCount: item.row.candidateCount, qualificationHeld: true, error: "旧原39 SHAと実原文が同値でないため送信表現の再資格化をHOLD", ...ZERO_JEV_STATS };
  }
  if (item.refreshTextReceipt && judgment !== null && receipt.notionSectionsSha256 === undefined) {
    return { stockCode: item.stockCode, kind: item.kind, outcome: "skipped", tagStatus: item.row.tagStatus,
      candidateCount: item.row.candidateCount, qualificationHeld: true, error: "旧原4 SHA/business SHAと実原文の同値証拠がないため再資格化をHOLD", ...ZERO_JEV_STATS };
  }
  const same = previous !== null && JSON.stringify(previous) === JSON.stringify(receipt);
  if (same && !item.refreshTextReceipt) await deps.assertLatestDocCurrent(item.stockCode, item.doc);
  else await writeRowWithEvidence(item, deps, { docId: item.doc.docId, ...(item.refreshTextReceipt ? {} : { texts }), textStatus: "取得済",
    judgeInput: withTextSyncReceipt(item.row.judgeInput, receipt) }, undefined, item.refreshTextReceipt ? texts : undefined);
  return { stockCode: item.stockCode, kind: item.kind, outcome: same ? "skipped" : "updated",
    tagStatus: item.row.tagStatus, candidateCount: item.row.candidateCount, ...ZERO_JEV_STATS };
}

/** 今のタグ (labelJa の配列) を今の単語帳の id へ変換する。version_bump の前提上、必ず見つかる。 */
function idsFromActiveLabels(vocab: Vocabulary, labels: string[]): string[] {
  const map = new Map(vocab.business.filter((t) => !t.deprecated).map((t) => [t.labelJa.toLowerCase(), t.id] as const));
  return labels.map((label) => {
    const id = map.get(label.toLowerCase());
    if (id === undefined) {
      throw new Error(
        `processStock: version_bump 対象のラベルが今の単語帳に見つかりません (不変条件違反): ${label}`
      );
    }
    return id;
  });
}

/**
 * 1 銘柄ぶんの作業項目 (`plan.ts` の `WorkItem`) を実行する。
 */
export async function processStock(item: WorkItem, deps: ProcessDeps): Promise<ProcessOutcome> {
  switch (item.kind) {
    case "sync_text":
      try { return await syncTexts(item, deps); }
      catch (error) {
        if (!(error instanceof SupplementWriteHeldError)) throw error;
        return { stockCode: item.stockCode, kind: item.kind, outcome: "skipped", tagStatus: item.row === null ? null : item.row.tagStatus,
          candidateCount: item.row === null ? null : item.row.candidateCount, qualificationHeld: true, error: error.message, ...ZERO_JEV_STATS };
      }
    case "skip":
      return {
        stockCode: item.stockCode,
        kind: item.kind,
        outcome: "skipped",
        tagStatus: item.row?.tagStatus ?? null,
        candidateCount: item.row?.candidateCount ?? null,
        ...ZERO_JEV_STATS,
      };

    case "create_row": {
      await deps.createSupplementRow(
        {
          companyName: item.companyName,
          stockCode: item.stockCode,
          masterPageId: deps.resolveMasterPageId(item.stockCode),
          sector33: item.sector33,
          docId: null,
          docType: null,
          periodEnd: null,
          submittedAt: null,
          textStatus: "本文なし",
          upstream: [],
          downstream: [],
          distribution: [],
          themes: [],
          uncertain: null,
          evidenceText: null,
          tagStatus: "本文なし",
          tagDoc: null,
          vocabVersion: null,
          judgedAt: null,
          candidateCount: null,
          judgeInput: null,
          error: null,
          attempts: 0,
          nextRetryAt: null,
        },
        null
      );
      return {
        stockCode: item.stockCode,
        kind: item.kind,
        outcome: "created",
        tagStatus: "本文なし",
        candidateCount: null,
        ...ZERO_JEV_STATS,
      };
    }

    case "no_text": {
      if (item.row === null) {
        throw new Error(`processStock: no_text だが既存行が無い (${item.stockCode})`);
      }
      // 新しい本文が読めないだけでは、以前の書類・タグ・根拠を消さない。
      return {
        stockCode: item.stockCode,
        kind: item.kind,
        outcome: "skipped",
        tagStatus: item.row.tagStatus,
        candidateCount: item.row.candidateCount,
        ...ZERO_JEV_STATS,
      };
    }

    case "version_bump": {
      if (item.row === null || item.doc === null) {
        throw new Error(`processStock: version_bump に必要な行/書類が無い (${item.stockCode})`);
      }
      const tagIds = idsFromActiveLabels(deps.vocab, [
        ...item.row.upstream,
        ...item.row.downstream,
        ...item.row.distribution,
      ]);
      const themes = deriveThemes(deps.vocab, tagIds).map((t) => t.labelJa);
      await deps.updateSupplementRow(item.row.pageId, {
        themes,
        vocabVersion: deps.vocab.version,
      });
      return {
        stockCode: item.stockCode,
        kind: item.kind,
        outcome: "updated",
        tagStatus: item.row.tagStatus,
        candidateCount: item.row.candidateCount,
        ...ZERO_JEV_STATS,
      };
    }

    case "sync_and_tag":
    case "retag":
    case "retry": {
      if (item.doc === null) {
        throw new Error(`processStock: ${item.kind} に必要な最新有報が無い (${item.stockCode})`);
      }
      return syncAndTag(item, item.doc, deps);
    }
  }
}

async function syncAndTag(item: WorkItem, doc: Doc, deps: ProcessDeps): Promise<ProcessOutcome> {
  if (doc.notionDocPageId === null) {
    // plan.ts の hasUsableText が保証しているはずで通常到達しない。
    throw new Error(`processStock: ${item.kind} に必要な notionDocPageId が無い (${item.stockCode})`);
  }

  let sections: StockTextSection[];
  try {
    sections = await deps.readStockTextRow(doc.notionDocPageId);
  } catch (e) {
    if (item.row !== null) throw new Error(`有報本文の読込を保留 (${item.stockCode} ${doc.docId})`, { cause: e });
    return recordFailure(item, deps, {
      textStatus: "読込失敗",
      tagStatus: "読込失敗",
      docId: doc.docId,
      docType: docTypeLabelOf(doc.docTypeCode),
      periodEnd: doc.periodEnd,
      submittedAt: doc.submittedAt,
      // 読込自体に失敗しているので新しい本文は無い。旧書類の本文が残らないよう
      // 明示的に全列を空にする (texts を省略すると既存値が残ってしまう)。
      texts: allTextColumnsCleared(),
      candidateCount: null,
      judgeInput: null,
      errorMessage: `Notion 有報テキストの読込に失敗: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const sectionMap: Partial<Record<PrefilterSectionKey, string>> = {};
  // 補足 DB の本文列名は TEXT_SECTIONS の項目名 (有報テキスト行の itemName は CSV の
  // 生の項目名「事業の内容 [テキストブロック]」なので使わない)。39 列すべてを明示し、
  // この書類に無い項目は null で空にする (前の書類の本文を残さない)。知らない節キーは
  // 形式の変化なので throw する (黙って捨てない)。
  const textsByColumn = textColumnsOf(sections);
  for (const s of sections) {
    if (isPrefilterSection(s.sectionKey)) {
      sectionMap[s.sectionKey] = s.text;
    }
  }

  if (!Object.values(sectionMap).some((text) => text.trim().length > 0)) {
    throw new Error(`事業タグ対象の本文がありません (${item.stockCode} ${doc.docId})。判定・既存結果の更新を保留します。`);
  }
  const result = prefilter(deps.vocab, sectionMap);
  const candidateCount = result.candidates.length;
  const baseInput: SupplementRowInput = {
    companyName: item.companyName,
    stockCode: item.stockCode,
    masterPageId: deps.resolveMasterPageId(item.stockCode),
    sector33: item.sector33,
    docId: doc.docId,
    docType: docTypeLabelOf(doc.docTypeCode),
    periodEnd: doc.periodEnd,
    submittedAt: doc.submittedAt,
    textStatus: "取得済",
    texts: textsByColumn,
  };
  const tagDoc = `${doc.docId} ${formatPeriodJa(doc.periodEnd)}`;
  const business = sectionMap.business;
  const receipt: InputReceipt = {
    docId: doc.docId, textPageId: doc.notionDocPageId,
    businessSha256: business === undefined ? null : await sha256Hex(business),
    sectionsSha256: await sha256Hex(JSON.stringify(PREFILTER_SECTIONS.map((key) => [key, sectionMap[key] === undefined ? null : sectionMap[key]]))),
    stateSha256: null, vocabVersion: deps.vocab.version, model: null,
  };
  const syncedTexts = await textReceipt(doc, textsByColumn, receipt);
  if (item.checkSourceInput) {
    const previous = readInputReceipt(item.row?.judgeInput);
    if (previous === null || previous.docId !== doc.docId) {
      throw new Error("同一書類の入力照合に必要な旧SHAがありません。旧判定を保持してHOLD");
    }
    if (previous.sectionsSha256 === receipt.sectionsSha256) {
      if (item.row === null || typeof item.row.judgeInput !== "string") throw new Error("入力照合の既存行が不正です");
      await writeRowWithEvidence(item, deps, {
        ...baseInput, judgeInput: withTextSyncReceipt(item.row.judgeInput, {
          ...await textReceipt(doc, textsByColumn, previous), equivalentJudgmentInputSha256: previous.sectionsSha256,
        }),
      }, undefined);
      return { stockCode: item.stockCode, kind: item.kind, outcome: "updated", tagStatus: item.row.tagStatus,
        candidateCount: item.row.candidateCount, ...ZERO_JEV_STATS };
    }
  }
  const localJudge = item.initialSemif === true || item.sourceChangedLocalJudge === true;
  const judgeName = localJudge ? localJudgeName(deps) : null;
  const judgePrefix = item.sourceChangedLocalJudge ? `${judgeName}入力変更の再判定`
    : judgeName === "Clef-Flash" ? INITIAL_CLEF_INPUT_PREFIX : INITIAL_SEMIF_INPUT_PREFIX;

  if (result.candidates.length === 0) {
    // 候補語 0 件でも「判定済」(判定はした。該当が無かっただけ。§5.6)。
    await writeRowWithEvidence(
      item,
      deps,
      {
        ...baseInput,
        upstream: [],
        downstream: [],
        distribution: [],
        themes: [],
        uncertain: null,
        evidenceText: null,
        tagStatus: "判定済",
        tagDoc,
        vocabVersion: deps.vocab.version,
        judgedAt: deps.today,
        candidateCount: 0,
        judgeInput: withTextSyncReceipt(withInputReceipt(`${localJudge ? `${judgePrefix}：` : "機械照合："}候補語なし (キーワード照合で該当語なし・外部判定なし)`, receipt), syncedTexts),
        error: null,
        attempts: 0,
        nextRetryAt: null,
      },
      null
    );
    return {
      stockCode: item.stockCode,
      kind: item.kind,
      outcome: outcomeKindOf(item),
      tagStatus: "判定済",
      candidateCount: 0,
      ...ZERO_JEV_STATS,
    };
  }

  const meta: DocMeta = {
    stockCode: item.stockCode,
    companyName: item.companyName,
    docId: doc.docId,
    periodEnd: doc.periodEnd,
    docTypeLabel: docTypeLabelOf(doc.docTypeCode),
  };
  let judgeInputSummary = localJudge
    ? judgePrefix
    : "機械照合：単語帳のキーワード一致・同文の除外語を確認 (AI確率なし)";

  let stats = ZERO_JEV_STATS;
  try {
    let tagOutcome: TagOutcome;
    if (localJudge) {
      const judgeInput = buildJudgeInput(meta, sectionMap, result);
      judgeInputSummary = `${judgePrefix}：${judgeInput.inputSummary}`;
      receipt.stateSha256 = await sha256Hex(judgeInput.state);
      deps.localJudgeInput?.({ ...receipt }, syncedTexts.textsSha256);
      const judged = await judgeCandidates(deps.jevClient, judgeInput,
        result.candidates.map((c) => c.term), deps.thresholds);
      receipt.model = judged.model;
      tagOutcome = summarizeJudgments(deps.vocab, result.candidates, judged.judgments);
      stats = { jevCalls: judged.calls, jevInputTokens: judged.inputTokens, jevOutputTokens: judged.outputTokens };
    } else {
      tagOutcome = summarizeKeywordMatches(deps.vocab, result.candidates);
    }
    const evidenceItems: EvidenceBlockInput["items"] = tagOutcome.evidence;
    const evidenceBlock =
      evidenceItems.length > 0
        ? buildEvidenceBlock({
            vocabVersion: deps.vocab.version,
            docId: doc.docId,
            periodLabel: formatPeriodJa(doc.periodEnd),
            items: evidenceItems,
          })
        : null;
    // 根拠文が Notion の rich_text 上限で切り詰められたときは、判定入力欄に
    // その事実を明記する(切り詰めを黙って残さない・ルール2)。ページ本文の
    // 根拠トグル(evidenceBlock)には全語が残るので情報は失われない。
    if (tagOutcome.evidenceTextTruncated) judgeInputSummary +=
      "／事業タグの根拠文は文字数上限のため一部省略(全語はページ本文の根拠トグル参照)";
    await writeRowWithEvidence(
      item,
      deps,
      {
        ...baseInput,
        upstream: tagOutcome.upstream,
        downstream: tagOutcome.downstream,
        distribution: tagOutcome.distribution,
        themes: tagOutcome.themes,
        uncertain: tagOutcome.uncertainText,
        evidenceText: tagOutcome.evidenceText,
        tagStatus: "判定済",
        tagDoc,
        vocabVersion: deps.vocab.version,
        judgedAt: deps.localJudgeDate && localJudge ? deps.localJudgeDate() : deps.today,
        candidateCount,
        judgeInput: withTextSyncReceipt(withInputReceipt(judgeInputSummary, receipt), syncedTexts),
        error: null,
        attempts: 0,
        nextRetryAt: null,
      },
      evidenceBlock
    );
    return {
      stockCode: item.stockCode,
      kind: item.kind,
      outcome: outcomeKindOf(item),
      tagStatus: "判定済",
      candidateCount,
      ...stats,
    };
  } catch (e) {
    if (e instanceof SupplementWriteHeldError) {
      return { stockCode: item.stockCode, kind: item.kind, outcome: "skipped", tagStatus: item.row === null ? null : item.row.tagStatus,
        candidateCount: item.row === null ? null : item.row.candidateCount, qualificationHeld: true, error: e.message, ...stats };
    }
    if (!(e instanceof SemifUnavailableError)) throw e;
    if (item.sourceChangedLocalJudge && item.row !== null) {
      return { stockCode: item.stockCode, kind: item.kind, outcome: "skipped", tagStatus: item.row.tagStatus,
        candidateCount: item.row.candidateCount, qualificationHeld: true,
        error: `${judgeName}入力変更の再判定をHOLD (旧本文・タグ・根拠・判定版を保持): ${e.message}`, ...ZERO_JEV_STATS };
    }
    return recordFailure(item, deps, {
      textStatus: "取得済",
      tagStatus: "判定不能",
      docId: doc.docId,
      docType: docTypeLabelOf(doc.docTypeCode),
      periodEnd: doc.periodEnd,
      submittedAt: doc.submittedAt,
      texts: textsByColumn,
      candidateCount,
      judgeInput: judgeInputSummary,
      errorMessage: `${judgeName} 判定に失敗: ${e.message}`,
    });
  }
}

interface FailureArgs {
  textStatus: SupplementRowInput["textStatus"];
  tagStatus: TagStatus;
  docId: string;
  docType: DocTypeLabel;
  periodEnd: string;
  submittedAt: string;
  texts: Record<string, string | null> | undefined;
  candidateCount: number | null;
  judgeInput: string | null;
  errorMessage: string;
}

/** 読込失敗・jev 判定不能の記録 (再試行回数+1・次回再試行日を計算)。共通経路。 */
async function recordFailure(item: WorkItem, deps: ProcessDeps, args: FailureArgs): Promise<ProcessOutcome> {
  const prevAttempts = item.row?.attempts ?? 0;
  const attempts = prevAttempts + 1;
  const nextRetryAt = nextRetryDate(deps.today, attempts);

  const input: SupplementRowInput = {
    companyName: item.companyName,
    stockCode: item.stockCode,
    masterPageId: deps.resolveMasterPageId(item.stockCode),
    sector33: item.sector33,
    docId: args.docId,
    docType: args.docType,
    periodEnd: args.periodEnd,
    submittedAt: args.submittedAt,
    textStatus: args.textStatus,
    upstream: [],
    downstream: [],
    distribution: [],
    themes: [],
    uncertain: null,
    evidenceText: null,
    tagStatus: args.tagStatus,
    tagDoc: null,
    vocabVersion: null,
    judgedAt: null,
    candidateCount: args.candidateCount,
    judgeInput: item.initialSemif && args.judgeInput === null
      ? `${localJudgeName(deps)}新規銘柄の初回判定：本文読込失敗 (外部判定なし)` : args.judgeInput,
    // rich_text の実測上限に対する安全側の切り詰め (Notion API 側の 2000字/要素 は
    // splitRichText が分割するが、事業タグの「判定エラー」列は原因の要約で十分)。
    error: args.errorMessage.slice(0, 1900),
    attempts,
    nextRetryAt,
  };
  if (args.texts !== undefined) input.texts = args.texts;

  await writeRowWithEvidence(item, deps, input, null);
  return {
    stockCode: item.stockCode,
    kind: item.kind,
    outcome: outcomeKindOf(item),
    tagStatus: args.tagStatus,
    candidateCount: args.candidateCount,
    error: args.errorMessage,
    ...ZERO_JEV_STATS,
  };
}
