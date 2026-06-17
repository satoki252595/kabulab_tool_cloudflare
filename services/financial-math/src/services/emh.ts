/**
 * EMH アノマリー判定 — 純関数
 *
 * Notion 「金融数学入門」 で紹介された 4 つのアノマリー:
 *   1. PEAD (決算後ドリフト) — 決算日が外部データなしに取れないため、
 *      core.stock_financials.fetched_at の更新時刻を簡易代理として扱う。
 *   2. 小型株効果 — 時価総額閾値 (例: 500 億円未満)
 *   3. モメンタム — 過去 6-12 ヶ月リターン上位
 *   4. 低ボラ・アノマリー — 低ボラ銘柄のリスク調整後リターン
 *
 * 本ファイルは純関数のみ提供 (DB アクセスはルート側)。
 */

export interface MomentumScore {
  /** 直近リターン累積 (%、小数) */
  cumulativeReturn: number;
  /** 累積リターン / 年率ボラ (= シャープ比的指標、無リスク金利 0 と仮定) */
  riskAdjustedScore: number;
  /** 集計に使用した日数 */
  windowSize: number;
}

/**
 * 終値配列 (古い順) からモメンタムスコアを計算。
 *
 *   累積リターン = 終値[N-1] / 終値[0] - 1
 *   年率ボラ     = stdev(daily log return) × √252
 *   調整スコア   = 累積リターン / 年率ボラ
 *
 * window 日数のサンプルがない場合は null。
 */
export function calcMomentum(
  closes: ReadonlyArray<number | null>,
  window: number
): MomentumScore | null {
  const valid: number[] = [];
  for (const c of closes) {
    if (c !== null && Number.isFinite(c) && c > 0) valid.push(c);
  }
  if (valid.length < window) return null;

  const slice = valid.slice(-window);
  const first = slice[0];
  const last = slice[slice.length - 1];
  const cumulativeReturn = last / first - 1;

  // 日次ログリターン → 年率ボラ
  const logRets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    logRets.push(Math.log(slice[i] / slice[i - 1]));
  }
  const mean = logRets.reduce((a, b) => a + b, 0) / logRets.length;
  let sumSq = 0;
  for (const r of logRets) sumSq += (r - mean) * (r - mean);
  const stdev = Math.sqrt(sumSq / Math.max(logRets.length - 1, 1));
  const annualVol = stdev * Math.sqrt(252);

  const riskAdjustedScore = annualVol > 0 ? cumulativeReturn / annualVol : 0;
  return {
    cumulativeReturn,
    riskAdjustedScore,
    windowSize: window,
  };
}

/**
 * 小型株判定 (単純な閾値)。
 * @param marketCapYen 時価総額 (円)
 * @param thresholdYen 閾値 (円)。Notion ガイドのデフォルトは 500 億円。
 */
export function isSmallCap(marketCapYen: number | null, thresholdYen = 500e8): boolean {
  if (marketCapYen === null || !Number.isFinite(marketCapYen)) return false;
  return marketCapYen > 0 && marketCapYen < thresholdYen;
}

/**
 * 低ボラ判定。
 * @param atrPct ATR(14)/終値 × 100 (% 値)。例: 1.5 = 1.5%
 * @param threshold 閾値 (% 値)。デフォルト 1.5 = 1.5%
 *
 * 注意: kabulab DB の `swing.stock_indicators.atr_pct` は dividendYield と同じく
 * **% 値** で保存されている (decimal ではない)。本関数はそれに合わせて % 値前提。
 */
export function isLowVolatility(atrPct: number | null, threshold = 1.5): boolean {
  if (atrPct === null || !Number.isFinite(atrPct)) return false;
  return atrPct > 0 && atrPct < threshold;
}
