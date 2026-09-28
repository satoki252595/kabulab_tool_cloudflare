import { afterEach, expect, it, vi } from "vitest";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { r2GetVersion, r2Put } from "./r2.js";

vi.mock("../../../src/shared/env.js", () => ({
  sharedEnv: {
    LOCAL_OUT: () => undefined,
    R2_BUCKET: () => "test-bucket",
    R2_ACCOUNT_ID: () => "test-account",
    R2_ACCESS_KEY_ID: () => "test-access",
    R2_SECRET_ACCESS_KEY: () => "test-secret",
  },
}));
afterEach(() => vi.restoreAllMocks());

it("conditional repair preserves the native ETag and propagates a stale precondition failure", async () => {
  const send = vi.spyOn(S3Client.prototype, "send");
  send.mockImplementationOnce(async () => ({
    ETag: '"native-etag"',
    Body: { transformToString: async () => "original bytes" },
  }));
  const current = await r2GetVersion("daily/1909.json");
  expect(current).toEqual({ body: "original bytes", etag: '"native-etag"' });
  send.mockRejectedValueOnce(new Error("PreconditionFailed"));
  await expect(
    r2Put("daily/1909.json", "repaired bytes", current!.etag),
  ).rejects.toThrow("PreconditionFailed");
  const command = send.mock.calls[1][0] as PutObjectCommand;
  expect(command).toBeInstanceOf(PutObjectCommand);
  expect(command.input).toMatchObject({
    Bucket: "test-bucket",
    Key: "daily/1909.json",
    IfMatch: '"native-etag"',
  });
});
