/**
 * 受注パーサのユニットテスト。fixture は EDINET から取得した実在の
 * 有価証券報告書 (公開済み法定開示) の受注表をそのまま使う。架空値は使わない。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseOrderHtml } from "../services/edinet/order-parser.js";
import { parseJpNumber, unitToYenFactor } from "../services/edinet/html-table.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fx = (n: string) => readFileSync(join(FX, n), "utf8");

describe("parseJpNumber (ルール2: 欠損は null, 0 で埋めない)", () => {
  it("通常 / 全角符号 / マイナス記号", () => {
    expect(parseJpNumber("2,630,757")).toBe(2630757);
    expect(parseJpNumber("＋27.5")).toBe(27.5);
    expect(parseJpNumber("△66,712")).toBe(-66712);
    expect(parseJpNumber("▲1,000")).toBe(-1000);
  });
  it("記号のみ・空は null (0 にしない)", () => {
    for (const s of ["―", "－", "-", "", "—", "N/A", "－百万円"]) {
      expect(parseJpNumber(s)).toBeNull();
    }
  });
});

describe("unitToYenFactor (ルール2: 未知単位は throw)", () => {
  it("百万円/千円/億円/円", () => {
    expect(unitToYenFactor("百万円")).toBe(1_000_000);
    expect(unitToYenFactor("（千円）")).toBe(1_000);
    expect(unitToYenFactor("億円")).toBe(100_000_000);
  });
  it("未知単位は throw", () => {
    expect(() => unitToYenFactor("ドル")).toThrow();
  });
});

describe("Pattern A — 受注高/受注残高 セグメント表", () => {
  it("7012 川崎重工 (見出し1行)", () => {
    const r = parseOrderHtml(fx("patternA-7012-kawasaki.html"), "2025-03-31");
    expect(r.status).toBe("ok_pattern_a");
    const total = r.facts.find((f) => f.segmentName === "合計")!;
    expect(total.segmentKind).toBe("total");
    expect(total.ordersReceived).toBe(2630757);
    expect(total.orderBacklog).toBe(2782728);
    const seg = r.facts.find((f) => f.segmentName === "航空宇宙システム")!;
    expect(seg.segmentKind).toBe("segment");
    expect(seg.ordersReceived).toBe(882899);
    expect(seg.orderBacklog).toBe(1301937);
    expect(total.unitLabel).toBe("百万円");
    expect(total.fiscalYearEnd).toBe("2025-03-31");
  });

  it("7011 三菱重工 (見出し2行・セグメント列結合 → 列補正)", () => {
    const r = parseOrderHtml(fx("patternA-7011-mitsubishi.html"), "2025-03-31");
    expect(r.status).toBe("ok_pattern_a");
    const energy = r.facts.find((f) => f.segmentName === "エナジー")!;
    expect(energy.ordersReceived).toBe(2622466);
    expect(energy.orderBacklog).toBe(4918439);
    const total = r.facts.find((f) => f.segmentName === "合計")!;
    expect(total.ordersReceived).toBe(7071259);
    expect(total.orderBacklog).toBe(10236296);
    const elim = r.facts.find((f) => f.segmentName === "全社又は消去")!;
    expect(elim.segmentKind).toBe("elimination");
    expect(elim.ordersReceived).toBe(-66712); // △66,712
    expect(elim.orderBacklog).toBe(320);
    expect(total.isConsolidated).toBe(true); // 見出しに「連結」
  });

  it("7013 IHI (報告セグメント計=subtotal, 調整額=elimination, 欠損は null)", () => {
    const r = parseOrderHtml(fx("patternA-7013-ihi.html"), "2025-03-31");
    expect(r.status).toBe("ok_pattern_a");
    const total = r.facts.find((f) => f.segmentName === "合計")!;
    expect(total.ordersReceived).toBe(1751136);
    expect(total.orderBacklog).toBe(1487352);
    const sub = r.facts.find((f) => f.segmentName === "報告セグメント 計")!;
    expect(sub.segmentKind).toBe("subtotal");
    const adj = r.facts.find((f) => f.segmentName === "調整額")!;
    expect(adj.segmentKind).toBe("elimination");
    expect(adj.ordersReceived).toBe(-49565);
    expect(adj.orderBacklog).toBeNull(); // 「－」→ null (0 ではない)
  });
});

describe("Pattern A 一般化 — 2行ヘッダ/単位ラベル/計のみ総計 (取りこぼし回収)", () => {
  it("7883 サンメッセ (単行ヘッダ・千円・総計が『計』のみ→total昇格)", () => {
    const r = parseOrderHtml(
      fx("patternA2-7883-samesse-tankai.html"),
      "2025-03-31"
    );
    expect(r.status).toBe("ok_pattern_a");
    const seg = r.facts.find((f) => f.segmentName === "印刷事業")!;
    expect(seg.ordersReceived).toBe(15892833);
    expect(seg.orderBacklog).toBe(2482392);
    expect(seg.unitLabel).toBe("千円");
    const ev = r.facts.find((f) => f.segmentName === "イベント事業")!;
    expect(ev.orderBacklog).toBeNull(); // 「―」→ null (0 ではない)
    const total = r.facts.find((f) => f.segmentName === "計")!;
    expect(total.segmentKind).toBe("total"); // 『計』のみ → total 昇格
    expect(total.ordersReceived).toBe(16368457);
  });

  it("6776 天昇電気 (2行ヘッダ: 受注高/受注残高 が金額・前年比に分岐)", () => {
    const r = parseOrderHtml(
      fx("patternA2-6776-tensho-2rowhdr.html"),
      "2025-03-31"
    );
    expect(r.status).toBe("ok_pattern_a");
    const seg = r.facts.find((f) => f.segmentName === "日本成形関連事業")!;
    expect(seg.ordersReceived).toBe(19709); // % 列でなく金額列
    expect(seg.orderBacklog).toBe(1381);
    expect(seg.unitLabel).toBe("百万円");
    const total = r.facts.find((f) => f.segmentName === "合計")!;
    expect(total.segmentKind).toBe("total");
    expect(total.ordersReceived).toBe(27307);
    expect(total.orderBacklog).toBe(1383);
  });

  it("6360 東京自働機械 (単位がセグメント名側『包装機械(千円)』)", () => {
    const r = parseOrderHtml(
      fx("patternA2-6360-unit-in-label.html"),
      "2025-03-31"
    );
    expect(r.status).toBe("ok_pattern_a");
    const seg = r.facts.find((f) => f.segmentName === "包装機械")!; // 単位除去
    expect(seg.ordersReceived).toBe(6054608);
    expect(seg.orderBacklog).toBe(3264200);
    expect(seg.unitLabel).toBe("千円");
    const total = r.facts.find((f) => f.segmentName === "合計")!;
    expect(total.segmentKind).toBe("total");
    expect(total.ordersReceived).toBe(7590165);
  });

  it("7949 小松ウオール工業 (2行ヘッダ・品目別)", () => {
    const r = parseOrderHtml(
      fx("patternA2-7949-hinmoku-2rowhdr.html"),
      "2025-03-31"
    );
    expect(r.status).toBe("ok_pattern_a");
    const seg = r.facts.find((f) => f.segmentName === "可動間仕切")!;
    expect(seg.ordersReceived).toBe(20891);
    expect(seg.orderBacklog).toBe(5283);
    const total = r.facts.find((f) => f.segmentName === "合計")!;
    expect(total.ordersReceived).toBe(46833);
    expect(total.orderBacklog).toBe(18897);
  });

  it("6324 ハーモニック (地域×製品2次元) → per-segmentは捏造せず, 全社合計のみ採用", () => {
    const r = parseOrderHtml(
      fx("reject-6324-region-product.html"),
      "2025-03-31"
    );
    // セグメント別は曖昧で作らない。会社全体(開示済 合計)だけ確実に取る。
    expect(r.status).not.toBe("ok_pattern_a");
    expect(r.status).toBe("ok_total_only");
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].segmentKind).toBe("total");
    expect(r.facts[0].ordersReceived).toBe(53041114);
    expect(r.facts[0].orderBacklog).toBe(19250679);
    expect(r.facts[0].unitLabel).toBe("千円");
  });

  it("3513 イチカワ (2階層セグメント) → 全社合計のみ ok_total_only", () => {
    const r = parseOrderHtml(fx("audit-3513-ichikawa-2level.html"), "2025-03-31");
    expect(r.status).toBe("ok_total_only");
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].ordersReceived).toBe(13645);
    expect(r.facts[0].orderBacklog).toBe(5928);
    expect(r.facts[0].unitLabel).toBe("百万円");
  });

  it("5268 旭コンクリート (数量×金額併記) → 金額列の計のみ採用 (数量を金額と誤らない)", () => {
    const r = parseOrderHtml(
      fx("audit-5268-asahiconc-qty-amt.html"),
      "2025-03-31"
    );
    expect(r.status).toBe("ok_total_only");
    expect(r.facts[0].ordersReceived).toBe(5610645); // 金額(千円), 数量49233ではない
    expect(r.facts[0].orderBacklog).toBe(1912134);
    expect(r.facts[0].unitLabel).toBe("千円");
  });

  it("3076 あいHD (合計行なしのセグメント受注表) → ok_pattern_a (total無)", () => {
    const r = parseOrderHtml(
      fx("patternA2-3076-aiHD-no-total.html"),
      "2025-03-31"
    );
    expect(r.status).toBe("ok_pattern_a");
    expect(r.facts).toHaveLength(4);
    expect(r.facts.every((f) => f.segmentKind === "segment")).toBe(true);
    const s = r.facts.find((f) => f.segmentName === "設計事業")!;
    expect(s.ordersReceived).toBe(9782);
    expect(s.orderBacklog).toBe(8918);
    expect(s.unitLabel).toBe("百万円");
  });

  it("9698 クレオ (合計行なし・3セグメント) → ok_pattern_a", () => {
    const r = parseOrderHtml(
      fx("patternA2-9698-creo-no-total.html"),
      "2025-03-31"
    );
    expect(r.status).toBe("ok_pattern_a");
    expect(r.facts).toHaveLength(3);
    const s = r.facts.find(
      (f) => f.segmentName === "受託開発事業"
    )!;
    expect(s.ordersReceived).toBe(3473);
    expect(s.orderBacklog).toBe(984);
  });

  it("3856 Abalance (『報告セグメント合計』を total 認識)", () => {
    const r = parseOrderHtml(
      fx("patternA2-3856-abalance-houkoku-goukei.html"),
      "2025-03-31"
    );
    expect(r.status).toBe("ok_pattern_a");
    const total = r.facts.find(
      (f) => f.segmentName === "報告セグメント合計"
    )!;
    expect(total.segmentKind).toBe("total");
    expect(total.ordersReceived).toBe(57248);
    expect(total.orderBacklog).toBe(20821);
    const seg = r.facts.find(
      (f) => f.segmentName === "太陽光パネル製造事業"
    )!;
    expect(seg.segmentKind).toBe("segment");
    expect(seg.ordersReceived).toBe(50231);
  });
});

describe("Pattern B — 建設業 完成工事 (期別×種類別)", () => {
  it("1812 鹿島建設 (当期受注高=受注高, 期末繰越高=受注残高相当, 2期分)", () => {
    const r = parseOrderHtml(fx("patternB-1812-kajima.html"), "2025-03-31");
    expect(r.status).toBe("ok_pattern_b");

    const cur = r.facts.filter((f) => f.fiscalYearEnd === "2025-03-31");
    const prev = r.facts.filter((f) => f.fiscalYearEnd === "2024-03-31");
    expect(cur.length).toBeGreaterThan(0);
    expect(prev.length).toBeGreaterThan(0);

    const curTotal = cur.find((f) => f.segmentName === "合計")!;
    expect(curTotal.ordersReceived).toBe(1831107);
    expect(curTotal.orderBacklog).toBe(2550864);

    const prevTotal = prev.find((f) => f.segmentName === "合計")!;
    expect(prevTotal.ordersReceived).toBe(1944029);
    expect(prevTotal.orderBacklog).toBe(2279773);

    const curArch = cur.find((f) => f.segmentName === "建築工事")!;
    expect(curArch.ordersReceived).toBe(1334668);
    expect(curArch.orderBacklog).toBe(1750297);
  });

  it("1803 清水建設 (列名揺れ: 当期受注(契約)高 / 次期繰越高, 期は 至日付で確定)", () => {
    const r = parseOrderHtml(fx("patternB-1803-shimizu.html"), "2025-03-31");
    expect(r.status).toBe("ok_pattern_b");

    // 至2025年3月31日 ブロック = 当期
    const cur = r.facts.filter((f) => f.fiscalYearEnd === "2025-03-31");
    const curTotal = cur.find((f) => f.segmentName === "合計")!;
    expect(curTotal.ordersReceived).toBe(1404220); // 当期受注(契約)高
    expect(curTotal.orderBacklog).toBe(2328337); // 次期繰越高
    const curArch = cur.find((f) => f.segmentName === "建築工事")!;
    expect(curArch.ordersReceived).toBe(1048314);
    expect(curArch.orderBacklog).toBe(1633614);
    expect(curTotal.unitLabel).toBe("百万円");

    // 至2024年3月31日 ブロック = 前期 (至日付から会計期末を直接確定)
    const prev = r.facts.filter((f) => f.fiscalYearEnd === "2024-03-31");
    const prevTotal = prev.find((f) => f.segmentName === "合計")!;
    expect(prevTotal.ordersReceived).toBe(1852181);
    expect(prevTotal.orderBacklog).toBe(2425637);
  });
});

describe("Pattern C — 設備/建設 完成工事高 区分別 (年度別に別テーブル)", () => {
  const strip = (s: string) => s.replace(/^<!--[\s\S]*?-->\n/, "");
  it("1736 オーテック (当期受注工事高/期末繰越工事高=手持工事高, 多段ヘッダ, 前→当の順)", () => {
    // 有報本文では前事業年度→当事業年度の順に別テーブルで出現する
    const prev = strip(fx("patternC-1736-otec-prev.html"));
    const cur = strip(fx("patternC-1736-otec-cur.html"));
    const r = parseOrderHtml(
      `<html><body>${prev}${cur}</body></html>`,
      "2025-03-31"
    );
    expect(r.status).toBe("ok_pattern_c");

    const cur25 = r.facts.filter((f) => f.fiscalYearEnd === "2025-03-31");
    const t25 = cur25.find((f) => f.segmentName === "工事合計")!;
    expect(t25.segmentKind).toBe("total");
    expect(t25.ordersReceived).toBe(18896479); // 当期受注工事高
    expect(t25.orderBacklog).toBe(10708248); // 期末繰越工事高(手持)
    expect(t25.unitLabel).toBe("千円");
    const seg25 = cur25.find((f) => f.segmentName === "新設工事")!;
    expect(seg25.ordersReceived).toBe(8292919);
    expect(seg25.orderBacklog).toBe(7277883);

    const prev24 = r.facts.filter((f) => f.fiscalYearEnd === "2024-03-31");
    const t24 = prev24.find((f) => f.segmentName === "工事合計")!;
    expect(t24.ordersReceived).toBe(17845459);
    expect(t24.orderBacklog).toBe(11404218);
  });

  it("単一テーブルのみなら会計期末=当該有報期 (前年は作らない)", () => {
    const cur = strip(fx("patternC-1736-otec-cur.html"));
    const r = parseOrderHtml(`<html><body>${cur}</body></html>`, "2025-03-31");
    expect(r.status).toBe("ok_pattern_c");
    expect(new Set(r.facts.map((f) => f.fiscalYearEnd))).toEqual(
      new Set(["2025-03-31"])
    );
    const t = r.facts.find((f) => f.segmentName === "工事合計")!;
    expect(t.ordersReceived).toBe(18896479);
  });
});

describe("構造化できない表は捏造せず status で明示 (ルール1/2)", () => {
  it("受注高のみ (受注残高なし) → orders_only", () => {
    const r = parseOrderHtml(fx("ordersonly-7013-ihi.html"), "2025-03-31");
    expect(r.status).toBe("orders_only");
    expect(r.facts).toEqual([]);
  });
  it("地域×製品の多段表 → per-segmentは%を金額と捏造しない, 全社合計のみ採用", () => {
    // S100VZ4X: Pattern A は誤判定回避で per-segment を作らない。会社全体
    // (開示済 合計) だけ ok_total_only で確実取得 (捏造ゼロ・会社全体OK)。
    const r = parseOrderHtml(fx("reject-S100VZ4X-region.html"), "2025-03-31");
    expect(r.status).not.toBe("ok_pattern_a");
    expect(r.status).toBe("ok_total_only");
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].segmentKind).toBe("total");
    expect(Number.isInteger(r.facts[0].ordersReceived)).toBe(true);
  });
  it("受注語を含む表が無い → no_order_table", () => {
    const r = parseOrderHtml(
      "<html><body><table><tr><td>売上高</td><td>100</td></tr></table></body></html>",
      "2025-03-31"
    );
    expect(r.status).toBe("no_order_table");
    expect(r.facts).toEqual([]);
  });
});
