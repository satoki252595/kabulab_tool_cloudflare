import { describe, expect, it, vi } from "vitest";
import {
  createDailyStockStartGate,
  isDailySyncIncomplete,
  isTransientDailySyncFailure,
  prioritizeDailyRecoveryFailures,
  recoverTransientDailyFailures,
} from "./daily.js";

describe("createDailyStockStartGate", () => {
  it("既存の待機量のまま5 workerの開始を30msずつ平準化する", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-05T00:00:00.000Z"));
      const base = Date.now();
      const startedAt: number[] = [];
      const gate = createDailyStockStartGate(30);
      const pending = Promise.all(
        Array.from({ length: 5 }, async () => {
          await gate.wait();
          startedAt.push(Date.now());
        })
      );

      await vi.runAllTimersAsync();
      await pending;

      expect(startedAt.map((value) => value - base)).toEqual([
        0, 30, 60, 90, 120,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("待機中に観測した最初の429だけで後続を最大30秒止める", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-05T00:00:00.000Z"));
      const base = Date.now();
      const startedAt: number[] = [];
      const gate = createDailyStockStartGate(30);
      const pending = Promise.all(
        Array.from({ length: 3 }, async () => {
          await gate.wait();
          startedAt.push(Date.now());
        })
      );

      await vi.advanceTimersByTimeAsync(10);
      gate.observeFailure(
        "Chart API HTTP エラー [9503]: 429 Too Many Requests; " +
          `retry-at-ms=${Date.now() + 60_000}`
      );
      await vi.advanceTimersByTimeAsync(990);
      gate.observeFailure(
        "QuoteSummary API HTTP エラー [9506]: 429 Too Many Requests; " +
          `retry-at-ms=${Date.now() + 60_000}`
      );

      await vi.advanceTimersByTimeAsync(29_040);
      await pending;

      expect(startedAt.map((value) => value - base)).toEqual([
        0, 30_010, 30_040,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

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
    ["Nikkei smartchart HTTP エラー: 500 Internal Server Error", true],
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

  it("macroを優先しstockと共有する100件枠・外部call上限を守る", async () => {
    vi.useFakeTimers();
    try {
      const macroFailures = Array.from({ length: 5 }, (_, index) => ({
        target: `macro-${index}`,
        error: `Chart API HTTP エラー [macro-${index}]: 500 Internal Server Error`,
      }));
      const stockFailures = Array.from({ length: 100 }, (_, index) => ({
        target: `stock-${index}`,
        error: `Chart API HTTP エラー [stock-${index}]: 500 Internal Server Error`,
      }));
      const prioritized = prioritizeDailyRecoveryFailures(
        macroFailures,
        stockFailures
      );
      let macroAttempts = 0;
      let stockAttempts = 0;
      let externalCalls = 0;
      const pending = recoverTransientDailyFailures(
        prioritized,
        async (target) => {
          if (target.kind === "macro") {
            macroAttempts++;
            externalCalls++;
          } else {
            stockAttempts++;
            externalCalls += 2;
          }
        }
      );

      await vi.runAllTimersAsync();
      const result = await pending;

      expect(prioritized.slice(0, 5).map(({ target }) => target.kind)).toEqual(
        Array(5).fill("macro")
      );
      expect(macroAttempts).toBe(5);
      expect(stockAttempts).toBe(95);
      expect(macroAttempts + stockAttempts).toBe(100);
      expect(externalCalls).toBe(195);
      expect(externalCalls).toBeLessThanOrEqual(200);
      expect(result.attempted).toBe(100);
      expect(result.recovered).toBe(100);
      expect(result.skippedDueToLimit).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});
