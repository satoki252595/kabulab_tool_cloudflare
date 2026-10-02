/**
 * 実行オーケストレーション (`pnpm biztag run`)。
 * 設計: docs/005-yuho-quant-business-tags.md §2・§7・§9・§11.2。
 *
 * 1) 公式上場の初回資格・見直し期限の検査 (語彙の有料審査は停止)
 * 2) 今の有効な単語帳を解決
 * 3) 「銘柄マスタ（補足）」DB を確保
 * 4) D1 の最新有報と補足行を突き合わせて作業一覧を作る (`plan.ts`)
 * 5) 予算 (`budgetMs`) の範囲で 1 銘柄ずつ処理する (`process.ts`)
 * 6) 見直し材料 (review packet) を台帳へ反映する
 *
 * D1 は読むだけ (§0 運営決定)。Node から D1 へは HTTP (`createD1HttpDb`) で読む。
 */
import { inArray } from "drizzle-orm";
import { createD1HttpDb } from "../../../../src/shared/db/d1-http-client.js";
import {
  createLedgerEntry,
  createSupplementRow,
  ensureLedgerDb,
  ensureSupplementDb,
  listLedgerEntries,
  loadStockMasterIndex,
  loadSupplementRows,
  notionStats,
  readLedgerJson,
  readStockTextRow,
  replaceEvidenceBlock,
  replaceLedgerJson,
  resetNotionStats,
  updateLedgerEntry,
  updateSupplementRow,
  type LedgerEntry,
  type NotionStats,
  type SupplementSchemaSpec,
} from "../../../../src/shared/notion-archive/index.js";
import type { JevClient } from "../../../../src/shared/jev/index.js";
import { createSemifClient, SEMIF_MODEL, type SemifClient } from "../../../../src/shared/semif/index.js";
import { createMemoizedJevClient } from "../../../../src/shared/jev/memo.js";
import * as yuhoSchema from "../db/schema.js";
import { yuhoEnv } from "../env.js";
import { resolveActiveVocabulary } from "./active-vocab.js";
import { todayJst } from "./date-jst.js";
import { checkDeadline, type DeadlineCheckResult, type GateRunResult } from "./gate.js";
import { evaluateGolden, goldenItemKey, loadGoldenSet, type GoldenMetrics } from "./golden.js";
import type { BtThresholds } from "./judge.js";
import { MAX_RETRY_ATTEMPTS, planWork, type WorkItem } from "./plan.js";
import { processStock, type ProcessDeps } from "./process.js";
import { isPrefilterSection, type PrefilterSectionKey } from "./prefilter.js";
import { buildReviewPacket, refreshReviewPacketLedger } from "./review.js";
import { loadLatestDocs, loadNewStockEligibility, type BiztagSourceDb } from "./source.js";
import type { Vocabulary } from "./vocabulary/schema.js";
import { TEXT_SECTIONS } from "../services/edinet/text-sections.js";

export interface RunBiztagOptions {
  /** 処理に充てる時間予算 (ミリ秒)。超えたら新規銘柄の着手を止める。 */
  budgetMs: number;
  /** 実際に処理する (skip 以外の) 銘柄数の上限。 */
  limit?: number;
  /** 指定した証券コードだけを対象にする。 */
  codes?: string[];
  /**
   * true なら Notion への書込を一切行わない (安全な下見)。
   * 「銘柄マスタ（補足）」の行・根拠、見直し材料・期限通知の台帳書込を止める。
   * 新規初回のローカル判定は HOLD にし、既存の機械照合だけ実データで下見する。
   * DB 確保・単語帳解決は行う。
   */
  dryRun?: boolean;
  thresholds: BtThresholds;
  model: string;
}

export interface RunSummary {
  startedAt: string;
  elapsedMs: number;
  budgetMs: number;
  dryRun: boolean;
  totalStocks: number;
  processed: number;
  remaining: number;
  countsByKind: Record<string, number>;
  countsByTagStatus: Record<string, number>;
  coverage: { judged: number; total: number; ratio: number };
  jev: { calls: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number };
  /** jev は旧サマリとの互換キー。実際の判定/費用境界はこの欄に明記する。 */
  judge?: { provider: "semif"; model: string; calls: number; costMetering: "not_metered_local"; externalApiCalls: 0; tokens: null; hardwareCostUsd: null };
  notion: NotionStats;
  vocabVersion: string;
  vocabSeeded: boolean;
  gate: GateRunResult | null;
  /** nullの関門を実施済みと読まないための停止理由。 */
  gateSkippedReason?: string;
  deadline: DeadlineCheckResult;
  failures: Array<{ stockCode: string; message: string }>;
  /** ① 銘柄マスタに同じ銘柄コードの行が複数あり、relation を付けなかった銘柄コード */
  masterDuplicates: string[];
  /** 再試行上限 (`MAX_RETRY_ATTEMPTS`) に到達したまま残っている銘柄コード (docs §11.6) */
  retryExhausted: string[];
  /**
   * 課金切れ (jev 402/billing_error) で判定不能のまま残っている銘柄コード。
   * 再試行期日が未来・再試行上限に達した skip も含めて集計する (`remaining: 0` を完了と
   * 読み違えないため。2026-09-29 実測 14 件が green のまま埋もれていた)。
   */
  billingBlocked: string[];
  qualificationHeld?: string[];
}

/**
 * 台帳「判定エラー」列が jev 課金切れを示すかの純粋判定。
 * `JevUnavailableError` の message 形 (`status=402` / `billing_error` 含有) を見る。
 */
export function isBillingBlockedError(error: string | null): boolean {
  if (!error) return false;
  return error.includes("billing_error") || error.includes("status=402");
}

/**
 * competitors パイプライン (`competitors/pipeline.ts`) からも再利用する
 * (「銘柄マスタ（補足）」の dbId/propertyIds 解決はここが正本。重複させない)。
 */
export function buildSchemaSpec(vocab: Vocabulary, sector33Options: string[]): SupplementSchemaSpec {
  return {
    textColumns: TEXT_SECTIONS.map((t) => t.title),
    upstreamOptions: vocab.business
      .filter((t) => !t.deprecated && t.notionColumn === "upstream")
      .map((t) => t.labelJa),
    downstreamOptions: vocab.business
      .filter((t) => !t.deprecated && t.notionColumn === "downstream")
      .map((t) => t.labelJa),
    distributionOptions: vocab.business
      .filter((t) => !t.deprecated && t.notionColumn === "distribution")
      .map((t) => t.labelJa),
    themeOptions: vocab.themes.filter((t) => !t.deprecated).map((t) => t.labelJa),
    versionOptions: [vocab.version],
    sector33Options,
  };
}

/**
 * D1 の bind 変数上限 (1クエリ100。memory: D1 bound param limit) を超えないよう、
 * 配列を安全な件数ごとに分ける (source.ts のサブクエリ方式と同じ制約への対処だが、
 * ここでの docIds はゴールデンセットの JSON ファイル由来の文字列リテラルであり、
 * D1 上の別テーブルからサブクエリで作れる母集団ではないため、チャンク分割で対処する)。
 */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** ゴールデンセットの各項目に必要な本文 (絞り込みの対象節) を D1+Notion から読む。 */
export async function fetchGoldenTexts(
  db: BiztagSourceDb,
  items: ReturnType<typeof loadGoldenSet>["items"]
): Promise<Map<string, Partial<Record<PrefilterSectionKey, string>>>> {
  const docIds = [...new Set(items.map((i) => i.docId))];
  const rows: Array<{ docId: string; notionDocPageId: string | null }> = [];
  for (const docIdBatch of chunk(docIds, 90)) {
    const batchRows = (await db
      .select({ docId: yuhoSchema.yuhoDocuments.docId, notionDocPageId: yuhoSchema.yuhoDocuments.notionDocPageId })
      .from(yuhoSchema.yuhoDocuments)
      .where(inArray(yuhoSchema.yuhoDocuments.docId, docIdBatch))) as Array<{
      docId: string;
      notionDocPageId: string | null;
    }>;
    rows.push(...batchRows);
  }
  const pageIdByDocId = new Map(rows.map((r) => [r.docId, r.notionDocPageId] as const));

  const map = new Map<string, Partial<Record<PrefilterSectionKey, string>>>();
  for (const item of items) {
    const key = goldenItemKey(item);
    if (map.has(key)) continue;
    const pageId = pageIdByDocId.get(item.docId);
    if (!pageId) throw new Error(`fetchGoldenTexts: ${item.docId} の本文ページが D1 にありません`);
    const sections = await readStockTextRow(pageId);
    const sectionMap: Partial<Record<PrefilterSectionKey, string>> = {};
    for (const s of sections) {
      if (isPrefilterSection(s.sectionKey)) sectionMap[s.sectionKey] = s.text;
    }
    map.set(key, sectionMap);
  }
  return map;
}

export function makeEvaluateGoldenForVocab(
  db: BiztagSourceDb,
  jevClient: JevClient,
  thresholds: BtThresholds
): (vocab: Vocabulary) => Promise<GoldenMetrics> {
  // 関門は今の版と提案の版をこの関数で続けて測る。jev はしきい値付近で回答が
  // 揺れるので、入力 (抜粋・質問) が同じ問いは 1 回の関門の中で同じ回答を使い、
  // 比較の差を提案で入力が変わった項目だけに限る (memo.ts 参照)。
  const memoClient = createMemoizedJevClient(jevClient);
  return async (vocab: Vocabulary): Promise<GoldenMetrics> => {
    const goldenSet = loadGoldenSet();
    const texts = await fetchGoldenTexts(db, goldenSet.items);
    const evaluation = await evaluateGolden(goldenSet, vocab, texts, memoClient, thresholds);
    return {
      precisionYes: evaluation.precisionYes,
      recallYes: evaluation.recallYes,
      mustHitRecall: evaluation.mustHitRecall,
      mustNotViolations: evaluation.mustNotViolations,
      filterMissRate: evaluation.filterMissRate,
    };
  };
}

/**
 * dry-run 用の no-op 台帳書込。期限検査・見直し材料の比較は行い、
 * 通知の記録・見直し材料の差し替えを止める。
 */
function makeDryRunLedgerWrites(): {
  createLedgerEntry: typeof createLedgerEntry;
  updateLedgerEntry: typeof updateLedgerEntry;
  replaceLedgerJson: typeof replaceLedgerJson;
} {
  const dryRunCreateLedgerEntry: typeof createLedgerEntry = async (_dbId, e): Promise<LedgerEntry> => ({
    pageId: "dry-run",
    name: e.name,
    kind: e.kind,
    state: e.state,
    version: e.version,
    hash: "dry-run",
    recordedAt: e.recordedAt,
    reason: e.reason,
    diff: e.diff,
    rollbackFrom: e.rollbackFrom,
  });
  const dryRunUpdateLedgerEntry: typeof updateLedgerEntry = async () => {};
  const dryRunReplaceLedgerJson: typeof replaceLedgerJson = async (entry) => entry;
  return {
    createLedgerEntry: dryRunCreateLedgerEntry,
    updateLedgerEntry: dryRunUpdateLedgerEntry,
    replaceLedgerJson: dryRunReplaceLedgerJson,
  };
}

export async function runBiztag(opts: RunBiztagOptions): Promise<RunSummary> {
  if (opts.model !== SEMIF_MODEL) throw new Error("新規銘柄の判定モデルがSemIf較正対象と一致しません");
  const listingFrom = yuhoEnv.BIZTAG_NEW_LISTING_FROM();
  const start = Date.now();
  const startedAt = new Date(start).toISOString();
  resetNotionStats();

  const today = todayJst(() => start);
  const db = createD1HttpDb(yuhoSchema) as unknown as BiztagSourceDb;
  const newStockEligibility = await loadNewStockEligibility(db, listingFrom, today);
  let initialClient: SemifClient | null = null;
  // 新規の実資格と本文候補が揃うまでPythonを起動しない。既存機械経路からは呼ばない。
  const jevClient: JevClient = { askNoul: async (state, questions) => {
    if (initialClient === null) initialClient = createSemifClient();
    return initialClient.askNoul(state, questions);
  } };
  try {
  // dry-run は通知・見直し材料の台帳書込を no-op にする。
  const ledgerWrites = opts.dryRun
    ? makeDryRunLedgerWrites()
    : { createLedgerEntry, updateLedgerEntry, replaceLedgerJson };

  // 1. 今の有効な単語帳 (台帳が空なら v1 を初回投入) を解決する。
  const ledgerDbId = await ensureLedgerDb();
  const initial = await resolveActiveVocabulary(today, { dryRun: opts.dryRun });
  const seeded = initial.seeded;
  const vocab = initial.vocab;

  // 2. 有料の語彙審査・golden評価は再開しない。現在の有効版と期限だけ読む。
  const gate = null;
  const allLedgerEntries = await listLedgerEntries(ledgerDbId);
  const deadline = checkDeadline(today, allLedgerEntries);
  if (deadline.shouldNotify) {
    await ledgerWrites.createLedgerEntry(ledgerDbId, {
      name: `通知 ${deadline.year} 期限切れ`,
      kind: "通知",
      state: "送信済",
      version: null,
      reason: `見直し期限 (${deadline.deadline}) までに提案が届きませんでした`,
      diff: "",
      rollbackFrom: null,
      json: { year: deadline.year, deadline: deadline.deadline },
      recordedAt: today,
    });
  }

  // 3. D1 の最新有報 (対象母集団)。
  let latest = await loadLatestDocs(db);
  if (opts.codes && opts.codes.length > 0) {
    const codeSet = new Set(opts.codes);
    latest = latest.filter((l) => codeSet.has(l.stockCode));
  }
  const sector33Options = [...new Set(latest.map((l) => l.sector33).filter((s): s is string => s !== null))];

  // 4. 補足 DB を確保し、既存行を読む。
  const { dbId: supplementDbId, propertyIds } = await ensureSupplementDb(buildSchemaSpec(vocab, sector33Options));
  // 銘柄コードで保存済みタグを参照する。判定済みの有報・語彙変更では本文を再取得しない。
  const rows = await loadSupplementRows(supplementDbId, propertyIds);
  const items = planWork(latest, rows, today, newStockEligibility);
  const retryExhausted = items.filter((i) => i.retryExhausted === true).map((i) => i.stockCode).sort();
  // 課金切れの未解決ブロッカーを台帳エラーから集計する。再試行期日の
  // 未来・到来・上限到達を問わない (skip も残件であり、完了ではない)。
  const billingBlocked = new Set(rows
    .filter((r) => r.tagStatus === "判定不能" && isBillingBlockedError(r.error))
    .map((r) => r.stockCode)
  );
  const qualificationHeld = items.filter((item) => item.qualificationHeld).map((item) => item.stockCode).sort();

  // 6. 銘柄マスタ (relation 先) の索引。
  // ① 側で同じ銘柄コードが複数行ある銘柄は relation を空のままにする (どれかを選ばない)。
  const masterIndex = await loadStockMasterIndex();
  const masterDuplicates = [...masterIndex.duplicates.keys()].sort();
  if (masterDuplicates.length > 0) {
    console.warn(
      `[biztag] ① 銘柄マスタに同じ銘柄コードの行が複数あるため relation を付けない: ${masterDuplicates.join(", ")}`
    );
  }

  const realDeps: ProcessDeps = {
    vocab,
    thresholds: opts.thresholds,
    jevClient,
    today,
    resolveMasterPageId: (code) => masterIndex.index.get(code) ?? null,
    readStockTextRow,
    createSupplementRow: (input, evidence) => createSupplementRow(supplementDbId, input, evidence),
    updateSupplementRow,
    replaceEvidenceBlock,
  };
  const deps: ProcessDeps = opts.dryRun
    ? {
        ...realDeps,
        createSupplementRow: async () => "dry-run",
        updateSupplementRow: async () => {},
        replaceEvidenceBlock: async () => {},
      }
    : realDeps;

  const countsByKind: Record<string, number> = {};
  const countsByTagStatus: Record<string, number> = {};
  const failures: Array<{ stockCode: string; message: string }> = [];
  let processed = 0;
  let judged = 0;
  let jevCalls = 0;
  let jevInputTokens = 0;
  let jevOutputTokens = 0;
  let workBudgetLeft = opts.limit ?? Infinity;

  for (let i = 0; i < items.length; i++) {
    const item: WorkItem = items[i];
    if (item.kind !== "skip") {
      if (workBudgetLeft <= 0 || Date.now() - start > opts.budgetMs) {
        break;
      }
      workBudgetLeft--;
    }
    if (opts.dryRun && item.initialSemif) {
      // 新規初回は下見で推論しない。機械判定へも切り替えず保留を明示。
      qualificationHeld.push(item.stockCode);
      countsByKind["initial_judge_dry_run_hold"] = (countsByKind["initial_judge_dry_run_hold"] ?? 0) + 1;
      processed++;
      continue;
    }
    try {
      const outcome = await processStock(item, deps);
      if (outcome.error) {
        failures.push({ stockCode: item.stockCode, message: outcome.error });
        if (isBillingBlockedError(outcome.error)) billingBlocked.add(item.stockCode);
      } else if (outcome.tagStatus === "判定済" && !opts.dryRun) {
        billingBlocked.delete(item.stockCode);
      }
      processed++;
      countsByKind[outcome.kind] = (countsByKind[outcome.kind] ?? 0) + 1;
      if (outcome.tagStatus) {
        countsByTagStatus[outcome.tagStatus] = (countsByTagStatus[outcome.tagStatus] ?? 0) + 1;
        if (outcome.tagStatus === "判定済" && !item.qualificationHeld) judged++;
      }
      jevCalls += outcome.jevCalls;
      jevInputTokens += outcome.jevInputTokens;
      jevOutputTokens += outcome.jevOutputTokens;
    } catch (e) {
      failures.push({ stockCode: item.stockCode, message: e instanceof Error ? e.message : String(e) });
    }
  }

  // 7. 見直し材料 (review packet) を台帳へ反映 (内容が変わったときだけ)。
  const packet = buildReviewPacket(rows, vocab, new Date(start).toISOString());
  await refreshReviewPacketLedger({
    dbId: ledgerDbId,
    packet,
    listLedgerEntries,
    readLedgerJson,
    createLedgerEntry: ledgerWrites.createLedgerEntry,
    replaceLedgerJson: ledgerWrites.replaceLedgerJson,
  });

  const elapsedMs = Date.now() - start;
  return {
    startedAt,
    elapsedMs,
    budgetMs: opts.budgetMs,
    dryRun: opts.dryRun ?? false,
    totalStocks: items.length,
    processed,
    remaining: items.length - processed,
    countsByKind,
    countsByTagStatus,
    coverage: { judged, total: items.length, ratio: items.length === 0 ? 0 : judged / items.length },
    jev: { calls: jevCalls, inputTokens: jevInputTokens, outputTokens: jevOutputTokens, estimatedCostUsd: 0 },
    judge: { provider: "semif", model: opts.model, calls: jevCalls, costMetering: "not_metered_local", externalApiCalls: 0, tokens: null, hardwareCostUsd: null },
    notion: notionStats(),
    vocabVersion: vocab.version,
    vocabSeeded: seeded,
    masterDuplicates,
    retryExhausted,
    billingBlocked: [...billingBlocked].sort(),
    qualificationHeld,
    gate,
    gateSkippedReason: "語彙審査・精度測定のTypeSafeは停止中",
    deadline,
    failures,
  };
  } finally {
    // MLXの常駐モデルは1runで共有し、途中のNotion失敗でも解放する。
    (initialClient as SemifClient | null)?.close();
  }
}

export interface RunNotifyResult {
  notify: boolean;
  title?: string;
  summary?: string;
}

/**
 * 実行サマリから運営向け GitHub Issue 通知 (docs §11.6) を組み立てる (純粋関数)。
 *
 * §11.6 が約束する通知条件は 3 つ: (1) 関門で提案が不採用、(2) 見直しの期限切れ、
 * (3) 再試行上限に達したまま残っている銘柄がある。この3つのうちどれかが
 * 該当すれば notify:true とし、優先順位 (1) > (2) > (3) で「主要因」の
 * title/summary を使う。個別銘柄の失敗 (`summary.failures`) と ① 銘柄マスタの
 * 重複 (`summary.masterDuplicates`) は §11.6 の独立した通知条件ではないが、
 * 見落とすと運営が気づけない情報 (実行サマリ中の JSON にしか残らない) なので、
 * 上の3条件のどれかで通知が上がる/失敗単独でも通知が要る場合はどちらも
 * 必ず summary に書き足す (findings: 旧実装は gate/deadline が両方 null だと
 * failures の一覧ごと notify:false にして落としていた)。
 */
export function composeRunNotify(summary: RunSummary): RunNotifyResult {
  const notes: string[] = [];
  if (summary.qualificationHeld && summary.qualificationHeld.length > 0) {
    notes.push(`新規銘柄の資格または本文を確認できず保留: ${summary.qualificationHeld.length}件 (${summary.qualificationHeld.slice(0, 10).join(", ")})`);
  }
  if (summary.failures.length > 0) {
    notes.push(
      `失敗した銘柄 (最大10件): ${summary.failures
        .slice(0, 10)
        .map((f) => `${f.stockCode}: ${f.message}`)
        .join(" / ")}`
    );
  }
  if (summary.retryExhausted.length > 0) {
    notes.push(
      `再試行上限 (${MAX_RETRY_ATTEMPTS}回) に達したまま残っている銘柄: ${summary.retryExhausted.length}件 (${summary.retryExhausted
        .slice(0, 10)
        .join(", ")}${summary.retryExhausted.length > 10 ? " 他" : ""})`
    );
  }
  if (summary.masterDuplicates.length > 0) {
    notes.push(
      `① 銘柄マスタ重複 (relation 未設定): ${summary.masterDuplicates.length}件 (${summary.masterDuplicates
        .slice(0, 10)
        .join(", ")}${summary.masterDuplicates.length > 10 ? " 他" : ""})`
    );
  }
  if (summary.billingBlocked.length > 0) {
    notes.push(
      `課金切れ (jev 402/billing_error) で判定不能のまま残っている銘柄: ${summary.billingBlocked.length}件 (${summary.billingBlocked
        .slice(0, 10)
        .join(", ")}${summary.billingBlocked.length > 10 ? " 他" : ""})`
    );
  }
  const extraNote = notes.length > 0 ? `\n${notes.join("\n")}` : "";

  const deadlineNotify = summary.deadline.shouldNotify
    ? {
        title: "[biztag] 単語帳の見直しが期限切れです",
        summary: `期限 (${summary.deadline.deadline}) までに提案が届きませんでした`,
      }
    : null;
  const retryExhaustedNotify =
    summary.retryExhausted.length > 0
      ? {
          title: "[biztag] 再試行上限に達したまま残っている銘柄があります",
          summary: `再試行上限 (${MAX_RETRY_ATTEMPTS}回) に達した銘柄が ${summary.retryExhausted.length} 件あります (詳細は下記)。`,
        }
      : null;
  // 上の3条件のいずれにも該当しないが、失敗銘柄や① 銘柄マスタ重複だけは
  // ある場合も、運営が気づける経路を残す (fallback)。
  const fallbackNotify =
    notes.length > 0
      ? {
          title: "[biztag] 実行結果に確認が必要な項目があります",
          summary: "実行サマリに運営が確認すべき項目があります (詳細は下記)。",
        }
      : null;

  const primary = summary.gate?.notify ?? deadlineNotify ?? retryExhaustedNotify ?? fallbackNotify;
  if (!primary) return { notify: false };
  return { notify: true, title: primary.title, summary: `${primary.summary}${extraNote}` };
}
