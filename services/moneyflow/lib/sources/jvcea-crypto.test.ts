/**
 * JVCEA「会員の暗号資産取引状況表（月次）」パーサのテスト。
 *
 * フィクスチャは 2026-09-27 に実際に取得した実ファイル (架空値ではない)。置き場所は
 * fixtures/private/jvcea-crypto/ (commit しない。未取得の環境では該当テストを skip):
 *   - jvcea-crypto-202607-koukai-01-p1-2.pdf
 *       元URL: https://jvcea.or.jp/cms2026/wp-content/uploads/2026/08/202607-KOUKAI-01-FINAL.pdf
 *       (全8ページ中、本パーサが対象とする1〜2ページ目 [合算表] のみを
 *        pymupdf で抽出したもの。3ページ目以降は銘柄別内訳でスコープ外)
 *   - jvcea-crypto-202607-koukai-01-full-8p.pdf
 *       同URL の全8ページそのまま (トリミング無し)。本番の fetchJvceaCrypto()
 *       が実際に受け取るのと同じ形。3ページ目以降 (銘柄別内訳、列構成が
 *       異なる) を含めても合算表だけを正しく取り出せることを検証するために
 *       使う (このトリミング無し版が無いと、本番が壊れていても
 *       p1-2 版だけのテストは全て pass してしまう)。
 *   - jvcea-statistics-information-20260927.html
 *       元URL: https://jvcea.or.jp/statistics/information/ (2026-09-27 時点)
 *
 * 期待値は PDF を画像化して目視確認した数値 (下記コメントの通り)。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractText, getDocumentProxy } from "unpdf";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JVCEA_CRYPTO_CATEGORY,
  JVCEA_CRYPTO_INDICATORS,
  fetchJvceaCrypto,
  isJvceaCryptoMonthPublished,
  jvceaCryptoArchiveInput,
  jvceaCryptoRowToObservations,
  parseJvceaCryptoText,
  parseJvceaCryptoUpdatedDate,
  parseLatestJvceaCryptoPdfUrl,
  selectAggregateTablePages,
  type JvceaCryptoRow,
} from "./jvcea-crypto.js";

// unpdf の extractText を「実物をそのまま呼ぶ」vi.fn で包む (既定は素通し)。
// 本番経路 fetchJvceaCrypto に抽出崩れを注入する回帰テストだけが
// mockImplementationOnce で差し替える (ESM 名前空間は spyOn できないため)。
vi.mock("unpdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("unpdf")>();
  return { ...actual, extractText: vi.fn(actual.extractText) };
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures", "private", "jvcea-crypto");
// JVCEA の資料は再配布不可のため commit しない (`.gitignore` 済み)。置いていない環境 (CI) では
// 実ファイルを読むテストだけを skip する (読むのは各テストの中だけ。import 時には読まない)。
const hasFixtures = [
  "jvcea-crypto-202607-koukai-01-p1-2.pdf",
  "jvcea-crypto-202607-koukai-01-full-8p.pdf",
  "jvcea-statistics-information-20260927.html",
].every((f) => existsSync(join(FIXTURES, f)));

async function extractPageTexts(filename: string): Promise<string[]> {
  const bytes = readFileSync(join(FIXTURES, filename));
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}

async function loadFixtureRows(): Promise<JvceaCryptoRow[]> {
  const text = await extractPageTexts("jvcea-crypto-202607-koukai-01-p1-2.pdf");
  return parseJvceaCryptoText(text);
}

describe.skipIf(!hasFixtures)("parseJvceaCryptoText (実フィクスチャ)", () => {
  it("2018年9月〜2026年7月の95か月分を、欠落・重複なく抽出する", async () => {
    const rows = await loadFixtureRows();
    expect(rows).toHaveLength(95);
    const periods = rows.map((r) => r.period);
    expect(new Set(periods).size).toBe(95);
    expect(periods).toContain("2018-09");
    expect(periods).toContain("2026-07");
  });

  it("2026-07 (最新月) の値が原本の目視確認値と一致する", async () => {
    const rows = await loadFixtureRows();
    const row = rows.find((r) => r.period === "2026-07");
    expect(row).toBeDefined();
    // 以下は PDF 1ページ目 (会員の暗号資産取引状況表(月次)) 2026年7月行を
    // 画像化して目視確認した値。
    expect(row!.spotTurnoverJpy).toBe(674_240); // 現物取引 金額 (百万円)
    expect(row!.marginTurnoverJpy).toBe(627_529); // 証拠金取引 金額 (取引高、百万円)
    expect(row!.depositsTotalJpy).toBe(2_872_363); // 利用者預託金残高 合計 (百万円)
    expect(row!.marginPositionTotalJpy).toBe(18_477); // 証拠金取引建玉残高 合計金額 (百万円)
    expect(row!.accountsTotalEstablished).toBe(14_280_598); // 利用者口座数 全体 設定口座
    expect(row!.accountsMarginActive).toBe(1_015_983); // 利用者口座数 うち証拠金取引 稼働口座
  });

  it("2018-09 (最古月) の値が原本の目視確認値と一致する", async () => {
    const rows = await loadFixtureRows();
    const row = rows.find((r) => r.period === "2018-09");
    expect(row).toBeDefined();
    // PDF 2ページ目 (表の末尾行) を画像化して目視確認した値。
    expect(row!.spotTurnoverJpy).toBe(813_446);
    expect(row!.accountsTotalEstablished).toBe(2_838_620);
    expect(row!.accountsMarginActive).toBe(439_694);
  });

  it("月次系列が連続している (2026-07 の次は 2026-06)", async () => {
    const rows = await loadFixtureRows();
    const idx = rows.findIndex((r) => r.period === "2026-07");
    expect(rows[idx + 1]!.period).toBe("2026-06");
  });
});

describe("parseJvceaCryptoText (様式異常時は throw する)", () => {
  it("列数が想定 (19) と異なる行があれば throw する", () => {
    // 合成データ: 意図的に列を1つ減らしている (18列)。
    const malformed =
      "2026 7 1,376,706,952,792 674,240 56,700,555,851 627,529 12,558,517,490,795 " +
      "2,641,858 230,505 2,872,363 406,181 11,048,072,156 44,220,770,769 55,268,842,925 " +
      "4,119 14,358 18,477 14,280,598 8,858,935";
    expect(() => parseJvceaCryptoText([malformed])).toThrow(/数値列数/);
  });

  it("数値として解釈できないトークン (例: ー) があれば throw する", () => {
    // 19列目 (稼働口座うち証拠金取引) だけを "ー" (JVCEA表内の欠損記号) に置換。
    const malformed =
      "2026 7 1,376,706,952,792 674,240 56,700,555,851 627,529 12,558,517,490,795 " +
      "2,641,858 230,505 2,872,363 406,181 11,048,072,156 44,220,770,769 55,268,842,925 " +
      "4,119 14,358 18,477 14,280,598 8,858,935 2,238,288 ー";
    expect(() => parseJvceaCryptoText([malformed])).toThrow(/解釈できない/);
  });

  it("月が重複していれば throw する", () => {
    const line = "2026 7 " + Array(19).fill("1").join(" ");
    expect(() => parseJvceaCryptoText([`${line}\n${line}`])).toThrow(/複数回出現/);
  });

  it("月次系列が不連続なら throw する", () => {
    const row = (y: number, m: number) => `${y} ${m} ${Array(19).fill("1").join(" ")}`;
    // 2026-07 の次が 2026-05 (2026-06 が抜けている)
    expect(() => parseJvceaCryptoText([`${row(2026, 7)}\n${row(2026, 5)}`])).toThrow(/連続していません/);
  });

  it("表の行が1件も抽出できなければ throw する", () => {
    expect(() => parseJvceaCryptoText(["見出しだけの本文で数値行が無い"])).toThrow(/1件も抽出/);
  });

  it("「年 月 …」形の行で月が範囲外なら黙って読み飛ばさず throw する", () => {
    // 回帰テスト: 旧実装は月が 1〜12 以外の行を `continue` で黙って捨てていた。
    // 先頭/末尾の月が抽出崩れで欠けると連続性チェックでも気付けないため失敗させる。
    const row = (y: number, m: number) => `${y} ${m} ${Array(19).fill("1").join(" ")}`;
    expect(() => parseJvceaCryptoText([`${row(2026, 13)}\n${row(2026, 6)}`])).toThrow(/月が不正/);
  });
});

describe.skipIf(!hasFixtures)("parseJvceaCryptoText (様式異常時は throw する, 実フィクスチャ加工)", () => {
  it("行が「年 月」と数値部に割れて抽出されたら黙って捨てず throw する", async () => {
    // 回帰テスト (2次レビュー): 実 PDF の最古行 2018-09 を「2018 9」と数値部の
    // 2 行に割ると、旧実装は数値部を黙って読み飛ばし 94 行 (2018-10〜) で成功した
    // (連続性チェックは端の欠落を検知できない)。
    const pages = selectAggregateTablePages(
      await extractPageTexts("jvcea-crypto-202607-koukai-01-full-8p.pdf")
    );
    const split = pages.map((p) => p.replace(/^2018 9 /m, "2018 9\n"));
    expect(split.join("\n")).not.toBe(pages.join("\n"));
    expect(() => parseJvceaCryptoText(split)).toThrow(/年・月だけ/);
  });
});

describe("parseJvceaCryptoUpdatedDate (PDF 印字の更新日)", () => {
  it("更新日が無いページがあれば throw する", () => {
    expect(() => parseJvceaCryptoUpdatedDate(["更新日：2026年9月3日", "更新日の無いページ"])).toThrow(
      /0 件/
    );
  });

  it("ページ間で更新日が食い違えば throw する (版の混在)", () => {
    expect(() =>
      parseJvceaCryptoUpdatedDate(["更新日：2026年9月3日", "更新日：2026年8月5日"])
    ).toThrow(/食い違い/);
  });
});

describe.skipIf(!hasFixtures)("parseJvceaCryptoUpdatedDate (PDF 印字の更新日, 実フィクスチャ)", () => {
  it("実 PDF (全8ページ→合算表2ページ) から更新日 2026-09-03 を得る", async () => {
    const pageTexts = await extractPageTexts("jvcea-crypto-202607-koukai-01-full-8p.pdf");
    expect(parseJvceaCryptoUpdatedDate(selectAggregateTablePages(pageTexts))).toBe("2026-09-03");
  });
});

describe.skipIf(!hasFixtures)("selectAggregateTablePages (実フィクスチャ、本番と同じ全8ページ入力の回帰テスト)", () => {
  // 回帰テスト: 本番の fetchJvceaCrypto() は unpdf extractText の結果 (実際に
  // 取得した全8ページぶんのテキスト、うち3ページ目以降は銘柄別内訳表で
  // 列構成が異なる) をそのまま parseJvceaCryptoText に渡していたため、
  // 3ページ目 (BTC 保有状況表、「年 月 ...」パターンにマッチしつつ列数が
  // 19 と異なる行を含む) で必ず throw していた (2026-09-27 実データで確認)。
  // フィクスチャをあらかじめ1〜2ページ目だけにトリミングしたテスト
  // (loadFixtureRows 系) だけでは、この本番専用の壊れ方を検知できない。

  it("全8ページの生テキストをそのまま渡すと (旧実装相当)、銘柄別内訳表の列数不一致で throw する", async () => {
    const pageTexts = await extractPageTexts("jvcea-crypto-202607-koukai-01-full-8p.pdf");
    expect(pageTexts).toHaveLength(8);
    expect(() => parseJvceaCryptoText(pageTexts)).toThrow(/数値列数/);
  });

  it("全8ページから合算表のページだけを絞り込むと2ページに絞られ、以後は解析可能", async () => {
    const pageTexts = await extractPageTexts("jvcea-crypto-202607-koukai-01-full-8p.pdf");
    const aggregatePages = selectAggregateTablePages(pageTexts);
    expect(aggregatePages).toHaveLength(2);
    const rows = parseJvceaCryptoText(aggregatePages);
    expect(rows).toHaveLength(95);
    const row2607 = rows.find((r) => r.period === "2026-07");
    expect(row2607).toBeDefined();
    // p1-2 版フィクスチャ (loadFixtureRows) のテストと同じ目視確認値。
    expect(row2607!.spotTurnoverJpy).toBe(674_240);
    expect(row2607!.marginPositionTotalJpy).toBe(18_477);
    const row1809 = rows.find((r) => r.period === "2018-09");
    expect(row1809).toBeDefined();
    expect(row1809!.spotTurnoverJpy).toBe(813_446);
  });
});

describe("selectAggregateTablePages (様式異常時は throw する)", () => {
  it("見出し行が1件も見つからなければ throw する (様式変更の疑い)", () => {
    expect(() => selectAggregateTablePages(["見出しの無い本文", "別の本文"])).toThrow(
      /列見出し行が見つかりません/
    );
  });
});

describe.skipIf(!hasFixtures)("fetchJvceaCrypto (本番経路。fetch だけを実フィクスチャ応答に差し替え)", () => {
  const INFO_URL = "https://jvcea.or.jp/statistics/information/";
  const PDF_URL =
    "https://jvcea.or.jp/cms2026/wp-content/uploads/2026/08/202607-KOUKAI-01-FINAL.pdf";
  const realHtml = () =>
    readFileSync(join(FIXTURES, "jvcea-statistics-information-20260927.html"), "utf-8");
  const realPdf = () =>
    new Uint8Array(readFileSync(join(FIXTURES, "jvcea-crypto-202607-koukai-01-full-8p.pdf")));

  function stubFetch(routes: Record<string, () => BodyInit>): string[] {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL) => {
      const u = String(url);
      calls.push(u);
      const body = routes[u];
      if (!body) return new Response("not found", { status: 404, statusText: "Not Found" });
      return new Response(body(), { status: 200 });
    });
    return calls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("実 HTML + 実 PDF (全8ページ) で成功し、2 リクエストのみで 95 か月分を返す", async () => {
    // 回帰テスト (反証レビュー high): 旧実装は全ページを parseJvceaCryptoText に
    // 渡しており、3 ページ目 (銘柄別内訳表) の列数不一致で必ず throw していた。
    const calls = stubFetch({ [INFO_URL]: realHtml, [PDF_URL]: realPdf });
    const data = await fetchJvceaCrypto();
    expect(calls).toEqual([INFO_URL, PDF_URL]);
    expect(data.latestMonth).toBe("2026-07");
    expect(data.updatedDate).toBe("2026-09-03");
    expect(data.pdfUrl).toBe(PDF_URL);
    expect(data.rows).toHaveLength(95);
    expect(data.rows.find((r) => r.period === "2026-07")!.spotTurnoverJpy).toBe(674_240);
  });

  it("返す pdfBytes は取得した PDF 実体そのもの (getDocumentProxy に detach されて空にならない)", async () => {
    // 回帰テスト: unpdf の getDocumentProxy は渡した Uint8Array の ArrayBuffer を
    // transfer して detach する (実測で byteLength が 0 になる)。原本を渡していた
    // 旧実装では pdfBytes が空になり、ルール6 の Notion 実体アップロードが
    // 「空ファイルはアップロードできません」で必ず失敗していた。
    const expected = realPdf();
    stubFetch({ [INFO_URL]: realHtml, [PDF_URL]: realPdf });
    const data = await fetchJvceaCrypto();
    expect(data.pdfBytes.byteLength).toBe(expected.byteLength);
    expect(Buffer.from(data.pdfBytes).equals(Buffer.from(expected))).toBe(true);
    const input = jvceaCryptoArchiveInput(data);
    expect(input.key).toBe("jvcea-crypto-2026-07-updated-2026-09-03");
    expect(input.files[0]!.bytes.byteLength).toBe(expected.byteLength);
  });

  it("ファイル名の最新月と PDF 本文の最新行の月が食い違えば throw する", async () => {
    // 一覧ページのリンク名だけが古い月 (202606) を指し、中身は 2026-07 まで
    // 収録している状況。旧実装は「2026-06 の行がある」だけで通していた。
    const staleUrl =
      "https://jvcea.or.jp/cms2026/wp-content/uploads/2026/08/202606-KOUKAI-01-FINAL.pdf";
    const html = realHtml().replaceAll(PDF_URL, staleUrl);
    stubFetch({ [INFO_URL]: () => html, [staleUrl]: realPdf });
    await expect(fetchJvceaCrypto()).rejects.toThrow(/一致しません/);
  });

  it("PDF 本文の最古行が累積表の起点 (2018-09) でなければ throw する (先頭行の抽出漏れ)", async () => {
    // 回帰テスト (2次レビュー): 最新月はファイル名と照合していたが、最古月は
    // 未照合で、先頭行が欠けても 94 行で成功扱いになっていた。ここでは実 PDF の
    // 2018-09 行だけを落とした抽出結果を extractText から返させて本番経路を通す。
    const actual = await vi.importActual<typeof import("unpdf")>("unpdf");
    let dropped = 0;
    vi.mocked(extractText).mockImplementationOnce((async (pdf: never) => {
      const r = await actual.extractText(pdf, { mergePages: false });
      const text = r.text.map((p) =>
        p.replace(/^2018 9 .*$/m, () => {
          dropped++;
          return "";
        })
      );
      return { ...r, text };
    }) as unknown as typeof extractText);
    stubFetch({ [INFO_URL]: realHtml, [PDF_URL]: realPdf });
    await expect(fetchJvceaCrypto()).rejects.toThrow(/起点 2018-09 と一致しません/);
    // 合算表 (2 ページ目) と銘柄別内訳表の 2018-09 行を落としている
    expect(dropped).toBeGreaterThanOrEqual(1);
  });

  it("PDF が HTTP エラーなら throw する", async () => {
    stubFetch({ [INFO_URL]: realHtml });
    await expect(fetchJvceaCrypto()).rejects.toThrow(/HTTP エラー: 404/);
  });
});

describe("parseLatestJvceaCryptoPdfUrl", () => {
  it("http:// のリンク (同ページの過去データで実際に混在) も拾い、YYYYMM 最大のものを採る", () => {
    // 旧実装は https:// 固定で、最新版だけ http:// で載ると古い https:// 版を
    // 黙って採る (または見つからず throw する) 恐れがあった。
    const html =
      '<a href="https://jvcea.or.jp/cms2026/wp-content/uploads/2026/08/202607-KOUKAI-01-FINAL.pdf">7月</a>' +
      '<a href="http://jvcea.or.jp/cms2026/wp-content/uploads/2026/09/202608-KOUKAI-01-FINAL.pdf">8月</a>';
    const info = parseLatestJvceaCryptoPdfUrl(html);
    expect(info.latestMonth).toBe("2026-08");
    expect(info.pdfUrl).toBe(
      "http://jvcea.or.jp/cms2026/wp-content/uploads/2026/09/202608-KOUKAI-01-FINAL.pdf"
    );
  });

  it("同じ最新 YYYYMM を指す別ファイルのリンクが複数あれば、出現順で黙って選ばず throw する", () => {
    // 回帰テスト (2次レビュー): 旧実装はページ内で後に出た方を黙って採っていた。
    const html =
      '<a href="https://jvcea.or.jp/cms2026/wp-content/uploads/2026/08/202607-KOUKAI-01-FINAL.pdf">a</a>' +
      '<a href="https://jvcea.or.jp/cms2026/wp-content/uploads/2026/09/202607-KOUKAI-01-FINAL.pdf">b</a>';
    expect(() => parseLatestJvceaCryptoPdfUrl(html)).toThrow(/複数の別ファイル/);
  });

  it("同一ファイルの重複掲載・http/https 表記揺れだけなら 1 件として扱う", () => {
    const path = "jvcea.or.jp/cms2026/wp-content/uploads/2026/08/202607-KOUKAI-01-FINAL.pdf";
    const html =
      `<a href="https://${path}">a</a><a href="https://${path}">b</a><a href="http://${path}">c</a>`;
    expect(parseLatestJvceaCryptoPdfUrl(html).latestMonth).toBe("2026-07");
  });

  it("リンクが1件も無ければ throw する (様式変更の疑い)", () => {
    expect(() => parseLatestJvceaCryptoPdfUrl("<html>no links here</html>")).toThrow(
      /リンクが/
    );
  });
});

describe.skipIf(!hasFixtures)("parseLatestJvceaCryptoPdfUrl (実フィクスチャ, 統計情報ページ)", () => {
  it("統計情報ページから最新の累積 PDF の URL と収録最新月を得る", () => {
    const html = readFileSync(
      join(FIXTURES, "jvcea-statistics-information-20260927.html"),
      "utf-8"
    );
    const info = parseLatestJvceaCryptoPdfUrl(html);
    expect(info.pdfUrl).toBe(
      "https://jvcea.or.jp/cms2026/wp-content/uploads/2026/08/202607-KOUKAI-01-FINAL.pdf"
    );
    expect(info.latestMonth).toBe("2026-07");
  });
});

describe("isJvceaCryptoMonthPublished (まだ公表されていない判定)", () => {
  it("対象月が最新公表月以前なら公表済み", () => {
    expect(isJvceaCryptoMonthPublished("2026-07", "2026-07")).toBe(true);
    expect(isJvceaCryptoMonthPublished("2026-06", "2026-07")).toBe(true);
  });

  it("対象月が最新公表月より先なら未公表 (2026-08 分はまだ出ていない)", () => {
    expect(isJvceaCryptoMonthPublished("2026-08", "2026-07")).toBe(false);
  });

  it("YYYY-MM 形式でなければ throw する", () => {
    expect(() => isJvceaCryptoMonthPublished("2026/08", "2026-07")).toThrow(/YYYY-MM/);
  });
});

describe("jvceaCryptoRowToObservations / JVCEA_CRYPTO_INDICATORS", () => {
  const sampleRow: JvceaCryptoRow = {
    period: "2026-07",
    spotTurnoverQty: 1,
    spotTurnoverJpy: 674_240,
    marginTurnoverQty: 1,
    marginTurnoverJpy: 627_529,
    depositsCryptoQty: 1,
    depositsCryptoJpy: 2_641_858,
    depositsCashJpy: 230_505,
    depositsTotalJpy: 2_872_363,
    depositsMarginJpy: 406_181,
    marginPositionSellQty: 1,
    marginPositionBuyQty: 1,
    marginPositionTotalQty: 1,
    marginPositionSellJpy: 4_119,
    marginPositionBuyJpy: 14_358,
    marginPositionTotalJpy: 18_477,
    accountsTotalEstablished: 14_280_598,
    accountsTotalActive: 8_858_935,
    accountsMarginEstablished: 2_238_288,
    accountsMarginActive: 1_015_983,
  };

  it("13指標ぶんの縦長レコードを返し、数量(参考値)は含めない", () => {
    const obs = jvceaCryptoRowToObservations(sampleRow);
    expect(obs).toHaveLength(13);
    for (const o of obs) {
      expect(o.period).toBe("2026-07");
      expect(o.category).toBe(JVCEA_CRYPTO_CATEGORY);
      expect(o.isApproximate).toBe(false);
      expect(o.isEstimated).toBe(false);
      expect(Number.isFinite(o.value)).toBe(true);
    }
    const byKey = Object.fromEntries(obs.map((o) => [o.indicatorKey, o]));
    expect(byKey["jvcea_crypto_spot_turnover_jpy"]!.value).toBe(674_240);
    expect(byKey["jvcea_crypto_margin_position_total_jpy"]!.value).toBe(18_477);
    expect(byKey["jvcea_crypto_accounts_total_established"]!.unit).toBe("口座");
  });

  it("観測ログが出す indicatorKey は、指標定義 (JVCEA_CRYPTO_INDICATORS) と過不足なく一致する", () => {
    const obsKeys = new Set(jvceaCryptoRowToObservations(sampleRow).map((o) => o.indicatorKey));
    const defKeys = new Set(JVCEA_CRYPTO_INDICATORS.map((d) => d.key));
    expect(obsKeys).toEqual(defKeys);
  });

  it("指標定義は key が重複しない", () => {
    const keys = JVCEA_CRYPTO_INDICATORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("指標定義は全てR3(資産クラス横断)要件を持つ", () => {
    for (const d of JVCEA_CRYPTO_INDICATORS) {
      expect(d.requirements).toContain("R3");
    }
  });

  // 回帰テスト: PDF 原本の脚注 (注1〜注3、2026-09-27 実データで本文確認済み)
  // は「他の交換業者等への取次ぎ」分の扱いがカテゴリごとに逆方向であることを
  // 明記している。
  //   注1 取引高      (現物・証拠金取引高)               → 含む   (二重計上の可能性)
  //   注2 利用者残高   (預託金残高・証拠金取引建玉残高)     → 含まない (過小に出うる)
  //   注3 利用者口座数 (設定/稼働、全体/証拠金)            → 含む   (口座単位の重複計上)
  // 単一の注記文を全指標に一律適用すると注1/注2で向きが逆になる。
  it("取引高系(2指標)の limitations は「含む・二重計上」(原本注1)", () => {
    const turnoverKeys = ["jvcea_crypto_spot_turnover_jpy", "jvcea_crypto_margin_turnover_jpy"];
    for (const key of turnoverKeys) {
      const def = JVCEA_CRYPTO_INDICATORS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.limitations).toContain("含むため");
      expect(def!.limitations).toContain("二重計上");
    }
  });

  it("預託金残高・建玉残高系(7指標)の limitations は「含まない」(原本注2、取引高とは逆方向)", () => {
    const balanceKeys = [
      "jvcea_crypto_deposits_crypto_jpy",
      "jvcea_crypto_deposits_cash_jpy",
      "jvcea_crypto_deposits_total_jpy",
      "jvcea_crypto_deposits_margin_jpy",
      "jvcea_crypto_margin_position_sell_jpy",
      "jvcea_crypto_margin_position_buy_jpy",
      "jvcea_crypto_margin_position_total_jpy",
    ];
    for (const key of balanceKeys) {
      const def = JVCEA_CRYPTO_INDICATORS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.limitations).toContain("含まない");
      // 取引高向けの「二重計上」文言をそのまま使い回していないこと。
      expect(def!.limitations).not.toContain("二重計上");
    }
  });

  it("利用者口座数系(4指標)の limitations は「含む」(原本注3、取引高とは別文言)", () => {
    const accountsKeys = [
      "jvcea_crypto_accounts_total_established",
      "jvcea_crypto_accounts_total_active",
      "jvcea_crypto_accounts_margin_established",
      "jvcea_crypto_accounts_margin_active",
    ];
    for (const key of accountsKeys) {
      const def = JVCEA_CRYPTO_INDICATORS.find((d) => d.key === key);
      expect(def).toBeDefined();
      expect(def!.limitations).toContain("含む");
      expect(def!.limitations).not.toContain("含まない");
      // 取引高向けの「取引高の二重計上」という的外れな文言を流用していないこと。
      expect(def!.limitations).not.toContain("取引高の二重計上");
    }
  });

  it("設定口座系の定義は「累計」「減らない」と説明しない", () => {
    for (const key of [
      "jvcea_crypto_accounts_total_established",
      "jvcea_crypto_accounts_margin_established",
    ]) {
      const def = JVCEA_CRYPTO_INDICATORS.find((d) => d.key === key)!;
      for (const text of [def.measures, def.plainDescription]) {
        expect(text).not.toContain("減らない");
        expect(text).not.toMatch(/累計(数|値)(?!ではなく)/);
      }
      expect(def.measures).toContain("月末時点");
    }
  });

  it("うち証拠金取引・稼働口座は「証拠金取引を実際に使った口座数」と断定しない (原本注4: 共用口座を含む)", () => {
    const def = JVCEA_CRYPTO_INDICATORS.find((d) => d.key === "jvcea_crypto_accounts_margin_active")!;
    expect(def.measures).toContain("共用");
    expect(def.plainDescription).toContain("共用");
    expect(def.plainDescription).not.toBe("その月に証拠金取引(レバレッジ取引)を実際に使った口座の数。");
  });

  it("全指標の limitations が原本注6 (Zaif への事業譲渡で未移行の利用者は対象外) を明記する", () => {
    expect(JVCEA_CRYPTO_INDICATORS).toHaveLength(13);
    for (const d of JVCEA_CRYPTO_INDICATORS) {
      expect(d.limitations, d.key).toContain("注6");
      expect(d.limitations, d.key).toContain("Zaif");
    }
  });

  it("現物取引高の定義は原本注8 (信用取引のうち取引所取引分を含む) を明記する", () => {
    const def = JVCEA_CRYPTO_INDICATORS.find((d) => d.key === "jvcea_crypto_spot_turnover_jpy")!;
    expect(def.measures).toContain("注8");
    expect(def.limitations).toContain("注8");
  });
});

describe.skipIf(!hasFixtures)("jvceaCryptoRowToObservations / JVCEA_CRYPTO_INDICATORS (実データ)", () => {
  // 回帰テスト (ルール7: 定義の正確さ): 旧定義は「設定口座」を「解約されても
  // 数は減らない累計値」と説明していたが、実データでは前月より減る月がある。
  it("実データ: 設定口座は累計値ではなく前月より減る月がある (2026-06 → 2026-07)", async () => {
    const rows = await loadFixtureRows();
    const jun = rows.find((r) => r.period === "2026-06")!;
    const jul = rows.find((r) => r.period === "2026-07")!;
    expect(jun.accountsTotalEstablished).toBe(14_443_385);
    expect(jul.accountsTotalEstablished).toBe(14_280_598);
    expect(jul.accountsTotalEstablished).toBeLessThan(jun.accountsTotalEstablished);
  });
});

describe("jvceaCryptoArchiveInput (ルール6の入力組み立て、記録自体はしない)", () => {
  const PDF_URL =
    "https://jvcea.or.jp/cms2026/wp-content/uploads/2026/08/202607-KOUKAI-01-FINAL.pdf";

  it("「収録最新月 + 更新日」の冪等キー + PDF実体で記録入力を組む", () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const input = jvceaCryptoArchiveInput({
      latestMonth: "2026-07",
      updatedDate: "2026-09-03",
      rows: [],
      pdfBytes: bytes,
      pdfUrl: PDF_URL,
    });
    expect(input.service).toBe("moneyflow");
    expect(input.key).toBe("jvcea-crypto-2026-07-updated-2026-09-03");
    expect(input.source).toBe(PDF_URL);
    expect(input.metadata).toMatchObject({ latestMonth: "2026-07", updatedDate: "2026-09-03", bytes: 4 });
    expect(input.files).toHaveLength(1);
    expect(input.files[0]!.filename).toBe("jvcea-crypto-2026-07-updated-2026-09-03.pdf");
    expect(input.files[0]!.bytes).toBe(bytes);
  });

  it("同じ収録最新月でも更新日が違う版 (訂正差し替え) は別キーになる", () => {
    // 回帰テスト: 旧キー `jvcea-crypto-YYYY-MM` では同月の差し替え版が
    // recordPrimaryData の skipped_existing で黙って捨てられていた。
    const base = { latestMonth: "2026-07", rows: [], pdfBytes: new Uint8Array([1]), pdfUrl: PDF_URL };
    const a = jvceaCryptoArchiveInput({ ...base, updatedDate: "2026-08-05" });
    const b = jvceaCryptoArchiveInput({ ...base, updatedDate: "2026-09-03" });
    expect(a.key).not.toBe(b.key);
  });

  it("PDF 実体が空なら throw する (空ファイルを記録済み扱いにしない)", () => {
    expect(() =>
      jvceaCryptoArchiveInput({
        latestMonth: "2026-07",
        updatedDate: "2026-09-03",
        rows: [],
        pdfBytes: new Uint8Array(0),
        pdfUrl: PDF_URL,
      })
    ).toThrow(/空です/);
  });
});
