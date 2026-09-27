/**
 * jpx-derivatives-investor アダプタ (JPX 先物・オプション 投資部門別取引状況 / 指数先物建玉残高) のテスト。
 *
 * 実ファイル (private/ — JPX の利用条件は personal-only のため commit しない) は
 * `services/moneyflow/lib/sources/fixtures/private/jpx-derivatives-investor/` に置く:
 *   - jpx-deriv-investor-week-20260907_20260911.csv
 *       2026-09-27 に https://www.jpx.co.jp/markets/statistics-derivatives/sector/t13vrt000001yi1d-att/Tousi_DV_W_20260907_20260911.csv
 *       から取得した原本そのもの (MD5 df1dce16e5d7981e67469f5e01e1091e)
 *   - jpx-futures-oi-20260918-indexfut.xlsx
 *       2026-09-27 に https://www.jpx.co.jp/automation/markets/derivatives/open-interest/files/2026/20260918_indexfut_oi_by_tp.xlsx
 *       から取得した原本そのもの (MD5 ed8b1b5fd4790a8050d51df954942d7d)
 *   - jpx-deriv-sector-index-20260927.html
 *       2026-09-27 に https://www.jpx.co.jp/markets/statistics-derivatives/sector/index.html から取得した一覧ページ
 * 置いていない環境 (CI) では実ファイルのテストを describe.skipIf で skip する。
 * 期待値は検証証跡 (docs/moneyflow-evidence-2026-09-27 の jpx-derivatives-investor の verified_values:
 * 原本 CSV を Python csv で、原本 xlsx の生 XML を自前の Python パーサで、実装とは独立に読んだ値)。
 *
 * CI でも走るテストは、原本の様式 (CSV の 12 列・コード体系・差引の符号規則、xlsx の見出し・
 * 左右 2 ブロックの列配置、一覧ページのリンク形式、索引 JSON の形) だけを真似てテスト内で
 * 組み立てた **合成テストデータ** を使う (値・参加者名は実データではない)。
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
import { validateDrafts, type ObservationDraft, type SpecFile } from "../source-spec.js";
import {
  INDICATOR_DEFINITIONS,
  JPX_DERIV_INVESTOR_NAMES,
  JPX_DERIV_PRODUCT_NAMES,
} from "../sources/jpx-derivatives-investor.js";
import {
  JPX_DERIVATIVES_INVESTOR_SPECS,
  JPX_DERIV_FUTURES_OI_INDICATORS,
  JPX_DERIV_FUTURES_OI_KEY,
  JPX_DERIV_FUTURES_OI_SPEC_NAME,
  JPX_DERIV_GROSS_VALUE_KEY,
  JPX_DERIV_GROSS_VOLUME_KEY,
  JPX_DERIV_MAX_AGE_DAYS,
  JPX_DERIV_NET_VALUE_KEY,
  JPX_DERIV_NET_VOLUME_KEY,
  JPX_DERIV_WEEKLY_INDICATORS,
  JPX_DERIV_WEEKLY_INVESTORS,
  JPX_DERIV_WEEKLY_PRODUCTS,
  JPX_DERIV_WEEKLY_SPEC_NAME,
  assertJpxDerivFresh,
  jpxDerivBatchKey,
  jpxDerivativesInvestorFuturesOiSpec,
  jpxDerivativesInvestorWeeklySpec,
} from "./jpx-derivatives-investor.js";

const FIXTURE_DIR = fileURLToPath(new URL("../sources/fixtures/private/jpx-derivatives-investor/", import.meta.url));
const REAL_CSV = join(FIXTURE_DIR, "jpx-deriv-investor-week-20260907_20260911.csv");
const REAL_XLSX = join(FIXTURE_DIR, "jpx-futures-oi-20260918-indexfut.xlsx");
const REAL_INDEX = join(FIXTURE_DIR, "jpx-deriv-sector-index-20260927.html");
const HAS_CSV = existsSync(REAL_CSV);
const HAS_XLSX = existsSync(REAL_XLSX);
const HAS_INDEX = existsSync(REAL_INDEX);

const ROW_BUDGET = 600;
const SECTOR_INDEX_URL = "https://www.jpx.co.jp/markets/statistics-derivatives/sector/index.html";
const REAL_CSV_URL =
  "https://www.jpx.co.jp/markets/statistics-derivatives/sector/t13vrt000001yi1d-att/Tousi_DV_W_20260907_20260911.csv";
const OI_YEARLIST_URL = "https://www.jpx.co.jp/automation/markets/derivatives/open-interest/json/open_interest_yearlist.json";
const OI_YEAR_PATH = "/automation/markets/derivatives/open-interest/json/open_interest_2026.json";
const OI_XLSX_PATH = "/automation/markets/derivatives/open-interest/files/2026/20260918_indexfut_oi_by_tp.xlsx";
const WEEKLY_KEY = "jpx-derivatives-investor-weekly-2026-W37";
const OI_KEY = "jpx-derivatives-investor-futures-oi-2026-W38";
const WEEKLY_FILENAME = "jpx-deriv-investor-2026-09-11.csv";
const OI_FILENAME = "jpx-futures-oi-indexfut-2026-09-18.xlsx";
/** 実ファイル取得日 (2026-09-27 12:00 JST)。 */
const FETCHED_AT = new Date("2026-09-27T03:00:00Z");

const readBytes = (path: string): Uint8Array => new Uint8Array(readFileSync(path));
const sameBytes = (a: Uint8Array | undefined, b: Uint8Array): boolean =>
  a !== undefined && Buffer.from(a).equals(Buffer.from(b));

function find(drafts: readonly ObservationDraft[], indicatorKey: string, category: string): ObservationDraft {
  const hits = drafts.filter((d) => d.indicatorKey === indicatorKey && d.category === category);
  if (hits.length !== 1) throw new Error(`テスト: ${indicatorKey}|${category} が ${hits.length} 件`);
  return hits[0] as ObservationDraft;
}

/** fetch をスタブし、URL → 本文の対応だけ 200 で返す (他は 404)。呼ばれた URL を記録する。 */
function stubFetch(routes: Record<string, Uint8Array | string>): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const body = routes[url];
    if (body === undefined) return new Response("not found", { status: 404, statusText: "Not Found" });
    return new Response(typeof body === "string" ? body : new Uint8Array(body), { status: 200 });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 合成テストデータ (実データではない)
// ---------------------------------------------------------------------------

const CSV_HEADER =
  '"帳票種別 Product type","サイクル区分 Cycle","年月週 Year, Month, Week",' +
  '"報告年月日（自）Period covered - from","報告年月日（至）Period covered - to",' +
  '"投資部門コード Type of Investor","数量金額区分 Volume/Value","売 Sales",' +
  '"売-差引 Balance","買 Purchases","買-差引 Balance","合計 Total"';

/** 合成テストデータ: 1 行 (差引は 買−売 を売り越しなら売-差引(負)、買い越しなら買-差引(正) に入れる原本の規則どおり)。 */
function synthRow(product: string, investor: string, metric: "1" | "2", sales: number, purchases: number, from = "20260907", to = "20260911"): string {
  const net = purchases - sales;
  const salesBalance = net < 0 ? net : 0;
  const purchasesBalance = net > 0 ? net : 0;
  return [product, "1", "2026092", from, to, investor, metric, sales, salesBalance, purchases, purchasesBalance, sales + purchases].join(",");
}

/** 合成テストデータの売・買 (商品 i・投資部門 j ごとに決まる架空の値)。代金は数量×1,000,000。 */
function synthAmounts(i: number, j: number, metric: "1" | "2"): { sales: number; purchases: number } {
  const sales = 1000 + i * 100 + j * 7;
  const purchases = 1000 + i * 100 + (j % 2 === 0 ? j * 11 : -j * 5);
  const scale = metric === "2" ? 1_000_000 : 1;
  return { sales: sales * scale, purchases: purchases * scale };
}

/** 合成テストデータの CSV 全体 (固定 11 商品の全投資部門×数量/代金 + 固定リスト外の商品 449)。 */
function synthCsvLines(): string[] {
  const lines: string[] = [];
  const products = [...JPX_DERIV_WEEKLY_PRODUCTS.map(([code]) => code), "449"];
  products.forEach((product, i) => {
    JPX_DERIV_WEEKLY_INVESTORS.forEach(([investor], j) => {
      for (const metric of ["1", "2"] as const) {
        const { sales, purchases } = synthAmounts(i, j, metric);
        lines.push(synthRow(product, investor, metric, sales, purchases));
      }
    });
  });
  return lines;
}

const encodeCsv = (lines: readonly string[]): Uint8Array =>
  new TextEncoder().encode("﻿" + [CSV_HEADER, ...lines].join("\r\n") + "\r\n");

const weeklyFiles = (bytes: Uint8Array, filename = WEEKLY_FILENAME): SpecFile[] => [{ filename, bytes }];

/** 合成テストデータの一覧ページ (実データの週次リンクはアイコンのみ、サンプルはリンクテキスト付き、の形だけ真似る)。 */
const SYNTH_INDEX_HTML = `
  <table class="overtable fixedhead"><tr><td>
    <a href="/markets/statistics-derivatives/sector/t13vrt000001yi1d-att/Tousi_DV_W_20260907_20260911.csv" rel="external"><img alt="icon-csv" /></a>
    <a href="/markets/statistics-derivatives/sector/t13vrt000001y00l-att/Tousi_DV_W_20260831_20260904.csv" rel="external"><img alt="icon-csv" /></a>
  </td></tr></table>
  <a href="/markets/statistics-derivatives/sector/tvdivq00000020o8-att/Tousi_DV_W_20260413_20260417.csv" rel="external">「投資部門別取引状況」サンプルファイル（ＣＳＶ版）</a>
`;

/** 合成テストデータの建玉 xlsx の 1 商品分 (見出し + 小見出し + 2 順位 × 左右 2 限月)。参加者は架空。 */
function synthOiSection(product: string, seed: number): unknown[][] {
  const row = (rank: number): unknown[] => [
    rank, "2026年12月限月", `9${seed}0${rank}1`, `合成証券${seed}-${rank}A`, 1000 * seed + rank, `9${seed}0${rank}2`, `合成証券${seed}-${rank}B`, 2000 * seed + rank, "", "",
    rank, "2027年03月限月", `9${seed}0${rank}3`, `合成証券${seed}-${rank}C`, 300 * seed + rank, `9${seed}0${rank}4`, `合成証券${seed}-${rank}D`, 400 * seed + rank,
  ];
  return [[`＜${product}＞`], ["", "", "（売超参加者）", "", "", "（買超参加者）"], row(1), row(2)];
}

function synthOiXlsx(products: readonly string[], asOfLabel = "（ 2026年09月18日現在 ）"): Uint8Array {
  const grid: unknown[][] = [["指数先物取引参加者別建玉残高"], [asOfLabel], ["2026年09月24日"]];
  products.forEach((p, i) => grid.push(...synthOiSection(p, i + 1)));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), "Sheet1");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

const OI_PRODUCTS = ["日経225先物", "日経225mini", "TOPIX先物"] as const;
const oiFiles = (bytes: Uint8Array, filename = OI_FILENAME): SpecFile[] => [{ filename, bytes }];

/** 合成テストデータの索引 JSON (年一覧・週一覧。取得時の構造だけ真似る)。 */
function oiIndexRoutes(xlsx: Uint8Array): Record<string, Uint8Array | string> {
  return {
    [OI_YEARLIST_URL]: JSON.stringify({
      UpdateDate: "2026/09/24 15:31",
      TableDatas: [
        { Year: "2025", Jsonfile: "/automation/markets/derivatives/open-interest/json/open_interest_2025.json" },
        { Year: "2026", Jsonfile: OI_YEAR_PATH },
      ],
    }),
    [`https://www.jpx.co.jp${OI_YEAR_PATH}`]: JSON.stringify({
      UpdateDate: "2026/09/24 15:31",
      TableDatas: [
        { TradeDate: "20260911", IndexFutures: "/automation/markets/derivatives/open-interest/files/2026/20260911_indexfut_oi_by_tp.xlsx", IndexOptions: "", SecuritiesOptions: "" },
        { TradeDate: "20260918", IndexFutures: OI_XLSX_PATH, IndexOptions: "", SecuritiesOptions: "" },
      ],
    }),
    [`https://www.jpx.co.jp${OI_XLSX_PATH}`]: xlsx,
  };
}

// ---------------------------------------------------------------------------
// 1. 指標定義
// ---------------------------------------------------------------------------

describe("指標定義", () => {
  const all = [...JPX_DERIV_WEEKLY_INDICATORS, ...JPX_DERIV_FUTURES_OI_INDICATORS];

  it("全指標が Notion 側の列挙値・https 出典・日本語の説明/限界を持ち、キーが一意", () => {
    expect(all.map((d) => d.key)).toEqual([
      JPX_DERIV_NET_VOLUME_KEY,
      JPX_DERIV_NET_VALUE_KEY,
      JPX_DERIV_GROSS_VOLUME_KEY,
      JPX_DERIV_GROSS_VALUE_KEY,
      JPX_DERIV_FUTURES_OI_KEY,
    ]);
    expect(new Set(all.map((d) => d.key)).size).toBe(all.length);
    for (const d of all) {
      expect(isMoneyflowFlowType(d.flowType)).toBe(true);
      expect(isMoneyflowFrequency(d.frequency)).toBe(true);
      expect(isMoneyflowLicense(d.license)).toBe(true);
      expect(isMoneyflowRequirement(d.requirement)).toBe(true);
      expect(d.requirement).toBe("R3");
      expect(d.license).toBe("personal-only");
      expect(d.frequency).toBe("週次");
      expect(d.sourceUrl).toMatch(/^https:\/\/www\.jpx\.co\.jp\//);
      expect(d.displayName).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(d.description).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(d.limitations).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(d.limitations).toMatch(/personal-only|商用/);
    }
  });

  it("フロー/ストック・符号・単位・近似の説明を持つ (ルール7: 正確で平易な定義)", () => {
    const byKey = new Map(all.map((d) => [d.key, d]));
    const text = (k: string): string => {
      const d = byKey.get(k);
      if (!d) throw new Error(`テスト: 指標 ${k} が無い`);
      return `${d.description}\n${d.limitations}`;
    };
    expect(text(JPX_DERIV_NET_VOLUME_KEY)).toMatch(/プラスは買い越し.*マイナスは売り越し/);
    expect(text(JPX_DERIV_NET_VOLUME_KEY)).toMatch(/単位は枚/);
    expect(text(JPX_DERIV_NET_VALUE_KEY)).toMatch(/単位は円/);
    expect(text(JPX_DERIV_NET_VALUE_KEY)).toMatch(/想定元本/);
    expect(text(JPX_DERIV_NET_VALUE_KEY)).toMatch(/プレミアム/);
    expect(text(JPX_DERIV_GROSS_VALUE_KEY)).toMatch(/向きは表さない/);
    expect(text(JPX_DERIV_FUTURES_OI_KEY)).toMatch(/残高\(ストック\)/);
    expect(text(JPX_DERIV_FUTURES_OI_KEY)).toMatch(/正の数で記録/);
    // 固定の商品リストと絞り方を「限界」に書く
    for (const [, name] of JPX_DERIV_WEEKLY_PRODUCTS) expect(text(JPX_DERIV_NET_VOLUME_KEY)).toContain(name);
  });

  it("固定の商品・投資部門リストが取得元モジュールの名称と一致し、取得元の定義は R3", () => {
    for (const [code, name] of JPX_DERIV_WEEKLY_PRODUCTS) expect(JPX_DERIV_PRODUCT_NAMES[code]).toBe(name);
    expect(Object.fromEntries(JPX_DERIV_WEEKLY_INVESTORS)).toEqual({ ...JPX_DERIV_INVESTOR_NAMES });
    for (const d of INDICATOR_DEFINITIONS) expect(d.requirements).toContain("R3");
  });

  it("spec 名は取得元キーで始まり、spec 一覧に 2 件", () => {
    expect(JPX_DERIVATIVES_INVESTOR_SPECS.map((s) => s.name)).toEqual([
      JPX_DERIV_WEEKLY_SPEC_NAME,
      JPX_DERIV_FUTURES_OI_SPEC_NAME,
    ]);
    for (const s of JPX_DERIVATIVES_INVESTOR_SPECS) expect(s.name).toMatch(/^jpx-derivatives-investor(-[a-z0-9-]+)?$/);
  });
});

// ---------------------------------------------------------------------------
// 3. weekly: 投資部門別取引状況 (合成テストデータ、CI でも走る)
// ---------------------------------------------------------------------------

describe("weekly toObservations (合成テストデータ)", () => {
  const drafts = jpxDerivativesInvestorWeeklySpec.toObservations({ key: WEEKLY_KEY, files: weeklyFiles(encodeCsv(synthCsvLines())) });

  it("固定 11 商品 × 11 投資部門 × 4 指標 = 484 行で、検証を通り行数の目安に収まる", () => {
    expect(drafts).toHaveLength(JPX_DERIV_WEEKLY_PRODUCTS.length * JPX_DERIV_WEEKLY_INVESTORS.length * 4);
    expect(drafts).toHaveLength(484);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    expect(() => validateDrafts(JPX_DERIV_WEEKLY_SPEC_NAME, drafts, JPX_DERIV_WEEKLY_INDICATORS)).not.toThrow();
  });

  it("期間・区分・単位・フラグを規約どおりに付け、固定リスト外の商品は記録しない", () => {
    for (const d of drafts) {
      expect(d).toMatchObject({
        period: "2026-W37",
        periodStart: "2026-09-07",
        periodEnd: "2026-09-11",
        categoryKind: "投資部門",
        changeFromPrev: null,
        approximate: true,
        measureKind: "実測",
      });
      expect(d.unit).toBe(d.indicatorKey.endsWith("_value") ? "円" : "枚");
    }
    expect(drafts.some((d) => d.category.startsWith("東証銀行業株価指数先物"))).toBe(false);
    expect(new Set(drafts.map((d) => d.category.split(" / ")[0]))).toEqual(
      new Set(JPX_DERIV_WEEKLY_PRODUCTS.map(([, name]) => name))
    );
  });

  it("純売買は 買−売 (売り越しは負)、グロスは 売+買 を、数量は枚・代金は円のまま (換算係数 1) で記録する", () => {
    // 商品 i=0 (日経225先物)・投資部門 j=10 (海外投資家): 売 1070 / 買 1110 → +40 (買い越し)
    expect(find(drafts, JPX_DERIV_NET_VOLUME_KEY, "日経225先物 / 海外投資家").value).toBe(40);
    expect(find(drafts, JPX_DERIV_GROSS_VOLUME_KEY, "日経225先物 / 海外投資家").value).toBe(2180);
    expect(find(drafts, JPX_DERIV_NET_VALUE_KEY, "日経225先物 / 海外投資家").value).toBe(40_000_000);
    expect(find(drafts, JPX_DERIV_GROSS_VALUE_KEY, "日経225先物 / 海外投資家").value).toBe(2_180_000_000);
    // 商品 i=0・投資部門 j=1 (生保・損保): 売 1007 / 買 995 → −12 (売り越し)
    expect(find(drafts, JPX_DERIV_NET_VOLUME_KEY, "日経225先物 / 生保・損保").value).toBe(-12);
    expect(find(drafts, JPX_DERIV_NET_VALUE_KEY, "日経225先物 / 生保・損保").value).toBe(-12_000_000);
  });

  it("出力順は固定 (商品 → 投資部門 → 指標)。最後の行は最後の商品の海外投資家のグロス代金", () => {
    expect(drafts.slice(0, 4).map((d) => [d.category, d.indicatorKey])).toEqual([
      ["日経225先物 / 自己", JPX_DERIV_NET_VOLUME_KEY],
      ["日経225先物 / 自己", JPX_DERIV_NET_VALUE_KEY],
      ["日経225先物 / 自己", JPX_DERIV_GROSS_VOLUME_KEY],
      ["日経225先物 / 自己", JPX_DERIV_GROSS_VALUE_KEY],
    ]);
    const last = drafts[drafts.length - 1] as ObservationDraft;
    expect([last.category, last.indicatorKey]).toEqual(["プラッツドバイ原油先物 / 海外投資家", JPX_DERIV_GROSS_VALUE_KEY]);
    // 同じ入力なら同じ結果 (純関数)
    const again = jpxDerivativesInvestorWeeklySpec.toObservations({ key: WEEKLY_KEY, files: weeklyFiles(encodeCsv(synthCsvLines())) });
    expect(again).toEqual(drafts);
  });
});

// ---------------------------------------------------------------------------
// 5. weekly: 想定外の入力は throw
// ---------------------------------------------------------------------------

describe("weekly toObservations: 想定外の入力は throw する (合成テストデータ)", () => {
  const good = synthCsvLines();
  const run = (bytes: Uint8Array, key = WEEKLY_KEY, filename = WEEKLY_FILENAME) =>
    jpxDerivativesInvestorWeeklySpec.toObservations({ key, files: weeklyFiles(bytes, filename) });

  it("固定リストの商品×投資部門×数量/代金の行が欠けていたら throw (欠落を 0 で埋めない)", () => {
    const missing = good.filter((l) => !l.startsWith("317,1,2026092,20260907,20260911,51,2,"));
    expect(missing).toHaveLength(good.length - 1);
    expect(() => run(encodeCsv(missing))).toThrow(/帳票種別 317 × 投資部門 51 の代金の行がありません/);
  });

  it("同じ商品・投資部門・数量金額区分の行が重複していたら throw", () => {
    expect(() => run(encodeCsv([...good, good[0] as string]))).toThrow(/重複/);
  });

  it("未知の帳票種別コードの行があれば throw (取得元モジュールが検知)", () => {
    expect(() => run(encodeCsv([...good, synthRow("999", "11", "1", 10, 20)]))).toThrow(/未知の帳票種別コード/);
  });

  it("キーの週と CSV 内の対象週が違えば throw", () => {
    expect(() => run(encodeCsv(good), "jpx-derivatives-investor-weekly-2026-W38")).toThrow(/キーの週 2026-W38/);
  });

  it("キーの形式が違う・実在しない週なら throw", () => {
    expect(() => run(encodeCsv(good), "jpx-derivatives-investor-weekly-2026-09-11")).toThrow(/冪等キーの形式/);
    expect(() => run(encodeCsv(good), "jpx-derivatives-investor-weekly-2025-W53")).toThrow(/存在しません/);
  });

  it("ファイル名の日付と CSV 内の対象週の最終日が違えば throw", () => {
    expect(() => run(encodeCsv(good), WEEKLY_KEY, "jpx-deriv-investor-2026-09-10.csv")).toThrow(/ファイル名の日付/);
  });

  it("CSV ファイルが無い・2 件ある・名前が違うなら throw", () => {
    const bytes = encodeCsv(good);
    expect(() => jpxDerivativesInvestorWeeklySpec.toObservations({ key: WEEKLY_KEY, files: [] })).toThrow(/0 件/);
    expect(() =>
      jpxDerivativesInvestorWeeklySpec.toObservations({
        key: WEEKLY_KEY,
        files: [...weeklyFiles(bytes), ...weeklyFiles(bytes, "jpx-deriv-investor-2026-09-04.csv")],
      })
    ).toThrow(/2 件/);
    expect(() => run(bytes, WEEKLY_KEY, "Tousi_DV_W_20260907_20260911.csv")).toThrow(/0 件/);
  });

  it("UTF-8 として不正なバイト列なら throw (文字化けのまま読まない)", () => {
    const bytes = encodeCsv(good);
    const broken = new Uint8Array(bytes.length + 2);
    broken.set(bytes);
    broken.set([0xff, 0xfe], bytes.length);
    expect(() => run(broken)).toThrow(/UTF-8/);
  });
});

// ---------------------------------------------------------------------------
// 3/5. futures-oi: 指数先物 取引参加者別建玉残高 (合成テストデータ)
// ---------------------------------------------------------------------------

describe("futures-oi toObservations (合成テストデータ)", () => {
  const drafts = jpxDerivativesInvestorFuturesOiSpec.toObservations({ key: OI_KEY, files: oiFiles(synthOiXlsx(OI_PRODUCTS)) });

  it("3 商品 × 2 順位 × 左右 2 限月 × 売超/買超 = 24 行で、検証を通る", () => {
    expect(drafts).toHaveLength(24);
    expect(() => validateDrafts(JPX_DERIV_FUTURES_OI_SPEC_NAME, drafts, JPX_DERIV_FUTURES_OI_INDICATORS)).not.toThrow();
  });

  it("期間 (基準日の ISO 週・開始=終了=基準日)・区分・単位・フラグを規約どおりに付ける", () => {
    for (const d of drafts) {
      expect(d).toMatchObject({
        period: "2026-W38",
        periodStart: "2026-09-18",
        periodEnd: "2026-09-18",
        indicatorKey: JPX_DERIV_FUTURES_OI_KEY,
        categoryKind: "商品",
        unit: "枚",
        changeFromPrev: null,
        approximate: true,
        measureKind: "実測",
      });
    }
    // 合成データ: 商品 seed=1 (日経225先物) の 2026-12 限月 売超1位 = 1000*1+1、買超1位 = 2000*1+1
    expect(find(drafts, JPX_DERIV_FUTURES_OI_KEY, "日経225先物 / 2026-12限月 / 売超1位 / 合成証券1-1A").value).toBe(1001);
    expect(find(drafts, JPX_DERIV_FUTURES_OI_KEY, "日経225先物 / 2026-12限月 / 買超1位 / 合成証券1-1B").value).toBe(2001);
    // 右ブロック (2027-03 限月) の買超2位 (seed=3 TOPIX先物) = 400*3+2
    expect(find(drafts, JPX_DERIV_FUTURES_OI_KEY, "TOPIX先物 / 2027-03限月 / 買超2位 / 合成証券3-2D").value).toBe(1202);
  });

  it("出力順は 商品 (固定順) → 限月 → 売超・買超 → 順位", () => {
    expect(drafts.slice(0, 5).map((d) => d.category)).toEqual([
      "日経225先物 / 2026-12限月 / 売超1位 / 合成証券1-1A",
      "日経225先物 / 2026-12限月 / 売超2位 / 合成証券1-2A",
      "日経225先物 / 2026-12限月 / 買超1位 / 合成証券1-1B",
      "日経225先物 / 2026-12限月 / 買超2位 / 合成証券1-2B",
      "日経225先物 / 2027-03限月 / 売超1位 / 合成証券1-1C",
    ]);
    expect((drafts[drafts.length - 1] as ObservationDraft).category).toBe("TOPIX先物 / 2027-03限月 / 買超2位 / 合成証券3-2D");
  });

  it("想定外の商品見出しがあれば throw", () => {
    const bytes = synthOiXlsx([...OI_PRODUCTS, "JPXプライム150指数先物"]);
    expect(() => jpxDerivativesInvestorFuturesOiSpec.toObservations({ key: OI_KEY, files: oiFiles(bytes) })).toThrow(
      /想定外の商品見出し ＜JPXプライム150指数先物＞/
    );
  });

  it("3 商品のどれかが無ければ throw", () => {
    const bytes = synthOiXlsx(["日経225先物", "TOPIX先物"]);
    expect(() => jpxDerivativesInvestorFuturesOiSpec.toObservations({ key: OI_KEY, files: oiFiles(bytes) })).toThrow(
      /商品 日経225mini の行がありません/
    );
  });

  it("キーの週・ファイル名の日付とシート内の基準日が違えば throw", () => {
    const bytes = synthOiXlsx(OI_PRODUCTS);
    expect(() =>
      jpxDerivativesInvestorFuturesOiSpec.toObservations({ key: "jpx-derivatives-investor-futures-oi-2026-W37", files: oiFiles(bytes) })
    ).toThrow(/キーの週 2026-W37/);
    expect(() =>
      jpxDerivativesInvestorFuturesOiSpec.toObservations({ key: OI_KEY, files: oiFiles(bytes, "jpx-futures-oi-indexfut-2026-09-17.xlsx") })
    ).toThrow(/ファイル名の日付/);
  });

  it("xlsx が無い・様式が違う (タイトル行) なら throw", () => {
    expect(() => jpxDerivativesInvestorFuturesOiSpec.toObservations({ key: OI_KEY, files: [] })).toThrow(/0 件/);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["日経平均オプション取引参加者別建玉残高"]]), "Sheet1");
    const other = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    expect(() => jpxDerivativesInvestorFuturesOiSpec.toObservations({ key: OI_KEY, files: oiFiles(other) })).toThrow(
      /タイトル行が想定と異なります/
    );
  });
});

// ---------------------------------------------------------------------------
// 4. resolve()/fetch() (fetch をスタブ、合成テストデータ)
// ---------------------------------------------------------------------------

describe("resolve()/fetch() (fetch スタブ・合成テストデータ)", () => {
  it("weekly: 一覧ページから最新週 (サンプルリンクは除外) のキーを決め、fetch() は同じキーと安定したファイル名を返す", async () => {
    const csv = encodeCsv(synthCsvLines());
    const calls = stubFetch({ [SECTOR_INDEX_URL]: SYNTH_INDEX_HTML, [REAL_CSV_URL]: csv });
    const resolved = await jpxDerivativesInvestorWeeklySpec.resolve(FETCHED_AT);
    expect(resolved.key).toBe(WEEKLY_KEY);
    expect(calls).toEqual([SECTOR_INDEX_URL]); // resolve は一覧ページだけ
    const batch = await resolved.fetch();
    expect(batch.key).toBe(WEEKLY_KEY);
    expect(batch.source).toBe(REAL_CSV_URL);
    expect(batch.files.map((f) => [f.filename, f.contentType])).toEqual([[WEEKLY_FILENAME, "text/csv"]]);
    expect(sameBytes(batch.files[0]?.bytes, csv)).toBe(true);
    expect(calls).toEqual([SECTOR_INDEX_URL, SECTOR_INDEX_URL, REAL_CSV_URL]);
    const drafts = jpxDerivativesInvestorWeeklySpec.toObservations({ key: batch.key, files: batch.files });
    expect(drafts).toHaveLength(484);
  });

  it("weekly: resolve 後に一覧ページの最新 CSV が変わったら fetch() は throw", async () => {
    // 新しい週のリンクは実データの週次テーブル (<table>) の中に追加する (取得元モジュールは
    // 表の外の告知欄のリンクを拾わないため、表の外に足すと「一覧が変わった」ことにならない)
    const newer = SYNTH_INDEX_HTML.replace(
      "<tr><td>",
      '<tr><td><a href="/markets/statistics-derivatives/sector/t13vrt000001zzzz-att/Tousi_DV_W_20260914_20260918.csv" rel="external"><img alt="icon-csv" /></a>'
    );
    expect(newer).not.toBe(SYNTH_INDEX_HTML);
    let first = true;
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url = String(input);
      if (url === SECTOR_INDEX_URL) {
        const html = first ? SYNTH_INDEX_HTML : newer;
        first = false;
        return new Response(html, { status: 200 });
      }
      // 新しい週の URL には、その週の対象期間を持つ合成テストデータの CSV を返す
      const lines = url.includes("20260914_20260918")
        ? synthCsvLines().map((l) => l.replace(",20260907,20260911,", ",20260914,20260918,"))
        : synthCsvLines();
      return new Response(new Uint8Array(encodeCsv(lines)), { status: 200 });
    });
    const resolved = await jpxDerivativesInvestorWeeklySpec.resolve(FETCHED_AT);
    await expect(resolved.fetch()).rejects.toThrow(/resolve 後に一覧ページの最新 CSV が変わりました/);
  });

  it("weekly: 一覧ページの最新週が古すぎる (更新停止) / 実行日より後なら throw", async () => {
    stubFetch({ [SECTOR_INDEX_URL]: SYNTH_INDEX_HTML });
    await expect(jpxDerivativesInvestorWeeklySpec.resolve(new Date("2026-11-30T03:00:00Z"))).rejects.toThrow(/更新停止/);
    await expect(jpxDerivativesInvestorWeeklySpec.resolve(new Date("2026-09-10T03:00:00Z"))).rejects.toThrow(/実行日 .* より後/);
  });

  it("鮮度の境界: 最終日から 35 日目までは通り、36 日目で throw (実行日は JST で数える)", () => {
    expect(JPX_DERIV_MAX_AGE_DAYS).toBe(35);
    // 2026-09-11 + 35 日 = 2026-10-16 (JST)。UTC 15:00 は JST 翌日 0:00。
    expect(() => assertJpxDerivFresh("t", "2026-09-11", new Date("2026-10-16T14:59:00Z"))).not.toThrow();
    expect(() => assertJpxDerivFresh("t", "2026-09-11", new Date("2026-10-16T15:00:00Z"))).toThrow(/36 日前/);
  });

  it("futures-oi: 索引 JSON → 最新基準日の xlsx でキーを決め、fetch() は追加の取得なしで同じバイト列を返す", async () => {
    const xlsx = synthOiXlsx(OI_PRODUCTS);
    const calls = stubFetch(oiIndexRoutes(xlsx));
    const resolved = await jpxDerivativesInvestorFuturesOiSpec.resolve(FETCHED_AT);
    expect(resolved.key).toBe(OI_KEY);
    const batch = await resolved.fetch();
    expect(calls).toHaveLength(3);
    expect(batch.key).toBe(OI_KEY);
    expect(batch.source).toBe(`https://www.jpx.co.jp${OI_XLSX_PATH}`);
    expect(batch.files.map((f) => f.filename)).toEqual([OI_FILENAME]);
    expect(sameBytes(batch.files[0]?.bytes, xlsx)).toBe(true);
    expect(jpxDerivativesInvestorFuturesOiSpec.toObservations({ key: batch.key, files: batch.files })).toHaveLength(24);
  });

  it("futures-oi: 様式が変わった xlsx でも resolve()/fetch() は解析せずに原本を返し (先に保管させる)、解析の失敗は toObservations() で throw する", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["指数先物取引参加者別建玉残高（新様式）"]]), "Sheet1");
    const changed = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    stubFetch(oiIndexRoutes(changed));
    const resolved = await jpxDerivativesInvestorFuturesOiSpec.resolve(FETCHED_AT);
    expect(resolved.key).toBe(OI_KEY);
    const batch = await resolved.fetch();
    expect(batch.files.map((f) => [f.filename, f.contentType])).toEqual([
      [OI_FILENAME, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ]);
    expect(sameBytes(batch.files[0]?.bytes, changed)).toBe(true);
    expect(batch.metadata).toMatchObject({ tradeDate: "2026-09-18", xlsxUrl: `https://www.jpx.co.jp${OI_XLSX_PATH}` });
    expect(() => jpxDerivativesInvestorFuturesOiSpec.toObservations({ key: batch.key, files: batch.files })).toThrow(
      /タイトル行が想定と異なります/
    );
  });

  it("futures-oi: 最新基準日が古すぎれば throw", async () => {
    stubFetch(oiIndexRoutes(synthOiXlsx(OI_PRODUCTS)));
    await expect(jpxDerivativesInvestorFuturesOiSpec.resolve(new Date("2026-12-01T03:00:00Z"))).rejects.toThrow(/更新停止/);
  });

  it("キーは spec 名 + 期間終了日の ISO 週", () => {
    expect(jpxDerivBatchKey(JPX_DERIV_WEEKLY_SPEC_NAME, "2026-09-11")).toBe(WEEKLY_KEY);
    expect(jpxDerivBatchKey(JPX_DERIV_FUTURES_OI_SPEC_NAME, "2026-09-18")).toBe(OI_KEY);
    expect(jpxDerivBatchKey(JPX_DERIV_WEEKLY_SPEC_NAME, "2027-01-01")).toBe("jpx-derivatives-investor-weekly-2026-W53");
  });
});

// ---------------------------------------------------------------------------
// 2/4. 実ファイル (private/。無い環境では skip)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_INDEX)("実ファイル: 一覧ページ (2026-09-27 取得)", () => {
  it("resolve() は実際の一覧ページから 2026-09-07〜09-11 週 (2026-W37) を選び、残存するサンプルリンク (2026-04-17) を選ばない", async () => {
    // CSV 本体は合成テストデータ (実 CSV の有無に依存させない)
    const calls = stubFetch({ [SECTOR_INDEX_URL]: readBytes(REAL_INDEX), [REAL_CSV_URL]: encodeCsv(synthCsvLines()) });
    const resolved = await jpxDerivativesInvestorWeeklySpec.resolve(FETCHED_AT);
    expect(resolved.key).toBe(WEEKLY_KEY);
    const batch = await resolved.fetch();
    expect(batch.key).toBe(WEEKLY_KEY);
    expect(calls[calls.length - 1]).toBe(REAL_CSV_URL);
    expect(batch.metadata).toMatchObject({ periodFrom: "2026-09-07", periodTo: "2026-09-11", csvUrl: REAL_CSV_URL });
  });
});

describe.skipIf(!HAS_CSV)("実ファイル: 投資部門別取引状況 CSV (2026-09-07〜09-11 週)", () => {
  const drafts = HAS_CSV
    ? jpxDerivativesInvestorWeeklySpec.toObservations({ key: WEEKLY_KEY, files: weeklyFiles(readBytes(REAL_CSV)) })
    : [];

  it("検証を通り、484 行 (固定 11 商品 × 11 投資部門 × 4 指標) で目安に収まる", () => {
    expect(() => validateDrafts(JPX_DERIV_WEEKLY_SPEC_NAME, drafts, JPX_DERIV_WEEKLY_INDICATORS)).not.toThrow();
    expect(drafts).toHaveLength(484);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    expect(drafts[0]).toMatchObject({ period: "2026-W37", periodStart: "2026-09-07", periodEnd: "2026-09-11" });
  });

  it("既知値 (原本から独立に読んだ値): 日経225先物の自己・海外投資家 (数量=枚) と個人 (代金=円、換算係数 1)", () => {
    // 自己・数量: 売161,521 / 買153,856 / 合計315,377 / 差引 −7,665
    expect(find(drafts, JPX_DERIV_NET_VOLUME_KEY, "日経225先物 / 自己")).toMatchObject({ value: -7665, unit: "枚" });
    expect(find(drafts, JPX_DERIV_GROSS_VOLUME_KEY, "日経225先物 / 自己")).toMatchObject({ value: 315377, unit: "枚" });
    // 海外投資家・数量: 売351,234 / 買359,577 / 合計710,811 / 差引 +8,343
    expect(find(drafts, JPX_DERIV_NET_VOLUME_KEY, "日経225先物 / 海外投資家")).toMatchObject({ value: 8343, unit: "枚" });
    expect(find(drafts, JPX_DERIV_GROSS_VOLUME_KEY, "日経225先物 / 海外投資家")).toMatchObject({ value: 710811, unit: "枚" });
    // 個人・代金 (円): 売986,745,217,800 / 買1,035,027,202,700 → 差引 +48,281,984,900 / 合計 2,021,772,420,500
    expect(find(drafts, JPX_DERIV_NET_VALUE_KEY, "日経225先物 / 個人")).toMatchObject({ value: 48_281_984_900, unit: "円" });
    expect(find(drafts, JPX_DERIV_GROSS_VALUE_KEY, "日経225先物 / 個人")).toMatchObject({ value: 2_021_772_420_500, unit: "円" });
  });

  it.skipIf(!HAS_INDEX)("resolve()/fetch() (実一覧 + 実 CSV をスタブで配信) → 同じキー・同じバイト列・同じ観測行", async () => {
    const csv = readBytes(REAL_CSV);
    stubFetch({ [SECTOR_INDEX_URL]: readBytes(REAL_INDEX), [REAL_CSV_URL]: csv });
    const resolved = await jpxDerivativesInvestorWeeklySpec.resolve(FETCHED_AT);
    const batch = await resolved.fetch();
    expect([resolved.key, batch.key]).toEqual([WEEKLY_KEY, WEEKLY_KEY]);
    expect(batch.files.map((f) => f.filename)).toEqual([WEEKLY_FILENAME]);
    expect(sameBytes(batch.files[0]?.bytes, csv)).toBe(true);
    expect(jpxDerivativesInvestorWeeklySpec.toObservations({ key: batch.key, files: batch.files })).toEqual(drafts);
  });
});

describe.skipIf(!HAS_XLSX)("実ファイル: 指数先物 取引参加者別建玉残高 xlsx (2026-09-18 現在)", () => {
  const drafts = HAS_XLSX
    ? jpxDerivativesInvestorFuturesOiSpec.toObservations({ key: OI_KEY, files: oiFiles(readBytes(REAL_XLSX)) })
    : [];

  it("検証を通り、3 商品すべてを含み、行数の目安に収まる", () => {
    expect(() => validateDrafts(JPX_DERIV_FUTURES_OI_SPEC_NAME, drafts, JPX_DERIV_FUTURES_OI_INDICATORS)).not.toThrow();
    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    expect(new Set(drafts.map((d) => d.category.split(" / ")[0]))).toEqual(new Set(OI_PRODUCTS));
    expect(drafts[0]).toMatchObject({ period: "2026-W38", periodStart: "2026-09-18", periodEnd: "2026-09-18", unit: "枚" });
  });

  it("既知値 (原本 xlsx の生 XML から独立に読んだ値): 2026年12月限月の売超/買超 1 位", () => {
    expect(find(drafts, JPX_DERIV_FUTURES_OI_KEY, "日経225先物 / 2026-12限月 / 売超1位 / ＨＳＢＣ証券").value).toBe(31500);
    expect(find(drafts, JPX_DERIV_FUTURES_OI_KEY, "日経225先物 / 2026-12限月 / 買超1位 / 野村証券").value).toBe(33866);
    expect(find(drafts, JPX_DERIV_FUTURES_OI_KEY, "TOPIX先物 / 2026-12限月 / 売超1位 / ゴールドマン証券").value).toBe(53241);
    expect(find(drafts, JPX_DERIV_FUTURES_OI_KEY, "TOPIX先物 / 2026-12限月 / 買超1位 / シティグループ証券").value).toBe(63708);
  });

  it("resolve()/fetch() (索引 JSON は合成テストデータ・xlsx は実ファイルをスタブで配信) → 同じキー・同じバイト列", async () => {
    const xlsx = readBytes(REAL_XLSX);
    stubFetch(oiIndexRoutes(xlsx));
    const resolved = await jpxDerivativesInvestorFuturesOiSpec.resolve(FETCHED_AT);
    const batch = await resolved.fetch();
    expect([resolved.key, batch.key]).toEqual([OI_KEY, OI_KEY]);
    expect(batch.files.map((f) => f.filename)).toEqual([OI_FILENAME]);
    expect(sameBytes(batch.files[0]?.bytes, xlsx)).toBe(true);
    expect(jpxDerivativesInvestorFuturesOiSpec.toObservations({ key: batch.key, files: batch.files })).toEqual(drafts);
  });
});
