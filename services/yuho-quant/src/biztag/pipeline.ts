/**
 * 実行オーケストレーション (`pnpm biztag run`)。
 * 設計: docs/005-yuho-quant-business-tags.md §2・§7・§9・§11.2。
 *
 * 1) 単語帳の関門 (未審査提案があれば審査)・見直し期限の検査
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
  type SupplementRow,
  type SupplementSchemaSpec,
} from "../../../../src/shared/notion-archive/index.js";
import { createJevClient, estimateCostUsd, jevEnv, type JevClient } from "../../../../src/shared/jev/index.js";
import { createMemoizedJevClient } from "../../../../src/shared/jev/memo.js";
import * as yuhoSchema from "../db/schema.js";
import { resolveActiveVocabulary } from "./active-vocab.js";
import { todayJst } from "./date-jst.js";
import { checkDeadline, runGate, type DeadlineCheckResult, type GateRunResult } from "./gate.js";
import { evaluateGolden, goldenItemKey, loadGoldenSet, type GoldenMetrics } from "./golden.js";
import type { BtThresholds } from "./judge.js";
import { MAX_RETRY_ATTEMPTS, planWork, type WorkItem } from "./plan.js";
import { processStock, type ProcessDeps } from "./process.js";
import { PREFILTER_SECTIONS, PREFILTER_SECTION_TITLE, isPrefilterSection, type PrefilterSectionKey } from "./prefilter.js";
import { buildReviewPacket, refreshReviewPacketLedger } from "./review.js";
import { DEFAULT_VERIFY_SOURCES_BUDGET_MS, makeBudgetedVerifySources } from "./sources-verify.js";
import { loadLatestDocs, type BiztagSourceDb } from "./source.js";
import { diffVocabularies } from "./vocabulary/diff.js";
import { parseVocabulary } from "./vocabulary/load.js";
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
   * スコープは「銘柄マスタ（補足）」の行・根拠だけでなく、単語帳の関門
   * (`runGate` による版の確定・提案の状態更新)・見直し材料・見直し期限の
   * 通知など**台帳への書込も含む** (判定・審査そのものは実データで行うため
   * jev 呼び出し・出典検査は dry-run でも実際に発生する。DB 確保・単語帳解決も行う)。
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
  notion: NotionStats;
  vocabVersion: string;
  vocabSeeded: boolean;
  gate: GateRunResult;
  deadline: DeadlineCheckResult;
  failures: Array<{ stockCode: string; message: string }>;
  /** ① 銘柄マスタに同じ銘柄コードの行が複数あり、relation を付けなかった銘柄コード */
  masterDuplicates: string[];
  /** 再試行上限 (`MAX_RETRY_ATTEMPTS`) に到達したまま残っている銘柄コード (docs §11.6) */
  retryExhausted: string[];
}

function buildSchemaSpec(vocab: Vocabulary, sector33Options: string[]): SupplementSchemaSpec {
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
 * 補足行の `vocabVersion` (現在の版と異なるものだけ) から `VocabDiff` を
 * 引けるようにする。台帳の「版」履歴を読んで解決する (I/O はここでまとめて
 * 行い、`plan.ts` へは同期関数として渡す)。
 */
async function buildVocabDiffResolver(
  ledgerDbId: string,
  neededVersions: Set<string>,
  current: Vocabulary
): Promise<(rowVersion: string) => import("./vocabulary/diff.js").VocabDiff> {
  const map = new Map<string, import("./vocabulary/diff.js").VocabDiff>();
  if (neededVersions.size > 0) {
    const versionEntries = await listLedgerEntries(ledgerDbId, { kind: "版" });
    for (const version of neededVersions) {
      const entry = versionEntries.find((e) => e.version === version);
      if (!entry) {
        throw new Error(`buildVocabDiffResolver: 台帳に版 ${version} の記録がありません`);
      }
      const oldVocab = parseVocabulary(await readLedgerJson(entry));
      map.set(version, diffVocabularies(oldVocab, current));
    }
  }
  return (rowVersion: string) => {
    const diff = map.get(rowVersion);
    if (!diff) throw new Error(`vocabDiffFromRowVersion: 未解決の版です: ${rowVersion}`);
    return diff;
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
 * dry-run 用の no-op 台帳書込。`runGate`・見直し期限の通知・
 * `refreshReviewPacketLedger` は、実データでの判定・比較 (jev 呼び出し・
 * 出典検査・見直し材料の内容比較) はそのまま行うが、Notion 台帳への実書込
 * (版の確定・提案の状態更新・通知の記録・見直し材料の差し替え) だけを
 * 差し替えて無効化する (dryRun のスコープを ProcessDeps だけに閉じない)。
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
  const start = Date.now();
  const startedAt = new Date(start).toISOString();
  resetNotionStats();

  const today = todayJst(() => start);
  const db = createD1HttpDb(yuhoSchema) as unknown as BiztagSourceDb;
  const jevClient = createJevClient({ apiKey: jevEnv.TYPESAFE_API_KEY(), model: opts.model });
  const evaluateGoldenForVocab = makeEvaluateGoldenForVocab(db, jevClient, opts.thresholds);
  // dry-run はここから先の台帳書込 (版の確定・提案の状態更新・通知・見直し材料の
  // 差し替え) を全て no-op にする (判定・審査自体は実データで行う)。
  const ledgerWrites = opts.dryRun
    ? makeDryRunLedgerWrites()
    : { createLedgerEntry, updateLedgerEntry, replaceLedgerJson };

  // 1. 今の有効な単語帳 (台帳が空なら v1 を初回投入)。関門は有効な版を基準に審査する
  //    ので、先に解決しておく。
  const ledgerDbId = await ensureLedgerDb();
  const initial = await resolveActiveVocabulary(today, { dryRun: opts.dryRun });
  const seeded = initial.seeded;
  let vocab = initial.vocab;

  // 2. 単語帳の関門 + 見直し期限の検査。
  // 出典検査 (verifySources) は提案内の URL を実際に fetch するため、
  // opts.budgetMs から一部を専用予算として切り出す (opts.budgetMs をそのまま
  // 使うと、後続の銘柄処理ループの予算が丸ごと出典検査に消費されうる)。
  // 予算を使い切っても、審査自体 (runGate) は打ち切らず「その提案を
  // 不採用にする」形で正直に終わらせる (sources-verify.ts 参照)。
  const verifySourcesBudgetMs = Math.min(DEFAULT_VERIFY_SOURCES_BUDGET_MS, opts.budgetMs);
  const gate = await runGate({
    ledgerDbId,
    listLedgerEntries,
    readLedgerJson,
    createLedgerEntry: ledgerWrites.createLedgerEntry,
    updateLedgerEntry: ledgerWrites.updateLedgerEntry,
    verifySources: makeBudgetedVerifySources(verifySourcesBudgetMs),
    evaluateGoldenForVocab,
    recordedAt: today,
  });
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

  // 関門が新しい版を採用したら、その版で以降を処理する (dry-run は採用を書かないので不要)。
  if (gate.adopted.length > 0 && !opts.dryRun) {
    ({ vocab } = await resolveActiveVocabulary(today));
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
  // 本文列は重い (1 行平均数万字) ので、版の影響判定が要る行 (= 版が違う判定済の
  // 行) だけ本文列つきで読み直す。普段の日次はほぼ全行が「同じ版」で状態の列
  // だけ読めば足りるが、版を上げた直後は「版が違う判定済」の行が数千件残る
  // 移行期間 (§7 の日次予算では数日〜数週間かかる) が続くため、その間**毎日**
  // 全行ぶんの本文列を読み直すと (`loadSupplementRows` の全件取得コストが
  // 版の影響判定を受ける行の数に関わらず一定になり) 20分の日次予算を圧迫する。
  // ここでは実際に影響判定が必要な行 (stale) の銘柄コードだけを絞って本文列を
  // 読み直し、残りは状態の列だけの行のまま使う (`loadSupplementRows` の
  // `codes` フィルタを利用)。
  let rows = await loadSupplementRows(supplementDbId, propertyIds);
  const staleCodes = rows
    .filter((r) => r.tagStatus === "判定済" && r.vocabVersion !== null && r.vocabVersion !== vocab.version)
    .map((r) => r.stockCode);
  if (staleCodes.length > 0) {
    const textColumns = PREFILTER_SECTIONS.map((k) => PREFILTER_SECTION_TITLE[k]);
    const staleRowsByCode = new Map<string, SupplementRow>();
    // Notion の compound filter (`codes` は or フィルタに展開される) は
    // 1 クエリあたりの条件数に上限があるため、安全側でチャンクに分けて
    // 問い合わせる (`loadSupplementRows` 自身は codes を分割しない)。
    for (const codeBatch of chunk(staleCodes, 90)) {
      const staleRows = await loadSupplementRows(supplementDbId, propertyIds, {
        codes: codeBatch,
        textColumns,
      });
      for (const r of staleRows) staleRowsByCode.set(r.stockCode, r);
    }
    rows = rows.map((r) => staleRowsByCode.get(r.stockCode) ?? r);
  }

  // 5. 版の違いの影響判定に必要な過去の単語帳を解決する。
  const neededVersions = new Set(
    rows.map((r) => r.vocabVersion).filter((v): v is string => v !== null && v !== vocab.version)
  );
  const vocabDiffFromRowVersion = await buildVocabDiffResolver(ledgerDbId, neededVersions, vocab);

  const items = planWork(latest, rows, vocab, vocabDiffFromRowVersion, today);
  const retryExhausted = items.filter((i) => i.retryExhausted === true).map((i) => i.stockCode).sort();

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
    try {
      const outcome = await processStock(item, deps);
      processed++;
      countsByKind[outcome.kind] = (countsByKind[outcome.kind] ?? 0) + 1;
      if (outcome.tagStatus) {
        countsByTagStatus[outcome.tagStatus] = (countsByTagStatus[outcome.tagStatus] ?? 0) + 1;
        if (outcome.tagStatus === "判定済") judged++;
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
    jev: { calls: jevCalls, inputTokens: jevInputTokens, outputTokens: jevOutputTokens, estimatedCostUsd: estimateCostUsd(jevInputTokens) },
    notion: notionStats(),
    vocabVersion: vocab.version,
    vocabSeeded: seeded,
    masterDuplicates,
    retryExhausted,
    gate,
    deadline,
    failures,
  };
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

  const primary = summary.gate.notify ?? deadlineNotify ?? retryExhaustedNotify ?? fallbackNotify;
  if (!primary) return { notify: false };
  return { notify: true, title: primary.title, summary: `${primary.summary}${extraNote}` };
}
