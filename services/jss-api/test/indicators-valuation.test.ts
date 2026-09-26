/**
 * 旧 Notion「②株価テクニカル」(swing_stock_indicators / otakara_stock_financials)
 * と「⑦収集ジョブログ」(jss_job_runs) の代替エンドポイント／MCP ツールのテスト。
 *
 * D1 はスタブで、実通信はしない。stubD1 は sql テキストと bind パラメータの両方を
 * 見て、実際の D1 の `WHERE code IN (...)` に近い絞り込みを模する
 * （そうしないと not_found の検証ができない）。
 */
import { describe, expect, it } from "vitest";

import privateApp from "../src/private";
import publicApp from "../src/public";
import { MAX_BATCH_CODES } from "../src/shared/routes";
import { TOOLS, handleMcp } from "../src/shared/mcp";
import type { PrivateEnv, PublicEnv } from "../src/shared/types";
import { stubD1, stubR2 } from "./helpers";

const AUTH = { headers: { "X-API-Key": "secret-key" } };

const INDICATOR_ROWS: Record<string, unknown>[] = [
  {
    code: "7203",
    name: "トヨタ自動車",
    latest_close: 3000,
    latest_volume: 12_000_000,
    latest_date: "2026-09-25",
    pct_change_1d: 1.2,
    sma_5: 2950,
    sma_20: 2900,
    sma_25: 2890,
    sma_60: 2800,
    sma_75: 2780,
    rsi_14: 55.5,
    macd: 10.2,
    macd_signal: 9.1,
    macd_hist: 1.1,
    atr_14: 45.2,
    atr_pct: 0.015,
    volume_ratio: 1.3,
    avg_turnover_20d: 5_000_000_000,
    range_20d_high: 3100,
    range_20d_low: 2850,
    range_width: 250,
    computed_at: 1_758_700_000,
  },
];

const VALUATION_ROWS: Record<string, unknown>[] = [
  {
    code: "7203",
    name: "トヨタ自動車",
    price: 3000,
    per: 10.5,
    pbr: 1.1,
    dividend_yield: 2.5,
    eps: 285.7,
    bps: 2727.3,
    roe: 10.5,
    roa: 5.2,
    market_cap: 45_000_000_000_000,
    data_date: "2026-09-25",
    fetched_at: 1_758_700_000,
  },
];

const JOB_RUN_ROWS: Record<string, unknown>[] = [
  { job_name: "stock-sync", status: "success", processed: 3800, failed: 0, run_url: null, duration_secs: 120.5, finished_at: 1_758_700_000 },
  { job_name: "vwap-sync", status: "success", processed: 3800, failed: 0, run_url: null, duration_secs: 90.1, finished_at: 1_758_600_000 },
];

/** 与えた行集合を、bind パラメータの code 群で絞り込むスタブ D1。 */
function codeFilteredD1(rows: Record<string, unknown>[], marker: string) {
  return stubD1((sql, params) => {
    if (!sql.includes(marker)) return [];
    const codes = params.map(String);
    return rows.filter((r) => codes.includes(String(r.code)));
  });
}

function privateEnv(db: D1Database): PrivateEnv {
  return {
    DB: db,
    RAW: stubR2({}),
    SUPPLY: stubR2({}),
    SURFACE: "private",
    JSS_API_KEYS: "secret-key",
  };
}

function publicEnv(): PublicEnv {
  return { DB: stubD1(() => []), RAW: stubR2({}), SURFACE: "public" };
}

function rpc(method: string, params?: Record<string, unknown>) {
  return new Request("https://x/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("REST /v1/indicators/:code", () => {
  it("見つかれば personal-only の封筒で返す", async () => {
    const env = privateEnv(codeFilteredD1(INDICATOR_ROWS, "swing_stock_indicators"));
    const res = await privateApp.request("/v1/indicators/7203", AUTH, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { code: string; rsi_14: number }; meta: { licenses: string[] } };
    expect(body.data.code).toBe("7203");
    expect(body.data.rsi_14).toBe(55.5);
    expect(body.meta.licenses).toContain("personal-only");
  });

  it("未知コード・未計算コードは 404", async () => {
    const env = privateEnv(codeFilteredD1(INDICATOR_ROWS, "swing_stock_indicators"));
    const res = await privateApp.request("/v1/indicators/9999", AUTH, env);
    expect(res.status).toBe(404);
  });

  it("銘柄コードが4桁でなければ 400", async () => {
    const env = privateEnv(codeFilteredD1(INDICATOR_ROWS, "swing_stock_indicators"));
    const res = await privateApp.request("/v1/indicators/72031", AUTH, env);
    expect(res.status).toBe(400);
  });

  it("公開面には存在しない", async () => {
    const res = await publicApp.request("/v1/indicators/7203", {}, publicEnv());
    expect(res.status).toBe(404);
  });
});

describe("REST /v1/valuation/:code", () => {
  it("見つかれば data_date / fetched_at を含めて返す", async () => {
    const env = privateEnv(codeFilteredD1(VALUATION_ROWS, "otakara_stock_financials"));
    const res = await privateApp.request("/v1/valuation/7203", AUTH, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { per: number; data_date: string; fetched_at: number } };
    expect(body.data.per).toBe(10.5);
    expect(body.data.data_date).toBe("2026-09-25");
    expect(body.data.fetched_at).toBe(1_758_700_000);
  });

  it("未知コード・未取得コードは 404", async () => {
    const env = privateEnv(codeFilteredD1(VALUATION_ROWS, "otakara_stock_financials"));
    const res = await privateApp.request("/v1/valuation/9999", AUTH, env);
    expect(res.status).toBe(404);
  });

  it("公開面には存在しない", async () => {
    const res = await publicApp.request("/v1/valuation/7203", {}, publicEnv());
    expect(res.status).toBe(404);
  });
});

describe("MCP jp_indicators_latest / jp_valuation / jp_job_runs", () => {
  it("tools/list に新ツールが並ぶ", async () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["jp_indicators_latest", "jp_valuation", "jp_job_runs"]),
    );
    expect(names.every((n) => n.startsWith("jp_"))).toBe(true);
  });

  it("jp_indicators_latest は複数銘柄をまとめて返し、見つからない分は not_found へ", async () => {
    const env = privateEnv(codeFilteredD1(INDICATOR_ROWS, "swing_stock_indicators"));
    const res = await handleMcp(
      rpc("tools/call", { name: "jp_indicators_latest", arguments: { codes: ["7203", "9999"] } }),
      env,
    );
    const body = await res.json() as { result: { content: { text: string }[] } };
    const parsed = JSON.parse(body.result.content[0]!.text) as {
      data: { results: { code: string }[]; not_found: string[] };
      meta: { licenses: string[] };
    };
    expect(parsed.data.results.map((r) => r.code)).toEqual(["7203"]);
    expect(parsed.data.not_found).toEqual(["9999"]);
    expect(parsed.meta.licenses).toContain("personal-only");
  });

  it("jp_indicators_latest は codes の上限を超えると isError", async () => {
    const env = privateEnv(codeFilteredD1(INDICATOR_ROWS, "swing_stock_indicators"));
    const tooMany = Array.from({ length: MAX_BATCH_CODES + 1 }, (_, i) => String(1000 + i));
    const res = await handleMcp(
      rpc("tools/call", { name: "jp_indicators_latest", arguments: { codes: tooMany } }),
      env,
    );
    const body = await res.json() as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);
  });

  it("jp_indicators_latest は不正な銘柄コード混入で isError（無効値で埋めて続行しない）", async () => {
    const env = privateEnv(codeFilteredD1(INDICATOR_ROWS, "swing_stock_indicators"));
    const res = await handleMcp(
      rpc("tools/call", { name: "jp_indicators_latest", arguments: { codes: ["7203", "bad"] } }),
      env,
    );
    const body = await res.json() as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);
  });

  it("jp_valuation は複数銘柄をまとめて返す", async () => {
    const env = privateEnv(codeFilteredD1(VALUATION_ROWS, "otakara_stock_financials"));
    const res = await handleMcp(
      rpc("tools/call", { name: "jp_valuation", arguments: { codes: ["7203", "9999"] } }),
      env,
    );
    const body = await res.json() as { result: { content: { text: string }[] } };
    const parsed = JSON.parse(body.result.content[0]!.text) as {
      data: { results: { code: string }[]; not_found: string[] };
    };
    expect(parsed.data.results.map((r) => r.code)).toEqual(["7203"]);
    expect(parsed.data.not_found).toEqual(["9999"]);
  });

  it("jp_job_runs はジョブごとの最新1件を返す", async () => {
    const env = privateEnv(
      stubD1((sql) => (sql.includes("jss_job_runs") ? JOB_RUN_ROWS : [])),
    );
    const res = await handleMcp(rpc("tools/call", { name: "jp_job_runs", arguments: {} }), env);
    const body = await res.json() as { result: { content: { text: string }[] } };
    const parsed = JSON.parse(body.result.content[0]!.text) as {
      data: { job_name: string; status: string; finished_at: number }[];
    };
    expect(parsed.data.map((r) => r.job_name)).toEqual(["stock-sync", "vwap-sync"]);
    expect(parsed.data.every((r) => r.status === "success")).toBe(true);
  });
});
