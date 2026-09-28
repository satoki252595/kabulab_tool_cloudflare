/**
 * クラウド LLM の要約結果を検証し、通った行だけを D1 に書く。**既定は dry-run。**
 *
 * 検証の中身は `summary-import.ts` (契約・金額ガード・taskId と今の D1 の一致)。
 * D1 の `short_summary` / `estimated_value` / `estimate_value_source` を
 * 書くのはこのコマンドだけ (変更日時 `updated_at` も同時に打つ)。
 * (`estimate_source_url` は 2026-09-25 に DROP した。writer が常に null を
 * 書くだけの死に列だったため — X-01)。
 * 書き込んだ銘柄の `yutai_yield` とスコアは同一実行で再計算する
 * (`recompute-yields.ts`。取り込みだけ利回りを置き去りにすると fresh stale が
 * 再発するため)。同一銘柄の要約・推定値・利回り・スコアの全 UPDATE は
 * D1 REST `{batch}` 1 リクエストで送る (銘柄単位の原子単位。`atomic-apply.ts`)。
 *
 * 実行:
 *   pnpm yutai:summary:import --tasks <タスクファイル> --results <結果ファイル>          # dry-run
 *   pnpm yutai:summary:import --tasks <タスクファイル> --results <結果ファイル> --apply  # 書き込み
 *
 * dry-run は D1 を読むだけで、書く件数・はじいた行と理由を出す。既定では、はじいた
 * 行の詳細に掲載文由来の文字列 (契約違反の要約本体・JSON として読めなかった行の
 * 原文) を出さない。`--show-text` を付けると端末にだけそれを出すが、Issue / PR /
 * チャット等には貼らないこと (掲載元サイトの規約・private-path.ts の趣旨と同じ)。
 *
 * 採らなかった案: 違反が 1 行でもあれば全体を止める (旧 apply の挙動)。旧経路は
 * 自前の LLM を再実行すれば済んだが、外部エージェントへの再依頼は往復が重く、
 * 通った行まで止めると 85 行の違反修正のような部分的な改善が入らない。
 * はじいた行は理由つきで列挙し、未反映のまま残る (公開面は前の値のまま)。
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { eq, inArray, sql } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { createD1HttpBatchSender } from "../../../src/shared/db/d1-http-client.js";
import { stocks, yutaiBenefits } from "../src/db/schema.js";
import {
  applyAtomicBatches,
  planAtomicBatches,
  type AtomicBatchSender,
} from "./atomic-apply.js";
import { benefitKey } from "./benefit-key.js";
import { loadBenefitRows, openOtakaraD1 } from "./benefit-rows.js";
import { assertNotCommittable } from "./private-path.js";
import {
  formatRecomputeReport,
  planYieldRecompute,
  type RecomputeYieldsDb,
  type YieldRecomputePlan,
} from "./recompute-yields.js";
import {
  MAX_IDS_PER_UPDATE,
  formatPlanReport,
  planSummaryImport,
  type PlannedUpdate,
  type SummaryWriter,
} from "./summary-import.js";
import { parseTaskFile } from "./summary-tasks.js";

export type ImportArgs = {
  tasks: string;
  results: string;
  apply: boolean;
  showText: boolean;
};

/**
 * CLI 引数を解釈する。`main` から切り出してテストで固定する — CLI の配線
 * (`--show-text` 既定 false の値がどのオプションに渡るか) は D1 を読まずに
 * ここだけで検証できる。
 */
export function parseImportArgs(argv: readonly string[]): ImportArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      tasks: { type: "string" },
      results: { type: "string" },
      apply: { type: "boolean", default: false },
      // 既定オフ。付けると、はじいた行の詳細に掲載文由来の文字列 (契約違反の
      // 要約本体・壊れた JSON 行の原文) を端末にだけ出す。Issue / PR / チャット
      // には貼らないこと。
      "show-text": { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values.tasks || !values.results) {
    throw new Error("--tasks <タスクファイル> と --results <結果ファイル> を指定してください");
  }
  return {
    tasks: values.tasks,
    results: values.results,
    apply: values.apply ?? false,
    showText: values["show-text"] ?? false,
  };
}

/**
 * D1 への逐次書き込み口。書く 4 列 (要約・推定値・出典・更新日時) の正準。
 * `--apply` の実経路は銘柄単位の原子 batch (`applyImportAtomically`) を使い、
 * この writer は直接呼ばない — `buildBenefitUpdateStatements` が同一の 4 列を
 * 書くことをテストで固定する。
 */
export function makeSummaryWriter(
  db: BaseSQLiteDatabase<"async", unknown, Record<string, unknown>>
): SummaryWriter {
  return {
    async update(ids, v) {
      await db
        .update(yutaiBenefits)
        .set({
          shortSummary: v.shortSummary,
          estimatedValue: v.estimatedValue,
          estimateValueSource: v.estimateValueSource,
          // 取り込みで書いた行がいつ変わったか追えるようにする (従来は
          // updated_at に触らず、利回り stale の原因特定ができなかった)。
          updatedAt: sql`(unixepoch())`,
        })
        .where(inArray(yutaiBenefits.id, ids));
    },
  };
}

async function main(): Promise<void> {
  const { tasks: tasksPath, results: resultsPath, apply, showText } = parseImportArgs(process.argv.slice(2));
  assertNotCommittable(tasksPath);
  assertNotCommittable(resultsPath);

  const tasks = parseTaskFile(readFileSync(tasksPath, "utf-8"));
  const resultsText = readFileSync(resultsPath, "utf-8");
  const db = openOtakaraD1();
  const currentRows = await loadBenefitRows(db);

  const plan = planSummaryImport({ tasks, resultsText, currentRows, includeText: showText });
  console.info(`[summary:import] タスク ${tasks.length} 件 / D1 の優待行 ${currentRows.length}`);
  for (const line of formatPlanReport(plan, undefined, showText)) console.info(`[summary:import] ${line}`);

  // 利回りの追随対象。書き込み予定があればその行、無ければ (全 reject・前回が
  // 要約書き込み後に中断した場合の再実行) タスク対象の行で再評価する。
  const targetIds = resolveTargetIds(tasks, currentRows, plan.updates);
  if (!apply) {
    const rows = plan.updates.reduce((s, u) => s + u.ids.length, 0);
    console.info(
      `[summary:import] dry-run: D1 には書いていません (書く予定 ${plan.updates.length} タスク / ${rows} 行)。--apply で書き込みます。`,
    );
    await reportYieldPreview(db, targetIds, plan.updates);
    return;
  }
  const atomic = await applyImportAtomically(db, createD1HttpBatchSender(), {
    targetIds,
    updates: plan.updates,
  });
  console.info(`[summary:import] 書き込み完了: ${atomic.groups} タスク / ${atomic.rows} 行`);
  if (plan.rejections.length > 0) {
    console.warn(
      `[summary:import] はじいた ${plan.rejections.length} 行は未反映です。理由を添えて再依頼してください。`,
    );
  }
  for (const line of formatRecomputeReport(atomic.yieldPlan, atomic.codeOf)) {
    console.info(`[summary:import] ${line}`);
  }
  const updated = atomic.yieldPlan.entries.filter((e) => e.changed).length;
  const scoresUpdated = atomic.yieldPlan.entries.filter((e) => e.scoreChanged).length;
  console.info(
    `[summary:import] 優待利回りを更新: ${updated} 銘柄 / スコアを更新: ${scoresUpdated} 銘柄 (data_date は月次のまま)`
  );
}

/**
 * 利回り追随の対象の優待行 id。書き込み予定の行とタスク対象の行の和集合。
 * 和集合にするのは混合再開のため: 前回が要約書き込み後に中断し、今回の
 * 結果でそのタスクが reject されると、その行は updates に現れない。
 * updates だけ見ると前回書いた行の利回りが置き去りになるので、タスク側の
 * 行も必ず含める (余分に触れても changed のある行だけ書くので無害)。
 * stale で今の D1 に無いタスクは寄与しない。
 */
export function resolveTargetIds(
  tasks: { taskId: string }[],
  currentRows: { id: number; stockCode: string; description: string }[],
  updates: { ids: number[] }[]
): number[] {
  const ids = new Set(updates.flatMap((u) => u.ids));
  const wanted = new Set(tasks.map((t) => t.taskId));
  for (const r of currentRows) {
    if (wanted.has(benefitKey(r.stockCode, r.description))) ids.add(r.id);
  }
  return [...ids];
}

/** 対象の優待行 id から (stockId, 銘柄コード) を引く。 */
async function resolveTouchedStocks(
  db: RecomputeYieldsDb,
  ids: number[]
): Promise<{
  stockIds: number[];
  codeOf: (stockId: number) => string;
  stockOf: (benefitId: number) => number | undefined;
}> {
  const unique = [...new Set(ids)];
  const stockById = new Map<number, { stockId: number; code: string }>();
  for (let i = 0; i < unique.length; i += MAX_IDS_PER_UPDATE) {
    const rows = await db
      .select({ id: yutaiBenefits.id, stockId: yutaiBenefits.stockId, code: stocks.code })
      .from(yutaiBenefits)
      .innerJoin(stocks, eq(yutaiBenefits.stockId, stocks.id))
      .where(inArray(yutaiBenefits.id, unique.slice(i, i + MAX_IDS_PER_UPDATE)));
    for (const r of rows) stockById.set(r.id, r);
  }
  const codeByStock = new Map<number, string>();
  for (const r of stockById.values()) codeByStock.set(r.stockId, r.code);
  return {
    stockIds: [...codeByStock.keys()],
    codeOf: (stockId) => codeByStock.get(stockId) ?? `stock:${stockId}`,
    stockOf: (benefitId) => stockById.get(benefitId)?.stockId,
  };
}

/** dry-run: 書き込み予定値を仮適用した利回りを表示する (書かない)。 */
async function reportYieldPreview(
  db: ReturnType<typeof openOtakaraD1>,
  targetIds: number[],
  updates: { ids: number[]; estimatedValue: number | null }[]
): Promise<void> {
  if (targetIds.length === 0) return;
  const { stockIds, codeOf } = await resolveTouchedStocks(db, targetIds);
  const overlay = new Map<number, number | null>();
  for (const u of updates) for (const id of u.ids) overlay.set(id, u.estimatedValue);
  const plan = await planYieldRecompute(db, stockIds, overlay);
  for (const line of formatRecomputeReport(plan, codeOf)) {
    console.info(`[summary:import] (preview) ${line}`);
  }
}

/**
 * `--apply` の実経路: 書き込み予定の推定値を今の D1 の snapshot に仮適用して
 * 利回り・スコアを先に計算し (dry-run の先見せと同一の overlay 方式・同一関数)、
 * 同一銘柄の要約・推定値・利回り・スコアの全 UPDATE を D1 REST `{batch}`
 * 1 リクエストで送る (銘柄単位の原子単位。要約だけ書いて中断する形は無い)。
 * `data_date` は月次のまま。銘柄間の失敗は止めて同引数の再実行で回復する
 * (適用済み銘柄は無変更・冪等。`resolveTargetIds` の和集合で混合再開に対応)。
 * 送信口は差し替え可能にし、テストでは D1 なしで束ね方を固定する。
 */
export async function applyImportAtomically(
  db: RecomputeYieldsDb,
  sender: AtomicBatchSender,
  input: { targetIds: readonly number[]; updates: readonly PlannedUpdate[] }
): Promise<{
  groups: number;
  rows: number;
  yieldPlan: YieldRecomputePlan;
  codeOf: (stockId: number) => string;
}> {
  const groups = input.updates.length;
  const rows = input.updates.reduce((s, u) => s + u.ids.length, 0);
  if (input.targetIds.length === 0) {
    return {
      groups,
      rows,
      yieldPlan: { entries: [], skippedNoRow: [], skippedNoScore: [] },
      codeOf: (stockId) => `stock:${stockId}`,
    };
  }
  const { stockIds, codeOf, stockOf } = await resolveTouchedStocks(db, [...input.targetIds]);
  const overlay = new Map<number, number | null>();
  for (const u of input.updates) for (const id of u.ids) overlay.set(id, u.estimatedValue);
  const yieldPlan = await planYieldRecompute(db, stockIds, overlay);
  const batches = planAtomicBatches({ updates: input.updates, yieldPlan, stockOfBenefit: stockOf });
  await applyAtomicBatches(sender, batches);
  return { groups, rows, yieldPlan, codeOf };
}

// CLI として直接実行されたときだけ動かす。`parseImportArgs` をテストから
// import しても `main()` (D1 アクセス・`process.exit`) が走らないようにするため。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("[summary:import] エラー:", e);
    process.exit(1);
  });
}
