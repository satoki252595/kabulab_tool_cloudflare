/**
 * Custody-query runner round1 の offline 検証 (hermetic・送信 0)。
 * /tmp pins・env・network を使わない。packet SHA 付きの実 preflight は
 * canonical env で別途検証する。
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertFreshOutDir,
  assertPacketShape,
  assertRequestBindings,
  createReadOnlyGuardFetch,
  dashless,
  deriveChunkBodySHAs,
  HoldError,
  isAllowedRoute,
  loadPacket,
  requireGrant,
  requireRound,
  ROUNDS,
  saveBodyWx,
  type GuardBindings,
  type GuardCounters,
} from "../../data-scripts/overseas-custody-query.js";
import { checkDocsCustody, edinetArchiveKey } from "../services/edinet/archive.js";

const ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90a";
const U = (s: string) => new URL(s);
const keyFn = (d: string, t: 1 | 5) => `${d}:type${t}`;
const shaOf = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const BIND: GuardBindings = {
  chunkBodySHAs: deriveChunkBodySHAs(["S1000000X"], keyFn),
  typedParentDashless: dashless(ID),
  expectedTitle: "一次データ｜yuho-quant",
};

describe("grant-first / OUT-freshness", () => {
  it("grant なしは HOLD", () => {
    expect(() => requireGrant(["node", "x.js"])).toThrow(HoldError);
    expect(requireGrant(["node", "x.js", "--grant=g"])).toBe("g");
  });

  it("既存 OUT は拒否・不存在は通過", () => {
    const dir = mkdtempSync(join(tmpdir(), "custody-test-"));
    expect(() => assertFreshOutDir(dir)).toThrow(HoldError);
    expect(() => assertFreshOutDir(join(dir, "fresh"))).not.toThrow();
  });
});

describe("read-only allow-list", () => {
  it("round1 到達の4経路のみ許可", () => {
    expect(isAllowedRoute("POST", U("https://api.notion.com/v1/search"))).toBe(true);
    expect(isAllowedRoute("POST", U(`https://api.notion.com/v1/databases/${ID}/query`))).toBe(true);
    expect(isAllowedRoute("GET", U(`https://api.notion.com/v1/databases/${ID}`))).toBe(true);
    expect(isAllowedRoute("GET", U(`https://api.notion.com/v1/blocks/${ID}/children`))).toBe(true);
    expect(
      isAllowedRoute("GET", U(`https://api.notion.com/v1/blocks/${ID}/children?page_size=100&start_cursor=abc`))
    ).toBe(true);
  });

  it("CREATE/PATCH/DELETE・形状外は拒否", () => {
    // CREATE 経路
    expect(isAllowedRoute("POST", U("https://api.notion.com/v1/databases"))).toBe(false);
    expect(isAllowedRoute("POST", U("https://api.notion.com/v1/pages"))).toBe(false);
    // mutation verbs
    expect(isAllowedRoute("PATCH", U(`https://api.notion.com/v1/databases/${ID}`))).toBe(false);
    expect(isAllowedRoute("DELETE", U(`https://api.notion.com/v1/blocks/${ID}`))).toBe(false);
    // 形状外
    expect(isAllowedRoute("POST", U("https://api.notion.com/v1/search?x=1"))).toBe(false);
    expect(isAllowedRoute("POST", U("https://api.notion.com/v1/databases//query"))).toBe(false);
    expect(isAllowedRoute("POST", U("https://api.notion.com/v1/databases/short/query"))).toBe(false);
    expect(isAllowedRoute("GET", U(`https://api.notion.com/v1/databases/${ID}/query`))).toBe(false);
    expect(isAllowedRoute("GET", U(`https://api.notion.com/v1/blocks/${ID}/children?evil=1`))).toBe(false);
    // host/proto 外
    expect(isAllowedRoute("POST", U("https://evil.example.com/v1/search"))).toBe(false);
    expect(isAllowedRoute("POST", U("http://api.notion.com/v1/search"))).toBe(false);
  });
});

describe("bindings (body/query exact)", () => {
  const qurl = U(`https://api.notion.com/v1/databases/${ID}/query`);
  // helper 送信形の独立リテラル (導出関数を使わない)。
  const qbody = JSON.stringify({
    filter: {
      or: [
        { property: "Key", title: { equals: "S1000000X:type1" } },
        { property: "Key", title: { equals: "S1000000X:type5" } },
      ],
    },
    page_size: 41,
  });
  const surl = U("https://api.notion.com/v1/search");
  const sbody = JSON.stringify({
    query: "一次データ｜yuho-quant",
    filter: { property: "object", value: "database" },
    page_size: 100,
  });

  it("固定値一致は通過・DB pin は初回確定", () => {
    expect(shaOf(qbody)).toBe(BIND.chunkBodySHAs[0]);
    expect(assertRequestBindings("POST", qurl, { method: "POST", body: qbody }, BIND, null, 0)).toBe(ID);
    expect(assertRequestBindings("POST", qurl, { method: "POST", body: qbody }, BIND, ID, 0)).toBe(ID);
    expect(assertRequestBindings("POST", surl, { method: "POST", body: sbody }, BIND, null, 0)).toBeNull();
    expect(
      assertRequestBindings("GET", U(`https://api.notion.com/v1/blocks/${ID}/children?page_size=100`), undefined, BIND, null, 0)
    ).toBeNull();
    expect(assertRequestBindings("GET", U(`https://api.notion.com/v1/databases/${ID}`), undefined, BIND, ID, 0)).toBe(ID);
  });

  it("非exact-chunk (subset/oversized/範囲外/余分key/順序入替/超過) は HOLD", () => {
    const base = JSON.parse(qbody) as { filter: { or: unknown[] }; page_size: number };
    const or = base.filter.or as Array<Record<string, unknown>>;
    const variant = (o: unknown[], extra?: Record<string, unknown>) =>
      JSON.stringify({ filter: { or: o }, page_size: 41, ...extra });
    // subset (type5 欠落)
    expect(() => assertRequestBindings("POST", qurl, { method: "POST", body: variant(or.slice(0, 1)) }, BIND, null, 0)).toThrow(HoldError);
    // oversized (重複追加)
    expect(() => assertRequestBindings("POST", qurl, { method: "POST", body: variant([...or, or[0]]) }, BIND, null, 0)).toThrow(HoldError);
    // 範囲外 key
    const outside = JSON.parse(JSON.stringify(or)) as Array<Record<string, { equals: string }>>;
    outside[0].title.equals = "ZZZ:type1";
    expect(() => assertRequestBindings("POST", qurl, { method: "POST", body: variant(outside) }, BIND, null, 0)).toThrow(HoldError);
    // 余分 top-level key
    expect(() => assertRequestBindings("POST", qurl, { method: "POST", body: variant(or, { start_cursor: "x" }) }, BIND, null, 0)).toThrow(HoldError);
    // 順序入替 (type5→type1)
    expect(() => assertRequestBindings("POST", qurl, { method: "POST", body: variant([or[1], or[0]]) }, BIND, null, 0)).toThrow(HoldError);
    // page_size 違い
    const badPage = JSON.stringify({ filter: { or }, page_size: 42 });
    expect(() => assertRequestBindings("POST", qurl, { method: "POST", body: badPage }, BIND, null, 0)).toThrow(HoldError);
    // chunk 超過 (当該 0 のみ有効・1 は存在しない)
    expect(() => assertRequestBindings("POST", qurl, { method: "POST", body: qbody }, BIND, null, 1)).toThrow(HoldError);
    // 健全性: 無変更の再 serialize は通過する
    expect(assertRequestBindings("POST", qurl, { method: "POST", body: variant(or) }, BIND, null, 0)).toBe(ID);
  });

  it("drift・未 pin・非固定値は HOLD", () => {
    const other = "b1b2c3d4e5f60718293a4b5c6d7e8f90b";
    expect(() => assertRequestBindings("POST", qurl, { method: "POST", body: qbody }, BIND, other, 0)).toThrow(HoldError);
    expect(() => assertRequestBindings("GET", U(`https://api.notion.com/v1/databases/${ID}`), undefined, BIND, null, 0)).toThrow(HoldError);
    const badTitle = JSON.stringify({
      query: "別物",
      filter: { property: "object", value: "database" },
      page_size: 100,
    });
    expect(() => assertRequestBindings("POST", surl, { method: "POST", body: badTitle }, BIND, null, 0)).toThrow(HoldError);
    expect(
      () => assertRequestBindings("GET", U(`https://api.notion.com/v1/blocks/${other}/children`), undefined, BIND, null, 0)
    ).toThrow(HoldError);
  });
});

describe("guard (native 前・deny 到達なし)", () => {
  const sbody = JSON.stringify({
    query: "一次データ｜yuho-quant",
    filter: { property: "object", value: "database" },
    page_size: 100,
  });

  it("deny は native 未到達・cap 超過も拒否", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custody-test-"));
    let native = 0;
    const inner = (async () => {
      native += 1;
      return new Response("{}");
    }) as typeof fetch;
    const counters: GuardCounters = { attempts: 0, rejected: 0, querySuccess: 0 };
    const g = createReadOnlyGuardFetch(inner, dir, counters, 1, BIND);
    // 許可経路は通る
    await g("https://api.notion.com/v1/search", { method: "POST", body: sbody });
    expect(native).toBe(1);
    expect(counters.attempts).toBe(1);
    // CREATE は native 未到達で拒否
    await expect(g("https://api.notion.com/v1/databases", { method: "POST", body: "{}" })).rejects.toThrow(
      HoldError
    );
    expect(native).toBe(1);
    expect(counters.rejected).toBe(1);
    // cap 到達後の許可経路も拒否
    await expect(g("https://api.notion.com/v1/search", { method: "POST", body: sbody })).rejects.toThrow(
      HoldError
    );
    expect(native).toBe(1);
    expect(counters.rejected).toBe(2);
  });

  it("redirect manual 強制・3xx は body 保存後に follow せず STOP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custody-test-"));
    let seenRedirect: unknown = null;
    let native = 0;
    const inner = (async (_u: unknown, init?: RequestInit) => {
      native += 1;
      seenRedirect = init?.redirect;
      return new Response("moved", { status: 301, headers: { location: "https://evil.example.com/" } });
    }) as typeof fetch;
    const counters: GuardCounters = { attempts: 0, rejected: 0, querySuccess: 0 };
    const g = createReadOnlyGuardFetch(inner, dir, counters, 96, BIND);
    await expect(g("https://api.notion.com/v1/search", { method: "POST", body: sbody })).rejects.toThrow(
      /3xx/
    );
    expect(native).toBe(1);
    expect(seenRedirect).toBe("manual");
    expect(counters.attempts).toBe(1);
    // 失敗 response も証跡: 全 body + status を判定前に保存する
    const { readFileSync, statSync } = await import("node:fs");
    expect(readFileSync(join(dir, "attempt-001-search.bin"), "utf8")).toBe("moved");
    expect(statSync(join(dir, "attempt-001-search.bin")).mode & 0o777).toBe(0o600);
  });

  it("同一 response を clone 保存し、原本を呼出側へ返す", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custody-test-"));
    const inner = (async () =>
      new Response(JSON.stringify({ a: 1, n: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const counters: GuardCounters = { attempts: 0, rejected: 0, querySuccess: 0 };
    const g = createReadOnlyGuardFetch(inner, dir, counters, 96, BIND);
    const res = await g("https://api.notion.com/v1/search", { method: "POST", body: sbody });
    expect(await res.json()).toEqual({ a: 1, n: null });
    const { readFileSync, statSync } = await import("node:fs");
    const saved = readFileSync(join(dir, "attempt-001-search.bin"), "utf8");
    expect(JSON.parse(saved)).toEqual({ a: 1, n: null });
    expect(statSync(join(dir, "attempt-001-search.bin")).mode & 0o777).toBe(0o600);
  });

  it("native 到達失敗は HOLD・body なし", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custody-test-"));
    const inner = (async () => {
      throw new Error("boom");
    }) as typeof fetch;
    const counters: GuardCounters = { attempts: 0, rejected: 0, querySuccess: 0 };
    const g = createReadOnlyGuardFetch(inner, dir, counters, 96, BIND);
    await expect(g("https://api.notion.com/v1/search", { method: "POST", body: sbody })).rejects.toThrow(
      HoldError
    );
    expect(counters.attempts).toBe(1);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "attempt-001-search.bin"))).toBe(false);
  });
});

describe("saveBodyWx", () => {
  it("wx 単一書込・0600・SHA 返却", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custody-test-"));
    const sha = saveBodyWx(dir, "x.bin", new Uint8Array([1, 2, 3]));
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(() => saveBodyWx(dir, "x.bin", new Uint8Array([9]))).toThrow();
    const { statSync } = await import("node:fs");
    expect(statSync(join(dir, "x.bin")).mode & 0o777).toBe(0o600);
  });
});

describe("packet (hash-first・形状証明)", () => {
  const docs = Array.from({ length: 20 }, (_, i) => `S10${String(i).padStart(4, "0")}X`);

  it("40 keys・20 通・対・再導出が揃う packet のみ通過", () => {
    const keys = docs.flatMap((d) => [keyFn(d, 1), keyFn(d, 5)]);
    const p = assertPacketShape({ service: "yuho-quant", keys }, keyFn);
    expect(p.docs).toHaveLength(20);
    expect(p.keys).toHaveLength(40);
  });

  it("keys 数外・対欠落・形状外・再導出不一致は HOLD", () => {
    const keys = docs.flatMap((d) => [keyFn(d, 1), keyFn(d, 5)]);
    expect(() => assertPacketShape({ service: "yuho-quant", keys: keys.slice(0, 39) }, keyFn)).toThrow(
      HoldError
    );
    expect(() =>
      assertPacketShape({ service: "yuho-quant", keys: [...keys.slice(0, 39), keys[0]] }, keyFn)
    ).toThrow(HoldError);
    expect(() =>
      assertPacketShape({ service: "yuho-quant", keys: [...keys.slice(1), "BADKEY"] }, keyFn)
    ).toThrow(HoldError);
    expect(() => assertPacketShape({ service: "other", keys }, keyFn)).toThrow(HoldError);
    expect(() => assertPacketShape({ service: "yuho-quant", keys }, () => "WRONG")).toThrow(HoldError);
    expect(() => assertPacketShape(null, keyFn)).toThrow(HoldError);
  });

  it("rest 規模 (3655/7310) の形状証明が通る", () => {
    const docs = Array.from({ length: 3655 }, (_, i) => `S${String(i).padStart(6, "0")}X`);
    const keys = docs.flatMap((d) => [keyFn(d, 1), keyFn(d, 5)]);
    const p = assertPacketShape({ service: "yuho-quant", keys }, keyFn, 3655, 7310);
    expect(p.docs).toHaveLength(3655);
    expect(p.keys).toHaveLength(7310);
    expect(() => assertPacketShape({ service: "yuho-quant", keys: keys.slice(0, 7308) }, keyFn, 3655, 7310)).toThrow(
      HoldError
    );
  });

  it("SHA 一致の packet は読込通過する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custody-test-"));
    const { createHash } = await import("node:crypto");
    const keys = Array.from({ length: 20 }, (_, i) => `S10${String(i).padStart(4, "0")}X`).flatMap((d) => [
      keyFn(d, 1),
      keyFn(d, 5),
    ]);
    const good = join(dir, "good.json");
    const data = JSON.stringify({ service: "yuho-quant", keys });
    writeFileSync(good, data);
    const sha = createHash("sha256").update(data).digest("hex");
    const cfg = { round: "t", docs: 20, keys: 40, chunks: 1, cap: 96, packet: good, packetSHA: sha, outDir: dir };
    expect(loadPacket(cfg, keyFn).docs).toHaveLength(20);
  });

  it("pin 外 SHA・不在 packet は HOLD", () => {
    const dir = mkdtempSync(join(tmpdir(), "custody-test-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ service: "yuho-quant", keys: [] }));
    const cfg = { round: "t", docs: 0, keys: 0, chunks: 0, cap: 0, packet: bad, packetSHA: "0".repeat(64), outDir: dir };
    // SHA 不一致で落ちる (形状検証に到達しない)
    expect(() => loadPacket(cfg, keyFn)).toThrow(HoldError);
    expect(() => loadPacket({ ...cfg, packet: join(dir, "absent.json") }, keyFn)).toThrow(HoldError);
  });
});

describe("rounds (closed・明示指定)", () => {
  it("round 定義は固定値 (1: 20/40/1/96・rest: 3655/7310/183/1351)", () => {
    expect(ROUNDS["1"]).toMatchObject({ docs: 20, keys: 40, chunks: 1, cap: 96 });
    expect(ROUNDS["rest"]).toMatchObject({ docs: 3655, keys: 7310, chunks: 183, cap: 1351 });
    expect(183 * 40 - 7310).toBe(10); // 末尾 30 keys (40-10)
  });

  it("--round 明示のみ通過・不明は HOLD", () => {
    expect(requireRound(["node", "x.js", "--round=1"]).round).toBe("1");
    expect(requireRound(["node", "x.js", "--round=rest"]).round).toBe("rest");
    expect(() => requireRound(["node", "x.js"])).toThrow(HoldError);
    expect(() => requireRound(["node", "x.js", "--round=all"])).toThrow(HoldError);
  });
});

describe("exact-chunk guard (actual helper bytes・hermetic)", () => {
  const PARENT = "f1f2f3f4-f5f6-0708-1829-3a4b5c6d7e8f";
  const DBID = "d1d2d3d4-d5d6-0708-1829-3a4b5c6d7e8f";

  it("実 helper 送信 bytes が事前導出 chunk SHA と一致し、2 chunk 成功する", async () => {
    const docs = Array.from({ length: 21 }, (_, i) => `S1${String(i).padStart(6, "0")}`);
    const shas = deriveChunkBodySHAs(docs, edinetArchiveKey);
    expect(shas).toHaveLength(2);
    const bindings: GuardBindings = {
      chunkBodySHAs: shas,
      typedParentDashless: dashless(PARENT),
      expectedTitle: "一次データ｜yuho-quant",
    };
    const dir = mkdtempSync(join(tmpdir(), "custody-test-"));
    const counters: GuardCounters = { attempts: 0, rejected: 0, querySuccess: 0 };
    const queryBodies: string[] = [];
    const inner = (async (u: unknown, init?: RequestInit) => {
      const url = new URL(String(u));
      if (url.pathname === "/v1/search") {
        const q = (JSON.parse(String(init?.body)) as { query: string }).query;
        return new Response(
          JSON.stringify({
            results: [
              {
                object: "database",
                id: DBID,
                title: q,
                parent: { type: "page_id", page_id: PARENT },
                created_time: "2026-01-01T00:00:00.000Z",
              },
            ],
            has_more: false,
            next_cursor: null,
          })
        );
      }
      if (url.pathname.endsWith("/query")) {
        queryBodies.push(String(init?.body));
        return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }));
      }
      return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }));
    }) as typeof fetch;
    const g = createReadOnlyGuardFetch(inner, dir, counters, 96, bindings);
    const prevFetch = globalThis.fetch;
    const prevToken = process.env["NOTION_TOKEN"];
    const prevParent = process.env["NOTION_ARCHIVE_PAGE_ID"];
    process.env["NOTION_TOKEN"] = "test-token";
    process.env["NOTION_ARCHIVE_PAGE_ID"] = PARENT;
    try {
      globalThis.fetch = g;
      const verdicts = await checkDocsCustody("yuho-quant", docs);
      expect(verdicts.size).toBe(21);
      for (const v of verdicts.values()) expect(v).toEqual({ t1: "missing", t5: "missing" });
    } finally {
      globalThis.fetch = prevFetch;
      if (prevToken === undefined) delete process.env["NOTION_TOKEN"];
      else process.env["NOTION_TOKEN"] = prevToken;
      if (prevParent === undefined) delete process.env["NOTION_ARCHIVE_PAGE_ID"];
      else process.env["NOTION_ARCHIVE_PAGE_ID"] = prevParent;
    }
    // 実 helper の送信 bytes (素通し) が事前導出と一致する
    expect(queryBodies).toHaveLength(2);
    expect(shaOf(queryBodies[0])).toBe(shas[0]);
    expect(shaOf(queryBodies[1])).toBe(shas[1]);
    expect(counters.querySuccess).toBe(2);
    expect(counters.rejected).toBe(0);
  });

  it("同一 chunk 再送は成功まで許可・前進後の再送と変造 body は拒否", async () => {
    const dir = mkdtempSync(join(tmpdir(), "custody-test-"));
    const counters: GuardCounters = { attempts: 0, rejected: 0, querySuccess: 0 };
    const statuses = [500, 200];
    let native = 0;
    const inner = (async () => {
      native += 1;
      const st = statuses.shift() ?? 200;
      return new Response(JSON.stringify({ results: [], has_more: false }), { status: st });
    }) as typeof fetch;
    const g = createReadOnlyGuardFetch(inner, dir, counters, 96, BIND);
    const qbody = JSON.stringify({
      filter: {
        or: [
          { property: "Key", title: { equals: "S1000000X:type1" } },
          { property: "Key", title: { equals: "S1000000X:type5" } },
        ],
      },
      page_size: 41,
    });
    const qurl = `https://api.notion.com/v1/databases/${ID}/query`;
    // 1 回目 500: 前進しない
    await g(qurl, { method: "POST", body: qbody });
    expect(counters.querySuccess).toBe(0);
    // 同一 chunk 再送 → 200 で前進
    await g(qurl, { method: "POST", body: qbody });
    expect(counters.querySuccess).toBe(1);
    expect(native).toBe(2);
    // 前進後の同一 body 再送は拒否 (native 未到達)
    await expect(g(qurl, { method: "POST", body: qbody })).rejects.toThrow(HoldError);
    expect(native).toBe(2);
    // 変造 body は別 guard (chunk 0) でも拒否
    const or = (JSON.parse(qbody) as { filter: { or: unknown[] } }).filter.or;
    const subset = JSON.stringify({ filter: { or: (or as unknown[]).slice(0, 1) }, page_size: 41 });
    const oversized = JSON.stringify({ filter: { or: [...(or as unknown[]), or[0]] }, page_size: 41 });
    for (const bad of [subset, oversized]) {
      const d2 = mkdtempSync(join(tmpdir(), "custody-test-"));
      const c2: GuardCounters = { attempts: 0, rejected: 0, querySuccess: 0 };
      let n2 = 0;
      const g2 = createReadOnlyGuardFetch(
        (async () => {
          n2 += 1;
          return new Response("{}");
        }) as typeof fetch,
        d2,
        c2,
        96,
        BIND
      );
      await expect(g2(qurl, { method: "POST", body: bad })).rejects.toThrow(HoldError);
      expect(n2).toBe(0);
      expect(c2.querySuccess).toBe(0);
    }
  });
});
