import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * workflow 直下の concurrency が pending を1件しか残さない形（既定
 * queue=single）だと、実行中の run がある状態で次の pending が来たとき
 * 先の pending が cancel される。
 * https://docs.github.com/en/actions/using-jobs/using-concurrency
 *
 * jobs.<id>.concurrency の queue: max は workflow 直下の置換 cancel を
 * 止めない。INC vwap-ingest は直下 group が原因だった。
 */

const WORKFLOWS = new URL("../../.github/workflows/", import.meta.url);

/** pending を後着で置換しうる workflow。queue: max だけがドキュメント上の回避。 */
const MUST_KEEP_PENDING = [
  ["vwap-ingest.yml", "${{ (inputs.target == 'scheduled-margin' || inputs.target == 'margin') && 'vwap-margin' || 'vwap-ingest' }}"],
  ["stock-sync.yml", "stock-sync"],
  ["catchup.yml", "catchup"],
  ["moneyflow.yml", "moneyflow-ingest"],
  ["supply_daily.yml", "supply_daily"],
  ["tdnet_hourly.yml", "tdnet_hourly"],
  ["edinet_daily.yml", "edinet_daily"],
] as const;

type WorkflowConcurrency = {
  group: string;
  cancelInProgress: boolean;
  /** 未設定はドキュメント上の既定 single。pending は1件で、次が先を cancel する。 */
  queue: "single" | "max" | undefined;
};

function rootKey(line: string): string | undefined {
  const match = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/.exec(line);
  if (!match) return undefined;
  return match[1];
}

function stripInlineComment(value: string): string {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || value[i - 1] === " " || value[i - 1] === "\t")) {
      return value.slice(0, i).trim();
    }
  }
  return value.trim();
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * workflow 直下の concurrency だけを読む。jobs 配下は列0の次キーで打ち切る。
 * 想定外の形は黙って single 扱いにせず throw する。
 */
export function parseWorkflowLevelConcurrency(source: string): WorkflowConcurrency | null {
  const lines = source.split(/\r?\n/);
  const roots: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (rootKey(lines[i]) === "concurrency") roots.push(i);
  }
  if (roots.length === 0) return null;
  if (roots.length > 1) {
    throw new Error("workflow 直下の concurrency が複数あります");
  }

  const header = lines[roots[0]];
  const inline = stripInlineComment(header.slice(header.indexOf(":") + 1));
  if (inline !== "") {
    return { group: unquote(inline), cancelInProgress: false, queue: undefined };
  }

  const fields = new Map<string, string>();
  for (let i = roots[0] + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (rootKey(line) !== undefined) break;
    const match = /^ {2}([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!match) {
      throw new Error(`concurrency の行を解釈できません: ${line}`);
    }
    const key = match[1];
    const raw = stripInlineComment(match[2]);
    if (raw === "" || raw === "|" || raw === ">" || raw.startsWith("|") || raw.startsWith(">")) {
      throw new Error(`concurrency.${key} は1行のスカラーである必要があります`);
    }
    if (fields.has(key)) throw new Error(`concurrency.${key} が重複しています`);
    fields.set(key, unquote(raw));
  }

  const group = fields.get("group");
  if (group === undefined || group === "") {
    throw new Error("concurrency.group がありません");
  }
  const cancelRaw = fields.get("cancel-in-progress");
  let cancelInProgress = false;
  if (cancelRaw !== undefined) {
    if (cancelRaw === "true") cancelInProgress = true;
    else if (cancelRaw === "false") cancelInProgress = false;
    else throw new Error(`cancel-in-progress が true/false ではありません: ${cancelRaw}`);
  }
  const queueRaw = fields.get("queue");
  let queue: "single" | "max" | undefined;
  if (queueRaw === undefined) queue = undefined;
  else if (queueRaw === "single" || queueRaw === "max") queue = queueRaw;
  else throw new Error(`queue の値が single/max ではありません: ${queueRaw}`);

  for (const key of fields.keys()) {
    if (key !== "group" && key !== "cancel-in-progress" && key !== "queue") {
      throw new Error(`未対応の concurrency キーです: ${key}`);
    }
  }
  return { group, cancelInProgress, queue };
}

function dropsPending(concurrency: WorkflowConcurrency): boolean {
  return concurrency.queue !== "max" || concurrency.cancelInProgress;
}

describe("workflow直下 concurrency は pending を置換しない", () => {
  it.each(MUST_KEEP_PENDING)("%s は queue: max かつ cancel-in-progress: false", (file, group) => {
    const source = readFileSync(new URL(file, WORKFLOWS), "utf8");
    const parsed = parseWorkflowLevelConcurrency(source);
    if (parsed === null) {
      throw new Error(`${file} に workflow 直下 concurrency がありません`);
    }
    expect(parsed.group).toBe(group);
    expect(parsed.queue).toBe("max");
    expect(parsed.cancelInProgress).toBe(false);
    expect(dropsPending(parsed)).toBe(false);
  });

  it("job 直下の queue: max は workflow 直下の pending 置換を隠さない", () => {
    const source = `
name: example
concurrency:
  group: vwap-ingest
  cancel-in-progress: false
jobs:
  ingest:
    concurrency:
      group: yahoo-source
      cancel-in-progress: false
      queue: max
    runs-on: ubuntu-latest
`;
    const parsed = parseWorkflowLevelConcurrency(source);
    expect(parsed).toEqual({
      group: "vwap-ingest",
      cancelInProgress: false,
      queue: undefined,
    });
    expect(parsed && dropsPending(parsed)).toBe(true);
  });

  it("queue: max は pending を100件まで残す形として読む", () => {
    const parsed = parseWorkflowLevelConcurrency(`
concurrency:
  group: catchup
  cancel-in-progress: false
  queue: max # pending を置換しない
`);
    expect(parsed).toEqual({
      group: "catchup",
      cancelInProgress: false,
      queue: "max",
    });
    expect(parsed && dropsPending(parsed)).toBe(false);
  });
});
