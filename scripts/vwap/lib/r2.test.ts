import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { createServer, get as httpGet, type IncomingMessage } from "node:http";
import {
  r2GetVersion,
  r2GetBytesVersion,
  r2Put,
  r2PutBytes,
  confirmUnknownPricePut,
  beginR2PutDiagRun,
  logR2PutRunSummary,
  noteR2PutFatal,
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
    GITHUB_SHA: () => {
      const value = process.env.GITHUB_SHA;
      return value && value.trim() !== "" ? value : undefined;
    },
    GITHUB_RUN_ID: () => {
      const value = process.env.GITHUB_RUN_ID;
      return value && value.trim() !== "" ? value : undefined;
    },
  },
}));
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); beginR2PutDiagRun(); });

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

describe("unknown価格PUTの正のPOST状態照合だけを許可する", () => {
  const body = '{"code":"3513"}'; // 宣言したtransport control。実市場値ではない。
  const metadata = { unrelated: "retained", "holdings-price": "qualified-reference" };
  const native = (overrides: Record<string, unknown> = {}) => ({ ETag: '"native-observed"',
    ContentLength: Buffer.byteLength(body), ContentType: "application/json", Metadata: metadata,
    Body: Readable.from([Buffer.from(body)]), $metadata: { httpStatusCode: 200 }, ...overrides });
  const unknown = () => new R2PutUnknownError("daily/3513.json", "InternalError", 500, svcError("InternalError", 500));

  it("native閉鎖済みのunknown確認はGETせず、元unknownを保持する", async () => {
    const controller = new AbortController(); controller.abort();
    const error = unknown(), send = vi.spyOn(S3Client.prototype, "send");
    await expect(confirmUnknownPricePut(error, "daily/3513.json", body, metadata, () => {}, { abortSignal: controller.signal }))
      .rejects.toBe(error);
    expect(send).not.toHaveBeenCalled();
  });

  it("PUT500→全bytes/metadata一致のGET1回だけで閉鎖し、ACK不明をproofへ保持する", async () => {
    const error = svcError("InternalError", 500), send = vi.spyOn(S3Client.prototype, "send")
      .mockRejectedValueOnce(error).mockImplementationOnce(async () => native());
    const assertActive = vi.fn();
    const result = await r2Put("daily/3513.json", body, '"old-etag"', metadata)
      .catch(e => confirmUnknownPricePut(e, "daily/3513.json", body, metadata, assertActive));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);
    expect((send.mock.calls[1][0] as GetObjectCommand).input).toEqual({ Bucket: "test-bucket", Key: "daily/3513.json" });
    expect(result).toMatchObject({ putAcknowledgement: "unknown", state: "exact-post-observed", complete: true,
      etag: '"native-observed"', bodyBytes: Buffer.byteLength(body), contentType: "application/json" });
    expect(result?.bodySha256).toMatch(/^[a-f0-9]{64}$/); expect(assertActive).toHaveBeenCalledTimes(3);
  });

  it.each(["body", "metadata-missing", "metadata-extra", "content-type", "etag", "truncated", "length", "read-500", "missing"])("%s は元unknownを保持し再送/GET再試行しない", async mode => {
    const error = unknown(), send = vi.spyOn(S3Client.prototype, "send");
    if (mode === "read-500") send.mockRejectedValueOnce(svcError("InternalError", 500));
    else if (mode === "missing") send.mockRejectedValueOnce(svcError("NoSuchKey", 404));
    else send.mockImplementationOnce(async () => native({
      ...(mode === "body" ? { Body: Readable.from([Buffer.from(body.replace("3513", "3514"))]) } : {}),
      ...(mode === "metadata-missing" ? { Metadata: undefined } : {}),
      ...(mode === "metadata-extra" ? { Metadata: { ...metadata, extra: "unexpected" } } : {}),
      ...(mode === "content-type" ? { ContentType: "text/plain" } : {}),
      ...(mode === "etag" ? { ETag: "" } : {}),
      ...(mode === "truncated" ? { Body: Readable.from([Buffer.from(body.slice(1))]) } : {}),
      ...(mode === "length" ? { ContentLength: undefined } : {}),
    }));
    await expect(confirmUnknownPricePut(error, "daily/3513.json", body, metadata, () => {})).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
  });

  it("metadataの順序と空bagを正規化するが、UTF8復号後の見かけ同値は採用しない", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementationOnce(async () => native({ Metadata: { "holdings-price": metadata["holdings-price"], unrelated: metadata.unrelated } }));
    await expect(confirmUnknownPricePut(unknown(), "daily/3513.json", body, metadata, () => {})).resolves.toMatchObject({ state: "exact-post-observed" });
    send.mockImplementationOnce(async () => native({ Metadata: {} }));
    await expect(confirmUnknownPricePut(unknown(), "intra/3513.json", body, undefined, () => {})).resolves.toMatchObject({ state: "exact-post-observed" });
    send.mockImplementationOnce(async () => native({ Metadata: undefined, ContentLength: 1, Body: Readable.from([Buffer.from([255])]) }));
    const error = unknown();
    await expect(confirmUnknownPricePut(error, "daily/3513.json", "\ufffd", undefined, () => {})).rejects.toBe(error);
  });

  it.each(["rejected", "other-key", "expired-before", "expired-after"])("%s はPUT成功へ変えず、期限外に新規GETしない", async mode => {
    const error = mode === "rejected" ? new R2PutRejectedError("daily/3513.json", "PreconditionFailed", 412, null) : unknown();
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementationOnce(async () => native());
    const active = vi.fn(() => { if (mode === "expired-before" || mode === "expired-after" && active.mock.calls.length === 3) throw new Error("deadline"); });
    await expect(confirmUnknownPricePut(error, mode === "other-key" ? "ops/3513.json" : "daily/3513.json", body, metadata, active)).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(mode === "expired-after" ? 1 : 0);
  });
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
  it("JSON wrapperもcallerのnative guard/signalをSDKへ渡し、期限切れなら送信0", async () => {
    const controller = new AbortController(), beforeAttempt = vi.fn();
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementationOnce(async () => okPut());
    const options = { abortSignal: controller.signal, beforeAttempt };
    await r2Put("daily/7203.json", "{}", null, undefined, options);
    expect(beforeAttempt).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
    const signal = (send.mock.calls[0][1] as { abortSignal: AbortSignal }).abortSignal;
    controller.abort(); expect(signal.aborted).toBe(true);
    await expect(r2Put("daily/7203.json", "{}", null, undefined, options)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });
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

  it("PUT failure logs one incident line and still throws the same error", async () => {
    const body = `<Error><Code>SlowDown</Code>${"😀".repeat(301)}</Error>`;
    const sdk = Object.assign(new Error("https://secret.example/leak?X-Amz-Signature=abcdef"), {
      name: "InternalError",
      code: "SlowDown",
      $metadata: { httpStatusCode: 500, requestId: "req-abc" },
      $response: {
        headers: { "content-type": "application/xml", authorization: "Bearer test-secret", "x-amz-request-id": "req-header" },
        body: new TextEncoder().encode(body),
      },
    });
    const send = vi.spyOn(S3Client.prototype, "send").mockRejectedValueOnce(sdk);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = await r2Put("daily/7203.json", "{}", '"observed"').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(R2PutUnknownError);
    expect(error).toMatchObject({ cause: sdk });
    expect((error as Error).message).toContain("cause=InternalError/500");
    expect((error as Error).message).not.toContain("https://");
    expect(send).toHaveBeenCalledTimes(1);
    const lines = logged.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown]"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown\] put seq=\d+ key=daily\/7203\.json startMs=\d+ endMs=\d+ durMs=\d+ bytes=2 sha8=[0-9a-f]{8} cond=IfMatch inflight=\d+ status=500 name=InternalError code=SlowDown cause=none abort=0 abortReason=none attempts=none requestId=req-abc httpStatusCode=500 amzRequestId=req-header body=/);
    const loggedBody = lines[0]!.slice(lines[0]!.indexOf(" body=") + " body=".length);
    expect(Array.from(loggedBody)).toHaveLength(200);
    expect(loggedBody.startsWith("<Error><Code>SlowDown</Code>")).toBe(true);
    expect(lines[0]).not.toMatch(/[\r\n]/);
    expect(lines[0]).not.toContain("observed");
    for (const secret of ["https://", "abcdef", "Bearer", "test-secret", "test-access", "application/xml"]) {
      expect(lines[0]).not.toContain(secret);
    }
  });

  it("redacts signed URL, auth header, and access keys in the message head", async () => {
    const sdk = Object.assign(new Error(
      `see secret=private-value https://acct.r2.cloudflarestorage.com/b/k?X-Amz-Signature=deadbeef Authorization: Bearer test-secret id=test-access AKIAIOSFODNN7EXAMPLE\nnext`,
    ), { name: "TimeoutError" });
    vi.spyOn(S3Client.prototype, "send").mockRejectedValueOnce(sdk);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(r2Put("daily/7203.json", "{}", null)).rejects.toBeInstanceOf(R2PutUnknownError);
    const line = logged.mock.calls.map((call) => String(call[0])).find((item) => item.startsWith("[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown]"));
    expect(line).toMatch(/^\[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown\] put seq=\d+ key=daily\/7203\.json startMs=\d+ endMs=\d+ durMs=\d+ bytes=2 sha8=[0-9a-f]{8} cond=IfNoneMatch inflight=\d+ status=none name=TimeoutError code=none cause=none abort=0 abortReason=none attempts=none body=see secret=<redacted> <url> <redacted> <redacted> id=<redacted> <redacted> next$/);
    expect(line).not.toContain("private-value");
  });

  it("uses the XML Code when the exception has no string code", async () => {
    const sdk = Object.assign(new Error("ignored"), {
      name: "UnknownError",
      Code: "InternalError",
      $response: { body: "", headers: { "X-Amz-Request-Id": "xml-req" } },
    });
    vi.spyOn(S3Client.prototype, "send").mockRejectedValueOnce(sdk);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(r2Put("intra/7203.json", "{}", null)).rejects.toBeInstanceOf(R2PutUnknownError);
    const line = logged.mock.calls.map((call) => String(call[0])).find((item) => item.startsWith("[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown]"));
    expect(line).toMatch(/^\[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown\] put seq=\d+ key=intra\/7203\.json startMs=\d+ endMs=\d+ durMs=\d+ bytes=2 sha8=[0-9a-f]{8} cond=IfNoneMatch inflight=\d+ status=none name=UnknownError code=InternalError cause=none abort=0 abortReason=none attempts=none requestId=xml-req amzRequestId=xml-req body=ignored$/);
  });

  it("a throwing response body falls through to a redacted message and still throws unknown", async () => {
    const sdk = Object.assign(new Error("https://secret.example/x?k=LEAK"), {
      name: "InternalError",
      code: "ECONNRESET",
      $metadata: { httpStatusCode: 500, requestId: "req-keep" },
    });
    Object.defineProperty(sdk, "$response", { get() { throw new Error("body boom"); } });
    vi.spyOn(S3Client.prototype, "send").mockRejectedValueOnce(sdk);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = await r2Put("daily/7203.json", "{}", null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(R2PutUnknownError);
    expect((error as Error).cause).toBe(sdk);
    const line = logged.mock.calls.map((call) => String(call[0])).find((item) => item.startsWith("[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown]"));
    expect(line).toMatch(/^\[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown\] put seq=\d+ key=daily\/7203\.json startMs=\d+ endMs=\d+ durMs=\d+ bytes=2 sha8=[0-9a-f]{8} cond=IfNoneMatch inflight=\d+ status=500 name=InternalError code=ECONNRESET cause=none abort=0 abortReason=none attempts=none requestId=req-keep httpStatusCode=500 body=<url>$/);
    expect(line).not.toContain("LEAK");
  });

  it("marks the body unreadable when every source throws, without changing the PUT error", async () => {
    const sdk = Object.assign(new Error("placeholder"), { name: "TimeoutError", $metadata: { httpStatusCode: 500 } });
    Object.defineProperty(sdk, "$response", { get() { throw new Error("body boom"); } });
    Object.defineProperty(sdk, "body", { get() { throw new Error("raw boom"); } });
    Object.defineProperty(sdk, "message", { get() { throw new Error("message boom"); } });
    vi.spyOn(S3Client.prototype, "send").mockRejectedValueOnce(sdk);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(r2Put("daily/7203.json", "{}", null)).rejects.toBeInstanceOf(R2PutUnknownError);
    const line = logged.mock.calls.map((call) => String(call[0])).find((item) => item.startsWith("[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown]"));
    expect(line).toMatch(/^\[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown\] put seq=\d+ key=daily\/7203\.json startMs=\d+ endMs=\d+ durMs=\d+ bytes=2 sha8=[0-9a-f]{8} cond=IfNoneMatch inflight=\d+ status=500 name=TimeoutError code=none cause=none abort=0 abortReason=none attempts=none requestId=<unreadable> httpStatusCode=500 body=<unreadable>$/);
  });

  it("logs an explicit rejection without turning it into unknown", async () => {
    const sdk = svcError("PreconditionFailed", 412);
    vi.spyOn(S3Client.prototype, "send").mockRejectedValueOnce(sdk);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = await r2Put("daily/7203.json", "{}", null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(R2PutRejectedError);
    expect(error).not.toBeInstanceOf(R2PutUnknownError);
    const line = logged.mock.calls.map((call) => String(call[0])).find((item) => item.startsWith("[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown]"));
    expect(line).toMatch(/^\[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown\] put seq=\d+ key=daily\/7203\.json startMs=\d+ endMs=\d+ durMs=\d+ bytes=2 sha8=[0-9a-f]{8} cond=IfNoneMatch inflight=\d+ status=412 name=PreconditionFailed code=none cause=none abort=0 abortReason=none attempts=none httpStatusCode=412 body=PreconditionFailed$/);
  });

  it("logs a resolved response that misses the success schema", async () => {
    vi.spyOn(S3Client.prototype, "send").mockImplementationOnce(async () => ({
      ETag: "",
      $metadata: { httpStatusCode: 200, requestId: "req-bad" },
    }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(r2Put("daily/7203.json", "{}", null)).rejects.toBeInstanceOf(R2PutUnknownError);
    const line = logged.mock.calls.map((call) => String(call[0])).find((item) => item.startsWith("[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown]"));
    expect(line).toMatch(/^\[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown\] put seq=\d+ key=daily\/7203\.json startMs=\d+ endMs=\d+ durMs=\d+ bytes=2 sha8=[0-9a-f]{8} cond=IfNoneMatch inflight=\d+ status=200 name=none code=none cause=none abort=0 abortReason=none attempts=none requestId=req-bad httpStatusCode=200 body=<absent>$/);
  });

  it("a failing incident log does not change the thrown PUT error", async () => {
    vi.spyOn(S3Client.prototype, "send").mockRejectedValueOnce(svcError("TimeoutError"));
    vi.spyOn(console, "error").mockImplementation(() => { throw new Error("log failed"); });
    await expect(r2Put("daily/7203.json", "{}", null)).rejects.toBeInstanceOf(R2PutUnknownError);
  });

  it("logs one measurement line for a successful PUT and none for pre-send rejection or GET faults", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const incident = () => logged.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown]"));
    send.mockImplementationOnce(async () => okPut());
    await r2Put("daily/7203.json", "{}", null);
    expect(incident()).toHaveLength(1);
    expect(incident()[0]).toMatch(/ put seq=\d+ key=daily\/7203\.json .* cond=IfNoneMatch inflight=\d+ status=200 name=none code=none cause=none abort=0 abortReason=none attempts=none httpStatusCode=200 body=none$/);
    expect(incident()[0]).not.toContain("put-etag");
    await expect(r2Put("daily/7203.json", "{}", " ")).rejects.toThrow("observed ETag");
    send.mockRejectedValueOnce(svcError("Forbidden", 403));
    await expect(r2GetVersion("daily/7203.json")).rejects.toThrow();
    expect(incident()).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
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
  function fakeAttemptTimeouts() {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("attempt expired", "TimeoutError")), ms);
      return controller.signal;
    });
  }
  // 固定SDKがheader待機中のsignal中断で返す型/cause。同じsignalへ束縛して制御する。
  const pendingHeader = (_command: unknown, options?: unknown) => new Promise<never>((_resolve, reject) => {
    const signal = (options as { abortSignal: AbortSignal }).abortSignal;
    signal.addEventListener("abort", () => reject(Object.assign(new Error("Request aborted"),
      { name: "AbortError", cause: signal.reason })), { once: true });
  });

  it("own 60s header timeout retries a GET within the live caller budget", async () => {
    fakeAttemptTimeouts();
    const caller = new AbortController(), beforeAttempt = vi.fn();
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementationOnce(pendingHeader)
      .mockImplementationOnce(async () => ({ ...okGet(), Body: Readable.from([Buffer.from("original bytes")]) }));
    const result = expect(r2GetVersion("daily/3931.json", { abortSignal: caller.signal, beforeAttempt }))
      .resolves.toEqual({ body: "original bytes", etag: '"native-etag"' });
    await vi.advanceTimersByTimeAsync(61_000); await result;
    expect(send).toHaveBeenCalledTimes(2); expect(beforeAttempt).toHaveBeenCalledTimes(2);
    expect(caller.signal.aborted).toBe(false);
    expect(send.mock.calls.every(([command]) => command instanceof GetObjectCommand)).toBe(true);
  });

  it("persistent own header timeouts remain a fault after at most three GETs", async () => {
    fakeAttemptTimeouts();
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(pendingHeader);
    const result = expect(r2GetVersion("daily/3931.json")).rejects.toMatchObject({ name: "AbortError" });
    await vi.runAllTimersAsync(); await result;
    expect(send).toHaveBeenCalledTimes(3);
  });

  it.each(["singleAttempt", "observer"])("own header timeout keeps %s read single", async mode => {
    fakeAttemptTimeouts();
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(pendingHeader), onRead = vi.fn();
    const options = mode === "singleAttempt" ? { singleAttempt: true } : { maxBytes: 100, onRead };
    const result = expect(r2GetVersion("daily/3931.json", options)).rejects.toMatchObject({ name: "AbortError" });
    await vi.runAllTimersAsync(); await result;
    expect(send).toHaveBeenCalledOnce(); expect(onRead).not.toHaveBeenCalled();
  });

  it("caller abort never becomes an own timeout retry", async () => {
    fakeAttemptTimeouts();
    const caller = new AbortController(), send = vi.spyOn(S3Client.prototype, "send").mockImplementation(pendingHeader);
    const result = expect(r2GetVersion("daily/3931.json", { abortSignal: caller.signal })).rejects.toMatchObject({ name: "AbortError" });
    setTimeout(() => caller.abort(new Error("caller deadline")), 30_000);
    await vi.runAllTimersAsync(); await result;
    expect(send).toHaveBeenCalledOnce();
  });

  it("caller expiry during backoff stops before the next GET", async () => {
    fakeAttemptTimeouts();
    const caller = new AbortController(), beforeAttempt = vi.fn();
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(pendingHeader);
    const result = expect(r2GetVersion("daily/3931.json", { abortSignal: caller.signal, beforeAttempt }))
      .rejects.toThrow("caller deadline");
    setTimeout(() => caller.abort(new Error("caller deadline")), 60_500);
    await vi.runAllTimersAsync(); await result;
    expect(send).toHaveBeenCalledOnce(); expect(beforeAttempt).toHaveBeenCalledOnce();
  });

  it("clears the previous own timeout before a next-attempt guard rejects", async () => {
    fakeAttemptTimeouts();
    let previousAbort: unknown;
    const beforeAttempt = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw previousAbort; });
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation((command, options) => pendingHeader(command, options)
      .catch(error => { previousAbort = error; throw error; }));
    const result = expect(r2GetVersion("daily/3931.json", { beforeAttempt })).rejects.toMatchObject({ name: "AbortError" });
    await vi.runAllTimersAsync(); await result;
    expect(send).toHaveBeenCalledOnce(); expect(beforeAttempt).toHaveBeenCalledTimes(2);
  });

  it("unattributed AbortError and timeout body failure are never retried", async () => {
    const error = Object.assign(new Error("Request aborted"), { name: "AbortError" });
    const send = vi.spyOn(S3Client.prototype, "send").mockRejectedValueOnce(error);
    await expect(r2GetVersion("daily/3931.json")).rejects.toBe(error); expect(send).toHaveBeenCalledOnce();
    send.mockReset().mockImplementationOnce(async () => ({ ...okGet(), Body: { transformToByteArray: async () => { throw error; } } }));
    await expect(r2GetVersion("daily/3931.json")).rejects.toBe(error); expect(send).toHaveBeenCalledOnce();
    fakeAttemptTimeouts();
    send.mockReset().mockImplementation((_command, options) => new Promise((_resolve, reject) => {
      const signal = (options as { abortSignal: AbortSignal }).abortSignal;
      signal.addEventListener("abort", () => reject(error), { once: true });
    }));
    const unbound = expect(r2GetVersion("daily/3931.json")).rejects.toBe(error);
    await vi.runAllTimersAsync(); await unbound;
    expect(send).toHaveBeenCalledOnce(); // own期限が発火してもcauseが一致しないAbortErrorは除外。
  });

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
  it.each(["ENOTFOUND", "EAI_AGAIN"])("native %s retries only GET; explicit singleAttempt and PUT remain single", async code => {
    vi.useFakeTimers();
    const fault = Object.assign(new Error("EXPLICIT_DNS_FAILURE"), { code, syscall: "getaddrinfo" });
    const send = vi.spyOn(S3Client.prototype, "send").mockRejectedValueOnce(fault).mockImplementationOnce(async () => okGet());
    const result = expect(r2GetVersion("local-jobs/biztag/latest.json")).resolves.toEqual({ body: "original bytes", etag: '"native-etag"' });
    await vi.runAllTimersAsync(); await result;
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([command]) => command instanceof GetObjectCommand)).toBe(true);
    send.mockReset().mockRejectedValue(fault);
    await expect(r2GetVersion("local-jobs/biztag/latest.json", { singleAttempt: true })).rejects.toThrow("EXPLICIT_DNS_FAILURE");
    expect(send).toHaveBeenCalledOnce();
    send.mockClear();
    await expect(r2Put("local-jobs/biztag/latest.json", "{}", '"observed"')).rejects.toBeInstanceOf(R2PutUnknownError);
    expect(send).toHaveBeenCalledOnce();
  });
  it("persistent DNS is at most3 GETs; unknown shape or contradictory HTTP never retries", async () => {
    vi.useFakeTimers();
    const fault = Object.assign(new Error("EXPLICIT_DNS_FAILURE"), { code: "ENOTFOUND", syscall: "getaddrinfo" });
    const send = vi.spyOn(S3Client.prototype, "send").mockRejectedValue(fault);
    const rejected = expect(r2GetVersion("local-jobs/biztag/latest.json")).rejects.toThrow("EXPLICIT_DNS_FAILURE");
    await vi.runAllTimersAsync(); await rejected;
    expect(send).toHaveBeenCalledTimes(3);
    for (const invalid of [new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND", syscall: "getaddrinfo" },
      Object.assign(new Error("DNS"), { code: "ENOTFOUND", syscall: "connect" }),
      Object.assign(new Error("DNS"), { code: "ENOTFOUND", syscall: "getaddrinfo", $metadata: { httpStatusCode: 403 } })]) {
      send.mockReset().mockRejectedValue(invalid);
      await expect(r2GetVersion("local-jobs/biztag/latest.json")).rejects.toBe(invalid);
      expect(send).toHaveBeenCalledOnce();
    }
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
  it("publisherのhard signalと送信直前guardをSDKへ伝え、期限済みなら送信0", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async () => okPut());
    const abort = new AbortController(), beforeAttempt = vi.fn();
    await r2PutBytes("protocol.json", new Uint8Array([123, 125]), null, "raw-bucket", "application/json", undefined,
      { abortSignal: abort.signal, beforeAttempt });
    expect(beforeAttempt).toHaveBeenCalledTimes(1);
    const signal = (send.mock.calls[0][1] as { abortSignal: AbortSignal }).abortSignal;
    abort.abort(); expect(signal.aborted).toBe(true);
    await expect(r2PutBytes("protocol.json", new Uint8Array([123, 125]), null, "raw-bucket", "application/json", undefined,
      { abortSignal: abort.signal })).rejects.toThrow();
    await expect(r2PutBytes("protocol.json", new Uint8Array([123, 125]), null, "raw-bucket", "application/json", undefined,
      { beforeAttempt: () => { throw new Error("hard expired"); } })).rejects.toThrow("hard expired");
    expect(send).toHaveBeenCalledTimes(1);
  });
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

const ABORT_LOG = "[INC-20261025-kabulab_tool_cloudflare-vwap-abort]";
const abortLogLines = (logged: { mock: { calls: unknown[][] } }) =>
  logged.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith(ABORT_LOG));

describe("R2 abort signal diagnostic", () => {
  const timeoutReason = (message = "The operation was aborted due to timeout") =>
    new DOMException(message, "TimeoutError");

  it("logs a 60s header abort, keeps the 60s timer, and rethrows the same error once", async () => {
    const timeout = new AbortController();
    const budget = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      expect(ms).toBe(60_000);
      return timeout.signal;
    });
    const reason = timeoutReason("https://acct.r2.cloudflarestorage.com/x?X-Amz-Signature=deadbeef Authorization: Bearer test-secret");
    let thrown!: Error;
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (_command, options) => {
      const signal = (options as { abortSignal: AbortSignal }).abortSignal;
      const until = Date.now() + 25;
      while (Date.now() < until) { /* 要求開始からの経過を実測する */ }
      timeout.abort(reason);
      expect(signal.aborted).toBe(true);
      expect(budget.signal.aborted).toBe(false);
      thrown = Object.assign(new Error("Request aborted https://secret.example/leak?X-Amz-Signature=deadbeef"), {
        name: "AbortError",
        cause: signal.reason,
      });
      throw thrown;
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const started = Date.now();
    const caught = await r2GetVersion("daily/3931.json", { abortSignal: budget.signal, singleAttempt: true }).catch((error: unknown) => error);
    expect(caught).toBe(thrown);
    expect(caught).not.toBeInstanceOf(R2PutUnknownError);
    expect(send).toHaveBeenCalledTimes(1);
    const lines = abortLogLines(logged);
    expect(lines).toHaveLength(1);
    const elapsed = Number(lines[0].match(/elapsedMs=(\d+)/)?.[1]);
    expect(Number.isSafeInteger(elapsed)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThanOrEqual(Date.now() - started);
    expect(lines[0]).toBe(`${ABORT_LOG} signal=要求ごと60秒 phase=ヘッダ受信前 reason=TimeoutError cause=TimeoutError elapsedMs=${elapsed} key=daily/3931.json`);
    expect(lines[0]).not.toMatch(/[\r\n]/);
    for (const secret of ["https://", "deadbeef", "Bearer", "test-secret", "secret.example", "test-access", "test-account", "cloudflarestorage"]) {
      expect(lines[0]).not.toContain(secret);
    }
    expect(logged.mock.calls.map((call) => String(call[0])).some((line) => line.startsWith("[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown]"))).toBe(false);
  });

  it("logs every own 60s header abort and still retries that GET up to three times", async () => {
    vi.useFakeTimers();
    const budget = new AbortController();
    const controllers: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      expect(ms).toBe(60_000);
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    });
    const thrown: Error[] = [];
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (_command, options) => {
      const signal = (options as { abortSignal: AbortSignal }).abortSignal;
      controllers.at(-1)!.abort(timeoutReason());
      const error = Object.assign(new Error("Request aborted"), { name: "AbortError", cause: signal.reason });
      thrown.push(error);
      throw error;
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = r2GetVersion("daily/3931.json", { abortSignal: budget.signal }).then(() => {
      throw new Error("own header timeout should stay a fault");
    }, (error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await pending).toBe(thrown[2]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(budget.signal.aborted).toBe(false);
    const lines = abortLogLines(logged);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toMatch(/ signal=要求ごと60秒 phase=ヘッダ受信前 reason=TimeoutError cause=TimeoutError elapsedMs=\d+ key=daily\/3931\.json$/);
    }
  });

  it("attributes a header abort to the budget signal when the 60s timer is still running", async () => {
    const budget = new AbortController();
    const reason = timeoutReason();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let thrown!: Error;
    vi.spyOn(S3Client.prototype, "send").mockImplementation(async (_command, options) => {
      const signal = (options as { abortSignal: AbortSignal }).abortSignal;
      budget.abort(reason);
      expect(signal.aborted).toBe(true);
      thrown = Object.assign(new Error("Request aborted"), { name: "AbortError", cause: signal.reason });
      throw thrown;
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const caught = await r2GetVersion("daily/3931.json", { abortSignal: budget.signal }).catch((error: unknown) => error);
    expect(caught).toBe(thrown);
    expect(timeout.mock.calls).toEqual([[60_000]]);
    expect((timeout.mock.results[0].value as AbortSignal).aborted).toBe(false);
    const line = abortLogLines(logged)[0];
    expect(line).toMatch(new RegExp(`^${ABORT_LOG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} signal=予算 phase=ヘッダ受信前 reason=TimeoutError cause=TimeoutError elapsedMs=\\d+ key=daily/3931\\.json$`));
  });

  it("says the signal is unknown when both are aborted or neither is", async () => {
    const timeout = new AbortController();
    const budget = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => timeout.signal);
    let thrown!: Error;
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (_command, options) => {
      const signal = (options as { abortSignal: AbortSignal }).abortSignal;
      timeout.abort(timeoutReason());
      budget.abort(timeoutReason());
      thrown = Object.assign(new Error("Request aborted"), { name: "AbortError", cause: signal.reason });
      throw thrown;
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await r2GetVersion("daily/3931.json", { abortSignal: budget.signal }).catch((error: unknown) => error)).toBe(thrown);
    expect(abortLogLines(logged)[0]).toMatch(/ signal=不明 phase=ヘッダ受信前 reason=TimeoutError cause=TimeoutError elapsedMs=\d+ /);
    expect(send).toHaveBeenCalledTimes(1);

    logged.mockClear();
    send.mockReset();
    const cause = Object.assign(new Error("https://secret.example/leak"), { name: "TimeoutError" });
    const plain = Object.assign(new Error("Request aborted"), { name: "AbortError", cause });
    send.mockRejectedValueOnce(plain);
    vi.spyOn(AbortSignal, "timeout").mockRestore();
    const realTimeout = vi.spyOn(AbortSignal, "timeout");
    expect(await r2GetVersion("daily/3931.json").catch((error: unknown) => error)).toBe(plain);
    expect(realTimeout).toHaveBeenCalledWith(60_000);
    expect((realTimeout.mock.results[0].value as AbortSignal).aborted).toBe(false);
    const line = abortLogLines(logged)[0];
    expect(line).toMatch(/ signal=不明 phase=ヘッダ受信前 reason=none cause=TimeoutError elapsedMs=\d+ key=daily\/3931\.json$/);
    expect(line).not.toContain("secret.example");
  });

  it("logs a body-read abort and still rejects with the signal reason plus the received prefix", async () => {
    const budget = new AbortController();
    const reason = timeoutReason();
    const prefix = Buffer.from("ab");
    const stream = new Readable({ read() {} });
    stream.push(prefix);
    const onRead = vi.fn();
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementationOnce(async () => ({ ...okGet(), ContentLength: 4, Body: stream }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = r2GetVersion("daily/3931.json", { singleAttempt: true, maxBytes: 4, abortSignal: budget.signal, onRead });
    const rejected = expect(pending).rejects.toBe(reason);
    await new Promise<void>((resolve) => setImmediate(resolve));
    budget.abort(reason);
    await rejected;
    expect(stream.destroyed).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onRead).toHaveBeenCalledExactlyOnceWith({ status: 200, etag: '"native-etag"', contentLength: 4, body: prefix, receivedBytes: 2, complete: false });
    expect(abortLogLines(logged)[0]).toMatch(/ signal=予算 phase=本文読み取り中 reason=TimeoutError cause=none elapsedMs=\d+ key=daily\/3931\.json$/);
  });

  it("attributes a body-read abort to the 60s signal when no budget signal is aborted", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      expect(ms).toBe(60_000);
      return timeout.signal;
    });
    const reason = timeoutReason();
    const stream = new Readable({ read() {} });
    stream.push(Buffer.from("ab"));
    vi.spyOn(S3Client.prototype, "send").mockImplementationOnce(async () => ({ ...okGet(), ContentLength: 4, Body: stream }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = r2GetVersion("daily/3931.json", { singleAttempt: true, maxBytes: 4 });
    const rejected = expect(pending).rejects.toBe(reason);
    await new Promise<void>((resolve) => setImmediate(resolve));
    timeout.abort(reason);
    await rejected;
    expect(abortLogLines(logged)[0]).toMatch(/ signal=要求ごと60秒 phase=本文読み取り中 reason=TimeoutError cause=none elapsedMs=\d+ /);
  });

  it("does not log aborts for success, missing objects, short bodies, or retried 5xx", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const send = vi.spyOn(S3Client.prototype, "send");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    send.mockImplementationOnce(async () => okGet());
    await r2GetVersion("daily/3931.json");
    send.mockRejectedValueOnce(svcError("NoSuchKey", 404));
    await expect(r2GetVersion("daily/3931.json")).resolves.toBeNull();
    send.mockImplementationOnce(async () => ({ ...okGet(), ContentLength: 4, Body: Readable.from([Buffer.from("ab")]) }));
    await expect(r2GetVersion("daily/3931.json", { singleAttempt: true, maxBytes: 4 })).rejects.toThrow("ContentLength");
    const fault = svcError("InternalError", 500);
    send.mockRejectedValue(fault);
    const rejected = expect(r2GetVersion("daily/3931.json")).rejects.toBe(fault);
    await vi.runAllTimersAsync();
    await rejected;
    expect(send).toHaveBeenCalledTimes(6);
    expect(timeout.mock.calls).toEqual([[60_000], [60_000], [60_000], [60_000], [60_000], [60_000]]);
    expect(abortLogLines(logged)).toEqual([]);
  });

  it("does not log a budget abort that happens before the request starts", async () => {
    const budget = new AbortController();
    const send = vi.spyOn(S3Client.prototype, "send");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const beforeAttempt = () => { budget.abort(new Error("absolute deadline")); };
    await expect(r2GetVersion("daily/3931.json", { abortSignal: budget.signal, beforeAttempt, singleAttempt: true })).rejects.toThrow("absolute deadline");
    expect(send).not.toHaveBeenCalled();
    expect(abortLogLines(logged)).toEqual([]);
  });

  it("logs a PUT abort without replacing the unknown error or the existing incident line", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      expect(ms).toBe(60_000);
      return timeout.signal;
    });
    const reason = timeoutReason();
    let sdk!: Error;
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (_command, options) => {
      const signal = (options as { abortSignal: AbortSignal }).abortSignal;
      timeout.abort(reason);
      sdk = Object.assign(new Error("Request aborted"), { name: "AbortError", cause: signal.reason });
      throw sdk;
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const caught = await r2Put("daily/3931.json", "{}", null).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(R2PutUnknownError);
    expect((caught as Error).cause).toBe(sdk);
    expect(send).toHaveBeenCalledTimes(1);
    const lines = logged.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.startsWith("[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown]"))).toHaveLength(1);
    expect(lines.find((line) => line.startsWith("[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown]"))).toMatch(/ put seq=\d+ key=daily\/3931\.json .* status=none name=AbortError code=none cause=TimeoutError abort=1 abortReason=TimeoutError attempts=none body=Request aborted$/);
    expect(abortLogLines(logged)[0]).toMatch(new RegExp(`^${ABORT_LOG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} signal=要求ごと60秒 phase=ヘッダ受信前 reason=TimeoutError cause=TimeoutError elapsedMs=\\d+ key=daily/3931\\.json$`));
  });

  it("a failing abort log still throws the original GET error and the wrapped PUT error", async () => {
    vi.useFakeTimers();
    const reason = timeoutReason();
    const controllers: AbortController[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    });
    let last!: Error;
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (_command, options) => {
      const signal = (options as { abortSignal: AbortSignal }).abortSignal;
      controllers.at(-1)!.abort(reason);
      last = Object.assign(new Error("Request aborted"), { name: "AbortError", cause: signal.reason });
      throw last;
    });
    vi.spyOn(console, "error").mockImplementation(() => { throw new Error("log failed"); });
    const pending = r2GetVersion("daily/3931.json").then(() => {
      throw new Error("own header timeout should stay a fault");
    }, (error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await pending).toBe(last);
    expect(send).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
    const putTimeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(putTimeout.signal);
    const putSdk = Object.assign(new Error("Request aborted"), { name: "AbortError", cause: reason });
    send.mockReset().mockImplementation(async () => {
      putTimeout.abort(reason);
      throw putSdk;
    });
    const caught = await r2Put("daily/7203.json", "{}", null).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(R2PutUnknownError);
    expect((caught as Error).cause).toBe(putSdk);
  });
});

const INCIDENT = "[INC-20261013-kabulab_tool_cloudflare-vwap-r2-put-unknown]";
const incidentLines = (logged: { mock: { calls: unknown[][] } }) =>
  logged.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith(INCIDENT));

describe("R2 PUT measurement", () => {
  const sha8 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8);

  it("logs one success line, a 500 confirm and neighbors, and a run summary without secrets", async () => {
    beginR2PutDiagRun();
    const prevSha = process.env.GITHUB_SHA;
    const prevRun = process.env.GITHUB_RUN_ID;
    process.env.GITHUB_SHA = "0123456789abcdef0123456789abcdef01234567";
    process.env.GITHUB_RUN_ID = "987654321";
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const send = vi.spyOn(S3Client.prototype, "send");
    try {
      send.mockImplementation(async () => okPut());
      for (const code of ["1001", "1002", "1003", "1004", "1005"]) await r2Put(`daily/${code}.json`, "{}", null);
      const secretEtag = "super-secret-etag";
      const body = '{"code":"7203"}';
      const bodyBytes = new TextEncoder().encode(body).byteLength;
      const sdk = Object.assign(new Error("ignored"), {
        name: "InternalError",
        code: "SlowDown",
        cause: Object.assign(new Error("https://acct.r2.cloudflarestorage.com/leak?X-Amz-Signature=deadbeef"), { name: "NetworkError" }),
        $metadata: { httpStatusCode: 500, requestId: "req-abc", extendedRequestId: "ext-1", cfId: "meta-cf", attempts: 1 },
        $response: {
          headers: { authorization: "Bearer test-secret", "cf-ray": "ray-123", "x-amz-request-id": "req-header", "cf-id": "hdr-cf", "content-type": "application/xml" },
          body: new TextEncoder().encode("see https://acct.r2.cloudflarestorage.com/b?X-Amz-Signature=deadbeef Authorization: Bearer test-secret"),
        },
      });
      send.mockRejectedValueOnce(sdk);
      const error = await r2Put("daily/7203.json", body, `"${secretEtag}"`).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(R2PutUnknownError);
      const bytes = Buffer.from(body);
      send.mockImplementationOnce(async () => ({
        ETag: '"native-observed"', ContentLength: bytes.length, ContentType: "application/json",
        LastModified: new Date("2026-10-13T00:00:00.000Z"), Body: Readable.from([bytes]), $metadata: { httpStatusCode: 200 },
      }));
      const proof = await confirmUnknownPricePut(error, "daily/7203.json", body, undefined, () => {});
      expect(proof).toMatchObject({ putAcknowledgement: "unknown", state: "exact-post-observed", etag: '"native-observed"', bodyBytes: bytes.length, complete: true });
      for (const code of ["2001", "2002", "2003", "2004", "2005"]) await r2Put(`daily/${code}.json`, "{}", null);
      noteR2PutFatal("ingest-daily.ts:putBarrier", new Error("R2 PUT 結果不明 cause=InternalError/500 https://acct.r2.cloudflarestorage.com/secret"));
      logR2PutRunSummary(true);
      const lines = incidentLines(logged);
      const puts = lines.filter((line) => line.includes(" put "));
      const confirms = lines.filter((line) => line.includes(" confirm "));
      const neighbors = lines.filter((line) => line.includes(" neighbors "));
      const summaries = lines.filter((line) => line.includes(" summary "));
      expect(puts).toHaveLength(11);
      expect(confirms).toHaveLength(1);
      expect(neighbors).toHaveLength(1);
      expect(summaries).toHaveLength(1);
      expect(puts[0]).toMatch(new RegExp(`^${INCIDENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} put seq=1 key=daily/1001\\.json startMs=\\d+ endMs=\\d+ durMs=\\d+ bytes=2 sha8=${sha8("{}")} cond=IfNoneMatch inflight=1 status=200 name=none code=none cause=none abort=0 abortReason=none attempts=none httpStatusCode=200 body=none$`));
      const unknown = puts[5]!;
      expect(unknown).toMatch(new RegExp(`key=daily/7203\\.json startMs=\\d+ endMs=\\d+ durMs=\\d+ bytes=${bodyBytes} sha8=${sha8(body)} cond=IfMatch inflight=1 status=500 name=InternalError code=SlowDown cause=NetworkError abort=0 abortReason=none attempts=1 requestId=req-abc extendedRequestId=ext-1 cfId=meta-cf httpStatusCode=500 cfRay=ray-123 amzRequestId=req-header body=`));
      expect(confirms[0]).toContain('confirm seq=6 key=daily/7203.json present=1 etag="native-observed"');
      expect(confirms[0]).toContain(`bytes=${bytes.length}`);
      expect(confirms[0]).toContain("lastModified=2026-10-13T00:00:00.000Z");
      expect(confirms[0]).toContain(`shaMatch=1 sentSha8=${sha8(body)} gotSha8=${sha8(body)}`);
      const brief = (line: string) => {
        const key = line.match(/key=(\S+)/)?.[1];
        const status = line.match(/ status=(\S+)/)?.[1];
        const dur = line.match(/durMs=(\d+)/)?.[1];
        return `${key}:${status}:${dur}`;
      };
      expect(neighbors[0]).toBe(`${INCIDENT} neighbors seq=6 key=daily/7203.json before=${puts.slice(0, 5).map(brief).join(";")} after=${puts.slice(6).map(brief).join(";")}`);
      const durs = puts.map((line) => Number(line.match(/durMs=(\d+)/)?.[1])).sort((a, b) => a - b);
      const pct = (p: number) => durs[Math.min(durs.length, Math.max(1, Math.ceil((p / 100) * durs.length))) - 1];
      const minutes = new Map<string, number>();
      for (const line of puts) {
        const ms = Number(line.match(/startMs=(\d+)/)?.[1]);
        const stamp = new Date(ms);
        const pad = (n: number) => String(n).padStart(2, "0");
        const minute = `${stamp.getUTCFullYear()}-${pad(stamp.getUTCMonth() + 1)}-${pad(stamp.getUTCDate())}T${pad(stamp.getUTCHours())}:${pad(stamp.getUTCMinutes())}Z`;
        minutes.set(minute, (minutes.get(minute) ?? 0) + 1);
      }
      const perMinute = [...minutes.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([key, count]) => `${key}=${count}`).join(",");
      const summary = summaries[0]!;
      expect(summary).toContain(" total=11 ");
      expect(summary).toContain(" ok=10 ");
      expect(summary).toContain(" unknown=1 ");
      expect(summary).toContain(" fail=0 ");
      expect(summary).toContain(` p50=${pct(50)} `);
      expect(summary).toContain(` p95=${pct(95)} `);
      expect(summary).toContain(` max=${durs[durs.length - 1]} `);
      expect(summary).toContain(` perMinute=${perMinute} `);
      expect(summary).toContain(" fatal=1 ");
      expect(summary).toContain(" site=ingest-daily.ts:putBarrier ");
      expect(summary).toContain(" sha=0123456789abcdef0123456789abcdef01234567 ");
      expect(summary).toContain(" runId=987654321");
      expect(send).toHaveBeenCalledTimes(12);
      for (const line of lines) {
        expect(line.startsWith(INCIDENT)).toBe(true);
        expect(line).not.toMatch(/[\r\n]/);
        for (const secret of [secretEtag, "https://", "deadbeef", "Bearer", "test-secret", "test-access", "test-bucket", "test-account", "cloudflarestorage", "hdr-cf", "application/xml", "Authorization"]) {
          expect(line).not.toContain(secret);
        }
        const start = Number(line.match(/startMs=(\d+)/)?.[1]);
        const end = Number(line.match(/endMs=(\d+)/)?.[1]);
        if (line.includes(" put ")) expect(end).toBeGreaterThanOrEqual(start);
      }
    } finally {
      if (prevSha === undefined) delete process.env.GITHUB_SHA;
      else process.env.GITHUB_SHA = prevSha;
      if (prevRun === undefined) delete process.env.GITHUB_RUN_ID;
      else process.env.GITHUB_RUN_ID = prevRun;
    }
  });

  it("logs a failed readback without replacing the original unknown error", async () => {
    beginR2PutDiagRun();
    const send = vi.spyOn(S3Client.prototype, "send");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    send.mockRejectedValueOnce(svcError("InternalError", 500));
    const error = await r2Put("daily/7203.json", '{"a":1}', null).catch((e: unknown) => e);
    send.mockRejectedValueOnce(svcError("TimeoutError", 500));
    await expect(confirmUnknownPricePut(error, "daily/7203.json", '{"a":1}', undefined, () => {})).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(2);
    const confirm = incidentLines(logged).find((line) => line.includes(" confirm "));
    expect(confirm).toMatch(/present=none etag=none bytes=none lastModified=none shaMatch=none read=error name=TimeoutError/);
    expect(confirm).not.toContain("https://");
    expect(confirm).not.toContain("test-secret");
  });
});
