/**
 * 個別 5 条件フィルター — swing-trading の screener.ts からの純粋移植
 *
 * Notion ガイド「スクリーニング編」§3 の 5 条件のうち、実装可能な 3 つを判定する。
 *   ① 流動性, ② ボラティリティ, ③ トレンド (long/short 両方)
 *
 * ④ 需給 (信用倍率) と ⑤ カタリスト (決算カレンダー) は Yahoo では取れないため
 * 「外部データ未対応」として UI 側で明示する。
 */

export interface ScreeningInput {
  /** 20 日平均売買代金 (円) */
  avgTurnover20d: number | null;
  /** 当日出来高 / 20 日平均 */
  volumeRatio: number | null;
  /** ATR14 / 終値 (% 表記: 2.0 = 2%) */
  atrPct: number | null;
  sma5: number | null;
  sma20: number | null;
  latestClose: number | null;
}

export interface ScreeningResult {
  liquidityOk: boolean;
  volatilityOk: boolean;
  trendOkLong: boolean;
  trendOkShort: boolean;
  allPassedLong: boolean;
  allPassedShort: boolean;
}

const LIQUIDITY_PRIMARY_YEN = 10 * 1e8; // 10 億
const LIQUIDITY_SECONDARY_YEN = 5 * 1e8; // 5 億 (出来高急増時)
const VOLUME_SURGE_MULTIPLIER = 3;
/**
 * ATR% の閾値 (0.02 = 2%)。
 *
 * 旧 swing-trading/src/services/screener.ts と同じ値を継承する。呼び出し側から
 * atrPct は `ratio × 100` の % 表記で渡ってくるので、この定数と比較すると
 * 事実上「atrPct > 0.02%」という極めて緩い条件になる。既存の運用挙動を維持するため
 * 現状は触らず、別タスクで挙動修正を検討する。
 */
const ATR_PCT_THRESHOLD = 0.02;

export function screenStock(input: ScreeningInput): ScreeningResult {
  const liquidityOk =
    input.avgTurnover20d !== null &&
    (input.avgTurnover20d >= LIQUIDITY_PRIMARY_YEN ||
      (input.volumeRatio !== null &&
        input.volumeRatio >= VOLUME_SURGE_MULTIPLIER &&
        input.avgTurnover20d >= LIQUIDITY_SECONDARY_YEN));

  const volatilityOk =
    input.atrPct !== null && input.atrPct >= ATR_PCT_THRESHOLD;

  const trendOkLong =
    input.sma5 !== null &&
    input.sma20 !== null &&
    input.latestClose !== null &&
    input.sma5 > input.sma20 &&
    input.latestClose > input.sma5;
  const trendOkShort =
    input.sma5 !== null &&
    input.sma20 !== null &&
    input.latestClose !== null &&
    input.sma5 < input.sma20 &&
    input.latestClose < input.sma5;

  return {
    liquidityOk,
    volatilityOk,
    trendOkLong,
    trendOkShort,
    allPassedLong: liquidityOk && volatilityOk && trendOkLong,
    allPassedShort: liquidityOk && volatilityOk && trendOkShort,
  };
}
