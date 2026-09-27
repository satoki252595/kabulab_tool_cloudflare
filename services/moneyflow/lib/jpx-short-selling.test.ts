/**
 * JPX「空売り集計・業種別集計」日次 PDF パーサのテスト。
 *
 * 実 PDF (2026-09-25 分) をフィクスチャに使う (services/moneyflow/tests/fixtures/README.md
 * 参照。personal-only のため repo には commit しない。未取得の環境では skip する)。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractText, getDocumentProxy } from "unpdf";
import { JPX_33_SECTORS } from "./sector-names.js";
import {
  aggregateMonthlyShortSellingRatio,
  latestShortSellingSectorPdfUrl,
  parseShortSellingSectorText,
} from "./jpx-short-selling.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("../tests/fixtures/jpx-short-selling-sector-20260925.pdf", import.meta.url)
);
const hasFixture = existsSync(FIXTURE_PATH);

describe.skipIf(!hasFixture)("parseShortSellingSectorText (実 PDF: 2026-09-25 分)", () => {
  it("実 PDF から抽出したテキストを解析し、実測値と一致する", async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE_PATH));
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });

    const data = parseShortSellingSectorText(text);

    expect(data.date).toBe("2026-09-25");
    expect(data.sectors).toHaveLength(33);

    const denki = data.sectors.find((s) => s.sector === "電気機器");
    expect(denki?.realOrder).toBe(1_971_606);
    expect(denki?.restrictedShort).toBe(902_200);
    expect(denki?.unrestrictedShort).toBe(416_524);
    expect(denki?.total).toBe(3_290_330);
    // (902,200 + 416,524) / 3,290,330
    expect(denki?.shortRatio).toBeCloseTo((902_200 + 416_524) / 3_290_330, 10);

    expect(data.other.total).toBe(309_956);
    expect(data.other.realOrder).toBe(188_203);
  });
});

describe("parseShortSellingSectorText (様式検証)", () => {
  it("日付が見つからなければ throw する", () => {
    expect(() => parseShortSellingSectorText("業種名だけのテキスト")).toThrow(/日付/);
  });

  it("「その他（33業種外）」行が無ければ throw する", () => {
    const rows = [
      "電気機器 1,000 50.0% 400 20.0% 100 10.0% 2,000",
    ].join(" ");
    expect(() => parseShortSellingSectorText(`2026年9月25日 ${rows}`)).toThrow(/33/);
  });
});

describe("aggregateMonthlyShortSellingRatio", () => {
  const other = { realOrder: 1, restrictedShort: 1, unrestrictedShort: 1, total: 3, shortRatio: 2 / 3 };

  /** 33 業種すべてを埋めた1日分を作る。「電気機器」だけ差し替え可能。 */
  function makeDay(date: string, denki: { realOrder: number; restrictedShort: number; unrestrictedShort: number; total: number }) {
    const filler = { realOrder: 100, restrictedShort: 10, unrestrictedShort: 10, total: 120 };
    return {
      date,
      sectors: JPX_33_SECTORS.map((sector) =>
        sector === "電気機器"
          ? { sector, ...denki, shortRatio: (denki.restrictedShort + denki.unrestrictedShort) / denki.total }
          : { sector, ...filler, shortRatio: 20 / 120 }
      ),
      other,
    };
  }

  it("加重平均で月次比率を求める (単純平均ではない)", () => {
    // 出来高の小さい日 (総額140) と大きい日 (総額1000) を混ぜる。単純平均なら
    // (40/140 + 100/1000)/2 ≈ 0.193 になるが、加重平均は (40+100)/(140+1000) ≈ 0.123。
    const dayA = makeDay("2026-09-01", { realOrder: 100, restrictedShort: 30, unrestrictedShort: 10, total: 140 });
    const dayB = makeDay("2026-09-02", { realOrder: 900, restrictedShort: 50, unrestrictedShort: 50, total: 1000 });

    const result = aggregateMonthlyShortSellingRatio([dayA, dayB]);

    expect(result.month).toBe("2026-09");
    const denki = result.sectors.find((s) => s.sector === "電気機器");
    expect(denki?.totalTurnover).toBe(140 + 1000);
    expect(denki?.tradingDays).toBe(2);
    expect(denki?.shortRatio).toBeCloseTo((40 + 100) / (140 + 1000), 10);
    // 単純平均の値とは異なることも確認する (加重平均であることの反証)。
    const simpleAverage = (40 / 140 + 100 / 1000) / 2;
    expect(denki?.shortRatio).not.toBeCloseTo(simpleAverage, 3);
  });

  it("当月の売買代金合計が 0 の業種は比率を 0 ではなく null にする", () => {
    const zero = makeDay("2026-09-01", { realOrder: 0, restrictedShort: 0, unrestrictedShort: 0, total: 0 });
    // makeDay は shortRatio を 0/0 で作るので、日次側の定義 (null) に合わせる
    const day = {
      ...zero,
      sectors: zero.sectors.map((s) => (s.sector === "電気機器" ? { ...s, shortRatio: null } : s)),
    };
    const result = aggregateMonthlyShortSellingRatio([day]);
    expect(result.sectors.find((s) => s.sector === "電気機器")?.shortRatio).toBeNull();
    expect(result.sectors.find((s) => s.sector === "銀行業")?.shortRatio).toBeCloseTo(20 / 120, 10);
  });

  it("空配列は throw する (0 件を 0 として返さない)", () => {
    expect(() => aggregateMonthlyShortSellingRatio([])).toThrow(/0 件/);
  });

  it("複数月が混在していれば throw する", () => {
    const dayA = makeDay("2026-09-01", { realOrder: 100, restrictedShort: 30, unrestrictedShort: 10, total: 140 });
    const dayC = makeDay("2026-10-01", { realOrder: 100, restrictedShort: 30, unrestrictedShort: 10, total: 140 });
    expect(() => aggregateMonthlyShortSellingRatio([dayA, dayC])).toThrow(/複数の月/);
  });

  it("一部の業種のデータが欠けていれば throw する (欠損を0で埋めない)", () => {
    const dayA = makeDay("2026-09-01", { realOrder: 100, restrictedShort: 30, unrestrictedShort: 10, total: 140 });
    const incomplete = { ...dayA, sectors: dayA.sectors.filter((s) => s.sector !== "銀行業") };
    expect(() => aggregateMonthlyShortSellingRatio([incomplete])).toThrow(/銀行業/);
  });
});

describe("latestShortSellingSectorPdfUrl (一覧ページの解析)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("「業種別集計」列 (-g.pdf) のリンクから文字列比較で最新のものを選ぶ (「空売り集計」列 -m.pdf は無視する)", async () => {
    const html = `
      <a href="/markets/statistics-equities/short-selling/260924-m.pdf">空売り集計</a>
      <a href="/markets/statistics-equities/short-selling/260924-g.pdf">業種別集計</a>
      <a href="/markets/statistics-equities/short-selling/260925-g.pdf">業種別集計</a>
    `;
    globalThis.fetch = vi.fn().mockResolvedValue({ text: async () => html }) as unknown as typeof fetch;

    const result = await latestShortSellingSectorPdfUrl();
    expect(result).toEqual({
      url: "https://www.jpx.co.jp/markets/statistics-equities/short-selling/260925-g.pdf",
      date: "2026-09-25",
    });
  });

  it("「業種別集計」リンクが1件も無ければ throw する", async () => {
    const html = `<a href="/markets/statistics-equities/short-selling/260925-m.pdf">空売り集計のみ</a>`;
    globalThis.fetch = vi.fn().mockResolvedValue({ text: async () => html }) as unknown as typeof fetch;
    await expect(latestShortSellingSectorPdfUrl()).rejects.toThrow(/業種別集計 PDF リンクが見つかりません/);
  });
});
