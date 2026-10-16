import "dotenv/config";
import { readFileSync } from "node:fs";
import { sharedEnv } from "../../src/shared/env.js";
import { SOURCES, parseOnlyArg } from "./ingest.js";
import { joinMoneyflowSummaries } from "./lib/source-summary.js";

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const values = args.filter(x => x.startsWith(`--${name}=`));
  if (values.length > 1) throw new Error(`--${name}の重複指定です`);
  return values[0]?.slice(name.length + 3);
};
const dir = arg("dir");
if (!dir) throw new Error("moneyflow joinのsummary directoryがありません");
const result = joinMoneyflowSummaries({
  requested: parseOnlyArg(args, SOURCES), all: SOURCES,
  runId: `${sharedEnv.GITHUB_RUN_ID()}.${sharedEnv.GITHUB_RUN_ATTEMPT()}`,
  summaries: ["non-yahoo", "yahoo"].map(lane => JSON.parse(readFileSync(`${dir}/${lane}.json`, "utf8"))),
  plannedDate: arg("scheduled-date"), nowMs: Date.now(), dryRun: args.includes("--dry-run"),
});
console.info(JSON.stringify({ moneyflowSourceJoin: result }));
