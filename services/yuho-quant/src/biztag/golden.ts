/**
 * ゴールデンセットによる精度測定。設計: docs/005-yuho-quant-business-tags.md §10・§6.3-3。
 *
 * 各項目は実在する有報の文だけを使う (`code`/`docId`/`docTypeCode`/`periodEnd`/
 * `companyName` + 期待する語ごとの判定 `expect[]`)。本文そのものはゴールデン
 * セットに含めず (Notion/D1 が正)、評価時に呼び出し側が読んで渡す。
 */
import { readFileSync } from "node:fs";
import { z } from "../../../../src/shared/zod-mini.js";
import { STOCK_CODE_REGEX } from "../../../../src/shared/jpx/stock-code.js";
import { DOC_TYPE_CODES, docTypeLabelOf } from "./doc-type.js";
import { buildJudgeInput, type DocMeta } from "./excerpt.js";
import { bandOf, judgeCandidates, type Band, type BtThresholds } from "./judge.js";
import { TEXT_SECTIONS, type TextSectionKey } from "../services/edinet/text-sections.js";
import { prefilter, type PrefilterSectionKey } from "./prefilter.js";
import { VERSION_PATTERN, type Vocabulary } from "./vocabulary/schema.js";
import type { JevClient } from "../../../../src/shared/jev/index.js";

const TEXT_SECTION_KEYS = TEXT_SECTIONS.map((d) => d.key) as [TextSectionKey, ...TextSectionKey[]];

const nonEmpty = () => z.string().check(z.minLength(1));
/** 日付 (YYYY-MM-DD)。ゴールデンセットを作った日 (`createdAt`) の形式。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const GoldenExpectSchema = z.strictObject({
  termId: nonEmpty(),
  label: z.boolean(),
  quote: nonEmpty(),
  /** 引用 (ラベルの根拠) を取った有報の項目。判定の入力節に限らない (子会社の状況等も可) */
  sectionKey: z.enum(TEXT_SECTION_KEYS),
  /** 運営の依頼文で「当てたい例」に挙がった組 (label は必ず true。loadGoldenSet が検査) */
  mustHit: z.optional(z.boolean()),
  /** 運営の依頼文で「外したい例」に挙がった組 (label は必ず false。loadGoldenSet が検査) */
  mustNot: z.optional(z.boolean()),
});

export const GoldenItemSchema = z.strictObject({
  code: z.string().check(z.regex(STOCK_CODE_REGEX)),
  docId: nonEmpty(),
  /** 120=有報／130=訂正有報 (D1 `yuho_documents.doc_type_code` と同じ値)。 */
  docTypeCode: z.enum(DOC_TYPE_CODES),
  periodEnd: nonEmpty(),
  companyName: nonEmpty(),
  expect: z.array(GoldenExpectSchema).check(z.minLength(1)),
});

export const GoldenSetSchema = z.strictObject({
  /** ゴールデンセット自体のバージョン (ファイル名 `v1.json` と対応)。 */
  version: nonEmpty(),
  /** ゴールデンセットを作成・更新した日 (YYYY-MM-DD, JST)。 */
  createdAt: z.string().check(z.regex(DATE_PATTERN)),
  /** このゴールデンセットの `expect[]` が前提にしている単語帳の版。 */
  vocabVersion: z.string().check(z.regex(VERSION_PATTERN)),
  items: z.array(GoldenItemSchema).check(z.minLength(1)),
});
export type GoldenExpect = z.infer<typeof GoldenExpectSchema>;
export type GoldenItem = z.infer<typeof GoldenItemSchema>;
export type GoldenSet = z.infer<typeof GoldenSetSchema>;

/** `code` + `docId` からゴールデン項目の一意キーを作る (`texts` の索引キーと共通)。 */
export function goldenItemKey(item: Pick<GoldenItem, "code" | "docId">): string {
  return `${item.code}:${item.docId}`;
}

/**
 * `mustHit`/`mustNot` の意味的な前提 (mustHit ⇒ label=true・mustNot ⇒ label=false)
 * を検査する。運営が「当てたい例」に label=false を紛れ込ませる等の入力ミスを
 * 早期に落とすため、`loadGoldenSet` が読み込み時に必ず呼ぶ (ルール2: 矛盾した
 * 入力を黙って通さない)。
 */
export function assertGoldenSetInvariants(goldenSet: GoldenSet): void {
  for (const item of goldenSet.items) {
    for (const expect of item.expect) {
      if (expect.mustHit === true && expect.label !== true) {
        throw new Error(
          `assertGoldenSetInvariants: mustHit は label=true でなければなりません (${goldenItemKey(item)} ${expect.termId})`
        );
      }
      if (expect.mustNot === true && expect.label !== false) {
        throw new Error(
          `assertGoldenSetInvariants: mustNot は label=false でなければなりません (${goldenItemKey(item)} ${expect.termId})`
        );
      }
    }
  }
}

/**
 * `services/yuho-quant/src/biztag/golden/v1.json` を読む。
 * このファイルは意図的にリポジトリへ未同梱 (実在する有報の文だけで作る運用
 * データのため、このタスクでは捏造しない。運営が用意する — ルール1)。
 */
export function loadGoldenSet(): GoldenSet {
  const path = new URL("./golden/v1.json", import.meta.url);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    throw new Error(
      "services/yuho-quant/src/biztag/golden/v1.json が見つかりません。" +
        "実在する有報の文だけを使ったゴールデンセットを運営が用意してから実行してください " +
        "(docs/005-yuho-quant-business-tags.md §10・§11.4)。",
      { cause: e }
    );
  }
  const goldenSet = GoldenSetSchema.parse(JSON.parse(raw));
  assertGoldenSetInvariants(goldenSet);
  return goldenSet;
}

export interface GoldenMetrics {
  /** 「はい」判定のうち期待どおり true だった比率。「はい」判定が0件なら測れない (null)。 */
  precisionYes: number | null;
  /** 期待 label=true のうち「はい」判定できた比率。期待trueが0件なら測れない (null)。 */
  recallYes: number | null;
  /** `mustHit` (当てたい例) のうち「はい」判定できた比率。mustHit が0件なら測れない (null)。 */
  mustHitRecall: number | null;
  /** `mustNot` (外したい例) なのに「はい」判定してしまった件数 (率ではなく件数)。 */
  mustNotViolations: number;
  /** 期待 label=true のうち絞り込みで候補にすら挙がらなかった比率。期待trueが0件なら測れない (null)。 */
  filterMissRate: number | null;
}

export interface GoldenPerItemResult {
  code: string;
  docId: string;
  termId: string;
  expectedLabel: boolean;
  /** 絞り込み (prefilter) の時点で候補になったか */
  candidate: boolean;
  band: Band | "no_candidate";
  /** jev が返した確率。候補にならず判定していない場合は null。 */
  probability: number | null;
  correct: boolean;
  mustHit: boolean;
  mustNot: boolean;
}

export interface GoldenEvaluation extends GoldenMetrics {
  perItem: GoldenPerItemResult[];
  confusion: { truePositive: number; falsePositive: number; trueNegative: number; falseNegative: number };
}

/**
 * 保存済みの `perItem` (確率つき) から、別のしきい値で `GoldenMetrics` を
 * 作り直す純粋関数。jev を呼び直さずにしきい値の較正を試せるようにする
 * (`pnpm biztag golden` の閾値スイープ表・`gate.ts` の再評価が使う)。
 */
export function evaluateAtThresholds(
  perItem: GoldenPerItemResult[],
  t: BtThresholds
): GoldenMetrics & { confusion: GoldenEvaluation["confusion"] } {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  let expectedTrueCount = 0;
  let filterMissCount = 0;
  let mustHitTotal = 0;
  let mustHitYes = 0;
  let mustNotViolations = 0;

  for (const r of perItem) {
    const predictedYes = r.candidate && r.probability !== null && bandOf(r.probability, t) === "yes";

    if (r.expectedLabel) {
      expectedTrueCount++;
      if (!r.candidate) filterMissCount++;
      if (predictedYes) truePositive++;
      else falseNegative++;
    } else if (predictedYes) {
      falsePositive++;
    } else {
      trueNegative++;
    }

    if (r.mustHit) {
      mustHitTotal++;
      if (predictedYes) mustHitYes++;
    }
    if (r.mustNot && predictedYes) mustNotViolations++;
  }

  const predictedYesCount = truePositive + falsePositive;
  const precisionYes = predictedYesCount === 0 ? null : truePositive / predictedYesCount;
  const recallYes = expectedTrueCount === 0 ? null : truePositive / expectedTrueCount;
  const mustHitRecall = mustHitTotal === 0 ? null : mustHitYes / mustHitTotal;
  const filterMissRate = expectedTrueCount === 0 ? null : filterMissCount / expectedTrueCount;

  return {
    precisionYes,
    recallYes,
    mustHitRecall,
    mustNotViolations,
    filterMissRate,
    confusion: { truePositive, falsePositive, trueNegative, falseNegative },
  };
}

/**
 * ゴールデンセットで精度を測る。項目ごとに絞り込み (`prefilter`) をやり直し、
 * 候補になった語 **全て** を jev に問い合わせる (本番の `process.ts` と同じ
 * バッチ構成にするため。`expect` に挙がっている語だけに絞ると、本番より
 * 小さいバッチで jev に問い合わせることになり、精度の測定が実態とずれる)。
 * 候補にすら挙がらなかった期待 true の項目は `filterMissRate` にカウントする
 * (絞り込みの取りこぼし。jev には問い合わせない)。
 *
 * 指標の定義は {@link GoldenMetrics} を参照。実際の集計は
 * {@link evaluateAtThresholds} に委譲する。
 */
export async function evaluateGolden(
  goldenSet: GoldenSet,
  vocab: Vocabulary,
  texts: Map<string, Partial<Record<PrefilterSectionKey, string>>>,
  judge: JevClient,
  thresholds: BtThresholds
): Promise<GoldenEvaluation> {
  const perItem: GoldenPerItemResult[] = [];

  for (const item of goldenSet.items) {
    const key = goldenItemKey(item);
    const sections = texts.get(key);
    if (!sections) {
      throw new Error(`evaluateGolden: テキストが見つかりません (${key})`);
    }
    const result = prefilter(vocab, sections);
    const candidateById = new Map(result.candidates.map((c) => [c.term.id, c] as const));

    const judgments = new Map<string, number>();
    if (result.candidates.length > 0) {
      const meta: DocMeta = {
        stockCode: item.code,
        companyName: item.companyName,
        docId: item.docId,
        periodEnd: item.periodEnd,
        docTypeLabel: docTypeLabelOf(item.docTypeCode),
      };
      const judgeInput = buildJudgeInput(meta, sections, result);
      const termsToJudge = result.candidates.map((c) => c.term);
      const { judgments: js } = await judgeCandidates(judge, judgeInput, termsToJudge, thresholds);
      for (const j of js) judgments.set(j.termId, j.probability);
    }

    for (const expect of item.expect) {
      const candidate = candidateById.has(expect.termId);
      const mustHit = expect.mustHit ?? false;
      const mustNot = expect.mustNot ?? false;

      if (!candidate) {
        perItem.push({
          code: item.code,
          docId: item.docId,
          termId: expect.termId,
          expectedLabel: expect.label,
          candidate: false,
          band: "no_candidate",
          probability: null,
          correct: !expect.label,
          mustHit,
          mustNot,
        });
        continue;
      }
      const p = judgments.get(expect.termId);
      if (p === undefined) {
        throw new Error(`evaluateGolden: ${expect.termId} の判定結果が無い (${key})`);
      }
      const band = bandOf(p, thresholds);
      const predictedYes = band === "yes";
      perItem.push({
        code: item.code,
        docId: item.docId,
        termId: expect.termId,
        expectedLabel: expect.label,
        candidate: true,
        band,
        probability: p,
        correct: predictedYes === expect.label,
        mustHit,
        mustNot,
      });
    }
  }

  const { confusion, ...metrics } = evaluateAtThresholds(perItem, thresholds);
  return { ...metrics, confusion, perItem };
}
