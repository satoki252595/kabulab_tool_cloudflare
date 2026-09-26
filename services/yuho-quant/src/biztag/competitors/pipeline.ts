/**
 * 競合他社パイプライン (`pnpm biztag competitors`) のオーケストレーション。
 * 設計: docs/005-yuho-quant-business-tags.md「競合他社」節 §5・§12.9(judge)。
 *
 * 入力はすべて Notion「銘柄マスタ（補足）」(事業タグ・33業種・「事業の内容」)
 * だけで完結する。D1 には触れない (受注・海外売上と同じく「D1 は既存表を読むだけ」
 * の運営決定に倣い、ここでは D1 を読む必要すら無い)。
 *
 * 増分処理: 「銘柄マスタ（補足）」の各行に対し、
 *   - `競合判定書類ID` が無い (未判定)
 *   - `競合判定書類ID` ≠ `有報書類ID` (書類が変わった = 事業内容が変わった可能性)
 *   - `競合判定の版` ≠ 今の候補生成版+モデル (アルゴリズム/モデルを変えた)
 * のいずれかに該当する銘柄だけを対象にする (差分方式。biztag 本体の `plan.ts` と同じ精神)。
 */
import {
  ensureCompetitorColumns,
  ensureSupplementDb,
  loadCompetitorMeta,
  loadSupplementRows,
  writeCompetitorRelation,
  SUPPLEMENT_PROPS,
} from "../../../../../src/shared/notion-archive/index.js";
import { createJevClient, estimateCostUsd, jevEnv, type JevClient } from "../../../../../src/shared/jev/index.js";
import { createSemifClient } from "../../../../../src/shared/semif/index.js";
import { resolveActiveVocabulary } from "../active-vocab.js";
import { todayJst } from "../date-jst.js";
import { buildSchemaSpec } from "../pipeline.js";
import { buildCandidates, type CandidateGenOptions, type CompanyProfile, GENERIC_TAG_LABELS } from "./candidates.js";
import { loadCompetitorCalibration, type CompetitorJudge } from "./calibration.js";
import { processCompanyCompetitors } from "./process.js";

/** 判定に使うクライアントを judge から作る (jev は API キー必須・semif はローカル常駐プロセス)。 */
function createJudgeClient(judge: CompetitorJudge, model: string): JevClient {
  if (judge === "semif") return createSemifClient({});
  return createJevClient({ apiKey: jevEnv.TYPESAFE_API_KEY(), model });
}

export interface RunCompetitorsOptions {
  /** 処理に充てる時間予算 (ミリ秒)。超えたら新規銘柄の着手を止める。 */
  budgetMs: number;
  /** 実際に処理する銘柄数の上限。 */
  limit?: number;
  /** 指定した証券コードだけを対象にする (増分判定をスキップし、必ず対象にする)。 */
  codes?: string[];
  /** true なら Notion (relation・メタ列) への書込を一切行わない。判定・候補生成は実データで行う。 */
  dryRun?: boolean;
  /** 判定に使うモデル。既定 jev (2026-09-26 追加。§12.9)。 */
  judge?: CompetitorJudge;
  /**
   * true なら「一度も判定されていない行」(`競合判定書類ID` が無い) だけを対象にする。
   * `codes` 同様、書類変更・版変更による再判定 (`needsRecompute`) はスキップする。
   * jev のクレジット枯渇等で中断した続きを別 judge (semif) で引き継ぐとき、
   * 既に判定済みの行を version 不一致 (judge が違う) で誤って再判定しないための
   * フラグ (2026-09-26 追加。§12.9)。
   */
  onlyUnjudged?: boolean;
  /** 会社ごとの処理を並列実行する数 (既定1=逐次)。semif (ローカル推論の1リクエスト単位) 向け。 */
  concurrency?: number;
}

export interface RunCompetitorsSummary {
  startedAt: string;
  elapsedMs: number;
  budgetMs: number;
  dryRun: boolean;
  /** 判定に使ったモデル。 */
  judge: CompetitorJudge;
  /** 判定に使った具体的なモデル名 (versionTag にも入る。例: `jev-1.13.0` / `Qwen3.5-4B@851bf6e/semif-mlx`)。 */
  model: string;
  /** 候補生成の母集団 (事業タグの状態=判定済の銘柄数)。 */
  corpusSize: number;
  /** 増分方式で今回対象になった銘柄数 (未処理を含む)。 */
  totalTargets: number;
  processed: number;
  remaining: number;
  /**
   * 判定呼び出しの使用量。semif はローカル推論で API 従量課金が存在しないため、
   * judge="semif" のとき inputTokens/outputTokens は 0 だが、これは
   * 「計測不能」ではなく「実費用ゼロという事実そのもの」を意味する
   * (`costMetering` 参照。ルール2)。
   */
  jev: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    costMetering: "metered" | "not_metered_local";
  };
  results: Array<{
    stockCode: string;
    companyName: string;
    candidateCount: number;
    competitorCodes: string[];
  }>;
  failures: Array<{ stockCode: string; message: string }>;
}

/** 対象銘柄を選ぶ (増分方式。ヘッダコメント参照)。 */
export function needsRecompute(
  profile: CompanyProfile,
  meta: { judgedDocId: string | null; version: string | null } | undefined,
  versionTag: string
): boolean {
  if (meta === undefined) return true;
  if (meta.judgedDocId === null || meta.judgedDocId === "") return true;
  if (meta.judgedDocId !== (profile.docId ?? "")) return true;
  if (meta.version !== versionTag) return true;
  return false;
}

export async function runCompetitors(opts: RunCompetitorsOptions): Promise<RunCompetitorsSummary> {
  const start = Date.now();
  const startedAt = new Date(start).toISOString();
  const today = todayJst(() => start);

  const judge: CompetitorJudge = opts.judge ?? "jev";
  const calibration = loadCompetitorCalibration(judge);
  const versionTag = `${calibration.candidateVersion}|${calibration.model}`;
  const judgeClient = createJudgeClient(judge, calibration.model);

  const { vocab } = await resolveActiveVocabulary(today);
  // sector33 の選択肢追加はここでは行わない (biztag run が既に維持している。
  // 空配列を渡しても既存の選択肢は消えない — buildMissingPatch は追加のみ)。
  const { dbId, propertyIds: supplementPropertyIds } = await ensureSupplementDb(buildSchemaSpec(vocab, []));
  const competitorPropertyIds = await ensureCompetitorColumns(dbId);
  const propertyIds = { ...supplementPropertyIds, ...competitorPropertyIds };

  const rows = await loadSupplementRows(dbId, propertyIds, { textColumns: ["事業の内容"] });
  const corpus: CompanyProfile[] = rows
    .filter((r) => r.tagStatus === "判定済")
    .map((r) => ({
      stockCode: r.stockCode,
      companyName: r.companyName,
      pageId: r.pageId,
      sector33: r.sector33,
      tags: [...r.upstream, ...r.downstream, ...r.distribution],
      businessText: r.texts["事業の内容"] ?? "",
      docId: r.docId,
    }));
  const profileByCode = new Map(corpus.map((c) => [c.stockCode, c] as const));

  const candidateOptions: CandidateGenOptions = {
    topK: calibration.candidateTopK,
    weights: calibration.candidateWeights,
    genericTagLabels: GENERIC_TAG_LABELS,
    postingCaps: calibration.candidatePostingCaps,
  };
  const candidatesByCode = buildCandidates(corpus, candidateOptions);

  const meta = await loadCompetitorMeta(dbId, propertyIds, SUPPLEMENT_PROPS.code);
  const metaByCode = new Map(meta.map((m) => [m.stockCode, m] as const));

  let targetCodes: string[];
  if (opts.codes && opts.codes.length > 0) {
    const wanted = new Set(opts.codes);
    targetCodes = corpus.map((c) => c.stockCode).filter((code) => wanted.has(code));
  } else if (opts.onlyUnjudged) {
    targetCodes = corpus
      .filter((p) => {
        const m = metaByCode.get(p.stockCode);
        return m === undefined || m.judgedDocId === null;
      })
      .map((p) => p.stockCode);
  } else {
    targetCodes = corpus
      .filter((p) => needsRecompute(p, metaByCode.get(p.stockCode), versionTag))
      .map((p) => p.stockCode);
  }
  targetCodes.sort();

  const results: RunCompetitorsSummary["results"] = [];
  const failures: RunCompetitorsSummary["failures"] = [];
  let processed = 0;
  let jevCalls = 0;
  let jevInputTokens = 0;
  let jevOutputTokens = 0;
  let workBudgetLeft = opts.limit ?? Infinity;

  const writeFn = opts.dryRun ? async (): Promise<void> => {} : writeCompetitorRelation;

  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (workBudgetLeft <= 0 || Date.now() - start > opts.budgetMs) return;
      if (cursor >= targetCodes.length) return;
      const code = targetCodes[cursor];
      cursor++;
      workBudgetLeft--;

      const a = profileByCode.get(code);
      if (!a) throw new Error(`runCompetitors: 対象銘柄 ${code} のプロフィールが見つかりません`);
      const candidates = candidatesByCode.get(code) ?? [];
      try {
        const outcome = await processCompanyCompetitors(a, candidates, profileByCode, {
          jevClient: judgeClient,
          thresholds: calibration.thresholds,
          versionTag,
          today,
          writeCompetitorRelation: writeFn,
          batchSize: calibration.batchSize,
        });
        processed++;
        jevCalls += outcome.jevCalls;
        jevInputTokens += outcome.jevInputTokens;
        jevOutputTokens += outcome.jevOutputTokens;
        results.push({
          stockCode: outcome.stockCode,
          companyName: a.companyName,
          candidateCount: outcome.candidateCount,
          competitorCodes: outcome.competitorCodes,
        });
      } catch (e) {
        failures.push({ stockCode: code, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // concurrency>1 は複数会社を並行処理する (semif は常駐プロセス1本を全員で
  // 共有するため、リクエストは実質的にプロセス側の応答待ちで直列化される —
  // Notion への書込は notion-archive/client.ts のプロセス内直列キューが
  // 自動で捌く。ルール6)。
  const concurrency = Math.max(1, Math.trunc(opts.concurrency ?? 1));
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const elapsedMs = Date.now() - start;
  return {
    startedAt,
    elapsedMs,
    budgetMs: opts.budgetMs,
    dryRun: opts.dryRun ?? false,
    judge,
    model: calibration.model,
    corpusSize: corpus.length,
    totalTargets: targetCodes.length,
    processed,
    remaining: targetCodes.length - processed,
    jev: {
      calls: jevCalls,
      inputTokens: jevInputTokens,
      outputTokens: jevOutputTokens,
      estimatedCostUsd: estimateCostUsd(jevInputTokens),
      costMetering: judge === "semif" ? "not_metered_local" : "metered",
    },
    results,
    failures,
  };
}
