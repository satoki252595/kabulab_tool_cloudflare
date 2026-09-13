import { describe, expect, it } from "vitest";
import {
  JPX_LISTING_URL,
  isListedEquity,
  parseJpxAsOf,
  type JpxRow,
} from "./sectors.js";

// 内国株式の 2 行は JPX data_j 2026-06-30 版の実在行。ETF の行は合成で、コードは JPX の
// 上場銘柄一覧 (2026-08-31 版) にも本番 core_stocks にも無く、銘柄名も架空。
// 区分文字列だけが data_j の表記。
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
const SYNTHETIC_ETF: JpxRow = {
  asOf: "2026-06-30",
  code: "1202",
  name: "合成テスト指数連動型ＥＴＦ",
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
    expect(isListedEquity(SYNTHETIC_ETF)).toBe(false);
  });
});

describe("JPX_LISTING_URL", () => {
  // 2026-09 に JPX が .xls から .xlsx へ差し替え、旧 URL が 404 になった。
  // 月次の universe sync が 2026-09-10 から失敗していた原因なので、
  // 拡張子の取り違えをここで固定する。
  it("配布形式は .xlsx (旧 .xls は 404)", () => {
    expect(JPX_LISTING_URL.endsWith(".xlsx")).toBe(true);
    expect(JPX_LISTING_URL.endsWith(".xls")).toBe(false);
  });

  it("一覧ページが指すパスと一致する", () => {
    expect(JPX_LISTING_URL).toBe(
      "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx",
    );
  });
});
