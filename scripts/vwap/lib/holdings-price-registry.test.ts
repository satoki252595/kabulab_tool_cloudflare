import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { bootstrapPriceSnapshot, publishDailyPriceSnapshot, readActivatedPriceSnapshot } from "./holdings-price-registry.js";
import { PRICE_ACTIVE_KEY, type PriceReference, type PriceSnapshot } from "../../../src/shared/holdings/price-registry.js";
import { r2GetVersion, r2Put } from "./r2.js";
import { resolveLatestHoldingsCodeList } from "../../sync/holdings-code-list.js";
vi.mock("./r2.js", () => ({ r2GetVersion: vi.fn(), r2Put: vi.fn() }));
vi.mock("../../sync/holdings-code-list.js", () => ({ resolveLatestHoldingsCodeList: vi.fn() }));
const hash = (body: string) => createHash("sha256").update(body).digest("hex");
const ref: PriceReference = { file: { archivePageId: "a".repeat(32), filename: "raw.json.gz", sha256: "b".repeat(64), byteLength: 100 },
  symbol: "7203.T", receivedAt: "2026-10-14T09:00:00.000Z", bodySha256: "c".repeat(64), bodyBytes: 200 };
const base: PriceSnapshot = { version: 1, snapshotId: "old", sessionDate: "2026-10-13", createdAt: "2026-10-13T09:00:00.000Z", codeList: ref.file,
  members: { "7203.T": { ...ref, receivedAt: "2026-10-13T09:00:00.000Z" } } };
const args = { runId: "new", sessionDate: "2026-10-14", finishedAt: "2026-10-14T09:01:00.000Z", universe: ["7203"], codes: ["7203"], references: new Map([["7203", ref]]), complete: true };
let store: Map<string, { body: string; etag: string }>;
beforeEach(() => {
  vi.clearAllMocks(); store = new Map(); const body = JSON.stringify(base), digest = hash(body), registryKey = `ops/holdings-price/snapshot-old-${digest}.json`;
  store.set(registryKey, { body, etag: "registry-old" });
  store.set(PRICE_ACTIVE_KEY, { body: JSON.stringify({ version: 1, snapshotId: "old", registryKey, registrySha256: digest, activatedAt: base.createdAt }), etag: "active-old" });
  vi.mocked(r2GetVersion).mockImplementation(async key => store.get(key) ?? null);
  vi.mocked(resolveLatestHoldingsCodeList).mockResolvedValue({ status: "ready", file: base.codeList });
  vi.mocked(r2Put).mockImplementation(async (key, body, etag) => {
    expect(store.get(key)?.etag ?? null).toBe(etag); store.set(key, { body, etag: `v${store.size}-${body.length}` });
  });
});
describe("通常全量だけの価格snapshot activation", () => {
  it.each([1, 2, 3, 4])("通常snapshotの第%i PUT直前guard拒否は以後の送信0・既ACK不変", async (rejected) => {
    let calls = 0;
    const stopped = new Error("completion window expired");
    const beforeMutation = () => { if (++calls === rejected) throw stopped; };
    await expect(publishDailyPriceSnapshot({ ...args, beforeMutation })).rejects.toBe(stopped);
    expect(r2Put).toHaveBeenCalledTimes(rejected - 1);
    expect(calls).toBe(rejected);
    if (rejected <= 3) expect(JSON.parse(store.get(PRICE_ACTIVE_KEY)!.body).snapshotId).toBe(base.snapshotId);
    if (rejected >= 3) expect(JSON.parse(store.get("ops/holdings-price/activation.json")!.body).phase).toBe("inflight");
  });
  it("初回固定集合は全原本fresh資格→metadata4CAS/readback、再度は既存latchでSTOP", async () => {
    // 件数・順序の構造入力。架空の価格値/原文を保存するテストではない。
    const members = Object.fromEntries(Array.from({ length: 3456 }, (_, i) => {
      const symbol = `${1000 + i}.T`;
      return [symbol, { ...ref, symbol, receivedAt: "2026-10-04T13:00:00.000Z", file: { ...ref.file, filename: `part-${i % 116}.json.gz` } }];
    }));
    const fixed = { ...base, snapshotId: "37202207552.1", sessionDate: "2026-10-02", members };
    store.clear();
    const verify = vi.fn(async () => { expect(r2Put).not.toHaveBeenCalled(); });
    await bootstrapPriceSnapshot(fixed, verify);
    expect(verify).toHaveBeenCalledTimes(1); expect(r2Put).toHaveBeenCalledTimes(4);
    expect((await readActivatedPriceSnapshot())?.members).toEqual(members);
    expect(vi.mocked(r2Put).mock.calls.map(([key]) => key)).toEqual(["ops/holdings-price/activation.json", expect.stringContaining("snapshot-37202207552.1-"), PRICE_ACTIVE_KEY, "ops/holdings-price/activation.json"]);
    await expect(bootstrapPriceSnapshot(fixed, verify)).rejects.toThrow("既存状態");
    expect(verify).toHaveBeenCalledTimes(1); expect(r2Put).toHaveBeenCalledTimes(4);
  });
  it("初回原本SHA資格失敗/旧状態競合はmetadata送信0", async () => {
    const members = Object.fromEntries(Array.from({ length: 3456 }, (_, i) => {
      const symbol = `${1000 + i}.T`;
      return [symbol, { ...ref, symbol, receivedAt: "2026-10-04T13:00:00.000Z", file: { ...ref.file, filename: `part-${i % 116}.json.gz` } }];
    }));
    const fixed = { ...base, snapshotId: "37202207552.1", sessionDate: "2026-10-02", members };
    const verify = vi.fn(async () => { throw new Error("fresh raw SHA mismatch"); });
    await expect(bootstrapPriceSnapshot(fixed, verify)).rejects.toThrow("既存状態"); expect(verify).not.toHaveBeenCalled();
    store.clear();
    await expect(bootstrapPriceSnapshot(fixed, verify)).rejects.toThrow("SHA mismatch"); expect(r2Put).not.toHaveBeenCalled();
    await expect(bootstrapPriceSnapshot(fixed, async () => { store.set(PRICE_ACTIVE_KEY, { body: "concurrent", etag: "changed" }); })).rejects.toThrow("状態が変化");
    expect(r2Put).not.toHaveBeenCalled();
  });
  it("partial・一社pilot・legacy参照欠測は旧activeを維持しwrite0", async () => {
    const before = store.get(PRICE_ACTIVE_KEY);
    for (const changed of [{ complete: false }, { universe: ["7203", "1301"] }, { references: new Map() }]) {
      expect((await publishDailyPriceSnapshot({ ...args, ...changed })).status).toBe("held");
    }
    expect(store.get(PRICE_ACTIVE_KEY)).toBe(before); expect(r2Put).not.toHaveBeenCalled();
    expect(resolveLatestHoldingsCodeList).not.toHaveBeenCalled();
  });
  it("通常全量は最新の公式銘柄表を新snapshotに束縛し、候補無し/不適格は旧activeを保持する", async () => {
    const nextCodeList = { ...base.codeList, archivePageId: "e".repeat(32), filename: "new-codes.zip" };
    vi.mocked(resolveLatestHoldingsCodeList).mockResolvedValue({ status: "ready", file: nextCodeList });
    await publishDailyPriceSnapshot(args);
    expect((await readActivatedPriceSnapshot())?.codeList).toEqual(nextCodeList);
    expect(resolveLatestHoldingsCodeList).toHaveBeenCalledWith(base.codeList, args.finishedAt);
    const before = store.get(PRICE_ACTIVE_KEY); vi.mocked(r2Put).mockClear();
    vi.mocked(resolveLatestHoldingsCodeList).mockResolvedValue({ status: "held", reason: "保存世代なし" });
    expect(await publishDailyPriceSnapshot({ ...args, runId: "next" })).toEqual({ status: "held", reason: "保存世代なし" });
    vi.mocked(resolveLatestHoldingsCodeList).mockRejectedValue(new Error("newest invalid"));
    await expect(publishDailyPriceSnapshot({ ...args, runId: "next" })).rejects.toThrow("newest invalid");
    expect(store.get(PRICE_ACTIVE_KEY)).toBe(before); expect(r2Put).not.toHaveBeenCalled();
  });
  it("全文readbackしたregistry→inflight→active→completeを各一回CASし、同じ証拠はwrite0", async () => {
    expect(await publishDailyPriceSnapshot(args)).toEqual({ status: "activated" });
    expect(r2Put).toHaveBeenCalledTimes(4);
    expect((await readActivatedPriceSnapshot())?.members["7203.T"]).toEqual(ref);
    vi.mocked(r2Put).mockClear();
    expect(await publishDailyPriceSnapshot({ ...args, runId: "next" })).toEqual({ status: "unchanged" });
    expect(r2Put).not.toHaveBeenCalled();
  });
  it.each([false, true])("active CASのunknown(applied=%s)はinflightを残し次runもSTOP、別snapshotへ迂回しない", async applied => {
    const original = store.get(PRICE_ACTIVE_KEY);
    vi.mocked(r2Put).mockImplementation(async (key, body, etag) => {
      if (key === PRICE_ACTIVE_KEY) {
        if (applied) store.set(key, { body, etag: "unknown-applied" });
        throw new Error("UNKNOWN_PUT");
      }
      expect(store.get(key)?.etag ?? null).toBe(etag); store.set(key, { body, etag: "intent" });
    });
    await expect(publishDailyPriceSnapshot(args)).rejects.toThrow("UNKNOWN_PUT");
    if (!applied) expect(store.get(PRICE_ACTIVE_KEY)).toBe(original);
    const sends = vi.mocked(r2Put).mock.calls.length;
    await expect(publishDailyPriceSnapshot({ ...args, runId: "next" })).rejects.toThrow("結果未確定");
    await expect(readActivatedPriceSnapshot()).rejects.toThrow("結果未確定");
    expect(r2Put).toHaveBeenCalledTimes(sends);
  });
});
