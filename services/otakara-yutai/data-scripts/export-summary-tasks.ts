/**
 * 優待要約のタスクを書き出す (D1 は読むだけ)。
 *
 * 要約 (`short_summary`) と推定金額は、リポジトリの外のクラウド LLM
 * (Cursor Automations 等) が作業仕様書
 * `services/otakara-yutai/docs/llm-summary-task.md` に従って作る。
 * このコマンドはその入力を JSONL で書き出すだけで、LLM は呼ばない。
 *
 * 対象 (単位は `(銘柄コード, 掲載文)`):
 *   - missing: `short_summary` が NULL の行がある (新規・掲載文が変わった行を含む)
 *   - contract_violation: 既存の要約が `summary-contract.ts` に違反する
 *   - rework: `--retask-keys` で指定した内容キー (契約上有効だが内容が誤りの
 *     要約の作り直し。監査で見つけた別群貼り付け・tier 違いの修復用)
 *
 * 実行:
 *   pnpm yutai:summary:export                     # missing + contract_violation
 *   pnpm yutai:summary:export --violations-only   # 契約違反の既存要約だけ
 *   オプション: --out <path> (既定 data-scripts/data/summary-tasks/tasks-<日付>[-violations].jsonl)
 *              --limit <n> (試走用)
 *              --retask-keys <path> (taskId を 1 行ずつ並べたテキスト。rework 対象)
 *
 * 出力には出典サイトの掲載文がそのまま入る。公開リポジトリにコミットできる場所へは
 * 書かない (`private-path.ts` が git に確かめて止める)。Notion への一次データ記録も
 * しない (掲載文の確定スナップショットは export-benefit-descriptions.ts が既に記録する)。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadBenefitRows, openOtakaraD1 } from "./benefit-rows.js";
import { assertNotCommittable } from "./private-path.js";
import { SUMMARY_CONTRACT_VERSION } from "./summary-contract.js";
import { TASK_ID_PATTERN, selectSummaryTasks, serializeTasks } from "./summary-tasks.js";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "data");

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "violations-only": { type: "boolean", default: false },
      out: { type: "string" },
      limit: { type: "string" },
      "retask-keys": { type: "string" },
    },
    strict: true,
  });
  const violationsOnly = values["violations-only"] ?? false;
  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`--limit は 1 以上の整数で指定してください: ${values.limit}`);
    }
  }
  // rework 指定。taskId (16 桁 hex) を 1 行ずつ並べたテキストを読む。
  // 形の崩れた行があれば止める (別群への貼り付け事故を防ぐため黙って飛ばさない)。
  let retaskKeys: Set<string> | undefined;
  if (values["retask-keys"] !== undefined) {
    const keys = new Set<string>();
    const text = readFileSync(values["retask-keys"], "utf-8");
    text.split("\n").forEach((line, i) => {
      const key = line.trim();
      if (key === "") return;
      if (!TASK_ID_PATTERN.test(key)) {
        throw new Error(`--retask-keys の ${i + 1} 行目が taskId (16 桁 hex) ではありません`);
      }
      keys.add(key);
    });
    retaskKeys = keys;
  }
  const day = new Date().toISOString().slice(0, 10);
  const out =
    values.out ??
    join(DATA_DIR, "summary-tasks", `tasks-${day}${violationsOnly ? "-violations" : ""}.jsonl`);
  // D1 を読む前に確かめる (読んでから止まると無駄な往復になる)。
  assertNotCommittable(out);

  const rows = await loadBenefitRows(openOtakaraD1(), "active-equity");
  const tasks = selectSummaryTasks(rows, { violationsOnly, limit, retaskKeys });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, serializeTasks(tasks), "utf-8");

  const missing = tasks.filter((t) => t.reason === "missing");
  const violating = tasks.filter((t) => t.reason === "contract_violation");
  const rework = tasks.filter((t) => t.reason === "rework");
  const sumRows = (ts: typeof tasks) => ts.reduce((s, t) => s + t.rowCount, 0);
  console.info(`[summary:export] D1 の優待行: ${rows.length}`);
  console.info(`[summary:export] 契約の版: ${SUMMARY_CONTRACT_VERSION}`);
  console.info(
    `[summary:export] タスク ${tasks.length} 件 (missing ${missing.length} 件 / ${sumRows(missing)} 行, ` +
      `contract_violation ${violating.length} 件 / ${sumRows(violating)} 行, ` +
      `rework ${rework.length} 件 / ${sumRows(rework)} 行)`,
  );
  if (retaskKeys !== undefined) {
    const hit = new Set(tasks.filter((t) => t.reason === "rework").map((t) => t.taskId));
    const missed = [...retaskKeys].filter((k) => !hit.has(k));
    if (missed.length > 0) {
      // missing/contract_violation として既に task 化された分は除いて数える。
      const already = new Set(tasks.map((t) => t.taskId));
      const trulyMissed = missed.filter((k) => !already.has(k));
      console.warn(
        `[summary:export] 注意: --retask-keys の ${missed.length} 件は rework になりませんでした ` +
          `(既に missing/contract_violation: ${missed.length - trulyMissed.length} 件, ` +
          `今の D1 に無いキー: ${trulyMissed.length} 件)`,
      );
    }
  }
  console.info(`[summary:export] 書き出し先: ${out}`);
  if (tasks.length > 0) {
    console.info(
      "[summary:export] 次は: services/otakara-yutai/docs/llm-summary-task.md とこのファイルをクラウド LLM に渡して要約させ、\n" +
        `  pnpm yutai:summary:import --tasks ${out} --results <結果ファイル>  (dry-run で確認後 --apply)`,
    );
  }
}

main().catch((e) => {
  console.error("[summary:export] エラー:", e);
  process.exit(1);
});
