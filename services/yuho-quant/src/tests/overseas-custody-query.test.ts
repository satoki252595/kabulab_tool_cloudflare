/**
 * Custody-query runner round1 の offline 検証 (hermetic・送信 0)。
 * /tmp pins・env・network を使わない。packet SHA 付きの実 preflight は
 * canonical env で別途検証する。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertFreshOutDir,
  assertPacketShape,
  assertRequestBindings,
  createReadOnlyGuardFetch,
  dashless,
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

const ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90a";
const U = (s: string) => new URL(s);
const BIND: GuardBindings = {
  manifestKeys: new Set(["S1000000X:type1", "S1000000X:type5"]),
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
  const qbody = JSON.stringify({
    filter: { or: [{ property: "Key", title: { equals: "S1000000X:type1" } }] },
    page_size: 41,
  });
  const surl = U("https://api.notion.com/v1/search");
  const sbody = JSON.stringify({
    query: "一次データ｜yuho-quant",
    filter: { property: "object", value: "database" },
    page_size: 100,
  });

  it("固定値一致は通過・DB pin は初回確定", () => {
    expect(assertRequestBindings("POST", qurl, { method: "POST", body: qbody }, BIND, null)).toBe(ID);
    expect(assertRequestBindings("POST", qurl, { method: "POST", body: qbody }, BIND, ID)).toBe(ID);
    expect(assertRequestBindings("POST", surl, { method: "POST", body: sbody }, BIND, null)).toBeNull();
    expect(
      assertRequestBindings("GET", U(`https://api.notion.com/v1/blocks/${ID}/children?page_size=100`), undefined, BIND, null)
    ).toBeNull();
    expect(assertRequestBindings("GET", U(`https://api.notion.com/v1/databases/${ID}`), undefined, BIND, ID)).toBe(ID);
  });

  it("manifest 外 key・非固定値・drift・未 pin は HOLD", () => {
    const badKey = JSON.stringify({
      filter: { or: [{ property: "Key", title: { equals: "ZZZ:type1" } }] },
      page_size: 41,
    });
    expect(() => assertRequestBindings("POST", qurl, { method: "POST", body: badKey }, BIND, null)).toThrow(HoldError);
    const badPage = JSON.stringify({
      filter: { or: [{ property: "Key", title: { equals: "S1000000X:type1" } }] },
      page_size: 42,
    });
    expect(() => assertRequestBindings("POST", qurl, { method: "POST", body: badPage }, BIND, null)).toThrow(HoldError);
    const other = "b1b2c3d4e5f60718293a4b5c6d7e8f90b";
    expect(() => assertRequestBindings("POST", qurl, { method: "POST", body: qbody }, BIND, other)).toThrow(HoldError);
    expect(() => assertRequestBindings("GET", U(`https://api.notion.com/v1/databases/${ID}`), undefined, BIND, null)).toThrow(HoldError);
    const badTitle = JSON.stringify({
      query: "別物",
      filter: { property: "object", value: "database" },
      page_size: 100,
    });
    expect(() => assertRequestBindings("POST", surl, { method: "POST", body: badTitle }, BIND, null)).toThrow(HoldError);
    expect(
      () => assertRequestBindings("GET", U(`https://api.notion.com/v1/blocks/${other}/children`), undefined, BIND, null)
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
    const counters: GuardCounters = { attempts: 0, rejected: 0 };
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
    const counters: GuardCounters = { attempts: 0, rejected: 0 };
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
    const counters: GuardCounters = { attempts: 0, rejected: 0 };
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
    const counters: GuardCounters = { attempts: 0, rejected: 0 };
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
  const keyFn = (d: string, t: 1 | 5) => `${d}:type${t}`;
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
