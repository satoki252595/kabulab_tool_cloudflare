/** 株式Actionsの明示direct。既存proxyと同じD1停止行を通し、別transportへ再送しない。 */
import { sharedEnv } from "../../src/shared/env.js";
import { assertD1SingleQueryResponse, d1HttpQueryUrl } from "../../src/shared/db/d1-http-client.js";
import { YahooRateLimitError, rateLimitRetryAt, yahooFetchDirect, type YahooTransport } from "../../src/shared/yahoo/client.js";
import { assertYahooCooldown, checkedYahooDeadline, isAllowedYahooTarget, YahooSharedCooldownError, YAHOO_COOLDOWN_SELECT, YAHOO_COOLDOWN_UPSERT } from "../../src/shared/yahoo/shared-cooldown.js";

export function createStockYahooDirectTransport(): YahooTransport {
  const url = d1HttpQueryUrl(), token = sharedEnv.CLOUDFLARE_API_TOKEN();
  async function query(sql: string, params: number[]) {
    const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(60_000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sql, params }) });
    if (!response.ok) throw new Error("Yahoo cooldown D1 request failed");
    const data: unknown = await response.json();
    const rows = assertD1SingleQueryResponse(data);
    return { rows, data: data as { result: [{ meta?: { changes?: unknown } }] } };
  }
  const persist = async (status: number, retryAt: number | null) => {
    if (status !== 429 && status !== 503) throw new Error("Yahoo cooldown status invalid");
    const result = await query(YAHOO_COOLDOWN_UPSERT, [checkedYahooDeadline(retryAt), status]);
    if (result.data.result[0].meta?.changes !== 1) throw new Error("Yahoo cooldown write not acknowledged");
  };
  const fault = () => console.error(JSON.stringify({ event: "yahoo_stock_direct_cooldown_failed",
    operation: "persist", globalCooldownGuaranteed: false }));

  return async (target, beforeRequest) => {
    const parsed = new URL(target);
    if (!isAllowedYahooTarget(parsed, decodeURIComponent(parsed.pathname))) throw new Error("Yahoo direct target is not allowed");
    beforeRequest?.();
    let cooldown;
    try {
      const { rows } = await query(YAHOO_COOLDOWN_SELECT, []);
      if (rows.length !== 1) throw new Error("Yahoo cooldown row missing");
      assertYahooCooldown(rows[0]);
      cooldown = rows[0];
    } catch {
      beforeRequest?.(); // 実source/停止時計に達した例外をDB不明へ塗り替えない。
      throw new YahooSharedCooldownError();
    }
    beforeRequest?.(); // D1待機後にsource期限を再確認する。
    if (Date.now() < cooldown.retry_at_ms) {
      if (cooldown.upstream_status === null) throw new YahooSharedCooldownError();
      return new Response(JSON.stringify({ error: "yahoo shared cooldown active; no upstream request" }), {
        status: cooldown.upstream_status, headers: {
          "Retry-After": String(Math.max(0, Math.ceil((cooldown.retry_at_ms - Date.now()) / 1000))),
          "X-Kabulab-Yahoo-Cooldown": "active", "X-Kabulab-Yahoo-Stage": "shared-cooldown",
        } });
    }
    let response: Response;
    try { response = await yahooFetchDirect(target, beforeRequest); }
    catch (error) {
      if (error instanceof YahooRateLimitError) {
        try {
          if (error.retryAtMs === null && error.retryAfterMs !== null && (!Number.isFinite(error.retryAfterMs) || error.retryAfterMs < 0)) throw new Error("invalid retry delay", { cause: error });
          await persist(error.status, error.retryAtMs !== null ? error.retryAtMs : rateLimitRetryAt(new Response(null, {
            status: error.status, headers: error.retryAfterMs === null ? {} : { "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)) },
          })));
        } catch { fault(); }
      }
      throw error;
    }
    let persistenceFailed = false;
    if (response.status === 429 || response.status === 503) {
      try { await persist(response.status, rateLimitRetryAt(response)); }
      catch { persistenceFailed = true; fault(); }
    }
    // 制限原文をcapture前に失わない。Cookie等はconsumerへ渡さず、実URLは元のまま保持。
    const headers = new Headers({ "X-Kabulab-Yahoo-Status": String(response.status),
      "X-Kabulab-Yahoo-Stage": new URL(target).pathname.startsWith("/v8/") ? "chart" : "quote-summary" });
    for (const name of ["Content-Type", "Retry-After", "Age", "CF-Cache-Status", "CF-Ray"]) {
      const value = response.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    if (persistenceFailed) headers.set("X-Kabulab-Yahoo-Cooldown", "persist-failed");
    const relayed = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    Object.defineProperty(relayed, "url", { value: response.url });
    return relayed;
  };
}
