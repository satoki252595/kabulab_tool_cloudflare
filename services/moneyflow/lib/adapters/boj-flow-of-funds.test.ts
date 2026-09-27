/**
 * 日銀 資金循環統計アダプタ (`./boj-flow-of-funds.ts`) のテスト。
 *
 * - 実ファイル (2026-09-27 に日銀サイトから取得した sjpre.xlsx と index.htm) は
 *   `../sources/fixtures/private/boj-flow-of-funds/` にあり commit しない。無い環境 (CI) では
 *   `describe.skipIf` で skip する。値の期待値は Python (openpyxl) で同じ xlsx のセルを
 *   独立に読み出したもの (検証証跡 verified_values の 37,452 / 6,789,608 億円とも一致)。
 * - CI でも走る部分は、日銀の表の並び (見出し・部門コード行・資産(A)/負債(L) 行・行コード列)
 *   を真似てテスト内で組み立てた **合成テストデータ** の xlsx / HTML を使う。値は
 *   「行番号×1000+列番号」などの作り物で、実データではない。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import {
  isMoneyflowFlowType,
  isMoneyflowFrequency,
  isMoneyflowLicense,
  isMoneyflowRequirement,
} from "../../../../src/shared/notion-archive/index.js";
import { validateDrafts, type ObservationDraft, type SpecFile } from "../source-spec.js";
import { BOJ_FLOW_OF_FUNDS_INDEX_URL, BOJ_FLOW_OF_FUNDS_INDICATORS, BOJ_INSTRUMENTS } from "../sources/boj-flow-of-funds.js";
import {
  BOJ_FLOW_OF_FUNDS_SPEC_INDICATORS,
  bojFlowOfFundsBatchKey,
  bojFlowOfFundsSpec,
  bojSjpreFilename,
  parseBojFlowOfFundsBatchKey,
} from "./boj-flow-of-funds.js";

const ROW_BUDGET = 600;
const OKU = 100_000_000;
const SJPRE_URL = "https://www.boj.or.jp/statistics/sj/sjpre.xlsx";

function row(drafts: readonly ObservationDraft[], indicatorKey: string, category: string): ObservationDraft {
  const hits = drafts.filter((d) => d.indicatorKey === indicatorKey && d.category === category);
  if (hits.length !== 1) throw new Error(`test: ${indicatorKey} ${category} が ${hits.length} 件`);
  return hits[0] as ObservationDraft;
}

// ---------------------------------------------------------------------------
// 合成テストデータ (実データではない): 日銀の全体表の並びを真似た xlsx
// ---------------------------------------------------------------------------

type Cell = string | number | null;

/** page1 の部門コード (資産列の位置)。実ファイルと同じく G 列 (index 6) から 2 列おき。 */
const PAGE1_SECTORS = ["1", "2", "21", "22", "3", "31"];
/** page2 の部門コード。C 列 (index 2) から 2 列おき。 */
const PAGE2_SECTORS = ["32", "33", "331", "4", "5", "6"];
/** 合成表の行コード。B は採用外 (出力されないことを確かめる)。 */
const SYN_ROW_CODES = ["A", "B", ...BOJ_INSTRUMENTS.map((i) => i.rowCode).filter((c) => c !== "A")];

interface SynOptions {
  flowLabel?: string;
  stockLabel?: string;
  /** page2 の末尾に部門コードの列を足す (未知の部門コードのテスト用)。 */
  extraPage2Sector?: string;
}

/** 合成テストデータ: (行コード, 部門, 資産/負債) → 値。空欄にするセルは null。 */
function synValue(table: "flow" | "stock", rowCode: string, sector: string, pos: "A" | "L"): number | null {
  if (sector === "4" && pos === "L" && rowCode !== "C") return null; // 家計の負債は貸出(借入)だけ
  const r = SYN_ROW_CODES.indexOf(rowCode) + 1;
  const base = r * 1000 + Number(sector) * 10 + (pos === "A" ? 1 : 2);
  return table === "flow" ? (r % 2 === 0 ? -base : base) : base * 100;
}

function buildPage(
  table: "flow" | "stock",
  page: 1 | 2,
  sectors: readonly string[],
  periodLabel: string
): XLSX.WorkSheet {
  const firstCol = page === 1 ? 6 : 2;
  // page2 は部門列の右に行コード列 (実ファイルと同じ並び)。
  const codeCol = firstCol + sectors.length * 2;
  const width = page === 1 ? 18 : codeCol + 1;
  const blank = (): Cell[] => Array.from({ length: width }, () => null);
  const rows: Cell[][] = Array.from({ length: 11 }, blank);
  if (page === 1) {
    (rows[2] as Cell[])[2] = table === "flow" ? "１．金融取引表（Financial Transactions）" : "２．金融資産・負債残高表 (Financial Assets and Liabilities)";
    (rows[3] as Cell[])[3] = "（１）全体表（All Sectors)";
    (rows[4] as Cell[])[5] = `${periodLabel} (synthetic)`;
  } else {
    (rows[3] as Cell[])[codeCol] = periodLabel;
    (rows[5] as Cell[])[codeCol] = "（単位　億円＜\\ 100 million＞）";
  }
  sectors.forEach((s, i) => {
    const c = firstCol + i * 2;
    (rows[9] as Cell[])[c] = Number(s);
    (rows[10] as Cell[])[c] = "資産(A)";
    (rows[10] as Cell[])[c + 1] = "負債(L)";
  });
  for (const code of SYN_ROW_CODES) {
    const r = blank();
    if (page === 1) {
      r[2] = code;
      r[3] = `合成項目${code}`;
    } else {
      r[codeCol] = code;
    }
    sectors.forEach((s, i) => {
      const c = firstCol + i * 2;
      r[c] = synValue(table, code, s, "A");
      r[c + 1] = synValue(table, code, s, "L");
    });
    rows.push(r);
  }
  return XLSX.utils.aoa_to_sheet(rows);
}

/** 合成テストデータ: sjpre.xlsx の形をした xlsx のバイト列。 */
function synXlsx(opts: SynOptions = {}): Uint8Array {
  const flowLabel = opts.flowLabel ?? "2030年  1～3月期(速報)";
  const stockLabel = opts.stockLabel ?? "2030年 3月末(速報)";
  const page2 = opts.extraPage2Sector === undefined ? PAGE2_SECTORS : [...PAGE2_SECTORS, opts.extraPage2Sector];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildPage("flow", 1, PAGE1_SECTORS, flowLabel), "1");
  XLSX.utils.book_append_sheet(wb, buildPage("flow", 2, page2, flowLabel), "2");
  XLSX.utils.book_append_sheet(wb, buildPage("stock", 1, PAGE1_SECTORS, stockLabel), "19");
  XLSX.utils.book_append_sheet(wb, buildPage("stock", 2, page2, stockLabel), "20");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

const SYN_KEY = "boj-flow-of-funds-2030-Q1-prelim-2030-06-20";

function synFiles(opts: SynOptions = {}): SpecFile[] {
  return [{ filename: "boj-sjpre-2030-Q1.xlsx", bytes: synXlsx(opts) }];
}

/** 合成テストデータ: index.htm の「四半期計数」表の最小形。 */
function synIndexHtml(date: string, hint: string): string {
  return (
    "<html><body><table><tbody>" +
    `<tr><td>${date}</td><td>全体版（2030年第1四半期）</td><td><a href="/statistics/sj/sjall.pdf">&nbsp;[PDF&nbsp;600KB]</a></td></tr>` +
    `<tr><td>${date}</td><td>${hint}</td><td><a href="/statistics/sj/sjpre.xlsx">&nbsp;[XLSX&nbsp;200KB]</a></td></tr>` +
    "</tbody></table></body></html>"
  );
}

/** Response 本体用に ArrayBuffer を切り出す (Uint8Array<ArrayBufferLike> は BodyInit に直接渡せない)。 */
function bodyOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function stubFetch(responses: () => { index: string; xlsx: Uint8Array }) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const r = responses();
    if (url === BOJ_FLOW_OF_FUNDS_INDEX_URL) return new Response(r.index, { status: 200 });
    if (url === SJPRE_URL) return new Response(bodyOf(r.xlsx), { status: 200 });
    return new Response("not found", { status: 404, statusText: "Not Found" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. 指標定義
// ---------------------------------------------------------------------------

describe("boj-flow-of-funds 指標定義", () => {
  it("全指標が enum ガードを通り、キーが一意で、出典が https、説明・限界が日本語で空でない", () => {
    const defs = BOJ_FLOW_OF_FUNDS_SPEC_INDICATORS;
    expect(defs).toHaveLength(24);
    expect(new Set(defs.map((d) => d.key)).size).toBe(defs.length);
    expect(defs.map((d) => d.key)).toEqual(BOJ_FLOW_OF_FUNDS_INDICATORS.map((d) => d.key));
    for (const d of defs) {
      expect(isMoneyflowFlowType(d.flowType)).toBe(true);
      expect(isMoneyflowFrequency(d.frequency)).toBe(true);
      expect(isMoneyflowLicense(d.license)).toBe(true);
      expect(isMoneyflowRequirement(d.requirement)).toBe(true);
      expect(d.sourceUrl).toMatch(/^https:\/\//);
      expect(d.description).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(d.limitations).toMatch(/[ぁ-んァ-ヶ一-龠]/);
      expect(d.displayName.trim()).not.toBe("");
      expect(d.frequency).toBe("四半期");
      expect(d.license).toBe("attribution-required");
      // 単位の換算と「純流入ではない / 残高である」ことを必ず明記する
      expect(d.description).toContain("円に換算");
      if (d.key.endsWith("_flow")) {
        expect(d.flowType).toBe("純買い越し");
        expect(d.description).toContain("新しいお金が流れ込んだ額ではない");
        // 『負債 / 海外』のフロー (例: 対外証券投資の -10.7 兆円 = 日本の居住者の売り越し) を
        // 「海外が返済・償還した」と読ませない (一般の負債側の説明は当てはまらない)
        expect(d.description).toContain("『負債 / 海外』の行だけは読み方が違い");
        expect(d.description).toContain("償還・返済したとは限らない");
      } else {
        expect(d.flowType).toBe("残高");
        expect(d.description).toContain("期末時点の残高");
        expect(d.limitations).toContain("近似フラグ");
      }
      expect(d.limitations).toContain("速報");
    }
  });

  it("要件はモジュールの主要件 (先頭) — 対外投資 K/L は R4、ほかは R2", () => {
    const req = new Map(BOJ_FLOW_OF_FUNDS_SPEC_INDICATORS.map((d) => [d.key, d.requirement]));
    expect(req.get("boj_ffa_outward_direct_investment_stock")).toBe("R4");
    expect(req.get("boj_ffa_outward_portfolio_investment_flow")).toBe("R4");
    expect(req.get("boj_ffa_listed_shares_flow")).toBe("R2");
    expect(req.get("boj_ffa_cash_and_deposits_stock")).toBe("R2");
  });
});

// ---------------------------------------------------------------------------
// 2. 冪等キー
// ---------------------------------------------------------------------------

describe("boj-flow-of-funds 冪等キー", () => {
  it("組み立てと分解が往復し、形の違うキーは throw", () => {
    const key = bojFlowOfFundsBatchKey({ year: 2026, quarter: 2, announcedAt: "2026-09-17" });
    expect(key).toBe("boj-flow-of-funds-2026-Q2-prelim-2026-09-17");
    expect(parseBojFlowOfFundsBatchKey(key)).toEqual({ year: 2026, quarter: 2, announcedAt: "2026-09-17" });
    expect(bojSjpreFilename({ year: 2026, quarter: 2 })).toBe("boj-sjpre-2026-Q2.xlsx");
    expect(() => parseBojFlowOfFundsBatchKey("boj-flow-of-funds-2026Q2")).toThrow(/形式/);
    expect(() => bojFlowOfFundsBatchKey({ year: 2026, quarter: 2, announcedAt: "2026/09/17" })).toThrow(/YYYY-MM-DD/);
  });
});

// ---------------------------------------------------------------------------
// 3. 合成テストデータで対応付けの規則 (CI でも走る)
// ---------------------------------------------------------------------------

describe("boj-flow-of-funds toObservations (合成テストデータ)", () => {
  const drafts = bojFlowOfFundsSpec.toObservations({ key: SYN_KEY, files: synFiles() });

  it("validateDrafts を通り、行数は採用 12 項目 × 2 表 × 葉部門の値のあるセルだけ", () => {
    validateDrafts(bojFlowOfFundsSpec.name, drafts, bojFlowOfFundsSpec.indicators);
    // 9 部門 × 資産/負債 = 18 セル。家計の負債は貸出以外空欄 → 貸出以外の 11 項目で 1 セル減。
    expect(drafts).toHaveLength(2 * (12 * 18 - 11));
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    // 採用外の行コード B (合成項目B) と集計部門 (2 / 3 / 331) は出ない
    const keys = new Set(drafts.map((d) => d.indicatorKey));
    expect(keys.size).toBe(24);
    const cats = new Set(drafts.map((d) => d.category));
    expect(cats.size).toBe(18);
    for (const c of cats) expect(c).toMatch(/^(資産|負債) \/ \S+$/);
    expect([...cats].some((c) => c.includes("一般政府") || c.includes("非金融法人企業計") || c.includes("公的年金"))).toBe(
      false
    );
  });

  it("億円 → 円、区分・期間・近似フラグ・実測推定の対応付け", () => {
    // 家計(部門コード4) の資産側、行コード E (SYN_ROW_CODES の 7 番目 → 奇数なのでプラス)
    const e = SYN_ROW_CODES.indexOf("E") + 1;
    const flowHh = row(drafts, "boj_ffa_equity_and_investment_fund_shares_flow", "資産 / 家計");
    expect(flowHh).toEqual({
      period: "2030-Q1",
      periodStart: "2030-01-01",
      periodEnd: "2030-03-31",
      indicatorKey: "boj_ffa_equity_and_investment_fund_shares_flow",
      category: "資産 / 家計",
      categoryKind: "投資部門",
      value: (e * 1000 + 40 + 1) * OKU,
      unit: "円",
      changeFromPrev: null,
      approximate: false,
      measureKind: "実測",
    });
    const stockRow = row(drafts, "boj_ffa_equity_and_investment_fund_shares_stock", "負債 / 海外");
    expect(stockRow).toMatchObject({
      periodStart: "2030-03-31",
      periodEnd: "2030-03-31",
      value: (e * 1000 + 60 + 2) * 100 * OKU,
      approximate: true,
      measureKind: "実測",
    });
    // フローのマイナス値 (合成データでは偶数番目の行コード。D は 4 番目) の符号が保たれる
    const d = SYN_ROW_CODES.indexOf("D") + 1;
    expect(row(drafts, "boj_ffa_debt_securities_flow", "資産 / 金融機関").value).toBe(-(d * 1000 + 10 + 1) * OKU);
    // 家計の負債は貸出だけ行があり、ほかは空欄 = 行を作らない
    expect(drafts.some((x) => x.indicatorKey === "boj_ffa_loans_flow" && x.category === "負債 / 家計")).toBe(true);
    expect(drafts.some((x) => x.indicatorKey === "boj_ffa_cash_and_deposits_flow" && x.category === "負債 / 家計")).toBe(
      false
    );
  });

  it("並び順は決定的 (指標定義順 → 資産→負債 → 部門順)。最後の行はストックの対外証券投資・負債・海外", () => {
    const again = bojFlowOfFundsSpec.toObservations({ key: SYN_KEY, files: synFiles() });
    expect(again).toEqual(drafts);
    expect(drafts[0]).toMatchObject({ indicatorKey: "boj_ffa_cash_and_deposits_flow", category: "資産 / 金融機関" });
    expect(drafts[drafts.length - 1]).toMatchObject({
      indicatorKey: "boj_ffa_outward_portfolio_investment_stock",
      category: "負債 / 海外",
    });
  });
});

// ---------------------------------------------------------------------------
// 4. 想定外の入力は throw (CI でも走る)
// ---------------------------------------------------------------------------

describe("boj-flow-of-funds 想定外の入力", () => {
  it("ファイルが無い・名前が違う・余計なファイルがあると throw", () => {
    expect(() => bojFlowOfFundsSpec.toObservations({ key: SYN_KEY, files: [] })).toThrow(/0 件/);
    const bytes = synXlsx();
    expect(() =>
      bojFlowOfFundsSpec.toObservations({ key: SYN_KEY, files: [{ filename: "boj-sjpre-2030-Q2.xlsx", bytes }] })
    ).toThrow(/0 件/);
    expect(() =>
      bojFlowOfFundsSpec.toObservations({
        key: SYN_KEY,
        files: [
          { filename: "boj-sjpre-2030-Q1.xlsx", bytes },
          { filename: "other.csv", bytes },
        ],
      })
    ).toThrow(/想定外のファイル/);
  });

  it("ファイルの期間がキーと違う・速報でない (確報) と throw", () => {
    const key = "boj-flow-of-funds-2030-Q2-prelim-2030-09-20";
    expect(() =>
      bojFlowOfFundsSpec.toObservations({ key, files: [{ filename: "boj-sjpre-2030-Q2.xlsx", bytes: synXlsx() }] })
    ).toThrow(/一致しません/);
    expect(() =>
      bojFlowOfFundsSpec.toObservations({
        key: SYN_KEY,
        files: synFiles({ flowLabel: "2030年  1～3月期(確報)", stockLabel: "2030年 3月末(確報)" }),
      })
    ).toThrow(/速報ではありません/);
  });

  it("未知の制度部門コード (区分) があると throw", () => {
    expect(() =>
      bojFlowOfFundsSpec.toObservations({ key: SYN_KEY, files: synFiles({ extraPage2Sector: "7" }) })
    ).toThrow(/未知の制度部門コード/);
  });

  it("キーの形が違うと throw", () => {
    expect(() => bojFlowOfFundsSpec.toObservations({ key: "boj-flow-of-funds-2030-Q1", files: synFiles() })).toThrow(
      /形式/
    );
  });
});

// ---------------------------------------------------------------------------
// 5. resolve / fetch (合成テストデータ、global fetch をスタブ。CI でも走る)
// ---------------------------------------------------------------------------

describe("boj-flow-of-funds resolve / fetch (合成テストデータ)", () => {
  it("index.htm だけでキーを決め、fetch は同じキーと安定したファイル名を返す", async () => {
    const xlsx = synXlsx();
    const fetchMock = stubFetch(() => ({ index: synIndexHtml("2030年&nbsp;6月20日", "速報（2030年第1四半期）"), xlsx }));
    const resolved = await bojFlowOfFundsSpec.resolve(new Date("2030-06-25T00:00:00Z"));
    expect(resolved.key).toBe(SYN_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const batch = await resolved.fetch();
    expect(batch.key).toBe(SYN_KEY);
    expect(batch.source).toBe(SJPRE_URL);
    expect(batch.files.map((f) => f.filename)).toEqual(["boj-sjpre-2030-Q1.xlsx"]);
    expect(batch.files[0]?.contentType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(batch.metadata).toMatchObject({ announcedAt: "2030-06-20", periodLabelHint: "速報（2030年第1四半期）" });
    const drafts = bojFlowOfFundsSpec.toObservations({ key: batch.key, files: batch.files });
    validateDrafts(bojFlowOfFundsSpec.name, drafts, bojFlowOfFundsSpec.indicators);
  });

  it("resolve と fetch の間に掲載日が変わったら throw", async () => {
    let calls = 0;
    const xlsx = synXlsx();
    stubFetch(() => {
      calls += 1;
      const date = calls === 1 ? "2030年&nbsp;6月20日" : "2030年&nbsp;6月27日";
      return { index: synIndexHtml(date, "速報（2030年第1四半期）"), xlsx };
    });
    const resolved = await bojFlowOfFundsSpec.resolve(new Date("2030-06-25T00:00:00Z"));
    await expect(resolved.fetch()).rejects.toThrow(/掲載日が変わりました/);
  });

  it("index.htm の公表対象期が想定外なら throw、本体の期間がキーと違えば保管前に throw", async () => {
    stubFetch(() => ({ index: synIndexHtml("2030年&nbsp;6月20日", "速報（2030年1〜3月期）"), xlsx: synXlsx() }));
    await expect(bojFlowOfFundsSpec.resolve(new Date())).rejects.toThrow(/公表対象期/);

    stubFetch(() => ({
      index: synIndexHtml("2030年&nbsp;9月20日", "速報（2030年第2四半期）"),
      xlsx: synXlsx(),
    }));
    const resolved = await bojFlowOfFundsSpec.resolve(new Date());
    expect(resolved.key).toBe("boj-flow-of-funds-2030-Q2-prelim-2030-09-20");
    await expect(resolved.fetch()).rejects.toThrow(/一致しません/);
  });
});

// ---------------------------------------------------------------------------
// 6. 実ファイル (private フィクスチャ。無い環境では skip)
// ---------------------------------------------------------------------------

const FIXTURE_DIR = fileURLToPath(new URL("../sources/fixtures/private/boj-flow-of-funds/", import.meta.url));
const FIXTURE_XLSX = `${FIXTURE_DIR}boj-sjpre-2026q2.xlsx`;
const FIXTURE_INDEX = `${FIXTURE_DIR}boj-sj-index-2026-09-27.html`;
const HAS_FIXTURES = existsSync(FIXTURE_XLSX) && existsSync(FIXTURE_INDEX);
const FIXTURE_KEY = "boj-flow-of-funds-2026-Q2-prelim-2026-09-17";

describe.skipIf(!HAS_FIXTURES)("boj-flow-of-funds 実ファイル (2026年4〜6月期速報, 2026-09-27 取得)", () => {
  function realFiles(): SpecFile[] {
    return [{ filename: "boj-sjpre-2026-Q2.xlsx", bytes: new Uint8Array(readFileSync(FIXTURE_XLSX)) }];
  }

  it("validateDrafts を通り、行数が予算内で、独立抽出値と一致する (億円→円)", () => {
    const drafts = bojFlowOfFundsSpec.toObservations({ key: FIXTURE_KEY, files: realFiles() });
    validateDrafts(bojFlowOfFundsSpec.name, drafts, bojFlowOfFundsSpec.indicators);
    expect(drafts).toHaveLength(282);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    expect(new Set(drafts.map((d) => d.period))).toEqual(new Set(["2026-Q2"]));

    // 期待値は openpyxl でシート 1/2 (フロー) ・19/20 (ストック) のセルを直接読んだもの。
    const flowHh = row(drafts, "boj_ffa_equity_and_investment_fund_shares_flow", "資産 / 家計"); // シート2 I44
    expect(flowHh).toMatchObject({ value: 37_452 * OKU, periodStart: "2026-04-01", periodEnd: "2026-06-30" });
    expect(flowHh.value).toBe(3_745_200_000_000);
    const stockHh = row(drafts, "boj_ffa_equity_and_investment_fund_shares_stock", "資産 / 家計"); // シート20 I44
    expect(stockHh).toMatchObject({ value: 678_960_800_000_000, periodStart: "2026-06-30", periodEnd: "2026-06-30" });
    // 海外投資家が持つ日本の上場株式 (シート20 M46)
    expect(row(drafts, "boj_ffa_listed_shares_stock", "資産 / 海外").value).toBe(492_080_100_000_000);
    // 中央政府の国債・財投債の発行 (フロー、負債側。シート1 R35)
    expect(row(drafts, "boj_ffa_jgb_and_filp_bonds_flow", "負債 / 中央政府").value).toBe(9_015_700_000_000);
    // 対外証券投資 (フロー) の海外・負債側 = 日本の居住者による外国証券の売り越し (シート2 N65、マイナス)
    expect(row(drafts, "boj_ffa_outward_portfolio_investment_flow", "負債 / 海外").value).toBe(-10_738_100_000_000);
    // 家計の現金・預金残高 (シート20 I12)
    expect(row(drafts, "boj_ffa_cash_and_deposits_stock", "資産 / 家計").value).toBe(1_131_594_300_000_000);
    // 家計の投資信託受益証券の取引 (シート2 I49)
    expect(row(drafts, "boj_ffa_investment_fund_shares_flow", "資産 / 家計").value).toBe(3_962_800_000_000);
    // 表で 0 と書かれたセルは 0 を記録 (シート1 Q46: 中央政府の上場株式の取引)
    expect(row(drafts, "boj_ffa_listed_shares_flow", "資産 / 中央政府").value).toBe(0);
    // 符号と資産/負債の対応: 対外証券投資 (フロー) は国内各部門の資産側の合計が『負債 / 海外』と一致する
    // (-107,381 億円 = 日本の居住者の外国証券の売り越し。openpyxl で同じ行を合計して確認)
    const lFlow = drafts.filter((d) => d.indicatorKey === "boj_ffa_outward_portfolio_investment_flow");
    const lAssets = lFlow.filter((d) => d.category.startsWith("資産 / ")).reduce((s, d) => s + d.value, 0);
    expect(lAssets).toBe(-10_738_100_000_000);
    expect(lFlow.filter((d) => d.category.startsWith("負債 / ")).map((d) => d.category)).toEqual(["負債 / 海外"]);
    // 上場株式 (フロー) の発行側: 民間非金融法人企業の負債 -144,298 億円 (シート1 L46、自社株買い等で純減)
    expect(row(drafts, "boj_ffa_listed_shares_flow", "負債 / 民間非金融法人企業").value).toBe(-14_429_800_000_000);
    // 家計の借入残高 (ストック、貸出の負債側。シート20 J21)
    expect(row(drafts, "boj_ffa_loans_stock", "負債 / 家計").value).toBe(396_686_800_000_000);
    // 空欄 (家計の現金・預金の負債) は行を作らない
    expect(drafts.some((d) => d.indicatorKey === "boj_ffa_cash_and_deposits_stock" && d.category === "負債 / 家計")).toBe(
      false
    );
  });

  it("stub した fetch に実ファイルを返させると、resolve → fetch → toObservations が通る", async () => {
    const index = readFileSync(FIXTURE_INDEX, "utf8");
    const xlsx = new Uint8Array(readFileSync(FIXTURE_XLSX));
    const fetchMock = stubFetch(() => ({ index, xlsx }));
    const resolved = await bojFlowOfFundsSpec.resolve(new Date("2026-09-27T09:00:00Z"));
    expect(resolved.key).toBe(FIXTURE_KEY);
    const batch = await resolved.fetch();
    expect(batch.key).toBe(FIXTURE_KEY);
    expect(batch.files.map((f) => f.filename)).toEqual(["boj-sjpre-2026-Q2.xlsx"]);
    expect(batch.files[0]?.bytes.byteLength).toBe(220_647);
    expect(batch.metadata).toMatchObject({ announcedAt: "2026-09-17", periodLabelHint: "速報（2026年第2四半期）" });
    expect(fetchMock).toHaveBeenCalledTimes(3); // resolve: index / fetch: index + xlsx
    const drafts = bojFlowOfFundsSpec.toObservations({ key: batch.key, files: batch.files });
    expect(drafts).toHaveLength(282);
  });
});
