import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import * as zipReader from "../services/edinet/zip.js";
import { parseOrderData, parseOrderHtml } from "../services/edinet/order-parser.js";
import { tablesWithHeading } from "../services/edinet/html-table.js";

const original = readFileSync(fileURLToPath(new URL("./fixtures/order-split-S100XTPW.zip", import.meta.url)));
const entries = zipReader.unzip(original);
const orderMember = [...entries.keys()].find((name) => name.includes("0102010_honbun"))!;
const otherMember = [...entries.keys()].find((name) => name.includes("0105010_honbun"))!;
const orderHtml = entries.get(orderMember)!.toString("utf8");
const table = tablesWithHeading(orderHtml).find((t) => t.table.includes("10,823,159"))!.table;

// Explicit corruptions of the real decoded source exercise selector gates.
// These Maps are test inputs; they are never claimed to be original EDINET bytes.
function changedEntries(changes: Array<[string, string]>, reverse = false): void {
  const changed = new Map(entries);
  for (const [name, html] of changes) changed.set(name, Buffer.from(html));
  vi.spyOn(zipReader, "unzip").mockReturnValue(reverse ? new Map([...changed].reverse()) : changed);
}

afterEach(() => vi.restoreAllMocks());

describe("S100XTPW 原ZIP全本文から受注factsetを一意に選ぶ", () => {
  it("先頭の語だけで打ち切らず、実当期・連結表の4factsを採用する", () => {
    expect(createHash("sha256").update(original).digest("hex"))
      .toBe("df58b791f3d9f35df9fa77a32e6e6576f2d611e0c2f1cec3aae882568b10e4c5");
    const result = parseOrderData(original, "2025-12-31");
    expect(result.status).toBe("ok_pattern_a");
    expect(result.honbunFile).toBe(orderMember);
    expect(result.facts.map((f) => [f.segmentName, f.ordersReceived, f.orderBacklog])).toEqual([
      ["水道", 10823159, 11489348],
      ["下水道", 12682821, 11555023],
      ["河川その他", 3012739, 1715362],
      ["合計", 26518720, 24759735],
    ]);
    expect(result.facts.every((f) => f.fiscalYearEnd === "2025-12-31" && f.isConsolidated === true && f.unitLabel === "千円")).toBe(true);
  });

  it("native member列挙を逆順にしても同じfactsetを採用する", () => {
    const expected = parseOrderData(original, "2025-12-31");
    changedEntries([], true);
    expect(parseOrderData(original, "2025-12-31")).toEqual(expected);
  });

  it("同一の実tableが別本文に重複しても値を足し合わせない", () => {
    const expected = parseOrderData(original, "2025-12-31");
    changedEntries([[otherMember, entries.get(otherMember)!.toString("utf8").replace("</html>", `${table}</html>`)]]);
    const result = parseOrderData(original, "2025-12-31");
    expect(result.facts).toEqual(expected.facts);
    expect(result.facts).toHaveLength(4);
  });

  it.each([orderMember, otherMember])("同じ期・scopeで値が矛盾する実table変形をHOLDする: %s", (member) => {
    // Swap existing source amounts, preserving the total and all dates/scopes.
    const conflict = table.replace("10,823,159", "__swap__").replace("12,682,821", "10,823,159").replace("__swap__", "12,682,821");
    changedEntries([[member, entries.get(member)!.toString("utf8").replace("</html>", `${conflict}</html>`)]]);
    const result = parseOrderData(original, "2025-12-31");
    expect(result).toMatchObject({ status: "table_unrecognized", facts: [], honbunFile: null, holdReason: "conflicting_order_factsets" });
  });

  it("別候補の印刷期が不明なら既知の当期候補だけを都合よく採らない", () => {
    const unknown = table.replace(/当連結会計年度[\s\S]*?2025年12月31日）/g, "");
    expect(unknown).not.toBe(table);
    changedEntries([[otherMember, entries.get(otherMember)!.toString("utf8").replace("</html>", `${unknown}</html>`)]]);
    expect(parseOrderData(original, "2025-12-31")).toMatchObject({ status: "table_unrecognized", facts: [], holdReason: "order_table_fiscal_unknown" });
  });

  it("別候補の連結区分が不明ならscopeを補って採用しない", () => {
    const unknown = table.replace(/当連結会計年度/g, "当会計年度");
    changedEntries([[otherMember, entries.get(otherMember)!.toString("utf8").replace("</html>", `${unknown}</html>`)]]);
    expect(parseOrderData(original, "2025-12-31")).toMatchObject({ status: "table_unrecognized", facts: [], holdReason: "order_table_scope_unknown_or_mismatch" });
  });

  it("入力の期末が原表と違うと当期factを生成しない", () => {
    const result = parseOrderData(original, "2026-12-31");
    expect(result.facts).toHaveLength(0);
    expect(result.status).toBe("table_unrecognized");
  });
});


interface NativeContextFixture {
  code: string;
  docId: string;
  periodEnd: string;
  members: Record<string, string>;
}
const nativeBytes = readFileSync(fileURLToPath(new URL("./fixtures/order-native-contexts.json.gz", import.meta.url)));
const nativeFixtures = JSON.parse(gunzipSync(nativeBytes).toString("utf8")) as NativeContextFixture[];
const nativeProvenance = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/order-native-contexts.provenance.json", import.meta.url)), "utf8")) as {
  fixtureSha256: string;
  items: Array<{ code: string; members: Record<string, { sha256: string }> }>;
};
function nativeMembers(code: string): NativeContextFixture {
  const fixture = nativeFixtures.find((f) => f.code === code)!;
  const proof = nativeProvenance.items.find((f) => f.code === code)!;
  expect(createHash("sha256").update(nativeBytes).digest("hex")).toBe(nativeProvenance.fixtureSha256);
  for (const [name, content] of Object.entries(fixture.members)) {
    expect(createHash("sha256").update(content).digest("hex")).toBe(proof.members[name].sha256);
  }
  // Exact public native members, explicitly a source subset rather than an original ZIP.
  vi.spyOn(zipReader, "unzip").mockReturnValue(new Map(Object.entries(fixture.members).map(([name, content]) => [name, Buffer.from(content)])));
  return fixture;
}

describe("実native表題と同一filing durationの期間・scope資格", () => {
  it("1431の『当連結会計年度の受注実績』を実durationへ結ぶ", () => {
    const fixture = nativeMembers("1431");
    const result = parseOrderData(original, fixture.periodEnd);
    expect(result.status).toBe("ok_pattern_a");
    expect(result.facts.map((f) => [f.segmentName, f.ordersReceived, f.orderBacklog])).toEqual([
      ["建築請負事業", 11189047, 7095656], ["不動産販売事業", 3625727, 672239], ["合計", 14814774, 7767895],
    ]);
    expect(result.facts.every((f) => f.fiscalYearEnd === fixture.periodEnd && f.isConsolidated === true)).toBe(true);
  });

  it("1431の実duration定義を除去した破損入力は相対語だけで当期を作らない", () => {
    const fixture = nativeMembers("1431");
    const corrupted = new Map(Object.entries(fixture.members).map(([name, content]) => [name, Buffer.from(content.replace(/<xbrli:context id="CurrentYearDuration">[\s\S]*?<\/xbrli:context>/g, ""))]));
    vi.mocked(zipReader.unzip).mockReturnValue(corrupted);
    expect(parseOrderData(original, fixture.periodEnd)).toMatchObject({ status: "table_unrecognized", facts: [], holdReason: "order_table_fiscal_unknown" });
  });

  it("1815の提出会社表を前段の連結説明で上書きしない", () => {
    const fixture = nativeMembers("1815");
    const result = parseOrderData(original, fixture.periodEnd);
    expect(result.status).toBe("ok_pattern_b");
    expect(result.facts).toHaveLength(6);
    expect(result.facts.every((f) => f.isConsolidated === false)).toBe(true);
    expect(result.facts.filter((f) => f.fiscalYearEnd === fixture.periodEnd).map((f) => [f.segmentName, f.ordersReceived, f.orderBacklog])).toEqual([
      ["土木工事", 115030, 188403], ["建築工事", 109704, 141078], ["計", 224734, 329481],
    ]);
  });

  it("1925の連結表・個別表を全検査後に連結contractへ限定し、混ぜない", () => {
    const fixture = nativeMembers("1925");
    const result = parseOrderData(original, fixture.periodEnd);
    expect(result.status).toBe("ok_pattern_a");
    expect(result.facts).toHaveLength(8);
    expect(result.facts.every((f) => f.isConsolidated === true && f.fiscalYearEnd === fixture.periodEnd)).toBe(true);
    expect(result.facts.find((f) => f.segmentKind === "total")).toMatchObject({ ordersReceived: 5733924, orderBacklog: 2060296 });
  });
});


describe("実B表の独立した期間証拠と単体scope", () => {
  it("1812の絶対印刷自至日だけで採用でき、duration欠損を別の期で埋めない", () => {
    const fixture = nativeMembers("1812");
    const noDuration = new Map(Object.entries(fixture.members).map(([name, content]) => [name, Buffer.from(content.replace(/<xbrli:context id="CurrentYearDuration">[\s\S]*?<\/xbrli:context>/g, ""))]));
    vi.mocked(zipReader.unzip).mockReturnValue(noDuration);
    const actual = parseOrderData(original, fixture.periodEnd);
    expect(actual.status).toBe("ok_pattern_b");
    expect(actual.facts).toHaveLength(10);
    expect(actual.facts.every((f) => f.isConsolidated === false)).toBe(true);
    // Corrupt caller input. Old B override used its own assigned FY as evidence.
    expect(parseOrderData(original, "2027-03-31")).toMatchObject({ status: "table_unrecognized", facts: [] });
  });

  it("1812の当/前年度ラベルだけにした破損入力は実durationなしで採用しない", () => {
    const fixture = nativeMembers("1812");
    const noDates = new Map(Object.entries(fixture.members).map(([name, source]) => {
      let content = source.replace(/<xbrli:context\s+id="CurrentYearDuration"\s*>[\s\S]*?<\/xbrli:context>/g, "");
      if (name.includes("honbun")) {
        const nativeTable = tablesWithHeading(source).find((t) => parseOrderHtml(t.table, fixture.periodEnd).status === "ok_pattern_b")!;
        const corrupted = nativeTable.table.replace(/自[\s\S]*?日/g, "").replace(/至[\s\S]*?日/g, "");
        expect(corrupted).not.toBe(nativeTable.table);
        content = content.replace(nativeTable.table, corrupted);
      }
      return [name, Buffer.from(content)];
    }));
    vi.mocked(zipReader.unzip).mockReturnValue(noDates);
    expect(parseOrderData(original, fixture.periodEnd)).toMatchObject({ status: "table_unrecognized", facts: [] });
    expect(parseOrderData(original, "2027-03-31")).toMatchObject({ status: "table_unrecognized", facts: [] });
  });

  it("1803の直前『当社単体』を広い前文の連結説明で上書きしない", () => {
    const fixture = nativeMembers("1803");
    const result = parseOrderData(original, fixture.periodEnd);
    expect(result.status).toBe("ok_pattern_b");
    expect(result.facts).toHaveLength(10);
    expect(result.facts.every((f) => f.isConsolidated === false)).toBe(true);
  });
});
