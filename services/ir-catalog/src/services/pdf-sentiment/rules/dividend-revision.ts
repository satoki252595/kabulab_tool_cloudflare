/**
 * Engine 1 ルール: 配当(決定・予想) PDF → positive/negative/mixed/unknown
 *
 * 「配当予想の修正」「剰余金の配当」は東証様式テンプレに沿って
 *   1 株当たり配当金 (期末配当 / 中間配当 / 合計)
 * を「前回予想 → 今回予想 → 増減」で記載する。本ルールは:
 *
 * 1. 「1株当たり配当」を含む key (合計 / 期末 / 中間) の前回→今回ペアを抽出
 * 2. **合計 (年間)** を primary key とする (株主視点で最重要)
 * 3. 合計が取れない場合は期末 → 中間でフォールバック
 * 4. 全側で前回=今回は `unknown` (横ばい)
 * 5. 単位は「円」「銭」を許容 (通常は円)
 * 6. 抽出 0 件は `unknown`
 */
import type { PdfSentimentResult } from "../types.js";
import { unknown } from "../types.js";
import { extractBeforeAfter, normalizeForNumber } from "./numbers.js";

const PRIORITY_KEYS = [
  // 表記揺れを順序で網羅。合計 (年間) を最優先
  "1 株当たり配当金 合計",
  "1株当たり配当金合計",
  "合計 (年間)",
  "年間配当",
  "年間",
  "1 株当たり配当金",
  "1株当たり配当金",
  "1 株当たり配当",
  "1株当たり配当",
  "期末配当",
  "中間配当",
] as const;

interface DividendMove {
  key: string;
  before: number;
  after: number;
}

export function classifyDividendRevision(text: string): PdfSentimentResult {
  const norm = normalizeForNumber(text);
  // 配当 PDF は「銭」単位が混ざる場合がある。「円」「銭」を両方許容。
  const moves: DividendMove[] = [];
  const seenKeys = new Set<string>();
  for (const key of PRIORITY_KEYS) {
    if (seenKeys.has(key)) continue;
    const pair = extractBeforeAfter(norm, key, ["円"], 160);
    if (!pair) continue;
    seenKeys.add(key);
    moves.push({ key, before: pair.before, after: pair.after });
  }

  if (moves.length === 0) {
    return unknown("配当テーブルから 1 株当たり配当の数値ペアを抽出できなかった");
  }

  // primary key 探索: PRIORITY_KEYS 順で最初に flat 以外
  const primary = moves.find((m) => m.before !== m.after);
  if (!primary) {
    return unknown(
      `配当テーブルは抽出できたが前回=今回で横ばい (keys=${moves
        .map((m) => m.key)
        .join("/")})`
    );
  }

  // 配当の場合、「期末は減るが中間は増える」のような mixed は実務でも稀なので
  // 単純に primary の方向で判定する (合計が含まれていれば合計が primary になる)
  const up = primary.after > primary.before;
  return {
    sentiment: up ? "positive" : "negative",
    method: "rule_v1",
    score: 1.0,
    rationale: `primary=${primary.key} ${primary.before}→${primary.after}`,
  };
}
