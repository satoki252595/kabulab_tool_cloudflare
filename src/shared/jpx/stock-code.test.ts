import { describe, it, expect } from "vitest";
import {
  STOCK_CODE_REGEX,
  STOCK_CODE_HTML_PATTERN,
  normalizeStockCode,
  isValidStockCode,
  parseStockCode,
} from "./stock-code.js";
import {
  stockCodeSchema,
  optionalStockCodeSchema,
} from "./stock-code-schema.js";

/**
 * JPX 英数字コード対応の回帰防止テスト。
 *
 * 2024 年以降の新規上場銘柄 (例: 130A) が `/^\d{4}$/` で弾かれていた本番
 * 不具合 (005 受注検索で英字コード未対応) の再発を固定する。
 */

describe("normalizeStockCode", () => {
  it("前後空白を除去する", () => {
    expect(normalizeStockCode("  7011 ")).toBe("7011");
  });

  it("英字を大文字化する (利用者が小文字で打っても拾う)", () => {
    expect(normalizeStockCode("130a")).toBe("130A");
  });

  it("全角英数字を半角化する (モバイル日本語 IME 対策)", () => {
    expect(normalizeStockCode("７０１１")).toBe("7011");
    expect(normalizeStockCode("１３０ａ")).toBe("130A");
    expect(normalizeStockCode("１３０Ａ")).toBe("130A");
  });
});

describe("STOCK_CODE_REGEX / isValidStockCode", () => {
  it("純 4 桁数字コードを受理する", () => {
    expect(isValidStockCode("7011")).toBe(true);
    expect(isValidStockCode("1803")).toBe(true);
  });

  it("英数字コード (3 桁数字 + 末尾英字) を受理する", () => {
    expect(isValidStockCode("130A")).toBe(true);
    expect(isValidStockCode("141A")).toBe(true);
    expect(isValidStockCode("999Z")).toBe(true);
  });

  it("小文字・全角入力も正規化して受理する", () => {
    expect(isValidStockCode("130a")).toBe(true);
    expect(isValidStockCode("１３０Ａ")).toBe(true);
  });

  it("3 桁・5 桁・先頭英字・記号は拒否する", () => {
    expect(isValidStockCode("701")).toBe(false);
    expect(isValidStockCode("70111")).toBe(false);
    expect(isValidStockCode("A130")).toBe(false);
    expect(isValidStockCode("13-A")).toBe(false);
    expect(isValidStockCode("")).toBe(false);
  });

  it("末尾以外の英字 (現行付番に存在しない) は拒否する", () => {
    // 仕様が 2 桁目英字化に及んだらこのテストと REGEX を更新する。
    expect(isValidStockCode("1A30")).toBe(false);
  });

  it("正準パターン (STOCK_CODE_REGEX) 自体は大文字・半角前提 — 正規化は helper の責務", () => {
    expect(STOCK_CODE_REGEX.test("130A")).toBe(true);
    expect(STOCK_CODE_REGEX.test("130a")).toBe(false);
    expect(STOCK_CODE_REGEX.test("7011")).toBe(true);
  });
});

describe("STOCK_CODE_HTML_PATTERN", () => {
  // HTML input は暗黙に全体一致・大文字小文字区別。小文字も許可 (サーバ正規化前提)。
  const re = new RegExp(`^(?:${STOCK_CODE_HTML_PATTERN})$`);
  it("数字コード・英字コード・小文字を許可する", () => {
    expect(re.test("7011")).toBe(true);
    expect(re.test("130A")).toBe(true);
    expect(re.test("130a")).toBe(true);
  });
  it("桁数違いを拒否する", () => {
    expect(re.test("701")).toBe(false);
    expect(re.test("70111")).toBe(false);
  });
});

describe("parseStockCode", () => {
  it("妥当なら正準形 (大文字・半角・trim) を返す", () => {
    expect(parseStockCode(" 7011 ")).toBe("7011");
    expect(parseStockCode("130a")).toBe("130A");
    expect(parseStockCode("１３０Ａ")).toBe("130A");
  });
  it("不正なら null を返す (黙って別値に差し替えない)", () => {
    expect(parseStockCode("70111")).toBeNull();
    expect(parseStockCode("abc")).toBeNull();
    expect(parseStockCode("")).toBeNull();
  });
});

describe("stockCodeSchema (zod 必須)", () => {
  it("数字コード・英字コードを正準形でパースする", () => {
    expect(stockCodeSchema.parse("7011")).toBe("7011");
    expect(stockCodeSchema.parse("130A")).toBe("130A");
  });
  it("小文字・全角・空白を正規化する", () => {
    expect(stockCodeSchema.parse(" 130a ")).toBe("130A");
    expect(stockCodeSchema.parse("１４１ａ")).toBe("141A");
  });
  it("不正コードは throw する", () => {
    expect(() => stockCodeSchema.parse("70111")).toThrow();
    expect(() => stockCodeSchema.parse("abc")).toThrow();
    expect(() => stockCodeSchema.parse("")).toThrow();
  });
});

describe("optionalStockCodeSchema (zod 任意)", () => {
  it("空文字列・空白・未指定は undefined に正規化する", () => {
    expect(optionalStockCodeSchema.parse("")).toBeUndefined();
    expect(optionalStockCodeSchema.parse("   ")).toBeUndefined();
    expect(optionalStockCodeSchema.parse(undefined)).toBeUndefined();
  });
  it("非空かつ妥当なら正準形を返す", () => {
    expect(optionalStockCodeSchema.parse("130a")).toBe("130A");
    expect(optionalStockCodeSchema.parse("7203")).toBe("7203");
  });
  it("非空かつ不正なら throw する (黙って捨てない)", () => {
    expect(() => optionalStockCodeSchema.parse("99999")).toThrow();
  });
});
