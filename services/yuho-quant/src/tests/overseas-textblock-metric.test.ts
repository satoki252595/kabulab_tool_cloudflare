import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseOverseasHtml,
  validateOverseasSaveSet,
  type OverseasCapture,
} from "../services/overseas-parser.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf8");

describe("実TextBlockの非売上metric", () => {
  it("S100YD7J: 表題が遠い減損損失表を地域別売上候補にしない", () => {
    // Old reducer passed its arithmetic proof with total=54,405 and
    // overseas=52,873. The native enclosing TextBlock identifies impairment.
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const result = parseOverseasHtml(
      fixture("textblock-metric-impairment-S100YD7J.html"), "2026-03-31", { capture },
    );
    expect(result.status).toBe("no_overseas_table");
    expect(result.facts).toHaveLength(0);
    expect(result.tablesScanned).toBe(0);
    expect(capture.candidates).toHaveLength(0);
  });

  it("S100YD7J: 正規地域売上表は引き続き診断し、未分類額を外国へ補わない", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const result = parseOverseasHtml(
      fixture("textblock-metric-sales-S100YD7J.html"), "2026-03-31", { capture },
    );
    expect(result.status).toBe("geo_present_unstructured");
    expect(result.facts).toHaveLength(0);
    expect(result.tablesScanned).toBe(1);
    expect(capture.incomplete).toHaveLength(1);
    expect(capture.incomplete![0]).toMatchObject({
      kind: "rows",
      labels: ["中華人民共和国", "大韓民国", "その他", "外部顧客からの売上収益"],
      amount: 1451082,
    });
  });

  it("S100W2ZR: 実原文の正しい売上表と資産表の対照を保持する", () => {
    const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
    const result = parseOverseasHtml(
      fixture("metric-heading-pair-S100W2ZR.html"), "2025-03-31", { capture },
    );
    expect(result.status).toBe("ok_geo_rows");
    expect(result.facts).toHaveLength(7);
    expect(capture.candidates).toHaveLength(1);
    expect(capture.candidates[0].selected).toBe(true);
    validateOverseasSaveSet(result.facts, result.proof);
  });
});
