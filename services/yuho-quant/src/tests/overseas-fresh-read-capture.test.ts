/**
 * Fresh-read-capture の offline 検証 (hermetic・送信 0)。
 *
 * /tmp pins・env・network を使わない。DB 観測値の捏造なし:
 * validator の positive 行は形状 fixture であり観測主張ではない
 * (値は "S100TEST0" 等の自明な合成値。preimage 検証は live run の
 * raw capture が行う)。SQL template は実 builders の toSQL で検証する。
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import {
  buildQ1F,
  buildQ2F,
  chunkIds,
  createCaptureFetch,
  HoldError,
  offlineDb,
  partitionChunk,
  requireGrant,
  validateQ1FRow,
  type AttemptCtx,
  type BodyReceipt,
  type GuardCounters,
} from "../../data-scripts/overseas-fresh-read-capture.js";
import {
  assertProjection,
  createBoundedFetch,
  validateQ2Row,
} from "../../data-scripts/overseas-745-select-proof.js";

const CHUNK100 = Array.from({ length: 100 }, (_, i) => `S100T${String(i).padStart(3, "0")}`);
const CHUNK75 = Array.from({ length: 75 }, (_, i) => `S100U${String(i).padStart(3, "0")}`);

describe("grant-first (fetch 0 のまま HOLD)", () => {
  it("grant なしは HoldError", () => {
    expect(() => requireGrant(["node", "capture.js"])).toThrow(HoldError);
    expect(() => requireGrant(["node", "capture.js", "--grant="])).toThrow(HoldError);
  });

  it("grant ありは文を返す (stdout には出さない)", () => {
    expect(requireGrant(["node", "capture.js", "--grant=Root-ok-1"])).toBe("Root-ok-1");
  });
});

describe("chunk 分割 (純粋)", () => {
  it("250 → 100/100/50、3675 → 37 chunks (末尾 75)", () => {
    const ids250 = Array.from({ length: 250 }, (_, i) => `D${i}`);
    expect(chunkIds(ids250, 100).map((c) => c.length)).toEqual([100, 100, 50]);
    const ids3675 = Array.from({ length: 3675 }, (_, i) => `D${i}`);
    const chunks = chunkIds(ids3675, 100);
    expect(chunks.length).toBe(37);
    expect(chunks[36]?.length).toBe(75);
  });

  it("size 非正は HOLD", () => {
    expect(() => chunkIds(["a"], 0)).toThrow(HoldError);
  });
});

describe("Q1 exact set partition (純粋)", () => {
  it("observed unique + missing = chunk (rows == all を要求しない)", () => {
    const part = partitionChunk(["a", "b", "c"], ["c", "a"], "t");
    expect(part.observed.sort()).toEqual(["a", "c"]);
    expect(part.missing).toEqual(["b"]);
  });

  it("重複・echo 範囲外は HOLD", () => {
    expect(() => partitionChunk(["a", "b"], ["a", "a"], "t")).toThrow(HoldError);
    expect(() => partitionChunk(["a", "b"], ["a", "zz"], "t")).toThrow(HoldError);
  });
});

describe("builders (実 toSQL・送信不能 db)", () => {
  it("Q1F 17射影・Q2F 13射影・binds == chunk 件数・read-only", () => {
    const db = offlineDb();
    for (const chunk of [CHUNK100, CHUNK75]) {
      const q1 = buildQ1F(db, chunk).toSQL();
      const q2 = buildQ2F(db, chunk).toSQL();
      assertProjection(q1.sql, 17, "t");
      assertProjection(q2.sql, 13, "t");
      expect(q1.params.length).toBe(chunk.length);
      expect(q2.params.length).toBe(chunk.length);
      expect(q1.params).toEqual(chunk);
      expect(/^\s*select\b/i.test(q1.sql)).toBe(true);
      expect(/^\s*select\b/i.test(q2.sql)).toBe(true);
    }
  });

  it("offline db は呼ばれたら throw (toSQL のみ)", async () => {
    const db = offlineDb();
    // drizzle が callback 失敗を Failed query で包む (送信は起きない)。
    await expect(buildQ1F(db, ["S100T000"])).rejects.toThrow("Failed query");
  });

  it("main 経路と同じ drizzle 形でも builders が使える", () => {
    const db2 = drizzle(async () => {
      throw new Error("no-send");
    }, { schema: {} });
    const q1 = buildQ1F(db2, CHUNK100).toSQL();
    assertProjection(q1.sql, 17, "t");
  });
});

describe("Q1F 行検証 (形状 fixture・観測主張なし)", () => {
  const goodRow = (): Record<string, unknown> => ({
    id: 7, stockId: 4242, edinetCode: "E99999", docId: "S100TEST0",
    docTypeCode: "120", filerName: "Fixture Co", periodStart: "2023-04-01",
    periodEnd: "2024-03-31", submittedAt: new Date("2024-06-20T00:00:00Z"),
    parseStatus: "ok_pattern_a", honbunFile: "honbun.html",
    overseasParseStatus: "ok_geo_rows", overseasHonbunFile: "overseas.html",
    textParseStatus: null, notionDocPageId: null,
    ingestedAt: 1718841600, factsCount: 3,
  });

  it("正形状を通す (epoch int も ISO へ)", () => {
    const d = validateQ1FRow(goodRow(), "t");
    expect(d.docId).toBe("S100TEST0");
    expect(d.submittedAt).toBe("2024-06-20T00:00:00.000Z");
    expect(d.ingestedAt).toBe("2024-06-20T00:00:00.000Z");
    expect(d.textParseStatus).toBeNull();
  });

  it("列不足・id 外・periodEnd 外・時刻 null・factsCount 外は HOLD", () => {
    const { ...noId } = goodRow();
    delete (noId as Record<string, unknown>)["id"];
    expect(() => validateQ1FRow(noId, "t")).toThrow(HoldError);
    expect(() => validateQ1FRow({ ...goodRow(), id: 0 }, "t")).toThrow(HoldError);
    expect(() => validateQ1FRow({ ...goodRow(), periodEnd: "2024/03/31" }, "t")).toThrow(HoldError);
    expect(() => validateQ1FRow({ ...goodRow(), submittedAt: null }, "t")).toThrow(HoldError);
    expect(() => validateQ1FRow({ ...goodRow(), factsCount: -1 }, "t")).toThrow(HoldError);
    expect(() => validateQ1FRow({ ...goodRow(), overseasParseStatus: 5 }, "t")).toThrow(HoldError);
  });
});

describe("Q2F 行検証の再使用 (形状 fixture)", () => {
  const goodRow = (): Record<string, unknown> => ({
    docId: "S100TEST0", id: 11, documentId: 7, stockId: 4242,
    fiscalYearEnd: "2024-03-31", regionName: "北米", regionKind: "overseas",
    isConsolidated: 1, unitLabel: "百万円", salesRaw: 100, salesYen: 100000000,
    ratioPct: 12.5, pattern: "geo_rows",
  });

  it("正形状を通す", () => {
    expect(validateQ2Row(goodRow(), "t").docId).toBe("S100TEST0");
  });

  it("列不足・PK 外は HOLD", () => {
    // validateQ2Row は select-proof の HoldError を投げる (別 class のため文で判定)。
    const { ...noId } = goodRow();
    delete (noId as Record<string, unknown>)["id"];
    expect(() => validateQ2Row(noId, "t")).toThrow("HOLD:");
    expect(() => validateQ2Row({ ...goodRow(), id: 0 }, "t")).toThrow("HOLD:");
  });
});

describe("bound guard (native 0 call)", () => {
  it("非 D1/batch/非 SELECT/超過を native 到達前に拒否", async () => {
    const url = "https://api.cloudflare.com/client/v4/accounts/a/d1/database/d/query";
    let nativeCalls = 0;
    const native = (async () => {
      nativeCalls += 1;
      return new Response("{}");
    }) as typeof fetch;
    const counters: GuardCounters = { observed: 0, failed: 0 };
    const guard = createBoundedFetch(native, 1, counters);
    await expect(guard("https://example.com/x", {})).rejects.toThrow();
    await expect(guard(url, { body: JSON.stringify({ batch: [] }) })).rejects.toThrow();
    await expect(guard(url, { body: JSON.stringify({ sql: "DELETE FROM t" }) })).rejects.toThrow();
    expect(nativeCalls).toBe(0);
    expect(counters.failed).toBe(3);
  });
});

describe("capture 層 (fsync-first log + wx0600 body + safe receipt)", () => {
  it("body を wx0600 保存し res を intact で返し log 2 行を残す", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-test-"));
    const counters: GuardCounters = { observed: 0, failed: 0 };
    const receipts: BodyReceipt[] = [];
    const inner = (async () =>
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json", authorization: "Bearer s3cr3t" },
      })) as typeof fetch;
    const at: AttemptCtx = { seq: 7, kind: "Q1F", chunk: 0, idsSHA: "i".repeat(64), sqlSHA: "s".repeat(64) };
    const cap = createCaptureFetch(inner, dir, counters, receipts, () => at, () => undefined);
    const res = await cap("https://d1.invalid/query", {
      method: "POST",
      headers: { authorization: "Bearer s3cr3t" },
      body: JSON.stringify({ sql: "select 1", params: ["S100SECRET"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const bodyPath = join(dir, "attempt-007-Q1F-body.bin");
    expect(statSync(bodyPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(bodyPath, "utf8")).toBe(JSON.stringify({ success: true }));
    // receipt は whole-body SHA + path + raw bytes (strict judge の前に確定)。
    expect(receipts.length).toBe(1);
    expect(receipts[0]?.path).toBe(bodyPath);
    expect(receipts[0]?.bytes).toBe(JSON.stringify({ success: true }).length);
    expect(receipts[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const log = readFileSync(join(dir, "attempt.log"), "utf8");
    const lines = log.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(log).toContain('"phase":"send"');
    expect(log).toContain('"phase":"receipt"');
    expect(log).toContain('"status":200');
    expect(log).toContain('"bodySHA":"');
    expect(log).toContain('"rawBytes":');
    expect(log).toContain(bodyPath);
    // request 秘密・params 値は log しない。
    expect(log).not.toContain("s3cr3t");
    expect(log).not.toContain("S100SECRET");
    expect(log).not.toContain("authorization");
  });

  it("同一 seq の再入は wx で拒否する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-test-"));
    const counters: GuardCounters = { observed: 0, failed: 0 };
    const receipts: BodyReceipt[] = [];
    const inner = (async () => new Response("{}")) as typeof fetch;
    const at: AttemptCtx = { seq: 1, kind: "Q1F", chunk: 0, idsSHA: "i", sqlSHA: "s" };
    const cap = createCaptureFetch(inner, dir, counters, receipts, () => at, () => undefined);
    await cap("https://d1.invalid/query", {});
    await expect(cap("https://d1.invalid/query", {})).rejects.toThrow("再入");
    expect(counters.failed).toBe(1);
    expect(receipts.length).toBe(1);
  });

  it("attempt context 不在の送信を拒否する", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-test-"));
    const counters: GuardCounters = { observed: 0, failed: 0 };
    const receipts: BodyReceipt[] = [];
    let innerCalls = 0;
    const inner = (async () => {
      innerCalls += 1;
      return new Response("{}");
    }) as typeof fetch;
    const cap = createCaptureFetch(inner, dir, counters, receipts, () => null, () => undefined);
    await expect(cap("https://d1.invalid/query", {})).rejects.toThrow("context 不在");
    expect(innerCalls).toBe(0);
    expect(receipts.length).toBe(0);
  });
});
