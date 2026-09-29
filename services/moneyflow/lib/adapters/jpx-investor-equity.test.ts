import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMoneyflowFlowType,
  isMoneyflowFrequency,
  isMoneyflowLicense,
  isMoneyflowRequirement,
  observationKey,
} from "../../../../src/shared/notion-archive/moneyflow.js";
import { validateDrafts, type ObservationDraft, type SpecFile } from "../source-spec.js";
import * as sourceModule from "../sources/jpx-investor-equity.js";
import type { InvestorEquityMarket, InvestorEquityRecord } from "../sources/jpx-investor-equity.js";
import {
  JPX_INVESTOR_EQUITY_MONTHLY_SPEC,
  JPX_INVESTOR_EQUITY_SPECS,
  JPX_INVESTOR_EQUITY_WEEKLY_SPEC,
  weeklyKeyFromIndexLabel,
} from "./jpx-investor-equity.js";

// 解析関数は既定では本物の実装に委ね、CI 用の合成テストだけ mockImplementationOnce で差し替える。
vi.mock("../sources/jpx-investor-equity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sources/jpx-investor-equity.js")>();
  return { ...actual, parseInvestorEquityWorkbook: vi.fn(actual.parseInvestorEquityWorkbook) };
});

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, "../sources/fixtures/private/jpx-investor-equity");
const fx = (name: string): string => join(FIXTURE_DIR, name);
const WEEKLY_FIXTURES = [
  "weekly-index-2026-09-27.html",
  "weekly-value-2026-w2-0907-0911.xls",
  "weekly-volume-2026-w2-0907-0911.xls",
].map(fx);
const MONTHLY_FIXTURES = ["monthly-index-2026-09-27.html", "monthly-value-2026-08.xls", "monthly-volume-2026-08.xls"].map(
  fx
);
const UNIFIED_SAMPLE = fx("unified-format-sample-jpx-official.xlsx");
const UNIFIED_W3_XLSX = fx("weekly-unified-2026-w3-0914-0918.xlsx");
const UNIFIED_W3_INDEX = fx("weekly-index-2026-09-29.html");
const hasWeekly = WEEKLY_FIXTURES.every((p) => existsSync(p));
const hasMonthly = MONTHLY_FIXTURES.every((p) => existsSync(p));
const hasUnified = existsSync(UNIFIED_SAMPLE);
const hasUnifiedW3 = existsSync(UNIFIED_W3_XLSX) && existsSync(UNIFIED_W3_INDEX);
const hasWeeklyPrev = ["weekly-value-2026-w1-0831-0904.xls", "weekly-volume-2026-w1-0831-0904.xls"].every((n) =>
  existsSync(fx(n))
);

const bytesOf = (p: string): Uint8Array => new Uint8Array(readFileSync(p));

const weeklyFiles = (): SpecFile[] => [
  { filename: "investor-equity-value-stock_val_1_260902.xls", bytes: bytesOf(WEEKLY_FIXTURES[1] as string) },
  { filename: "investor-equity-volume-stock_vol_1_260902.xls", bytes: bytesOf(WEEKLY_FIXTURES[2] as string) },
];
const monthlyFiles = (): SpecFile[] => [
  { filename: "investor-equity-value-stock_val_1_m2608.xls", bytes: bytesOf(MONTHLY_FIXTURES[1] as string) },
  { filename: "investor-equity-volume-stock_vol_1_m2608.xls", bytes: bytesOf(MONTHLY_FIXTURES[2] as string) },
];
const unifiedW3Files = (): SpecFile[] => [
  {
    filename: "investor-equity-unified-stock_1_w_20260914_20260918.xlsx",
    bytes: bytesOf(UNIFIED_W3_XLSX),
  },
];

function find(drafts: readonly ObservationDraft[], indicatorKey: string, category: string): ObservationDraft {
  const hits = drafts.filter((d) => d.indicatorKey === indicatorKey && d.category === category);
  expect(hits).toHaveLength(1);
  return hits[0] as ObservationDraft;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("指標定義", () => {
  it("全指標が enum ガードを通り、キーが一意・https・日本語の説明と限界を持つ", () => {
    const all = JPX_INVESTOR_EQUITY_SPECS.flatMap((s) => s.indicators);
    expect(all).toHaveLength(12);
    expect(JPX_INVESTOR_EQUITY_WEEKLY_SPEC.indicators).toHaveLength(8);
    expect(JPX_INVESTOR_EQUITY_MONTHLY_SPEC.indicators).toHaveLength(4);
    expect(new Set(all.map((i) => i.key)).size).toBe(all.length);
    for (const ind of all) {
      expect(isMoneyflowFlowType(ind.flowType)).toBe(true);
      expect(isMoneyflowFrequency(ind.frequency)).toBe(true);
      expect(isMoneyflowLicense(ind.license)).toBe(true);
      expect(isMoneyflowRequirement(ind.requirement)).toBe(true);
      expect(ind.sourceUrl).toMatch(/^https:\/\/www\.jpx\.co\.jp\//);
      expect(ind.description).toMatch(/[ぁ-んァ-ン一-龥]/);
      expect(ind.limitations).toMatch(/[ぁ-んァ-ン一-龥]/);
      expect(ind.license).toBe("personal-only");
    }
    expect(JPX_INVESTOR_EQUITY_WEEKLY_SPEC.indicators.every((i) => i.frequency === "週次")).toBe(true);
    expect(JPX_INVESTOR_EQUITY_MONTHLY_SPEC.indicators.every((i) => i.frequency === "月次")).toBe(true);
    expect(JPX_INVESTOR_EQUITY_SPECS.map((s) => s.name)).toEqual([
      "jpx-investor-equity-weekly",
      "jpx-investor-equity-monthly",
    ]);
  });

  it("限界に「公表後の訂正は自動反映されない」を明記し、未確認の月帰属規則を事実として書かない", () => {
    // JPX 週次一覧ページには「訂正情報（2024年9月10日）」が載っており、公表値の訂正はありうる。
    // 冪等キーに版を含めない以上、訂正が反映されないことを利用者に示す必要がある。
    for (const ind of JPX_INVESTOR_EQUITY_SPECS.flatMap((s) => s.indicators)) {
      expect(ind.limitations).toMatch(/訂正/);
      expect(ind.limitations).toMatch(/自動では反映されない/);
    }
    // 月をまたぐ週の帰属は 8/31〜9/4 (=9月第1週) の1例しか確認できていない。9月分の月次が
    // 9/28〜10/2 週と同じ 10/8 に掲載予定であることから「終了日の月に数える」とは限らない。
    for (const ind of JPX_INVESTOR_EQUITY_WEEKLY_SPEC.indicators) {
      expect(ind.limitations).not.toMatch(/終了日の月に数える/);
      expect(ind.limitations).toMatch(/確認できていない/);
    }
  });

  it("週次に売付/買付の4キーを含み、net/gross と unit・source・定義が整合する (月次は付けない)", () => {
    const weekly = JPX_INVESTOR_EQUITY_WEEKLY_SPEC.indicators;
    const monthlyKeys = new Set(JPX_INVESTOR_EQUITY_MONTHLY_SPEC.indicators.map((i) => i.key));
    for (const kind of ["sell_value", "buy_value", "sell_volume", "buy_volume"] as const) {
      const key = `jpx_investor_equity_${kind}_weekly`;
      const found = weekly.find((i) => i.key === key);
      expect(found).toBeDefined();
      expect(found!.frequency).toBe("週次");
      expect(found!.license).toBe("personal-only");
      expect(found!.sourceUrl).toMatch(/^https:\/\/www\.jpx\.co\.jp\/markets\/statistics-equities\/investor-type\//);
      expect(found!.limitations).toMatch(/新様式ファイル/);
      expect(monthlyKeys.has(`jpx_investor_equity_${kind}_monthly`)).toBe(false);
    }
    const sellValue = weekly.find((i) => i.key === "jpx_investor_equity_sell_value_weekly")!;
    const buyVolume = weekly.find((i) => i.key === "jpx_investor_equity_buy_volume_weekly")!;
    expect(sellValue.description).toMatch(/円/);
    expect(buyVolume.description).toMatch(/株/);
    expect(sellValue.description).toMatch(/売付金額/);
    expect(buyVolume.description).toMatch(/買付株数/);
  });
});

describe("weeklyKeyFromIndexLabel (一覧ページの行ラベル → 冪等キー)", () => {
  it("期間終了日の ISO 週をキーにする (月またぎの第1週を含む)", () => {
    expect(weeklyKeyFromIndexLabel("2026年9月第2週(9月7日～9月11日)")).toBe("jpx-investor-equity-weekly-2026-W37");
    expect(weeklyKeyFromIndexLabel("2026年9月第1週(8月31日～9月4日)")).toBe("jpx-investor-equity-weekly-2026-W36");
    expect(weeklyKeyFromIndexLabel("2026年9月第3週(9月14日～9月18日)")).toBe("jpx-investor-equity-weekly-2026-W38");
  });
  it("年末年始は ISO 週年で数える (2026 は 53 週ある年)", () => {
    expect(weeklyKeyFromIndexLabel("2026年12月第5週(12月28日～12月30日)")).toBe("jpx-investor-equity-weekly-2026-W53");
    expect(weeklyKeyFromIndexLabel("2027年1月第1週(1月4日～1月8日)")).toBe("jpx-investor-equity-weekly-2027-W01");
  });
  it("様式外・終了日の月がラベルの月と違う・暦日でないラベルは throw", () => {
    expect(() => weeklyKeyFromIndexLabel("2026年9月第2週")).toThrow(/様式が想定外/);
    expect(() => weeklyKeyFromIndexLabel("2026年9月第5週(9月28日～10月2日)")).toThrow(/一致しません/);
    expect(() => weeklyKeyFromIndexLabel("2026年9月第5週(9月28日～9月31日)")).toThrow(/暦日/);
  });
});

// ---------------------------------------------------------------------------
// CI で走る合成テスト (以下のレコードは テスト用の合成入力 であり実データではない)
// ---------------------------------------------------------------------------

const MARKETS: readonly InvestorEquityMarket[] = ["TSE Prime", "TSE Standard", "TSE Growth", "Tokyo & Nagoya"];
const CATEGORIES = [
  "自己計",
  "委託計",
  "総計",
  "法人",
  "個人",
  "海外投資家",
  "証券会社",
  "投資信託",
  "事業法人",
  "その他法人等",
  "金融機関",
  "生保・損保",
  "都銀・地銀等",
  "信託銀行",
  "その他金融機関",
];

/** テスト用の合成レコード (実データではない)。sell=100, buy=130 固定。 */
function syntheticRecords(
  metric: "value" | "volume",
  over: Partial<InvestorEquityRecord> = {}
): InvestorEquityRecord[] {
  const out: InvestorEquityRecord[] = [];
  for (const market of MARKETS) {
    for (const investorCategory of CATEGORIES) {
      out.push({
        formatVersion: "legacy_split_files",
        periodType: "weekly",
        periodLabel: "2026年9月第2週",
        periodStart: "2026-09-07",
        periodEnd: "2026-09-11",
        market,
        investorCategory,
        isAggregateCategory: false,
        metric,
        unit: metric === "value" ? "thousand_yen" : "thousand_shares",
        sell: 100,
        buy: 130,
        net: 30,
        total: 230,
        ...over,
      } as InvestorEquityRecord);
    }
  }
  return out;
}

const SYNTH_FILES: SpecFile[] = [
  { filename: "investor-equity-value-synthetic.xls", bytes: new Uint8Array([1]) },
  { filename: "investor-equity-volume-synthetic.xls", bytes: new Uint8Array([2]) },
];

function mockParse(value: InvestorEquityRecord[], volume: InvestorEquityRecord[]): void {
  const parse = vi.mocked(sourceModule.parseInvestorEquityWorkbook);
  parse.mockImplementationOnce(() => value).mockImplementationOnce(() => volume);
}

const UNIFIED_SYNTH_CATEGORIES = [
  "自己現金",
  "自己信用",
  "個人現金",
  "個人信用",
  "海外投資家法人",
  "海外投資家個人",
  "証券会社",
  "投資信託",
  "事業法人",
  "その他法人等",
  "生保・損保",
  "都銀・地銀等",
  "信託銀行",
  "その他金融機関",
];

/** テスト用の合成レコード: 新様式の単一ファイルの中身 (実データではない)。sell=100, buy=130 固定。 */
function syntheticUnifiedRecords(): InvestorEquityRecord[] {
  const out: InvestorEquityRecord[] = [];
  for (const metric of ["value", "volume"] as const) {
    for (const market of MARKETS) {
      for (const investorCategory of UNIFIED_SYNTH_CATEGORIES) {
        out.push({
          formatVersion: "unified_single_file",
          periodType: "weekly",
          periodLabel: "2026年9月第3週",
          periodStart: "2026-09-14",
          periodEnd: "2026-09-18",
          market,
          investorCategory,
          isAggregateCategory: false,
          metric,
          unit: metric === "value" ? "thousand_yen" : "thousand_shares",
          sell: 100,
          buy: 130,
          net: 30,
          total: 230,
        } as InvestorEquityRecord);
      }
    }
  }
  return out;
}

const SYNTH_UNIFIED_FILES: SpecFile[] = [
  { filename: "investor-equity-unified-synthetic.xlsx", bytes: new Uint8Array([3]) },
];

function mockParseOnce(records: InvestorEquityRecord[]): void {
  vi.mocked(sourceModule.parseInvestorEquityWorkbook).mockImplementationOnce(() => records);
}

describe("toObservations の写像 (合成入力・CI 用)", () => {
  it("千円→円・千株→株に換算し、区分を「市場 / 投資部門」、行数 240 で出す", () => {
    mockParse(syntheticRecords("value"), syntheticRecords("volume"));
    const drafts = JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({
      key: "jpx-investor-equity-weekly-2026-W37",
      files: SYNTH_FILES,
    });
    validateDrafts(JPX_INVESTOR_EQUITY_WEEKLY_SPEC.name, drafts, JPX_INVESTOR_EQUITY_WEEKLY_SPEC.indicators);
    expect(drafts).toHaveLength(240);
    const net = find(drafts, "jpx_investor_equity_net_flow_value_weekly", "東証プライム / 海外投資家");
    expect(net).toMatchObject({
      period: "2026-W37",
      periodStart: "2026-09-07",
      periodEnd: "2026-09-11",
      value: 30_000,
      unit: "円",
      categoryKind: "投資部門",
      changeFromPrev: null,
      approximate: false,
      measureKind: "実測",
    });
    expect(find(drafts, "jpx_investor_equity_gross_turnover_volume_weekly", "二市場 / その他金融機関")).toMatchObject({
      value: 230_000,
      unit: "株",
    });
    // 最後の行 (取込完了の印) は決定的
    expect(drafts[drafts.length - 1]).toMatchObject({
      indicatorKey: "jpx_investor_equity_gross_turnover_volume_weekly",
      category: "二市場 / その他金融機関",
    });
  });

  it("未知の投資部門名は throw", () => {
    const value = syntheticRecords("value");
    (value[3] as InvestorEquityRecord).investorCategory = "謎の部門";
    mockParse(value, syntheticRecords("volume"));
    expect(() =>
      JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({ key: "jpx-investor-equity-weekly-2026-W37", files: SYNTH_FILES })
    ).toThrow(/未知の投資部門/);
  });

  it("未知の単位は throw", () => {
    mockParse(syntheticRecords("value", { unit: "yen" as never }), syntheticRecords("volume"));
    expect(() =>
      JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({ key: "jpx-investor-equity-weekly-2026-W37", files: SYNTH_FILES })
    ).toThrow(/未知の単位/);
  });

  it("新様式の単一ファイルは 448 行を出す (合成入力。net/gross/sell/buy)", () => {
    mockParseOnce(syntheticUnifiedRecords());
    const drafts = JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({
      key: "jpx-investor-equity-weekly-2026-W38",
      files: SYNTH_UNIFIED_FILES,
    });
    validateDrafts(JPX_INVESTOR_EQUITY_WEEKLY_SPEC.name, drafts, JPX_INVESTOR_EQUITY_WEEKLY_SPEC.indicators);
    expect(drafts).toHaveLength(4 * 14 * 2 * 4);
    expect(find(drafts, "jpx_investor_equity_net_flow_value_weekly", "東証プライム / 自己現金")).toMatchObject({
      period: "2026-W38",
      periodStart: "2026-09-14",
      periodEnd: "2026-09-18",
      value: 30_000,
      unit: "円",
      categoryKind: "投資部門",
    });
    // 旧様式と同名の部門は同じ区分で継続する
    expect(find(drafts, "jpx_investor_equity_gross_turnover_volume_weekly", "二市場 / 証券会社")).toMatchObject({
      value: 230_000,
      unit: "株",
    });
    // 公式売付/買付セルを直接記録する
    expect(find(drafts, "jpx_investor_equity_sell_value_weekly", "東証プライム / 自己現金").value).toBe(100_000);
    expect(find(drafts, "jpx_investor_equity_buy_volume_weekly", "二市場 / 証券会社").value).toBe(130_000);
  });

  it("新様式の行は6内訳を持ち、冪等キーは7セグメント (category は表示のみ)", () => {
    mockParseOnce(syntheticUnifiedRecords());
    const drafts = JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({
      key: "jpx-investor-equity-weekly-2026-W38",
      files: SYNTH_UNIFIED_FILES,
    });
    const cash = find(drafts, "jpx_investor_equity_sell_value_weekly", "東証プライム / 自己現金");
    expect(cash).toMatchObject({
      marketSegment: "東証プライム",
      investorCategory: "自己現金",
      tradeType: "現金",
      parentCategory: "自己計",
      categoryLevel: 1,
      publicationDate: null,
    });
    expect(observationKey(cash)).toBe(
      "2026-W38|jpx_investor_equity_sell_value_weekly|東証プライム|自己現金|現金|自己計|1"
    );
    // 現金/信用に分かれていない部門の取引種別は null (捏造しない)
    const sec = find(drafts, "jpx_investor_equity_buy_value_weekly", "東証プライム / 証券会社");
    expect(sec).toMatchObject({ tradeType: null, parentCategory: "委託計", categoryLevel: 1 });
    expect(observationKey(sec)).toBe(
      "2026-W38|jpx_investor_equity_buy_value_weekly|東証プライム|証券会社||委託計|1"
    );
  });

  it("旧様式の行は名前付き内訳を持たず、従来キー `期間|指標|区分` のまま", () => {
    mockParse(syntheticRecords("value"), syntheticRecords("volume"));
    const drafts = JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({
      key: "jpx-investor-equity-weekly-2026-W37",
      files: SYNTH_FILES,
    });
    const net = find(drafts, "jpx_investor_equity_net_flow_value_weekly", "東証プライム / 海外投資家");
    expect(net.marketSegment).toBeUndefined();
    expect(net.investorCategory).toBeUndefined();
    expect(net.tradeType).toBeUndefined();
    expect(net.parentCategory).toBeUndefined();
    expect(net.categoryLevel).toBeUndefined();
    expect(net.publicationDate).toBeUndefined();
    expect(observationKey(net)).toBe(
      "2026-W37|jpx_investor_equity_net_flow_value_weekly|東証プライム / 海外投資家"
    );
  });

  it("旧様式名のファイルに新様式レコードが混ざれば throw (ファイル名と中身の不一致)", () => {
    mockParse(syntheticUnifiedRecords(), syntheticRecords("volume"));
    expect(() =>
      JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({ key: "jpx-investor-equity-weekly-2026-W37", files: SYNTH_FILES })
    ).toThrow(/様式が不一致/);
  });

  it("新様式ファイルを月次 spec に渡すと throw (月次新様式は未公表)", () => {
    // 期間種別の検査は解析より先のため、parse の mock は積まない
    // (積むと消費されず後続テストへ漏れる)。
    expect(() =>
      JPX_INVESTOR_EQUITY_MONTHLY_SPEC.toObservations({
        key: "jpx-investor-equity-monthly-2026-09",
        files: SYNTH_UNIFIED_FILES,
      })
    ).toThrow(/月次の新様式/);
  });

  it("新様式ファイルと他のファイルが混ざれば throw", () => {
    expect(() =>
      JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({
        key: "jpx-investor-equity-weekly-2026-W38",
        files: [...SYNTH_UNIFIED_FILES, SYNTH_FILES[0] as SpecFile],
      })
    ).toThrow(/混ざっています/);
  });

  it("金額と株数で期間が違う・金額ファイルに株数が混ざる・キーと期間の不一致は throw", () => {
    mockParse(syntheticRecords("value"), syntheticRecords("volume", { periodEnd: "2026-09-04" }));
    expect(() =>
      JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({ key: "jpx-investor-equity-weekly-2026-W37", files: SYNTH_FILES })
    ).toThrow(/食い違って/);
    mockParse(syntheticRecords("volume"), syntheticRecords("volume"));
    expect(() =>
      JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({ key: "jpx-investor-equity-weekly-2026-W37", files: SYNTH_FILES })
    ).toThrow(/金額 \(value\) のファイルではありません/);
    mockParse(syntheticRecords("value"), syntheticRecords("volume"));
    expect(() =>
      JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({ key: "jpx-investor-equity-weekly-2026-W36", files: SYNTH_FILES })
    ).toThrow(/一致しません/);
  });

  it("週次のファイルを月次 spec に渡すと throw (期間種別の取り違え)", () => {
    mockParse(syntheticRecords("value"), syntheticRecords("volume"));
    expect(() =>
      JPX_INVESTOR_EQUITY_MONTHLY_SPEC.toObservations({ key: "jpx-investor-equity-monthly-2026-09", files: SYNTH_FILES })
    ).toThrow(/monthly のはずが weekly/);
  });

  it("ファイル欠落・不正なキーは解析前に throw", () => {
    expect(() =>
      JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({
        key: "jpx-investor-equity-weekly-2026-W37",
        files: [SYNTH_FILES[0] as SpecFile],
      })
    ).toThrow(/株数ファイル: 該当ファイルが 0 件/);
    expect(() =>
      JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({ key: "jpx-investor-equity-weekly-2026-09-11", files: SYNTH_FILES })
    ).toThrow(/冪等キーの様式/);
  });
});

// ---------------------------------------------------------------------------
// 実ファイル (2026-09-27 取得。private/ は commit しないため CI では skip)
// ---------------------------------------------------------------------------

describe.skipIf(!hasWeekly)("実ファイル: 週次 2026年9月第2週 (9/7〜9/11) と第1週", () => {
  it("validateDrafts を通り、行数 240・値は千円/千株→円/株に換算される", () => {
    const drafts = JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({
      key: "jpx-investor-equity-weekly-2026-W37",
      files: weeklyFiles(),
    });
    validateDrafts(JPX_INVESTOR_EQUITY_WEEKLY_SPEC.name, drafts, JPX_INVESTOR_EQUITY_WEEKLY_SPEC.indicators);
    expect(drafts).toHaveLength(240);
    expect(drafts.every((d) => d.period === "2026-W37" && d.periodStart === "2026-09-07" && d.periodEnd === "2026-09-11")).toBe(
      true
    );
    // python xlrd で独立に読んだ値 (TSE Prime 海外投資家: 売 28,570,404,573 / 買 28,295,470,330 千円)
    expect(find(drafts, "jpx_investor_equity_net_flow_value_weekly", "東証プライム / 海外投資家").value).toBe(
      -274_934_243_000
    );
    // TSE Prime 個人 合計 23,018,500,585 千円
    expect(find(drafts, "jpx_investor_equity_gross_turnover_value_weekly", "東証プライム / 個人").value).toBe(
      23_018_500_585_000
    );
    // Tokyo & Nagoya 総計 株数合計 35,820,577 千株 / 差引 2,481 千株
    expect(find(drafts, "jpx_investor_equity_gross_turnover_volume_weekly", "二市場 / 総計")).toMatchObject({
      value: 35_820_577_000,
      unit: "株",
    });
    expect(find(drafts, "jpx_investor_equity_net_flow_volume_weekly", "二市場 / 総計").value).toBe(2_481_000);
    // TSE Growth 個人 株数 差引 29,966 千株
    expect(find(drafts, "jpx_investor_equity_net_flow_volume_weekly", "東証グロース / 個人").value).toBe(29_966_000);
    // レビューで python xlrd から独立に読んだ追加値 (総計・負値・最小区分を含む)
    // 二市場 総計 金額: 差引 -15,921,956 千円
    expect(find(drafts, "jpx_investor_equity_net_flow_value_weekly", "二市場 / 総計").value).toBe(-15_921_956_000);
    // 東証スタンダード 生保・損保 金額: 売 399,228 / 買 89,223 千円 (差引欄 -310,005)
    expect(find(drafts, "jpx_investor_equity_net_flow_value_weekly", "東証スタンダード / 生保・損保").value).toBe(
      -310_005_000
    );
    // 東証グロース 信託銀行 株数合計 4,598 千株
    expect(find(drafts, "jpx_investor_equity_gross_turnover_volume_weekly", "東証グロース / 信託銀行").value).toBe(
      4_598_000
    );
    // 東証プライム 海外投資家 株数: 差引 -70,583 千株
    expect(find(drafts, "jpx_investor_equity_net_flow_volume_weekly", "東証プライム / 海外投資家").value).toBe(-70_583_000);
  });

  it.skipIf(!hasWeeklyPrev)("第1週 (8/31〜9/4) のファイルは W36・その週の欄の値になる (前週欄を読まない)", () => {
    const drafts = JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({
      key: "jpx-investor-equity-weekly-2026-W36",
      files: [
        { filename: "investor-equity-value-stock_val_1_260901.xls", bytes: bytesOf(fx("weekly-value-2026-w1-0831-0904.xls")) },
        { filename: "investor-equity-volume-stock_vol_1_260901.xls", bytes: bytesOf(fx("weekly-volume-2026-w1-0831-0904.xls")) },
      ],
    });
    validateDrafts(JPX_INVESTOR_EQUITY_WEEKLY_SPEC.name, drafts, JPX_INVESTOR_EQUITY_WEEKLY_SPEC.indicators);
    expect(drafts.every((d) => d.period === "2026-W36" && d.periodStart === "2026-08-31" && d.periodEnd === "2026-09-04")).toBe(
      true
    );
    // 二市場 総計 金額 差引 +10,649,727 千円 / 東証スタンダード 生保・損保 差引 -453,728 千円
    // (後者は第2週ファイルの前週欄「08/31～09/04」とも一致 = 同じ週の値)
    expect(find(drafts, "jpx_investor_equity_net_flow_value_weekly", "二市場 / 総計").value).toBe(10_649_727_000);
    expect(find(drafts, "jpx_investor_equity_net_flow_value_weekly", "東証スタンダード / 生保・損保").value).toBe(
      -453_728_000
    );
  });
});

describe.skipIf(!hasMonthly)("実ファイル: 月次 2026年8月 (8/3〜8/28)", () => {
  it("validateDrafts を通り、期間ラベルは JPX の帰属年月・期間は実際の集計期間", () => {
    const drafts = JPX_INVESTOR_EQUITY_MONTHLY_SPEC.toObservations({
      key: "jpx-investor-equity-monthly-2026-08",
      files: monthlyFiles(),
    });
    validateDrafts(JPX_INVESTOR_EQUITY_MONTHLY_SPEC.name, drafts, JPX_INVESTOR_EQUITY_MONTHLY_SPEC.indicators);
    expect(drafts).toHaveLength(240);
    expect(drafts.every((d) => d.period === "2026-08" && d.periodStart === "2026-08-03" && d.periodEnd === "2026-08-28")).toBe(
      true
    );
    // TSE Prime 自己計: 売 18,077,441,828 / 買 18,547,327,192 千円
    expect(find(drafts, "jpx_investor_equity_net_flow_value_monthly", "東証プライム / 自己計").value).toBe(469_885_364_000);
    // Tokyo & Nagoya 総計 合計 407,516,356,670 千円
    expect(find(drafts, "jpx_investor_equity_gross_turnover_value_monthly", "二市場 / 総計").value).toBe(
      407_516_356_670_000
    );
    // TSE Growth 海外投資家 差引 33,064,261 千円
    expect(find(drafts, "jpx_investor_equity_net_flow_value_monthly", "東証グロース / 海外投資家").value).toBe(
      33_064_261_000
    );
    // Tokyo & Nagoya その他金融機関 株数 差引 -38,353 千株
    expect(find(drafts, "jpx_investor_equity_net_flow_volume_monthly", "二市場 / その他金融機関").value).toBe(-38_353_000);
    // レビューで独立に読んだ追加値: 東証スタンダード 個人 金額 差引 -36,038,564 千円 /
    // 二市場 総計 金額 差引 +143,507,594 千円
    expect(find(drafts, "jpx_investor_equity_net_flow_value_monthly", "東証スタンダード / 個人").value).toBe(
      -36_038_564_000
    );
    expect(find(drafts, "jpx_investor_equity_net_flow_value_monthly", "二市場 / 総計").value).toBe(143_507_594_000);
  });
});

describe.skipIf(!hasUnifiedW3)("実ファイル: 新様式 週次 2026年9月第3週 (9/14〜9/18)", () => {
  it("validateDrafts を通り、行数 448・値は千円/千株→円/株に換算される", () => {
    const drafts = JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({
      key: "jpx-investor-equity-weekly-2026-W38",
      files: unifiedW3Files(),
    });
    validateDrafts(JPX_INVESTOR_EQUITY_WEEKLY_SPEC.name, drafts, JPX_INVESTOR_EQUITY_WEEKLY_SPEC.indicators);
    expect(drafts).toHaveLength(448);
    expect(drafts.every((d) => d.period === "2026-W38" && d.periodStart === "2026-09-14" && d.periodEnd === "2026-09-18")).toBe(
      true
    );
    // TSE Prime 自己現金 金額: 差引 1,654,475,050 千円 / 合計 9,541,520,114 千円
    expect(find(drafts, "jpx_investor_equity_net_flow_value_weekly", "東証プライム / 自己現金").value).toBe(
      1_654_475_050_000
    );
    expect(find(drafts, "jpx_investor_equity_gross_turnover_value_weekly", "東証プライム / 自己現金").value).toBe(
      9_541_520_114_000
    );
    // TSE Prime 証券会社 金額: 差引 -7,494,776 千円 (旧様式と同名の区分で継続)
    expect(find(drafts, "jpx_investor_equity_net_flow_value_weekly", "東証プライム / 証券会社").value).toBe(-7_494_776_000);
    // 二市場 海外投資家個人 金額: 合計 190,504,668 千円
    expect(find(drafts, "jpx_investor_equity_gross_turnover_value_weekly", "二市場 / 海外投資家個人").value).toBe(
      190_504_668_000
    );
    // TSE Prime 自己現金 株数: 差引 602,967 千株
    expect(find(drafts, "jpx_investor_equity_net_flow_volume_weekly", "東証プライム / 自己現金").value).toBe(602_967_000);
    // TSE Prime 自己現金 金額: 売 3,943,522,532 / 買 5,597,997,582 千円 (公式セル直接値)
    expect(find(drafts, "jpx_investor_equity_sell_value_weekly", "東証プライム / 自己現金").value).toBe(
      3_943_522_532_000
    );
    expect(find(drafts, "jpx_investor_equity_buy_value_weekly", "東証プライム / 自己現金").value).toBe(5_597_997_582_000);
    // 名前付き内訳: 自己現金は 現金/自己計、証券会社は取引種別なし/委託計
    expect(find(drafts, "jpx_investor_equity_sell_value_weekly", "東証プライム / 自己現金")).toMatchObject({
      marketSegment: "東証プライム",
      investorCategory: "自己現金",
      tradeType: "現金",
      parentCategory: "自己計",
      categoryLevel: 1,
      publicationDate: null,
    });
    expect(find(drafts, "jpx_investor_equity_buy_value_weekly", "東証プライム / 証券会社")).toMatchObject({
      investorCategory: "証券会社",
      tradeType: null,
      parentCategory: "委託計",
    });
  });

  it("旧様式の合計行の系列は含まれず、新旧の別名系列は混ざらない", () => {
    const drafts = JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({
      key: "jpx-investor-equity-weekly-2026-W38",
      files: unifiedW3Files(),
    });
    const categories = new Set(drafts.map((d) => d.category));
    expect(categories.has("東証プライム / 証券会社")).toBe(true);
    expect(categories.has("東証プライム / 自己現金")).toBe(true);
    for (const ended of ["自己計", "委託計", "総計", "法人", "金融機関"]) {
      expect([...categories].some((c) => c.endsWith(` / ${ended}`))).toBe(false);
    }
    // 旧様式の「個人」「海外投資家」(単独名) も含まれない
    expect([...categories].some((c) => c.endsWith(" / 個人") || c.endsWith(" / 海外投資家"))).toBe(false);
  });

  it("新様式の実ファイルを旧様式名で渡すと様式不一致で throw する", () => {
    const bytes = bytesOf(UNIFIED_W3_XLSX);
    expect(() =>
      JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({
        key: "jpx-investor-equity-weekly-2026-W38",
        files: [
          { filename: "investor-equity-value-stock_1_w_20260914_20260918.xlsx", bytes },
          { filename: "investor-equity-volume-stock_1_w_20260914_20260918.xlsx", bytes },
        ],
      })
    ).toThrow(/様式が不一致/);
  });
});

describe.skipIf(!hasUnified)("実ファイル: JPX 公式の新様式サンプル (実データではない仕様サンプル)", () => {
  it("サンプルは桁の検査で throw する (値が円/株単位のまま)", () => {
    const bytes = bytesOf(UNIFIED_SAMPLE);
    expect(() =>
      JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({
        key: "jpx-investor-equity-weekly-2026-W37",
        files: [{ filename: "investor-equity-unified-stock_1_w_YYYYMMDD_YYYYMMDD.xlsx", bytes }],
      })
    ).toThrow(/桁としてありえません/);
  });
});

/** 実ファイルを URL ごとに返す fetch スタブ (未知の URL は 404)。 */
function stubFetch(routes: Record<string, string>): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const hit = Object.entries(routes).find(([suffix]) => url.endsWith(suffix));
      if (!hit) return new Response("not found", { status: 404, statusText: "Not Found" });
      return new Response(readFileSync(hit[1]));
    })
  );
  return calls;
}

describe.skipIf(!hasWeekly)("resolve/fetch (週次、fetch スタブで実ファイルを返す)", () => {
  it("一覧ページだけでキーを決め、fetch は同じキー・安定したファイル名を返す", async () => {
    const calls = stubFetch({
      "/investor-type/index.html": WEEKLY_FIXTURES[0] as string,
      "stock_val_1_260902.xls": WEEKLY_FIXTURES[1] as string,
      "stock_vol_1_260902.xls": WEEKLY_FIXTURES[2] as string,
    });
    const resolved = await JPX_INVESTOR_EQUITY_WEEKLY_SPEC.resolve(new Date("2026-09-27T00:00:00Z"));
    expect(resolved.key).toBe("jpx-investor-equity-weekly-2026-W37");
    expect(calls).toHaveLength(1);
    const batch = await resolved.fetch();
    expect(calls).toHaveLength(3);
    expect(batch.key).toBe(resolved.key);
    expect(batch.files.map((f) => f.filename)).toEqual([
      "investor-equity-value-stock_val_1_260902.xls",
      "investor-equity-volume-stock_vol_1_260902.xls",
    ]);
    expect(batch.files.every((f) => f.contentType === "application/vnd.ms-excel" && f.bytes.length > 0)).toBe(true);
    const drafts = JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({ key: batch.key, files: batch.files });
    validateDrafts(JPX_INVESTOR_EQUITY_WEEKLY_SPEC.name, drafts, JPX_INVESTOR_EQUITY_WEEKLY_SPEC.indicators);
    expect(drafts).toHaveLength(240);
  });

  it.skipIf(!hasWeeklyPrev)("一覧ページとリンク先ファイルの期間が食い違えば fetch が throw (誤ったキーで保管しない)", async () => {
    stubFetch({
      "/investor-type/index.html": WEEKLY_FIXTURES[0] as string,
      // 最新行 (第2週) のリンク先に第1週のファイルを返す
      "stock_val_1_260902.xls": fx("weekly-value-2026-w1-0831-0904.xls"),
      "stock_vol_1_260902.xls": fx("weekly-volume-2026-w1-0831-0904.xls"),
    });
    const resolved = await JPX_INVESTOR_EQUITY_WEEKLY_SPEC.resolve(new Date("2026-09-27T00:00:00Z"));
    await expect(resolved.fetch()).rejects.toThrow(/一致しません/);
  });

  it("HTTP エラーは throw", async () => {
    stubFetch({});
    await expect(JPX_INVESTOR_EQUITY_WEEKLY_SPEC.resolve(new Date("2026-09-27T00:00:00Z"))).rejects.toThrow(/HTTP エラー 404/);
  });
});

describe.skipIf(!hasUnifiedW3)("resolve/fetch (週次新様式、fetch スタブで実ファイルを返す)", () => {
  it("新様式の最新週をキーにし、fetch は単一 xlsx の1ファイルを返す", async () => {
    const calls = stubFetch({
      "/investor-type/index.html": UNIFIED_W3_INDEX,
      "stock_1_w_20260914_20260918.xlsx": UNIFIED_W3_XLSX,
    });
    const resolved = await JPX_INVESTOR_EQUITY_WEEKLY_SPEC.resolve(new Date("2026-09-29T00:00:00Z"));
    expect(resolved.key).toBe("jpx-investor-equity-weekly-2026-W38");
    expect(calls).toHaveLength(1);
    const batch = await resolved.fetch();
    expect(calls).toHaveLength(2);
    expect(batch.key).toBe(resolved.key);
    expect(batch.files.map((f) => f.filename)).toEqual([
      "investor-equity-unified-stock_1_w_20260914_20260918.xlsx",
    ]);
    expect(batch.files[0]?.contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(batch.files[0]?.bytes.length).toBeGreaterThan(0);
    const drafts = JPX_INVESTOR_EQUITY_WEEKLY_SPEC.toObservations({ key: batch.key, files: batch.files });
    validateDrafts(JPX_INVESTOR_EQUITY_WEEKLY_SPEC.name, drafts, JPX_INVESTOR_EQUITY_WEEKLY_SPEC.indicators);
    expect(drafts).toHaveLength(448);
  });
});

describe.skipIf(!hasMonthly)("resolve/fetch (月次、fetch スタブで実ファイルを返す)", () => {
  it("公表済みの最新月をキーにし、fetch は同じキー・安定したファイル名を返す", async () => {
    const calls = stubFetch({
      "/investor-type/00-01.html": MONTHLY_FIXTURES[0] as string,
      "stock_val_1_m2608.xls": MONTHLY_FIXTURES[1] as string,
      "stock_vol_1_m2608.xls": MONTHLY_FIXTURES[2] as string,
    });
    const resolved = await JPX_INVESTOR_EQUITY_MONTHLY_SPEC.resolve(new Date("2026-09-27T00:00:00Z"));
    expect(resolved.key).toBe("jpx-investor-equity-monthly-2026-08");
    expect(calls).toHaveLength(1);
    const batch = await resolved.fetch();
    expect(batch.key).toBe(resolved.key);
    expect(batch.files.map((f) => f.filename)).toEqual([
      "investor-equity-value-stock_val_1_m2608.xls",
      "investor-equity-volume-stock_vol_1_m2608.xls",
    ]);
    const drafts = JPX_INVESTOR_EQUITY_MONTHLY_SPEC.toObservations({ key: batch.key, files: batch.files });
    validateDrafts(JPX_INVESTOR_EQUITY_MONTHLY_SPEC.name, drafts, JPX_INVESTOR_EQUITY_MONTHLY_SPEC.indicators);
    expect(drafts).toHaveLength(240);
  });
});
