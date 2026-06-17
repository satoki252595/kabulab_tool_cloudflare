/**
 * 優良株 (blue chip) 判定
 *
 * rsi-screening の `services/rsi-screening/src/services/blue-chip-filter.ts`
 * からの純粋移植。
 *
 * 現在の優良株定義:
 *   - 売上高が過去 3 年で増加基調 AND
 *   - 営業利益率 TTM が閾値以上
 *
 * 元々は「営業利益率の 3 年トレンド + 売上高の 3 年トレンド」だったが、
 * Yahoo Finance が 2025 年頃に無料 quoteSummary API から `operatingIncome` を
 * 削除した (`{}` を返す) ため、historical な営業利益率は計算不能。代わりに
 * `financialData.operatingMargins` (TTM 単一値) を使って現在の収益性を判定する。
 */

import type { AnnualFinancial } from "../types.js";

export interface BlueChipEvaluation {
  isBlueChip: boolean;
  /** 営業利益率 TTM (0.1234 = 12.34%) */
  operatingMarginTtm: number | null;
  /** 売上高トレンド: +1=上昇 / 0=横ばい / -1=下降 / null=判定不能 */
  revenueTrend: number | null;
}

/** 営業利益率 TTM の閾値 (日本株中央値付近 = 5%) */
export const OPERATING_MARGIN_TTM_THRESHOLD = 0.05;

/**
 * 時系列配列が「上昇基調」か判定する
 *
 * 最初→最後が +5% 以上増加 & 途中で -5% 超の年前年比下落が無ければ上昇基調。
 *
 * @returns +1=上昇 / 0=横ばい / -1=下降 / null=判定不能
 */
export function judgeTrend(values: (number | null)[]): number | null {
  const valid = values.filter(
    (v): v is number => v !== null && Number.isFinite(v)
  );
  if (valid.length < 2) return null;

  const first = valid[0];
  const last = valid[valid.length - 1];
  if (first === 0) return null;

  const totalChange = (last - first) / Math.abs(first);

  let hasSignificantDrop = false;
  let hasSignificantRise = false;
  for (let i = 1; i < valid.length; i++) {
    const prev = valid[i - 1];
    if (prev === 0) continue;
    const yoy = (valid[i] - prev) / Math.abs(prev);
    if (yoy < -0.05) hasSignificantDrop = true;
    if (yoy > 0.05) hasSignificantRise = true;
  }

  if (totalChange > 0.05 && !hasSignificantDrop) return 1;
  if (totalChange < -0.05 && !hasSignificantRise) return -1;
  return 0;
}

/**
 * 優良株判定
 *
 * @param annualFinancials - 年度財務 (古い→新しい順)
 * @param operatingMarginTtm - TTM 営業利益率
 */
export function evaluateBlueChip(
  annualFinancials: AnnualFinancial[],
  operatingMarginTtm: number | null
): BlueChipEvaluation {
  const recent = annualFinancials.slice(-3);

  if (recent.length < 3) {
    return { isBlueChip: false, operatingMarginTtm, revenueTrend: null };
  }

  const revenues = recent.map((f) => f.revenue);
  const revenueTrend = judgeTrend(revenues);

  const isBlueChip =
    revenueTrend === 1 &&
    operatingMarginTtm !== null &&
    operatingMarginTtm >= OPERATING_MARGIN_TTM_THRESHOLD;

  return { isBlueChip, operatingMarginTtm, revenueTrend };
}
