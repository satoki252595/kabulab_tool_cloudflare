import { describe, expect, it } from "vitest";
import {
  classifyDividendForecastEvent,
  dividendForecastAsOfSec,
  forecastDividendYield,
  judgeDividendForecast,
  FORECAST_MAX_AGE_DAYS,
  SPLIT_LOOKBACK_DAYS,
} from "./forecast-dividend-yield.js";

const DAY = 86_400;
const AS_OF = dividendForecastAsOfSec("2026-10-16");
const AT = AS_OF - 60 * DAY; // 60 日前の短信

describe("dividendForecastAsOfSec", () => {
  it("対象日の JST 23:59:59 を返す", () => {
    expect(new Date(AS_OF * 1000).toISOString()).toBe("2026-10-16T14:59:59.000Z");
  });
  it("形式違いは throw", () => {
    expect(() => dividendForecastAsOfSec("2026/10/16")).toThrow();
  });
});

describe("classifyDividendForecastEvent", () => {
  it.each([
    ["2027年3月期 第1四半期決算短信〔日本基準〕(連結)", "tanshin"],
    ["業績予想及び配当予想の修正に関するお知らせ", "dividend"],
    ["剰余金の配当（増配）に関するお知らせ", "dividend"],
    ["株式分割、定款の一部変更および配当予想の修正に関するお知らせ", "share-split"],
    ["株式併合に関するお知らせ", "share-split"],
    ["自己株式の取得状況に関するお知らせ", null],
    ["会社分割による事業承継に関するお知らせ", null],
  ])("%s → %s", (title, kind) => {
    expect(classifyDividendForecastEvent(title)).toBe(kind);
  });
});

describe("judgeDividendForecast", () => {
  const row = (dpsForecast: number | null, disclosedAt = AT) => ({ dpsForecast, disclosedAt });

  it("後続開示の無い最新短信の予想を採る", () => {
    expect(judgeDividendForecast([row(178)], [], AS_OF)).toEqual({ kind: "forecast", dps: 178, disclosedAt: AT });
  });
  it("短信行が無ければ未確定", () => {
    expect(judgeDividendForecast([], [], AS_OF)).toEqual({ kind: "unverified", reason: "no-forecast-row" });
  });
  it("予想が未定 (null) なら未確定。0 円予想は無配として採る", () => {
    expect(judgeDividendForecast([row(null)], [], AS_OF)).toEqual({ kind: "unverified", reason: "forecast-undisclosed" });
    expect(judgeDividendForecast([row(0)], [], AS_OF)).toEqual({ kind: "forecast", dps: 0, disclosedAt: AT });
  });
  it("連結/単体の行で予想が食い違えば未確定 (null 混在も)", () => {
    expect(judgeDividendForecast([row(40), row(20)], [], AS_OF)).toEqual({ kind: "unverified", reason: "forecast-conflict" });
    expect(judgeDividendForecast([row(40), row(null)], [], AS_OF)).toEqual({ kind: "unverified", reason: "forecast-conflict" });
    expect(judgeDividendForecast([row(40), row(40)], [], AS_OF).kind).toBe("forecast");
  });
  it("短信より後の短信・配当開示があれば未確定 (同時刻の開示は短信に反映済みとみなす)", () => {
    expect(judgeDividendForecast([row(40)], [{ kind: "tanshin", pubdate: AT + 1 }], AS_OF))
      .toEqual({ kind: "unverified", reason: "superseded" });
    expect(judgeDividendForecast([row(40)], [{ kind: "dividend", pubdate: AT + DAY }], AS_OF))
      .toEqual({ kind: "unverified", reason: "superseded" });
    expect(judgeDividendForecast([row(40)], [{ kind: "dividend", pubdate: AT }], AS_OF).kind).toBe("forecast");
  });
  it("短信の前 200 日以内〜後の分割/併合開示は株数基準不明で未確定", () => {
    const split = (pubdate: number) => [{ kind: "share-split" as const, pubdate }];
    expect(judgeDividendForecast([row(40)], split(AT - (SPLIT_LOOKBACK_DAYS - 1) * DAY), AS_OF))
      .toEqual({ kind: "unverified", reason: "share-split-basis" });
    expect(judgeDividendForecast([row(40)], split(AT), AS_OF))
      .toEqual({ kind: "unverified", reason: "share-split-basis" });
    expect(judgeDividendForecast([row(40)], split(AT + DAY), AS_OF))
      .toEqual({ kind: "unverified", reason: "share-split-basis" });
    expect(judgeDividendForecast([row(40)], split(AT - (SPLIT_LOOKBACK_DAYS + 1) * DAY), AS_OF).kind).toBe("forecast");
  });
  it("短信が古すぎれば未確定", () => {
    const old = AS_OF - (FORECAST_MAX_AGE_DAYS + 1) * DAY;
    expect(judgeDividendForecast([row(40, old)], [], AS_OF)).toEqual({ kind: "unverified", reason: "stale" });
  });
  it("基準時刻より後の行・開示や、別短信の行の混入は throw", () => {
    expect(() => judgeDividendForecast([row(40, AS_OF + 1)], [], AS_OF)).toThrow();
    expect(() => judgeDividendForecast([row(40)], [{ kind: "tanshin", pubdate: AS_OF + 1 }], AS_OF)).toThrow();
    expect(() => judgeDividendForecast([row(40), row(40, AT - 1)], [], AS_OF)).toThrow();
    expect(() => judgeDividendForecast([row(-1)], [], AS_OF)).toThrow();
  });
});

describe("forecastDividendYield", () => {
  const basis = { kind: "forecast" as const, dps: 178, disclosedAt: AT };
  it("会社予想 ÷ 株価 を % 値 2 桁で返す", () => {
    expect(forecastDividendYield(basis, 13450)).toEqual({ value: 1.32, reason: null });
    expect(forecastDividendYield({ ...basis, dps: 0 }, 13450)).toEqual({ value: 0, reason: null });
  });
  it("株価が無い・正でなければ未確定", () => {
    expect(forecastDividendYield(basis, null)).toEqual({ value: null, reason: "price-missing" });
    expect(forecastDividendYield(basis, 0)).toEqual({ value: null, reason: "price-missing" });
  });
  it("未確定の基準は理由ごと null", () => {
    expect(forecastDividendYield({ kind: "unverified", reason: "superseded" }, 13450))
      .toEqual({ value: null, reason: "superseded" });
  });
});
