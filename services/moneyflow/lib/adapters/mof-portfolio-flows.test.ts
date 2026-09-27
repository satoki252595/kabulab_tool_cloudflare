/**
 * mof-portfolio-flows アダプタ (財務省 対外及び対内証券売買契約等の状況: 週次/月次) のテスト。
 *
 * 実ファイル (public/ — 公共データ利用規約 PDL1.0 で出典を明記すれば再配布できるため commit する):
 *   services/moneyflow/lib/sources/fixtures/public/mof-portfolio-flows/
 *     - mof-week.csv     … 2026-09-27 に week.csv を取得した原本 (Shift_JIS のまま。2005-01-02〜2026-09-12 の 1,132 週)
 *     - mof-montha1.csv  … 同日に montha1.csv を取得した原本 (2005-01〜2026-08 + 2026-09〜12 の空欄予定行)
 * 実ファイルのテストは統一のため describe.skipIf で囲む (2 ファイルのどちらかが無い環境では skip)。
 * 期待値は python (csv モジュール + cp932 デコード) で原本のセルを独立に読み、億円→円に換算した値。
 *
 * CI で必ず走るテストは、原本の様式 (列の並び・期間欄の書式・Shift_JIS) だけを真似て
 * テスト内で組み立てた **合成テストデータ** の CSV を使う (財務省の実データではない)。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMoneyflowFlowType,
  isMoneyflowFrequency,
  isMoneyflowLicense,
  isMoneyflowRequirement,
} from "../../../../src/shared/notion-archive/moneyflow.js";
import { validateDrafts, type MoneyflowSourceSpec, type ObservationDraft, type SpecFile } from "../source-spec.js";
import {
  MOF_PORTFOLIO_FLOWS_INDEX_URL,
  MOF_PORTFOLIO_FLOWS_MONTHLY_URL,
  MOF_PORTFOLIO_FLOWS_WEEKLY_URL,
} from "../sources/mof-portfolio-flows.js";
import {
  MOF_MONTHLY_WINDOW_MONTHS,
  MOF_PORTFOLIO_FLOWS_MONTHLY_INDICATORS,
  MOF_PORTFOLIO_FLOWS_SPECS,
  MOF_PORTFOLIO_FLOWS_WEEKLY_INDICATORS,
  MOF_WEEKLY_WINDOW_WEEKS,
  mofCategoryInfo,
  mofFileUpdatedOn,
  mofPortfolioFlowsMonthlySpec,
  mofPortfolioFlowsWeeklySpec,
} from "./mof-portfolio-flows.js";

const WEEK_FIXTURE = fileURLToPath(
  new URL("../sources/fixtures/public/mof-portfolio-flows/mof-week.csv", import.meta.url)
);
const MONTH_FIXTURE = fileURLToPath(
  new URL("../sources/fixtures/public/mof-portfolio-flows/mof-montha1.csv", import.meta.url)
);

/** 実ファイルの resolve テストは週次・月次の両方を返すスタブが要る (モジュールが両方を取るため)。 */
const HAVE_FIXTURES = existsSync(WEEK_FIXTURE) && existsSync(MONTH_FIXTURE);

const ROW_BUDGET = 600;
const OKU = 100_000_000;
const OUT = "対外証券投資";
const IN = "対内証券投資";
const EQUITY = "株式・投資ファンド持分";
const LT_BOND = "中長期債";
const ST_BOND = "短期債";
const TOTAL = "合計(株式・投資ファンド持分+中長期債+短期債)";

const readBytes = (path: string): Uint8Array => new Uint8Array(readFileSync(path));

/** バイト列が完全に一致するか (Uint8Array の由来による付随プロパティの差は無視する)。 */
const sameBytes = (a: Uint8Array | undefined, b: Uint8Array): boolean =>
  a !== undefined && Buffer.from(a).equals(Buffer.from(b));

function find(drafts: readonly ObservationDraft[], period: string, indicatorKey: string, category: string): ObservationDraft {
  const hits = drafts.filter((d) => d.period === period && d.indicatorKey === indicatorKey && d.category === category);
  if (hits.length !== 1) throw new Error(`テスト: ${period}|${indicatorKey}|${category} が ${hits.length} 件`);
  return hits[0] as ObservationDraft;
}

function files(key: string, bytes: Uint8Array): SpecFile[] {
  return [{ filename: `${key}.csv`, bytes }];
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
  const all = [...MOF_PORTFOLIO_FLOWS_WEEKLY_INDICATORS, ...MOF_PORTFOLIO_FLOWS_MONTHLY_INDICATORS];

  it("全指標が enum ガードを通り、キーが一意で、出典は https、説明と限界は日本語で空でない", () => {
    expect(all.map((i) => i.key)).toEqual([
      "mof_net_flow_weekly",
      "mof_gross_acquisition_weekly",
      "mof_gross_disposition_weekly",
      "mof_net_flow_monthly",
      "mof_gross_acquisition_monthly",
      "mof_gross_disposition_monthly",
    ]);
    expect(new Set(all.map((i) => i.key)).size).toBe(all.length);
    for (const i of all) {
      expect(isMoneyflowFlowType(i.flowType), i.key).toBe(true);
      expect(isMoneyflowFrequency(i.frequency), i.key).toBe(true);
      expect(isMoneyflowLicense(i.license), i.key).toBe(true);
      expect(isMoneyflowRequirement(i.requirement), i.key).toBe(true);
      expect(new URL(i.sourceUrl).protocol, i.key).toBe("https:");
      expect(i.sourceUrl).toBe(MOF_PORTFOLIO_FLOWS_INDEX_URL);
      for (const text of [i.displayName, i.description, i.limitations]) {
        expect(text.trim().length, i.key).toBeGreaterThan(0);
        expect(text, i.key).toMatch(/[぀-ヿ一-鿿]/);
      }
    }
  });

  it("種別・頻度・利用条件・要件が定義どおりで、符号の向き・単位・フロー/ストックを明記している", () => {
    const byKey = new Map(all.map((i) => [i.key, i]));
    for (const suffix of ["weekly", "monthly"] as const) {
      expect(byKey.get(`mof_net_flow_${suffix}`)?.flowType).toBe("純買い越し");
      expect(byKey.get(`mof_gross_acquisition_${suffix}`)?.flowType).toBe("売買代金");
      expect(byKey.get(`mof_gross_disposition_${suffix}`)?.flowType).toBe("売買代金");
    }
    for (const i of MOF_PORTFOLIO_FLOWS_WEEKLY_INDICATORS) expect(i.frequency).toBe("週次");
    for (const i of MOF_PORTFOLIO_FLOWS_MONTHLY_INDICATORS) expect(i.frequency).toBe("月次");
    for (const i of all) {
      expect(i.license).toBe("attribution-required");
      expect(i.requirement).toBe("R4");
      expect(i.description).toMatch(/単位は円\(原資料の億円を換算\)/);
      // 取得元モジュールの確認済みの注意 (2014年1月の区分変更) を引き継いでいる
      expect(i.limitations).toMatch(/2014年1月/);
      expect(i.limitations).toMatch(/PDL1\.0/);
    }
    const net = byKey.get("mof_net_flow_weekly");
    expect(net?.description).toMatch(/保有残高\(ストック\)ではなく/);
    expect(net?.description).toMatch(/お金の向きは対内と対外で逆/);
    expect(byKey.get("mof_gross_acquisition_monthly")?.description).toMatch(/ネット\)は分からない/);
    expect(byKey.get("mof_net_flow_weekly")?.limitations).toMatch(/直近13週/);
    expect(byKey.get("mof_net_flow_monthly")?.limitations).toMatch(/直近12か月/);
  });

  it("spec 名は規約どおりで、指標は spec ごとに重ならない", () => {
    expect(MOF_PORTFOLIO_FLOWS_SPECS.map((s) => s.name)).toEqual([
      "mof-portfolio-flows-weekly",
      "mof-portfolio-flows-monthly",
    ]);
    for (const s of MOF_PORTFOLIO_FLOWS_SPECS) expect(s.name).toMatch(/^mof-portfolio-flows(-[a-z0-9]+)*$/);
    expect(mofPortfolioFlowsWeeklySpec.indicators).toBe(MOF_PORTFOLIO_FLOWS_WEEKLY_INDICATORS);
    expect(mofPortfolioFlowsMonthlySpec.indicators).toBe(MOF_PORTFOLIO_FLOWS_MONTHLY_INDICATORS);
  });
});

// ---------------------------------------------------------------------------
// 合成テストデータ (財務省の実データではない)。原本の様式だけを真似た小さな CSV。
// ---------------------------------------------------------------------------

/**
 * テスト用の最小 Shift_JIS エンコーダ。ASCII はそのまま 1 バイト、週次の期間欄が使う
 * 全角ピリオド(．)・全角チルダ(～)と、見出しの「最終更新日  令和N年M月D日」・
 * 表の見出し (単位・対外/対内証券投資・区分・取得/処分/ネット) に使う文字だけを
 * cp932 のバイト列にする (下のテストで TextDecoder("shift_jis") との往復を確かめる)。
 */
const SJIS_OVERRIDES: Record<string, readonly number[]> = {
  "．": [0x81, 0x44],
  "～": [0x81, 0x60],
  最: [0x8d, 0xc5],
  終: [0x8f, 0x49],
  更: [0x8d, 0x58],
  新: [0x90, 0x56],
  日: [0x93, 0xfa],
  令: [0x97, 0xdf],
  和: [0x98, 0x61],
  年: [0x94, 0x4e],
  月: [0x8c, 0x8e],
  元: [0x8c, 0xb3],
  単: [0x92, 0x50],
  位: [0x88, 0xca],
  "：": [0x81, 0x46],
  億: [0x89, 0xad],
  円: [0x89, 0x7e],
  対: [0x91, 0xce],
  外: [0x8a, 0x4f],
  証: [0x8f, 0xd8],
  券: [0x8c, 0x94],
  投: [0x93, 0x8a],
  資: [0x8e, 0x91],
  内: [0x93, 0xe0],
  株: [0x8a, 0x94],
  式: [0x8e, 0xae],
  "・": [0x81, 0x45],
  フ: [0x83, 0x74],
  ァ: [0x83, 0x40],
  ン: [0x83, 0x93],
  ド: [0x83, 0x68],
  持: [0x8e, 0x9d],
  分: [0x95, 0xaa],
  中: [0x92, 0x86],
  長: [0x92, 0xb7],
  期: [0x8a, 0xfa],
  債: [0x8d, 0xc2],
  小: [0x8f, 0xac],
  計: [0x8c, 0x76],
  短: [0x92, 0x5a],
  合: [0x8d, 0x87],
  取: [0x8e, 0xe6],
  得: [0x93, 0xbe],
  処: [0x8f, 0x88],
  ネ: [0x83, 0x6c],
  ッ: [0x83, 0x62],
  ト: [0x83, 0x67],
};

const EN_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * 原本と同じ形の見出し 2 行 (和暦の「最終更新日」と英語の「Final Update」)。
 * `en` を渡すと英語側だけ別の日付にできる (食い違いの検知用)。
 */
function headerLines(updatedIso: string, opts: { en?: string; omitEn?: boolean } = {}): string[] {
  const [y, m, d] = updatedIso.split("-").map(Number) as [number, number, number];
  const reiwa = y - 2018;
  const ja = `synthetic test data (not MOF data),,,最終更新日  令和${reiwa === 1 ? "元" : reiwa}年${m}月${d}日,,`;
  const [ey, em, ed] = (opts.en ?? updatedIso).split("-").map(Number) as [number, number, number];
  const en = `synthetic,,,"Final Update  ${EN_MONTHS[em - 1]}  ${ed} , ${ey}",,`;
  return opts.omitEn ? [ja] : [ja, en];
}

/**
 * 原本と同じ並びの表の見出し行 (単位・対外/対内証券投資・区分・取得/処分/ネット)。
 * 取得元モジュールは列位置で値を読むため、この見出しが想定の列に無いと様式変更として throw する。
 * 週次は 1 方向 11 列を列 1 (対外)・列 12 (対内) から、月次は列 3 (対外)・列 14 (対内) から置く
 * (月次の見出し行は第 3 列 (index 2) を空欄にする。原本と同じく、そこが値の行との区別になる)。
 */
const LAYOUT_ASSET_ROW = ["株式・投資ファンド持分", "", "", "中長期債", "", "", "小計", "短期債", "", "", "合計"];
const LAYOUT_METRIC_ROW = ["取得", "処分", "ネット", "取得", "処分", "ネット", "ネット", "取得", "処分", "ネット", "ネット"];

function layoutLines(kind: "weekly" | "monthly"): string[] {
  const [lead, unitAt] = kind === "weekly" ? [1, 19] : [3, 25];
  const width = lead + 22 + 2;
  const row = (cells: Record<number, string>): string =>
    Array.from({ length: width }, (_, i) => cells[i] ?? "").join(",");
  const block = (labels: readonly string[]): Record<number, string> =>
    Object.fromEntries([
      ...labels.map((l, i) => [lead + i, l] as const),
      ...labels.map((l, i) => [lead + 11 + i, l] as const),
    ]);
  return [
    row({ [unitAt]: "単位： 億円" }),
    row({ [kind === "weekly" ? 1 : 0]: "対外証券投資", [kind === "weekly" ? 12 : 14]: "対内証券投資" }),
    row(block(LAYOUT_ASSET_ROW)),
    row(block(LAYOUT_METRIC_ROW)),
  ];
}

function sjisEncode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    const override = SJIS_OVERRIDES[ch];
    if (!override) throw new Error(`テスト: sjisEncode が未対応の文字です: ${ch}`);
    bytes.push(...override);
  }
  return new Uint8Array(bytes);
}

/** 1 方向 11 列のうちネットの列 (株式ネット・中長期債ネット・小計・短期債ネット・合計)。 */
const NET_COLUMNS: ReadonlySet<number> = new Set([2, 5, 6, 9, 10]);

/**
 * 合成テストデータの値 (億円)。期間番号 p・列番号 c (0〜21、対外 0〜10・対内 11〜21) から決める。
 * ネットの列は奇数番目の期間でマイナスにする (符号の扱いを確かめるため)。
 */
function synthValue(p: number, c: number): number {
  const base = (p + 1) * 1000 + c;
  return NET_COLUMNS.has(c % 11) && p % 2 === 1 ? -base : base;
}

/** 原本と同じく、3 桁区切りのカンマを含む値だけ `"..."` で囲む。 */
function csvNumber(v: number): string {
  const s = v.toLocaleString("en-US");
  return s.includes(",") ? `"${s}"` : s;
}

function synthValues(p: number): string[] {
  return Array.from({ length: 22 }, (_, c) => csvNumber(synthValue(p, c)));
}

function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 期間欄 ("2026．9．6～9．12"、年をまたぐ週は "2026．12．27～ 2027．1．2")。 */
function weekCell(start: string, end: string): string {
  const [y1, m1, d1] = start.split("-").map(Number);
  const [y2, m2, d2] = end.split("-").map(Number);
  const tail = y1 === y2 ? `${m2}．${d2}` : ` ${y2}．${m2}．${d2}`;
  return `${y1}．${m1}．${d1}～${tail}`;
}

/**
 * 合成テストデータの週次 CSV。firstStart から count 週 (週の長さ 7 日)。
 * skip に入れた番号の週は行ごと省く (抜けの検知用)。
 */
function syntheticWeeklyCsv(
  firstStart: string,
  count: number,
  opts: { skip?: number[]; updated?: string; header?: string[] } = {}
): Uint8Array {
  // 最終更新日の既定: 最後の週の最終日 (土曜) の 5 日後 (木曜 = 通常の公表日)
  const updated = opts.updated ?? addDaysIso(firstStart, (count - 1) * 7 + 6 + 5);
  const lines = [...(opts.header ?? headerLines(updated)), ",,,", ...layoutLines("weekly")];
  for (let p = 0; p < count; p += 1) {
    if (opts.skip?.includes(p)) continue;
    const start = addDaysIso(firstStart, p * 7);
    const end = addDaysIso(start, 6);
    lines.push([weekCell(start, end), ...synthValues(p)].join(","));
  }
  lines.push(",,,");
  return sjisEncode(lines.join("\r\n") + "\r\n");
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * 合成テストデータの月次 CSV (ASCII のみ)。first ("YYYY-MM") から count か月分の値の行と、
 * その後ろに blankAfter か月分の値が全欄空欄の予定行 (原本の未到来月と同じ形)。
 * blankAt に入れた番号の月は値を全欄空欄にする (公表済みの月の間に空欄がある異常の検知用)。
 */
function syntheticMonthlyCsv(
  first: string,
  count: number,
  opts: { blankAfter?: number; blankAt?: number[]; partialBlankAt?: number; updated?: string } = {}
): Uint8Array {
  const [fy, fm] = first.split("-").map(Number) as [number, number];
  // 最終更新日の既定: 最後の値の月の翌月 8 日
  const nextIndex = fy * 12 + (fm - 1) + count;
  const updated =
    opts.updated ?? `${Math.floor(nextIndex / 12)}-${String((nextIndex % 12) + 1).padStart(2, "0")}-08`;
  const lines = [...headerLines(updated), ",,,", ...layoutLines("monthly")];
  const total = count + (opts.blankAfter ?? 0);
  for (let p = 0; p < total; p += 1) {
    const index = fy * 12 + (fm - 1) + p;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    const yearCell = p === 0 || month === 1 ? String(year) : "";
    const blank = p >= count || (opts.blankAt ?? []).includes(p);
    let values = blank ? Array.from({ length: 24 }, () => "") : [...synthValues(p), "1", "2"];
    if (opts.partialBlankAt === p) values = values.map((v, i) => (i === 4 ? "" : v));
    lines.push([yearCell, "", MONTH_ABBR[month - 1], ...values].join(","));
  }
  lines.push("2025CY total row (synthetic),,,1,2,3");
  return sjisEncode(lines.join("\r\n") + "\r\n");
}

// 14 週 (窓 13 週 + 前期比用 1 週)。最新週は 2026-09-06〜09-12 (ISO 2026-W37)。
const SYN_WEEK_FIRST = "2026-06-07";
const SYN_WEEK_KEY = "mof-portfolio-flows-weekly-2026-W37-updated-2026-09-17";
// 13 か月 (窓 12 か月 + 前期比用 1 か月)。最新月は 2026-08。
const SYN_MONTH_FIRST = "2025-08";
const SYN_MONTH_KEY = "mof-portfolio-flows-monthly-2026-08-updated-2026-09-08";

describe("合成テストデータで観測行への変換 (CI で実行)", () => {
  it("テスト用 Shift_JIS エンコーダは TextDecoder('shift_jis') と往復一致する", () => {
    for (const text of [
      "2026．9．6～9．12",
      "最終更新日  令和8年9月17日",
      "令和元年",
      ...layoutLines("weekly"),
      ...layoutLines("monthly"),
    ]) {
      expect(new TextDecoder("shift_jis").decode(sjisEncode(text))).toBe(text);
    }
  });

  it("週次: 直近13週×22系列を円に換算し、前期比は前の週との差、最後の行は最新週の対内・合計ネット", () => {
    const bytes = syntheticWeeklyCsv(SYN_WEEK_FIRST, MOF_WEEKLY_WINDOW_WEEKS + 1);
    const drafts = mofPortfolioFlowsWeeklySpec.toObservations({ key: SYN_WEEK_KEY, files: files(SYN_WEEK_KEY, bytes) });
    validateDrafts(mofPortfolioFlowsWeeklySpec.name, drafts, mofPortfolioFlowsWeeklySpec.indicators);
    expect(drafts).toHaveLength(MOF_WEEKLY_WINDOW_WEEKS * 22);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);

    // 先頭の週 (2026-06-14〜06-20 = 2026-W25) の最初の行: 対外・株式等の取得
    const firstRow = drafts[0] as ObservationDraft;
    expect(firstRow).toEqual({
      period: "2026-W25",
      periodStart: "2026-06-14",
      periodEnd: "2026-06-20",
      indicatorKey: "mof_gross_acquisition_weekly",
      category: `${OUT} / ${EQUITY}`,
      categoryKind: "資産クラス",
      value: synthValue(1, 0) * OKU,
      unit: "円",
      changeFromPrev: (synthValue(1, 0) - synthValue(0, 0)) * OKU,
      approximate: false,
      measureKind: "実測",
    });
    // 最新週の対内・株式等ネット: 期間番号 13 (奇数 → ネットはマイナス)、列 11+2
    const inEqNet = find(drafts, "2026-W37", "mof_net_flow_weekly", `${IN} / ${EQUITY}`);
    expect(inEqNet.value).toBe(-14_013 * OKU);
    expect(inEqNet.value).toBe(-1_401_300_000_000);
    expect(inEqNet.changeFromPrev).toBe((-14_013 - 13_013) * OKU);
    expect(inEqNet.periodStart).toBe("2026-09-06");
    expect(inEqNet.periodEnd).toBe("2026-09-12");

    const last = drafts[drafts.length - 1] as ObservationDraft;
    expect([last.period, last.indicatorKey, last.category]).toEqual([
      "2026-W37",
      "mof_net_flow_weekly",
      `${IN} / ${TOTAL}`,
    ]);
    // 1 期間の中の並び = 原本の列順 (対外 11 系列 → 対内 11 系列)
    expect(drafts.slice(0, 11).map((d) => [d.indicatorKey.replace(/_weekly$/, ""), d.category])).toEqual([
      ["mof_gross_acquisition", `${OUT} / ${EQUITY}`],
      ["mof_gross_disposition", `${OUT} / ${EQUITY}`],
      ["mof_net_flow", `${OUT} / ${EQUITY}`],
      ["mof_gross_acquisition", `${OUT} / ${LT_BOND}`],
      ["mof_gross_disposition", `${OUT} / ${LT_BOND}`],
      ["mof_net_flow", `${OUT} / ${LT_BOND}`],
      ["mof_net_flow", `${OUT} / 小計(株式・投資ファンド持分+中長期債)`],
      ["mof_gross_acquisition", `${OUT} / ${ST_BOND}`],
      ["mof_gross_disposition", `${OUT} / ${ST_BOND}`],
      ["mof_net_flow", `${OUT} / ${ST_BOND}`],
      ["mof_net_flow", `${OUT} / ${TOTAL}`],
    ]);
    // 出す指標 = spec の指標定義 (過不足なし)
    expect(new Set(drafts.map((d) => d.indicatorKey))).toEqual(
      new Set(mofPortfolioFlowsWeeklySpec.indicators.map((i) => i.key))
    );
    expect(new Set(drafts.map((d) => d.period)).size).toBe(MOF_WEEKLY_WINDOW_WEEKS);
  });

  it("週次: 年をまたぐ週 (終了年を明記) は ISO 週 2026-W53 になり、集計期間は日曜〜土曜のまま", () => {
    // 2026-10-11 から 14 週 → 最新週は 2027-01-10〜01-16 (ISO 2027-W02)
    const bytes = syntheticWeeklyCsv("2026-10-11", MOF_WEEKLY_WINDOW_WEEKS + 1);
    const key = "mof-portfolio-flows-weekly-2027-W02-updated-2027-01-21";
    const drafts = mofPortfolioFlowsWeeklySpec.toObservations({ key, files: files(key, bytes) });
    validateDrafts(mofPortfolioFlowsWeeklySpec.name, drafts, mofPortfolioFlowsWeeklySpec.indicators);
    const crossing = find(drafts, "2026-W53", "mof_net_flow_weekly", `${IN} / ${TOTAL}`);
    expect([crossing.periodStart, crossing.periodEnd]).toEqual(["2026-12-27", "2027-01-02"]);
    expect(find(drafts, "2027-W01", "mof_net_flow_weekly", `${IN} / ${TOTAL}`).periodStart).toBe("2027-01-03");
  });

  it("月次: 直近12か月×22系列、空欄の予定行と暦年集計行は出さない、最後の行は最新月の対内・合計ネット", () => {
    const bytes = syntheticMonthlyCsv(SYN_MONTH_FIRST, MOF_MONTHLY_WINDOW_MONTHS + 1, { blankAfter: 4 });
    const drafts = mofPortfolioFlowsMonthlySpec.toObservations({ key: SYN_MONTH_KEY, files: files(SYN_MONTH_KEY, bytes) });
    validateDrafts(mofPortfolioFlowsMonthlySpec.name, drafts, mofPortfolioFlowsMonthlySpec.indicators);
    expect(drafts).toHaveLength(MOF_MONTHLY_WINDOW_MONTHS * 22);
    const periods = [...new Set(drafts.map((d) => d.period))];
    expect(periods[0]).toBe("2025-09");
    expect(periods[periods.length - 1]).toBe("2026-08");
    expect(periods).toHaveLength(12);
    const feb = find(drafts, "2026-02", "mof_gross_disposition_monthly", `${OUT} / ${ST_BOND}`);
    // 2026-02 は期間番号 6、対外・短期債処分は列 8
    expect(feb.value).toBe(synthValue(6, 8) * OKU);
    expect([feb.periodStart, feb.periodEnd]).toEqual(["2026-02-01", "2026-02-28"]);
    const last = drafts[drafts.length - 1] as ObservationDraft;
    expect([last.period, last.indicatorKey, last.category]).toEqual([
      "2026-08",
      "mof_net_flow_monthly",
      `${IN} / ${TOTAL}`,
    ]);
    // 期間番号 12 (偶数 → プラス)、列 21。前月 (番号 11、奇数 → マイナス) との差
    expect(last.value).toBe(13_021 * OKU);
    expect(last.changeFromPrev).toBe((13_021 - -12_021) * OKU);
    expect(new Set(drafts.map((d) => d.indicatorKey))).toEqual(
      new Set(mofPortfolioFlowsMonthlySpec.indicators.map((i) => i.key))
    );
  });
});

// ---------------------------------------------------------------------------
// 想定外の入力は throw する (CI で実行)
// ---------------------------------------------------------------------------

describe("想定外の入力は throw する", () => {
  const weekly = syntheticWeeklyCsv(SYN_WEEK_FIRST, MOF_WEEKLY_WINDOW_WEEKS + 1);

  it("ファイルが無い・名前が違う・2 件ある", () => {
    const spec = mofPortfolioFlowsWeeklySpec;
    expect(() => spec.toObservations({ key: SYN_WEEK_KEY, files: [] })).toThrow(/該当ファイルが 0 件/);
    expect(() =>
      spec.toObservations({ key: SYN_WEEK_KEY, files: [{ filename: "week.csv", bytes: weekly }] })
    ).toThrow(/該当ファイルが 0 件/);
    expect(() =>
      spec.toObservations({ key: SYN_WEEK_KEY, files: [...files(SYN_WEEK_KEY, weekly), ...files(SYN_WEEK_KEY, weekly)] })
    ).toThrow(/該当ファイルが 2 件/);
  });

  it("キーの形式が不正・実在しない週/月、キーの期間とファイルの最新期間が違う", () => {
    const spec = mofPortfolioFlowsWeeklySpec;
    for (const bad of [
      "mof-portfolio-flows-weekly-2026-37-updated-2026-09-17",
      "mof-portfolio-flows-2026-W37-updated-2026-09-17",
      "mof-portfolio-flows-weekly-2026-W37-updated-2026-09-17-x",
      // 版 (最終更新日) の無い旧形式のキーは受け付けない
      "mof-portfolio-flows-weekly-2026-W37",
    ]) {
      expect(() => spec.toObservations({ key: bad, files: files(bad, weekly) }), bad).toThrow(/冪等キーの形式が不正/);
    }
    const noWeek53 = "mof-portfolio-flows-weekly-2025-W53-updated-2026-09-17";
    expect(() => spec.toObservations({ key: noWeek53, files: files(noWeek53, weekly) })).toThrow(/存在しません/);
    const older = "mof-portfolio-flows-weekly-2026-W36-updated-2026-09-17";
    expect(() => spec.toObservations({ key: older, files: files(older, weekly) })).toThrow(/一致しません/);
    const badMonth = "mof-portfolio-flows-monthly-2026-13-updated-2026-09-08";
    const monthly = syntheticMonthlyCsv(SYN_MONTH_FIRST, MOF_MONTHLY_WINDOW_MONTHS + 1);
    expect(() => mofPortfolioFlowsMonthlySpec.toObservations({ key: badMonth, files: files(badMonth, monthly) })).toThrow(
      /月が不正/
    );
    const badDate = "mof-portfolio-flows-weekly-2026-W37-updated-2026-02-30";
    expect(() => spec.toObservations({ key: badDate, files: files(badDate, weekly) })).toThrow(/YYYY-MM-DD ではありません/);
  });

  it("版: キーの最終更新日とファイル見出しの最終更新日が違えば throw (同じ期間の差し替えを取り違えない)", () => {
    const spec = mofPortfolioFlowsWeeklySpec;
    const otherVersion = "mof-portfolio-flows-weekly-2026-W37-updated-2026-09-18";
    expect(() => spec.toObservations({ key: otherVersion, files: files(otherVersion, weekly) })).toThrow(
      /版 \(最終更新日 2026-09-18\) とファイルの最終更新日 2026-09-17 が一致しません/
    );
    // 同じ最新週のまま差し替えられたファイル (最終更新日だけ違う) は別の版のキーになる
    const corrected = syntheticWeeklyCsv(SYN_WEEK_FIRST, MOF_WEEKLY_WINDOW_WEEKS + 1, { updated: "2026-09-18" });
    const drafts = spec.toObservations({ key: otherVersion, files: files(otherVersion, corrected) });
    expect(drafts).toHaveLength(286);
  });

  it("見出しの最終更新日: 和暦・英語の両方を読み、無い・食い違う・期間の終了日以前なら throw", () => {
    expect(mofFileUpdatedOn(sjisEncode(headerLines("2026-09-17").join("\r\n")), "[t]")).toBe("2026-09-17");
    expect(mofFileUpdatedOn(sjisEncode(headerLines("2019-05-07").join("\r\n")), "[t]")).toBe("2019-05-07"); // 令和元年
    expect(() => mofFileUpdatedOn(sjisEncode(headerLines("2026-09-17", { omitEn: true }).join("\r\n")), "[t]")).toThrow(
      /最終更新日が読めません/
    );
    expect(() =>
      mofFileUpdatedOn(sjisEncode(headerLines("2026-09-17", { en: "2026-09-18" }).join("\r\n")), "[t]")
    ).toThrow(/食い違います/);
    expect(() => mofFileUpdatedOn(sjisEncode("synthetic,,,\r\n"), "[t]")).toThrow(/最終更新日が読めません/);
    // 最終更新日 2026-09-12 = 最新週の最終日 (その週の値はまだ公表できない)
    const early = syntheticWeeklyCsv(SYN_WEEK_FIRST, MOF_WEEKLY_WINDOW_WEEKS + 1, { updated: "2026-09-12" });
    const earlyKey = "mof-portfolio-flows-weekly-2026-W37-updated-2026-09-12";
    expect(() => mofPortfolioFlowsWeeklySpec.toObservations({ key: earlyKey, files: files(earlyKey, early) })).toThrow(
      /終了日以前/
    );
  });

  it("未知の方向・資産区分", () => {
    expect(mofCategoryInfo("inward", "equity")).toEqual({ label: `${IN} / ${EQUITY}`, kind: "資産クラス" });
    expect(() => mofCategoryInfo("sideways", "equity")).toThrow(/未知の方向/);
    expect(() => mofCategoryInfo("inward", "crypto")).toThrow(/未知の資産区分/);
  });

  it("週の抜け・期間の不足・日曜始まりでない週", () => {
    const spec = mofPortfolioFlowsWeeklySpec;
    const gap = syntheticWeeklyCsv(SYN_WEEK_FIRST, MOF_WEEKLY_WINDOW_WEEKS + 2, { skip: [5] });
    const gapKey = "mof-portfolio-flows-weekly-2026-W38-updated-2026-09-24";
    expect(() => spec.toObservations({ key: gapKey, files: files(gapKey, gap) })).toThrow(/連続していません/);
    const short = syntheticWeeklyCsv("2026-06-14", MOF_WEEKLY_WINDOW_WEEKS);
    expect(() => spec.toObservations({ key: SYN_WEEK_KEY, files: files(SYN_WEEK_KEY, short) })).toThrow(
      /公表済みの期間が 13 件しかありません/
    );
    // 月曜始まりの 7 日間 (2026-09-07〜09-13) が最新週 → 様式変更として throw
    const monday = syntheticWeeklyCsv("2026-06-08", MOF_WEEKLY_WINDOW_WEEKS + 1);
    expect(() => spec.toObservations({ key: SYN_WEEK_KEY, files: files(SYN_WEEK_KEY, monday) })).toThrow(/日曜〜土曜/);
  });

  it("月次: 公表済みの月の間に全欄空欄の月がある・一部だけ空欄の行がある", () => {
    const spec = mofPortfolioFlowsMonthlySpec;
    const hole = syntheticMonthlyCsv(SYN_MONTH_FIRST, MOF_MONTHLY_WINDOW_MONTHS + 1, { blankAt: [7] });
    expect(() => spec.toObservations({ key: SYN_MONTH_KEY, files: files(SYN_MONTH_KEY, hole) })).toThrow(/全欄空欄/);
    const partial = syntheticMonthlyCsv(SYN_MONTH_FIRST, MOF_MONTHLY_WINDOW_MONTHS + 1, { partialBlankAt: 3 });
    expect(() => spec.toObservations({ key: SYN_MONTH_KEY, files: files(SYN_MONTH_KEY, partial) })).toThrow(
      /一部だけ空欄/
    );
  });
});

// ---------------------------------------------------------------------------
// resolve / fetch (合成テストデータ・CI で実行)
// ---------------------------------------------------------------------------

describe("resolve/fetch (fetch をスタブ・合成テストデータ)", () => {
  const weekly = syntheticWeeklyCsv(SYN_WEEK_FIRST, MOF_WEEKLY_WINDOW_WEEKS + 1);
  const monthly = syntheticMonthlyCsv(SYN_MONTH_FIRST, MOF_MONTHLY_WINDOW_MONTHS + 1, { blankAfter: 4 });
  const routes = { [MOF_PORTFOLIO_FLOWS_WEEKLY_URL]: weekly, [MOF_PORTFOLIO_FLOWS_MONTHLY_URL]: monthly };
  // 2026-09-27 12:00 JST
  const NOW = new Date("2026-09-27T03:00:00Z");

  async function roundTrip(spec: MoneyflowSourceSpec, expectedKey: string, bytes: Uint8Array, url: string) {
    const fetchFn = stubFetch(routes);
    const resolved = await spec.resolve(NOW);
    expect(resolved.key).toBe(expectedKey);
    // モジュールの取得関数は週次・月次を 1 回ずつ取る (1 ファイルだけ取る関数が無い)
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const batch = await resolved.fetch();
    expect(fetchFn).toHaveBeenCalledTimes(2); // fetch() は取り直さない
    expect(batch.key).toBe(expectedKey);
    expect(batch.source).toBe(url);
    expect(batch.files).toHaveLength(1);
    expect(batch.files[0]?.filename).toBe(`${expectedKey}.csv`);
    expect(batch.files[0]?.contentType).toBe("text/csv");
    expect(sameBytes(batch.files[0]?.bytes, bytes)).toBe(true);
    const drafts = spec.toObservations({ key: batch.key, files: batch.files });
    validateDrafts(spec.name, drafts, spec.indicators);
    return drafts;
  }

  it("週次: キー = 最新週の ISO 週、fetch() は同じバイト列を安定したファイル名で返す", async () => {
    const drafts = await roundTrip(mofPortfolioFlowsWeeklySpec, SYN_WEEK_KEY, weekly, MOF_PORTFOLIO_FLOWS_WEEKLY_URL);
    expect(drafts).toHaveLength(286);
  });

  it("月次: キー = 最新の公表済み月 (空欄の予定行は無視)", async () => {
    const drafts = await roundTrip(mofPortfolioFlowsMonthlySpec, SYN_MONTH_KEY, monthly, MOF_PORTFOLIO_FLOWS_MONTHLY_URL);
    expect(drafts).toHaveLength(264);
  });

  it("更新停止・未来の期間は resolve で throw する", async () => {
    stubFetch(routes);
    await expect(mofPortfolioFlowsWeeklySpec.resolve(new Date("2026-11-01T03:00:00Z"))).rejects.toThrow(/更新停止/);
    // 最新週の最終日 (2026-09-12) の当日 (JST) にはまだ公表されない
    await expect(mofPortfolioFlowsWeeklySpec.resolve(new Date("2026-09-12T03:00:00Z"))).rejects.toThrow(/以降です/);
    await expect(mofPortfolioFlowsMonthlySpec.resolve(new Date("2026-12-01T03:00:00Z"))).rejects.toThrow(/更新停止/);
    await expect(mofPortfolioFlowsMonthlySpec.resolve(new Date("2026-08-20T03:00:00Z"))).rejects.toThrow(/以降です/);
    // 境界: 2026-10-17 (最終日の 35 日後) は通り、月次は 2026-11 (3 か月前 = 2026-08) まで通る
    await expect(mofPortfolioFlowsWeeklySpec.resolve(new Date("2026-10-17T03:00:00Z"))).resolves.toMatchObject({
      key: SYN_WEEK_KEY,
    });
    await expect(mofPortfolioFlowsMonthlySpec.resolve(new Date("2026-11-30T03:00:00Z"))).resolves.toMatchObject({
      key: SYN_MONTH_KEY,
    });
    // 最新週は鮮度の範囲内でも、最終更新日 (2026-09-17) が実行日 (2026-09-15 JST) より後なら throw
    await expect(mofPortfolioFlowsWeeklySpec.resolve(new Date("2026-09-15T03:00:00Z"))).rejects.toThrow(
      /最終更新日 2026-09-17 が実行日 2026-09-15/
    );
  });

  it("HTTP エラーは throw する", async () => {
    stubFetch({ [MOF_PORTFOLIO_FLOWS_MONTHLY_URL]: monthly });
    await expect(mofPortfolioFlowsWeeklySpec.resolve(NOW)).rejects.toThrow(/HTTPエラー: 404/);
  });
});

// ---------------------------------------------------------------------------
// 実ファイル (2026-09-27 取得の原本)
// ---------------------------------------------------------------------------

describe.skipIf(!HAVE_FIXTURES)("実ファイル: 週次 week.csv (2026-09-27 取得)", () => {
  const key = "mof-portfolio-flows-weekly-2026-W37-updated-2026-09-17";

  it("見出しの最終更新日 (令和8年9月17日 / September 17, 2026) を版として読む", () => {
    expect(mofFileUpdatedOn(readBytes(WEEK_FIXTURE), "[t]")).toBe("2026-09-17");
  });

  it("最新週 2026-09-06〜09-12 から直近13週を観測行にし、検証を通る (python で独立に読んだ値と一致)", () => {
    const drafts = mofPortfolioFlowsWeeklySpec.toObservations({ key, files: files(key, readBytes(WEEK_FIXTURE)) });
    validateDrafts(mofPortfolioFlowsWeeklySpec.name, drafts, mofPortfolioFlowsWeeklySpec.indicators);
    expect(drafts).toHaveLength(286);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    const periods = [...new Set(drafts.map((d) => d.period))];
    expect(periods[0]).toBe("2026-W25");
    expect(periods[periods.length - 1]).toBe("2026-W37");

    // 2026-09-06〜09-12 対内・株式等ネット -15,228 億円 (前週 +6,896 億円)
    const inEq = find(drafts, "2026-W37", "mof_net_flow_weekly", `${IN} / ${EQUITY}`);
    expect(inEq.value).toBe(-1_522_800_000_000);
    expect(inEq.changeFromPrev).toBe(-2_212_400_000_000);
    expect([inEq.periodStart, inEq.periodEnd]).toEqual(["2026-09-06", "2026-09-12"]);
    // 同週 対外・株式等ネット +1,692 億円
    expect(find(drafts, "2026-W37", "mof_net_flow_weekly", `${OUT} / ${EQUITY}`).value).toBe(169_200_000_000);
    // 同週 対内・合計ネット -4,995 億円
    expect(find(drafts, "2026-W37", "mof_net_flow_weekly", `${IN} / ${TOTAL}`).value).toBe(-499_500_000_000);
    // 同週 対内・株式等取得 381,075 億円
    expect(find(drafts, "2026-W37", "mof_gross_acquisition_weekly", `${IN} / ${EQUITY}`).value).toBe(
      38_107_500_000_000
    );
    // 同週 対内・短期債処分 45,000 億円
    expect(find(drafts, "2026-W37", "mof_gross_disposition_weekly", `${IN} / ${ST_BOND}`).value).toBe(
      4_500_000_000_000
    );
    // 窓の先頭 2026-06-14〜06-20 対外・株式等ネット +4,267 億円 (前週 -4,173 億円 = 窓の外の週)
    const oldest = find(drafts, "2026-W25", "mof_net_flow_weekly", `${OUT} / ${EQUITY}`);
    expect(oldest.value).toBe(426_700_000_000);
    expect(oldest.changeFromPrev).toBe(844_000_000_000);
    expect([oldest.periodStart, oldest.periodEnd]).toEqual(["2026-06-14", "2026-06-20"]);

    // レビュー時に python (csv + cp932) で独立に読んだ別のセル (合計・短期債・中長期債、前期比込み)
    // 2026-09-06〜09-12 対外・合計ネット +14,029 億円 (前週 -2,631 億円)
    const outTotal = find(drafts, "2026-W37", "mof_net_flow_weekly", `${OUT} / ${TOTAL}`);
    expect([outTotal.value, outTotal.changeFromPrev]).toEqual([1_402_900_000_000, 1_666_000_000_000]);
    // 同週 対内・短期債ネット -12,128 億円 (前週 -2,752 億円)、取得 32,871 億円 (前週 27,252 億円)
    const inStNet = find(drafts, "2026-W37", "mof_net_flow_weekly", `${IN} / ${ST_BOND}`);
    expect([inStNet.value, inStNet.changeFromPrev]).toEqual([-1_212_800_000_000, -937_600_000_000]);
    const inStAcq = find(drafts, "2026-W37", "mof_gross_acquisition_weekly", `${IN} / ${ST_BOND}`);
    expect([inStAcq.value, inStAcq.changeFromPrev]).toEqual([3_287_100_000_000, 561_900_000_000]);
    // 同週 対外・中長期債取得 117,497 億円 (前週 126,512 億円)
    const outLtAcq = find(drafts, "2026-W37", "mof_gross_acquisition_weekly", `${OUT} / ${LT_BOND}`);
    expect([outLtAcq.value, outLtAcq.changeFromPrev]).toEqual([11_749_700_000_000, -901_500_000_000]);
    // 2026-08-09〜08-15 (2026-W33) 対内・合計ネット -17,925 億円 (前週 -2,091 億円)
    const w33 = find(drafts, "2026-W33", "mof_net_flow_weekly", `${IN} / ${TOTAL}`);
    expect([w33.periodStart, w33.periodEnd, w33.value, w33.changeFromPrev]).toEqual([
      "2026-08-09",
      "2026-08-15",
      -1_792_500_000_000,
      -1_583_400_000_000,
    ]);
  });

  it("resolve/fetch (fetch スタブが実ファイルを返す) → キー 2026-W37、同じバイト列、観測行 286 行", async () => {
    const weekBytes = readBytes(WEEK_FIXTURE);
    const monthBytes = readBytes(MONTH_FIXTURE);
    stubFetch({ [MOF_PORTFOLIO_FLOWS_WEEKLY_URL]: weekBytes, [MOF_PORTFOLIO_FLOWS_MONTHLY_URL]: monthBytes });
    const resolved = await mofPortfolioFlowsWeeklySpec.resolve(new Date("2026-09-27T03:00:00Z"));
    expect(resolved.key).toBe(key);
    const batch = await resolved.fetch();
    expect(batch.key).toBe(key);
    expect(batch.files.map((f) => f.filename)).toEqual([`${key}.csv`]);
    expect(sameBytes(batch.files[0]?.bytes, weekBytes)).toBe(true);
    expect(batch.metadata).toMatchObject({
      latestPeriod: "2026-W37",
      latestPeriodStart: "2026-09-06",
      latestPeriodEnd: "2026-09-12",
      fileUpdatedOn: "2026-09-17",
      unpublishedPeriods: [],
    });
    const drafts = mofPortfolioFlowsWeeklySpec.toObservations({ key: batch.key, files: batch.files });
    expect(drafts).toHaveLength(286);
  });
});

describe.skipIf(!HAVE_FIXTURES)("実ファイル: 月次 montha1.csv (2026-09-27 取得)", () => {
  const key = "mof-portfolio-flows-monthly-2026-08-updated-2026-09-08";

  it("見出しの最終更新日 (令和8年9月8日 / September 8, 2026) を版として読む", () => {
    expect(mofFileUpdatedOn(readBytes(MONTH_FIXTURE), "[t]")).toBe("2026-09-08");
  });

  it("最新月 2026-08 から直近12か月を観測行にし、検証を通る (python で独立に読んだ値と一致)", () => {
    const drafts = mofPortfolioFlowsMonthlySpec.toObservations({ key, files: files(key, readBytes(MONTH_FIXTURE)) });
    validateDrafts(mofPortfolioFlowsMonthlySpec.name, drafts, mofPortfolioFlowsMonthlySpec.indicators);
    expect(drafts).toHaveLength(264);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    const periods = [...new Set(drafts.map((d) => d.period))];
    expect(periods[0]).toBe("2025-09");
    expect(periods[periods.length - 1]).toBe("2026-08");
    // 空欄の予定行 (2026-09〜12) は出さない
    expect(drafts.some((d) => d.period >= "2026-09")).toBe(false);

    // 2026-08 対外・株式等ネット +12,983 億円 (前月 +1,695 億円)
    const outEq = find(drafts, "2026-08", "mof_net_flow_monthly", `${OUT} / ${EQUITY}`);
    expect(outEq.value).toBe(1_298_300_000_000);
    expect(outEq.changeFromPrev).toBe(1_128_800_000_000);
    expect([outEq.periodStart, outEq.periodEnd]).toEqual(["2026-08-01", "2026-08-31"]);
    // 同月 対内・中長期債ネット -6,841 億円
    expect(find(drafts, "2026-08", "mof_net_flow_monthly", `${IN} / ${LT_BOND}`).value).toBe(-684_100_000_000);
    // 同月 対内・合計ネット -58,239 億円
    expect(find(drafts, "2026-08", "mof_net_flow_monthly", `${IN} / ${TOTAL}`).value).toBe(-5_823_900_000_000);
    // 同月 対内・株式等取得 1,599,653 億円
    expect(find(drafts, "2026-08", "mof_gross_acquisition_monthly", `${IN} / ${EQUITY}`).value).toBe(
      159_965_300_000_000
    );
    // 2026-01 対外・株式等ネット +6,020 億円
    expect(find(drafts, "2026-01", "mof_net_flow_monthly", `${OUT} / ${EQUITY}`).value).toBe(602_000_000_000);
    // 窓の先頭 2025-09 対外・株式等ネット +2,676 億円 (前月 2025-08 は -868 億円 = 窓の外の月)
    const oldest = find(drafts, "2025-09", "mof_net_flow_monthly", `${OUT} / ${EQUITY}`);
    expect(oldest.value).toBe(267_600_000_000);
    expect(oldest.changeFromPrev).toBe(354_400_000_000);

    // レビュー時に python (csv + cp932) で独立に読んだ別のセル
    // 2026-08 対外・合計ネット +1,366 億円 (前月 +13,605 億円)
    const outTotal = find(drafts, "2026-08", "mof_net_flow_monthly", `${OUT} / ${TOTAL}`);
    expect([outTotal.value, outTotal.changeFromPrev]).toEqual([136_600_000_000, -1_223_900_000_000]);
    // 同月 対内・小計ネット -8,581 億円 (前月 -184 億円)
    const inSub = find(drafts, "2026-08", "mof_net_flow_monthly", `${IN} / 小計(株式・投資ファンド持分+中長期債)`);
    expect([inSub.value, inSub.changeFromPrev]).toEqual([-858_100_000_000, -839_700_000_000]);
    // 2026-03 対内・合計ネット -126,554 億円 (前月 +76,096 億円。窓の中で最小)
    const mar = find(drafts, "2026-03", "mof_net_flow_monthly", `${IN} / ${TOTAL}`);
    expect([mar.periodStart, mar.periodEnd, mar.value, mar.changeFromPrev]).toEqual([
      "2026-03-01",
      "2026-03-31",
      -12_655_400_000_000,
      -20_265_000_000_000,
    ]);
    // 2025-09 対内・短期債ネット -30,104 億円 (前月 2025-08 は +11,232 億円 = 窓の外)
    const sep = find(drafts, "2025-09", "mof_net_flow_monthly", `${IN} / ${ST_BOND}`);
    expect([sep.value, sep.changeFromPrev]).toEqual([-3_010_400_000_000, -4_133_600_000_000]);
    // 2025-12 対外・短期債処分 36,779 億円 (前月 33,393 億円)
    const dec = find(drafts, "2025-12", "mof_gross_disposition_monthly", `${OUT} / ${ST_BOND}`);
    expect([dec.value, dec.changeFromPrev]).toEqual([3_677_900_000_000, 338_600_000_000]);
  });

  it("resolve/fetch (fetch スタブが実ファイルを返す) → キー 2026-08、同じバイト列、観測行 264 行", async () => {
    const monthBytes = readBytes(MONTH_FIXTURE);
    const weekBytes = readBytes(WEEK_FIXTURE);
    stubFetch({ [MOF_PORTFOLIO_FLOWS_WEEKLY_URL]: weekBytes, [MOF_PORTFOLIO_FLOWS_MONTHLY_URL]: monthBytes });
    const resolved = await mofPortfolioFlowsMonthlySpec.resolve(new Date("2026-09-27T03:00:00Z"));
    expect(resolved.key).toBe(key);
    const batch = await resolved.fetch();
    expect(batch.key).toBe(key);
    expect(batch.files.map((f) => f.filename)).toEqual([`${key}.csv`]);
    expect(sameBytes(batch.files[0]?.bytes, monthBytes)).toBe(true);
    expect(batch.metadata).toMatchObject({
      latestPeriod: "2026-08",
      fileUpdatedOn: "2026-09-08",
      unpublishedPeriods: ["2026-09", "2026-10", "2026-11", "2026-12"],
    });
    const drafts = mofPortfolioFlowsMonthlySpec.toObservations({ key: batch.key, files: batch.files });
    expect(drafts).toHaveLength(264);
  });
});
