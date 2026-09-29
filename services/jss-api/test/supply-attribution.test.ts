/**
 * 需給4経路の出典契約テスト (issue #191)。
 *
 * フィルタ適用後に実際に返す行・非空系列だけから `meta.attribution` を
 * 算出する。形状は writer 契約 (`models.py SupplyPoint` /
 * `CF-CANONICAL-DESIGN.md` の `series` 例) を読み取って合わせている。
 * 本番の JSF/JPX 混在有無は未確定のため、混在ケースは契約上の振る舞い
 * (両出典を返す) を固定する。
 */
import { describe, expect, it } from "vitest";

import app from "../src/private";
import { ATTRIBUTION } from "../src/shared/envelope";
import { TOOLS, handleMcp } from "../src/shared/mcp";
import type { PrivateEnv } from "../src/shared/types";
import { stubD1, stubR2 } from "./helpers";

const JSF = ATTRIBUTION["日証金"] as string;
const JPX = ATTRIBUTION.JPX as string;

const AUTH = { headers: { "X-API-Key": "secret-key" } };

interface LatestRow {
  code: string;
  data_type: unknown;
  data_date: string;
  [key: string]: unknown;
}

const JSF_ZANDAKA_ROW: LatestRow = { code: "7203", data_type: "jsf_zandaka", data_date: "2026-09-10" };
const JSF_SHINA_ROW: LatestRow = { code: "7203", data_type: "jsf_shina", data_date: "2026-09-10" };
const JPX_ROW: LatestRow = { code: "7203", data_type: "jpx_margin", data_date: "2026-09-28" };

/** D1 スタブ。WHERE data_type = ? のバインドを尊重して絞る。 */
function dbWithRows(rows: LatestRow[]) {
  return stubD1((_sql, params) => {
    if (params.length >= 1 && typeof params[0] === "string") {
      return rows.filter((r) => r.data_type === params[0]);
    }
    return rows;
  });
}

function envWith(o: { rows?: LatestRow[]; supply?: Record<string, unknown> }): PrivateEnv {
  return {
    DB: dbWithRows(o.rows ?? []),
    RAW: stubR2({}),
    SUPPLY: stubR2(o.supply ?? {}),
    SURFACE: "private",
    JSS_API_KEYS: "secret-key",
  };
}

function seriesPayload(series: unknown): Record<string, unknown> {
  return { code: "7203", updated: "2026-09-29", series };
}

const JSF_POINTS = [{ d: "2026-09-10", exch: "東証およびＰＴＳ", loan_bal: 3450000 }];
const JPX_POINTS = [{ d: "2026-09-28", kind: "daily", isin: "JP3633400001", sell: 9300, buy: 152000 }];

type RestBody = { meta: { attribution: string[]; licenses: string[] } };

// status >= 400 は status/text で検証する。成功レスポンスの JSON parse 失敗は
// フォールバック値で隠さず、そのままテスト失敗にする (架空 meta を返さない)。
async function restResult(res: Response): Promise<{ status: number; body: RestBody | null; text: string | null }> {
  const status = res.status;
  if (status >= 400) return { status, body: null, text: await res.text() };
  return { status, body: (await res.json()) as RestBody, text: null };
}

async function restLatest(rows: LatestRow[], query = "") {
  return restResult(await app.request(`/v1/supply/latest${query}`, AUTH, envWith({ rows })));
}

async function restSeries(payload: Record<string, unknown>, query = "") {
  return restResult(
    await app.request(
      `/v1/supply/7203${query}`,
      AUTH,
      envWith({ supply: { "supply/7203.json": payload } }),
    ),
  );
}

function rpc(method: string, params?: Record<string, unknown>) {
  return new Request("https://x/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function mcpCall(env: PrivateEnv, name: string, args: Record<string, unknown>) {
  const res = await handleMcp(rpc("tools/call", { name, arguments: args }), env);
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  const isError = body.result.isError ?? false;
  return {
    isError,
    envelope: isError
      ? null
      : (JSON.parse(body.result.content[0]!.text) as {
          meta: { attribution: string[]; licenses: string[] };
        }),
  };
}

describe("REST /v1/supply/latest の出典", () => {
  it.each([
    { name: "JSF単独", rows: [JSF_ZANDAKA_ROW, JSF_SHINA_ROW], query: "", attribution: [JSF] },
    { name: "JPX単独", rows: [JPX_ROW], query: "", attribution: [JPX] },
    { name: "混在", rows: [JPX_ROW, JSF_ZANDAKA_ROW], query: "", attribution: [JSF, JPX] },
    { name: "空", rows: [], query: "", attribution: [] },
    { name: "data_type絞込", rows: [JSF_ZANDAKA_ROW, JPX_ROW], query: "?data_type=jpx_margin", attribution: [JPX] },
  ])("$name → attribution が返却行と一致する", async ({ rows, query, attribution }) => {
    const { status, body } = await restLatest(rows, query);
    expect(status).toBe(200);
    expect(body!.meta.attribution).toEqual(attribution);
    expect(body!.meta.licenses).toEqual(["personal-only"]);
  });

  it.each([
    { name: "未知 type の行", rows: [{ ...JSF_ZANDAKA_ROW, data_type: "xxx_unknown" }] },
    { name: "非文字列 type の行", rows: [{ ...JSF_ZANDAKA_ROW, data_type: 123 }] },
    { name: "type 欠損の行", rows: [{ code: "7203", data_date: "2026-09-10" } as unknown as LatestRow] },
  ])("$name → 500 (成功扱いしない)", async ({ rows }) => {
    const { status } = await restLatest(rows);
    expect(status).toBe(500);
  });

  it("不正 data_type filter → 400", async () => {
    const { status, text } = await restLatest([JSF_ZANDAKA_ROW], "?data_type=xxx");
    expect(status).toBe(400);
    expect(text).toContain("invalid_data_type");
  });
});

describe("REST /v1/supply/:code の出典", () => {
  it.each([
    { name: "JSF単独", series: { jsf_zandaka: JSF_POINTS }, query: "", attribution: [JSF] },
    { name: "JPX単独", series: { jpx_margin: JPX_POINTS }, query: "", attribution: [JPX] },
    {
      name: "混在",
      series: { jpx_margin: JPX_POINTS, jsf_zandaka: JSF_POINTS },
      query: "",
      attribution: [JSF, JPX],
    },
    {
      name: "series絞込",
      series: { jpx_margin: JPX_POINTS, jsf_zandaka: JSF_POINTS },
      query: "?series=jpx_margin",
      attribution: [JPX],
    },
    {
      name: "期間で全滅 → 空",
      series: { jsf_zandaka: JSF_POINTS },
      query: "?from=2026-09-11",
      attribution: [],
    },
    { name: "series 空オブジェクト → 空", series: {}, query: "", attribution: [] },
  ])("$name → attribution が返却系列と一致する", async ({ series, query, attribution }) => {
    const { status, body } = await restSeries(seriesPayload(series), query);
    expect(status).toBe(200);
    expect(body!.meta.attribution).toEqual(attribution);
    expect(body!.meta.licenses).toEqual(["personal-only"]);
  });

  it.each([
    { name: "未知 key", series: { xxx_unknown: JSF_POINTS }, query: "" },
    { name: "未知 key (期間で空にしても error)", series: { xxx_unknown: JSF_POINTS }, query: "?from=2026-09-11" },
    { name: "非配列の値", series: { jsf_zandaka: { d: "2026-09-10" } }, query: "" },
  ])("$name → 500 (成功扱いしない)", async ({ series, query }) => {
    const { status } = await restSeries(seriesPayload(series), query);
    expect(status).toBe(500);
  });

  it.each([
    { name: "series 欠損", payload: { code: "7203", updated: "2026-09-29" } },
    { name: "series 非オブジェクト", payload: { code: "7203", updated: "2026-09-29", series: [] } },
  ])("$name → 500 (?? {} で黙殺しない)", async ({ payload }) => {
    const { status } = await restSeries(payload, "");
    expect(status).toBe(500);
  });

  it.each([
    { name: "不正 series filter", query: "?series=xxx", code: "invalid_series" },
    { name: "不正 from 書式", query: "?from=2026/09/10", code: "invalid_range" },
    { name: "不正 to 書式", query: "?to=09-10", code: "invalid_range" },
  ])("$name → 400", async ({ query, code }) => {
    const { status, text } = await restSeries(seriesPayload({ jsf_zandaka: JSF_POINTS }), query);
    expect(status).toBe(400);
    expect(text).toContain(code);
  });
});

describe("MCP 需給ツールの出典", () => {
  const latestEnv = (rows: LatestRow[]) => envWith({ rows });
  const seriesEnv = (series: unknown) =>
    envWith({ supply: { "supply/7203.json": seriesPayload(series) } });

  it.each([
    { name: "latest 混在", tool: "jp_supply_latest", args: {}, env: latestEnv([JPX_ROW, JSF_SHINA_ROW]), attribution: [JSF, JPX] },
    { name: "latest JPX絞込", tool: "jp_supply_latest", args: { data_type: "jpx_margin" }, env: latestEnv([JPX_ROW, JSF_ZANDAKA_ROW]), attribution: [JPX] },
    { name: "latest 空", tool: "jp_supply_latest", args: {}, env: latestEnv([]), attribution: [] },
    {
      name: "series 混在",
      tool: "jp_supply_series",
      args: { code: "7203" },
      env: seriesEnv({ jpx_margin: JPX_POINTS, jsf_shina: [{ d: "2026-09-10", hibu: null }] }),
      attribution: [JSF, JPX],
    },
    {
      name: "series 空",
      tool: "jp_supply_series",
      args: { code: "7203", from: "2026-09-11" },
      env: seriesEnv({ jsf_zandaka: JSF_POINTS }),
      attribution: [],
    },
  ])("$name → attribution が返却データと一致する", async ({ tool, args, env, attribution }) => {
    const { isError, envelope } = await mcpCall(env, tool, args);
    expect(isError).toBe(false);
    expect(envelope!.meta.attribution).toEqual(attribution);
    expect(envelope!.meta.licenses).toEqual(["personal-only"]);
  });

  it.each([
    { name: "latest 未知 type", tool: "jp_supply_latest", args: {}, env: latestEnv([{ ...JPX_ROW, data_type: "zzz" }]) },
    { name: "latest 不正 filter", tool: "jp_supply_latest", args: { data_type: "zzz" }, env: latestEnv([JPX_ROW]) },
    {
      name: "series 未知 key",
      tool: "jp_supply_series",
      args: { code: "7203" },
      env: seriesEnv({ zzz: JPX_POINTS }),
    },
    {
      name: "series 欠損",
      tool: "jp_supply_series",
      args: { code: "7203" },
      env: envWith({ supply: { "supply/7203.json": { code: "7203" } } }),
    },
    {
      name: "series 不正 filter",
      tool: "jp_supply_series",
      args: { code: "7203", series: "zzz" },
      env: seriesEnv({ jsf_zandaka: JSF_POINTS }),
    },
    {
      name: "series 不正 from",
      tool: "jp_supply_series",
      args: { code: "7203", from: "2026/09/10" },
      env: seriesEnv({ jsf_zandaka: JSF_POINTS }),
    },
  ])("$name → isError (成功扱いしない)", async ({ tool, args, env }) => {
    const { isError } = await mcpCall(env, tool, args);
    expect(isError).toBe(true);
  });
});

describe("filter の非文字列境界 (生入力で拒否)", () => {
  // undefined だけが省略扱い。String() 変換・truthiness 判定を先にすると
  // false/0 が未指定に消え、['jpx_margin'] が正規型に化ける。
  const NON_STRINGS: Array<{ label: string; value: unknown }> = [
    { label: "null", value: null },
    { label: "false", value: false },
    { label: "0", value: 0 },
    { label: "[]", value: [] },
    { label: "['jpx_margin']", value: ["jpx_margin"] },
    { label: "{}", value: {} },
    { label: '""', value: "" },
  ];
  const seriesEnv = () =>
    envWith({ supply: { "supply/7203.json": seriesPayload({ jsf_zandaka: JSF_POINTS }) } });

  it.each(NON_STRINGS)("MCP latest data_type=$label → isError", async ({ value }) => {
    const { isError } = await mcpCall(envWith({ rows: [JSF_ZANDAKA_ROW] }), "jp_supply_latest", {
      data_type: value,
    });
    expect(isError).toBe(true);
  });

  it.each(NON_STRINGS)("MCP series series=$label → isError", async ({ value }) => {
    const { isError } = await mcpCall(seriesEnv(), "jp_supply_series", { code: "7203", series: value });
    expect(isError).toBe(true);
  });

  it.each(NON_STRINGS)("MCP series from=$label → isError", async ({ value }) => {
    const { isError } = await mcpCall(seriesEnv(), "jp_supply_series", { code: "7203", from: value });
    expect(isError).toBe(true);
  });

  it.each(NON_STRINGS)("MCP series to=$label → isError", async ({ value }) => {
    const { isError } = await mcpCall(seriesEnv(), "jp_supply_series", { code: "7203", to: value });
    expect(isError).toBe(true);
  });

  it.each([
    { name: "REST latest data_type", path: "/v1/supply/latest?data_type=" },
    { name: "REST series series", path: "/v1/supply/7203?series=" },
    { name: "REST series from", path: "/v1/supply/7203?from=" },
    { name: "REST series to", path: "/v1/supply/7203?to=" },
  ])('$name="" → 400 (省略扱いにしない)', async ({ path }) => {
    const res = await app.request(path, AUTH, seriesEnv());
    expect(res.status).toBe(400);
  });
});

describe("MCP 需給ツールの契約", () => {
  it("jpx_margin を enum に持ち JSF貸借とJPX信用を区別する", () => {
    const latest = TOOLS.find((t) => t.name === "jp_supply_latest");
    const series = TOOLS.find((t) => t.name === "jp_supply_series");
    for (const tool of [latest, series]) {
      const props = tool!.inputSchema.properties as Record<string, { enum?: readonly string[] }>;
      const key = tool!.name === "jp_supply_latest" ? "data_type" : "series";
      expect(props[key]!.enum).toEqual(["jsf_zandaka", "jsf_shina", "jpx_margin"]);
      expect(tool!.description).toContain("日証金");
      expect(tool!.description).toContain("JPX");
      expect(tool!.description).toContain("meta.attribution");
    }
  });

  it("enum は SUPPLY_TYPES を reuse し 3type を硬コード複製しない", async () => {
    const { SUPPLY_TYPES } = await import("../src/shared/supply");
    for (const name of ["jp_supply_latest", "jp_supply_series"] as const) {
      const tool = TOOLS.find((t) => t.name === name)!;
      const props = tool.inputSchema.properties as Record<string, { enum?: readonly string[] }>;
      const key = name === "jp_supply_latest" ? "data_type" : "series";
      expect(props[key]!.enum).toEqual([...SUPPLY_TYPES]);
    }
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/shared/mcp.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/"jsf_zandaka"/);
    expect(src).not.toMatch(/"jsf_shina"/);
    expect(src).not.toMatch(/"jpx_margin"/);
  });
});

describe("point 形状の厳密検証 (filter 有無とも error)", () => {
  // helper 内で全 point を検証するため、日付 filter で除外される前に失敗する。
  const BAD_POINTS: Array<{ shape: string; point: unknown }> = [
    { shape: "null", point: null },
    { shape: "array", point: [] },
    { shape: "{}", point: {} },
    { shape: "d:number", point: { d: 20260910 } },
    { shape: "d:boolean", point: { d: true } },
    { shape: 'd:""', point: { d: "" } },
    { shape: "d:非日付", point: { d: "09-10" } },
  ];
  const FILTERS = [
    { filter: "filter無", query: "", args: {} },
    { filter: "from有", query: "?from=2026-09-01", args: { from: "2026-09-01" } },
  ];

  it.each(
    BAD_POINTS.flatMap((p) => FILTERS.map((f) => ({ ...p, ...f }))),
  )("REST series $shape+$filter → 500", async ({ point, query }) => {
    const { status } = await restSeries(seriesPayload({ jsf_zandaka: [point] }), query);
    expect(status).toBe(500);
  });

  it("REST series 後段の不正 point も 500 (全件検証)", async () => {
    const { status } = await restSeries(
      seriesPayload({ jsf_zandaka: [...JSF_POINTS, null] }),
      "",
    );
    expect(status).toBe(500);
  });

  it.each(
    BAD_POINTS.flatMap((p) => FILTERS.map((f) => ({ ...p, ...f }))),
  )("MCP series $shape+$filter → isError", async ({ point, args }) => {
    const env = envWith({ supply: { "supply/7203.json": seriesPayload({ jsf_zandaka: [point] }) } });
    const { isError } = await mcpCall(env, "jp_supply_series", { code: "7203", ...args });
    expect(isError).toBe(true);
  });

  it("MCP series 後段の不正 point も isError (全件検証)", async () => {
    const env = envWith({
      supply: { "supply/7203.json": seriesPayload({ jsf_zandaka: [...JSF_POINTS, {}] }) },
    });
    const { isError } = await mcpCall(env, "jp_supply_series", { code: "7203" });
    expect(isError).toBe(true);
  });

  it("REST 既知の空系列 → 200 で正常 empty", async () => {
    const { status, body } = await restSeries(seriesPayload({ jsf_zandaka: [] }), "");
    expect(status).toBe(200);
    expect(body!.meta.attribution).toEqual([]);
    expect(body!.meta.licenses).toEqual(["personal-only"]);
  });

  it("MCP 既知の空系列 → 正常 empty", async () => {
    const env = envWith({ supply: { "supply/7203.json": seriesPayload({ jpx_margin: [] }) } });
    const { isError, envelope } = await mcpCall(env, "jp_supply_series", { code: "7203" });
    expect(isError).toBe(false);
    expect(envelope!.meta.attribution).toEqual([]);
  });
});

describe("filter 検証は fetch より前 (REST series)", () => {
  it("不正 filter + 欠損オブジェクト → 400 (404 に変化しない)", async () => {
    const res = await app.request("/v1/supply/7203?series=xxx", AUTH, envWith({ supply: {} }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid_series");
  });

  it("不正 filter + series 欠損 payload → 400 (500 に変化しない)", async () => {
    const { status, text } = await restSeries({ code: "7203" }, "?series=xxx");
    expect(status).toBe(400);
    expect(text).toContain("invalid_series");
  });
});
