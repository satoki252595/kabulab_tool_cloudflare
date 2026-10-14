import { afterEach, describe, expect, it, vi } from "vitest";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { createServer, get as httpGet, type IncomingMessage } from "node:http";
import {
  r2GetVersion,
  r2GetBytesVersion,
  r2Put,
  r2PutBytes,
  R2PutRejectedError,
  R2PutUnknownError,
  type R2ReadOptions,
} from "./r2.js";

vi.mock("../../../src/shared/env.js", () => ({
  sharedEnv: {
    LOCAL_OUT: () => undefined,
    R2_BUCKET: () => "test-bucket",
    R2_ACCOUNT_ID: () => "test-account",
    R2_ACCESS_KEY_ID: () => "test-access",
    R2_SECRET_ACCESS_KEY: () => "test-secret",
  },
}));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const okGet = () => ({
  ETag: '"native-etag"',
  Body: { transformToByteArray: async () => new TextEncoder().encode("original bytes") },
  $metadata: { httpStatusCode: 200 },
});
const okPut = () => ({
  ETag: '"put-etag"',
  $metadata: { httpStatusCode: 200 },
});
const svcError = (name: string, status?: number) =>
  Object.assign(new Error(name), {
    name,
    ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }),
  });

it("conditional repair preserves the native ETag and propagates a stale precondition failure", async () => {
  const send = vi.spyOn(S3Client.prototype, "send");
  send.mockImplementationOnce(async () => okGet());
  const current = await r2GetVersion("daily/1909.json");
  expect(current).toEqual({ body: "original bytes", etag: '"native-etag"' });
  send.mockRejectedValueOnce(svcError("PreconditionFailed", 412));
  await expect(
    r2Put("daily/1909.json", "repaired bytes", current!.etag),
  ).rejects.toBeInstanceOf(R2PutRejectedError);
  const command = send.mock.calls[1][0] as PutObjectCommand;
  expect(command).toBeInstanceOf(PutObjectCommand);
  expect(command.input).toMatchObject({
    Bucket: "test-bucket",
    Key: "daily/1909.json",
    IfMatch: '"native-etag"',
  });
});

it("native metadata uses the same single conditional PUT while body bytes stay unchanged", async () => {
  const metadata = { "holdings-price": '{"bodySha256":"proof"}', unrelated: "preserved" };
  const send = vi.spyOn(S3Client.prototype, "send").mockImplementationOnce(async () => okPut());
  await r2Put("daily/7203.json", "original bytes", '"observed"', metadata);
  expect(send).toHaveBeenCalledTimes(1);
  expect((send.mock.calls[0][0] as PutObjectCommand).input).toMatchObject({
    Body: new TextEncoder().encode("original bytes"), IfMatch: '"observed"', Metadata: metadata,
  });
  send.mockImplementationOnce(async () => ({ ...okGet(), Metadata: metadata }));
  expect(await r2GetVersion("daily/7203.json")).toEqual({ body: "original bytes", etag: '"native-etag"', metadata });
});

it("invalid/oversized custom metadata never sends or becomes a successful GET", async () => {
  const send = vi.spyOn(S3Client.prototype, "send");
  await expect(r2Put("daily/7203.json", "original bytes", null, { "holdings-price": "x".repeat(2048) })).rejects.toThrow("metadata");
  expect(send).not.toHaveBeenCalled();
  send.mockImplementationOnce(async () => ({ ...okGet(), Metadata: { "holdings-price": 1 } }));
  await expect(r2GetVersion("daily/7203.json")).rejects.toThrow("metadata");
  expect(send).toHaveBeenCalledTimes(1);
});

it.each([undefined, 1000])("bounded metadata reads reject unknown/oversized length %s before reading the body", async length => {
  const body = vi.fn(async () => new Uint8Array(1000)), destroy = vi.fn();
  const send = vi.spyOn(S3Client.prototype, "send").mockImplementationOnce(async () => ({
    ...okGet(), ...(length === undefined ? {} : { ContentLength: length }), Body: { transformToByteArray: body, destroy },
  }));
  await expect(r2GetVersion("ops/holdings-price/active.json", { maxBytes: 128 })).rejects.toThrow("byte budget");
  expect(send).toHaveBeenCalledTimes(1); expect(body).not.toHaveBeenCalled(); expect(destroy).toHaveBeenCalledTimes(1);
});

describe("r2Put contract (1 attempt, no retry)", () => {
  it("bounded transport abort stops a mutation without replay", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementationOnce((_command, options) =>
      new Promise((_resolve, reject) => {
        const signal = (options as { abortSignal: AbortSignal }).abortSignal;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }));
    const pending = r2Put("daily/7203.json", "{}", null);
    controller.abort(new DOMException("transport timed out", "TimeoutError"));
    await expect(pending).rejects.toBeInstanceOf(R2PutUnknownError);
    expect(timeout).toHaveBeenCalledWith(60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("known missing objects create only while still absent", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockRejectedValueOnce(svcError("PreconditionFailed", 412));
    await expect(r2Put("daily/7203.json", "{}", null)).rejects.toBeInstanceOf(R2PutRejectedError);
    const command = send.mock.calls[0][0] as PutObjectCommand;
    expect(command.input.IfNoneMatch).toBe("*");
    expect(command.input.IfMatch).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "", " ", "*", " * "])("invalid observed version %s never sends", async (version) => {
    const send = vi.spyOn(S3Client.prototype, "send");
    await expect(r2Put("daily/7203.json", "{}", version as string)).rejects.toThrow("observed ETag");
    expect(send).not.toHaveBeenCalled();
  });
  it("2xx + ETag resolves", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockImplementationOnce(async () => okPut());
    await r2Put("daily/7203.json", "{}", null);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("timeout without response is unknown, sent once", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockRejectedValueOnce(svcError("TimeoutError"));
    await expect(r2Put("daily/7203.json", "{}", null)).rejects.toBeInstanceOf(
      R2PutUnknownError
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([["InternalError", 500], ["SlowDown", 503], ["TooManyRequests", 429]])(
    "%s (%s) is unknown, never rejected",
    async (name, status) => {
      const send = vi.spyOn(S3Client.prototype, "send");
      send.mockRejectedValueOnce(svcError(name, status));
      await expect(r2Put("daily/7203.json", "{}", null)).rejects.toBeInstanceOf(
        R2PutUnknownError
      );
      expect(send).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ["PreconditionFailed", 412],
    ["Forbidden", 403],
    ["BadRequest", 400],
  ])("%s (%s) is explicit rejection", async (name, status) => {
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockRejectedValueOnce(svcError(name, status));
    await expect(r2Put("daily/7203.json", "{}", null)).rejects.toBeInstanceOf(
      R2PutRejectedError
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("2xx without ETag is unknown, not success", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockImplementationOnce(async () => ({ $metadata: { httpStatusCode: 200 } }));
    await expect(r2Put("daily/7203.json", "{}", null)).rejects.toBeInstanceOf(
      R2PutUnknownError
    );
  });

  it("resolved response without metadata is unknown", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockImplementationOnce(async () => ({ ETag: '"x"' }));
    await expect(r2Put("daily/7203.json", "{}", null)).rejects.toBeInstanceOf(
      R2PutUnknownError
    );
  });

  it("messages carry sanitized code/status only, no raw cause text", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockRejectedValueOnce(
      Object.assign(new Error("https://secret.example/endpoint?key=LEAK"), {
        name: "TimeoutError",
      })
    );
    const err = (await r2Put("daily/7203.json", "{}", null).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("cause=TimeoutError/none");
    expect(err.message).not.toContain("LEAK");
    expect(err.message).not.toContain("https://");
  });
});

describe("SDK retry disabled", () => {
  it("shared client resolves maxAttempts 1 (send count alone proves nothing)", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockImplementationOnce(async () => okGet());
    await r2GetVersion("daily/7203.json");
    // 新規 public API なしに実 client instance の解決済み設定を読む。
    const client = send.mock.contexts[0] as unknown as {
      config: { maxAttempts: () => Promise<number> };
    };
    await expect(client.config.maxAttempts()).resolves.toBe(1);
  });
});

describe("r2GetVersion contract", () => {
  it("native transient GET failure retries only the read and keeps the returned version", async () => {
    vi.useFakeTimers();
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockRejectedValueOnce(svcError("InternalError", 500)).mockImplementationOnce(async () => okGet());
    const result = expect(r2GetVersion("daily/9409.json")).resolves.toEqual({ body: "original bytes", etag: '"native-etag"' });
    await vi.runAllTimersAsync();
    await result;
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([command]) => command instanceof GetObjectCommand)).toBe(true);
  });

  it("three failed native GET attempts remain a fault and never become a missing object", async () => {
    vi.useFakeTimers();
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockRejectedValue(svcError("InternalError", 500));
    const rejected = expect(r2GetVersion("daily/9409.json")).rejects.toThrow("InternalError");
    await vi.runAllTimersAsync();
    await rejected;
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.every(([command]) => command instanceof GetObjectCommand)).toBe(true);
  });

  it("explicit NoSuchKey is normal bootstrap (null)", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockRejectedValueOnce(svcError("NoSuchKey", 404));
    await expect(r2GetVersion("daily/7203.json")).resolves.toBeNull();
  });

  it("NoSuchKey with contradictory metadata is a fault, not bootstrap", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockRejectedValueOnce(svcError("NoSuchKey", 500));
    await expect(r2GetVersion("daily/7203.json")).rejects.toThrow();
    send.mockRejectedValueOnce(svcError("NoSuchKey"));
    await expect(r2GetVersion("daily/7203.json")).rejects.toThrow();
  });

  it("generic 404 without NoSuchKey is a fault, not bootstrap", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockRejectedValueOnce(svcError("NotFound", 404));
    await expect(r2GetVersion("daily/7203.json")).rejects.toThrow();
  });

  it("non-404 faults throw", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockRejectedValueOnce(svcError("Forbidden", 403));
    await expect(r2GetVersion("daily/7203.json")).rejects.toThrow();
  });

  it("200 without ETag is a fault", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockImplementationOnce(async () => ({
      Body: { transformToByteArray: async () => new TextEncoder().encode("x") },
      $metadata: { httpStatusCode: 200 },
    }));
    await expect(r2GetVersion("daily/7203.json")).rejects.toThrow(/不完全/);
  });

  it("non-200 envelope is a fault", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockImplementationOnce(async () => ({
      ETag: '"x"',
      Body: { transformToByteArray: async () => new TextEncoder().encode("x") },
      $metadata: { httpStatusCode: 206 },
    }));
    await expect(r2GetVersion("daily/7203.json")).rejects.toThrow(/不完全/);
  });
});

describe("binary原本も既存CAS/unknown契約を共有する", () => {
  it("非UTF8 bytesと明示bucketを読書きで保持する", async () => {
    const body = new Uint8Array([0, 255, 254, 128]);
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockImplementationOnce(async () => ({ ...okGet(), Body: { transformToByteArray: async () => body } }));
    expect(await r2GetBytesVersion("raw/source/file.zip", "raw-bucket")).toEqual({body, etag: '"native-etag"'});
    expect((send.mock.calls[0][0] as GetObjectCommand).input.Bucket).toBe("raw-bucket");
    send.mockImplementationOnce(async () => okPut());
    await r2PutBytes("raw/source/file.zip", body, null, "raw-bucket", "application/zip");
    expect((send.mock.calls[1][0] as PutObjectCommand).input).toMatchObject({ Bucket: "raw-bucket", Body: body, ContentType: "application/zip", IfNoneMatch: "*" });
  });
  it("binary PUTのunknownは一度で停止し、bucket未指定は送信しない", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockRejectedValueOnce(svcError("TimeoutError"));
    await expect(r2PutBytes("raw/file.pdf", new Uint8Array([255]), null, "raw-bucket", "application/pdf")).rejects.toBeInstanceOf(R2PutUnknownError);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(r2PutBytes("raw/file.pdf", new Uint8Array([255]), null, undefined, "application/pdf")).rejects.toThrow("bucket");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("明示singleAttemptのbinary GETは既知5xxでも再読しない", async () => {
    vi.useFakeTimers();
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockRejectedValue(svcError("InternalError", 500));
    const rejected = expect(r2GetBytesVersion("raw/file.pdf", "raw-bucket", { singleAttempt: true })).rejects.toThrow("InternalError");
    await vi.runAllTimersAsync();
    await rejected;
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("explicit SDK read budgets include the native body tail", () => {
  it("reserves once before send and observes the exact full bytes/ETag once", async () => {
    const bytes = new Uint8Array([0, 255, 254, 128]), order: string[] = [];
    const beforeAttempt = vi.fn(() => { order.push("reserve"); });
    const onRead = vi.fn(() => { order.push("full-body"); });
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementationOnce(async () => {
      order.push("send");
      return { ...okGet(), ContentLength: bytes.length, Body: Readable.from([bytes]) };
    });
    const result = await r2GetBytesVersion("raw/file.zip", "raw-bucket", { singleAttempt: true, maxBytes: 4, beforeAttempt, onRead });
    expect(new Uint8Array(result!.body)).toEqual(bytes); expect(result!.etag).toBe('"native-etag"');
    expect(order).toEqual(["reserve", "send", "full-body"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onRead).toHaveBeenCalledExactlyOnceWith({ status: 200, etag: '"native-etag"', contentLength: 4, body: Buffer.from(bytes), receivedBytes: 4, complete: true });
  });

  it("an expired reservation prevents the native send", async () => {
    const controller = new AbortController(), onRead = vi.fn();
    const beforeAttempt = vi.fn(() => { controller.abort(new Error("absolute deadline")); });
    const send = vi.spyOn(S3Client.prototype, "send");
    await expect(r2GetVersion("macro/jp-close/2026-10-14.json", { singleAttempt: true, maxBytes: 128, abortSignal: controller.signal, beforeAttempt, onRead })).rejects.toThrow("absolute deadline");
    expect(beforeAttempt).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled(); expect(onRead).not.toHaveBeenCalled();
  });

  it("the caller deadline aborts a stalled tail after headers and preserves the received prefix", async () => {
    const controller = new AbortController(), prefix = Buffer.from("ab"), stream = new Readable({ read() {} });
    stream.push(prefix);
    const onRead = vi.fn(), beforeAttempt = vi.fn();
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementationOnce(async (_command, options) => {
      expect((options as { abortSignal: AbortSignal }).abortSignal.aborted).toBe(false);
      return { ...okGet(), ContentLength: 4, Body: stream };
    });
    const pending = r2GetVersion("macro/jp-close/2026-10-14.json", { singleAttempt: true, maxBytes: 4, abortSignal: controller.signal, beforeAttempt, onRead });
    const rejected = expect(pending).rejects.toThrow("absolute deadline");
    await new Promise<void>(resolve => setImmediate(resolve));
    controller.abort(new Error("absolute deadline"));
    await rejected;
    expect(stream.destroyed).toBe(true); expect(send).toHaveBeenCalledTimes(1); expect(beforeAttempt).toHaveBeenCalledTimes(1);
    expect(onRead).toHaveBeenCalledExactlyOnceWith({ status: 200, etag: '"native-etag"', contentLength: 4, body: prefix, receivedBytes: 2, complete: false });
  });

  it.each([
    ["short", Buffer.from("ab"), 4, 4, "ContentLength", Buffer.from("ab")],
    ["oversized chunk", Buffer.from("abcdef"), 4, 4, "byte budget", Buffer.from("abcd")],
  ])("%s is a fault, with a bounded prefix and actual received-byte count", async (_name, bytes, length, maxBytes, error, prefix) => {
    const stream = Readable.from([bytes]), onRead = vi.fn();
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementationOnce(async () => ({ ...okGet(), ContentLength: length, Body: stream }));
    await expect(r2GetVersion("macro/jp-close/2026-10-14.json", { singleAttempt: true, maxBytes, onRead })).rejects.toThrow(error);
    expect(onRead).toHaveBeenCalledExactlyOnceWith({ status: 200, etag: '"native-etag"', contentLength: length, body: prefix, receivedBytes: bytes.length, complete: false });
    expect(stream.destroyed).toBe(true); expect(send).toHaveBeenCalledTimes(1);
  });

  it("an actual interrupted HTTP body is never full-read ACK or retried", async () => {
    // Loopback transport fault injection only: no vendor/R2/production call.
    const server = createServer((_req, res) => { res.writeHead(200, { "Content-Length": "4" }); res.write("ab"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    let incoming: IncomingMessage | undefined;
    try {
      const address = server.address(); if (address === null || typeof address === "string") throw new Error("loopback address");
      incoming = await new Promise<IncomingMessage>((resolve, reject) => { httpGet(`http://127.0.0.1:${address.port}`, resolve).once("error", reject); });
      const body = incoming, onRead = vi.fn();
      const send = vi.spyOn(S3Client.prototype, "send").mockImplementationOnce(async () => ({ ...okGet(), ContentLength: 4, Body: body }));
      const pending = r2GetVersion("macro/jp-close/2026-10-14.json", { singleAttempt: true, maxBytes: 4, onRead });
      const rejected = expect(pending).rejects.toThrow();
      await new Promise<void>(resolve => setImmediate(resolve));
      server.closeAllConnections();
      await rejected;
      expect(onRead).toHaveBeenCalledExactlyOnceWith({ status: 200, etag: '"native-etag"', contentLength: 4, body: Buffer.from("ab"), receivedBytes: 2, complete: false });
      expect(body.destroyed).toBe(true); expect(send).toHaveBeenCalledTimes(1);
    } finally {
      incoming?.destroy(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("singleAttempt does not back off/retry known 5xx, and a failed observer cannot become success", async () => {
    const beforeAttempt = vi.fn(), onRead = vi.fn();
    const send = vi.spyOn(S3Client.prototype, "send").mockRejectedValueOnce(svcError("InternalError", 500));
    const sleep = vi.spyOn(globalThis, "setTimeout");
    await expect(r2GetVersion("macro/jp-close/2026-10-14.json", { singleAttempt: true, maxBytes: 4, beforeAttempt, onRead })).rejects.toThrow("InternalError");
    expect(send).toHaveBeenCalledTimes(1); expect(beforeAttempt).toHaveBeenCalledTimes(1); expect(onRead).not.toHaveBeenCalled(); expect(sleep).not.toHaveBeenCalled();
    send.mockImplementationOnce(async () => ({ ...okGet(), ContentLength: 2, Body: Readable.from([Buffer.from("ab")]) }));
    const fail: R2ReadOptions["onRead"] = () => { throw new Error("durable observation failed"); };
    await expect(r2GetVersion("macro/jp-close/2026-10-14.json", { singleAttempt: true, maxBytes: 4, onRead: fail })).rejects.toThrow("durable observation failed");
    expect(send).toHaveBeenCalledTimes(2);
  });
});
