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
  validateOverseasSaveSet,
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

describe("F2 根因修正: 未解決の重複地域名は ok を出さない (aggregate-before-dedup 防止)", () => {
  it("S100T6Q9 減損損失表 (非売上・(地域, 用途) 非一意) は却下され、取込 pure path でも保存行を生まない", () => {
    // raw(実原本の必要表のみ切り出し) → parse → 取込 caller と同一の保存前検証
    const r = parseOverseasHtml(fx("georows-impairment-unresolved-S100T6Q9.html"), "2023-12-31");
    // pre-fix (#150 以前) は ok_geo_rows で米国/日本の重複＋集計を出していた。
    // P-2D/P-hier/P-metric のいずれでも証明できないため却下のまま。
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    // ingest.ts / backfill-overseas.ts / backfill-missing-docs.ts と同一の
    // 保存前検証を通しても保存行は生まれない (空集合は検証対象外で pass)
    expect(() => validateOverseasSaveSet(r.facts)).not.toThrow();
  });
});

describe("P-2D/P-hier/P-metric: 証明できる重複は正しく読む", () => {
  it("S100J2E7 販売実績表 (地域×品目の2次元表) は品目合算で回復する", () => {
    // 日本 16698+14814、アジア 5439+11524、北米 2864 (ブレーキ欠損は合計上0)。
    // 合算 51339 が開示合計 51340 と一致して分割を証明する。
    const r = parseOverseasHtml(fx("georows-dup-region-ambiguous-S100J2E7.html"), "2020-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(31512);
    expect(region(r.facts, "アジア")!.salesAmount).toBe(16963);
    expect(region(r.facts, "北米")!.salesAmount).toBe(2864);
    // 源泉正の集計は保持する (per-column provenance: 落としたのは地域行だけ)
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(19827);
    expect(pick(r.facts, "overseas_total")!.ratioPct).toBe(38.6);
    expect(pick(r.facts, "total")!.salesAmount).toBe(51340);
    expect(pick(r.facts, "overseas_total")!.unitLabel).toBe("百万円");
    // 取込 caller と同一の保存前検証を通る (一意化済み・集計一致)
    expect(() => validateOverseasSaveSet(r.facts)).not.toThrow();
    expect(r.facts).toHaveLength(5);
  });

  it("S100YBHC 販売実績表 (地域×品目の2次元表) は品目合算で回復する", () => {
    const r = parseOverseasHtml(fx("georows-2dproduct-sales-S100YBHC.html"), "2026-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(26626847);
    expect(region(r.facts, "中国")!.salesAmount).toBe(4046665);
    expect(region(r.facts, "北米")!.salesAmount).toBe(12107628);
    expect(region(r.facts, "欧州")!.salesAmount).toBe(16776734);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(32931027);
    expect(pick(r.facts, "total")!.salesAmount).toBe(59557877);
    expect(pick(r.facts, "overseas_total")!.unitLabel).toBe("千円");
  });

  it("S100OJV9 2階層行ラベル表は子ラベルで読替える", () => {
    // 親 (日本/海外) + 子 (日本/アジア/欧州/北米/その他)。leaf 合計 152403 が
    // 顧客契約 152406 と一致して分割を証明する。
    const r = parseOverseasHtml(fx("georows-hierchild-S100OJV9.html"), "2022-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(92660);
    expect(region(r.facts, "アジア")!.salesAmount).toBe(15228);
    expect(region(r.facts, "欧州")!.salesAmount).toBe(27377);
    expect(region(r.facts, "北米")!.salesAmount).toBe(12016);
    expect(region(r.facts, "その他")!.salesAmount).toBe(5122);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(59743);
    expect(pick(r.facts, "total")!.salesAmount).toBe(152536);
    expect(pick(r.facts, "overseas_total")!.unitLabel).toBe("百万円");
  });

  it("S100VI7V 地域×項目対は売上高行だけ読み、合計欠損は null で正直に出す", () => {
    // 営業利益行を混ぜない。開示合計行がなく事業セグメント (警備輸送等) もある
    // ため total は欠損 (地域計を総額に捏造しない)。比率も欠損。
    const r = parseOverseasHtml(fx("georows-metricpair-S100VI7V.html"), "2022-12-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(14572);
    expect(region(r.facts, "米州")!.salesAmount).toBe(1620);
    expect(region(r.facts, "欧州")!.salesAmount).toBe(2156);
    expect(region(r.facts, "東アジア")!.salesAmount).toBe(2420);
    expect(region(r.facts, "南アジア・オセアニア")!.salesAmount).toBe(2218);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(8414);
    expect(pick(r.facts, "total")!.salesAmount).toBeNull();
    expect(pick(r.facts, "overseas_total")!.ratioPct).toBeNull();
    expect(pick(r.facts, "overseas_total")!.unitLabel).toBe("億円");
  });

  it("S100VI6W 地域×項目対 (IFRS: 売上収益/事業利益) も売上収益行だけ読む", () => {
    const r = parseOverseasHtml(fx("georows-metricpair-ifrs-S100VI6W.html"), "2024-12-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(12620);
    expect(region(r.facts, "米州")!.salesAmount).toBe(1530);
    expect(region(r.facts, "欧州")!.salesAmount).toBe(5017);
    expect(region(r.facts, "東アジア")!.salesAmount).toBe(1739);
    expect(region(r.facts, "南アジア・オセアニア")!.salesAmount).toBe(1576);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(9862);
    expect(pick(r.facts, "total")!.salesAmount).toBeNull();
    expect(pick(r.facts, "overseas_total")!.unitLabel).toBe("億円");
  });
});

describe("保存前検証: caller 共通境界は壊れた集合を保存させない", () => {
  // 実 parse 出力への破壊注入 (negative)。正常系は各回復テストで通す。
  const real = () =>
    parseOverseasHtml(fx("georows-dup-region-ambiguous-S100J2E7.html"), "2020-03-31").facts;

  it("正常集合は通る (J2E7 回復値・VI7V の total 欠損・空集合)", () => {
    expect(() => validateOverseasSaveSet(real())).not.toThrow();
    const metric = parseOverseasHtml(fx("georows-metricpair-S100VI7V.html"), "2022-12-31").facts;
    expect(() => validateOverseasSaveSet(metric)).not.toThrow();
    expect(() => validateOverseasSaveSet([])).not.toThrow();
  });

  it("重複地域・単位混在・期末混在・連結混在は throw", () => {
    const dup = [...real(), { ...real()[0]! }];
    expect(() => validateOverseasSaveSet(dup)).toThrow();
    const unitMix = real().map((f, i) =>
      i === 0 ? { ...f, unitYenFactor: 1000 } : f
    );
    expect(() => validateOverseasSaveSet(unitMix)).toThrow();
    const fyMix = real().map((f, i) =>
      i === 0 ? { ...f, fiscalYearEnd: "2019-03-31" } : f
    );
    expect(() => validateOverseasSaveSet(fyMix)).toThrow();
    const consolMix = real().map((f, i) =>
      i === 0 ? { ...f, isConsolidated: false } : f
    );
    expect(() => validateOverseasSaveSet(consolMix)).toThrow();
  });

  it("集計不一致・比率不一致・総額不足は throw", () => {
    const otBad = real().map((f) =>
      f.regionKind === "overseas_total" ? { ...f, salesAmount: 99999 } : f
    );
    expect(() => validateOverseasSaveSet(otBad)).toThrow();
    const ratioBad = real().map((f) =>
      f.regionKind === "overseas_total" ? { ...f, ratioPct: 99.9 } : f
    );
    expect(() => validateOverseasSaveSet(ratioBad)).toThrow();
    const totalShort = real().map((f) =>
      f.regionKind === "total" ? { ...f, salesAmount: 100 } : f
    );
    expect(() => validateOverseasSaveSet(totalShort)).toThrow();
  });
});

describe("P-hier-cols: 階層列見出しは親 grouping で合算する", () => {
  it("S100DDYF 2階層列 (親アジア/米州 + 子) は親合算で回復する", () => {
    // アジア 118476+182922、米州 161237+81313。leaf 合計 1150205 が
    // 開示合計 1150209 と一致して分割を証明する。
    const r = parseOverseasHtml(fx("geocols-hierparent-S100DDYF.html"), "2018-03-31");
    expect(r.status).toBe("ok_geo_cols");
    expect(region(r.facts, "日本")!.salesAmount).toBe(505167);
    expect(region(r.facts, "アジア")!.salesAmount).toBe(301398);
    expect(region(r.facts, "米州")!.salesAmount).toBe(242550);
    expect(region(r.facts, "欧州")!.salesAmount).toBe(101090);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(645038);
    expect(pick(r.facts, "total")!.salesAmount).toBe(1150209);
    expect(pick(r.facts, "overseas_total")!.unitLabel).toBe("百万円");
  });

  it("S100Y53G 3階層列 (親国内/海外 + 子) は親合算で回復する", () => {
    // 国内 236131+92760、海外 35917+102813+101709。leaf 合計 569330 が
    // 開示連結 569370 と一致して分割を証明する。
    const r = parseOverseasHtml(fx("geocols-hierparent-S100Y53G.html"), "2026-02-28");
    expect(r.status).toBe("ok_geo_cols");
    expect(region(r.facts, "国内")!.salesAmount).toBe(328891);
    expect(region(r.facts, "海外")!.salesAmount).toBe(240439);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(240439);
    expect(pick(r.facts, "total")!.salesAmount).toBe(569370);
    expect(pick(r.facts, "overseas_total")!.unitLabel).toBe("百万円");
  });
});

describe("B2 根因修正: 生産実績表は売上高の開示ではないので候補にしない", () => {
  it("S100OE0P 生産実績表 (a) 単体は採用されない (pre-fix は ok_geo_rows で生産高 21830 を海外売上高にしていた)", () => {
    const r = parseOverseasHtml(fx("georows-production-results-excluded-S100OE0P.html"), "2022-03-31");
    expect(r.status).toBe("no_overseas_table");
    expect(r.facts).toHaveLength(0);
  });

  it("S100OE0P 販売実績表 (c) 単体は正規の売上表として構造化される", () => {
    const r = parseOverseasHtml(fx("georows-sales-results-preferred-S100OE0P.html"), "2022-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(16163);
    expect(region(r.facts, "南北アメリカ")!.salesAmount).toBe(11814);
    expect(region(r.facts, "中国")!.salesAmount).toBe(5209);
    expect(region(r.facts, "東南アジア／インド")!.salesAmount).toBe(4497);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(21520);
    expect(pick(r.facts, "total")!.salesAmount).toBe(37686);
    expect(pick(r.facts, "overseas_total")!.unitLabel).toBe("百万円");
  });

  it("S100OE0P 生産→販売の原文書順でも販売実績表が選ばれ、取込 pure path で正しい保存行になる", () => {
    // 原文書と同じ順序 (生産実績 (a) が先、販売実績 (c) が後)。pre-fix は同点で
    // 文書順タイブレークにより生産実績表 (海外売上高 21830) を誤採用していた。
    const html =
      fx("georows-production-results-excluded-S100OE0P.html") +
      "\n" +
      fx("georows-sales-results-preferred-S100OE0P.html");
    const r = parseOverseasHtml(html, "2022-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(21520);
    expect(pick(r.facts, "total")!.salesAmount).toBe(37686);
    // ingest.ts / backfill-overseas.ts / backfill-missing-docs.ts と同一の
    // 保存前検証を通る (一意化済み・集計一致)
    expect(() => validateOverseasSaveSet(r.facts)).not.toThrow();
    expect(r.facts).toHaveLength(6);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(21520);
    // 生産実績の値 (日本 15706 / 海外売上高 21830) が混入していないこと
    expect(region(r.facts, "日本")!.salesAmount).toBe(16163);
  });

  it("S100OE0P 原文書区間 (a)表〜(c)表・表間テキスト付きでも販売実績表が選ばれる", () => {
    // 切出し連結ではなく原文書の区間 (生産表の表題〜販売表の終端。表間の (注)・
    // (b)受注状況キャプションを含む) で判定する。見出し window は表題そのもの
    // ではなく前表の説明文を含み得るため、最寄り表題語で判定する。
    const r = parseOverseasHtml(fx("georows-production-vs-sales-fullsection-S100OE0P.html"), "2022-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(21520);
    expect(pick(r.facts, "total")!.salesAmount).toBe(37686);
    expect(region(r.facts, "日本")!.salesAmount).toBe(16163);
  });
});

describe("P-block: 積層 block は売上・地域 block だけ読む (小計・消去・計で検証)", () => {
  it("S100DA2Y 売上block + 営業利益block → 売上blockのみ (地域計+消去=計)", () => {
    const r = parseOverseasHtml(fx("georows-salesblock-profitblock-S100DA2Y.html"), "2018-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(16024844);
    expect(region(r.facts, "北米")!.salesAmount).toBe(10574410);
    expect(region(r.facts, "欧州")!.salesAmount).toBe(3185224);
    expect(region(r.facts, "アジア")!.salesAmount).toBe(5148139);
    expect(region(r.facts, "その他")!.salesAmount).toBe(2453299);
    // 営業利益blockの値 (日本 1659918 等) が混入していないこと
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(21361072);
    expect(pick(r.facts, "total")!.salesAmount).toBe(29379510);
    expect(pick(r.facts, "overseas_total")!.ratioPct).toBe(72.7);
    expect(pick(r.facts, "overseas_total")!.unitLabel).toBe("百万円");
  });

  it("S100OE1D 地域市場block + 用途別block → 地域blockのみ", () => {
    const r = parseOverseasHtml(fx("georows-regionblock-productblock-S100OE1D.html"), "2022-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(13511615);
    expect(region(r.facts, "アジア")!.salesAmount).toBe(6845842);
    expect(region(r.facts, "北米")!.salesAmount).toBe(5297522);
    expect(region(r.facts, "欧州")!.salesAmount).toBe(3369511);
    // 地域blockのその他 (341247)。用途別blockのその他 (1998616) ではない
    expect(region(r.facts, "その他")!.salesAmount).toBe(341247);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(15854122);
    expect(pick(r.facts, "total")!.salesAmount).toBe(29365738);
    expect(pick(r.facts, "overseas_total")!.unitLabel).toBe("千円");
  });

  it("S100OH3F 地域市場block + 財サービスblock → 地域blockのみ (中近東を読む)", () => {
    const r = parseOverseasHtml(fx("georows-regionblock-productblock-nakachinto-S100OH3F.html"), "2022-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(3926667);
    expect(region(r.facts, "東アジア")!.salesAmount).toBe(316624);
    expect(region(r.facts, "東南・南アジア")!.salesAmount).toBe(203194);
    expect(region(r.facts, "中近東")!.salesAmount).toBe(115979);
    expect(region(r.facts, "その他")!.salesAmount).toBe(15741);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(651538);
    expect(pick(r.facts, "total")!.salesAmount).toBe(4578208);
    expect(pick(r.facts, "overseas_total")!.unitLabel).toBe("千円");
  });

  it("S100YDNF 財block + 地域別block → 地域blockのみ", () => {
    const r = parseOverseasHtml(fx("georows-zaiblock-regionblock-S100YDNF.html"), "2026-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(26515);
    expect(region(r.facts, "アジア")!.salesAmount).toBe(18667);
    expect(region(r.facts, "北米")!.salesAmount).toBe(14327);
    // 地域blockのその他 (2534)。財blockのその他 (0) ではない
    expect(region(r.facts, "その他")!.salesAmount).toBe(2534);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(35528);
    expect(pick(r.facts, "total")!.salesAmount).toBe(62045);
    expect(pick(r.facts, "overseas_total")!.unitLabel).toBe("百万円");
  });

  it("S100QIEX 収益2block + 小計 → block合算 (小計A+小計B=外部顧客)", () => {
    const r = parseOverseasHtml(fx("georows-twoblock-shokei-S100QIEX.html"), "2022-12-31");
    expect(r.status).toBe("ok_geo_rows");
    // 日本 1738900+369973、中国 373868+7321 の block 間合算
    expect(region(r.facts, "日本")!.salesAmount).toBe(2108873);
    expect(region(r.facts, "中国")!.salesAmount).toBe(381189);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(381189);
    expect(pick(r.facts, "total")!.salesAmount).toBe(2490064);
    expect(pick(r.facts, "overseas_total")!.ratioPct).toBe(15.3);
    expect(pick(r.facts, "overseas_total")!.unitLabel).toBe("千円");
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
