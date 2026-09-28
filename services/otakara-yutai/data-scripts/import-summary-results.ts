/**
 * クラウド LLM の要約結果を検証し、通った行だけを D1 に書く。**既定は dry-run。**
 *
 * 検証の中身は `summary-import.ts` (契約・金額ガード・taskId と今の D1 の一致)。
 * D1 の `short_summary` / `estimated_value` / `estimate_value_source` を
 * 書くのはこのコマンドだけ (変更日時 `updated_at` も同時に打つ)。
 * (`estimate_source_url` は 2026-09-25 に DROP した。writer が常に null を
 * 書くだけの死に列だったため — X-01)。
 * 書き込んだ銘柄の `yutai_yield` は同一実行で再計算する (`recompute-yields.ts`。
 * 取り込みだけ利回りを置き去りにすると fresh stale が再発するため)。
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
import { stocks, yutaiBenefits } from "../src/db/schema.js";
import { benefitKey } from "./benefit-key.js";
import { loadBenefitRows, openOtakaraD1 } from "./benefit-rows.js";
import { assertNotCommittable } from "./private-path.js";
import {
  applyYieldRecompute,
  formatRecomputeReport,
  planYieldRecompute,
} from "./recompute-yields.js";
import {
  MAX_IDS_PER_UPDATE,
  applySummaryImport,
  formatPlanReport,
  planSummaryImport,
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
 * D1 への書き込み口。`main` から切り出してテストで固定する —
 * 書く 4 列 (要約・推定値・出典・更新日時) を D1 なしで検証できる。
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

  const writer: SummaryWriter = makeSummaryWriter(db);
  const res = await applySummaryImport(plan, writer, { apply });
  // 利回りの追随対象。書き込み予定があればその行、無ければ (全 reject・前回が
  // 要約書き込み後に中断した場合の再実行) タスク対象の行で再評価する。
  const targetIds = resolveTargetIds(tasks, currentRows, plan.updates);
  if (!res.written) {
    console.info(
      `[summary:import] dry-run: D1 には書いていません (書く予定 ${res.groups} タスク / ${res.rows} 行)。--apply で書き込みます。`,
    );
    await reportYieldPreview(db, targetIds, plan.updates);
    return;
  }
  console.info(`[summary:import] 書き込み完了: ${res.groups} タスク / ${res.rows} 行`);
  if (plan.rejections.length > 0) {
    console.warn(
      `[summary:import] はじいた ${plan.rejections.length} 行は未反映です。理由を添えて再依頼してください。`,
    );
  }
  await refreshTouchedYields(db, targetIds);
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
  db: ReturnType<typeof openOtakaraD1>,
  ids: number[]
): Promise<{ stockIds: number[]; codeOf: (stockId: number) => string }> {
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
 * --apply 後: 書いた銘柄の優待利回り・スコアを現入力で再計算する。
 * 取り込みだけ利回りを置き去りにすると fresh stale (2026-09-28 監査 F3) が
 * 再発するため、同一実行で追随させる。data_date は月次のまま。
 * 要約の書き込みと利回りの更新の間で中断しても、同じ引数の再実行で
 * タスク対象の利回りを再評価するため置き去りは残らない (再実行は冪等)。
 */
async function refreshTouchedYields(
  db: ReturnType<typeof openOtakaraD1>,
  targetIds: number[]
): Promise<void> {
  if (targetIds.length === 0) return;
  const { stockIds, codeOf } = await resolveTouchedStocks(db, targetIds);
  const plan = await planYieldRecompute(db, stockIds);
  const { updated, scoresUpdated } = await applyYieldRecompute(db, plan);
  for (const line of formatRecomputeReport(plan, codeOf)) {
    console.info(`[summary:import] ${line}`);
  }
  console.info(
    `[summary:import] 優待利回りを更新: ${updated} 銘柄 / スコアを更新: ${scoresUpdated} 銘柄 (data_date は月次のまま)`
  );
}

// CLI として直接実行されたときだけ動かす。`parseImportArgs` をテストから
// import しても `main()` (D1 アクセス・`process.exit`) が走らないようにするため。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("[summary:import] エラー:", e);
    process.exit(1);
  });
}
