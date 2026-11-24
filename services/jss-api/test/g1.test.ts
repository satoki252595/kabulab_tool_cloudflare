/**
 * G1 読み取り専用 (内部面のみ) の REST 6 本と MCP `jp_*` 6 本のテスト。
 *
 * D1 / R2 はスタブ (実通信なし)。行の値は形状確認用の配管フィクスチャで、
 * 実在企業の実測値ではない。並び替え・絞り込みそのものは SQL が担うため、
 * スタブは「選択済みの行」を返し、選択規則は発行 SQL の形で固定する
 * (`forecast-latest.test.ts` と同方針)。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import privateApp from "../src/private";
import publicApp from "../src/public";
import { MASTER_COLUMN_LICENSES, fetchDisclosures, jstDayStartEpoch } from "../src/shared/g1";
import { TOOLS, handleMcp } from "../src/shared/mcp";
import type { PrivateEnv, PublicEnv } from "../src/shared/types";
import { stubD1, stubR2 } from "./helpers";

const AUTH = { headers: { "X-API-Key": "secret-key" } };

const DISC_ROWS: Record<string, unknown>[] = [
  {
    code: "7203", company_code: "72030", company_name: "テスト自動車",
    tdnet_id: "t-002", title: "決算短信", pubdate: 1_791_000_000,
    document_url: "https://example.test/doc2.pdf", xbrl_url: "https://example.test/x2.zip",
    markets_string: "東証", tags: '["決算短信","増配"]', primary_tag: "決算短信",
    ingested_at: 1_791_003_600, _id: 12,
  },
  {
    code: "7203", company_code: "72030", company_name: "テスト自動車",
    tdnet_id: "t-001", title: "月次報告", pubdate: 1_790_000_000,
    document_url: "https://example.test/doc1.pdf", xbrl_url: null,
    markets_string: "東証", tags: "[]", primary_tag: null,
    ingested_at: 1_790_003_600, _id: 11,
  },
];

const FIN_ROWS: Record<string, unknown>[] = [
  {
    code: "7203", fiscal_period_end: "2026-03-31", disclosure_type: "本決算",
    consolidated: "連結", accounting_standard: "日本基準", net_sales: 1000,
    operating_income: 100, ordinary_income: 110, net_income: 80, eps: 10.5,
    bps: 200.25, roe_pct: 5, roa_pct: null, equity_ratio_pct: 40,
    cf_operating: 90, cf_investing: -30, cf_financing: -20, dps_actual: 5,
    dps_forecast: 6, forecast_net_sales: 1100, forecast_operating_income: 120,
    forecast_ordinary_income: null, forecast_net_income: 90, forecast_eps: 11,
    disclosed_at: 1_791_000_000, doc_id: "doc-2", raw_sha256: "a".repeat(64),
    source: "TDnet", license_tag: "factual-cite", data_date: "2026-05-01",
    fetched_at: 1_791_003_600, quality: "ok", name: "テスト自動車",
  },
  {
    code: "7203", fiscal_period_end: "2025-03-31", disclosure_type: "本決算",
    consolidated: "連結", accounting_standard: "日本基準", net_sales: 900,
    operating_income: 90, ordinary_income: 95, net_income: 70, eps: 9,
    bps: 190, roe_pct: 4.5, roa_pct: null, equity_ratio_pct: 39,
    cf_operating: 80, cf_investing: -25, cf_financing: -15, dps_actual: 4,
    dps_forecast: null, forecast_net_sales: null, forecast_operating_income: null,
    forecast_ordinary_income: null, forecast_net_income: null, forecast_eps: null,
    disclosed_at: 1_760_000_000, doc_id: "doc-1", raw_sha256: "b".repeat(64),
    source: "EDINET", license_tag: "commercial-ok", data_date: "2025-06-01",
    fetched_at: 1_760_003_600, quality: "ok", name: "テスト自動車",
  },
];

const FORECAST_ROWS: Record<string, unknown>[] = [
  {
    code: "7203", doc_id: "f-001", disclosed_at: 1_760_000_000,
    target_period_end: "2026-03-31", forecast_scope: "current_year",
    consolidated: "連結", forecast_net_sales: 1000, forecast_operating_income: 100,
    forecast_ordinary_income: null, forecast_net_income: 80, forecast_eps: 10,
    dps_forecast: 5, dps_target_period_end: "2026-03-31",
    source_period_end: "2025-03-31", source_disclosure_type: "本決算",
    raw_sha256: "c".repeat(64), source: "TDnet", license_tag: "factual-cite",
    fetched_at: 1_760_003_600, name: "テスト自動車",
  },
  {
    code: "7203", doc_id: "f-002", disclosed_at: 1_791_000_000,
    target_period_end: "2027-03-31", forecast_scope: "current_year",
    consolidated: "連結", forecast_net_sales: 1100, forecast_operating_income: 120,
    forecast_ordinary_income: null, forecast_net_income: 90, forecast_eps: 11,
    dps_forecast: 6, dps_target_period_end: "2027-03-31",
    source_period_end: "2026-03-31", source_disclosure_type: "本決算",
    raw_sha256: "d".repeat(64), source: "TDnet", license_tag: "factual-cite",
    fetched_at: 1_791_003_600, name: "テスト自動車",
  },
];

const EVENT_ROWS: Record<string, unknown>[] = [
  {
    code: "7203", kind: "transfer", effective_date: "2026-04-01", name: "テスト自動車",
    market_from: "スタンダード", market_to: "プライム", source_url: "https://example.test/e2",
    fetched_at: "2026-04-02T00:00:00.000Z", raw_sha: "e".repeat(64),
    archive_key: "k2", last_seen_fetched_at: "2026-04-02T00:00:00.000Z", _id: 22,
  },
  {
    code: "6758", kind: "listing", effective_date: "2026-03-01", name: "テスト電機",
    market_from: null, market_to: "プライム", source_url: "https://example.test/e1",
    fetched_at: "2026-03-02T00:00:00.000Z", raw_sha: "f".repeat(64),
    archive_key: "k1", last_seen_fetched_at: "2026-03-02T00:00:00.000Z", _id: 21,
  },
];

const MASTER_ROWS: Record<string, unknown>[] = [
  { code: "6758", name: "テスト電機", sector33: "電気機器", is_active: 0 },
  { code: "7203", name: "テスト自動車", sector33: "輸送用機器", is_active: 1 },
];

const KNOWN_CODES = ["7203", "6758", "6088"];

const DAILY_PAYLOAD = {
  code: "7203",
  updated: "2026-01-05T00:00:00.000Z",
  bars: [
    { date: "2026-01-01", o: 100, h: 110, l: 90, c: 105, v: 1000 },
    { date: "2026-01-02", o: 105, h: 115, l: 95, c: 110, v: 1100 },
    { date: "2026-01-03", o: 110, h: 120, l: 100, c: 115, v: 1200, adj: 114.5 },
  ],
  splits: [
    { date: "2025-12-30", ratio: 2 },
    { date: "2026-06-01", ratio: 3 },
  ],
  proof: { sentinel: "do-not-return" },
};

function g1D1() {
  return stubD1((sql, params) => {
    const strs = params.map(String);
    if (sql.includes("jss_financial_forecasts")) {
      return FORECAST_ROWS.filter((r) => String(r.code) === strs[0]);
    }
    if (sql.includes("jss_financials")) {
      return FIN_ROWS.filter((r) => strs.includes(String(r.code)));
    }
    if (sql.includes("ir_disclosures")) return DISC_ROWS;
    if (sql.includes("universe_official_events")) return EVENT_ROWS;
    if (sql.includes("sector33")) {
      if (sql.includes("code IN")) return MASTER_ROWS.filter((r) => strs.includes(String(r.code)));
      return [...MASTER_ROWS].sort((a, b) => String(a.code).localeCompare(String(b.code)));
    }
    if (sql.includes("core_stocks")) {
      return KNOWN_CODES.filter((c) => strs.includes(c)).map((code) => ({ code }));
    }
    return [];
  });
}

function privateEnv(overrides: Partial<PrivateEnv> = {}): PrivateEnv {
  return {
    DB: g1D1(),
    RAW: stubR2({}),
    VWAP: stubR2({ "daily/7203.json": DAILY_PAYLOAD, "margin/dates.json": [] }),
    SUPPLY: stubR2({}),
    SURFACE: "private",
    JSS_API_KEYS: "secret-key",
    ...overrides,
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

async function mcpCall(env: PrivateEnv, name: string, args: Record<string, unknown>) {
  const res = await handleMcp(rpc("tools/call", { name, arguments: args }), env);
  return await res.json() as { result: { content: { text: string }[]; isError?: boolean } };
}

function mcpData(body: { result: { content: { text: string }[] } }) {
  return JSON.parse(body.result.content[0]!.text) as {
    data: unknown;
    meta: { cursor: string | null; licenses: string[]; attribution: string[] };
  };
}

describe("G1 共通", () => {
  it("JST 暦日の開始 epoch は UTC+9 の 00:00", () => {
    // 2026-01-01T00:00+09:00 = 2025-12-31T15:00Z。
    expect(jstDayStartEpoch("2026-01-01")).toBe(1_767_193_200);
    expect(jstDayStartEpoch("2026-01-02") - jstDayStartEpoch("2026-01-01")).toBe(86_400);
  });

  it("新規6パスは公開面に存在しない", async () => {
    for (const path of [
      "/v1/disclosures",
      "/v1/financials/7203",
      "/v1/forecasts/7203/history",
      "/v1/universe/events",
      "/v1/ohlcv-r2/7203",
      "/v1/universe/master",
    ]) {
      const res = await publicApp.request(path, {}, publicEnv());
      expect(res.status, path).toBe(404);
    }
  });

  it("内部面は無キー 401・未設定 503 (新規パスでも fail-closed)", async () => {
    expect((await privateApp.request("/v1/disclosures", {}, privateEnv())).status).toBe(401);
    expect((await privateApp.request("/v1/universe/master", {}, privateEnv({ JSS_API_KEYS: undefined }))).status).toBe(503);
    expect((await privateApp.request("/v1/ohlcv-r2/7203", { headers: { "X-API-Key": "wrong" } }, privateEnv())).status).toBe(401);
  });
});

describe("REST /v1/disclosures", () => {
  it("tags を配列化し has_xbrl と factual-cite を返す (本文・内部IDなし)", async () => {
    const res = await privateApp.request("/v1/disclosures", AUTH, privateEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: Record<string, unknown>[];
      meta: { licenses: string[]; attribution: string[]; cursor: string | null };
    };
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({ code: "7203", tdnet_id: "t-002", tags: ["決算短信", "増配"], has_xbrl: true });
    expect(body.data[1]).toMatchObject({ tdnet_id: "t-001", tags: [], has_xbrl: false, xbrl_url: null });
    expect(body.data[0]).not.toHaveProperty("_id");
    expect(body.meta.licenses).toEqual(["factual-cite"]);
    expect(body.meta.attribution[0]).toContain("TDnet");
    expect(body.meta.cursor).toBeNull();
  });

  it("limit+1 件でカーソルを出し、次ページ述語を SQL に含める", async () => {
    const res = await privateApp.request("/v1/disclosures?limit=1", AUTH, privateEnv());
    const body = await res.json() as { data: unknown[]; meta: { cursor: string | null } };
    expect(body.data).toHaveLength(1);
    expect(body.meta.cursor).toBe("1791000000:12");

    let seenSql = "";
    let seenParams: unknown[] = [];
    const db = stubD1((sql, params) => {
      seenSql = sql;
      seenParams = params;
      return [];
    });
    await fetchDisclosures(db, { code: "7203", titleContains: "a%b", tag: "決算短信", limit: 5, cursor: "1791000000:12" });
    expect(seenSql).toContain("JOIN core_stocks");
    expect(seenSql).toContain("json_each(d.tags)");
    expect(seenSql).toContain("LIKE ? ESCAPE");
    expect(seenSql).toContain("(d.pubdate < ? OR (d.pubdate = ? AND d.id < ?))");
    expect(seenSql).toContain("ORDER BY d.pubdate DESC, d.id DESC");
    expect(seenParams).toContain("%a\\%b%");
  });

  it("不正コード・不正日付・逆転範囲・不正カーソルは 400", async () => {
    const env = privateEnv();
    const cases: [string, string][] = [
      ["/v1/disclosures?code=720", "invalid_code"],
      ["/v1/disclosures?from=2026-02-30", "invalid_range"],
      ["/v1/disclosures?from=2026-02-01&to=2026-01-01", "invalid_range"],
      ["/v1/disclosures?cursor=nope", "invalid_cursor"],
      ["/v1/disclosures?tag=", "invalid_query"],
    ];
    for (const [path, code] of cases) {
      const res = await privateApp.request(path, AUTH, env);
      expect(res.status, path).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    }
  });

  it("0件でも factual-cite を保ち出典は空にする", async () => {
    const env = privateEnv({ DB: stubD1(() => []) });
    const res = await privateApp.request("/v1/disclosures", AUTH, env);
    const body = await res.json() as { data: unknown[]; meta: { licenses: string[]; attribution: string[] } };
    expect(body.data).toEqual([]);
    expect(body.meta.licenses).toEqual(["factual-cite"]);
    expect(body.meta.attribution).toEqual([]);
  });

  it("壊れた tags JSON は 500 (黙って空配列にしない)", async () => {
    const env = privateEnv({ DB: stubD1(() => [{ ...DISC_ROWS[0], tags: "not-json" }]) });
    const res = await privateApp.request("/v1/disclosures", AUTH, env);
    expect(res.status).toBe(500);
  });
});

describe("REST /v1/financials/:code", () => {
  it("実績+予想列と行ライセンス2種を伝播する", async () => {
    const res = await privateApp.request("/v1/financials/7203", AUTH, privateEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: Record<string, unknown>[];
      meta: { licenses: string[]; attribution: string[] };
    };
    expect(body.data.map((r) => r.fiscal_period_end)).toEqual(["2026-03-31", "2025-03-31"]);
    expect(body.data[0]).toMatchObject({ net_sales: 1000, bps: 200.25, forecast_eps: 11 });
    expect(body.data[0]).not.toHaveProperty("stock_id");
    expect(body.data[0]).not.toHaveProperty("raw_page_id");
    expect(body.meta.licenses).toEqual(["commercial-ok", "factual-cite"]);
    expect(body.meta.attribution.join(" ")).toContain("TDnet");
    expect(body.meta.attribution.join(" ")).toContain("EDINET");
  });

  it("実在銘柄の0件は 200 空、未知コードは 404 unknown_code", async () => {
    const env = privateEnv();
    const empty = await privateApp.request("/v1/financials/6088", AUTH, env);
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { data: unknown[] }).data).toEqual([]);
    const unknown = await privateApp.request("/v1/financials/9999", AUTH, env);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("unknown_code");
  });

  it("コード不正・範囲不正は 400、未知 license_tag 行は 500", async () => {
    const env = privateEnv();
    expect((await privateApp.request("/v1/financials/720", AUTH, env)).status).toBe(400);
    expect((await privateApp.request("/v1/financials/7203?from=2026-13-01", AUTH, env)).status).toBe(400);
    const bad = privateEnv({
      DB: stubD1((sql) => sql.includes("jss_financials") ? [{ ...FIN_ROWS[0], license_tag: "mystery" }] : []),
    });
    expect((await privateApp.request("/v1/financials/7203", AUTH, bad)).status).toBe(500);
  });
});

describe("REST /v1/forecasts/:code/history", () => {
  it("全履歴を開示時刻の古い順で返す", async () => {
    const res = await privateApp.request("/v1/forecasts/7203/history", AUTH, privateEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown>[]; meta: { licenses: string[] } };
    expect(body.data.map((r) => r.doc_id)).toEqual(["f-001", "f-002"]);
    expect(body.meta.licenses).toEqual(["factual-cite"]);
  });

  it("未知 404 / 予想なし(範囲なし) 404 / 予想なし(範囲あり) 200 空", async () => {
    const env = privateEnv();
    const unknown = await privateApp.request("/v1/forecasts/9999/history", AUTH, env);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("unknown_code");
    const none = await privateApp.request("/v1/forecasts/6758/history", AUTH, env);
    expect(none.status).toBe(404);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe("no_forecast_in_store");
    const ranged = await privateApp.request("/v1/forecasts/6758/history?from=2026-01-01", AUTH, env);
    expect(ranged.status).toBe(200);
    expect(((await ranged.json()) as { data: unknown[] }).data).toEqual([]);
  });
});

describe("REST /v1/universe/events", () => {
  it("personal-only で返しカーソルを出す", async () => {
    const res = await privateApp.request("/v1/universe/events?limit=1", AUTH, privateEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: Record<string, unknown>[];
      meta: { licenses: string[]; cursor: string | null; attribution: string[] };
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ kind: "transfer", effective_date: "2026-04-01" });
    expect(body.data[0]).not.toHaveProperty("_id");
    expect(body.meta.licenses).toEqual(["personal-only"]);
    expect(body.meta.attribution[0]).toContain("JPX");
    expect(body.meta.cursor).toBe("2026-04-01:22");
  });

  it("kind 不正・カーソル不正は 400、未知 kind の保存行は 500", async () => {
    const env = privateEnv();
    const badKind = await privateApp.request("/v1/universe/events?kind=split", AUTH, env);
    expect(badKind.status).toBe(400);
    expect(((await badKind.json()) as { error: { code: string } }).error.code).toBe("invalid_kind");
    expect((await privateApp.request("/v1/universe/events?cursor=2026-02-30:1", AUTH, env)).status).toBe(400);
    const bad = privateEnv({
      DB: stubD1((sql) => sql.includes("universe_official_events") ? [{ ...EVENT_ROWS[0], kind: "split" }] : []),
    });
    expect((await privateApp.request("/v1/universe/events", AUTH, bad)).status).toBe(500);
  });
});

describe("REST /v1/ohlcv-r2/:code", () => {
  it("bars を範囲で絞り splits は全件・分離のまま返す (proof は出さない)", async () => {
    const res = await privateApp.request("/v1/ohlcv-r2/7203?from=2026-01-02&to=2026-01-03", AUTH, privateEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: { code: string; updated: string; bars: Record<string, unknown>[]; splits: unknown[] };
      meta: { licenses: string[] };
    };
    expect(body.data.bars.map((b) => b.date)).toEqual(["2026-01-02", "2026-01-03"]);
    expect(body.data.bars[0]).not.toHaveProperty("adj");
    expect(body.data.bars[1]).toMatchObject({ adj: 114.5 });
    expect(body.data.splits).toEqual([
      { date: "2025-12-30", ratio: 2 },
      { date: "2026-06-01", ratio: 3 },
    ]);
    expect(body.data).not.toHaveProperty("proof");
    expect(body.meta.licenses).toEqual(["personal-only"]);
  });

  it("オブジェクトなし 404、範囲不正 400、壊れ payload 500", async () => {
    const env = privateEnv();
    expect((await privateApp.request("/v1/ohlcv-r2/6758", AUTH, env)).status).toBe(404);
    expect((await privateApp.request("/v1/ohlcv-r2/7203?to=2026-01-32", AUTH, env)).status).toBe(400);
    const mismatch = privateEnv({
      VWAP: stubR2({ "daily/7203.json": { ...DAILY_PAYLOAD, code: "6758" } }),
    });
    expect((await privateApp.request("/v1/ohlcv-r2/7203", AUTH, mismatch)).status).toBe(500);
    const noSplits = privateEnv({
      VWAP: stubR2({ "daily/7203.json": { code: "7203", updated: "x", bars: [] } }),
    });
    expect((await privateApp.request("/v1/ohlcv-r2/7203", AUTH, noSplits)).status).toBe(500);
    const badBar = privateEnv({
      VWAP: stubR2({
        "daily/7203.json": { code: "7203", bars: [{ date: "2026-13-01", o: 1, h: 1, l: 1, c: 1, v: 1 }], splits: [] },
      }),
    });
    expect((await privateApp.request("/v1/ohlcv-r2/7203", AUTH, badBar)).status).toBe(500);
  });
});

describe("REST /v1/universe/master", () => {
  it("sector33 のみ・is_active boolean・最も厳しい区分を含む", async () => {
    const res = await privateApp.request("/v1/universe/master?codes=7203,6758", AUTH, privateEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown>[]; meta: { licenses: string[] } };
    expect(body.data).toHaveLength(2);
    const row = body.data.find((r) => r.code === "7203");
    expect(row).toMatchObject({ sector33: "輸送用機器", is_active: true });
    expect(row).not.toHaveProperty("sector");
    expect(row).not.toHaveProperty("market");
    expect(body.data.find((r) => r.code === "6758")).toMatchObject({ is_active: false });
    expect(body.meta.licenses).toEqual(["commercial-ok", "personal-only"]);
  });

  it("列ライセンス宣言が共有契約と一致する", () => {
    const contract = JSON.parse(readFileSync(
      new URL("../../../tests/fixtures/contracts/d1-license-map.json", import.meta.url), "utf8",
    )) as { column_license: Record<string, Record<string, string>> };
    const declared = contract.column_license.core_stocks;
    if (!declared) throw new Error("地図に core_stocks が無い");
    for (const [column, tag] of Object.entries(MASTER_COLUMN_LICENSES)) {
      expect(declared[column], column).toBe(tag);
    }
  });

  it("activeOnly 不正・codes+cursor 併用は 400、一覧カーソルは code", async () => {
    const env = privateEnv();
    expect((await privateApp.request("/v1/universe/master?activeOnly=yes", AUTH, env)).status).toBe(400);
    expect((await privateApp.request("/v1/universe/master?codes=7203&cursor=7203", AUTH, env)).status).toBe(400);
    expect((await privateApp.request("/v1/universe/master?codes=7203,bad", AUTH, env)).status).toBe(400);
    const res = await privateApp.request("/v1/universe/master?limit=1", AUTH, env);
    const body = await res.json() as { data: Record<string, unknown>[]; meta: { cursor: string | null } };
    expect(body.data.map((r) => r.code)).toEqual(["6758"]);
    expect(body.meta.cursor).toBe("6758");
  });
});

describe("MCP G1 ツール", () => {
  it("tools/list に6本並ぶ", () => {
    const names = TOOLS.map((t) => t.name);
    for (const name of [
      "jp_disclosures_list", "jp_financials", "jp_forecast_history",
      "jp_universe_events", "jp_ohlcv_r2_range", "jp_universe_master",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("jp_disclosures_list / jp_universe_events / jp_universe_master が封筒で返る", async () => {
    const env = privateEnv();
    const disc = mcpData(await mcpCall(env, "jp_disclosures_list", { limit: 1 }));
    expect((disc.data as unknown[])).toHaveLength(1);
    expect(disc.meta.licenses).toEqual(["factual-cite"]);
    expect(disc.meta.cursor).toBe("1791000000:12");

    const events = mcpData(await mcpCall(env, "jp_universe_events", { kind: "listing" }));
    expect(events.meta.licenses).toEqual(["personal-only"]);

    const master = mcpData(await mcpCall(env, "jp_universe_master", { codes: ["7203"] }));
    expect(master.data).toMatchObject([{ code: "7203", is_active: true }]);
    expect(master.meta.licenses).toContain("personal-only");
  });

  it("jp_financials は単一/バッチと not_found 理由を返す", async () => {
    const env = privateEnv();
    const single = mcpData(await mcpCall(env, "jp_financials", { code: "7203" }));
    const singleData = single.data as { results: Record<string, unknown>[]; not_found: string[] };
    expect(singleData.results).toHaveLength(2);
    expect(singleData.not_found).toEqual([]);

    const batch = mcpData(await mcpCall(env, "jp_financials", { codes: ["7203", "6088", "9999"] }));
    const batchData = batch.data as {
      results: unknown[]; not_found: string[];
      not_found_reasons: { code: string; reason: string }[];
    };
    expect(batchData.not_found).toEqual(["6088", "9999"]);
    expect(batchData.not_found_reasons).toEqual([
      { code: "6088", reason: "not_collected" },
      { code: "9999", reason: "unknown_code" },
    ]);
    expect(batch.meta.licenses).toEqual(["commercial-ok", "factual-cite"]);

    const both = await mcpCall(env, "jp_financials", { code: "7203", codes: ["7203"] });
    expect(both.result.isError).toBe(true);
  });

  it("jp_forecast_history / jp_ohlcv_r2_range の成功と欠損", async () => {
    const env = privateEnv();
    const hist = mcpData(await mcpCall(env, "jp_forecast_history", { code: "7203" }));
    expect((hist.data as Record<string, unknown>[]).map((r) => r.doc_id)).toEqual(["f-001", "f-002"]);
    const unknown = await mcpCall(env, "jp_forecast_history", { code: "9999" });
    expect(unknown.result.isError).toBe(true);
    expect(unknown.result.content[0]!.text).toContain("unknown_code");

    const ohlcv = mcpData(await mcpCall(env, "jp_ohlcv_r2_range", { code: "7203", from: "2026-01-03" }));
    const data = ohlcv.data as { bars: unknown[]; splits: unknown[] };
    expect(data.bars).toHaveLength(1);
    expect(data.splits).toHaveLength(2);
    const missing = await mcpCall(env, "jp_ohlcv_r2_range", { code: "6758" });
    expect(missing.result.isError).toBe(true);
  });

  it("不正引数は isError (kind / 日付 / activeOnly / コード)", async () => {
    const env = privateEnv();
    for (const [name, args] of [
      ["jp_universe_events", { kind: "split" }],
      ["jp_disclosures_list", { from: "2026-02-30" }],
      ["jp_universe_master", { activeOnly: "yes" }],
      ["jp_ohlcv_r2_range", { code: "bad" }],
      ["jp_disclosures_list", { code: null }],
    ] as [string, Record<string, unknown>][]) {
      const body = await mcpCall(env, name, args);
      expect(body.result.isError, name).toBe(true);
    }
  });
});


