import { afterEach, describe, expect, it } from "vitest";
import { sharedEnv } from "./env.js";

describe("sharedEnv.GITHUB_OUTPUT", () => {
  const PREV = process.env.GITHUB_OUTPUT;
  afterEach(() => {
    if (PREV === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = PREV;
  });

  it("設定時はそのまま返し、未設定・空は undefined", () => {
    process.env.GITHUB_OUTPUT = "/tmp/gh-output";
    expect(sharedEnv.GITHUB_OUTPUT()).toBe("/tmp/gh-output");
    delete process.env.GITHUB_OUTPUT;
    expect(sharedEnv.GITHUB_OUTPUT()).toBeUndefined();
    process.env.GITHUB_OUTPUT = "  ";
    expect(sharedEnv.GITHUB_OUTPUT()).toBeUndefined();
  });
});
