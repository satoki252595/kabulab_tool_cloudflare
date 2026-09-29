/**
 * VWAP Analysis 公開 API (app.ts) の /api/margin のテスト。
 *
 * 日次スナップショット (`margin/daily/YYYY-MM-DD.json` + `margin/dates.json`)
 * を R2 モックに載せ、同一ティッカー複数行の除外日表示と正常日の保護を検証する。
 */
import { describe, expect, it } from "vitest";
import app from "./app.js";

function row(sourceCode: string, ordinaryTicker: string | null, sell: number, buy: number) {
  const fig = (s: number, b: number) => ({
    sellOutstanding: s,
    sellChg: 0,
    sellListedRatio: 0,
    sellListedRatioRaw: "0.0%",
    buyOutstanding: b,
    buyChg: 0,
    buyListedRatio: 0,
    buyListedRatioRaw: "0.0%",
    negSell: s,
    negSellChg: 0,
    negBuy: b,
    negBuyChg: 0,
    stdSell: 0,
    stdSellChg: 0,
    stdBuy: 0,
    stdBuyChg: 0,
  });
  return {
    sourceCode,
    name: `合成${sourceCode}`,
    ordinaryTicker,
    eligible: ordinaryTicker !== null,
    unitLetter: "B",
    sectype: "普通株式",
    market: "プライム",
    loanKind: "貸",
    isin: "JP0000000000",
    shares: fig(sell, buy),
    amounts: fig(sell * 1000, buy * 1000),
  };
}

type Row = ReturnType<typeof row>;

function zeroFig() {
  return {
    sellOutstanding: 0, sellChg: 0, sellListedRatio: 0, sellListedRatioRaw: "0.0%",
    buyOutstanding: 0, buyChg: 0, buyListedRatio: 0, buyListedRatioRaw: "0.0%",
    negSell: 0, negSellChg: 0, negBuy: 0, negBuyChg: 0,
    stdSell: 0, stdSellChg: 0, stdBuy: 0, stdBuyChg: 0,
  };
}

const NUM_KEYS = [
  "sellOutstanding", "sellChg", "buyOutstanding", "buyChg",
  "negSell", "negSellChg", "negBuy", "negBuyChg",
  "stdSell", "stdSellChg", "stdBuy", "stdBuyChg",
] as const;

/** 行合計と整合する最小 totals (全行を loan に集約。16行)。検証 reuse のため完全整合が必須。 */
function totalsFor(rows: Row[]) {
  const sumOf = (pick: (r: Row) => { [k in (typeof NUM_KEYS)[number]]: number }) => {
    const out: Record<string, number | string> = { ...zeroFig() };
    for (const k of NUM_KEYS) out[k] = rows.reduce((a, r) => a + pick(r)[k], 0);
    return out;
  };
  const sumS = sumOf((r) => r.shares);
  const sumA = sumOf((r) => r.amounts);
  const n = rows.length;
  const zS = zeroFig();
  const zA = zeroFig();
  const T = (label: string, scope: string, market: string | null, count: number, shares: unknown, amounts: unknown) =>
    ({ label, scope, market, count, shares, amounts });
  const block = (label: string, scope: string, count: number, shares: unknown, amounts: unknown) => [
    T(label, scope, null, count, shares, amounts),
    T("プライム 小計", scope, "プライム", count, shares, amounts),
    T("スタンダード 小計", scope, "スタンダード", 0, zS, zA),
    T("グロース 小計", scope, "グロース", 0, zS, zA),
  ];
  return [
    ...block("貸借銘柄", "loan", n, sumS, sumA),
    ...block("制度信用銘柄", "standardized", 0, zS, zA),
    ...block("一般信用銘柄", "other", 0, zS, zA),
    ...block("総合計", "grand", n, sumS, sumA),
  ];
}

function snap(rows: Row[], basisDate: string) {
  return {
    format: "jpx-margin-daily-v1",
    basisDate,
    publicationDate: "2026-09-29",
    sourceUrl: "https://example.invalid/m.pdf",
    rawSha256: "0".repeat(64),
    rawPageId: null,
    rows,
    totals: totalsFor(rows),
  };
}

// 2026-09-25: 25930 (普通株) と 25935 (種類株) が同一ティッカー 2593 に衝突する日。
const DAY_AMBIGUOUS = snap(
  [row("25930", "2593", 100, 200), row("25935", "2593", 310, 410), row("72030", "7203", 310, 0)],
  "2026-09-25"
);
// 2026-09-28: 2593 は 1 行だけの正常日。
const DAY_NORMAL = snap([row("25930", "2593", 100, 200), row("72030", "7203", 310, 0)], "2026-09-28");

function bucket(files: Record<string, unknown>) {
  return {
    get: async (key: string) => {
      if (!(key in files)) return null;
      const text = JSON.stringify(files[key]);
      return { body: null, text: async () => text };
    },
  };
}

const BUCKET = bucket({
  "margin/dates.json": ["2026-09-25", "2026-09-28"],
  "margin/daily/2026-09-25.json": DAY_AMBIGUOUS,
  "margin/daily/2026-09-28.json": DAY_NORMAL,
});

describe("GET /api/margin (同一ティッカー複数行の除外と正常日の保護)", () => {
  it("code=2593: 衝突日は除外日、正常日だけ値を返す", async () => {
    const res = await app.request("/api/margin?code=2593", {}, { BUCKET } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dates: Array<{ date: string; publicationDate: string; shares: { sellOutstanding: number } }>;
      ambiguousDates: string[];
    };
    expect(body.dates.map((d) => d.date)).toEqual(["2026-09-28"]);
    expect(body.dates[0]).toMatchObject({ publicationDate: "2026-09-29" });
    expect(body.dates[0]!.shares.sellOutstanding).toBe(100);
    expect(body.ambiguousDates).toEqual(["2026-09-25"]);
  });

  it("code=7203: 両日とも正常に値を返す (除外の影響なし)", async () => {
    const res = await app.request("/api/margin?code=7203", {}, { BUCKET } as never);
    const body = (await res.json()) as {
      dates: Array<{ date: string; shares: { sellOutstanding: number } }>;
    };
    expect(body.dates.map((d) => d.date)).toEqual(["2026-09-25", "2026-09-28"]);
    expect(body.dates[0]!.shares.sellOutstanding).toBe(310);
  });

  it("5文字原文コードでも直接引ける", async () => {
    const res = await app.request("/api/margin?code=25935", {}, { BUCKET } as never);
    const body = (await res.json()) as {
      dates: Array<{ date: string; sourceCode: string }>;
      ambiguousDates: unknown[];
    };
    expect(body.dates.map((d) => d.date)).toEqual(["2026-09-25"]);
    expect(body.dates[0]!.sourceCode).toBe("25935");
    expect(body.ambiguousDates).toEqual([]);
  });

  it("存在しない銘柄は空 + 空の除外日", async () => {
    const res = await app.request("/api/margin?code=9999", {}, { BUCKET } as never);
    const body = (await res.json()) as { dates: unknown[]; ambiguousDates: unknown[] };
    expect(body.dates).toEqual([]);
    expect(body.ambiguousDates).toEqual([]);
  });

  it("dates.json が無ければ空 (従来どおり) + 空の除外日", async () => {
    const res = await app.request("/api/margin?code=2593", {}, { BUCKET: bucket({}) } as never);
    const body = (await res.json()) as { dates: unknown[]; ambiguousDates: unknown[] };
    expect(body.dates).toEqual([]);
    expect(body.ambiguousDates).toEqual([]);
  });

  it("rows 欠落の破損スナップショットは空に化けずエラーにする (||[] 禁止)", async () => {
    const bad = bucket({
      "margin/dates.json": ["2026-09-28"],
      "margin/daily/2026-09-28.json": { ...DAY_NORMAL, rows: null },
    });
    const res = await app.request("/api/margin?code=2593", {}, { BUCKET: bad } as never);
    expect(res.status).toBe(500);
  });

  it("basisDate と index 日付の不一致はエラーにする", async () => {
    const bad = bucket({
      "margin/dates.json": ["2026-09-28"],
      "margin/daily/2026-09-28.json": { ...DAY_NORMAL, basisDate: "2026-09-25" },
    });
    const res = await app.request("/api/margin?code=2593", {}, { BUCKET: bad } as never);
    expect(res.status).toBe(500);
  });

  it("旧週次オブジェクトは読まない", async () => {
    const legacy = bucket({
      "margin/dates.json": ["2026-09-28"],
      "margin/daily/2026-09-28.json": DAY_NORMAL,
      "margin/weeks.json": ["2026-09-18"],
      "margin/2026-09-18.json": { rows: [row("25930", "2593", 1, 2)] },
    });
    const res = await app.request("/api/margin?code=2593", {}, { BUCKET: legacy } as never);
    const body = (await res.json()) as { dates: Array<{ date: string }> };
    expect(body.dates.map((d) => d.date)).toEqual(["2026-09-28"]);
  });
});
