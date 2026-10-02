/**
 * 全 Yahoo 実通信（認証を含む）の開始間隔。待機 Promise/Response は共有しない。
 * ponytail: process/isolate 内の制御。取込全体の排他は Actions の共通 job group で行う。
 */
export const YAHOO_REQUEST_INTERVAL_MS = 1_000;
let nextStartAt = 0;

export async function fetchYahooWithSpacing(
  url: string,
  init: RequestInit,
  assertAllowed: () => void
): Promise<Response> {
  while (true) {
    const now = Date.now();
    if (now >= nextStartAt) {
      assertAllowed();
      // 許可・実開始を同じ同期ターンで行い、await 間の遅延で間隔を潰さない。
      nextStartAt = Date.now() + YAHOO_REQUEST_INTERVAL_MS;
      return fetch(url, init);
    }
    // timer が遅延してまとめて起床しても、実時計で間隔を取り直す。
    await new Promise<void>((resolve) => setTimeout(resolve, nextStartAt - now));
  }
}
