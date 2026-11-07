import { describe, expect, it } from "vitest";
import { parseDocidTargets } from "./docid-targets.js";

describe("parseDocidTargets", () => {
  it("日付ごとに束ね、重複を除き、日付昇順にする", () => {
    const m = parseDocidTargets(
      [
        '{"docID":"S100BBBB","submit":"2017-06-30 09:00"}',
        '{"docID":"S100AAAA","submit":"2016-12-22 11:48"}',
        '{"docID":"S100BBBB","submit":"2017-06-30 09:00"}',
        "",
        '{"docID":"S100CCCC","submit":"2017-06-30"}',
      ].join("\n")
    );
    expect([...m.keys()]).toEqual(["2016-12-22", "2017-06-30"]);
    expect([...m.get("2016-12-22")!]).toEqual(["S100AAAA"]);
    expect([...m.get("2017-06-30")!].sort()).toEqual(["S100BBBB", "S100CCCC"]);
  });

  it("不正な行は行番号つきで throw する", () => {
    expect(() => parseDocidTargets('{"docID":"X123","submit":"2017-06-30"}')).toThrow("1 行目");
    expect(() => parseDocidTargets('{"docID":"S100AAAA"}')).toThrow("submit");
    expect(() => parseDocidTargets("not json")).toThrow("JSON");
    expect(() => parseDocidTargets("  \n")).toThrow("0 件");
  });
});
