/**
 * Physical-64 closure runner の offline 検証 (hermetic・送信 0)。
 * 実 packet (0600)・実 preflight は canonical env で別途検証する。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  loadExpectedBytes,
  requireGrant,
  routeTag,
  saveBodyWx,
  type ClosePacketRow,
  type GuardBindings,
  type GuardCounters,
} from "../../data-scripts/overseas-physical-close64.js";
import { verifyArchivedAttachments } from "../../../../src/shared/notion-archive/readback.js";

const P1 = "a1b2c3d4-e5f6-0708-1829-3a4b5c6d7e8f";
const P2 = "b1b2c3d4-e5f6-0708-1829-3a4b5c6d7e8f";
const PX = "c1b2c3d4-e5f6-0708-1829-3a4b5c6d7e8f";
const U = (s: string) => new URL(s);
const HOST = "https://prod-files-secure.s3.us-west-2.amazonaws.com";
const BIND: GuardBindings = { pageIds: new Set([dashless(P1), dashless(P2)]) };

function row(o: Partial<ClosePacketRow> & { key: string; pageId: string }): ClosePacketRow {
  return {
    file: "x.zip",
    kind: "file",
    bytes: null,
    sha256: null,
    edinetDocType: null,
    local: { path: null, exists: false },
    ...o,
  };
}

describe("grant-first / OUT-freshness", () => {
  it("grant なしは HOLD", () => {
    expect(() => requireGrant(["node", "x.js"])).toThrow(HoldError);
    expect(requireGrant(["node", "x.js", "--grant=g"])).toBe("g");
  });

  it("既存 OUT は拒否・不存在は通過", () => {
    const dir = mkdtempSync(join(tmpdir(), "close64-test-"));
    expect(() => assertFreshOutDir(dir)).toThrow(HoldError);
    expect(() => assertFreshOutDir(join(dir, "fresh"))).not.toThrow();
  });
});

describe("read-only allow-list (listing + hosted のみ)", () => {
  it("到達の2経路のみ許可", () => {
    expect(isAllowedRoute("GET", U(`https://api.notion.com/v1/pages/${P1}`))).toBe(true);
    expect(isAllowedRoute("GET", U(`${HOST}/xxx/file.zip?X-Amz-Sig=abc`))).toBe(true);
    expect(routeTag(U(`https://api.notion.com/v1/pages/${P1}`))).toBe("listing");
    expect(routeTag(U(`${HOST}/x`))).toBe("hosted");
  });

  it("search・mutation・他 host・形状外は拒否", () => {
    expect(isAllowedRoute("POST", U("https://api.notion.com/v1/search"))).toBe(false);
    expect(isAllowedRoute("POST", U(`https://api.notion.com/v1/pages/${P1}`))).toBe(false);
    expect(isAllowedRoute("PATCH", U(`https://api.notion.com/v1/pages/${P1}`))).toBe(false);
    expect(isAllowedRoute("GET", U(`https://api.notion.com/v1/pages/${P1}?x=1`))).toBe(false);
    expect(isAllowedRoute("GET", U(`https://api.notion.com/v1/pages/short`))).toBe(false);
    expect(isAllowedRoute("GET", U("https://evil.example.com/x.zip"))).toBe(false);
    expect(isAllowedRoute("GET", U("http://api.notion.com/v1/search"))).toBe(false);
  });
});

describe("bindings (exact64 + hosted各1回)", () => {
  const lurl = U(`https://api.notion.com/v1/pages/${P1}`);
  const xurl = U(`https://api.notion.com/v1/pages/${PX}`);
  const hurl = U(`${HOST}/a/f.zip?sig=1`);

  it("packet64 listing・未見 hosted は通過", () => {
    expect(() => assertRequestBindings(lurl, undefined, BIND, new Set())).not.toThrow();
    expect(() => assertRequestBindings(hurl, undefined, BIND, new Set())).not.toThrow();
  });

  it("非packet64・hosted重複・GET body 付きは HOLD", () => {
    expect(() => assertRequestBindings(xurl, undefined, BIND, new Set())).toThrow(HoldError);
    expect(() => assertRequestBindings(lurl, { method: "GET", body: "x" }, BIND, new Set())).toThrow(HoldError);
    expect(() => assertRequestBindings(hurl, undefined, BIND, new Set([hurl.href]))).toThrow(HoldError);
    // 別 URL (別署名) は未見扱いで通過する
    expect(() => assertRequestBindings(U(`${HOST}/a/f.zip?sig=2`), undefined, BIND, new Set([hurl.href]))).not.toThrow();
  });
});

describe("guard (native 前・deny 到達なし・予約先行)", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "close64-test-"));
    const counters: GuardCounters = { attempts: 0, rejected: 0, listing: 0, hosted: 0 };
    let native = 0;
    const inner = (async () => {
      native += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const g = createReadOnlyGuardFetch(inner, dir, counters, BIND);
    return { dir, counters, g, native: () => native };
  }

  it("deny は native 未到達・hosted 重複は2回目を拒否", async () => {
    const s = setup();
    const h = `${HOST}/a/f.zip?sig=1`;
    await s.g(h, { method: "GET" });
    expect(s.native()).toBe(1);
    expect(s.counters.hosted).toBe(1);
    await expect(s.g(h, { method: "GET" })).rejects.toThrow(HoldError);
    expect(s.native()).toBe(1);
    expect(s.counters.rejected).toBe(1);
    // 非 packet page も native 未到達
    await expect(s.g(`https://api.notion.com/v1/pages/${PX}`, { method: "GET" })).rejects.toThrow(HoldError);
    expect(s.native()).toBe(1);
  });

  it("listing 再送は通す・予約行が captured に先行する", async () => {
    const s = setup();
    const l = `https://api.notion.com/v1/pages/${P1}`;
    await s.g(l, { method: "GET" });
    await s.g(l, { method: "GET" });
    expect(s.native()).toBe(2);
    expect(s.counters.listing).toBe(2);
    const lines = readFileSync(join(s.dir, "guard-attempt.log"), "utf8").trim().split("\n").map((x) => JSON.parse(x));
    expect(lines.map((x: { decision: string }) => x.decision)).toEqual(["reserved", "captured", "reserved", "captured"]);
    expect(lines[0].seq).toBe(lines[1].seq);
  });

  it("redirect manual 強制・3xx は body 保存後に STOP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "close64-test-"));
    let seen: unknown = null;
    const inner = (async (_u: unknown, init?: RequestInit) => {
      seen = init?.redirect;
      return new Response("moved", { status: 301 });
    }) as typeof fetch;
    const counters: GuardCounters = { attempts: 0, rejected: 0, listing: 0, hosted: 0 };
    const g = createReadOnlyGuardFetch(inner, dir, counters, BIND);
    await expect(g(`https://api.notion.com/v1/pages/${P1}`, { method: "GET" })).rejects.toThrow(/3xx/);
    expect(seen).toBe("manual");
    expect(readFileSync(join(dir, "attempt-001-listing.bin"), "utf8")).toBe("moved");
  });
});

describe("saveBodyWx", () => {
  it("wx 単一書込・0600・SHA 返却", async () => {
    const dir = mkdtempSync(join(tmpdir(), "close64-test-"));
    const sha = saveBodyWx(dir, "x.bin", new Uint8Array([1, 2, 3]));
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(() => saveBodyWx(dir, "x.bin", new Uint8Array([9]))).toThrow();
    const { statSync } = await import("node:fs");
    expect(statSync(join(dir, "x.bin")).mode & 0o777).toBe(0o600);
  });
});

describe("packet shape (69/64/59/5/5)", () => {
  function packet64(): { rows: ClosePacketRow[] } {
    const rows: ClosePacketRow[] = [];
    for (let i = 0; i < 59; i++) {
      const id = `a1b2c3d4-e5f6-0708-1829-3a4b5c6d00${String(i).padStart(2, "0")}`;
      rows.push(
        row({
          key: `S${String(i).padStart(6, "0")}X:type1`,
          pageId: id,
          file: "f.zip",
          bytes: 10,
          sha256: "0".repeat(64),
          local: { path: "/none", exists: true, sizeMatch: true, shaMatch: true },
        })
      );
    }
    for (let i = 0; i < 5; i++) {
      const id = `b1b2c3d4-e5f6-0708-1829-3a4b5c6d00${String(i).padStart(2, "0")}`;
      rows.push(
        row({
          key: `T${String(i).padStart(6, "0")}X:type1`,
          pageId: id,
          file: "g.zip",
          local: { path: "/none", exists: true, conventional: true, size: 10, sha256: "1".repeat(64) },
        })
      );
    }
    for (let i = 0; i < 5; i++) {
      const id = `c1b2c3d4-e5f6-0708-1829-3a4b5c6d00${String(i).padStart(2, "0")}`;
      rows.push(row({ key: `U${String(i).padStart(6, "0")}X:type5`, pageId: id, file: "h.zip" }));
    }
    return { rows };
  }

  it("69/64/59/5/5 の packet のみ通過し C5 を除外する", () => {
    const { scope, held } = assertPacketShape(packet64());
    expect(scope).toHaveLength(64);
    expect(held).toHaveLength(5);
    expect(held.every((r) => r.key.endsWith(":type5"))).toBe(true);
    expect(scope.every((r) => r.local.exists)).toBe(true);
  });

  it("数外・Tier 不足・重複・形状外は HOLD", () => {
    const p = packet64();
    expect(() => assertPacketShape({ rows: p.rows.slice(0, 68) })).toThrow(HoldError);
    expect(() => assertPacketShape({ rows: [...p.rows.slice(0, 68), p.rows[0]] })).toThrow(HoldError); // rows[0] 重複
    const badTier = packet64();
    (badTier.rows[0].local as { shaMatch: boolean }).shaMatch = false;
    expect(() => assertPacketShape(badTier)).toThrow(HoldError);
    const badKind = packet64();
    badKind.rows[0].kind = "external";
    expect(() => assertPacketShape(badKind)).toThrow(HoldError);
  });
});

describe("loadExpectedBytes (local 再照合)", () => {
  it("TierA は metadata 照合・TierB は観測値照合・変化/不在は HOLD", async () => {
    const { createHash } = await import("node:crypto");
    const dir = mkdtempSync(join(tmpdir(), "close64-test-"));
    const f = join(dir, "a.zip");
    writeFileSync(f, Buffer.from([1, 2, 3, 4]));
    const sha = createHash("sha256").update(Buffer.from([1, 2, 3, 4])).digest("hex");
    const a = row({
      key: "S000001X:type1",
      pageId: P1,
      file: "a.zip",
      bytes: 4,
      sha256: sha,
      local: { path: f, exists: true, sizeMatch: true, shaMatch: true },
    });
    expect(loadExpectedBytes(a)).toHaveLength(4);
    // 変化は HOLD
    writeFileSync(f, Buffer.from([9, 9]));
    expect(() => loadExpectedBytes(a)).toThrow(HoldError);
    // TierB: 観測値一致は通過・変化は HOLD
    const b = row({
      key: "T000001X:type1",
      pageId: P2,
      file: "b.zip",
      local: { path: f, exists: true, conventional: true, size: 2, sha256: createHash("sha256").update(Buffer.from([9, 9])).digest("hex") },
    });
    expect(loadExpectedBytes(b)).toHaveLength(2);
    (b.local as { size: number }).size = 3;
    expect(() => loadExpectedBytes(b)).toThrow(HoldError);
    // 不在は HOLD
    const c = row({ key: "U000001X:type5", pageId: PX, file: "c.zip" });
    expect(() => loadExpectedBytes(c)).toThrow(HoldError);
  });
});

describe("actual verifier 経路 (hermetic)", () => {
  it("実 verifyArchivedAttachments が guard 経由で閉鎖する・bytes 不一致は throw", async () => {
    const dir = mkdtempSync(join(tmpdir(), "close64-test-"));
    const counters: GuardCounters = { attempts: 0, rejected: 0, listing: 0, hosted: 0 };
    const hostedURL = `${HOST}/signed/f.zip?sig=test`;
    const want = new Uint8Array([7, 7, 7]);
    let hostedBytes: Uint8Array = want;
    const inner = (async (u: unknown) => {
      const url = new URL(String(u));
      if (url.hostname === "api.notion.com") {
        return new Response(JSON.stringify({ properties: { Files: { type: "files", files: [{ name: "f.zip", type: "file", file: { url: hostedURL } }] } } }));
      }
      return new Response(hostedBytes as BodyInit);
    }) as typeof fetch;
    const g = createReadOnlyGuardFetch(inner, dir, counters, BIND);
    const prevFetch = globalThis.fetch;
    const prevToken = process.env["NOTION_TOKEN"];
    process.env["NOTION_TOKEN"] = "test-token";
    try {
      globalThis.fetch = g;
      await verifyArchivedAttachments(P1, [{ filename: "f.zip", bytes: want }], "test-close");
      expect(counters.listing).toBe(1);
      expect(counters.hosted).toBe(1);
      // 不一致 path は fresh guard (hosted-once ではなく verifier が throw すること)。
      const dir2 = mkdtempSync(join(tmpdir(), "close64-test-"));
      const c2: GuardCounters = { attempts: 0, rejected: 0, listing: 0, hosted: 0 };
      globalThis.fetch = createReadOnlyGuardFetch(inner, dir2, c2, BIND);
      hostedBytes = new Uint8Array([8]);
      await expect(verifyArchivedAttachments(P1, [{ filename: "f.zip", bytes: want }], "test-close")).rejects.toThrow(
        /バイト長|SHA/
      );
      expect(c2.hosted).toBe(1);
    } finally {
      globalThis.fetch = prevFetch;
      if (prevToken === undefined) delete process.env["NOTION_TOKEN"];
      else process.env["NOTION_TOKEN"] = prevToken;
    }
  });
});
