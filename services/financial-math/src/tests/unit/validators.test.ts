import { describe, it, expect } from "vitest";
import { dcfFormSchema } from "../../validators/dcf.js";
import { capmFormSchema } from "../../validators/capm.js";
import { bsFormSchema } from "../../validators/black-scholes.js";

/**
 * バリデータの空文字列吸収テスト。
 *
 * フォーム未入力時は空文字列で送信される (HTML form の標準挙動)。
 * `z.string().regex(...).optional()` だけだと空文字列が regex に当たって 400 エラー
 * になるため、union + transform で undefined に正規化している。
 *
 * 1414 を入力したとき "code フィールドが regex に弾かれる" 本番バグの再発防止用。
 */

describe("dcfFormSchema", () => {
  it("code='' を undefined に正規化する", () => {
    const r = dcfFormSchema.parse({
      code: "",
      mode: "gordon",
      expectedDividend: "100",
      requiredReturnPct: "7",
      growthRatePct: "3",
    });
    expect(r.code).toBeUndefined();
  });

  it("code 未指定でも parse 通る", () => {
    const r = dcfFormSchema.parse({
      mode: "gordon",
      expectedDividend: "100",
      requiredReturnPct: "7",
      growthRatePct: "3",
    });
    expect(r.code).toBeUndefined();
  });

  it("code='7203' は正しくパースされる", () => {
    const r = dcfFormSchema.parse({
      code: "7203",
      mode: "gordon",
      expectedDividend: "100",
      requiredReturnPct: "7",
      growthRatePct: "3",
    });
    expect(r.code).toBe("7203");
  });

  it("code='abc' (4桁数字でない) は throw", () => {
    expect(() =>
      dcfFormSchema.parse({
        code: "abc",
        mode: "gordon",
        expectedDividend: "100",
        requiredReturnPct: "7",
        growthRatePct: "3",
      })
    ).toThrow();
  });

  it("code='12345' (5桁数字) は throw", () => {
    expect(() =>
      dcfFormSchema.parse({
        code: "12345",
        mode: "gordon",
        expectedDividend: "100",
        requiredReturnPct: "7",
        growthRatePct: "3",
      })
    ).toThrow();
  });

  it("code='130A' (新形式 4桁+英字) は通る", () => {
    const r = dcfFormSchema.parse({
      code: "130A",
      mode: "gordon",
      expectedDividend: "100",
      requiredReturnPct: "7",
      growthRatePct: "3",
    });
    expect(r.code).toBe("130A");
  });

  it("code='141A' (トライアル HD) は通る", () => {
    const r = dcfFormSchema.parse({
      code: "141A",
      mode: "gordon",
      expectedDividend: "100",
      requiredReturnPct: "7",
      growthRatePct: "3",
    });
    expect(r.code).toBe("141A");
  });

  it("code='1234a' (5 文字) は throw (小文字は大文字化で正規化されるが桁数オーバーで弾かれる)", () => {
    expect(() =>
      dcfFormSchema.parse({
        code: "1234a",
        mode: "gordon",
        expectedDividend: "100",
        requiredReturnPct: "7",
        growthRatePct: "3",
      })
    ).toThrow();
  });

  it("code='130a' (小文字英字 4 文字) は '130A' に正規化されて通る", () => {
    const r = dcfFormSchema.parse({
      code: "130a",
      mode: "gordon",
      expectedDividend: "100",
      requiredReturnPct: "7",
      growthRatePct: "3",
    });
    expect(r.code).toBe("130A");
  });

  it("code='１４１Ａ' (全角) は '141A' に正規化されて通る", () => {
    const r = dcfFormSchema.parse({
      code: "１４１Ａ",
      mode: "gordon",
      expectedDividend: "100",
      requiredReturnPct: "7",
      growthRatePct: "3",
    });
    expect(r.code).toBe("141A");
  });

  // === required 外しに伴う optional 化テスト (focus 不能バグ再発防止) ===
  it("code 指定 + expectedDividend 空 → 通る (API 側で Yahoo 補完)", () => {
    const r = dcfFormSchema.parse({
      code: "7203",
      mode: "gordon",
      expectedDividend: "",
      requiredReturnPct: "7",
      growthRatePct: "3",
    });
    expect(r.code).toBe("7203");
    expect(r.expectedDividend).toBeUndefined();
  });

  it("code 空 + expectedDividend 空 → throw (どちらか必須)", () => {
    expect(() =>
      dcfFormSchema.parse({
        mode: "gordon",
        expectedDividend: "",
        requiredReturnPct: "7",
        growthRatePct: "3",
      })
    ).toThrow(/銘柄コード.*または.*来期予想配当/);
  });

  it("code 空 + expectedDividend 100 → 通る (純手動計算)", () => {
    const r = dcfFormSchema.parse({
      mode: "gordon",
      expectedDividend: "100",
      requiredReturnPct: "7",
      growthRatePct: "3",
    });
    expect(r.code).toBeUndefined();
    expect(r.expectedDividend).toBe(100);
  });

  it("% 入力が小数に変換される", () => {
    const r = dcfFormSchema.parse({
      mode: "gordon",
      expectedDividend: "100",
      requiredReturnPct: "7.5",
      growthRatePct: "2.5",
    });
    expect(r.requiredReturn).toBeCloseTo(0.075, 6);
    expect(r.growthRate).toBeCloseTo(0.025, 6);
  });

  // === 無配銘柄/未入力の挙動 ===
  // 旧仕様: validator が「expectedDividend 空」で throw していた
  // 新仕様: code 指定時は API 側で Yahoo 補完を試みる (無配時は別途 notice 表示)。
  //         なので validator レベルでは通る。
  it("code 指定 + expectedDividend='' → validator 通過 (無配でも通り、API 側で notice 表示)", () => {
    const r = dcfFormSchema.parse({
      code: "7777",
      mode: "gordon",
      expectedDividend: "",
      requiredReturnPct: "7",
      growthRatePct: "3",
    });
    expect(r.code).toBe("7777");
    expect(r.expectedDividend).toBeUndefined();
  });

  it("expectedDividend=0 (z.coerce.number は '' を 0 にしないが念のため) → エラー", () => {
    expect(() =>
      dcfFormSchema.parse({
        code: "7777",
        mode: "gordon",
        expectedDividend: "0",
        requiredReturnPct: "7",
        growthRatePct: "3",
      })
    ).toThrow(/正の数|無配/);
  });

  it("expectedDividend=-10 → positive() 制約で throw", () => {
    expect(() =>
      dcfFormSchema.parse({
        mode: "gordon",
        expectedDividend: "-10",
        requiredReturnPct: "7",
        growthRatePct: "3",
      })
    ).toThrow();
  });
});

describe("capmFormSchema", () => {
  it("code='' を undefined に", () => {
    const r = capmFormSchema.parse({
      code: "",
      mode: "manual",
      beta: "1.3",
      riskFreeRatePct: "0.5",
      marketReturnPct: "6",
    });
    expect(r.code).toBeUndefined();
  });

  it("beta='' (manualモード未入力) を undefined に", () => {
    const r = capmFormSchema.parse({
      code: "7203",
      mode: "auto",
      beta: "",
      riskFreeRatePct: "0.5",
      marketReturnPct: "6",
    });
    expect(r.beta).toBeUndefined();
  });

  it("beta=1.3 が数値として保持される", () => {
    const r = capmFormSchema.parse({
      mode: "manual",
      beta: "1.3",
      riskFreeRatePct: "0.5",
      marketReturnPct: "6",
    });
    expect(r.beta).toBeCloseTo(1.3, 6);
  });

  it("code='130a' (英字コード小文字) は '130A' に正規化されて通る", () => {
    const r = capmFormSchema.parse({
      code: "130a",
      mode: "manual",
      beta: "1.3",
      riskFreeRatePct: "0.5",
      marketReturnPct: "6",
    });
    expect(r.code).toBe("130A");
  });

  it("code='1234a' (5 文字) は throw", () => {
    expect(() =>
      capmFormSchema.parse({
        code: "1234a",
        mode: "manual",
        beta: "1.3",
        riskFreeRatePct: "0.5",
        marketReturnPct: "6",
      })
    ).toThrow();
  });
});

describe("bsFormSchema", () => {
  it("code='' を undefined に", () => {
    const r = bsFormSchema.parse({
      code: "",
      spot: "1000",
      strike: "1000",
      daysToExpiry: "90",
      riskFreeRatePct: "0.5",
      volatilityPct: "30",
    });
    expect(r.code).toBeUndefined();
  });

  it("marketPrice='' を undefined に", () => {
    const r = bsFormSchema.parse({
      spot: "1000",
      strike: "1000",
      daysToExpiry: "90",
      riskFreeRatePct: "0.5",
      volatilityPct: "30",
      marketPrice: "",
    });
    expect(r.marketPrice).toBeUndefined();
  });

  it("marketPrice=600 が数値として保持される", () => {
    const r = bsFormSchema.parse({
      spot: "1000",
      strike: "1000",
      daysToExpiry: "90",
      riskFreeRatePct: "0.5",
      volatilityPct: "30",
      marketPrice: "600",
      ivType: "call",
    });
    expect(r.marketPrice).toBe(600);
    expect(r.ivType).toBe("call");
  });

  it("daysToExpiry=90 → timeToExpiry = 90/365", () => {
    const r = bsFormSchema.parse({
      spot: "1000",
      strike: "1000",
      daysToExpiry: "90",
      riskFreeRatePct: "0.5",
      volatilityPct: "30",
    });
    expect(r.timeToExpiry).toBeCloseTo(90 / 365, 6);
  });

  it("code='130a' (英字コード小文字) は '130A' に正規化されて通る", () => {
    const r = bsFormSchema.parse({
      code: "130a",
      spot: "1000",
      strike: "1000",
      daysToExpiry: "90",
      riskFreeRatePct: "0.5",
      volatilityPct: "30",
    });
    expect(r.code).toBe("130A");
  });

  it("code='1234a' (5 文字) は throw", () => {
    expect(() =>
      bsFormSchema.parse({
        code: "1234a",
        spot: "1000",
        strike: "1000",
        daysToExpiry: "90",
        riskFreeRatePct: "0.5",
        volatilityPct: "30",
      })
    ).toThrow();
  });

  // === required 外しに伴う optional 化テスト (focus 不能バグ再発防止) ===
  it("code 指定 + spot/strike/vol 全て空 → 通る (API 側で Yahoo 補完)", () => {
    const r = bsFormSchema.parse({
      code: "7974",
      spot: "",
      strike: "",
      daysToExpiry: "90",
      riskFreeRatePct: "0.5",
      volatilityPct: "",
    });
    expect(r.code).toBe("7974");
    expect(r.spot).toBeUndefined();
    expect(r.strike).toBeUndefined();
    expect(r.volatility).toBeUndefined();
  });

  it("code 空 + spot 空 → throw (銘柄コード または 株価必須)", () => {
    expect(() =>
      bsFormSchema.parse({
        spot: "",
        strike: "1000",
        daysToExpiry: "90",
        riskFreeRatePct: "0.5",
        volatilityPct: "30",
      })
    ).toThrow(/銘柄コード.*または.*株価/);
  });

  it("code 空 + volatilityPct 空 → throw (銘柄コード または σ 必須)", () => {
    expect(() =>
      bsFormSchema.parse({
        spot: "1000",
        strike: "1000",
        daysToExpiry: "90",
        riskFreeRatePct: "0.5",
        volatilityPct: "",
      })
    ).toThrow(/銘柄コード.*または.*ボラ/);
  });
});
