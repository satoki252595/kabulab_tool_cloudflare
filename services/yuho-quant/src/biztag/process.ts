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
  type DocTypeLabel,
  type EvidenceBlockInput,
  type SupplementRowInput,
  type TagStatus,
} from "../../../../src/shared/notion-archive/index.js";
import type { StockTextSection } from "../../../../src/shared/notion-archive/stock-text.js";
import { JevUnavailableError, type JevClient } from "../../../../src/shared/jev/index.js";
import { addDaysJst } from "./date-jst.js";
import { docTypeLabelOf } from "./doc-type.js";
import { formatPeriodJa } from "./evidence.js";
import { buildJudgeInput, type DocMeta } from "./excerpt.js";
import { judgeCandidates, type BtThresholds } from "./judge.js";
import type { WorkItem } from "./plan.js";
import { isPrefilterSection, prefilter, type PrefilterSectionKey } from "./prefilter.js";
import { summarizeJudgments } from "./row.js";
import type { LatestDoc } from "./source.js";
import { deriveThemes } from "./themes.js";
import type { Vocabulary } from "./vocabulary/schema.js";
import { TEXT_SECTIONS } from "../services/edinet/text-sections.js";

type Doc = NonNullable<LatestDoc["doc"]>;

export interface ProcessDeps {
  vocab: Vocabulary;
  thresholds: BtThresholds;
  jevClient: JevClient;
  /** 判定日・再試行日の基準 (JST, YYYY-MM-DD) */
  today: string;
  /** ① 銘柄マスタのページ ID 解決 (無ければ null。relation を張らない) */
  resolveMasterPageId: (stockCode: string) => string | null;
  /** Notion 有報テキスト行の読取 (`notionDocPageId` → セクション列) */
  readStockTextRow: (rowPageId: string) => Promise<StockTextSection[]>;
  createSupplementRow: (input: SupplementRowInput, evidence?: unknown | null) => Promise<string>;
  updateSupplementRow: (pageId: string, input: SupplementRowInput) => Promise<void>;
  replaceEvidenceBlock: (pageId: string, block: unknown | null) => Promise<void>;
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
}

const ZERO_JEV_STATS = { jevCalls: 0, jevInputTokens: 0, jevOutputTokens: 0 };

/** 失敗 n 回目の後の再試行間隔 = 2^(n-1) 日 (1, 2, 4, 8, 16 日。§5.2)。 */
function nextRetryDate(today: string, attemptsAfter: number): string {
  return addDaysJst(today, 2 ** (attemptsAfter - 1));
}

async function writeRow(item: WorkItem, deps: ProcessDeps, input: SupplementRowInput): Promise<string> {
  if (item.row) {
    await deps.updateSupplementRow(item.row.pageId, input);
    return item.row.pageId;
  }
  return deps.createSupplementRow(input, null);
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
          themes: [],
          uncertain: null,
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
      const pageId = await writeRow(item, deps, {
        companyName: item.companyName,
        stockCode: item.stockCode,
        masterPageId: deps.resolveMasterPageId(item.stockCode),
        sector33: item.sector33,
        docId: item.doc?.docId ?? null,
        docType: item.doc ? docTypeLabelOf(item.doc.docTypeCode) : null,
        periodEnd: item.doc?.periodEnd ?? null,
        submittedAt: item.doc?.submittedAt ?? null,
        textStatus: "本文なし",
        texts: allTextColumnsCleared(),
        upstream: [],
        downstream: [],
        themes: [],
        uncertain: null,
        tagStatus: "本文なし",
        tagDoc: null,
        vocabVersion: null,
        judgedAt: null,
        candidateCount: null,
        judgeInput: null,
        error: null,
        attempts: 0,
        nextRetryAt: null,
      });
      await deps.replaceEvidenceBlock(pageId, null);
      return {
        stockCode: item.stockCode,
        kind: item.kind,
        outcome: outcomeKindOf(item),
        tagStatus: "本文なし",
        candidateCount: null,
        ...ZERO_JEV_STATS,
      };
    }

    case "version_bump": {
      if (item.row === null || item.doc === null) {
        throw new Error(`processStock: version_bump に必要な行/書類が無い (${item.stockCode})`);
      }
      const tagIds = idsFromActiveLabels(deps.vocab, [...item.row.upstream, ...item.row.downstream]);
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
  const textsByColumn: Record<string, string | null> = allTextColumnsCleared();
  for (const s of sections) {
    const title = TITLE_BY_SECTION_KEY.get(s.sectionKey);
    if (title === undefined) {
      throw new Error(`有報テキスト行に未知の節キー「${s.sectionKey}」があります (${item.stockCode} ${doc.docId})`);
    }
    textsByColumn[title] = s.text;
    if (isPrefilterSection(s.sectionKey)) {
      sectionMap[s.sectionKey] = s.text;
    }
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

  if (result.candidates.length === 0) {
    // 候補語 0 件でも「判定済」(判定はした。該当が無かっただけ。§5.6)。
    const pageId = await writeRow(item, deps, {
      ...baseInput,
      upstream: [],
      downstream: [],
      themes: [],
      uncertain: null,
      tagStatus: "判定済",
      tagDoc,
      vocabVersion: deps.vocab.version,
      judgedAt: deps.today,
      candidateCount: 0,
      judgeInput: "候補語なし (絞り込みで該当語なし)",
      error: null,
      attempts: 0,
      nextRetryAt: null,
    });
    await deps.replaceEvidenceBlock(pageId, null);
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
  const judgeInput = buildJudgeInput(meta, sectionMap, result);

  try {
    const { judgments, calls, inputTokens, outputTokens } = await judgeCandidates(
      deps.jevClient,
      judgeInput,
      result.candidates.map((c) => c.term),
      deps.thresholds
    );
    const tagOutcome = summarizeJudgments(deps.vocab, result.candidates, judgments);
    const pageId = await writeRow(item, deps, {
      ...baseInput,
      upstream: tagOutcome.upstream,
      downstream: tagOutcome.downstream,
      themes: tagOutcome.themes,
      uncertain: tagOutcome.uncertainText,
      tagStatus: "判定済",
      tagDoc,
      vocabVersion: deps.vocab.version,
      judgedAt: deps.today,
      candidateCount,
      judgeInput: judgeInput.inputSummary,
      error: null,
      attempts: 0,
      nextRetryAt: null,
    });
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
    await deps.replaceEvidenceBlock(pageId, evidenceBlock);
    return {
      stockCode: item.stockCode,
      kind: item.kind,
      outcome: outcomeKindOf(item),
      tagStatus: "判定済",
      candidateCount,
      jevCalls: calls,
      jevInputTokens: inputTokens,
      jevOutputTokens: outputTokens,
    };
  } catch (e) {
    if (!(e instanceof JevUnavailableError)) throw e;
    return recordFailure(item, deps, {
      textStatus: "取得済",
      tagStatus: "判定不能",
      docId: doc.docId,
      docType: docTypeLabelOf(doc.docTypeCode),
      periodEnd: doc.periodEnd,
      submittedAt: doc.submittedAt,
      texts: textsByColumn,
      candidateCount,
      judgeInput: judgeInput.inputSummary,
      errorMessage: `jev 判定に失敗: ${e.message}`,
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
    themes: [],
    uncertain: null,
    tagStatus: args.tagStatus,
    tagDoc: null,
    vocabVersion: null,
    judgedAt: null,
    candidateCount: args.candidateCount,
    judgeInput: args.judgeInput,
    // rich_text の実測上限に対する安全側の切り詰め (Notion API 側の 2000字/要素 は
    // splitRichText が分割するが、事業タグの「判定エラー」列は原因の要約で十分)。
    error: args.errorMessage.slice(0, 1900),
    attempts,
    nextRetryAt,
  };
  if (args.texts !== undefined) input.texts = args.texts;

  const pageId = await writeRow(item, deps, input);
  await deps.replaceEvidenceBlock(pageId, null);
  return {
    stockCode: item.stockCode,
    kind: item.kind,
    outcome: outcomeKindOf(item),
    tagStatus: args.tagStatus,
    candidateCount: args.candidateCount,
    ...ZERO_JEV_STATS,
  };
}
