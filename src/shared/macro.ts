/**
 * マクロ環境判定 — swing-trading の macro.ts からの純粋移植
 *
 * Notion ガイド「スクリーニング編」§1 の A/B/C/D 判定。
 *
 * 日経VI が取れない場合は "HOLD" (判定保留) を返す。silent fallback で
 * B 判定にしないこと。VIX が上がって S&P500 が下がる場合は D と判定する。
 */

export interface MacroInput {
  nikkeiVi: number | null;
  topixTurnoverRatio: number | null;
  futuresGap: number | null;
  vix: number | null;
  sp500Pct: number | null;
}

export interface MacroResult {
  judgment: "A" | "B" | "C" | "D" | "HOLD";
  reason: string;
}

export function judgeMacro(input: MacroInput): MacroResult {
  if (input.nikkeiVi === null) {
    const detail = [
      input.vix !== null ? `VIX=${input.vix.toFixed(1)}` : null,
      input.sp500Pct !== null ? `S&P500=${input.sp500Pct.toFixed(2)}%` : null,
      input.futuresGap !== null
        ? `先物ギャップ=${input.futuresGap.toFixed(0)}円`
        : null,
    ]
      .filter(Boolean)
      .join(" / ");
    return {
      judgment: "HOLD",
      reason: `日経VI 取得不能のため判定保留${detail ? " (参考: " + detail + ")" : ""}`,
    };
  }

  const vi = input.nikkeiVi;

  if (vi > 35) {
    return {
      judgment: "D",
      reason: `日経VI ${vi.toFixed(1)} (35 超・嵐) → 見送り`,
    };
  }
  if (
    input.vix !== null &&
    input.sp500Pct !== null &&
    input.vix > 20 &&
    input.sp500Pct <= -1
  ) {
    return {
      judgment: "D",
      reason: `VIX ${input.vix.toFixed(1)} 超 & S&P500 ${input.sp500Pct.toFixed(2)}% → 米国悪化・見送り`,
    };
  }

  const turnoverOk =
    input.topixTurnoverRatio !== null && input.topixTurnoverRatio >= 1.2;
  const turnoverNormal =
    input.topixTurnoverRatio !== null &&
    input.topixTurnoverRatio >= 0.8 &&
    input.topixTurnoverRatio < 1.2;
  const turnoverLow =
    input.topixTurnoverRatio !== null && input.topixTurnoverRatio < 0.8;
  const gapSmall =
    input.futuresGap !== null && Math.abs(input.futuresGap) <= 200;

  let judgment: "A" | "B" | "C" | "D" | "HOLD";
  let reason: string;

  if (vi >= 30 && vi <= 35) {
    judgment = "C";
    reason = `日経VI ${vi.toFixed(1)} (30-35・慎重ゾーン)`;
    if (turnoverLow) reason += " / 売買代金 < 0.8x";
  } else if (vi > 25 && vi < 30) {
    judgment = "B";
    reason = `日経VI ${vi.toFixed(1)} (25-30・通常ゾーン)`;
    if (turnoverNormal) reason += " / 売買代金平均";
  } else if (vi >= 20 && vi <= 25 && turnoverOk && gapSmall) {
    judgment = "A";
    reason = `日経VI ${vi.toFixed(1)} / 売買代金 ${input.topixTurnoverRatio!.toFixed(2)}x / ギャップ${input.futuresGap!.toFixed(0)}円 → 積極`;
  } else if (vi >= 20 && vi <= 25) {
    judgment = "B";
    reason = `日経VI ${vi.toFixed(1)} (20-25だが売買代金/ギャップが条件未達)`;
  } else if (vi < 20) {
    judgment = "B";
    reason = `日経VI ${vi.toFixed(1)} (低すぎ・通常扱い)`;
  } else {
    judgment = "C";
    reason = `日経VI ${vi.toFixed(1)}`;
  }

  const extras: string[] = [];
  if (input.vix !== null) extras.push(`VIX=${input.vix.toFixed(1)}`);
  if (input.sp500Pct !== null)
    extras.push(`SP500=${input.sp500Pct.toFixed(2)}%`);
  if (extras.length > 0) reason += " / " + extras.join(" ");

  return { judgment, reason };
}
