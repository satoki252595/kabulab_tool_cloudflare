/**
 * `downloadJpxListing` (data_j.xlsx パーサ本体) の単体テスト。
 *
 * ## なぜ足したか
 * 既存の `sectors.test.ts` は `JpxRow` リテラルを直接組み立てており、検証対象は
 * `parseJpxAsOf` / `isListedEquity` / `JPX_LISTING_URL` の 3 つだけだった。
 * XLSX から `JpxRow[]` を作る本体 (コード正規化・行を落とさない不変条件・
 * 基準日の一意性) には 1 件もテストが無く、コード正規化を触る足場が無かった。
 *
 * fetch と Notion 原本アーカイブはモックする。ここで固定したいのは
 * 「シートの中身をどう行に変換するか」だけ。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

const recordPrimaryData = vi.fn().mockResolvedValue(undefined);
vi.mock("../notion-archive/index.js", () => ({
  recordPrimaryData: (...args: unknown[]) => recordPrimaryData(...args),
}));

const { downloadJpxListing, isListedEquity } = await import("./sectors.js");

/** data_j.xlsx の実列名でシートを組み、xlsx バイト列にする。 */
function xlsxBytes(rows: Record<string, unknown>[]): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Sheet1");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
}

function row(code: unknown, name: string, marketCategory: string, sector33 = "-") {
  return {
    日付: 20260630,
    コード: code,
    銘柄名: name,
    "市場・商品区分": marketCategory,
    "33業種区分": sector33,
  };
}

function stubFetch(bytes: Uint8Array) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      arrayBuffer: async () => bytes.buffer.slice(0),
    })
  );
}

// 内国株式の行は data_j 2026-06-30 版の実在行を使う。ETF の行は合成で、コードは JPX の
// 上場銘柄一覧 (2026-08-31 版) にも本番 core_stocks にも無く、銘柄名も架空。
// 区分文字列だけが data_j の表記。
const TOYOTA = row(7203, "トヨタ自動車", "プライム（内国株式）", "輸送用機器");
const VERITAS = row("130A", "Ｖｅｒｉｔａｓ　Ｉｎ　Ｓｉｌｉｃｏ", "グロース（内国株式）", "医薬品");
const ITO_EN_PREFERRED = row(25935, "伊藤園第１種優先株式", "プライム（内国株式）", "食料品");
const SYNTHETIC_ETF = row(1202, "合成テスト指数連動型ＥＴＦ", "ETF・ETN");

describe("downloadJpxListing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordPrimaryData.mockResolvedValue(undefined);
  });

  it("実列名を JpxRow へ写し、基準日を ISO 化する", async () => {
    stubFetch(xlsxBytes([TOYOTA, VERITAS]));
    const rows = await downloadJpxListing();
    expect(rows).toEqual([
      {
        asOf: "2026-06-30",
        code: "7203",
        name: "トヨタ自動車",
        marketCategory: "プライム（内国株式）",
        sector33: "輸送用機器",
      },
      {
        asOf: "2026-06-30",
        code: "130A",
        name: "Ｖｅｒｉｔａｓ　Ｉｎ　Ｓｉｌｉｃｏ",
        marketCategory: "グロース（内国株式）",
        sector33: "医薬品",
      },
    ]);
  });

  // universe.ts:159 はこの配列の長さをガード (a) の rawCount に渡す
  // (MIN_JPX_ROWS=4000 = ETF/REIT/PRO/外国株を含む全行数の下限)。パーサ側で
  // 非正準コード行を落とすと rawCount が「正準コード行数」に変質し、部分取得の
  // 検知器としての意味が変わる。ここを回帰で固定する。
  it("5文字の種類株・ETF 行も落とさない (rawCount の母集団を保つ)", async () => {
    stubFetch(xlsxBytes([TOYOTA, ITO_EN_PREFERRED, SYNTHETIC_ETF]));
    const rows = await downloadJpxListing();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.code)).toEqual(["7203", "25935", "1202"]);
    // 絞り込みは isListedEquity 側の責務
    expect(rows.filter(isListedEquity).map((r) => r.code)).toEqual(["7203"]);
  });

  // universe.ts:151 の rawCodes に 5 文字コードが残っていることが、
  // shouldDeactivateUniverseCode の `!rawCodes.has(code)` 節が種類株について
  // 到達可能である前提。
  it("種類株コードを正準形に丸めず原形のまま返す", async () => {
    stubFetch(xlsxBytes([ITO_EN_PREFERRED]));
    const rows = await downloadJpxListing();
    expect(rows[0].code).toBe("25935");
    expect(rows[0].code).not.toBe("2593");
  });

  it("表記揺れ (全角・小文字・前後空白) だけを吸収する", async () => {
    stubFetch(xlsxBytes([row("  １３０ａ ", "全角小文字表記", "グロース（内国株式）")]));
    const rows = await downloadJpxListing();
    expect(rows[0].code).toBe("130A");
  });

  // 以前は `.padStart(4, "0")` が入っており、列ズレ等で短い値が来ると
  // 実在しないコードを母集団に作ってしまっていた ("720" → "0720")。
  it("桁不足コードを0埋めで4文字に捏造しない", async () => {
    stubFetch(xlsxBytes([row("720", "桁不足", "プライム（内国株式）")]));
    const rows = await downloadJpxListing();
    expect(rows[0].code).toBe("720");
    expect(isListedEquity(rows[0])).toBe(false);
  });

  it("コード列が文字列でも数値でもない行だけを飛ばす", async () => {
    const broken = { ...row(7203, "コード欠損", "プライム（内国株式）"), コード: "" };
    stubFetch(xlsxBytes([TOYOTA, broken]));
    const rows = await downloadJpxListing();
    // defval:"" で空文字列になるため行自体は残り、コード契約で落ちる
    expect(rows).toHaveLength(2);
    expect(rows[1].code).toBe("");
    expect(isListedEquity(rows[1])).toBe(false);
  });

  it("基準日が複数混在したら throw する (差替え途中のファイルを取り込まない)", async () => {
    const other = { ...TOYOTA, 日付: 20260731 };
    stubFetch(xlsxBytes([TOYOTA, other]));
    await expect(downloadJpxListing()).rejects.toThrow("基準日が複数混在");
  });

  it("データ行 0 件は throw する (空を母集団にしない)", async () => {
    stubFetch(xlsxBytes([]));
    await expect(downloadJpxListing()).rejects.toThrow("データ行が 0 件");
  });

  it("HTTP エラーは throw する (404 は配布形式の差替えを示唆する)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        arrayBuffer: async () => new ArrayBuffer(0),
      })
    );
    await expect(downloadJpxListing()).rejects.toThrow("拡張子/URL が変わっていないか");
  });

  it("一次取得物を基準月キーで Notion へ原本アーカイブする", async () => {
    stubFetch(xlsxBytes([TOYOTA, ITO_EN_PREFERRED, SYNTHETIC_ETF]));
    await downloadJpxListing();
    expect(recordPrimaryData).toHaveBeenCalledTimes(1);
    const arg = recordPrimaryData.mock.calls[0][0] as {
      key: string;
      metadata: { rowCount: number; listedEquityCount: number; sourceAsOf: string };
      files: { filename: string }[];
    };
    expect(arg.key).toBe("jpx-listing-2026-06");
    expect(arg.metadata.rowCount).toBe(3);
    expect(arg.metadata.listedEquityCount).toBe(1);
    expect(arg.metadata.sourceAsOf).toBe("2026-06-30");
    expect(arg.files[0].filename).toBe("data_j-2026-06-30.xlsx");
  });
});
