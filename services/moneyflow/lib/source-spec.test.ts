import { describe, expect, it } from "vitest";
import type { IndicatorDefInput } from "../../../src/shared/notion-archive/index.js";
import { monthRange, quarterRange, requireSpecFile, validateDrafts, type ObservationDraft } from "./source-spec.js";

const IND: IndicatorDefInput = {
  key: "k1",
  displayName: "指標1",
  requirement: "R2",
  flowType: "純買い越し",
  description: "説明",
  sourceUrl: "https://example.jp/",
  license: "personal-only",
  frequency: "月次",
  limitations: "限界",
};

const draft = (over: Partial<ObservationDraft> = {}): ObservationDraft => ({
  period: "2026-08",
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31",
  indicatorKey: "k1",
  category: "海外投資家",
  categoryKind: "投資部門",
  value: 1000,
  unit: "円",
  changeFromPrev: null,
  approximate: false,
  measureKind: "実測",
  ...over,
});

describe("validateDrafts", () => {
  it("正常な行は通す", () => {
    expect(() => validateDrafts("s", [draft(), draft({ category: "個人" })], [IND])).not.toThrow();
  });

  it("0 行は異常として throw する (様式変更で何も読めなかった回を成功扱いにしない)", () => {
    expect(() => validateDrafts("s", [], [IND])).toThrow(/0 件/);
  });

  it("冪等キーの重複を throw する (後の行が前の行を黙って上書きするため)", () => {
    expect(() => validateDrafts("s", [draft(), draft({ value: 2 })], [IND])).toThrow(/重複/);
  });

  it("指標定義に無いキー・非有限値・日付逆転・未知の単位をまとめて報告する", () => {
    const bad = [
      draft({ indicatorKey: "nope", category: "a" }),
      draft({ value: Number.NaN, category: "b" }),
      draft({ periodStart: "2026-09-01", category: "c" }),
      draft({ unit: "千円" as never, category: "d" }),
      draft({ periodEnd: "2026/08/31", category: "e" }),
      draft({ changeFromPrev: Number.POSITIVE_INFINITY, category: "f" }),
    ];
    let message = "";
    try {
      validateDrafts("s", bad, [IND]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/6 件/);
    expect(message).toMatch(/指標定義に無い指標キー/);
    expect(message).toMatch(/有限数でない/);
    expect(message).toMatch(/より後/);
    expect(message).toMatch(/未知の単位 千円/);
    expect(message).toMatch(/YYYY-MM-DD でない/);
    expect(message).toMatch(/前期比が有限数でない/);
  });
});

describe("monthRange / quarterRange", () => {
  it("月の初日と末日 (うるう年の2月を含む)", () => {
    expect(monthRange("2026-08")).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(monthRange("2028-02")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
    expect(() => monthRange("2026-13")).toThrow();
    expect(() => monthRange("202608")).toThrow();
  });

  it("暦年四半期の初日と末日", () => {
    expect(quarterRange(2026, 2)).toEqual({ start: "2026-04-01", end: "2026-06-30" });
    expect(quarterRange(2026, 4)).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(() => quarterRange(2026, 5)).toThrow();
  });
});

describe("requireSpecFile", () => {
  const files = [
    { filename: "a.xls", bytes: new Uint8Array([1]) },
    { filename: "b.xls", bytes: new Uint8Array([2]) },
  ];
  it("1 件だけ一致すれば返す", () => {
    expect(requireSpecFile(files, (n) => n === "a.xls", "t").bytes[0]).toBe(1);
  });
  it("0 件・複数件なら throw する (取り違えて解析しない)", () => {
    expect(() => requireSpecFile(files, (n) => n === "c.xls", "t")).toThrow(/0 件/);
    expect(() => requireSpecFile(files, (n) => n.endsWith(".xls"), "t")).toThrow(/2 件/);
  });
});
