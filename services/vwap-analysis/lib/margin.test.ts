/**
 * JPX 信用残 PDF パーサ (parseMarginText) の銘柄コード規則。
 *
 * stockStock `tests/test_jpx_margin.py::TestFiveCharCodeToKey` と**同じ合成入力・
 * 同じ期待値**。R2 `margin/{date}.json` の writer は移行期に両リポにあり、同じ PDF
 * から同じバイト列を書くことが要件なので、片方だけ直すと出力が割れる。
 *
 * 行の形 (5桁コード + ISIN + 数値) だけ実 PDF に合わせ、銘柄名・ISIN・数値は架空。
 * 種類株が普通株の直後に並ぶ並びは実 PDF と同じ (2026-08-28 / 09-04 の実測では
 * 衝突 6 組すべてで普通株が先)。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  dailyMarginArchiveInput,
  dailyMarginPdfUrlForDateFromHtml,
  extractDailyMarginPdfLinks,
  extractMarginPdfLinks,
  latestDailyMarginPdfUrlFromHtml,
  latestMarginPdfUrlFromHtml,
  marginArchiveInput,
  marginPdfUrlForWeekFromHtml,
  parseDailyMarginPdf,
  parseMarginPdf,
  parseMarginText,
  validateMarginData,
  weeksMissing,
} from "./margin.js";

const sha256 = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");

const SYNTHETIC_TEXT = `2026/9/4 申込み現在 End-of-week outstanding margin trading by issue
B 合成食品\u3000普通株式 25930 JP0000000011 1,000 ▲ 100 2,000 200 0 0 1,000 ▲ 100 0 0 2,000 200
B 株式会社合成食品第１種優先株式 25935 JP0000000029 10 0 20 ▲ 5 0 0 10 0 0 0 20 ▲ 5
B 合成通信\u3000普通株式 94340 JP0000000037 3,000 300 4,000 ▲ 400 0 0 3,000 300 0 0 4,000 ▲ 400
B 合成通信株式会社第１回社債型種類株式 94345 JP0000000045 0 0 30 3 0 0 0 0 0 0 30 3
B 合成通信株式会社第２回社債型種類株式 94346 JP0000000052 0 0 0 0 0 0 0 0 0 0 0 0
J 合成ＴＯＰＩＸ連動型上場投信\u3000受益証券12020 JP0000000060 5,000 50 6,000 60 0 0 5,000 50 0 0 6,000 60
B 合成新興\u3000普通株式 130A0 JP0000000078 7 ▲ 1 8 1 0 0 7 ▲ 1 0 0 8 1
`;

const EXPECTED = [
  { code: "2593", sell: 1000, sell_chg: -100, buy: 2000, buy_chg: 200 },
  { code: "25935", sell: 10, sell_chg: 0, buy: 20, buy_chg: -5 },
  { code: "9434", sell: 3000, sell_chg: 300, buy: 4000, buy_chg: -400 },
  { code: "94345", sell: 0, sell_chg: 0, buy: 30, buy_chg: 3 },
  { code: "94346", sell: 0, sell_chg: 0, buy: 0, buy_chg: 0 },
  { code: "1202", sell: 5000, sell_chg: 50, buy: 6000, buy_chg: 60 },
  { code: "130A", sell: 7, sell_chg: -1, buy: 8, buy_chg: 1 },
];

describe("parseMarginText の 5 桁コード規則", () => {
  it("合成行を期待値どおりに解析する (stockStock と同一の期待値)", () => {
    const data = parseMarginText(SYNTHETIC_TEXT);
    expect(data.week).toBe("2026-09-04");
    // R2 の JSON はキー順も含めて比較されるので、toEqual ではなく直列化で比べる。
    expect(JSON.stringify(data.rows.map((r) => ({
      code: r.code, sell: r.sell, sell_chg: r.sell_chg, buy: r.buy, buy_chg: r.buy_chg,
    })))).toBe(JSON.stringify(EXPECTED));
  });

  it("種類株を普通株のコードへ潰さない (旧実装は 25930/25935 を両方 2593 にしていた)", () => {
    const codes = parseMarginText(SYNTHETIC_TEXT).rows.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("行を落とさない (sourceCodeToTicker だと種類株 3 行を落とす)", () => {
    expect(parseMarginText(SYNTHETIC_TEXT).rows).toHaveLength(7);
  });

  it("/api/margin の 4 文字コード検索 (先頭一致) は普通株の行を返し続ける", () => {
    const rows = parseMarginText(SYNTHETIC_TEXT).rows;
    expect(rows.find((r) => r.code === "2593")?.sell).toBe(1000);
    expect(rows.find((r) => r.code === "9434")?.sell).toBe(3000);
  });
});

/**
 * テスト入力用の最小 PDF (1 ページ・Helvetica で 1 行) をその場で組み立てる。
 * moneyflow の pdf-text.test.ts と同じ作り (信用残の様式は含まない)。
 */
function tinyPdf(text: string): Uint8Array {
  const content = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe("parseMarginPdf のバイト列不変性 (#117)", () => {
  it("解析後も入力バイト列が nonzero かつ SHA 不変 (unpdf の detach 対策)", async () => {
    const bytes = tinyPdf("margin detach check");
    const before = { len: bytes.byteLength, sha: sha256(bytes) };
    expect(before.len).toBeGreaterThan(0);
    // 様式外 PDF なので解析結果は空でよい。重要なのは入力の不変性。
    const parsed = await parseMarginPdf(bytes);
    expect(parsed.week).toBe("");
    expect(parsed.rows).toEqual([]);
    // 旧実装 (getDocumentProxy へ直渡し) では 0 になる。コピーを渡すので不変。
    expect(bytes.byteLength).toBe(before.len);
    expect(sha256(bytes)).toBe(before.sha);
  });

  it("Notion アップロード引数は解析後も原本そのもの (空判定を通過できる)", async () => {
    const bytes = tinyPdf("margin upload arg check");
    const parsed = await parseMarginPdf(bytes);
    // fetchMargin と同じ組み立て (pdfBytes には解析に使った bytes を渡す)。
    const input = marginArchiveInput({
      ...parsed,
      week: "2026-09-18",
      pdfBytes: bytes,
      pdfUrl: "https://www.jpx.co.jp/markets/statistics-equities/margin/05.html",
    });
    expect(input.files[0]!.filename).toBe("margin-2026-09-18.pdf");
    expect(input.files[0]!.bytes).toBe(bytes);
    expect(input.files[0]!.bytes.byteLength).toBeGreaterThan(0);
  });
});

// 実 PDF (2026-09-18 週 = #117 で落ちた週そのもの) をフィクスチャに使う。
// services/vwap-analysis/tests/fixtures/README.md 参照。personal-only のため
// repo には commit しない。未取得の環境では skip する。
const FIXTURE_PATH = fileURLToPath(
  new URL("../tests/fixtures/jpx-margin-weekly-20260918.pdf", import.meta.url)
);
const hasFixture = existsSync(FIXTURE_PATH);

describe.skipIf(!hasFixture)("parseMarginPdf (実 PDF: 2026-09-18 週 #117)", () => {
  // 下の数値は実 PDF の実測値 (2026-09-28 確認)。フィクスチャを差し替えたら更新すること。
  const FIXTURE_BYTES = 873311;
  const FIXTURE_SHA256 =
    "21c99f4e06641cae0270bd8151c41d45559e28a08f165a829726b9601c52131d";

  it("実原本が解析後も nonzero かつ SHA 不変で、アップロード引数と一致する", async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE_PATH));
    expect(bytes.byteLength).toBe(FIXTURE_BYTES);
    expect(sha256(bytes)).toBe(FIXTURE_SHA256);

    const parsed = await parseMarginPdf(bytes);
    expect(parsed.week).toBe("2026-09-18");
    expect(parsed.rows.length).toBe(4230);

    expect(bytes.byteLength).toBe(FIXTURE_BYTES);
    expect(sha256(bytes)).toBe(FIXTURE_SHA256);

    const input = marginArchiveInput({
      ...parsed,
      pdfBytes: bytes,
      pdfUrl: "https://www.jpx.co.jp/markets/statistics-equities/margin/05.html",
    });
    expect(input.key).toBe("jpx-margin-2026-09-18");
    expect(input.files[0]!.filename).toBe("margin-2026-09-18.pdf");
    expect(input.files[0]!.bytes).toBe(bytes);
    expect(input.files[0]!.bytes.byteLength).toBe(FIXTURE_BYTES);
  });
});

/**
 * 一覧ページの発見経路 (2026-09-28 実測)。
 * 週末残高 PDF は 05.html から 01.html (銘柄別信用取引残高) へ移転し、
 * 05.html は信用取引現在高表のみ (syumatsu 0 件) になった。
 * 下の HTML は実ページのリンク構造だけを写した合成断片 (全文ではない)。
 */
const HTML_01 = `
<a href="/markets/statistics-equities/margin/01.html">銘柄別信用取引残高</a>
<a href="/markets/statistics-equities/margin/tvdivq0000001rnl-att/20260925_mtall.pdf">PDF</a>
<a href="/markets/statistics-equities/margin/tvdivq0000001rnl-att/syumatsu2026082800.pdf">PDF</a>
<a href="/markets/statistics-equities/margin/tvdivq0000001rnl-att/syumatsu2026090400.pdf">PDF</a>
<a href="/markets/statistics-equities/margin/tvdivq0000001rnl-att/syumatsu2026091100.pdf">PDF</a>
<a href="/markets/statistics-equities/margin/tvdivq0000001rnl-att/syumatsu2026091800.pdf">PDF</a>
`;
const HTML_05_RENEWED = `
<a href="/markets/statistics-equities/margin/05.html">信用取引現在高過去推移表</a>
<a href="/markets/statistics-equities/margin/tvdivq0000001rq1-att/tvdivq000001597x.pdf">PDF</a>
<a href="/markets/statistics-equities/margin/tvdivq0000001rq1-att/tvdivq000001595z.xls">XLS</a>
`;

describe("margin 発見経路 (一覧 HTML→PDF URL)", () => {
  it("syumatsu リンクだけを抜き出す (現在高表の tvdivq 添付は拾わない)", () => {
    const links = extractMarginPdfLinks(HTML_01);
    expect(links.map((l) => l.stamp)).toEqual([
      "2026082800",
      "2026090400",
      "2026091100",
      "2026091800",
    ]);
  });

  it("最新週の URL を返す (01.html 移転後の形)", () => {
    expect(latestMarginPdfUrlFromHtml(HTML_01)).toBe(
      "https://www.jpx.co.jp/markets/statistics-equities/margin/tvdivq0000001rnl-att/syumatsu2026091800.pdf"
    );
  });

  it("syumatsu が 0 件なら throw する (05.html 移転後の形を検出する)", () => {
    expect(extractMarginPdfLinks(HTML_05_RENEWED)).toEqual([]);
    expect(() => latestMarginPdfUrlFromHtml(HTML_05_RENEWED)).toThrow(/margin pdf link not found/);
  });

  it("指定週の URL を返す (--week の解決)", () => {
    expect(marginPdfUrlForWeekFromHtml(HTML_01, "20260904")).toBe(
      "https://www.jpx.co.jp/markets/statistics-equities/margin/tvdivq0000001rnl-att/syumatsu2026090400.pdf"
    );
  });

  it("指定週が一覧に無ければ throw し、最新週で代用しない", () => {
    expect(() => marginPdfUrlForWeekFromHtml(HTML_01, "20260703")).toThrow(/該当週がありません/);
  });

  it("指定週の形式が違えば throw する", () => {
    expect(() => marginPdfUrlForWeekFromHtml(HTML_01, "2026-09-04")).toThrow(/形式が不正/);
  });
});

const HTML_01_DAILY = `
<a href="/markets/statistics-equities/margin/01.html">銘柄別信用取引残高</a>
<a href="/markets/statistics-equities/margin/tvdivq0000001rnl-att/20260925_mtall.pdf">PDF</a>
<a href="/markets/statistics-equities/margin/tvdivq0000001rnl-att/20260928_mtall.pdf">PDF</a>
<a href="/markets/statistics-equities/margin/tvdivq0000001rnl-att/syumatsu2026091800.pdf">PDF</a>
`;

describe("margin 日次発見経路 (一覧 HTML→mtall PDF URL)", () => {
  it("mtall リンクだけを抜き出す (syumatsu は拾わない)", () => {
    expect(extractDailyMarginPdfLinks(HTML_01_DAILY).map((l) => l.stamp)).toEqual([
      "20260925",
      "20260928",
    ]);
  });

  it("最新の URL を返す", () => {
    expect(latestDailyMarginPdfUrlFromHtml(HTML_01_DAILY)).toBe(
      "https://www.jpx.co.jp/markets/statistics-equities/margin/tvdivq0000001rnl-att/20260928_mtall.pdf"
    );
  });

  it("mtall が 0 件なら throw する", () => {
    expect(extractDailyMarginPdfLinks(HTML_05_RENEWED)).toEqual([]);
    expect(() => latestDailyMarginPdfUrlFromHtml(HTML_05_RENEWED)).toThrow(/margin daily pdf link not found/);
  });

  it("指定基準日の URL を返す (--date の解決。該当なしは最新で代用しない)", () => {
    expect(dailyMarginPdfUrlForDateFromHtml(HTML_01_DAILY, "20260925")).toBe(
      "https://www.jpx.co.jp/markets/statistics-equities/margin/tvdivq0000001rnl-att/20260925_mtall.pdf"
    );
    expect(() => dailyMarginPdfUrlForDateFromHtml(HTML_01_DAILY, "20260926")).toThrow(/該当基準日がありません/);
    expect(() => dailyMarginPdfUrlForDateFromHtml(HTML_01_DAILY, "2026-09-25")).toThrow(/形式が不正/);
  });
});

// 実 PDF (日次 2026-09-28 分) をフィクスチャに使う。personal-only のため
// repo には commit しない。未取得の環境では skip する。
const DAILY_FIXTURE_PATH = fileURLToPath(
  new URL("../tests/fixtures/jpx-margin-daily-20260928.pdf", import.meta.url)
);
const hasDailyFixture = existsSync(DAILY_FIXTURE_PATH);

describe.skipIf(!hasDailyFixture)("parseDailyMarginPdf (実 PDF: 日次 2026-09-28)", () => {
  // 下の数値は実 PDF の実測値 (2026-09-29 確認)。フィクスチャを差し替えたら更新すること。
  const FIXTURE_BYTES = 1795979;
  const FIXTURE_SHA256 = "7a0c2e21b8c8e545c79ca84d81a1cad43f424b7d88760947b0cc7151f12ce314";

  it("実原本 4259 行を全ガード通過で解析し、バイト列不変で保管引数と一致する", async () => {
    const bytes = new Uint8Array(readFileSync(DAILY_FIXTURE_PATH));
    expect(bytes.byteLength).toBe(FIXTURE_BYTES);
    expect(sha256(bytes)).toBe(FIXTURE_SHA256);
    const snapshot = await parseDailyMarginPdf(bytes, {
      sourceUrl: "https://www.jpx.co.jp/markets/statistics-equities/margin/01.html",
      rawSha256: FIXTURE_SHA256,
      rawPageId: null,
    });
    expect(snapshot.basisDate).toBe("2026-09-28");
    expect(snapshot.publicationDate).toBe("2026-09-29");
    expect(snapshot.rows).toHaveLength(4259);
    expect(snapshot.totals).toHaveLength(19);
    expect(bytes.byteLength).toBe(FIXTURE_BYTES);
    expect(sha256(bytes)).toBe(FIXTURE_SHA256);

    const input = dailyMarginArchiveInput({
      snapshot: { ...snapshot, rawPageId: null },
      pdfBytes: bytes,
      pdfUrl: "https://www.jpx.co.jp/x.pdf",
    });
    expect(input.key).toBe("jpx-margin-daily-2026-09-28");
    expect(input.files[0]!.filename).toBe("margin-daily-2026-09-28.pdf");
    expect(input.files[0]!.bytes).toBe(bytes);
    expect(input.metadata).toMatchObject({ basisDate: "2026-09-28", publicationDate: "2026-09-29", rowCount: 4259 });
  });
});

describe("weeksMissing (欠落週の検出)", () => {
  it("末尾の欠落を列挙する", () => {
    expect(weeksMissing(["2026-06-12", "2026-06-19", "2026-06-26"], "2026-07-17")).toEqual([
      "2026-07-03",
      "2026-07-10",
    ]);
  });

  it("区間内部の欠落も検出する (7/3・7/10 の実例: 保存済みに挟まれた欠落)", () => {
    // 実 R2 margin/weeks.json の 13 週 (7/3・7/10 だけ欠落)。
    const saved13 = [
      "2026-06-12", "2026-06-19", "2026-06-26", "2026-07-17", "2026-07-24",
      "2026-07-31", "2026-08-07", "2026-08-14", "2026-08-21", "2026-08-28",
      "2026-09-04", "2026-09-11", "2026-09-18",
    ];
    expect(weeksMissing(saved13, "2026-09-18")).toEqual(["2026-07-03", "2026-07-10"]);
  });

  it("--week の過去週補修でも内部欠落は報告する (今回週は除く)", () => {
    expect(weeksMissing(["2026-06-26", "2026-09-18"], "2026-08-28")).toEqual([
      "2026-07-03",
      "2026-07-10",
      "2026-07-17",
      "2026-07-24",
      "2026-07-31",
      "2026-08-07",
      "2026-08-14",
      "2026-08-21",
      "2026-09-04",
      "2026-09-11",
    ]);
  });

  it("連続週・再実行・初回は空", () => {
    expect(weeksMissing(["2026-09-04", "2026-09-11"], "2026-09-18")).toEqual([]);
    expect(weeksMissing(["2026-09-18"], "2026-09-18")).toEqual([]);
    expect(weeksMissing([], "2026-09-18")).toEqual([]);
  });

  it("形式が違えば throw する", () => {
    expect(() => weeksMissing(["2026-09-11"], "20260918")).toThrow(/形式が不正/);
    expect(() => weeksMissing(["2026/09/11"], "2026-09-18")).toThrow(/形式が不正/);
  });
});

describe("validateMarginData (保存前の検証)", () => {
  const good = {
    week: "2026-09-18",
    rows: [{ code: "7203", sell: 1, sell_chg: 0, buy: 2, buy_chg: 0 }],
    pdfBytes: new Uint8Array([1, 2, 3]),
    pdfUrl: "https://www.jpx.co.jp/x.pdf",
  };

  it("正常なら何もしない", () => {
    expect(() => validateMarginData(good)).not.toThrow();
  });

  it("週・行・原本のいずれかが空なら throw する", () => {
    expect(() => validateMarginData({ ...good, week: "" })).toThrow(/申込週/);
    expect(() => validateMarginData({ ...good, rows: [] })).toThrow(/0 件/);
    expect(() => validateMarginData({ ...good, pdfBytes: new Uint8Array(0) })).toThrow(/原本バイト列/);
  });

  it("同一コードの複数行 (種類株崩壊の取込) は保存させず throw する", () => {
    const dup = {
      ...good,
      rows: [
        { code: "2593", sell: 77200, sell_chg: 0, buy: 244500, buy_chg: 0 },
        { code: "2593", sell: 100, sell_chg: 0, buy: 17500, buy_chg: 0 },
      ],
    };
    expect(() => validateMarginData(dup)).toThrow(/duplicate code.*2593/);
  });
});

describe("marginArchiveInput (ルール6)", () => {
  it("週次冪等キー + PDF 実体で記録入力を組む", () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const input = marginArchiveInput({
      week: "2026-09-18",
      rows: [{ code: "1001", sell: 1, buy: 2, sell_chg: 0, buy_chg: 0 }],
      pdfBytes: bytes,
      pdfUrl: "https://www.jpx.co.jp/x/syumatsu20260918.pdf",
    });
    expect(input.service).toBe("vwap-analysis");
    expect(input.key).toBe("jpx-margin-2026-09-18");
    expect(input.source).toBe("https://www.jpx.co.jp/x/syumatsu20260918.pdf");
    expect(input.metadata).toMatchObject({ week: "2026-09-18", rowCount: 1 });
    expect(input.files).toHaveLength(1);
    expect(input.files[0]!.filename).toBe("margin-2026-09-18.pdf");
    expect(input.files[0]!.bytes).toBe(bytes);
  });
});
