import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import * as zipReader from "../services/edinet/zip.js";
import { parseOrderData } from "../services/edinet/order-parser.js";
import { parseJpNumber, tablesWithHeading, tableToGridExpanded } from "../services/edinet/html-table.js";

const original = readFileSync(fileURLToPath(new URL("./fixtures/order-construction-S100YHJP.zip", import.meta.url)));
const entries = zipReader.unzip(original);
const member = [...entries.keys()].find((name) => name.includes("0102010_honbun"))!;
const html = entries.get(member)!.toString("utf8");
const scopeBytes = readFileSync(fileURLToPath(new URL("./fixtures/order-construction-scope-members.json.gz", import.meta.url)));
const scopeFixtures = JSON.parse(gunzipSync(scopeBytes).toString()) as Array<{
  code: string; periodEnd: string; members: Record<string, string>;
}>;
const scopeProvenance = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/order-construction-scope-members.provenance.json", import.meta.url)), "utf8")) as {
  fixtureSha256: string; items: Array<{ code: string; members: Record<string, { sha256: string }> }>;
};

// Explicit corruptions of the saved original exercise HOLD gates, never production facts.
function corruptMember(from: string, to: string): void {
  expect(html).toContain(from);
  const changed = new Map(entries);
  changed.set(member, Buffer.from(html.replace(from, to)));
  vi.spyOn(zipReader, "unzip").mockReturnValue(changed);
}

afterEach(() => vi.restoreAllMocks());

describe("1719/S100YHJP native建設表の見出し空白と独立した金額列", () => {
  it("全ZIP・原見出し・併記の期首繰越を保ち、受注/残高を固定列から読む", () => {
    expect(createHash("sha256").update(original).digest("hex"))
      .toBe("957022b0d8d0a188ed968ec54f57fe799ecfd01979209b57f41e614b2bca876a");
    const table = tablesWithHeading(html).find((t) => t.table.includes("143,578"))!;
    const grid = tableToGridExpanded(table.table);
    expect(grid[0]).toContain("当期受注 工事高 (百万円)");
    expect(grid[4][2]).toBe("( 271,480 ) 271,519");
    expect(parseJpNumber(grid[4][2])).toBeNull();
    const result = parseOrderData(original, "2026-03-31");
    expect(result.status).toBe("ok_pattern_b");
    expect(result.facts).toHaveLength(6);
    expect(result.facts.every((f) => f.isConsolidated === false && f.unitLabel === "百万円")).toBe(true);
    expect(result.facts.filter((f) => f.fiscalYearEnd === "2026-03-31")
      .map((f) => [f.segmentName, f.ordersReceived, f.orderBacklog])).toEqual([
      ["土木工事", 143578, 273971],
      ["建築工事", 390005, 414219],
      ["合計", 533583, 688190],
    ]);
  });

  it("原表と違う入力期へ金額を割り当てない", () => {
    expect(parseOrderData(original, "2027-03-31")).toMatchObject({ status: "table_unrecognized", facts: [] });
  });

  it("受注セル自体が併記なら別の金額へずらさずHOLDする", () => {
    corruptMember("143,578", "( 271,480 ) 271,519");
    expect(parseOrderData(original, "2026-03-31")).toMatchObject({ status: "table_unrecognized", facts: [] });
  });

  it("個別の明示を除去した破損表は前段の連結説明で補わない", () => {
    corruptMember("個別の事業の実績", "事業の実績");
    expect(parseOrderData(original, "2026-03-31"))
      .toMatchObject({ status: "table_unrecognized", facts: [], holdReason: "order_table_scope_unknown_or_mismatch" });
  });

  it("対象セルの明示欠測はNULLのままで、他列や合計から補完しない", () => {
    corruptMember("143,578", "―");
    const result = parseOrderData(original, "2026-03-31");
    expect(result.status).toBe("ok_pattern_b");
    expect(result.facts.find((f) => f.fiscalYearEnd === "2026-03-31" && f.segmentName === "土木工事"))
      .toMatchObject({ ordersReceived: null, orderBacklog: 273971 });
  });

  it("建設事業計の明示ラベルを部門として二重集計しない", () => {
    const table = tablesWithHeading(html).find((t) => t.table.includes("143,578"))!;
    // Label-only test mutation; the source amounts and native period stay intact.
    corruptMember(table.table, table.table.replaceAll("合計", "建設事業計"));
    const result = parseOrderData(original, "2026-03-31");
    expect(result.status).toBe("ok_pattern_b");
    expect(result.facts.filter((f) => f.segmentName === "建設事業計").map((f) => f.segmentKind))
      .toEqual(["subtotal", "subtotal"]);
  });
});

describe("原表直前の提出会社の実績/建設事業という個別範囲", () => {
  it.each([
    ["1860", 8, "国内建築", 412827, 716343],
    ["1980", 12, "空調衛生工事", 242729, 261539],
  ] as const)("%sの全native本文と実日付から個別表を資格化する", (code, length, label, received, backlog) => {
    const fixture = scopeFixtures.find((f) => f.code === code)!;
    const proof = scopeProvenance.items.find((f) => f.code === code)!;
    expect(createHash("sha256").update(scopeBytes).digest("hex")).toBe(scopeProvenance.fixtureSha256);
    for (const [name, content] of Object.entries(fixture.members)) {
      expect(createHash("sha256").update(content).digest("hex")).toBe(proof.members[name].sha256);
    }
    vi.spyOn(zipReader, "unzip").mockReturnValue(new Map(Object.entries(fixture.members).map(([name, source]) => [name, Buffer.from(source)])));
    const result = parseOrderData(original, fixture.periodEnd);
    expect(result.status).toBe("ok_pattern_b");
    expect(result.facts).toHaveLength(length);
    expect(result.facts.every((f) => f.isConsolidated === false)).toBe(true);
    expect(result.facts.find((f) => f.fiscalYearEnd === fixture.periodEnd && f.segmentName === label))
      .toMatchObject({ ordersReceived: received, orderBacklog: backlog, unitLabel: "百万円" });
  });

  it.each([
    ["1860", "提出会社の建設事業"], ["1980", "提出会社の実績"],
  ])("%sの主体明示を除去した破損入力を別段落の連結語で補わない", (code, phrase) => {
    const fixture = scopeFixtures.find((f) => f.code === code)!;
    expect(Object.values(fixture.members).some((source) => source.includes(phrase))).toBe(true);
    const changed = new Map(Object.entries(fixture.members)
      .map(([name, source]) => [name, Buffer.from(source.replace(phrase, "実績"))]));
    vi.spyOn(zipReader, "unzip").mockReturnValue(changed);
    expect(parseOrderData(original, fixture.periodEnd))
      .toMatchObject({ status: "table_unrecognized", facts: [], holdReason: "order_table_scope_unknown_or_mismatch" });
  });
});
