/**
 * クラウド LLM が返した要約結果の検証と、D1 への書き込み計画。
 *
 * **LLM の出力は信用しない。** 外部エージェントが作業仕様書
 * (`services/otakara-yutai/docs/llm-summary-task.md`) を守った保証は無いので、
 * 結果 1 行ごとに次を検査し、通った行だけを書き込み対象にする:
 *   - JSON / スキーマ (余計なキーも不可。掲載文を書き戻されても取り込まない)
 *   - taskId の重複 (同じタスクへの 2 回答はどちらを採るか決められないので両方はじく)
 *   - 発行したタスクか (unknown_task)
 *   - 契約の版が今のコードと一致するか (contract_version)
 *   - タスク発行後に掲載文が変わっていないか = 今の D1 にその内容キーがあるか (stale)
 *   - 要約契約 `checkSummary` (contract) / 掲載文の長い逐語コピー (verbatim)
 *   - 推定金額の決定論ガード `sanitizeEstimatedValue` (value_guard)
 *
 * 書き込み先の行 ID はタスクファイルではなく**今の D1 から内容キーで引き直す**。
 * `fetch-yutai-full.ts` は再取得のたびに全行を作り直して ID を振り直すため、
 * タスク発行時の ID を信じると別銘柄の行へ書く (旧 idx 結合で実際に起きた破損)。
 *
 * 採らなかった案:
 * - 金額ガードに掛かった行も要約だけ書き、金額を null にする: 旧ローカル経路は
 *   そうしていたが、ガードに掛かるのは「割引を金額にした」「桁を取り違えた」
 *   出力で、同じ回答の要約側も誤読している疑いが強い。行ごとはじいて再依頼する。
 * - 違反を自動で切り詰めて書く: ルール2 (黙って直さない) に反するので採らない。
 */
import { z } from "zod";
import { benefitKey } from "./benefit-key.js";
import { sanitizeEstimatedValue } from "./estimated-value-guard.js";
import {
  SUMMARY_CONTRACT_VERSION,
  checkSummary,
  formatViolations,
  isVerbatimCopy,
  normalizeSummary,
} from "./summary-contract.js";
import type { BenefitRow, SummaryTask } from "./summary-tasks.js";

/** 結果ファイル 1 行。外部エージェントの出力。 */
export const SummaryResult = z
  .object({
    taskId: z.string(),
    contractVersion: z.string(),
    shortSummary: z.string(),
    /** 優待 1 単位あたりの推定金額 (円・正の整数)。推定しないなら null。 */
    estimatedValue: z.number().int().positive().nullable(),
  })
  .strict();
export type SummaryResult = z.infer<typeof SummaryResult>;

export type RejectReason =
  | "parse"
  | "schema"
  | "duplicate"
  | "unknown_task"
  | "contract_version"
  | "stale"
  | "contract"
  | "verbatim"
  | "value_guard";

export type Rejection = {
  /** 結果ファイルの行番号 (1 始まり)。 */
  line: number;
  taskId: string | null;
  reason: RejectReason;
  detail: string;
};

export type PlannedUpdate = {
  taskId: string;
  /** 今の D1 で内容キーが一致する行 ID。 */
  ids: number[];
  shortSummary: string;
  estimatedValue: number | null;
  estimateValueSource: "company" | null;
  estimateSourceUrl: null;
};

export type ImportPlan = {
  updates: PlannedUpdate[];
  rejections: Rejection[];
  /** 結果に 1 行も現れなかったタスク (未回答)。 */
  unansweredTaskIds: string[];
};

/** 結果ファイルとタスク・現行行を突き合わせ、書き込み計画を作る (副作用なし)。 */
export function planSummaryImport(input: {
  tasks: readonly SummaryTask[];
  resultsText: string;
  currentRows: readonly BenefitRow[];
}): ImportPlan {
  const taskById = new Map(input.tasks.map((t) => [t.taskId, t]));
  const current = new Map<string, { ids: number[]; description: string }>();
  for (const r of input.currentRows) {
    const key = benefitKey(r.stockCode, r.description);
    const e = current.get(key);
    if (e) e.ids.push(r.id);
    else current.set(key, { ids: [r.id], description: r.description });
  }

  const rejections: Rejection[] = [];
  const parsed: { line: number; result: SummaryResult }[] = [];
  input.resultsText.split("\n").forEach((text, i) => {
    const line = i + 1;
    if (text.trim() === "") return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      rejections.push({ line, taskId: null, reason: "parse", detail: (e as Error).message.slice(0, 120) });
      return;
    }
    const r = SummaryResult.safeParse(raw);
    if (!r.success) {
      const taskId =
        raw && typeof raw === "object" && typeof (raw as { taskId?: unknown }).taskId === "string"
          ? (raw as { taskId: string }).taskId
          : null;
      rejections.push({
        line,
        taskId,
        reason: "schema",
        detail: r.error.issues.map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`).join(" / ").slice(0, 200),
      });
      return;
    }
    parsed.push({ line, result: r.data });
  });

  const answered = new Set<string>();
  const countById = new Map<string, number>();
  for (const { result } of parsed) {
    answered.add(result.taskId);
    countById.set(result.taskId, (countById.get(result.taskId) ?? 0) + 1);
  }
  for (const rej of rejections) if (rej.taskId) answered.add(rej.taskId);

  const updates: PlannedUpdate[] = [];
  for (const { line, result } of parsed) {
    const reject = (reason: RejectReason, detail: string) =>
      rejections.push({ line, taskId: result.taskId, reason, detail });

    if ((countById.get(result.taskId) ?? 0) > 1) {
      reject("duplicate", `taskId が結果に ${countById.get(result.taskId)} 回現れる`);
      continue;
    }
    const task = taskById.get(result.taskId);
    if (!task) {
      reject("unknown_task", "発行したタスクファイルに無い taskId");
      continue;
    }
    if (result.contractVersion !== SUMMARY_CONTRACT_VERSION || task.contractVersion !== SUMMARY_CONTRACT_VERSION) {
      reject(
        "contract_version",
        `結果 ${result.contractVersion} / タスク ${task.contractVersion} / 現行 ${SUMMARY_CONTRACT_VERSION}`,
      );
      continue;
    }
    const row = current.get(result.taskId);
    if (!row) {
      reject("stale", "今の D1 にこの (銘柄, 掲載文) が無い (タスク発行後に再取得で文言が変わった)");
      continue;
    }
    const summary = normalizeSummary(result.shortSummary);
    const violations = checkSummary(summary);
    if (violations.length > 0) {
      reject("contract", `${formatViolations(violations)} :: ${summary.slice(0, 70)}`);
      continue;
    }
    if (isVerbatimCopy(summary, row.description)) {
      reject("verbatim", `掲載文の ${summary.length} 字の逐語コピー`);
      continue;
    }
    if (sanitizeEstimatedValue(row.description, result.estimatedValue) !== result.estimatedValue) {
      reject("value_guard", `estimatedValue=${result.estimatedValue} が割引の金額化か、本文の金額と桁が合わない`);
      continue;
    }
    updates.push({
      taskId: result.taskId,
      ids: [...row.ids].sort((a, b) => a - b),
      shortSummary: summary,
      estimatedValue: result.estimatedValue,
      estimateValueSource: result.estimatedValue !== null ? "company" : null,
      estimateSourceUrl: null,
    });
  }

  rejections.sort((a, b) => a.line - b.line);
  const unansweredTaskIds = input.tasks.map((t) => t.taskId).filter((id) => !answered.has(id));
  return { updates, rejections, unansweredTaskIds };
}

/** D1 への書き込み口。テストでは差し替える。 */
export interface SummaryWriter {
  update(
    ids: number[],
    values: Pick<PlannedUpdate, "shortSummary" | "estimatedValue" | "estimateValueSource" | "estimateSourceUrl">,
  ): Promise<void>;
}

/**
 * 1 文あたりの行 ID 上限。D1 REST は bind 100 個までなので、SET 句の 4 個を
 * 引いて余裕を持たせる。
 */
export const MAX_IDS_PER_UPDATE = 90;

/**
 * 計画を実行する。`apply=false` (既定の dry-run) では writer を一切呼ばない。
 * 戻り値は書いた (dry-run では書く予定の) 行数とグループ数。
 */
export async function applySummaryImport(
  plan: ImportPlan,
  writer: SummaryWriter,
  opts: { apply: boolean },
): Promise<{ rows: number; groups: number; written: boolean }> {
  const rows = plan.updates.reduce((s, u) => s + u.ids.length, 0);
  if (!opts.apply) return { rows, groups: plan.updates.length, written: false };
  for (const u of plan.updates) {
    for (let i = 0; i < u.ids.length; i += MAX_IDS_PER_UPDATE) {
      await writer.update(u.ids.slice(i, i + MAX_IDS_PER_UPDATE), {
        shortSummary: u.shortSummary,
        estimatedValue: u.estimatedValue,
        estimateValueSource: u.estimateValueSource,
        estimateSourceUrl: u.estimateSourceUrl,
      });
    }
  }
  return { rows, groups: plan.updates.length, written: true };
}

/** 計画をログ用の行にする。掲載文は出さない (要約は公開予定の文字列なので出す)。 */
export function formatPlanReport(plan: ImportPlan, maxRejections = 30): string[] {
  const out: string[] = [];
  const rows = plan.updates.reduce((s, u) => s + u.ids.length, 0);
  out.push(`書き込み対象: ${plan.updates.length} タスク / ${rows} 行`);
  out.push(`はじいた結果: ${plan.rejections.length} 行`);
  const byReason = new Map<RejectReason, number>();
  for (const r of plan.rejections) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) out.push(`  ${reason}: ${n}`);
  for (const r of plan.rejections.slice(0, maxRejections)) {
    out.push(`  L${r.line} ${r.taskId ?? "(taskId なし)"} ${r.reason}: ${r.detail}`);
  }
  if (plan.rejections.length > maxRejections) out.push(`  … 他 ${plan.rejections.length - maxRejections} 行`);
  out.push(`未回答のタスク: ${plan.unansweredTaskIds.length}`);
  return out;
}
