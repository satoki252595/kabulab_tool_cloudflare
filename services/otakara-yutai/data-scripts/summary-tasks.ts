/**
 * 優待要約タスクの選定とファイル形式 (提供元に依存しない部分)。
 *
 * 要約 (`yutai_benefits.short_summary`) と推定金額はリポジトリの外のクラウド LLM
 * (Cursor Automations 等) が作る。このモジュールは
 *   1. D1 の現行行から「要約が要る (銘柄, 掲載文)」を選び、
 *   2. 外部エージェントへ渡すタスク行の形を決める。
 * D1 / ファイル I/O は CLI (`export-summary-tasks.ts`) 側に置き、ここは純関数に
 * してテストで固定する。
 *
 * タスクの単位は行ではなく `(銘柄コード, 掲載文)`。同じ文言が権利月違いで複数行
 * あり、解釈は文言で決まるため (`benefit-key.ts`)。
 *
 * 「掲載文が変わった行」を別の条件で拾わないのは、`fetch-yutai-full.ts` が
 * 再取得時に解釈を `(銘柄, 掲載文)` の内容キーで戻すので、文言が変わった行は
 * `short_summary` が NULL のまま入り、`missing` で拾えるから。
 */
import { z } from "zod";
import { benefitKey } from "./benefit-key.js";
import {
  SUMMARY_CONTRACT_VERSION,
  checkSummary,
  type SummaryViolation,
} from "./summary-contract.js";

/** D1 から読む 1 行 (yutai_benefits × core_stocks)。 */
export type BenefitRow = {
  id: number;
  stockCode: string;
  stockName: string;
  description: string;
  shortSummary: string | null;
  estimatedValue: number | null;
};

const VIOLATION_RULES = ["annotation", "too_long", "prose", "empty"] as const satisfies readonly SummaryViolation["rule"][];

/** タスクファイル 1 行。外部エージェントへの入力。 */
export const SummaryTask = z
  .object({
    /** `benefitKey(stockCode, description)`。結果の突き合わせキー。 */
    taskId: z.string().regex(/^[0-9a-f]{16}$/),
    contractVersion: z.string().min(1),
    /** missing = 要約が無い / contract_violation = 今の要約が契約違反。 */
    reason: z.enum(["missing", "contract_violation"]),
    violations: z.array(z.enum(VIOLATION_RULES)),
    stockCode: z.string().min(1),
    stockName: z.string(),
    description: z.string(),
    /** この文言を持つ D1 の行数 (権利月違い等)。作業量の目安。 */
    rowCount: z.number().int().positive(),
  })
  .strict();
export type SummaryTask = z.infer<typeof SummaryTask>;

export type SelectOptions = {
  /** 契約違反の既存要約だけに絞る (要約が無い行は含めない)。 */
  violationsOnly?: boolean;
  /** 先頭から n 件 (試走用)。 */
  limit?: number;
};

/** 現行行から要約タスクを選ぶ。順序は (銘柄コード, 掲載文) で決定的。 */
export function selectSummaryTasks(
  rows: readonly BenefitRow[],
  opts: SelectOptions = {},
): SummaryTask[] {
  const groups = new Map<
    string,
    { stockCode: string; stockName: string; description: string; summaries: (string | null)[] }
  >();
  for (const r of rows) {
    const key = benefitKey(r.stockCode, r.description);
    let g = groups.get(key);
    if (!g) {
      g = { stockCode: r.stockCode, stockName: r.stockName, description: r.description, summaries: [] };
      groups.set(key, g);
    }
    g.summaries.push(r.shortSummary);
  }

  const tasks: SummaryTask[] = [];
  for (const [taskId, g] of groups) {
    const hasMissing = g.summaries.some((s) => s === null);
    let reason: SummaryTask["reason"] | null = null;
    const rules = new Set<SummaryViolation["rule"]>();
    if (hasMissing) {
      reason = "missing";
    } else {
      for (const s of new Set(g.summaries)) {
        for (const v of checkSummary(s as string)) rules.add(v.rule);
      }
      if (rules.size > 0) reason = "contract_violation";
    }
    if (reason === null) continue;
    if (opts.violationsOnly && reason !== "contract_violation") continue;
    tasks.push({
      taskId,
      contractVersion: SUMMARY_CONTRACT_VERSION,
      reason,
      violations: VIOLATION_RULES.filter((r) => rules.has(r)),
      stockCode: g.stockCode,
      stockName: g.stockName,
      description: g.description,
      rowCount: g.summaries.length,
    });
  }

  tasks.sort((a, b) =>
    a.stockCode !== b.stockCode
      ? a.stockCode < b.stockCode ? -1 : 1
      : a.description < b.description ? -1 : a.description > b.description ? 1 : 0,
  );
  return opts.limit !== undefined ? tasks.slice(0, opts.limit) : tasks;
}

/** タスク列を JSONL にする。 */
export function serializeTasks(tasks: readonly SummaryTask[]): string {
  return tasks.map((t) => JSON.stringify(t)).join("\n") + (tasks.length > 0 ? "\n" : "");
}

/**
 * タスクファイルを読む。自分で書き出したファイルなので、形が崩れていたら
 * 行単位ではじかずに全体を止める (ルール2)。`taskId` が掲載文と合わない行は
 * 手で書き換えられたものとして止める (別銘柄へ要約を貼る事故を防ぐ)。
 */
export function parseTaskFile(text: string): SummaryTask[] {
  const out: SummaryTask[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      throw new Error(`タスクファイル ${i + 1} 行目が JSON ではありません: ${(e as Error).message}`, { cause: e });
    }
    const parsed = SummaryTask.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`タスクファイル ${i + 1} 行目の形が不正です: ${parsed.error.message.slice(0, 300)}`);
    }
    const t = parsed.data;
    if (benefitKey(t.stockCode, t.description) !== t.taskId) {
      throw new Error(`タスクファイル ${i + 1} 行目の taskId が銘柄コードと掲載文に一致しません (手で編集された可能性)`);
    }
    if (seen.has(t.taskId)) {
      throw new Error(`タスクファイル ${i + 1} 行目の taskId ${t.taskId} が重複しています`);
    }
    seen.add(t.taskId);
    out.push(t);
  });
  return out;
}
