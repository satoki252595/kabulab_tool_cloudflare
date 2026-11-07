/**
 * 空売り日次が「最新の -g.pdf」と「保管済みの日だけで月次成功」になる回帰。
 * 一覧HTMLの形は 2026-11-06 の JPX 日次集計 (select.backnumber の YYYY年M月、
 * 日付/空売り集計/業種別集計、YYMMDD-g.pdf) に合わせた最小フィクスチャ。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { JPX_33_SECTORS } from "./sector-names.js";

const DIR = "/markets/statistics-equities/short-selling";
const INDEX_PATH = `${DIR}/index.html`;
const BASE = "https://www.jpx.co.jp";

function sectorPdfText(iso: string): string {
  const [y, m, d] = iso.split("-");
  const line = (name: string) => `${name} 1,000 50.0% 100 10.0% 100 10.0% 1,200`;
  return `${y}年${Number(m)}月${Number(d)}日 ` + [...JPX_33_SECTORS, "その他（33業種外）"].map(line).join(" ");
}

function pdfRow(iso: string): string {
  const [y, m, d] = iso.split("-");
  const yymmdd = `${y.slice(2)}${m}${d}`;
  const cell = (kind: "m" | "g") =>
    `<td class="a-center"><a href="${DIR}/t-att/${yymmdd}-${kind}.pdf"><img alt="PDF"></a></td>`;
  return `<tr><td class="a-center">${y}/${m}/${d}</td>${cell("m")}${cell("g")}</tr>`;
}

function zeroRow(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `<tr><td class="a-center">${y}/${m}/${d}</td><td class="a-center">-</td><td class="a-center">-</td></tr>`;
}

function listingHtml(selfPath: string, options: Array<[string, string]>, rows: string): string {
  const opts = options.map(([path, label]) =>
    `<option value="${path}"${path === selfPath ? ' selected="selected"' : ""}>${label}</option>`).join("");
  return `<title>日次集計 | 空売り集計 | 日本取引所グループ</title><select class="backnumber">${opts}</select>` +
    `<table><tr><th>日付</th><th>空売り集計</th><th>業種別集計</th></tr>${rows}</table>`;
}

async function load() {
  vi.resetModules();
  vi.doMock("./pdf-text.js", () => ({
    extractPdfText: async (bytes: Uint8Array) => sectorPdfText(new TextDecoder().decode(bytes)),
  }));
  const mod = await import("./jpx-short-selling.js");
  expect(mod.resolveShortSellingSectorPdf, "resolveShortSellingSectorPdf").toBeTypeOf("function");
  expect(mod.missingShortSellingBusinessDays, "missingShortSellingBusinessDays").toBeTypeOf("function");
  expect(mod.parseShortSellingListingHtml, "parseShortSellingListingHtml").toBeTypeOf("function");
  expect(mod.shortSellingListingPathForMonth, "shortSellingListingPathForMonth").toBeTypeOf("function");
  return mod;
}

describe("短売り欠測", () => {
  afterEach(() => {
    vi.doUnmock("./pdf-text.js");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.useRealTimers();
  });

  it("短売り欠測: 複数日の掲載から要求日の業種別PDFだけを選ぶ", async () => {
    const mod = await load();
    const html = listingHtml(INDEX_PATH, [
      [INDEX_PATH, "2026年10月"],
      [`${DIR}/00-archives-01.html`, "2026年9月"],
    ], pdfRow("2026-10-05") + pdfRow("2026-10-02") + pdfRow("2026-10-01"));
    const listing = mod.parseShortSellingListingHtml(html, INDEX_PATH);
    expect(mod.resolveShortSellingSectorPdf(listing.entries, "2026-10-01")).toEqual({
      url: `${BASE}${DIR}/t-att/261001-g.pdf`,
    });
    expect(mod.resolveShortSellingSectorPdf(listing.entries, "2026-10-02").url).toContain("261002-g.pdf");
  });

  it("短売り欠測: 要求月がindexでなければarchivesのpathだけを返す", async () => {
    const mod = await load();
    const oct = `${DIR}/00-archives-01.html`;
    const html = listingHtml(INDEX_PATH, [
      [INDEX_PATH, "2026年11月"],
      [oct, "2026年10月"],
      [`${DIR}/00-archives-02.html`, "2026年9月"],
    ], pdfRow("2026-11-05"));
    const options = mod.parseShortSellingBackNumber(html);
    expect(mod.shortSellingListingPathForMonth(options, "2026-10")).toBe(oct);
    expect(mod.shortSellingListingPathForMonth(options, "2026-11")).toBe(INDEX_PATH);
    expect(() => mod.shortSellingListingPathForMonth(options, "2026-12")).toThrow(/2026-12/);
  });

  it("短売り欠測: 要求日が無ければthrowし、別日のURLを返さない", async () => {
    const mod = await load();
    const html = listingHtml(INDEX_PATH, [[INDEX_PATH, "2026年10月"]], pdfRow("2026-10-02") + pdfRow("2026-10-01"));
    const listing = mod.parseShortSellingListingHtml(html, INDEX_PATH);
    expect(() => mod.resolveShortSellingSectorPdf(listing.entries, "2026-10-05")).toThrow(/2026-10-05/);
    expect(() => mod.resolveShortSellingSectorPdf(listing.entries, "2026-10-05")).toThrow(/ありません/);
    let resolved: { url: string } | undefined;
    try {
      resolved = mod.resolveShortSellingSectorPdf(listing.entries, "2026-10-05");
    } catch {
      resolved = undefined;
    }
    expect(resolved).toBeUndefined();
  });

  it("短売り欠測: as-of=10-01の解決結果は10-02のPDFにならない", async () => {
    const mod = await load();
    const html = listingHtml(INDEX_PATH, [[INDEX_PATH, "2026年10月"]], pdfRow("2026-10-02") + pdfRow("2026-10-01"));
    const listing = mod.parseShortSellingListingHtml(html, INDEX_PATH);
    const resolved = mod.resolveShortSellingSectorPdf(listing.entries, "2026-10-01");
    expect(resolved.url).toContain("261001-g.pdf");
    expect(resolved.url).not.toContain("261002-g.pdf");
  });

  it("短売り欠測: 保管2日だけなら10-05と10-06が欠け、週末は欠けに入らない", async () => {
    const mod = await load();
    expect(mod.missingShortSellingBusinessDays({
      through: "2026-10-06",
      storedDates: ["2026-10-01", "2026-10-02"],
      officialZeroDates: [],
    })).toEqual(["2026-10-05", "2026-10-06"]);
  });

  it("短売り欠測: 休場と公式0件の営業日は欠けにせず、月初の1営業日は完全になる", async () => {
    const mod = await load();
    const stored = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-13"];
    expect(mod.missingShortSellingBusinessDays({
      through: "2026-10-13",
      storedDates: stored,
      officialZeroDates: ["2026-10-09"],
    })).toEqual([]);
    expect(mod.missingShortSellingBusinessDays({
      through: "2026-10-01",
      storedDates: ["2026-10-01", "2026-10-02"],
      officialZeroDates: [],
    })).toEqual([]);
    expect(mod.missingShortSellingBusinessDays({
      through: "2026-01-05",
      storedDates: ["2026-01-05"],
      officialZeroDates: [],
    })).toEqual([]);
  });

  it("短売り欠測: 未収録年は営業日を推定せず停止する", async () => {
    const mod = await load();
    expect(() => mod.missingShortSellingBusinessDays({
      through: "2025-11-04",
      storedDates: [],
      officialZeroDates: [],
    })).toThrow(/未収録/);
  });

  it("短売り欠測: 将来日は取得せず別日のfetchもしない", async () => {
    const mod = await load();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    const fetchMock = vi.fn(async () => new Response("no", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    let thrown = "";
    try {
      await mod.fetchShortSellingSector("2026-10-02");
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(thrown).toMatch(/将来日/);
  });

  it("短売り欠測: PDF本文の日付が要求日と違えばそのPDFを要求日として返さない", async () => {
    const mod = await load();
    const html = listingHtml(INDEX_PATH, [[INDEX_PATH, "2026年10月"]], pdfRow("2026-10-01"));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith(".html")) return new Response(html, { status: 200 });
      if (url.includes("261001-g.pdf")) return new Response(new TextEncoder().encode("2026-10-02"), { status: 200 });
      return new Response("no", { status: 404 });
    }));
    await expect(mod.fetchShortSellingSector("2026-10-01")).rejects.toThrow(/2026-10-01/);
    await expect(mod.fetchShortSellingSector("2026-10-01")).rejects.toThrow(/一致しません/);
  });

  it("短売り欠測: 公式0件の要求日は別日PDFへ倒さずthrowする", async () => {
    const mod = await load();
    const html = listingHtml(INDEX_PATH, [[INDEX_PATH, "2026年10月"]], zeroRow("2026-10-05") + pdfRow("2026-10-02"));
    const listing = mod.parseShortSellingListingHtml(html, INDEX_PATH);
    expect(listing.entries.find((entry) => entry.date === "2026-10-05")?.sectorPdfPath).toBeNull();
    expect(() => mod.resolveShortSellingSectorPdf(listing.entries, "2026-10-05")).toThrow(/0件/);
  });

  it("短売り欠測: 空セルやファイル名日付の不一致は0件とみなさない", async () => {
    const mod = await load();
    const empty = listingHtml(INDEX_PATH, [[INDEX_PATH, "2026年10月"]],
      `<tr><td class="a-center">2026/10/01</td><td class="a-center"></td><td class="a-center"></td></tr>`);
    expect(() => mod.parseShortSellingListingHtml(empty, INDEX_PATH)).toThrow(/空/);
    const mismatch = listingHtml(INDEX_PATH, [[INDEX_PATH, "2026年10月"]],
      `<tr><td class="a-center">2026/10/01</td>` +
      `<td class="a-center"><a href="${DIR}/t-att/261002-m.pdf"><img alt="PDF"></a></td>` +
      `<td class="a-center"><a href="${DIR}/t-att/261002-g.pdf"><img alt="PDF"></a></td></tr>`);
    expect(() => mod.parseShortSellingListingHtml(mismatch, INDEX_PATH)).toThrow(/261002|一致/);
  });
});
