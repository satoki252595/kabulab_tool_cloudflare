import { describe, expect, it } from "vitest";
import {
  isListedEquity,
  parseJpxAsOf,
  type JpxRow,
} from "./sectors.js";

// JPX data_j.xls 2026-06-30版の実在行。手作りの架空銘柄は使わない。
const VERITAS: JpxRow = {
  asOf: "2026-06-30",
  code: "130A",
  name: "Ｖｅｒｉｔａｓ　Ｉｎ　Ｓｉｌｉｃｏ",
  marketCategory: "グロース（内国株式）",
  sector33: "医薬品",
};
const ITO_EN_PREFERRED: JpxRow = {
  asOf: "2026-06-30",
  code: "25935",
  name: "伊藤園第１種優先株式",
  marketCategory: "プライム（内国株式）",
  sector33: "食料品",
};
const IFREE_TOPIX: JpxRow = {
  asOf: "2026-06-30",
  code: "1305",
  name: "ｉＦｒｅｅＥＴＦ　ＴＯＰＩＸ（年１回決算型）",
  marketCategory: "ETF・ETN",
  sector33: null,
};

describe("parseJpxAsOf", () => {
  it("JPX実ファイルの日付をISO基準日にする", () => {
    expect(parseJpxAsOf(20260630)).toBe("2026-06-30");
  });

  it("形式崩れと実在しない日付を拒否する", () => {
    expect(() => parseJpxAsOf("2026-06-30")).toThrow("YYYYMMDD");
    expect(() => parseJpxAsOf(20260230)).toThrow("実在しない");
  });
});

describe("isListedEquity", () => {
  it("東証内国普通株の数字・英字4文字コードを対象にする", () => {
    expect(isListedEquity(VERITAS)).toBe(true);
  });

  it("5桁種類株とETFを普通株母集団から除外する", () => {
    expect(isListedEquity(ITO_EN_PREFERRED)).toBe(false);
    expect(isListedEquity(IFREE_TOPIX)).toBe(false);
  });
});
