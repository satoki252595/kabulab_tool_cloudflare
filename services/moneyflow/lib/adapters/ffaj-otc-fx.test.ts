/**
 * ffaj-otc-fx アダプタ (FFAJ 店頭FX月次速報) のテスト。
 *
 * 実ファイル (private/ — 利用条件要確認のため commit しない) は
 * `services/moneyflow/lib/sources/fixtures/private/ffaj-otc-fx/` に置く (2026-09-27 取得、2026年8月分・
 * 資料室ページ更新日 2026-09-14):
 *   - ffaj-index-2026-09-27.html            … https://www.ffaj.or.jp/library/performance/fx_flash/
 *   - ffaj-trading_vol_and_position.xls     … https://www.ffaj.or.jp/wp-content/uploads/2026/09/trading_vol_and_position.xls
 *   - ffaj-open_position_with_mc.xls        … https://www.ffaj.or.jp/wp-content/uploads/2026/09/open_position_with_mc.xls
 *   - ffaj-deposit_amount_information.xls   … https://www.ffaj.or.jp/wp-content/uploads/2026/09/deposit_amount_information.xls
 * 置いていない環境 (CI) では実ファイルのテストを describe.skipIf で skip する。
 * 期待値は python (xlrd) で原本 xls のセルを独立に読み、百万円→円に換算した値。
 *
 * CI でも走るテストは、原本 xls の配置 (見出し行・単位表示行・データ開始行) だけを真似て
 * テスト内で SheetJS により組み立てた **合成テストデータ** を使う (実データではない。数値も架空)。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMoneyflowFlowType,
  isMoneyflowFrequency,
  isMoneyflowLicense,
  isMoneyflowRequirement,
} from "../../../../src/shared/notion-archive/moneyflow.js";
import { validateDrafts, type ObservationDraft, type SpecFile } from "../source-spec.js";
import { FFAJ_OTC_FX_INDICATORS, parseFfajOtcFxFiles, type FfajOtcFxParsed } from "../sources/ffaj-otc-fx.js";
import {
  FFAJ_OTC_FX_SPECS,
  FFAJ_OTC_FX_SPEC_INDICATORS,
  FFAJ_OTC_FX_WINDOW_MONTHS,
  assertFfajOtcFxFresh,
  ffajOtcFxFilenames,
  ffajOtcFxParsedToDrafts,
  ffajOtcFxSpec,
  parseFfajOtcFxBatchKey,
} from "./ffaj-otc-fx.js";

const FIXTURE_DIR = fileURLToPath(new URL("../sources/fixtures/private/ffaj-otc-fx/", import.meta.url));
const REAL_INDEX = join(FIXTURE_DIR, "ffaj-index-2026-09-27.html");
const REAL_TRADING = join(FIXTURE_DIR, "ffaj-trading_vol_and_position.xls");
const REAL_OPEN = join(FIXTURE_DIR, "ffaj-open_position_with_mc.xls");
const REAL_DEPOSIT = join(FIXTURE_DIR, "ffaj-deposit_amount_information.xls");
const HAS_REAL = [REAL_INDEX, REAL_TRADING, REAL_OPEN, REAL_DEPOSIT].every((p) => existsSync(p));

const INDEX_URL = "https://www.ffaj.or.jp/library/performance/fx_flash/";
const REAL_KEY = "ffaj-otc-fx-2026-08-updated-2026-09-14";
const REAL_UPLOAD_DIR = "https://www.ffaj.or.jp/wp-content/uploads/2026/09/";
const ROW_BUDGET = 600;
const MILLION = 1_000_000;
/** 1 か月あたりの行数: 全通貨ペア合計 4 + 通貨別 9 + 預託額情報 3。 */
const ROWS_PER_MONTH = 16;
/** 実ファイル取得日 (2026-09-27 12:00 JST)。 */
const FETCHED_AT = new Date("2026-09-27T03:00:00Z");

const readBytes = (path: string): Uint8Array => new Uint8Array(readFileSync(path));

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
// 合成テストデータ (実データではない): 原本 xls / 資料室ページの配置だけを真似る
// ---------------------------------------------------------------------------

const SYN_LATEST = "2019-11";
const SYN_UPDATED = "2019-12-05";
const SYN_KEY = `ffaj-otc-fx-${SYN_LATEST}-updated-${SYN_UPDATED}`;
const SYN_UPLOAD_DIR = "https://www.ffaj.or.jp/wp-content/uploads/2019/12/";
const SYN_CURRENCIES: ReadonlyArray<[string, string]> = [
  ["日本円", "JPY"],
  ["米ドル", "USD"],
  ["ユーロ", "EUR"],
  ["英ポンド", "GBP"],
  ["オーストラリアドル", "AUD"],
  ["ニュージーランドドル", "NZD"],
  ["スイスフラン", "CHF"],
  ["カナダドル", "CAD"],
  ["南アフリカランド", "ZAR"],
];

/** latest から新しい順に n か月 ([年, 月])。 */
function monthsDesc(latest: string, n: number): Array<[number, number]> {
  const [y0, m0] = latest.split("-").map(Number) as [number, number];
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i += 1) {
    const idx = y0 * 12 + (m0 - 1) - i;
    out.push([Math.floor(idx / 12), (idx % 12) + 1]);
  }
  return out;
}

function toXls(sheetName: string, aoa: unknown[][]): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xls" }) as ArrayBuffer);
}

/** 合成の通し番号 (新しい月ほど大きい) から決まる架空の値。 */
const synVal = (monthIndexFromOldest: number, col: number): number => (monthIndexFromOldest + 1) * 1000 + col;

function syntheticTrading(latest: string, n: number): Uint8Array {
  const aoa: unknown[][] = [["合成テストデータ (実データではない)"], [], [], [], [], [], ["単位: 百万円"], ["Unit: 1million Jpy"]];
  aoa.push(["月\nMonth", "年\nYear", "全通貨ペア合計 Total"]);
  aoa.push(["", "", "取引金額\nTrading Volume", "売建\nShort Positions", "買建\nLong Positions", "建玉計\nTotal Positions"]);
  monthsDesc(latest, n).forEach(([y, m], i) => {
    const k = n - 1 - i;
    aoa.push([m, y, synVal(k, 0), synVal(k, 1), synVal(k, 2), synVal(k, 1) + synVal(k, 2)]);
  });
  return toXls("ALL(TOTAL)", aoa);
}

function syntheticOpenPosition(latest: string, n: number, currencies = SYN_CURRENCIES): Uint8Array {
  const aoa: unknown[][] = [["合成テストデータ (実データではない)"], [], [], [], [], [], ["単位：百万円"], ["Unit: million Yen"]];
  const head: unknown[] = ["月\nMonth", "年\nYear"];
  const sub: unknown[] = ["", ""];
  for (const [ja, code] of currencies) {
    head.push(`${ja}\n${code}`, "", "", "");
    sub.push("取引金額\nTrading Volume", "①売建\nShort Positions", "②買建\nLong Positions", "②-①＝買越額\nNet Long");
  }
  aoa.push(head, sub);
  monthsDesc(latest, n).forEach(([y, m], i) => {
    const k = n - 1 - i;
    const row: unknown[] = [m, y];
    currencies.forEach((_, c) => {
      const short = synVal(k, 10 * c + 1);
      const long = synVal(k, 10 * c + 2);
      row.push(synVal(k, 10 * c), short, long, long - short - 2 * c);
    });
    aoa.push(row);
  });
  return toXls("Data", aoa);
}

function syntheticDeposit(latest: string, n: number, naMonth?: string): Uint8Array {
  const aoa: unknown[][] = [["合成テストデータ (実データではない)"], [], [], [], [], [], []];
  aoa.push(["報告対象年月", "", "顧客区分管理必要額", "", "", "顧客区分管理必要額正味増減額", "④顧客区分管理信託額", "信託保全率"]);
  aoa.push(["Period"]);
  aoa.push(["年", "月", "①当月顧客入金額", "②当月顧客出金額", "③当月末必要額", "=③-前月③-①+②", "（当月末日時点）", "=④/③*100"]);
  aoa.push(["Year"]);
  aoa.push(["", "", "円(Yen)", "円(Yen)", "円(Yen)", "円(Yen)", "円(Yen)", "％"]);
  monthsDesc(latest, n).forEach(([y, m], i) => {
    const k = n - 1 - i;
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    const net = ym === naMonth ? "na" : -synVal(k, 3);
    aoa.push([y, m, synVal(k, 0), synVal(k, 1), synVal(k, 2), net, synVal(k, 4), 101.5]);
  });
  return toXls("DATA", aoa);
}

function syntheticIndexHtml(latest: string, updated: string, uploadDir: string): string {
  const [y, m] = latest.split("-").map(Number) as [number, number];
  const [uy, um, ud] = updated.split("-").map(Number) as [number, number, number];
  return [
    "<!-- 合成テストデータ (実データではない) -->",
    `<p>更新日：${uy}年${um}月${ud}日</p>`,
    `<h2 class="component-header-B01__heading">${y}年${m}月</h2>`,
    `<a href="${uploadDir}trading_vol_and_position.xls">取引状況</a>`,
    `<a href="${uploadDir}open_position_with_mc.xls">主要通貨建玉</a>`,
    `<a href="${uploadDir}deposit_amount_information.xls">預託額情報</a>`,
  ].join("\n");
}

function syntheticFiles(opts: { key?: string; months?: number; naMonth?: string; indexLatest?: string } = {}): SpecFile[] {
  const key = opts.key ?? SYN_KEY;
  const months = opts.months ?? 30;
  const names = ffajOtcFxFilenames(key);
  return [
    {
      filename: names.index,
      bytes: new TextEncoder().encode(syntheticIndexHtml(opts.indexLatest ?? SYN_LATEST, SYN_UPDATED, SYN_UPLOAD_DIR)),
    },
    { filename: names.tradingVolAndPosition, bytes: syntheticTrading(SYN_LATEST, months) },
    { filename: names.openPositionWithMc, bytes: syntheticOpenPosition(SYN_LATEST, months) },
    { filename: names.depositAmountInformation, bytes: syntheticDeposit(SYN_LATEST, months, opts.naMonth) },
  ];
}

// ---------------------------------------------------------------------------
// 1. 指標定義
// ---------------------------------------------------------------------------

describe("ffaj-otc-fx: 指標定義", () => {
  it("全指標が enum ガードを通り、キーが一意で、https の出典と日本語の説明・限界を持つ", () => {
    expect(FFAJ_OTC_FX_SPEC_INDICATORS.length).toBe(FFAJ_OTC_FX_INDICATORS.length);
    const keys = FFAJ_OTC_FX_SPEC_INDICATORS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const def of FFAJ_OTC_FX_SPEC_INDICATORS) {
      expect(isMoneyflowFlowType(def.flowType)).toBe(true);
      expect(isMoneyflowFrequency(def.frequency)).toBe(true);
      expect(isMoneyflowLicense(def.license)).toBe(true);
      expect(isMoneyflowRequirement(def.requirement)).toBe(true);
      expect(def.sourceUrl.startsWith("https://")).toBe(true);
      expect(def.description).toMatch(/[ぁ-んァ-ン一-龥]/);
      expect(def.limitations).toMatch(/[ぁ-んァ-ン一-龥]/);
      expect(def.displayName.trim()).not.toBe("");
      expect(def.license).toBe("要確認");
      expect(def.frequency).toBe("月次");
      expect(def.requirement).toBe("R3");
      expect(def.description).toContain("純流入額");
      expect(def.limitations).toContain(`直近${FFAJ_OTC_FX_WINDOW_MONTHS}か月`);
    }
  });

  it("正味増減額は「損益」、建玉は「建玉」、取引金額は「売買代金」に分類される", () => {
    const byKey = new Map(FFAJ_OTC_FX_SPEC_INDICATORS.map((d) => [d.key, d]));
    expect(byKey.get("ffaj_otc_fx_customer_deposit_net_change")?.flowType).toBe("損益");
    expect(byKey.get("ffaj_otc_fx_turnover")?.flowType).toBe("売買代金");
    expect(byKey.get("ffaj_otc_fx_net_long_position")?.flowType).toBe("建玉");
    expect(byKey.get("ffaj_otc_fx_deposit_trust_balance")?.flowType).toBe("残高");
  });

  it("spec は 1 本で名前は ffaj-otc-fx", () => {
    expect(FFAJ_OTC_FX_SPECS.map((s) => s.name)).toEqual(["ffaj-otc-fx"]);
    expect(ffajOtcFxSpec.indicators).toBe(FFAJ_OTC_FX_SPEC_INDICATORS);
  });
});

// ---------------------------------------------------------------------------
// 3. 合成テストデータによる変換ロジック (CI でも走る)
// ---------------------------------------------------------------------------

describe("ffaj-otc-fx: キー・鮮度 (純関数)", () => {
  it("キーを分解し、形式違いは throw", () => {
    expect(parseFfajOtcFxBatchKey(REAL_KEY)).toEqual({ latestMonth: "2026-08", updatedOn: "2026-09-14" });
    expect(() => parseFfajOtcFxBatchKey("ffaj-otc-fx-2026-08")).toThrow(/形式/);
    expect(() => parseFfajOtcFxBatchKey("ffaj-otc-fx-2026-13-updated-2026-09-14")).toThrow();
  });

  it("最新公表月が実行月以降・3か月より古いと throw", () => {
    expect(() => assertFfajOtcFxFresh("2026-08", FETCHED_AT)).not.toThrow();
    expect(() => assertFfajOtcFxFresh("2026-06", FETCHED_AT)).not.toThrow();
    expect(() => assertFfajOtcFxFresh("2026-09", FETCHED_AT)).toThrow(/以降/);
    expect(() => assertFfajOtcFxFresh("2026-05", FETCHED_AT)).toThrow(/古すぎ/);
  });
});

describe("ffaj-otc-fx: 合成テストデータ → 観測行", () => {
  it("直近24か月 × 16 行を古い順に作り、百万円を円に換算する", () => {
    const drafts = ffajOtcFxSpec.toObservations({ key: SYN_KEY, files: syntheticFiles() });
    validateDrafts(ffajOtcFxSpec.name, drafts, ffajOtcFxSpec.indicators);
    expect(drafts.length).toBe(FFAJ_OTC_FX_WINDOW_MONTHS * ROWS_PER_MONTH);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    expect(drafts[0]?.period).toBe("2017-12");
    const last = drafts[drafts.length - 1] as ObservationDraft;
    expect(last.period).toBe(SYN_LATEST);
    expect(last.indicatorKey).toBe("ffaj_otc_fx_deposit_trust_balance");

    // 合成 30 か月の最新月は通し番号 29 → synVal = 30,000 + 列
    const turnover = find(drafts, SYN_LATEST, "ffaj_otc_fx_turnover", "全通貨ペア合計");
    expect(turnover.value).toBe(30_000 * MILLION);
    expect(turnover.unit).toBe("円");
    expect(turnover.periodStart).toBe("2019-11-01");
    expect(turnover.periodEnd).toBe("2019-11-30");
    expect(turnover.categoryKind).toBe("全体");

    const total = find(drafts, SYN_LATEST, "ffaj_otc_fx_open_position_total", "全通貨ペア合計");
    expect(total.value).toBe((30_001 + 30_002) * MILLION);
    expect(total.periodStart).toBe("2019-11-30");

    // USD は 2 番目の通貨 (c=1): 買越額 = long - short - 2 = 30,012 - 30,011 - 2
    const usd = find(drafts, SYN_LATEST, "ffaj_otc_fx_net_long_position", "米ドル (USD)");
    expect(usd.value).toBe(-1 * MILLION);
    expect(usd.categoryKind).toBe("通貨");

    // 預託額情報は原資料も円 (換算しない)
    const net = find(drafts, SYN_LATEST, "ffaj_otc_fx_customer_deposit_net_change", "報告会員合算");
    expect(net.value).toBe(-30_003);
    expect(net.periodStart).toBe("2019-11-01");
    const trust = find(drafts, SYN_LATEST, "ffaj_otc_fx_deposit_trust_balance", "報告会員合算");
    expect(trust.value).toBe(30_004);
    for (const d of drafts) {
      expect(d.changeFromPrev).toBeNull();
      expect(d.approximate).toBe(true);
      expect(d.measureKind).toBe("実測");
    }
  });

  it("窓の中で正味増減額が \"na\" の月はその 1 行だけ記録しない (0 で埋めない)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const drafts = ffajOtcFxSpec.toObservations({ key: SYN_KEY, files: syntheticFiles({ naMonth: "2019-03" }) });
    // 窓の中の "na" は運用者に見えるよう警告が出る (モジュールの通知経路を残す)
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("2019-03")).length).toBe(1);
    warn.mockRestore();
    validateDrafts(ffajOtcFxSpec.name, drafts, ffajOtcFxSpec.indicators);
    expect(drafts.length).toBe(FFAJ_OTC_FX_WINDOW_MONTHS * ROWS_PER_MONTH - 1);
    expect(
      drafts.some((d) => d.period === "2019-03" && d.indicatorKey === "ffaj_otc_fx_customer_deposit_net_change")
    ).toBe(false);
    expect(find(drafts, "2019-03", "ffaj_otc_fx_deposit_required_balance", "報告会員合算").value).toBeGreaterThan(0);
  });

  it("窓の外 (最古月) の正味増減額 \"na\" は警告を出さず、窓の行数も変わらない", () => {
    // 合成 30 か月の最古月は 2017-06 (窓は 2017-12〜2019-11)
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const drafts = ffajOtcFxSpec.toObservations({ key: SYN_KEY, files: syntheticFiles({ naMonth: "2017-06" }) });
    expect(drafts.length).toBe(FFAJ_OTC_FX_WINDOW_MONTHS * ROWS_PER_MONTH);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 5. 想定外の入力は throw
// ---------------------------------------------------------------------------

describe("ffaj-otc-fx: 想定外の入力", () => {
  it("ファイルが欠けていると throw", () => {
    const files = syntheticFiles().filter((f) => !f.filename.startsWith("ffaj-deposit-amount-information"));
    expect(() => ffajOtcFxSpec.toObservations({ key: SYN_KEY, files })).toThrow(/該当ファイルが 0 件/);
  });

  it("保管した資料室ページの最新公表月がキーと違うと throw", () => {
    expect(() =>
      ffajOtcFxSpec.toObservations({ key: SYN_KEY, files: syntheticFiles({ indexLatest: "2019-10" }) })
    ).toThrow(/一致しません/);
  });

  it("xls の最新月がキーと違うと throw", () => {
    const key = "ffaj-otc-fx-2019-12-updated-2019-12-05";
    const files = syntheticFiles({ key }).map((f) =>
      f.filename.endsWith(".html")
        ? { ...f, bytes: new TextEncoder().encode(syntheticIndexHtml("2019-12", SYN_UPDATED, SYN_UPLOAD_DIR)) }
        : f
    );
    expect(() => ffajOtcFxSpec.toObservations({ key, files })).toThrow(/最新月 2019-11/);
  });

  it("窓 (24か月) より短い履歴しか無いと throw (黙って欠かさない)", () => {
    expect(() => ffajOtcFxSpec.toObservations({ key: SYN_KEY, files: syntheticFiles({ months: 20 }) })).toThrow(
      /記録対象の観測行がありません/
    );
  });

  it("未知の通貨区分の観測行があると throw", () => {
    const parsed = parseFfajOtcFxFiles({
      tradingVolAndPosition: syntheticTrading(SYN_LATEST, 30),
      openPositionWithMc: syntheticOpenPosition(SYN_LATEST, 30),
      depositAmountInformation: syntheticDeposit(SYN_LATEST, 30),
    });
    const tampered: FfajOtcFxParsed = {
      ...parsed,
      currencyPositions: [
        ...parsed.currencyPositions,
        // 合成テストデータ: モジュールが返しうる型の外の通貨コードを混ぜる
        { ...(parsed.currencyPositions[0] as FfajOtcFxParsed["currencyPositions"][number]), currency: "XXX" as never },
      ],
    };
    expect(() => ffajOtcFxParsedToDrafts(tampered, SYN_LATEST)).toThrow(/想定外の指標・区分/);
  });

  it("主要通貨の見出しが欠けた xls は throw (モジュールの様式検証)", () => {
    const files = syntheticFiles().map((f) =>
      f.filename.startsWith("ffaj-open-position-with-mc")
        ? { ...f, bytes: syntheticOpenPosition(SYN_LATEST, 30, SYN_CURRENCIES.slice(0, 8)) }
        : f
    );
    expect(() => ffajOtcFxSpec.toObservations({ key: SYN_KEY, files })).toThrow(/ZAR/);
  });
});

// ---------------------------------------------------------------------------
// 4. resolve()/fetch() (合成テストデータ・CI でも走る)
// ---------------------------------------------------------------------------

describe("ffaj-otc-fx: resolve/fetch (合成テストデータ)", () => {
  it("資料室ページだけでキーを決め、fetch() が同じキーと安定したファイル名を返す", async () => {
    const html = new TextEncoder().encode(syntheticIndexHtml(SYN_LATEST, SYN_UPDATED, SYN_UPLOAD_DIR));
    const fn = stubFetch({
      [INDEX_URL]: html,
      [`${SYN_UPLOAD_DIR}trading_vol_and_position.xls`]: syntheticTrading(SYN_LATEST, 30),
      [`${SYN_UPLOAD_DIR}open_position_with_mc.xls`]: syntheticOpenPosition(SYN_LATEST, 30),
      [`${SYN_UPLOAD_DIR}deposit_amount_information.xls`]: syntheticDeposit(SYN_LATEST, 30),
    });
    const now = new Date("2019-12-10T03:00:00Z");
    const resolved = await ffajOtcFxSpec.resolve(now);
    expect(resolved.key).toBe(SYN_KEY);
    expect(fn).toHaveBeenCalledTimes(1);
    const batch = await resolved.fetch();
    expect(batch.key).toBe(SYN_KEY);
    expect(batch.files.map((f) => f.filename).sort()).toEqual(Object.values(ffajOtcFxFilenames(SYN_KEY)).sort());
    // 資料室ページ HTML は素の MIME 型 (他アダプタと同じ。パラメータ付きにしない)
    expect(batch.files.find((f) => f.filename.endsWith(".html"))?.contentType).toBe("text/html");
    const xls = batch.files.filter((f) => f.filename.endsWith(".xls"));
    expect(xls.map((f) => f.contentType)).toEqual(Array(3).fill("application/vnd.ms-excel"));
    const drafts = ffajOtcFxSpec.toObservations({ key: batch.key, files: batch.files });
    validateDrafts(ffajOtcFxSpec.name, drafts, ffajOtcFxSpec.indicators);
    expect(drafts.length).toBe(FFAJ_OTC_FX_WINDOW_MONTHS * ROWS_PER_MONTH);
  });

  it("資料室ページの最新公表月が古すぎる (更新停止の疑い) と resolve が throw し、xls は取りに行かない", async () => {
    const fn = stubFetch({
      [INDEX_URL]: new TextEncoder().encode(syntheticIndexHtml(SYN_LATEST, SYN_UPDATED, SYN_UPLOAD_DIR)),
    });
    // 実行月 2020-03 (JST) の 3 か月前 = 2019-12 より 2019-11 は古い
    await expect(ffajOtcFxSpec.resolve(new Date("2020-03-10T03:00:00Z"))).rejects.toThrow(/古すぎ/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resolve と fetch の間に資料室ページが差し替わったら throw", async () => {
    const routes: Record<string, Uint8Array> = {
      [INDEX_URL]: new TextEncoder().encode(syntheticIndexHtml(SYN_LATEST, SYN_UPDATED, SYN_UPLOAD_DIR)),
      [`${SYN_UPLOAD_DIR}trading_vol_and_position.xls`]: syntheticTrading(SYN_LATEST, 30),
      [`${SYN_UPLOAD_DIR}open_position_with_mc.xls`]: syntheticOpenPosition(SYN_LATEST, 30),
      [`${SYN_UPLOAD_DIR}deposit_amount_information.xls`]: syntheticDeposit(SYN_LATEST, 30),
    };
    stubFetch(routes);
    const resolved = await ffajOtcFxSpec.resolve(new Date("2019-12-10T03:00:00Z"));
    routes[INDEX_URL] = new TextEncoder().encode(syntheticIndexHtml(SYN_LATEST, "2019-12-06", SYN_UPLOAD_DIR));
    await expect(resolved.fetch()).rejects.toThrow(/版が変わりました/);
  });
});

// ---------------------------------------------------------------------------
// 2 / 4. 実ファイル (private/ があるときだけ)
// ---------------------------------------------------------------------------

function realFiles(): SpecFile[] {
  const names = ffajOtcFxFilenames(REAL_KEY);
  return [
    { filename: names.index, bytes: readBytes(REAL_INDEX) },
    { filename: names.tradingVolAndPosition, bytes: readBytes(REAL_TRADING) },
    { filename: names.openPositionWithMc, bytes: readBytes(REAL_OPEN) },
    { filename: names.depositAmountInformation, bytes: readBytes(REAL_DEPOSIT) },
  ];
}

describe.skipIf(!HAS_REAL)("ffaj-otc-fx: 実ファイル (2026年8月分)", () => {
  it("観測行が検証を通り、行数が目安内で、値が原本 xls (python xlrd で独立に読んだ値) と一致する", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const drafts = ffajOtcFxSpec.toObservations({ key: REAL_KEY, files: realFiles() });
    // 系列先頭 2015-04 の正味増減額 "na" は窓 (2024-09〜2026-08) の外なので警告しない
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    validateDrafts(ffajOtcFxSpec.name, drafts, ffajOtcFxSpec.indicators);
    expect(drafts.length).toBe(FFAJ_OTC_FX_WINDOW_MONTHS * ROWS_PER_MONTH);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    expect(drafts[0]?.period).toBe("2024-09");
    const last = drafts[drafts.length - 1] as ObservationDraft;
    expect([last.period, last.indicatorKey]).toEqual(["2026-08", "ffaj_otc_fx_deposit_trust_balance"]);

    // trading_vol_and_position.xls ALL(TOTAL) 2026年8月: 取引金額 825,716,490 百万円
    expect(find(drafts, "2026-08", "ffaj_otc_fx_turnover", "全通貨ペア合計").value).toBe(825_716_490 * MILLION);
    // 同 建玉計 12,164,177 百万円
    expect(find(drafts, "2026-08", "ffaj_otc_fx_open_position_total", "全通貨ペア合計").value).toBe(
      12_164_177 * MILLION
    );
    // open_position_with_mc.xls Data 2026年8月 JPY 買越額 -2,877,141 百万円
    expect(find(drafts, "2026-08", "ffaj_otc_fx_net_long_position", "日本円 (JPY)").value).toBe(-2_877_141 * MILLION);
    // 同 2024年9月 (窓の最古月) JPY 買越額 -639,838 百万円
    expect(find(drafts, "2024-09", "ffaj_otc_fx_net_long_position", "日本円 (JPY)").value).toBe(-639_838 * MILLION);
    // trading_vol_and_position.xls 2024年9月 取引金額 1,354,404,504 百万円
    expect(find(drafts, "2024-09", "ffaj_otc_fx_turnover", "全通貨ペア合計").value).toBe(1_354_404_504 * MILLION);
    // deposit_amount_information.xls DATA 2026年8月 (円のまま): 正味増減額・必要額・信託額
    expect(find(drafts, "2026-08", "ffaj_otc_fx_customer_deposit_net_change", "報告会員合算").value).toBe(
      67_271_782_392
    );
    expect(find(drafts, "2026-08", "ffaj_otc_fx_deposit_required_balance", "報告会員合算").value).toBe(
      1_920_655_895_456
    );
    expect(find(drafts, "2026-08", "ffaj_otc_fx_deposit_trust_balance", "報告会員合算").value).toBe(
      1_985_850_459_013
    );
    // --- レビューで追加した独立照合 (python xlrd で原本セルを読んだ値) ---
    // ALL(TOTAL) 2025年2月 売建 3,737,984 百万円 (月末残高: 開始=終了=月末日)
    const short202502 = find(drafts, "2025-02", "ffaj_otc_fx_short_position", "全通貨ペア合計");
    expect(short202502.value).toBe(3_737_984 * MILLION);
    expect([short202502.periodStart, short202502.periodEnd]).toEqual(["2025-02-28", "2025-02-28"]);
    // ALL(TOTAL) 2025年6月 買建 4,758,306 百万円
    expect(find(drafts, "2025-06", "ffaj_otc_fx_long_position", "全通貨ペア合計").value).toBe(4_758_306 * MILLION);
    // Data 2024年9月 ZAR (最後の通貨ブロック・小さい値) 買越額 109,733 百万円
    expect(find(drafts, "2024-09", "ffaj_otc_fx_net_long_position", "南アフリカランド (ZAR)").value).toBe(
      109_733 * MILLION
    );
    // Data 2025年12月 CHF 買越額 -430,704 百万円 (マイナス = 売り持ちの方が多い)
    expect(find(drafts, "2025-12", "ffaj_otc_fx_net_long_position", "スイスフラン (CHF)").value).toBe(
      -430_704 * MILLION
    );
    // DATA 2024年9月 (窓の最古月) ③当月末必要額 1,581,399,130,603 円・正味増減額 -18,712,888,922 円
    expect(find(drafts, "2024-09", "ffaj_otc_fx_deposit_required_balance", "報告会員合算").value).toBe(
      1_581_399_130_603
    );
    const net202409 = find(drafts, "2024-09", "ffaj_otc_fx_customer_deposit_net_change", "報告会員合算");
    expect(net202409.value).toBe(-18_712_888_922);
    expect([net202409.periodStart, net202409.periodEnd]).toEqual(["2024-09-01", "2024-09-30"]);
    // DATA 2025年4月 正味増減額 -63,392,598,772 円
    expect(find(drafts, "2025-04", "ffaj_otc_fx_customer_deposit_net_change", "報告会員合算").value).toBe(
      -63_392_598_772
    );
    // 同 2026年7月 正味増減額 -37,269,691,175 円 (損をした月)
    expect(find(drafts, "2026-07", "ffaj_otc_fx_customer_deposit_net_change", "報告会員合算").value).toBe(
      -37_269_691_175
    );
  });

  it("resolve()/fetch() (fetch スタブが実ファイルを返す) でキー・ファイル名が安定し、観測行が作れる", async () => {
    const fn = stubFetch({
      [INDEX_URL]: readBytes(REAL_INDEX),
      [`${REAL_UPLOAD_DIR}trading_vol_and_position.xls`]: readBytes(REAL_TRADING),
      [`${REAL_UPLOAD_DIR}open_position_with_mc.xls`]: readBytes(REAL_OPEN),
      [`${REAL_UPLOAD_DIR}deposit_amount_information.xls`]: readBytes(REAL_DEPOSIT),
    });
    const resolved = await ffajOtcFxSpec.resolve(FETCHED_AT);
    expect(resolved.key).toBe(REAL_KEY);
    expect(fn).toHaveBeenCalledTimes(1);
    const batch = await resolved.fetch();
    // 資料室ページ (resolve) 1 + 資料室ページ再取得 1 + xls 3
    expect(fn).toHaveBeenCalledTimes(5);
    expect(batch.key).toBe(REAL_KEY);
    expect(batch.source).toBe(INDEX_URL);
    expect(batch.files.map((f) => f.filename)).toEqual([
      "ffaj-otc-fx-2026-08-updated-2026-09-14-fx-flash-index.html",
      "ffaj-trading-vol-and-position-2026-08.xls",
      "ffaj-open-position-with-mc-2026-08.xls",
      "ffaj-deposit-amount-information-2026-08.xls",
    ]);
    const drafts = ffajOtcFxSpec.toObservations({ key: batch.key, files: batch.files });
    validateDrafts(ffajOtcFxSpec.name, drafts, ffajOtcFxSpec.indicators);
    expect(drafts.length).toBe(FFAJ_OTC_FX_WINDOW_MONTHS * ROWS_PER_MONTH);
  });
});
