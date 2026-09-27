/**
 * jpx-investor-etf-reit アダプタ (JPX 投資部門別売買状況 ETF / J-REIT 月次) のテスト。
 *
 * 実ファイル (private/ — JPX の利用条件は personal-only のため commit しない) は
 * `services/moneyflow/lib/sources/fixtures/private/jpx-investor-etf-reit/` に置く:
 *   - etf_m2608.xls  … 2026-09-27 に
 *       https://www.jpx.co.jp/markets/statistics-equities/investor-type/t13vrt000001xy39-att/etf_m2608.xls
 *       から取得した原本そのもの
 *   - reit_m2608.xls … 2026-09-27 に
 *       https://www.jpx.co.jp/markets/statistics-equities/investor-type/t13vrt000001xyd5-att/reit_m2608.xls
 *       から取得した原本そのもの
 *   - investor-type-02-links-excerpt.html / investor-type-03-links-excerpt.html
 *       … 2026-09-27 に一覧ページ (investor-type/02.html・03.html) から月次ファイルへの
 *       リンク部分だけを抜粋した実データ
 * 置いていない環境 (CI) では実ファイルのテストを describe.skipIf で skip する。
 * 期待値は原本 xls を Python xlrd で実装とは独立に読んだ値 (検証証跡
 * docs/moneyflow-evidence-2026-09-27 の jpx-investor-etf-reit verified_values とも一致)。
 *
 * CI でも走るテストは、取得元モジュールの `parseJpxInvestorWorkbook` をモックして
 * テスト内で手組みした **合成テストデータ** (値は実データではない) を返させる。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMoneyflowCategoryKind,
  isMoneyflowFlowType,
  isMoneyflowFrequency,
  isMoneyflowLicense,
  isMoneyflowRequirement,
  isMoneyflowUnit,
} from "../../../../src/shared/notion-archive/moneyflow.js";
import { validateDrafts, type ObservationDraft, type SpecFile } from "../source-spec.js";
import * as source from "../sources/jpx-investor-etf-reit.js";
import type { JpxInvestorCategoryRow, JpxInvestorReport, JpxInvestorSheet } from "../sources/jpx-investor-etf-reit.js";
import {
  JPX_INVESTOR_ETF_INDICATORS,
  JPX_INVESTOR_ETF_REIT_CATEGORIES,
  JPX_INVESTOR_ETF_REIT_SPECS,
  JPX_INVESTOR_ETF_SPEC_NAME,
  JPX_INVESTOR_REIT_INDICATORS,
  JPX_INVESTOR_REIT_SPEC_NAME,
  assertJpxInvestorFresh,
  jpxInvestorEtfReitBatchKey,
  jpxInvestorEtfReitFilenames,
  jpxInvestorEtfSpec,
  jpxInvestorReitSpec,
} from "./jpx-investor-etf-reit.js";

// 解析関数だけ差し替え可能にする (既定は本物をそのまま呼ぶ)。CI 用テストでは
// mockReturnValueOnce で合成テストデータを返させる。
vi.mock("../sources/jpx-investor-etf-reit.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sources/jpx-investor-etf-reit.js")>();
  return { ...actual, parseJpxInvestorWorkbook: vi.fn(actual.parseJpxInvestorWorkbook) };
});

const FIXTURE_DIR = fileURLToPath(new URL("../sources/fixtures/private/jpx-investor-etf-reit/", import.meta.url));
const ETF_XLS = join(FIXTURE_DIR, "etf_m2608.xls");
const REIT_XLS = join(FIXTURE_DIR, "reit_m2608.xls");
const ETF_LINKS = join(FIXTURE_DIR, "investor-type-02-links-excerpt.html");
const REIT_LINKS = join(FIXTURE_DIR, "investor-type-03-links-excerpt.html");
const HAS_XLS = existsSync(ETF_XLS) && existsSync(REIT_XLS);
const HAS_RESOLVE = HAS_XLS && existsSync(ETF_LINKS) && existsSync(REIT_LINKS);

const ROW_BUDGET = 600;
const ETF_KEY = "jpx-investor-etf-reit-etf-2026-08";
const REIT_KEY = "jpx-investor-etf-reit-reit-2026-08";
const ETF_LISTING = "https://www.jpx.co.jp/markets/statistics-equities/investor-type/02.html";
const REIT_LISTING = "https://www.jpx.co.jp/markets/statistics-equities/investor-type/03.html";
const ETF_FILE_URL = "https://www.jpx.co.jp/markets/statistics-equities/investor-type/t13vrt000001xy39-att/etf_m2608.xls";
const REIT_FILE_URL =
  "https://www.jpx.co.jp/markets/statistics-equities/investor-type/t13vrt000001xyd5-att/reit_m2608.xls";
/** 実ファイル取得日 (2026-09-27 12:00 JST)。 */
const FETCHED_AT = new Date("2026-09-27T03:00:00Z");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(source.parseJpxInvestorWorkbook).mockClear();
});

function find(drafts: readonly ObservationDraft[], indicatorKey: string, category: string): ObservationDraft {
  const hits = drafts.filter((d) => d.indicatorKey === indicatorKey && d.category === category);
  expect(hits).toHaveLength(1);
  return hits[0] as ObservationDraft;
}

// ---------------------------------------------------------------------------
// 1. 指標定義
// ---------------------------------------------------------------------------

describe("指標定義", () => {
  const all = [...JPX_INVESTOR_ETF_INDICATORS, ...JPX_INVESTOR_REIT_INDICATORS];

  it("全指標が enum ガードを通り、キーは一意で snake_case", () => {
    for (const d of all) {
      expect(isMoneyflowFlowType(d.flowType), d.key).toBe(true);
      expect(isMoneyflowFrequency(d.frequency), d.key).toBe(true);
      expect(isMoneyflowLicense(d.license), d.key).toBe(true);
      expect(isMoneyflowRequirement(d.requirement), d.key).toBe(true);
      expect(d.key).toMatch(/^[a-z0-9_]+$/);
    }
    expect(new Set(all.map((d) => d.key)).size).toBe(all.length);
    expect(all.map((d) => d.key)).toEqual([
      "jpx_etf_investor_net_flow_value",
      "jpx_etf_investor_turnover_value",
      "jpx_etf_market_turnover_value",
      "jpx_reit_investor_net_flow_value",
      "jpx_reit_investor_turnover_value",
      "jpx_reit_market_turnover_value",
    ]);
  });

  it("出典は https の一覧ページ、説明・限界は日本語で単位 (円) と口数を取り込まないことを明記", () => {
    for (const d of JPX_INVESTOR_ETF_INDICATORS) expect(d.sourceUrl).toBe(ETF_LISTING);
    for (const d of JPX_INVESTOR_REIT_INDICATORS) expect(d.sourceUrl).toBe(REIT_LISTING);
    for (const d of all) {
      expect(d.displayName).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(d.description).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(d.description).toContain("単位は円");
      expect(d.limitations).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(d.limitations).toContain("「口」が無いため取り込んでいない");
      expect(d.license).toBe("personal-only");
      expect(d.frequency).toBe("月次");
      expect(d.requirement).toBe("R2");
    }
    const net = all.filter((d) => d.key.includes("net_flow"));
    for (const d of net) {
      expect(d.flowType).toBe("純買い越し");
      expect(d.description).toContain("プラスは買い越し");
      expect(d.description).toMatch(/新しくお金が入った額 \(.+\) ではない/);
    }
    // 取引所外の資金流入経路は商品ごとに違う: ETF は「設定」、J-REIT は増資 (設定・解約は無い)
    const etfNet = JPX_INVESTOR_ETF_INDICATORS.find((d) => d.key === "jpx_etf_investor_net_flow_value")!;
    const reitNet = JPX_INVESTOR_REIT_INDICATORS.find((d) => d.key === "jpx_reit_investor_net_flow_value")!;
    expect(etfNet.description).toContain("指定参加者を通じた新しい口数の設定");
    expect(etfNet.description).not.toContain("増資");
    expect(reitNet.description).toContain("公募増資などによる新しい投資口の発行");
    expect(reitNet.description).toContain("設定・解約の仕組みは無い");
    expect(reitNet.description).not.toContain("(設定");
    for (const d of all.filter((x) => x.key.includes("turnover"))) expect(d.flowType).toBe("売買代金");
  });

  it("spec 名は規約どおり", () => {
    expect(JPX_INVESTOR_ETF_REIT_SPECS.map((s) => s.name)).toEqual([JPX_INVESTOR_ETF_SPEC_NAME, JPX_INVESTOR_REIT_SPEC_NAME]);
    for (const s of JPX_INVESTOR_ETF_REIT_SPECS) expect(s.name).toMatch(/^jpx-investor-etf-reit(-[a-z]+)?$/);
  });
});

// ---------------------------------------------------------------------------
// 2. 実ファイル → toObservations → validateDrafts
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_XLS)("実ファイル (2026年8月分) の変換", () => {
  const etfFiles: SpecFile[] = HAS_XLS ? [{ filename: "etf_m2608.xls", bytes: new Uint8Array(readFileSync(ETF_XLS)) }] : [];
  const reitFiles: SpecFile[] = HAS_XLS
    ? [{ filename: "reit_m2608.xls", bytes: new Uint8Array(readFileSync(REIT_XLS)) }]
    : [];

  it("ETF: 29 行・検証を通り、値は原本 (千円) × 1,000 の円", () => {
    const drafts = jpxInvestorEtfSpec.toObservations({ key: ETF_KEY, files: etfFiles });
    validateDrafts(jpxInvestorEtfSpec.name, drafts, jpxInvestorEtfSpec.indicators);
    expect(drafts).toHaveLength(29);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    for (const d of drafts) {
      expect(d.period).toBe("2026-08");
      expect(d.periodStart).toBe("2026-08-03");
      expect(d.periodEnd).toBe("2026-08-31");
      expect(d.unit).toBe("円");
      expect(isMoneyflowUnit(d.unit)).toBe(true);
      expect(isMoneyflowCategoryKind(d.categoryKind)).toBe(true);
      expect(d.changeFromPrev).toBeNull();
      expect(d.approximate).toBe(true);
      expect(d.measureKind).toBe("実測");
    }
    // xlrd で独立に読んだ値 (千円) × 1,000
    expect(find(drafts, "jpx_etf_investor_net_flow_value", "海外投資家").value).toBe(129_341_724_000);
    expect(find(drafts, "jpx_etf_investor_net_flow_value", "個人").value).toBe(-38_756_369_000);
    expect(find(drafts, "jpx_etf_investor_net_flow_value", "銀行").value).toBe(-168_898_545_000);
    expect(find(drafts, "jpx_etf_investor_turnover_value", "総計").value).toBe(14_556_190_891_000);
    const market = find(drafts, "jpx_etf_market_turnover_value", "市場全体");
    expect(market.value).toBe(14_633_061_770_000);
    expect(market.categoryKind).toBe("全体");
    expect(find(drafts, "jpx_etf_investor_turnover_value", "総計").categoryKind).toBe("全体");
    expect(find(drafts, "jpx_etf_investor_net_flow_value", "海外投資家").categoryKind).toBe("投資部門");
    // 最後の行 (取込完了の印) は市場全体の総売買代金
    expect(drafts[drafts.length - 1]).toEqual(market);
    // 決定的 (同じ入力から同じ行順)
    expect(jpxInvestorEtfSpec.toObservations({ key: ETF_KEY, files: etfFiles })).toEqual(drafts);
  });

  it("REIT: 29 行・検証を通り、値は原本 (千円) × 1,000 の円", () => {
    const drafts = jpxInvestorReitSpec.toObservations({ key: REIT_KEY, files: reitFiles });
    validateDrafts(jpxInvestorReitSpec.name, drafts, jpxInvestorReitSpec.indicators);
    expect(drafts).toHaveLength(29);
    expect(find(drafts, "jpx_reit_investor_net_flow_value", "海外投資家").value).toBe(-66_009_392_000);
    expect(find(drafts, "jpx_reit_investor_net_flow_value", "法人").value).toBe(37_174_802_000);
    expect(find(drafts, "jpx_reit_investor_turnover_value", "海外投資家").value).toBe(1_171_151_402_000);
    expect(find(drafts, "jpx_reit_market_turnover_value", "市場全体").value).toBe(2_163_190_582_000);
    expect(find(drafts, "jpx_reit_investor_net_flow_value", "総計").value).toBe(-948_641_000);
  });

  it("ETF のファイルを REIT のキーで渡すと throw (ファイル名の取り違え)", () => {
    expect(() =>
      jpxInvestorReitSpec.toObservations({ key: REIT_KEY, files: [{ filename: "etf_m2608.xls", bytes: etfFiles[0]!.bytes }] })
    ).toThrow(/該当ファイルが 0 件/);
  });

  it("キーの月とファイルの対象月が違えば throw", () => {
    expect(() =>
      jpxInvestorEtfSpec.toObservations({
        key: "jpx-investor-etf-reit-etf-2026-07",
        files: [{ filename: "etf_m2607.xls", bytes: etfFiles[0]!.bytes }],
      })
    ).toThrow(/一致しません/);
  });
});

// ---------------------------------------------------------------------------
// 3. CI でも走る: 合成テストデータ (解析関数をモック) で写像を確認
// ---------------------------------------------------------------------------

/** 合成テストデータ: 区分行 (値は実データではない)。 */
function syntheticCategory(category: string, sales: number, purchases: number): JpxInvestorCategoryRow {
  return {
    category,
    categoryEn: "synthetic",
    group: null,
    sales,
    salesRatioPercent: 1,
    purchases,
    purchasesRatioPercent: 1,
    balance: purchases - sales,
    total: sales + purchases,
    totalRatioPercent: 1,
  };
}

/** 合成テストデータ: 2026年3月分の解析結果 (値は実データではない)。 */
function syntheticReport(product: "etf" | "reit", labels: readonly string[]): JpxInvestorReport {
  const categories = labels.map((l, i) => syntheticCategory(l, 1_000 + i, 1_500 + 2 * i));
  const sheet = (metric: "value" | "volume"): JpxInvestorSheet => ({
    metric,
    unit: metric === "value" ? "thousand_yen" : product === "etf" ? "lot_100units" : "unit",
    periodLabel: "2026年3月 2026/3  ( 3/2 - 3/31 )",
    yearMonth: "2026-03",
    rangeStart: "2026-03-02",
    rangeEnd: "2026-03-31",
    marketTotal: 99_999,
    categories,
  });
  return { product, sourceUrl: "synthetic", yearMonth: "2026-03", value: sheet("value"), volume: sheet("volume") };
}

const KNOWN_LABELS = JPX_INVESTOR_ETF_REIT_CATEGORIES.map((c) => c.label);
const SYNTHETIC_FILE: SpecFile[] = [{ filename: "etf_m2603.xls", bytes: new Uint8Array([0]) }];
const SYNTHETIC_KEY = "jpx-investor-etf-reit-etf-2026-03";

describe("写像 (合成テストデータ・CI で実行)", () => {
  it("区分ごとに買い越し (買い−売り) と売買代金 (売り+買い) を千円→円で出し、市場全体を最後に置く", () => {
    vi.mocked(source.parseJpxInvestorWorkbook).mockReturnValueOnce(syntheticReport("etf", KNOWN_LABELS));
    const drafts = jpxInvestorEtfSpec.toObservations({ key: SYNTHETIC_KEY, files: SYNTHETIC_FILE });
    validateDrafts(jpxInvestorEtfSpec.name, drafts, jpxInvestorEtfSpec.indicators);
    expect(drafts).toHaveLength(29);
    // 海外投資家は 6 番目 (i=5): 売り 1,005 / 買い 1,510 千円
    expect(find(drafts, "jpx_etf_investor_net_flow_value", "海外投資家").value).toBe(505_000);
    expect(find(drafts, "jpx_etf_investor_turnover_value", "海外投資家").value).toBe(2_515_000);
    const last = drafts[drafts.length - 1] as ObservationDraft;
    expect(last).toMatchObject({ indicatorKey: "jpx_etf_market_turnover_value", category: "市場全体", value: 99_999_000 });
    expect(drafts[0]).toMatchObject({ period: "2026-03", periodStart: "2026-03-02", periodEnd: "2026-03-31" });
    expect(drafts.slice(0, 14).map((d) => d.category)).toEqual(KNOWN_LABELS);
  });

  it("未知の区分があれば throw", () => {
    vi.mocked(source.parseJpxInvestorWorkbook).mockReturnValueOnce(syntheticReport("etf", [...KNOWN_LABELS, "謎の部門"]));
    expect(() => jpxInvestorEtfSpec.toObservations({ key: SYNTHETIC_KEY, files: SYNTHETIC_FILE })).toThrow(
      /未知の投資部門区分/
    );
  });

  it("区分が欠けていれば throw", () => {
    vi.mocked(source.parseJpxInvestorWorkbook).mockReturnValueOnce(
      syntheticReport("etf", KNOWN_LABELS.filter((l) => l !== "個人"))
    );
    expect(() => jpxInvestorEtfSpec.toObservations({ key: SYNTHETIC_KEY, files: SYNTHETIC_FILE })).toThrow(
      /区分が欠けています: 個人/
    );
  });

  it("金額シートの単位が千円でなければ throw", () => {
    const r = syntheticReport("etf", KNOWN_LABELS);
    vi.mocked(source.parseJpxInvestorWorkbook).mockReturnValueOnce({ ...r, value: { ...r.value, unit: "unit" } });
    expect(() => jpxInvestorEtfSpec.toObservations({ key: SYNTHETIC_KEY, files: SYNTHETIC_FILE })).toThrow(/千円/);
  });

  it("ファイルが無い・キーの形式が違えば throw (解析前に止める)", () => {
    expect(() => jpxInvestorEtfSpec.toObservations({ key: SYNTHETIC_KEY, files: [] })).toThrow(/該当ファイルが 0 件/);
    expect(() => jpxInvestorEtfSpec.toObservations({ key: "jpx-investor-etf-reit-etf-2026-13", files: SYNTHETIC_FILE })).toThrow(
      /月が不正/
    );
    expect(() => jpxInvestorEtfSpec.toObservations({ key: "jpx-etf-2026-03", files: SYNTHETIC_FILE })).toThrow(
      /冪等キーの形式が不正/
    );
    expect(source.parseJpxInvestorWorkbook).not.toHaveBeenCalled();
  });

  it("新様式の 4 桁年ファイル名 (etf_mYYYYMM.xlsx) も同じ月の原本として受け付け、別月・別商品は受け付けない", () => {
    expect(jpxInvestorEtfReitFilenames("etf", "2026-09")).toEqual([
      "etf_m2609.xls",
      "etf_m2609.xlsx",
      "etf_m202609.xls",
      "etf_m202609.xlsx",
    ]);
    vi.mocked(source.parseJpxInvestorWorkbook).mockReturnValueOnce(syntheticReport("etf", KNOWN_LABELS));
    const drafts = jpxInvestorEtfSpec.toObservations({
      key: SYNTHETIC_KEY,
      files: [{ filename: "etf_m202603.xlsx", bytes: new Uint8Array([0]) }],
    });
    expect(drafts).toHaveLength(29);
    for (const filename of ["etf_m202604.xlsx", "etf_m2604.xls", "reit_m202603.xlsx", "etf_m20260.xlsx"]) {
      expect(() =>
        jpxInvestorEtfSpec.toObservations({ key: SYNTHETIC_KEY, files: [{ filename, bytes: new Uint8Array([0]) }] })
      ).toThrow(/該当ファイルが 0 件/);
    }
  });

  it("キーは <spec名>-YYYY-MM", () => {
    expect(jpxInvestorEtfReitBatchKey("etf", "2026-08")).toBe(ETF_KEY);
    expect(jpxInvestorEtfReitBatchKey("reit", "2026-08")).toBe(REIT_KEY);
    expect(() => jpxInvestorEtfReitBatchKey("etf", "2026-8")).toThrow();
  });

  it("鮮度: 前月・前々月は通し、それより古い/未来の月は throw (JST 基準)", () => {
    const now = new Date("2026-10-05T00:00:00Z"); // JST 10/5 → 前月 = 2026-09
    expect(() => assertJpxInvestorFresh("etf", "2026-09", now)).not.toThrow();
    expect(() => assertJpxInvestorFresh("etf", "2026-08", now)).not.toThrow();
    expect(() => assertJpxInvestorFresh("etf", "2026-07", now)).toThrow(/更新停止/);
    expect(() => assertJpxInvestorFresh("etf", "2026-10", now)).toThrow(/より後/);
    // UTC では 9/30 だが JST では 10/1 → 前月 = 2026-09
    expect(() => assertJpxInvestorFresh("reit", "2026-09", new Date("2026-09-30T20:00:00Z"))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. resolve()/fetch() (fetch をスタブして実ファイルを返す)
// ---------------------------------------------------------------------------

function stubJpx(routes: Record<string, string | Uint8Array>, calls: string[]): void {
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const body = routes[url];
    if (body === undefined) return new Response("not found", { status: 404, statusText: "Not Found" });
    return new Response(typeof body === "string" ? body : new Uint8Array(body), { status: 200 });
  });
}

describe("resolve / fetch (新様式の命名・合成テストデータ・CI で実行)", () => {
  it("一覧の最新リンクが新様式 etf_mYYYYMM.xlsx でも fetch() が throw せず原本名のまま返す (保管前に落とさない)", async () => {
    const calls: string[] = [];
    // 合成テストデータ: 一覧ページのリンク部分とファイル本体 (値は実データではない)
    const fileUrl = "https://www.jpx.co.jp/markets/statistics-equities/investor-type/synthetic-att/etf_m202609.xlsx";
    const listing =
      '<html><body><a href="/markets/statistics-equities/investor-type/synthetic-att/etf_m202609.xlsx">2026年9月</a>' +
      '<a href="/markets/statistics-equities/investor-type/synthetic-att/etf_m2608.xls">2026年8月</a></body></html>';
    const body = new Uint8Array([1, 2, 3]);
    stubJpx({ [ETF_LISTING]: listing, [fileUrl]: body }, calls);
    const resolved = await jpxInvestorEtfSpec.resolve(new Date("2026-10-14T03:00:00Z"));
    expect(resolved.key).toBe("jpx-investor-etf-reit-etf-2026-09");
    const batch = await resolved.fetch();
    expect(batch.files.map((f) => f.filename)).toEqual(["etf_m202609.xlsx"]);
    expect(Array.from(batch.files[0]!.bytes)).toEqual([1, 2, 3]);
    expect(calls).toEqual([ETF_LISTING, ETF_LISTING, fileUrl]);
  });
});

describe.skipIf(!HAS_RESOLVE)("resolve / fetch (実ファイルをスタブ fetch で返す)", () => {
  const cases = [
    { spec: jpxInvestorEtfSpec, key: ETF_KEY, listing: ETF_LISTING, links: ETF_LINKS, fileUrl: ETF_FILE_URL, xls: ETF_XLS, filename: "etf_m2608.xls" },
    { spec: jpxInvestorReitSpec, key: REIT_KEY, listing: REIT_LISTING, links: REIT_LINKS, fileUrl: REIT_FILE_URL, xls: REIT_XLS, filename: "reit_m2608.xls" },
  ];
  for (const c of cases) {
    it(`${c.spec.name}: 最新月のキーを返し、fetch() は同じキー・安定したファイル名で原本のバイト列を返す`, async () => {
      const calls: string[] = [];
      const bytes = new Uint8Array(readFileSync(c.xls));
      stubJpx({ [c.listing]: readFileSync(c.links, "utf8"), [c.fileUrl]: bytes }, calls);
      const resolved = await c.spec.resolve(FETCHED_AT);
      expect(resolved.key).toBe(c.key);
      expect(calls).toEqual([c.listing]);
      const batch = await resolved.fetch();
      expect(batch.key).toBe(c.key);
      expect(batch.source).toBe(c.fileUrl);
      expect(batch.files.map((f) => f.filename)).toEqual([c.filename]);
      expect(batch.files[0]!.contentType).toBe("application/vnd.ms-excel");
      expect(Buffer.from(batch.files[0]!.bytes).equals(Buffer.from(bytes))).toBe(true);
      expect(calls).toEqual([c.listing, c.listing, c.fileUrl]);
      const drafts = c.spec.toObservations({ key: batch.key, files: batch.files });
      validateDrafts(c.spec.name, drafts, c.spec.indicators);
      expect(drafts).toHaveLength(29);
    });
  }

  it("一覧ページの最新月が古すぎれば resolve が throw", async () => {
    const calls: string[] = [];
    stubJpx({ [ETF_LISTING]: readFileSync(ETF_LINKS, "utf8") }, calls);
    await expect(jpxInvestorEtfSpec.resolve(new Date("2026-11-20T03:00:00Z"))).rejects.toThrow(/更新停止/);
  });
});
