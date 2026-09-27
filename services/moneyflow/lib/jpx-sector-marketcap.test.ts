/**
 * JPX「株式時価総額」月次 PDF パーサのテスト。
 *
 * 実 PDF (2026年8月分) をフィクスチャに使う (services/moneyflow/tests/fixtures/README.md
 * 参照。personal-only のため repo には commit しない。未取得の環境では skip する
 * — pipeline/tests/conftest.py の fixture_path() skip パターンと同じ考え方)。
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractText, getDocumentProxy } from "unpdf";
import {
  parseSectorMarketCapText,
  latestSectorMarketCapPdfUrl,
  sectorMarketCapPeriodFromYearMonth,
  sectorMarketCapKey,
} from "./jpx-sector-marketcap.js";

const FIXTURE_PATH = fileURLToPath(
  new URL("../tests/fixtures/jpx-sector-marketcap-202608.pdf", import.meta.url)
);
const hasFixture = existsSync(FIXTURE_PATH);

describe.skipIf(!hasFixture)("parseSectorMarketCapText (実 PDF: 2026年8月分)", () => {
  it("実 PDF から抽出したテキストを解析し、実測値と一致する", async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE_PATH));
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });

    const data = parseSectorMarketCapText(text);

    expect(data.asOfDate).toBe("2026-08-31");
    expect(data.sectors).toHaveLength(33);

    const denki = data.sectors.find((s) => s.sector === "電気機器");
    expect(denki).toEqual({ sector: "電気機器", companies: 123, marketCapMillionYen: 279_083_685 });

    const suisan = data.sectors.find((s) => s.sector === "水産・農林業");
    expect(suisan).toEqual({ sector: "水産・農林業", companies: 6, marketCapMillionYen: 961_105 });

    expect(data.segments.prime).toEqual({ companies: 1_549, marketCapMillionYen: 1_368_732_387 });
    expect(data.segments.standard).toEqual({ companies: 1_555, marketCapMillionYen: 34_769_462 });
    expect(data.segments.growth).toEqual({ companies: 596, marketCapMillionYen: 10_607_309 });
    expect(data.segments.tokyoProMarket).toEqual({ companies: 187, marketCapMillionYen: 351_983 });
    expect(data.segments.total).toEqual({ companies: 3_887, marketCapMillionYen: 1_414_461_142 });

    // プライム 33 業種の社数合計はプライム区分計と一致する。時価総額は JPX 側の
    // 丸め (実測: 33業種合計 1,368,732,373 百万円 vs プライム区分計 1,368,732,387
    // 百万円、差 14 百万円) でぴったりは一致しないため、社数のみ厳密一致で見る
    // (パーサが値を捏造/欠落させていないことの確認が目的で、出典側の丸め誤差を
    // 呼び出し側で補正はしない — ルール2)。
    const sumCompanies = data.sectors.reduce((s, r) => s + r.companies, 0);
    expect(sumCompanies).toBe(data.segments.prime.companies);
  });
});

describe("parseSectorMarketCapText (様式検証)", () => {
  it("基準日が見つからなければ throw する", () => {
    expect(() => parseSectorMarketCapText("業種名 数値だけのテキスト")).toThrow(/基準日/);
  });

  it("業種が33件に満たなければ throw する (様式変更の疑い)", () => {
    const text = "(2026年8月31日現在) 電気機器 123 279,083,685 プライム 1 1 スタンダード 1 1 グロース 1 1 TOKYO PRO Market 1 1 合 計 1 1";
    expect(() => parseSectorMarketCapText(text)).toThrow(/33/);
  });
});

describe("sectorMarketCapPeriodFromYearMonth / sectorMarketCapKey", () => {
  it("YYYYMM を YYYY-MM に変換し、アーカイブキーを組み立てる", () => {
    expect(sectorMarketCapPeriodFromYearMonth("202608")).toBe("2026-08");
    expect(sectorMarketCapKey("2026-08")).toBe("jpx-sector-marketcap-2026-08");
  });
});

describe("latestSectorMarketCapPdfUrl (一覧ページの解析)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("複数の年月のリンクから文字列比較で最新のものを選ぶ", async () => {
    const html = `
      <a href="/markets/statistics-equities/misc/202606.pdf">2026年6月分</a>
      <a href="/markets/statistics-equities/misc/202608.pdf">2026年8月分</a>
      <a href="/markets/statistics-equities/misc/202607.pdf">2026年7月分</a>
    `;
    globalThis.fetch = vi.fn().mockResolvedValue({ text: async () => html }) as unknown as typeof fetch;

    const result = await latestSectorMarketCapPdfUrl();
    expect(result).toEqual({
      url: "https://www.jpx.co.jp/markets/statistics-equities/misc/202608.pdf",
      yearMonth: "202608",
    });
  });

  it("リンクが1件も無ければ throw する", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ text: async () => "<html>no links here</html>" }) as unknown as typeof fetch;
    await expect(latestSectorMarketCapPdfUrl()).rejects.toThrow(/PDF リンクが見つかりません/);
  });
});
