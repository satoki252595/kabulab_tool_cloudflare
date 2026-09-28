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
  cellInterval,
  cellsConsistent,
  parseJpNumberCell,
  detectRoundingMode,
  inheritSourceFiscal,
  unanimousFlatFiscal,
  axisFiscal,
  resolveCandidateFiscal,
  contractOf,
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
  it("S100W20H 横並び地域・連結列が総額 (第87期/Z表は期首フィルタで除外し第88期/T表を採用。旧期待値 818761 は前期値の誤保存だった)", () => {
    const r = parseOverseasHtml(fx("geocols-horizontal-renketsu-total-S100W20H.html"), "2025-03-31");
    expect(r.status).toBe("ok_geo_cols");
    expect(pick(r.facts, "domestic")!.salesAmount).toBe(355104);
    expect(region(r.facts, "中華圏")!.salesAmount).toBe(159967);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(446649);
    expect(pick(r.facts, "total")!.salesAmount).toBe(801753);
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
    // R1 以後は候補段階で除外されるため no_overseas_table (B2 の生産実績表と同型。
    // 減損表は売上表ではないので geo signal なしが正しい)。0 facts・保存なしは不変。
    expect(r.status).toBe("no_overseas_table");
    expect(r.facts).toHaveLength(0);
    // ingest.ts / backfill-overseas.ts / backfill-missing-docs.ts と同一の
    // 保存前検証を通しても保存行は生まれない (空集合は検証対象外で pass)
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
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
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
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
  // proof は必須 (facts-only は STOP)。正常系は parse 出力の proof を渡す。
  const real = () =>
    parseOverseasHtml(fx("georows-dup-region-ambiguous-S100J2E7.html"), "2020-03-31");

  it("正常集合は通る (J2E7 回復値・VI7V の total 欠損・空集合)", () => {
    expect(() => validateOverseasSaveSet(real().facts, real().proof)).not.toThrow();
    const metric = parseOverseasHtml(fx("georows-metricpair-S100VI7V.html"), "2022-12-31");
    expect(() => validateOverseasSaveSet(metric.facts, metric.proof)).not.toThrow();
    expect(() => validateOverseasSaveSet([], undefined)).not.toThrow();
  });

  it("proof 欠損は throw (facts-only fallback は廃止)", () => {
    expect(() => validateOverseasSaveSet(real().facts, undefined)).toThrow();
  });

  it("重複地域・単位混在・期末混在・連結混在は throw", () => {
    const dup = [...real().facts, { ...real().facts[0]! }];
    expect(() => validateOverseasSaveSet(dup, real().proof)).toThrow();
    const unitMix = real().facts.map((f, i) =>
      i === 0 ? { ...f, unitYenFactor: 1000 } : f
    );
    expect(() => validateOverseasSaveSet(unitMix, real().proof)).toThrow();
    const fyMix = real().facts.map((f, i) =>
      i === 0 ? { ...f, fiscalYearEnd: "2019-03-31" } : f
    );
    expect(() => validateOverseasSaveSet(fyMix, real().proof)).toThrow();
    const consolMix = real().facts.map((f, i) =>
      i === 0 ? { ...f, isConsolidated: false } : f
    );
    expect(() => validateOverseasSaveSet(consolMix, real().proof)).toThrow();
  });

  it("集計不一致・比率不一致・総額不足は throw", () => {
    const otBad = real().facts.map((f) =>
      f.regionKind === "overseas_total" ? { ...f, salesAmount: 99999 } : f
    );
    expect(() => validateOverseasSaveSet(otBad, real().proof)).toThrow();
    const ratioBad = real().facts.map((f) =>
      f.regionKind === "overseas_total" ? { ...f, ratioPct: 99.9 } : f
    );
    expect(() => validateOverseasSaveSet(ratioBad, real().proof)).toThrow();
    const totalShort = real().facts.map((f) =>
      f.regionKind === "total" ? { ...f, salesAmount: 100 } : f
    );
    expect(() => validateOverseasSaveSet(totalShort, real().proof)).toThrow();
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
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
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
    // Gate3:「消去又は全社」は elim 脚だけに計上し全社共通に重ねない (二重なら -16012812)
    expect(r.proof!.reconciliationAdjustment).toBe(-8006406);
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

describe("語彙: アセアンは海外地域 (S100OIVD ほか10文書で脱落を実証)", () => {
  it("S100OIVD 主たる地域市場表はアセアンを含めて構造化される (pre-fix はアセアン 11371 を落とし海外売上高を過小にしていた)", () => {
    const r = parseOverseasHtml(fx("georows-asean-S100OIVD.html"), "2022-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "アセアン")!.salesAmount).toBe(11371);
    expect(region(r.facts, "日本")!.salesAmount).toBe(34457);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(46330);
    expect(pick(r.facts, "total")!.salesAmount).toBe(80789);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });
});

describe("P-block: 製品ライン block は売上 block ではない (S100LN1R ほか7文書で混入を実証)", () => {
  it("S100LN1R 収益分解表は地域市場 block だけ読む (pre-fix は製品blockのその他 12855 を海外に混入し海外売上高 83161/合計 143366 を保存していた)", () => {
    const r = parseOverseasHtml(fx("georows-productline-block-S100LN1R.html"), "2021-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(r.facts).toHaveLength(5);
    expect(region(r.facts, "日本")!.salesAmount).toBe(60205);
    expect(region(r.facts, "アジア・オセアニア")!.salesAmount).toBe(41837);
    expect(region(r.facts, "欧州・米州等")!.salesAmount).toBe(28469);
    // 製品 block のその他 (12855) が混入していないこと
    expect(region(r.facts, "その他")).toBeUndefined();
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(70306);
    expect(pick(r.facts, "total")!.salesAmount).toBe(130513);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100YR3G エリア別製品販売状況表は表題の製品で誤殺されない (標識は製品ラインに限定。エリア別売上表として採用)", () => {
    const r = parseOverseasHtml(fx("georows-areaproduct-sales-S100YR3G.html"), "2026-04-30");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "米国")!.salesAmount).toBe(6249);
    expect(region(r.facts, "その他")!.salesAmount).toBe(783);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(9627);
    expect(pick(r.facts, "total")!.salesAmount).toBe(10883);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });
});

describe("消去/調整: 調整額行は地域計に加算して照合する (S100VYJU で実証)", () => {
  it("S100VYJU 販売実績表は調整額 1766 を加算して合計と照合する (pre-fix は生産実績表を誤採用。R1・B2 後は本表が読める)", () => {
    const r = parseOverseasHtml(fx("georows-adjustment-S100VYJU.html"), "2025-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "中華圏")!.salesAmount).toBe(14268);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(53994);
    expect(pick(r.facts, "total")!.salesAmount).toBe(111050);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });
});

describe("R1 根因修正: 非流動資産・減損損失の地域別表は売上高の開示ではないので候補にしない", () => {
  it("S100G2DL 非流動資産の地域別情報表 単体は採用されない (pre-fix は ok_geo_rows で資産額 1992354 を連結売上高にしていた。dup なし・検証も通り抜け)", () => {
    const r = parseOverseasHtml(fx("georows-noncurrent-assets-excluded-S100G2DL.html"), "2019-03-31");
    expect(r.status).toBe("no_overseas_table");
    expect(r.facts).toHaveLength(0);
  });

  it("S100J2FF 減損損失表 (場所×減損損失) 単体は採用されない (pre-fix は ok_geo_rows で減損額 20655 を連結売上高にしていた)", () => {
    const r = parseOverseasHtml(fx("georows-impairment-excluded-S100J2FF.html"), "2020-03-31");
    expect(r.status).toBe("no_overseas_table");
    expect(r.facts).toHaveLength(0);
  });

  it("S100AJAN 地域別収益表は窓内の減損 prose にもかかわらず採用される (最寄り metric 名詞は収益。R1 の誤殺防止)", () => {
    const r = parseOverseasHtml(fx("georows-impairment-caption-sales-kept-S100AJAN.html"), "2017-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(2290622);
    expect(pick(r.facts, "total")!.salesAmount).toBe(3996974);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100O4SN 入れ子内側の減損損失表も表頭-R1 で除外される (内側表の窓は表題を含まず heading-R1 をすり抜けた。pre-fix は減損額 476690 を連結売上高にしていた)", () => {
    const r = parseOverseasHtml(fx("georows-impairment-nested-excluded-S100O4SN.html"), "2022-02-28");
    expect(r.status).toBe("no_overseas_table");
    expect(r.facts).toHaveLength(0);
  });

  it("S100QHOQ 当期売上表は省略宣言文中の非流動資産で誤殺されない (省略文は不開示。P/L 売上収益 90 と一致)", () => {
    const r = parseOverseasHtml(fx("georows-omission-sales-kept-S100QHOQ.html"), "2022-12-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(63);
    expect(region(r.facts, "米国")!.salesAmount).toBe(17);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(27);
    expect(pick(r.facts, "total")!.salesAmount).toBe(90);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100DCF4 有形固定資産および無形資産の帳簿価額表は採用されない (正準の地域売上注記と同点 tie の汚染源だった)", () => {
    const r = parseOverseasHtml(fx("r1-yukei-mukei-shisan-S100DCF4.html"), "2018-03-31");
    expect(r.status).toBe("no_overseas_table");
    expect(r.facts).toHaveLength(0);
  });

  it("S100TP3I 繰越工事高の国内/海外/計表は採用されない (手持ち残高であり売上高ではない。pre-fix は受注残高 2198120 を連結売上高にしていた)", () => {
    const r = parseOverseasHtml(fx("backlog-kurikoshikojidaka-S100TP3I.html"), "2024-03-31");
    expect(r.status).toBe("no_overseas_table");
    expect(r.facts).toHaveLength(0);
  });
});

describe("海外59根因: 全角・語彙・集計変種・消去適用範囲・非地域列・葉数え・block境界", () => {
  it("S1009XV6 全角数字のその他５を読む (pre-fix は行脱落→差 7 で 1% 通過/絶対 bound 却下)", () => {
    const r = parseOverseasHtml(fx("georows-fullwidth-sonota-S1009XV6.html"), "2016-12-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "その他")!.salesAmount).toBe(5);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(493);
    expect(pick(r.facts, "total")!.salesAmount).toBe(1233);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100ACAR セグメント注記のその他（注）１列は fact 化せず照合に加える (地理不明。pre-fix は注番号で分類不能→差 1749)", () => {
    const r = parseOverseasHtml(fx("geocols-segnote-sonota-chu-S100ACAR.html"), "2017-02-28");
    expect(r.status).toBe("ok_geo_cols");
    expect(region(r.facts, "日本")!.salesAmount).toBe(189656);
    expect(region(r.facts, "豪州")!.salesAmount).toBe(18680);
    expect(region(r.facts, "その他")).toBeUndefined();
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(18680);
    expect(pick(r.facts, "total")!.salesAmount).toBe(210085);
    expect(r.proof!.reconciliationAdjustment).toBe(1748);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100IWKH セグメント注記の事業列 (スポーツ施設事業) は fact 化せず照合に加える (pre-fix は差 512499)", () => {
    const r = parseOverseasHtml(fx("geocols-segnote-business-col-S100IWKH.html"), "2020-03-31");
    expect(r.status).toBe("ok_geo_cols");
    expect(region(r.facts, "スポーツ施設事業")).toBeUndefined();
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(23334825);
    expect(pick(r.facts, "total")!.salesAmount).toBe(61967107);
    expect(r.proof!.reconciliationAdjustment).toBe(512497);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100GAYK モンゴルは海外地域 (pre-fix は語彙なし→差 183)", () => {
    const r = parseOverseasHtml(fx("georows-mongolia-S100GAYK.html"), "2019-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "モンゴル")!.salesAmount).toBe(181);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(53575);
    expect(pick(r.facts, "total")!.salesAmount).toBe(74935);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100AI6T EMEA は海外地域 (pre-fix は語彙なし→差 1113。合算 635605 と完全一致)", () => {
    const r = parseOverseasHtml(fx("georows-emea-S100AI6T.html"), "2017-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "EMEA")!.salesAmount).toBe(1113);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(66205);
    expect(pick(r.facts, "total")!.salesAmount).toBe(635605);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100TRBB 生じた変種の契約小計に地域計が一致し、その他の収益 85 を橋渡しして外部顧客総額を採る", () => {
    const r = parseOverseasHtml(fx("georows-contract-shojita-S100TRBB.html"), "2024-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(75548);
    expect(pick(r.facts, "total")!.salesAmount).toBe(128738);
    expect(r.proof!.reconciliationAdjustment).toBe(85);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100OJ6E を分解した情報つき契約小計に地域計が一致し、その他の収益 1012 を橋渡しして外部顧客総額を採る", () => {
    const r = parseOverseasHtml(fx("georows-contract-bunkaijoho-S100OJ6E.html"), "2022-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(124096);
    expect(pick(r.facts, "total")!.salesAmount).toBe(746926);
    expect(r.proof!.reconciliationAdjustment).toBe(1012);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100TSSV 認識した変種の契約小計に地域計が一致し、その他の契約から認識した収益 212 を橋渡しする", () => {
    const r = parseOverseasHtml(fx("georows-contract-ninshiki-S100TSSV.html"), "2024-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(128727);
    expect(pick(r.facts, "total")!.salesAmount).toBe(646213);
    expect(r.proof!.reconciliationAdjustment).toBe(212);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100YCID 調整額は地域計に巻き込まず、契約小計で完全性を証明してから外部顧客総額へ橋渡しする (13−28=−15)", () => {
    const r = parseOverseasHtml(fx("georows-elim-scope-contract-S100YCID.html"), "2026-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(13604);
    expect(pick(r.facts, "total")!.salesAmount).toBe(94503);
    expect(r.proof!.reconciliationAdjustment).toBe(-15);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100NRWW 発行体側 slop の差 4 (葉5項) は完全読取として採用する (許容 4.5。脱落の差 7/10 は却下のまま)", () => {
    const r = parseOverseasHtml(fx("georows-slop4-simple-S100NRWW.html"), "2021-12-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(355762);
    expect(pick(r.facts, "total")!.salesAmount).toBe(603213);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100PV48 葉和と開示小計が懸け離れた自己矛盾表は却下する (日本 7932007 vs 7923007 の転記誤り)", () => {
    const r = parseOverseasHtml(fx("georows-inconsistent-subtotal-S100PV48.html"), "2022-09-30");
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
  });

  it("S100TYYR 集計行より後の事業 block のその他は地域に混ぜない (pre-fix はその他 4953 を混入→差 4951)", () => {
    const r = parseOverseasHtml(fx("georows-postagg-sonota-excluded-S100TYYR.html"), "2024-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "その他")).toBeUndefined();
    expect(region(r.facts, "日本")!.salesAmount).toBe(85404);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(420575);
    expect(pick(r.facts, "total")!.salesAmount).toBe(505981);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100PUMS 2-D 合計列は葉セル数で許容し、その他の収益 70350 を橋渡しして外部顧客総額を採る", () => {
    const r = parseOverseasHtml(fx("georows-segment-2d-triplet-S100PUMS.html"), "2022-09-30");
    expect(r.status).toBe("ok_geo_rows");
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(46625598);
    expect(pick(r.facts, "total")!.salesAmount).toBe(111250597);
    expect(r.proof!.reconciliationAdjustment).toBe(70350);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100APSL 先頭の営業収益行は block 境界にしない (地域行の後でのみ境界。34文書の誤除外を実証)", () => {
    const r = parseOverseasHtml(fx("georows-leading-total-S100APSL.html"), "2017-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "国内")!.salesAmount).toBe(95564);
    expect(region(r.facts, "海外")!.salesAmount).toBe(18346);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(18346);
    expect(pick(r.facts, "total")!.salesAmount).toBe(113910);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100YCP3 営業費用明細を持つ P/L 表は地域別収益の開示ではないので採用しない (pre-fix は費用内訳のその他 348 を混入)", () => {
    const r = parseOverseasHtml(fx("georows-pl-table-excluded-S100YCP3.html"), "2026-03-31");
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
  });

  it("S100YCP3 先頭総額の国内/海外表は採用する (MD&A ナラティブの海外 32198 と一致)", () => {
    const r = parseOverseasHtml(fx("georows-leading-total-narrative-S100YCP3.html"), "2026-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "国内")!.salesAmount).toBe(111893);
    expect(region(r.facts, "海外")!.salesAmount).toBe(32198);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(32198);
    expect(pick(r.facts, "total")!.salesAmount).toBe(144091);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100O7VN 見出しも値も同一の重複セグメント列は二重計上しない (航空宇宙・精密機械の 2 列ずつ)", () => {
    const r = parseOverseasHtml(fx("georows-dup-segcols-S100O7VN.html"), "2022-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(664476);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(836401);
    expect(pick(r.facts, "total")!.salesAmount).toBe(1500879);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100TU9A 計測機器は小計ではない (セグメント計の部分一致で葉を落とさない。pre-fix は差 121138)", () => {
    const r = parseOverseasHtml(fx("georows-keisoku-not-subtotal-S100TU9A.html"), "2024-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(215594);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(296298);
    expect(pick(r.facts, "total")!.salesAmount).toBe(511895);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100OH0Q 合計に和算される調整額列は葉として検証する (pre-fix は除外して差 85597 で自己矛盾誤認)", () => {
    const r = parseOverseasHtml(fx("georows-feeder-adjustment-S100OH0Q.html"), "2022-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(458504);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(235176);
    expect(pick(r.facts, "total")!.salesAmount).toBe(693682);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100FHUH 連結損益計算書計上額・計列を総額列にする (pre-fix は aggregates 空で当期表を誤殺し前期に後退)", () => {
    const r = parseOverseasHtml(fx("geocols-renketsu-sonneki-keijo-S100FHUH.html"), "2018-12-31");
    expect(r.status).toBe("ok_geo_cols");
    expect(region(r.facts, "日本")!.salesAmount).toBe(46377);
    expect(region(r.facts, "中華圏")!.salesAmount).toBe(59694);
    expect(region(r.facts, "東南アジア")!.salesAmount).toBe(87040);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(196398);
    expect(pick(r.facts, "total")!.salesAmount).toBe(242804);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100R9AG 葉セル誤記は開示総額が裁定し開示小計を信頼する (アジア葉 5793 vs 小計 5973、総額 29461 と整合)", () => {
    const r = parseOverseasHtml(fx("georows-leaf-typo-subtotal-S100R9AG.html"), "2023-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(11801);
    expect(region(r.facts, "アジア")!.salesAmount).toBe(5973);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(17658);
    expect(pick(r.facts, "total")!.salesAmount).toBe(29461);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100YJVF 単位片の有無だけが違う重複列は間引く (pre-fix は種結晶 2 列を二重計上し当期表を誤殺)", () => {
    const r = parseOverseasHtml(fx("georows-dupcol-unitfrag-S100YJVF.html"), "2026-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "国内")!.salesAmount).toBe(305043);
    expect(region(r.facts, "海外")!.salesAmount).toBe(211508);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(211508);
    expect(pick(r.facts, "total")!.salesAmount).toBe(516552);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100OC7S 合計+連結計上額の併記は連結列を値列にする (合計 40900 と連結 40900、単一条件不発の後退回帰を固定)", () => {
    const r = parseOverseasHtml(fx("georows-multi-aggcol-renketsu-S100OC7S.html"), "2022-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(40900);
    expect(region(r.facts, "アジア")!.salesAmount).toBe(8038);
    expect(region(r.facts, "その他")!.salesAmount).toBe(947);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(8985);
    expect(pick(r.facts, "total")!.salesAmount).toBe(49887);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100R98H ranged 表題なしの前期/当期ペアは継承不能で未構造化を維持する (順序 proxy・metric-clean 優先は廃止。原典では節表題 25KB 前方から継承して当期を正採用)", () => {
    const r = parseOverseasHtml(fx("georows-period-pair-nohead-S100R98H.html"), "2023-03-31");
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
  });

  it("S100TTUY 同点の前期/当期ペアは印刷ラベルから継承した当期側を採る (前事業年度@2023-03-31→Z / 当事業年度@2024-03-31=pe→T。文書順は使わない)", () => {
    const r = parseOverseasHtml(fx("georows-fiscal-inherit-S100TTUY.html"), "2024-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(5295526);
    expect(region(r.facts, "東アジア")!.salesAmount).toBe(1149416);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(1965538);
    expect(pick(r.facts, "total")!.salesAmount).toBe(7261065);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("Solレビュー1 S100OJV9-TTUY 最高点 unknown と明示 T の共存は STOP する (OJV9 は score で勝つが score だけでは採用せず、削っての T 都合採用もしない。単独時は OJV9/TTUY 各テストが採用を pin)", () => {
    const r = parseOverseasHtml(fx("georows-unknown-gated-S100OJV9-TTUY.html"), "2024-03-31");
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
  });

  it("S100LVA5 2期比較表は値列頭の当連結@pe で T 確定する (表外の交互節表題は直前=前期の stale。値軸が表外より強い)", () => {
    const r = parseOverseasHtml(fx("georows-twocol-axis-fiscal-S100LVA5.html"), "2021-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(116672);
    expect(region(r.facts, "欧州")!.salesAmount).toBe(191331);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(382552);
    expect(pick(r.facts, "total")!.salesAmount).toBe(499224);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("Gate2 S100TA7H 収益認識 (contract) とセグメント (company) は別 group で未構造化を維持する (Z ペア A/C・T ペア B/D が脚同値・総額不一致。脚のみの収束や順序選択、曖昧からの都合良い選択はしない)", () => {
    const r = parseOverseasHtml(fx("geocols-twopair-tie-S100TA7H.html"), "2024-01-20");
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
  });
  it("Gate2 contractOf: 採用ラベル・caption・表文面の明示のみで判定する (TA7H/W0AF の verbatim)", () => {
    const noFacts: OverseasFact[] = [];
    // TA7H-A (収益認識): 顧客との契約 + 外部顧客 → contract
    expect(
      contractOf(noFacts, "１．顧客との契約から生じる収益を分解した情報", "顧客との契約から生じる収益 外部顧客への 売上高")
    ).toBe("contract");
    // TA7H-C (セグメント): セグメント間内部 → company
    expect(
      contractOf(noFacts, "報告セグメントごとの売上高", "外部顧客への売上高 セグメント間の内部売上高又は振替高 計")
    ).toBe("company");
    // W0AF/OC7S (実在の混在表): 内部 + 契約 → mixed
    expect(
      contractOf(noFacts, "", "顧客との契約から生じる収益 セグメント間の内部売上高又は振替高")
    ).toBe("mixed");
    // 外部顧客ライン単独 → ext。採用ラベル由来でも拾う
    expect(contractOf(noFacts, "", "外部顧客への売上高")).toBe("ext");
    const extTotal: OverseasFact = {
      regionName: "外部顧客への売上高",
      regionKind: "total",
      salesAmount: 1,
      ratioPct: null,
      unitLabel: "千円",
      unitYenFactor: 1000,
      fiscalYearEnd: "2024-01-20",
      isConsolidated: true,
    };
    expect(contractOf([extTotal], "", "日本 アジア")).toBe("ext");
    // 明示なし → unknown (捏造しない)
    expect(contractOf(noFacts, "", "日本 アジア 売上高")).toBe("unknown");
  });

  it("S100CMLA 資産表 (IFRS 移行日列+広窓の最寄り資産名詞) は R1-wide で up-front 除去し売上表のみ残す (tiebreak の metric 分岐は廃止。資産値 34912 の誤採用なし)", () => {
    const r = parseOverseasHtml(fx("georows-tiebreak-metric-clean-S100CMLA.html"), "2017-12-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(14887);
    expect(region(r.facts, "ドイツ")!.salesAmount).toBe(14396);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(75265);
    expect(pick(r.facts, "total")!.salesAmount).toBe(90153);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });

  it("S100G3BR 正準の地域注記をセグメント表より優先する (pre-fix はセグメント切り 28055/北米を地域別として誤採用)", () => {
    const r = parseOverseasHtml(fx("georows-canonical-geo-note-S100G3BR.html"), "2019-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(region(r.facts, "日本")!.salesAmount).toBe(27943);
    expect(region(r.facts, "米国")!.salesAmount).toBe(50724);
    expect(region(r.facts, "中国")!.salesAmount).toBe(59364);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(153320);
    expect(pick(r.facts, "total")!.salesAmount).toBe(181264);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
  });
});

describe("Gate3: per-cell 区間照合 (universal-L 廃止)", () => {
  const intCells = (n: number, v = 0) =>
    Array.from({ length: n }, () => ({ value: v, quantum: 1 }));
  it("cellInterval: 方式別の真値区間 (切捨は片寄り・四捨五入は対称・unknown は包摂)", () => {
    expect(cellInterval(100, 1, "truncate")).toEqual([100, 101]);
    expect(cellInterval(100, 1, "round")).toEqual([99.5, 100.5]);
    expect(cellInterval(100, 1, "unknown")).toEqual([99.5, 101]);
    expect(cellInterval(-5, 1, "truncate")).toEqual([-6, -5]);
    expect(cellInterval(12.5, 0.1, "truncate")).toEqual([12.5, 12.6]);
  });
  it("parseJpNumberCell: 値 + quantum (小数桁から。整数は 1)", () => {
    expect(parseJpNumberCell("17,750,933")).toEqual({ value: 17750933, quantum: 1 });
    expect(parseJpNumberCell("12.5")).toEqual({ value: 12.5, quantum: 0.1 });
    expect(parseJpNumberCell("△ 3,767,119")).toEqual({ value: -3767119, quantum: 1 });
    expect(parseJpNumberCell("―")).toBeNull();
  });
  it("detectRoundingMode: 実文言の端数注記でのみ確定する (DDYF/NRWW verbatim)", () => {
    expect(
      detectRoundingMode("（注）２．百万円未満を切り捨てて記載しております。").mode
    ).toBe("truncate");
    expect(
      detectRoundingMode("要約連結財務諸表については、百万円未満を切捨てて記載しています。").mode
    ).toBe("truncate");
    expect(
      detectRoundingMode("百万円未満の端数は切り捨てております。").mode
    ).toBe("truncate");
    // 株数注記は金額丸めではない → unknown
    expect(detectRoundingMode("ただし、100株未満は切り捨てます。").mode).toBe("unknown");
    // 注記なし (OJX1 級) → unknown
    expect(detectRoundingMode("日本 アジア 売上高").mode).toBe("unknown");
  });
  it("差 4 の完全読取は受理する (NRWW/OJX1/DDYF/PUMS 級。unknown 5 葉で差 4)", () => {
    expect(cellsConsistent(intCells(5, 20), { value: 104, quantum: 1 }, "unknown")).toBe(true);
    expect(cellsConsistent(intCells(6, 20), { value: 124, quantum: 1 }, "unknown")).toBe(true);
    expect(cellsConsistent(intCells(15, 20), { value: 304, quantum: 1 }, "unknown")).toBe(true);
  });
  it("実証済み脱落は却下する (9XV6 差 7・FFET 差 10 は 5 葉の区間外)", () => {
    expect(cellsConsistent(intCells(5, 20), { value: 107, quantum: 1 }, "unknown")).toBe(false);
    expect(cellsConsistent(intCells(5, 20), { value: 110, quantum: 1 }, "unknown")).toBe(false);
    // 境界1: unknown 5 葉の下側 5.5。差 5 は受理・差 6 は却下
    expect(cellsConsistent(intCells(5, 20), { value: 105, quantum: 1 }, "unknown")).toBe(true);
    expect(cellsConsistent(intCells(5, 20), { value: 106, quantum: 1 }, "unknown")).toBe(false);
  });
  it("J2E7 合法差 1 は受理する (2-D 合算 51336 と開示 51337 の区間重なり)", () => {
    expect(cellsConsistent(intCells(4, 12834), { value: 51337, quantum: 1 }, "unknown")).toBe(true);
  });
  it("Solレビュー2: 葉の実 quantum を使う (12.0 は q=0.1 であり 1 に置換しない)", () => {
    // 100(q=1) + 12.0(q=0.1): 和区間 [111.45, 113.1]。総額 113 は重なり受理、
    // 総額 114 は区間外で却下 (q=1 置換なら幅 2 で 114 も受理してしまう)。
    const leaves = [{ value: 100, quantum: 1 }, { value: 12, quantum: 0.1 }];
    expect(cellsConsistent(leaves, { value: 113, quantum: 1 }, "unknown")).toBe(true);
    expect(cellsConsistent(leaves, { value: 114, quantum: 1 }, "unknown")).toBe(false);
  });
});

describe("HOLD-gate: 期首継承 inheritSourceFiscal", () => {
  it("西暦 ranged 表題: 当期は終期=pe で T 確定、不一致は mismatch (Gate1: unknown へ落とさない)", () => {
    expect(
      inheritSourceFiscal("当連結会計年度（自2022年４月１日 至2023年３月31日）", "2023-03-31")
    ).toEqual({ side: "T", date: "2023-03-31" });
    expect(
      inheritSourceFiscal("当連結会計年度（自2022年４月１日 至2023年３月31日）", "2024-03-31")
    ).toBe("mismatch");
  });
  it("西暦 ranged 表題: 前期は終期<pe で Z 確定、pe 以降は mismatch (Gate1)", () => {
    expect(
      inheritSourceFiscal("前連結会計年度（自2021年４月１日 至2022年３月31日）", "2023-03-31")
    ).toEqual({ side: "Z", date: "2022-03-31" });
    expect(
      inheritSourceFiscal("前連結会計年度（自2022年４月１日 至2023年３月31日）", "2023-03-31")
    ).toBe("mismatch");
  });
  it("半角括弧の ranged 表題も拾う (TA7H 式)", () => {
    expect(
      inheritSourceFiscal("当連結会計年度(自 2023年１月21日 至 2024年１月20日)", "2024-01-20")
    ).toEqual({ side: "T", date: "2024-01-20" });
  });
  it("和暦終期は西暦化して pe 照合する (平成28年3月31日=2016-03-31)", () => {
    expect(
      inheritSourceFiscal("当事業年度（自平成27年４月１日 至平成28年３月31日）", "2016-03-31")
    ).toEqual({ side: "T", date: "2016-03-31" });
    expect(
      inheritSourceFiscal("前事業年度（自平成26年４月１日 至平成27年３月31日）", "2016-03-31")
    ).toEqual({ side: "Z", date: "2015-03-31" });
  });
  it("最も近い (最後の) ranged 表題を拾う", () => {
    expect(
      inheritSourceFiscal(
        "前連結会計年度（自2021年４月１日 至2022年３月31日） 報告セグメント 当連結会計年度（自2022年４月１日 至2023年３月31日）",
        "2023-03-31"
      )
    ).toEqual({ side: "T", date: "2023-03-31" });
  });
  it("期数式も終期で判定する (TSNG: 第27期@2024-03-31=pe→T)", () => {
    expect(
      inheritSourceFiscal("第27期（自 2023年４月１日 至 2024年３月31日）", "2024-03-31")
    ).toEqual({ side: "T", date: "2024-03-31" });
    expect(
      inheritSourceFiscal("第26期（自 2022年４月１日 至 2023年３月31日）", "2024-03-31")
    ).toEqual({ side: "Z", date: "2023-03-31" });
  });
  it("ranged 表題なし・終期パース不能は unknown", () => {
    expect(inheritSourceFiscal("（2）地域別の内訳", "2023-03-31")).toBeNull();
    expect(inheritSourceFiscal("当期の売上について説明します", "2023-03-31")).toBeNull();
  });
});

describe("HOLD-gate: fiscal 確定鎖 (値軸→表内→表外)", () => {
  it("unanimousFlatFiscal: 表内表題の全会一致のみ確定する (W92F: 表内当連結@pe→T)", () => {
    expect(
      unanimousFlatFiscal("当連結会計年度(自2024年４月１日 至2025年３月31日) 報告セグメント", "2025-03-31")
    ).toEqual({ side: "T", date: "2025-03-31" });
    expect(
      unanimousFlatFiscal("前連結会計年度（自2023年４月１日 至2024年３月31日）", "2025-03-31")
    ).toEqual({ side: "Z", date: "2024-03-31" });
    // TZ 混在 (2期比較列)・日付不一致は非全会一致→null
    expect(
      unanimousFlatFiscal("前連結会計年度（自2023年４月１日 至2024年３月31日） 当連結会計年度（自2024年４月１日 至2025年３月31日）", "2025-03-31")
    ).toBeNull();
  });
  it("axisFiscal: 値列頭の ranged 表題で確定する (LVA5: 当連結@pe→T)", () => {
    expect(
      axisFiscal("当連結会計年度（自2020年４月１日 至2021年３月31日）", "2021-03-31")
    ).toEqual({ side: "T", date: "2021-03-31" });
    expect(
      axisFiscal("前連結会計年度（自2019年４月１日 至2020年３月31日）", "2021-03-31")
    ).toEqual({ side: "Z", date: "2020-03-31" });
  });
  it("axisFiscal: 単一年月→月末日で判定する (印刷由来。pe への補完はしない)", () => {
    expect(axisFiscal("2025年3月期 売上高", "2025-03-31")).toEqual({ side: "T", date: "2025-03-31" });
    expect(axisFiscal("2024年3月期 売上高", "2025-03-31")).toEqual({ side: "Z", date: "2024-03-31" });
    expect(axisFiscal("令和7年3月期", "2025-03-31")).toEqual({ side: "T", date: "2025-03-31" });
    expect(axisFiscal("2024年2月期", "2025-03-31")).toEqual({ side: "Z", date: "2024-02-29" });
    // 年のみは side のみ (date=null)。複数・年月なしは null
    expect(axisFiscal("2025年 売上高", "2025-03-31")).toEqual({ side: "T", date: null });
    expect(axisFiscal("2024年 売上高", "2025-03-31")).toEqual({ side: "Z", date: null });
    expect(axisFiscal("2024年 2025年 比較", "2025-03-31")).toBeNull();
    expect(axisFiscal("2024年3月期 2025年3月期", "2025-03-31")).toBeNull();
    expect(axisFiscal("合計", "2025-03-31")).toBeNull();
  });
  it("resolveCandidateFiscal: 値軸→表内→表外の順に確定する", () => {
    // 値軸 T が表外 stale-Z に勝つ (LVA5 級)
    expect(
      resolveCandidateFiscal(
        "当連結会計年度（自2020年４月１日 至2021年３月31日）",
        "日本 欧州 北米",
        "前連結会計年度（自2019年４月１日 至2020年３月31日）",
        "2021-03-31"
      )
    ).toEqual({ side: "T", date: "2021-03-31" });
    // 値軸 unknown → 表内 T (W92F 級)
    expect(
      resolveCandidateFiscal(
        "外部顧客への売上高",
        "当連結会計年度(自2024年４月１日 至2025年３月31日)",
        "前連結会計年度（自2023年４月１日 至2024年３月31日）",
        "2025-03-31"
      )
    ).toEqual({ side: "T", date: "2025-03-31" });
    // 値軸・表内 unknown → 表外 (R98H 級)
    expect(
      resolveCandidateFiscal(
        "合計",
        "日本 アジア 欧州",
        "当連結会計年度（自2022年４月１日 至2023年３月31日）",
        "2023-03-31"
      )
    ).toEqual({ side: "T", date: "2023-03-31" });
  });
  it("Gate1 axisFiscal: 印刷日 (年月日) があればその日を保持し、未来日は mismatch", () => {
    expect(axisFiscal("2023年3月31日現在 売上高", "2023-03-31")).toEqual({
      side: "T",
      date: "2023-03-31",
    });
    expect(axisFiscal("2022年3月31日現在 売上高", "2023-03-31")).toEqual({
      side: "Z",
      date: "2022-03-31",
    });
    expect(axisFiscal("2024年3月31日現在 売上高", "2023-03-31")).toBe("mismatch");
    // 境界1: pe 翌日 (pe+1) の印刷日は T ではなく mismatch
    expect(axisFiscal("2023年4月1日現在 売上高", "2023-03-31")).toBe("mismatch");
  });
  it("Gate1 axisFiscal: 素の年月は unknown のまま年 side へ落とさない (Solレビュー)", () => {
    expect(axisFiscal("2025年3月 売上高", "2025-03-31")).toBeNull();
    expect(axisFiscal("2024年3月 売上高", "2025-03-31")).toBeNull();
    // マーカーつきとの混在も unknown (fail-closed)
    expect(axisFiscal("2025年3月期 2024年3月", "2025-03-31")).toBeNull();
    // 明示の期末表記つきは月末化する
    expect(axisFiscal("2025年3月末現在 売上高", "2025-03-31")).toEqual({
      side: "T",
      date: "2025-03-31",
    });
    expect(axisFiscal("2024年3月期末 売上高", "2025-03-31")).toEqual({
      side: "Z",
      date: "2024-03-31",
    });
    // 年のみ (年月なし) は side-only のまま
    expect(axisFiscal("2025年 売上高", "2025-03-31")).toEqual({ side: "T", date: null });
  });
  it("Gate1: 強い側の mismatch は弱い側の確定で上書きしない (推測採用に戻らない)", () => {
    // 値軸の明示矛盾 + 表内の当連結@pe → mismatch (表内の T を採用しない)
    expect(
      resolveCandidateFiscal(
        "2026年3月31日現在 売上高",
        "当連結会計年度(自2024年４月１日 至2025年３月31日)",
        "当連結会計年度（自2024年４月１日 至2025年３月31日）",
        "2025-03-31"
      )
    ).toBe("mismatch");
    // 表内の明示矛盾 + 表外の当連結@pe → mismatch (表外の T を採用しない)
    expect(
      resolveCandidateFiscal(
        "合計",
        "当連結会計年度(自2023年４月１日 至2024年３月31日)",
        "当連結会計年度（自2024年４月１日 至2025年３月31日）",
        "2025-03-31"
      )
    ).toBe("mismatch");
  });
});
