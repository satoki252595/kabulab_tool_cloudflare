import { Hono } from "hono";
import { verifyCronSecret } from "../shared/auth.js";
import { createServiceDb } from "../shared/db/client.js";
import { rootCauseMessage } from "../shared/errors.js";
import {
  aggregateMoneyflowSector,
  isoWeekToDateRange,
} from "./moneyflow-sector.js";
import {
  redactYahooDiagnostic,
  yahooFetchDirect,
} from "../shared/yahoo/client.js";

/**
 * 取込プロキシ — Node(GitHub Actions / ローカル)からの Yahoo 取得を Cloudflare
 * エッジ経由にするための認証ルート（ADR-0001・Workers Paid を使わない運用）。
 *
 * 自宅/CI の IP は Yahoo に 429 されるため、Node 側の共有 Yahoo クライアントは
 * `YAHOO_PROXY_BASE` が設定されていると Yahoo API URL をこのルートに委譲する。
 * crumb/cookie の取得・付与はエッジ側 (`yahooFetchDirect`) が行い、生レスポンスを
 * そのまま返す（パースは呼び出し側の共有クライアントが従来どおり行う）。
 *
 * root app に `app.route("/api/ingest", ingestProxyRoute)` でマウントする。
 *   GET /api/ingest/yahoo?u=<encoded Yahoo API URL>
 */
type Bindings = { DB: D1Database };

export const ingestProxyRoute = new Hono<{ Bindings: Bindings }>({
  strict: false,
});

/** SSRF/オープンプロキシ防止: Yahoo Finance API ホストのみ許可。 */
const ALLOWED_HOSTS = new Set([
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
]);

ingestProxyRoute.get("/yahoo", async (c) => {
  if (!verifyCronSecret(c.req.raw)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const u = c.req.query("u");
  if (!u) return c.json({ error: "missing u" }, 400);

  let target: URL;
  try {
    target = new URL(u);
  } catch {
    return c.json({ error: "bad url" }, 400);
  }
  if (!ALLOWED_HOSTS.has(target.hostname)) {
    return c.json({ error: `host not allowed: ${target.hostname}` }, 403);
  }

  // エッジで crumb 付き直接 fetch (この Worker は YAHOO_PROXY_BASE 未設定なので
  // プロキシループにはならない)。status ヘッダで upstream 応答と Worker 内部
  // 例外を呼び出し側が区別できるようにし、本文はバッファせず中継する。
  let res: Response;
  try {
    res = await yahooFetchDirect(u);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "yahoo_ingest_proxy_error",
        source: "ingest-proxy",
        error: redactYahooDiagnostic(rootCauseMessage(error)),
      })
    );
    return c.json({ error: "yahoo ingest proxy failed" }, 502);
  }
  const headers = new Headers({
    "X-Kabulab-Yahoo-Status": String(res.status),
  });
  const contentType = res.headers.get("Content-Type");
  if (contentType) headers.set("Content-Type", contentType);
  const contentEncoding = res.headers.get("Content-Encoding");
  if (contentEncoding) headers.set("Content-Encoding", contentEncoding);
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter) headers.set("Retry-After", retryAfter);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
});

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * moneyflow (008) の内部読取エンドポイント。既存 D1 (`swing_daily_ohlcv` ×
 * `core_stocks.sector`) を週単位 (ISO 週 `week=YYYY-Www`、または `from`/`to`
 * 直接指定) に集計した JSON を返す。`scripts/moneyflow/ingest.ts` が
 * `WORKER_BASE_URL` + `CRON_SECRET` 経由で叩く (Node から D1 バインディングへ
 * 直接アクセスできないため — ADR-0001)。
 *
 *   GET /api/ingest/moneyflow-sector?week=2026-W38
 *   GET /api/ingest/moneyflow-sector?from=2026-09-14&to=2026-09-20
 *
 * `week` と `from`/`to` の同時指定、どちらも未指定は 400 (どちらを優先するか
 * 黙って決めない — ルール2)。
 */
ingestProxyRoute.get("/moneyflow-sector", async (c) => {
  if (!verifyCronSecret(c.req.raw)) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const week = c.req.query("week");
  const fromQ = c.req.query("from");
  const toQ = c.req.query("to");

  let from: string;
  let to: string;
  if (week !== undefined) {
    if (fromQ !== undefined || toQ !== undefined) {
      return c.json({ error: "week と from/to は同時に指定できません" }, 400);
    }
    try {
      ({ from, to } = isoWeekToDateRange(week));
    } catch (error) {
      return c.json({ error: rootCauseMessage(error) }, 400);
    }
  } else if (fromQ !== undefined && toQ !== undefined) {
    if (!YMD_RE.test(fromQ) || !YMD_RE.test(toQ)) {
      return c.json({ error: "from/to は YYYY-MM-DD 形式で指定してください" }, 400);
    }
    from = fromQ;
    to = toQ;
  } else {
    return c.json({ error: "week (YYYY-Www) または from+to (YYYY-MM-DD) を指定してください" }, 400);
  }
  if (from > to) {
    return c.json({ error: `from (${from}) は to (${to}) 以前にしてください` }, 400);
  }

  try {
    const db = createServiceDb(c.env.DB, {});
    const result = await aggregateMoneyflowSector(db, { from, to });
    return c.json(result);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "moneyflow_sector_aggregate_error",
        source: "ingest-proxy",
        error: rootCauseMessage(error),
      })
    );
    return c.json({ error: "moneyflow sector aggregate failed" }, 502);
  }
});
