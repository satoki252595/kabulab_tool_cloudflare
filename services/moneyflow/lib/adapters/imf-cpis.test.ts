/**
 * IMF pip アダプタ (`./imf-cpis.ts`。公式 SDMX API 直接) のテスト。
 *
 * - 公式 SDMX-JSON の形を真似た **合成テストデータ** (実データではない。
 *   値は 1000 の倍数などの作り物) で対応付けの規則を確かめる。合成応答の骨格は
 *   2026-09-28 の実応答と同じ形にしてある。
 * - 旧ミラー (DBnomics) 時代の実ファイルは新パーサでは読めない (様式も
 *   ファイル名も拒む)。混在防止のテストは合成データで行う。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMoneyflowFlowType,
  isMoneyflowFrequency,
  isMoneyflowLicense,
  isMoneyflowRequirement,
} from "../../../../src/shared/notion-archive/index.js";
import { validateDrafts, type ObservationDraft, type SpecFile } from "../source-spec.js";
import {
  IMF_CPIS_DEFAULT_COUNTERPART_AREAS,
  IMF_CPIS_INDICATORS,
  IMF_CPIS_SOURCE_URL,
  IMF_CPIS_USER_AGENT,
  buildImfCpisDataKey,
  type ImfCpisAssetClass,
  type ImfCpisDirection,
} from "../sources/imf-cpis.js";
import {
  IMF_CPIS_EXPECTED_SERIES_CODES,
  IMF_CPIS_PERIOD_WINDOW,
  imfCpisBatchKey,
  imfCpisContentHash,
  imfCpisCounterpartAreas,
  imfCpisPartFilename,
  imfCpisSpec,
} from "./imf-cpis.js";

const ROW_BUDGET = 600;

// ---------------------------------------------------------------------------
// 合成テストデータの組み立て (実データではない)
// ---------------------------------------------------------------------------

const OFFICIAL_OF: Record<string, string> = {
  W00: "G001",
  US: "USA",
  KY: "CYM",
  GB: "GBR",
  LU: "LUX",
  IE: "IRL",
  FR: "FRA",
  DE: "DEU",
  NL: "NLD",
  CH: "CHE",
  AU: "AUS",
  CA: "CAN",
  HK: "HKG",
  SG: "SGP",
  KR: "KOR",
  TW: "TWN",
  CN: "CHN",
};

const SERIES_DEF: Record<ImfCpisDirection, Record<ImfCpisAssetClass, { ae: string; ind: string; der: string }>> = {
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

function code(direction: ImfCpisDirection, assetClass: ImfCpisAssetClass, area: string): string {
  return buildImfCpisDataKey({ direction, assetClass, counterpartArea: area });
}

/** 合成テストデータ: 公式 SDMX-JSON の data 応答。値は作り物。 */
function synthResponse(
  direction: ImfCpisDirection,
  assetClass: ImfCpisAssetClass,
  areas: readonly string[],
  periods: readonly string[],
  values: (area: string, periodIndex: number) => string | number | null
): Record<string, unknown> {
  const d = SERIES_DEF[direction][assetClass];
  const officials = areas.map((a) => OFFICIAL_OF[a] as string);
  const single = (id: string, keyPosition: number, value: string) => ({
    id,
    keyPosition,
    roles: id === "FREQUENCY" ? ["FREQ"] : [],
    values: [{ id: value }],
  });
  const series: Record<string, unknown> = {};
  areas.forEach((area, pos) => {
    const observations: Record<string, unknown> = {};
    periods.forEach((_, i) => {
      observations[String(i)] = [values(area, i), null, 0, null];
    });
    series[`0:0:0:0:0:${pos}:0`] = { attributes: [0, null, null], observations };
  });
  return {
    _meta: { note: "合成テストデータ (実データではない)" },
    data: {
      dataSets: [{ structure: 0, action: "Replace", series }],
      structures: [
        {
          links: [
            {
              urn: "urn:sdmx:org.sdmx.infomodel.datastructure.Dataflow=IMF.STA:PIP(5.0.0)",
              title: "Dataflow",
            },
            {
              urn: "urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=IMF.STA:DSD_PIP(5.0.0)",
              title: "DataStructureDefinition",
            },
          ],
          dimensions: {
            series: [
              single("COUNTRY", 0, "JPN"),
              single("ACCOUNTING_ENTRY", 1, d.ae),
              single("INDICATOR", 2, d.ind),
              single("SECTOR", 3, "S1"),
              single("COUNTERPART_SECTOR", 4, "S1"),
              { id: "COUNTERPART_COUNTRY", keyPosition: 5, roles: [], values: officials.map((id) => ({ id })) },
              single("FREQUENCY", 6, "S"),
            ],
            observation: [{ id: "TIME_PERIOD", keyPosition: 7, values: periods.map((value) => ({ value })) }],
          },
          attributes: {
            dimensionGroup: [
              { id: "FLOW_STOCK_ENTRY", roles: [], values: [{ id: "P" }] },
              ...(d.der === "SCC"
                ? [{ id: "DV_TYPE", roles: [], values: [{ id: "SCC" }] }]
                : [{ id: "DV_TYPE", roles: [] }]),
              { id: "UNIT", roles: [], values: [{ id: "USD" }] },
            ],
            series: [
              { id: "SCALE", roles: [], values: [{ id: "6" }] },
              { id: "DECIMALS_DISPLAYED", roles: [] },
              { id: "OVERLAP", roles: [] },
            ],
            observation: [
              { id: "PRECISION", roles: [] },
              { id: "DERIVATION_TYPE", roles: [], values: [{ id: d.der }] },
              { id: "STATUS", roles: [] },
            ],
          },
        },
      ],
    },
  };
}

function jsonFile(n: number, json: unknown): SpecFile {
  return { filename: imfCpisPartFilename(n), bytes: new TextEncoder().encode(JSON.stringify(json)) };
}

/** ファイル番号 → 向き×資産クラス (adapter の SERIES_TARGETS と同じ順序)。 */
const TARGETS6: ReadonlyArray<{ direction: ImfCpisDirection; assetClass: ImfCpisAssetClass }> = [
  { direction: "jp_holds_abroad", assetClass: "total" },
  { direction: "jp_holds_abroad", assetClass: "equity" },
  { direction: "jp_holds_abroad", assetClass: "debt" },
  { direction: "world_holds_jp", assetClass: "total" },
  { direction: "world_holds_jp", assetClass: "equity" },
  { direction: "world_holds_jp", assetClass: "debt" },
];

/** 指定番号の空パート (米国 1 系列・全期 null。行を作らないが検証は通る)。 */
function nullPart(n: number): SpecFile {
  const t = TARGETS6[n - 1]!;
  return jsonFile(n, synthResponse(t.direction, t.assetClass, ["US"], ["2029-S2"], () => null));
}

/** 部分的なファイル群を 6 件に埋める (欠番は空パートで補う)。 */
function pad6(files: SpecFile[]): SpecFile[] {
  const have = new Set(files.map((f) => f.filename));
  const out = [...files];
  for (let n = 1; n <= 6; n++) {
    if (!have.has(imfCpisPartFilename(n))) out.push(nullPart(n));
  }
  return out;
}

/** ファイル群から決まるキーを再計算する (テスト内の期待キー組み立て用)。 */
function keyOf(files: SpecFile[], latestPeriod: string): string {
  return imfCpisBatchKey(latestPeriod, imfCpisContentHash(files).slice(0, 12));
}

const SYN_PERIODS = ["2027-S1", "2027-S2", "2028-S1", "2028-S2", "2029-S1", "2029-S2"];

function find(drafts: readonly ObservationDraft[], period: string, indicatorKey: string, category: string): ObservationDraft {
  const hits = drafts.filter((d) => d.period === period && d.indicatorKey === indicatorKey && d.category === category);
  expect(hits).toHaveLength(1);
  return hits[0] as ObservationDraft;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. 指標定義
// ---------------------------------------------------------------------------

describe("imfCpisSpec.indicators (指標定義)", () => {
  const JA = /[ぁ-んァ-ヶ一-龠]/;

  it("モジュールの 6 指標をそのままのキーで持ち、列挙値のガードをすべて通る", () => {
    expect(imfCpisSpec.name).toBe("imf-cpis");
    expect(imfCpisSpec.indicators.map((i) => i.key)).toEqual(IMF_CPIS_INDICATORS.map((d) => d.key));
    expect(new Set(imfCpisSpec.indicators.map((i) => i.key)).size).toBe(6);
    for (const ind of imfCpisSpec.indicators) {
      expect(isMoneyflowFlowType(ind.flowType)).toBe(true);
      expect(isMoneyflowFrequency(ind.frequency)).toBe(true);
      expect(isMoneyflowLicense(ind.license)).toBe(true);
      expect(isMoneyflowRequirement(ind.requirement)).toBe(true);
      expect(ind.flowType).toBe("残高");
      expect(ind.frequency).toBe("半期");
      expect(ind.requirement).toBe("R4");
      expect(ind.license).toBe("attribution-required");
      expect(ind.sourceUrl).toBe(IMF_CPIS_SOURCE_URL);
      expect(ind.displayName).toMatch(JA);
      expect(ind.description).toMatch(JA);
      expect(ind.limitations).toMatch(JA);
      // ストックであること・単位・符号の意味・固定の区分と期間の絞り方を必ず書く
      expect(ind.description).toMatch(/ストック/);
      expect(ind.description).toMatch(/米ドル/);
      expect(ind.description).toMatch(/符号/);
      expect(ind.limitations).toMatch(/世界計/);
      expect(ind.limitations).toMatch(new RegExp(`計${IMF_CPIS_PERIOD_WINDOW}期`));
    }
  });

  it("対内 (Derived) 系の指標は推定である旨と非参加国の注意を持つ", () => {
    for (const ind of imfCpisSpec.indicators.filter((i) => i.key.startsWith("imf_cpis_jp_liabilities_"))) {
      expect(ind.description).toMatch(/Derived/);
      expect(ind.limitations).toMatch(/台湾/);
    }
  });

  it("対内の世界計は全額ではないこと、対外の国分けは発行体の居住地であることを書く", () => {
    for (const ind of imfCpisSpec.indicators) {
      if (ind.key.startsWith("imf_cpis_jp_liabilities_")) {
        expect(ind.limitations).toMatch(/約80の国・地域/);
        expect(ind.limitations).toMatch(/全額ではない/);
        expect(ind.limitations).toMatch(/区分には台湾を入れていない/);
        expect(ind.limitations).not.toMatch(/台湾・中国/); // 対内の区分一覧に台湾を載せない
      } else {
        expect(ind.description).toMatch(/居住者/);
        expect(ind.limitations).toMatch(/台湾/); // 対外の区分一覧には台湾がある
      }
    }
  });

  it("取得元は公式 (data.imf.org) で、ミラーへの言及が無い", () => {
    expect(IMF_CPIS_SOURCE_URL).toBe("https://data.imf.org/en/datasets/IMF.STA:PIP");
    for (const ind of imfCpisSpec.indicators) {
      expect(ind.limitations).not.toMatch(/DBnomics|db\.nomics/);
      expect(ind.limitations).toMatch(/公式/);
    }
  });

  it("対内 (Derived) は台湾を問い合わせない (IMF 非加盟で Derived 系列が作られない)", () => {
    expect(imfCpisCounterpartAreas("jp_holds_abroad")).toEqual([...IMF_CPIS_DEFAULT_COUNTERPART_AREAS]);
    expect(imfCpisCounterpartAreas("world_holds_jp")).toEqual(
      IMF_CPIS_DEFAULT_COUNTERPART_AREAS.filter((a) => a !== "TW")
    );
    expect(IMF_CPIS_EXPECTED_SERIES_CODES).toContain(code("jp_holds_abroad", "total", "TW"));
    for (const ac of ["total", "equity", "debt"] as const) {
      expect(IMF_CPIS_EXPECTED_SERIES_CODES).not.toContain(code("world_holds_jp", ac, "TW"));
    }
  });

  it("取得対象は 対外 3 × 17 + 対内 3 × 16 = 99 系列で、4 期分でも 1 バッチの行数目安に収まる", () => {
    expect(IMF_CPIS_EXPECTED_SERIES_CODES).toHaveLength(3 * 17 + 3 * 16);
    expect(new Set(IMF_CPIS_EXPECTED_SERIES_CODES).size).toBe(IMF_CPIS_EXPECTED_SERIES_CODES.length);
    expect(IMF_CPIS_EXPECTED_SERIES_CODES.length * IMF_CPIS_PERIOD_WINDOW).toBeLessThanOrEqual(ROW_BUDGET);
    // すべて公式キー (JPN 起始・S1 固定・半期 S 終端)。旧ミラー形は混ざらない。
    for (const c of IMF_CPIS_EXPECTED_SERIES_CODES) {
      expect(c).toMatch(/^JPN\.[AL]\.P_[A-Z0-9_]+_USD\.S1\.S1\.[A-Z0-9]+\.S$/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. 対応付けの規則 (合成テストデータ、CI でも走る)
// ---------------------------------------------------------------------------

describe("toObservations の対応付け (合成テストデータ)", () => {
  // 合成テストデータ: ファイル1 = 対外・合計 (米国・世界計)、ファイル2 = 対外・株式
  // (米国) の 6 期分。ファイル3〜6 は空パート。ファイル番号と向き×資産クラスが対応する。
  function synthFiles(): SpecFile[] {
    const f1 = synthResponse("jp_holds_abroad", "total", ["US", "W00"], SYN_PERIODS, (area, i) => {
      const us = [1000, 2000, 3000, 4000, 5000, 6000];
      const w00 = [10000, 20000, 30000, 40000, 50000, null];
      return (area === "US" ? us : w00)[i] as number | null;
    });
    const f2 = synthResponse("jp_holds_abroad", "equity", ["US"], SYN_PERIODS, (_, i) =>
      [7000, 8000, 9000, 11000, 12000, 13000][i] as number
    );
    return pad6([jsonFile(1, f1), jsonFile(2, f2)]);
  }

  it("半期 S1/S2 → H1/H2 (基準日 6/30・12/31)、世界計は区分種別「全体」、対外は実測", () => {
    const files = synthFiles();
    const drafts = imfCpisSpec.toObservations({ key: keyOf(files, "2029-S2"), files });
    expect(() => validateDrafts(imfCpisSpec.name, drafts, imfCpisSpec.indicators)).not.toThrow();

    const h2 = find(drafts, "2029-H2", "imf_cpis_jp_assets_total", "米国");
    expect(h2).toEqual({
      period: "2029-H2",
      periodStart: "2029-12-31",
      periodEnd: "2029-12-31",
      indicatorKey: "imf_cpis_jp_assets_total",
      category: "米国",
      categoryKind: "国地域",
      value: 6000,
      unit: "米ドル",
      changeFromPrev: null,
      approximate: true,
      measureKind: "実測",
    });
    const h1 = find(drafts, "2029-H1", "imf_cpis_jp_assets_total", "世界計");
    expect(h1).toMatchObject({ periodStart: "2029-06-30", periodEnd: "2029-06-30", categoryKind: "全体", value: 50000 });
    expect(find(drafts, "2028-H2", "imf_cpis_jp_assets_equity", "米国")).toMatchObject({
      value: 11000,
      measureKind: "実測",
    });
  });

  it("最新期から 4 期分だけを出し、欠損 (null) は行を作らない (0 で埋めない)", () => {
    const files = synthFiles();
    const drafts = imfCpisSpec.toObservations({ key: keyOf(files, "2029-S2"), files });
    expect([...new Set(drafts.map((d) => d.period))]).toEqual(["2028-H1", "2028-H2", "2029-H1", "2029-H2"]);
    // 3 系列 × 4 期 - 世界計 2029-H2 の欠損 1 = 11 行
    expect(drafts).toHaveLength(11);
    expect(drafts.some((d) => d.period === "2029-H2" && d.category === "世界計")).toBe(false);
  });

  it("並びは 期間 → 指標 (モジュールの定義順) → 区分 (取得対象の並び) で決まる", () => {
    const files = synthFiles();
    const drafts = imfCpisSpec.toObservations({ key: keyOf(files, "2029-S2"), files });
    expect(drafts.slice(0, 3).map((d) => `${d.period}|${d.indicatorKey}|${d.category}`)).toEqual([
      "2028-H1|imf_cpis_jp_assets_total|世界計",
      "2028-H1|imf_cpis_jp_assets_total|米国",
      "2028-H1|imf_cpis_jp_assets_equity|米国",
    ]);
    expect(drafts[drafts.length - 1]).toMatchObject({ period: "2029-H2", indicatorKey: "imf_cpis_jp_assets_equity" });
  });

  it("全 99 系列 × 4 期でも検証を通り、区分の日本語名がすべて揃っている", () => {
    const periods = SYN_PERIODS.slice(-IMF_CPIS_PERIOD_WINDOW);
    const targets: Array<{ direction: ImfCpisDirection; assetClass: ImfCpisAssetClass }> = [
      { direction: "jp_holds_abroad", assetClass: "total" },
      { direction: "jp_holds_abroad", assetClass: "equity" },
      { direction: "jp_holds_abroad", assetClass: "debt" },
      { direction: "world_holds_jp", assetClass: "total" },
      { direction: "world_holds_jp", assetClass: "equity" },
      { direction: "world_holds_jp", assetClass: "debt" },
    ];
    const files = targets.map((t, n) => {
      const areas = [...imfCpisCounterpartAreas(t.direction)];
      return jsonFile(
        n + 1,
        synthResponse(t.direction, t.assetClass, areas, periods, (area) => (areas.indexOf(area) + 1) * 1000)
      );
    });
    const drafts = imfCpisSpec.toObservations({ key: keyOf(files, "2029-S2"), files });
    expect(() => validateDrafts(imfCpisSpec.name, drafts, imfCpisSpec.indicators)).not.toThrow();
    expect(drafts).toHaveLength(99 * IMF_CPIS_PERIOD_WINDOW);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    const categories = new Set(drafts.map((d) => d.category));
    expect(categories.size).toBe(IMF_CPIS_DEFAULT_COUNTERPART_AREAS.length);
    expect([...categories].every((c) => /[ぁ-んァ-ヶ一-龠]/.test(c))).toBe(true);
  });

  it("キーは spec 名・最新の半期 (H 表記)・内容ハッシュ先頭12桁から決まる", () => {
    expect(imfCpisBatchKey("2024-S1", "0123456789ab")).toBe("imf-cpis-2024-H1-sha-0123456789ab");
    expect(() => imfCpisBatchKey("2024-Q1", "0123456789ab")).toThrow();
    expect(() => imfCpisBatchKey("2024-S1", "xyz")).toThrow();
    expect(() => imfCpisBatchKey("2024-S1", "0123456789AB")).toThrow();
  });

  it("内容ハッシュはファイル名順で決まり、バイト列が変われば変わる", () => {
    const files = synthFiles();
    const h1 = imfCpisContentHash(files);
    const h2 = imfCpisContentHash([...files].reverse());
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h2).toBe(h1);
    const mutated = files.map((f) => ({ ...f, bytes: new Uint8Array([...f.bytes, 0]) }));
    expect(imfCpisContentHash(mutated)).not.toBe(h1);
  });
});

// ---------------------------------------------------------------------------
// 3. 想定外の入力は throw する (合成テストデータ)
// ---------------------------------------------------------------------------

describe("toObservations は想定外の入力で throw する (合成テストデータ)", () => {
  const okFile = () =>
    jsonFile(
      1,
      synthResponse("jp_holds_abroad", "total", ["US"], ["2029-S2"], () => 1000)
    );
  const keyFor = (files: SpecFile[]) => keyOf(files, "2029-S2");

  it("ファイルが無い・名前が想定外・件数が6でない・番号が飛んでいたら throw", () => {
    expect(() => imfCpisSpec.toObservations({ key: "imf-cpis-2029-H2-sha-000000000000", files: [] })).toThrow(
      /ファイルがありません/
    );
    const f = okFile();
    expect(() =>
      imfCpisSpec.toObservations({ key: keyFor([f]), files: [{ ...f, filename: "other.json" }] })
    ).toThrow(/想定外のファイル名/);
    // 6 件ちょうどが契約。01 のみの欠落バッチは受理しない。
    expect(() => imfCpisSpec.toObservations({ key: keyFor([f]), files: [f] })).toThrow(/6 件ちょうど/);
    expect(() =>
      imfCpisSpec.toObservations({ key: keyFor(pad6([f]).slice(0, 5)), files: pad6([f]).slice(0, 5) })
    ).toThrow(/6 件ちょうど/);
    // 6 件あっても番号飛び (02 が無く 07 がある) は拒む。
    const gap = [f, nullPart(3), nullPart(4), nullPart(5), nullPart(6), { ...nullPart(3), filename: imfCpisPartFilename(7) }];
    expect(() => imfCpisSpec.toObservations({ key: keyFor(gap), files: gap })).toThrow(/imf-cpis-imf-02\.json/);
  });

  it("旧ミラー名のファイルが混ざったら throw (公式・ミラーを混ぜない)", () => {
    const f = okFile();
    const legacy: SpecFile = { ...f, filename: "imf-cpis-dbnomics-01.json" };
    expect(() => imfCpisSpec.toObservations({ key: keyFor([f]), files: [legacy] })).toThrow(/旧ミラー名/);
  });

  it("旧ミラー応答 (series.docs 形) の中身は拒む", () => {
    const mirror: SpecFile = {
      filename: imfCpisPartFilename(1),
      bytes: new TextEncoder().encode(JSON.stringify({ series: { docs: [] } })),
    };
    const files = pad6([mirror]);
    expect(() => imfCpisSpec.toObservations({ key: keyFor(files), files })).toThrow(/data オブジェクト/);
  });

  it("問い合わせていない相手国 (対内の台湾など) が混ざっていたら throw", () => {
    const f = okFile();
    const twLiab = jsonFile(
      4,
      synthResponse("world_holds_jp", "total", ["TW"], ["2029-S2"], () => 1000)
    );
    // ファイル4 は対内・合計のはずだが、TW は問い合わせ対象外なので拒む。
    const files = pad6([f, twLiab]);
    expect(() => imfCpisSpec.toObservations({ key: keyFor(files), files })).toThrow(/要求していない相手国/);
  });

  it("ファイル番号と向き×資産クラスが食い違ったら throw (取り違え防止)", () => {
    // ファイル1 (対外・合計のはず) に対内・合計の応答を入れる
    const wrong: SpecFile = {
      filename: imfCpisPartFilename(1),
      bytes: new TextEncoder().encode(
        JSON.stringify(synthResponse("world_holds_jp", "total", ["US"], ["2029-S2"], () => 1000))
      ),
    };
    const files = pad6([wrong]);
    expect(() => imfCpisSpec.toObservations({ key: keyFor(files), files })).toThrow(/ACCOUNTING_ENTRY が想定/);
  });

  it("JSON でない・観測値ゼロ・キーの不一致は throw", () => {
    const notJson: SpecFile = { filename: imfCpisPartFilename(1), bytes: new TextEncoder().encode("<html>") };
    const njFiles = pad6([notJson]);
    expect(() => imfCpisSpec.toObservations({ key: keyFor(njFiles), files: njFiles })).toThrow(
      /JSON として読めません/
    );

    const allNull: SpecFile[] = [1, 2, 3, 4, 5, 6].map((n) => {
      const t = TARGETS6[n - 1]!;
      return jsonFile(n, synthResponse(t.direction, t.assetClass, ["US"], ["2029-S1", "2029-S2"], () => null));
    });
    expect(() => imfCpisSpec.toObservations({ key: keyFor(allNull), files: allNull })).toThrow(
      /観測値が 1 件もありません/
    );

    const files = pad6([okFile()]);
    expect(() => imfCpisSpec.toObservations({ key: keyFor(files).replace(/sha-/, "sha-0"), files })).toThrow(
      /一致しません/
    );
  });

  it("モジュールのパーサが拒む形 (未知の単位・非SCC 指標の混入) もそのまま throw する", () => {
    const badUnit = synthResponse("jp_holds_abroad", "total", ["US"], ["2029-S2"], () => 1000) as {
      data: { structures: Array<{ attributes: { dimensionGroup: Array<{ id: string; values?: Array<{ id: string }> }> } }> };
    };
    const unit = badUnit.data.structures[0]!.attributes.dimensionGroup.find((a) => a.id === "UNIT")!;
    unit.values = [{ id: "EUR" }];
    const f1: SpecFile = { filename: imfCpisPartFilename(1), bytes: new TextEncoder().encode(JSON.stringify(badUnit)) };
    const uFiles = pad6([f1]);
    expect(() => imfCpisSpec.toObservations({ key: keyFor(uFiles), files: uFiles })).toThrow(/属性 UNIT/);

    // 対内ファイルに報告負債 (L + 非SCC) の応答が混ざったら拒む
    const reported = synthResponse("world_holds_jp", "total", ["US"], ["2029-S2"], () => 1000) as {
      data: { structures: Array<{ dimensions: { series: Array<{ id: string; values: Array<{ id: string }> }> } }> };
    };
    const ind = reported.data.structures[0]!.dimensions.series.find((d) => d.id === "INDICATOR")!;
    ind.values = [{ id: "P_TOTINV_P_USD" }];
    const f4a = jsonFile(1, synthResponse("jp_holds_abroad", "total", ["US"], ["2029-S2"], () => 1000));
    const f4b: SpecFile = {
      filename: imfCpisPartFilename(2),
      bytes: new TextEncoder().encode(JSON.stringify(reported)),
    };
    // ファイル2 は対外・株式のはず。L + 非SCC の応答は ACCOUNTING_ENTRY/INDICATOR の
    // どちらかで必ず拒まれる (「合計」として誤収載しないことが要点)。
    const rFiles = pad6([f4a, f4b]);
    expect(() => imfCpisSpec.toObservations({ key: keyFor(rFiles), files: rFiles })).toThrow(
      /ACCOUNTING_ENTRY が想定|INDICATOR が想定/
    );
  });
});

// ---------------------------------------------------------------------------
// 4. resolve() / fetch() (global fetch を差し替え)
// ---------------------------------------------------------------------------

describe("resolve() / fetch() (合成テストデータを返す fetch スタブ)", () => {
  const PERIODS = ["2028-S1", "2028-S2", "2029-S1", "2029-S2"];

  // 合成テストデータ: 問い合わせの URL から向き×資産クラスを読み取り、その対象の
  // 系列に 4 期分の値を返す。対内・合計の TW は要求に含まれない (対象外の証左)。
  function stubSynthetic(status = 200): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const m = /\.([AL])\.(P_[A-Z0-9_]+_USD)\.S1\.S1\.([A-Z0-9+]+)\.S\?/.exec(url);
      if (!m) throw new Error(`想定外の URL: ${url}`);
      const [, ae, ind, ctys] = m as unknown as [string, string, string, string];
      const entries: Array<{ direction: ImfCpisDirection; assetClass: ImfCpisAssetClass; ae: string; ind: string }> = [
        ...(Object.entries(SERIES_DEF.jp_holds_abroad) as Array<[ImfCpisAssetClass, { ae: string; ind: string }]>).map(
          ([assetClass, d]) => ({ direction: "jp_holds_abroad" as const, assetClass, ...d })
        ),
        ...(Object.entries(SERIES_DEF.world_holds_jp) as Array<[ImfCpisAssetClass, { ae: string; ind: string }]>).map(
          ([assetClass, d]) => ({ direction: "world_holds_jp" as const, assetClass, ...d })
        ),
      ];
      const target = entries.find((t) => t.ae === ae && t.ind === ind);
      if (!target) throw new Error(`想定外の向き×資産クラス: ${ae}.${ind}`);
      const officials = ctys!.split("+");
      const rmap = new Map(Object.entries(OFFICIAL_OF).map(([k, v]) => [v, k]));
      const areas = officials.map((o) => {
        const a = rmap.get(o);
        if (!a) throw new Error(`想定外の相手国: ${o}`);
        return a;
      });
      const json = synthResponse(target.direction, target.assetClass, areas, PERIODS, (area, i) =>
        area === "TW" ? null : (areas.indexOf(area) + 1) * 1000 + i
      );
      return new Response(JSON.stringify(json), {
        status,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("99 系列を 6 リクエストで取り、キー・保管ファイル・メタデータを返す", async () => {
    const fetchMock = stubSynthetic();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const resolved = await imfCpisSpec.resolve(new Date("2030-02-01T00:00:00Z"));
    expect(resolved.key).toMatch(/^imf-cpis-2029-H2-sha-[0-9a-f]{12}$/);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    for (const url of urls) {
      expect(url.startsWith("https://api.imf.org/external/sdmx/3.0/data/dataflow/IMF.STA/PIP/5.0.0/")).toBe(true);
      expect(url).toContain("+"); // 相手国を束ねる
      expect(url).not.toContain("startPeriod");
    }
    // 対内の 3 本に TWN が含まれない (問い合わせ対象外)
    const liabUrls = urls.filter((u) => u.includes(".L."));
    expect(liabUrls).toHaveLength(3);
    for (const u of liabUrls) expect(u).not.toContain("TWN");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(IMF_CPIS_USER_AGENT);

    const batch = await resolved.fetch();
    expect(batch.key).toBe(resolved.key);
    expect(batch.files.map((f) => f.filename)).toEqual([
      "imf-cpis-imf-01.json",
      "imf-cpis-imf-02.json",
      "imf-cpis-imf-03.json",
      "imf-cpis-imf-04.json",
      "imf-cpis-imf-05.json",
      "imf-cpis-imf-06.json",
    ]);
    expect(batch.files.every((f) => f.contentType === "application/json")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(6); // fetch() は取り直さない
    expect(batch.metadata).toMatchObject({
      latestPeriod: "2029-H2",
      periodsInBatch: ["2028-H1", "2028-H2", "2029-H1", "2029-H2"],
      seriesRequested: 99,
      seriesReturned: 99,
    });
    expect(batch.metadata.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect((batch.metadata.seriesMissing as string[])).toEqual([]);
    // TW (対外・3 系列) は応答に含まれるが全期 null のため行にならない
    expect(batch.metadata.observationRows).toBe(99 * 4 - 3 * 4);
    expect(warn).not.toHaveBeenCalled();

    const drafts = imfCpisSpec.toObservations({ key: batch.key, files: batch.files });
    expect(() => validateDrafts(imfCpisSpec.name, drafts, imfCpisSpec.indicators)).not.toThrow();
    expect(drafts).toHaveLength(99 * 4 - 3 * 4);
  });

  it("応答に無い系列は警告して行を作らない", async () => {
    // 対外・合計の応答から KY を落とすスタブ
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const isAssetsTotal = url.includes(".A.P_TOTINV_P_USD.");
      const m = /\.S1\.S1\.([A-Z0-9+]+)\.S\?/.exec(url);
      const officials = m![1]!.split("+").filter((o) => !(isAssetsTotal && o === "CYM"));
      const rmap = new Map(Object.entries(OFFICIAL_OF).map(([k, v]) => [v, k]));
      const areas = officials.map((o) => rmap.get(o) as string);
      const target = url.includes(".A.P_TOTINV_P_USD.")
        ? ({ direction: "jp_holds_abroad", assetClass: "total" } as const)
        : url.includes(".A.P_F51_P_USD.")
          ? ({ direction: "jp_holds_abroad", assetClass: "equity" } as const)
          : url.includes(".A.P_F3_P_USD.")
            ? ({ direction: "jp_holds_abroad", assetClass: "debt" } as const)
            : url.includes(".L.P_TOTINV_P_SCC_USD.")
              ? ({ direction: "world_holds_jp", assetClass: "total" } as const)
              : url.includes(".L.P_F51_P_SCC_USD.")
                ? ({ direction: "world_holds_jp", assetClass: "equity" } as const)
                : ({ direction: "world_holds_jp", assetClass: "debt" } as const);
      const json = synthResponse(target.direction, target.assetClass, areas, PERIODS, () => 1000);
      return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const resolved = await imfCpisSpec.resolve(new Date("2030-02-01T00:00:00Z"));
    const batch = await resolved.fetch();
    expect(batch.metadata.seriesReturned).toBe(98);
    expect(batch.metadata.seriesMissing).toEqual(["JPN.A.P_TOTINV_P_USD.S1.S1.CYM.S"]);
    expect(warn).toHaveBeenCalledTimes(1);
    const drafts = imfCpisSpec.toObservations({ key: batch.key, files: batch.files });
    expect(drafts.some((d) => d.indicatorKey === "imf_cpis_jp_assets_total" && d.category === "ケイマン諸島")).toBe(false);
  });

  it("最新期の基準日が実行日より後なら throw (応答が不正)", async () => {
    stubSynthetic();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(imfCpisSpec.resolve(new Date("2029-12-30T00:00:00Z"))).rejects.toThrow(/実行日/);
  });

  it("HTTP エラーは throw (モジュールの判定をそのまま通す)", async () => {
    stubSynthetic(503);
    await expect(imfCpisSpec.resolve(new Date("2030-02-01T00:00:00Z"))).rejects.toThrow(/HTTP エラー: 503/);
  });
});
