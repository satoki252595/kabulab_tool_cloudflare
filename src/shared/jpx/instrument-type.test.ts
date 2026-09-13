import { describe, expect, it } from "vitest";
import {
  INSTRUMENT_TYPES,
  INSTRUMENT_TYPE_EQUITY,
  NON_EQUITY_CATEGORY_TABLE,
  classifyInstrumentType,
} from "./instrument-type.js";
import { isListedEquity, type JpxRow } from "./sectors.js";

// JPX data_j 2026-06-30版の実在行 (sectors.test.ts と同じ 3 行)。手作りの架空銘柄は使わない。
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

describe("classifyInstrumentType", () => {
  it("内国普通株は equity、ETF・ETN は etf_etn", () => {
    expect(classifyInstrumentType(VERITAS)).toBe("equity");
    expect(classifyInstrumentType(IFREE_TOPIX)).toBe("etf_etn");
  });

  it("区分が内国株式でも 4 文字コード契約外の種類株は未分類 (null)", () => {
    // equity にすると (c) の分母が isListedEquity の分子より大きくなる。
    // 優先株などの別の語にするには data_j の列に根拠が無い (推定になる)。
    expect(classifyInstrumentType(ITO_EN_PREFERRED)).toBeNull();
  });

  it("equity の述語は isListedEquity と完全に一致する (ガード (c) の分子と分母を揃える)", () => {
    const rows = [VERITAS, ITO_EN_PREFERRED, IFREE_TOPIX];
    for (const row of rows) {
      expect(classifyInstrumentType(row) === INSTRUMENT_TYPE_EQUITY).toBe(
        isListedEquity(row)
      );
    }
    // 表の区分は、4 文字コード契約に合うコードと組み合わせても equity にならない。
    // (PRO Market の内国株などが equity に紛れ込むと (c) が恒久的に 98% を割る)
    for (const category of NON_EQUITY_CATEGORY_TABLE.keys()) {
      const row = { code: VERITAS.code, marketCategory: category };
      expect(isListedEquity(row)).toBe(false);
      expect(classifyInstrumentType(row)).not.toBe(INSTRUMENT_TYPE_EQUITY);
    }
  });

  it("区分文字列ごとの語 (契約)", () => {
    expect(Object.fromEntries(NON_EQUITY_CATEGORY_TABLE)).toEqual({
      "プライム（外国株式）": "foreign",
      "スタンダード（外国株式）": "foreign",
      "グロース（外国株式）": "foreign",
      "PRO Market": "pro_market",
      "ETF・ETN": "etf_etn",
      "REIT・ベンチャーファンド・カントリーファンド・インフラファンド": "reit_fund",
      出資証券: "investment_certificate",
    });
  });

  it("表に無い区分・表記ゆれは近い語へ寄せず未分類にする", () => {
    // 部分一致で拾うと、JPX が区分名を変えたことに気づけないまま誤分類する。
    for (const marketCategory of [
      "ETF",
      "REIT",
      "PRO Market（内国株式）",
      "プライム(外国株式)", // 半角括弧
      "",
    ]) {
      expect(
        classifyInstrumentType({ code: IFREE_TOPIX.code, marketCategory })
      ).toBeNull();
    }
  });
});

describe("INSTRUMENT_TYPES (語彙)", () => {
  it("equity は stockStock universe_guards.INSTRUMENT_TYPE_EQUITY と同じ文字列", () => {
    // stockStock `src/jp_stock_pipeline/cloud_store/universe_guards.py`:
    //   INSTRUMENT_TYPE_EQUITY = "equity"
    // 片方だけ変えると、ガード (c)(d2) の分母が 0 件になり黙って縮退し続ける。
    expect(INSTRUMENT_TYPE_EQUITY).toBe("equity");
  });

  it("値は重複せず [a-z_] だけで書かれている (universe.ts が SQL リテラルに埋め込む)", () => {
    const values = Object.values(INSTRUMENT_TYPES);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v).toMatch(/^[a-z_]+$/);
  });

  it("表の語はすべて語彙に含まれる", () => {
    const values = new Set<string>(Object.values(INSTRUMENT_TYPES));
    for (const v of NON_EQUITY_CATEGORY_TABLE.values()) {
      expect(values.has(v)).toBe(true);
    }
  });
});
