import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256HexBytes } from "../sha256.js";
import {
  collectBasicProfile,
  parseBasicProfile,
  resolveDomesticFullMarket,
  TSE_BASIC_PATH,
  TSE_ENTRY_URL,
  TSE_SEARCH_PATH,
  type BasicFetch,
  type BasicRoundTrip,
} from "./basic-profile.js";

type PartialErr = Error & {
  partial?: { entry?: BasicFetch; search?: BasicFetch; basic?: BasicFetch };
};

// fixture は 621A S2 実 raw の抜粋。`;jsessionid=` 値のみ REDACTED
// (他は byte-exact)。event hidden 値は session 非依存の literal。
const FIX = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
const ENTRY = readFileSync(`${FIX}basic-entry-form.html`, "utf-8");
const SEARCH = readFileSync(`${FIX}basic-search-030.html`, "utf-8");
const TABLE = readFileSync(`${FIX}basic-table.html`, "utf-8");

function mockTrip(
  pages: [string, string, string],
  statuses: [number, number, number] = [200, 200, 200]
): {
  roundTrip: BasicRoundTrip;
  calls: { method: string; url: string; body?: string; cookie?: string }[];
} {
  const calls: { method: string; url: string; body?: string; cookie?: string }[] = [];
  let n = 0;
  const enc = new TextEncoder();
  const roundTrip: BasicRoundTrip = async (req) => {
    calls.push({ ...req });
    const text = pages[n];
    const status = statuses[n];
    n++;
    const bytes = enc.encode(text);
    return {
      status,
      location: null,
      // jar 継続: R1 発行の JSESSIONID を全段で維持する。
      setCookies: [`JSESSIONID=REDACTED; Path=/; HttpOnly`],
      bytes,
      text,
    };
  };
  return { roundTrip, calls };
}

describe("parseBasicProfile", () => {
  it("621A 行を厳密抽出する", () => {
    const row = parseBasicProfile(TABLE, "621A");
    expect(row).toEqual({
      code4: "621A",
      code5: "621A0",
      isin: "JP3172510004",
      marketBare: "グロース",
      countryCell: null,
      sector: "サービス業",
    });
    expect(resolveDomesticFullMarket(row)).toBe("グロース（内国株式）");
  });

  it("外国 suffix セルは非 qualifying (推定しない)", () => {
    const foreign = TABLE.replace("グロース", "グロース アメリカ");
    const row = parseBasicProfile(foreign, "621A");
    expect(row.marketBare).toBeNull();
    expect(row.countryCell).toBe("グロース アメリカ");
    expect(resolveDomesticFullMarket(row)).toBeNull();
  });

  it("header 不一致は throw", () => {
    expect(() =>
      parseBasicProfile(TABLE.replace("売買単位", "単元"), "621A")
    ).toThrow(/header 不一致/);
  });

  it("対象行なしは throw", () => {
    expect(() => parseBasicProfile(TABLE, "625A")).toThrow(/行なし/);
  });

  it("予備桁 0 以外の表示は矛盾 STOP", () => {
    const bad = TABLE + TABLE.replace("621A0", "621A1");
    expect(() => parseBasicProfile(bad, "621A")).toThrow(/予備桁矛盾/);
  });

  it("複数表の不一致は throw", () => {
    const dup = TABLE.replace("</table>", "") + TABLE.replace(
      "<table>\n",
      ""
    );
    const inconsistent = dup.replace("サービス業", "小売業");
    expect(() => parseBasicProfile(inconsistent, "621A")).toThrow(/不一致/);
  });
});

describe("collectBasicProfile (mock 3 段・live なし)", () => {
  it("成功 control の連鎖で証拠を返す (3 往復・retry なし)", async () => {
    const { roundTrip, calls } = mockTrip([ENTRY, SEARCH, TABLE]);
    const out = await collectBasicProfile("621A", {
      roundTrip,
      nowIso: () => "2026-09-30T02:00:00.000Z",
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ method: "GET", url: TSE_ENTRY_URL });
    expect(calls[1].url).toContain(TSE_SEARCH_PATH);
    const b2 = new URLSearchParams(calls[1].body ?? "");
    expect(b2.get("ListShow")).toBe("ListShow");
    expect(b2.get("eqMgrCd")).toBe("621A");
    expect(b2.get("dspSsuPd")).toBe("10");
    expect(b2.has("Show")).toBe(false);
    expect(b2.has("Switch")).toBe(false);
    expect(calls[2].url).toBe(`https://www2.jpx.co.jp${TSE_BASIC_PATH}`);
    const b3 = new URLSearchParams(calls[2].body ?? "");
    expect(b3.get("mgrCd")).toBe("621A0");
    expect(b3.get("jjHisiFlg")).toBe("1");
    expect(b3.get("BaseJh")).toBe("BaseJh");
    expect(b3.has("Transition")).toBe(false);
    expect(out.evidence).toMatchObject({
      code4: "621A",
      code5: "621A0",
      marketBare: "グロース",
      basicFetchedAt: "2026-09-30T02:00:00.000Z",
      sourceUrl: TSE_ENTRY_URL,
    });
    // 一次保管は受信生バイト。
    expect(out.basic.sha256).toBe(await sha256HexBytes(out.basic.bytes));
    expect(out.evidence.rawSha).toBe(out.basic.sha256);
  });

  it("R2 session 断は STOP (S1 型 bounce)・bounce body を partial 保管", async () => {
    const { roundTrip } = mockTrip([ENTRY, SEARCH, TABLE]);
    let n = 0;
    const flapping: BasicRoundTrip = async (req) => {
      const r = await roundTrip(req);
      n++;
      if (n === 2) {
        return {
          ...r,
          setCookies: ["JSESSIONID=ROTATED; Path=/; HttpOnly"],
        };
      }
      return r;
    };
    const err = await collectBasicProfile("621A", {
      roundTrip: flapping,
    }).then(
      () => null,
      (e: unknown) => e as PartialErr
    );
    expect(err?.message).toMatch(/session 断/);
    expect(err?.partial?.entry).toBeDefined();
    // bounce 応答の受信 body は黙殺せず search 段として保管する。
    expect(err?.partial?.search?.bytes).toEqual(
      new TextEncoder().encode(SEARCH)
    );
    expect(err?.partial?.search?.status).toBe(200);
    expect(err?.partial?.basic).toBeUndefined();
  });

  it("R2 結果表の複数行は exact-one 不成立", async () => {
    const row625 =
      "<tr><td>625A0</td><td>x</td><td>x</td><td>x</td><td>x</td><td>x</td><td>x</td><td>x</td><td>x</td></tr>";
    const i = SEARCH.lastIndexOf("</table>");
    const two = `${SEARCH.slice(0, i)}${row625}${SEARCH.slice(i)}`;
    const { roundTrip } = mockTrip([ENTRY, two, TABLE]);
    await expect(
      collectBasicProfile("621A", { roundTrip })
    ).rejects.toThrow(/exact-one/);
  });

  it("R2 表外の他社コード文字列は無視する (表 scope の証明)", async () => {
    const noise = `${SEARCH}<p>参考: 625A0 は別銘柄</p>`;
    const { roundTrip } = mockTrip([ENTRY, noise, TABLE]);
    const out = await collectBasicProfile("621A", { roundTrip });
    expect(out.evidence.code5).toBe("621A0");
  });

  it("R2 結果表なしは STOP", async () => {
    const nogrid = `${ENTRY}gotoBaseJh('621A0', '1')`;
    const { roundTrip } = mockTrip([ENTRY, nogrid, TABLE]);
    await expect(
      collectBasicProfile("621A", { roundTrip })
    ).rejects.toThrow(/検索結果表なし/);
  });

  it("R1 redirect は追随せず STOP", async () => {
    const { roundTrip } = mockTrip([ENTRY, SEARCH, TABLE]);
    const redir: BasicRoundTrip = async (req) => {
      const r = await roundTrip(req);
      return { ...r, status: 302, location: "https://example.invalid/" };
    };
    await expect(
      collectBasicProfile("621A", { roundTrip: redir })
    ).rejects.toThrow(/redirect=true/);
  });

  it("R1 ListShow 欠落は STOP", async () => {
    const noList = ENTRY.replace(/<input[^>]*name="ListShow"[^>]*>/, "");
    const { roundTrip } = mockTrip([noList, SEARCH, TABLE]);
    await expect(
      collectBasicProfile("621A", { roundTrip })
    ).rejects.toThrow(/ListShow/);
  });

  it("R3 失敗時は得済み entry/search/basic を partial に添付する", async () => {
    const { roundTrip } = mockTrip([ENTRY, SEARCH, TABLE], [200, 200, 500]);
    const err = await collectBasicProfile("621A", { roundTrip }).then(
      () => null,
      (e: unknown) => e as PartialErr
    );
    expect(err?.message).toContain("R3");
    expect(err?.partial?.entry).toBeDefined();
    expect(err?.partial?.search).toBeDefined();
    // 非 200 body も得済みとして basic 段に保管する (status ごと)。
    expect(err?.partial?.basic?.bytes).toEqual(
      new TextEncoder().encode(TABLE)
    );
    expect(err?.partial?.basic?.status).toBe(500);
  });

  it("R1/R2/R3 の fetchedAt は各実受信時で単調 (cycle 流用なし)", async () => {
    const { roundTrip } = mockTrip([ENTRY, SEARCH, TABLE]);
    const stamps = [
      "2026-09-30T00:00:01.000Z",
      "2026-09-30T00:00:02.000Z",
      "2026-09-30T00:00:03.000Z",
      "2026-09-30T00:00:04.000Z",
    ];
    let n = 0;
    const out = await collectBasicProfile("621A", {
      roundTrip,
      nowIso: () => stamps[Math.min(n++, stamps.length - 1)],
    });
    expect(out.entry.fetchedAt).toBe("2026-09-30T00:00:01.000Z");
    expect(out.search.fetchedAt).toBe("2026-09-30T00:00:02.000Z");
    expect(out.basic.fetchedAt).toBe("2026-09-30T00:00:03.000Z");
    expect(out.evidence.basicFetchedAt).toBe("2026-09-30T00:00:04.000Z");
    expect(out.evidence.entryFetchedAt).toBe(out.entry.fetchedAt);
    expect(out.evidence.searchFetchedAt).toBe(out.search.fetchedAt);
  });

  it("R1 輸送失敗時は partial なし (得済みゼロ)", async () => {
    const throwing: BasicRoundTrip = async () => {
      throw new Error("transport down");
    };
    const err = await collectBasicProfile("621A", {
      roundTrip: throwing,
    }).then(
      () => null,
      (e: unknown) => e as PartialErr
    );
    expect(err?.message).toContain("transport down");
    expect(err?.partial).toBeUndefined();
  });
});
