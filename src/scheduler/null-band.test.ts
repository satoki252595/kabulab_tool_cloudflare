/**
 * INC-20261008-kabulab_tool_cloudflare-financials-stale
 * 定時の株式取得が null 帯（D 23:30 JST 〜 D+1 朝）に入らないこと、
 * および ^N225 原文 fixture でゲートが D の実終値だけを通すことを固定する。
 * 旧 cron `13 17 * * MON-FRI`（02:13 JST）では cron 側の断言が落ちる。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseChartResponse } from "../shared/yahoo/client.js";
import { checkFreshClose, guardChartBars } from "../shared/yahoo/bar-sanity.js";
import { selectConfirmedCloses } from "../cron/macro-session.js";
import { formatNullBandHoldLog } from "../cron/inc-financials-stale-diag.js";
import {
  COMPLETION_CUTOFF_TIME,
  COMPLETION_FLOOR_TIME,
  CONTEXT_DISPATCH_CRON,
  CONTEXT_READCHECK_CRON,
  DISPATCH_CRON,
  DISPATCH_START_DEADLINE_MINUTES,
  READCHECK_CRON,
  evaluateReadcheck,
  resolveRunDate,
  routeCron,
  type RunJob,
} from "./stock.js";

/** docs/test-logs/stock-sync-asof-2026-09-28.md の実測最大 190.95 分。 */
const WORST_MINUTES = 191;
/** 最大開始遅延 176.23 分 + 最大実行 21.18 分（別 run の合算）。 */
const CONSERVATIVE_MINUTES = 197.41;
const TSE_CLOSE_MINUTES = 15 * 60 + 30;
const NULL_BAND_START_MINUTES = 23 * 60 + 30;
const D = "2026-10-08";
const CONFIRMED_CLOSE = 69042.109375;

const FX = join(dirname(fileURLToPath(import.meta.url)), "../cron/__fixtures__/inc-financials-stale");

function fx(name: string): { bytes: Uint8Array; json: unknown } {
  const bytes = readFileSync(join(FX, name));
  return { bytes, json: JSON.parse(new TextDecoder().decode(bytes)) };
}

function parseCron(cron: string): { minute: number; hour: number } {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* MON-FRI$/.exec(cron);
  if (match === null) throw new Error(`株式 dispatch cron の形が不正です: ${cron}`);
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) throw new Error(`株式 dispatch cron の時刻が不正です: ${cron}`);
  return { minute, hour };
}

/** cron の UTC 時刻を、同じ暦日の JST 分へ移す。日をまたぐときは null（JST の D ではない）。 */
function jstMinutesSameDate(cron: string): number | null {
  const { minute, hour } = parseCron(cron);
  const shifted = hour * 60 + minute + 9 * 60;
  if (shifted >= 24 * 60) return null;
  return shifted;
}

function finishesBeforeNullBand(cron: string, worstMinutes: number): boolean {
  const start = jstMinutesSameDate(cron);
  if (start === null) return false;
  if (start <= TSE_CLOSE_MINUTES) return false;
  return start + worstMinutes < NULL_BAND_START_MINUTES;
}

function jstDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

function stockJob(completedAt: string): RunJob {
  return {
    name: "sync",
    status: "completed",
    conclusion: "success",
    run_id: 101,
    steps: [
      { name: "stock daily sync", status: "completed", conclusion: "success", completed_at: completedAt },
      {
        name: "許容内失敗があれば Issue にコメント",
        status: "completed",
        conclusion: "skipped",
        completed_at: completedAt,
      },
    ],
  };
}

function gate(name: string) {
  const { bytes, json } = fx(name);
  const parsed = parseChartResponse(json, "^N225");
  const guarded = guardChartBars(parsed.bars, parsed.meta.regularMarketPrice, "^N225");
  const fresh = checkFreshClose(guarded.bars.at(-1), D);
  let confirmed: { ok: true; date: string; value: number } | { ok: false };
  try {
    const row = selectConfirmedCloses(bytes, guarded.bars, "^N225");
    confirmed = { ok: true, date: row.date, value: row.value };
  } catch {
    confirmed = { ok: false };
  }
  const dBars = guarded.bars.filter((bar) => bar.date === D);
  return { parsed, guarded, fresh, confirmed, dBars };
}

describe("株式 dispatch は null 帯の外（修正前の 13 17 では落ちる）", () => {
  it("旧 cron 13 17 は JST の D ではなく、最悪 191 分でも 23:30 前に終わらない", () => {
    expect(jstMinutesSameDate("13 17 * * MON-FRI")).toBeNull();
    expect(finishesBeforeNullBand("13 17 * * MON-FRI", WORST_MINUTES)).toBe(false);
    expect(() => routeCron("13 17 * * MON-FRI")).toThrow("未知の cron");
  });

  it("現行 DISPATCH_CRON は 18:00 JST で、最悪 191 分でも D 23:30 JST より前に終わる", () => {
    expect(DISPATCH_CRON).toBe("0 9 * * MON-FRI");
    expect(jstMinutesSameDate(DISPATCH_CRON)).toBe(18 * 60);
    expect(finishesBeforeNullBand(DISPATCH_CRON, WORST_MINUTES)).toBe(true);
    expect(finishesBeforeNullBand(DISPATCH_CRON, CONSERVATIVE_MINUTES)).toBe(true);
    const start = jstMinutesSameDate(DISPATCH_CRON);
    if (start === null) throw new Error("dispatch が JST の日付をまたぎます");
    expect(NULL_BAND_START_MINUTES - (start + WORST_MINUTES)).toBe(139);
    expect(NULL_BAND_START_MINUTES - (start + CONSERVATIVE_MINUTES)).toBeCloseTo(132.59, 2);
  });

  it("09:00 UTC の予定日は UTC 日＝JST の D で、土日と開始期限は従来どおり落とす", () => {
    const scheduled = Date.parse("2026-10-08T09:00:00.000Z");
    expect(resolveRunDate("dispatch", scheduled, scheduled + 30_000)).toBe(D);
    expect(jstDate(scheduled)).toBe(D);
    expect(DISPATCH_START_DEADLINE_MINUTES).toBe(60);
    expect(() => resolveRunDate("dispatch", scheduled, scheduled + 61 * 60_000)).toThrow("開始期限");
    const saturday = Date.parse("2026-10-10T09:00:00.000Z");
    expect(() => resolveRunDate("dispatch", saturday, saturday + 30_000)).toThrow("土日");
  });

  it("readcheck の完了窓は dispatch 以降、23:30 JST までで、21:00 UTC へ延ばさない", () => {
    expect(COMPLETION_FLOOR_TIME).toBe("09:00:00.000Z");
    expect(COMPLETION_CUTOFF_TIME).toBe("14:30:00.000Z");
    expect(READCHECK_CRON).toBe("35 14 * * MON-FRI");
    expect(Date.parse(`${D}T${COMPLETION_CUTOFF_TIME}`)).toBeLessThanOrEqual(Date.parse(`${D}T21:00:00.000Z`));
    expect(evaluateReadcheck([stockJob(`${D}T12:11:00.000Z`)], D)).toEqual({
      stockCompletedAt: `${D}T12:11:00.000Z`,
    });
    expect(evaluateReadcheck([stockJob(`${D}T09:00:00.000Z`)], D).stockCompletedAt).toBe(`${D}T09:00:00.000Z`);
    expect(evaluateReadcheck([stockJob(`${D}T14:30:00.000Z`)], D).stockCompletedAt).toBe(`${D}T14:30:00.000Z`);
    expect(() => evaluateReadcheck([stockJob(`${D}T08:59:59.000Z`)], D)).toThrow("09:00 UTC より前");
    expect(() => evaluateReadcheck([stockJob(`${D}T14:30:01.000Z`)], D)).toThrow("14:30 UTC を超過");
    expect(() => evaluateReadcheck([stockJob(`${D}T20:30:00.000Z`)], D)).toThrow("14:30 UTC を超過");
  });

  it("マクロの cron は残し、wrangler の株式 cron だけが新しい時刻になる", () => {
    expect(CONTEXT_DISPATCH_CRON).toBe("0 21 * * MON-FRI");
    expect(CONTEXT_READCHECK_CRON).toBe("5 22 * * MON-FRI");
    const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
    expect(toml).toContain(`"${DISPATCH_CRON}"`);
    expect(toml).toContain(`"${READCHECK_CRON}"`);
    expect(toml).toContain('"0 21 * * MON-FRI"');
    expect(toml).toContain('"5 22 * * MON-FRI"');
    expect(toml).not.toContain('"13 17 * * MON-FRI"');
    expect(toml).not.toContain('"5 21 * * MON-FRI"');
  });

  it("21:15 JST 以降に始めると最悪 191 分では 23:30 前に終わらない", () => {
    const starts = [21 * 60 + 15, 21 * 60 + 30, 22 * 60, 22 * 60 + 30, 23 * 60];
    for (const start of starts) {
      expect(start + WORST_MINUTES < NULL_BAND_START_MINUTES).toBe(false);
      expect(start + CONSERVATIVE_MINUTES < NULL_BAND_START_MINUTES).toBe(false);
    }
  });
});

describe("^N225 原文 fixture（D=2026-10-08）", () => {
  it.each(["20261008T211500.json", "20261008T233000.json"])(
    "%s は D の実終値で通り、regularMarketPrice を終値にしない",
    (name) => {
      const result = gate(name);
      expect(result.fresh).toEqual({ ok: true });
      expect(result.confirmed).toEqual({ ok: true, date: D, value: CONFIRMED_CLOSE });
      expect(result.parsed.meta.regularMarketPrice).toBe(69042.11);
      expect(result.dBars).toHaveLength(1);
      expect(result.dBars[0]?.close).toBe(CONFIRMED_CLOSE);
      if (result.confirmed.ok) expect(result.confirmed.value).not.toBe(result.parsed.meta.regularMarketPrice);
    }
  );

  it.each(["20261009T001500.json", "20261009T021500.json", "20261009T061500.json"])(
    "%s は D バーが null なので HOLD し、regularMarketPrice 69042.11 を代用しない",
    (name) => {
      const result = gate(name);
      expect(result.fresh.ok).toBe(false);
      expect(result.confirmed.ok).toBe(false);
      expect(result.parsed.meta.regularMarketPrice).toBe(69042.11);
      expect(result.dBars).toHaveLength(1);
      expect(result.dBars[0]?.close).toBeNull();
      expect(result.dBars[0]?.adj).toBeNull();
    }
  );

  it("09:45 の原文は D バーが null のまま HOLD し、10/9 の終値も D に使わない", () => {
    const result = gate("20261009T094500.json");
    expect(result.fresh.ok).toBe(false);
    expect(result.confirmed.ok).toBe(false);
    expect(result.parsed.meta.regularMarketPrice).toBe(68330.38);
    expect(result.dBars).toHaveLength(1);
    expect(result.dBars[0]?.close).toBeNull();
    expect(result.dBars[0]?.adj).toBeNull();
    expect(result.guarded.bars.at(-1)?.date).toBe("2026-10-09");
    expect(result.guarded.bars.at(-1)?.close).toBe(68330.3828125);
  });

  it("null 帯の原文は取得時刻と ctp を理由ログに書き、値がある原文は疑いを付けない", () => {
    const hold = fx("20261009T001500.json");
    const parsed = parseChartResponse(hold.json, "^N225");
    const line = formatNullBandHoldLog({
      stage: "stocks-session",
      symbol: "^N225",
      receivedAt: "2026-10-08T15:15:00.000Z",
      raw: hold.bytes,
      bars: parsed.bars,
      targetDate: D,
    });
    expect(line.startsWith("[INC-20261008-kabulab_tool_cloudflare-financials-stale] null-band-hold ")).toBe(true);
    expect(line).not.toMatch(/https?:|query1|query2|Bearer|token/i);
    expect(JSON.parse(line.slice(line.indexOf("{")))).toMatchObject({
      receivedAt: "2026-10-08T15:15:00.000Z",
      receivedAtJst: "2026-10-09T00:15:00+09:00",
      regularStartJst: "2026-10-09T09:00:00+09:00",
      regularEndJst: "2026-10-09T15:30:00+09:00",
      latestBarDate: D,
      latestCloseNull: true,
      latestAdjNull: true,
      targetCloseNull: true,
      nullBandSuspicion: "null 帯（D 23:30〜D+1 09:45 以降）での取得の疑い",
    });

    const morning = fx("20261009T094500.json");
    const morningLine = formatNullBandHoldLog({
      stage: "vwap-daily-session",
      symbol: "^N225",
      receivedAt: "2026-10-09T00:45:00.000Z",
      raw: morning.bytes,
      bars: parseChartResponse(morning.json, "^N225").bars,
      targetDate: D,
    });
    expect(JSON.parse(morningLine.slice(morningLine.indexOf("{"))).nullBandSuspicion).toBe(
      "null 帯（D 23:30〜D+1 09:45 以降）での取得の疑い"
    );
    expect(JSON.parse(morningLine.slice(morningLine.indexOf("{"))).latestBarDate).toBe("2026-10-09");
    expect(JSON.parse(morningLine.slice(morningLine.indexOf("{"))).latestCloseNull).toBe(false);
    expect(JSON.parse(morningLine.slice(morningLine.indexOf("{"))).targetCloseNull).toBe(true);

    const open = fx("20261008T211500.json");
    const openLine = formatNullBandHoldLog({
      stage: "stocks-session",
      symbol: "^N225",
      receivedAt: "2026-10-08T12:15:00.000Z",
      raw: open.bytes,
      bars: parseChartResponse(open.json, "^N225").bars,
      targetDate: D,
    });
    expect(JSON.parse(openLine.slice(openLine.indexOf("{"))).nullBandSuspicion).toBeNull();
  });
});
