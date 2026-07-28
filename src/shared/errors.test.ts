import { describe, expect, it } from "vitest";
import { rootCauseMessage } from "./errors.js";

describe("rootCauseMessage", () => {
  it("Drizzle が包んだ本番 D1 エラーの最深 cause を返す", () => {
    // 2026-07-27 run で表層 SQL/params に偶然「404」が混ざり、
    // 上場廃止と誤判定された実障害を固定する。
    const d1 = new Error(
      'D1 HTTP error: [{"code":7500,"message":"no such column: adj"}]'
    );
    const drizzle = new Error(
      "Failed query: insert into swing_daily_ohlcv ... params: 404",
      { cause: d1 }
    );

    expect(rootCauseMessage(drizzle)).toBe(d1.message);
    expect(rootCauseMessage(drizzle)).not.toContain("params: 404");
  });

  it("cause のない通常エラーは元メッセージを返す", () => {
    const yahoo = new Error(
      "QuoteSummary API HTTP エラー [130A]: 404 Not Found"
    );
    expect(rootCauseMessage(yahoo)).toBe(yahoo.message);
  });

  it("運用者向けの外側説明は具体的なcauseと共に残す", () => {
    const d1 = new Error("D1 HTTP 400: no such column: adj");
    const drizzle = new Error("Failed query: SELECT adj ...", { cause: d1 });
    const preflight = new Error(
      "D1 スキーマ不整合: migration適用状態を確認してください。",
      { cause: drizzle }
    );

    expect(rootCauseMessage(preflight)).toBe(
      `${preflight.message} / 原因: ${d1.message}`
    );
  });
});
