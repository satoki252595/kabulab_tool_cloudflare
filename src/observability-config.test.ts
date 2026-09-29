import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * wrangler.toml の observability 設定の不変条件。
 *
 * - logs は有効 (将来の Worker 呼出ステータス + 既存 console ログを残す)。
 * - traces は無効のまま。EDINET 外向き URL に Subscription-Key を含むため、
 *   有効化するとキー付き URL がトレースに残る。変える場合は出向き URL の
 *   キー埋め込み方式の見直しとセットで行うこと。
 */

const TOML_PATH = new URL("../wrangler.toml", import.meta.url);

/**
 * 最小 TOML 読取。[section] スコープ内の `key = value` 行だけを抜く。
 * 値は boolean/number/文字列想定。見つからなければ throw (黙って通さない)。
 */
function sectionValues(text: string, section: string): Map<string, string> {
  const values = new Map<string, string>();
  let current: string | null = null;
  let found = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = header[1];
      if (current === section) found = true;
      continue;
    }
    if (current !== section) continue;
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line);
    if (!kv) {
      throw new Error(`wrangler.toml: [${section}] の行を解釈できません: ${line}`);
    }
    values.set(kv[1], kv[2]);
  }
  if (!found) {
    throw new Error(`wrangler.toml: [${section}] がありません`);
  }
  return values;
}

function required(values: Map<string, string>, key: string): string {
  const v = values.get(key);
  if (v === undefined) {
    throw new Error(`wrangler.toml: ${key} がありません`);
  }
  return v;
}

describe("wrangler.toml observability", () => {
  const text = readFileSync(TOML_PATH, "utf8");

  it("Worker ログ (呼出+console) が有効", () => {
    expect(required(sectionValues(text, "observability"), "enabled")).toBe("true");
    const logs = sectionValues(text, "observability.logs");
    expect(required(logs, "enabled")).toBe("true");
    expect(required(logs, "invocation_logs")).toBe("true");
    expect(required(logs, "head_sampling_rate")).toBe("1");
  });

  it("traces は無効のまま (EDINET Subscription-Key 漏出防止)", () => {
    const traces = sectionValues(text, "observability.traces");
    expect(required(traces, "enabled")).toBe("false");
  });
});
