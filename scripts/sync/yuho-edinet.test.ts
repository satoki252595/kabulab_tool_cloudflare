/**
 * scripts/sync/yuho-edinet.ts (EDINET catchup トリガ) の再試行テスト。
 *
 * #98: catchup ジョブが Worker への 1 発の fetch だけで、一過性の切断で
 * ジョブ全体を赤にしていた。実失敗は以下 2 種 (いずれも fetch 自体の throw):
 *   - run36022119851: HeadersTimeoutError (応答遅延。~302 秒後に発火)
 *   - run36156111106: read ECONNRESET (一過性切断。~249 秒後に発火)
 * いずれも catchup の冪等性 (docId/Notion 冪等・再開可能) により切り直しで
 * 復旧できるため、fetch の throw に限り限定回数だけ再試行する。
 * HTTP 応答が返った場合・上限到達時は従来どおり throw (成功化しない)。
 */
import { describe, expect, it, vi } from "vitest";
import { postCatchup } from "./yuho-edinet.js";

const CATCHUP_URL = new URL("https://worker.example.test/yuho-quant/admin/catchup");
const SECRET = "test-secret";

/** run36156111106 の `fetch failed` + `read ECONNRESET` を再現する。 */
function econnreset(): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });
}

/** run36022119851 の `fetch failed` + `HeadersTimeoutError` を再現する。 */
function headersTimeout(): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("Headers Timeout Error"), {
      name: "HeadersTimeoutError",
    }),
  });
}

function scriptedFetch(script: Array<Response | Error>) {
  const fetchFn = vi.fn(async () => {
    const next = script.shift();
    if (next === undefined) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    return next;
  });
  return fetchFn as unknown as typeof fetch;
}

function recordingSleep() {
  const slept: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    slept.push(ms);
  };
  return { slept, sleep };
}

describe("postCatchup (#98)", () => {
  it("初回成功なら 1 回だけ叩く (従来どおり)", async () => {
    const fetchFn = scriptedFetch([new Response("done", { status: 200 })]);
    const { slept, sleep } = recordingSleep();
    await expect(postCatchup(CATCHUP_URL, SECRET, { fetchFn, sleep })).resolves.toBe(
      "done"
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it("ECONNRESET が続いても 3 回目で成功すれば本文を返す", async () => {
    const fetchFn = scriptedFetch([
      econnreset(),
      econnreset(),
      new Response("done", { status: 200 }),
    ]);
    const { slept, sleep } = recordingSleep();
    await expect(postCatchup(CATCHUP_URL, SECRET, { fetchFn, sleep })).resolves.toBe(
      "done"
    );
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([10_000, 30_000]);
  });

  it("HeadersTimeoutError の後も切り直して成功すれば本文を返す", async () => {
    const fetchFn = scriptedFetch([
      headersTimeout(),
      new Response("done", { status: 200 }),
    ]);
    const { slept, sleep } = recordingSleep();
    await expect(postCatchup(CATCHUP_URL, SECRET, { fetchFn, sleep })).resolves.toBe(
      "done"
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([10_000]);
  });

  it("上限まで失敗したら throw する (成功化しない・試行回数と元エラーを残す)", async () => {
    const fetchFn = scriptedFetch([econnreset(), econnreset(), econnreset()]);
    const { slept, sleep } = recordingSleep();
    const err = (await postCatchup(CATCHUP_URL, SECRET, { fetchFn, sleep }).catch(
      (e: unknown) => e
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/3 回試行後も失敗/);
    expect(err.message).toContain("fetch failed");
    expect(err.cause).toBeInstanceOf(TypeError);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([10_000, 30_000]);
  });

  it("HTTP 500 は再試行せず即 throw する (従来どおり・マスクしない)", async () => {
    const fetchFn = scriptedFetch([new Response("boom", { status: 500 })]);
    const { slept, sleep } = recordingSleep();
    await expect(postCatchup(CATCHUP_URL, SECRET, { fetchFn, sleep })).rejects.toThrow(
      /catchup 失敗: HTTP 500 boom/
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it("エラー文に URL・認証情報を含めない", async () => {
    const fetchFn = scriptedFetch([econnreset(), econnreset(), econnreset()]);
    const { sleep } = recordingSleep();
    const err = (await postCatchup(CATCHUP_URL, SECRET, { fetchFn, sleep }).catch(
      (e: unknown) => e
    )) as Error;
    expect(err.message).not.toContain("worker.example.test");
    expect(err.message).not.toContain(SECRET);
  });
});
