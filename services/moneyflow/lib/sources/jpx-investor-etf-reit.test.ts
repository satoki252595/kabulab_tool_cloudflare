/**
 * jpx-investor-etf-reit.ts のテスト。
 *
 * フィクスチャは JPX 一覧ページ (investor-type/02.html, 03.html) から
 * 2026-09-27 に実際にダウンロードした本物のファイル (`fixtures/etf_m2608.xls`
 * `fixtures/reit_m2608.xls`)。検証値は同じ JPX が配布する PDF 版
 * (`etf_m2608.pdf` / `reit_m2608.pdf`, unpdf でテキスト抽出) と突き合わせて
 * 一致を確認済みの実測値 (2026年8月, 8/3〜8/31)。架空値は使わない。
 *
 * `fixtures/*_sample-new-format.xlsx` は JPX が
 * investor-type/02.html, 03.html 上で「2026年10月13日掲載分からの新様式」
 * として公式に先行公開しているサンプルファイルそのもの (再ダウンロード)。
 * 中の数値は JPX 自身のプレースホルダ例示であり実際の取引結果ではないため、
 * 「現行パーサがこれを渡されたら明示的に throw する」ことの確認にのみ使う
 * (実測値としては扱わない)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expectedJpxInvestorYearMonth,
  jpxInvestorArchiveInput,
  jpxInvestorIndicatorDefinitions,
  parseJpxInvestorMonthLinks,
  parseJpxInvestorWorkbook,
  resolveJpxInvestorPublicationStatus,
  toJpxInvestorObservationRows,
  type JpxInvestorWorkbookFile,
} from "./jpx-investor-etf-reit.js";

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

function loadFixtureBytes(filename: string): Uint8Array {
  return new Uint8Array(readFileSync(`${FIXTURES_DIR}${filename}`));
}

function loadFixtureText(filename: string): string {
  return readFileSync(`${FIXTURES_DIR}${filename}`, "utf-8");
}

describe("parseJpxInvestorWorkbook — ETF (実ファイル etf_m2608.xls, 2026年8月)", () => {
  const bytes = loadFixtureBytes("etf_m2608.xls");
  const report = parseJpxInvestorWorkbook(
    bytes,
    "etf",
    "https://www.jpx.co.jp/markets/statistics-equities/investor-type/t13vrt000001xy39-att/etf_m2608.xls"
  );

  it("対象期間を正しく読む", () => {
    expect(report.yearMonth).toBe("2026-08");
    expect(report.value.rangeStart).toBe("2026-08-03");
    expect(report.value.rangeEnd).toBe("2026-08-31");
  });

  it("総売買代金 (金額シート) が原本 (xls・PDF双方) と一致する", () => {
    // PDF (etf_m2608.pdf, unpdf抽出) より: "14,633,061,770 99.47% 3.62% 95.85%"
    expect(report.value.marketTotal).toBe(14_633_061_770);
    expect(report.value.unit).toBe("thousand_yen");
  });

  it("海外投資家 (Foreigners) の金額を原本と一致させ、買い越しと判定する", () => {
    // PDF より: "海外投資家 売り Sales 3,932,263,296 55.64 Foreigners 買い Purchases 4,061,605,020 58.36 129,341,724"
    const foreigners = report.value.categories.find((c) => c.category === "海外投資家");
    expect(foreigners).toBeDefined();
    expect(foreigners?.sales).toBe(3_932_263_296);
    expect(foreigners?.purchases).toBe(4_061_605_020);
    expect(foreigners?.balance).toBe(129_341_724);
    expect(foreigners?.balance).toBeGreaterThan(0); // 買い越し
  });

  it("個人 (Individuals) の差引を原本と一致させ、売り越しと判定する", () => {
    // PDF より: "個 人 売り Sales 2,521,010,902 35.67 個人 買い Purchases 2,482,254,533 35.67 -38,756,369"
    const individuals = report.value.categories.find((c) => c.category === "個人");
    expect(individuals?.balance).toBe(-38_756_369);
    expect(individuals?.balance).toBeLessThan(0); // 売り越し
  });

  it("総売買高 (口数シート) が原本と一致する", () => {
    // PDF (Volume) より: "111,242,010 99.34% 3.10% 96.23%"
    expect(report.volume.marketTotal).toBe(111_242_010);
    expect(report.volume.unit).toBe("lot_100units");
  });

  it("カテゴリの合計が売り+買いと一致する不変条件を保つ", () => {
    for (const c of [...report.value.categories, ...report.volume.categories]) {
      expect(c.total).toBe(c.sales + c.purchases);
      expect(c.balance).toBe(c.purchases - c.sales);
    }
  });

  it("marketTotal は投資部門別「総計」(資本金30億円以上の参加者限定) とは母集団が異なり一致しない", () => {
    // 総計 = 自己計 + 委託計 (資本金30億円以上の取引参加者のみを対象とした投資部門別集計)。
    // marketTotal (シート冒頭の総売買代金) はそれより広い市場参加者全体の実測合計であり、
    // 同じ値にはならない (実測ではおおむね0.5%前後 marketTotal の方が大きい)。
    const total = report.value.categories.find((c) => c.group === null && c.category === "総計");
    expect(total).toBeDefined();
    expect(total?.total).not.toBe(report.value.marketTotal);
    expect(report.value.marketTotal).toBeGreaterThan(total!.total);
    const diffRatio = (report.value.marketTotal - total!.total) / report.value.marketTotal;
    expect(diffRatio).toBeGreaterThan(0);
    expect(diffRatio).toBeLessThan(0.01); // 差はおおむね0.5%前後 (1%未満)
  });
});

describe("parseJpxInvestorWorkbook — REIT (実ファイル reit_m2608.xls, 2026年8月)", () => {
  const bytes = loadFixtureBytes("reit_m2608.xls");
  const report = parseJpxInvestorWorkbook(
    bytes,
    "reit",
    "https://www.jpx.co.jp/markets/statistics-equities/investor-type/t13vrt000001xyd5-att/reit_m2608.xls"
  );

  it("総売買代金が原本 (xls・PDF双方) と一致する", () => {
    // PDF (reit_m2608.pdf) より: "2,163,190,582 99.48% 20.97% 78.51%"
    expect(report.value.marketTotal).toBe(2_163_190_582);
  });

  it("海外投資家の差引を原本と一致させ、売り越しと判定する", () => {
    // PDF より: "海外投資家 売り Sales 618,580,397 72.14 Foreigners 買い Purchases 552,571,005 65.72 -66,009,392"
    const foreigners = report.value.categories.find((c) => c.category === "海外投資家");
    expect(foreigners?.sales).toBe(618_580_397);
    expect(foreigners?.purchases).toBe(552_571_005);
    expect(foreigners?.balance).toBe(-66_009_392);
  });

  it("法人 (Institutions) の差引を原本と一致させ、買い越しと判定する", () => {
    // PDF より: "法 人 売り Sales 149,324,755 17.41 Institutions 買い Purchases 186,499,557 22.18 37,174,802"
    const institutions = report.value.categories.find(
      (c) => c.category === "法人" && c.group?.includes("委託内訳")
    );
    expect(institutions?.balance).toBe(37_174_802);
  });

  it("REITの口数単位は百口ではなく口 (1単位) である (ETFとの違い)", () => {
    expect(report.volume.unit).toBe("unit");
    // PDF (Volume) より総売買高: "20,100,112"
    expect(report.volume.marketTotal).toBe(20_100_112);
  });
});

describe("parseJpxInvestorWorkbook — 様式が変わった場合は throw する", () => {
  it("JPXが2026-10-13掲載分から先行公開している新様式サンプル(ETF)を渡すと throw する", () => {
    // 数値はJPX自身のプレースホルダ例示 (実測値ではない)。構造検証のみに使う。
    const bytes = loadFixtureBytes("etf_mYYYYMM_sample-new-format.xlsx");
    expect(() => parseJpxInvestorWorkbook(bytes, "etf", "https://example.invalid/sample")).toThrow(
      /未対応のシート構成|2026年10月13日/
    );
  });

  it("JPXが2026-10-13掲載分から先行公開している新様式サンプル(REIT)を渡すと throw する", () => {
    const bytes = loadFixtureBytes("reit_mYYYYMM_sample-new-format.xlsx");
    expect(() => parseJpxInvestorWorkbook(bytes, "reit", "https://example.invalid/sample")).toThrow(
      /未対応のシート構成/
    );
  });
});

describe("parseJpxInvestorMonthLinks (実ページの抜粋)", () => {
  it("ETF一覧ページの抜粋から月次リンクを年月昇順で抽出し、最新が2026-08になる", () => {
    const html = loadFixtureText("investor-type-02-links-excerpt.html");
    const links = parseJpxInvestorMonthLinks(html, "etf");
    expect(links.map((l) => l.yearMonth)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08",
    ]);
    expect(links[links.length - 1]).toMatchObject({
      yearMonth: "2026-08",
      ext: "xls",
      href: "https://www.jpx.co.jp/markets/statistics-equities/investor-type/t13vrt000001xy39-att/etf_m2608.xls",
    });
  });

  it("サンプルファイル(etf_mYYYYMM.xls)やPDFリンクは月次リンクに含めない", () => {
    const html = loadFixtureText("investor-type-02-links-excerpt.html");
    const links = parseJpxInvestorMonthLinks(html, "etf");
    expect(links.every((l) => l.ext === "xls" || l.ext === "xlsx")).toBe(true);
    expect(links.some((l) => l.href.includes("YYYYMM"))).toBe(false);
  });

  it("REIT一覧ページの抜粋からも同様に抽出できる", () => {
    const html = loadFixtureText("investor-type-03-links-excerpt.html");
    const links = parseJpxInvestorMonthLinks(html, "reit");
    expect(links.length).toBe(8);
    expect(links[links.length - 1]?.yearMonth).toBe("2026-08");
  });

  it("該当リンクが1件もなければ throw する (様式変化の検知)", () => {
    expect(() => parseJpxInvestorMonthLinks("<html><body>no links here</body></html>", "etf")).toThrow(
      /月次ファイルへのリンクが1件も見つかりません/
    );
  });
});

describe("expectedJpxInvestorYearMonth / resolveJpxInvestorPublicationStatus", () => {
  it("基準日の前月を返す (月次公表は翌月なので、まだ出ていて当然の月)", () => {
    expect(expectedJpxInvestorYearMonth(new Date("2026-09-27T00:00:00Z"))).toBe("2026-08");
  });

  it("年をまたぐ場合も正しく前月を返す", () => {
    expect(expectedJpxInvestorYearMonth(new Date("2026-01-15T00:00:00Z"))).toBe("2025-12");
  });

  it("実際の一覧 (〜2026-08) では2026-09はまだ公表されていないと判定する", () => {
    const html = loadFixtureText("investor-type-02-links-excerpt.html");
    const links = parseJpxInvestorMonthLinks(html, "etf");
    const status = resolveJpxInvestorPublicationStatus(new Date("2026-09-27T00:00:00Z"), links);
    expect(status.expectedYearMonth).toBe("2026-08");
    expect(status.latestAvailableYearMonth).toBe("2026-08");
    expect(status.isExpectedMonthPublished).toBe(true);
  });

  it("基準日を10月にずらすと、まだ載っていない9月は「未公表」と判定する", () => {
    const html = loadFixtureText("investor-type-02-links-excerpt.html");
    const links = parseJpxInvestorMonthLinks(html, "etf");
    const status = resolveJpxInvestorPublicationStatus(new Date("2026-10-05T00:00:00Z"), links);
    expect(status.expectedYearMonth).toBe("2026-09");
    expect(status.isExpectedMonthPublished).toBe(false);
  });

  it("月末境界はJST (UTC+9) で判定する — UTC暦だけで見ると1ヶ月ずれる時刻でも正しい月を返す", () => {
    // 2026-09-30T20:00:00Z は JST では既に 2026-10-01T05:00 (10月)。
    // UTC の暦フィールドだけで「前月」を計算すると誤って "2026-08" を返してしまう
    // (UTC暦ではまだ9月なので前月=8月と誤判定する) バグの回帰テスト。
    // JST基準で正しくは、この瞬間の前月である "2026-09" を返すべき。
    expect(expectedJpxInvestorYearMonth(new Date("2026-09-30T20:00:00Z"))).toBe("2026-09");
    // 逆に UTC ではもう10月だが JST ではまだ9月、という向きのズレも無いことを確認。
    // 2026-09-30T14:00:00Z は JST では 2026-09-30T23:00 (まだ9月)。
    expect(expectedJpxInvestorYearMonth(new Date("2026-09-30T14:00:00Z"))).toBe("2026-08");
  });
});

describe("jpxInvestorIndicatorDefinitions", () => {
  it("ETF/REIT それぞれ6指標を定義し、personal-onlyのライセンスを明示する", () => {
    for (const product of ["etf", "reit"] as const) {
      const defs = jpxInvestorIndicatorDefinitions(product);
      expect(defs.length).toBe(6);
      const keys = defs.map((d) => d.key);
      expect(new Set(keys).size).toBe(keys.length); // キー重複なし
      for (const def of defs) {
        expect(def.usageConditions).toBe("personal-only");
        expect(def.frequency).toBe("monthly");
        expect(def.sourceUrl).toContain("jpx.co.jp");
        expect(def.plainDescription.length).toBeGreaterThan(0);
        expect(def.preciseDefinition.length).toBeGreaterThan(0);
      }
    }
  });

  it("市場全体 総売買代金/総売買高 は投資部門別カテゴリ集計と母集団が異なる (資本金30億円未満の参加者を含む)", () => {
    for (const product of ["etf", "reit"] as const) {
      const defs = jpxInvestorIndicatorDefinitions(product);
      const marketValueDef = defs.find((d) => d.key === `jpx-${product}-market-turnover-value`);
      const marketVolumeDef = defs.find((d) => d.key === `jpx-${product}-market-turnover-volume`);
      const categoryDef = defs.find((d) => d.key === `jpx-${product}-investor-net-flow-value`);
      expect(marketValueDef).toBeDefined();
      expect(marketVolumeDef).toBeDefined();
      expect(categoryDef).toBeDefined();

      // 誤り (実データで反証済み) だった「全カテゴリのSales+Purchasesの総和と一致する」
      // という主張がpreciseDefinitionに残っていないこと。
      expect(marketValueDef?.preciseDefinition).not.toContain("総和と一致する");
      // 母集団が異なり一致しないことを明示していること。
      expect(marketValueDef?.preciseDefinition).toContain("一致しない");

      // 市場全体系は「資本金30億円以上の取引参加者のみ」という限定が掛からない
      // (投資部門別カテゴリ系とは異なる limitations であること)。
      expect(marketValueDef?.limitations).not.toContain("資本金30億円以上の取引参加者のみ");
      expect(marketVolumeDef?.limitations).not.toContain("資本金30億円以上の取引参加者のみ");
      expect(categoryDef?.limitations).toContain("資本金30億円以上の取引参加者のみ");
    }
  });
});

describe("toJpxInvestorObservationRows", () => {
  it("実データから縦長の観測ログ行を組み立て、既知の値を含む", () => {
    const bytes = loadFixtureBytes("etf_m2608.xls");
    const report = parseJpxInvestorWorkbook(bytes, "etf", "https://example.invalid/etf_m2608.xls");
    const rows = toJpxInvestorObservationRows(report);

    // 市場全体 + カテゴリ14件 × (net+turnover) の2指標、Value/Volume 両シート分
    expect(rows.length).toBe((1 + 14 * 2) * 2);
    expect(rows.every((r) => r.period === "2026-08")).toBe(true);
    expect(rows.every((r) => r.isEstimated === false)).toBe(true);

    // 市場全体 (資本金30億円未満の参加者も含む実測合計) は近似ではない。
    const marketRows = rows.filter((r) => r.category === "市場全体");
    expect(marketRows.length).toBe(2); // value + volume
    expect(marketRows.every((r) => r.isApproximate === false)).toBe(true);

    // 投資部門別の各カテゴリ (資本金30億円以上の取引参加者限定の集計) は近似。
    const categoryRows = rows.filter((r) => r.category !== "市場全体");
    expect(categoryRows.length).toBe(14 * 2 * 2);
    expect(categoryRows.every((r) => r.isApproximate === true)).toBe(true);

    const foreignersNet = rows.find(
      (r) => r.indicatorKey === "jpx-etf-investor-net-flow-value" && r.category === "海外投資家"
    );
    expect(foreignersNet?.value).toBe(129_341_724);
    expect(foreignersNet?.unit).toBe("thousand_yen");

    const marketTurnover = rows.find(
      (r) => r.indicatorKey === "jpx-etf-market-turnover-value" && r.category === "市場全体"
    );
    expect(marketTurnover?.value).toBe(14_633_061_770);
  });
});

describe("jpxInvestorArchiveInput (ルール6: recordPrimaryDataへの入力を組み立てるだけで、実際には呼ばない)", () => {
  it("月次冪等キーとファイル実体で記録入力を組む", () => {
    const workbook: JpxInvestorWorkbookFile = {
      product: "etf",
      yearMonth: "2026-08",
      sourceUrl: "https://www.jpx.co.jp/x/etf_m2608.xls",
      filename: "etf_m2608.xls",
      contentType: "application/vnd.ms-excel",
      bytes: new Uint8Array([1, 2, 3]),
    };
    const input = jpxInvestorArchiveInput(workbook);
    expect(input.service).toBe("moneyflow");
    expect(input.key).toBe("jpx-etf-investor-2026-08");
    expect(input.source).toBe(workbook.sourceUrl);
    expect(input.files).toHaveLength(1);
    expect(input.files[0]?.filename).toBe("etf_m2608.xls");
    expect(input.files[0]?.bytes).toBe(workbook.bytes);
  });
});
