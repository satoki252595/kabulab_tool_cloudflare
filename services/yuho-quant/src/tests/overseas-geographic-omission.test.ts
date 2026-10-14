import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseOverseasData, type OverseasCapture, type OverseasFact } from "../services/overseas-parser.js";

interface Fixture {
  code: string;
  docId: string;
  periodEnd: string;
  members: Record<string, string>;
  expectedCurrentEvidence: Array<{
    rawBlockSha256: string;
    visibleText: string;
    nativePeriod: { contextRef: string; entity: string; startDate: string; endDate: string };
  }>;
}
const fixtures = JSON.parse(gunzipSync(readFileSync(new URL(
  "./fixtures/geographic-omission-five.json.gz", import.meta.url,
))).toString()) as Fixture[];
const actual = (code: string) => fixtures.find((fixture) => fixture.code === code)!;
const coexisting = JSON.parse(gunzipSync(readFileSync(new URL(
  "./fixtures/geographic-omission-coexisting-sales.json.gz", import.meta.url,
))).toString()) as Array<Fixture & { expectedStatus: string; expectedFacts: OverseasFact[] }>;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Existing stored-ZIP test packaging; original fragment/XML bytes stay intact. */
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
function parse(fixture: Fixture, members = fixture.members, periodEnd = fixture.periodEnd) {
  const capture: OverseasCapture = { status: null, stopReason: null, candidates: [] };
  return { result: parseOverseasData(zip(members), periodEnd, { capture }), capture };
}
function changeBody(fixture: Fixture, change: (body: string) => string) {
  return Object.fromEntries(Object.entries(fixture.members).map(([name, value]) =>
    [name, name.endsWith(".xbrl") ? value : change(value)]));
}

describe("実原典の地域売上省略理由", () => {
  it.each(coexisting)("$code: 地域注記の省略と別開示の当期連結実数を共存させる", (fixture) => {
    const { result } = parse(fixture);
    expect(result.status).toBe(fixture.expectedStatus);
    expect(result.facts).toEqual(fixture.expectedFacts);
    expect(result.proof).toBeDefined();
    expect(result.omission?.scope).toBe("regional_external_customer_sales_note");
    expect(result.omission?.evidence.length).toBeGreaterThan(0);
    expect(result.omission!.evidence.every((proof) => proof.contextPeriod.endDate === fixture.periodEnd)).toBe(true);
  });
  it.each(["1414", "1435", "155A", "1852"])("%s: 当期連結売上の明示省略だけを証拠化する", (code) => {
    const fixture = actual(code), { result, capture } = parse(fixture);
    expect(result.status).toBe("no_overseas_table");
    expect(result.facts).toEqual([]);
    expect(result.proof).toBeUndefined();
    expect(result.omission?.reason).toBe("domestic_external_sales_over_90_percent");
    expect(result.omission?.scope).toBe("regional_external_customer_sales_note");
    expect(result.omission?.evidence).toHaveLength(fixture.expectedCurrentEvidence.length);
    for (const proof of result.omission!.evidence) {
      const original = fixture.expectedCurrentEvidence.find((item) => item.rawBlockSha256 === proof.rawBlockSha256)!;
      expect(original).toBeDefined();
      expect(proof.quote).toBe(original.visibleText);
      expect(proof.contextPeriod).toEqual(original.nativePeriod);
      expect(proof.memberSha256).toBe(sha(fixture.members[proof.honbunFile]));
    }
    expect(capture.omission).toEqual(result.omission);
    expect(capture.stopReason).toBe(result.omission?.reason);
  });

  it("153A: 実在する単体期間を連結の省略へ昇格しない", () => {
    const fixture = actual("153A"), { result, capture } = parse(fixture);
    expect(Object.values(fixture.members).join("")).toContain("NonConsolidatedMember");
    expect(result.facts).toEqual([]);
    expect(result.omission).toBeUndefined();
    expect(capture.omission).toBeUndefined();
  });

  it("外側不変でも内側nonNumericのcontinuationは不採用にする", () => {
    const fixture = actual("1414");
    const inner = '<ix:nonNumeric name="jpcrp_cor:RevenuesFromExternalCustomersInformationForEachRegionTextBlock" contextRef="CurrentYearDuration">本邦の外部顧客</ix:nonNumeric>';
    const nested = changeBody(fixture, (body) => body.replaceAll("本邦の外部顧客", inner));
    expect(parse(fixture, nested).result.omission).toBeDefined();
    const continued = Object.fromEntries(Object.entries(nested).map(([name, text]) =>
      [name, text.replaceAll(inner, inner.replace("<ix:nonNumeric ", '<ix:nonNumeric continuedAt="unsupported" '))]));
    expect(continued).not.toEqual(nested);
    expect(parse(fixture, continued).result.omission).toBeUndefined();
  });

  it("native期間欠測/issuer矛盾/別FY/前期のみは理由を生成しない", () => {
    const fixture = actual("1414");
    const missing = Object.fromEntries(Object.entries(fixture.members).filter(([name]) => !name.endsWith(".xbrl")));
    const wrongEntity = Object.fromEntries(Object.entries(fixture.members).map(([name, value]) =>
      [name, name.endsWith(".xbrl") ? value.replaceAll("E00329-000", "E00330-000") : value]));
    const priorOnly = changeBody(fixture, (body) => body.replace(/<ix:nonNumeric\b[^>]*contextRef="CurrentYearDuration"[^>]*>[\s\S]*?<\/ix:nonNumeric>/g, ""));
    for (const members of [missing, wrongEntity, priorOnly]) {
      expect(members).not.toEqual(fixture.members);
      expect(parse(fixture, members).result.omission).toBeUndefined();
    }
    expect(parse(fixture, fixture.members, "2025-06-30").result.omission).toBeUndefined();
  });

  it("scope/metric/省略目的の違い、continued/未閉鎖/コメントは証拠にしない", () => {
    const fixture = actual("1414");
    for (const change of [
      (body: string) => body.replaceAll("連結損益計算書", "損益計算書"),
      (body: string) => body.replaceAll("売上高", "有形固定資産"),
      (body: string) => body.replaceAll("90％", "10％"),
      (body: string) => body.replaceAll("記載を省略", "セグメント情報を省略"),
      (body: string) => body.replaceAll("<ix:nonNumeric ", '<ix:nonNumeric continuedAt="unsupported" '),
      (body: string) => body.replaceAll("</ix:nonNumeric>", ""),
      (body: string) => `<!--${body}-->`,
      (body: string) => `<![CDATA[${body}]]>`,
      (body: string) => `<ix:hidden>${body}</ix:hidden>`,
      (body: string) => body.replaceAll("本邦の外部顧客", "<ix:hidden>本邦の外部顧客</ix:hidden>"),
    ]) {
      const members = changeBody(fixture, change);
      expect(members).not.toEqual(fixture.members);
      expect(parse(fixture, members).result.omission).toBeUndefined();
    }
  });

  it("同期間の地域実表との矛盾は既HOLDへ戻し、reasonの使い回しもしない", () => {
    const fixture = actual("1414"), capture: OverseasCapture = {
      status: null, stopReason: null, candidates: [],
    };
    const qualified = parseOverseasData(zip(fixture.members), fixture.periodEnd, { capture });
    expect(capture.omission).toEqual(qualified.omission);
    const numeric = readFileSync(new URL("./fixtures/geographic-external-row-S100Y4VB.html", import.meta.url), "utf8");
    // Deliberate contradiction: wrap a real sales table in a second current regional TB.
    const members = changeBody(fixture, (body) => body +
      '<ix:nonNumeric name="jpcrp_cor:RevenuesFromExternalCustomersInformationForEachRegionTextBlock" contextRef="CurrentYearDuration">' +
      numeric + "</ix:nonNumeric>");
    const stopped = parseOverseasData(zip(members), fixture.periodEnd, { capture });
    expect(stopped.status).toBe("geo_present_unstructured");
    expect(stopped.facts).toEqual([]);
    expect(stopped.omission).toBeUndefined();
    expect(capture.omission).toBeUndefined();
    expect(capture.stopReason).toBe("geographic-omission-conflict");
  });

  it("期末だけ同じ短期contextの表を年次省略の矛盾にしない", () => {
    const fixture = actual("1414");
    const numeric = readFileSync(new URL("./fixtures/geographic-external-row-S100Y4VB.html", import.meta.url), "utf8");
    const members = changeBody(fixture, (body) => body +
      '<ix:nonNumeric name="jpcrp_cor:RevenuesFromExternalCustomersInformationForEachRegionTextBlock" contextRef="CurrentQuarterDuration">' +
      numeric + "</ix:nonNumeric>");
    const instance = Object.keys(members).find((name) => name.endsWith(".xbrl"))!;
    const annual = /<xbrli:context id="CurrentYearDuration">[\s\S]*?<\/xbrli:context>/.exec(members[instance])![0];
    // Explicit negative transformation of the real definition; never a primary-source period.
    const short = annual.replace("CurrentYearDuration", "CurrentQuarterDuration")
      .replace("2025-07-01", "2026-04-01");
    expect(short).not.toBe(annual);
    members[instance] = members[instance].replace("</xbrli:xbrl>", short + "</xbrli:xbrl>");
    const { result, capture } = parse(fixture, members);
    expect(result.omission?.scope).toBe("regional_external_customer_sales_note");
    expect(capture.stopReason).not.toBe("geographic-omission-conflict");
  });
});
