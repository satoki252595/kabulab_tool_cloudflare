import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFilingDurationContexts } from "../services/edinet/duration-context.js";
import {
  parseOverseasHtml, validateOverseasSaveSet, type OverseasCapture,
} from "../services/overseas-parser.js";

const stem = "jpcrp030000-asr-001_E03462-000_2026-02-28_01_2026-05-20";
const fixture = (ext: string) => readFileSync(fileURLToPath(new URL(
  `./fixtures/geographic-external-row-S100Y4VB.${ext}`, import.meta.url,
)), "utf8");
const contexts = () => readFilingDurationContexts(new Map([
  [`XBRL/PublicDoc/${stem}.xbrl`, Buffer.from(fixture("xml"))],
]), `XBRL/PublicDoc/0105010_honbun_${stem}_ixbrl.htm`, "2026-02-28");
const parse = (html = fixture("html"), definitions = contexts(), pe = "2026-02-28") => {
  const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
  return { result: parseOverseasHtml(html, pe, { durationContexts: definitions, capture }), capture };
};

describe("実3382のexternal営業収益行とOther地域", () => {
  it("当期連結/地理区分注記/唯一external行/同じ印刷総額を照合する", () => {
    const { result, capture } = parse();
    expect(result.status).toBe("ok_geo_cols");
    expect(result.facts.find((f) => f.regionName === "その他の地域")).toMatchObject({
      regionKind: "overseas", salesAmount: 624984,
    });
    expect(result.facts.find((f) => f.regionKind === "overseas_total")?.salesAmount).toBe(8585982);
    expect(result.facts.find((f) => f.regionKind === "total")?.salesAmount).toBe(10430269);
    expect(result.facts.every((f) => f.isConsolidated === true && f.fiscalYearEnd === "2026-02-28")).toBe(true);
    expect(result.proof?.otherGeography?.contextPeriod).toMatchObject({
      startDate: "2025-03-01", endDate: "2026-02-28",
    });
    expect(result.proof?.otherGeography?.classificationNote).toContain("地理的近接度");
    expect(capture.candidates.filter((c) => c.selected)).toHaveLength(1);
    validateOverseasSaveSet(result.facts, result.proof);
    // 印刷foreign leaf合計を守り、公表total−Japanの1百万円差を埋めない。
    expect(8585982).not.toBe(10430269 - 1844286);
  });

  it("native期間欠測/異なるFY/印刷期首の矛盾はHOLDする", () => {
    const html = fixture("html");
    expect(parse(html, new Map()).result.facts).toHaveLength(0);
    expect(parse(html, contexts(), "2025-02-28").result.facts).toHaveLength(0);
    const wrongStart = html.replace("2025年3月1日", "2024年3月1日");
    expect(wrongStart).not.toBe(html);
    expect(parse(wrongStart).result.facts).toHaveLength(0);
  });

  it("地理注記なし/個別/非売上metric/期間見出しなしをHOLDする", () => {
    const html = fixture("html");
    for (const changed of [
      html.replace("地理的近接度", "EXPLICIT_NEGATIVE_NO_CLASSIFICATION"),
      html.replaceAll("当連結会計年度", "当事業年度"),
      html.replaceAll("外部顧客への営業収益", "非流動資産"),
      html.replace(/当連結会計年度（自[^<]+/, "EXPLICIT_NEGATIVE_NO_PERIOD"),
    ]) {
      expect(changed).not.toBe(html);
      expect(parse(changed).result.facts).toHaveLength(0);
    }
  });

  it("計/連結の不一致、総額対leaf不一致、複数JapanをHOLDする", () => {
    const html = fixture("html");
    for (const changed of [
      html.replace("10,430,269", "10,430,270"),
      html.replace("624,984", "724,984"),
      html.replace(">北米<", ">日本<"),
    ]) {
      expect(changed).not.toBe(html);
      expect(parse(changed).result.facts).toHaveLength(0);
    }
  });
  it("external行が複数、または同一期の適格原表が矛盾するとHOLDする", () => {
    const html = fixture("html");
    const row = [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)]
      .find((m) => m[0].includes("外部顧客への営業収益"))![0];
    expect(parse(html.replace(row, row + row)).result.facts).toHaveLength(0);
    const conflict = html.replace("7,960,998", "7,960,997").replace("624,984", "624,985");
    expect(conflict).not.toBe(html);
    const stopped = parse(html + conflict);
    expect(stopped.result.facts).toHaveLength(0);
    expect(stopped.capture.stopReason).toBe("other-geography-conflict");
  });

});
