import { describe, expect, it } from "vitest";
import { buildPublicBenefitFacts } from "../../data-scripts/public-facts.js";
import { parsePublicBenefitFacts } from "../public-facts.js";
import { groupBenefits, renderBenefitFacts } from "../../app.js";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ROOT } from "../../../../src/shared/db/tests/source-scan.js";
import type { BenefitRow as SourceRow } from "../../data-scripts/summary-tasks.js";

// 試験専用の合成文。実制度・実出力の根拠には使わない。
const build = (text: string) => buildPublicBenefitFacts({
  code: "7203", description: text, context: { minShares: [100], recordMonths: [3] },
  fetchedAt: "2026-10-13T15:00:00.000Z", batchFetchedAt: "2026-10-13T15:01:00.000Z",
});

describe("公開優待条件DTO", () => {
  const officialPath = join(ROOT, "tmp/feature-audit-20261013/official/toyota-yutai.html");
  const sourcePath = join(ROOT, "tmp/feature-audit-20261013/yutai-public-facts-source-rows.json");

  it.skipIf(!existsSync(officialPath) || !existsSync(sourcePath))("保管済7203公式の5年・代替選択を既存掲載群で失わず、未照合や合計額を創作しない", () => {
    // 原本とD1本文はGit管理外の実取得物だけを使い、CIで合成の実データを作らない。
    const bytes = readFileSync(officialPath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("867cb515b747d43e2629e333b898abddb7a2bf17e3b526b652a9c63258ff0c71");
    const receipt = JSON.parse(readFileSync(`${officialPath}.receipt.json`, "utf8")) as { readback: boolean; sha256: string };
    expect(receipt).toMatchObject({ readback: true, sha256: createHash("sha256").update(bytes).digest("hex") });
    const official = bytes.toString("utf8").normalize("NFKC").replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
      .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    expect(official).toMatch(/2026年3月末日/);
    expect(official).toMatch(/1,000株以上[\s\S]*?5年以上[\s\S]*?30,000円分/);
    expect(official).toMatch(/TOYOTA Wallet残高30,000円に代え[\s\S]*?いずれか1つを選択/);
    const rows = (JSON.parse(readFileSync(sourcePath, "utf8")) as { rows: SourceRow[] }).rows;
    const companyRows = rows.filter(row => row.stockCode === "7203");
    expect(companyRows).toHaveLength(3);
    const alternative = companyRows.find(row => row.minShares === 1000);
    expect(alternative).toBeDefined();
    if (alternative === undefined) throw new Error("7203の代替選択群がありません");
    const facts = buildPublicBenefitFacts({ code: alternative.stockCode, description: alternative.description,
      context: { minShares: [alternative.minShares], recordMonths: [alternative.recordMonth] }, fetchedAt: null, batchFetchedAt: null });
    expect(facts.holdingPeriods).toContain("5年以上");
    expect(facts).toMatchObject({ choice: true, combination: "unverified", qualifiedAmount: null, valueStatus: "unresolved" });
    expect(facts.source.officialStatus).toBe("not_verified");
  });

  it("保有期間・選択・抽選・応募を原文の事実として保ち、未確認を不要/併用可へ変えない", () => {
    const facts = build("5年以上継続保有、架空ギフト券3000円分または商品を選択し応募。抽選あり。");
    expect(facts).toMatchObject({ holding: true, holdingPeriods: ["5年以上"], choice: true, lottery: true, application: true,
      combination: "unverified", valueStatus: "unresolved", qualifiedAmount: null });
    expect(facts.source).toMatchObject({ officialStatus: "not_verified", officialUrl: null, verifiedAt: null });
    const html = renderBenefitFacts(facts, null);
    expect(html).toContain("5年以上");
    expect(html).toContain("選択肢を合算しない");
    expect(html).toContain("会社の公式情報との照合は未実施");
    expect(html).not.toContain("架空ギフト券");
    expect(JSON.stringify(facts)).not.toContain("description");
  });

  it("併用の明記だけを採り、相反する記載は未確認に戻す", () => {
    expect(build("架空ギフト券3000円分、併用可").combination).toBe("allowed");
    expect(build("架空ギフト券3000円分、併用不可").combination).toBe("not_allowed");
    expect(build("券は併用可、別券は併用不可").combination).toBe("unverified");
    expect(build("併用可能ではありません").combination).toBe("unverified");
    expect(build("併用可能 ではありません").combination).toBe("unverified");
    expect(build("併用可否は未確認").combination).toBe("unverified");
    expect(build("架空食品").valueReasons).toEqual(["no_source_yen_amount"]);
  });

  it("掲載額・受信時計を持ち、JSONを厳密に再読できる", () => {
    const facts = build("架空QUOカード3000円分");
    expect(facts).toMatchObject({ qualifiedAmount: 3000, valueStatus: "source_amount_qualified" });
    expect(parsePublicBenefitFacts(JSON.stringify(facts), "7203")).toEqual(facts);
    expect(parsePublicBenefitFacts(null)).toBeNull();
    expect(() => parsePublicBenefitFacts(facts, "6758")).toThrow(/銘柄/);
  });

  it("原文や未知項目・不正時計・公式未確認の偽URLが混じるDTOは配信前に停止する", () => {
    const facts = build("架空食品");
    for (const invalid of [
      { ...facts, description: "漏洩させない原文" },
      { ...facts, holdingPeriods: ["条件を推測して埋めた値"] },
      { ...facts, source: { ...facts.source, fetchedAt: "2026-02-30T00:00:00.000Z" } },
      { ...facts, source: { ...facts.source, officialUrl: "https://example.com/" } },
      { ...facts, source: { ...facts.source, officialStatus: "verified", officialUrl: facts.source.listingUrl, verifiedAt: "2026-10-13T15:00:00.000Z" } },
      { ...facts, valueStatus: "source_amount_qualified", qualifiedAmount: null },
      { ...facts, holding: false, holdingPeriods: ["5年以上"] },
    ]) expect(() => parsePublicBenefitFacts(invalid)).toThrow();
  });

  it("companyスタンプだけの値やDTOと異なる額を公開の金額へ採用しない", () => {
    const base = { genre: { name: "金券", slug: "voucher" }, minShares: 100, recordMonth: 3, recordDate: null,
      summary: "架空QUOカード3000円分", estimatedValue: 3000, estimateValueSource: "company" };
    expect(groupBenefits([{ ...base, facts: null }])[0].tiers[0].products[0].estimatedValue).toBeNull();
    expect(groupBenefits([{ ...base, estimatedValue: 9000, facts: build("架空QUOカード3000円分") }])[0].tiers[0].products[0].estimatedValue).toBeNull();
  });

  it("掲載表記の存在を全員の申込必須や特典の同時受取可へ読み替えない", () => {
    const facts = build("希望者が申込、割引券は併用可。期間1年以上");
    const html = renderBenefitFacts(facts, null);
    expect(html).toContain("記載あり（必要性・対象は掲載元で確認）");
    expect(html).toContain("併用可の記載あり（対象未確認）");
    expect(html).toContain("券の利用時の併用と、複数の優待を同時に受け取ることは異なります");
    expect(html).toContain("掲載の期間表記 1年以上（保有条件・株数との対応は掲載元で確認）");
    expect(html).toContain("期間・保有の記載");
    expect(html).toContain("預金などの利用期間と、株を持ち続ける期間は異なります");
    expect(html).not.toContain("継続保有");
    expect(html).not.toContain("/ 申込・応募: 必要");
    expect(html).not.toContain("複数の優待を同時に受け取れるかという条件です");
  });

  it.skipIf(!existsSync(sourcePath))("保存実原本の希望者申込・券の利用併用・期間表記も対象を捏造せず表示する", () => {
    const bytes = readFileSync(sourcePath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("02463516456db0f942021b56ebc22a57706281b68ce048fc67456fc7aeeca625");
    const rows = (JSON.parse(bytes.toString()) as { rows: SourceRow[] }).rows;
    expect(rows).toHaveLength(7716);
    const groups = [...new Map(rows.map(row => [`${row.stockCode}\0${row.description}`, row])).values()];
    const optionalApplications = groups.filter(row => /(?:希望|希望者|希望する株主)[\s\S]{0,40}(?:申[し込込み]+|応募)/.test(row.description));
    const useCombination = groups.filter(row => /(?:割引|クーポン|優待券|買物券|食事券)[\s\S]{0,45}併用/.test(row.description));
    const periodCandidates = groups.filter(row => !/保有|株主名簿|株主番号/.test(row.description) && /(?:[0-9]+|半)(?:年|か月|ヶ月|カ月|ヵ月)(?:以上|未満|以下|超)/.test(row.description.normalize("NFKC")));
    expect(optionalApplications.length).toBeGreaterThan(0);
    expect(useCombination.length).toBeGreaterThan(0);
    expect(periodCandidates.length).toBeGreaterThan(0);
    for (const row of [...optionalApplications, ...useCombination, ...periodCandidates]) {
      const facts = buildPublicBenefitFacts({ code: row.stockCode, description: row.description,
        context: { minShares: [row.minShares], recordMonths: [row.recordMonth] }, fetchedAt: null, batchFetchedAt: null });
      const html = renderBenefitFacts(facts, null);
      if (facts.application) expect(html).toContain("記載あり（必要性・対象は掲載元で確認）");
      if (facts.combination !== "unverified") expect(html).toContain("対象未確認");
      if (facts.holdingPeriods.length > 0) expect(html).toContain("掲載の期間表記");
      expect(html).toContain("期間・保有の記載");
      expect(html).not.toContain("継続保有");
      expect(html).not.toContain("/ 申込・応募: 必要");
      expect(html).not.toContain(row.description);
      expect(facts.source.officialStatus).toBe("not_verified");
    }
  });
});
