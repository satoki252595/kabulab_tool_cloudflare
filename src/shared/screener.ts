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
 * ATR% の閾値 (2 = 2%)。
 *
 * atrPct は呼び出し側 (`src/cron/daily.ts`) から `ratio × 100` の % 表記で
 * 渡ってくる。旧 swing-trading の `0.02` をそのまま継承していたため、事実上
 * 「atrPct > 0.02%」という極めて緩い条件になっていた (UI の「ATR% ≧ 2%」表示
 * とも食い違っていた)。% 表記に合わせて `2` に直す。
 */
const ATR_PCT_THRESHOLD = 2;

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
