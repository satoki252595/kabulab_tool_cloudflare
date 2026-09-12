import { afterEach, beforeEach, describe, it, expect } from "vitest";
import app from "../../index.js";
import {
  createFinmathD1,
  seedFinmathData,
  type FinmathD1,
} from "../helpers/finmath-d1.js";

/**
 * Hono ルートの統合テスト。
 *
 * 1414 ユーザーバグ (空文字列 code で 400 になる) の再発防止が主目的。
 *
 * ## `DATABASE_URL` ゲートを外した理由
 *
 * 以前は `hasDb = !!process.env.DATABASE_URL` で分岐し、DB が無い環境では
 * **500 も合格**にしていた (`expect([200, 500]).toContain(res.status)`)。
 * `DATABASE_URL` は Neon 期の env で、D1 移行後は誰も設定しないので
 * 実質「常に 500 を許す」= ルートが壊れても緑になる状態だった。
 * さらに `it.skipIf(!hasDb)` の 3 件は**一度も実行されていなかった**。
 *
 * `node:sqlite` の D1 スタブを注げば DB 有りで回せるので、分岐そのものを消した。
 * code 付き経路の中身 (どの表を読むか / 書かないか) は
 * price-read-path.test.ts と emh-projection.test.ts が見ている。
 */

let d1: FinmathD1;

beforeEach(() => {
  d1 = createFinmathD1();
  seedFinmathData(
    d1.sqlite,
    [
      { id: 1, code: "7203", name: "トヨタ自動車", price: 2870, dividendYieldPct: 3.43, bars: 90, close: 2500, step: 4 },
      { id: 2, code: "1414", name: "ショーボンドHD", price: 5600, dividendYieldPct: 1.2, bars: 84, close: 5000, step: 7 },
    ],
    95
  );
});

afterEach(() => {
  d1.close();
});

function request(path: string, init?: RequestInit) {
  return app.request(path, init, { DB: d1.binding });
}

async function postForm(path: string, fields: Record<string, string>) {
  const body = new URLSearchParams(fields).toString();
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("GET /financial-math/* — 全ページが 200 を返す", () => {
  for (const path of [
    "/",
    "/dcf",
    "/capm",
    "/black-scholes",
    "/emh?type=momentum&limit=10",
    "/emh?type=small-cap&limit=10",
    "/emh?type=low-vol&limit=10",
    "/emh?type=post-earnings&limit=10",
  ]) {
    it(`GET ${path}`, async () => {
      const res = await request(path);
      expect(res.status).toBe(200);
    });
  }
});

describe("POST /api/dcf/calc — 1414 バグ再発防止", () => {
  it("code='' を含む POST も 200 を返す (空文字列許容)", async () => {
    const res = await postForm("/api/dcf/calc", {
      code: "",
      mode: "gordon",
      expectedDividend: "100",
      requiredReturnPct: "7",
      growthRatePct: "3",
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("result-headline");
  });

  it("code 未指定でも 200", async () => {
    const res = await postForm("/api/dcf/calc", {
      mode: "gordon",
      expectedDividend: "200",
      requiredReturnPct: "7",
      growthRatePct: "3",
    });
    expect(res.status).toBe(200);
  });

  it("code=1414 (有効銘柄) で 200", async () => {
    const res = await postForm("/api/dcf/calc", {
      code: "1414",
      mode: "gordon",
      expectedDividend: "100",
      requiredReturnPct: "7",
      growthRatePct: "3",
    });
    expect(res.status).toBe(200);
  });

  it("code='1414' のバリデーション層は通る (DB レス)", async () => {
    // バリデータが 4 桁数字を許容することを直接確認 (DB アクセスは別)
    const { dcfFormSchema } = await import("../../validators/dcf.js");
    const r = dcfFormSchema.parse({
      code: "1414",
      mode: "gordon",
      expectedDividend: "100",
      requiredReturnPct: "7",
      growthRatePct: "3",
    });
    expect(r.code).toBe("1414");
  });

  it("code='abc' (無効) で 400", async () => {
    const res = await postForm("/api/dcf/calc", {
      code: "abc",
      mode: "gordon",
      expectedDividend: "100",
      requiredReturnPct: "7",
      growthRatePct: "3",
    });
    expect(res.status).toBe(400);
  });

  it("k <= g で 400 (Gordon 制約違反)", async () => {
    const res = await postForm("/api/dcf/calc", {
      mode: "gordon",
      expectedDividend: "200",
      requiredReturnPct: "3",
      growthRatePct: "5",
    });
    expect(res.status).toBe(400);
  });

  // === 1414 バグ再発防止 ===
  // バグ: code=1414 (配当銘柄) + expectedDividend=100 (古い値) を送ると
  //       100/(0.07-0.03) = 2,500 円 が出てしまっていた。
  // 修正: 銘柄コード指定時は断面の推定値で expectedDividend を強制上書き。
  it("code=1414 + expectedDividend=100 → 断面の推定値で上書き (2,500 円にならない)", async () => {
    const res = await postForm("/api/dcf/calc", {
      code: "1414",
      mode: "gordon",
      expectedDividend: "100",
      requiredReturnPct: "7",
      growthRatePct: "3",
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    // 2,500 円という headline は出ない (バグの典型値)
    expect(body).not.toMatch(/class="result-headline">2,500</);
    // 上書きした事実と出所を notice に出す (silent override 禁止)
    expect(body).toMatch(/推定配当[\s\S]{0,80}日次同期の断面/);
  });

  it("code=7203 + expectedDividend=100 → やはり断面の推定値で上書き", async () => {
    const res = await postForm("/api/dcf/calc", {
      code: "7203",
      mode: "gordon",
      expectedDividend: "100",
      requiredReturnPct: "7",
      growthRatePct: "3",
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toMatch(/class="result-headline">2,500</);
  });

  it("code 未指定 + expectedDividend=100 → そのまま 2,500 円計算 (手動計算モード)", async () => {
    const res = await postForm("/api/dcf/calc", {
      mode: "gordon",
      expectedDividend: "100",
      requiredReturnPct: "7",
      growthRatePct: "3",
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toMatch(/class="result-headline">2,500/);
    // 上書き notice は出ない (銘柄指定なし)
    expect(body).not.toMatch(/日次同期の断面/);
  });
});

describe("POST /api/capm/calc — 空文字列許容", () => {
  it("code='' & beta='' (manual で β 未入力) でも 200", async () => {
    const res = await postForm("/api/capm/calc", {
      code: "",
      mode: "manual",
      beta: "",
      riskFreeRatePct: "0.5",
      marketReturnPct: "6",
    });
    // β=undefined でも form 再表示で 200 (capmResult は無いが)
    expect(res.status).toBe(200);
  });

  it("code='' で manual β=1.3 で 200", async () => {
    const res = await postForm("/api/capm/calc", {
      code: "",
      mode: "manual",
      beta: "1.3",
      riskFreeRatePct: "0.5",
      marketReturnPct: "6",
    });
    expect(res.status).toBe(200);
  });

  it("code=7203 で auto 推定", async () => {
    const res = await postForm("/api/capm/calc", {
      code: "7203",
      mode: "auto",
      riskFreeRatePct: "0.5",
      marketReturnPct: "6",
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    // β または "推定不能" のいずれかが表示される
    expect(/β |推定/.test(body)).toBe(true);
  });
});

describe("POST /api/black-scholes/calc — 空文字列許容", () => {
  it("code='' & marketPrice='' でも 200", async () => {
    const res = await postForm("/api/black-scholes/calc", {
      code: "",
      spot: "8000",
      strike: "8000",
      daysToExpiry: "90",
      riskFreeRatePct: "0.5",
      volatilityPct: "30",
      marketPrice: "",
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("CALL");
  });

  it("code='' で marketPrice 指定 → IV 逆算", async () => {
    const res = await postForm("/api/black-scholes/calc", {
      code: "",
      spot: "8000",
      strike: "8000",
      daysToExpiry: "90",
      riskFreeRatePct: "0.5",
      volatilityPct: "30",
      marketPrice: "500",
      ivType: "call",
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Implied Volatility");
  });
});
