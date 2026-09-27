/**
 * jsda-bonds アダプタ (JSDA 公社債発行額・償還額) のテスト。
 *
 * 実ファイル (private/ — 利用条件要確認のため commit しない) は
 * `services/moneyflow/lib/sources/fixtures/private/jsda-bonds/` に置く:
 *   - jsda-hakkou-2026-07.xlsx
 *       2026-09-27 に https://www.jsda.or.jp/shiryoshitsu/toukei/hakkou/hakkougakushoukanngaku.xlsx
 *       から取得した原本そのもの (2026年7月分更新。2019年4月分〜の月次を含む)
 *   - jsda-hakkou-index-2026-09-27.html
 *       同日に https://www.jsda.or.jp/shiryoshitsu/toukei/hakkou/index.html から取得した一覧ページ
 * 置いていない環境 (CI) では実ファイルのテストを describe.skipIf で skip する。
 * 期待値は python (openpyxl) で原本のセルを独立に読み、百万円→円に換算した値。
 *
 * CI でも走るテストは、原本の様式 (シート名・見出し行・「YYYY.MM」の月次行) だけを
 * 真似てテスト内で組み立てた **合成テストデータ** の xlsx / HTML を使う (実データではない)。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import {
  isMoneyflowFlowType,
  isMoneyflowFrequency,
  isMoneyflowLicense,
  isMoneyflowRequirement,
} from "../../../../src/shared/notion-archive/moneyflow.js";
import { validateDrafts, type ObservationDraft, type SpecFile } from "../source-spec.js";
import { JSDA_HAKKOU_PAGE_URL } from "../sources/jsda-bonds.js";
import {
  JSDA_BONDS_SPECS,
  JSDA_BONDS_SPEC_INDICATORS,
  JSDA_BONDS_WINDOW_MONTHS,
  jsdaBondCategoryInfo,
  jsdaBondsBatchKey,
  jsdaBondsIndexFilename,
  jsdaBondsSpec,
  jsdaBondsXlsxFilename,
} from "./jsda-bonds.js";

const FIXTURE_DIR = fileURLToPath(new URL("../sources/fixtures/private/jsda-bonds/", import.meta.url));
const REAL_XLSX = join(FIXTURE_DIR, "jsda-hakkou-2026-07.xlsx");
const REAL_INDEX = join(FIXTURE_DIR, "jsda-hakkou-index-2026-09-27.html");
const HAS_REAL = existsSync(REAL_XLSX) && existsSync(REAL_INDEX);

const XLSX_URL = "https://www.jsda.or.jp/shiryoshitsu/toukei/hakkou/hakkougakushoukanngaku.xlsx";
const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ROW_BUDGET = 600;
const MILLION = 1_000_000;
/** 実ファイル (2026年7月分・掲載日 2026-09-10) に対応するキー。 */
const REAL_KEY = "jsda-bonds-2026-07-published-2026-09-10";
/** 実ファイル取得日 (2026-09-27 12:00 JST)。 */
const FETCHED_AT = new Date("2026-09-27T03:00:00Z");

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
// 合成テストデータ (原本の様式だけを真似た架空の値。実データではない)
// ---------------------------------------------------------------------------

const SHEETS = [
  "合計（Total）",
  "国債（JGB）",
  "地方債",
  "政保債",
  "財投機関債等",
  "普通社債",
  "資産担保型社債",
  "転換社債（CB）",
  "金融債",
  "非居住者債",
] as const;
const COMPONENT_SHEETS = SHEETS.slice(1);

/** 合成テストデータの対象月 (2025-07〜2026-07 = 窓 12 か月 + 1 か月)。 */
const SYN_MONTHS = Array.from({ length: 13 }, (_, i) => {
  const idx = 2025 * 12 + 6 + i; // 2025-07 から
  return `${Math.floor(idx / 12)}.${String((idx % 12) + 1).padStart(2, "0")}`;
});
/** 未公表の将来月 (原本と同じく行ラベルだけ先に用意されている)。 */
const SYN_FUTURE = "2026.08";

interface SynOptions {
  /** 単位表記 (原本は百万円)。 */
  unit?: string;
  /** 追加するシート (未知の種類)。 */
  extraSheet?: string;
  /** 削除するシート。 */
  dropSheet?: string;
  /** 将来月の国債シートの埋め方 (原本は空文字。合計シートは原本どおり 0)。 */
  futureJgb?: "empty" | "zero";
  /** 値を書き換える (合成テストデータの異常系用)。 */
  override?: (sheet: string, month: string, v: { issuance: number; redemption: number }) => {
    issuance: number;
    redemption: number;
  };
}

/** 合成テストデータの値: シート i・月 j の発行額/償還額 (原資料の単位のまま)。 */
function synValue(sheet: string, monthIdx: number): { issuance: number; redemption: number } {
  const i = COMPONENT_SHEETS.indexOf(sheet as (typeof COMPONENT_SHEETS)[number]) + 1;
  return { issuance: i * 1000 + monthIdx, redemption: i * 100 + monthIdx };
}

function buildSyntheticXlsx({ unit = "百万円", ...opts }: SynOptions = {}): Uint8Array {
  const wb = XLSX.utils.book_new();
  const sheets: string[] = SHEETS.filter((s) => s !== opts.dropSheet);
  if (opts.extraSheet) sheets.push(opts.extraSheet);
  for (const sheet of sheets) {
    const valueOf = (monthIdx: number): { issuance: number; redemption: number } => {
      const month = SYN_MONTHS[monthIdx] as string;
      let v: { issuance: number; redemption: number };
      if (sheet === "合計（Total）") {
        v = COMPONENT_SHEETS.reduce(
          (acc, s) => {
            const c = opts.override ? opts.override(s, month, synValue(s, monthIdx)) : synValue(s, monthIdx);
            return { issuance: acc.issuance + c.issuance, redemption: acc.redemption + c.redemption };
          },
          { issuance: 0, redemption: 0 }
        );
      } else {
        v = synValue(sheet, monthIdx);
      }
      return opts.override ? opts.override(sheet, month, v) : v;
    };
    const aoa: unknown[][] = [
      ["", `合成テスト ${sheet}`],
      ["", "synthetic"],
      [`(単位：${unit}）\n(unit)`, "発 行 額\nIssue", "", "償還額内訳", "", "", "", "合計(b)\nTotal", "増減（△）\nNet"],
      ["年月中", "銘柄数", "金額(a)\nAmount of Issued", "銘柄数", "満期償還額", "定時償還額", "買入消却額", "", ""],
      ["【月中】 During the month"],
    ];
    SYN_MONTHS.forEach((label, idx) => {
      const v = valueOf(idx);
      aoa.push([label, 1, v.issuance, 1, v.redemption, 0, 0, v.redemption, v.issuance - v.redemption]);
    });
    if (sheet === "国債（JGB）" && opts.futureJgb !== "zero") {
      aoa.push([SYN_FUTURE, "", "", "", "", "", "", "", ""]);
    } else {
      aoa.push([SYN_FUTURE, 0, 0, 0, 0, 0, 0, 0, 0]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet);
  }
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

/** 合成テストデータの一覧ページ (原本の該当行の書式だけを真似たもの)。 */
function syntheticIndexHtml(period = "2026年7月分", published = "2026.9.10"): Uint8Array {
  return new TextEncoder().encode(
    `<!doctype html><html><head><meta charset="utf-8"></head><body><ul>` +
      `<li><a href="hakkougakushoukanngaku.xlsx"><span style="font-size: 110%;">公社債発行額・償還額（${period}更新）</span></a> ` +
      `<span class="text_icon"></span>（掲載日：${published}）</li></ul></body></html>`
  );
}

/** キーに対応する保管ファイル名で xlsx を 1 件渡す。 */
const xlsxFiles = (key: string, bytes: Uint8Array): SpecFile[] => [{ filename: jsdaBondsXlsxFilename(key), bytes }];

// ---------------------------------------------------------------------------
// 1. 指標定義
// ---------------------------------------------------------------------------

describe("指標定義", () => {
  it("全指標が enum ガードを通り、キーが一意で、出典は https、説明と限界は日本語で空でない", () => {
    expect(JSDA_BONDS_SPEC_INDICATORS.map((i) => i.key)).toEqual(["jsda_bond_issuance", "jsda_bond_redemption"]);
    expect(new Set(JSDA_BONDS_SPEC_INDICATORS.map((i) => i.key)).size).toBe(JSDA_BONDS_SPEC_INDICATORS.length);
    for (const i of JSDA_BONDS_SPEC_INDICATORS) {
      expect(isMoneyflowFlowType(i.flowType), i.key).toBe(true);
      expect(isMoneyflowFrequency(i.frequency), i.key).toBe(true);
      expect(isMoneyflowLicense(i.license), i.key).toBe(true);
      expect(isMoneyflowRequirement(i.requirement), i.key).toBe(true);
      expect(new URL(i.sourceUrl).protocol, i.key).toBe("https:");
      expect(i.sourceUrl).toBe(JSDA_HAKKOU_PAGE_URL);
      for (const text of [i.displayName, i.description, i.limitations]) {
        expect(text.trim().length, i.key).toBeGreaterThan(0);
        expect(text, i.key).toMatch(/[぀-ヿ一-鿿]/);
      }
    }
  });

  it("要件・利用条件・頻度が定義どおりで、純額でないこと・単位・転換を含むことを明記する", () => {
    const byKey = new Map(JSDA_BONDS_SPEC_INDICATORS.map((i) => [i.key, i]));
    for (const i of JSDA_BONDS_SPEC_INDICATORS) {
      expect(i.requirement).toBe("R2");
      // 商用可否が未確認のため personal-only に丸めない
      expect(i.license).toBe("要確認");
      expect(i.frequency).toBe("月次");
      expect(i.flowType).toBe("売買代金");
      expect(i.description).toMatch(/単位は円\(原資料の百万円を換算\)/);
      expect(i.description).toMatch(/フロー/);
      expect(i.limitations).toMatch(/直近12か月/);
      expect(i.limitations).toMatch(/要確認/);
    }
    expect(byKey.get("jsda_bond_issuance")?.description).toMatch(/純額でも、投資家の買い越し\/売り越しでもない/);
    expect(byKey.get("jsda_bond_redemption")?.description).toMatch(/株式への転換/);
    expect(byKey.get("jsda_bond_redemption")?.description).toMatch(/売り越し.*ではない/);
    // 円建非居住者債の「転換額」列は原本 (2019.04〜2026.07) で常に 0 で、何への転換かも
    // 原本に書かれていない。株式への転換と言い切らない (転換社債型新株予約権付社債だけが株式)。
    const redemptionDef = byKey.get("jsda_bond_redemption");
    if (!redemptionDef) throw new Error("テスト: jsda_bond_redemption の定義がありません");
    const redemption = redemptionDef.description;
    expect(redemption).not.toMatch(/円建非居住者債では株式への転換/);
    expect(redemption).toMatch(/円建非居住者債にも転換額の列があり合計に含まれるが、2019年4月分以降の原資料では常に0円/);
    // 原本注記: 買入消却額には定時償還・買入消却以外の方法による一部償還も含む
    expect(redemption).toMatch(/定時償還・買入消却以外の方法による一部償還も含まれる/);
  });

  it("spec 名は規約どおりで、spec は 1 つ", () => {
    expect(JSDA_BONDS_SPECS.map((s) => s.name)).toEqual(["jsda-bonds"]);
    expect(jsdaBondsSpec.indicators).toBe(JSDA_BONDS_SPEC_INDICATORS);
  });
});

// ---------------------------------------------------------------------------
// 2. 実ファイル → 観測行 (値の照合)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_REAL)("実ファイル (2026年7月分) → toObservations", () => {
  let drafts: ObservationDraft[] = [];
  beforeAll(() => {
    drafts = jsdaBondsSpec.toObservations({ key: REAL_KEY, files: xlsxFiles(REAL_KEY, readBytes(REAL_XLSX)) });
  }, 60_000);

  it("validateDrafts を通り、行数は 12か月 × 10区分 × 2指標 = 240 行 (予算内)", () => {
    validateDrafts(jsdaBondsSpec.name, drafts, jsdaBondsSpec.indicators);
    expect(drafts).toHaveLength(JSDA_BONDS_WINDOW_MONTHS * 10 * 2);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    expect([...new Set(drafts.map((d) => d.period))]).toEqual([
      "2025-08",
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
    ]);
    // 最後の行 (取込完了の印) はキーの対象月の最後の区分の償還額
    const last = drafts[drafts.length - 1] as ObservationDraft;
    expect([last.period, last.indicatorKey, last.category]).toEqual(["2026-07", "jsda_bond_redemption", "円建非居住者債"]);
  });

  it("原本のセル値 (百万円) を円に換算した値と一致する (python/openpyxl で独立に抽出)", () => {
    // 国債（JGB）シート 2026.07 行: 金額(a)=14,524,109 / 合計(b)=8,048,861 (百万円)
    expect(find(drafts, "2026-07", "jsda_bond_issuance", "国債").value).toBe(14_524_109 * MILLION);
    expect(find(drafts, "2026-07", "jsda_bond_redemption", "国債").value).toBe(8_048_861 * MILLION);
    // 合計（Total）シート 2026.07 行: 18,459,539 / 10,634,271
    expect(find(drafts, "2026-07", "jsda_bond_issuance", "公社債合計").value).toBe(18_459_539 * MILLION);
    expect(find(drafts, "2026-07", "jsda_bond_redemption", "公社債合計").value).toBe(10_634_271 * MILLION);
    // 非居住者債シート (転換額列で合計(b)が 1 列右) 2026.07 行: 157,000 / 241,900
    expect(find(drafts, "2026-07", "jsda_bond_issuance", "円建非居住者債").value).toBe(157_000 * MILLION);
    expect(find(drafts, "2026-07", "jsda_bond_redemption", "円建非居住者債").value).toBe(241_900 * MILLION);
    // 転換社債（CB）シート 2026.07 行: 発行 0 / 償還 600 (全額が転換額)
    expect(find(drafts, "2026-07", "jsda_bond_issuance", "転換社債型新株予約権付社債").value).toBe(0);
    expect(find(drafts, "2026-07", "jsda_bond_redemption", "転換社債型新株予約権付社債").value).toBe(600 * MILLION);
    // 政保債シート 2026.07 行: 151,000 / 50,000
    expect(find(drafts, "2026-07", "jsda_bond_issuance", "政府保証債").value).toBe(151_000 * MILLION);
    // 窓の最初の月: 国債 2025.08 行 14,131,156 / 合計 2026.06 行の償還 30,245,382
    expect(find(drafts, "2025-08", "jsda_bond_issuance", "国債").value).toBe(14_131_156 * MILLION);
    expect(find(drafts, "2026-06", "jsda_bond_redemption", "公社債合計").value).toBe(30_245_382 * MILLION);
  });

  it("別の月・区分でも原本のセル値と一致する (再検証で openpyxl により独立抽出。償還超過月・0 の月を含む)", () => {
    // 地方債 2026.03 行: 合計(b)=705,946 (発行 396,500 より大きい償還超過月)
    expect(find(drafts, "2026-03", "jsda_bond_redemption", "地方債").value).toBe(705_946 * MILLION);
    // 合計（Total）2026.03 行: 合計(b)=30,681,687
    expect(find(drafts, "2026-03", "jsda_bond_redemption", "公社債合計").value).toBe(30_681_687 * MILLION);
    // 金融債 2026.07 行: 金額(a)=103,130
    expect(find(drafts, "2026-07", "jsda_bond_issuance", "金融債").value).toBe(103_130 * MILLION);
    // 財投機関債等 2025.11 行: 合計(b)=201,651
    expect(find(drafts, "2025-11", "jsda_bond_redemption", "財投機関債等").value).toBe(201_651 * MILLION);
    // 普通社債 2026.03 行: 合計(b)=1,176,100
    expect(find(drafts, "2026-03", "jsda_bond_redemption", "普通社債").value).toBe(1_176_100 * MILLION);
    // 非居住者債 2025.09 行: 合計(b) は転換額列の右 (列9) = 132,100
    expect(find(drafts, "2025-09", "jsda_bond_redemption", "円建非居住者債").value).toBe(132_100 * MILLION);
    // 資産担保型社債 2025.12 行: 発行 0 (0 は欠損ではなく実際の 0)
    expect(find(drafts, "2025-12", "jsda_bond_issuance", "資産担保型社債").value).toBe(0);
    // 国債 2025.10 行 (末尾 0 の月。数値として読むと 2025.1 になり取り違えうる): 金額(a)=14,899,176 / 合計(b)=6,494,229
    expect(find(drafts, "2025-10", "jsda_bond_issuance", "国債").value).toBe(14_899_176 * MILLION);
    expect(find(drafts, "2025-10", "jsda_bond_redemption", "国債").value).toBe(6_494_229 * MILLION);
  });

  it("期間・区分・単位・フラグが規約どおり", () => {
    const row = find(drafts, "2026-07", "jsda_bond_issuance", "国債");
    expect(row).toMatchObject({
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      categoryKind: "資産クラス",
      unit: "円",
      changeFromPrev: null,
      approximate: false,
      measureKind: "実測",
    });
    expect(find(drafts, "2026-02", "jsda_bond_issuance", "公社債合計")).toMatchObject({
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
      categoryKind: "全体",
    });
    expect([...new Set(drafts.map((d) => d.category))]).toEqual([
      "公社債合計",
      "国債",
      "地方債",
      "政府保証債",
      "財投機関債等",
      "普通社債",
      "資産担保型社債",
      "転換社債型新株予約権付社債",
      "金融債",
      "円建非居住者債",
    ]);
  });

  it("キーの対象月が原本でまだ空 (未公表) なら throw する", () => {
    expect(() =>
      jsdaBondsSpec.toObservations({
        key: "jsda-bonds-2026-08-published-2026-10-09",
        files: xlsxFiles("jsda-bonds-2026-08-published-2026-10-09", readBytes(REAL_XLSX)),
      })
    ).toThrow(/2026\.08/);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3. 合成テストデータによる対応付けの検証 (CI で走る)
// ---------------------------------------------------------------------------

describe("toObservations (合成テストデータ)", () => {
  const key = "jsda-bonds-2026-07-published-2026-09-10";

  it("窓 12 か月 × 10 区分 × 2 指標を、月→区分→(発行,償還) の固定順で出し、百万円を円に換算する", () => {
    const drafts = jsdaBondsSpec.toObservations({ key, files: xlsxFiles(key, buildSyntheticXlsx()) });
    validateDrafts(jsdaBondsSpec.name, drafts, jsdaBondsSpec.indicators);
    expect(drafts).toHaveLength(240);
    // 合成テストデータの 2025.07 (index 0) は窓の外 (窓は 2025-08〜2026-07)
    expect(drafts[0]).toEqual({
      period: "2025-08",
      periodStart: "2025-08-01",
      periodEnd: "2025-08-31",
      indicatorKey: "jsda_bond_issuance",
      category: "公社債合計",
      categoryKind: "全体",
      // 9 種類の合成値 (i*1000+1) の合計 = 45,009 百万円
      value: 45_009 * MILLION,
      unit: "円",
      changeFromPrev: null,
      approximate: false,
      measureKind: "実測",
    });
    // 国債 (i=1) 2026.07 (index 12): 発行 1,012 / 償還 112 百万円
    expect(find(drafts, "2026-07", "jsda_bond_issuance", "国債").value).toBe(1_012 * MILLION);
    expect(find(drafts, "2026-07", "jsda_bond_redemption", "国債").value).toBe(112 * MILLION);
    // 非居住者債 (i=9) → 区分「円建非居住者債」
    expect(find(drafts, "2026-07", "jsda_bond_issuance", "円建非居住者債").value).toBe(9_012 * MILLION);
    expect(drafts.slice(0, 4).map((d) => `${d.category}:${d.indicatorKey}`)).toEqual([
      "公社債合計:jsda_bond_issuance",
      "公社債合計:jsda_bond_redemption",
      "国債:jsda_bond_issuance",
      "国債:jsda_bond_redemption",
    ]);
    const last = drafts[drafts.length - 1] as ObservationDraft;
    expect([last.period, last.indicatorKey, last.category]).toEqual(["2026-07", "jsda_bond_redemption", "円建非居住者債"]);
    // 同じ入力からは同じ結果 (純関数)
    expect(jsdaBondsSpec.toObservations({ key, files: xlsxFiles(key, buildSyntheticXlsx()) })).toEqual(drafts);
  });

  it("単位表記が千円のシートは ×1,000 で円にする (単位は取得元モジュールがシートから読む)", () => {
    const drafts = jsdaBondsSpec.toObservations({ key, files: xlsxFiles(key, buildSyntheticXlsx({ unit: "千円" })) });
    expect(find(drafts, "2026-07", "jsda_bond_issuance", "国債").value).toBe(1_012 * 1_000);
  });

  it("区分表: 既知のシート名を区分と区分種別に変換し、未知のシート名は throw", () => {
    expect(jsdaBondCategoryInfo("政保債")).toEqual({ label: "政府保証債", kind: "資産クラス" });
    expect(jsdaBondCategoryInfo("合計（Total）")).toEqual({ label: "公社債合計", kind: "全体" });
    expect(() => jsdaBondCategoryInfo("政府保証債")).toThrow(/未知の公社債種類/);
  });
});

// ---------------------------------------------------------------------------
// 4. resolve / fetch (fetch をスタブ)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_REAL)("resolve / fetch (実ファイルを配信する fetch スタブ)", () => {
  it(
    "一覧ページから最新月・掲載日のキーを決め、fetch は同じキーで xlsx と一覧ページを返す",
    async () => {
      const xlsx = readBytes(REAL_XLSX);
      const html = readBytes(REAL_INDEX);
      const fetchMock = stubFetch({ [JSDA_HAKKOU_PAGE_URL]: html, [XLSX_URL]: xlsx });

      const resolved = await jsdaBondsSpec.resolve(FETCHED_AT);
      expect(resolved.key).toBe(REAL_KEY);
      // resolve では一覧ページだけを取る (本体 xlsx は取らない)
      expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([JSDA_HAKKOU_PAGE_URL]);

      const batch = await resolved.fetch();
      expect(batch.key).toBe(REAL_KEY);
      expect(batch.source).toBe(XLSX_URL);
      expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([JSDA_HAKKOU_PAGE_URL, XLSX_URL]);
      expect(batch.files.map((f) => [f.filename, f.contentType])).toEqual([
        [`${REAL_KEY}.xlsx`, XLSX_CONTENT_TYPE],
        [`${REAL_KEY}-index.html`, "text/html; charset=utf-8"],
      ]);
      expect(sameBytes(batch.files[0]?.bytes, xlsx)).toBe(true);
      expect(sameBytes(batch.files[1]?.bytes, html)).toBe(true);
      expect(batch.metadata).toMatchObject({
        periodMonth: "2026-07",
        publishedOn: "2026-09-10",
        fileUrl: XLSX_URL,
        linkedFilename: "hakkougakushoukanngaku.xlsx",
        windowStart: "2025-08",
        xlsxBytes: xlsx.byteLength,
      });

      const drafts = jsdaBondsSpec.toObservations({ key: batch.key, files: batch.files });
      validateDrafts(jsdaBondsSpec.name, drafts, jsdaBondsSpec.indicators);
      expect(drafts).toHaveLength(240);
      expect(find(drafts, "2026-07", "jsda_bond_issuance", "国債").value).toBe(14_524_109 * MILLION);
    },
    60_000
  );
});

describe("resolve / fetch (合成テストデータを配信する fetch スタブ)", () => {
  const key = "jsda-bonds-2026-07-published-2026-09-10";

  it("キーと保管ファイル名が安定し、toObservations まで通る", async () => {
    const xlsx = buildSyntheticXlsx();
    const html = syntheticIndexHtml();
    stubFetch({ [JSDA_HAKKOU_PAGE_URL]: html, [XLSX_URL]: xlsx });
    const resolved = await jsdaBondsSpec.resolve(FETCHED_AT);
    expect(resolved.key).toBe(key);
    const batch = await resolved.fetch();
    expect(batch.key).toBe(key);
    expect(batch.files.map((f) => f.filename)).toEqual([jsdaBondsXlsxFilename(key), jsdaBondsIndexFilename(key)]);
    expect(sameBytes(batch.files[0]?.bytes, xlsx)).toBe(true);
    const drafts = jsdaBondsSpec.toObservations({ key: batch.key, files: batch.files });
    expect(drafts).toHaveLength(240);
  });

  it("一覧ページの最新月が実行月の 4 か月以上前なら更新停止を疑って throw (3 か月前までは許す)", async () => {
    stubFetch({ [JSDA_HAKKOU_PAGE_URL]: syntheticIndexHtml() });
    await expect(jsdaBondsSpec.resolve(new Date("2026-10-31T03:00:00Z"))).resolves.toMatchObject({ key });
    await expect(jsdaBondsSpec.resolve(new Date("2026-11-01T03:00:00Z"))).rejects.toThrow(/のままです/);
  });

  it("最新月・掲載日が実行時点 (JST) より後なら throw", async () => {
    stubFetch({ [JSDA_HAKKOU_PAGE_URL]: syntheticIndexHtml() });
    // 2026-09-09 23:00 JST は掲載日 2026-09-10 より前
    await expect(jsdaBondsSpec.resolve(new Date("2026-09-09T14:00:00Z"))).rejects.toThrow(/掲載日 2026-09-10 が実行日/);
    // 2026-09-10 00:30 JST (UTC ではまだ 9 日) なら通る
    await expect(jsdaBondsSpec.resolve(new Date("2026-09-09T15:30:00Z"))).resolves.toMatchObject({ key });
    await expect(jsdaBondsSpec.resolve(new Date("2026-06-30T03:00:00Z"))).rejects.toThrow(/実行月 2026-06/);
  });

  it("掲載日が対象月の末日以前 (一覧ページの読み取り異常) なら throw", async () => {
    stubFetch({ [JSDA_HAKKOU_PAGE_URL]: syntheticIndexHtml("2026年7月分", "2026.7.20") });
    await expect(jsdaBondsSpec.resolve(FETCHED_AT)).rejects.toThrow(/末日以前/);
  });

  it("本体の応答が xlsx (zip) でなければ保管前に throw、一覧ページが 404 なら resolve で throw", async () => {
    stubFetch({
      [JSDA_HAKKOU_PAGE_URL]: syntheticIndexHtml(),
      [XLSX_URL]: new TextEncoder().encode("<html>maintenance</html>"),
    });
    const resolved = await jsdaBondsSpec.resolve(FETCHED_AT);
    await expect(resolved.fetch()).rejects.toThrow(/xlsx \(zip\) ではありません/);

    stubFetch({});
    await expect(jsdaBondsSpec.resolve(FETCHED_AT)).rejects.toThrow(/HTTP 404/);
  });
});

// ---------------------------------------------------------------------------
// 5. 想定外の入力は throw
// ---------------------------------------------------------------------------

describe("想定外の入力は throw する", () => {
  const key = "jsda-bonds-2026-07-published-2026-09-10";

  it("ファイルが無い・名前が違う・同名が 2 件", () => {
    const bytes = buildSyntheticXlsx();
    expect(() => jsdaBondsSpec.toObservations({ key, files: [] })).toThrow(/該当ファイルが 0 件/);
    expect(() =>
      jsdaBondsSpec.toObservations({ key, files: [{ filename: "hakkougakushoukanngaku.xlsx", bytes }] })
    ).toThrow(/該当ファイルが 0 件/);
    expect(() => jsdaBondsSpec.toObservations({ key, files: [...xlsxFiles(key, bytes), ...xlsxFiles(key, bytes)] })).toThrow(
      /該当ファイルが 2 件/
    );
  });

  it("キーの形式・月・掲載日が不正", () => {
    const bytes = buildSyntheticXlsx();
    for (const bad of [
      "jsda-bonds-2026-07",
      "jsda-bonds-2026-13-published-2027-02-10",
      "jsda-bonds-2026-07-published-2026-02-30",
      "jsda-bonds-2026-07-published-2026-07-31",
      "jsda-bond-issuance-redemption-2026-07",
    ]) {
      expect(() => jsdaBondsSpec.toObservations({ key: bad, files: xlsxFiles(bad, bytes) }), bad).toThrow();
    }
    expect(() => jsdaBondsBatchKey({ periodMonth: "2026-7", publishedOn: "2026-09-10" })).toThrow(/冪等キーの形式/);
  });

  it("未知のシート (種類の追加) ・シートの欠落", () => {
    expect(() =>
      jsdaBondsSpec.toObservations({ key, files: xlsxFiles(key, buildSyntheticXlsx({ extraSheet: "新種債" })) })
    ).toThrow(/未知の公社債種類 \(シート名\) です: "新種債"/);
    expect(() =>
      jsdaBondsSpec.toObservations({ key, files: xlsxFiles(key, buildSyntheticXlsx({ dropSheet: "金融債" })) })
    ).toThrow(/シート「金融債」がありません/);
  });

  it("9 種類の合計と公社債合計の不一致・負の値", () => {
    const mismatch = buildSyntheticXlsx({
      override: (sheet, month, v) =>
        sheet === "合計（Total）" && month === "2026.03" ? { ...v, redemption: v.redemption + 1 } : v,
    });
    expect(() => jsdaBondsSpec.toObservations({ key, files: xlsxFiles(key, mismatch) })).toThrow(
      /2026-03: 9 種類の合計 .* と一致しません/
    );
    const negative = buildSyntheticXlsx({
      override: (sheet, month, v) => (sheet === "地方債" && month === "2026.05" ? { ...v, redemption: -5 } : v),
    });
    expect(() => jsdaBondsSpec.toObservations({ key, files: xlsxFiles(key, negative) })).toThrow(/負です/);
  });

  it("未公表の将来月: 国債が空なら取得元モジュールが、0 で先埋めされていても公社債合計 0 で throw", () => {
    const futureKey = "jsda-bonds-2026-08-published-2026-10-09";
    // 窓 2025-09〜2026-08 のうち 2026-08 が未公表 (合成テストデータ)
    expect(() =>
      jsdaBondsSpec.toObservations({ key: futureKey, files: xlsxFiles(futureKey, buildSyntheticXlsx()) })
    ).toThrow(/値が空です/);
    expect(() =>
      jsdaBondsSpec.toObservations({
        key: futureKey,
        files: xlsxFiles(futureKey, buildSyntheticXlsx({ futureJgb: "zero" })),
      })
    ).toThrow(/公社債合計の発行額\/償還額が 0 です/);
  });
});
