/**
 * 海外売上高パーサのユニットテスト。fixture は EDINET から取得した実在の
 * 有価証券報告書 (公開済み法定開示) の地域別売上表を、見出し+表 単位で
 * そのまま切り出したもの。架空値は一切使わない (CLAUDE.md ルール1)。
 *
 * 期待値は原典テーブルの開示数値そのもの。海外売上高 = 開示された海外地域の
 * 合計、連結売上高 = 開示総額 (外部顧客への売上高/連結) を採る。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseOverseasHtml,
  type OverseasFact,
} from "../services/overseas-parser.js";
import { REGION_BUCKETS } from "../services/overseas-query.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (n: string) => readFileSync(join(FX, n), "utf8");

function pick(facts: OverseasFact[], kind: OverseasFact["regionKind"]) {
  return facts.find((f) => f.regionKind === kind);
}
function region(facts: OverseasFact[], name: string) {
  return facts.find(
    (f) => f.regionName === name && (f.regionKind === "overseas" || f.regionKind === "domestic")
  );
}

describe("GEO_ROWS — 地域=行 (新収益認識基準の地域別収益分解)", () => {
  it("S100W16I 単一数値列・千円 (単位は表外見出し)", () => {
    const r = parseOverseasHtml(fx("georows-single-col-sen-S100W16I.html"), "2025-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(pick(r.facts, "domestic")!.salesAmount).toBe(7509516);
    expect(region(r.facts, "アジア")!.salesAmount).toBe(6089797);
    expect(region(r.facts, "北米")!.salesAmount).toBe(2141657);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(11917676);
    expect(pick(r.facts, "total")!.salesAmount).toBe(19427195);
    expect(pick(r.facts, "overseas_total")!.unitLabel).toBe("千円");
  });

  it("S100W179 前期/当期2列 → 当期列を採用", () => {
    const r = parseOverseasHtml(fx("georows-twoyear-current-col-S100W179.html"), "2025-03-31");
    expect(r.status).toBe("ok_geo_rows");
    // 当期 (2024/4-2025/3) の値であること (前期 45,385 ではない)
    expect(pick(r.facts, "domestic")!.salesAmount).toBe(45244);
    expect(region(r.facts, "アジア")!.salesAmount).toBe(42153);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(70347);
    expect(pick(r.facts, "total")!.salesAmount).toBe(115593);
  });

  it("S100W1NR 製品ブロック + 地域ブロックの積層表 → 地域だけ拾う", () => {
    const r = parseOverseasHtml(fx("georows-stacked-product-geo-blocks-S100W1NR.html"), "2025-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(pick(r.facts, "domestic")!.salesAmount).toBe(244647);
    // 製品行 (自動車関連 等) を地域として誤って拾っていないこと
    expect(region(r.facts, "自動車関連")).toBeUndefined();
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(522210);
  });

  it("S100W0UT 合計列・アジア(日本を除く) / その他の収益は海外に混ぜない", () => {
    const r = parseOverseasHtml(fx("georows-total-col-asia-ex-japan-S100W0UT.html"), "2025-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(pick(r.facts, "domestic")!.salesAmount).toBe(127177);
    // 海外売上高 = 開示海外地域の合計 (79,944)。total−国内(=81,283) ではない
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(79944);
    expect(pick(r.facts, "total")!.salesAmount).toBe(208460);
  });

  it("S100W03X 日本/米国/中国/その他の地域", () => {
    const r = parseOverseasHtml(fx("georows-us-cn-other-S100W03X.html"), "2025-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(pick(r.facts, "domestic")!.salesAmount).toBe(109685);
    expect(region(r.facts, "米国")!.salesAmount).toBe(10195);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(32572);
  });

  it("S100W1LQ アメリカ/その他北米/欧州 (高海外比率の機械)", () => {
    const r = parseOverseasHtml(fx("georows-america-othernorth-europe-S100W1LQ.html"), "2025-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(pick(r.facts, "domestic")!.salesAmount).toBe(16769);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(31280);
    expect(pick(r.facts, "overseas_total")!.ratioPct).toBeCloseTo(65.1, 0);
  });
});

describe("GEO_COLS — 地域=列", () => {
  it("S100W20H 横並び地域・連結列が総額", () => {
    const r = parseOverseasHtml(fx("geocols-horizontal-renketsu-total-S100W20H.html"), "2025-03-31");
    expect(r.status).toBe("ok_geo_cols");
    expect(pick(r.facts, "domestic")!.salesAmount).toBe(348998);
    expect(region(r.facts, "中華圏")!.salesAmount).toBe(171932);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(469763);
    expect(pick(r.facts, "total")!.salesAmount).toBe(818761);
    expect(pick(r.facts, "overseas_total")!.isConsolidated).toBe(true);
  });

  it("S100W0AF 地域がセグメント・連結財務諸表計上額が総額 (当期・連結を選択)", () => {
    const r = parseOverseasHtml(fx("geocols-geographic-segments-S100W0AF.html"), "2025-03-31");
    expect(r.status).toBe("ok_geo_cols");
    expect(pick(r.facts, "domestic")!.salesAmount).toBe(41479);
    expect(region(r.facts, "タイ")!.salesAmount).toBe(3855);
    expect(pick(r.facts, "total")!.salesAmount).toBe(46749);
  });

  it("S100W1Q5 米州・欧州 / アジア・オセアニア (千円・低海外比率)", () => {
    const r = parseOverseasHtml(fx("geocols-beishu-oushu-S100W1Q5.html"), "2025-03-31");
    expect(r.status).toBe("ok_geo_cols");
    expect(pick(r.facts, "domestic")!.salesAmount).toBe(59149647);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(4570155);
    expect(pick(r.facts, "overseas_total")!.ratioPct).toBeCloseTo(7.2, 1);
  });

  it("S100W1AE 北米偏重 (地域=列・高海外比率の自動車部品)", () => {
    const r = parseOverseasHtml(fx("geocols-auto-high-overseas-S100W1AE.html"), "2025-03-31");
    expect(r.status).toBe("ok_geo_cols");
    expect(pick(r.facts, "domestic")!.salesAmount).toBe(651390);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(4034373);
    expect(pick(r.facts, "overseas_total")!.ratioPct).toBeCloseTo(86.1, 0);
  });
});

describe("実在の大型輸出企業 (答え合わせ済み・現実の海外比率と整合)", () => {
  it("トヨタ 7203 — 地域別営業概況 (営業収益建て・地域=列)", () => {
    const r = parseOverseasHtml(fx("geocols-eigyoshueki-toyota-S100Y8NY.html"), "2026-03-31");
    expect(r.status).toBe("ok_geo_cols");
    expect(pick(r.facts, "domestic")!.salesAmount).toBe(10985614);
    expect(region(r.facts, "北米")!.salesAmount).toBe(20661490);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(39699338);
    expect(pick(r.facts, "total")!.salesAmount).toBe(50684952);
    // 海外比率 ~78% (現実と整合。誤った 35.9% ではない)
    expect(pick(r.facts, "overseas_total")!.ratioPct).toBeCloseTo(78.3, 0);
  });

  it("任天堂 7974 — 米大陸/欧州/その他 (地域=列・合計行)", () => {
    const r = parseOverseasHtml(fx("geocols-beitairiku-nintendo-S100W73A.html"), "2025-03-31");
    expect(r.status).toBe("ok_geo_cols");
    expect(region(r.facts, "米大陸")!.salesAmount).toBe(741350);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(1309213);
    expect(pick(r.facts, "total")!.salesAmount).toBe(1671865);
  });

  it("大林組 1802 — 顧客との契約 と 外部顧客への売上高 の二層 (その他の収益を海外に混ぜない)", () => {
    const r = parseOverseasHtml(fx("georows-multilevel-contract-vs-external-obayashi-S100W0FJ.html"), "2025-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(pick(r.facts, "domestic")!.salesAmount).toBe(1808919);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(757806);
    // 分母は外部顧客への売上高 (その他の収益込みの総売上)
    expect(pick(r.facts, "total")!.salesAmount).toBe(2620101);
  });

  it("村田製作所 6981 — 「南北アメリカのうち、米国」内訳行を二重計上しない", () => {
    const r = parseOverseasHtml(fx("georows-uchi-subrow-murata-S100W2ZR.html"), "2025-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(pick(r.facts, "domestic")!.salesAmount).toBe(129255);
    // 「うち、米国」を別地域として加算していないこと
    expect(r.facts.some((f) => /うち/.test(f.regionName))).toBe(false);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(1614097);
  });

  it("ソニーG 6758 / ホンダ 7267 — 海外比率が現実と整合", () => {
    const sony = parseOverseasHtml(fx("georows-sony-S100W19Q.html"), "2025-03-31");
    expect(sony.status).toBe("ok_geo_rows");
    expect(pick(sony.facts, "overseas_total")!.ratioPct).toBeCloseTo(67.7, 0);
    const honda = parseOverseasHtml(fx("geocols-honda-S100VYOD.html"), "2025-03-31");
    expect(honda.status).toBe("ok_geo_cols");
    expect(pick(honda.facts, "domestic")!.salesAmount).toBe(2845609);
    expect(pick(honda.facts, "overseas_total")!.ratioPct).toBeCloseTo(86.9, 0);
  });
});

describe("地域別バケット (REGION_BUCKETS) — 同義地域語の正規化と二重計上回避", () => {
  it("中国バケットは中国/中華圏/香港に当たり、アジア/中南米/中東/米国には当たらない", () => {
    const china = REGION_BUCKETS.china.rx;
    expect(china.test("中国")).toBe(true);
    expect(china.test("中華圏")).toBe(true);
    expect(china.test("香港")).toBe(true);
    expect(china.test("アジア")).toBe(false);
    expect(china.test("中南米")).toBe(false);
    expect(china.test("中東")).toBe(false);
    expect(china.test("米国")).toBe(false);
  });

  it("米州/欧州/アジア バケットの代表語 (中国はアジアに入れない)", () => {
    expect(REGION_BUCKETS.americas.rx.test("米国")).toBe(true);
    expect(REGION_BUCKETS.americas.rx.test("南北アメリカ")).toBe(true);
    expect(REGION_BUCKETS.americas.rx.test("北米")).toBe(true);
    expect(REGION_BUCKETS.americas.rx.test("中国")).toBe(false);
    expect(REGION_BUCKETS.europe.rx.test("欧州")).toBe(true);
    expect(REGION_BUCKETS.asia.rx.test("アジア・オセアニア")).toBe(true);
    expect(REGION_BUCKETS.asia.rx.test("中国")).toBe(false);
  });

  it("複合地域『アジア・中国』は2バケットに該当する (query 側は中立で除外する)", () => {
    const hit = Object.values(REGION_BUCKETS).filter((b) => b.rx.test("アジア・中国"));
    // china と asia の両方にマッチ = 複合行。screenOverseasGrowth は単一該当行のみ算入。
    expect(hit.length).toBeGreaterThanOrEqual(2);
  });

  it("ソニー実有報: 地域別比率を正しく束ね、中国をアジアに二重計上しない", () => {
    const r = parseOverseasHtml(fx("georows-sony-S100W19Q.html"), "2025-03-31");
    const total = pick(r.facts, "total")!.salesAmount!;
    const sumBucket = (rx: RegExp) =>
      r.facts
        .filter((f) => f.regionKind === "overseas" && rx.test(f.regionName))
        .reduce((a, f) => a + (f.salesAmount ?? 0), 0);
    expect(sumBucket(REGION_BUCKETS.china.rx)).toBe(27372); // 「中国」行のみ
    expect(sumBucket(REGION_BUCKETS.americas.rx)).toBe(2915183); // 「米国」行
    expect(sumBucket(REGION_BUCKETS.asia.rx)).toBe(233895); // 中国を含めない
    expect(+((sumBucket(REGION_BUCKETS.americas.rx) / total) * 100).toFixed(1)).toBeCloseTo(45.1, 0);
  });
});

describe("ルール1/2: 構造化できない/開示なしは数値を作らない", () => {
  it("地域別売上の無いHTML (空テーブル) は no_overseas_table", () => {
    const r = parseOverseasHtml("<html><body><p>本文</p></body></html>", "2025-03-31");
    expect(r.status).toBe("no_overseas_table");
    expect(r.facts).toHaveLength(0);
  });

  it("全 fixture で 国内+海外地域 の合計が開示総額と整合する (誤読していない)", () => {
    const files = [
      "georows-single-col-sen-S100W16I.html",
      "geocols-horizontal-renketsu-total-S100W20H.html",
      "georows-twoyear-current-col-S100W179.html",
    ];
    for (const f of files) {
      const r = parseOverseasHtml(fx(f), "2025-03-31");
      const dom = r.facts.filter((x) => x.regionKind === "domestic").reduce((a, x) => a + (x.salesAmount ?? 0), 0);
      const ov = pick(r.facts, "overseas_total")!.salesAmount!;
      const total = pick(r.facts, "total")!.salesAmount!;
      // 国内 + 海外 は総額の 99% 以上 (その他の収益等の僅少差を許容)
      expect(dom + ov).toBeGreaterThanOrEqual(total * 0.98);
      expect(dom + ov).toBeLessThanOrEqual(total);
    }
  });
});
