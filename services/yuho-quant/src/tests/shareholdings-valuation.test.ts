/** 実コードリストと構造検証用chartで、時点・通貨・銘柄・分割の境界を検証。 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { exactLegalName, HoldingsPriceIndex, parseHoldingsCodeList, qualifyHoldingValuation, type ArchivedSource } from "../services/edinet/shareholdings-valuation.js";
import type { Shareholding } from "../services/edinet/shareholdings.js";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const zip = readFileSync(new URL("../../../../pipeline/tests/fixtures/edinet/Edinetcode.zip", import.meta.url));
const catalog = parseHoldingsCodeList({ archivePageId: "a".repeat(32), filename: "Edinetcode.zip", bytes: zip, sha256: hash(zip) });
const issuer = [...catalog.byLegalName.values()].flat().find(row => row.code === "7203")!;
const holding: Shareholding = { name: issuer.legalName, kind: "特定投資株式", shares: 12, sharesRaw: 12, sharesUnit: "株",
  bookValueYen: 10000, bookValueRaw: 10, bookValueUnit: "千円", listingStatus: "unknown", price: null, priceDate: null,
  priceCurrency: null, tableIndex: 0, rowIndex: 3 };
const ts = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;
function source(options: { splitDate?: string; priceDate?: string; currency?: string; issuerName?: string; symbol?: string; eventsQuery?: boolean; duplicate?: boolean } = {}): ArchivedSource {
  const date = options.priceDate === undefined ? "2026-06-30" : options.priceDate;
  const currency = options.currency === undefined ? "JPY" : options.currency;
  const name = options.issuerName === undefined ? issuer.englishName : options.issuerName;
  const symbol = options.symbol === undefined ? "7203.T" : options.symbol;
  const raw = Buffer.from(JSON.stringify({ chart: { result: [{ meta: { symbol, range: "10y", currency,
    exchangeTimezoneName: "Asia/Tokyo", longName: name, regularMarketPrice: 100, regularMarketTime: ts("2026-07-01") },
    timestamp: [ts(date), ts("2026-07-01")], indicators: { quote: [{ open: [100, 100], high: [100, 100], low: [100, 100], close: [100, 100], volume: [1, 1] }] },
    ...(options.splitDate ? { events: { splits: { split: { date: ts(options.splitDate), numerator: 2, denominator: 1 } } } } : {}),
  }], error: null } }));
  const member = { api: "daily", symbol, status: 200, receivedAt: "2026-07-02T00:00:00Z", byteLength: raw.length,
    sha256: hash(raw), bodyBase64: raw.toString("base64"), url: `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=10y&interval=1d${options.eventsQuery === false ? "" : "&events=split,div"}` };
  const bytes = gzipSync(Buffer.from(JSON.stringify({ version: 1, members: options.duplicate ? [member, member] : [member] })));
  return { archivePageId: "b".repeat(32), filename: "raw.json.gz", bytes, sha256: hash(bytes) };
}
const qualify = (priceSource: ArchivedSource) => qualifyHoldingValuation({ holding, fiscalYearEnd: "2026-06-30", catalog, prices: [priceSource] });

describe("保有明細の期末参考時価", () => {
  it("明示snapshotだけを候補化し、同梱の旧観測/非active symbolを流用しない", async () => {
    const original = source(), wrapper = JSON.parse(gunzipSync(original.bytes).toString("utf8"));
    const member = wrapper.members[0];
    const bytes = gzipSync(Buffer.from(JSON.stringify({ ...wrapper, members: [{ ...member, receivedAt: "2026-07-01T00:00:00Z" }, member,
      { ...member, symbol: "6758.T" }] })));
    const saved = { ...original, bytes, sha256: hash(bytes), priceMembers: { "7203.T": {
      bodySha256: member.sha256, bodyBytes: member.byteLength, receivedAt: member.receivedAt } } };
    const index = new HoldingsPriceIndex([saved]);
    expect(index.candidates("7203.T")).toHaveLength(1); expect(index.candidates("6758.T")).toHaveLength(0);
    const expected = await qualify(original);
    expect(expected.status).toBe("qualified");
    if (expected.status !== "qualified") throw new Error(expected.reason);
    expect(await qualifyHoldingValuation({ holding, fiscalYearEnd: "2026-06-30", catalog, prices: index }))
      .toEqual({ ...expected, priceSource: { ...expected.priceSource, gzipSha256: saved.sha256 } });
    expect(saved.bytes).toBe(bytes); expect(saved.sha256).toBe(hash(bytes));
    for (const change of [{ bodySha256: "0".repeat(64) }, { bodyBytes: member.byteLength + 1 }, { receivedAt: "2026-06-30T00:00:00Z" }]) {
      const mismatch = new HoldingsPriceIndex([{ ...saved, priceMembers: { "7203.T": { ...saved.priceMembers["7203.T"], ...change } } }]);
      expect(() => mismatch.candidates("7203.T")).toThrow("明示member");
    }
    const duplicate = source({ duplicate: true });
    expect(() => new HoldingsPriceIndex([{ ...duplicate, priceMembers: saved.priceMembers }]).candidates("7203.T")).toThrow("重複");
  });
  it("同義法人表記だけを正規化し、法人格削除や略称一致はしない", () => {
    expect(exactLegalName("構造㈱")).toBe("構造株式会社");
    expect(exactLegalName("構造株式会社")).not.toBe(exactLegalName("構造"));
  });
  // 実FSA ZIPと保存Yahoo日足の商号。価格系列だけは既存の構造検証用chartを使う。
  it.each([
    ["8045", "Yokohama Maruuo Co., Ltd", "Yokohama Maruuo Co., Ltd."],
    ["7481", "oie sangyo co.,ltd", "Oie Sangyo Co., Ltd."],
    ["9068", "Maruzen Showa Unyu Co,.Ltd.", "Maruzen Showa Unyu Co., Ltd."],
  ])("英字商号のASCII . , 差だけを許容し、原本を変えない: %s", async (code, fsaName, priceName) => {
    const target = [...catalog.byLegalName.values()].flat().find(row => row.code === code)!;
    expect(target.englishName).toBe(fsaName);
    const saved = source({ symbol: `${code}.T`, issuerName: priceName });
    expect(await qualifyHoldingValuation({ holding: { ...holding, name: target.legalName }, fiscalYearEnd: "2026-06-30", catalog, prices: [saved] }))
      .toMatchObject({ status: "qualified", identity: { code }, price: 100 });
    expect(hash(saved.bytes)).toBe(saved.sha256);
  });
  it.each([
    ["8418", "Yamaguchi Finacial Group,Inc.", "Yamaguchi Financial Group, Inc."],
    ["9304", "The Shibusawa Warehouse Co.,Ltd.", "Shibusawa Logistics Corporation"],
    ["3315", "NIPPON COKE & ENGINEERING CO., LTD.", "Nippon Coke & Engineering Company, Limited"],
    ["6897", "TWIN-BIRD CORPORATION", "Twinbird Corporation"],
  ])("綴り・語句・略称・ハイフン差は英字商号STOPを維持する: %s", async (code, fsaName, priceName) => {
    const target = [...catalog.byLegalName.values()].flat().find(row => row.code === code)!;
    expect(target.englishName).toBe(fsaName);
    await expect(qualifyHoldingValuation({ holding: { ...holding, name: target.legalName }, fiscalYearEnd: "2026-06-30", catalog,
      prices: [source({ symbol: `${code}.T`, issuerName: priceName })] })).rejects.toThrow("英字商号");
  });
  it("原本商号/code/JPY/同日期末株数/同日raw close/分割0を検証し、日付と出典SHAを保つ", async () => {
    const result = await qualify(source());
    expect(result.status).toBe("qualified");
    if (result.status !== "qualified") throw new Error(result.reason);
    expect(result).toMatchObject({ price: 100, value: 1200, currency: "JPY", date: "2026-06-30", identity: { code: "7203" },
      priceSource: { symbol: "7203.T", capturedAt: "2026-07-02T00:00:00Z", sourceTimestamp: ts("2026-06-30") } });
  });
  it("近似名・重複商号・株数欠測では価格を埋めない", async () => {
    expect((await qualifyHoldingValuation({ holding: { ...holding, name: holding.name + "別会社" }, fiscalYearEnd: "2026-06-30", catalog, prices: [] })).status).toBe("unavailable");
    const duplicate = { ...catalog, byLegalName: new Map([[exactLegalName(holding.name), [issuer, issuer]]]) };
    expect((await qualifyHoldingValuation({ holding, fiscalYearEnd: "2026-06-30", catalog: duplicate, prices: [] })).status).toBe("unavailable");
    expect((await qualifyHoldingValuation({ holding: { ...holding, shares: null }, fiscalYearEnd: "2026-06-30", catalog, prices: [] })).status).toBe("unavailable");
  });
  it("期末当日が休場/欠測なら別日で埋めず、raw候補が重複しても採らない", async () => {
    expect((await qualify(source({ priceDate: "2026-06-29" }))).status).toBe("unavailable");
    expect((await qualify(source({ duplicate: true }))).status).toBe("unavailable");
  });
  it("期末後のsplitはHOLDし、期末前のsplitで当期株数を二重調整しない", async () => {
    expect((await qualify(source({ splitDate: "2026-07-01" }))).status).toBe("unavailable");
    expect((await qualify(source({ splitDate: "2026-06-29" }))).status).toBe("qualified");
  });
  it("split要求根拠・通貨・英字商号・SHAが不一致ならSTOP", async () => {
    await expect(qualify(source({ eventsQuery: false }))).rejects.toThrow();
    await expect(qualify(source({ currency: "USD" }))).rejects.toThrow();
    await expect(qualify(source({ issuerName: "STRUCTURAL MISMATCH" }))).rejects.toThrow();
    await expect(qualify({ ...source(), sha256: "0".repeat(64) })).rejects.toThrow();
  });
  it("明示indexは同じsourceを一度だけ展開し、同symbolのchart検証を共有して同じ結果を返す", async () => {
    const saved = source(), spy = vi.spyOn(JSON, "parse");
    const wrappers = () => spy.mock.calls.filter(([text]) => typeof text === "string" && text.startsWith('{"version":1')).length;
    const charts = () => spy.mock.calls.filter(([text]) => typeof text === "string" && text.startsWith('{"chart":')).length;
    try {
      const expected = await Promise.all([qualify(saved), qualify(saved), qualify(saved)]);
      expect(wrappers()).toBe(3); expect(charts()).toBe(6);
      spy.mockClear();
      const index = new HoldingsPriceIndex([saved]);
      const actual = await Promise.all([1, 2, 3].map(() => qualifyHoldingValuation({ holding, fiscalYearEnd: "2026-06-30", catalog, prices: index })));
      expect(actual).toEqual(expected);expect(wrappers()).toBe(1);expect(charts()).toBe(2);
      const changedShares = await qualifyHoldingValuation({ holding: { ...holding, shares: 24 }, fiscalYearEnd: "2026-06-30", catalog, prices: index });
      expect(changedShares).toMatchObject({ status: "qualified", price: 100, value: 2400 });expect(charts()).toBe(2);
    } finally { spy.mockRestore(); }
  });
  it("chart検証を共有しても銘柄identityをcacheせず、不一致は各回STOPする", async () => {
    const index = new HoldingsPriceIndex([source()]);
    expect((await qualifyHoldingValuation({ holding, fiscalYearEnd: "2026-06-30", catalog, prices: index })).status).toBe("qualified");
    const mismatch = { ...catalog, byLegalName: new Map([[exactLegalName(holding.name), [{ ...issuer, englishName: "UNPROVEN IDENTITY" }]]]) };
    await expect(qualifyHoldingValuation({ holding, fiscalYearEnd: "2026-06-30", catalog: mismatch, prices: index })).rejects.toThrow("英字商号");
    expect((await qualifyHoldingValuation({ holding, fiscalYearEnd: "2026-06-29", catalog, prices: index })).status).toBe("unavailable");
  });
  it.each([{ currency: "USD" }, { issuerName: "UNPROVEN IDENTITY" }, { eventsQuery: false }])("明示indexでも既存原本guardの不一致はSTOP", async options => {
    const index = new HoldingsPriceIndex([source(options)]);
    await expect(qualifyHoldingValuation({ holding, fiscalYearEnd: "2026-06-30", catalog, prices: index })).rejects.toThrow();
  });
  it("明示indexはsource SHAとmember SHAの不一致を許容せず、重複候補を選ばない", async () => {
    const corrupt = new HoldingsPriceIndex([{ ...source(), sha256: "0".repeat(64) }]);
    expect(() => corrupt.candidates("7203.T")).toThrow();
    const duplicated = new HoldingsPriceIndex([source(), source()]);
    expect(await qualifyHoldingValuation({ holding, fiscalYearEnd: "2026-06-30", catalog, prices: duplicated })).toMatchObject({ status: "unavailable", reason: "該当symbolの保存日足原本が一意ではありません" });
    const saved = source(), wrapper = JSON.parse((await import("node:zlib")).gunzipSync(saved.bytes).toString("utf8"));
    wrapper.members[0].sha256 = "0".repeat(64);
    const bytes = gzipSync(Buffer.from(JSON.stringify(wrapper))), index = new HoldingsPriceIndex([{ ...saved, bytes, sha256: hash(bytes) }]);
    for (let attempt = 0; attempt < 2; attempt++) await expect(qualifyHoldingValuation({ holding, fiscalYearEnd: "2026-06-30", catalog, prices: index })).rejects.toThrow();
  });
  it("全未同定/株数非開示なら未使用の破損bundleへ触れず、候補使用時だけ一度STOPする", async () => {
    const index = new HoldingsPriceIndex([{ ...source(), sha256: "0".repeat(64) }]);
    expect(await qualifyHoldingValuation({ holding: { ...holding, name: holding.name + "別会社" }, fiscalYearEnd: "2026-06-30", catalog, prices: index }))
      .toMatchObject({ status: "unavailable", reason: "公式上場提出者名へ完全一致しません" });
    expect(await qualifyHoldingValuation({ holding: { ...holding, shares: null }, fiscalYearEnd: "2026-06-30", catalog, prices: index }))
      .toMatchObject({ status: "unavailable", reason: "期末株数が非開示です" });
    let firstError: unknown;
    try { index.candidates("7203.T"); } catch (error) { firstError = error; }
    expect(firstError).toBeInstanceOf(Error);
    expect(() => index.candidates("7203.T")).toThrow(firstError as Error);
    try { index.candidates("7203.T"); } catch (error) { expect(error).toBe(firstError); }
    await expect(qualifyHoldingValuation({ holding, fiscalYearEnd: "2026-06-30", catalog, prices: index })).rejects.toThrow("SHA");
  });
});
