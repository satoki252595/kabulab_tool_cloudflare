/**
 * `downloadJpxListing` (data_j.xlsx パーサ本体) の単体テスト。
 *
 * ## なぜ足したか
 * 既存の `sectors.test.ts` は `JpxRow` リテラルを直接組み立てており、検証対象は
 * `parseJpxAsOf` / `isListedEquity` / `JPX_LISTING_URL` の 3 つだけだった。
 * XLSX から `JpxRow[]` を作る本体 (コード正規化・行を落とさない不変条件・
 * 基準日の一意性) には 1 件もテストが無く、コード正規化を触る足場が無かった。
 *
 * fetch と Notion 原本アーカイブはモックする。原文の物理照合が済むまで
 * 解析・母集団への返却へ進まない境界も固定する。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

const recordPrimaryData = vi.fn();
const verifyArchivedAttachments = vi.fn();
const archivePage = vi.fn();
vi.mock("../notion-archive/index.js", () => ({
  recordPrimaryData: (...args: unknown[]) => recordPrimaryData(...args),
  verifyArchivedAttachments: (...args: unknown[]) => verifyArchivedAttachments(...args),
  notionEnv: { NOTION_TOKEN: vi.fn(), NOTION_ARCHIVE_PAGE_ID: () => archivePage() },
}));

const { downloadJpxListing, isListedEquity } = await import("./sectors.js");
const { sha256HexBytes } = await import("../sha256.js");
const { toNotionUpload } = await import("../notion-archive/file-upload.js");

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
      url: "https://www.jpx.co.jp/data_j.xlsx",
      headers: new Headers({ "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
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
    recordPrimaryData.mockResolvedValue({ pageId: "archive-page", outcome: "recorded", fileTooLarge: false, manifestMatch: "written" });
    verifyArchivedAttachments.mockResolvedValue(undefined);
    archivePage.mockReturnValue("archive-parent");
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

  it.each([new Uint8Array(), new Uint8Array([0, 255, 195, 13, 10])])("HTTP エラーは原bodyをgzip保管してthrowする (404 は配布形式の差替えを示唆)", async (original) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        url: "https://www.jpx.co.jp/data_j.xlsx",
        headers: new Headers({ "content-type": "text/plain" }),
        arrayBuffer: async () => original.buffer,
      })
    );
    await expect(downloadJpxListing()).rejects.toThrow("拡張子/URL が変わっていないか");
    const input = recordPrimaryData.mock.calls[0][0];
    const file = input.files[0];
    expect(input.metadata.status).toBe(404);
    expect(input.metadata.archiveEncoding).toBe("gzip");
    expect(input.metadata.bytes).toBe(original.byteLength);
    expect(input.metadata.sha256).toBe(await sha256HexBytes(original));
    expect(file.bytes.length).toBeGreaterThan(0);
    // 共有アップロード実関数の受理形式と、UTF-8に依存しない原bytesの復元を検査。
    expect(toNotionUpload(file.filename, file.contentType)).toEqual({ filename: file.filename, contentType: "application/gzip" });
    const decoded = new Uint8Array(await new Response(
      new Blob([Uint8Array.from(file.bytes)]).stream().pipeThrough(new DecompressionStream("gzip"))
    ).arrayBuffer());
    expect(Array.from(decoded)).toEqual(Array.from(original));
    expect(verifyArchivedAttachments).toHaveBeenCalledWith("archive-page", input.files, "JPX listing 原本");
    expect(verifyArchivedAttachments).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("一次取得全bytesをSHAキーで物理照合してから解析する", async () => {
    const bytes = xlsxBytes([TOYOTA, ITO_EN_PREFERRED, SYNTHETIC_ETF]);
    const sha256 = await sha256HexBytes(Uint8Array.from(bytes));
    stubFetch(bytes);
    await downloadJpxListing();
    expect(recordPrimaryData).toHaveBeenCalledTimes(1);
    const arg = recordPrimaryData.mock.calls[0][0];
    expect(arg.key).toBe(`jpx-listing-sha256-${sha256}`);
    expect(arg.force).toBe(false);
    expect(arg.metadata.sha256).toBe(sha256);
    expect(arg.metadata.bytes).toBe(bytes.byteLength);
    expect(arg.metadata).not.toHaveProperty("sourceAsOf");
    expect(arg.files[0].filename).toBe(`data_j-${sha256}.xlsx`);
    expect(toNotionUpload(arg.files[0].filename, arg.files[0].contentType)).toEqual({ filename: arg.files[0].filename, contentType: arg.files[0].contentType });
    expect(arg.files[0].bytes.byteLength).toBe(bytes.byteLength);
    expect(await sha256HexBytes(Uint8Array.from(arg.files[0].bytes))).toBe(sha256);
    expect(verifyArchivedAttachments).toHaveBeenCalledWith("archive-page", arg.files, "JPX listing 原本");
    expect(recordPrimaryData.mock.invocationCallOrder[0]).toBeLessThan(verifyArchivedAttachments.mock.invocationCallOrder[0]);
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ redirect: "manual", signal: expect.any(AbortSignal) });
  });

  it("同月の別bytesは別キー、同じbytesの再用も全物理照合する", async () => {
    const first = xlsxBytes([TOYOTA]);
    const changed = xlsxBytes([TOYOTA, VERITAS]);
    for (const bytes of [first, changed, first]) {
      stubFetch(bytes);
      await downloadJpxListing();
      recordPrimaryData.mockResolvedValue({ pageId: "archive-page", outcome: "skipped_existing", fileTooLarge: false, manifestMatch: "same" });
    }
    const keys = recordPrimaryData.mock.calls.map(([arg]) => arg.key);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toBe(keys[2]);
    expect(verifyArchivedAttachments).toHaveBeenCalledTimes(3);
  });

  it("同じbytesでも非200のgzipと200のXLSXは同じkeyを使わない", async () => {
    const bytes = xlsxBytes([TOYOTA]);
    stubFetch(bytes);
    await downloadJpxListing();
    vi.mocked(fetch).mockResolvedValue({
      status: 503, statusText: "Service Unavailable", url: "https://www.jpx.co.jp/data_j.xlsx",
      headers: new Headers(), arrayBuffer: async () => bytes.buffer.slice(0),
    } as Response);
    await expect(downloadJpxListing()).rejects.toThrow("HTTP エラー: 503");
    const [ok, error] = recordPrimaryData.mock.calls.map(([arg]) => arg);
    expect(ok.metadata.sha256).toBe(error.metadata.sha256);
    expect(ok.key).not.toBe(error.key);
    expect(error.key).toContain("http-503-sha256-");
    expect(verifyArchivedAttachments).toHaveBeenCalledTimes(2);
  });

  it("既知の不正XLSも保管し、readback不明なら解析より先に停止する", async () => {
    stubFetch(xlsxBytes([{ ...TOYOTA, 日付: 20260230 }]));
    verifyArchivedAttachments.mockRejectedValue(new Error("readback unknown"));
    await expect(downloadJpxListing()).rejects.toThrow("readback unknown");
    expect(recordPrimaryData).toHaveBeenCalledTimes(1);
    verifyArchivedAttachments.mockResolvedValue(undefined);
    await expect(downloadJpxListing()).rejects.toThrow("実在しない日付");
    expect(verifyArchivedAttachments).toHaveBeenCalledTimes(2);
  });

  it("容量上限と保管不明は解析へ進まずsourceを再取得しない", async () => {
    stubFetch(xlsxBytes([TOYOTA]));
    recordPrimaryData.mockResolvedValue({ pageId: "archive-page", outcome: "recorded", fileTooLarge: true, manifestMatch: "written" });
    await expect(downloadJpxListing()).rejects.toThrow("容量上限");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(verifyArchivedAttachments).not.toHaveBeenCalled();
    recordPrimaryData.mockRejectedValue(new Error("archive unknown"));
    await expect(downloadJpxListing()).rejects.toThrow("archive unknown");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(verifyArchivedAttachments).not.toHaveBeenCalled();
  });

  it("保管設定が不明ならsource取得前に停止する", async () => {
    stubFetch(xlsxBytes([TOYOTA]));
    archivePage.mockImplementation(() => { throw new Error("archive config missing"); });
    await expect(downloadJpxListing()).rejects.toThrow("archive config missing");
    expect(fetch).not.toHaveBeenCalled();
    expect(recordPrimaryData).not.toHaveBeenCalled();
  });
});
