/**
 * BIS 所在地ベース国際銀行統計アダプタ (`./bis-banking.ts`) のテスト。
 *
 * - 実ファイル (2026-09-27 に BIS Data Portal SDMX API から取得した CSV。加工なし) は
 *   `../sources/fixtures/public/bis-banking/` にある (BIS は出典明記で再配布可のため public)。
 *   他のアダプタと揃えて `describe.skipIf` で「無ければ skip」にしてある。
 *   期待値は Python の csv モジュールで同じファイルから独立に読み出した値
 *   (与信 2026-Q1 の米国・英国・ドイツ・世界計は検証証跡の verified_values とも一致)。
 * - CI で常に走る部分は、BIS の CSV の列構成を真似た **合成テストデータ** (実データではない。
 *   値は作り物) で対応付けの規則を確かめる。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isMoneyflowCategoryKind,
  isMoneyflowFlowType,
  isMoneyflowFrequency,
  isMoneyflowLicense,
  isMoneyflowMeasureKind,
  isMoneyflowRequirement,
  isMoneyflowUnit,
} from "../../../../src/shared/notion-archive/index.js";
import { validateDrafts, type ObservationDraft, type SpecFile } from "../source-spec.js";
import { parseBisBankingCsv, toMoneyflowObservations } from "../sources/bis-banking.js";
import {
  BIS_BANKING_FILENAMES,
  BIS_BANKING_INDICATOR_DEFS,
  BIS_BANKING_INDICATOR_KEYS,
  BIS_BANKING_SPEC_NAME,
  BIS_BANKING_SPECS,
  BIS_COUNTERPARTY_NAMES,
  BIS_WORLD_TOTAL_CATEGORY,
  bisBankingBatchKey,
  bisBankingSpec,
  bisBankingToObservations,
  previousQuarter,
  usdMillionToUsd,
} from "./bis-banking.js";

const ROW_BUDGET = 600;
const CLAIMS_KEY = BIS_BANKING_INDICATOR_KEYS.claims;
const LIABILITIES_KEY = BIS_BANKING_INDICATOR_KEYS.liabilities;

const FIXTURE_DIR = fileURLToPath(new URL("../sources/fixtures/public/bis-banking/", import.meta.url));
const CLAIMS_PATH = `${FIXTURE_DIR}${BIS_BANKING_FILENAMES.claims}`;
const LIABILITIES_PATH = `${FIXTURE_DIR}${BIS_BANKING_FILENAMES.liabilities}`;
const hasFixtures = existsSync(CLAIMS_PATH) && existsSync(LIABILITIES_PATH);

const encoder = new TextEncoder();

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 合成テストデータの組み立て (実データではない)
// ---------------------------------------------------------------------------

/** BIS SDMX CSV の実際のヘッダ (2026-09-27 取得の実ファイルと同じ 25 列)。 */
const HEADER =
  "FREQ,L_MEASURE,L_POSITION,L_INSTR,L_DENOM,L_CURR_TYPE,L_PARENT_CTY,L_REP_BANK_TYPE,L_REP_CTY," +
  "L_CP_SECTOR,L_CP_COUNTRY,L_POS_TYPE,DECIMALS,UNIT_MEASURE,UNIT_MULT,AVAILABILITY,TITLE_GRP," +
  "TIME_FORMAT,COLLECTION,ORG_VISIBILITY,TIME_PERIOD,OBS_VALUE,OBS_STATUS,OBS_CONF,OBS_PRE_BREAK";

interface SynthRow {
  country: string;
  period: string;
  value: string;
  status?: string;
  repCty?: string;
  unitMult?: string;
}

/** 合成テストデータ: CSV 1 行 (固定次元は取得 key と同じ値)。 */
function synthLine(position: "C" | "L", r: SynthRow): string {
  const repCty = r.repCty ?? "JP";
  const unitMult = r.unitMult ?? "6";
  const status = r.status ?? "A";
  return `Q,S,${position},A,TO1,A,5J,A,${repCty},A,${r.country},N,3,USD,${unitMult},K,,,E,E,${r.period},${r.value},${status},F,`;
}

function synthCsv(position: "C" | "L", rows: SynthRow[]): string {
  return [HEADER, ...rows.map((r) => synthLine(position, r))].join("\n") + "\n";
}

/** 合成テストデータ: 与信 CSV (並びはわざと崩してある。値は作り物)。 */
const SYNTH_CLAIMS_ROWS: SynthRow[] = [
  { country: "US", period: "2025-Q4", value: "400.125" },
  { country: "US", period: "2026-Q1", value: "420.5" },
  { country: "5J", period: "2025-Q4", value: "1000.5" },
  { country: "5J", period: "2026-Q1", value: "1100.25" },
  { country: "1C", period: "2025-Q4", value: "9" },
  { country: "1C", period: "2026-Q1", value: "10" },
  { country: "DD", period: "1990-Q1", value: "5" },
  { country: "DD", period: "1990-Q2", value: "NaN", status: "B" },
  { country: "KY", period: "2025-Q3", value: "111" },
  { country: "KY", period: "2026-Q1", value: "123.456", status: "B" },
  { country: "SG", period: "2025-Q4", value: "50" },
  { country: "SG", period: "2026-Q1", value: "NaN", status: "Q" },
];

/** 合成テストデータ: 負債 CSV (値は作り物)。 */
const SYNTH_LIABILITIES_ROWS: SynthRow[] = [
  { country: "CN", period: "2026-Q1", value: "0.296" },
  { country: "CN", period: "2025-Q4", value: "0.3" },
  { country: "5J", period: "2026-Q1", value: "750.001" },
  { country: "5J", period: "2025-Q4", value: "800" },
  { country: "US", period: "2025-Q3", value: "290" },
  { country: "US", period: "2025-Q4", value: "300" },
];

function specFile(filename: string, text: string): SpecFile {
  return { filename, bytes: encoder.encode(text) };
}

function synthFiles(claimsRows = SYNTH_CLAIMS_ROWS, liabilitiesRows = SYNTH_LIABILITIES_ROWS): SpecFile[] {
  return [
    specFile(BIS_BANKING_FILENAMES.claims, synthCsv("C", claimsRows)),
    specFile(BIS_BANKING_FILENAMES.liabilities, synthCsv("L", liabilitiesRows)),
  ];
}

function find(drafts: readonly ObservationDraft[], period: string, key: string, category: string): ObservationDraft {
  const hits = drafts.filter((d) => d.period === period && d.indicatorKey === key && d.category === category);
  expect(hits).toHaveLength(1);
  return hits[0] as ObservationDraft;
}

// ---------------------------------------------------------------------------
// 指標定義
// ---------------------------------------------------------------------------

describe("指標定義", () => {
  const JA = /[ぁ-んァ-ヶ一-龠]/;

  it("与信・負債の 2 指標で、キーが一意・列挙値がすべて既知", () => {
    expect(BIS_BANKING_INDICATOR_DEFS.map((d) => d.key)).toEqual([CLAIMS_KEY, LIABILITIES_KEY]);
    expect(new Set(BIS_BANKING_INDICATOR_DEFS.map((d) => d.key)).size).toBe(BIS_BANKING_INDICATOR_DEFS.length);
    for (const d of BIS_BANKING_INDICATOR_DEFS) {
      expect(isMoneyflowFlowType(d.flowType)).toBe(true);
      expect(isMoneyflowFrequency(d.frequency)).toBe(true);
      expect(isMoneyflowLicense(d.license)).toBe(true);
      expect(isMoneyflowRequirement(d.requirement)).toBe(true);
      expect(d.flowType).toBe("残高");
      expect(d.frequency).toBe("四半期");
      expect(d.requirement).toBe("R4");
      expect(d.license).toBe("attribution-required");
      expect(d.sourceUrl).toMatch(/^https:\/\/\S+$/);
      expect(d.displayName).toMatch(JA);
      expect(d.description).toMatch(JA);
      expect(d.limitations).toMatch(JA);
      // フロー/ストックの取り違え・単位・符号の説明が入っていること (ルール7 の精神)
      expect(d.description).toContain("残高");
      expect(d.description).toContain("純流入");
      expect(d.description).toContain("米ドル");
      expect(d.description).toContain("符号");
      expect(d.limitations).toContain("直前の四半期");
      expect(d.limitations).toContain("利用条件");
    }
  });

  it("spec の名前・指標一覧・登録用の配列", () => {
    expect(bisBankingSpec.name).toBe(BIS_BANKING_SPEC_NAME);
    expect(bisBankingSpec.name).toMatch(/^bis-banking(-[a-z0-9-]+)?$/);
    expect(bisBankingSpec.indicators).toBe(BIS_BANKING_INDICATOR_DEFS);
    expect(BIS_BANKING_SPECS).toEqual([bisBankingSpec]);
  });

  it("相手国・地域の日本語名が重複せず、世界計と衝突しない", () => {
    const names = [...BIS_COUNTERPARTY_NAMES.values()];
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain(BIS_WORLD_TOTAL_CATEGORY);
    for (const code of BIS_COUNTERPARTY_NAMES.keys()) expect(code).toMatch(/^[A-Z]{2}$/);
    // 擬似コード・消滅した国のコードは載せない (最新 2 四半期に出たら throw させる)
    for (const code of ["5J", "1C", "2T", "2U", "C9", "CS", "DD", "SU", "YU", "AN"]) {
      expect(BIS_COUNTERPARTY_NAMES.has(code)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 純関数の部品 (CI で走る)
// ---------------------------------------------------------------------------

describe("期間・キー・単位の部品", () => {
  it("previousQuarter は年をまたぐ", () => {
    expect(previousQuarter("2026-Q1")).toBe("2025-Q4");
    expect(previousQuarter("2026-Q3")).toBe("2026-Q2");
    expect(() => previousQuarter("2026-Q5")).toThrow(/YYYY-Qn/);
  });

  it("bisBankingBatchKey は bis-banking-YYYY-Qn", () => {
    expect(bisBankingBatchKey("2026-Q1")).toBe("bis-banking-2026-Q1");
    expect(() => bisBankingBatchKey("2026Q1")).toThrow(/YYYY-Qn/);
  });

  it("usdMillionToUsd は百万米ドルを浮動小数の誤差なく米ドルにする", () => {
    expect(usdMillionToUsd(2379304.268, "t")).toBe(2_379_304_268_000);
    expect(usdMillionToUsd(0.296, "t")).toBe(296_000);
    expect(usdMillionToUsd(5.9, "t")).toBe(5_900_000);
    expect(usdMillionToUsd(0, "t")).toBe(0);
  });

  it("usdMillionToUsd は小数第 4 位以下・負の値を throw する", () => {
    expect(() => usdMillionToUsd(1.2345, "t")).toThrow(/小数第 3 位/);
    expect(() => usdMillionToUsd(-1, "t")).toThrow(/0 以上/);
  });
});

describe("toObservations (合成テストデータ・CI で走る)", () => {
  const drafts = bisBankingToObservations({ key: "bis-banking-2026-Q1", files: synthFiles() });

  it("validateDrafts を通り、並びは 直前期→最新期 × 与信→負債 × 世界計→コード順", () => {
    validateDrafts(BIS_BANKING_SPEC_NAME, drafts, BIS_BANKING_INDICATOR_DEFS);
    expect(drafts.map((d) => `${d.period}|${d.indicatorKey}|${d.category}|${d.value}`)).toEqual([
      `2025-Q4|${CLAIMS_KEY}|世界計|1000500000`,
      `2025-Q4|${CLAIMS_KEY}|シンガポール|50000000`,
      `2025-Q4|${CLAIMS_KEY}|米国|400125000`,
      `2025-Q4|${LIABILITIES_KEY}|世界計|800000000`,
      `2025-Q4|${LIABILITIES_KEY}|中国|300000`,
      `2025-Q4|${LIABILITIES_KEY}|米国|300000000`,
      `2026-Q1|${CLAIMS_KEY}|世界計|1100250000`,
      `2026-Q1|${CLAIMS_KEY}|ケイマン諸島|123456000`,
      `2026-Q1|${CLAIMS_KEY}|米国|420500000`,
      `2026-Q1|${LIABILITIES_KEY}|世界計|750001000`,
      `2026-Q1|${LIABILITIES_KEY}|中国|296000`,
    ]);
  });

  it("国際機関 (1C)・欠測 (NaN)・最新 2 期より古い期 (DD 1990・KY 2025-Q3・US 2025-Q3) は行にしない", () => {
    expect(drafts.some((d) => d.category === "1C" || d.category.includes("国際機関"))).toBe(false);
    expect(drafts.some((d) => d.period !== "2025-Q4" && d.period !== "2026-Q1")).toBe(false);
    expect(drafts.filter((d) => d.category === "シンガポール").map((d) => d.period)).toEqual(["2025-Q4"]);
  });

  it("区分種別・単位・期間の基準日・近似/実測・前期比", () => {
    const world = find(drafts, "2026-Q1", CLAIMS_KEY, "世界計");
    expect(world.categoryKind).toBe("全体");
    const us = find(drafts, "2025-Q4", CLAIMS_KEY, "米国");
    expect(us.categoryKind).toBe("国地域");
    expect(us.periodStart).toBe("2025-12-31");
    expect(us.periodEnd).toBe("2025-12-31");
    expect(world.periodStart).toBe("2026-03-31");
    expect(world.periodEnd).toBe("2026-03-31");
    for (const d of drafts) {
      expect(d.unit).toBe("米ドル");
      expect(d.approximate).toBe(true);
      expect(d.measureKind).toBe("実測");
      expect(d.changeFromPrev).toBeNull();
      expect(isMoneyflowUnit(d.unit)).toBe(true);
      expect(isMoneyflowCategoryKind(d.categoryKind)).toBe(true);
      expect(isMoneyflowMeasureKind(d.measureKind)).toBe(true);
    }
  });

  it("系列の断層 (OBS_STATUS=B) の値は記録する", () => {
    expect(find(drafts, "2026-Q1", CLAIMS_KEY, "ケイマン諸島").value).toBe(123_456_000);
  });

  it("最後の行 (取込完了の印) は最新四半期の行", () => {
    const last = drafts[drafts.length - 1] as ObservationDraft;
    expect(last.period).toBe("2026-Q1");
    expect(last.indicatorKey).toBe(LIABILITIES_KEY);
  });

  it("ファイルの並び順に依存しない (純関数・決定的)", () => {
    const reversed = [...synthFiles()].reverse();
    expect(bisBankingToObservations({ key: "bis-banking-2026-Q1", files: reversed })).toEqual(drafts);
  });
});

describe("toObservations の異常系 (CI で走る)", () => {
  const key = "bis-banking-2026-Q1";

  it("ファイルが欠けている・重複している・想定外のファイルがあると throw", () => {
    const [claims, liabilities] = synthFiles() as [SpecFile, SpecFile];
    expect(() => bisBankingToObservations({ key, files: [claims] })).toThrow(/0 件/);
    expect(() => bisBankingToObservations({ key, files: [claims, claims, liabilities] })).toThrow(/2 件/);
    expect(() =>
      bisBankingToObservations({ key, files: [claims, liabilities, specFile("other.csv", "x")] })
    ).toThrow(/想定外のファイル/);
  });

  it("キーの形式違い・キーとファイルの最新四半期の不一致で throw", () => {
    expect(() => bisBankingToObservations({ key: "bis-banking-2026Q1", files: synthFiles() })).toThrow(/冪等キーの形式/);
    expect(() => bisBankingToObservations({ key: "bis-banking-2025-Q4", files: synthFiles() })).toThrow(/一致しません/);
    const liabilitiesBehind = SYNTH_LIABILITIES_ROWS.filter((r) => r.period !== "2026-Q1");
    expect(() =>
      bisBankingToObservations({ key, files: synthFiles(SYNTH_CLAIMS_ROWS, liabilitiesBehind) })
    ).toThrow(/一致しません/);
  });

  it("対応表に無い相手国・地域コード (未知コード・消滅した国) が最新 2 期に出たら throw", () => {
    const unknown = [...SYNTH_CLAIMS_ROWS, { country: "XX", period: "2026-Q1", value: "1" }];
    expect(() => bisBankingToObservations({ key, files: synthFiles(unknown) })).toThrow(/未定義の相手国・地域コードです: XX/);
    const dissolved = [...SYNTH_CLAIMS_ROWS, { country: "SU", period: "2025-Q4", value: "1" }];
    expect(() => bisBankingToObservations({ key, files: synthFiles(dissolved) })).toThrow(/未定義の相手国・地域コードです: SU/);
  });

  it("集計コード (EU/XM/XW) は国として行にしない (国別の行と二重計上になる)", () => {
    const withAggregates = [
      ...SYNTH_CLAIMS_ROWS,
      { country: "EU", period: "2026-Q1", value: "300" },
      { country: "XM", period: "2025-Q4", value: "200" },
      { country: "XW", period: "2026-Q1", value: "1100.25" },
    ];
    const got = bisBankingToObservations({ key, files: synthFiles(withAggregates) });
    expect(got).toEqual(bisBankingToObservations({ key, files: synthFiles() }));
  });

  it("キーの四半期より新しい期の値があれば throw (黙って捨てない)", () => {
    const newer = [...SYNTH_CLAIMS_ROWS, { country: "US", period: "2026-Q2", value: "430" }];
    expect(() => bisBankingToObservations({ key, files: synthFiles(newer) })).toThrow(/より新しい期の値があります.*US 2026-Q2/);
    // 値の無い (NaN) 新しい期は捨てても情報を失わないので通す
    const newerNaN = [...SYNTH_CLAIMS_ROWS, { country: "US", period: "2026-Q2", value: "NaN", status: "Q" }];
    expect(bisBankingToObservations({ key, files: synthFiles(newerNaN) })).toHaveLength(11);
  });

  it("推計値など A/B 以外の OBS_STATUS の値は throw (実測として混ぜない)", () => {
    const estimated = SYNTH_CLAIMS_ROWS.map((r) =>
      r.country === "US" && r.period === "2026-Q1" ? { ...r, status: "E" } : r
    );
    expect(() => bisBankingToObservations({ key, files: synthFiles(estimated) })).toThrow(/OBS_STATUS="E"/);
  });

  it("単位の倍率違い・小数桁の増加・報告国違い・UTF-8 でないバイト列は throw", () => {
    const thousands = SYNTH_CLAIMS_ROWS.map((r) => ({ ...r, unitMult: "3" }));
    expect(() => bisBankingToObservations({ key, files: synthFiles(thousands) })).toThrow(/単位が想定外/);
    const moreDecimals = SYNTH_CLAIMS_ROWS.map((r) =>
      r.country === "US" && r.period === "2026-Q1" ? { ...r, value: "420.5001" } : r
    );
    expect(() => bisBankingToObservations({ key, files: synthFiles(moreDecimals) })).toThrow(/小数第 3 位/);
    const otherReporter = SYNTH_CLAIMS_ROWS.map((r) => (r.country === "US" ? { ...r, repCty: "US" } : r));
    expect(() => bisBankingToObservations({ key, files: synthFiles(otherReporter) })).toThrow(/JP/);
    const [, liabilities] = synthFiles() as [SpecFile, SpecFile];
    const broken: SpecFile = { filename: BIS_BANKING_FILENAMES.claims, bytes: new Uint8Array([0xff, 0xfe, 0x41]) };
    expect(() => bisBankingToObservations({ key, files: [broken, liabilities] })).toThrow(/UTF-8/);
  });
});

// ---------------------------------------------------------------------------
// resolve() / fetch() (fetch スタブ)
// ---------------------------------------------------------------------------

/** URL の SDMX key (…/1.0/Q.S.{C|L}.…?…) から与信/負債を見分けて本文を返す fetch スタブ。 */
function stubBisFetch(claimsText: string, liabilitiesText: string) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const m = /\/WS_LBS_D_PUB\/1\.0\/Q\.S\.([CL])\.A\.TO1\.A\.5J\.A\.JP\.A\.\.N\?/.exec(url);
    if (!m) throw new Error(`想定外の URL: ${url}`);
    return new Response(m[1] === "C" ? claimsText : liabilitiesText, {
      status: 200,
      headers: { "content-type": "text/csv" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("resolve() / fetch() (合成テストデータ・CI で走る)", () => {
  it("resolve は与信 1 リクエストでキーを決め、fetch は負債だけ追加で取る", async () => {
    const claimsText = synthCsv("C", SYNTH_CLAIMS_ROWS);
    const liabilitiesText = synthCsv("L", SYNTH_LIABILITIES_ROWS);
    const fetchMock = stubBisFetch(claimsText, liabilitiesText);
    const resolved = await bisBankingSpec.resolve(new Date("2026-09-27T09:00:00Z"));
    expect(resolved.key).toBe("bis-banking-2026-Q1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("lastNObservations=2");
    const batch = await resolved.fetch();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batch.key).toBe(resolved.key);
    expect(batch.files.map((f) => f.filename)).toEqual([BIS_BANKING_FILENAMES.claims, BIS_BANKING_FILENAMES.liabilities]);
    expect(batch.files.every((f) => f.contentType === "text/csv")).toBe(true);
    expect(new TextDecoder().decode(batch.files[0]?.bytes)).toBe(claimsText);
    expect(new TextDecoder().decode(batch.files[1]?.bytes)).toBe(liabilitiesText);
    expect(batch.metadata).toMatchObject({ latestAvailableQuarter: "2026-Q1", mostRecentEndedQuarter: "2026-Q2" });
    const drafts = bisBankingSpec.toObservations({ key: batch.key, files: batch.files });
    validateDrafts(bisBankingSpec.name, drafts, bisBankingSpec.indicators);
    expect(drafts).toHaveLength(11);
  });

  it("負債の最新四半期が与信と違えば fetch() が throw する", async () => {
    stubBisFetch(
      synthCsv("C", SYNTH_CLAIMS_ROWS),
      synthCsv("L", SYNTH_LIABILITIES_ROWS.filter((r) => r.period !== "2026-Q1"))
    );
    const resolved = await bisBankingSpec.resolve(new Date("2026-09-27T09:00:00Z"));
    await expect(resolved.fetch()).rejects.toThrow(/一致しません/);
  });

  it("BIS が HTTP エラーを返したら resolve() が throw する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("No results for query", { status: 404, statusText: "Not Found" }))
    );
    await expect(bisBankingSpec.resolve(new Date("2026-09-27T09:00:00Z"))).rejects.toThrow(/404/);
  });
});

// ---------------------------------------------------------------------------
// 実ファイル (2026-09-27 取得)
// ---------------------------------------------------------------------------

describe.skipIf(!hasFixtures)("toObservations (実ファイル: BIS SDMX API の CSV 2026-09-27 取得)", () => {
  const claimsBytes = hasFixtures ? readFileSync(CLAIMS_PATH) : Buffer.alloc(0);
  const liabilitiesBytes = hasFixtures ? readFileSync(LIABILITIES_PATH) : Buffer.alloc(0);
  const files: SpecFile[] = [
    { filename: BIS_BANKING_FILENAMES.claims, bytes: new Uint8Array(claimsBytes) },
    { filename: BIS_BANKING_FILENAMES.liabilities, bytes: new Uint8Array(liabilitiesBytes) },
  ];
  const drafts = hasFixtures ? bisBankingToObservations({ key: "bis-banking-2026-Q1", files }) : [];

  it("validateDrafts を通り、行数は 453 (目安 600 以内)、期は 2025-Q4 と 2026-Q1 のみ", () => {
    validateDrafts(BIS_BANKING_SPEC_NAME, drafts, BIS_BANKING_INDICATOR_DEFS);
    expect(drafts.length).toBeLessThanOrEqual(ROW_BUDGET);
    // Python で数えた件数: 与信 2025-Q4 110 / 2026-Q1 111、負債 2025-Q4 117 / 2026-Q1 115 (世界計を含み 1C を除く)
    const count = (period: string, key: string) =>
      drafts.filter((d) => d.period === period && d.indicatorKey === key).length;
    expect(count("2025-Q4", CLAIMS_KEY)).toBe(110);
    expect(count("2026-Q1", CLAIMS_KEY)).toBe(111);
    expect(count("2025-Q4", LIABILITIES_KEY)).toBe(117);
    expect(count("2026-Q1", LIABILITIES_KEY)).toBe(115);
    expect(drafts).toHaveLength(453);
    const last = drafts[drafts.length - 1] as ObservationDraft;
    expect(`${last.period}|${last.indicatorKey}|${last.category}`).toBe(`2026-Q1|${LIABILITIES_KEY}|ザンビア`);
  });

  it("既知値 (百万米ドル → 米ドルの換算を含む。Python csv で独立に読んだ値)", () => {
    // 与信 2026-Q1 米国 2,379,304.268 百万米ドル
    expect(find(drafts, "2026-Q1", CLAIMS_KEY, "米国").value).toBe(2_379_304_268_000);
    // 与信 2026-Q1 世界計 (L_CP_COUNTRY=5J) 5,257,195.619 百万米ドル
    const world = find(drafts, "2026-Q1", CLAIMS_KEY, "世界計");
    expect(world.value).toBe(5_257_195_619_000);
    expect(world.categoryKind).toBe("全体");
    // 与信 2026-Q1 英国 458,048.538 / ドイツ 128,644.097 百万米ドル
    expect(find(drafts, "2026-Q1", CLAIMS_KEY, "英国").value).toBe(458_048_538_000);
    expect(find(drafts, "2026-Q1", CLAIMS_KEY, "ドイツ").value).toBe(128_644_097_000);
    // 与信 2025-Q4 (直前の四半期) ケイマン諸島 738,151.665 百万米ドル
    const ky = find(drafts, "2025-Q4", CLAIMS_KEY, "ケイマン諸島");
    expect(ky.value).toBe(738_151_665_000);
    expect(ky.periodEnd).toBe("2025-12-31");
    // 与信 2026-Q1 ザンビア 3.2 百万米ドル (小さい値の換算)
    expect(find(drafts, "2026-Q1", CLAIMS_KEY, "ザンビア").value).toBe(3_200_000);
    // 負債 2026-Q1 米国 525,905.198 / 英国 473,663.377 / ドイツ 40,403.103 百万米ドル
    expect(find(drafts, "2026-Q1", LIABILITIES_KEY, "米国").value).toBe(525_905_198_000);
    expect(find(drafts, "2026-Q1", LIABILITIES_KEY, "英国").value).toBe(473_663_377_000);
    expect(find(drafts, "2026-Q1", LIABILITIES_KEY, "ドイツ").value).toBe(40_403_103_000);
    // 負債 2026-Q1 世界計 1,673,568.089 / 2025-Q4 中国 32,665.732 / 2026-Q1 ザンビア 0.296 百万米ドル
    expect(find(drafts, "2026-Q1", LIABILITIES_KEY, "世界計").value).toBe(1_673_568_089_000);
    expect(find(drafts, "2025-Q4", LIABILITIES_KEY, "中国").value).toBe(32_665_732_000);
    expect(find(drafts, "2026-Q1", LIABILITIES_KEY, "ザンビア").value).toBe(296_000);
  });

  it("追加の既知値 (レビュー時に Python csv + Decimal で独立に読んだ値。直前期の世界計・最小値を含む)", () => {
    // 直前期 2025-Q4 の世界計: 与信 5,098,591.486 / 負債 1,693,303.019 百万米ドル
    expect(find(drafts, "2025-Q4", CLAIMS_KEY, "世界計").value).toBe(5_098_591_486_000);
    expect(find(drafts, "2025-Q4", LIABILITIES_KEY, "世界計").value).toBe(1_693_303_019_000);
    // 与信 2026-Q1 香港 59,727.158 / 台湾 30,702.487、負債 2026-Q1 香港 125,461.117 / ケイマン諸島 6,410.633
    expect(find(drafts, "2026-Q1", CLAIMS_KEY, "香港").value).toBe(59_727_158_000);
    expect(find(drafts, "2026-Q1", CLAIMS_KEY, "台湾").value).toBe(30_702_487_000);
    expect(find(drafts, "2026-Q1", LIABILITIES_KEY, "香港").value).toBe(125_461_117_000);
    expect(find(drafts, "2026-Q1", LIABILITIES_KEY, "ケイマン諸島").value).toBe(6_410_633_000);
    // 負債 2025-Q4 フランス 169,429.724
    expect(find(drafts, "2025-Q4", LIABILITIES_KEY, "フランス").value).toBe(169_429_724_000);
    // 最小値: 与信 2026-Q1 アルジェリア 0.098 / 負債 2025-Q4 アルメニア 0.096 百万米ドル
    expect(find(drafts, "2026-Q1", CLAIMS_KEY, "アルジェリア").value).toBe(98_000);
    expect(find(drafts, "2025-Q4", LIABILITIES_KEY, "アルメニア").value).toBe(96_000);
  });

  it("国際機関 (1C 与信 2026-Q1 = 14,873.514) と報告が途絶えた国 (東ドイツ・ソ連等) は行にならない", () => {
    expect(drafts.some((d) => d.value === 14_873_514_000)).toBe(false);
    expect(drafts.some((d) => d.period !== "2025-Q4" && d.period !== "2026-Q1")).toBe(false);
    // 与信のアルバニアは 2025-Q4 が最新 (2026-Q1 の報告なし) → 2025-Q4 の行だけ
    expect(drafts.filter((d) => d.indicatorKey === CLAIMS_KEY && d.category === "アルバニア").map((d) => d.period)).toEqual([
      "2025-Q4",
    ]);
  });

  it("国別の行はモジュールの toMoneyflowObservations (同じ除外規則) と一致する", () => {
    const text = (b: Uint8Array) => new TextDecoder().decode(b);
    const moduleRows = [
      ...toMoneyflowObservations(parseBisBankingCsv(text(files[0]!.bytes), "claims")),
      ...toMoneyflowObservations(parseBisBankingCsv(text(files[1]!.bytes), "liabilities")),
    ].filter((o) => o.period === "2025-Q4" || o.period === "2026-Q1");
    const fromModule = moduleRows
      .map((o) => `${o.period}|${o.indicatorKey}|${BIS_COUNTERPARTY_NAMES.get(o.category)}|${Math.round(o.value * 1000) * 1000}`)
      .sort();
    const fromAdapter = drafts
      .filter((d) => d.category !== BIS_WORLD_TOTAL_CATEGORY)
      .map((d) => `${d.period}|${d.indicatorKey}|${d.category}|${d.value}`)
      .sort();
    expect(fromAdapter).toEqual(fromModule);
    expect(fromAdapter).toHaveLength(449);
  });
});

describe.skipIf(!hasFixtures)("resolve() / fetch() (実ファイルを返す fetch スタブ)", () => {
  it("キー bis-banking-2026-Q1 を返し、fetch() は同じキーと実ファイルと同一のバイト列を返す", async () => {
    const claimsBytes = readFileSync(CLAIMS_PATH);
    const liabilitiesBytes = readFileSync(LIABILITIES_PATH);
    const fetchMock = stubBisFetch(claimsBytes.toString("utf-8"), liabilitiesBytes.toString("utf-8"));
    const resolved = await bisBankingSpec.resolve(new Date("2026-09-27T09:00:00Z"));
    expect(resolved.key).toBe("bis-banking-2026-Q1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const batch = await resolved.fetch();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(batch.key).toBe("bis-banking-2026-Q1");
    expect(batch.files.map((f) => f.filename)).toEqual(["bis-lbs-claims-jp.csv", "bis-lbs-liabilities-jp.csv"]);
    // ASCII のみの CSV なので、文字列で受けて UTF-8 に戻したバイト列が原本と一致する (ルール6)
    expect(Buffer.from(batch.files[0]!.bytes).equals(claimsBytes)).toBe(true);
    expect(Buffer.from(batch.files[1]!.bytes).equals(liabilitiesBytes)).toBe(true);
    expect(batch.metadata).toMatchObject({
      latestAvailableQuarter: "2026-Q1",
      mostRecentEndedQuarter: "2026-Q2",
      isCaughtUp: false,
      lastNObservations: 2,
    });
    expect(batch.source).toContain("https://stats.bis.org/api/v2/data/dataflow/BIS/WS_LBS_D_PUB/1.0/");
    const drafts = bisBankingSpec.toObservations({ key: batch.key, files: batch.files });
    validateDrafts(bisBankingSpec.name, drafts, bisBankingSpec.indicators);
    expect(drafts).toHaveLength(453);
  });
});
