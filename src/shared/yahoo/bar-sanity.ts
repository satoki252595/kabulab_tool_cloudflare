/**
 * 日足バーの帯域チェック（取り込み時のサニティ）。
 *
 * Yahoo の Chart API は、ごくまれに桁の壊れたバーを返す。実害が出た例:
 *
 *   1909 日本ドライケミカル 2026-09-11
 *     close = 16,278,046,720 / volume = 0（前日終値 3,700）
 *   → pct_change_1d が 439,947,108.65% になり業種平均を汚染し、
 *     003 のトップページに「機械 +2,105,009.25%」が表示された
 *
 * 値が桁外れであること自体は「正しい急変」と区別できないが、
 * **出来高 0 で価格だけが数百万倍**という組み合わせは市場では起こらない。
 * 推定で直さず、**その1本を採用しない**（§3-1: 欠測は欠測のまま）。
 * 前後のバーは通すので、指標は 1 本欠けた状態で計算される。
 */

// 型を再定義しない。同じ概念を 2 箇所で持つと必ず食い違う。
import type { DailyOhlcv } from "../types.js";

export type Bar = DailyOhlcv;

/** 前日比の許容上限（倍）。ストップ高の連続でもこれは超えない。 */
export const MAX_DAILY_RATIO = 10;

/**
 * 棄却の理由。呼び出し側がログ・記録に使う。
 *
 * **「終値が高安のレンジ外」は棄却理由に入れない。** 本番 336,170 本を調べると
 * 18 本が該当したが、最大乖離率は 1.695%（例: 7112 の high 700 / low 698 /
 * close 697）で、Yahoo 側の丸めや取引時間の差によるもの。指標計算に実害は無く、
 * 弾くと正当なバーを 18 本失う。桁が壊れた本物の事故は `jump_without_volume`
 * が捕まえる（本番で該当したのは 1909 の 1 本だけ）。
 */
export type RejectReason =
  | "non_positive_close"
  | "high_low_inverted"
  | "jump_without_volume";

export type BarCheck = { ok: true } | { ok: false; reason: RejectReason };

/** 1 本のバーが単体で整合しているか。 */
export function checkBarSelf(bar: Bar): BarCheck {
  if (bar.close !== null && bar.close <= 0) {
    return { ok: false, reason: "non_positive_close" };
  }
  // 高安の逆転は構造的にあり得ない（本番実測 0 件）。
  if (bar.high !== null && bar.low !== null && bar.high < bar.low) {
    return { ok: false, reason: "high_low_inverted" };
  }
  return { ok: true };
}

/**
 * 直前のバーと比べて採用してよいか。
 *
 * 弾くのは「**出来高が無いのに価格が桁外れに動いた**」場合だけにする。
 * 出来高を伴う急変（ストップ高連続・TOB・株式分割の調整漏れ）は
 * 本物かもしれないので通す。誤って弾くほうが害が大きい。
 */
export function checkBarAgainstPrevious(bar: Bar, previous: Bar | null): BarCheck {
  const self = checkBarSelf(bar);
  if (!self.ok) return self;
  if (previous === null) return { ok: true };
  const prev = previous.close;
  const cur = bar.close;
  if (prev === null || cur === null || prev <= 0) return { ok: true };
  const ratio = cur / prev;
  const jumped = ratio > MAX_DAILY_RATIO || ratio < 1 / MAX_DAILY_RATIO;
  const noVolume = bar.volume === null || bar.volume === 0;
  if (jumped && noVolume) return { ok: false, reason: "jump_without_volume" };
  return { ok: true };
}

export type SanitizeResult = {
  bars: Bar[];
  rejected: { date: string; reason: RejectReason }[];
};

/**
 * 日付昇順のバー列から、採用できないバーを取り除く。
 *
 * 比較の基準は「直前に**採用した**バー」。壊れたバーを基準にすると
 * 次の正常なバーまで巻き込んで弾いてしまう。
 */
export function sanitizeBars(bars: readonly Bar[]): SanitizeResult {
  const out: Bar[] = [];
  const rejected: { date: string; reason: RejectReason }[] = [];
  let lastAccepted: Bar | null = null;
  for (const bar of bars) {
    const check = checkBarAgainstPrevious(bar, lastAccepted);
    if (check.ok) {
      out.push(bar);
      if (bar.close !== null) lastAccepted = bar;
    } else {
      rejected.push({ date: bar.date, reason: check.reason });
    }
  }
  return { bars: out, rejected };
}
