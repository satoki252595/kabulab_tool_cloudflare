import { createMiddleware } from "hono/factory";

/** レートリミットの追跡情報 */
type RateLimitEntry = {
  count: number;
  resetAt: number;
};

/** レートリミッターの設定オプション */
type RateLimiterOptions = {
  /** ウィンドウ期間（ミリ秒）。デフォルト: 60000 */
  windowMs?: number;
  /** ウィンドウ期間あたりの最大リクエスト数。デフォルト: 100 */
  maxRequests?: number;
};

/** 期限切れエントリのクリーンアップ間隔（ミリ秒） */
const CLEANUP_INTERVAL_MS = 60_000;

/**
 * シンプルなインメモリレートリミッターを生成する
 * Vercelのサーバーレス環境ではインスタンス間で共有されないため、
 * 基本的な防御としてのみ機能する
 *
 * @param options - レートリミッターの設定
 * @returns Honoミドルウェア
 */
export function createRateLimiter(options?: RateLimiterOptions) {
  const windowMs = options?.windowMs ?? 60_000;
  const maxRequests = options?.maxRequests ?? 100;

  const store = new Map<string, RateLimitEntry>();
  let lastCleanup = Date.now();

  /**
   * 期限切れエントリを削除する
   */
  function cleanup() {
    const now = Date.now();
    if (now - lastCleanup < CLEANUP_INTERVAL_MS) {
      return;
    }
    lastCleanup = now;
    for (const [key, entry] of store) {
      if (now >= entry.resetAt) {
        store.delete(key);
      }
    }
  }

  return createMiddleware(async (c, next) => {
    const clientIp = c.req.header("x-forwarded-for") ?? "unknown";
    const now = Date.now();

    cleanup();

    const entry = store.get(clientIp);

    if (!entry || now >= entry.resetAt) {
      // 新しいウィンドウを開始
      store.set(clientIp, { count: 1, resetAt: now + windowMs });
      await next();
      return;
    }

    if (entry.count >= maxRequests) {
      return c.json(
        {
          error: "Too Many Requests",
          message: "リクエスト数が制限を超えました。しばらく待ってから再試行してください。",
        },
        429,
      );
    }

    entry.count++;
    await next();
  });
}
