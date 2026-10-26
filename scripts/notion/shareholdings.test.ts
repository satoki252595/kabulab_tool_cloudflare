/** Local transport/filesystem fault tests only; no production/source requests. */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardedHoldingsMutation, inspectPendingHoldingPatch, writeHoldingsArtifact, claimHoldingPatchReplacement, resumeHoldingPrices } from "./shareholdings.js";
import { parseShareholdingsData } from "../../services/yuho-quant/src/services/edinet/shareholdings.js";
import { unzip } from "../../services/yuho-quant/src/services/edinet/zip.js";
import { holdingProperties, inspectHoldingPatch, resumePendingShareholdingsPrices } from "../../src/shared/notion-archive/shareholdings.js";
import { createD1HttpDb } from "../../src/shared/db/d1-http-client.js";
import { createHoldingPriceSourceLoader } from "../sync/holdings-price-sources.js";
import { notionEnv } from "../../src/shared/notion-archive/env.js";
import { sharedEnv } from "../../src/shared/env.js";

vi.mock("../../src/shared/notion-archive/shareholdings.js", async original => ({ ...await original<typeof import("../../src/shared/notion-archive/shareholdings.js")>(), inspectHoldingPatch: vi.fn(), resumePendingShareholdingsPrices: vi.fn() }));
vi.mock("../../src/shared/db/d1-http-client.js", () => ({ createD1HttpDb: vi.fn(() => ({})) }));
vi.mock("../sync/holdings-price-sources.js", () => ({ createHoldingPriceSourceLoader: vi.fn(() => vi.fn()) }));
vi.mock("../../src/shared/env.js", async original => {
  const real = await original<typeof import("../../src/shared/env.js")>();
  // Declared transport-only configuration. No credentials or business requests are used.
  return { ...real, sharedEnv: { ...real.sharedEnv,
    ...Object.fromEntries(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"].map(key => [key, vi.fn(() => "unused-protocol-config")])),
    LOCAL_OUT: vi.fn(() => undefined),
  } };
});

vi.mock("node:fs", async original => {
  const real = await original<typeof import("node:fs")>();
  return { ...real, fsyncSync: vi.fn(real.fsyncSync), writeFileSync: vi.fn(real.writeFileSync) };
});

describe("normal pending-patch read-only CLI", () => {
  const fixture = new URL("../../services/yuho-quant/src/tests/fixtures/holdings-pending1911/", import.meta.url);
  function inputs() {
    const paths = { pending: pending(), intent: join(dir, "intent.json"), request: join(dir, "request.json"), before: join(dir, "before.json"), schema: join(dir, "schema.json"), out: join(dir, "inspection.json") };
    for (const [key, file] of [["intent", "unknown-intent.json"], ["request", "unknown-request.json"], ["before", "unknown-before.json"], ["schema", "schema.json"]] as const) fs.copyFileSync(new URL(file, fixture), paths[key]);
    fs.copyFileSync(new URL("journal.jsonl", fixture), journal());
    // Only temporary journal routing is changed; original143 event bytes stay exact.
    fs.writeFileSync(pending(), JSON.stringify({ version: 2, mode: "latest-saved-holdings", journal: journal(), noAutomaticReplay: true }));
    return paths;
  }
  it("実143unknownの全journal/意図SHAを照合してGET観測だけを別receiptへ残す", async () => {
    const paths = inputs(), pendingBytes = fs.readFileSync(pending()), journalBytes = fs.readFileSync(journal());
    const current = JSON.parse(fs.readFileSync(paths.before, "utf8"));
    vi.mocked(inspectHoldingPatch).mockResolvedValue({ status: "observed_pre", current, replayAuthorized: false });
    await inspectPendingHoldingPatch(paths);
    expect(inspectHoldingPatch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(paths.out, "utf8"))).toMatchObject({ attempt: 143, observation: { status: "observed_pre" }, GET: 1, mutations: 0, pendingCleared: false, sourceComplete: false, replayAuthorized: false });
    expect(fs.readFileSync(pending()).equals(pendingBytes)).toBe(true); expect(fs.readFileSync(journal()).equals(journalBytes)).toBe(true);
    expect(fs.statSync(paths.out).mode & 0o777).toBe(0o600);
  });
  it("実意図bodyが1文字でも変わるとGET前STOP/元pending保持", async () => {
    const paths = inputs(), pendingBytes = fs.readFileSync(pending()); fs.appendFileSync(paths.request, " ");
    await expect(inspectPendingHoldingPatch(paths)).rejects.toThrow(); expect(inspectHoldingPatch).not.toHaveBeenCalled();
    expect(fs.readFileSync(pending()).equals(pendingBytes)).toBe(true); expect(fs.existsSync(paths.out)).toBe(false);
  });
  it("canonical旧IDのfsync latchは別output/PREでも再送を拒否し元bytesを保持する", () => {
    const state = join(dir, "replacement-state"), native = vi.fn(); vi.stubGlobal("fetch", native);
    const oldId = JSON.parse(fs.readFileSync(new URL("unknown-before.json", fixture), "utf8")).id;
    claimHoldingPatchReplacement(state, { oldId, out: "first-output" });
    const original = fs.readFileSync(join(state, "replacement-started.json"));
    expect(() => claimHoldingPatchReplacement(state, { oldId, out: "different-output" })).toThrow();
    expect(fs.readFileSync(join(state, "replacement-started.json")).equals(original)).toBe(true);
    expect(native).not.toHaveBeenCalled(); expect(vi.mocked(fs.fsyncSync).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
// Bind the journal's actual fixture DB explicitly; CI must not rely on a developer .env.
vi.mock("../../src/shared/notion-archive/env.js", async original => {
  const real = await original<typeof import("../../src/shared/notion-archive/env.js")>();
  return { ...real, notionEnv: { ...real.notionEnv, NOTION_TOKEN: vi.fn(() => "unused-protocol-token"), NOTION_ARCHIVE_PAGE_ID: vi.fn(() => "1".repeat(32)),
    NOTION_STOCK_HOLDINGS_DB_ID: () => "5ad4d311-b06f-42b4-b78a-b3801cd509e2" } };
});
vi.mock("../../services/yuho-quant/src/services/edinet/zip.js", () => ({ unzip: vi.fn() }));
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
let dir: string, out: string;
const pending = () => `${out}.pending-write.json`, journal = () => `${out}.write-events.jsonl`;
const events = () => fs.readFileSync(journal(), "utf8").trim().split("\n").map(line => JSON.parse(line));
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(fs.fsyncSync).mockImplementation(realFs.fsyncSync); vi.mocked(fs.writeFileSync).mockImplementation(realFs.writeFileSync);
  dir = fs.mkdtempSync(join(tmpdir(), "kabulab-holdings-journal-")); out = join(dir, "result.json");
});
afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("durable single-attempt Node holdings journal", () => {
  it("keeps the actual saved native facts through seven ordered intents and preserves the completed journal", async () => {
    const bytes = fs.readFileSync(new URL("../../services/yuho-quant/src/tests/fixtures/holdings-header-forms.json.gz", import.meta.url));
    const provenance = JSON.parse(fs.readFileSync(new URL("../../services/yuho-quant/src/tests/fixtures/holdings-header-forms.provenance.json", import.meta.url), "utf8"));
    expect(hash(bytes)).toBe(provenance.fixtureSha256);
    const fixture = (JSON.parse(gunzipSync(bytes).toString()) as Array<{ source: { docId: string; stockCode: string; edinetCode: string; fiscalYearEnd: string }; filename: string; html: string }>).find(row => row.source.stockCode === "1438")!;
    vi.mocked(unzip).mockReturnValue(new Map([[fixture.filename, Buffer.from(fixture.html)]]));
    const parsed = parseShareholdingsData(Buffer.alloc(0), fixture.source);
    expect(parsed.status).toBe("ok"); expect(parsed.holdings).toHaveLength(4);
    expect(parsed.holdings[0]).toMatchObject({ shares: 22900, bookValueYen: 126408000 });
    const body = JSON.stringify({ properties: holdingProperties(fixture.source, "提出者の機構検証", parsed.holdings[0]) });
    const native = vi.fn(async () => {
      expect(fs.existsSync(pending())).toBe(true);
      const intents = events().filter(event => event.phase === "send-intent");
      expect(intents).toHaveLength(native.mock.calls.length); expect(intents.at(-1).bodySha256).toBe(hash(body));
      expect(vi.mocked(fs.fsyncSync).mock.calls.length).toBeGreaterThanOrEqual(3);
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", native);
    const result = await guardedHoldingsMutation(out, "local-seven-phase-check", async () => {
      // Schema/source-inflight/create/source-done/price-inflight/price-patch/price-done mechanism sequence.
      for (let attempt = 0; attempt < 7; attempt++) await fetch("https://api.notion.com/v1/pages", { method: attempt === 2 ? "POST" : "PATCH", body });
      return { status: "published", parsed: parsed.holdings.length };
    });
    expect(result).toEqual({ status: "published", parsed: 4 }); expect(native).toHaveBeenCalledTimes(7);
    expect(events().filter(event => event.phase === "send-intent").map(event => event.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events().filter(event => event.phase === "response-headers")).toHaveLength(7);
    expect(events().at(-1).phase).toBe("action-returned");
    const receipt = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(receipt.writes).toBe(7); expect(receipt.journal.sha256).toBe(hash(fs.readFileSync(journal())));
    expect(receipt.journal.pendingSha256).toBe(hash(fs.readFileSync(`${out}.completed-write.json`)));
    expect(fs.existsSync(pending())).toBe(false); expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    expect(vi.mocked(fs.writeFileSync).mock.calls.some(call => {
      const options = call[2]; return call[0] === out && options !== null && typeof options === "object" && options.flush === true && options.flag === "wx";
    })).toBe(true);
    await expect(guardedHoldingsMutation(out, "replay", async () => { throw new Error("must not run"); })).rejects.toThrow("読取照合");
  });

  it("unknown second send preserves the entire prefix and prohibits a swallowed failure or next-run replay", async () => {
    const native = vi.fn().mockResolvedValueOnce(new Response("{}", { status: 200 })).mockRejectedValueOnce(new Error("connection lost"));
    vi.stubGlobal("fetch", native);
    await expect(guardedHoldingsMutation(out, "unknown-control", async () => {
      await fetch("https://api.notion.com/v1/pages", { method: "POST", body: "{}" });
      await fetch("https://api.notion.com/v1/pages", { method: "PATCH", body: "{}" }).catch(() => undefined);
      await fetch("https://api.notion.com/v1/pages", { method: "PATCH", body: "{}" }).catch(() => undefined);
      return "must not become success";
    })).rejects.toThrow("成功");
    expect(native).toHaveBeenCalledTimes(2); expect(fs.existsSync(out)).toBe(false); expect(fs.existsSync(pending())).toBe(true);
    const prefix = fs.readFileSync(journal()); expect(events().filter(event => event.phase === "send-intent")).toHaveLength(2);
    await expect(guardedHoldingsMutation(out, "retry", async () => "must not run")).rejects.toThrow("読取照合");
    expect(fs.readFileSync(journal()).equals(prefix)).toBe(true); expect(native).toHaveBeenCalledTimes(2);
  });

  it("old pending/output bytes are preserved without starting the action", async () => {
    const old = '{"writes":[{"method":"PATCH"}],"noAutomaticReplay":true}\n';
    fs.writeFileSync(pending(), old); const action = vi.fn(async () => "must not run");
    await expect(guardedHoldingsMutation(out, "legacy", action)).rejects.toThrow("読取照合");
    expect(fs.readFileSync(pending(), "utf8")).toBe(old); expect(action).not.toHaveBeenCalled(); expect(fs.existsSync(journal())).toBe(false);
    writeHoldingsArtifact(out, old);
    expect(() => writeHoldingsArtifact(out, "replacement")).toThrow(); expect(fs.readFileSync(out, "utf8")).toBe(old);
  });

  it("failed fsync before the action sends nothing and keeps the exclusive marker", async () => {
    const action = vi.fn(async () => "must not run");
    vi.mocked(fs.fsyncSync).mockImplementationOnce(() => { throw new Error("fsync failed"); });
    await expect(guardedHoldingsMutation(out, "fsync-control", action)).rejects.toThrow("fsync failed");
    expect(action).not.toHaveBeenCalled(); expect(fs.existsSync(pending())).toBe(true); expect(fs.existsSync(out)).toBe(false);
  });

  it("output failure after a known response retains the pending latch and permits no resend", async () => {
    const native = vi.fn(async () => new Response("{}", { status: 200 })); vi.stubGlobal("fetch", native);
    vi.mocked(fs.writeFileSync).mockImplementation((...args) => { if (args[0] === out) throw new Error("output failed"); return realFs.writeFileSync(...args); });
    await expect(guardedHoldingsMutation(out, "output-control", async () => {
      await fetch("https://api.notion.com/v1/pages", { method: "POST", body: "{}" }); return "verified control";
    })).rejects.toThrow("output failed");
    expect(native).toHaveBeenCalledTimes(1); expect(fs.existsSync(pending())).toBe(true); expect(fs.existsSync(out)).toBe(false);
    await expect(guardedHoldingsMutation(out, "replay", async () => "must not run")).rejects.toThrow("読取照合");
    expect(native).toHaveBeenCalledTimes(1);
  });
});

describe("normal price-only CLI window", () => {
  it("同じ共有DB/loaderと通常予算を一度だけ渡し、既知partialはjournal閉鎖後exit1にする", async () => {
    const native = vi.fn(async () => new Response("{}", { status: 200 })); vi.stubGlobal("fetch", native);
    const review = { scope: "initial-attention-sample-and-selected-window" as const, attentionHasMore: true, attentionSample: [], queueSize: 6, queueHasMore: false, queuedSourcePageIds: [], sources: [] };
    const partial = { usedRows: 42, resumed: 5, held: 1, pending: true, review };
    vi.mocked(resumePendingShareholdingsPrices).mockImplementationOnce(async args => {
      expect(args.sourceDb).toBe(vi.mocked(createD1HttpDb).mock.results[0].value);
      expect(args.loadSources).toBe(vi.mocked(createHoldingPriceSourceLoader).mock.results[0].value);
      expect(args.maxRows).toBe(100); expect(args.budget).toEqual({ remainingChunks: 116, remainingBytes: 256 * 1024 * 1024 });
      expect(args.shouldStop()).toBe(false);
      await fetch("https://api.cloudflare.com/client/v4/accounts/protocol/d1/database/protocol/query", { method: "POST", body: JSON.stringify({ sql: "SELECT 1", params: [] }) });
      await fetch("https://api.notion.com/v1/pages", { method: "PATCH", body: "{}" });
      return partial;
    });
    expect(await resumeHoldingPrices(out)).toBe(1);
    expect(resumePendingShareholdingsPrices).toHaveBeenCalledTimes(1); expect(createHoldingPriceSourceLoader).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toMatchObject({ mode: "resume-prices", result: partial, writes: 1, sourceRequests: 0 });
    expect(fs.existsSync(pending())).toBe(false); expect(fs.existsSync(`${out}.completed-write.json`)).toBe(true);
    expect(native).toHaveBeenCalledTimes(2);
    vi.mocked(resumePendingShareholdingsPrices).mockResolvedValueOnce({ usedRows: 0, resumed: 0, held: 0, pending: false, review: { ...review, attentionHasMore: false, queueSize: 0 } });
    expect(await resumeHoldingPrices(join(dir, "complete.json"))).toBe(0);
  });
  it("unknownは完成receipt無し・元pending維持、同outの再送を拒否する", async () => {
    const native = vi.fn(async () => { throw new Error("DECLARED_UNKNOWN"); }); vi.stubGlobal("fetch", native);
    vi.mocked(resumePendingShareholdingsPrices).mockImplementationOnce(async () => {
      await fetch("https://api.notion.com/v1/pages", { method: "PATCH", body: "{}" });
      throw new Error("must not complete");
    });
    await expect(resumeHoldingPrices(out)).rejects.toThrow("再送せず");
    const original = fs.readFileSync(pending()), prefix = fs.readFileSync(journal());
    expect(fs.existsSync(out)).toBe(false); expect(fs.existsSync(`${out}.completed-write.json`)).toBe(false);
    await expect(resumeHoldingPrices(out)).rejects.toThrow("読取照合");
    expect(fs.readFileSync(pending())).toEqual(original); expect(fs.readFileSync(journal())).toEqual(prefix);
    expect(resumePendingShareholdingsPrices).toHaveBeenCalledTimes(1); expect(native).toHaveBeenCalledTimes(1);
  });
  it("必須設定欠測やLOCAL_OUT指定はpending/DB/原本読取より前に拒否する", async () => {
    vi.mocked(notionEnv.NOTION_TOKEN).mockImplementationOnce(() => { throw new Error("missing token"); });
    await expect(resumeHoldingPrices(out)).rejects.toThrow("missing token");
    vi.mocked(sharedEnv.LOCAL_OUT).mockReturnValueOnce(dir);
    await expect(resumeHoldingPrices(out)).rejects.toThrow("ローカル代替");
    expect(fs.existsSync(pending())).toBe(false); expect(createD1HttpDb).not.toHaveBeenCalled(); expect(resumePendingShareholdingsPrices).not.toHaveBeenCalled();
  });
});
