/**
 * IMF pip 取得元 (imf-cpis.ts。公式 SDMX 3.0 API 専用) のテスト。
 *
 * 公式応答の形を真似た **合成テストデータ** (実データではない。値は 1000 の倍数
 * などの作り物) で対応付けの規則と検証を確かめる。合成応答の骨格
 * (7 系列次元 + TIME_PERIOD・属性の配置・系列キーの位置指定・観測配列) は
 * 2026-09-28 の実応答と同じ形にしてある。
 *
 * 実値の意味同一の証明 (旧ミラー 2024-S1 値との突合・改訂差分) は一次証拠
 * (`/tmp/imf-official-20260928/` の private 0600 captures + 実行計画書の集計) が
 * 持ち、本ファイルの期待値には使わない。
 */
import { describe, expect, it } from "vitest";
import {
  IMF_CPIS_API_BASE,
  IMF_CPIS_DATAFLOW_AGENCY,
  IMF_CPIS_DATAFLOW_ID,
  IMF_CPIS_DATAFLOW_VERSION,
  IMF_CPIS_DEFAULT_COUNTERPART_AREAS,
  IMF_CPIS_DSD_ID,
  IMF_CPIS_DSD_VERSION,
  IMF_CPIS_INDICATORS,
  IMF_CPIS_SOURCE_URL,
  buildImfCpisBatchKey,
  buildImfCpisDataKey,
  buildImfCpisUrl,
  chunkImfCpisCounterparts,
  compareImfCpisPeriods,
  currentImfCpisPeriodLabel,
  fetchImfCpis,
  isImfCpisPeriodPublished,
  latestImfCpisPeriod,
  nextImfCpisPeriod,
  parseImfCpisPeriod,
  parseImfCpisResponse,
  toImfCpisObservationRows,
  type ImfCpisAssetClass,
  type ImfCpisDirection,
  type ImfCpisParseExpected,
} from "./imf-cpis.js";

// ---------------------------------------------------------------------------
// 合成テストデータの組み立て (実データではない)
// ---------------------------------------------------------------------------

interface SynthSeries {
  /** 公式相手国コード (例: "USA")。 */
  counterpart: string;
  /** 観測値 (periods と同じ長さ。文字列は実応答どおりの引用符付き数値)。 */
  values: Array<string | number | null>;
}

interface SynthOpts {
  direction: ImfCpisDirection;
  assetClass: ImfCpisAssetClass;
  counterparts: readonly string[];
  periods: readonly string[];
  series: readonly SynthSeries[];
  unit?: string;
  scale?: string;
  flowStockEntry?: string;
  derivation?: string;
  dvType?: string | null;
  dataflowVersion?: string;
  dsdVersion?: string;
  indicatorOverride?: string;
  accountingOverride?: string;
  omitLinks?: boolean;
}

function synthDims(o: {
  accountingEntry: string;
  indicator: string;
  counterparts: readonly string[];
}): Array<Record<string, unknown>> {
  const single = (id: string, keyPosition: number, value: string) => ({
    id,
    keyPosition,
    roles: id === "FREQUENCY" ? ["FREQ"] : [],
    values: [{ id: value }],
  });
  return [
    single("COUNTRY", 0, "JPN"),
    single("ACCOUNTING_ENTRY", 1, o.accountingEntry),
    single("INDICATOR", 2, o.indicator),
    single("SECTOR", 3, "S1"),
    single("COUNTERPART_SECTOR", 4, "S1"),
    {
      id: "COUNTERPART_COUNTRY",
      keyPosition: 5,
      roles: [],
      values: o.counterparts.map((id) => ({ id })),
    },
    single("FREQUENCY", 6, "S"),
  ];
}

/** 合成テストデータ: 公式 SDMX-JSON の data 応答の最小形。値は作り物。 */
function synthResponse(o: SynthOpts): Record<string, unknown> {
  const defs: Record<ImfCpisDirection, Record<ImfCpisAssetClass, { ae: string; ind: string; der: string }>> = {
    jp_holds_abroad: {
      total: { ae: "A", ind: "P_TOTINV_P_USD", der: "O" },
      equity: { ae: "A", ind: "P_F51_P_USD", der: "O" },
      debt: { ae: "A", ind: "P_F3_P_USD", der: "O" },
    },
    world_holds_jp: {
      total: { ae: "L", ind: "P_TOTINV_P_SCC_USD", der: "SCC" },
      equity: { ae: "L", ind: "P_F51_P_SCC_USD", der: "SCC" },
      debt: { ae: "L", ind: "P_F3_P_SCC_USD", der: "SCC" },
    },
  };
  const d = defs[o.direction][o.assetClass];
  const ae = o.accountingOverride ?? d.ae;
  const ind = o.indicatorOverride ?? d.ind;
  const der = o.derivation ?? d.der;
  // dvType の既定: 資産側は属性値なし、Derived 側は SCC (実測どおり)。
  const dv = o.dvType === undefined ? (der === "SCC" ? "SCC" : null) : o.dvType;
  const series: Record<string, unknown> = {};
  for (const s of o.series) {
    const pos = o.counterparts.indexOf(s.counterpart);
    if (pos < 0) throw new Error(`合成テストデータの不整合: ${s.counterpart} が counterparts に無い`);
    const observations: Record<string, unknown> = {};
    s.values.forEach((v, i) => {
      observations[String(i)] = [v, null, 0, null];
    });
    series[`0:0:0:0:0:${pos}:0`] = { attributes: [0, null, null], observations };
  }
  return {
    _meta: { note: "合成テストデータ (実データではない)" },
    meta: {},
    data: {
      dataSets: [{ structure: 0, action: "Replace", series }],
      structures: [
        {
          links: o.omitLinks
            ? []
            : [
                {
                  urn: `urn:sdmx:org.sdmx.infomodel.datastructure.Dataflow=${IMF_CPIS_DATAFLOW_AGENCY}:${IMF_CPIS_DATAFLOW_ID}(${o.dataflowVersion ?? IMF_CPIS_DATAFLOW_VERSION})`,
                  title: "Dataflow",
                },
                {
                  urn: `urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=${IMF_CPIS_DATAFLOW_AGENCY}:${IMF_CPIS_DSD_ID}(${o.dsdVersion ?? IMF_CPIS_DSD_VERSION})`,
                  title: "DataStructureDefinition",
                },
              ],
          dimensions: {
            series: synthDims({ accountingEntry: ae, indicator: ind, counterparts: o.counterparts }),
            observation: [{ id: "TIME_PERIOD", keyPosition: 7, values: o.periods.map((value) => ({ value })) }],
          },
          measures: { observation: [{ id: "OBS_VALUE", roles: [] }] },
          attributes: {
            dimensionGroup: [
              { id: "INSTR_ASSET", roles: [], values: [{ id: "TOTINV" }] },
              { id: "FUNCTIONAL_CAT", roles: [], values: [{ id: "P" }] },
              { id: "FI_MATURITY", roles: [] },
              { id: "CURRENCY_DENOMINATION", roles: [] },
              { id: "CURRENCY", roles: [] },
              { id: "FLOW_STOCK_ENTRY", roles: [], values: [{ id: o.flowStockEntry ?? "P" }] },
              ...(dv === null ? [{ id: "DV_TYPE", roles: [] }] : [{ id: "DV_TYPE", roles: [], values: [{ id: dv }] }]),
              { id: "UNIT", roles: [], values: [{ id: o.unit ?? "USD" }] },
            ],
            series: [
              { id: "SCALE", roles: [], values: [{ id: o.scale ?? "6" }] },
              { id: "DECIMALS_DISPLAYED", roles: [] },
              { id: "OVERLAP", roles: [] },
            ],
            observation: [
              { id: "PRECISION", roles: [] },
              { id: "DERIVATION_TYPE", roles: [], values: [{ id: der }] },
              { id: "STATUS", roles: [] },
            ],
          },
        },
      ],
    },
  };
}

const expectedOf = (
  direction: ImfCpisDirection,
  assetClass: ImfCpisAssetClass,
  counterpartAreas: readonly string[]
): ImfCpisParseExpected => ({ direction, assetClass, counterpartAreas });

// ---------------------------------------------------------------------------
// データキー・URL・チャンク
// ---------------------------------------------------------------------------

describe("buildImfCpisDataKey / buildImfCpisBatchKey / buildImfCpisUrl", () => {
  it("資産側は A + 非SCC 指標、対内側は L + SCC 指標の公式キーを組み立てる", () => {
    expect(buildImfCpisDataKey({ direction: "jp_holds_abroad", assetClass: "total", counterpartArea: "US" })).toBe(
      "JPN.A.P_TOTINV_P_USD.S1.S1.USA.S"
    );
    expect(buildImfCpisDataKey({ direction: "jp_holds_abroad", assetClass: "equity", counterpartArea: "W00" })).toBe(
      "JPN.A.P_F51_P_USD.S1.S1.G001.S"
    );
    expect(buildImfCpisDataKey({ direction: "jp_holds_abroad", assetClass: "debt", counterpartArea: "KY" })).toBe(
      "JPN.A.P_F3_P_USD.S1.S1.CYM.S"
    );
    expect(buildImfCpisDataKey({ direction: "world_holds_jp", assetClass: "total", counterpartArea: "US" })).toBe(
      "JPN.L.P_TOTINV_P_SCC_USD.S1.S1.USA.S"
    );
    expect(buildImfCpisDataKey({ direction: "world_holds_jp", assetClass: "equity", counterpartArea: "GB" })).toBe(
      "JPN.L.P_F51_P_SCC_USD.S1.S1.GBR.S"
    );
    expect(buildImfCpisDataKey({ direction: "world_holds_jp", assetClass: "debt", counterpartArea: "CN" })).toBe(
      "JPN.L.P_F3_P_SCC_USD.S1.S1.CHN.S"
    );
  });

  it("報告負債 (L + 非SCC 指標) のキーは組み立てられない (対応表に無い概念)", () => {
    // 対応表にあるのは A + 非SCC と L + SCC の 6 通りのみ。L + 非SCC を要求する
    // 入口は存在しない (無根拠の同一視を型の段階で防ぐ)。
    for (const assetClass of ["total", "equity", "debt"] as const) {
      const key = buildImfCpisDataKey({ direction: "world_holds_jp", assetClass, counterpartArea: "US" });
      expect(key).toContain(".L.P_");
      expect(key).toContain("_SCC_USD.");
    }
  });

  it("対応表に無い相手国・未知の direction は throw し、推測で補わない", () => {
    expect(() =>
      buildImfCpisDataKey({ direction: "jp_holds_abroad", assetClass: "total", counterpartArea: "XX" })
    ).toThrow(/未知の相手国/);
    expect(() =>
      buildImfCpisDataKey({
        direction: "unknown" as unknown as ImfCpisDirection,
        assetClass: "total",
        counterpartArea: "US",
      })
    ).toThrow(/未知の direction/);
  });

  it("同じ向き×資産クラスの相手国を `+` で束ねる。空なら throw", () => {
    expect(
      buildImfCpisBatchKey({ direction: "jp_holds_abroad", assetClass: "total", counterpartAreas: ["US", "KY", "W00"] })
    ).toBe("JPN.A.P_TOTINV_P_USD.S1.S1.USA+CYM+G001.S");
    expect(() =>
      buildImfCpisBatchKey({ direction: "jp_holds_abroad", assetClass: "total", counterpartAreas: [] })
    ).toThrow(/空です/);
  });

  it("公式 SDMX の data URL を組み立てる。期間クエリは付けない (無視されるため)", () => {
    const url = buildImfCpisUrl("JPN.A.P_TOTINV_P_USD.S1.S1.USA.S");
    expect(url).toBe(
      `${IMF_CPIS_API_BASE}/data/dataflow/IMF.STA/PIP/5.0.0/JPN.A.P_TOTINV_P_USD.S1.S1.USA.S?dimension_at_observation=AllDimensions`
    );
    expect(url).not.toContain("startPeriod");
    expect(url).not.toContain("endPeriod");
    expect(url).not.toContain("lastNObservations");
    expect(() => buildImfCpisUrl("")).toThrow(/空です/);
  });

  it("相手国をチャンクサイズごとに分割する", () => {
    const areas = Array.from({ length: 25 }, (_, i) => `A${i}`);
    const chunks = chunkImfCpisCounterparts(areas, 10);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(10);
    expect(chunks[2]).toHaveLength(5);
    expect(chunks.flat()).toEqual(areas);
    expect(() => chunkImfCpisCounterparts(areas, 0)).toThrow(/正の整数/);
  });
});

// ---------------------------------------------------------------------------
// parseImfCpisResponse — 合成の公式応答での値検証
// ---------------------------------------------------------------------------

describe("parseImfCpisResponse — 合成の公式応答", () => {
  const PERIODS = ["2024-S1", "2024-S2", "2025-S1"];

  it("資産側 (A・報告値) を指標キー・方向・資産クラス・新旧コード付きで読む", () => {
    const json = synthResponse({
      direction: "jp_holds_abroad",
      assetClass: "total",
      counterparts: ["USA", "G001"],
      periods: PERIODS,
      series: [
        { counterpart: "USA", values: ["2072394613197.0", "1000.5", 2000] },
        { counterpart: "G001", values: ["4337640482073.52", "3000", "4000.25"] },
      ],
    });
    const { records, returnedKeys, missingSeriesCodes } = parseImfCpisResponse(
      json,
      expectedOf("jp_holds_abroad", "total", ["US", "W00"])
    );
    expect(records).toHaveLength(6);
    expect(missingSeriesCodes).toEqual([]);
    expect(returnedKeys).toHaveLength(2);
    const us = records.find((r) => r.counterpartArea === "US" && r.period === "2024-S1")!;
    expect(us).toMatchObject({
      indicatorKey: "imf_cpis_jp_assets_total",
      direction: "jp_holds_abroad",
      assetClass: "total",
      counterpartArea: "US",
      counterpartCountry: "USA",
      valueUsd: 2072394613197.0,
      seriesCode: "JPN.A.P_TOTINV_P_USD.S1.S1.USA.S",
    });
    // 文字列値・数値値の両方を有限数として読む
    expect(records.find((r) => r.counterpartArea === "US" && r.period === "2024-S2")?.valueUsd).toBe(1000.5);
    expect(records.find((r) => r.counterpartArea === "US" && r.period === "2025-S1")?.valueUsd).toBe(2000);
  });

  it("対内側 (L・Derived) は liabilities 指標キーになり、欠損 (null) は 0 埋めせず読み飛ばす", () => {
    const json = synthResponse({
      direction: "world_holds_jp",
      assetClass: "equity",
      counterparts: ["USA"],
      periods: PERIODS,
      series: [{ counterpart: "USA", values: [null, "1000156000000", "1139116000000"] }],
    });
    const { records } = parseImfCpisResponse(json, expectedOf("world_holds_jp", "equity", ["US"]));
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      indicatorKey: "imf_cpis_jp_liabilities_equity",
      direction: "world_holds_jp",
      period: "2024-S2",
      valueUsd: 1000156000000,
    });
    expect(records.every((r) => r.valueUsd !== 0)).toBe(true);
  });

  it("要求したが応答に無い系列 (台湾の Derived など) は missingSeriesCodes で明示する", () => {
    const json = synthResponse({
      direction: "world_holds_jp",
      assetClass: "total",
      counterparts: ["USA"],
      periods: PERIODS,
      series: [{ counterpart: "USA", values: ["1000", "2000", "3000"] }],
    });
    const { records, missingSeriesCodes } = parseImfCpisResponse(
      json,
      expectedOf("world_holds_jp", "total", ["US", "TW"])
    );
    expect(records).toHaveLength(3);
    expect(missingSeriesCodes).toEqual(["JPN.L.P_TOTINV_P_SCC_USD.S1.S1.TWN.S"]);
  });

  it("2013 年より前の S1 試行分は取り込まず、S2 年末値と 2013-S1 以降は残す", () => {
    const json = synthResponse({
      direction: "world_holds_jp",
      assetClass: "total",
      counterparts: ["G001"],
      periods: ["2009-S1", "2009-S2", "2012-S1", "2012-S2", "2013-S1"],
      series: [{ counterpart: "G001", values: ["25400000000", "1166000000000", "32100000000", "1150000000000", "1200000000000"] }],
    });
    const { records } = parseImfCpisResponse(json, expectedOf("world_holds_jp", "total", ["W00"]));
    expect(records.map((r) => r.period)).toEqual(["2009-S2", "2012-S2", "2013-S1"]);
  });
});

describe("parseImfCpisResponse — 想定外の形状は throw する", () => {
  const base = (): SynthOpts => ({
    direction: "jp_holds_abroad",
    assetClass: "total",
    counterparts: ["USA"],
    periods: ["2025-S1"],
    series: [{ counterpart: "USA", values: ["1000"] }],
  });
  const parseOk = (json: unknown) => parseImfCpisResponse(json, expectedOf("jp_holds_abroad", "total", ["US"]));

  it("data/dataSets/structures が無ければ throw (旧ミラー応答もここで拒む)", () => {
    expect(() => parseOk({ series: { docs: [] } })).toThrow(/data オブジェクト/);
    expect(() => parseOk({ data: {} })).toThrow(/dataSets/);
    expect(() => parseOk({ data: { dataSets: [{}], structures: [] } })).toThrow(/structures/);
  });

  it("dataflow/DSD の URN が想定と違えば throw (版の黙った追従をしない)", () => {
    expect(() => parseOk(synthResponse({ ...base(), omitLinks: true }))).toThrow(/dataflow の URN/);
    const bumpedFlow = synthResponse({ ...base(), dataflowVersion: "5.0.1" });
    expect(() => parseOk(bumpedFlow)).toThrow(/dataflow の URN/);
    const bumpedDsd = synthResponse({ ...base(), dsdVersion: "6.0.0" });
    expect(() => parseOk(bumpedDsd)).toThrow(/DSD の URN/);
  });

  it("系列次元の順序・数・固定値が違えば throw", () => {
    const json = synthResponse(base()) as { data: { structures: Array<{ dimensions: { series: unknown[] } }> } };
    json.data.structures[0]!.dimensions.series.pop();
    expect(() => parseOk(json)).toThrow(/系列次元の数/);

    const swapped = synthResponse(base()) as { data: { structures: Array<{ dimensions: { series: Array<{ id: string }> } }> } };
    const dims = swapped.data.structures[0]!.dimensions.series;
    const tmp = dims[0]!;
    dims[0] = dims[5]!;
    dims[5] = tmp;
    expect(() => parseOk(swapped)).toThrow(/系列次元 #0/);
  });

  it("対内 (L・SCC) の要求に報告負債 (L + 非SCC 指標) が返れば throw (無根拠の同一視を防ぐ)", () => {
    const json = synthResponse({
      direction: "world_holds_jp",
      assetClass: "total",
      counterparts: ["USA"],
      periods: ["2025-S1"],
      series: [{ counterpart: "USA", values: ["1000"] }],
      indicatorOverride: "P_TOTINV_P_USD",
    });
    expect(() =>
      parseImfCpisResponse(json, expectedOf("world_holds_jp", "total", ["US"]))
    ).toThrow(/INDICATOR が想定/);
  });

  it("要求していない相手国・系列キーの混在・観測位置の範囲外は throw", () => {
    const json = synthResponse({
      ...base(),
      counterparts: ["USA", "FRA"],
      series: [{ counterpart: "FRA", values: ["1000"] }],
    });
    expect(() => parseOk(json)).toThrow(/要求していない相手国/);

    const mixed = synthResponse(base()) as { data: { dataSets: Array<{ series: Record<string, unknown> }> } };
    mixed.data.dataSets[0]!.series = { "0:1:0:0:0:0:0": { observations: { "0": ["1000", null, 0, null] } } };
    expect(() => parseOk(mixed)).toThrow(/混在スコープ/);

    const badKey = synthResponse(base()) as { data: { dataSets: Array<{ series: Record<string, unknown> }> } };
    badKey.data.dataSets[0]!.series = { "not-a-key": { observations: { "0": ["1000", null, 0, null] } } };
    expect(() => parseOk(badKey)).toThrow(/位置指定/);

    const badObs = synthResponse(base()) as { data: { dataSets: Array<{ series: Record<string, unknown> }> } };
    badObs.data.dataSets[0]!.series = {
      "0:0:0:0:0:0:0": { attributes: [0, null, null], observations: { "9": ["1000", null, 0, null] } },
    };
    expect(() => parseOk(badObs)).toThrow(/範囲外/);
  });

  it("dataSets/structures が単一でない・structure の参照先が 0 でなければ throw (先頭選択なし)", () => {
    const multi = synthResponse(base()) as { data: { dataSets: unknown[]; structures: unknown[] } };
    const ds0 = multi.data.dataSets[0];
    multi.data.dataSets = [ds0, ds0];
    expect(() => parseOk(multi)).toThrow(/dataSets が単一/);
    const multi2 = synthResponse(base()) as { data: { dataSets: unknown[]; structures: unknown[] } };
    const st0 = multi2.data.structures[0];
    multi2.data.structures = [st0, st0];
    expect(() => parseOk(multi2)).toThrow(/structures が単一/);
    const ref1 = synthResponse(base()) as { data: { dataSets: Array<{ structure: number }> } };
    ref1.data.dataSets[0]!.structure = 1;
    expect(() => parseOk(ref1)).toThrow(/structure \(0\) を指していません/);
  });

  it("系列・観測の属性インデックスが許可カタログの範囲外・長さ不一致なら throw (黙認なし)", () => {
    // 系列属性の SCALE 位置に範囲外の添字
    const badSeriesAttr = synthResponse(base()) as { data: { dataSets: Array<{ series: Record<string, { attributes: unknown[] }> }> } };
    badSeriesAttr.data.dataSets[0]!.series["0:0:0:0:0:0:0"]!.attributes = [5, null, null];
    expect(() => parseOk(badSeriesAttr)).toThrow(/許可カタログの範囲外/);
    // 系列属性の長さ不一致 (属性の増減は様式変更)
    const shortSeriesAttr = synthResponse(base()) as { data: { dataSets: Array<{ series: Record<string, { attributes: unknown[] }> }> } };
    shortSeriesAttr.data.dataSets[0]!.series["0:0:0:0:0:0:0"]!.attributes = [0, null];
    expect(() => parseOk(shortSeriesAttr)).toThrow(/属性配列の長さ/);
    // 観測属性の DERIVATION 位置に範囲外の添字 (未知の導出区分を黙認しない)
    const badObsAttr = synthResponse(base()) as { data: { dataSets: Array<{ series: Record<string, { observations: Record<string, unknown[]> }> }> } };
    badObsAttr.data.dataSets[0]!.series["0:0:0:0:0:0:0"]!.observations["0"] = ["1000", null, 3, null];
    expect(() => parseOk(badObsAttr)).toThrow(/許可カタログの範囲外/);
    // 値を持たない属性 (PRECISION) に添字が付けば throw
    const badPrec = synthResponse(base()) as { data: { dataSets: Array<{ series: Record<string, { observations: Record<string, unknown[]> }> }> } };
    badPrec.data.dataSets[0]!.series["0:0:0:0:0:0:0"]!.observations["0"] = ["1000", 0, 0, null];
    expect(() => parseOk(badPrec)).toThrow(/許可カタログの範囲外/);
  });

  it("値なし行の STATUS 'C' リテラル (観測した唯一の例外) は受理して読み飛ばす", () => {
    const json = synthResponse({
      ...base(),
      periods: ["2024-S2", "2025-S1"],
      series: [{ counterpart: "USA", values: [null, "1000"] }],
    }) as { data: { dataSets: Array<{ series: Record<string, { observations: Record<string, unknown[]> }> }> } };
    // 実測形 [null, null, 0, "C"] (f4/f5/f6 の SGP 等 26 件)
    json.data.dataSets[0]!.series["0:0:0:0:0:0:0"]!.observations["0"] = [null, null, 0, "C"];
    const { records } = parseOk(json);
    expect(records).toHaveLength(1);
    expect(records[0]?.period).toBe("2025-S1");
  });

  it("値を持つ行の旗・値一覧がある属性への直書き・系列位置の直書きは throw する", () => {
    type S = { attributes: unknown[]; observations: Record<string, unknown[]> };
    // 値を持つ行に STATUS 旗が付けば throw (provisional 等を正常として読まない)
    const flagged = synthResponse(base()) as { data: { dataSets: Array<{ series: Record<string, S> }> } };
    flagged.data.dataSets[0]!.series["0:0:0:0:0:0:0"]!.observations["0"] = ["1000", null, 0, "C"];
    expect(() => parseOk(flagged)).toThrow(/直書き値/);
    // 値一覧がある属性 (DERIVATION_TYPE) への直書きは throw (添字を使わせる)
    const litDer = synthResponse(base()) as { data: { dataSets: Array<{ series: Record<string, S> }> } };
    litDer.data.dataSets[0]!.series["0:0:0:0:0:0:0"]!.observations["0"] = [null, null, "O", null];
    expect(() => parseOk(litDer)).toThrow(/直書き値/);
    // 系列属性位置の直書きは throw (未観測。止めて再評価させる)
    const litSer = synthResponse(base()) as { data: { dataSets: Array<{ series: Record<string, S> }> } };
    litSer.data.dataSets[0]!.series["0:0:0:0:0:0:0"]!.attributes = ["6", null, null];
    expect(() => parseOk(litSer)).toThrow(/直書き値/);
    // 値なし行でも他の属性 (PRECISION)・他の文字列 ('P') の直書きは throw する
    const litPrec = synthResponse(base()) as { data: { dataSets: Array<{ series: Record<string, S> }> } };
    litPrec.data.dataSets[0]!.series["0:0:0:0:0:0:0"]!.observations["0"] = [null, "X", 0, null];
    expect(() => parseOk(litPrec)).toThrow(/直書き値/);
    const litP = synthResponse(base()) as { data: { dataSets: Array<{ series: Record<string, S> }> } };
    litP.data.dataSets[0]!.series["0:0:0:0:0:0:0"]!.observations["0"] = [null, null, 0, "P"];
    expect(() => parseOk(litP)).toThrow(/直書き値/);
  });

  it("単位・スケール・残高区分・導出区分が想定と違えば throw", () => {
    expect(() => parseOk(synthResponse({ ...base(), unit: "EUR" }))).toThrow(/属性 UNIT/);
    expect(() => parseOk(synthResponse({ ...base(), scale: "3" }))).toThrow(/属性 SCALE/);
    expect(() => parseOk(synthResponse({ ...base(), flowStockEntry: "F" }))).toThrow(/FLOW_STOCK_ENTRY/);
    expect(() => parseOk(synthResponse({ ...base(), derivation: "SCC" }))).toThrow(/DERIVATION_TYPE/);
    // 資産側に DV_TYPE=SCC が付いたら throw (報告値のはず)
    expect(() => parseOk(synthResponse({ ...base(), dvType: "SCC" }))).toThrow(/DV_TYPE/);
    // Derived 側に DV_TYPE が無ければ throw
    const liab = synthResponse({
      direction: "world_holds_jp",
      assetClass: "total",
      counterparts: ["USA"],
      periods: ["2025-S1"],
      series: [{ counterpart: "USA", values: ["1000"] }],
      dvType: null,
    });
    expect(() => parseImfCpisResponse(liab, expectedOf("world_holds_jp", "total", ["US"]))).toThrow(/DV_TYPE/);
  });

  it("期間表記が YYYY-S1/S2 でない・値が有限数でないなら throw", () => {
    const badPeriod = synthResponse({ ...base(), periods: ["2025-Q1"] });
    expect(() => parseOk(badPeriod)).toThrow(/YYYY-S1\/YYYY-S2/);
    const badValue = synthResponse({
      ...base(),
      series: [{ counterpart: "USA", values: ["N/A"] }],
    });
    expect(() => parseOk(badValue)).toThrow(/有限の数値ではありません/);
  });

  it("空・空白の文字列値は 0 として読まず throw する (Number('') は 0 になるため)", () => {
    for (const blank of ["", "   "]) {
      const json = synthResponse({
        ...base(),
        series: [{ counterpart: "USA", values: [blank] }],
      });
      expect(() => parseOk(json)).toThrow(/空・空白の文字列/);
    }
  });
});

describe("fetchImfCpis — 要求と応答の突き合わせ (fetch は差し替え)", () => {
  const respond = (json: unknown) =>
    (async () => new Response(JSON.stringify(json), { status: 200 })) as unknown as typeof fetch;

  it("相手国を束ねた 1 リクエストで取り、欠落は missingSeriesCodes で明示する", async () => {
    const json = synthResponse({
      direction: "jp_holds_abroad",
      assetClass: "total",
      counterparts: ["USA", "G001"],
      periods: ["2025-S1"],
      series: [
        { counterpart: "USA", values: ["1000"] },
        { counterpart: "G001", values: ["2000"] },
      ],
    });
    const seen: string[] = [];
    const capture = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify(json), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchImfCpis(
      [{ direction: "jp_holds_abroad", assetClass: "total", counterpartAreas: ["US", "W00", "TW"] }],
      { fetchImpl: capture }
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("USA+G001+TWN");
    expect(result.records).toHaveLength(2);
    expect(result.missingSeriesCodes).toEqual(["JPN.A.P_TOTINV_P_USD.S1.S1.TWN.S"]);
  });

  it("HTTP エラー・空の要求・空の相手国は throw", async () => {
    const fail = (async () => new Response("err", { status: 503 })) as unknown as typeof fetch;
    await expect(
      fetchImfCpis([{ direction: "jp_holds_abroad", assetClass: "total" }], { fetchImpl: fail })
    ).rejects.toThrow(/HTTP エラー: 503/);
    await expect(fetchImfCpis([], { fetchImpl: respond({}) })).rejects.toThrow(/requests が空/);
    await expect(
      fetchImfCpis([{ direction: "jp_holds_abroad", assetClass: "total", counterpartAreas: [] }], {
        fetchImpl: respond({}),
      })
    ).rejects.toThrow(/counterpartAreas が空/);
  });

  it("要求していない相手国の応答は throw (黙って取り込まない)", async () => {
    const json = synthResponse({
      direction: "jp_holds_abroad",
      assetClass: "total",
      counterparts: ["USA", "FRA"],
      periods: ["2025-S1"],
      series: [
        { counterpart: "USA", values: ["1000"] },
        { counterpart: "FRA", values: ["2000"] },
      ],
    });
    await expect(
      fetchImfCpis([{ direction: "jp_holds_abroad", assetClass: "total", counterpartAreas: ["US"] }], {
        fetchImpl: respond(json),
      })
    ).rejects.toThrow(/要求していない相手国/);
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
    const records = [{ period: "2024-S1" }, { period: "2024-S2" }];
    expect(isImfCpisPeriodPublished(records, "2024-S1")).toBe(true);
    expect(isImfCpisPeriodPublished(records, "2025-S2")).toBe(false);
  });
});

describe("toImfCpisObservationRows (観測ログ用の縦持ち変換)", () => {
  it("実測 (jp_holds_abroad) は isEstimated=false、近似フラグは常に true", () => {
    const rows = toImfCpisObservationRows([
      {
        indicatorKey: "imf_cpis_jp_assets_total",
        direction: "jp_holds_abroad",
        assetClass: "total",
        period: "2025-S1",
        counterpartArea: "US",
        counterpartCountry: "USA",
        valueUsd: 1000,
        seriesCode: "JPN.A.P_TOTINV_P_USD.S1.S1.USA.S",
      },
    ]);
    expect(rows).toEqual([
      {
        period: "2025-S1",
        indicatorKey: "imf_cpis_jp_assets_total",
        category: "US",
        value: 1000,
        unit: "USD",
        isApproximate: true,
        isEstimated: false,
      },
    ]);
  });

  it("Derived 系 (world_holds_jp) は isEstimated=true", () => {
    const rows = toImfCpisObservationRows([
      {
        indicatorKey: "imf_cpis_jp_liabilities_total",
        direction: "world_holds_jp",
        assetClass: "total",
        period: "2025-S1",
        counterpartArea: "US",
        counterpartCountry: "USA",
        valueUsd: 2000,
        seriesCode: "JPN.L.P_TOTINV_P_SCC_USD.S1.S1.USA.S",
      },
    ]);
    expect(rows[0]?.isEstimated).toBe(true);
    expect(rows[0]?.isApproximate).toBe(true);
  });
});

describe("IMF_CPIS_INDICATORS / IMF_CPIS_DEFAULT_COUNTERPART_AREAS", () => {
  it("6 種類 (向き2 × 資産クラス3) の指標定義を持ち、キーが重複しない", () => {
    expect(IMF_CPIS_INDICATORS).toHaveLength(6);
    const keys = IMF_CPIS_INDICATORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(6);
    // 指標キーは旧ミラー時代と同一 (系列の意味同一を証明した範囲で維持)。
    expect(keys).toEqual([
      "imf_cpis_jp_assets_total",
      "imf_cpis_jp_assets_equity",
      "imf_cpis_jp_assets_debt",
      "imf_cpis_jp_liabilities_total",
      "imf_cpis_jp_liabilities_equity",
      "imf_cpis_jp_liabilities_debt",
    ]);
  });

  it("すべて R4 要件・holdings_stock・USD・semiannual を満たす", () => {
    for (const def of IMF_CPIS_INDICATORS) {
      expect(def.requirements).toContain("R4");
      expect(def.flowType).toBe("holdings_stock");
      expect(def.unit).toBe("USD");
      expect(def.frequency).toBe("semiannual");
      expect(def.description.length).toBeGreaterThan(10);
      expect(def.sourceUrl).toBe(IMF_CPIS_SOURCE_URL);
    }
  });

  it("取得元は公式 (data.imf.org) で、ミラーへの言及が無い", () => {
    expect(IMF_CPIS_SOURCE_URL).toBe("https://data.imf.org/en/datasets/IMF.STA:PIP");
    for (const def of IMF_CPIS_INDICATORS) {
      expect(def.usageTerms).not.toMatch(/DBnomics|ミラー/);
      expect(def.usageTerms).toMatch(/公式/);
      expect(def.limitations).not.toMatch(/DBnomics/);
    }
  });

  it("既定の相手国リストに世界計コード W00 を含む", () => {
    expect(IMF_CPIS_DEFAULT_COUNTERPART_AREAS).toContain("W00");
    expect(IMF_CPIS_DEFAULT_COUNTERPART_AREAS).toContain("US");
  });
});

describe("IMF_CPIS_INDICATORS の定義の正確さ (ルール7)", () => {
  it("pip は外貨準備を対象外とする旨を全指標の説明/限界に明記し、「政府を含むすべて」と誤認させない", () => {
    for (const def of IMF_CPIS_INDICATORS) {
      expect(def.limitations).toContain("外貨準備");
      expect(def.description).not.toContain("政府・企業・個人などすべて合計");
    }
    const assets = IMF_CPIS_INDICATORS.filter((d) => d.key.startsWith("imf_cpis_jp_assets_"));
    expect(assets).toHaveLength(3);
    for (const def of assets) {
      expect(def.description).toContain("外貨準備は含まない");
    }
  });

  it("対日側 (Liabilities) は「日本が発行した証券」であり「日本国内で保有」ではない", () => {
    const liab = IMF_CPIS_INDICATORS.filter((d) => d.key.startsWith("imf_cpis_jp_liabilities_"));
    expect(liab).toHaveLength(3);
    for (const def of liab) {
      expect(def.description).not.toContain("日本国内で保有");
      expect(def.description).toContain("発行した証券");
      expect(def.description).toContain("SCC");
    }
  });

  it("改訂と系列ごとの最新期のずれを限界に明記する", () => {
    for (const def of IMF_CPIS_INDICATORS) {
      expect(def.limitations).toContain("改訂");
      expect(def.limitations).toContain("最新期は揃わない");
    }
  });
});
