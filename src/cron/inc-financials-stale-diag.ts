/**
 * INC-20261008-kabulab_tool_cloudflare-financials-stale 計測用ログ行の組み立て (純粋関数)。
 * 判定・例外・リトライ・既定値には使わない。値は日付・真偽・時刻だけで秘密を含まない。
 */
import type { DailyOhlcv } from "../shared/types.js";
import type { ConfirmedCloseDiag } from "./macro-session.js";

export const INC_FINANCIALS_STALE_TAG = "[INC-20261008-kabulab_tool_cloudflare-financials-stale]";

type BarLike = Pick<DailyOhlcv, "date" | "close" | "adj"> | undefined;

/** 株式 N225 鮮度ゲート直前の 1 行 (取得済みデータのみ使用)。 */
export function formatStockSessionDiag(
  ohlcv: readonly BarLike[],
  receivedAt: string | undefined,
  targetDate: string
): string {
  const latest = ohlcv.length > 0 ? ohlcv[ohlcv.length - 1] : undefined;
  const prev = ohlcv.length > 1 ? ohlcv[ohlcv.length - 2] : undefined;
  return `${INC_FINANCIALS_STALE_TAG} stocks-session ${JSON.stringify({
    targetDate,
    receivedAt: receivedAt ?? null,
    latestBarDate: latest?.date ?? null,
    latestCloseNull: latest === undefined ? null : latest.close === null,
    latestAdjNull: latest === undefined ? null : (latest.adj ?? null) === null,
    prevBarDate: prev?.date ?? null,
  })}`;
}

/** マクロ / VWAP の confirmed-close HOLD 理由の 1 行。 */
export function formatConfirmedHoldDiag(
  stage: "macro" | "vwap-daily-session",
  symbol: string,
  receivedAt: string | undefined,
  diag: ConfirmedCloseDiag
): string {
  return `${INC_FINANCIALS_STALE_TAG} ${stage} ${JSON.stringify({
    symbol,
    receivedAt: receivedAt ?? null,
    reason: diag.reason,
    candidateDate: diag.candidateDate,
    sessionDate: diag.sessionDate,
    ended: diag.ended,
  })}`;
}
