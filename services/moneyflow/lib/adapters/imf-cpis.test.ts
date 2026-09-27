/**
 * IMF CPIS アダプタ (`./imf-cpis.ts`) のテスト。
 *
 * - 実ファイル (2026-09-27 に DBnomics API から取得した応答 JSON) は
 *   `../sources/fixtures/private/imf-cpis/` にあり commit しない。無い環境 (CI) では
 *   `describe.skipIf` で skip する。値の期待値は Python の json モジュールで
 *   同じファイルから独立に読み出したもの (検証証跡の verified_values とも一致)。
 * - CI でも走る部分は、DBnomics 応答の形を真似た **合成テストデータ** (実データではない。
 *   値は 1000 の倍数などの作り物) で対応付けの規則を確かめる。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  IMF_CPIS_MAX_SERIES_PER_REQUEST,
  IMF_CPIS_USER_AGENT,
  buildImfCpisSeriesCode,
  type ImfCpisAssetClass,
  type ImfCpisDirection,
} from "../sources/imf-cpis.js";
import {
  IMF_CPIS_EXPECTED_SERIES_CODES,
  IMF_CPIS_PERIOD_WINDOW,
  imfCpisBatchKey,
  imfCpisCounterpartAreas,
  imfCpisPartFilename,
  imfCpisSpec,
} from "./imf-cpis.js";

const ROW_BUDGET = 600;

// ---------------------------------------------------------------------------
// 合成テストデータの組み立て (実データではない)
// ---------------------------------------------------------------------------

function code(direction: ImfCpisDirection, assetClass: ImfCpisAssetClass, area: string): string {
  return buildImfCpisSeriesCode({ direction, assetClass, counterpartArea: area });
}

/** 合成テストデータ: DBnomics `/v22/series` の docs 1 件 (series_code から次元を組み立てる)。 */
function synthDoc(seriesCode: string, periods: string[], values: Array<number | null>): Record<string, unknown> {
  const [freq, ref, indicator, refSector, cpSector, area] = seriesCode.split(".");
  return {
    series_code: seriesCode,
    dimensions: {
      FREQ: freq,
      REF_AREA: ref,
      INDICATOR: indicator,
      REF_SECTOR: refSector,
      COUNTERPART_SECTOR: cpSector,
      COUNTERPART_AREA: area,
    },
    period: periods,
    value: values,
  };
}

/** 合成テストデータ: DBnomics `/v22/series` 応答の最小形。 */
function synthResponse(docs: Array<Record<string, unknown>>, updatedAt: unknown): Record<string, unknown> {
  return {
    _meta: { note: "合成テストデータ (実データではない)" },
    datasets: { "IMF/CPIS": { updated_at: updatedAt } },
    errors: null,
    series: { docs, num_found: docs.length, limit: 1000, offset: 0 },
  };
}

function jsonFile(n: number, json: unknown): SpecFile {
  return { filename: imfCpisPartFilename(n), bytes: new TextEncoder().encode(JSON.stringify(json)) };
}

const SYN_UPDATED = "2030-01-15";
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
      expect(ind.sourceUrl).toMatch(/^https:\/\//);
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
  });
});

// ---------------------------------------------------------------------------
// 2. 実ファイル → toObservations
// ---------------------------------------------------------------------------

const FIXTURE_DIR = fileURLToPath(new URL("../sources/fixtures/private/imf-cpis/", import.meta.url));
const FIXTURE_NAMES = [
  "imf-cpis-jp-assets-total.json",
  "imf-cpis-jp-assets-equity-debt.json",
  "imf-cpis-jp-liabilities-total.json",
  "imf-cpis-jp-liabilities-equity-debt.json",
] as const;
const hasFixtures = FIXTURE_NAMES.every((n) => existsSync(FIXTURE_DIR + n));
const FIXTURE_KEY = "imf-cpis-2024-H1-updated-2025-04-08";

function fixtureBytes(name: (typeof FIXTURE_NAMES)[number]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(FIXTURE_DIR + name));
}

/** 実ファイル 4 本を、本番と同じ命名 (imf-cpis-dbnomics-NN.json) の分割ファイルとして並べる。 */
function fixtureFiles(order: readonly (typeof FIXTURE_NAMES)[number][] = FIXTURE_NAMES): SpecFile[] {
  return order.map((name, i) => ({ filename: imfCpisPartFilename(i + 1), bytes: fixtureBytes(name) }));
}

describe.skipIf(!hasFixtures)("toObservations (実ファイル: DBnomics 応答 2026-09-27 取得)", () => {
  it("検証を通り、最新 4 期 (2022-H2〜2024-H1) × 10 系列 = 40 行を作る", () => {
    const drafts = imfCpisSpec.toObservations({ key: FIXTURE_KEY, files: fixtureFiles() });
    expect(() => validateDrafts(imfCpisSpec.name, drafts, imfCpisSpec.indicators)).not.toThrow();
    expect(drafts).toHaveLength(40);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    expect([...new Set(drafts.map((d) => d.period))]).toEqual(["2022-H2", "2023-H1", "2023-H2", "2024-H1"]);
    for (const d of drafts) {
      expect(d.unit).toBe("米ドル");
      expect(d.changeFromPrev).toBeNull();
      expect(d.approximate).toBe(true);
      expect(d.periodStart).toBe(d.periodEnd);
    }
  });

  it("値・単位・期間・区分・実測推定を実ファイルどおりに写す (Python で独立に読んだ値と一致)", () => {
    const drafts = imfCpisSpec.toObservations({ key: FIXTURE_KEY, files: fixtureFiles() });

    const usAssets = find(drafts, "2024-H1", "imf_cpis_jp_assets_total", "米国");
    expect(usAssets.value).toBe(2072394613197.0);
    expect(usAssets.unit).toBe("米ドル");
    expect(usAssets.periodStart).toBe("2024-06-30");
    expect(usAssets.periodEnd).toBe("2024-06-30");
    expect(usAssets.categoryKind).toBe("国地域");
    expect(usAssets.measureKind).toBe("実測");

    expect(find(drafts, "2024-H1", "imf_cpis_jp_assets_total", "ケイマン諸島").value).toBe(818396287835.949);

    const world = find(drafts, "2024-H1", "imf_cpis_jp_assets_total", "世界計");
    expect(world.value).toBe(4337640482073.52);
    expect(world.categoryKind).toBe("全体");

    const usLiab = find(drafts, "2024-H1", "imf_cpis_jp_liabilities_total", "米国");
    expect(usLiab.value).toBe(1225933000000);
    expect(usLiab.measureKind).toBe("推定");

    expect(find(drafts, "2024-H1", "imf_cpis_jp_assets_equity", "米国").value).toBe(927585184508.034);
    expect(find(drafts, "2024-H1", "imf_cpis_jp_assets_debt", "米国").value).toBe(1144809428688.97);

    const worldLiab2022 = find(drafts, "2022-H2", "imf_cpis_jp_liabilities_total", "世界計");
    expect(worldLiab2022.value).toBe(2901534674594.02);
    expect(worldLiab2022.periodEnd).toBe("2022-12-31");

    expect(find(drafts, "2023-H1", "imf_cpis_jp_liabilities_total", "ケイマン諸島").value).toBe(127152340236.91);
    expect(find(drafts, "2023-H2", "imf_cpis_jp_liabilities_equity", "米国").value).toBe(991275000000);

    // 株式 + 債券 = 合計 (同じ取得分の内部整合。誤差は浮動小数の丸め程度)
    const eq = find(drafts, "2024-H1", "imf_cpis_jp_assets_equity", "米国").value;
    const debt = find(drafts, "2024-H1", "imf_cpis_jp_assets_debt", "米国").value;
    expect(Math.abs(eq + debt - usAssets.value)).toBeLessThan(1);

    // 窓の外 (2022-H1) は出さない
    expect(drafts.some((d) => d.period === "2022-H1")).toBe(false);
  });

  it("最後の行は最新期・最後の指標 (取込完了の印)。ファイルの並びを変えても同じ行列になる", () => {
    const a = imfCpisSpec.toObservations({ key: FIXTURE_KEY, files: fixtureFiles() });
    const reversed = [...FIXTURE_NAMES].reverse();
    const b = imfCpisSpec.toObservations({ key: FIXTURE_KEY, files: fixtureFiles(reversed) });
    expect(b).toEqual(a);
    const last = a[a.length - 1] as ObservationDraft;
    expect(last).toMatchObject({
      period: "2024-H1",
      indicatorKey: "imf_cpis_jp_liabilities_debt",
      category: "米国",
      value: 198368000000,
    });
  });

  it("キーがファイルの中身 (最新期・DBnomics 更新日) と合わなければ throw する", () => {
    expect(() =>
      imfCpisSpec.toObservations({ key: "imf-cpis-2024-H1-updated-2025-04-09", files: fixtureFiles() })
    ).toThrow(/一致しません/);
    expect(() =>
      imfCpisSpec.toObservations({ key: "imf-cpis-2023-H2-updated-2025-04-08", files: fixtureFiles() })
    ).toThrow(/一致しません/);
  });
});

// ---------------------------------------------------------------------------
// 3. 対応付けの規則 (合成テストデータ、CI でも走る)
// ---------------------------------------------------------------------------

describe("toObservations の対応付け (合成テストデータ)", () => {
  const synthKey = "imf-cpis-2029-H2-updated-2030-01-15";

  function synthFiles(): SpecFile[] {
    // 合成テストデータ: 対外 (合計) 米国・世界計と、対内 (株式) 米国の 3 系列、6 期分。
    const f1 = synthResponse(
      [
        synthDoc(code("jp_holds_abroad", "total", "US"), SYN_PERIODS, [1000, 2000, 3000, 4000, 5000, 6000]),
        synthDoc(code("jp_holds_abroad", "total", "W00"), SYN_PERIODS, [10000, 20000, 30000, 40000, 50000, null]),
      ],
      SYN_UPDATED
    );
    const f2 = synthResponse(
      [synthDoc(code("world_holds_jp", "equity", "US"), SYN_PERIODS, [7000, 8000, 9000, 11000, 12000, 13000])],
      SYN_UPDATED
    );
    return [jsonFile(1, f1), jsonFile(2, f2)];
  }

  it("半期 S1/S2 → H1/H2 (基準日 6/30・12/31)、世界計は区分種別「全体」、対内は推定", () => {
    const drafts = imfCpisSpec.toObservations({ key: synthKey, files: synthFiles() });
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
    expect(find(drafts, "2028-H2", "imf_cpis_jp_liabilities_equity", "米国")).toMatchObject({
      value: 11000,
      measureKind: "推定",
    });
  });

  it("最新期から 4 期分だけを出し、欠損 (null) は行を作らない (0 で埋めない)", () => {
    const drafts = imfCpisSpec.toObservations({ key: synthKey, files: synthFiles() });
    expect([...new Set(drafts.map((d) => d.period))]).toEqual(["2028-H1", "2028-H2", "2029-H1", "2029-H2"]);
    // 3 系列 × 4 期 - 世界計 2029-H2 の欠損 1 = 11 行
    expect(drafts).toHaveLength(11);
    expect(drafts.some((d) => d.period === "2029-H2" && d.category === "世界計")).toBe(false);
  });

  it("並びは 期間 → 指標 (モジュールの定義順) → 区分 (取得対象の並び) で決まる", () => {
    const drafts = imfCpisSpec.toObservations({ key: synthKey, files: synthFiles() });
    expect(drafts.slice(0, 3).map((d) => `${d.period}|${d.indicatorKey}|${d.category}`)).toEqual([
      "2028-H1|imf_cpis_jp_assets_total|世界計",
      "2028-H1|imf_cpis_jp_assets_total|米国",
      "2028-H1|imf_cpis_jp_liabilities_equity|米国",
    ]);
    expect(drafts[drafts.length - 1]).toMatchObject({ period: "2029-H2", indicatorKey: "imf_cpis_jp_liabilities_equity" });
  });

  it("全 99 系列 × 4 期でも検証を通り、区分の日本語名がすべて揃っている", () => {
    const periods = SYN_PERIODS.slice(-IMF_CPIS_PERIOD_WINDOW);
    const docs = IMF_CPIS_EXPECTED_SERIES_CODES.map((c, i) => synthDoc(c, periods, periods.map((_, j) => (i + 1) * 1000 + j)));
    const files = [
      jsonFile(1, synthResponse(docs.slice(0, IMF_CPIS_MAX_SERIES_PER_REQUEST), SYN_UPDATED)),
      jsonFile(2, synthResponse(docs.slice(IMF_CPIS_MAX_SERIES_PER_REQUEST), SYN_UPDATED)),
    ];
    const drafts = imfCpisSpec.toObservations({ key: synthKey, files });
    expect(() => validateDrafts(imfCpisSpec.name, drafts, imfCpisSpec.indicators)).not.toThrow();
    expect(drafts).toHaveLength(99 * IMF_CPIS_PERIOD_WINDOW);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    const categories = new Set(drafts.map((d) => d.category));
    expect(categories.size).toBe(IMF_CPIS_DEFAULT_COUNTERPART_AREAS.length);
    expect([...categories].every((c) => /[ぁ-んァ-ヶ一-龠]/.test(c))).toBe(true);
  });

  it("キーは spec 名・最新の半期 (H 表記)・DBnomics 更新日から決まる", () => {
    expect(imfCpisBatchKey("2024-S1", "2025-04-08")).toBe("imf-cpis-2024-H1-updated-2025-04-08");
    expect(imfCpisBatchKey("2029-S2", "2030-01-15")).toBe(synthKey);
    expect(() => imfCpisBatchKey("2024-Q1", "2025-04-08")).toThrow();
    expect(() => imfCpisBatchKey("2024-S1", "20250408")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. 想定外の入力は throw する (合成テストデータ)
// ---------------------------------------------------------------------------

describe("toObservations は想定外の入力で throw する (合成テストデータ)", () => {
  const key = "imf-cpis-2029-H2-updated-2030-01-15";
  const okDoc = () => synthDoc(code("jp_holds_abroad", "total", "US"), ["2029-S2"], [1000]);

  it("ファイルが無い・名前が想定外・番号が飛んでいる", () => {
    expect(() => imfCpisSpec.toObservations({ key, files: [] })).toThrow(/ファイルがありません/);
    const f = jsonFile(1, synthResponse([okDoc()], SYN_UPDATED));
    expect(() => imfCpisSpec.toObservations({ key, files: [{ ...f, filename: "other.json" }] })).toThrow(
      /想定外のファイル名/
    );
    const f3 = { ...jsonFile(1, synthResponse([], SYN_UPDATED)), filename: imfCpisPartFilename(3) };
    expect(() => imfCpisSpec.toObservations({ key, files: [f, f3] })).toThrow(/imf-cpis-dbnomics-02\.json/);
  });

  it("問い合わせていない相手国 (未知の区分) や部門別系列が混ざっていたら throw", () => {
    const unknownArea = synthDoc("B.JP.I_A_T_T_T_BP6_USD.T.T.FJ", ["2029-S2"], [1000]);
    expect(() =>
      imfCpisSpec.toObservations({ key, files: [jsonFile(1, synthResponse([okDoc(), unknownArea], SYN_UPDATED))] })
    ).toThrow(/問い合わせていない系列/);
    const twLiab = synthDoc(code("world_holds_jp", "total", "TW"), ["2029-S2"], [1000]);
    expect(() =>
      imfCpisSpec.toObservations({ key, files: [jsonFile(1, synthResponse([okDoc(), twLiab], SYN_UPDATED))] })
    ).toThrow(/問い合わせていない系列/);
    // 部門別系列はモジュールのパーサ (parseImfCpisResponse) が REF_SECTOR/COUNTERPART_SECTOR
    // の検証で先に拒む (アダプタの系列突き合わせより前)。「合計」として誤収載しないことが要点。
    const sector = synthDoc("B.JP.I_A_T_T_T_BP6_USD.CB.T.US", ["2029-S2"], [1000]);
    expect(() =>
      imfCpisSpec.toObservations({ key, files: [jsonFile(1, synthResponse([sector], SYN_UPDATED))] })
    ).toThrow(/想定外の部門です/);
  });

  it("同じ系列が 2 回・ファイル間で更新日が違う・更新日が無い", () => {
    const f1 = jsonFile(1, synthResponse([okDoc()], SYN_UPDATED));
    expect(() =>
      imfCpisSpec.toObservations({ key, files: [f1, jsonFile(2, synthResponse([okDoc()], SYN_UPDATED))] })
    ).toThrow(/2 回現れました/);
    const other = synthDoc(code("jp_holds_abroad", "total", "GB"), ["2029-S2"], [1000]);
    expect(() =>
      imfCpisSpec.toObservations({ key, files: [f1, jsonFile(2, synthResponse([other], "2030-01-16"))] })
    ).toThrow(/更新日が一致しません/);
    expect(() =>
      imfCpisSpec.toObservations({ key, files: [jsonFile(1, synthResponse([okDoc()], null))] })
    ).toThrow(/updated_at/);
  });

  it("DBnomics の errors・途中で切れた応答・JSON でない・観測値ゼロ", () => {
    const withErrors = { ...synthResponse([okDoc()], SYN_UPDATED), errors: [{ message: "合成テストデータのエラー" }] };
    expect(() => imfCpisSpec.toObservations({ key, files: [jsonFile(1, withErrors)] })).toThrow(/エラーを返して/);
    const errorOnly = { errors: [{ message: "合成テストデータのエラー (series なし)" }] };
    expect(() => imfCpisSpec.toObservations({ key, files: [jsonFile(1, errorOnly)] })).toThrow(/エラーを返して/);

    const truncated = synthResponse([okDoc()], SYN_UPDATED);
    (truncated.series as Record<string, unknown>).num_found = 5;
    expect(() => imfCpisSpec.toObservations({ key, files: [jsonFile(1, truncated)] })).toThrow(/途中で切れて/);

    const notJson: SpecFile = { filename: imfCpisPartFilename(1), bytes: new TextEncoder().encode("<html>") };
    expect(() => imfCpisSpec.toObservations({ key, files: [notJson] })).toThrow(/JSON として読めません/);

    const allNull = synthDoc(code("jp_holds_abroad", "total", "US"), ["2029-S1", "2029-S2"], [null, null]);
    expect(() =>
      imfCpisSpec.toObservations({ key, files: [jsonFile(1, synthResponse([allNull], SYN_UPDATED))] })
    ).toThrow(/観測値が 1 件もありません/);
  });

  it("モジュールのパーサが拒む形 (未知の INDICATOR・四半期) もそのまま throw する", () => {
    const quarterly = synthDoc("Q.JP.I_A_T_T_T_BP6_USD.T.T.US", ["2029-S2"], [1000]);
    expect(() =>
      imfCpisSpec.toObservations({ key, files: [jsonFile(1, synthResponse([quarterly], SYN_UPDATED))] })
    ).toThrow(/FREQ/);
    const unknownIndicator = synthDoc("B.JP.I_X_T_T_T_BP6_USD.T.T.US", ["2029-S2"], [1000]);
    expect(() =>
      imfCpisSpec.toObservations({ key, files: [jsonFile(1, synthResponse([unknownIndicator], SYN_UPDATED))] })
    ).toThrow(/INDICATOR/);
  });
});

// ---------------------------------------------------------------------------
// 4. resolve() / fetch() (global fetch を差し替え)
// ---------------------------------------------------------------------------

function seriesIdsOf(url: string): string[] {
  const ids = new URL(url).searchParams.get("series_ids");
  if (ids === null) throw new Error(`series_ids がありません: ${url}`);
  return ids.split(",").map((id) => id.replace(/^IMF\/CPIS\//, ""));
}

describe("resolve() / fetch() (合成テストデータを返す fetch スタブ)", () => {
  // 合成テストデータ: 問い合わせのうち対外 (合計) の系列だけに 4 期分の値を返す (他は応答に無い)。
  function stubSynthetic(status = 200): ReturnType<typeof vi.fn> {
    const periods = ["2028-S1", "2028-S2", "2029-S1", "2029-S2"];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const docs = seriesIdsOf(url)
        .filter((c) => c.includes(".I_A_T_T_T_BP6_USD."))
        .map((c) => synthDoc(c, periods, [1000, 2000, 3000, 4000]));
      return new Response(JSON.stringify(synthResponse(docs, SYN_UPDATED)), {
        status,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("99 系列を 2 リクエストで取り、キー・保管ファイル・メタデータを返す", async () => {
    const fetchMock = stubSynthetic();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const resolved = await imfCpisSpec.resolve(new Date("2030-02-01T00:00:00Z"));
    expect(resolved.key).toBe("imf-cpis-2029-H2-updated-2030-01-15");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requested = fetchMock.mock.calls.flatMap((c) => seriesIdsOf(String(c[0])));
    expect(requested).toEqual([...IMF_CPIS_EXPECTED_SERIES_CODES]);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe(IMF_CPIS_USER_AGENT);

    const batch = await resolved.fetch();
    expect(batch.key).toBe(resolved.key);
    expect(batch.files.map((f) => f.filename)).toEqual(["imf-cpis-dbnomics-01.json", "imf-cpis-dbnomics-02.json"]);
    expect(batch.files.every((f) => f.contentType === "application/json")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2); // fetch() は取り直さない
    expect(batch.metadata).toMatchObject({
      dbnomicsDatasetUpdatedAt: SYN_UPDATED,
      latestPeriod: "2029-H2",
      periodsInBatch: ["2028-H1", "2028-H2", "2029-H1", "2029-H2"],
      seriesRequested: 99,
      seriesReturned: 17,
      observationRows: 17 * 4,
    });
    expect((batch.metadata.seriesMissing as string[]).length).toBe(99 - 17);
    expect(warn).toHaveBeenCalledTimes(1);

    const drafts = imfCpisSpec.toObservations({ key: batch.key, files: batch.files });
    expect(() => validateDrafts(imfCpisSpec.name, drafts, imfCpisSpec.indicators)).not.toThrow();
    expect(drafts).toHaveLength(17 * 4);
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

describe.skipIf(!hasFixtures)("resolve() / fetch() (実ファイルを返す fetch スタブ)", () => {
  it("実応答のバイト列をそのまま保管し、同じキーで toObservations できる", async () => {
    // 1 本目の問い合わせには「対外・合計」、2 本目には「対内・株式/債券」の実応答を返す
    // (本番の 99 系列の応答ではなく、系列が一部だけの応答として扱われる)。
    // モジュールの fetchImfCpis() は「その問い合わせで要求していない系列」を拒むので、
    // 各問い合わせ (60 系列ずつ) に含まれる系列だけから成る実応答を選ぶ: 対外・合計
    // (US/KY/W00) は 1 本目、対内・株式/債券 (US) は 2 本目に含まれる
    // (対内・合計の W00/US/KY は 1 本目に含まれるため 2 本目には返せない)。
    const served = [
      fixtureBytes("imf-cpis-jp-assets-total.json"),
      fixtureBytes("imf-cpis-jp-liabilities-equity-debt.json"),
    ];
    let call = 0;
    const fetchMock = vi.fn(async () => {
      const bytes = served[call];
      call += 1;
      if (bytes === undefined) throw new Error("想定外の 3 本目の問い合わせ");
      return new Response(bytes, { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const resolved = await imfCpisSpec.resolve(new Date("2026-09-27T09:00:00Z"));
    expect(resolved.key).toBe(FIXTURE_KEY);
    const batch = await resolved.fetch();
    expect(batch.key).toBe(FIXTURE_KEY);
    expect(batch.files.map((f) => f.filename)).toEqual(["imf-cpis-dbnomics-01.json", "imf-cpis-dbnomics-02.json"]);
    expect(Buffer.from(batch.files[0]?.bytes as Uint8Array).equals(Buffer.from(served[0] as Uint8Array))).toBe(true);
    expect(Buffer.from(batch.files[1]?.bytes as Uint8Array).equals(Buffer.from(served[1] as Uint8Array))).toBe(true);
    expect(batch.metadata).toMatchObject({ latestPeriod: "2024-H1", dbnomicsDatasetUpdatedAt: "2025-04-08", seriesReturned: 5 });

    const drafts = imfCpisSpec.toObservations({ key: batch.key, files: batch.files });
    expect(() => validateDrafts(imfCpisSpec.name, drafts, imfCpisSpec.indicators)).not.toThrow();
    expect(drafts).toHaveLength(5 * 4);
    expect(find(drafts, "2024-H1", "imf_cpis_jp_assets_total", "米国").value).toBe(2072394613197.0);
    expect(find(drafts, "2024-H1", "imf_cpis_jp_liabilities_debt", "米国").value).toBe(198368000000);
  });
});
