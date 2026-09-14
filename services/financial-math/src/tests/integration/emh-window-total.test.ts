/**
 * `/emh` の件数クエリと行クエリの 1 本化 (window 関数) の検証。
 *
 * small-cap / low-vol / post-earnings は `count(*)` と行取得の 2 クエリを
 * 打っていた。`count(*) over()` を行クエリに載せれば 1 本になる (L-48)。
 * window 関数は LIMIT の前に評価されるので、over() の値はページ切り捨て
 * 前の総件数になる。固定したい契約:
 *
 *   1. limit で切っても総件数 (`該当: N 件`) は母集団の件数のまま。
 *   2. 件数クエリが復活しない (断面表を読む文が 1 本だけ)。
 *   3. 該当 0 件のとき総件数は 0 (空ページで `?? 0` が効く)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../../index.js";
import { createFinmathD1, type FinmathD1 } from "../helpers/finmath-d1.js";

let d1: FinmathD1;

const AS_OF = "2026-09-11";
/** limit=10 (最小) で切っても総件数が残るよう、11 件以上を用意する */
const SEED_COUNT = 12;

beforeEach(() => {
  d1 = createFinmathD1();
  const insStock = d1.sqlite.prepare(
    "INSERT INTO core_stocks (id, code, name, market, sector, is_active, instrument_type) VALUES (?, ?, ?, ?, ?, ?, 'equity')"
  );
  const insFin = d1.sqlite.prepare(
    "INSERT INTO core_stock_financials (stock_id, price, dividend_yield, market_cap, data_date) VALUES (?, ?, ?, ?, ?)"
  );
  const insInd = d1.sqlite.prepare(
    "INSERT INTO swing_stock_indicators (stock_id, atr_pct, pct_change_1d) VALUES (?, ?, ?)"
  );
  for (let i = 1; i <= SEED_COUNT; i++) {
    const code = `100${i}`;
    insStock.run(i, code, `銘柄${code}`, "プライム", "輸送用機器", 1);
    // 時価総額は昇順 (id 順 = 表示順)。500 億円の既定閾値を下回る。
    insFin.run(i, 1000 + i, 2.5, i * 1.0e9, AS_OF);
    // ATR% は昇順。1.5% の既定閾値を下回る。
    insInd.run(i, 0.1 * i, 1.0);
  }
});

afterEach(() => {
  d1.close();
});

async function emh(query: string): Promise<string> {
  d1.executed.length = 0;
  const res = await app.request(`/emh?${query}`, {}, { DB: d1.binding });
  expect(res.status).toBe(200);
  return await res.text();
}

function codesInOrder(html: string): string[] {
  return [...html.matchAll(/\/dcf\?code=(\w+)/g)].map((m) => m[1]);
}

describe("/emh の件数と行の 1 本化 (L-48)", () => {
  it("small-cap: limit で切っても総件数は母集団のまま", async () => {
    const html = await emh("type=small-cap&limit=10");

    expect(html).toContain(`該当: ${SEED_COUNT} 件`);
    // 時価総額昇順の先頭 10 件だけ並ぶ
    expect(codesInOrder(html)).toEqual(
      Array.from({ length: 10 }, (_, i) => `100${i + 1}`)
    );
  });

  it("small-cap: core_stock_financials を読む文は 1 本だけ", async () => {
    await emh("type=small-cap&limit=10");

    const reads = d1.executed.filter((q) => /core_stock_financials/i.test(q));
    expect(
      reads,
      "件数クエリが復活している (2 本目は count(*) 単独のはず)"
    ).toHaveLength(1);
    // その 1 本が window 関数を持っている
    expect(reads[0]).toMatch(/count\(\*\)\s+over\(\)/i);
  });

  it("low-vol: limit で切っても総件数は母集団のまま", async () => {
    const html = await emh("type=low-vol&limit=10");

    expect(html).toContain(`該当: ${SEED_COUNT} 件`);
    expect(codesInOrder(html)).toHaveLength(10);
  });

  it("low-vol: swing_stock_indicators を読む文は 1 本だけ", async () => {
    await emh("type=low-vol&limit=10");

    const reads = d1.executed.filter((q) => /swing_stock_indicators/i.test(q));
    expect(
      reads,
      "件数クエリが復活している (2 本目は count(*) 単独のはず)"
    ).toHaveLength(1);
    expect(reads[0]).toMatch(/count\(\*\)\s+over\(\)/i);
  });

  it("post-earnings: 総件数は断面の行数で、読む文は 1 本だけ", async () => {
    const html = await emh("type=post-earnings&limit=10");

    expect(html).toContain(`該当: ${SEED_COUNT} 件`);
    const reads = d1.executed.filter((q) => /core_stock_financials/i.test(q));
    expect(reads).toHaveLength(1);
  });

  it("該当 0 件のとき総件数は 0", async () => {
    d1.sqlite.exec("DELETE FROM core_stock_financials");

    const html = await emh("type=small-cap&limit=10");

    expect(html).toContain("該当: 0 件");
  });
});
