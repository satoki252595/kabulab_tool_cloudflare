import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseOverseasData, validateOverseasSaveSet, type OverseasCapture } from "../services/overseas-parser.js";
import { readFilingDateInstant, readFilingDurationContexts } from "../services/edinet/duration-context.js";

interface Fixture { code: string; docId: string; periodEnd: string; members: Record<string, string> }
const fixtures = JSON.parse(gunzipSync(readFileSync(new URL("./fixtures/overseas-source-backed-five.json.gz", import.meta.url))).toString()) as Fixture[];
const actual = (code: string) => fixtures.find((fixture) => fixture.code === code)!;

// Same stored-ZIP test packaging used by overseas-geographic-omission.test.ts.
function zip(members: Record<string, string>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(members)) {
    const path = Buffer.from(name), bytes = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30), entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(path.length, 26);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(path.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, path, bytes); central.push(entry, path);
    offset += header.length + path.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(members).length, 8);
  end.writeUInt16LE(Object.keys(members).length, 10); end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function parse(fixture: Fixture, members = fixture.members) {
  const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
  return { result: parseOverseasData(zip(members), fixture.periodEnd, { capture }), capture };
}
function segmentBody(fixture: Fixture, change: (body: string) => string) {
  return Object.fromEntries(Object.entries(fixture.members).map(([name, text]) => [name,
    name.endsWith(".xbrl") ? text : text.replace(/<ix:nonNumeric\b[^>]*name="jpcrp_cor:NotesSegmentInformationEtcConsolidatedFinancialStatementsTextBlock"[^>]*>[\s\S]*$/, change),
  ]));
}

describe("既本番値の実原典境界", () => {
  it("4290: 実採用external行が同値なら全表のcontract差に引きずられない", () => {
    const { result, capture } = parse(actual("4290"));
    expect(result.status).toBe("ok_geo_cols");
    expect(result.facts.find((fact) => fact.regionKind === "overseas_total")?.salesAmount).toBe(5005700);
    expect(result.facts.find((fact) => fact.regionKind === "total")?.salesAmount).toBe(70911322);
    expect(result.facts.every((fact) => fact.unitLabel === "千円" && fact.isConsolidated === true)).toBe(true);
    expect(capture.candidates.find((candidate) => candidate.selected)?.trace?.valueLabel).toBe("外部顧客への売上高");
    validateOverseasSaveSet(result.facts, result.proof);
  });

  it("4290: 同じ値でも採用行が別contractなら収束させない", () => {
    const fixture = actual("4290");
    // 外部顧客の語は残しscore差を作らず、実採用metricだけを意図的に変える負例。
    const changed = segmentBody(fixture, (body) => body.replaceAll("外部顧客への売上高", "外部顧客への売上高（顧客との契約から生じる収益）"));
    expect(changed).not.toEqual(fixture.members);
    const { result } = parse(fixture, changed);
    expect(result.status).toBe("geo_present_unstructured");
    expect(result.facts).toEqual([]);
  });

  it("4290: external行同士でも外国地域の原値が矛盾すれば停止する", () => {
    const fixture = actual("4290");
    const changed = segmentBody(fixture, (body) => body.replaceAll("3,308,139", "__FOREIGN_CELL__")
      .replaceAll("1,697,561", "3,308,139").replaceAll("__FOREIGN_CELL__", "1,697,561"));
    expect(changed).not.toEqual(fixture.members);
    const { result, capture } = parse(fixture, changed);
    expect(result.status).toBe("geo_present_unstructured");
    expect(result.facts).toEqual([]);
    expect(capture.stopReason).toBe("group-conflict");
  });

  it("6484: selling-priceで評価された生産実績を売上にしない", () => {
    const { result } = parse(actual("6484"));
    expect(result.facts.some((fact) => [28285571, 3378086, 54529, 31718187].includes(fact.salesAmount!))).toBe(false);
  });

  it("6484: 同期連結の内部取引限定原文とexternal行dashを証明して販売額を読む", () => {
    const { result } = parse(actual("6484"));
    expect(result.status).toBe("ok_geo_cols");
    expect(result.facts.find((fact) => fact.regionKind === "overseas_total")?.salesAmount).toBe(486164);
    expect(result.facts.find((fact) => fact.regionKind === "total")?.salesAmount).toBe(30899762);
    expect(result.facts.some((fact) => fact.regionName === "フィリピン")).toBe(false);
    expect(result.proof?.internalOnlyRegions?.[0].quote).toBe("フィリピンにおきましては、グループ間のみの売買取引となります。");
    validateOverseasSaveSet(result.facts, result.proof);
  });

  it("6484: 原文/可視性/期/実native期間が欠けたdashを0扱いしない", () => {
    const fixture = actual("6484"), sentence = "フィリピンにおきましては、グループ間のみの売買取引となります。";
    for (const change of [
      (text: string) => text.replace(sentence, sentence.replace("のみ", "")),
      (text: string) => text.replace(sentence, `<!--${sentence}-->`),
      (text: string) => text.replace(sentence, `<ix:hidden>${sentence}</ix:hidden>`),
      (text: string) => text.replace(sentence, `前連結会計年度 ${sentence}`),
      (text: string) => text.replaceAll("2026-03-31", "2025-03-31"),
      (text: string) => text.replaceAll(/E\d{5}-000/g, "E00000-000"),
      (text: string) => text.replace('name="jpcrp_cor:ManagementAnalysisOfFinancialPositionOperatingResultsAndCashFlowsTextBlock"', 'continuedAt="unresolved" name="jpcrp_cor:ManagementAnalysisOfFinancialPositionOperatingResultsAndCashFlowsTextBlock"'),
    ]) {
      const changed = Object.fromEntries(Object.entries(fixture.members).map(([name, text]) => [name, change(text)]));
      expect(changed).not.toEqual(fixture.members);
      expect(parse(fixture, changed).result.facts).toEqual([]);
    }
    expect(parse(fixture, Object.fromEntries(Object.entries(fixture.members).filter(([name]) => !name.endsWith(".xbrl")))).result.facts).toEqual([]);
  });

  it("6484: 実提出日時点と実current durationを区別して参照原値を保持する", () => {
    const fixture = actual("6484"), entries = new Map(Object.entries(fixture.members).map(([name, text]) => [name, Buffer.from(text)]));
    const honbun = [...entries.keys()].find((name) => name.includes("0102010_honbun"))!;
    const baseline = parse(fixture).result;
    expect(readFilingDurationContexts(entries, honbun, fixture.periodEnd).get("FilingDateInstant")).toBeNull();
    expect(readFilingDateInstant(entries, honbun, fixture.periodEnd)).toEqual({
      contextRef: "FilingDateInstant", entity: "E01434-000", instantDate: "2026-06-23",
    });
    expect(baseline.proof?.internalOnlyRegions?.[0].sourceContext).toEqual(readFilingDateInstant(entries, honbun, fixture.periodEnd));
    const changed = Object.fromEntries(Object.entries(fixture.members).map(([name, text]) => [name,
      text.replace(/(<ix:nonNumeric\b[^>]*ManagementAnalysisOfFinancialPositionOperatingResultsAndCashFlowsTextBlock[^>]*contextRef=")FilingDateInstant"/, '$1CurrentYearDuration"')]));
    expect(changed).not.toEqual(fixture.members);
    const result = parse(fixture, changed).result;
    expect(result.facts).toEqual(baseline.facts);
    expect(result.proof?.internalOnlyRegions?.[0].sourceContext).toEqual(readFilingDurationContexts(entries, honbun, fixture.periodEnd).get("CurrentYearDuration"));
    validateOverseasSaveSet(result.facts, result.proof);
  });

  it("6484: 明示別期/未知参照と提出日時点の欠測・不一致・重複をcurrentへ置換しない", () => {
    const fixture = actual("6484"), instanceName = Object.keys(fixture.members).find((name) => name.endsWith(".xbrl"))!;
    const instance = fixture.members[instanceName];
    const instant = /<xbrli:context id="FilingDateInstant">[\s\S]*?<\/xbrli:context>/.exec(instance)![0];
    const ref = (text: string, value: string) => text.replace(
      /(<ix:nonNumeric\b[^>]*ManagementAnalysisOfFinancialPositionOperatingResultsAndCashFlowsTextBlock[^>]*contextRef=")FilingDateInstant"/, `$1${value}"`);
    for (const change of [
      (members: Record<string, string>) => Object.fromEntries(Object.entries(members).map(([name, text]) => [name, ref(text, "Prior1YearDuration")])),
      (members: Record<string, string>) => Object.fromEntries(Object.entries(members).map(([name, text]) => [name, ref(text, "UnknownContext")])),
      ...[
        "", instant + instant,
        instant.replace("2026-06-23", "2026-06-22"),
        instant.replace("2026-06-23", "2026-02-31"),
        instant.replace("E01434-000", "E02040-000"),
        instant.replace('<xbrli:context id=', '<xbrli:context xmlns:xbrli="http://www.xbrl.org/2008/inlineXBRL" id='),
        instant.replace("<xbrli:period>", '<xbrli:period extra="unsupported">'),
      ].map((replacement) => (members: Record<string, string>) => ({ ...members, [instanceName]: instance.replace(instant, replacement) })),
      (members: Record<string, string>) => ({ ...members,
        [instanceName.replace(/([^/]+)\.xbrl$/, "0000000_header_$1_ixbrl.htm")]: instance
          .replace("<xbrli:xbrl", "<html").replace("</xbrli:xbrl>", "</html>")
          .replace(instant, instant.replace("2026-06-23", "2026-06-22")),
      }),
      (members: Record<string, string>) => Object.fromEntries(Object.entries(members)
        .map(([name, text]) => [name.replace("2026-06-23", "2026-06-24"), text])),
    ]) {
      const changed = change(fixture.members);
      expect(changed).not.toEqual(fixture.members);
      expect(parse(fixture, changed).result.facts).toEqual([]);
    }
  });

  it("6484: 内部限定原文とexternal正数/0/非dash欠測が矛盾すれば停止する", () => {
    const fixture = actual("6484");
    for (const replacement of ["1", "0", "非開示"]) {
      const changed = segmentBody(fixture, (body) => body.replace(/<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*<\/tr>/g,
        (row) => row.includes("外部顧客への売上高") ? row.replace("－", replacement) : row));
      expect(changed).not.toEqual(fixture.members);
      expect(parse(fixture, changed).result.facts).toEqual([]);
    }
  });

  it("7085: 国内の財サービス子行を国内親行に重ねず、実当期列だけ読む", () => {
    const { result } = parse(actual("7085"));
    expect(result.status).toBe("ok_geo_rows");
    expect(result.facts.filter((fact) => fact.regionKind === "domestic").map((fact) => fact.salesAmount)).toEqual([36993]);
    expect(result.facts.find((fact) => fact.regionKind === "overseas_total")?.salesAmount).toBe(572);
    expect(result.facts.find((fact) => fact.regionKind === "total")?.salesAmount).toBe(37566);
    expect(result.facts.every((fact) => fact.isConsolidated === true && fact.fiscalYearEnd === "2025-08-31")).toBe(true);
    validateOverseasSaveSet(result.facts, result.proof);
  });

  it("7085: 子額矛盾やnative期間欠測を親額で隠さない", () => {
    const fixture = actual("7085");
    const changed = Object.fromEntries(Object.entries(fixture.members).map(([name, text]) =>
      [name, name.endsWith(".xbrl") ? text : text.replaceAll("35,963", "34,963")]));
    expect(changed).not.toEqual(fixture.members);
    expect(parse(fixture, changed).result.facts).toEqual([]);
    const missing = Object.fromEntries(Object.entries(fixture.members).filter(([name]) => !name.endsWith(".xbrl")));
    expect(parse(fixture, missing).result.facts).toEqual([]);
  });

  it("6345: 主たる地域市場のOther行とbusiness Other列を分離する", () => {
    const { result } = parse(actual("6345"));
    expect(result.status).toBe("ok_geo_rows");
    expect(result.facts.find((fact) => fact.regionName === "その他")?.salesAmount).toBe(2339838);
    expect(result.facts.find((fact) => fact.regionKind === "overseas_total")?.salesAmount).toBe(5371832);
    expect(result.facts.find((fact) => fact.regionKind === "total")?.salesAmount).toBe(59613734);
    expect(result.proof?.reconciliationAdjustment).toBe(52871);
    expect(result.proof?.otherGeography?.axis).toBe("primary_geographic_markets_rows");
    validateOverseasSaveSet(result.facts, result.proof);
  });

  it("6345: 地域軸名/native期間なしにOtherを外国へ補わない", () => {
    const fixture = actual("6345");
    const noAxis = Object.fromEntries(Object.entries(fixture.members).map(([name, text]) => [name,
      name.endsWith(".xbrl") ? text : text.replaceAll("主たる地域市場", "主なサービス区分")]));
    expect(noAxis).not.toEqual(fixture.members);
    expect(parse(fixture, noAxis).result.facts).toEqual([]);
    const missing = Object.fromEntries(Object.entries(fixture.members).filter(([name]) => !name.endsWith(".xbrl")));
    expect(parse(fixture, missing).result.facts).toEqual([]);
  });

  it("1379: 全地域行と全事業列の印刷小計が閉じる実行列だけOtherを資格化する", () => {
    const { result, capture } = parse(actual("1379"));
    expect(result.status).toBe("ok_geo_rows");
    expect(result.facts.find((fact) => fact.regionName === "その他")?.salesAmount).toBe(33);
    expect(result.facts.find((fact) => fact.regionKind === "overseas_total")?.salesAmount).toBe(8524);
    expect(result.facts.find((fact) => fact.regionKind === "total")?.salesAmount).toBe(85915);
    expect(result.proof?.otherGeography?.axis).toBe("closed_geographic_rows_business_columns");
    expect(capture.candidates.find((candidate) => candidate.selected)?.trace?.geographicAxis).toBe("closed_geographic_rows_business_columns");
    validateOverseasSaveSet(result.facts, result.proof);
  });

  it("1379: 地域/事業軸・subtotal・external・native期が崩れたOtherを採用しない", () => {
    const fixture = actual("1379");
    for (const change of [
      (text: string) => text.replaceAll("報告セグメント", "売上分類"),
      (text: string) => text.replaceAll("北米", "製品分類"),
      (text: string) => text.replaceAll("北米", "その他"),
      (text: string) => text.replaceAll("加工品事業", "その他事業"),
      (text: string) => text.replaceAll("4,436", "3,436"),
      (text: string) => text.replaceAll("外部顧客への売上高", "内部売上高"),
      (text: string) => text.replace(/<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*<\/tr>/g,
        (row) => row.includes("その他の収益") ? row.replace("－", "1") : row),
    ]) {
      const changed = Object.fromEntries(Object.entries(fixture.members).map(([name, text]) => [name, change(text)]));
      expect(changed).not.toEqual(fixture.members);
      expect(parse(fixture, changed).result.facts).toEqual([]);
    }
    expect(parse(fixture, Object.fromEntries(Object.entries(fixture.members).filter(([name]) => !name.endsWith(".xbrl")))).result.facts).toEqual([]);
  });

  it("6877: 明示別basisの連結表が共存しても旧顧客所在地の地域注記を消さない", () => {
    const { result, capture } = parse(actual("6877"));
    expect(result.status).toBe("ok_geo_cols");
    expect(result.facts.find((fact) => fact.regionKind === "overseas_total")?.salesAmount).toBe(41576);
    expect(result.facts.find((fact) => fact.regionKind === "total")?.salesAmount).toBe(61682);
    expect(result.facts.find((fact) => fact.regionName === "その他")?.salesAmount).toBe(2428);
    expect(capture.candidates.find((candidate) => candidate.selected)?.textBlock).toBe("RevenuesFromExternalCustomersInformationForEachRegionTextBlock");
    validateOverseasSaveSet(result.facts, result.proof);
  });

  it("6877: 同basis/不明/不可視の別額Other表はscore差で選ばない", () => {
    const fixture = actual("6877"), phrase = "当社グループ各社の所在地";
    for (const replacement of ["顧客の所在地", "所在地", `<!--${phrase}-->`, `<ix:hidden>${phrase}</ix:hidden>`, `<![CDATA[${phrase}]]>`]) {
      const changed = Object.fromEntries(Object.entries(fixture.members).map(([name, text]) => [name, text.replaceAll(phrase, replacement)]));
      expect(changed).not.toEqual(fixture.members);
      const { result, capture } = parse(fixture, changed);
      expect(result.facts).toEqual([]);
      expect(capture.stopReason).toBe("other-geography-conflict");
    }
  });

  it("6484/6877: inline CSS/hidden属性の原文を証拠にしない", () => {
    for (const [code, phrase] of [
      ["6484", "フィリピンにおきましては、グループ間のみの売買取引となります。"],
      ["6877", "当社グループ各社の所在地"],
    ]) {
      const fixture = actual(code);
      for (const attribute of [
        'style="display:none"', "hidden", 'style="visibility:hidden"',
        'hidden="false"', "style=display:none", 'style="DISPLAY : none !important"',
        'style="display&#58;none"',
      ]) {
        const changed = Object.fromEntries(Object.entries(fixture.members).map(([name, text]) =>
          [name, text.replaceAll(phrase, `<span ${attribute}>${phrase}</span>`)]));
        expect(changed).not.toEqual(fixture.members);
        expect(parse(fixture, changed).result.facts).toEqual([]);
      }
    }
  });

  it("6484/6877: 証拠window外から始まる非表示親と入れ子を尊重する", () => {
    for (const [code, phrase] of [
      ["6484", "フィリピンにおきましては、グループ間のみの売買取引となります。"],
      ["6877", "当社グループ各社の所在地"],
    ]) {
      const fixture = actual(code);
      for (const attribute of ['style="display:none"', "hidden", 'style="visibility:hidden"']) {
        const parent = Object.fromEntries(Object.entries(fixture.members).map(([name, text]) =>
          [name, text.includes(phrase) ? `<div ${attribute}><div>${text}</div></div>` : text]));
        expect(parse(fixture, parent).result.facts).toEqual([]);
        const nested = Object.fromEntries(Object.entries(fixture.members).map(([name, text]) =>
          [name, text.replaceAll(phrase,
            `<span ${attribute}><span style="display:block"><span>${phrase}</span></span></span>`)]));
        expect(parse(fixture, nested).result.facts).toEqual([]);
      }
    }
  });

  it("6484/6877: 非表示siblingがあっても実可視の原文を保持する", () => {
    for (const [code, phrase] of [
      ["6484", "フィリピンにおきましては、グループ間のみの売買取引となります。"],
      ["6877", "当社グループ各社の所在地"],
    ]) {
      const fixture = actual(code), baseline = parse(fixture).result;
      for (const attribute of ['style="display:none"', "hidden", 'style="visibility:hidden"']) {
        const changed = Object.fromEntries(Object.entries(fixture.members).map(([name, text]) =>
          [name, text.replaceAll(phrase, `<span ${attribute}>${phrase}</span><span>${phrase}</span>`)]));
        const result = parse(fixture, changed).result;
        expect(result.status).toBe(baseline.status);
        expect(result.facts).toEqual(baseline.facts);
        validateOverseasSaveSet(result.facts, result.proof);
      }
    }
  });

  it("1414: 同じ可視guardで非表示の地域省略文も採用しない", () => {
    const original = JSON.parse(gunzipSync(readFileSync(new URL(
      "./fixtures/geographic-omission-five.json.gz", import.meta.url,
    ))).toString()) as Fixture[];
    const fixture = original.find((item) => item.code === "1414")!;
    expect(parse(fixture).result.omission).toBeDefined();
    for (const attribute of ['style="display:none"', "hidden", 'style="visibility:hidden"']) {
      const changed = Object.fromEntries(Object.entries(fixture.members).map(([name, text]) =>
        [name, name.endsWith(".xbrl") ? text : `<div ${attribute}><div>${text}</div></div>`]));
      const result = parse(fixture, changed).result;
      expect(result.omission).toBeUndefined();
      expect(result.facts).toEqual([]);
    }
  });
});
