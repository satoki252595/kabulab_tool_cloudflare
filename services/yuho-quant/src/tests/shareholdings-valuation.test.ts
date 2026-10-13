/** 実コードリストと構造検証用chartで、時点・通貨・銘柄・分割の境界を検証。 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { exactLegalName, parseHoldingsCodeList, qualifyHoldingValuation, type ArchivedSource } from "../services/edinet/shareholdings-valuation.js";
import type { Shareholding } from "../services/edinet/shareholdings.js";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const zip = readFileSync(new URL("../../../../pipeline/tests/fixtures/edinet/Edinetcode.zip", import.meta.url));
const catalog = parseHoldingsCodeList({ archivePageId: "a".repeat(32), filename: "Edinetcode.zip", bytes: zip, sha256: hash(zip) });
const issuer = [...catalog.byLegalName.values()].flat().find(row => row.code === "7203")!;
const holding: Shareholding = { name: issuer.legalName, kind: "特定投資株式", shares: 12, sharesRaw: 12, sharesUnit: "株",
  bookValueYen: 10000, bookValueRaw: 10, bookValueUnit: "千円", listingStatus: "unknown", price: null, priceDate: null,
  priceCurrency: null, tableIndex: 0, rowIndex: 3 };
const ts = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;
function source(options: { splitDate?: string; priceDate?: string; currency?: string; issuerName?: string; eventsQuery?: boolean; duplicate?: boolean } = {}): ArchivedSource {
  const date = options.priceDate === undefined ? "2026-06-30" : options.priceDate;
  const currency = options.currency === undefined ? "JPY" : options.currency;
  const name = options.issuerName === undefined ? issuer.englishName : options.issuerName;
  const raw = Buffer.from(JSON.stringify({ chart: { result: [{ meta: { symbol: "7203.T", range: "10y", currency,
    exchangeTimezoneName: "Asia/Tokyo", longName: name, regularMarketPrice: 100, regularMarketTime: ts("2026-07-01") },
    timestamp: [ts(date), ts("2026-07-01")], indicators: { quote: [{ open: [100, 100], high: [100, 100], low: [100, 100], close: [100, 100], volume: [1, 1] }] },
    ...(options.splitDate ? { events: { splits: { split: { date: ts(options.splitDate), numerator: 2, denominator: 1 } } } } : {}),
  }], error: null } }));
  const member = { api: "daily", symbol: "7203.T", status: 200, receivedAt: "2026-07-02T00:00:00Z", byteLength: raw.length,
    sha256: hash(raw), bodyBase64: raw.toString("base64"), url: `https://query1.finance.yahoo.com/v8/finance/chart/7203.T?range=10y&interval=1d${options.eventsQuery === false ? "" : "&events=split,div"}` };
  const bytes = gzipSync(Buffer.from(JSON.stringify({ version: 1, members: options.duplicate ? [member, member] : [member] })));
  return { archivePageId: "b".repeat(32), filename: "raw.json.gz", bytes, sha256: hash(bytes) };
}
const qualify = (priceSource: ArchivedSource) => qualifyHoldingValuation({ holding, fiscalYearEnd: "2026-06-30", catalog, prices: [priceSource] });

describe("保有明細の期末参考時価", () => {
  it("同義法人表記だけを正規化し、法人格削除や略称一致はしない", () => {
    expect(exactLegalName("構造㈱")).toBe("構造株式会社");
    expect(exactLegalName("構造株式会社")).not.toBe(exactLegalName("構造"));
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
});
