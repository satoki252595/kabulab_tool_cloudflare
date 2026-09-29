/**
 * jpx-margin-sector adapter (spec) のテスト。
 *
 * 合成 snapshot + 合成 mapping (sources テストと同一 builder) から
 * toObservations が 33 業種 (+ 未分類) × 14 指標の drafts を作ることを検証する。
 * key 契約 (公表日のみ設定・33 行衝突なし) は validateDrafts + observationKey
 * の一意性で検証する。R2/D1/JPX への取得はしない。
 */
import { describe, expect, it } from "vitest";
import { observationKey } from "../../../../src/shared/notion-archive/index.js";
import { validateDrafts } from "../source-spec.js";
import { buildMarginSectorInput } from "../sources/jpx-margin-sector.js";
import {
  synthSectorFixture,
  synthSnapshot,
} from "../sources/margin-sector-fixture.js";
import {
  marginSectorSpec,
  marginSectorFilenames,
  MARGIN_SECTOR_INDICATORS,
} from "./jpx-margin-sector.js";

const KEY = "jpx-margin-sector-2026-09-28";

function specFiles() {
  const { rows, tickerSector, master } = synthSectorFixture();
  const snapshot = synthSnapshot(rows);
  const mapping = buildMarginSectorInput(snapshot as never, tickerSector, master);
  const names = marginSectorFilenames("2026-09-28");
  return {
    snapshot,
    mapping,
    files: [
      { filename: names.snapshot, bytes: new TextEncoder().encode(JSON.stringify(snapshot)) },
      { filename: names.mapping, bytes: new TextEncoder().encode(JSON.stringify(mapping)) },
    ],
  };
}

describe("marginSectorSpec.toObservations", () => {
  it("33 業種 + 未分類 × 14 指標 = 476 行を作る", () => {
    const { files } = specFiles();
    const drafts = marginSectorSpec.toObservations({ key: KEY, files });
    expect(drafts).toHaveLength(34 * 14);
    expect(MARGIN_SECTOR_INDICATORS).toHaveLength(14);
    // validateDrafts (冪等キー重複なし・値有限・日付・単位) を通過する。
    validateDrafts(marginSectorSpec.name, drafts, MARGIN_SECTOR_INDICATORS);
  });

  it("key 契約: 新内訳は公表日のみ・33 行が衝突しない", () => {
    const { files } = specFiles();
    const drafts = marginSectorSpec.toObservations({ key: KEY, files });
    for (const d of drafts) {
      expect(d.publicationDate).toBe("2026-09-29");
      expect(d.marketSegment).toBeNull();
      expect(d.investorCategory).toBeNull();
      expect(d.tradeType).toBeNull();
      expect(d.parentCategory).toBeNull();
      expect(d.categoryLevel).toBeNull();
      expect(d.period).toBe("2026-09-28");
      expect(d.periodStart).toBe("2026-09-28");
      expect(d.periodEnd).toBe("2026-09-28");
    }
    const keys = drafts.map((d) => observationKey(d));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("残高・前期比・派生比率の値を正しく載せる", () => {
    const { files } = specFiles();
    const drafts = marginSectorSpec.toObservations({ key: KEY, files });
    const sell = drafts.find((d) => d.indicatorKey === "sector_margin_sell_shares" && d.category === "水産・農林業")!;
    expect(sell.value).toBe(107);
    expect(sell.changeFromPrev).toBe(2);
    expect(sell.unit).toBe("株");
    // 化学: 売前日比 null 伝播。
    const chem = drafts.find((d) => d.indicatorKey === "sector_margin_sell_shares" && d.category === "化学")!;
    expect(chem.value).toBe(106);
    expect(chem.changeFromPrev).toBeNull();
    // 派生比率: 売/(売+買)。水産 107/(107+208)。
    const ratio = drafts.find(
      (d) => d.indicatorKey === "sector_margin_sell_position_ratio_shares" && d.category === "水産・農林業",
    )!;
    expect(ratio.value).toBeCloseTo(107 / 315, 12);
    expect(ratio.unit).toBe("比率");
    expect(ratio.changeFromPrev).toBeNull();
  });

  it("売買残合計 0 の業種は比率を 0% と捏造せず失敗させる", () => {
    const { snapshot, mapping } = specFiles();
    const zeroed = {
      ...snapshot,
      rows: snapshot.rows.map((r) => ({
        ...r,
        shares: { ...r.shares, sellOutstanding: 0, buyOutstanding: 0, negSell: 0, stdSell: 0, negBuy: 0, stdBuy: 0 },
        amounts: { ...r.amounts, sellOutstanding: 0, buyOutstanding: 0, negSell: 0, stdSell: 0, negBuy: 0, stdBuy: 0 },
      })),
    };
    // totals も作り直す (snapshot builder の totalsFor 相当を totals ごと置換)。
    const { totals: _drop, ...rest } = zeroed as Record<string, unknown>;
    void _drop;
    const names = marginSectorFilenames("2026-09-28");
    // totals 不整合では aggregate が先に落ちるため、ここでは比率分母の検査だけを
    // 見る: totals をゼロ化した totalsFor 互換の totals に置換する。
    const z = () => ({
      sellOutstanding: 0, sellChg: 0, sellListedRatio: 0, sellListedRatioRaw: "0.0%",
      buyOutstanding: 0, buyChg: 0, buyListedRatio: 0, buyListedRatioRaw: "0.0%",
      negSell: 0, negSellChg: 0, negBuy: 0, negBuyChg: 0,
      stdSell: 0, stdSellChg: 0, stdBuy: 0, stdBuyChg: 0,
    });
    const T = (label: string, scope: string, market: string | null, count: number) =>
      ({ label, scope, market, count, shares: z(), amounts: z() });
    const fixed = {
      ...rest,
      totals: [
        T("貸借銘柄", "loan", null, 38),
        T("プライム 小計", "loan", "プライム", 38),
        T("スタンダード 小計", "loan", "スタンダード", 0),
        T("グロース 小計", "loan", "グロース", 0),
        T("制度信用銘柄", "standardized", null, 0),
        T("プライム 小計", "standardized", "プライム", 0),
        T("スタンダード 小計", "standardized", "スタンダード", 0),
        T("グロース 小計", "standardized", "グロース", 0),
        T("一般信用銘柄", "other", null, 0),
        T("プライム 小計", "other", "プライム", 0),
        T("スタンダード 小計", "other", "スタンダード", 0),
        T("グロース 小計", "other", "グロース", 0),
        T("総合計", "grand", null, 38),
        T("プライム 小計", "grand", "プライム", 38),
        T("スタンダード 小計", "grand", "スタンダード", 0),
        T("グロース 小計", "grand", "グロース", 0),
      ],
    };
    const files = [
      { filename: names.snapshot, bytes: new TextEncoder().encode(JSON.stringify(fixed)) },
      { filename: names.mapping, bytes: new TextEncoder().encode(JSON.stringify(mapping)) },
    ];
    expect(() => marginSectorSpec.toObservations({ key: KEY, files })).toThrow(/比率を計算できません/);
  });

  it("キー形式違反・ファイル欠落は STOP する", () => {
    const { files } = specFiles();
    expect(() => marginSectorSpec.toObservations({ key: "jpx-margin-sector-2026/09/28", files })).toThrow(
      /冪等キー/,
    );
    expect(() => marginSectorSpec.toObservations({ key: KEY, files: files.slice(0, 1) })).toThrow(
      /mapping\/coverage capture/,
    );
  });
});
