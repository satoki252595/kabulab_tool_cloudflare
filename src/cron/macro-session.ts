/**
 * マクロ用 confirmed-bar 選択 (session meta 基準)。
 *
 * `fetchChart(..., { onRaw })` の同一 actual JSON から
 * `meta.currentTradingPeriod.regular.{start,end}` と
 * `exchangeTimezoneName` を読み、現形成 session のバーを除外した上で
 * 実終値つき confirmed bar の close + 直前 actual close を返す。
 * generic の価格選択・ParsedSchema は再実装しない (bars は fetchChart 戻り)。
 *
 * 確認は SOURCE の session end/timezone だけで行う。固定 16:00/15:30
 * cutoff・UTC 前日・休日推測は禁止。meta 不十分は explicit HOLD
 * (throw)。HOLD 時も older-bar の clear-date 状況は正直に記録するが
 * confirm には使わない。
 */
import type { DailyOhlcv } from "../shared/types.js";

export interface ConfirmedCloses {
  /** 最新 confirmed bar の close (実終値)。無ければ null */
  value: number | null;
  /** 直前 confirmed bar の close。無ければ null */
  prev: number | null;
  /** value バーの日付。無ければ null */
  date: string | null;
}

export function selectConfirmedCloses(
  raw: Uint8Array,
  bars: DailyOhlcv[],
  nowMs: number,
  symbol: string
): ConfirmedCloses {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new Error(`マクロ HOLD: ${symbol} の原文 JSON を読めません`);
  }
  const meta = (json as { chart?: { result?: Array<{ meta?: unknown }> } })
    ?.chart?.result?.[0]?.meta as
    | {
      currentTradingPeriod?: { regular?: { start?: unknown; end?: unknown } };
      exchangeTimezoneName?: unknown;
    }
    | undefined;
  const regular = meta?.currentTradingPeriod?.regular;
  const start = regular?.start;
  const end = regular?.end;
  const tz = meta?.exchangeTimezoneName;
  const okMeta =
    typeof start === "number" &&
    Number.isFinite(start) &&
    typeof end === "number" &&
    Number.isFinite(end) &&
    typeof tz === "string" &&
    tz !== "";
  if (!okMeta) {
    throw new Error(
      `マクロ HOLD: ${symbol} の session meta 不足のため形成中判定不可 ` +
        `(${olderBarEvidence(bars)})`
    );
  }
  const nowSec = Math.floor(nowMs / 1000);
  const forming = (start as number) <= nowSec && nowSec < (end as number);
  let eligible = bars;
  if (forming) {
    let sessionDate: string;
    try {
      sessionDate = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz as string,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date((end as number) * 1000));
    } catch {
      throw new Error(
        `マクロ HOLD: ${symbol} の exchange tz 不正 (${String(tz)}) ` +
          `(${olderBarEvidence(bars)})`
      );
    }
    eligible = bars.filter((b) => b.date < sessionDate);
  }
  const withClose = eligible.filter((b) => b.close !== null);
  const last = withClose.at(-1);
  const prevBar = withClose.at(-2);
  return {
    value: last?.close ?? null,
    prev: prevBar?.close ?? null,
    date: last?.date ?? null,
  };
}

/** HOLD 診断用に older-bar の状況だけ正直に記録する (confirm には使わない)。 */
function olderBarEvidence(bars: DailyOhlcv[]): string {
  const last = bars.at(-1)?.date ?? "なし";
  const lastClose =
    [...bars].reverse().find((b) => b.close !== null)?.date ?? "なし";
  return `最終バー ${last}・直近実終値バー ${lastClose}`;
}
