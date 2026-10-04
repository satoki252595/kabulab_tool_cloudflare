/** 独立市場sessionと同一原本の閉場証明。営業日/休日の推測はしない。 */
import { createHash } from "node:crypto";
import { fetchChart, type DailyResult, type YahooRawCapture } from "../../../src/shared/yahoo/client.js";
import { archiveYahooRawBatch, type YahooRawAttempt, type YahooRawMissing } from "../../../src/shared/yahoo/raw-custody.js";
import { selectConfirmedCloses } from "../../../src/cron/macro-session.js";
import { isCalendarDateString, isStrictIsoUtc, jstDateSec, tenYearRangeForDate } from "../../../src/shared/vwap/proof.js";
import { completedDailyFetch, sanitizeLogText, type DailySessionReference } from "./ingest-guard.js";

export type { DailySessionReference } from "./ingest-guard.js";

/** 通常共有benchmarkをrunに1回取得し、物理原本照合を完了してから返す。 */
export async function fetchDailySessionReference(runId: string): Promise<DailySessionReference> {
  const captures: YahooRawAttempt[] = [], missing: YahooRawMissing[] = [];
  let capture: YahooRawCapture | undefined;
  try {
    const chart = await fetchChart("^N225", "1mo", { onRaw: (raw) => {
      captures.push({ api: "chart", attempt: 1, capture: raw });
      capture = raw;
    } });
    if (captures.length !== 1 || capture === undefined || capture.symbol !== "^N225" || capture.status !== 200) {
      throw new Error("daily session HOLD: benchmarkの同一HTTP原本がありません");
    }
    const confirmed = selectConfirmedCloses(capture.bytes, chart.ohlcv, "^N225");
    const meta = JSON.parse(new TextDecoder().decode(capture.bytes)).chart?.result?.[0]?.meta;
    const regular = meta?.currentTradingPeriod?.regular;
    if (!isStrictIsoUtc(capture.receivedAt) || meta?.range !== "1mo" || meta?.exchangeTimezoneName !== "Asia/Tokyo" ||
        ![regular?.start, regular?.end, meta?.regularMarketTime].every((t) => typeof t === "number" && Number.isSafeInteger(t) && t > 0) ||
        regular.start >= regular.end || regular.timezone !== "JST" || regular.gmtoffset !== 32400 ||
        meta.regularMarketTime < regular.end || Date.parse(capture.receivedAt) / 1000 < meta.regularMarketTime ||
        [regular.start, regular.end, meta.regularMarketTime].some((t) => jstDateSec(t) !== confirmed.date)) {
      throw new Error("daily session HOLD: benchmarkの現在sessionが閉場済みではありません");
    }
    return { date: confirmed.date, observedAt: capture.receivedAt,
      rawSha: createHash("sha256").update(capture.bytes).digest("hex") };
  } catch (e) {
    if (captures.length === 0) missing.push({ api: "chart", symbol: "^N225", attempt: 1,
      failedAt: new Date().toISOString(), error: sanitizeLogText(e instanceof Error ? e.message : String(e)) });
    throw e;
  } finally {
    // 取得失敗/形成中HOLDも保管する。unknownは再送せず呼出元をSTOPする。
    await archiveYahooRawBatch({ service: "vwap-analysis", runId, stage: "vwap-daily-session", captures, missing });
  }
}

/**
 * sourceの10y窓を独立benchmark日と閉場済metaで資格化する。
 * 原SHA/受領clock/URL/全bars/eventsは変更しない。今日の日付へ読み替えない。
 * repairの上限は呼出元の実run日を維持し、より新しい旧行の欠落をHOLDする。
 */
export function qualifyDailySourceRange(
  fresh: DailyResult, capture: YahooRawCapture | undefined, reference: DailySessionReference
): { from: string; to: string } {
  if (!isCalendarDateString(reference.date) || !isStrictIsoUtc(reference.observedAt) ||
      !/^[0-9a-f]{64}$/.test(reference.rawSha) || capture === undefined ||
      !isStrictIsoUtc(capture.receivedAt) || capture.receivedAt !== fresh.proof.observedAt ||
      Date.parse(reference.observedAt) > Date.parse(capture.receivedAt) ||
      reference.date > jstDateSec(Date.parse(reference.observedAt) / 1000) ||
      jstDateSec(Date.parse(reference.observedAt) / 1000) !== jstDateSec(Date.parse(capture.receivedAt) / 1000)) {
    throw new Error("daily session HOLD: benchmark/原本の実受領証跡不一致");
  }
  const range = tenYearRangeForDate(reference.date);
  const outer = new URL(capture.url), target = outer.searchParams.has("u") ? new URL(outer.searchParams.get("u")!) : outer;
  const regular = JSON.parse(new TextDecoder().decode(capture.bytes)).chart?.result?.[0]?.meta?.currentTradingPeriod?.regular;
  if (target.protocol !== "https:" || !["query1.finance.yahoo.com", "query2.finance.yahoo.com"].includes(target.hostname) ||
      target.port !== "" || target.username !== "" || target.password !== "" ||
      decodeURIComponent(target.pathname) !== `/v8/finance/chart/${fresh.proof.symbol}` ||
      target.searchParams.get("range") !== "10y" || target.searchParams.get("interval") !== "1d" ||
      target.searchParams.get("events") !== "split,div" || regular?.timezone !== "JST" || regular?.gmtoffset !== 32400) {
    throw new Error("daily session HOLD: 原本の要求契約/session timezoneが一致しません");
  }
  if (completedDailyFetch(fresh, capture, range, reference) === null) {
    throw new Error("daily session HOLD: 独立benchmark日と閉場済session/全原本行が一致しません");
  }
  return range;
}
