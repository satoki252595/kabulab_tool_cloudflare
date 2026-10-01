import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFilingDurationContexts } from "../services/edinet/duration-context.js";
import {
  parseOverseasHtml,
  validateOverseasSaveSet,
  type OverseasCapture
} from "../services/overseas-parser.js";

const fxDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const xml = readFileSync(join(fxDir, "duration-context-S100YJVF.xml"), "utf8");
const html = readFileSync(
  join(fxDir, "context-geography-S100YJVF.html"),
  "utf8"
);
const stem = "jpcrp030000-asr-001_E37709-000_2026-03-31_01_2026-06-24";
const honbun = `XBRL/PublicDoc/0105010_honbun_${stem}_ixbrl.htm`;
const instance = `XBRL/PublicDoc/${stem}.xbrl`;
const header = `XBRL/PublicDoc/0000000_header_${stem}_ixbrl.htm`;
const pe = "2026-03-31";
const currentRef = "CurrentYearDuration";
const priorRef = "Prior1YearDuration";
// Structural header projection uses the actual context/namespace attributes,
// rather than manufacturing entity, dates or financial values.
const headerXml = xml
  .replace("<xbrli:xbrl", "<html")
  .replace("</xbrli:xbrl>", "</html>");
const currentXml = [
  ...xml.matchAll(/<xbrli:context\b[\s\S]*?<\/xbrli:context>/g)
].find((m) => m[0].includes(`id="${currentRef}"`))![0];
const blocks = [
  ...html.matchAll(/<ix:nonNumeric\b[^>]*>[\s\S]*?<\/ix:nonNumeric>/g)
].map((m) => m[0]).filter((b) => /name="jpcrp_cor:(?:NotesRevenueRecognitionConsolidatedFinancialStatementsTextBlock|RevenuesFromExternalCustomersInformationForEachRegionTextBlock)"/.test(b));

function contexts(
  instanceXml: string | null = xml,
  headerSource: string | null = headerXml
) {
  const entries = new Map<string, Buffer>();
  if (instanceXml !== null) entries.set(instance, Buffer.from(instanceXml));
  if (headerSource !== null) entries.set(header, Buffer.from(headerSource));
  return readFilingDurationContexts(entries, honbun, pe);
}

function parsed(source = html, definitions = contexts()) {
  const capture: OverseasCapture = {
    status: null,
    stopReason: null,
    candidates: []
  };
  const result = parseOverseasHtml(source, pe, {
    capture,
    durationContexts: definitions
  });
  return { result, capture };
}

describe("実 S100YJVF の referenced duration context", () => {
  it("unique actual entity/periodを解決し、片側sourceだけも受理する", () => {
    const expected = {
      contextRef: currentRef,
      entity: "E37709-000",
      startDate: "2025-04-01",
      endDate: pe
    };
    expect(contexts().get(currentRef)).toEqual(expected);
    expect(contexts(xml, null).get(currentRef)).toEqual(expected);
    expect(contexts(null, headerXml).get(currentRef)).toEqual(expected);
    expect(contexts().get(priorRef)?.endDate).toBe("2025-03-31");
  });

  it("FY captionの無い前期/当期表も既存地理未分類guardへ進み、収益分解の当期表を採用する", () => {
    const { result, capture } = parsed();
    expect(result.status).toBe("ok_geo_rows");
    expect(result.facts).toHaveLength(4);
    expect(
      result.facts.every(
        (f) => f.isConsolidated === true && f.fiscalYearEnd === pe
      )
    ).toBe(true);
    expect(
      result.facts.find((f) => f.regionKind === "domestic")?.salesAmount
    ).toBe(305043);
    expect(
      result.facts.find((f) => f.regionKind === "overseas_total")?.salesAmount
    ).toBe(211508);
    validateOverseasSaveSet(result.facts, result.proof);
    const rejected = capture.incomplete!.filter((c) => c.contextPeriod);
    expect(rejected).toHaveLength(2);
    expect(rejected.map((c) => c.contextPeriod?.endDate)).toEqual([
      "2025-03-31",
      pe
    ]);
    expect(rejected.every((c) => c.labels.includes("その他"))).toBe(true);
  });

  it("HTML-only断片のscope/期を推測せず、prior-only証明でもcurrent unknownを停止する", () => {
    const capture: OverseasCapture = {
      status: null,
      stopReason: null,
      candidates: []
    };
    expect(parseOverseasHtml(html, pe, { capture }).status).toBe(
      "geo_present_unstructured"
    );
    expect(capture.stopReason).toBe("single-row-fiscal-unknown");
    const onlyPrior = new Map([[priorRef, contexts().get(priorRef)!]]);
    expect(parsed(html, onlyPrior).capture.stopReason).toBe(
      "single-row-fiscal-unknown"
    );
    const currentOnly = parsed(blocks[2]);
    expect(currentOnly.result.status).toBe("geo_present_unstructured");
    expect(currentOnly.result.facts).toHaveLength(0); // dimensions0 does not prove scope or geography.
  });

  it.each([
    [
      "period conflict",
      headerXml.replace(
        "2026-03-31</xbrli:endDate>",
        "2026-03-30</xbrli:endDate>"
      )
    ],
    [
      "issuer mismatch",
      headerXml.replaceAll(
        "E37709-000</xbrli:identifier>",
        "E00766-000</xbrli:identifier>"
      )
    ],
    [
      "invalid calendar day",
      headerXml.replace(
        "2026-03-31</xbrli:endDate>",
        "2026-02-31</xbrli:endDate>"
      )
    ],
    [
      "instant",
      headerXml.replace(
        "<xbrli:startDate>2025-04-01</xbrli:startDate>",
        "<xbrli:instant>2026-03-31</xbrli:instant>"
      )
    ],
    [
      "start after end",
      headerXml.replace(
        "2025-04-01</xbrli:startDate>",
        "2026-04-01</xbrli:startDate>"
      )
    ],
    [
      "XML year zero",
      headerXml.replace(
        "2025-04-01</xbrli:startDate>",
        "0000-04-01</xbrli:startDate>"
      )
    ],
    [
      "dimension",
      headerXml.replaceAll(
        "E37709-000</xbrli:identifier>",
        'E37709-000</xbrli:identifier><xbrli:segment><xbrldi:explicitMember dimension="x:Axis">x:Member</xbrldi:explicitMember></xbrli:segment>'
      )
    ],
    ["equal duplicate", headerXml.replace("</html>", `${currentXml}</html>`)],
    [
      "self-closing duplicate",
      headerXml.replace("</html>", `<xbrli:context id="${currentRef}"/></html>`)
    ],
    ["missing ID in present header", headerXml.replace(currentXml, "")],
    [
      "namespace mismatch",
      headerXml.replace(
        "http://www.xbrl.org/2003/instance",
        "http://www.xbrl.org/2008/inlineXBRL"
      )
    ]
  ])(
    "%s は直接参照currentを未証明として停止し、別表のTを都合採用しない",
    (_reason, changed) => {
      const definitions = contexts(xml, changed);
      expect(definitions.get(currentRef)).toBeNull();
      const { result, capture } = parsed(html, definitions);
      expect(result.facts).toHaveLength(0);
      expect(capture.stopReason).toBe("single-row-fiscal-unknown");
    }
  );

  it("unused variantは他IDへ波及せず、ref名も期証明にはしない", () => {
    const unused = currentXml
      .replace(currentRef, "UnusedVariant")
      .replace("<xbrli:period>", '<xbrli:period extra="unsupported">');
    expect(
      contexts(
        xml.replace("</xbrli:xbrl>", `${unused}</xbrli:xbrl>`),
        headerXml
      ).get(currentRef)
    ).not.toBeNull();
    const renamedXml = xml.replaceAll(currentRef, "PriorNamedButActualCurrent");
    const renamedHeader = headerXml.replaceAll(
      currentRef,
      "PriorNamedButActualCurrent"
    );
    const definitions = contexts(renamedXml, renamedHeader);
    const renamedHtml = html.replaceAll(
      currentRef,
      "PriorNamedButActualCurrent"
    );
    expect(parsed(renamedHtml, definitions).result.status).toBe("ok_geo_rows");
    expect(contexts(null, null).size).toBe(0);
  });

  it("本文のfiling/issuerと異なるcontext sourceを借りない", () => {
    const entries = new Map([
      [instance.replace("E37709-000", "E00766-000"), Buffer.from(xml)]
    ]);
    expect(readFilingDurationContexts(entries, honbun, pe).size).toBe(0);
    expect(
      readFilingDurationContexts(
        new Map([[instance, Buffer.from(xml)]]),
        honbun,
        "2025-03-31"
      ).size
    ).toBe(0);
  });

  it("printed期間と実contextの開始/終了/当期区分が矛盾すればSTOP", () => {
    // Explicit negative transformation of the real current block, never a source fixture.
    const startConflict =
      "当連結会計年度（自 2024年４月１日 至 2026年３月31日）" + blocks[2];
    expect(parsed(startConflict).capture.stopReason).toBe(
      "single-row-fiscal-mismatch"
    );
    const sideConflict =
      "前連結会計年度（自 2025年４月１日 至 2026年３月31日）" + blocks[2];
    expect(parsed(sideConflict).capture.stopReason).toBe(
      "single-row-fiscal-mismatch"
    );
    const bareSideConflict = "前連結会計年度" + blocks[2];
    expect(parsed(bareSideConflict).capture.stopReason).toBe("single-row-fiscal-mismatch");
  });

  it("context の実終了が reportPeriodEnd より未来ならSTOP", () => {
    const futureXml = xml.replace(
      "2026-03-31</xbrli:endDate>",
      "2027-03-31</xbrli:endDate>"
    );
    const futureHeader = headerXml.replace(
      "2026-03-31</xbrli:endDate>",
      "2027-03-31</xbrli:endDate>"
    );
    expect(
      parsed(html, contexts(futureXml, futureHeader)).capture.stopReason
    ).toBe("single-row-fiscal-mismatch");
  });
});
