/**
 * クラウド LLM の要約結果を検証し、通った行だけを D1 に書く。**既定は dry-run。**
 *
 * 検証の中身は `summary-import.ts` (契約・金額ガード・taskId と今の D1 の一致)。
 * D1 の `short_summary` / `estimated_value` / `estimate_value_source` /
 * `estimate_source_url` を書くのはこのコマンドだけ。
 *
 * 実行:
 *   pnpm yutai:summary:import --tasks <タスクファイル> --results <結果ファイル>          # dry-run
 *   pnpm yutai:summary:import --tasks <タスクファイル> --results <結果ファイル> --apply  # 書き込み
 *
 * dry-run は D1 を読むだけで、書く件数・はじいた行と理由を出す。
 *
 * 採らなかった案: 違反が 1 行でもあれば全体を止める (旧 apply の挙動)。旧経路は
 * 自前の LLM を再実行すれば済んだが、外部エージェントへの再依頼は往復が重く、
 * 通った行まで止めると 85 行の違反修正のような部分的な改善が入らない。
 * はじいた行は理由つきで列挙し、未反映のまま残る (公開面は前の値のまま)。
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { inArray } from "drizzle-orm";
import { yutaiBenefits } from "../src/db/schema.js";
import { loadBenefitRows, openOtakaraD1 } from "./benefit-rows.js";
import { assertNotCommittable } from "./private-path.js";
import {
  applySummaryImport,
  formatPlanReport,
  planSummaryImport,
  type SummaryWriter,
} from "./summary-import.js";
import { parseTaskFile } from "./summary-tasks.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tasks: { type: "string" },
      results: { type: "string" },
      apply: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values.tasks || !values.results) {
    throw new Error("--tasks <タスクファイル> と --results <結果ファイル> を指定してください");
  }
  const apply = values.apply ?? false;
  assertNotCommittable(values.tasks);
  assertNotCommittable(values.results);

  const tasks = parseTaskFile(readFileSync(values.tasks, "utf-8"));
  const resultsText = readFileSync(values.results, "utf-8");
  const db = openOtakaraD1();
  const currentRows = await loadBenefitRows(db);

  const plan = planSummaryImport({ tasks, resultsText, currentRows });
  console.info(`[summary:import] タスク ${tasks.length} 件 / D1 の優待行 ${currentRows.length}`);
  for (const line of formatPlanReport(plan)) console.info(`[summary:import] ${line}`);

  const writer: SummaryWriter = {
    async update(ids, v) {
      await db
        .update(yutaiBenefits)
        .set({
          shortSummary: v.shortSummary,
          estimatedValue: v.estimatedValue,
          estimateValueSource: v.estimateValueSource,
          estimateSourceUrl: v.estimateSourceUrl,
        })
        .where(inArray(yutaiBenefits.id, ids));
    },
  };
  const res = await applySummaryImport(plan, writer, { apply });
  if (!res.written) {
    console.info(
      `[summary:import] dry-run: D1 には書いていません (書く予定 ${res.groups} タスク / ${res.rows} 行)。--apply で書き込みます。`,
    );
    return;
  }
  console.info(`[summary:import] 書き込み完了: ${res.groups} タスク / ${res.rows} 行`);
  if (plan.rejections.length > 0) {
    console.warn(
      `[summary:import] はじいた ${plan.rejections.length} 行は未反映です。理由を添えて再依頼してください。`,
    );
  }
}

main().catch((e) => {
  console.error("[summary:import] エラー:", e);
  process.exit(1);
});
