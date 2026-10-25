/** Linux定時入口。既存の機械文法・金額検証・原子取込だけを共有writer下で実行する。 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  withSharedPublishingWriter,
  type PublishingStore,
} from "../../../scripts/mechanical-publishing/shared-writer.js";
import {
  dependencies,
  parseLocalArgs,
  runLocalSummary,
  type LocalDependencies,
  type LocalOptions,
  type LocalReport,
} from "./summary-local.js";

/** モデル許可は入口で拒否する。deps生成時にもモデル実行やモデル用env読取は行わない。 */
export async function runMechanicalSummary(
  options: LocalOptions & { sourceDeadlineMs?: number },
  createDependencies: () => LocalDependencies = dependencies,
  store?: PublishingStore,
): Promise<LocalReport> {
  if (options.allowModel === true) throw new Error("mechanical_summary_model_forbidden");
  if (options.reviewedInput !== undefined) throw new Error("mechanical_summary_reviewed_forbidden");
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 60 || !options.stateDir.trim())
    throw new Error("mechanical_summary_invalid_options");
  const assertStart = () => {
    if (options.sourceDeadlineMs !== undefined &&
        (!Number.isSafeInteger(options.sourceDeadlineMs) || Date.now() >= options.sourceDeadlineMs))
      throw new Error("mechanical_summary_start_deadline");
  };
  assertStart();
  return withSharedPublishingWriter(() => {
    // 最大60群の原子batch。開始前だけsoftを確認し、開始済PRE→POSTは共通hardまで閉鎖する。
    assertStart();
    return runLocalSummary({ ...options, allowModel: false }, {
      ...createDependencies(),
      generate: async () => { throw new Error("mechanical_summary_model_forbidden"); },
    });
  }, store);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMechanicalSummary(parseLocalArgs(process.argv.slice(2))).then(report => {
    console.info(`[yutai:summary:mechanical] ${JSON.stringify(report)}`);
    if (report.rejected > 0) process.exitCode = 1;
  }).catch(() => {
    console.error("[yutai:summary:mechanical] STOP。私有証跡を確認してください。再試行しません。");
    process.exitCode = 1;
  });
}
