/**
 * 共有正準変換 (overseas-save-rows.ts) の検証。
 * 旧 5 箇所 local copy と同一意味であることを固定する。
 * null は素通し (0/factor1 埋めなし)。undefined/欠落・未知 status は
 * throw する (null≠missing。"none" への黙認 fallback なし)。
 */
import { describe, expect, it } from "vitest";
import type { OverseasFact } from "../services/overseas-parser.js";
import {
  overseasPatternOf,
  toOverseasSaveRows,
  toYen,
} from "../services/overseas-save-rows.js";

describe("toYen", () => {
  it("null は null のまま・数値は factor 乗 + round", () => {
    expect(toYen(null, 1000)).toBeNull();
    expect(toYen(2199570, 1000)).toBe(2199570000);
    expect(toYen(1.5, 1)).toBe(2);
    expect(toYen(-1.5, 1000)).toBe(-1500);
    expect(toYen(0, 1000)).toBe(0);
  });

  it("unit 欠落 (undefined/null factor・非数値 raw) は throw (factor1 埋めなし)", () => {
    expect(() => toYen(5, undefined as unknown as number)).toThrow();
    expect(() => toYen(5, null as unknown as number)).toThrow();
    expect(() => toYen(undefined as unknown as null, 1000)).toThrow();
    expect(() => toYen("5" as unknown as number, 1000)).toThrow();
  });
});

describe("overseasPatternOf", () => {
  it("既知 ok_2種は strip・valid 3種は none を保持", () => {
    expect(overseasPatternOf("ok_geo_rows")).toBe("geo_rows");
    expect(overseasPatternOf("ok_geo_cols")).toBe("geo_cols");
    expect(overseasPatternOf("geo_present_unstructured")).toBe("none");
    expect(overseasPatternOf("no_overseas_table")).toBe("none");
    expect(overseasPatternOf("parse_error")).toBe("none");
  });

  it("未知 status は throw (none への黙認なし)", () => {
    expect(() => overseasPatternOf("ok_unknown_future" as never)).toThrow();
    expect(() => overseasPatternOf("no_xbrl" as never)).toThrow();
    expect(() => overseasPatternOf("" as never)).toThrow();
  });
});

describe("toOverseasSaveRows", () => {
  it("9列組立・null 素通し・空配列は空のまま", () => {
    const rows = toOverseasSaveRows(
      [
        {
          fiscalYearEnd: "2016-06-30",
          regionName: "タイ",
          regionKind: "overseas",
          isConsolidated: null,
          unitLabel: "千円",
          salesAmount: 2199570,
          unitYenFactor: 1000,
          ratioPct: null,
        },
      ],
      "ok_geo_rows"
    );
    expect(rows).toEqual([
      {
        fiscalYearEnd: "2016-06-30",
        regionName: "タイ",
        regionKind: "overseas",
        isConsolidated: null,
        unitLabel: "千円",
        salesRaw: 2199570,
        salesYen: 2199570000,
        ratioPct: null,
        pattern: "geo_rows",
      },
    ]);
    expect(toOverseasSaveRows([], "ok_geo_rows")).toEqual([]);
  });

  it("salesAmount null は salesRaw/salesYen ともに null (捏造なし)", () => {
    const rows = toOverseasSaveRows(
      [
        {
          fiscalYearEnd: "2016-06-30",
          regionName: "X",
          regionKind: "overseas",
          isConsolidated: true,
          unitLabel: "千円",
          salesAmount: null,
          unitYenFactor: 1000,
          ratioPct: 26.8,
        },
      ],
      "ok_geo_cols"
    );
    expect(rows[0].salesRaw).toBeNull();
    expect(rows[0].salesYen).toBeNull();
    expect(rows[0].pattern).toBe("geo_cols");
  });

  it("未知 status・unit 欠落 fact は throw を伝播する", () => {
    const fact: OverseasFact = {
      fiscalYearEnd: "2016-06-30",
      regionName: "X",
      regionKind: "overseas",
      isConsolidated: null,
      unitLabel: "千円",
      salesAmount: 1,
      unitYenFactor: 1000,
      ratioPct: null,
    };
    expect(() => toOverseasSaveRows([fact], "ok_unknown_future" as never)).toThrow();
    expect(() =>
      toOverseasSaveRows(
        [{ ...fact, unitYenFactor: undefined as unknown as number }],
        "ok_geo_rows"
      )
    ).toThrow();
  });

  it("facts=[] でも未知 status は throw・valid empty は [] のまま", () => {
    expect(() => toOverseasSaveRows([], "ok_unknown_future" as never)).toThrow();
    expect(() => toOverseasSaveRows([], "no_xbrl" as never)).toThrow();
    expect(toOverseasSaveRows([], "parse_error")).toEqual([]);
    expect(toOverseasSaveRows([], "geo_present_unstructured")).toEqual([]);
    expect(toOverseasSaveRows([], "no_overseas_table")).toEqual([]);
  });
});
