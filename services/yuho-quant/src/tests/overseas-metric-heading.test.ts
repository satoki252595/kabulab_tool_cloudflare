import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseOverseasHtml,
  validateOverseasSaveSet,
  type OverseasCapture,
} from "../services/overseas-parser.js";

const fxDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const cases = [
  { doc: "S100GAYK", pe: "2019-03-31", salesEnd: 8081, salesStart: 877 },
  { doc: "S100W2ZR", pe: "2025-03-31", salesEnd: 10127, salesStart: 916 },
];

function parsed(html: string, pe: string) {
  const capture: OverseasCapture = {
    status: null,
    stopReason: null,
    candidates: [],
  };
  const result = parseOverseasHtml(html, pe, { capture });
  return { result, capture };
}

describe("実原文のstyle/単位layoutを挟む売上・資産題名", () => {
  for (const c of cases) {
    const html = readFileSync(
      join(fxDir, `metric-heading-pair-${c.doc}.html`),
      "utf8",
    );

    it(`${c.doc}: 後続資産を直接題名で除外し、元売上集合だけを保持する`, () => {
      const { result, capture } = parsed(html, c.pe);
      const sales = parsed(html.slice(0, c.salesEnd), c.pe);
      expect(result.status).toBe("ok_geo_rows");
      expect(result.facts).toHaveLength(7);
      expect(result.facts).toEqual(sales.result.facts);
      expect(capture.candidates).toHaveLength(1);
      expect(capture.candidates[0].start).toBe(c.salesStart);
      expect(capture.candidates[0].selected).toBe(true);
      expect(capture.stopReason).toBeNull();
      validateOverseasSaveSet(result.facts, result.proof);
    });

    it(`${c.doc}: 資産表だけでは売上候補を生成しない`, () => {
      // Verbatim source suffix, including the asset title and unit layout.
      const { result, capture } = parsed(html.slice(c.salesEnd), c.pe);
      expect(result.status).toBe("no_overseas_table");
      expect(result.facts).toHaveLength(0);
      expect(capture.candidates).toHaveLength(0);
    });

    it(`${c.doc}: 資産題名を失った未知の競合を売上scoreで解消しない`, () => {
      // Explicit negative transformation; no amount/period is changed and this
      // transformed input never claims to be an EDINET source fixture.
      const changed = html.replace(/非流動資産/g, "");
      expect(changed).not.toBe(html);
      const { result, capture } = parsed(changed, c.pe);
      expect(result.status).toBe("geo_present_unstructured");
      expect(result.facts).toHaveLength(0);
      expect(capture.stopReason).toBe("contract-ambiguity");
      expect(capture.candidates.filter((candidate) => candidate.selected)).toHaveLength(0);
    });
  }
});
