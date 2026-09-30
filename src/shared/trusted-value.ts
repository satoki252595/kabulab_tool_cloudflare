/**
 * 推定値の共有 trust 境界 (最小)。利回り・スコア・公開面の金額表示は、
 * `estimate_value_source = 'company'` の行の値だけ使う。由来の無い
 * (source NULL) 非 null 値は金額計算に入れない — 利回りの分子にすると
 * 根拠の無い利回りが出る (residual33)。description は見ないので
 * 公開バンドルに入れてもライセンス文言に触れない。
 *
 * company 開示の 0 は 0 のまま通す (呼び出し側の calc が null に畳む。
 * 行の有無と値の表示は呼び出し側が区別する)。
 */
export function trustedEstimateValue(row: {
  estimatedValue: number | null;
  estimateValueSource: string | null;
}): number | null {
  if (row.estimateValueSource !== "company") return null;
  return row.estimatedValue;
}
