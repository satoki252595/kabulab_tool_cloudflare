/**
 * お宝優待 (002) のスコアリングエンジン
 *
 * otakara-yutai の `src/services/scoring.ts` からの純粋移植 (純粋関数部分のみ)。
 * DB I/O を伴う `scoreAllStocks` は月次オーケストレータに移動した。ここでは
 * 入力 → 出力の単体テスト可能なロジックだけを定義する。
 *
 * スコア設計:
 *   ファンダメンタル 60% + テクニカル 40%
 *   ファンダメンタル: PER (25) / PBR (20) / 配当利回り (25) / ROE (15) / 優待利回り (15)
 *   テクニカル      : MA25乖離率 (45) / RSI (35) / MACD (20)
 *
 * null 指標は按分ルールで他の指標に重みを振り分ける。
 */

export interface ScoringInput {
  price: number | null;
  per: number | null;
  pbr: number | null;
  dividendYield: number | null;
  roe: number | null;
  ma25: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  yutaiYield: number | null;
}

export interface ScoreBreakdown {
  fundamentalScore: number;
  technicalScore: number;
  totalScore: number;
  details: {
    perScore: number;
    pbrScore: number;
    dividendYieldScore: number;
    roeScore: number;
    yutaiYieldScore: number;
    maDeviationScore: number;
    rsiScore: number;
    macdScore: number;
  };
}

// -----------------------------------------------------------------------------
// 個別指標スコア
// -----------------------------------------------------------------------------

function scorePER(per: number | null): number {
  if (per === null) return 0;
  if (per < 10) return 100;
  if (per < 15) return 80;
  if (per < 20) return 60;
  if (per < 30) return 40;
  return 20;
}

function scorePBR(pbr: number | null): number {
  if (pbr === null) return 0;
  if (pbr < 0.5) return 100;
  if (pbr < 1.0) return 80;
  if (pbr < 1.5) return 60;
  if (pbr < 2.0) return 40;
  return 20;
}

function scoreDividendYield(dy: number | null): number {
  if (dy === null) return 0;
  if (dy > 5) return 100;
  if (dy >= 4) return 80;
  if (dy >= 3) return 60;
  if (dy >= 2) return 40;
  if (dy >= 1) return 20;
  return 10;
}

function scoreROE(roe: number | null): number {
  if (roe === null) return 0;
  const roePct = roe > 1 ? roe : roe * 100;
  if (roePct > 15) return 100;
  if (roePct >= 10) return 80;
  if (roePct >= 5) return 60;
  if (roePct >= 0) return 40;
  return 20;
}

function scoreYutaiYield(y: number | null): number {
  if (y === null) return 0;
  if (y > 5) return 100;
  if (y >= 3) return 80;
  if (y >= 2) return 60;
  if (y >= 1) return 40;
  return 20;
}

function scoreMACD(
  macd: number | null,
  macdSignal: number | null
): number {
  if (macd === null || macdSignal === null) return 0;
  if (macd > macdSignal && macd < 0 && macdSignal < 0) return 100;
  if (macd > macdSignal) return 60;
  return 20;
}

function scoreMADeviation(
  price: number | null,
  ma25: number | null
): number {
  if (price === null || ma25 === null || ma25 === 0) return 0;
  const deviation = ((price - ma25) / ma25) * 100;
  if (deviation < -10) return 100;
  if (deviation < -5) return 80;
  if (deviation < 0) return 60;
  if (deviation < 5) return 40;
  return 20;
}

function scoreRSI(rsi14: number | null): number {
  if (rsi14 === null) return 0;
  if (rsi14 < 30) return 100;
  if (rsi14 < 40) return 80;
  if (rsi14 < 50) return 60;
  if (rsi14 < 60) return 40;
  if (rsi14 < 70) return 20;
  return 10;
}

// -----------------------------------------------------------------------------
// 按分ユーティリティ
// -----------------------------------------------------------------------------

function calculateWeightedScore(
  indicators: { score: number; weight: number; hasValue: boolean }[]
): number {
  const totalActiveWeight = indicators
    .filter((i) => i.hasValue)
    .reduce((sum, i) => sum + i.weight, 0);
  if (totalActiveWeight === 0) return 0;
  return indicators
    .filter((i) => i.hasValue)
    .reduce(
      (sum, i) => sum + i.score * (i.weight / totalActiveWeight),
      0
    );
}

// -----------------------------------------------------------------------------
// 公開関数
// -----------------------------------------------------------------------------

export function calculateFundamentalScore(data: ScoringInput): {
  score: number;
  details: {
    perScore: number;
    pbrScore: number;
    dividendYieldScore: number;
    roeScore: number;
    yutaiYieldScore: number;
  };
} {
  const perScore = scorePER(data.per);
  const pbrScore = scorePBR(data.pbr);
  const dividendYieldScore = scoreDividendYield(data.dividendYield);
  const roeScore = scoreROE(data.roe);
  const yutaiYieldScore = scoreYutaiYield(data.yutaiYield);

  const indicators = [
    { score: perScore, weight: 0.25, hasValue: data.per !== null },
    { score: pbrScore, weight: 0.2, hasValue: data.pbr !== null },
    { score: dividendYieldScore, weight: 0.25, hasValue: data.dividendYield !== null },
    { score: roeScore, weight: 0.15, hasValue: data.roe !== null },
    { score: yutaiYieldScore, weight: 0.15, hasValue: data.yutaiYield !== null },
  ];

  return {
    score: Math.round(calculateWeightedScore(indicators) * 100) / 100,
    details: { perScore, pbrScore, dividendYieldScore, roeScore, yutaiYieldScore },
  };
}

export function calculateTechnicalScore(data: ScoringInput): {
  score: number;
  details: {
    maDeviationScore: number;
    rsiScore: number;
    macdScore: number;
  };
} {
  const maDeviationScore = scoreMADeviation(data.price, data.ma25);
  const rsiScore = scoreRSI(data.rsi14);
  const macdScore = scoreMACD(data.macd, data.macdSignal);

  const hasMaDeviation =
    data.price !== null && data.ma25 !== null && data.ma25 !== 0;
  const hasRsi = data.rsi14 !== null;
  const hasMacd = data.macd !== null && data.macdSignal !== null;

  const indicators = [
    { score: maDeviationScore, weight: 0.45, hasValue: hasMaDeviation },
    { score: rsiScore, weight: 0.35, hasValue: hasRsi },
    { score: macdScore, weight: 0.2, hasValue: hasMacd },
  ];

  return {
    score: Math.round(calculateWeightedScore(indicators) * 100) / 100,
    details: { maDeviationScore, rsiScore, macdScore },
  };
}

export function calculateTotalScore(
  fundamental: number,
  technical: number
): number {
  const score = fundamental * 0.6 + technical * 0.4;
  return Math.round(score * 100) / 100;
}

export function scoreStock(data: ScoringInput): ScoreBreakdown {
  const fundamental = calculateFundamentalScore(data);
  const technical = calculateTechnicalScore(data);
  const totalScore = calculateTotalScore(fundamental.score, technical.score);

  return {
    fundamentalScore: fundamental.score,
    technicalScore: technical.score,
    totalScore,
    details: {
      ...fundamental.details,
      ...technical.details,
    },
  };
}
