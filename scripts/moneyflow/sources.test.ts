/**
 * 取得元レジストリ (sources.ts) の整合性テスト。17 取得元・25 spec を 1 つの
 * 取込 CLI に載せるため、名前や指標キーの衝突を CI で検出する。
 */
import { describe, expect, it } from "vitest";
import {
  isMoneyflowFlowType,
  isMoneyflowFrequency,
  isMoneyflowLicense,
  isMoneyflowRequirement,
} from "../../src/shared/notion-archive/index.js";
import { SPEC_SOURCES } from "./sources.js";
import { PHASE1_SOURCES, SOURCES, indicatorsForSources } from "./ingest.js";

describe("SPEC_SOURCES", () => {
  it("spec 名が一意で、Phase 1 の取得元名とも衝突しない", () => {
    const names = SPEC_SOURCES.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const p of PHASE1_SOURCES) expect(names).not.toContain(p);
    expect(SOURCES).toHaveLength(PHASE1_SOURCES.length + SPEC_SOURCES.length);
  });

  it("spec 名は英小文字・数字・ハイフンのみ (--only= で指定するため)", () => {
    for (const s of SPEC_SOURCES) expect(s.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("全取得元を同時に選んでも指標キーが別定義で衝突しない", () => {
    const all = indicatorsForSources(SOURCES);
    const keys = all.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("全指標定義が Notion の選択肢に収まり、出典は https、説明・限界は空でない", () => {
    for (const ind of indicatorsForSources(SOURCES)) {
      const where = ind.key;
      expect(isMoneyflowFlowType(ind.flowType), where).toBe(true);
      expect(isMoneyflowFrequency(ind.frequency), where).toBe(true);
      expect(isMoneyflowLicense(ind.license), where).toBe(true);
      expect(isMoneyflowRequirement(ind.requirement), where).toBe(true);
      expect(ind.sourceUrl, where).toMatch(/^https:\/\//);
      expect(ind.description.trim().length, where).toBeGreaterThan(0);
      expect(ind.limitations.trim().length, where).toBeGreaterThan(0);
      expect(ind.displayName.trim().length, where).toBeGreaterThan(0);
    }
  });

  it("各 spec は指標を 1 件以上持ち、spec 内の指標キーが一意", () => {
    for (const s of SPEC_SOURCES) {
      expect(s.indicators.length, s.name).toBeGreaterThan(0);
      const keys = s.indicators.map((i) => i.key);
      expect(new Set(keys).size, s.name).toBe(keys.length);
    }
  });
});
