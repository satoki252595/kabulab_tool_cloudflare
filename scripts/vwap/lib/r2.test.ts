import { afterEach, describe, expect, it, vi } from "vitest";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  r2GetVersion,
  r2Put,
  R2PutRejectedError,
  R2PutUnknownError,
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
  Body: { transformToString: async () => "original bytes" },
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

describe("r2Put contract (1 attempt, no retry)", () => {
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
      Body: { transformToString: async () => "x" },
      $metadata: { httpStatusCode: 200 },
    }));
    await expect(r2GetVersion("daily/7203.json")).rejects.toThrow(/不完全/);
  });

  it("non-200 envelope is a fault", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    send.mockImplementationOnce(async () => ({
      ETag: '"x"',
      Body: { transformToString: async () => "x" },
      $metadata: { httpStatusCode: 206 },
    }));
    await expect(r2GetVersion("daily/7203.json")).rejects.toThrow(/不完全/);
  });
});
