import { describe, expect, it } from "vitest";
import { SHARED_WRITER_KEY, currentPublishingWriter, initializeSharedPublishingWriter, publishingReadOnly, withSharedPublishingWriter, type PublishingStore } from "./shared-writer.js";

/** Protocol-only CAS server. No financial values or production credentials. */
function server(seed = true) {
  let version = 0;
  const objects = new Map<string, { body: string; etag: string }>();
  const puts: string[] = [];
  if (seed) objects.set(SHARED_WRITER_KEY, { body: JSON.stringify({ version: 1, baselineSha256: "0".repeat(64), owner: null, pending: null }) + "\n", etag: "initial" });
  let unknownRequest = false;
  const store: PublishingStore = {
    async get(key, maxBytes) { const value = objects.get(key); if (!value) return null; expect(Buffer.byteLength(value.body)).toBeLessThanOrEqual(maxBytes); return { ...value }; },
    async put(key, body, etag) {
      if ((objects.get(key)?.etag ?? null) !== etag) throw new Error("412 protocol CAS rejection");
      puts.push(key); objects.set(key, { body, etag: `version-${++version}` });
      if (unknownRequest && key.endsWith("/request.json")) throw new Error("protocol ACK unknown");
    },
  };
  return { store, objects, puts, unknown: () => { unknownRequest = true; } };
}
describe("cross-host publication owner and sticky pending", () => {
  it("missing shared baseline cannot be replaced by an empty Linux/local state", async () => {
    const s = server(false); let business = 0;
    await expect(withSharedPublishingWriter(async () => { business++; }, s.store)).rejects.toThrow("未初期化");
    expect(business).toBe(0); expect(s.puts).toEqual([]);
  });
  it("two hosts observing the same released state cannot both acquire its ETag", async () => {
    const s = server(); let entered = 0;
    const result = await Promise.allSettled([1, 2].map(() => withSharedPublishingWriter(async () => { entered++; }, s.store)));
    expect(entered).toBe(1); expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(JSON.parse(s.objects.get(SHARED_WRITER_KEY)!.body).owner).toBeNull();
  });
  it("unknown request archive leaves one shared pending intent and never resends through another host", async () => {
    const s = server(); s.unknown(); let business = 0;
    await expect(withSharedPublishingWriter(async () => {
      const op = await currentPublishingWriter()!.reserve("supplement-update", { pageId: "protocol-row" }, '{"protocol":"whole PRE"}');
      business++; await op.complete({ postPageSha256: "1".repeat(64) });
    }, s.store)).rejects.toThrow("ACK unknown");
    const snapshot = [...s.objects.entries()];
    await expect(withSharedPublishingWriter(async () => { business++; }, s.store)).rejects.toThrow("期限では解除しません");
    expect(business).toBe(0); expect([...s.objects.entries()]).toEqual(snapshot);
    expect(s.puts.filter(key => key.endsWith("/request.json"))).toHaveLength(1);
  });
  it("only complete publication can clear pending, persist the cursor and release the owner", async () => {
    const s = server();
    await withSharedPublishingWriter(async () => {
      const writer = currentPublishingWriter()!;
      expect(await writer.readCursor("supplement-texts")).toBeNull();
      const op = await writer.reserve("supplement-update", { pageId: "protocol-row" }, '{"protocol":"whole PRE"}');
      await expect(writer.writeCursor("supplement-texts", '{"afterCode":"1301"}')).rejects.toThrow("未閉鎖");
      // A rejected transition is sticky, so this run must remain blocked.
      await expect(op.complete({})).rejects.toThrow("sticky STOP");
    }, s.store).catch(error => { expect(error.message).toContain("sticky STOP"); });
    expect(JSON.parse(s.objects.get(SHARED_WRITER_KEY)!.body).pending).not.toBeNull();
    const clean = server();
    await withSharedPublishingWriter(async () => {
      const writer = currentPublishingWriter()!;
      expect(await writer.readCursor("supplement-texts")).toBeNull();
      const op = await writer.reserve("supplement-update", { pageId: "protocol-row" }, '{"protocol":"whole PRE"}');
      await op.complete({ archivePageId: "protocol-archive", postPageSha256: "1".repeat(64) });
      await writer.writeCursor("supplement-texts", '{"afterCode":"1301"}');
    }, clean.store);
    await withSharedPublishingWriter(async () => {
      expect(await currentPublishingWriter()!.readCursor("supplement-texts")).toBe('{"afterCode":"1301"}');
    }, clean.store);
    expect(JSON.parse(clean.objects.get(SHARED_WRITER_KEY)!.body)).toMatchObject({ owner: null, pending: null });
    expect(clean.puts.filter(key => key.endsWith("/completed.json"))).toHaveLength(1);
  });
  it("malformed shared state cannot authorize a publication", async () => {
    const s = server(); s.objects.get(SHARED_WRITER_KEY)!.body = '{}';
    await expect(withSharedPublishingWriter(async () => {}, s.store)).rejects.toThrow(); expect(s.puts).toEqual([]);
  });
  it("a declared pure read failure releases only before any publication/cursor attempt", async () => {
    const s = server();
    await expect(withSharedPublishingWriter(() => publishingReadOnly(async () => { throw new Error("offline GET fault"); }), s.store)).rejects.toThrow("publishing_read_only_failed");
    expect(JSON.parse(s.objects.get(SHARED_WRITER_KEY)!.body)).toMatchObject({ owner: null, pending: null });
    await withSharedPublishingWriter(async () => {}, s.store);
    await expect(withSharedPublishingWriter(async () => {
      const op = await currentPublishingWriter()!.reserve("supplement-update", {}, '{"protocol":"PRE"}');
      await op.complete({ protocol: "POST verified" });
      await publishingReadOnly(async () => { throw new Error("later GET fault"); });
    }, s.store)).rejects.toThrow("publishing_read_only_failed");
    expect(JSON.parse(s.objects.get(SHARED_WRITER_KEY)!.body).owner).not.toBeNull();
    await expect(withSharedPublishingWriter(async () => {}, s.store)).rejects.toThrow("期限では解除しません");
  });
  it("an unknown cursor PUT stays blocked even when the bytes were applied", async () => {
    const s = server(), original = s.store.put;
    s.store.put = async (key, body, etag) => { await original(key, body, etag); if (key.includes("/cursors/")) throw new Error("cursor ACK unknown"); };
    await expect(withSharedPublishingWriter(async () => {
      const writer = currentPublishingWriter()!; await writer.readCursor("supplement-texts");
      await writer.writeCursor("supplement-texts", '{}');
    }, s.store)).rejects.toThrow("cursor ACK unknown");
    const writes = s.puts.length;
    await expect(withSharedPublishingWriter(async () => {}, s.store)).rejects.toThrow("期限では解除しません");
    expect(s.puts).toHaveLength(writes);
  });
  it("initialization rejects every non-Mac host before any remote mutation", async () => {
    if (process.platform === "darwin" && process.arch === "arm64") return;
    const s = server(false);
    await expect(initializeSharedPublishingWriter({ protocol: "empty local state" }, s.store)).rejects.toThrow("Mac");
    expect(s.puts).toEqual([]);
  });
});
