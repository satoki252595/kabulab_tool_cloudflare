import { describe, expect, it, vi } from "vitest";
import {
  createDailyStockStartGate,
  isDailySyncIncomplete,
  isMondayUtc,
  isTransientDailySyncFailure,
  priceSyncStatusOf,
  prioritizeDailyRecoveryFailures,
  recoverTransientDailyFailures,
  runDateKeys,
} from "./daily.js";

describe("priceSyncStatusOf (「株価の日次同期」記録の状態)", () => {
  it("取引日が導出できなければ、失敗銘柄数に関わらず必ず「失敗」", () => {
    expect(priceSyncStatusOf({ tradingDate: null, failedStocks: 0 })).toBe("失敗");
    expect(priceSyncStatusOf({ tradingDate: null, failedStocks: 100 })).toBe("失敗");
  });

  it("取引日が分かり失敗銘柄が0なら「完了」", () => {
    expect(priceSyncStatusOf({ tradingDate: "2026-09-25", failedStocks: 0 })).toBe("完了");
  });

  it("取引日が分かり失敗銘柄が1件以上なら「一部失敗」", () => {
    expect(priceSyncStatusOf({ tradingDate: "2026-09-25", failedStocks: 3 })).toBe("一部失敗");
  });
});

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

  it("後続の429でsource期限が延びても30秒へ短縮せず取得を止める", async () => {
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

      await vi.advanceTimersByTimeAsync(60_030);
      await pending;

      expect(startedAt.map((value) => value - base)).toEqual([
        0, 61_000, 61_030,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("source期限がrun期限以後なら待機/新GET前にfalseを返す", async () => {
    const now = Date.now(), gate = createDailyStockStartGate(30, now + 30_000);
    gate.observeFailure(`Chart API HTTP エラー [7203]: 429 Too Many Requests; retry-at-ms=${now + 120_000}`);
    expect(await gate.wait()).toBe(false);
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
    expect(isDailySyncIncomplete({
      totalStocks: 3_716, successStocks: 3_716, failedStocks: 0, marketContextOk: null,
    })).toBe(false); // 株式専用の対象外は成功/失敗と取り違えない。
  });

  it("失敗率 1% 超・マクロ失敗・空母集団を監視上の失敗にする", () => {
    expect(
      isDailySyncIncomplete({
        totalStocks: 3_716,
        successStocks: 3_678,
        failedStocks: 38,
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

  it("失敗率 1% 以下は成功扱いにする (L-57)", () => {
    expect(
      isDailySyncIncomplete({
        totalStocks: 3_716,
        successStocks: 3_715,
        failedStocks: 1,
        marketContextOk: true,
      })
    ).toBe(false);
    expect(
      isDailySyncIncomplete({
        totalStocks: 3_716,
        successStocks: 3_679,
        failedStocks: 37,
        marketContextOk: true,
      })
    ).toBe(false);
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
      const retryAt = Date.now() + 5_000;
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

      await vi.advanceTimersByTimeAsync(4_999);
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
  it("120秒のsource期限を30秒へ短縮せず回収対象を未試行で残す", async () => {
    const processTarget = vi.fn();
    const failure = { target: "7203", error: `Chart API HTTP エラー [7203]: 429 Too Many Requests; retry-at-ms=${Date.now() + 120_000}` };
    const result = await recoverTransientDailyFailures([failure], processTarget);
    expect(processTarget).not.toHaveBeenCalled();
    expect(result).toEqual({ attempted: 0, recovered: 0, skippedDueToLimit: 1, failures: [failure] });
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

  it("時間予算を過ぎたら止め、超過対象を未解決として残す", async () => {
    vi.useFakeTimers();
    try {
      const failures = Array.from({ length: 5 }, (_, index) => ({
        target: String(index),
        error: `Chart API HTTP エラー [${index}]: 500 Internal Server Error`,
      }));
      const processed: string[] = [];
      const start = Date.now();
      const pending = recoverTransientDailyFailures(
        failures,
        async (target) => {
          processed.push(target);
          // 1 件の処理に 600ms かかる想定で時計を進める。
          vi.advanceTimersByTime(600);
        },
        { deadlineMs: start + 1000 }
      );
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(processed).toEqual(["0", "1"]);
      expect(result.attempted).toBe(2);
      expect(result.recovered).toBe(2);
      expect(result.skippedDueToLimit).toBe(3);
      expect(result.failures).toEqual(failures.slice(2));
    } finally {
      vi.useRealTimers();
    }
  });

  it("deadline を渡さないと全件を回収する", async () => {
    vi.useFakeTimers();
    try {
      const failures = Array.from({ length: 150 }, (_, index) => ({
        target: String(index),
        error: `Chart API HTTP エラー [${index}]: 500 Internal Server Error`,
      }));
      const processed: string[] = [];
      const pending = recoverTransientDailyFailures(
        failures,
        async (target) => {
          processed.push(target);
        }
      );
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(processed).toHaveLength(150);
      expect(result.attempted).toBe(150);
      expect(result.recovered).toBe(150);
      expect(result.skippedDueToLimit).toBe(0);
      expect(result.failures).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("macroを優先する (件数上限なし・時間予算のみ)", async () => {
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
      const order: string[] = [];
      const pending = recoverTransientDailyFailures(
        prioritized,
        async (target) => {
          order.push(target.kind);
        }
      );

      await vi.runAllTimersAsync();
      const result = await pending;

      expect(prioritized.slice(0, 5).map(({ target }) => target.kind)).toEqual(
        Array(5).fill("macro")
      );
      expect(order.slice(0, 5)).toEqual(Array(5).fill("macro"));
      expect(result.attempted).toBe(105);
      expect(result.recovered).toBe(105);
      expect(result.skippedDueToLimit).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isMondayUtc", () => {
  it("UTC の月曜だけ真 (週1ジョブの分岐用)", () => {
    // 2026-09-14 は月曜 (UTC)。
    expect(isMondayUtc(new Date("2026-09-14T00:30:00Z"))).toBe(true);
    expect(isMondayUtc(new Date("2026-09-14T23:59:59Z"))).toBe(true);
    expect(isMondayUtc(new Date("2026-09-15T00:00:00Z"))).toBe(false);
    expect(isMondayUtc(new Date("2026-09-13T23:59:59Z"))).toBe(false);
    // 週の最初の run は UTC 月曜 17:13 (= JST 火曜 02:13)。JST で見ると
    // run は火〜土曜にしか無いので、JST 曜日では「月曜」を拾えない。
    expect(isMondayUtc(new Date("2026-09-14T17:13:00Z"))).toBe(true);
  });
});

describe("runDateKeys (F-05: run 開始時刻に固定)", () => {
  it("月曜開始の run は Phase が火曜に跨いでも月曜のまま", () => {
    // run 開始が月曜 23:59 UTC。Phase 実行時刻で評価し直すと火曜になり
    // prune/年次が skip されて飢餓する。開始時刻の判定を保持する。
    const keys = runDateKeys(Date.parse("2026-09-14T23:59:59Z"));
    expect(keys).toEqual({ runDate: "2026-09-14", runMonday: true });
  });

  it("火曜開始の run は月曜ではない", () => {
    const keys = runDateKeys(Date.parse("2026-09-15T00:00:01Z"));
    expect(keys).toEqual({ runDate: "2026-09-15", runMonday: false });
  });
});
