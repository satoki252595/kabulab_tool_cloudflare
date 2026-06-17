/**
 * Engine 1 ルール: 業績予想の修正 PDF → positive/negative/mixed/unknown
 *
 * 適時開示「業績予想の修正」は東証様式テンプレに強く拘束され、
 *   売上高 / 営業利益 / 経常利益 / 親会社株主に帰属する当期純利益
 * の 4 指標について「前回発表予想 (A) → 今回修正予想 (B) → 増減額/率」
 * を表で記載するのが慣行。本ルールは:
 *
 * 1. 4 指標それぞれで「前回 → 今回」のペアを抽出
 * 2. **営業利益** を primary key (= 株主還元・PER 直結指標として優先) として方向判定
 * 3. 営業利益が抽出できない場合は経常利益 → 親会社株主に帰属する当期純利益
 *    の順でフォールバック
 * 4. **指標で割れ** (例: 売上+, 営業利益-) は `mixed` で正直に返す
 * 5. 全 4 指標で前回=今回(変化なし) は `unknown` (横ばいに方向はない)
 * 6. 抽出 0 件は `unknown`
 *
 * primary key 不明確は片寄せ禁止 (ルール2: silent fallback しない)。
 */
import type { PdfSentimentResult } from "../types.js";
import { unknown } from "../types.js";
import { extractBeforeAfter } from "./numbers.js";

const PRIORITY_KEYS = [
  "営業利益",
  "経常利益",
  "親会社株主に帰属する当期純利益",
  "当期純利益",
  "売上高",
] as const;

interface MetricMove {
  key: string;
  before: number;
  after: number;
  direction: "up" | "down" | "flat";
}

function direction(before: number, after: number): MetricMove["direction"] {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return "flat";
  if (after > before) return "up";
  if (after < before) return "down";
  return "flat";
}

export function classifyForecastRevision(text: string): PdfSentimentResult {
  const moves: MetricMove[] = [];
  for (const key of PRIORITY_KEYS) {
    const pair = extractBeforeAfter(text, key, ["円", "百万円", "千円", "億円"]);
    if (!pair) continue;
    moves.push({
      key,
      before: pair.before,
      after: pair.after,
      direction: direction(pair.before, pair.after),
    });
  }

  if (moves.length === 0) {
    return unknown("業績予想テーブルから数値ペアを抽出できなかった");
  }

  // 「親会社株主に帰属する当期純利益」が出てきていれば、汎用の「当期純利益」は
  // 取り除く (同一指標の二重カウント回避)
  const hasParent = moves.some(
    (m) => m.key === "親会社株主に帰属する当期純利益"
  );
  const dedupedMoves = hasParent
    ? moves.filter((m) => m.key !== "当期純利益")
    : moves;

  // primary key 探索: PRIORITY_KEYS 順で最初に見つかった (flat 以外) 指標を採用
  const primary = dedupedMoves.find((m) => m.direction !== "flat");
  if (!primary) {
    return unknown(
      `業績予想テーブルは抽出できたが全指標が前回=今回 (key=${dedupedMoves
        .map((m) => m.key)
        .join("/")})`
    );
  }

  // primary 以外の指標が逆方向に動いていれば mixed
  const hasOpposite = dedupedMoves.some(
    (m) =>
      m.direction !== "flat" &&
      m !== primary &&
      m.direction !== primary.direction
  );
  if (hasOpposite) {
    const opposites = dedupedMoves
      .filter(
        (m) =>
          m.direction !== "flat" &&
          m !== primary &&
          m.direction !== primary.direction
      )
      .map((m) => `${m.key}=${m.direction}`)
      .join(",");
    return {
      sentiment: "mixed",
      method: "rule_v1",
      score: 1.0,
      rationale: `primary=${primary.key}(${primary.direction}), 反対方向=${opposites}`,
    };
  }

  return {
    sentiment: primary.direction === "up" ? "positive" : "negative",
    method: "rule_v1",
    score: 1.0,
    rationale: `primary=${primary.key} ${primary.before}→${primary.after}`,
  };
}
