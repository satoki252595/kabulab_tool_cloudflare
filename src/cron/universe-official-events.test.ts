import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotionUnknownResultError } from "../shared/notion-archive/client.js";
import { officialEventsArchiveKey } from "../shared/jpx/delisted.js";
import { sha256Hex, sha256HexBytes } from "../shared/sha256.js";
import {
  collectUniverseOfficialEvents,
  type UniverseOfficialEventsDeps,
} from "./universe-official-events.js";

/**
 * Issue #196 collector/custody の回帰 (live なし)。
 * B の実フィクスチャ 3 件 + 実 parse/coverage/key/sha helper を使い、
 * 収集・manifest 決定性・custody 受理・物理 readback・incomplete 経路を
 * 検証する。IO (fetch/record/listFiles/download) は全注入。実 Notion/D1・
 * 実 source GET は使わない。
 */

const FIX = fileURLToPath(new URL("../shared/jpx/__fixtures__/", import.meta.url));
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(`${FIX}official-${name}.html`));

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

type RecordedInput = {
  service: string;
  key: string;
  source: string;
  fetchedAt: string;
  metadata: Record<string, unknown>;
  files: { filename: string; bytes: Uint8Array; contentType: string }[];
  force: boolean;
};

type Harness = {
  deps: UniverseOfficialEventsDeps;
  recorded: { current: RecordedInput | null; calls: RecordedInput[] };
  listCalls: { pageId: string; prop: string }[];
  downloadCalls: string[];
};

async function makeFetch(url: string, bytes: Uint8Array, fetchedAt: string, status = 200) {
  return {
    url,
    fetchedAt,
    status,
    bytes,
    sha256: await sha256HexBytes(Uint8Array.from(bytes)),
  };
}

/** 既定は実フィクスチャ 3 件・recorded・hosted 完全一致の readback 成功。 */
async function harness(over: UniverseOfficialEventsDeps = {}): Promise<Harness> {
  const recorded: Harness["recorded"] = { current: null, calls: [] };
  const listCalls: Harness["listCalls"] = [];
  const downloadCalls: Harness["downloadCalls"] = [];
  const byUrl = new Map<string, Uint8Array>();
  const deps: UniverseOfficialEventsDeps = {
    fetchDelisted: async () =>
      makeFetch("https://www.jpx.co.jp/listing/stocks/delisted/index.html", fixture("delisted"), "2026-09-30T00:00:01.000Z"),
    fetchNewListings: async () =>
      makeFetch("https://www.jpx.co.jp/listing/stocks/new/index.html", fixture("new-listings"), "2026-09-30T00:00:02.000Z"),
    fetchTransfers: async () =>
      makeFetch("https://www.jpx.co.jp/listing/stocks/transfers/index.html", fixture("transfers"), "2026-09-30T00:00:03.000Z"),
    record: (async (input: RecordedInput) => {
      recorded.current = input;
      recorded.calls.push(input);
      byUrl.clear();
      for (const f of input.files) byUrl.set(`https://hosted.test/${f.filename}`, f.bytes);
      return { pageId: "page-1", outcome: "recorded", fileTooLarge: false, manifestMatch: "written" };
    }) as never,
    listFiles: (async (pageId: string, prop: string) => {
      listCalls.push({ pageId, prop });
      const files = recorded.current?.files ?? [];
      return files.map((f) => ({ name: f.filename, url: `https://hosted.test/${f.filename}`, kind: "file" }));
    }) as never,
    downloadBytes: async (url: string) => {
      downloadCalls.push(url);
      const b = byUrl.get(url);
      if (!b) throw new Error(`hosted 不在: ${url}`);
      return Uint8Array.from(b);
    },
    nowIso: () => "2026-09-30T00:00:00.000Z",
    ...over,
  };
  return { deps, recorded, listCalls, downloadCalls };
}

const manifestOf = (h: Harness) => {
  const f = h.recorded.current?.files.find((x) => x.filename === "manifest.json");
  if (!f) throw new Error("manifest なし (内部不整合)");
  return { json: JSON.parse(new TextDecoder().decode(f.bytes)) as Record<string, unknown>, bytes: f.bytes };
};

describe("collectUniverseOfficialEvents 完全形", () => {
  it("実 3 件を exact-4-files custody し、全行 (未来含む) を返す", async () => {
    const h = await harness();
    const got = await collectUniverseOfficialEvents(
      { baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" },
      h.deps
    );
    expect(got.baseAsOf).toBe("2026-08-31");
    expect(got.eligibilityAsOf).toBe("2026-09-29");
    expect(got.eventsFetchedAt).toBe("2026-09-30T00:00:00.000Z");
    expect(got.coverage).toEqual({ years: ["2026"], bootstrapPartial: false });
    expect(got.pageId).toBe("page-1");
    // 実 helper の再計算と一致する full64 eventsSha。
    const wantSha = await sha256Hex(
      got.sources.delisted.rawSha + got.sources.newListings.rawSha + got.sources.transfers.rawSha
    );
    expect(got.eventsSha).toBe(wantSha);
    expect(got.eventsSha).toMatch(/^[0-9a-f]{64}$/);
    // archiveKey 外形 + prefix12 は B helper と一致。
    const prefix = await officialEventsArchiveKey({
      delisted: got.sources.delisted.rawSha,
      newListings: got.sources.newListings.rawSha,
      transfers: got.sources.transfers.rawSha,
    });
    expect(got.archiveKey).toBe(`universe-official-events-2026-08-31-2026-09-29-sha-${prefix}`);
    // 全 current-generation 行 (未来・base 以前を filter しない)。
    expect(got.sources.delisted.rows).toHaveLength(2);
    expect(got.sources.delisted.rows[0]).toMatchObject({ code: "8254", effectiveDate: "2027-03-01" });
    expect(got.sources.newListings.rows).toHaveLength(1);
    expect(got.sources.newListings.rows[0]).toMatchObject({ code: "653A", listingDate: "2026-11-02" });
    expect(got.sources.transfers.rows).toHaveLength(2);
    expect(got.sources.transfers.rows[1]).toMatchObject({ code: "3477", effectiveDate: "2026-09-24" });
    expect(got.sources.delisted.coveredYears).toEqual(["2026"]);
    // 記録は service universe・force false・exact 4 files (固定順・一意)。
    expect(h.recorded.current?.service).toBe("universe");
    expect(h.recorded.current?.force).toBe(false);
    expect(h.recorded.current?.files.map((f) => f.filename)).toEqual([
      "delisted.html",
      "new-listings.html",
      "transfers.html",
      "manifest.json",
    ]);
    // manifest は決定的で時刻・run・ID・署名 URL を含まない。
    const m = manifestOf(h);
    expect(m.json).toMatchObject({
      version: 1,
      complete: true,
      window: { baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" },
      coverage: { years: ["2026"], bootstrapPartial: false },
      failure: null,
    });
    const sources = m.json["sources"] as { key: string; rowCount: number; selectedYear: string }[];
    expect(sources.map((s) => s.key)).toEqual(["delisted", "newListings", "transfers"]);
    expect(sources.map((s) => s.rowCount)).toEqual([2, 1, 2]);
    expect(sources.map((s) => s.selectedYear)).toEqual(["2026", "2026", "2026"]);
    const raw = new TextDecoder().decode(m.bytes);
    for (const banned of ["fetchedAt", "page-1", "hosted.test", "signed", "runId"]) {
      expect(raw).not.toContain(banned);
    }
    // 各 source fetchedAt は metadata 専用。
    expect(h.recorded.current?.metadata["delistedFetchedAt"]).toBe("2026-09-30T00:00:01.000Z");
    expect(h.recorded.current?.metadata["eventsSha"]).toBe(got.eventsSha);
    // 物理 readback (4 件) を経て返す。
    expect(h.listCalls).toEqual([{ pageId: "page-1", prop: "Files" }]);
    expect(h.downloadCalls).toHaveLength(4);
  });

  it("既定 downloader は global fetch で 4 件を読む", async () => {
    const h = await harness({ downloadBytes: undefined });
    // harness の ...over で undefined 上書き → 既定実装を使う。
    delete h.deps.downloadBytes;
    const served = new Map<string, Uint8Array>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const b = served.get(url);
        if (!b) return new Response("ng", { status: 404 });
        return new Response(b as unknown as BodyInit, { status: 200 });
      })
    );
    const origRecord = h.deps.record as never as (i: RecordedInput) => Promise<Record<string, unknown>>;
    h.deps.record = (async (input: RecordedInput) => {
      served.clear();
      for (const f of input.files) served.set(`https://hosted.test/${f.filename}`, f.bytes);
      return origRecord(input);
    }) as never;
    const got = await collectUniverseOfficialEvents(
      { baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" },
      h.deps
    );
    expect(got.sources.transfers.rows).toHaveLength(2);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(4);
  });

  it("同一 window+同一 bytes の再実行は冪等 (key・manifest 同一)", async () => {
    const h1 = await harness({ nowIso: () => "2026-09-30T00:00:00.000Z" });
    const h2 = await harness({ nowIso: () => "2026-09-30T01:00:00.000Z" });
    const in1 = { baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" };
    const r1 = await collectUniverseOfficialEvents(in1, h1.deps);
    const r2 = await collectUniverseOfficialEvents(in1, h2.deps);
    expect(r2.archiveKey).toBe(r1.archiveKey);
    expect(r2.eventsSha).toBe(r1.eventsSha);
    // 時刻が変わっても manifest bytes は同一 (fingerprint のみ時刻を持つ)。
    expect(manifestOf(h2).bytes).toEqual(manifestOf(h1).bytes);
    expect(h2.recorded.current?.fetchedAt).toBe("2026-09-30T01:00:00.000Z");
  });

  it("skipped_existing+same でも受理し、物理 readback を省かない", async () => {
    const h = await harness();
    h.deps.record = (async (input: RecordedInput) => {
      h.recorded.current = input;
      h.recorded.calls.push(input);
      return { pageId: "page-exist", outcome: "skipped_existing", fileTooLarge: false, manifestMatch: "same" };
    }) as never;
    h.deps.downloadBytes = (async (url: string) => {
      const name = url.slice("https://hosted.test/".length);
      const f = h.recorded.current?.files.find((x) => x.filename === name);
      if (!f) throw new Error(`hosted 不在: ${url}`);
      h.downloadCalls.push(url);
      return Uint8Array.from(f.bytes);
    }) as never;
    const got = await collectUniverseOfficialEvents(
      { baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" },
      h.deps
    );
    expect(got.pageId).toBe("page-exist");
    expect(h.listCalls).toEqual([{ pageId: "page-exist", prop: "Files" }]);
    expect(h.downloadCalls).toHaveLength(4);
  });

  it("IPO raw-only 変化は行不変でも sha/key が変わる", async () => {
    const h = await harness();
    const base = await collectUniverseOfficialEvents(
      { baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" },
      h.deps
    );
    const changed = new Uint8Array([...fixture("new-listings"), 0x0a]);
    const h2 = await harness({
      fetchNewListings: async () => makeFetch("https://www.jpx.co.jp/listing/stocks/new/index.html", changed, "2026-09-30T00:00:02.000Z"),
    });
    const got = await collectUniverseOfficialEvents(
      { baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" },
      h2.deps
    );
    expect(got.sources.newListings.rows).toEqual(base.sources.newListings.rows);
    expect(got.sources.newListings.rawSha).not.toBe(base.sources.newListings.rawSha);
    expect(got.eventsSha).not.toBe(base.eventsSha);
    expect(got.archiveKey).not.toBe(base.archiveKey);
  });

  it("base=null は bootstrap partial を明示する", async () => {
    const h = await harness();
    const got = await collectUniverseOfficialEvents({ baseAsOf: null, eligibilityAsOf: "2026-09-29" }, h.deps);
    expect(got.coverage).toEqual({ years: ["2026"], bootstrapPartial: true });
    expect(got.archiveKey).toContain("universe-official-events-bootstrap-2026-09-29-sha-");
    expect(manifestOf(h).json).toMatchObject({
      complete: true,
      window: { baseAsOf: null, eligibilityAsOf: "2026-09-29" },
      coverage: { years: ["2026"], bootstrapPartial: true },
    });
  });

  it("nowIso 既定は ISO 時刻を使う", async () => {
    const h = await harness();
    delete h.deps.nowIso;
    const got = await collectUniverseOfficialEvents(
      { baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" },
      h.deps
    );
    expect(got.eventsFetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("入力検証 (IO 前 STOP)", () => {
  it("base==elig は throw し、fetch を呼ばない", async () => {
    const h = await harness({
      fetchDelisted: vi.fn(async () => { throw new Error("呼ばないこと"); }),
      fetchNewListings: vi.fn(async () => { throw new Error("呼ばないこと"); }),
      fetchTransfers: vi.fn(async () => { throw new Error("呼ばないこと"); }),
    });
    await expect(
      collectUniverseOfficialEvents({ baseAsOf: "2026-09-29", eligibilityAsOf: "2026-09-29" }, h.deps)
    ).rejects.toThrow(/被覆窓不正/);
    expect(h.deps.fetchDelisted).not.toHaveBeenCalled();
    expect(h.deps.fetchNewListings).not.toHaveBeenCalled();
    expect(h.deps.fetchTransfers).not.toHaveBeenCalled();
    expect(h.recorded.calls).toHaveLength(0);
  });

  it("非厳密日は throw し、fetch を呼ばない", async () => {
    const h = await harness();
    const fetchSpy = vi.fn(h.deps.fetchDelisted as () => Promise<never>);
    h.deps.fetchDelisted = fetchSpy as never;
    await expect(
      collectUniverseOfficialEvents({ baseAsOf: "2026-08-31", eligibilityAsOf: "2026-02-30" }, h.deps)
    ).rejects.toThrow(/厳密実在日/);
    await expect(
      collectUniverseOfficialEvents({ baseAsOf: "2026/08/31", eligibilityAsOf: "2026-09-29" }, h.deps)
    ).rejects.toThrow(/厳密実在日/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("incomplete custody (partial-success 返却なし)", () => {
  it("年被覆 HOLD は complete を返さず、known-raw-only custody して throw する", async () => {
    const h = await harness();
    const err = await collectUniverseOfficialEvents(
      { baseAsOf: "2025-12-15", eligibilityAsOf: "2026-01-10" },
      h.deps
    ).catch((e: unknown) => e);
    expect(String(err)).toMatch(/HOLD 年被覆不足/);
    expect(String(err)).toMatch(/incomplete custody 済み/);
    // 3 raw + manifest (全 fetch 成功のため known 3 件)。
    expect(h.recorded.calls).toHaveLength(1);
    expect(h.recorded.current?.files.map((f) => f.filename)).toEqual([
      "delisted.html",
      "new-listings.html",
      "transfers.html",
      "manifest.json",
    ]);
    const m = manifestOf(h).json as {
      complete: boolean;
      failure: { stage: string; sources: string[] };
      sources: { key: string; status: string; httpStatus: number | null }[];
    };
    expect(m.complete).toBe(false);
    expect(m.failure).toEqual({ stage: "parse", sources: ["delisted"] });
    expect(m.sources[0]).toMatchObject({ key: "delisted", status: "parse-failed", httpStatus: 200 });
    // 先行 break で未試行の source は unparsed (parse 失敗の捏造なし)。
    expect(m.sources[1]).toMatchObject({ key: "newListings", status: "unparsed" });
    expect(m.sources[2]).toMatchObject({ key: "transfers", status: "unparsed" });
    // incomplete key は -incomplete-<manifest署名> 付きで完全形と衝突しない。
    expect(h.recorded.current?.key).toMatch(/-incomplete-[0-9a-f]{12}$/);
    // readback も行う (incomplete でも物理確認なしに throw しない)。
    expect(h.listCalls).toHaveLength(1);
    expect(h.downloadCalls).toHaveLength(4);
  });

  it("same-3-raw の parse 失敗後に完全形が来ても key は衝突しない", async () => {
    const h = await harness();
    await collectUniverseOfficialEvents(
      { baseAsOf: "2025-12-15", eligibilityAsOf: "2026-01-10" },
      h.deps
    ).catch(() => null);
    const incompleteKey = h.recorded.current?.key ?? "";
    // key suffix は manifest 全 bytes の署名 (実 helper で再計算一致)。
    const mBytes = manifestOf(h).bytes;
    const sig = (await sha256HexBytes(Uint8Array.from(mBytes))).slice(0, 12);
    expect(incompleteKey.endsWith(`-incomplete-${sig}`)).toBe(true);
    const h2 = await harness();
    const complete = await collectUniverseOfficialEvents(
      { baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" },
      h2.deps
    );
    expect(complete.archiveKey).not.toBe(incompleteKey);
    expect(complete.archiveKey).not.toContain("-incomplete-");
  });

  it("volatile な例外文が違っても manifest/key は決定的 (詳細は metadata)", async () => {
    const run = async (message: string) => {
      const hh = await harness({
        fetchDelisted: async () => { throw new Error(message); },
      });
      await collectUniverseOfficialEvents(
        { baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" },
        hh.deps
      ).catch(() => null);
      return hh;
    };
    const h1 = await run("delisted GET 非200: status=500");
    const h2 = await run("fetch failed: socket reset by peer after 30012ms");
    expect(manifestOf(h2).bytes).toEqual(manifestOf(h1).bytes);
    expect(h2.recorded.current?.key).toBe(h1.recorded.current?.key);
    // 診断詳細は metadata 側に残る (manifest には載らない)。
    expect(h2.recorded.current?.metadata["failure"]).not.toBe(h1.recorded.current?.metadata["failure"]);
    const raw = new TextDecoder().decode(manifestOf(h1).bytes);
    expect(raw).not.toContain("status=500");
    expect(raw).not.toContain("socket");
  });

  it("元 buffer の後発 mutation は owned copy に影響しない", async () => {
    const h = await harness();
    const orig = Uint8Array.from(fixture("delisted"));
    const sha = await sha256HexBytes(Uint8Array.from(orig));
    h.deps.fetchDelisted = (async () => ({
      url: "https://www.jpx.co.jp/listing/stocks/delisted/index.html",
      fetchedAt: "2026-09-30T00:00:01.000Z",
      status: 200,
      bytes: orig,
      sha256: sha,
    })) as never;
    const got = await collectUniverseOfficialEvents(
      { baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" },
      h.deps
    );
    expect(got.sources.delisted.rows).toHaveLength(2);
    orig.fill(0x41);
    const recorded = h.recorded.current?.files.find((f) => f.filename === "delisted.html");
    expect(recorded?.bytes).toEqual(fixture("delisted"));
  });

  it("404 の valid 表は原文どおり custody して reject する (complete 扱いしない)", async () => {
    const h = await harness({
      fetchDelisted: async () =>
        makeFetch("https://www.jpx.co.jp/listing/stocks/delisted/index.html", fixture("delisted"), "2026-09-30T00:00:01.000Z", 404),
    });
    const err = await collectUniverseOfficialEvents(
      { baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" },
      h.deps
    ).catch((e: unknown) => e);
    expect(String(err)).toMatch(/HTTP 404/);
    // 非 200 raw も原文どおり custody される。
    expect(h.recorded.current?.files.map((f) => f.filename)).toEqual([
      "delisted.html",
      "new-listings.html",
      "transfers.html",
      "manifest.json",
    ]);
    const recorded = h.recorded.current?.files.find((f) => f.filename === "delisted.html");
    expect(recorded?.bytes).toEqual(fixture("delisted"));
    const m = manifestOf(h).json as {
      failure: { stage: string; sources: string[] };
      sources: { key: string; status: string; httpStatus: number | null; sha256: string | null; rowCount: number | null }[];
    };
    expect(m.failure).toEqual({ stage: "http", sources: ["delisted"] });
    expect(m.sources[0]?.status).toBe("http-failed");
    expect(m.sources[0]?.httpStatus).toBe(404);
    expect(m.sources[0]?.rowCount).toBeNull();
    expect(typeof m.sources[0]?.sha256).toBe("string");
    expect(h.recorded.current?.key).toMatch(/-incomplete-[0-9a-f]{12}$/);
  });

  it("1 fetch 失敗は残り 2 raw を custody し、manifest は決定的", async () => {
    const h = await harness({
      fetchDelisted: async () => { throw new Error("delisted GET 非200: status=500"); },
    });
    const err = await collectUniverseOfficialEvents(
      { baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" },
      h.deps
    ).catch((e: unknown) => e);
    expect(String(err)).toMatch(/delisted GET 非200/);
    expect(h.recorded.current?.files.map((f) => f.filename)).toEqual([
      "new-listings.html",
      "transfers.html",
      "manifest.json",
    ]);
    const m = manifestOf(h).json as {
      complete: boolean;
      failure: { stage: string; sources: string[] };
      sources: { key: string; status: string; httpStatus: number | null }[];
    };
    expect(m.complete).toBe(false);
    expect(m.failure).toEqual({ stage: "fetch", sources: ["delisted"] });
    expect(m.sources.map((s) => `${s.key}:${s.status}`)).toEqual([
      "delisted:fetch-failed",
      "newListings:ok",
      "transfers:ok",
    ]);
    // network throw (body なし) は missing のまま。捏造しない。
    expect(m.sources[0]).toMatchObject({ httpStatus: null });
    // 同一 bytes の再実行は同一 key・同一 manifest (冪等)。
    const h2 = await harness({
      fetchDelisted: async () => { throw new Error("delisted GET 非200: status=500"); },
      nowIso: () => "2026-09-30T05:00:00.000Z",
    });
    await collectUniverseOfficialEvents(
      { baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" },
      h2.deps
    ).catch(() => null);
    expect(h2.recorded.current?.key).toBe(h.recorded.current?.key);
    expect(manifestOf(h2).bytes).toEqual(manifestOf(h).bytes);
  });

  it("全 fetch 失敗は custody なしで throw する (捏造なし)", async () => {
    const boom = async () => { throw new Error("GET 非200: status=500"); };
    const h = await harness({ fetchDelisted: boom, fetchNewListings: boom, fetchTransfers: boom });
    await expect(
      collectUniverseOfficialEvents({ baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" }, h.deps)
    ).rejects.toThrow(/検証済み raw 0/);
    expect(h.recorded.calls).toHaveLength(0);
    expect(h.listCalls).toHaveLength(0);
  });

  it("sha 再計算不一致の bytes は隔離し、custody から外す", async () => {
    const bad = await makeFetch("https://www.jpx.co.jp/listing/stocks/delisted/index.html", fixture("delisted"), "2026-09-30T00:00:01.000Z");
    const h = await harness({
      fetchDelisted: async () => ({ ...bad, sha256: "0".repeat(64) }),
    });
    const err = await collectUniverseOfficialEvents(
      { baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" },
      h.deps
    ).catch((e: unknown) => e);
    expect(String(err)).toMatch(/sha 再計算不一致/);
    expect(h.recorded.current?.files.map((f) => f.filename)).toEqual([
      "new-listings.html",
      "transfers.html",
      "manifest.json",
    ]);
    const m = manifestOf(h).json as {
      failure: { stage: string; sources: string[] };
      sources: { key: string; status: string; sha256: string | null; httpStatus: number | null }[];
    };
    expect(m.failure).toEqual({ stage: "integrity", sources: ["delisted"] });
    expect(m.sources[0]).toMatchObject({ key: "delisted", status: "sha-mismatch", sha256: null, httpStatus: 200 });
  });

  it("parse 失敗 raw は verified のまま custody に含める (title 不一致)", async () => {
    const garbage = new TextEncoder().encode("<html><head><title>別制度</title></head><body></body></html>");
    const h = await harness({
      fetchTransfers: async () => makeFetch("https://www.jpx.co.jp/listing/stocks/transfers/index.html", garbage, "2026-09-30T00:00:03.000Z"),
    });
    const err = await collectUniverseOfficialEvents(
      { baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" },
      h.deps
    ).catch((e: unknown) => e);
    expect(String(err)).toMatch(/<title> 不一致/);
    expect(h.recorded.current?.files.map((f) => f.filename)).toEqual([
      "delisted.html",
      "new-listings.html",
      "transfers.html",
      "manifest.json",
    ]);
    const m = manifestOf(h).json as { sources: { key: string; status: string }[] };
    expect(m.sources[2]).toMatchObject({ key: "transfers", status: "parse-failed" });
  });
});

describe("custody 受理・物理 readback", () => {
  it("Unknown は再送せず STOP する", async () => {
    const record = vi.fn(async () => { throw new NotionUnknownResultError("POST 応答不明"); });
    const h = await harness({ record: record as never });
    await expect(
      collectUniverseOfficialEvents({ baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" }, h.deps)
    ).rejects.toThrow(/POST 応答不明/);
    expect(record).toHaveBeenCalledTimes(1);
    expect(h.listCalls).toHaveLength(0);
  });

  it("fileTooLarge・skipped_existing+unknown は受理しない", async () => {
    const h1 = await harness({
      record: (async () => ({ pageId: "p", outcome: "recorded", fileTooLarge: true, manifestMatch: "written" })) as never,
    });
    await expect(
      collectUniverseOfficialEvents({ baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" }, h1.deps)
    ).rejects.toThrow(/fileTooLarge/);
    const h2 = await harness({
      record: (async () => ({ pageId: "p", outcome: "skipped_existing", fileTooLarge: false, manifestMatch: "unknown" })) as never,
    });
    await expect(
      collectUniverseOfficialEvents({ baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" }, h2.deps)
    ).rejects.toThrow(/manifestMatch=unknown/);
  });

  it("添付の欠落・重複・外部参照は throw する", async () => {
    const h = await harness({
      listFiles: (async () => [
        { name: "delisted.html", url: "https://hosted.test/delisted.html", kind: "file" },
        { name: "new-listings.html", url: "https://hosted.test/new-listings.html", kind: "file" },
        { name: "transfers.html", url: "https://hosted.test/transfers.html", kind: "file" },
      ]) as never,
    });
    await expect(
      collectUniverseOfficialEvents({ baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" }, h.deps)
    ).rejects.toThrow(/添付 3 件/);
    const h2 = await harness({
      listFiles: (async () => [
        { name: "delisted.html", url: "https://hosted.test/a", kind: "file" },
        { name: "delisted.html", url: "https://hosted.test/b", kind: "file" },
        { name: "transfers.html", url: "https://hosted.test/c", kind: "file" },
        { name: "manifest.json", url: "https://hosted.test/d", kind: "file" },
      ]) as never,
    });
    await expect(
      collectUniverseOfficialEvents({ baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" }, h2.deps)
    ).rejects.toThrow(/なし|重複/);
    const h3 = await harness({
      listFiles: (async (_pageId: string) => [
        { name: "delisted.html", url: "https://hosted.test/delisted.html", kind: "file" },
        { name: "new-listings.html", url: "https://hosted.test/new-listings.html", kind: "file" },
        { name: "transfers.html", url: "https://hosted.test/transfers.html", kind: "file" },
        { name: "manifest.json", url: "https://external.test/m", kind: "external" },
      ]) as never,
    });
    await expect(
      collectUniverseOfficialEvents({ baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" }, h3.deps)
    ).rejects.toThrow(/hosted/);
  });

  it("再取得の長さ・SHA 不一致は throw する", async () => {
    const h = await harness({
      downloadBytes: async (_url: string) => new TextEncoder().encode("short"),
    });
    await expect(
      collectUniverseOfficialEvents({ baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" }, h.deps)
    ).rejects.toThrow(/バイト長/);
    const h2 = await harness();
    const orig = h2.deps.downloadBytes as (url: string) => Promise<Uint8Array>;
    h2.deps.downloadBytes = (async (url: string) => {
      const b = await orig(url);
      const tampered = Uint8Array.from(b);
      tampered[0] = (tampered[0] as number) ^ 0xff;
      return tampered;
    }) as never;
    await expect(
      collectUniverseOfficialEvents({ baseAsOf: "2026-08-31", eligibilityAsOf: "2026-09-29" }, h2.deps)
    ).rejects.toThrow(/SHA256 不一致/);
  });
});
