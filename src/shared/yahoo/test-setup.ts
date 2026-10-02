import { vi } from "vitest";

// HTTP wire/parse 回帰は間隔だけ省略。実開始・待機後STOPは専用testで検証する。
vi.mock("./request-spacing.js", () => ({
  fetchYahooWithSpacing: async (url: string, init: RequestInit, assertAllowed: () => void) => {
    assertAllowed();
    return fetch(url, init);
  },
}));
