/**
 * EDINET クライアントの要求期限 (#98)。
 *
 * 2026-09-28 の定期実行は 15 件を ~20s/件で進めた後に 5 分超停滞し、
 * トリガの 600s 期限切れで失敗した (run 36465347557。9/24・9/25 も同型)。
 * Worker の TIME_BUDGET 検査は await 間でしか発火しないため、EDINET への
 * fetch 自体に期限が要る。期限切れは文脈付きで throw し (ルール2)、
 * 未完了分は次回実行の 60 日窓 + docId 冪等が拾う。
 *
 * 本テストは外部通信しない。fetch を差し替えて「応答しない EDINET」を
 * 再現し、短縮期限で打ち切られること・正常時は signal 付きで送ること・
 * 非タイムアウト失敗の形を変えないことを固定する。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  downloadDocument,
  listDocuments,
  EDINET_LIST_TIMEOUT_MS,
  EDINET_DOWNLOAD_TIMEOUT_MS,
} from "../services/edinet/client.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

function useTestKey(): void {
  vi.stubEnv("EDINET_API_KEY", "test-key");
}

/** 応答しない fetch (abort されたら signal.reason で拒否 = 実 fetch と同形)。 */
function hangUntilAbort(capture?: { signal?: AbortSignal | null }): typeof fetch {
  return (async (_url: unknown, init?: { signal?: AbortSignal | null }) => {
    if (capture && init) capture.signal = init.signal ?? null;
    await new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason ?? new Error("aborted"));
      });
    });
    throw new Error("到達不能");
  }) as unknown as typeof fetch;
}

describe("EDINET 要求期限", () => {
  it("一覧の停滞は短縮期限で打ち切り、日付入りで throw する", async () => {
    useTestKey();
    globalThis.fetch = hangUntilAbort();
    const started = Date.now();
    await expect(listDocuments("2026-09-28", { timeoutMs: 50 })).rejects.toThrow(
      /書類一覧 API タイムアウト date=2026-09-28 timeoutMs=50/
    );
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("書類取得の停滞は短縮期限で打ち切り、docID 入りで throw する", async () => {
    useTestKey();
    globalThis.fetch = hangUntilAbort();
    const started = Date.now();
    await expect(
      downloadDocument("S100J2E7", 1, { timeoutMs: 50 })
    ).rejects.toThrow(
      /書類取得 API タイムアウト docID=S100J2E7 type=1 timeoutMs=50/
    );
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("正常時は signal 付きで送り、結果をそのまま返す", async () => {
    useTestKey();
    const capture: { signal?: AbortSignal | null } = {};
    globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal | null }) => {
      if (init) capture.signal = init.signal ?? null;
      return new Response(
        JSON.stringify({
          metadata: { status: "200", message: "OK", resultset: { count: 0 } },
          results: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    const list = await listDocuments("2026-09-28");
    expect(list.results).toEqual([]);
    expect(capture.signal).toBeInstanceOf(AbortSignal);

    globalThis.fetch = (async () => {
      return new Response(Buffer.from([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }) as unknown as typeof fetch;
    const zip = await downloadDocument("S100J2E7", 1);
    expect(zip.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b]));
  });

  it("境界: header 到着後の body 停滞も期限で打ち切り docID 入りで throw する", async () => {
    useTestKey();
    // header は即応答するが arrayBuffer が signal 中断まで戻らない EDINET。
    globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal | null }) => {
      const signal = init?.signal;
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/octet-stream" },
        arrayBuffer: () =>
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              reject(signal?.reason ?? new Error("aborted"));
            });
          }),
      };
    }) as unknown as typeof fetch;
    const started = Date.now();
    await expect(
      downloadDocument("S100J2E7", 1, { timeoutMs: 50 })
    ).rejects.toThrow(/書類取得 API タイムアウト docID=S100J2E7 type=1 timeoutMs=50/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("非タイムアウトの fetch 失敗は包まず素通しする", async () => {
    useTestKey();
    const failure = new TypeError("fetch failed");
    globalThis.fetch = (async () => {
      throw failure;
    }) as unknown as typeof fetch;
    await expect(listDocuments("2026-09-28")).rejects.toBe(failure);
    await expect(downloadDocument("S100J2E7", 1)).rejects.toBe(failure);
  });

  it("既定の期限は一覧 15s・取得 60s (定数の退行防止)", () => {
    expect(EDINET_LIST_TIMEOUT_MS).toBe(15_000);
    expect(EDINET_DOWNLOAD_TIMEOUT_MS).toBe(60_000);
  });
});
