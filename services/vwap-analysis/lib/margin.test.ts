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
import { describe, expect, it } from "vitest";
import { marginArchiveInput, parseMarginText } from "./margin.js";

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
