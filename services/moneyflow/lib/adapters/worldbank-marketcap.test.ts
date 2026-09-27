/**
 * World Bank 上場企業時価総額アダプタ (`./worldbank-marketcap.ts`) のテスト。
 *
 * - 実ファイル (2026-09-27 に World Bank API から取得した応答 JSON) は
 *   `../sources/fixtures/public/worldbank-marketcap/` にある (CC BY 4.0 で再配布可のため
 *   public)。規約に揃えて、無い環境では `describe.skipIf` で skip する。値の期待値は
 *   Python の json モジュールで同じファイルから独立に読み出したもの (検証証跡の
 *   verified_values: 日本 2023/2025・米国 2023・ドイツ 2023・World 2023 とも一致)。
 * - CI でも走る部分は、World Bank API 応答の形を真似た **合成テストデータ**
 *   (実データではない。年は 2024〜2030、値は 1000 の倍数などの作り物) で対応付けの
 *   規則を確かめる。
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
import { WORLDBANK_MARKETCAP_INDICATOR, buildCountryMetaUrl, buildMarketCapUrl } from "../sources/worldbank-marketcap.js";
import {
  WORLDBANK_MARKETCAP_ENTITIES,
  worldbankMarketcapBatchKey,
  worldbankMarketcapFilenames,
  worldbankMarketcapSpec,
} from "./worldbank-marketcap.js";

const ROW_BUDGET = 600;
const spec = worldbankMarketcapSpec;

function find(drafts: readonly ObservationDraft[], period: string, category: string): ObservationDraft {
  const hits = drafts.filter((d) => d.period === period && d.category === category);
  expect(hits).toHaveLength(1);
  return hits[0] as ObservationDraft;
}

function has(drafts: readonly ObservationDraft[], period: string, category: string): boolean {
  return drafts.some((d) => d.period === period && d.category === category);
}

function jsonBytes(json: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(json));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 合成テストデータの組み立て (実データではない)
// ---------------------------------------------------------------------------

interface SynEntity {
  id: string;
  iso3: string;
  name: string;
  aggregate: boolean;
}

/** 合成テストデータ: 固定リストの 22 区分 + リスト外の個別国 (FR) + リスト外の集計 (XD)。 */
const SYN_ENTITIES: SynEntity[] = [
  ...WORLDBANK_MARKETCAP_ENTITIES.map((e) => ({
    id: e.entityId,
    iso3: `S${e.entityId}`.slice(0, 3),
    name: e.worldBankName,
    aggregate: e.isAggregate,
  })),
  { id: "FR", iso3: "FRA", name: "France", aggregate: false },
  { id: "XD", iso3: "", name: "High income", aggregate: true },
];

const SYN_UPDATED = "2031-02-03";
const SYN_WINDOW = { fromYear: 2024, toYear: 2030 };
const SYN_KEY = "worldbank-marketcap-2024-2030-updated-2031-02-03";
/** 合成テストデータの応答に入れる年 (窓の最後の年 2030 は「まだ無い年」として応答に含めない)。 */
const SYN_YEARS = [2024, 2025, 2026, 2027, 2028, 2029];

/** 合成テストデータ: 値 = (区分の番号 + 1) × 1000 + 年。英国 (GB) は 2025 年だけ、2029 年は日本だけ値が無い。 */
function synValue(entityIndex: number, id: string, year: number): number | null {
  if (id === "GB" && year !== 2025) return null;
  if (id === "JP" && year === 2029) return null;
  return (entityIndex + 1) * 1000 + year;
}

interface SynRow {
  id: string;
  name: string;
  iso3: string;
  year: number;
  value: number | null;
}

function synRows(entities: readonly SynEntity[] = SYN_ENTITIES, years: readonly number[] = SYN_YEARS): SynRow[] {
  return entities.flatMap((e, i) =>
    years.map((year) => ({ id: e.id, name: e.name, iso3: e.iso3, year, value: synValue(i, e.id, year) }))
  );
}

/** 合成テストデータ: `/v2/country/all/indicator/CM.MKT.LCAP.CD` 応答の形。 */
function synMarketCap(
  rows: readonly SynRow[],
  opts: { lastupdated?: unknown; sourceid?: unknown; total?: number } = {}
): unknown {
  return [
    {
      page: 1,
      pages: 1,
      per_page: 20000,
      total: opts.total === undefined ? rows.length : opts.total,
      sourceid: opts.sourceid === undefined ? "2" : opts.sourceid,
      lastupdated: opts.lastupdated === undefined ? SYN_UPDATED : opts.lastupdated,
    },
    rows.map((r) => ({
      indicator: { id: "CM.MKT.LCAP.CD", value: "合成テストデータ" },
      country: { id: r.id, value: r.name },
      countryiso3code: r.iso3,
      date: String(r.year),
      value: r.value,
      unit: "",
      obs_status: "",
      decimal: 0,
    })),
  ];
}

/**
 * 合成テストデータ: 集計行の region。実ファイル (2026-09-27 取得) の集計行はすべて
 * `{ id: "NA", iso2code: "NA", value: "Aggregates" }` で、取得元モジュールの最新版は
 * id と value の両方が揃っていることを要求する (片方だけなら throw)。実ファイルと同じ形にする。
 */
const SYN_AGGREGATE_REGION = { id: "NA", iso2code: "NA", value: "Aggregates" };
/** 合成テストデータ: 個別国の region (id は "NA" 以外の地域コード)。 */
const SYN_COUNTRY_REGION = { id: "SYN", iso2code: "SY", value: "合成テスト地域" };

/** 合成テストデータ: `/v2/country/all` 応答の形。 */
function synMeta(entities: readonly SynEntity[] = SYN_ENTITIES): unknown {
  return [
    { page: 1, pages: 1, per_page: "20000", total: entities.length },
    entities.map((e) => ({
      id: e.iso3 === "" ? `A${e.id}` : e.iso3,
      iso2Code: e.id,
      name: e.name,
      region: e.aggregate ? SYN_AGGREGATE_REGION : SYN_COUNTRY_REGION,
    })),
  ];
}

function synFiles(mc: unknown = synMarketCap(synRows()), meta: unknown = synMeta()): SpecFile[] {
  const names = worldbankMarketcapFilenames(SYN_WINDOW);
  return [
    { filename: names.marketCap, bytes: jsonBytes(mc) },
    { filename: names.countryMeta, bytes: jsonBytes(meta) },
  ];
}

// ---------------------------------------------------------------------------
// 1. 指標定義
// ---------------------------------------------------------------------------

describe("worldbankMarketcapSpec.indicators (指標定義)", () => {
  const JA = /[ぁ-んァ-ヶ一-龠]/;

  it("モジュールの 1 指標をそのままのキーで持ち、列挙値のガードをすべて通る", () => {
    expect(spec.name).toBe("worldbank-marketcap");
    expect(spec.indicators.map((i) => i.key)).toEqual([WORLDBANK_MARKETCAP_INDICATOR.key]);
    expect(new Set(spec.indicators.map((i) => i.key)).size).toBe(spec.indicators.length);
    for (const ind of spec.indicators) {
      expect(isMoneyflowFlowType(ind.flowType)).toBe(true);
      expect(isMoneyflowFrequency(ind.frequency)).toBe(true);
      expect(isMoneyflowLicense(ind.license)).toBe(true);
      expect(isMoneyflowRequirement(ind.requirement)).toBe(true);
      expect(ind.flowType).toBe("残高");
      expect(ind.frequency).toBe("年次");
      expect(ind.requirement).toBe("R4");
      expect(ind.license).toBe("attribution-required");
      expect(ind.sourceUrl).toBe("https://data.worldbank.org/indicator/CM.MKT.LCAP.CD");
      expect(ind.displayName).toMatch(JA);
      expect(ind.description).toMatch(JA);
      expect(ind.limitations).toMatch(JA);
    }
  });

  it("説明にストック/フローの区別・単位・符号の意味・期間の付け方を書く", () => {
    const d = spec.indicators[0]?.description as string;
    expect(d).toMatch(/残高 \(ストック\)/);
    expect(d).toMatch(/フロー/);
    expect(d).toMatch(/米ドル/);
    expect(d).toMatch(/符号の付いた値ではない/);
    expect(d).toMatch(/YYYY-12-31/);
    expect(d).toMatch(/円安/);
    // モジュールの正確な定義 (投資信託等の除外) をそのまま引き継ぐ
    expect(d).toContain(WORLDBANK_MARKETCAP_INDICATOR.measures);
  });

  it("限界に固定の区分・欠落・世界計の注意・公表ラグ・前期比なし・出典表示を書く", () => {
    const l = spec.indicators[0]?.limitations as string;
    for (const e of WORLDBANK_MARKETCAP_ENTITIES) expect(l).toContain(e.category);
    expect(l).toMatch(/20か国・地域/);
    expect(l).toMatch(/真の資金フロー/);
    expect(l).toMatch(/WFE/);
    expect(l).toMatch(/台湾/);
    expect(l).toMatch(/公表ラグ/);
    expect(l).toMatch(/前期比は記録しない/);
    // 観測ログは upsert のみで行を消さないため、新しい版で値が取り消された年は古い値が残る
    expect(l).toMatch(/古い版の値が残る/);
    expect(l).toContain(WORLDBANK_MARKETCAP_INDICATOR.attribution);
  });
});

// ---------------------------------------------------------------------------
// 2. 実ファイル → toObservations
// ---------------------------------------------------------------------------

const FIXTURE_DIR = fileURLToPath(new URL("../sources/fixtures/public/worldbank-marketcap/", import.meta.url));
const MC_FIXTURE = `${FIXTURE_DIR}worldbank-marketcap-2020-2026.json`;
const META_FIXTURE = `${FIXTURE_DIR}worldbank-country-meta.json`;
const hasFixtures = existsSync(MC_FIXTURE) && existsSync(META_FIXTURE);
const FIXTURE_WINDOW = { fromYear: 2020, toYear: 2026 };
const FIXTURE_KEY = "worldbank-marketcap-2020-2026-updated-2026-07-13";

function fixtureBytes(path: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(path));
}

/** 実ファイル 2 本を、本番と同じ命名 (worldbank-marketcap-<窓>.json / worldbank-country-meta-<年>.json) で並べる。 */
function fixtureFiles(): SpecFile[] {
  const names = worldbankMarketcapFilenames(FIXTURE_WINDOW);
  return [
    { filename: names.marketCap, bytes: fixtureBytes(MC_FIXTURE) },
    { filename: names.countryMeta, bytes: fixtureBytes(META_FIXTURE) },
  ];
}

describe.skipIf(!hasFixtures)("toObservations (実ファイル: World Bank API 応答 2026-09-27 取得)", () => {
  it("検証を通り、固定 22 区分のうち値のある 127 行 (2020〜2025 年) を作る", () => {
    const drafts = spec.toObservations({ key: FIXTURE_KEY, files: fixtureFiles() });
    expect(() => validateDrafts(spec.name, drafts, spec.indicators)).not.toThrow();
    expect(drafts).toHaveLength(127);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    const years = ["2020", "2021", "2022", "2023", "2024", "2025"];
    expect([...new Set(drafts.map((d) => d.period))]).toEqual(years);
    expect(years.map((y) => drafts.filter((d) => d.period === y).length)).toEqual([21, 22, 22, 21, 20, 21]);
    // 固定リストの 22 区分がすべて少なくとも 1 回は出る (英国は 2021・2022 年のみ)
    expect(new Set(drafts.map((d) => d.category)).size).toBe(WORLDBANK_MARKETCAP_ENTITIES.length);
    // 行の順序は年の古い順 → 固定リストの順。最後の行 (取込完了の印) は 2025 年のマレーシア
    expect(drafts[0]).toMatchObject({ period: "2020", category: "世界計" });
    expect(drafts[drafts.length - 1]).toMatchObject({ period: "2025", category: "マレーシア" });
  });

  it("値は米ドル (倍率なし) のまま、年末基準日・近似・実測・前期比 null で入る (Python で独立に読んだ値と一致)", () => {
    const drafts = spec.toObservations({ key: FIXTURE_KEY, files: fixtureFiles() });
    const jp2023 = find(drafts, "2023", "日本");
    expect(jp2023).toEqual({
      period: "2023",
      periodStart: "2023-12-31",
      periodEnd: "2023-12-31",
      indicatorKey: "worldbank_marketcap",
      category: "日本",
      categoryKind: "国地域",
      value: 6149200180000,
      unit: "米ドル",
      changeFromPrev: null,
      approximate: true,
      measureKind: "実測",
    });
    expect(find(drafts, "2025", "日本").value).toBe(7610543670000);
    expect(find(drafts, "2023", "米国").value).toBe(48979397700000);
    expect(find(drafts, "2023", "ドイツ").value).toBe(2178052520000);
    const world2023 = find(drafts, "2023", "世界計");
    expect(world2023.value).toBe(102946352260000);
    expect(world2023.categoryKind).toBe("全体");
    expect(find(drafts, "2021", "英国").value).toBe(3799459240000);
    expect(find(drafts, "2025", "インド").value).toBe(10559581760000);
    expect(find(drafts, "2024", "香港").value).toBe(4549720760000);
    // World Bank が null (未公表・欠落) の年は行を作らない (0 で埋めない)
    expect(has(drafts, "2023", "英国")).toBe(false);
    expect(has(drafts, "2024", "メキシコ")).toBe(false);
    // 固定リスト外 (所得階層の集計 High income、リスト外の国 チリ) は行にしない
    expect(drafts.every((d) => WORLDBANK_MARKETCAP_ENTITIES.some((e) => e.category === d.category))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. 対応付けの規則 (合成テストデータ・CI で常に走る)
// ---------------------------------------------------------------------------

describe("toObservations (合成テストデータ)", () => {
  it("固定リストの区分だけを、値のある年について 年→リスト順 で並べる", () => {
    const drafts = spec.toObservations({ key: SYN_KEY, files: synFiles() });
    expect(() => validateDrafts(spec.name, drafts, spec.indicators)).not.toThrow();
    // 22 区分 × 6 年 - 英国の値なし 5 年 - 日本の値なし 1 年
    expect(drafts).toHaveLength(22 * 6 - 5 - 1);
    // リスト外の FR (番号 22) / XD (番号 23) の合成値 ((番号+1)×1000+年 = 25024 以上) は 1 行も入らない
    // (リスト内の最大は英国 (番号 21) の 22000+2029 = 24029)
    expect(SYN_ENTITIES.findIndex((e) => e.id === "FR")).toBe(WORLDBANK_MARKETCAP_ENTITIES.length);
    expect(Math.max(...drafts.map((d) => d.value))).toBeLessThan((WORLDBANK_MARKETCAP_ENTITIES.length + 1) * 1000 + 2024);
    expect([...new Set(drafts.map((d) => d.period))]).toEqual(["2024", "2025", "2026", "2027", "2028", "2029"]);
    const firstYear = drafts.filter((d) => d.period === "2024").map((d) => d.category);
    expect(firstYear).toEqual(WORLDBANK_MARKETCAP_ENTITIES.filter((e) => e.entityId !== "GB").map((e) => e.category));
    expect(drafts.filter((d) => d.category === "英国").map((d) => d.period)).toEqual(["2025"]);
    expect(has(drafts, "2029", "日本")).toBe(false);

    // 値: 合成テストデータの (区分の番号 + 1) × 1000 + 年 がそのまま (倍率なしの米ドル) 入る
    const jpIndex = WORLDBANK_MARKETCAP_ENTITIES.findIndex((e) => e.entityId === "JP");
    expect(find(drafts, "2026", "日本")).toEqual({
      period: "2026",
      periodStart: "2026-12-31",
      periodEnd: "2026-12-31",
      indicatorKey: "worldbank_marketcap",
      category: "日本",
      categoryKind: "国地域",
      value: (jpIndex + 1) * 1000 + 2026,
      unit: "米ドル",
      changeFromPrev: null,
      approximate: true,
      measureKind: "実測",
    });
    expect(find(drafts, "2024", "世界計")).toMatchObject({ categoryKind: "全体", value: 1000 + 2024 });
    expect(drafts[drafts.length - 1]).toMatchObject({ period: "2029", category: "マレーシア" });
  });

  it("同じ入力からは同じ行を同じ順で作る (純関数)", () => {
    const a = spec.toObservations({ key: SYN_KEY, files: synFiles() });
    const b = spec.toObservations({ key: SYN_KEY, files: [...synFiles()].reverse() });
    expect(b).toEqual(a);
  });
});

// ---------------------------------------------------------------------------
// 4. resolve() / fetch()
// ---------------------------------------------------------------------------

function stubFetchByUrl(served: ReadonlyMap<string, Uint8Array<ArrayBuffer>>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const bytes = served.get(url);
    if (bytes === undefined) throw new Error(`想定外の URL への問い合わせ: ${url}`);
    return new Response(bytes, { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("resolve() / fetch() (合成テストデータを返す fetch スタブ)", () => {
  it("時価総額応答の lastupdated からキーを決め、fetch() は国メタデータだけを追加で取る", async () => {
    const window = { fromYear: 2024, toYear: 2030 };
    const mcBytes = jsonBytes(synMarketCap(synRows()));
    const metaBytes = jsonBytes(synMeta());
    const fetchMock = stubFetchByUrl(
      new Map([
        [buildMarketCapUrl(window), mcBytes],
        [buildCountryMetaUrl(), metaBytes],
      ])
    );
    const resolved = await spec.resolve(new Date("2030-03-01T00:00:00Z"));
    expect(resolved.key).toBe(SYN_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const batch = await resolved.fetch();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batch.key).toBe(SYN_KEY);
    expect(batch.files.map((f) => f.filename)).toEqual([
      "worldbank-marketcap-2024-2030.json",
      "worldbank-country-meta-2030.json",
    ]);
    expect(batch.files.every((f) => f.contentType === "application/json")).toBe(true);
    expect(batch.metadata).toMatchObject({ wdiLastUpdated: SYN_UPDATED, fromYear: 2024, toYear: 2030 });
    const drafts = spec.toObservations({ key: batch.key, files: batch.files });
    expect(() => validateDrafts(spec.name, drafts, spec.indicators)).not.toThrow();
  });

  it("lastupdated が無い応答では resolve() が throw する (版の分からないキーを作らない)", async () => {
    stubFetchByUrl(
      new Map([[buildMarketCapUrl({ fromYear: 2024, toYear: 2030 }), jsonBytes(synMarketCap(synRows(), { lastupdated: null }))]])
    );
    await expect(spec.resolve(new Date("2030-03-01T00:00:00Z"))).rejects.toThrow(/lastupdated/);
  });
});

describe.skipIf(!hasFixtures)("resolve() / fetch() (実ファイルを返す fetch スタブ)", () => {
  it("実応答のバイト列をそのまま保管し、同じキーで toObservations できる", async () => {
    const mcBytes = fixtureBytes(MC_FIXTURE);
    const metaBytes = fixtureBytes(META_FIXTURE);
    // 実ファイルの国メタデータは per_page=400 で取得したもの (本番の per_page=20000 と
    // 行は同一で、meta.per_page の値だけが違う)。ここでは本番の URL に対して返す。
    const fetchMock = stubFetchByUrl(
      new Map([
        [buildMarketCapUrl(FIXTURE_WINDOW), mcBytes],
        [buildCountryMetaUrl(), metaBytes],
      ])
    );
    const resolved = await spec.resolve(new Date("2026-09-27T09:00:00Z"));
    expect(resolved.key).toBe(FIXTURE_KEY);
    expect(resolved.key).toBe(worldbankMarketcapBatchKey(FIXTURE_WINDOW, "2026-07-13"));
    const batch = await resolved.fetch();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batch.key).toBe(FIXTURE_KEY);
    expect(batch.files.map((f) => f.filename)).toEqual([
      "worldbank-marketcap-2020-2026.json",
      "worldbank-country-meta-2026.json",
    ]);
    expect(Buffer.from(batch.files[0]?.bytes as Uint8Array).equals(Buffer.from(mcBytes))).toBe(true);
    expect(Buffer.from(batch.files[1]?.bytes as Uint8Array).equals(Buffer.from(metaBytes))).toBe(true);
    expect(batch.metadata).toMatchObject({
      wdiLastUpdated: "2026-07-13",
      fromYear: 2020,
      toYear: 2026,
      marketCapBytes: 398531,
      countryMetaBytes: 113590,
    });
    const drafts = spec.toObservations({ key: batch.key, files: batch.files });
    expect(() => validateDrafts(spec.name, drafts, spec.indicators)).not.toThrow();
    expect(drafts).toHaveLength(127);
    expect(find(drafts, "2025", "日本").value).toBe(7610543670000);
  });
});

describe.skipIf(!hasFixtures)("合成テストデータの形が実ファイルと揃っている", () => {
  it("集計行・個別国の region は実ファイルと同じ判定規則 (集計 = id \"NA\" かつ value \"Aggregates\") を満たす", () => {
    const real = JSON.parse(readFileSync(META_FIXTURE, "utf-8")) as [
      unknown,
      { iso2Code: string; region: { id: string; iso2code: string; value: string } }[],
    ];
    const world = real[1].find((r) => r.iso2Code === "1W");
    const japan = real[1].find((r) => r.iso2Code === "JP");
    expect(world?.region).toEqual(SYN_AGGREGATE_REGION);
    expect(japan?.region.id).not.toBe("NA");
    expect(japan?.region.value).not.toBe("Aggregates");
    for (const r of real[1]) {
      expect(r.region.id === "NA").toBe(r.region.value === "Aggregates");
    }
    expect(SYN_COUNTRY_REGION.id).not.toBe("NA");
  });
});

// ---------------------------------------------------------------------------
// 5. 想定外の入力は throw する
// ---------------------------------------------------------------------------

describe("想定外の入力 (合成テストデータ)", () => {
  it("ファイルが欠けている・名前が違う", () => {
    const [mc, meta] = synFiles();
    expect(() => spec.toObservations({ key: SYN_KEY, files: [meta as SpecFile] })).toThrow(/時価総額: 該当ファイルが 0 件/);
    expect(() => spec.toObservations({ key: SYN_KEY, files: [mc as SpecFile] })).toThrow(/国・地域メタデータ: 該当ファイルが 0 件/);
    expect(() =>
      spec.toObservations({ key: SYN_KEY, files: [{ ...(mc as SpecFile), filename: "worldbank-marketcap-2023-2029.json" }, meta as SpecFile] })
    ).toThrow(/該当ファイルが 0 件/);
  });

  it("キーの形式違い・キーとファイルの版 (lastupdated) の食い違い", () => {
    expect(() => spec.toObservations({ key: "worldbank-marketcap-2024-2030", files: synFiles() })).toThrow(/キーの形式/);
    expect(() => spec.toObservations({ key: "worldbank-marketcap-2030-2024-updated-2031-02-03", files: synFiles() })).toThrow(
      /不正な年の窓/
    );
    expect(() =>
      spec.toObservations({ key: "worldbank-marketcap-2024-2030-updated-2031-02-04", files: synFiles() })
    ).toThrow(/lastupdated 2031-02-03 が一致しません/);
    expect(() => spec.toObservations({ key: SYN_KEY, files: synFiles(synMarketCap(synRows(), { sourceid: "57" })) })).toThrow(
      /sourceid/
    );
  });

  it("固定リストの国の名称・集計区分が変わった / 応答から消えた", () => {
    const renamed = SYN_ENTITIES.map((e) => (e.id === "JP" ? { ...e, name: "Japan (renamed)" } : e));
    expect(() => spec.toObservations({ key: SYN_KEY, files: synFiles(synMarketCap(synRows(renamed)), synMeta(renamed)) })).toThrow(
      /JP の名称\/集計区分が想定と違います/
    );
    const nowAggregate = SYN_ENTITIES.map((e) => (e.id === "US" ? { ...e, aggregate: true } : e));
    expect(() => spec.toObservations({ key: SYN_KEY, files: synFiles(undefined, synMeta(nowAggregate)) })).toThrow(
      /US の名称\/集計区分が想定と違います/
    );
    const withoutDe = SYN_ENTITIES.filter((e) => e.id !== "DE");
    expect(() => spec.toObservations({ key: SYN_KEY, files: synFiles(synMarketCap(synRows(withoutDe)), synMeta(withoutDe)) })).toThrow(
      /固定リストの DE \(Germany\) が応答にありません/
    );
  });

  it("メタデータに無いコード・窓の外の年・途中で切れた応答・壊れた JSON", () => {
    const unknown = [...synRows(), { id: "ZZ", name: "合成テストの未知コード", iso3: "ZZZ", year: 2025, value: 1 }];
    expect(() => spec.toObservations({ key: SYN_KEY, files: synFiles(synMarketCap(unknown)) })).toThrow(
      /ZZ .*国\/地域メタデータが見つかりません/
    );
    const outside = synRows(SYN_ENTITIES, [2023, ...SYN_YEARS]);
    expect(() => spec.toObservations({ key: SYN_KEY, files: synFiles(synMarketCap(outside)) })).toThrow(/窓 2024〜2030 の外の年/);
    const rows = synRows();
    expect(() =>
      spec.toObservations({ key: SYN_KEY, files: synFiles(synMarketCap(rows, { total: rows.length + 1 })) })
    ).toThrow(/件数 total=.* と行数 .* が一致しません/);
    const [, meta] = synFiles();
    const broken: SpecFile = { filename: "worldbank-marketcap-2024-2030.json", bytes: new TextEncoder().encode("[{") };
    expect(() => spec.toObservations({ key: SYN_KEY, files: [broken, meta as SpecFile] })).toThrow(/JSON として読めません/);
  });

  it("固定リストの国・地域に値が 1 件も無いバッチは成功扱いにしない", () => {
    const allNull = synRows().map((r) => (WORLDBANK_MARKETCAP_ENTITIES.some((e) => e.entityId === r.id) ? { ...r, value: null } : r));
    expect(() => spec.toObservations({ key: SYN_KEY, files: synFiles(synMarketCap(allNull)) })).toThrow(/値のある行が 1 件もありません/);
  });
});
