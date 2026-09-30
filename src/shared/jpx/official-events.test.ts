import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256HexBytes } from "../sha256.js";
import {
  fetchDelistedHtml,
  JPX_DELISTED_URL,
  officialEventsArchiveKey,
  parseDelistedHtml,
} from "./delisted.js";
import {
  fetchNewListingsHtml,
  JPX_NEW_LISTINGS_URL,
  parseNewListingsHtml,
} from "./new-listings.js";
import {
  expandGrid,
  parseOfficialCode,
  requiredCoverageYears,
} from "./official-html.js";
import {
  fetchTransfersHtml,
  JPX_TRANSFERS_URL,
  parseTransfersHtml,
} from "./transfers.js";

// フィクスチャは 2026-09-30 取得の JPX 原本 3 件のバイト正確な抜粋
// (title + select.backnumber + thead + 実 tbody 行)。運用:
//   delisted.html     90526B sha 4974be152301d34b… (136行中 row0,3)
//   new-listings.html 146955B sha 70c27b36577fd591… (88行中 pair0)
//   transfers.html    58207B sha c2aa24ca64e9c441… (46行中 row0,1)
const FIX = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const WIN_2026 = ["2026"];

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(`${FIX}official-${name}.html`));
}

describe("delisted", () => {
  it("実抜粋 2 行を厳密パースする (未来行 8254 も落とさない)", () => {
    const got = parseDelistedHtml(fixture("delisted"), {
      yearWindow: WIN_2026,
    });
    expect(got.coveredYears).toEqual(["2026"]);
    expect(got.tableIndex).toBe(0);
    expect(got.rows).toHaveLength(2);
    expect(got.rows[0]).toMatchObject({
      code: "8254",
      effectiveDate: "2027-03-01",
      market: "スタンダード",
    });
    expect(got.rows[1]).toMatchObject({
      code: "5484",
      effectiveDate: "2026-10-19",
    });
  });

  it("要求年が宣言外なら HOLD で throw する (行年から推測しない)", () => {
    expect(() =>
      parseDelistedHtml(fixture("delisted"), { yearWindow: ["2025", "2026"] })
    ).toThrow(/HOLD/);
  });
});

describe("new-listings", () => {
  it("2行組 1 組を厳密パースする (承認日カッコを捨てる)", () => {
    const got = parseNewListingsHtml(fixture("new-listings"), {
      yearWindow: WIN_2026,
    });
    expect(got.coveredYears).toEqual(["2026"]);
    expect(got.rows).toHaveLength(1);
    expect(got.rows[0]).toMatchObject({
      code: "653A",
      listingDate: "2026-11-02",
      market: "グロース",
    });
  });

  it("要求年が宣言外なら HOLD で throw する", () => {
    expect(() =>
      parseNewListingsHtml(fixture("new-listings"), { yearWindow: ["2025"] })
    ).toThrow(/HOLD/);
  });
});

describe("transfers", () => {
  it("3477 G→S を含む 2 行を厳密パースする", () => {
    const got = parseTransfersHtml(fixture("transfers"), {
      yearWindow: WIN_2026,
    });
    expect(got.coveredYears).toEqual(["2026"]);
    expect(got.rows).toHaveLength(2);
    expect(got.rows[1]).toMatchObject({
      code: "3477",
      effectiveDate: "2026-09-24",
      fromMarket: "グロース",
      toMarket: "スタンダード",
    });
  });

  it("要求年が宣言外なら HOLD で throw する", () => {
    expect(() =>
      parseTransfersHtml(fixture("transfers"), { yearWindow: ["2027"] })
    ).toThrow(/HOLD/);
  });
});

describe("strict span", () => {
  it("rowspan='x' は規定値 1 にしない", () => {
    expect(() =>
      expandGrid([`<td rowspan="x">a</td>`], "t")
    ).toThrow(/不正 span 属性/);
  });

  it("rowspan='2junk' は 2 にしない (全文検証)", () => {
    expect(() =>
      expandGrid([`<td rowspan="2junk">a</td>`, `<td>b</td>`], "t")
    ).toThrow(/不正 span 属性/);
  });

  it("colspan が未消費 carry を跨げば throw する", () => {
    expect(() =>
      expandGrid(
        [`<td>a</td><td rowspan="2">b</td>`, `<td colspan="2">c</td>`],
        "t"
      )
    ).toThrow(/span 重なり/);
  });

  it("表末端を超過する rowspan は throw する", () => {
    expect(() =>
      expandGrid(
        [`<td rowspan="3">a</td><td>x</td>`, `<td>y</td>`],
        "t"
      )
    ).toThrow(/未消費 rowspan/);
  });
});

describe("parseOfficialCode", () => {
  it("正準コードは正準形を返す", () => {
    expect(parseOfficialCode("8254", "t")).toBe("8254");
    expect(parseOfficialCode("130A", "t")).toBe("130A");
    expect(parseOfficialCode("130a", "t")).toBe("130A");
  });

  it("A130/1A30/0000 を拒否する", () => {
    for (const bad of ["A130", "1A30", "0000", "", "-"]) {
      expect(() => parseOfficialCode(bad, "t")).toThrow(/コード不正/);
    }
  });
});

describe("requiredCoverageYears", () => {
  it("12/31 base → 1月は前年を要求しない", () => {
    expect(requiredCoverageYears("2025-12-31", "2026-01-05")).toEqual({
      years: ["2026"],
      bootstrapPartial: false,
    });
  });

  it("12月中 base → 1月は両年を要求する", () => {
    expect(requiredCoverageYears("2025-12-15", "2026-01-10")).toEqual({
      years: ["2025", "2026"],
      bootstrapPartial: false,
    });
  });

  it("base=null は eligibility 年のみ + bootstrap 記録", () => {
    expect(requiredCoverageYears(null, "2026-09-29")).toEqual({
      years: ["2026"],
      bootstrapPartial: true,
    });
  });
});

describe("officialEventsArchiveKey", () => {
  const SHAS = { delisted: "a", newListings: "b", transfers: "c" };

  it("決定的で 12hex を返す", async () => {
    const k1 = await officialEventsArchiveKey(SHAS);
    const k2 = await officialEventsArchiveKey(SHAS);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{12}$/);
  });

  it("IPO/transfers の変化が key に入る (順序固定)", async () => {
    const base = await officialEventsArchiveKey(SHAS);
    const swapped = await officialEventsArchiveKey({
      delisted: "a",
      newListings: "c",
      transfers: "b",
    });
    expect(swapped).not.toBe(base);
  });
});

describe("fetch helpers (non-200 passthrough)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(status: number, body: ArrayBuffer) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status,
        arrayBuffer: () => Promise.resolve(body),
      })
    );
  }

  function bodyBytes(): {
    buffer: ArrayBuffer;
    bytes: Uint8Array<ArrayBuffer>;
  } {
    const buffer = new ArrayBuffer(4);
    const bytes = new Uint8Array(buffer) as Uint8Array<ArrayBuffer>;
    bytes.set([0x3c, 0x68, 0x74, 0x6d]);
    return { buffer, bytes };
  }

  it.each([
    ["delisted", fetchDelistedHtml, JPX_DELISTED_URL],
    ["new-listings", fetchNewListingsHtml, JPX_NEW_LISTINGS_URL],
    ["transfers", fetchTransfersHtml, JPX_TRANSFERS_URL],
  ] as const)("%s は 404 の body を捨てずに返す", async (_n, fn, url) => {
    const { buffer, bytes } = bodyBytes();
    stubFetch(404, buffer);
    const got = await fn();
    expect(got.status).toBe(404);
    expect(got.url).toBe(url);
    expect(got.bytes).toEqual(bytes);
    expect(got.sha256).toBe(await sha256HexBytes(bytes));
  });

  it("network reject はそのまま伝播する", async () => {
    const err = new Error("boom");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(err));
    await expect(fetchDelistedHtml()).rejects.toBe(err);
  });
});

describe("fatal decode", () => {
  it("不正 UTF-8 バイトは throw する", () => {
    expect(() =>
      parseDelistedHtml(new Uint8Array([0xff, 0xfe, 0x00]), {
        yearWindow: WIN_2026,
      })
    ).toThrow();
  });
});
