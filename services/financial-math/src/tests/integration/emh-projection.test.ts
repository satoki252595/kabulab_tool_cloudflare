/**
 * `/emh?type=momentum` が L2 投影 (`p_momentum`) だけを読むことの検証。
 *
 * 固定したい契約:
 *
 *   1. **`swing_daily_ohlcv` を触らない**。ここを全走査していたのが
 *      651,494 rows_read / TTFB 0.86〜1.01 秒の原因で、直したのはこの 1 点。
 *      「速くなった」は行数では測れないので、**どの表を読んだか**で固定する。
 *   2. 投影の終値列でランキングが作れる (累積リターン降順・limit 件)。
 *   3. window が実データの本数を超えたとき、0 件の理由が画面に出る。
 *      以前は「該当 0 件」だけで、アノマリーが無いのか本数が足りないのかが
 *      判別できなかった (UI の max=100 に対し実データは約 90 本)。
 *   4. momentum 以外のタブは投影を読まない (断面表は既に 1 銘柄 1 行なので不要)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../../index.js";
import { createFinmathD1, type FinmathD1 } from "../helpers/finmath-d1.js";
import { encodeCloses } from "../../../../../src/shared/indicators/momentum-series.js";

let d1: FinmathD1;

/** 単調に上昇/下降する終値列 */
function series(start: number, step: number, bars: number): number[] {
  return Array.from({ length: bars }, (_, i) =>
    Math.round((start + step * i + (i % 3) * 0.7) * 100) / 100
  );
}

const AS_OF = "2026-09-11";

beforeEach(() => {
  d1 = createFinmathD1();
  const insStock = d1.sqlite.prepare(
    "INSERT INTO core_stocks (id, code, name, market, sector, is_active, instrument_type) VALUES (?, ?, ?, ?, ?, ?, 'equity')"
  );
  const insFin = d1.sqlite.prepare(
    "INSERT INTO core_stock_financials (stock_id, price, dividend_yield, market_cap, data_date) VALUES (?, ?, ?, ?, ?)"
  );
  const insProj = d1.sqlite.prepare(
    "INSERT INTO p_momentum (stock_id, as_of, source_max_date, bars, closes) VALUES (?, ?, ?, ?, ?)"
  );

  // 1: 強い上昇 / 2: 弱い上昇 / 3: 下降。いずれも 40 本 (window=20 は満たす)。
  const plans: [number, string, number, number][] = [
    [1, "7203", 1000, 20],
    [2, "7974", 1000, 5],
    [3, "9984", 1000, -5],
  ];
  for (const [id, code, start, step] of plans) {
    insStock.run(id, code, `銘柄${code}`, "プライム", "輸送用機器", 1);
    insFin.run(id, start + step * 39, 2.5, 1.0e12, AS_OF);
    const closes = series(start, step, 40);
    insProj.run(id, AS_OF, AS_OF, closes.length, encodeCloses(closes));
  }

  // 母集団には居るが投影に終値列が無い銘柄 (取得が止まっている)。
  insStock.run(4, "1414", "銘柄1414", "スタンダード", "建設業", 1);
  insFin.run(4, 3000, 1.2, 5.0e10, AS_OF);
});

afterEach(() => {
  d1.close();
});

async function emh(query: string): Promise<string> {
  const res = await app.request(`/emh?${query}`, {}, { DB: d1.binding });
  expect(res.status).toBe(200);
  return await res.text();
}

describe("/emh?type=momentum は投影だけを読む", () => {
  it("swing_daily_ohlcv を 1 文も読まない", async () => {
    await emh("type=momentum&window=20&limit=50");
    const ohlcvReads = d1.executed.filter((q) => /swing_daily_ohlcv/i.test(q));
    expect(
      ohlcvReads,
      "OHLCV の全走査が復活している (1 表示 651,494 rows_read の原因)"
    ).toEqual([]);
    expect(d1.executed.some((q) => /p_momentum/i.test(q))).toBe(true);
  });

  it("累積リターン降順にランキングし、投影に無い銘柄は並ばない", async () => {
    const html = await emh("type=momentum&window=20&limit=50");
    const codes = [...html.matchAll(/\/dcf\?code=(\w+)/g)].map((m) => m[1]);
    expect(codes).toEqual(["7203", "7974", "9984"]);
    // 投影に終値列が無い 1414 はランキングに現れない (= 該当 3 件)
    expect(codes).not.toContain("1414");
    expect(html).toContain("該当: 3 件");
    // 母集団の分母は core_stocks の active かつ equity の件数 (投影行数ではない)
    expect(html).toContain("集計対象: 4 銘柄");
    // 終値列を持つ銘柄数と最長本数を併記する
    expect(html).toContain("終値列を持つ銘柄: 3 件 (最長 40 本)");
  });

  it("鮮度は投影の as_of を出す", async () => {
    const html = await emh("type=momentum&window=20&limit=50");
    expect(html).toContain(`最新日付: ${AS_OF}`);
  });

  it("window が実データの本数を超えたら理由を出す (0 件で黙らない)", async () => {
    const html = await emh("type=momentum&window=100&limit=50");
    expect(html).toContain("該当: 0 件");
    expect(html).toContain("window=100 は実データの最長 40 本を超えています");
    // 下げ先へのリンクを出す
    expect(html).toContain("window=40");
  });

  it("momentum 以外のタブは投影を読まない", async () => {
    d1.sqlite.exec(
      "INSERT INTO swing_stock_indicators (stock_id, atr_pct, pct_change_1d) VALUES (1, 0.9, 1.2)"
    );
    for (const type of ["small-cap", "low-vol", "post-earnings"]) {
      d1.executed.length = 0;
      await emh(`type=${type}&limit=10`);
      expect(
        d1.executed.filter((q) => /p_momentum/i.test(q)),
        `${type} が投影を読んでいる (断面表は既に 1 銘柄 1 行なので不要)`
      ).toEqual([]);
    }
  });

  it("GET は 1 文も書き込まない", async () => {
    for (const type of ["momentum", "small-cap", "low-vol", "post-earnings"]) {
      d1.executed.length = 0;
      await emh(`type=${type}&limit=10`);
      expect(
        d1.executed.filter((q) => /^\s*(insert|update|delete|replace)\b/i.test(q))
      ).toEqual([]);
    }
  });
});

describe("/emh の母集団は active かつ equity (非普通株を数えも並べもしない)", () => {
  /**
   * 日次の対象から外れた REIT。断面と指標は凍結したまま残っていて、small-cap /
   * low-vol / post-earnings のどの条件も満たし、しかも絞り込みが外れたら先頭に
   * 並ぶ値にしてある (時価総額が最小・ATR% が最小・fetched_at が最新)。
   * コードは合成 (JPX の上場銘柄一覧 2026-08-31 版にも本番 core_stocks にも無い)。
   */
  const REIT_CODE = "1201";

  beforeEach(() => {
    d1.sqlite
      .prepare(
        "INSERT INTO core_stocks (id, code, name, market, sector, is_active, instrument_type) VALUES (5, ?, 'REITテスト', 'REIT', NULL, 1, 'reit_fund')"
      )
      .run(REIT_CODE);
    d1.sqlite.exec(
      "INSERT INTO core_stock_financials (stock_id, price, dividend_yield, market_cap, data_date, fetched_at) VALUES (5, 100000, 4.0, 1.0e9, '2026-09-11', unixepoch() + 3600)"
    );
    d1.sqlite.exec(
      "INSERT INTO swing_stock_indicators (stock_id, atr_pct, pct_change_1d) VALUES (5, 0.3, 0.5), (1, 0.9, 1.2)"
    );
  });

  it("集計対象 (universeSize) に数えない", async () => {
    for (const type of ["momentum", "small-cap", "low-vol", "post-earnings"]) {
      expect(await emh(`type=${type}&limit=50`), type).toContain("集計対象: 4 銘柄");
    }
  });

  it("small-cap の件数と一覧に出ない", async () => {
    // 閾値を全銘柄が入る大きさにする (equity 4 件が並ぶ = 絞りすぎでないことも見る)
    const html = await emh("type=small-cap&smallCapMaxOku=50000&limit=50");
    expect(html).toContain("/dcf?code=7203");
    expect(html).not.toContain(`code=${REIT_CODE}`);
    expect(html).toContain("該当: 4 件");
  });

  it("low-vol の件数と一覧に出ない", async () => {
    const html = await emh("type=low-vol&limit=50");
    expect(html).toContain("/dcf?code=7203");
    expect(html).not.toContain(`code=${REIT_CODE}`);
    expect(html).toContain("該当: 1 件");
  });

  it("post-earnings の件数と一覧に出ない", async () => {
    const html = await emh("type=post-earnings&limit=50");
    expect(html).toContain("/dcf?code=7203");
    expect(html).not.toContain(`code=${REIT_CODE}`);
    expect(html).toContain("該当: 4 件");
  });
});
