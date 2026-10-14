import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFilingDurationContexts } from "../services/edinet/duration-context.js";
import {
  parseOverseasHtml, validateOverseasSaveSet, type OverseasCapture,
} from "../services/overseas-parser.js";

const stems = {
  S100YCK1: "jpcrp030000-asr-001_E00015-000_2026-03-31_01_2026-06-17",
  S100YCV6: "jpcrp030000-asr-001_E02998-000_2026-03-31_01_2026-06-17",
  S100YG3E: "jpcrp030000-asr-001_E00147-000_2026-03-31_01_2026-06-22",
};
const sections = { S100YCK1: "0105010", S100YCV6: "0105010", S100YG3E: "0105110" };
const fixture = (docId: keyof typeof stems, ext: string) => readFileSync(
  fileURLToPath(new URL(`./fixtures/geographic-other-${docId}.${ext}`, import.meta.url)), "utf8",
);
const contexts = (docId: keyof typeof stems) => readFilingDurationContexts(
  new Map([[`XBRL/PublicDoc/${stems[docId]}.xbrl`, Buffer.from(fixture(docId, "xml"))]]),
  `XBRL/PublicDoc/${sections[docId]}_honbun_${stems[docId]}_ixbrl.htm`, "2026-03-31",
);
const parsed = (html: string, definitions = contexts("S100YCV6"), pe = "2026-03-31") => {
  const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
  const result = parseOverseasHtml(html, pe, { durationContexts: definitions, capture });
  return { result, capture };
};

describe("実地域売上表のOther直接証明", () => {
  it.each([
    ["S100YCK1", "その他", 21448, 302689, 1105890],
    ["S100YCV6", "その他の地域", 358, 86561, 219720],
  ] as const)("%s: 当期連結/分類注記/一意値行/印刷総額を照合する", (docId, other, amount, overseas, total) => {
    const { result, capture } = parsed(fixture(docId, "html"), contexts(docId));
    expect(result.status).toBe("ok_geo_cols");
    expect(result.facts.find((f) => f.regionName === other)).toMatchObject({
      regionKind: "overseas", salesAmount: amount,
    });
    expect(result.facts.find((f) => f.regionKind === "overseas_total")?.salesAmount).toBe(overseas);
    expect(result.facts.find((f) => f.regionKind === "total")?.salesAmount).toBe(total);
    const japan = result.facts.find((f) => f.regionKind === "domestic")!.salesAmount!;
    expect(overseas).not.toBe(total - japan); // 実原表の端数差を埋めない。
    expect(result.facts.every((f) => f.isConsolidated === true && f.fiscalYearEnd === "2026-03-31")).toBe(true);
    expect(capture.candidates.filter((c) => c.selected)).toHaveLength(1);
    expect(result.proof?.otherGeography?.contextPeriod).toMatchObject({
      startDate: "2025-04-01", endDate: "2026-03-31",
    });
    validateOverseasSaveSet(result.facts, result.proof);
    const { otherGeography: _removed, ...unproven } = result.proof!;
    expect(() => validateOverseasSaveSet(result.facts, unproven)).toThrow("地理未立証");
  });

  it("実1860は当期連結/地理軸があっても分類注記なしでHOLDする", () => {
    const { result } = parsed(fixture("S100YG3E", "html"), contexts("S100YG3E"));
    expect(result.status).toBe("geo_present_unstructured");
    expect(result.facts).toHaveLength(0);
  });

  it("native duration欠測/異なるFYを印刷captionだけで補わない", () => {
    const html = fixture("S100YCV6", "html");
    expect(parsed(html, new Map()).result.facts).toHaveLength(0);
    expect(parsed(html, contexts("S100YCV6"), "2025-03-31").result.facts).toHaveLength(0);
  });

  it("注記欠測、別TextBlockへの移動、個別、複数Japan、総額欠測をHOLDする", () => {
    // 明示した負例変換。原fixture/本番出力として保存しない。
    const html = fixture("S100YCV6", "html");
    const note = "売上高は顧客の所在地を基礎として、国又は地域に分類しております。";
    const removed = html.replace(note, "");
    expect(removed).not.toBe(html);
    const variants = [
      removed,
      removed + note,
      html.replaceAll("当連結会計年度", "当事業年度"),
      html.replace(">アジア<", ">日本<"),
      html.replace(">219,720<", ">―<"),
    ];
    for (const variant of variants) {
      expect(variant).not.toBe(html);
      expect(parsed(variant).result.facts).toHaveLength(0);
    }
  });

  it("同一原表は一組へ収束し、scoreが違ってもOther適格原表の矛盾はHOLDする", () => {
    const html = fixture("S100YCV6", "html");
    const same = parsed(html + html);
    expect(same.result.status).toBe("ok_geo_cols");
    expect(same.result.facts.find((f) => f.regionKind === "overseas_total")?.salesAmount).toBe(86561);
    // 実セルの明示負例変換。外国leaf合計/公表総額を変えず、内訳を矛盾させる。
    const conflict = html.replace(">20,006<", ">20,005<").replace(">358<", ">359<")
      .replace("地域ごとの情報", "地域別の内訳");
    expect(conflict).not.toBe(html);
    const stopped = parsed(html + conflict);
    expect(stopped.result.facts).toHaveLength(0);
    expect(stopped.capture.stopReason).toBe("other-geography-conflict");
  });
});
