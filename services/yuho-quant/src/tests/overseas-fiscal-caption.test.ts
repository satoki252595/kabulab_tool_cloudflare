import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFilingDurationContexts } from "../services/edinet/duration-context.js";
import {
  lastRangedFiscalTitle,
  parseOverseasHtml,
  type OverseasCapture,
} from "../services/overseas-parser.js";

const fxDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const cases = [
  {
    doc: "S100Y53G",
    stem: "jpcrp030000-asr-001_E04912-000_2026-02-28_01_2026-05-19",
    pe: "2026-02-28",
    body: "0105010",
  },
  {
    doc: "S100TYYR",
    stem: "jpcrp030000-asr-001_E01569-000_2024-03-31_01_2024-07-01",
    pe: "2024-03-31",
    body: "0105010",
  },
  {
    doc: "S100FHUH",
    stem: "jpcrp030000-asr-001_E02900-000_2018-12-31_01_2019-03-28",
    pe: "2018-12-31",
    body: "0105110",
  },
];

function fixture(c: (typeof cases)[number]) {
  const html = readFileSync(
    join(fxDir, `context-fiscal-caption-${c.doc}.html`),
    "utf8",
  );
  const xml = readFileSync(
    join(fxDir, `duration-fiscal-caption-${c.doc}.xml`),
    "utf8",
  );
  const definitions = readFilingDurationContexts(
    new Map([[`XBRL/PublicDoc/${c.stem}.xbrl`, Buffer.from(xml)]]),
    `XBRL/PublicDoc/${c.body}_honbun_${c.stem}_ixbrl.htm`,
    c.pe,
  );
  const parse = (source = html, contexts = definitions) => {
    const capture: OverseasCapture = {
      status: null,
      stopReason: null,
      candidates: [],
    };
    const result = parseOverseasHtml(source, c.pe, {
      capture,
      durationContexts: contexts,
    });
    return { result, capture };
  };
  return { html, definitions, parse };
}

describe("実表captionの最寄りranged期間と実context", () => {
  for (const c of cases.slice(0, 2)) {
    it(`${c.doc}: range以前の反対期語だけを除外し、既存の地理未分類HOLDを維持する`, () => {
      const { definitions, parse } = fixture(c);
      const { result, capture } = parse();
      expect(result.status).toBe("geo_present_unstructured");
      expect(result.facts).toHaveLength(0);
      expect(capture.stopReason).toBe("unstructured");
      expect(capture.incomplete).toHaveLength(2);
      expect(capture.incomplete!.map((r) => r.contextPeriod)).toEqual([
        definitions.get("Prior1YearDuration"),
        definitions.get("CurrentYearDuration"),
      ]);
      expect(
        capture.incomplete!.every((r) => r.contextPeriod !== undefined),
      ).toBe(true);
    });

    it(`${c.doc}: range後の反対bare語は真矛盾として停止する`, () => {
      const { html, parse } = fixture(c);
      // Explicit negative transformation of actual source, never a source fixture.
      const changed = html.replace(/<table\b/i, "当連結会計年度<table");
      expect(changed).not.toBe(html);
      const { result, capture } = parse(changed);
      expect(result.facts).toHaveLength(0);
      expect(capture.stopReason).toBe("single-row-fiscal-mismatch");
    });

    it.each(["startDate", "endDate"] as const)(
      `${c.doc}: printed rangeと実contextの%s矛盾も停止する`,
      (key) => {
        const { definitions, parse } = fixture(c);
        const prior = definitions.get("Prior1YearDuration")!;
        const nextDay = new Date(`${prior[key]}T00:00:00Z`);
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        // Negative mutation of the resolved proof, not a claimed source definition.
        const changed = new Map(definitions).set("Prior1YearDuration", {
          ...prior,
          [key]: nextDay.toISOString().slice(0, 10),
        });
        const { result, capture } = parse(undefined, changed);
        expect(result.facts).toHaveLength(0);
        expect(capture.stopReason).toBe("single-row-fiscal-mismatch");
      },
    );
  }

  it("S100FHUH: rangeなしの当/前混在を実current contextだけで解消しない", () => {
    const { html, parse } = fixture(cases[2]);
    const caption = html.replace(/<[^>]+>/g, " ");
    expect(lastRangedFiscalTitle(caption)).toBeNull();
    const { result, capture } = parse();
    expect(result.status).toBe("geo_present_unstructured");
    expect(result.facts).toHaveLength(0);
    expect(capture.stopReason).toBe("single-row-fiscal-mismatch");
  });
});
