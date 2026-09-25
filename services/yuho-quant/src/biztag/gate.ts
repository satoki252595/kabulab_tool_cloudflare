/**
 * 単語帳の見直し提案の自動審査 (関門)・見直し期限の検査。
 * 設計: docs/005-yuho-quant-business-tags.md §6.3。
 *
 * AI の自己評価には頼らない。全部コード + jev (ゴールデンセット再評価) で
 * 4 つの関門 (形・出典・ゴールデン再評価・変更量) を順に検査し、1 つでも
 * 落ちたら不採用にする。全部通れば自動で新しい版にする (運営決定 2026-09-25)。
 */
import {
  type LedgerEntry,
  type LedgerKind,
  type LedgerState,
} from "../../../../src/shared/notion-archive/index.js";
import { addDaysJst } from "./date-jst.js";
import type { GoldenMetrics } from "./golden.js";
import type { SourceCheckIssue } from "./sources-verify.js";
import { changeStats, diffVocabularies, type VocabDiff } from "./vocabulary/diff.js";
import { parseVocabulary } from "./vocabulary/load.js";
import { applyProposal, ProposalSchema, type Proposal } from "./vocabulary/proposal.js";
import type { Vocabulary } from "./vocabulary/schema.js";
import { validateVocabulary } from "./vocabulary/validate.js";

/** 変更量の上限 (設計 §6.3-4: 変わる語は有効な語の 2 割まで)。 */
export const MAX_CHANGED_RATIO = 0.2;
/** 系統ごとの廃止量の上限 (設計 §6.3-4: 1 系統の廃止は全体の 1 割まで)。 */
export const MAX_DEPRECATED_RATIO_PER_FAMILY = 0.1;
/** ゴールデン再評価の精度下限 (設計 §6.3-3)。 */
export const MIN_PRECISION_YES = 0.9;

/** 指標の表示用フォーマット (null は「測定不可」と正直に書く。0 で埋めない — ルール2)。 */
function fmtMetric(v: number | null): string {
  return v === null ? "測定不可" : String(v);
}

function nextVersionOf(version: string): string {
  const m = /^v([1-9][0-9]*)$/.exec(version);
  if (!m) throw new Error(`evaluateProposal: 版名の形式が不正です: ${version}`);
  return `v${Number(m[1]) + 1}`;
}

export interface GateChecks {
  verifySources: (proposal: Proposal) => Promise<SourceCheckIssue[]>;
  evaluateGoldenForVocab: (vocab: Vocabulary) => Promise<GoldenMetrics>;
}

export interface GateDecision {
  decision: "adopted" | "rejected" | "no_change";
  reason: string;
  newVocab?: Vocabulary;
  diff?: VocabDiff;
}

/**
 * 提案 1 件を評価する (判定ロジック本体。I/O は `checks` 経由で注入)。
 *
 * `noChange:true` の提案は形の検査だけで足りる (変更が無いので出典・ゴールデン・
 * 変更量の検査対象が無い)。`getBaseline` は今の版のゴールデン評価を遅延計算する
 * 関数で、実際に基準との比較が必要になるまで (= 提案自身の精度が基準を満たす
 * ことを確認できるまで) 呼ばない。noChange の提案・出典検査で落ちる提案・
 * 提案自身の精度が最低基準を満たさない提案では一度も呼ばれない
 * (無駄な jev 呼び出し = ゴールデン再評価を避ける)。
 */
export async function evaluateProposal(
  current: Vocabulary,
  getBaseline: () => Promise<GoldenMetrics>,
  proposal: Proposal,
  checks: GateChecks
): Promise<GateDecision> {
  if (proposal.noChange) {
    // `理由` 列は「関門の判定理由（コードが作る文。提案者の作文は入れない）」
    // という契約 (docs §3.2 の表)。提出者の申告理由をそのまま `理由` に
    // 入れてしまうとこの契約に反するため、コードが組み立てた文の中に
    // 引用として埋め込む(提案者の作文をそのまま判定理由の顔で残さない)。
    // `reason` は ProposalSchema の refine で noChange:true のとき必須と
    // 検査済みのはずなので、無ければ検査漏れとして throw する (フォールバック
    // で埋めない — ルール2)。
    if (proposal.reason === undefined) {
      throw new Error(
        "evaluateProposal: noChange:true の提案に reason がありません (ProposalSchema の refine 漏れ)"
      );
    }
    return { decision: "no_change", reason: `変更なしとして受理 (提出者の申告理由: ${proposal.reason})` };
  }

  // 1. 形: 基にした版 = 今の有効な版であり (`applyProposal` 内で検査)、
  //    変更を当てた単語帳が `validateVocabulary` を通ること。
  let newVocab: Vocabulary;
  try {
    newVocab = applyProposal(current, proposal, nextVersionOf(current.version));
  } catch (e) {
    return { decision: "rejected", reason: `形の検査に失敗 (適用不能): ${(e as Error).message}` };
  }
  const issues = validateVocabulary(newVocab);
  if (issues.length > 0) {
    return {
      decision: "rejected",
      reason: `形の検査に失敗 (${issues.length}件): ${issues.map((i) => i.message).join(" / ")}`,
    };
  }

  // 2. 出典: 変更ごと・語ごとの URL が取得でき、引用が本文に実在する。
  const sourceIssues = await checks.verifySources(proposal);
  if (sourceIssues.length > 0) {
    return {
      decision: "rejected",
      reason: `出典の検査に失敗 (${sourceIssues.length}件): ${sourceIssues.map((i) => i.message).join(" / ")}`,
    };
  }

  // 3. jev でゴールデンセットを再評価: 「はい」の精度が測れて ≥ 0.9・今の版から
  //    下がらない・当てたい例の再現率が下がらない・外したい例の誤検出が増えない・
  //    絞り込みの取りこぼしが増えない。
  const golden = await checks.evaluateGoldenForVocab(newVocab);
  if (golden.precisionYes === null) {
    return {
      decision: "rejected",
      reason: "ゴールデンセットで「はい」判定が0件のため精度を測れませんでした",
    };
  }
  if (golden.precisionYes < MIN_PRECISION_YES) {
    return {
      decision: "rejected",
      reason: `ゴールデンセットの精度が基準 (${MIN_PRECISION_YES}) を下回りました: precisionYes=${golden.precisionYes}`,
    };
  }

  // ここまでの検査を通った提案だけ、実際に基準との比較のため今の版を再評価する。
  const baseline = await getBaseline();

  if (baseline.precisionYes !== null && golden.precisionYes < baseline.precisionYes) {
    return {
      decision: "rejected",
      reason: `ゴールデンセットの精度が今の版から下がりました: ${baseline.precisionYes} → ${golden.precisionYes}`,
    };
  }
  if (baseline.mustHitRecall !== null && (golden.mustHitRecall === null || golden.mustHitRecall < baseline.mustHitRecall)) {
    return {
      decision: "rejected",
      reason: `当てたい例の再現率が今の版から下がりました: ${fmtMetric(baseline.mustHitRecall)} → ${fmtMetric(golden.mustHitRecall)}`,
    };
  }
  if (golden.mustNotViolations > baseline.mustNotViolations) {
    return {
      decision: "rejected",
      reason: `外したい例の誤検出が今の版から増えました: ${baseline.mustNotViolations}件 → ${golden.mustNotViolations}件`,
    };
  }
  // filterMissRate: 期待trueが0件の版は null (比較対象なし)。基準が null (取りこぼし
  // 対象がそもそも無かった) のに提案側で取りこぼしが発生した (>0) 場合だけ、
  // 実質的な悪化として増加扱いにする。両方 null (どちらも比較材料が無い) は合格。
  if (golden.filterMissRate !== null) {
    const increased =
      baseline.filterMissRate === null
        ? golden.filterMissRate > 0
        : golden.filterMissRate > baseline.filterMissRate;
    if (increased) {
      return {
        decision: "rejected",
        reason: `絞り込みの取りこぼし率が今の版から増えました: ${fmtMetric(baseline.filterMissRate)} → ${golden.filterMissRate}`,
      };
    }
  }

  // 4. 変更量: 変わる語は有効な語の 2 割まで、1 系統の廃止は全体の 1 割まで。
  const diff = diffVocabularies(current, newVocab);
  const stats = changeStats(current, diff);
  if (stats.changedRatio > MAX_CHANGED_RATIO) {
    return {
      decision: "rejected",
      reason: `変更量が上限 (${MAX_CHANGED_RATIO * 100}%) を超えました: ${(stats.changedRatio * 100).toFixed(1)}%`,
    };
  }
  for (const [family, ratio] of Object.entries(stats.deprecatedRatioByFamily)) {
    if (ratio > MAX_DEPRECATED_RATIO_PER_FAMILY) {
      return {
        decision: "rejected",
        reason: `系統 ${family} の廃止量が上限 (${MAX_DEPRECATED_RATIO_PER_FAMILY * 100}%) を超えました: ${(ratio * 100).toFixed(1)}%`,
      };
    }
  }

  return {
    decision: "adopted",
    reason: "形式・出典・ゴールデン再評価・変更量の全ての関門を通過",
    newVocab,
    diff,
  };
}

// ── 見直し期限の検査 (§6.3 末尾) ──────────────────────────────────────────

/** 8月第1月曜 (YYYY-MM-DD)。設計例の「提案 2027-08-02」と一致する計算式。 */
export function firstMondayOfAugust(year: number): string {
  const aug1 = Date.UTC(year, 7, 1);
  const weekday = new Date(aug1).getUTCDay();
  const offsetDays = (8 - weekday) % 7;
  const d = new Date(aug1 + offsetDays * 24 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** 見直し提案の期限 = 8月第1月曜 + 7日。 */
export function reviewDeadline(year: number): string {
  return addDaysJst(firstMondayOfAugust(year), 7);
}

export interface DeadlineCheckResult {
  shouldNotify: boolean;
  year: number;
  deadline: string;
  /** その年は見直しの対象外だった理由 (仕組みの稼働前など)。対象年なら undefined */
  notApplicable?: string;
}

/**
 * 期限切れ検査。`todayJst` (YYYY-MM-DD) がその年の期限を過ぎていて、
 * 8/1 以降に記録された「提案」(状態は問わない。`変更なし` の提案も含む) が無く、
 * かつ今年分の「通知」がまだ無ければ通知が必要。
 */
export function checkDeadline(todayJst: string, entries: readonly LedgerEntry[]): DeadlineCheckResult {
  const year = Number(todayJst.slice(0, 4));
  const deadline = reviewDeadline(year);
  if (todayJst <= deadline) {
    return { shouldNotify: false, year, deadline };
  }
  // 仕組みが動き始めた (台帳に最初の「版」を記録した) のがその年の見直し開始日
  // (8 月第 1 月曜) より後なら、その年は Automation がまだ無かったので対象外。
  // 初年度 (2026-09 稼働) に「提案が来ていない」と誤って鳴らさないため。
  const firstVersionRecordedAt = entries
    .filter((e) => e.kind === "版")
    .map((e) => e.recordedAt)
    .sort()[0];
  if (firstVersionRecordedAt === undefined) {
    return { shouldNotify: false, year, deadline, notApplicable: "台帳に版がまだ無い (初回投入前)" };
  }
  if (firstVersionRecordedAt > firstMondayOfAugust(year)) {
    return {
      shouldNotify: false,
      year,
      deadline,
      notApplicable: `${year} 年の見直し開始日 (${firstMondayOfAugust(year)}) の後に稼働した (最初の版 ${firstVersionRecordedAt})`,
    };
  }
  const aug1 = `${year}-08-01`;
  const hasProposalSinceAug1 = entries.some(
    (e) => e.kind === "提案" && e.recordedAt >= aug1 && e.recordedAt <= todayJst
  );
  if (hasProposalSinceAug1) return { shouldNotify: false, year, deadline };
  const hasNotificationThisYear = entries.some(
    (e) => e.kind === "通知" && e.recordedAt.startsWith(String(year))
  );
  return { shouldNotify: !hasNotificationThisYear, year, deadline };
}

// ── I/O 込みのオーケストレーション ────────────────────────────────────────

export interface RunGateDeps extends GateChecks {
  ledgerDbId: string;
  listLedgerEntries: (
    dbId: string,
    filter?: { kind?: LedgerKind; state?: LedgerState }
  ) => Promise<LedgerEntry[]>;
  readLedgerJson: (entry: LedgerEntry) => Promise<unknown>;
  createLedgerEntry: (dbId: string, e: {
    name: string;
    kind: LedgerKind;
    state: LedgerState;
    version: string | null;
    reason: string;
    diff: string;
    rollbackFrom: string | null;
    json: unknown;
    recordedAt: string;
  }) => Promise<LedgerEntry>;
  updateLedgerEntry: (
    pageId: string,
    patch: { state?: LedgerState; reason?: string; diff?: string }
  ) => Promise<void>;
  /** 台帳に記録する日付 (JST, YYYY-MM-DD) */
  recordedAt: string;
}

export interface GateRunResult {
  reviewed: number;
  adopted: string[];
  rejected: string[];
  noChange: string[];
  /** 不採用が 1 件以上あった場合の運営向け通知内容。無ければ null。 */
  notify: { title: string; summary: string } | null;
}

/**
 * 未審査の提案を全て審査する (§6.3 の日次実行本体)。採用ごとに基準の版を
 * 更新し、以降の提案は新しい版を基準に評価する (複数提案の逐次適用)。
 */
export async function runGate(deps: RunGateDeps): Promise<GateRunResult> {
  const versions = await deps.listLedgerEntries(deps.ledgerDbId, { kind: "版" });
  const activeVersions = versions.filter((v) => v.state === "有効");
  if (activeVersions.length !== 1) {
    throw new Error(`runGate: 有効な単語帳の版が ${activeVersions.length} 件です`);
  }
  let currentEntry = activeVersions[0];

  const pending = await deps.listLedgerEntries(deps.ledgerDbId, { kind: "提案", state: "未審査" });
  if (pending.length === 0) {
    // ゴールデン再評価 (jev 呼び出し) は「実際に審査する提案がある」ときだけ行う
    // (運用コスト・初期セットアップ時に calibration/golden セット未整備でも
    // `run` の他ステップを止めないため)。
    return { reviewed: 0, adopted: [], rejected: [], noChange: [], notify: null };
  }

  let activeVocab = parseVocabulary(await deps.readLedgerJson(currentEntry));
  let baselineGolden: GoldenMetrics | null = null;
  // `evaluateProposal` へは関数そのもの (未呼び出し) を渡す。noChange の提案・
  // 出典検査で落ちる提案・精度が最低基準にすら届かない提案は、この関数を
  // 一度も呼ばないまま評価が終わる (無駄なゴールデン再評価 = jev 呼び出しを避ける)。
  const getBaseline = async (): Promise<GoldenMetrics> => {
    if (baselineGolden === null) baselineGolden = await deps.evaluateGoldenForVocab(activeVocab);
    return baselineGolden;
  };

  const adopted: string[] = [];
  const rejected: string[] = [];
  const noChangeIds: string[] = [];
  const rejectionReasons: string[] = [];

  for (const proposalEntry of pending) {
    const proposalJson = await deps.readLedgerJson(proposalEntry);
    const parsed = ProposalSchema.safeParse(proposalJson);
    if (!parsed.success) {
      const reason = `提案の形式が不正です: ${JSON.stringify(parsed.error.issues).slice(0, 1500)}`;
      await deps.updateLedgerEntry(proposalEntry.pageId, { state: "不採用", reason });
      rejected.push(proposalEntry.pageId);
      rejectionReasons.push(`${proposalEntry.name}: 形式不正`);
      continue;
    }

    const decision = await evaluateProposal(activeVocab, getBaseline, parsed.data, {
      verifySources: deps.verifySources,
      evaluateGoldenForVocab: deps.evaluateGoldenForVocab,
    });

    if (decision.decision === "no_change") {
      await deps.updateLedgerEntry(proposalEntry.pageId, { state: "変更なし", reason: decision.reason });
      noChangeIds.push(proposalEntry.pageId);
      continue;
    }
    if (decision.decision === "rejected") {
      await deps.updateLedgerEntry(proposalEntry.pageId, { state: "不採用", reason: decision.reason });
      rejected.push(proposalEntry.pageId);
      rejectionReasons.push(`${proposalEntry.name}: ${decision.reason}`);
      continue;
    }

    const newVocab = decision.newVocab as Vocabulary;
    const diff = decision.diff as VocabDiff;
    await deps.updateLedgerEntry(currentEntry.pageId, { state: "置換済" });
    const newEntry = await deps.createLedgerEntry(deps.ledgerDbId, {
      name: `版 ${newVocab.version}`,
      kind: "版",
      state: "有効",
      version: newVocab.version,
      reason: `提案 ${proposalEntry.name} を採用`,
      diff: diff.changedTermIds.join(", "),
      rollbackFrom: null,
      json: newVocab,
      recordedAt: deps.recordedAt,
    });
    await deps.updateLedgerEntry(proposalEntry.pageId, { state: "採用", reason: decision.reason });
    adopted.push(proposalEntry.pageId);

    currentEntry = newEntry;
    activeVocab = newVocab;
    baselineGolden = await deps.evaluateGoldenForVocab(activeVocab);
  }

  const notify =
    rejected.length > 0
      ? {
          title: "[biztag] 単語帳の見直し提案が関門で不採用になりました",
          summary: rejectionReasons.join("\n"),
        }
      : null;

  return { reviewed: pending.length, adopted, rejected, noChange: noChangeIds, notify };
}
