/**
 * imaj-fund-flows アダプタ (B-1 公募投信 / D-1 公募REIT) のテスト。
 *
 * 実ファイル (private/ — personal-only・利用条件要確認のため commit しない) は
 * `services/moneyflow/lib/sources/fixtures/private/imaj-fund-flows/` に置く:
 *   - imaj-fund-flows-b1.xlsx / imaj-reit-flows-d1.xlsx
 *       2026-09-27 に固定 URL から取得した原本を直近14か月のデータ行に切り詰めたもの (値は無改変)
 *   - I0112B_pub_m.xlsx / F00B21_pub.xlsx
 *       同日に取得した原本そのもの (B-1 は 1989年1月〜、D-1 は 2016年8月〜の全期間)
 * 置いていない環境 (CI) では実ファイルのテストを describe.skipIf で skip する。
 * 期待値は python (openpyxl) で原本のセルを独立に読み、百万円→円に換算した値。
 *
 * CI でも走るテストは、B-1/D-1 の様式 (シート名・ヘッダ列) だけを真似て
 * テスト内で組み立てた **合成テストデータ** の xlsx を使う (実データではない)。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import {
  isMoneyflowFlowType,
  isMoneyflowFrequency,
  isMoneyflowLicense,
  isMoneyflowRequirement,
} from "../../../../src/shared/notion-archive/moneyflow.js";
import { validateDrafts, type MoneyflowSourceSpec, type ObservationDraft, type SpecFile } from "../source-spec.js";
import { IMAJ_FUND_FLOWS_URL, IMAJ_REIT_FLOWS_URL } from "../sources/imaj-fund-flows.js";
import {
  IMAJ_FUND_FLOWS_REIT_SPEC_INDICATORS,
  IMAJ_FUND_FLOWS_SPECS,
  IMAJ_FUND_FLOWS_SPEC_INDICATORS,
  IMAJ_WINDOW_MONTHS,
  imajFundCategoryInfo,
  imajFundFlowsReitSpec,
  imajFundFlowsSpec,
} from "./imaj-fund-flows.js";

const FIXTURE_DIR = fileURLToPath(new URL("../sources/fixtures/private/imaj-fund-flows/", import.meta.url));
const B1_TRIMMED = join(FIXTURE_DIR, "imaj-fund-flows-b1.xlsx");
const D1_TRIMMED = join(FIXTURE_DIR, "imaj-reit-flows-d1.xlsx");
const B1_FULL = join(FIXTURE_DIR, "I0112B_pub_m.xlsx");
const D1_FULL = join(FIXTURE_DIR, "F00B21_pub.xlsx");

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ROW_BUDGET = 600;

const readBytes = (path: string): Uint8Array => new Uint8Array(readFileSync(path));

/** バイト列が完全に一致するか (Uint8Array の由来による付随プロパティの差は無視する)。 */
const sameBytes = (a: Uint8Array | undefined, b: Uint8Array): boolean =>
  a !== undefined && Buffer.from(a).equals(Buffer.from(b));

function find(drafts: readonly ObservationDraft[], period: string, indicatorKey: string, category: string): ObservationDraft {
  const hits = drafts.filter((d) => d.period === period && d.indicatorKey === indicatorKey && d.category === category);
  if (hits.length !== 1) throw new Error(`テスト: ${period}|${indicatorKey}|${category} が ${hits.length} 件`);
  return hits[0] as ObservationDraft;
}

/** fetch をスタブし、URL → バイト列の対応だけ 200 で返す (他は 404)。 */
function stubFetch(routes: Record<string, Uint8Array>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: unknown) => {
    const url = String(input);
    const bytes = routes[url];
    if (!bytes) return new Response("not found", { status: 404, statusText: "Not Found" });
    return new Response(new Uint8Array(bytes), { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. 指標定義
// ---------------------------------------------------------------------------

describe("指標定義", () => {
  const all = [...IMAJ_FUND_FLOWS_SPEC_INDICATORS, ...IMAJ_FUND_FLOWS_REIT_SPEC_INDICATORS];

  it("全指標が enum ガードを通り、キーが一意で、出典は https、説明と限界は日本語で空でない", () => {
    expect(all.map((i) => i.key)).toEqual([
      "imaj_fund_net_flow",
      "imaj_fund_net_asset_total",
      "imaj_reit_net_flow",
      "imaj_reit_net_asset_total",
    ]);
    expect(new Set(all.map((i) => i.key)).size).toBe(all.length);
    for (const i of all) {
      expect(isMoneyflowFlowType(i.flowType), i.key).toBe(true);
      expect(isMoneyflowFrequency(i.frequency), i.key).toBe(true);
      expect(isMoneyflowLicense(i.license), i.key).toBe(true);
      expect(isMoneyflowRequirement(i.requirement), i.key).toBe(true);
      expect(new URL(i.sourceUrl).protocol, i.key).toBe("https:");
      for (const text of [i.displayName, i.description, i.limitations]) {
        expect(text.trim().length, i.key).toBeGreaterThan(0);
        expect(text, i.key).toMatch(/[぀-ヿ一-鿿]/);
      }
    }
  });

  it("フロー/ストックの種別・利用条件・頻度が定義どおり (残高はフローでないと明記)", () => {
    const byKey = new Map(all.map((i) => [i.key, i]));
    expect(byKey.get("imaj_fund_net_flow")?.flowType).toBe("設定解約");
    expect(byKey.get("imaj_reit_net_flow")?.flowType).toBe("設定解約");
    expect(byKey.get("imaj_fund_net_asset_total")?.flowType).toBe("残高");
    expect(byKey.get("imaj_reit_net_asset_total")?.flowType).toBe("残高");
    for (const i of all) {
      expect(i.license).toBe("要確認");
      expect(i.frequency).toBe("月次");
      expect(i.requirement).toBe("R2");
    }
    expect(byKey.get("imaj_fund_net_asset_total")?.description).toMatch(/フロー\)ではない/);
    expect(byKey.get("imaj_reit_net_asset_total")?.description).toMatch(/時価総額\)ではない/);
    // 区分の足し算は原資料の端数処理で 100 万円ずれる月がある (実ファイル 2025-09 で確認) — 完全一致とは書かない
    expect(byKey.get("imaj_fund_net_flow")?.description).toMatch(/足し算が100万円ずれる月がある/);
  });

  it("spec 名は規約どおりで、指標は spec ごとに重ならない", () => {
    expect(IMAJ_FUND_FLOWS_SPECS.map((s) => s.name)).toEqual(["imaj-fund-flows", "imaj-fund-flows-reit"]);
    for (const s of IMAJ_FUND_FLOWS_SPECS) expect(s.name).toMatch(/^imaj-fund-flows(-[a-z0-9]+)*$/);
    expect(imajFundFlowsSpec.indicators).toBe(IMAJ_FUND_FLOWS_SPEC_INDICATORS);
    expect(imajFundFlowsReitSpec.indicators).toBe(IMAJ_FUND_FLOWS_REIT_SPEC_INDICATORS);
  });
});

// ---------------------------------------------------------------------------
// 合成テストデータ (実データではない)。B-1/D-1 の様式だけを真似た小さな xlsx。
// ---------------------------------------------------------------------------

const SYNTHETIC_FUND_SHEETS: ReadonlyArray<readonly [string, string]> = [
  ["総合計(株式投信+公社債投信)", "総合計"],
  ["株式投信", "株式"],
  ["株式投信(除ETF)", "株式 除ＥＴＦ"],
  ["株式投信(ETF)", "株式 追加型 ＥＴＦ"],
  ["公社債投信", "公社債"],
];

/** latest を含む直近 count か月 ("YYYY-MM"、古い順)。テスト用の素朴な実装。 */
function monthsEndingAt(latest: string, count: number): string[] {
  const [y, m] = latest.split("-").map(Number) as [number, number];
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const idx = y * 12 + (m - 1) - i;
    out.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

const toJaLabel = (period: string): string => {
  const [y, m] = period.split("-") as [string, string];
  return `${y}年${Number(m)}月`;
};

const writeXlsx = (wb: XLSX.WorkBook): Uint8Array =>
  new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);

/**
 * 合成テストデータの B-1 xlsx。区分 ci・月 j (古い順 0 始まり) の値 (百万円):
 *   資金増減額 = sign×((ci+1)×100 + j) (公社債だけ sign=-1) / 純資産総額 = (ci+1)×10,000 + j×7 /
 *   純資産増減額 = ci+5 / 償還額 = "-"
 */
function syntheticFundXlsx(opts: {
  periods: readonly string[];
  omit?: { sheet: string; period: string };
  duplicate?: { sheet: string; period: string };
  dropSheet?: string;
}): Uint8Array {
  const wb = XLSX.utils.book_new();
  SYNTHETIC_FUND_SHEETS.forEach(([, sheetName], ci) => {
    if (opts.dropSheet === sheetName) return;
    const sign = sheetName === "公社債" ? -1 : 1;
    const aoa: unknown[][] = [
      [null, "合成テストデータ (実データではない)"],
      [null, "（単位 ：百万円 ； ￥ million）"],
      [null, "項目", "設定額", "解約額", "償還額", "資金増減額", "収益分配額", "運用増減額", "純資産増減額", "純資産総額", "ファンド数"],
    ];
    opts.periods.forEach((p, j) => {
      if (opts.omit?.sheet === sheetName && opts.omit.period === p) return;
      const net = sign * ((ci + 1) * 100 + j);
      const row = [null, toJaLabel(p), 1000, 1000 - net, "-", net, 3, 4, ci + 5, (ci + 1) * 10_000 + j * 7, 10];
      aoa.push(row);
      if (opts.duplicate?.sheet === sheetName && opts.duplicate.period === p) aoa.push(row);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  });
  return writeXlsx(wb);
}

/**
 * 合成テストデータの D-1 xlsx。月 j の値 (百万円): 資本金増減額 = j×10 − 50 (j=3 だけ "-") /
 * 資産増減額 = j + 1 / 純資産総額 = 50,000 + j
 */
function syntheticReitXlsx(periods: readonly string[]): Uint8Array {
  const wb = XLSX.utils.book_new();
  const aoa: unknown[][] = [
    [null, "合成テストデータ (実データではない)"],
    [null, "（単位 ： 百万円 ； ￥ million）"],
    [
      null,
      "項目",
      "追加出資金額",
      "出資払戻金額",
      "資本金増減額",
      "その他増減額",
      "資産増減額",
      "当月末純資産総額",
      "資産総額",
      "出資総額",
      "負債総額",
      "組入不動産の総額",
      "月末総口数",
      "ファンド本数",
    ],
  ];
  periods.forEach((p, j) => {
    const capital = j === 3 ? "-" : j * 10 - 50;
    aoa.push([null, toJaLabel(p), 1, 1, capital, 2, j + 1, 50_000 + j, 90_000, 40_000, 40_000, 95_000, 1_000_000, 50]);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "月次");
  return writeXlsx(wb);
}

const SYN_LATEST = "2026-02";
const SYN_PERIODS = monthsEndingAt(SYN_LATEST, 14); // 2025-01〜2026-02 (窓12か月+前月+1)
const SYN_FUND_KEY = `imaj-fund-flows-${SYN_LATEST}`;
const SYN_REIT_KEY = `imaj-fund-flows-reit-${SYN_LATEST}`;
const fundFile = (bytes: Uint8Array, key = SYN_FUND_KEY): SpecFile[] => [{ filename: `${key}.xlsx`, bytes }];
const reitFile = (bytes: Uint8Array, key = SYN_REIT_KEY): SpecFile[] => [{ filename: `${key}.xlsx`, bytes }];

// ---------------------------------------------------------------------------
// 3. CI で走る写像ロジックのテスト (合成テストデータ)
// ---------------------------------------------------------------------------

describe("imaj-fund-flows toObservations (合成テストデータ)", () => {
  const drafts = imajFundFlowsSpec.toObservations({
    key: SYN_FUND_KEY,
    files: fundFile(syntheticFundXlsx({ periods: SYN_PERIODS })),
  });

  it("直近12か月 × 5区分 × 2指標 = 120 行で、検証を通る", () => {
    expect(drafts).toHaveLength(IMAJ_WINDOW_MONTHS * 5 * 2);
    expect(() => validateDrafts(imajFundFlowsSpec.name, drafts, imajFundFlowsSpec.indicators)).not.toThrow();
    expect([...new Set(drafts.map((d) => d.period))]).toEqual(monthsEndingAt(SYN_LATEST, 12));
  });

  it("行の並びは 月(古い順) → 区分 → 指標 で決定的。最後の行は最新月の公社債投信の純資産総額", () => {
    expect(drafts[0]).toMatchObject({ period: "2025-03", indicatorKey: "imaj_fund_net_flow", category: "総合計(株式投信+公社債投信)" });
    expect(drafts[drafts.length - 1]).toMatchObject({
      period: SYN_LATEST,
      indicatorKey: "imaj_fund_net_asset_total",
      category: "公社債投信",
    });
    expect(drafts.slice(0, 10).map((d) => d.category)).toEqual(
      SYNTHETIC_FUND_SHEETS.flatMap(([label]) => [label, label])
    );
  });

  it("百万円→円換算、前月差、期間、区分種別、近似フラグを正しく付ける", () => {
    // 株式投信 (ci=1)、2026-02 は j=13: 資金増減額 = 200+13 = 213 百万円
    const flow = find(drafts, SYN_LATEST, "imaj_fund_net_flow", "株式投信");
    expect(flow).toEqual({
      period: "2026-02",
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
      indicatorKey: "imaj_fund_net_flow",
      category: "株式投信",
      categoryKind: "資産クラス",
      value: 213_000_000,
      unit: "円",
      changeFromPrev: 1_000_000,
      approximate: false,
      measureKind: "実測",
    });
    // 純資産総額 = 20,000 + 13×7 = 20,091 百万円、純資産増減額列 = 1+5 = 6 百万円 (列の値をそのまま)
    const stock = find(drafts, SYN_LATEST, "imaj_fund_net_asset_total", "株式投信");
    expect(stock).toMatchObject({
      periodStart: "2026-02-28",
      periodEnd: "2026-02-28",
      value: 20_091_000_000,
      changeFromPrev: 6_000_000,
      approximate: true,
      measureKind: "実測",
    });
    // 公社債 (ci=4) は負の資金増減額: -(500+13) = -513 百万円、前月 -512 → 差 -1 百万円
    expect(find(drafts, SYN_LATEST, "imaj_fund_net_flow", "公社債投信")).toMatchObject({
      value: -513_000_000,
      changeFromPrev: -1_000_000,
    });
    expect(find(drafts, SYN_LATEST, "imaj_fund_net_flow", "総合計(株式投信+公社債投信)").categoryKind).toBe("全体");
  });

  it("窓の最初の月の前月差は、窓の外 (前月) の行から求める", () => {
    // 2025-03 は j=2 → 株式投信(除ETF) (ci=2): 302、前月 2025-02 (j=1): 301
    expect(find(drafts, "2025-03", "imaj_fund_net_flow", "株式投信(除ETF)")).toMatchObject({
      value: 302_000_000,
      changeFromPrev: 1_000_000,
    });
  });
});

describe("imaj-fund-flows-reit toObservations (合成テストデータ)", () => {
  const drafts = imajFundFlowsReitSpec.toObservations({ key: SYN_REIT_KEY, files: reitFile(syntheticReitXlsx(SYN_PERIODS)) });

  it("直近12か月 × 2指標 = 24 行で、検証を通る。最後の行は最新月の純資産総額", () => {
    expect(drafts).toHaveLength(IMAJ_WINDOW_MONTHS * 2);
    expect(() => validateDrafts(imajFundFlowsReitSpec.name, drafts, imajFundFlowsReitSpec.indicators)).not.toThrow();
    expect(drafts[drafts.length - 1]).toMatchObject({ period: SYN_LATEST, indicatorKey: "imaj_reit_net_asset_total" });
    expect(new Set(drafts.map((d) => d.category))).toEqual(new Set(["公募不動産投信"]));
    expect(new Set(drafts.map((d) => d.categoryKind))).toEqual(new Set(["全体"]));
  });

  it("「-」は 0、前月差は前月の行から、純資産の前期比は資産増減額列から", () => {
    // j=3 (2025-04) は資本金増減額が "-" → 0。前月 j=2: 2×10−50 = −30 → 差 +30 百万円
    expect(find(drafts, "2025-04", "imaj_reit_net_flow", "公募不動産投信")).toMatchObject({
      periodStart: "2025-04-01",
      periodEnd: "2025-04-30",
      value: 0,
      changeFromPrev: 30_000_000,
      approximate: false,
    });
    // j=13 (2026-02): 資本金増減額 80 百万円、前月 70 → +10。純資産 50,013、資産増減額 14
    expect(find(drafts, SYN_LATEST, "imaj_reit_net_flow", "公募不動産投信")).toMatchObject({
      value: 80_000_000,
      changeFromPrev: 10_000_000,
    });
    expect(find(drafts, SYN_LATEST, "imaj_reit_net_asset_total", "公募不動産投信")).toMatchObject({
      periodStart: "2026-02-28",
      periodEnd: "2026-02-28",
      value: 50_013_000_000,
      changeFromPrev: 14_000_000,
      approximate: true,
    });
  });
});

// ---------------------------------------------------------------------------
// 5. 想定外の入力は throw する (ルール2)
// ---------------------------------------------------------------------------

describe("想定外の入力で throw する", () => {
  const good = syntheticFundXlsx({ periods: SYN_PERIODS });

  it("ファイルが無い・名前が違う・2 件ある", () => {
    expect(() => imajFundFlowsSpec.toObservations({ key: SYN_FUND_KEY, files: [] })).toThrow(/0 件/);
    expect(() =>
      imajFundFlowsSpec.toObservations({ key: SYN_FUND_KEY, files: [{ filename: "I0112B_pub_m.xlsx", bytes: good }] })
    ).toThrow(/0 件/);
    expect(() =>
      imajFundFlowsSpec.toObservations({ key: SYN_FUND_KEY, files: [...fundFile(good), ...fundFile(good)] })
    ).toThrow(/2 件/);
  });

  it("キーの形式が不正 (別 spec のキー・月が 13)", () => {
    expect(() => imajFundFlowsSpec.toObservations({ key: SYN_REIT_KEY, files: fundFile(good, SYN_REIT_KEY) })).toThrow(
      /冪等キーの形式が不正/
    );
    expect(() =>
      imajFundFlowsSpec.toObservations({ key: "imaj-fund-flows-2026-13", files: fundFile(good, "imaj-fund-flows-2026-13") })
    ).toThrow(/月が不正/);
    expect(() =>
      imajFundFlowsReitSpec.toObservations({ key: SYN_FUND_KEY, files: reitFile(syntheticReitXlsx(SYN_PERIODS), SYN_FUND_KEY) })
    ).toThrow(/冪等キーの形式が不正/);
  });

  it("キーの月とファイルの最新月が違う", () => {
    const key = "imaj-fund-flows-2026-01";
    expect(() => imajFundFlowsSpec.toObservations({ key, files: fundFile(good, key) })).toThrow(/一致しません/);
    const reitKey = "imaj-fund-flows-reit-2026-03";
    expect(() =>
      imajFundFlowsReitSpec.toObservations({ key: reitKey, files: reitFile(syntheticReitXlsx(SYN_PERIODS), reitKey) })
    ).toThrow(/一致しません/);
  });

  it("窓の中の月・窓の直前の月が欠けている", () => {
    const holed = syntheticFundXlsx({ periods: SYN_PERIODS, omit: { sheet: "株式 追加型 ＥＴＦ", period: "2025-08" } });
    expect(() => imajFundFlowsSpec.toObservations({ key: SYN_FUND_KEY, files: fundFile(holed) })).toThrow(
      /equity_etf の 2025-08 分の行がありません/
    );
    // 12 か月しか無い → 窓の最初の月の前月差が求まらない (捏造せず throw)
    const short = syntheticFundXlsx({ periods: monthsEndingAt(SYN_LATEST, 12) });
    expect(() => imajFundFlowsSpec.toObservations({ key: SYN_FUND_KEY, files: fundFile(short) })).toThrow(
      /2025-02 分の行がありません/
    );
    const shortReit = syntheticReitXlsx(monthsEndingAt(SYN_LATEST, 12));
    expect(() => imajFundFlowsReitSpec.toObservations({ key: SYN_REIT_KEY, files: reitFile(shortReit) })).toThrow(
      /2025-02 分の行がありません/
    );
  });

  it("同じ区分・月の行が重複している", () => {
    const dup = syntheticFundXlsx({ periods: SYN_PERIODS, duplicate: { sheet: "公社債", period: "2025-06" } });
    expect(() => imajFundFlowsSpec.toObservations({ key: SYN_FUND_KEY, files: fundFile(dup) })).toThrow(/重複/);
  });

  it("シートが欠けている (様式変更) — 取得元モジュールの throw がそのまま伝わる", () => {
    const noSheet = syntheticFundXlsx({ periods: SYN_PERIODS, dropSheet: "株式 除ＥＴＦ" });
    expect(() => imajFundFlowsSpec.toObservations({ key: SYN_FUND_KEY, files: fundFile(noSheet) })).toThrow(
      /シート「株式 除ＥＴＦ」が見つかりません/
    );
  });

  it("未知の商品分類区分は throw する (黙って捨てない)", () => {
    expect(() => imajFundCategoryInfo("mrf")).toThrow(/未知の商品分類区分/);
    expect(() => imajFundCategoryInfo("")).toThrow(/未知の商品分類区分/);
    expect(imajFundCategoryInfo("equity_etf")).toEqual({ label: "株式投信(ETF)", kind: "資産クラス" });
  });
});

// ---------------------------------------------------------------------------
// 4. resolve()/fetch() (合成テストデータ・CI で走る)
// ---------------------------------------------------------------------------

describe("resolve()/fetch() (fetch をスタブ・合成テストデータ)", () => {
  const fundBytes = syntheticFundXlsx({ periods: SYN_PERIODS });
  const reitBytes = syntheticReitXlsx(SYN_PERIODS);

  it("B-1: 固定 URL を 1 回だけ取得し、最新月からキーを決め、fetch() は同じバイト列を返す", async () => {
    const fetchMock = stubFetch({ [IMAJ_FUND_FLOWS_URL]: fundBytes });
    const resolved = await imajFundFlowsSpec.resolve(new Date("2026-03-15T00:00:00Z"));
    expect(resolved.key).toBe(SYN_FUND_KEY);
    const batch = await resolved.fetch();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(batch.key).toBe(resolved.key);
    expect(batch.source).toBe(IMAJ_FUND_FLOWS_URL);
    expect(batch.files).toHaveLength(1);
    expect(batch.files[0]?.filename).toBe(`${SYN_FUND_KEY}.xlsx`);
    expect(batch.files[0]?.contentType).toBe(XLSX_CONTENT_TYPE);
    expect(sameBytes(batch.files[0]?.bytes, fundBytes)).toBe(true);
    expect(batch.metadata).toMatchObject({ latestPeriod: SYN_LATEST, windowMonths: 12, windowStart: "2025-03" });
    expect(imajFundFlowsSpec.toObservations({ key: batch.key, files: batch.files })).toHaveLength(120);
  });

  it("D-1: 同様にキーを決める", async () => {
    stubFetch({ [IMAJ_REIT_FLOWS_URL]: reitBytes });
    const resolved = await imajFundFlowsReitSpec.resolve(new Date("2026-05-20T00:00:00Z"));
    expect(resolved.key).toBe(SYN_REIT_KEY);
    const batch = await resolved.fetch();
    expect(batch.key).toBe(SYN_REIT_KEY);
    expect(batch.files.map((f) => f.filename)).toEqual([`${SYN_REIT_KEY}.xlsx`]);
    expect(imajFundFlowsReitSpec.toObservations({ key: batch.key, files: batch.files })).toHaveLength(24);
  });

  it("B-1: 最新月が実行月 (JST) の 4 か月以上前なら更新停止として throw する (JST の月境界で判定)", async () => {
    stubFetch({ [IMAJ_FUND_FLOWS_URL]: fundBytes });
    // 2026-05-31T14:59Z = JST 5/31 23:59 → 実行月 2026-05、必要な月 2026-02 → OK
    await expect(imajFundFlowsSpec.resolve(new Date("2026-05-31T14:59:00Z"))).resolves.toMatchObject({ key: SYN_FUND_KEY });
    // 2026-05-31T15:00Z = JST 6/1 0:00 → 実行月 2026-06、必要な月 2026-03 → 2026-02 までしか無い
    await expect(imajFundFlowsSpec.resolve(new Date("2026-05-31T15:00:00Z"))).rejects.toThrow(/更新停止|のままです/);
  });

  it("D-1: 5 か月以上前なら throw する", async () => {
    stubFetch({ [IMAJ_REIT_FLOWS_URL]: reitBytes });
    await expect(imajFundFlowsReitSpec.resolve(new Date("2026-06-20T00:00:00Z"))).resolves.toMatchObject({
      key: SYN_REIT_KEY,
    });
    await expect(imajFundFlowsReitSpec.resolve(new Date("2026-07-01T00:00:00Z"))).rejects.toThrow(/のままです/);
  });

  it("最新月が実行月より後なら throw する (ファイルか時計の異常)", async () => {
    stubFetch({ [IMAJ_FUND_FLOWS_URL]: fundBytes });
    await expect(imajFundFlowsSpec.resolve(new Date("2026-01-20T00:00:00Z"))).rejects.toThrow(/より後です/);
  });

  it("HTTP エラーは throw する", async () => {
    stubFetch({});
    await expect(imajFundFlowsSpec.resolve(new Date("2026-03-15T00:00:00Z"))).rejects.toThrow(/HTTP エラー 404/);
    await expect(imajFundFlowsReitSpec.resolve(new Date("2026-03-15T00:00:00Z"))).rejects.toThrow(/HTTP エラー 404/);
  });
});

// ---------------------------------------------------------------------------
// 2. 実ファイル (private/。無い環境では skip)
// ---------------------------------------------------------------------------

/**
 * B-1 2026年8月分 (2026-09-27 取得) の期待値。python openpyxl で原本セルを読み、×1,000,000 した値。
 *   総合計: 資金増減額 1,939,503 / 前月 2,790,366 / 純資産総額 364,285,531 / 純資産増減額 11,757,792
 *   株式投信(ETF): 資金増減額 −78,125 / 公社債投信: 資金増減額 −77,945・純資産総額 16,272,981
 *   株式投信(除ETF) 2025年9月: 資金増減額 1,255,420 / 前月 701,177
 *   総合計の資金増減額 12 か月合計 (2025-09〜2026-08): 22,654,691
 */
function expectB1Values(drafts: readonly ObservationDraft[]): void {
  const total = "総合計(株式投信+公社債投信)";
  expect(find(drafts, "2026-08", "imaj_fund_net_flow", total)).toMatchObject({
    value: 1_939_503_000_000,
    changeFromPrev: -850_863_000_000,
    unit: "円",
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
  });
  expect(find(drafts, "2026-08", "imaj_fund_net_asset_total", total)).toMatchObject({
    value: 364_285_531_000_000,
    changeFromPrev: 11_757_792_000_000,
    periodStart: "2026-08-31",
    periodEnd: "2026-08-31",
  });
  expect(find(drafts, "2026-08", "imaj_fund_net_flow", "株式投信(ETF)").value).toBe(-78_125_000_000);
  expect(find(drafts, "2026-08", "imaj_fund_net_flow", "公社債投信").value).toBe(-77_945_000_000);
  expect(find(drafts, "2026-08", "imaj_fund_net_asset_total", "公社債投信").value).toBe(16_272_981_000_000);
  expect(find(drafts, "2025-09", "imaj_fund_net_flow", "株式投信(除ETF)")).toMatchObject({
    value: 1_255_420_000_000,
    changeFromPrev: 554_243_000_000,
  });
  const sum = drafts
    .filter((d) => d.indicatorKey === "imaj_fund_net_flow" && d.category === total)
    .reduce((acc, d) => acc + d.value, 0);
  expect(sum).toBe(22_654_691_000_000);
  // 原本の内部整合 (株式投信 = 除ETF + ETF) が換算後も保たれている
  const eq = find(drafts, "2026-08", "imaj_fund_net_flow", "株式投信").value;
  const exEtf = find(drafts, "2026-08", "imaj_fund_net_flow", "株式投信(除ETF)").value;
  const etf = find(drafts, "2026-08", "imaj_fund_net_flow", "株式投信(ETF)").value;
  expect(eq).toBe(exEtf + etf);
  // ただし区分ごとの百万円未満の端数処理で 1 百万円ずれる月がある (2025-09: 株式 − 除ETF − ETF = −1 百万円)。
  // 指標定義はこれを明記している (「足し算が完全に一致する」とは教えない)。
  const sep = (c: string) => find(drafts, "2025-09", "imaj_fund_net_flow", c).value;
  expect(sep("株式投信") - sep("株式投信(除ETF)") - sep("株式投信(ETF)")).toBe(-1_000_000);
}

/**
 * D-1 2026年7月分 (2026-09-27 取得) の期待値。python openpyxl で原本セルを読み、×1,000,000 した値。
 *   2026年7月: 資本金増減額 −28 / 前月 11,632 / 純資産総額 12,341,269 / 資産増減額 41,536
 *   2025年9月: 資本金増減額 "-" (=0) / 前月 22,517
 *   2026年6月: 純資産総額 12,299,733 (7月分公表時の訂正後の値。原本で色付セル)
 */
function expectD1Values(drafts: readonly ObservationDraft[]): void {
  const c = "公募不動産投信";
  expect(find(drafts, "2026-07", "imaj_reit_net_flow", c)).toMatchObject({
    value: -28_000_000,
    changeFromPrev: -11_660_000_000,
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
  });
  expect(find(drafts, "2026-07", "imaj_reit_net_asset_total", c)).toMatchObject({
    value: 12_341_269_000_000,
    changeFromPrev: 41_536_000_000,
    periodStart: "2026-07-31",
    periodEnd: "2026-07-31",
  });
  expect(find(drafts, "2025-09", "imaj_reit_net_flow", c)).toMatchObject({ value: 0, changeFromPrev: -22_517_000_000 });
  expect(find(drafts, "2026-06", "imaj_reit_net_asset_total", c).value).toBe(12_299_733_000_000);
}

function checkRealBatch(spec: MoneyflowSourceSpec, key: string, bytes: Uint8Array, expectedRows: number, firstPeriod: string) {
  const drafts = spec.toObservations({ key, files: [{ filename: `${key}.xlsx`, bytes }] });
  validateDrafts(spec.name, drafts, spec.indicators);
  expect(drafts).toHaveLength(expectedRows);
  expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
  expect(drafts[0]?.period).toBe(firstPeriod);
  return drafts;
}

const REAL_NOW = new Date("2026-09-27T03:00:00Z"); // 取得日 (JST 2026-09-27 12:00)

describe.skipIf(!existsSync(B1_TRIMMED))("実ファイル B-1 (2026-09-27 取得・直近14か月に切り詰め)", () => {
  it("toObservations → 検証を通り、120 行 (行数上限内)、原本の値と一致 (円換算)", () => {
    const drafts = checkRealBatch(imajFundFlowsSpec, "imaj-fund-flows-2026-08", readBytes(B1_TRIMMED), 120, "2025-09");
    expectB1Values(drafts);
  });

  it("resolve()/fetch() (fetch スタブ) → キー imaj-fund-flows-2026-08、同名ファイルで再解析できる", async () => {
    const bytes = readBytes(B1_TRIMMED);
    stubFetch({ [IMAJ_FUND_FLOWS_URL]: bytes });
    const resolved = await imajFundFlowsSpec.resolve(REAL_NOW);
    expect(resolved.key).toBe("imaj-fund-flows-2026-08");
    const batch = await resolved.fetch();
    expect(batch.key).toBe(resolved.key);
    expect(batch.files.map((f) => f.filename)).toEqual(["imaj-fund-flows-2026-08.xlsx"]);
    expect(sameBytes(batch.files[0]?.bytes, bytes)).toBe(true);
    expectB1Values(imajFundFlowsSpec.toObservations({ key: batch.key, files: batch.files }));
  });
});

describe.skipIf(!existsSync(B1_FULL))("実ファイル B-1 原本 (I0112B_pub_m.xlsx・1989年〜の全期間)", () => {
  it("全期間のファイルでも直近12か月だけ (120 行) を記録し、値は切り詰め版と同じ", () => {
    const drafts = checkRealBatch(imajFundFlowsSpec, "imaj-fund-flows-2026-08", readBytes(B1_FULL), 120, "2025-09");
    expectB1Values(drafts);
  });

  it("resolve() (fetch スタブ) → キー imaj-fund-flows-2026-08", async () => {
    stubFetch({ [IMAJ_FUND_FLOWS_URL]: readBytes(B1_FULL) });
    const resolved = await imajFundFlowsSpec.resolve(REAL_NOW);
    expect(resolved.key).toBe("imaj-fund-flows-2026-08");
    const batch = await resolved.fetch();
    expect(imajFundFlowsSpec.toObservations({ key: batch.key, files: batch.files })).toHaveLength(120);
  });
});

describe.skipIf(!existsSync(D1_TRIMMED))("実ファイル D-1 (2026-09-27 取得・直近14か月に切り詰め)", () => {
  it("toObservations → 検証を通り、24 行、原本の値と一致 (円換算・「-」=0)", () => {
    const drafts = checkRealBatch(imajFundFlowsReitSpec, "imaj-fund-flows-reit-2026-07", readBytes(D1_TRIMMED), 24, "2025-08");
    expectD1Values(drafts);
  });

  it("resolve()/fetch() (fetch スタブ) → キー imaj-fund-flows-reit-2026-07", async () => {
    const bytes = readBytes(D1_TRIMMED);
    stubFetch({ [IMAJ_REIT_FLOWS_URL]: bytes });
    const resolved = await imajFundFlowsReitSpec.resolve(REAL_NOW);
    expect(resolved.key).toBe("imaj-fund-flows-reit-2026-07");
    const batch = await resolved.fetch();
    expect(batch.key).toBe(resolved.key);
    expect(batch.files.map((f) => f.filename)).toEqual(["imaj-fund-flows-reit-2026-07.xlsx"]);
    expectD1Values(imajFundFlowsReitSpec.toObservations({ key: batch.key, files: batch.files }));
  });
});

describe.skipIf(!existsSync(D1_FULL))("実ファイル D-1 原本 (F00B21_pub.xlsx・2016年8月〜の全期間)", () => {
  it("全期間のファイルでも直近12か月だけ (24 行) を記録し、値は切り詰め版と同じ", () => {
    const drafts = checkRealBatch(imajFundFlowsReitSpec, "imaj-fund-flows-reit-2026-07", readBytes(D1_FULL), 24, "2025-08");
    expectD1Values(drafts);
  });
});
