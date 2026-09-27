/**
 * FFAJ 店頭FX月次速報パーサのテスト。
 *
 * `index-page.sample.html` は実ページ (2026-09-27 取得, 2026年8月分) から
 * パーサが読む箇所だけを抜粋したもので、値・タグ構造は改変していない
 * (詳細は __fixtures__/ffaj-otc-fx/README.md)。
 *
 * xls 3 ファイルは実バイト列をコミットしていない (README.md の理由により)。
 * 代わりに、実ファイルと同一のシート名・ヘッダー行・列レイアウトを
 * このテスト内で `xlsx` パッケージ自身を使って組み立て、そこに 2026-09-27
 * 時点で実ファイルとページ本文の両方を突き合わせて確認した実測値
 * (KNOWN_VALUES_2026_08 / KNOWN_VALUES_2026_07, 出典は README.md の表) を
 * 埋め込んで検証する。数値そのものは公表された事実であり、FFAJ の表の
 * 体裁・編集を再配布するものではない。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { describe, expect, it, vi } from "vitest";
import {
  FFAJ_CURRENCY_CODES,
  FFAJ_INDEX_URL,
  FFAJ_OTC_FX_INDICATORS,
  ffajOtcFxArchiveInput,
  parseDepositAmountInformation,
  parseFfajIndexPage,
  parseFfajOtcFxFiles,
  parseOpenPositionWithMc,
  parseTradingVolAndPosition,
  resolveFfajOtcFxPeriodStatus,
  toFfajOtcFxObservations,
  type FfajCurrencyCode,
} from "./ffaj-otc-fx.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "ffaj-otc-fx");

// ---------------------------------------------------------------------------
// 実測値 (2026-09-27 に実ファイル・ページ本文の双方で確認。README.md 参照)
// ---------------------------------------------------------------------------

const KNOWN_VALUES_2026_08 = {
  month: "2026-08",
  turnoverMillionYen: 825716490,
  shortPositionMillionYen: 4786850,
  longPositionMillionYen: 7377326,
  totalPositionMillionYen: 12164177,
  jpy: { turnover: 803019386, short: 6831441, long: 3954300, netLong: -2877141 },
  usd: { turnover: 732068756, short: 2905029, long: 4175760, netLong: 1270731 },
  zar: { turnover: 541454, short: 20460, long: 236253, netLong: 215793 },
  depositIn: 264885433584,
  depositOut: 263339509817,
  requiredBalance: 1920655895456,
  netChange: 67271782392,
  trustBalance: 1985850459013,
  coverageRatio: 103.39,
};

const KNOWN_VALUES_2026_07 = {
  month: "2026-07",
  turnoverMillionYen: 882076835,
  shortPositionMillionYen: 3919139,
  longPositionMillionYen: 8045112,
  totalPositionMillionYen: 11964251,
  jpy: { turnover: 845955064, short: 7516686, long: 3187687, netLong: -4328998 },
  depositIn: 312831805170,
  depositOut: 289257952068,
  requiredBalance: 1851838189296,
  netChange: -37269691175,
  trustBalance: 1952134319963,
  coverageRatio: 105.41,
};

// 通貨ブロックの並び (実ファイルの列順どおり)。
const CURRENCY_BLOCK_VALUES_2026_08: Record<FfajCurrencyCode, [number, number, number, number]> = {
  JPY: [803019386, 6831441, 3954300, -2877141],
  USD: [732068756, 2905029, 4175760, 1270731],
  EUR: [29177478, 636163, 418221, -217942],
  GBP: [26406790, 407114, 806275, 399161],
  AUD: [35949017, 462759, 578313, 115554],
  NZD: [4700210, 104939, 211672, 106733],
  CHF: [4568559, 669215, 85016, -584198],
  CAD: [839765, 34898, 77414, 42516],
  ZAR: [541454, 20460, 236253, 215793],
};

// ---------------------------------------------------------------------------
// フィクスチャ組み立て (実ファイルと同じシート名・ヘッダー・列レイアウト)
// ---------------------------------------------------------------------------

function toWorkbookBytes(sheetName: string, aoa: unknown[][]): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

function buildTradingVolAndPosition(opts: {
  sheetName?: string;
  headerRow?: unknown[];
  dataRows?: unknown[][];
  trailingBlankRows?: number;
}): Uint8Array {
  const headerRow = opts.headerRow ?? [
    "",
    "",
    "取引金額\nTrading Volume",
    "売建\nShort Positions",
    "買建\nLong Positions",
    "建玉計\nTotal Positions",
  ];
  const dataRows = opts.dataRows ?? [
    [8, 2026, KNOWN_VALUES_2026_08.turnoverMillionYen, KNOWN_VALUES_2026_08.shortPositionMillionYen, KNOWN_VALUES_2026_08.longPositionMillionYen, KNOWN_VALUES_2026_08.totalPositionMillionYen],
    [7, 2026, KNOWN_VALUES_2026_07.turnoverMillionYen, KNOWN_VALUES_2026_07.shortPositionMillionYen, KNOWN_VALUES_2026_07.longPositionMillionYen, KNOWN_VALUES_2026_07.totalPositionMillionYen],
  ];
  const aoa: unknown[][] = [];
  aoa[0] = ["店頭外国為替証拠金取引の状況（月次）"];
  aoa[3] = ["通貨ペア：全通貨ペア"];
  aoa[6] = ["単位: 百万円"];
  aoa[8] = ["月\nMonth", "年\nYear", "全通貨ペア合計 Total"];
  aoa[9] = headerRow;
  for (const r of dataRows) aoa.push(r);
  for (let i = 0; i < (opts.trailingBlankRows ?? 2); i++) aoa.push(["", ""]);
  return toWorkbookBytes(opts.sheetName ?? "ALL(TOTAL)", aoa);
}

function buildOpenPositionWithMc(opts: {
  sheetName?: string;
  currencies?: readonly FfajCurrencyCode[];
  labelHeaderOverride?: (row: unknown[]) => unknown[];
  monthRows?: Array<{ month: number; year: number; blocks: Record<string, [number, number, number, number]> }>;
}): Uint8Array {
  const currencies = opts.currencies ?? FFAJ_CURRENCY_CODES;
  const currencyNames: Record<FfajCurrencyCode, string> = {
    JPY: "日本円\nJPY",
    USD: "米ドル\nUSD",
    EUR: "ユーロ\nEUR",
    GBP: "英ポンド\nGBP",
    AUD: "オーストラリアドル\nAUD",
    NZD: "ニュージーランドドル\nNZD",
    CHF: "スイスフラン\nCHF",
    CAD: "カナダドル\nCAD",
    ZAR: "南アフリカランド\nZAR",
  };
  const currencyHeaderRow: unknown[] = ["月\nMonth", "年\nYear"];
  let labelHeaderRow: unknown[] = ["", ""];
  for (const c of currencies) {
    currencyHeaderRow.push(currencyNames[c], "", "", "");
    labelHeaderRow.push(
      "取引金額\nTrading Volume",
      "①　　売建\nShort Positions",
      "②　　買建\nLong Positions",
      "②-①＝買越額\nNet Long"
    );
  }
  if (opts.labelHeaderOverride) labelHeaderRow = opts.labelHeaderOverride(labelHeaderRow);

  const monthRows =
    opts.monthRows ??
    ([
      { month: 8, year: 2026, blocks: CURRENCY_BLOCK_VALUES_2026_08 },
    ] as Array<{ month: number; year: number; blocks: Record<string, [number, number, number, number]> }>);

  const aoa: unknown[][] = [];
  aoa[0] = ["店頭外国為替証拠金取引の状況（月次）"];
  aoa[3] = ["主要通貨における建玉状況"];
  aoa[6] = ["単位：百万円"];
  aoa[8] = currencyHeaderRow;
  aoa[9] = labelHeaderRow;
  for (const mr of monthRows) {
    const row: unknown[] = [mr.month, mr.year];
    for (const c of currencies) row.push(...mr.blocks[c]);
    aoa.push(row);
  }
  aoa.push(["", ""]);
  return toWorkbookBytes(opts.sheetName ?? "Data", aoa);
}

function buildDepositAmountInformation(opts: {
  sheetName?: string;
  labelRow?: unknown[];
  subLabelRow?: unknown[];
  dataRows?: unknown[][];
}): Uint8Array {
  const labelRow = opts.labelRow ?? [
    "報告対象年月",
    "",
    "顧客区分管理必要額",
    "",
    "",
    "顧客区分管理必要額正味増減額",
    "④顧客区分管理信託額",
    "信託保全率",
  ];
  const subLabelRow = opts.subLabelRow ?? [
    "年",
    "月",
    "①当月顧客入金額",
    "②当月顧客出金額",
    "③当月末必要額",
    "=③-前月③-①+②",
    "（当月末日時点）",
    "=④/③*100",
  ];
  const dataRows = opts.dataRows ?? [
    [
      2026,
      8,
      KNOWN_VALUES_2026_08.depositIn,
      KNOWN_VALUES_2026_08.depositOut,
      KNOWN_VALUES_2026_08.requiredBalance,
      KNOWN_VALUES_2026_08.netChange,
      KNOWN_VALUES_2026_08.trustBalance,
      KNOWN_VALUES_2026_08.coverageRatio,
    ],
    [
      2026,
      7,
      KNOWN_VALUES_2026_07.depositIn,
      KNOWN_VALUES_2026_07.depositOut,
      KNOWN_VALUES_2026_07.requiredBalance,
      KNOWN_VALUES_2026_07.netChange,
      KNOWN_VALUES_2026_07.trustBalance,
      KNOWN_VALUES_2026_07.coverageRatio,
    ],
  ];
  const aoa: unknown[][] = [];
  aoa[0] = ["店頭外国為替証拠金取引 / 顧客区分管理必要額関連情報（預託額情報）"];
  aoa[4] = ["本表の見方については、こちらをご覧ください。"];
  aoa[7] = labelRow;
  aoa[9] = subLabelRow;
  aoa[11] = ["", "", "円(Yen)", "円(Yen)", "円(Yen)", "円(Yen)", "円(Yen)", "％"];
  for (const r of dataRows) aoa.push(r);
  aoa.push(["", ""]);
  return toWorkbookBytes(opts.sheetName ?? "DATA", aoa);
}

// ---------------------------------------------------------------------------
// (1) 資料室ページの解析 (実ページからの抜粋フィクスチャ)
// ---------------------------------------------------------------------------

describe("parseFfajIndexPage", () => {
  const html = readFileSync(join(FIXTURES_DIR, "index-page.sample.html"), "utf-8");

  it("実ページの抜粋 (2026年8月分, 更新日2026-09-14) から更新日・対象月・3ファイルのURLを取り出す", () => {
    const page = parseFfajIndexPage(html);
    expect(page.updatedOn).toBe("2026-09-14");
    expect(page.latestPublishedMonth).toBe("2026-08");
    expect(page.tradingVolAndPositionUrl).toBe(
      "https://www.ffaj.or.jp/wp-content/uploads/2026/09/trading_vol_and_position.xls"
    );
    expect(page.openPositionWithMcUrl).toBe(
      "https://www.ffaj.or.jp/wp-content/uploads/2026/09/open_position_with_mc.xls"
    );
    expect(page.depositAmountInformationUrl).toBe(
      "https://www.ffaj.or.jp/wp-content/uploads/2026/09/deposit_amount_information.xls"
    );
  });

  it("「更新日」が無ければ throw する (様式変更の検知)", () => {
    const broken = html.replace(/更新日[：:][^<]*/, "");
    expect(() => parseFfajIndexPage(broken)).toThrow(/更新日/);
  });

  it("対象月の見出しが無ければ throw する", () => {
    const broken = html.replace(/2026年8月（August 2026\)/, "");
    expect(() => parseFfajIndexPage(broken)).toThrow(/対象月/);
  });

  it("ファイルリンクが無ければ throw する (ファイル名を指定して検知)", () => {
    const broken = html.replace(
      "https://www.ffaj.or.jp/wp-content/uploads/2026/09/deposit_amount_information.xls",
      "https://www.ffaj.or.jp/wp-content/uploads/2026/09/deposit_amount_information_renamed.xls"
    );
    expect(() => parseFfajIndexPage(broken)).toThrow(/deposit_amount_information\.xls/);
  });
});

// ---------------------------------------------------------------------------
// (2) trading_vol_and_position.xls
// ---------------------------------------------------------------------------

describe("parseTradingVolAndPosition", () => {
  it("ALL(TOTAL) シートの実測値 (2026年8月・7月) を正しく取れる", () => {
    const rows = parseTradingVolAndPosition(buildTradingVolAndPosition({}));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      month: "2026-08",
      turnoverMillionYen: KNOWN_VALUES_2026_08.turnoverMillionYen,
      shortPositionMillionYen: KNOWN_VALUES_2026_08.shortPositionMillionYen,
      longPositionMillionYen: KNOWN_VALUES_2026_08.longPositionMillionYen,
      totalPositionMillionYen: KNOWN_VALUES_2026_08.totalPositionMillionYen,
    });
    expect(rows[1].month).toBe("2026-07");
    expect(rows[1].turnoverMillionYen).toBe(KNOWN_VALUES_2026_07.turnoverMillionYen);
  });

  it("末尾の空行パディングを無視する (実ファイルは239行中データは十数行のみ)", () => {
    const rows = parseTradingVolAndPosition(buildTradingVolAndPosition({ trailingBlankRows: 5 }));
    expect(rows).toHaveLength(2);
  });

  it("シート ALL(TOTAL) が無ければ throw する (様式変更の検知)", () => {
    const bytes = buildTradingVolAndPosition({ sheetName: "TOTAL_RENAMED" });
    expect(() => parseTradingVolAndPosition(bytes)).toThrow(/ALL\(TOTAL\)/);
  });

  it("ヘッダー列が想定と異なれば throw する", () => {
    const bytes = buildTradingVolAndPosition({
      headerRow: ["", "", "謎の列", "売建\nShort Positions", "買建\nLong Positions", "建玉計\nTotal Positions"],
    });
    expect(() => parseTradingVolAndPosition(bytes)).toThrow(/ヘッダー列/);
  });

  it("数値であるべきセルが数値でなければ throw する", () => {
    const bytes = buildTradingVolAndPosition({
      dataRows: [[8, 2026, "非数値", 4786850, 7377326, 12164177]],
    });
    expect(() => parseTradingVolAndPosition(bytes)).toThrow(/数値ではありません/);
  });

  it("月が範囲外なら throw する", () => {
    const bytes = buildTradingVolAndPosition({ dataRows: [[13, 2026, 1, 1, 1, 1]] });
    expect(() => parseTradingVolAndPosition(bytes)).toThrow(/月の値が不正/);
  });

  it("データ行が0件なら throw する", () => {
    const bytes = buildTradingVolAndPosition({ dataRows: [], trailingBlankRows: 3 });
    expect(() => parseTradingVolAndPosition(bytes)).toThrow(/データ行が 0 件/);
  });
});

// ---------------------------------------------------------------------------
// (2) open_position_with_mc.xls
// ---------------------------------------------------------------------------

describe("parseOpenPositionWithMc", () => {
  it("主要9通貨・実測値 (2026年8月) を正しく取れる", () => {
    const rows = parseOpenPositionWithMc(buildOpenPositionWithMc({}));
    expect(rows).toHaveLength(9);

    const jpy = rows.find((r) => r.currency === "JPY");
    expect(jpy).toEqual({
      month: "2026-08",
      currency: "JPY",
      turnoverMillionYen: KNOWN_VALUES_2026_08.jpy.turnover,
      shortPositionMillionYen: KNOWN_VALUES_2026_08.jpy.short,
      longPositionMillionYen: KNOWN_VALUES_2026_08.jpy.long,
      netLongMillionYen: KNOWN_VALUES_2026_08.jpy.netLong,
    });

    const usd = rows.find((r) => r.currency === "USD");
    expect(usd?.turnoverMillionYen).toBe(KNOWN_VALUES_2026_08.usd.turnover);
    expect(usd?.netLongMillionYen).toBe(KNOWN_VALUES_2026_08.usd.netLong);

    const zar = rows.find((r) => r.currency === "ZAR");
    expect(zar?.longPositionMillionYen).toBe(KNOWN_VALUES_2026_08.zar.long);
  });

  it("シート Data が無ければ throw する", () => {
    const bytes = buildOpenPositionWithMc({ sheetName: "Data_renamed" });
    expect(() => parseOpenPositionWithMc(bytes)).toThrow(/Data/);
  });

  it("通貨見出しが欠けていれば throw する (様式変更の検知)", () => {
    const bytes = buildOpenPositionWithMc({ currencies: ["JPY", "USD", "EUR"] });
    expect(() => parseOpenPositionWithMc(bytes)).toThrow(/GBP/);
  });

  it("列のサブラベルが想定と異なれば throw する", () => {
    const bytes = buildOpenPositionWithMc({
      labelHeaderOverride: (row) => {
        const copy = [...row];
        copy[2] = "謎の列";
        return copy;
      },
    });
    expect(() => parseOpenPositionWithMc(bytes)).toThrow(/ヘッダーが想定と異なります/);
  });
});

// ---------------------------------------------------------------------------
// (2) deposit_amount_information.xls
// ---------------------------------------------------------------------------

describe("parseDepositAmountInformation", () => {
  it("実測値 (2026年8月・7月) を正しく取れる (列順が年,月である点に注意)", () => {
    const rows = parseDepositAmountInformation(buildDepositAmountInformation({}));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      month: "2026-08",
      customerDepositInYen: KNOWN_VALUES_2026_08.depositIn,
      customerWithdrawalOutYen: KNOWN_VALUES_2026_08.depositOut,
      requiredBalanceYen: KNOWN_VALUES_2026_08.requiredBalance,
      netChangeYen: KNOWN_VALUES_2026_08.netChange,
      trustBalanceYen: KNOWN_VALUES_2026_08.trustBalance,
      trustCoverageRatioPercent: KNOWN_VALUES_2026_08.coverageRatio,
    });
    expect(rows[1].netChangeYen).toBe(KNOWN_VALUES_2026_07.netChange);
  });

  it("正味増減額が公表値どおり負の月もそのまま扱う (2026年7月は資金純流出)", () => {
    const rows = parseDepositAmountInformation(buildDepositAmountInformation({}));
    expect(rows[1].netChangeYen).toBeLessThan(0);
  });

  it("シート DATA が無ければ throw する", () => {
    const bytes = buildDepositAmountInformation({ sheetName: "DATA_renamed" });
    expect(() => parseDepositAmountInformation(bytes)).toThrow(/DATA/);
  });

  it("ヘッダー列が想定と異なれば throw する", () => {
    const bytes = buildDepositAmountInformation({
      subLabelRow: ["年", "月", "謎の列", "②当月顧客出金額", "③当月末必要額", "note", "note", "note"],
    });
    expect(() => parseDepositAmountInformation(bytes)).toThrow(/ヘッダー列が想定と異なります/);
  });

  it('正味増減額が原資料どおり "na" (前月データ欠落で計算不能) の月は null になる (実測: 系列先頭の2015-04がこの値)', () => {
    const bytes = buildDepositAmountInformation({
      dataRows: [
        [2015, 4, 1_000_000, 900_000, 50_000_000_000, "na", 51_000_000_000, 102.0],
      ],
    });
    const rows = parseDepositAmountInformation(bytes);
    expect(rows).toHaveLength(1);
    expect(rows[0].netChangeYen).toBeNull();
    // "na" 以外の列は通常どおり数値として取れる。
    expect(rows[0].requiredBalanceYen).toBe(50_000_000_000);
  });

  it('正味増減額が "na" 以外の非数値なら (na と誤解せず) throw する', () => {
    const bytes = buildDepositAmountInformation({
      dataRows: [[2026, 8, 1, 2, 3, "計算中", 4, 5]],
    });
    expect(() => parseDepositAmountInformation(bytes)).toThrow(/数値ではありません/);
  });
});

// ---------------------------------------------------------------------------
// (3) 期間判定 / まだ公表されていない
// ---------------------------------------------------------------------------

describe("resolveFfajOtcFxPeriodStatus", () => {
  it("対象月が最新公表月以前なら published", () => {
    expect(resolveFfajOtcFxPeriodStatus("2026-08", "2026-08")).toEqual({ status: "published", month: "2026-08" });
    expect(resolveFfajOtcFxPeriodStatus("2026-07", "2026-08")).toEqual({ status: "published", month: "2026-07" });
  });

  it("対象月が最新公表月より先ならまだ公表されていない (推測せず throw ではなく型で表現)", () => {
    expect(resolveFfajOtcFxPeriodStatus("2026-09", "2026-08")).toEqual({
      status: "not_yet_published",
      month: "2026-09",
      latestPublishedMonth: "2026-08",
    });
  });

  it("YYYY-MM 形式でなければ throw する", () => {
    expect(() => resolveFfajOtcFxPeriodStatus("2026/08", "2026-08")).toThrow(/形式が不正/);
    expect(() => resolveFfajOtcFxPeriodStatus("2026-08", "not-a-month")).toThrow(/形式が不正/);
  });
});

// ---------------------------------------------------------------------------
// (4) 指標定義
// ---------------------------------------------------------------------------

describe("FFAJ_OTC_FX_INDICATORS", () => {
  it("キーが重複しない", () => {
    const keys = FFAJ_OTC_FX_INDICATORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("各指標が必須項目 (キー・表示名・要件・flowType・平易な説明・正確な定義・単位・出典・利用条件・頻度・限界) を持つ", () => {
    for (const def of FFAJ_OTC_FX_INDICATORS) {
      expect(def.key.length).toBeGreaterThan(0);
      expect(def.displayName.length).toBeGreaterThan(0);
      expect(def.requirements.length).toBeGreaterThan(0);
      expect(def.plainExplanation.length).toBeGreaterThan(0);
      expect(def.preciseDefinition.length).toBeGreaterThan(0);
      expect(def.unit.length).toBeGreaterThan(0);
      expect(def.sourceUrl).toBe(FFAJ_INDEX_URL);
      expect(def.usageTerms).toContain("commercial_use");
      expect(def.frequency).toBe("月次");
      expect(def.limitations.length).toBeGreaterThan(0);
    }
  });

  it("預託証拠金の純増減額は fund_flow、残高は holdings_stock に分類する", () => {
    const netChange = FFAJ_OTC_FX_INDICATORS.find((d) => d.key === "ffaj_otc_fx_customer_deposit_net_change");
    const balance = FFAJ_OTC_FX_INDICATORS.find((d) => d.key === "ffaj_otc_fx_deposit_required_balance");
    expect(netChange?.flowType).toBe("fund_flow");
    expect(balance?.flowType).toBe("holdings_stock");
  });
});

// ---------------------------------------------------------------------------
// 縦長 (観測ログ) 形式への変換
// ---------------------------------------------------------------------------

describe("toFfajOtcFxObservations / parseFfajOtcFxFiles", () => {
  it("3ファイル分をまとめてパースし、縦長レコードへ変換できる", () => {
    const parsed = parseFfajOtcFxFiles({
      tradingVolAndPosition: buildTradingVolAndPosition({}),
      openPositionWithMc: buildOpenPositionWithMc({}),
      depositAmountInformation: buildDepositAmountInformation({}),
    });
    const observations = toFfajOtcFxObservations(parsed);

    // 市場全体 4 指標 × 2ヶ月 + 通貨別 1 指標 × 9通貨 × 1ヶ月 + 預託 3指標 × 2ヶ月
    expect(observations.length).toBe(4 * 2 + 9 * 1 + 3 * 2);

    const turnoverAug = observations.find(
      (o) => o.indicatorKey === "ffaj_otc_fx_turnover" && o.period === "2026-08"
    );
    expect(turnoverAug).toMatchObject({
      segment: "market",
      value: KNOWN_VALUES_2026_08.turnoverMillionYen,
      unit: "百万円",
      isApproximate: true,
      isEstimated: false,
    });

    const netLongUsd = observations.find(
      (o) => o.indicatorKey === "ffaj_otc_fx_net_long_position" && o.segment === "USD"
    );
    expect(netLongUsd?.value).toBe(KNOWN_VALUES_2026_08.usd.netLong);

    const depositNetChangeJul = observations.find(
      (o) => o.indicatorKey === "ffaj_otc_fx_customer_deposit_net_change" && o.period === "2026-07"
    );
    expect(depositNetChangeJul?.value).toBe(KNOWN_VALUES_2026_07.netChange);
  });

  it('正味増減額が null (原資料 "na") の月は観測ログにレコードを作らず、他の指標は作る', () => {
    const parsed = parseFfajOtcFxFiles({
      tradingVolAndPosition: buildTradingVolAndPosition({ dataRows: [[4, 2015, 1, 1, 1, 2]] }),
      openPositionWithMc: buildOpenPositionWithMc({
        monthRows: [{ month: 4, year: 2015, blocks: CURRENCY_BLOCK_VALUES_2026_08 }],
      }),
      depositAmountInformation: buildDepositAmountInformation({
        dataRows: [[2015, 4, 1_000_000, 900_000, 50_000_000_000, "na", 51_000_000_000, 102.0]],
      }),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const observations = toFfajOtcFxObservations(parsed);

    expect(
      observations.find((o) => o.indicatorKey === "ffaj_otc_fx_customer_deposit_net_change" && o.period === "2015-04")
    ).toBeUndefined();
    expect(
      observations.find((o) => o.indicatorKey === "ffaj_otc_fx_deposit_required_balance" && o.period === "2015-04")
    ).toMatchObject({ value: 50_000_000_000 });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain("2015-04");
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// ルール6: Notion アーカイブ入力の組み立て (Notion への実書込は行わない)
// ---------------------------------------------------------------------------

describe("ffajOtcFxArchiveInput", () => {
  it("最新公表月で冪等キーを組み、3ファイルの実体を渡す", () => {
    const raw = {
      page: {
        updatedOn: "2026-09-14",
        latestPublishedMonth: "2026-08",
        tradingVolAndPositionUrl: "https://example.invalid/a.xls",
        openPositionWithMcUrl: "https://example.invalid/b.xls",
        depositAmountInformationUrl: "https://example.invalid/c.xls",
      },
      tradingVolAndPosition: new Uint8Array([1, 2, 3]),
      openPositionWithMc: new Uint8Array([4, 5]),
      depositAmountInformation: new Uint8Array([6]),
    };
    const input = ffajOtcFxArchiveInput(raw);
    expect(input.service).toBe("moneyflow");
    expect(input.key).toBe("ffaj-otc-fx-2026-08");
    expect(input.source).toBe(FFAJ_INDEX_URL);
    expect(input.files).toHaveLength(3);
    expect(input.files[0]!.bytes).toBe(raw.tradingVolAndPosition);
    expect(input.metadata).toMatchObject({ month: "2026-08", updatedOn: "2026-09-14" });
  });
});
