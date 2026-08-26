import { describe, expect, it, vi } from "vitest";
import {
  isDailySyncIncomplete,
  isTransientDailySyncFailure,
  recoverTransientDailyFailures,
} from "./daily.js";

describe("isDailySyncIncomplete", () => {
  it("全対象成功かつマクロ成功だけを完全成功とする", () => {
    expect(
      isDailySyncIncomplete({
        totalStocks: 3_716,
        successStocks: 3_716,
        failedStocks: 0,
        marketContextOk: true,
      })
    ).toBe(false);
  });

  it("個別失敗・マクロ失敗・空母集団を監視上の失敗にする", () => {
    expect(
      isDailySyncIncomplete({
        totalStocks: 3_716,
        successStocks: 3_715,
        failedStocks: 1,
        marketContextOk: true,
      })
    ).toBe(true);
    expect(
      isDailySyncIncomplete({
        totalStocks: 3_716,
        successStocks: 3_716,
        failedStocks: 0,
        marketContextOk: false,
      })
    ).toBe(true);
    expect(
      isDailySyncIncomplete({
        totalStocks: 0,
        successStocks: 0,
        failedStocks: 0,
        marketContextOk: true,
      })
    ).toBe(true);
    expect(
      isDailySyncIncomplete({
        totalStocks: 3_716,
        successStocks: 3_715,
        failedStocks: 0,
        marketContextOk: true,
      })
    ).toBe(true);
  });
});

describe("isTransientDailySyncFailure", () => {
  it.each([
    ["Chart API HTTP エラー [3675]: 500 Internal Server Error", true],
    ["QuoteSummary API HTTP エラー [8383]: 502 Bad Gateway", true],
    ["QuoteSummary API HTTP エラー [7203]: 429 Too Many Requests", true],
    ["Yahoo crumb HTTP エラー: 429 Too Many Requests", true],
    ["D1 HTTP 500: internal error", true],
    [
      'D1 HTTP error: [{"code":7500,"message":"internal error; reference = abc"}]',
      true,
    ],
    ["fetch failed / 原因: read ECONNRESET", true],
    ["TypeError: terminated / 原因: other side closed", true],
    ["TypeError: UND_ERR_SOCKET", true],
    ["QuoteSummary API HTTP エラー [7203]: 404 Not Found", false],
    ["D1 HTTP 400: no such column: adj", false],
    ["D1 スキーマ不整合: migration適用状態を確認してください。", false],
  ])("%s -> %s", (message, expected) => {
    expect(isTransientDailySyncFailure(message)).toBe(expected);
  });
});

describe("recoverTransientDailyFailures", () => {
  it("429を有界なRetry-After後に1回再処理して回復する", async () => {
    vi.useFakeTimers();
    try {
      const retryAt = Date.now() + 60_000;
      const processed: string[] = [];
      const pending = recoverTransientDailyFailures(
        [
          {
            target: "2418",
            error:
              `Chart API HTTP エラー [2418]: 429 Too Many Requests; ` +
              `retry-at-ms=${retryAt}`,
          },
        ],
        async (target) => {
          processed.push(target);
        }
      );

      await vi.advanceTimersByTimeAsync(29_999);
      expect(processed).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(processed).toEqual(["2418"]);
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.attempted).toBe(1);
      expect(result.recovered).toBe(1);
      expect(result.failures).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("429が再処理後も続けば成功扱いせず最新失敗を残す", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const pending = recoverTransientDailyFailures(
        [
          {
            target: "2418",
            error: "Chart API HTTP エラー [2418]: 429 Too Many Requests",
          },
        ],
        async () => {
          attempts++;
          throw new Error(
            "Chart API HTTP エラー [2418]: 429 Too Many Requests; retry-at-ms=9999999999999"
          );
        }
      );
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(attempts).toBe(1);
      expect(result.attempted).toBe(1);
      expect(result.recovered).toBe(0);
      expect(result.failures).toEqual([
        {
          target: "2418",
          error:
            "Chart API HTTP エラー [2418]: 429 Too Many Requests; retry-at-ms=9999999999999",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("一過性失敗だけを1回再処理し、恒久エラーはそのまま残す", async () => {
    const processed: string[] = [];
    const result = await recoverTransientDailyFailures(
      [
        {
          target: "yahoo-500",
          error: "Chart API HTTP エラー [3675]: 500 Internal Server Error",
        },
        { target: "d1-500", error: "D1 HTTP 500: internal error" },
        {
          target: "schema",
          error: "D1 スキーマ不整合: migration適用状態を確認してください。",
        },
      ],
      async (target) => {
        processed.push(target);
      }
    );

    expect(new Set(processed)).toEqual(new Set(["yahoo-500", "d1-500"]));
    expect(result.attempted).toBe(2);
    expect(result.recovered).toBe(2);
    expect(result.skippedDueToLimit).toBe(0);
    expect(result.failures).toEqual([
      {
        target: "schema",
        error: "D1 スキーマ不整合: migration適用状態を確認してください。",
      },
    ]);
  });

  it("再処理も失敗した対象は最新原因で1件だけ残す", async () => {
    let attempts = 0;
    const result = await recoverTransientDailyFailures(
      [
        {
          target: "8383",
          error: "QuoteSummary API HTTP エラー [8383]: 502 Bad Gateway",
        },
      ],
      async () => {
        attempts++;
        throw new Error(
          "QuoteSummary API HTTP エラー [8383]: 500 Internal Server Error"
        );
      }
    );

    expect(attempts).toBe(1);
    expect(result.attempted).toBe(1);
    expect(result.recovered).toBe(0);
    expect(result.skippedDueToLimit).toBe(0);
    expect(result.failures).toEqual([
      {
        target: "8383",
        error: "QuoteSummary API HTTP エラー [8383]: 500 Internal Server Error",
      },
    ]);
  });

  it("回復処理を100件で止め、超過対象を未解決として残す", async () => {
    vi.useFakeTimers();
    try {
      const failures = Array.from({ length: 101 }, (_, index) => ({
        target: String(index),
        error: `Chart API HTTP エラー [${index}]: 500 Internal Server Error`,
      }));
      const processed: string[] = [];
      const pending = recoverTransientDailyFailures(failures, async (target) => {
        processed.push(target);
      });
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(processed).toHaveLength(100);
      expect(result.attempted).toBe(100);
      expect(result.recovered).toBe(100);
      expect(result.skippedDueToLimit).toBe(1);
      expect(result.failures).toEqual([failures[100]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
