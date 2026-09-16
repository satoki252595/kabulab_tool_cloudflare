/**
 * 日足 OHLCV の edge キャッシュ（Cache API）。
 *
 * REST (`GET /v1/ohlcv/:code`) と MCP (`jp_ohlcv_range`) の両方が
 * `fetchAdjustedOhlcv` を直接叩くので、HTTP 層ではなくデータ層で束ねる。
 * どちらから呼ばれても同一キーで当たり、kabuMCP の反復照会は
 * 1 銘柄 1 範囲あたり 1 回の D1 読みに潰れる。
 *
 * 前提と設計:
 * - 原本 (`swing_daily_ohlcv`) の更新は 1 日 1 回以下（stock-sync 21:00 UTC、
 *   vwap 取込は月水金）。TTL 6h で陳腐化の上限を抑える。
 * - TTL は自前で判定する（`X-Cached-At` 相当の `cachedAt` を値に埋める）。
 *   Cache API 自体の expire 挙動に依存しないため、テストで時刻を刺せる。
 * - 404（未知コード）は束ねない。銘柄の新規上場で 404→200 に変わるうえ、
 *   1 行 lookup は安いので、束ねる利得より stale-404 の害が大きい。
 * - キャッシュの読み書き失敗は無視して D1 に素通しする。最適化層が
 *   配信を壊してはならない（フォールバックではなく主経路への復帰）。
 * - `cache.put` は `waitUntil` に逃がさず await する。MCP 経路
 *   (`handleMcp`) には executionCtx が届かないため、両経路で挙動を
 *   揃えるほうを取る。put は D1 往復比で無視できる。
 *
 * 認証との関係: 呼び出しは全て認証ミドルウェアの後（`private.ts`）なので、
 * ここに届く時点で鍵は検証済み。鍵は単一テナントの私物で、呼び手ごとに
 * 変わる値を含まないため、認可済み呼び手間での共有は安全。
 */

import {
  fetchAdjustedOhlcv,
  type AdjustedBar,
  type OhlcvRange,
} from "./ohlcv";

/** キャッシュの有効期間（秒）。原本の更新頻度（1日1回以下）に対する上限。 */
export const OHLCV_CACHE_TTL_SECS = 6 * 3600;

const CACHE_KEY_BASE = "https://ohlcv-cache.internal/v1/ohlcv/";

export interface CachedOhlcvResult {
  code: string;
  bars: AdjustedBar[];
}

interface CacheEntry {
  cachedAt: number;
  payload: CachedOhlcvResult;
}

/** 正規化したキャッシュキー。from/to の有無・limit の違いは別エントリ。 */
export function ohlcvCacheKey(code: string, range: OhlcvRange): string {
  const params = new URLSearchParams();
  if (range.from) params.set("from", range.from);
  if (range.to) params.set("to", range.to);
  params.set("limit", String(range.limit));
  const query = params.toString();
  return `${CACHE_KEY_BASE}${code}${query ? `?${query}` : ""}`;
}

function cacheStore(): Cache | undefined {
  try {
    if (typeof caches === "undefined") return undefined;
    return caches.default;
  } catch {
    return undefined;
  }
}

/**
 * キャッシュ付きで調整済み日足を返す。`hit` は束ねが効いたかどうか。
 * `nowSec` はテスト用の注入時刻（本番は現在時刻）。
 */
export async function fetchAdjustedOhlcvCached(
  db: D1Database,
  code: string,
  range: OhlcvRange,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<{ result: CachedOhlcvResult | null; hit: boolean }> {
  const cache = cacheStore();
  if (!cache) {
    return { result: await fetchAdjustedOhlcv(db, code, range), hit: false };
  }
  const key = new Request(ohlcvCacheKey(code, range));
  try {
    const stored = await cache.match(key);
    if (stored) {
      const entry = (await stored.json()) as Partial<CacheEntry>;
      if (
        typeof entry.cachedAt === "number" &&
        Number.isFinite(entry.cachedAt) &&
        entry.payload &&
        nowSec - entry.cachedAt < OHLCV_CACHE_TTL_SECS
      ) {
        return { result: entry.payload, hit: true };
      }
    }
  } catch {
    // 読み失敗は無視して D1 に素通しする。
  }
  const result = await fetchAdjustedOhlcv(db, code, range);
  if (result) {
    try {
      const entry: CacheEntry = { cachedAt: nowSec, payload: result };
      await cache.put(
        key,
        new Response(JSON.stringify(entry), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    } catch {
      // 書き失敗は無視する（次回も D1 に素通しするだけ）。
    }
  }
  return { result, hit: false };
}
