/** 試験用の合成実行metadata。実処理の成功・処理件数として使用しない。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { sharedEnv } from "../../src/shared/env.js";
import { localJobScheduledFor, parseLocalJobReceipt, startLocalJobReceipt, mirrorLocalJobReceipt, type LocalJobReceipt } from "./receipt.js";

const running = (): LocalJobReceipt => parseLocalJobReceipt({ version: 1, kind: "biztag", phase: "running",
  scheduledFor: "2026-10-14T11:00:00.000Z", startedAt: "2026-10-14T11:00:01.000Z", finishedAt: null,
  revision: "a".repeat(40), acceptedRevision: "a".repeat(40), code: null, signal: null, retries: 0 });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Macの実行receipt", () => {
  it("通常入口のDNS失敗はGETだけ再読し、bounded本文照合と単発PUTを通す", async () => {
    vi.spyOn(sharedEnv, "R2_ACCOUNT_ID").mockReturnValue("test-account");
    vi.spyOn(sharedEnv, "R2_ACCESS_KEY_ID").mockReturnValue("test-access");
    vi.spyOn(sharedEnv, "R2_SECRET_ACCESS_KEY").mockReturnValue("test-secret");
    vi.spyOn(sharedEnv, "R2_BUCKET").mockReturnValue("test-bucket");
    const current = running(), body = Buffer.from(JSON.stringify(current));
    const send = vi.spyOn(S3Client.prototype, "send")
      .mockRejectedValueOnce(Object.assign(new Error("EXPLICIT_DNS_FAILURE"), { code: "ENOTFOUND", syscall: "getaddrinfo" }))
      .mockRejectedValueOnce(Object.assign(new Error("EXPLICIT_MISSING"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } }))
      .mockImplementationOnce(async () => ({ ETag: '"new"', $metadata: { httpStatusCode: 200 } }))
      .mockImplementationOnce(async () => ({ ETag: '"new"', ContentLength: body.length, Body: Readable.from([body]), $metadata: { httpStatusCode: 200 } }));
    const result = expect(startLocalJobReceipt(current)).resolves.toBe('"new"');
    await result;
    expect(send.mock.calls.map(([command]) => command instanceof GetObjectCommand ? "GET" : command instanceof PutObjectCommand ? "PUT" : "unknown"))
      .toEqual(["GET", "GET", "PUT", "GET"]);
    for (const [command, options] of send.mock.calls) if (command instanceof GetObjectCommand)
      expect((options as { abortSignal: AbortSignal }).abortSignal).toBeInstanceOf(AbortSignal);
  });
  it("JSTの毎日20時/21時を使い、早朝RunAtLoadを当日夜の定時成功へしない", () => {
    expect(localJobScheduledFor("biztag", "2026-10-14T11:00:01.000Z")).toBe("2026-10-14T11:00:00.000Z");
    expect(localJobScheduledFor("yutai-summary", "2026-10-14T12:00:01.000Z")).toBe("2026-10-14T12:00:00.000Z");
    expect(localJobScheduledFor("biztag", "2026-10-14T00:00:01.000Z")).toBe("2026-10-13T11:00:00.000Z");
  });

  it("原文/架空件数/完了時計の補完が混じる契約は拒否する", () => {
    for (const value of [
      { ...running(), description: "原文の番兵" }, { ...running(), processed: 0 },
      { ...running(), phase: "finished", code: 0 },
      { ...running(), startedAt: "2026-02-30T11:00:01.000Z" },
    ]) expect(() => parseLocalJobReceipt(value)).toThrow();
  });

  it("開始/終了を2PUT+3GETだけでCAS保存し、終了code0と件数を混同しない", async () => {
    let stored: { body: string; etag: string } | null = null;
    const get = vi.fn(async () => stored);
    const put = vi.fn(async (_key: string, body: string, version: string | null) => {
      expect(version).toBe(stored === null ? null : stored.etag);
      stored = { body, etag: `v${put.mock.calls.length}` };
    });
    const etag = await startLocalJobReceipt(running(), { get, put });
    const finished = parseLocalJobReceipt({ ...running(), phase: "finished", finishedAt: "2026-10-14T11:20:00.000Z", code: 0 });
    await mirrorLocalJobReceipt(finished, etag, { get, put });
    expect(put).toHaveBeenCalledTimes(2); expect(get).toHaveBeenCalledTimes(3);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!.body)).toEqual(finished);
    expect(stored!.body).not.toContain("processed");
  });

  it("PUT結果不明はreadback/再送/完了偽装をしない", async () => {
    const get = vi.fn(async () => null);
    const put = vi.fn(async () => { throw new Error("outcome unknown"); });
    await expect(startLocalJobReceipt(running(), { get, put })).rejects.toThrow(/unknown/);
    expect(put).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1);
  });

  it("終了CAS競合やreadback差分を成功として返さない", async () => {
    const finished = parseLocalJobReceipt({ ...running(), phase: "finished", finishedAt: "2026-10-14T11:20:00.000Z", code: 1 });
    const rejected = vi.fn(async () => { throw new Error("412"); });
    await expect(mirrorLocalJobReceipt(finished, "observed", { get: async () => null, put: rejected })).rejects.toThrow(/412/);
    expect(rejected).toHaveBeenCalledTimes(1);
    const put = vi.fn(async () => {});
    await expect(mirrorLocalJobReceipt(finished, "observed", { get: async () => ({ body: "{}", etag: "new" }), put })).rejects.toThrow(/全文照合/);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("壊れた先行receiptとLOCAL_OUTではmirror/処理を開始しない", async () => {
    const put = vi.fn(async () => {});
    await expect(startLocalJobReceipt(running(), { get: async () => ({ body: "{}", etag: "old" }), put })).rejects.toThrow();
    await expect(startLocalJobReceipt(running(), { get: async () => ({ body: "原文の番兵", etag: "old" }), put })).rejects.toThrow(/内容を公開せず/);
    expect(put).not.toHaveBeenCalled();
    vi.stubEnv("LOCAL_OUT", "/private-preview");
    const get = vi.fn(async () => null);
    await expect(startLocalJobReceipt(running(), { get, put })).rejects.toThrow(/LOCAL_OUT/);
    expect(get).not.toHaveBeenCalled();
  });

  it("同じslotの未完runを重複RunAtLoadで置換しない", async () => {
    const old = running();
    const current = { ...old, startedAt: "2026-10-14T11:00:02.000Z" };
    const put = vi.fn(async () => {});
    const get = vi.fn(async () => ({ body: JSON.stringify(old), etag: "live" }));
    await expect(startLocalJobReceipt(current, { get, put })).rejects.toThrow(/同一予定/);
    expect(put).not.toHaveBeenCalled(); expect(get).toHaveBeenCalledTimes(1);
  });

  it("前slotの未完は私有保全・照合・警告を残せる場合だけ次slotへ進む", async () => {
    const old = running(), body = JSON.stringify(old);
    const current = parseLocalJobReceipt({ ...old, scheduledFor: "2026-10-15T11:00:00.000Z", startedAt: "2026-10-15T11:00:01.000Z" });
    const put = vi.fn(async () => {});
    const withoutHistory = { get: async () => ({ body, etag: "old" }), put };
    await expect(startLocalJobReceipt(current, withoutHistory)).rejects.toThrow(/保全/);
    expect(put).not.toHaveBeenCalled();
    const dir = mkdtempSync(join(tmpdir(), "local-job-history-"));
    try {
      const history = join(dir, "previous-incomplete.json");
      const get = vi.fn().mockResolvedValueOnce({ body, etag: "old" })
        .mockResolvedValueOnce({ body: JSON.stringify(current), etag: "new" });
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      await startLocalJobReceipt(current, { get, put }, history);
      expect(readFileSync(history, "utf8")).toBe(body);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("previous_incomplete"));
      expect(put).toHaveBeenCalledTimes(1);
      expect(put.mock.calls[0]).toEqual(["local-jobs/biztag/latest.json", JSON.stringify(current), "old"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
