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
 *   - 推定金額が掲載文の金額表現に根拠を持つか (value_ungrounded)
 *
 * 取り込んだ金額は公開面で `estimate_value_source = "company"` (企業が示した額) として
 * 出る (`services/otakara-yutai/src/db/schema.ts` の定義)。`sanitizeEstimatedValue` は
 * 5 万円未満を無条件に通すので、掲載文に金額が 1 つも無いのに LLM が相場を見積もった
 * 値まで「企業公表」として載ってしまう。そこで金額を入れるなら掲載文に金額表現が
 * あることを別に求める (ルール1)。`sanitizeEstimatedValue` 自体を変えないのは、
 * 移設で挙動不変としたガードの判定基準をこの変更で動かさないため。
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
 * - 5 万円未満にも高額帯と同じ「本文の金額 × 数量 / 合計に一致」を求める: 仕様書が
 *   認める「年間額 ÷ 回数」などが一致せず正しい回答まではじくので、金額表現の
 *   有無だけを見る。
 */
import { z } from "zod";
import { benefitKey } from "./benefit-key.js";
import { extractYenAmounts, sanitizeEstimatedValue } from "./estimated-value-guard.js";
import {
  CONTRACT_VERSION_PATTERN,
  SUMMARY_CONTRACT_VERSION,
  checkSummary,
  formatViolations,
  isVerbatimCopy,
  normalizeSummary,
} from "./summary-contract.js";
import { TASK_ID_PATTERN, type BenefitRow, type SummaryTask } from "./summary-tasks.js";

/**
 * 結果ファイル 1 行。外部エージェントの出力。`taskId` / `contractVersion` は
 * 形式を絞る (`TASK_ID_PATTERN` / `CONTRACT_VERSION_PATTERN`) — LLM や手編集で
 * フィールドを取り違え、掲載文が本来別の値であるべきここに紛れ込んでも、
 * その時点でスキーマ違反としてはじき、後続の `contract_version` 等の detail に
 * 埋め込まれて dry-run 出力に本文が乗る経路を閉じるため。
 */
export const SummaryResult = z
  .object({
    taskId: z.string().regex(TASK_ID_PATTERN),
    contractVersion: z.string().regex(CONTRACT_VERSION_PATTERN),
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
  | "value_guard"
  | "value_ungrounded";

export type Rejection = {
  /** 結果ファイルの行番号 (1 始まり)。 */
  line: number;
  taskId: string | null;
  reason: RejectReason;
  detail: string;
  /**
   * `planSummaryImport` の `includeText` を明示的に指定したときだけ持つ、掲載文
   * 由来のテキスト (契約違反になった要約本体、または JSON として読めなかった行の
   * 原文)。既定 (`includeText` 省略) では入らない。`formatPlanReport` も
   * `showText` を渡さない限りこれを出力しないので、既定の dry-run ログには
   * 掲載文の断片が出ない。
   */
  text?: string;
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
  /**
   * 書き込み対象の行で、今の D1 の `estimated_value` がどう変わるか (行数)。
   * 契約違反の要約を直すだけのつもりでも、回答の金額が null なら既存の金額が消えて
   * 優待利回りの計算から外れる。dry-run で人が気付けるように数える。
   */
  valueChanges: { toNull: number; fromNull: number; changed: number };
};

/** 結果ファイルとタスク・現行行を突き合わせ、書き込み計画を作る (副作用なし)。 */
export function planSummaryImport(input: {
  tasks: readonly SummaryTask[];
  resultsText: string;
  currentRows: readonly BenefitRow[];
  /**
   * true のときだけ、はじいた行に掲載文由来のテキスト (`Rejection.text`) を残す。
   * 既定 (省略・false) では残さない — dry-run のログに掲載文の断片を出さないための
   * 既定値。運用者が端末で本文を確認したいとき (`--show-text`) だけ true にする。
   */
  includeText?: boolean;
}): ImportPlan {
  const taskById = new Map(input.tasks.map((t) => [t.taskId, t]));
  const current = new Map<string, { ids: number[]; description: string; values: (number | null)[] }>();
  for (const r of input.currentRows) {
    const key = benefitKey(r.stockCode, r.description);
    const e = current.get(key);
    if (e) {
      e.ids.push(r.id);
      e.values.push(r.estimatedValue);
    } else {
      current.set(key, { ids: [r.id], description: r.description, values: [r.estimatedValue] });
    }
  }

  const rejections: Rejection[] = [];
  const parsed: { line: number; result: SummaryResult }[] = [];
  input.resultsText.split("\n").forEach((text, i) => {
    const line = i + 1;
    if (text.trim() === "") return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      // Node の JSON.parse エラー文には入力の先頭が乗る (例: Node 22 の
      // `Unexpected token '架', "架空の掲載文がそのま"... is not valid JSON`)。
      // 壊れた行は往々にして掲載文をそのまま書き戻そうとした行なので、
      // メッセージをそのまま出さず固定文にする。
      rejections.push({
        line,
        taskId: null,
        reason: "parse",
        detail: "JSON として読めない",
        ...(input.includeText ? { text } : {}),
      });
      return;
    }
    const r = SummaryResult.safeParse(raw);
    if (!r.success) {
      const rawTaskId =
        raw && typeof raw === "object" && typeof (raw as { taskId?: unknown }).taskId === "string"
          ? (raw as { taskId: string }).taskId
          : null;
      // taskId の形式 (16 桁 hex) に一致するときだけ出す。フィールド取り違えで
      // 掲載文がそのまま taskId に入っていても、形式外なら null にして出さない。
      const taskId = rawTaskId !== null && TASK_ID_PATTERN.test(rawTaskId) ? rawTaskId : null;
      const detail = r.error.issues
        .map((x) =>
          x.code === "unrecognized_keys"
            // キー名に掲載文が紛れ込んでいても (例: 本文をキーにした行) キー数だけにする。
            ? `${x.path.join(".") || "(root)"}: 余計なキー ${x.keys.length} 個`
            : `${x.path.join(".") || "(root)"}: ${x.message}`,
        )
        .join(" / ")
        .slice(0, 200);
      rejections.push({ line, taskId, reason: "schema", detail });
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
  for (const rej of rejections) {
    if (!rej.taskId) continue;
    answered.add(rej.taskId);
    // 形の崩れた行も「そのタスクへの回答」として数える。数えないと、崩れた行と
    // 正しい行が同じ taskId に並んだとき正しい方だけが通り、仕様書の
    // 「同じ taskId を 2 回書くと両方はじく」と食い違う (どちらが本意か決められない)。
    countById.set(rej.taskId, (countById.get(rej.taskId) ?? 0) + 1);
  }

  const updates: PlannedUpdate[] = [];
  const valueChanges = { toNull: 0, fromNull: 0, changed: 0 };
  for (const { line, result } of parsed) {
    const reject = (reason: RejectReason, detail: string, text?: string) =>
      rejections.push({
        line,
        taskId: result.taskId,
        reason,
        detail,
        ...(input.includeText && text !== undefined ? { text } : {}),
      });

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
      // detail は規則名と字数だけ (formatViolations 参照)。要約本体は積まない —
      // annotation 違反はまさに「掲載文の注記ブロックを写した要約」なので、
      // ここで本体を出すとログに掲載文の断片が出てしまう。
      reject("contract", formatViolations(violations), summary);
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
    if (result.estimatedValue !== null && extractYenAmounts(row.description).length === 0) {
      reject("value_ungrounded", `estimatedValue=${result.estimatedValue} だが掲載文に金額表現 (円・千円・万円・ポイント) が無い`);
      continue;
    }
    for (const prev of row.values) {
      if (prev === result.estimatedValue) continue;
      if (result.estimatedValue === null) valueChanges.toNull++;
      else if (prev === null) valueChanges.fromNull++;
      else valueChanges.changed++;
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
  return { updates, rejections, unansweredTaskIds, valueChanges };
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

/**
 * 計画をログ用の行にする。既定 (`showText` 省略・false) では掲載文由来の文字列を
 * 一切出さない — `Rejection.detail` は規則名・字数・件数だけ、`Rejection.text`
 * (契約違反の要約本体や壊れた行の原文) はそもそも `planSummaryImport` に
 * `includeText: true` を渡さない限り無い。`showText: true` は運用者が端末で
 * 本文を確認したいとき専用で、貼り付け前提の出力ではない。
 */
export function formatPlanReport(plan: ImportPlan, maxRejections = 30, showText = false): string[] {
  const out: string[] = [];
  const rows = plan.updates.reduce((s, u) => s + u.ids.length, 0);
  out.push(`書き込み対象: ${plan.updates.length} タスク / ${rows} 行`);
  out.push(`はじいた結果: ${plan.rejections.length} 行`);
  const byReason = new Map<RejectReason, number>();
  for (const r of plan.rejections) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) out.push(`  ${reason}: ${n}`);
  for (const r of plan.rejections.slice(0, maxRejections)) {
    const textSuffix = showText && r.text !== undefined ? ` :: ${r.text}` : "";
    out.push(`  L${r.line} ${r.taskId ?? "(taskId なし)"} ${r.reason}: ${r.detail}${textSuffix}`);
  }
  if (plan.rejections.length > maxRejections) out.push(`  … 他 ${plan.rejections.length - maxRejections} 行`);
  const vc = plan.valueChanges;
  out.push(`推定金額の変化: 消える ${vc.toNull} 行 / 新たに付く ${vc.fromNull} 行 / 値が変わる ${vc.changed} 行`);
  if (vc.toNull > 0) {
    out.push(`  注意: 今ある推定金額が ${vc.toNull} 行で null になり、優待利回りの計算から外れる`);
  }
  out.push(`未回答のタスク: ${plan.unansweredTaskIds.length}`);
  return out;
}
