/**
 * 読み取り面 (GET / 計算 POST) が **D1 を読むだけで書かない**ことの検証。
 *
 * ## なぜこのテストが無かったのか、が問題だった
 *
 * `routes.test.ts` が叩いていた GET は code なしのパスだけで、**code 付きの
 * GET/POST の統合テストが 1 件も無かった**。ちょうどそこが
 * 「SSR の GET 中に Yahoo を同期で叩いて本番 D1 へ UPSERT する」経路で、
 * 実際に `/financial-math/dcf?code=7203` を開いた瞬間に本番の 7203 の行と
 * `finmath_daily_ohlcv` の `^N225` が書き換わった。テストは緑のままだった。
 *
 * ## 固定する契約
 *
 *   1. `1414` (優待なし・旧「独自ユニバースが必要」の根拠銘柄) がプリフィルできる
 *   2. `7203` の GET/POST が **INSERT/UPDATE を 1 文も出さない**
 *   3. `^N225` は `swing_market_context` から取り、それ以外の指数は**黙って
 *      空にせず**落ちる
 *   4. 断面が無い銘柄では silent catch せず理由を画面に出す
 *   5. σ は**使用サンプル本数**を画面に出す (系列が 514 本 → 約 90 本に減り、
 *      数値が変わるため)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../../index.js";
import {
  createFinmathD1,
  seedFinmathData,
  writeStatements,
  SEED_AS_OF,
  seedDate,
  type FinmathD1,
} from "../helpers/finmath-d1.js";
import { getOhlcvSeries, getPriceContext } from "../../services/price-cache.js";
import { createDb } from "../../db/client.js";

let d1: FinmathD1;

beforeEach(() => {
  d1 = createFinmathD1();
  seedFinmathData(
    d1.sqlite,
    [
      // 7203: 断面 + 90 本の日足 (本番の実測は 83 本)
      { id: 1, code: "7203", name: "トヨタ自動車", price: 2870, dividendYieldPct: 3.43, bars: 90, close: 2500, step: 4 },
      // 1414: 優待なし銘柄。旧コメントは「core.stocks に載らない」と書いていたが
      // 実際には is_active=1 の全銘柄に断面がある。
      { id: 2, code: "1414", name: "ショーボンドHD", price: 5600, dividendYieldPct: 1.2, bars: 84, close: 5000, step: 7 },
      // 9999: 断面も日足も無い (= 日次 sync の対象外)
      { id: 3, code: "9999", name: "断面なし銘柄", financials: false, bars: 0 },
      // 1301: 日足が 10 本しかない (β/σ の下限未満)
      { id: 4, code: "1301", name: "本数不足銘柄", price: 800, bars: 10, close: 800 },
    ],
    // 市場系列。本番は 107 行で銘柄側と重なるのが 94 日。
    95
  );
});

afterEach(() => {
  d1.close();
});

async function get(path: string): Promise<{ status: number; body: string }> {
  const res = await app.request(path, {}, { DB: d1.binding });
  return { status: res.status, body: await res.text() };
}

async function post(
  path: string,
  fields: Record<string, string>
): Promise<{ status: number; body: string }> {
  const res = await app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    },
    { DB: d1.binding }
  );
  return { status: res.status, body: await res.text() };
}

/**
 * テスト DB にある `finmath_` 表の名前。
 *
 * 以前はここで旧 2 表の番兵行が書き換わっていないかを見ていた。2 表は
 * drizzle/d1/0012 で本番から DROP するので、テスト DB も本番と同じく
 * **表を持たない**形にした。読み書きに行けば `no such table` で 500 になり、
 * 各テストの status 検査で落ちる。この関数はその前提 (表が無い) 自体が
 * 崩れていないことを確かめる。
 */
function finmathTables(): string[] {
  return (
    d1.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'finmath\\_%' ESCAPE '\\'")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

describe("code 付き GET が D1 へ書き込まない", () => {
  const paths = [
    "/dcf?code=7203",
    "/dcf?code=1414",
    "/capm?code=7203",
    "/capm?code=1414",
    "/black-scholes?code=7203",
    "/black-scholes?code=1414",
  ];

  it.each(paths)("GET %s は 200 で、書き込み文を 1 つも出さない", async (path) => {
    d1.executed.length = 0;
    const { status } = await get(path);
    expect(status).toBe(200);
    expect(
      writeStatements(d1.executed),
      "読み取り面が D1 へ書いている (訪問者ごとにデータが変わる原因)"
    ).toEqual([]);
  });

  it.each(paths)("GET %s は削除した 2 表を触らない", async (path) => {
    // 前提: テスト DB に 2 表が無い (本番と同じ)。あると触っても落ちない。
    expect(finmathTables()).toEqual([]);
    const { status } = await get(path);
    // 触っていれば `no such table` で 500 になる
    expect(status).toBe(200);
    expect(
      d1.executed.filter((q) => /finmath_(price_snapshot|daily_ohlcv)/i.test(q))
    ).toEqual([]);
  });

  it("計算 POST も書き込まない (誰が押したかでデータが変わらない)", async () => {
    for (const [path, fields] of [
      ["/api/dcf/calc", { code: "7203", mode: "gordon", requiredReturnPct: "7", growthRatePct: "3" }],
      ["/api/capm/calc", { code: "7203", mode: "auto", riskFreeRatePct: "0.5", marketReturnPct: "6" }],
      ["/api/black-scholes/calc", { code: "7203", daysToExpiry: "90", riskFreeRatePct: "0.5" }],
    ] as const) {
      d1.executed.length = 0;
      const { status } = await post(path, fields);
      expect(status, `${path} が 200 を返さない`).toBe(200);
      expect(writeStatements(d1.executed), `${path} が書き込んでいる`).toEqual([]);
      expect(
        d1.executed.filter((q) => /finmath_(price_snapshot|daily_ohlcv)/i.test(q)),
        `${path} が削除した 2 表を触っている`
      ).toEqual([]);
    }
  });
});

describe("1414 (優待なし銘柄) のプリフィル", () => {
  it("/dcf?code=1414 で株価と推定配当が埋まる", async () => {
    const { status, body } = await get("/dcf?code=1414");
    expect(status).toBe(200);
    expect(body).toContain("ショーボンドHD");
    expect(body).toContain("5,600");
    // 5600 × 1.2% = 67.2 円/株。% → decimal の正規化が効いていること
    // (効いていなければ 6,720 円という 100 倍の値になる)
    expect(body).toContain("67.2");
    expect(body).not.toContain("6720");
  });

  it("/black-scholes?code=1414 で σ とサンプル本数が出る", async () => {
    const { body } = await get("/black-scholes?code=1414");
    // 84 本の終値 → 83 本の日次リターン
    expect(body).toContain("σ サンプル: 83 本");
    expect(body).toContain(`〜${seedDate(83)}`);
    expect(body).toContain(`株価 as of: ${SEED_AS_OF}`);
  });
});

describe("β の市場系列", () => {
  it("^N225 は swing_market_context から取る", async () => {
    d1.executed.length = 0;
    const { body } = await get("/capm?code=7203");
    expect(d1.executed.some((q) => /swing_market_context/i.test(q))).toBe(true);
    expect(d1.executed.some((q) => /finmath_daily_ohlcv/i.test(q))).toBe(false);
    // 日付が重なる 89 日 → 差分を取って 88〜89 サンプル
    expect(body).toMatch(/サンプル数[\s\S]{0,200}?8[0-9]/);
  });

  it("日足が足りない銘柄は理由を出す (β を捏造しない)", async () => {
    const { body } = await get("/capm?code=1301");
    expect(body).toContain("β を自動推定できません");
    expect(body).toContain("10 日分しかなく");
  });

  it("^N225 以外の指数は黙って空にせず落ちる", async () => {
    const db = createDb(d1.binding as D1Database);
    await expect(getOhlcvSeries(db, "^GSPC")).rejects.toThrow(/\^N225 のみ対応/);
  });
});

describe("断面が無い銘柄で silent catch しない", () => {
  it("/dcf?code=9999 は理由を画面に出す", async () => {
    const { status, body } = await get("/dcf?code=9999");
    expect(status).toBe(200);
    expect(body).toContain("プリフィルができません");
    expect(body).toContain("core_stock_financials 未登録");
  });

  it("/black-scholes?code=9999 も理由を出す", async () => {
    const { body } = await get("/black-scholes?code=9999");
    expect(body).toContain("プリフィルができません");
  });

  it("getPriceContext は 0 や null で埋めずに throw する", async () => {
    const db = createDb(d1.binding as D1Database);
    await expect(getPriceContext(db, "9999")).rejects.toThrow(/価格断面が D1 にありません/);
    // 存在する銘柄は返る (検査自体が空振りしていないこと)
    await expect(getPriceContext(db, "7203")).resolves.toMatchObject({
      code: "7203",
      price: 2870,
      asOf: SEED_AS_OF,
    });
  });

  it("小文字入力も正準化して引ける (130a のような新形式コード)", async () => {
    const db = createDb(d1.binding as D1Database);
    await expect(getPriceContext(db, " 7203 ")).resolves.toMatchObject({ code: "7203" });
  });
});
