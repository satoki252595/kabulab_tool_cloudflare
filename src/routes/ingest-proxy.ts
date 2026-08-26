import { Hono } from "hono";
import { verifyCronSecret } from "../shared/auth.js";
import { yahooFetchDirect } from "../shared/yahoo/client.js";

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
  const res = await yahooFetchDirect(u);
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
