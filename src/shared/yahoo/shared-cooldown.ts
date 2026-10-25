/** Proxyと明示Node directが共有する単一行。欠損時のseed・期限の短縮はしない。 */
export type YahooCooldown = { retry_at_ms: number; upstream_status: 429 | 503 | null };
export const YAHOO_COOLDOWN_SELECT = "SELECT retry_at_ms,upstream_status FROM yahoo_proxy_cooldown WHERE id=1";
export const YAHOO_COOLDOWN_UPSERT = `INSERT INTO yahoo_proxy_cooldown (id,retry_at_ms,upstream_status)
    SELECT 1,?,? WHERE EXISTS (SELECT 1 FROM yahoo_proxy_cooldown WHERE id=1)
    ON CONFLICT(id) DO UPDATE SET
    upstream_status=CASE WHEN excluded.retry_at_ms>yahoo_proxy_cooldown.retry_at_ms THEN excluded.upstream_status ELSE yahoo_proxy_cooldown.upstream_status END,
    retry_at_ms=MAX(yahoo_proxy_cooldown.retry_at_ms,excluded.retry_at_ms)`;

/** Proxyと明示directの対象は同じ公開APIだけ。認証値付きURLや別originを受けない。 */
export function isAllowedYahooTarget(target: URL, decodedPath: string): boolean {
  return target.protocol === "https:" && target.port === "" && !target.username && !target.password &&
    (target.hostname === "query1.finance.yahoo.com" || target.hostname === "query2.finance.yahoo.com") &&
    /^\/v(?:8\/finance\/chart|10\/finance\/quoteSummary)\/[A-Za-z0-9.^=+-]+$/.test(decodedPath) && !target.searchParams.has("crumb");
}

export function assertYahooCooldown(value: unknown): asserts value is YahooCooldown {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("retry_at_ms" in value) || !("upstream_status" in value) ||
      !Number.isSafeInteger(value.retry_at_ms) || typeof value.retry_at_ms !== "number" || value.retry_at_ms < 0 ||
      (value.retry_at_ms === 0 ? value.upstream_status !== null : value.upstream_status !== 429 && value.upstream_status !== 503)) {
    throw new Error("Yahoo shared cooldown row is missing or invalid");
  }
}

export function checkedYahooDeadline(value: number | null): number {
  if (value === null || !Number.isSafeInteger(value) || value <= 0) throw new Error("Yahoo cooldown deadline is invalid");
  return value;
}

/** DB例外・SQL・URLを原因chainへ持ち込まず、銘柄間の新規取得も止める。 */
export class YahooSharedCooldownError extends Error {
  constructor() {
    super("Yahoo共有停止状態を確認できないため新規取得を停止します（再送なし）");
    this.name = "YahooSharedCooldownError";
  }
}
