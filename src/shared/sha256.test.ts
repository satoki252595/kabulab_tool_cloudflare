import { describe, expect, it } from "vitest";
import { sha256Hex, sha256HexBytes } from "./sha256.js";

describe("sha256", () => {
  it("sha256HexBytes は既知ベクタと一致する (空・abc)", async () => {
    expect(await sha256HexBytes(new Uint8Array([]))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(await sha256HexBytes(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("sha256Hex は bytes 版へ委譲し、既存の文字列結果を変えない", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    expect(await sha256Hex("")).toBe(await sha256HexBytes(new Uint8Array([])));
  });
});
