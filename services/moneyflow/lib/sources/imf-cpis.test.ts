/**
 * IMF CPIS 取得元 (imf-cpis.ts) のテスト。
 *
 * フィクスチャは `__fixtures__/imf-cpis-*.json` — 2026-09-27 に
 * `https://api.db.nomics.world/v22/series` (DBnomics 経由の IMF CPIS 再配信)
 * へ実際に発行した GET リクエストの生レスポンスをそのまま保存したもの
 * (合成・改変なし)。参照値は同じ日にこのフィクスチャを目視で読み取って
 * 確認した実測値 (日本→米国, 日本→ケイマン諸島, 日本→世界計の 2024-S1 残高、
 * および米国→日本の Derived 系列)。原本 URL:
 * https://api.db.nomics.world/v22/series?series_ids=IMF%2FCPIS%2FB.JP.I_A_T_T_T_BP6_USD.T.T.US,...
 *
 * 「様式が想定と違えば throw する」系のテストだけは、実際の応答ではなく
 * 手作りの不正形状データを使う (その旨を各テスト名に明記)。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IMF_CPIS_DEFAULT_COUNTERPART_AREAS,
  IMF_CPIS_INDICATORS,
  buildImfCpisSeriesCode,
  buildImfCpisUrl,
  chunkImfCpisSeriesCodes,
  compareImfCpisPeriods,
  currentImfCpisPeriodLabel,
  isImfCpisPeriodPublished,
  latestImfCpisPeriod,
  nextImfCpisPeriod,
  parseImfCpisPeriod,
  parseImfCpisResponse,
  toImfCpisObservationRows,
} from "./imf-cpis.js";

const FX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FX, name), "utf8"));

describe("parseImfCpisResponse — 実フィクスチャでの値検証", () => {
  it("日本→海外 (Assets, Total) の 2024-S1 残高を実測どおりに読む", () => {
    const records = parseImfCpisResponse(fixture("imf-cpis-jp-assets-total.json"));
    const at = (area: string) =>
      records.find((r) => r.counterpartArea === area && r.period === "2024-S1")?.valueUsd;

    // 原本 (DBnomics API, 2026-09-27 取得) を目視確認した実測値。
    expect(at("US")).toBe(2072394613197.0);
    expect(at("KY")).toBe(818396287835.949);
    expect(at("W00")).toBe(4337640482073.52);
  });

  it("海外→日本 (Liabilities, Derived, Total) の 2024-S1 残高を実測どおりに読む", () => {
    const records = parseImfCpisResponse(fixture("imf-cpis-jp-liabilities-total.json"));
    const at = (area: string) =>
      records.find((r) => r.counterpartArea === area && r.period === "2024-S1")?.valueUsd;

    expect(at("US")).toBe(1225933000000.0);
    expect(at("KY")).toBe(202207764972.49);
    expect(at("W00")).toBe(2806446928109.16);
  });

  it("資産クラス (株式/債券) を正しく振り分ける (jp_holds_abroad)", () => {
    const records = parseImfCpisResponse(fixture("imf-cpis-jp-assets-equity-debt.json"));
    const equity = records.find((r) => r.assetClass === "equity" && r.period === "2024-S1");
    const debt = records.find((r) => r.assetClass === "debt" && r.period === "2024-S1");
    expect(equity?.valueUsd).toBe(927585184508.034);
    expect(debt?.valueUsd).toBe(1144809428688.97);
    expect(equity?.indicatorKey).toBe("imf_cpis_jp_assets_equity");
    expect(debt?.indicatorKey).toBe("imf_cpis_jp_assets_debt");
    expect(equity?.direction).toBe("jp_holds_abroad");
  });

  it("資産クラス (株式/債券) を正しく振り分ける (world_holds_jp)", () => {
    const records = parseImfCpisResponse(fixture("imf-cpis-jp-liabilities-equity-debt.json"));
    const equity = records.find((r) => r.assetClass === "equity" && r.period === "2024-S1");
    const debt = records.find((r) => r.assetClass === "debt" && r.period === "2024-S1");
    expect(equity?.valueUsd).toBe(1027565000000.0);
    expect(debt?.valueUsd).toBe(198368000000.0);
    expect(equity?.indicatorKey).toBe("imf_cpis_jp_liabilities_equity");
    expect(debt?.indicatorKey).toBe("imf_cpis_jp_liabilities_debt");
    expect(equity?.direction).toBe("world_holds_jp");
  });

  it("株式+債券 の合計が Total 系列と一致する (フィクスチャ間の内部整合性)", () => {
    const totalRecords = parseImfCpisResponse(fixture("imf-cpis-jp-assets-total.json"));
    const splitRecords = parseImfCpisResponse(fixture("imf-cpis-jp-assets-equity-debt.json"));
    const total = totalRecords.find(
      (r) => r.counterpartArea === "US" && r.period === "2024-S1"
    )?.valueUsd;
    const equity = splitRecords.find(
      (r) => r.assetClass === "equity" && r.period === "2024-S1"
    )?.valueUsd;
    const debt = splitRecords.find(
      (r) => r.assetClass === "debt" && r.period === "2024-S1"
    )?.valueUsd;
    expect(total).toBeDefined();
    expect(equity! + debt!).toBeCloseTo(total!, 1);
  });

  it("守秘義務等による欠損 (value=null) は 0 埋めせず読み飛ばす", () => {
    // 実フィクスチャを複製し、1 点だけ null に差し替えた合成データ (形状は本物のまま)。
    const base = fixture("imf-cpis-jp-assets-total.json") as {
      series: { docs: Array<{ value: unknown[] }> };
    };
    const mutated = JSON.parse(JSON.stringify(base)) as typeof base;
    const doc = mutated.series.docs[0]!;
    const originalLength = (doc.value as unknown[]).length;
    doc.value[originalLength - 1] = null;

    const records = parseImfCpisResponse(mutated);
    const seriesCode = (
      (base.series.docs[0] as unknown) as { series_code: string }
    ).series_code;
    const forThisSeries = records.filter((r) => r.seriesCode === seriesCode);
    // 元は 36 観測、うち 1 点を null にしたので 35 件だけ出てくるはず。0 は混ざらない。
    expect(forThisSeries).toHaveLength(35);
    expect(forThisSeries.every((r) => Number.isFinite(r.valueUsd) && r.valueUsd !== 0)).toBe(
      true
    );
  });
});

describe("parseImfCpisResponse — 想定外の形状 (手作りの合成データ) は throw する", () => {
  it("series.docs が無ければ throw", () => {
    expect(() => parseImfCpisResponse({ series: {} })).toThrow(/series\.docs/);
  });

  it("series.docs が配列でなければ throw", () => {
    expect(() => parseImfCpisResponse({ series: { docs: "not-an-array" } })).toThrow(
      /配列ではありません/
    );
  });

  it("FREQ が半期 (B) 以外なら throw (四半期・年次が紛れ込んだ場合の検知)", () => {
    const bad = {
      series: {
        docs: [
          {
            series_code: "Q.JP.I_A_T_T_T_BP6_USD.T.T.US",
            dimensions: {
              FREQ: "Q",
              REF_AREA: "JP",
              INDICATOR: "I_A_T_T_T_BP6_USD",
              COUNTERPART_AREA: "US",
            },
            period: ["2024-Q1"],
            value: [1],
          },
        ],
      },
    };
    expect(() => parseImfCpisResponse(bad)).toThrow(/FREQ/);
  });

  it("REF_AREA が JP 以外なら throw", () => {
    const bad = {
      series: {
        docs: [
          {
            series_code: "B.US.I_A_T_T_T_BP6_USD.T.T.JP",
            dimensions: {
              FREQ: "B",
              REF_AREA: "US",
              INDICATOR: "I_A_T_T_T_BP6_USD",
              COUNTERPART_AREA: "JP",
            },
            period: ["2024-S1"],
            value: [1],
          },
        ],
      },
    };
    expect(() => parseImfCpisResponse(bad)).toThrow(/REF_AREA/);
  });

  it("未知の INDICATOR コードなら throw (様式変更の検知)", () => {
    const bad = {
      series: {
        docs: [
          {
            series_code: "B.JP.I_UNKNOWN_CODE.T.T.US",
            dimensions: {
              FREQ: "B",
              REF_AREA: "JP",
              INDICATOR: "I_UNKNOWN_CODE",
              COUNTERPART_AREA: "US",
            },
            period: ["2024-S1"],
            value: [1],
          },
        ],
      },
    };
    expect(() => parseImfCpisResponse(bad)).toThrow(/未知の INDICATOR/);
  });

  it("period と value の長さが違えば throw", () => {
    const bad = {
      series: {
        docs: [
          {
            series_code: "B.JP.I_A_T_T_T_BP6_USD.T.T.US",
            dimensions: {
              FREQ: "B",
              REF_AREA: "JP",
              INDICATOR: "I_A_T_T_T_BP6_USD",
              COUNTERPART_AREA: "US",
            },
            period: ["2024-S1", "2024-S2"],
            value: [1],
          },
        ],
      },
    };
    expect(() => parseImfCpisResponse(bad)).toThrow(/長さが一致しません/);
  });

  it("期間表記が YYYY-S1/S2 形式でなければ throw", () => {
    const bad = {
      series: {
        docs: [
          {
            series_code: "B.JP.I_A_T_T_T_BP6_USD.T.T.US",
            dimensions: {
              FREQ: "B",
              REF_AREA: "JP",
              INDICATOR: "I_A_T_T_T_BP6_USD",
              COUNTERPART_AREA: "US",
            },
            period: ["2024"],
            value: [1],
          },
        ],
      },
    };
    expect(() => parseImfCpisResponse(bad)).toThrow(/YYYY-S1\/YYYY-S2/);
  });

  it("値が数値でなければ (文字列が紛れ込んだら) throw し、無効値で埋めない", () => {
    const bad = {
      series: {
        docs: [
          {
            series_code: "B.JP.I_A_T_T_T_BP6_USD.T.T.US",
            dimensions: {
              FREQ: "B",
              REF_AREA: "JP",
              INDICATOR: "I_A_T_T_T_BP6_USD",
              COUNTERPART_AREA: "US",
            },
            period: ["2024-S1"],
            value: ["N/A"],
          },
        ],
      },
    };
    expect(() => parseImfCpisResponse(bad)).toThrow(/有限の数値ではありません/);
  });
});

describe("buildImfCpisSeriesCode / buildImfCpisUrl / chunkImfCpisSeriesCodes", () => {
  it("direction/assetClass/相手国から series_code を組み立てる", () => {
    expect(
      buildImfCpisSeriesCode({ direction: "jp_holds_abroad", assetClass: "total", counterpartArea: "US" })
    ).toBe("B.JP.I_A_T_T_T_BP6_USD.T.T.US");
    expect(
      buildImfCpisSeriesCode({ direction: "world_holds_jp", assetClass: "debt", counterpartArea: "KY" })
    ).toBe("B.JP.I_L_D_T_T_BP6_DV_USD.T.T.KY");
  });

  it("相手国コードの形式が不正なら throw する", () => {
    expect(() =>
      buildImfCpisSeriesCode({ direction: "jp_holds_abroad", assetClass: "total", counterpartArea: "us-1" })
    ).toThrow(/相手国・地域コード/);
  });

  it("series_ids クエリと observations=1 を含む URL を組み立てる", () => {
    const url = buildImfCpisUrl(["B.JP.I_A_T_T_T_BP6_USD.T.T.US"]);
    expect(url.startsWith("https://api.db.nomics.world/v22/series?")).toBe(true);
    expect(url).toContain("observations=1");
    expect(decodeURIComponent(url)).toContain("IMF/CPIS/B.JP.I_A_T_T_T_BP6_USD.T.T.US");
  });

  it("空配列なら throw する", () => {
    expect(() => buildImfCpisUrl([])).toThrow(/空です/);
  });

  it("チャンクサイズごとに分割する", () => {
    const codes = Array.from({ length: 25 }, (_, i) => `code-${i}`);
    const chunks = chunkImfCpisSeriesCodes(codes, 10);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(10);
    expect(chunks[2]).toHaveLength(5);
    expect(chunks.flat()).toEqual(codes);
  });
});

describe("期間の判定 (半期)", () => {
  it("parseImfCpisPeriod で年・半期に分解する", () => {
    expect(parseImfCpisPeriod("2024-S1")).toEqual({ year: 2024, half: 1 });
    expect(parseImfCpisPeriod("2024-S2")).toEqual({ year: 2024, half: 2 });
  });

  it("不正な形式は throw する", () => {
    expect(() => parseImfCpisPeriod("2024-Q1")).toThrow();
    expect(() => parseImfCpisPeriod("2024")).toThrow();
  });

  it("compareImfCpisPeriods は時系列順に比較する", () => {
    expect(compareImfCpisPeriods("2024-S2", "2024-S1")).toBeGreaterThan(0);
    expect(compareImfCpisPeriods("2024-S1", "2024-S2")).toBeLessThan(0);
    expect(compareImfCpisPeriods("2025-S1", "2024-S2")).toBeGreaterThan(0);
    expect(compareImfCpisPeriods("2024-S1", "2024-S1")).toBe(0);
  });

  it("nextImfCpisPeriod は S1→同年S2、S2→翌年S1 を返す", () => {
    expect(nextImfCpisPeriod("2024-S1")).toBe("2024-S2");
    expect(nextImfCpisPeriod("2024-S2")).toBe("2025-S1");
  });

  it("latestImfCpisPeriod は集合の中で最新を返し、空なら undefined (憶測しない)", () => {
    expect(latestImfCpisPeriod(["2023-S2", "2024-S1", "2022-S1"])).toBe("2024-S1");
    expect(latestImfCpisPeriod([])).toBeUndefined();
  });

  it("currentImfCpisPeriodLabel は日付からその時点の半期ラベルを返す (公表可否の判定はしない)", () => {
    expect(currentImfCpisPeriodLabel(new Date(Date.UTC(2026, 2, 15)))).toBe("2026-S1"); // 3月
    expect(currentImfCpisPeriodLabel(new Date(Date.UTC(2026, 8, 27)))).toBe("2026-S2"); // 9月
  });

  it("isImfCpisPeriodPublished は実測データの有無だけで判定する", () => {
    const records = parseImfCpisResponse(fixture("imf-cpis-jp-assets-total.json"));
    expect(isImfCpisPeriodPublished(records, "2024-S1")).toBe(true);
    // フィクスチャ取得時点 (2026-09-27) で DBnomics 側にまだ反映されていない期間。
    expect(isImfCpisPeriodPublished(records, "2025-S2")).toBe(false);
  });
});

describe("toImfCpisObservationRows (観測ログ用の縦持ち変換)", () => {
  it("実測 (jp_holds_abroad) は isEstimated=false、近似フラグは常に true", () => {
    const records = parseImfCpisResponse(fixture("imf-cpis-jp-assets-total.json"));
    const rows = toImfCpisObservationRows(records);
    expect(rows.length).toBe(records.length);
    for (const row of rows) {
      expect(row.isApproximate).toBe(true);
      expect(row.isEstimated).toBe(false);
      expect(row.unit).toBe("USD");
    }
    const usRow = rows.find((r) => r.category === "US" && r.period === "2024-S1");
    expect(usRow?.value).toBe(2072394613197.0);
    expect(usRow?.indicatorKey).toBe("imf_cpis_jp_assets_total");
  });

  it("Derived 系 (world_holds_jp) は isEstimated=true", () => {
    const records = parseImfCpisResponse(fixture("imf-cpis-jp-liabilities-total.json"));
    const rows = toImfCpisObservationRows(records);
    expect(rows.every((r) => r.isEstimated === true)).toBe(true);
  });
});

describe("IMF_CPIS_INDICATORS / IMF_CPIS_DEFAULT_COUNTERPART_AREAS", () => {
  it("6 種類 (向き2 × 資産クラス3) の指標定義を持ち、キーが重複しない", () => {
    expect(IMF_CPIS_INDICATORS).toHaveLength(6);
    const keys = IMF_CPIS_INDICATORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(6);
  });

  it("すべて R4 要件・holdings_stock・USD・semiannual を満たす", () => {
    for (const def of IMF_CPIS_INDICATORS) {
      expect(def.requirements).toContain("R4");
      expect(def.flowType).toBe("holdings_stock");
      expect(def.unit).toBe("USD");
      expect(def.frequency).toBe("semiannual");
      expect(def.description.length).toBeGreaterThan(10);
      expect(def.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it("既定の相手国リストに世界計コード W00 を含む", () => {
    expect(IMF_CPIS_DEFAULT_COUNTERPART_AREAS).toContain("W00");
    expect(IMF_CPIS_DEFAULT_COUNTERPART_AREAS).toContain("US");
  });
});
