import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import { headedDescription } from "../../data-scripts/estimated-value-guard.js";
import { extractBenefitRegistryStructure } from "../../data-scripts/registry-structure.js";
import { buildPublicBenefitFacts } from "../../data-scripts/public-facts.js";
import { parsePublicBenefitFacts } from "../public-facts.js";
import { renderBenefitFacts } from "../../app.js";

const privatePath = join(ROOT, "tmp/feature-audit-20261013/yutai-condition-tools-20261017-v1/all-groups.private.json");
const corpusSha = "cf75176596e3515ff264c8541189934388ea374f92dfdd33d3d01f04d2e91f38";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type SavedGroup = { key: string; code: string; rows: number; sourceDescription: string };
// 実掲載文はprivateに保持。公開fixtureは原文SHAと抽出数値構造だけ。
const projections = [
  { key: "eb53f8da4bb1fdf1", sha: "e65eba3218a0675afb134502f50ef6a79bc998474871fe101f394a5d1f98994c", remaining: 1,
    clauses: [{ kind: "holding_definition", holdingPeriod: "半年以上", minimumConsecutiveRecords: 2, recordObject: "unspecified" },
      { kind: "holding_definition", holdingPeriod: "3年以上", minimumConsecutiveRecords: 7, recordObject: "unspecified" }] },
  { key: "f84fbafc45a792c5", sha: "d40a388fce9a3c8c8c4f1f1b51c3519c8e48a2c257e92e5610a49912e0b17b16", remaining: 0,
    clauses: [{ kind: "registry_requirement", identity: "shareholder_number", recordDates: [{ month: 3, day: 31 }, { month: 9, day: 30 }],
      recurrence: "annual", minimumConsecutiveRecords: 5, minimumShares: null, entryMeaning: "recorded" }] },
  { key: "34be639eade271d3", sha: "a2d1ad6f207506d671ee10507784ae64db8759f3fff0e37c8c4adb45e534720a", remaining: 0,
    clauses: [{ kind: "registry_requirement", identity: "shareholder_number", recordDates: [{ month: 7, day: "month_end" }, { month: 1, day: "month_end" }],
      recurrence: "unprovided", minimumConsecutiveRecords: 3, minimumShares: 100, entryMeaning: "listed" }] },
  { key: "3152e2b666c297c4", sha: "089c56d1e8ee901d1b596893651e7ac8baab08a2d1b976ca01dfe80b22f1ca05", remaining: 0,
    clauses: [{ kind: "same_name_holding", identity: "registered_name", recordDates: [{ month: 8, day: "month_end" }], holdingPeriod: "1年以上", recurrence: "annual" }] },
];
function savedGroups(): SavedGroup[] {
  const bytes = readFileSync(privatePath);
  expect(hash(bytes)).toBe(corpusSha);
  return JSON.parse(bytes.toString()) as SavedGroup[];
}

describe("掲載の連続回数・名簿・同一名義の純抽出", () => {
  it("公開v5と画面へ接続し、旧v5を保ち、本人資格や別原文への改変を拒否する", () => {
    // 文法境界専用。実制度・掲載額として保存しない。
    const description = headedDescription("文法試験", "【1年以上保有】\n1,000円相当\n■継続保有期間について\n毎年3月31日および9月30日を基準日とする株主名簿に、同一の株主番号で連続して5回以上記録された株主といたします。");
    const facts = buildPublicBenefitFacts({ code: "1899", description, context: { minShares: [100], recordMonths: [3] }, fetchedAt: null, batchFetchedAt: null });
    if (facts.version !== 5 || facts.conditionStructure.ast.registry === undefined) throw Error("v5 registry required");
    const registry = facts.conditionStructure.ast.registry;
    expect(parsePublicBenefitFacts(JSON.stringify(facts), "1899")).toEqual(facts);
    expect(renderBenefitFacts(facts, null)).toContain("同一株主番号で連続5回以上記録");
    expect(renderBenefitFacts(facts, null)).toContain("同一名義と同一株主番号は別の条件");
    const { registry: omitted, ...oldAst } = facts.conditionStructure.ast; void omitted;
    expect(parsePublicBenefitFacts({ ...facts, conditionStructure: { ...facts.conditionStructure, ast: oldAst } })).not.toBeNull();
    for (const changed of [{ ...registry, sourceSha256: "0".repeat(64) }, { ...registry, applicability: "verified" },
      { ...registry, ast: { ...registry.ast, clauses: [{ kind: "registry_requirement", identity: "shareholder_number", recordDates: [{ month: 3, day: 31 }, { day: 31, month: 3 }], recurrence: "annual", minimumConsecutiveRecords: 5, minimumShares: null, entryMeaning: "recorded" }] } }]) {
      expect(() => parsePublicBenefitFacts({ ...facts, conditionStructure: { ...facts.conditionStructure, ast: { ...facts.conditionStructure.ast, registry: changed } } })).toThrow();
    }
  });
  it("対象の節や完全な句が無い入力を補完しない", () => {
    for (const input of ["", "■継続保有期間について", headedDescription("株主優待", "■継続保有期間について"),
      headedDescription("株主優待", "■継続保有期間について\n未確認")]) expect(extractBenefitRegistryStructure(input)).toBeNull();
  });

  it.skipIf(!existsSync(privatePath))("保存5748群の177群だけを抽出し、名義・番号・未提供項目・未解析行を区別する", () => {
    const groups = savedGroups();
    const before = JSON.stringify(groups);
    const parsed = groups.map(group => ({ group, result: extractBenefitRegistryStructure(group.sourceDescription) })).filter(row => row.result !== null);
    expect(parsed).toHaveLength(177);
    expect(parsed.reduce((sum, row) => sum + row.group.rows, 0)).toBe(201);
    expect(new Set(parsed.map(row => row.group.code)).size).toBe(60);
    expect(parsed.reduce((sum, row) => sum + row.result!.ast.clauses.length, 0)).toBe(353);
    expect(parsed.filter(row => row.result!.ast.remainingSectionLines === 0)).toHaveLength(21);
    for (const expected of projections) {
      const original = groups.find(group => group.key === expected.key)!;
      expect(hash(original.sourceDescription)).toBe(expected.sha);
      const result = extractBenefitRegistryStructure(original.sourceDescription)!;
      expect(result).toMatchObject({ status: "literal_extracted", rule: "holding-registry-clauses-v1", applicability: "unverified",
        sourceSha256: expected.sha, ast: { clauses: expected.clauses, remainingSectionLines: expected.remaining } });
      expect(result.ast.remainingDescriptionLines).toBeGreaterThan(0);
      expect(result).not.toHaveProperty("qualifiedAmount");
      expect(result).not.toHaveProperty("officialStatus");
    }
    expect(JSON.stringify(groups)).toBe(before);
  });

  it.skipIf(!existsSync(privatePath))("実原文の不正日付・数値・主体交換・節外・追加条件を成功へ読み替えない", () => {
    const groups = savedGroups();
    const registry = groups.find(group => group.key === projections[1].key)!.sourceDescription;
    for (const changed of [
      registry.replace("5回以上", "0回以上"), registry.replace("5回以上", "9007199254740992回以上"),
      registry.replace("5回以上", "5年以上"), registry.replace("3月31日", "2月30日"),
      registry.replace("9月30日", "3月31日"), registry.replace("同一の株主番号", "同一名義"),
      registry.replace("■継続保有期間について", "■その他"),
      registry.replace("■継続保有期間について", "■継続保有期間について\n※別の条件あり"),
      registry + "\n■継続保有期間について",
    ]) expect(extractBenefitRegistryStructure(changed)).toBeNull();
    const definitions = groups.find(group => group.key === projections[0].key)!.sourceDescription;
    expect(extractBenefitRegistryStructure(definitions.replace("3年以上継続保有", "半年以上継続保有"))).toBeNull();
    expect(extractBenefitRegistryStructure(definitions.replace("7回以上", "9007199254740992回以上"))).toBeNull();
    const withNote = definitions.replace("■継続保有期間について", "■継続保有期間について\n※別の条件あり");
    const result = extractBenefitRegistryStructure(withNote)!;
    expect(result.ast.clauses).toEqual(projections[0].clauses);
    expect(result.ast.remainingSectionLines).toBe(2);
    expect(result.applicability).toBe("unverified");
  });
});
