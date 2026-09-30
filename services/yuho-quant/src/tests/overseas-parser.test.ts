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
  singleUnlabeledValueRow,
  effectiveSubheading,
  lastRangedFiscalTitle,
  SINGLE_ROW_SALES_TEXTBLOCK,
  resolveTableScope,
  type OverseasFact,
  type OverseasCapture,
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
  it("S100W16I その他 883 は地理未分類で HOLD (旧: 単一数値列・千円として採用)", () => {
    // 修飾なしその他は地理の立証がないため不採用。数値の推定はしない。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-single-col-sen-S100W16I.html"), "2025-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 450, kind: "rows", labels: ["その他"], amount: 883 },
    ]);
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

  it("S100W1NR 地域blockのその他 58320 は地理未分類で HOLD (旧: 地域だけ拾って採用)", () => {
    // 製品blockの分離は section 除外で維持。地域block自身のその他が未分類。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-stacked-product-geo-blocks-S100W1NR.html"), "2025-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 450, kind: "rows", labels: ["その他"], amount: 58320 },
    ]);
  });

  it("S100W0UT その他 1146 は地理未分類で HOLD (旧: その他の収益を除いて採用)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-total-col-asia-ex-japan-S100W0UT.html"), "2025-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 450, kind: "rows", labels: ["その他"], amount: 1146 },
    ]);
  });

  it("S100W03X その他の地域 6988 は地理未分類で HOLD (旧: 日本/米国/中国と共に採用)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-us-cn-other-S100W03X.html"), "2025-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 450, kind: "rows", labels: ["その他の地域"], amount: 6988 },
    ]);
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

  it("S100W1AE その他 188608 は地理未分類で HOLD (旧: 地域=列として採用)", () => {
    // 空 header の 3438649 (col 5。うち米国? の unaligned のため立証不能)
    // も未分類として HOLD する (黙殺して北米に含めない)。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("geocols-auto-high-overseas-S100W1AE.html"), "2025-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 450, kind: "cols", labels: ["(col 5)", "その他"], amount: 3627257 },
    ]);
  });
});

describe("実在の大型輸出企業 (答え合わせ済み・現実の海外比率と整合)", () => {
  it("トヨタ 7203 その他 4606482 は地理未分類で HOLD (旧: 地域別営業概況として採用)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("geocols-eigyoshueki-toyota-S100Y8NY.html"), "2026-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 450, kind: "cols", labels: ["その他"], amount: 4606482 },
    ]);
  });

  it("任天堂 7974 その他 162130 は地理未分類で HOLD (旧: 米大陸/欧州と共に採用)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("geocols-beitairiku-nintendo-S100W73A.html"), "2025-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 450, kind: "cols", labels: ["その他"], amount: 162130 },
    ]);
  });

  it("大林組 1802 その他 3990 は地理未分類で HOLD (旧: 契約/外部顧客の二層として採用)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-multilevel-contract-vs-external-obayashi-S100W0FJ.html"), "2025-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 450, kind: "rows", labels: ["その他"], amount: 3990 },
    ]);
  });

  it("村田製作所 6981 — 「南北アメリカのうち、米国」内訳行を二重計上しない", () => {
    const r = parseOverseasHtml(fx("georows-uchi-subrow-murata-S100W2ZR.html"), "2025-03-31");
    expect(r.status).toBe("ok_geo_rows");
    expect(pick(r.facts, "domestic")!.salesAmount).toBe(129255);
    // 「うち、米国」を別地域として加算していないこと
    expect(r.facts.some((f) => /うち/.test(f.regionName))).toBe(false);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(1614097);
  });

  it("ソニーG 6758 / ホンダ 7267 その他は地理未分類で HOLD (旧: 海外比率を採用)", () => {
    const capS: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const sony = parseOverseasHtml(fx("georows-sony-S100W19Q.html"), "2025-03-31", { capture: capS });
    expect(sony.status).toBe("geo_present_unstructured");
    expect(sony.facts).toHaveLength(0);
    expect(capS.incomplete).toEqual([
      { start: 450, kind: "rows", labels: ["その他地域"], amount: 207545 },
    ]);
    const capH: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const honda = parseOverseasHtml(fx("geocols-honda-S100VYOD.html"), "2025-03-31", { capture: capH });
    expect(honda.status).toBe("geo_present_unstructured");
    expect(honda.facts).toHaveLength(0);
    expect(capH.incomplete).toEqual([
      { start: 450, kind: "cols", labels: ["その他"], amount: 7454594 },
    ]);
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

  it("W1LQ実有報: 地域別比率を正しく束ね、中国をアジアに二重計上しない", () => {
    // sony 表はその他地域 207545 で地理未分類 HOLD のため、clean な W1LQ 表で
    // bucket 束ねを pin する (rx 自体は不変。W1LQ: 中国/その他アジア/アメリカ/欧州)。
    const r = parseOverseasHtml(fx("georows-america-othernorth-europe-S100W1LQ.html"), "2025-03-31");
    expect(r.status).toBe("ok_geo_rows");
    const total = pick(r.facts, "total")!.salesAmount!;
    const sumBucket = (rx: RegExp) =>
      r.facts
        .filter((f) => f.regionKind === "overseas" && rx.test(f.regionName))
        .reduce((a, f) => a + (f.salesAmount ?? 0), 0);
    expect(sumBucket(REGION_BUCKETS.china.rx)).toBe(9974); // 「中国」行のみ
    expect(sumBucket(REGION_BUCKETS.americas.rx)).toBe(11003); // 「アメリカ」行
    expect(sumBucket(REGION_BUCKETS.asia.rx)).toBe(8199); // 「その他アジア」行。中国を含めない
    expect(+((sumBucket(REGION_BUCKETS.americas.rx) / total) * 100).toFixed(1)).toBeCloseTo(22.9, 0);
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
  it("S100J2E7 北米ブレーキ「－」欠損は地理未分類で HOLD (旧: 欠損を黙殺して品目合算で回復)", () => {
    // 既知地域の売上 leaf 欠損 (北米/ブレーキ「－」) は黙殺しない。旧実装は
    // 北米を落として不完全集合を certified していた (合算 51339 vs 開示 51340)。
    // 欠損つきは amount=null (金額不明) で却下する。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-dup-region-ambiguous-S100J2E7.html"), "2020-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 307, kind: "rows", labels: ["北米"], amount: null },
    ]);
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

  it("S100OJV9 子ラベルその他 5122 は地理未分類で HOLD (旧: P-hier 読替えで採用)", () => {
    // P-hier の sub 読替えで修飾なしその他が地域名になる表は採用前に却下する。
    // sub 経由でも裸その他を地域にできない (W81W 級の numerator 欠落防止)。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-hierchild-S100OJV9.html"), "2022-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 475, kind: "rows", labels: ["その他"], amount: 5122 },
    ]);
  });

  it("S100VI7V 同一blockの製品売上行は地理未分類で HOLD (旧: 売上高行だけ読んで採用)", () => {
    // 地域行と製品行 (警備輸送/重量品建設/物流サポート) の間に section・
    // 集計の境界がなく同一 block のため、製品売上行は未分類として HOLD。
    // 製品行を地域として誤認・採用はしない (旧 total null の正直さは維持)。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-metricpair-S100VI7V.html"), "2022-12-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 479, kind: "rows", labels: ["警備輸送", "警備輸送", "重量品建設", "重量品建設", "物流サポート", "物流サポート"], amount: 5512 },
    ]);
  });

  it("S100VI6W 同一blockの製品売上行は地理未分類で HOLD (旧: 売上収益行だけ読んで採用)", () => {
    // VI7V と同一構造 (IFRS)。同一 block の製品売上行は未分類 HOLD。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-metricpair-ifrs-S100VI6W.html"), "2024-12-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 482, kind: "rows", labels: ["警備輸送", "警備輸送", "重量品建設", "重量品建設", "物流サポート", "物流サポート"], amount: 5588 },
    ]);
  });
});

describe("短行・先頭吸収の missing 検査 (欠損 leaf の黙殺防止)", () => {
  /**
   * 実 fixture の指定行から末尾 td を n 個落とす (値の捏造なし。
   * 欠落 mutation のみ)。対象行は一意でなければ throw する。
   */
  function dropLastTds(html: string, anchor: string, n: number, extra?: string): string {
    const rs = html.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
    const hits = rs.filter((r) => r.includes(anchor) && (!extra || r.includes(extra)));
    if (hits.length !== 1) throw new Error(`row not unique: ${anchor} x${hits.length}`);
    const row = hits[0];
    const tds = row.match(/<td[\s\S]*?<\/td>/g) ?? [];
    return html.replace(row, row.slice(0, row.indexOf(tds[tds.length - n])) + "</tr>");
  }

  it("S100W1LQ 途中地域行の末尾値cell欠落は短行 missing として HOLD (旧: 無言 skip)", () => {
    // 中国行の末尾 9,974 を落とすと vc=5 に対して短行。tableToGridExpanded は
    // 行ごとの幅で push し全表 padding しないため到達可能。欠損 leaf として HOLD。
    const html = dropLastTds(fx("georows-america-othernorth-europe-S100W1LQ.html"), "中国", 1);
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(html, "2025-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 450, kind: "rows", labels: ["中国"], amount: null },
    ]);
  });

  it("S100W1LQ 先頭地域行の値欠落は firstNum 吸収されず HOLD (境界 guard。途中欠落の対照)", () => {
    // 日本行の値セルを全欠落 → firstNum が中国行へずれる。境界 guard が
    // 先頭の日本を missing 検査から除外しない。firstNum/header/vc 契約は不変。
    const html = dropLastTds(fx("georows-america-othernorth-europe-S100W1LQ.html"), "日本", 5);
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(html, "2025-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 450, kind: "rows", labels: ["日本"], amount: null },
    ]);
  });

  it("S100VI7V unknown 製品行の短行は missing として HOLD (有値 5512 の対照)", () => {
    // 売上高行×3 + rowspan-carry の営業利益行×3 (grid 8cell) の末尾値セルを
    // 落として短行化する。ラベル集合は有値 HOLD と同一、amount のみ null。
    // (物流ラベルは素片が markup 分割のため「物流」で anchor する。)
    let html = fx("georows-metricpair-S100VI7V.html");
    for (const p of ["警備輸送", "重量品建設", "物流"]) {
      html = dropLastTds(html, p, 3, "売上高");
    }
    const trs = html.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
    const prodEiei = trs.filter(
      (r, i) => i >= 12 && r.includes("営業利益") && !r.includes("売上高")
    );
    expect(prodEiei).toHaveLength(3);
    for (const row of prodEiei) {
      const tds = row.match(/<td[\s\S]*?<\/td>/g) ?? [];
      html = html.replace(row, row.slice(0, row.indexOf(tds[tds.length - 3])) + "</tr>");
    }
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(html, "2022-12-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 479, kind: "rows", labels: ["警備輸送", "警備輸送", "重量品建設", "重量品建設", "物流サポート", "物流サポート"], amount: null },
    ]);
  });
});

describe("保存前検証: caller 共通境界は壊れた集合を保存させない", () => {
  // 実 parse 出力への破壊注入 (negative)。正常系は各回復テストで通す。
  // proof は必須 (facts-only は STOP)。正常系は parse 出力の proof を渡す。
  // J2E7 は北米ブレーキ「－」欠損、VI6W/VI7V は同一block製品行で地理未分類
  // HOLD のため正常系の種に使えない (各テストで HOLD を pin)。
  // clean な YBHC (P-2D 回復・total あり) を種にする。
  const real = () =>
    parseOverseasHtml(fx("georows-2dproduct-sales-S100YBHC.html"), "2026-03-31");

  it("正常集合は通る (YBHC・TA7H・空集合)", () => {
    expect(() => validateOverseasSaveSet(real().facts, real().proof)).not.toThrow();
    // VI7V は同一block製品行で HOLD のため第二の種に使えない。clean な
    // TA7H (cols survivor) を種にする。
    const cols = parseOverseasHtml(fx("geocols-twopair-tie-S100TA7H.html"), "2024-01-20");
    expect(() => validateOverseasSaveSet(cols.facts, cols.proof)).not.toThrow();
    expect(() => validateOverseasSaveSet([], undefined)).not.toThrow();
  });

  it("proof 欠損は throw (facts-only fallback は廃止)", () => {
    expect(() => validateOverseasSaveSet(real().facts, undefined)).toThrow();
  });

  it("地理未分類の backstop: 旧 proof・nonzero・非有限は算術の前に throw (W81W omission 級)", () => {
    // 最小 consistency 集合 (日本 100 + 米国 50。算術 clean)。
    const facts = [
      {
        regionName: "日本",
        regionKind: "domestic",
        salesAmount: 100,
        ratioPct: null,
        unitLabel: "百万円",
        unitYenFactor: 1000000,
        fiscalYearEnd: "2020-03-31",
        isConsolidated: true,
      },
      {
        regionName: "米国",
        regionKind: "overseas",
        salesAmount: 50,
        ratioPct: null,
        unitLabel: "百万円",
        unitYenFactor: 1000000,
        fiscalYearEnd: "2020-03-31",
        isConsolidated: true,
      },
      {
        regionName: "海外売上高",
        regionKind: "overseas_total",
        salesAmount: 50,
        ratioPct: null,
        unitLabel: "百万円",
        unitYenFactor: 1000000,
        fiscalYearEnd: "2020-03-31",
        isConsolidated: true,
      },
    ] as Parameters<typeof validateOverseasSaveSet>[0];
    const cleanProof = {
      reconciliationAdjustment: 0,
      geoUnclassified: 0,
      mode: "truncate",
      sumLo: 150,
      sumHi: 150,
      totalLo: null,
      totalHi: null,
    } as Parameters<typeof validateOverseasSaveSet>[1];
    // 旧 bad pair: その他を omit した facts + 調整額=Other の旧 proof
    // (field なし)。算術は通っても backstop で STOP (default 0 なし)。
    const legacy = {
      reconciliationAdjustment: 1462,
      mode: "truncate",
      sumLo: 1612,
      sumHi: 1612,
      totalLo: null,
      totalHi: null,
    } as unknown as Parameters<typeof validateOverseasSaveSet>[1];
    expect(() => validateOverseasSaveSet(facts, legacy)).toThrow("地理未分類");
    // nonzero (W81W その他 1462 が未分類として残る pair)。
    expect(() =>
      validateOverseasSaveSet(facts, { ...cleanProof!, geoUnclassified: 1462 })
    ).toThrow("地理未分類");
    // 非有限。
    expect(() =>
      validateOverseasSaveSet(facts, { ...cleanProof!, geoUnclassified: NaN })
    ).toThrow("地理未分類");
    // 対照: clean proof は通る。明示消去の調整額つきも通る (対象外)。
    expect(() => validateOverseasSaveSet(facts, cleanProof)).not.toThrow();
    const elimProof = { ...cleanProof!, reconciliationAdjustment: -20, sumLo: 130, sumHi: 130 };
    expect(() => validateOverseasSaveSet(facts, elimProof)).not.toThrow();
  });

  it("地理未分類の backstop: 修飾なしその他 fact は保存させない (label 側)", () => {
    const facts = [
      {
        regionName: "日本",
        regionKind: "domestic",
        salesAmount: 100,
        ratioPct: null,
        unitLabel: "百万円",
        unitYenFactor: 1000000,
        fiscalYearEnd: "2020-03-31",
        isConsolidated: true,
      },
      {
        regionName: "その他",
        regionKind: "overseas",
        salesAmount: 50,
        ratioPct: null,
        unitLabel: "百万円",
        unitYenFactor: 1000000,
        fiscalYearEnd: "2020-03-31",
        isConsolidated: true,
      },
      {
        regionName: "海外売上高",
        regionKind: "overseas_total",
        salesAmount: 50,
        ratioPct: null,
        unitLabel: "百万円",
        unitYenFactor: 1000000,
        fiscalYearEnd: "2020-03-31",
        isConsolidated: true,
      },
    ] as Parameters<typeof validateOverseasSaveSet>[0];
    const proof = {
      reconciliationAdjustment: 0,
      geoUnclassified: 0,
      mode: "truncate",
      sumLo: 150,
      sumHi: 150,
      totalLo: null,
      totalHi: null,
    } as Parameters<typeof validateOverseasSaveSet>[1];
    expect(() => validateOverseasSaveSet(facts, proof)).toThrow("地理未立証");
  });

  it("重複地域・単位混在・期末混在・連結混在は throw", () => {
    const dup = [...real().facts, { ...real().facts[0]! }];
    expect(() => validateOverseasSaveSet(dup, real().proof)).toThrow();
    const unitMix = real().facts.map((f, i) =>
      // YBHC は千円 (factor 1000) のため 1 (円) を混ぜて mix を作る。
      i === 0 ? { ...f, unitYenFactor: 1 } : f
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
  it("S100DA2Y 売上blockのその他 2453299 は地理未分類で HOLD (旧: 売上blockのみ採用)", () => {
    // 営業利益blockの分離は section 除外で維持。売上block自身のその他が未分類。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-salesblock-profitblock-S100DA2Y.html"), "2018-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 488, kind: "rows", labels: ["その他"], amount: 2453299 },
    ]);
  });

  it("S100OE1D 地域blockのその他 341247 は地理未分類で HOLD (旧: 地域blockのみ採用)", () => {
    // 用途別blockの分離は維持。地域block自身のその他 (341247) が未分類。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-regionblock-productblock-S100OE1D.html"), "2022-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 486, kind: "rows", labels: ["その他"], amount: 341247 },
    ]);
  });

  it("S100OH3F 地域blockのその他 15741 は地理未分類で HOLD (旧: 中近東まで読んで採用)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-regionblock-productblock-nakachinto-S100OH3F.html"), "2022-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 493, kind: "rows", labels: ["その他"], amount: 15741 },
    ]);
  });

  it("S100YDNF 地域blockのその他 2534 は地理未分類で HOLD (旧: 地域blockのみ採用)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-zaiblock-regionblock-S100YDNF.html"), "2026-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 484, kind: "rows", labels: ["その他"], amount: 2534 },
    ]);
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
    // W16I はその他 883 の地理未分類で HOLD (採用集合に入れない)。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const h = parseOverseasHtml(fx("georows-single-col-sen-S100W16I.html"), "2025-03-31", { capture });
    expect(h.status).toBe("geo_present_unstructured");
    expect(h.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 450, kind: "rows", labels: ["その他"], amount: 883 },
    ]);
  });
});

describe("語彙: アセアンは海外地域 (S100OIVD ほか10文書で脱落を実証)", () => {
  it("S100OIVD その他 1305 は地理未分類で HOLD (旧: アセアン含め採用)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-asean-S100OIVD.html"), "2022-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 456, kind: "rows", labels: ["その他"], amount: 1305 },
    ]);
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

  it("S100YR3G 表題ゲートは通過しその他 + 事業収益合計で地理未分類 HOLD (旧: エリア別売上表として採用)", () => {
    // 製品ライン標識で誤殺されないことは維持 (scanned=1)。geo で HOLD する。
    // 対照: 事業収益合計 (事業+収益の複合 10886) は metric 語一致では免除
    // されず HOLD する (完全一致の実証済 metric のみ免除)。その他 783 と合算。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-areaproduct-sales-S100YR3G.html"), "2026-04-30", { capture });
    expect(r.tablesScanned).toBe(1);
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 500, kind: "rows", labels: ["その他", "事業収益合計"], amount: 11669 },
    ]);
  });
});

describe("消去/調整: 調整額行は地域計に加算して照合する (S100VYJU で実証)", () => {
  it("S100VYJU 本表は読めるがその他 5723 で地理未分類 HOLD (旧: 調整額 1766 を加算して採用)", () => {
    // R1・B2 で本表が読めることは維持 (scanned=1)。geo で HOLD する。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-adjustment-S100VYJU.html"), "2025-03-31", { capture });
    expect(r.tablesScanned).toBe(1);
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 452, kind: "rows", labels: ["その他"], amount: 5723 },
    ]);
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

  it("S100AJAN R1 は誤殺せず北米：欠損+その他で地理未分類 HOLD (旧: R1 を通過して採用)", () => {
    // R1 の誤殺防止は維持 (scanned=1)。北米：行の空セル (既知地域の leaf
    // 欠損) とその他 215111 が未分類で HOLD する。欠損つきは amount=null。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-impairment-caption-sales-kept-S100AJAN.html"), "2017-03-31", { capture });
    expect(r.tablesScanned).toBe(1);
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 492, kind: "rows", labels: ["北米：", "その他"], amount: null },
    ]);
  });

  it("S100O4SN 入れ子内側の減損損失表も表頭-R1 で除外される (内側表の窓は表題を含まず heading-R1 をすり抜けた。pre-fix は減損額 476690 を連結売上高にしていた)", () => {
    const r = parseOverseasHtml(fx("georows-impairment-nested-excluded-S100O4SN.html"), "2022-02-28");
    expect(r.status).toBe("no_overseas_table");
    expect(r.facts).toHaveLength(0);
  });

  it("S100QHOQ 省略文はかわすがその他 10 で地理未分類 HOLD (旧: P/L 売上収益 90 と一致して採用)", () => {
    // 省略宣言文中の非流動資産で誤殺されないことは維持 (scanned=1)。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-omission-sales-kept-S100QHOQ.html"), "2022-12-31", { capture });
    expect(r.tablesScanned).toBe(1);
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 519, kind: "rows", labels: ["その他"], amount: 10 },
    ]);
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
  it("S1009XV6 全角数字のその他５は読んで地理未分類で HOLD (旧: 読んで採用)", () => {
    // 全角５を 5 として読めることは維持 (amount=5 が証明)。地理未分類で HOLD。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-fullwidth-sonota-S1009XV6.html"), "2016-12-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 136, kind: "rows", labels: ["その他"], amount: 5 },
    ]);
  });

  it("S100ACAR その他（注）１列 1748 は地理未分類で HOLD (旧: 照合に加えて採用)", () => {
    // 注番号つきその他を認識して HOLD する。未分類の照合加算は廃止する
    // (numerator 欠落の温存になるため。不採用 + 不加算の両方)。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("geocols-segnote-sonota-chu-S100ACAR.html"), "2017-02-28", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 373, kind: "cols", labels: ["その他"], amount: 1748 },
    ]);
  });

  it("S100IWKH 事業列スポーツ施設事業 512497 は地理未分類で HOLD (旧: 照合に加えて採用)", () => {
    // 事業列を認識して HOLD する。未分類の照合加算は廃止する (ACAR と同一)。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("geocols-segnote-business-col-S100IWKH.html"), "2020-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 192, kind: "cols", labels: ["スポーツ施設事業"], amount: 512497 },
    ]);
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

  it("S100TRBB その他地域 5383 は地理未分類で HOLD (旧: 橋渡しして採用)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-contract-shojita-S100TRBB.html"), "2024-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 327, kind: "rows", labels: ["その他地域"], amount: 5383 },
    ]);
  });

  it("S100OJ6E その他 6979 は地理未分類で HOLD (旧: 橋渡しして採用)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-contract-bunkaijoho-S100OJ6E.html"), "2022-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 310, kind: "rows", labels: ["その他"], amount: 6979 },
    ]);
  });

  it("S100TSSV その他 11396 は地理未分類で HOLD (旧: 橋渡しして採用)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-contract-ninshiki-S100TSSV.html"), "2024-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 107, kind: "rows", labels: ["その他"], amount: 11396 },
    ]);
  });

  it("S100YCID その他 2612 は地理未分類で HOLD (旧: 契約小計の完全性で橋渡し)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-elim-scope-contract-S100YCID.html"), "2026-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 371, kind: "rows", labels: ["その他"], amount: 2612 },
    ]);
  });

  it("S100NRWW その他 78428 は地理未分類で HOLD (旧: slop 許容で採用)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-slop4-simple-S100NRWW.html"), "2021-12-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 339, kind: "rows", labels: ["その他"], amount: 78428 },
    ]);
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

  it("S100PUMS その他 3530062 は地理未分類で HOLD (旧: 橋渡しして採用)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-segment-2d-triplet-S100PUMS.html"), "2022-09-30", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 284, kind: "rows", labels: ["その他"], amount: 3530062 },
    ]);
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

  it("S100O7VN その他 77872 は地理未分類で HOLD (旧: 重複列を一本化して採用)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-dup-segcols-S100O7VN.html"), "2022-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 315, kind: "rows", labels: ["その他"], amount: 77872 },
    ]);
  });

  it("S100TU9A その他 28411 は地理未分類で HOLD (旧: 計測機器を葉として採用)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-keisoku-not-subtotal-S100TU9A.html"), "2024-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 303, kind: "rows", labels: ["その他"], amount: 28411 },
    ]);
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

  it("S100OC7S その他 947 は地理未分類で HOLD (旧: 連結列を値列に採用)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-multi-aggcol-renketsu-S100OC7S.html"), "2022-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 1120, kind: "rows", labels: ["その他"], amount: 947 },
    ]);
  });

  it("S100R98H ranged 表題なしの前期/当期ペアは継承不能で未構造化を維持する (順序 proxy・metric-clean 優先は廃止。原典では節表題 25KB 前方から継承して当期を正採用)", () => {
    const r = parseOverseasHtml(fx("georows-period-pair-nohead-S100R98H.html"), "2023-03-31");
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
  });

  it("S100TTUY 前期/当期の両表ともその他で地理未分類 HOLD (旧: 当期側を継承採用)", () => {
    // 両表とも地域blockにその他を持つため継承の前に HOLD する (表順に記録)。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-fiscal-inherit-S100TTUY.html"), "2024-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 860, kind: "rows", labels: ["その他"], amount: 54143 },
      { start: 10880, kind: "rows", labels: ["その他"], amount: 291002 },
    ]);
  });

  it("Solレビュー1 S100OJV9-TTUY 最高点 unknown と明示 T の共存は STOP する (OJV9 は score で勝つが score だけでは採用せず、削っての T 都合採用もしない。単独時は OJV9/TTUY 各テストが採用を pin)", () => {
    const r = parseOverseasHtml(fx("georows-unknown-gated-S100OJV9-TTUY.html"), "2024-03-31");
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
  });

  it("S100LVA5 その他の地域 88997 は地理未分類で HOLD (旧: 値軸で T 確定して採用)", () => {
    // 空ラベルの 499224 (row 5。総額級だが無証拠) も未分類として HOLD する。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-twocol-axis-fiscal-S100LVA5.html"), "2021-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 6966, kind: "rows", labels: ["その他の地域", "(row 5)"], amount: 588221 },
    ]);
  });

  it("Gate2 S100TA7H その他表2つが HOLD し clean な T 表だけ残って採用 (旧: 4候補の同点 tie で STOP)", () => {
    // 旧 STOP は T 同点ペア (35509/176226) の tie が原因。tie の一角 35509 が
    // その他 244082 で未分類脱落し (立証つき除外。都合選択ではない)、残った
    // clean な T 表が fiscal で確定する。Z 表は fiscal-excluded。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("geocols-twopair-tie-S100TA7H.html"), "2024-01-20", { capture });
    expect(r.status).toBe("ok_geo_cols");
    expect(region(r.facts, "日本")!.salesAmount).toBe(17259842);
    expect(region(r.facts, "欧州")!.salesAmount).toBe(432093);
    expect(region(r.facts, "中国")!.salesAmount).toBe(872867);
    expect(region(r.facts, "韓国")!.salesAmount).toBe(214834);
    expect(region(r.facts, "米国")!.salesAmount).toBe(387645);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(1907439);
    expect(pick(r.facts, "total")!.salesAmount).toBe(19167282);
    expect(capture.incomplete).toEqual([
      { start: 2252, kind: "cols", labels: ["その他"], amount: 290623 },
      { start: 35509, kind: "cols", labels: ["その他"], amount: 244082 },
    ]);
    expect(() => validateOverseasSaveSet(r.facts, r.proof)).not.toThrow();
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

  it("S100CMLA 資産表を除去し残った売上表はその他 34256 で地理未分類 HOLD (旧: 売上表のみ残して採用)", () => {
    // R1-wide の資産除去は維持 (資産値の混入なし)。残った売上表が geo で HOLD。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-tiebreak-metric-clean-S100CMLA.html"), "2017-12-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 3000, kind: "rows", labels: ["その他"], amount: 34256 },
    ]);
  });

  it("S100G3BR 両表ともその他で地理未分類 HOLD (旧: 正準の地域注記を優先採用)", () => {
    // セグメント表 (cols その他 7880) も正準の地域注記 (rows その他 43232) も
    // 未分類を持つため HOLD する。正準の注記でも裸その他は採用できない。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("georows-canonical-geo-note-S100G3BR.html"), "2019-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 992, kind: "cols", labels: ["その他"], amount: 7880 },
      { start: 75567, kind: "rows", labels: ["その他"], amount: 43232 },
    ]);
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

describe("単一行 geocols 限定分岐: 直前小見出し + TextBlock + caption 明示日 (S100R98H 81/83)", () => {
  // 表間 caption は R98H 原本の表81→82・表82→83 間の原文を strip した逐語
  // (E00766 有報 2023-03-31 期。表81=前連結売上高 152536 / 表82=前連結
  // 有形固定資産 67165 / 表83=当連結売上高 172811 / 表84=当連結有形固定資産 62019)。
  const CAP83 =
    "３．主要な顧客ごとの情報 外部顧客への売上高のうち、連結損益計算書の売上高の10％以上を占める相手先がないため、記載はありません。 当連結会計年度（自2022年４月１日 至2023年３月31日） １．製品及びサービスごとの情報 セグメント情報に同様の情報を開示しているため、記載を省略しております。 ２．地域ごとの情報 (1）売上高";
  const CAP82 =
    "（注）売上高は顧客の所在地を基礎とし、国又は地域に分類しております。 (2）有形固定資産";
  const SALES_TB = SINGLE_ROW_SALES_TEXTBLOCK;
  const ASSET_TB = "PropertyPlantAndEquipmentInformationForEachRegionTextBlock";
  type Roles = Parameters<typeof singleUnlabeledValueRow>[3];
  const grid83 = [
    ["（単位：百万円）", "", "", ""],
    ["", "日本", "アジア地域", "合計"],
    ["100,547", "18,455", "7,954", "172,811"],
  ];
  const roles: Roles = ["other", "domestic", "overseas", "aggregate"];

  it("E2E: 表81/83 ともその他の地域で地理未分類 HOLD (旧: 表83 のみ採用)", () => {
    // 前期表 (その他の地域 5122) も当連結表 (その他の地域 7954) も未分類で
    // HOLD する。資産表 (フランス列) の値は混入しない。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("geocols-singlerow-S100R98H.html"), "2023-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(r.facts.some((f) => f.regionName === "フランス")).toBe(false);
    expect(capture.incomplete).toEqual([
      { start: 720, kind: "cols", labels: ["その他の地域"], amount: 5122 },
      { start: 13988, kind: "cols", labels: ["その他の地域"], amount: 7954 },
    ]);
  });

  it("E2E: FY 証拠なし単一行表 (表82 級の切出し) は候補を作らない", () => {
    const r = parseOverseasHtml(fx("geocols-singlerow-nofy-S100R98H.html"), "2023-03-31");
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
  });

  it("E2E: 自表 caption に FY なし (前表のみ) は STOP する (wide 継承で採用しない)", () => {
    // fystop fixture = 4表 fixture の表83 caption から FY 文だけ除去
    // (表・TextBlock・小見出しは原本のまま) + 完全な表83 複製を後置。
    // 複製は単独で T 採用できる正表のため、0 facts は黙殺でなく STOP の証拠。
    const r = parseOverseasHtml(fx("geocols-singlerow-fystop-S100R98H.html"), "2023-03-31");
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
  });

  it("受理形: 地域 header + 唯一の無ラベル数値行 + 売上 TextBlock + sales 直前小見出し → 値行", () => {
    expect(singleUnlabeledValueRow(grid83, 1, 4, roles, 3, CAP83, SALES_TB)).toBe(2);
  });

  it("小見出し箍: 売上脚注の後の資産見出しが有効になり失効する (表82 級)", () => {
    expect(effectiveSubheading(CAP82)).toBe("有形固定資産");
    expect(singleUnlabeledValueRow(grid83, 1, 4, roles, 3, CAP82, SALES_TB)).toBe(-1);
    expect(effectiveSubheading(CAP83)).toBe("売上高");
    expect(effectiveSubheading("番号見出しなし")).toBeNull();
  });

  it("TextBlock 箍: 売上 TextBlock の囲みでなければ -1 (資産/なし)", () => {
    expect(singleUnlabeledValueRow(grid83, 1, 4, roles, 3, CAP83, ASSET_TB)).toBe(-1);
    expect(singleUnlabeledValueRow(grid83, 1, 4, roles, 3, CAP83, null)).toBe(-1);
  });

  it("FY 箍: caption 最終 ranged 表題だけが期の証拠 (表82 級はなし)", () => {
    expect(lastRangedFiscalTitle(CAP83)).toBe(
      "当連結会計年度（自2022年4月1日 至2023年3月31日）"
    );
    expect(lastRangedFiscalTitle(CAP82)).toBeNull();
  });

  it("sales 箍: 直前小見出しに sales metric がなければ -1", () => {
    expect(
      singleUnlabeledValueRow(
        grid83,
        1,
        4,
        roles,
        3,
        "当連結会計年度（自2022年４月１日 至2023年３月31日） (2）有形固定資産",
        SALES_TB
      )
    ).toBe(-1);
  });

  it("形状箍: 値行が2行以上・col0 ラベルつき・非数値セル・総額列なしは -1", () => {
    const two = [...grid83, ["1", "2", "3", "6"]];
    expect(singleUnlabeledValueRow(two, 1, 4, roles, 3, CAP83, SALES_TB)).toBe(-1);
    const labeled = grid83.map((r) => [...r]);
    labeled[2][0] = "有形固定資産";
    expect(singleUnlabeledValueRow(labeled, 1, 4, roles, 3, CAP83, SALES_TB)).toBe(-1);
    const dash = grid83.map((r) => [...r]);
    dash[2][2] = "－";
    expect(singleUnlabeledValueRow(dash, 1, 4, roles, 3, CAP83, SALES_TB)).toBe(-1);
    expect(singleUnlabeledValueRow(grid83, 1, 4, roles, -1, CAP83, SALES_TB)).toBe(-1);
  });
});

describe("Gate0 — 表ローカル連結区分 (table-local scope)", () => {
  const allScope = (facts: OverseasFact[]) =>
    new Set(facts.map((f) => String(f.isConsolidated)));

  it("S100AO7M 当連結 range 表題 + NotesToConsolidated → true (アジア/米州は2列和)", () => {
    const r = parseOverseasHtml(fx("scope-ao7m-geocol-S100AO7M.html"), "2017-03-31");
    expect(r.status).toBe("ok_geo_cols");
    expect(allScope(r.facts)).toEqual(new Set(["true"]));
    expect(pick(r.facts, "domestic")!.salesAmount).toBe(501837);
    expect(region(r.facts, "アジア")!.salesAmount).toBe(280265);
    expect(region(r.facts, "米州")!.salesAmount).toBe(232112);
    expect(region(r.facts, "欧州")!.salesAmount).toBe(76980);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(589357);
    expect(pick(r.facts, "total")!.salesAmount).toBe(1091195);
    expect(r.facts[0]!.fiscalYearEnd).toBe("2017-03-31");
  });

  it("S100OE0P 販売実績は true + 前表の生産実績は候補化しない (noleak)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("scope-oe0p-prod-sales-S100OE0P.html"), "2022-03-31", { capture });
    expect(r.status).toBe("ok_geo_rows");
    expect(allScope(r.facts)).toEqual(new Set(["true"]));
    // 生産実績表は候補にすらならない (販売実績表のみが候補)
    expect(capture.candidates.length).toBe(1);
    expect(capture.candidates[0]!.selected).toBe(true);
    expect(pick(r.facts, "domestic")!.salesAmount).toBe(16163);
    expect(region(r.facts, "南北アメリカ")!.salesAmount).toBe(11814);
    expect(region(r.facts, "中国")!.salesAmount).toBe(5209);
    expect(region(r.facts, "東南アジア／インド")!.salesAmount).toBe(4497);
    expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(21520);
    // 生産高の計 37537 ではなく販売実績の計 37686 であること
    expect(pick(r.facts, "total")!.salesAmount).toBe(37686);
    expect(r.facts[0]!.fiscalYearEnd).toBe("2022-03-31");
  });

  it("S100R1GC/S100TPW6/S100W2OC/S100YEVT 当連結販売実績 → true (FY 継承)", () => {
    const cases = [
      { fx: "scope-r1gc-sales-S100R1GC.html", pe: "2023-03-31", domestic: 17975, ot: 28818, total: 46794 },
      { fx: "scope-tpw6-sales-S100TPW6.html", pe: "2024-03-31", domestic: 19607, ot: 33377, total: 52985 },
      { fx: "scope-w2oc-sales-S100W2OC.html", pe: "2025-03-31", domestic: 19433, ot: 36077, total: 55512 },
      { fx: "scope-yevt-sales-S100YEVT.html", pe: "2026-03-31", domestic: 19643, ot: 31521, total: 51165 },
    ] as const;
    for (const c of cases) {
      const r = parseOverseasHtml(fx(c.fx), c.pe);
      expect(r.status).toBe("ok_geo_rows");
      expect(allScope(r.facts)).toEqual(new Set(["true"]));
      expect(pick(r.facts, "domestic")!.salesAmount).toBe(c.domestic);
      expect(pick(r.facts, "overseas_total")!.salesAmount).toBe(c.ot);
      expect(pick(r.facts, "total")!.salesAmount).toBe(c.total);
      expect(r.facts[0]!.fiscalYearEnd).toBe(c.pe);
    }
  });

  it("S100OH3F その他 651540 は地理未分類で HOLD (旧: 個別 false で採用)", () => {
    // scope-false の表自体が未分類で HOLD する。false 解決の機構は不変。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("scope-oh3f-jigyotitle-S100OH3F.html"), "2022-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 2158, kind: "cols", labels: ["その他"], amount: 651540 },
    ]);
  });

  it("S100QHYM 同一blockの製品行は地理未分類で HOLD (旧: 連結調整前 null で採用)", () => {
    // VI7V と同一表構造のため製品行で HOLD する。null 解決の機構は不変
    // (resolveTableScope の unit pin で維持)。E2E の null pin は喪失。
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("scope-qhym-chouseimae-S100QHYM.html"), "2022-12-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 2018, kind: "rows", labels: ["警備輸送", "警備輸送", "重量品建設", "重量品建設", "物流サポート", "物流サポート"], amount: 5512 },
    ]);
  });

  it("resolveTableScope: 実 caption 文字列の判定 (doc@offset 由来)", () => {
    const TB_CONS = "NotesToConsolidatedFinancialStatementsIFRSTextBlock";
    // S100AO7M caption の range 表題 (実文) → true
    expect(
      resolveTableScope(
        "売上高は顧客の所在地を基礎とし、国又は地域に分類しております。当連結会計年度（自 2016年４月１日 至 2017年３月31日）（単位：百万円）",
        TB_CONS,
        null
      )
    ).toBe(true);
    // S100OH3F caption の range 表題 (実文) → false
    expect(
      resolveTableScope(
        "記載を省略しております。当事業年度(自 2021年４月１日 至 2022年３月31日 ) １ 製品及びサービスごとの情報",
        "RevenuesFromExternalCustomersInformationForEachRegionTextBlock",
        null
      )
    ).toBe(false);
    // S100QHYM caption の注記 (実文) → null (連結調整前は positive でない)
    expect(
      resolveTableScope(
        "※「海外売上高」は連結調整前数値となります。",
        "BusinessPolicyBusinessEnvironmentIssuesToAddressEtcTextBlock",
        null
      )
    ).toBeNull();
    // S100VI6W caption の注記 (実文) → null (連結調整後は exact list 外)
    expect(
      resolveTableScope(
        "※「海外売上収益」は連結調整後数値となります。",
        "BusinessPolicyBusinessEnvironmentIssuesToAddressEtcTextBlock",
        null
      )
    ).toBeNull();
    // S100V5SX caption の組替注記 (実文): 個別財務諸表の言及は false 駆動
    // しない (false は FY 表題のみ)。当連結 exact + grid 連結 → true。
    expect(
      resolveTableScope(
        "当連結会計年度より、海外事業規模の拡大に伴いロイヤリティーの重要性が増していることを踏まえて、従来、個別財務諸表において「営業外収益」の区分に表示しておりました",
        "NotesSegmentInformationEtcConsolidatedFinancialStatementsTextBlock",
        true
      )
    ).toBe(true);
    // S1009CRX 脚注 (実文): 裸の非連結言及は positive 証拠にしない
    expect(
      resolveTableScope(
        "※１．非連結子会社及び関連会社に対するものは次のとおりであります。",
        null,
        null
      )
    ).toBeNull();
  });

  it("resolveTableScope: 個別 FY 表題 × 他 positive は mismatch (3602 未観測の fail-closed pin)", () => {
    // 実 caption × 実 gridScope 値の組合せ。文書実例はないが仕様を固定する。
    expect(
      resolveTableScope(
        "当事業年度(自 2021年４月１日 至 2022年３月31日 )",
        null,
        true
      )
    ).toBe("mismatch");
    expect(
      resolveTableScope(
        "当連結会計年度（自 2016年４月１日 至 2017年３月31日）",
        null,
        false
      )
    ).toBe("mismatch");
  });

  it("capture trace: AO7M は実 reducer の採用列・総額列を運ぶ (推定なし)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("scope-ao7m-geocol-S100AO7M.html"), "2017-03-31", { capture });
    expect(r.status).toBe("ok_geo_cols");
    expect(capture.candidates.length).toBe(1);
    const c = capture.candidates[0]!;
    expect(c.selected).toBe(true);
    expect(c.textBlock).toBe("NotesToConsolidatedFinancialStatementsIFRSTextBlock");
    expect(c.contextRef).toBe("CurrentYearDuration");
    expect(c.scope).toBe(true);
    expect(c.fiscal).toBe("T:2017-03-31");
    expect(c.trace?.kind).toBe("cols");
    expect(c.trace?.valueIndex).toBe(2);
    expect(c.trace?.valueLabel).toBe("売上高");
    expect(c.trace?.totalIndex).toBe(7);
    expect(c.trace?.totalLabel).toBe("合計");
    // アジア/米州は 2 列の合算採用 (leaf 全 index を保持)
    expect(c.trace?.adopted).toEqual([
      { indices: [1], label: "日本" },
      { indices: [2, 3], label: "アジア" },
      { indices: [4, 5], label: "米州" },
      { indices: [6], label: "欧州" },
    ]);
  });

  it("capture trace: OE0P は実 reducer の採用行・総額行を運ぶ (推定なし)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("scope-oe0p-prod-sales-S100OE0P.html"), "2022-03-31", { capture });
    expect(r.status).toBe("ok_geo_rows");
    const c = capture.candidates.find((x) => x.selected)!;
    expect(c.textBlock).toBe(
      "ManagementAnalysisOfFinancialPositionOperatingResultsAndCashFlowsTextBlock"
    );
    expect(c.contextRef).toBe("FilingDateInstant");
    expect(c.scope).toBe(true);
    expect(c.trace?.kind).toBe("rows");
    expect(c.trace?.valueIndex).toBe(1);
    expect(c.trace?.valueLabel).toBe("金額(百万円)");
    expect(c.trace?.totalIndex).toBe(5);
    expect(c.trace?.totalLabel).toBe("合計");
    expect(c.trace?.adopted).toEqual([
      { indices: [1], label: "日本" },
      { indices: [2], label: "南北アメリカ" },
      { indices: [3], label: "中国" },
      { indices: [4], label: "東南アジア／インド" },
    ]);
  });
});

describe("実表回帰: W81W/XRWN のその他 omission は HOLD する (actual fixtures)", () => {
  // 旧実装 (scope-only) はセグメント注記のその他を照合に回して分子から落とし
  // certified していた (W81W ot=73106=米国のみ、その他 1462 を欠落)。
  // 2 fixture は原文書の旧採用表の verbatim 抜粋 (provenance は fixture 頭注)。
  it("S100W81W その他 1462 は地理未分類で HOLD (注: 海外活動を含む事業で全体立証なし)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("geocols-segnote-sonota-S100W81W.html"), "2025-03-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 482, kind: "cols", labels: ["その他"], amount: 1462 },
    ]);
  });

  it("S100XRWN その他 18570 は地理未分類で HOLD (旧: ot=120817 に欠落)", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const r = parseOverseasHtml(fx("geocols-segnote-sonota-S100XRWN.html"), "2025-12-31", { capture });
    expect(r.status).toBe("geo_present_unstructured");
    expect(r.facts).toHaveLength(0);
    expect(capture.incomplete).toEqual([
      { start: 467, kind: "cols", labels: ["その他"], amount: 18570 },
    ]);
  });

  it("旧 bad ACTUAL pair (W81W/XRWN の facts+legacy proof) は保存させない", () => {
    // 旧実装が出力した実ペア (算術は clean。backstop が算術の前に STOP する)。
    // W81W: 日本 102488 + 米国 73106、ot=73106、total=177057、adj=1462。
    const w81wFacts = [
      { regionName: "日本", regionKind: "domestic", salesAmount: 102488 },
      { regionName: "米国", regionKind: "overseas", salesAmount: 73106 },
      { regionName: "海外売上高", regionKind: "overseas_total", salesAmount: 73106, ratioPct: 41.3 },
      { regionName: "連結売上高", regionKind: "total", salesAmount: 177057 },
    ].map((f) => ({
      ratioPct: null,
      unitLabel: "百万円",
      unitYenFactor: 1000000,
      fiscalYearEnd: "2025-03-31",
      isConsolidated: true,
      ...f,
    })) as Parameters<typeof validateOverseasSaveSet>[0];
    const w81wLegacyProof = {
      reconciliationAdjustment: 1462,
      mode: "unknown",
      sumLo: 177054.5,
      sumHi: 177059,
      totalLo: 177056.5,
      totalHi: 177058,
    } as unknown as Parameters<typeof validateOverseasSaveSet>[1];
    // 旧 shape (field なし) は default 0 を置かず STOP。
    expect(() => validateOverseasSaveSet(w81wFacts, w81wLegacyProof)).toThrow(
      "地理未分類"
    );
    // source 由来の未分類額 (1462) が載った proof も STOP。
    expect(() =>
      validateOverseasSaveSet(w81wFacts, {
        ...(w81wLegacyProof as unknown as Record<string, unknown>),
        geoUnclassified: 1462,
      } as Parameters<typeof validateOverseasSaveSet>[1])
    ).toThrow("地理未分類");
    // XRWN: 日本 101057 + 米州 28810 + 欧州 21100 + 中国 70907、ot=120817、
    // total=240444、adj=18570。
    const xrwnFacts = [
      { regionName: "日本", regionKind: "domestic", salesAmount: 101057 },
      { regionName: "米州", regionKind: "overseas", salesAmount: 28810 },
      { regionName: "欧州", regionKind: "overseas", salesAmount: 21100 },
      { regionName: "中国", regionKind: "overseas", salesAmount: 70907 },
      { regionName: "海外売上高", regionKind: "overseas_total", salesAmount: 120817, ratioPct: 50.2 },
      { regionName: "連結売上高", regionKind: "total", salesAmount: 240444 },
    ].map((f) => ({
      ratioPct: null,
      unitLabel: "百万円",
      unitYenFactor: 1000000,
      fiscalYearEnd: "2025-12-31",
      isConsolidated: true,
      ...f,
    })) as Parameters<typeof validateOverseasSaveSet>[0];
    const xrwnLegacyProof = {
      reconciliationAdjustment: 18570,
      mode: "unknown",
      sumLo: 240441.5,
      sumHi: 240449,
      totalLo: 240443.5,
      totalHi: 240445,
    } as unknown as Parameters<typeof validateOverseasSaveSet>[1];
    expect(() => validateOverseasSaveSet(xrwnFacts, xrwnLegacyProof)).toThrow(
      "地理未分類"
    );
  });
});
