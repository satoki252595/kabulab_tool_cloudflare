/**
 * 会社業績予想の最新開示1行 (#652): REST `/v1/forecast/:code` と
 * MCP `jp_forecast_latest` のテスト。
 *
 * D1 はスタブ。最新1行の選択自体は SQL の ROW_NUMBER が担うため、
 * スタブは「選択済みの最新行」を返し、選択規則は発行 SQL の形で固定する
 * (実 SQL の実行検証は pipeline 側の sqlite テストと本番 backfill で行う)。
 * 6532 の値は実短信 fixture の確認値 (対象期末 2027-02-28)。
 */
import { describe, expect, it } from "vitest";

import privateApp from "../src/private";
import publicApp from "../src/public";
import { fetchForecastLatestByCodes } from "../src/shared/routes";
import { TOOLS, handleMcp } from "../src/shared/mcp";
import type { PrivateEnv, PublicEnv } from "../src/shared/types";
import { stubD1, stubR2 } from "./helpers";

const AUTH = { headers: { "X-API-Key": "secret-key" } };

/** 最新開示として選択済みの行 (6532 は実値、6088 は予想未定の全 NULL 行)。 */
const LATEST_ROWS: Record<string, unknown>[] = [
  {
    code: "6088",
    name: "シグマクシス・ホールディングス",
    doc_id: "140120260000000002",
    disclosed_at: 1_791_000_000,
    target_period_end: null,
    forecast_scope: "unknown",
    consolidated: "連結",
    forecast_net_sales: null,
    forecast_operating_income: null,
    forecast_ordinary_income: null,
    forecast_net_income: null,
    forecast_eps: null,
    dps_forecast: null,
    dps_target_period_end: null,
    source_period_end: "2026-09-30",
    source_disclosure_type: "中間",
    raw_sha256: "c".repeat(64),
    source: "TDnet",
    license_tag: "factual-cite",
    fetched_at: 1_791_003_600,
  },
  {
    code: "6532",
    name: "ベイカレント",
    doc_id: "140120261009548418",
    disclosed_at: 1_789_700_000,
    target_period_end: "2027-02-28",
    forecast_scope: "current_year",
    consolidated: "連結",
    forecast_net_sales: 190_000_000_000,
    forecast_operating_income: 64_800_000_000,
    forecast_ordinary_income: null,
    forecast_net_income: 48_100_000_000,
    forecast_eps: 323.79,
    dps_forecast: 130,
    dps_target_period_end: "2027-02-28",
    source_period_end: "2026-08-31",
    source_disclosure_type: "中間",
    raw_sha256: "3d010eb3eb80832108df320ab374a1495a7078140a051dfb2090b532bd5f7dd9",
    source: "TDnet",
    license_tag: "factual-cite",
    fetched_at: 1_789_703_600,
  },
];

/** core_stocks に存在するコード (未知/予想なしの区別用スタブ)。 */
const KNOWN_CODES = ["6532", "6088", "7203"];

/**
 * 予想クエリと既知コード確認を SQL で振り分けるスタブ。
 * 予想 SQL は LEFT JOIN で core_stocks も含むため判定順序が重要。
 */
function forecastD1() {
  return stubD1((sql, params) => {
    const codes = params.map(String);
    if (sql.includes("jss_financial_forecasts")) {
      return LATEST_ROWS.filter((r) => codes.includes(String(r.code)));
    }
    if (sql.includes("core_stocks")) {
      return KNOWN_CODES.filter((c) => codes.includes(c)).map((code) => ({ code }));
    }
    return [];
  });
}

function privateEnv(db: D1Database): PrivateEnv {
  return {
    DB: db,
    RAW: stubR2({}),
    VWAP: stubR2({ "margin/dates.json": [] }),
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

describe("fetchForecastLatestByCodes の SQL", () => {
  it("最新開示1行を決定的に選ぶ形である", async () => {
    let seenSql = "";
    let seenParams: unknown[] = [];
    const db = stubD1((sql, params) => {
      seenSql = sql;
      seenParams = params;
      return [];
    });
    await fetchForecastLatestByCodes(db, ["6532", "6088"]);
    expect(seenSql).toContain("FROM jss_financial_forecasts");
    expect(seenSql).toContain("ROW_NUMBER() OVER (PARTITION BY f.code");
    // NULL の開示時刻を最後にし、同刻は取得時刻→doc_id で決着させる。
    expect(seenSql).toContain(
      "ORDER BY (f.disclosed_at IS NULL), f.disclosed_at DESC, f.fetched_at DESC",
    );
    expect(seenSql).toContain("f.doc_id DESC");
    expect(seenSql).toContain("WHERE rn = 1");
    expect(seenParams).toEqual(["6532", "6088"]);
  });
});

describe("REST /v1/forecast/:code", () => {
  it("最新開示1行を factual-cite の封筒で返す", async () => {
    const env = privateEnv(forecastD1());
    const res = await privateApp.request("/v1/forecast/6532", AUTH, env);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: {
        code: string;
        forecast_net_sales: number;
        forecast_eps: number;
        dps_forecast: number;
        target_period_end: string;
        disclosed_at: number;
      };
      meta: { licenses: string[]; attribution: string[] };
    };
    expect(body.data.code).toBe("6532");
    expect(body.data.forecast_net_sales).toBe(190_000_000_000);
    expect(body.data.forecast_eps).toBe(323.79);
    expect(body.data.dps_forecast).toBe(130);
    expect(body.data.target_period_end).toBe("2027-02-28");
    expect(body.data.disclosed_at).toBe(1_789_700_000);
    expect(body.meta.licenses).toEqual(["factual-cite"]);
    expect(body.meta.attribution[0]).toContain("TDnet");
  });

  it("最新開示が予想未定なら NULL のまま 200 で返す (古い開示で埋めない)", async () => {
    const env = privateEnv(forecastD1());
    const res = await privateApp.request("/v1/forecast/6088", AUTH, env);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { forecast_eps: number | null; target_period_end: string | null };
    };
    expect(body.data.forecast_eps).toBeNull();
    expect(body.data.target_period_end).toBeNull();
  });

  it("実在するが予想行が無ければ 404 no_forecast_in_store", async () => {
    const env = privateEnv(forecastD1());
    const res = await privateApp.request("/v1/forecast/7203", AUTH, env);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("no_forecast_in_store");
  });

  it("未知コードは 404 unknown_code", async () => {
    const env = privateEnv(forecastD1());
    const res = await privateApp.request("/v1/forecast/9999", AUTH, env);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("unknown_code");
  });

  it("銘柄コードが4桁でなければ 400", async () => {
    const env = privateEnv(forecastD1());
    const res = await privateApp.request("/v1/forecast/65321", AUTH, env);
    expect(res.status).toBe(400);
  });

  it("公開面には存在しない", async () => {
    const res = await publicApp.request("/v1/forecast/6532", {}, publicEnv());
    expect(res.status).toBe(404);
  });
});

describe("MCP jp_forecast_latest", () => {
  it("tools/list に並ぶ", () => {
    expect(TOOLS.map((t) => t.name)).toContain("jp_forecast_latest");
  });

  it("複数銘柄を返し、欠落理由を unknown_code / no_forecast_in_store で区別する", async () => {
    const env = privateEnv(forecastD1());
    const res = await handleMcp(
      rpc("tools/call", {
        name: "jp_forecast_latest",
        arguments: { codes: ["6532", "6088", "7203", "9999"] },
      }),
      env,
    );
    const body = await res.json() as { result: { content: { text: string }[] } };
    const parsed = JSON.parse(body.result.content[0]!.text) as {
      data: {
        results: { code: string; forecast_eps: number | null }[];
        not_found: string[];
        not_found_reasons: { code: string; reason: string }[];
      };
      meta: { licenses: string[] };
    };
    expect(parsed.data.results.map((r) => r.code)).toEqual(["6088", "6532"]);
    // 予想未定の最新行は null のまま混ざる (欠落扱いにしない)。
    expect(parsed.data.results.find((r) => r.code === "6088")?.forecast_eps).toBeNull();
    expect(parsed.data.not_found).toEqual(["7203", "9999"]);
    expect(parsed.data.not_found_reasons).toEqual([
      { code: "7203", reason: "no_forecast_in_store" },
      { code: "9999", reason: "unknown_code" },
    ]);
    expect(parsed.meta.licenses).toEqual(["factual-cite"]);
  });

  it("不正な銘柄コード混入で isError", async () => {
    const env = privateEnv(forecastD1());
    const res = await handleMcp(
      rpc("tools/call", {
        name: "jp_forecast_latest",
        arguments: { codes: ["6532", "bad"] },
      }),
      env,
    );
    const body = await res.json() as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);
  });
});
