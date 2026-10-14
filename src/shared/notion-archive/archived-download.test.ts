import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadArchivedFile } from "./archived-download.js";

const file = { name: "bounded-source.zip", url: "https://file.notion.so/bounded-source.zip" };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("保存Notion原本のbounded download", () => {
  it("Content-Length欠測でもstreamを上限内で読み、宣言サイズのある完全bodyも同値", async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(bytes))
      .mockResolvedValueOnce(new Response(bytes, { headers: { "Content-Length": "3" } }));
    expect(await downloadArchivedFile(file, "bounded", { maxBytes: 3 })).toEqual(bytes);
    expect(await downloadArchivedFile(file, "bounded", { maxBytes: 3 })).toEqual(bytes);
    expect(fetch).toHaveBeenCalledWith(file.url, { redirect: "error", signal: expect.any(AbortSignal) });
  });
  it.each(["4", "invalid"])("過大/不正Content-Length=%sはbodyを読み始めずcancelする", async length => {
    const response = new Response(Uint8Array.from([1]), { headers: { "Content-Length": length } });
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    await expect(downloadArchivedFile(file, "bounded", { maxBytes: 3 })).rejects.toThrow("サイズ");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("Content-Length欠測の途中超過でもstreamをcancelし、partialは返さない", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(Uint8Array.from([1, 2])); controller.enqueue(Uint8Array.from([3, 4]));
    }, cancel });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream));
    await expect(downloadArchivedFile(file, "bounded", { maxBytes: 3 })).rejects.toThrow("予算超過");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("宣言より短い/長いbodyと途中通信失敗を完全原本へ見せない", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(Uint8Array.from([1]), { headers: { "Content-Length": "2" } }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2]), { headers: { "Content-Length": "1" } }))
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new Error("BODY_UNKNOWN")); } })));
    await expect(downloadArchivedFile(file, "bounded", { maxBytes: 3 })).rejects.toThrow("実バイト長");
    await expect(downloadArchivedFile(file, "bounded", { maxBytes: 3 })).rejects.toThrow("実バイト長");
    await expect(downloadArchivedFile(file, "bounded", { maxBytes: 3 })).rejects.toThrow("BODY_UNKNOWN");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("HTTP gzipのwire長をデコード済body長と比較せず、実body上限は守る", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3]), {
      headers: { "Content-Length": "23", "Content-Encoding": "gzip" },
    })).mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3, 4]), {
      headers: { "Content-Length": "24", "Content-Encoding": "gzip" },
    }));
    expect(await downloadArchivedFile(file, "bounded", { maxBytes: 3 })).toEqual(Uint8Array.from([1, 2, 3]));
    await expect(downloadArchivedFile(file, "bounded", { maxBytes: 3 })).rejects.toThrow("予算超過");
  });
  it("外部origin/credentials/不正予算は通信前STOP", async () => {
    vi.spyOn(globalThis, "fetch");
    for (const url of ["https://untrusted.invalid/source", "http://file.notion.so/source", "https://user@file.notion.so/source"]) {
      await expect(downloadArchivedFile({ ...file, url }, "bounded", { maxBytes: 3 })).rejects.toThrow("URL資格");
    }
    await expect(downloadArchivedFile(file, "bounded", { maxBytes: -1 })).rejects.toThrow("予算");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("保存Aの例外型/本文に明示transport codeを注入し、同じGETの有限再読取を計数する", async () => {
    // 原STOPは型/本文だけ保存。UND_ERR_SOCKETはこの非通信faultで明示注入し、実観測と混同しない。
    const error = new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" }) });
    const events: unknown[] = [];
    const get = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(error).mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3])));
    await expect(downloadArchivedFile(file, "saved-A", { maxBytes: 3, onAttempt: event => events.push(event) })).resolves.toEqual(Uint8Array.from([1, 2, 3]));
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls.map(args => args[0])).toEqual([file.url, file.url]);
    expect(events).toEqual([{ attempt: 1, phase: "start", receivedBytes: 0 }, { attempt: 1, phase: "transport-error", receivedBytes: 0 },
      { attempt: 2, phase: "start", receivedBytes: 0 }, { attempt: 2, phase: "complete", receivedBytes: 3, status: 200 }]);
  });

  it("部分bodyのnative切断後もpartialは返さず、全体が読めた同URLのbytesだけ返す", async () => {
    let reads = 0; const events: Array<{ receivedBytes: number; phase: string }> = [];
    const partial = new ReadableStream<Uint8Array>({ pull(controller) {
      if (reads++ === 0) controller.enqueue(Uint8Array.from([9])); else controller.error(new TypeError("terminated"));
    } });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(partial)).mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3])));
    expect(await downloadArchivedFile(file, "partial", { maxBytes: 3, onAttempt: event => events.push(event) })).toEqual(Uint8Array.from([1, 2, 3]));
    expect(events.find(event => event.phase === "transport-error")?.receivedBytes).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([400, 403, 404, 429, 500, 503])("HTTP %iは同じGETも再送しない", async status => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("rejected", { status }));
    await expect(downloadArchivedFile(file, "http", { maxBytes: 10 })).rejects.toThrow(`status=${status}`);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["NotionConfigError", "NotionUnknownResultError", "AssertionError", "Error"])("guard/unknown marker %sはtransport扱いしない", async name => {
    const error = Object.assign(new Error("fetch failed"), { name });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
    await expect(downloadArchivedFile(file, "guard", { maxBytes: 3 })).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("native切断は2GETで終え、未知cause付きfetch failedは最初でSTOPする", async () => {
    const get = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(downloadArchivedFile(file, "finite", { maxBytes: 3 })).rejects.toThrow("fetch failed");
    expect(get).toHaveBeenCalledTimes(2);
    get.mockClear();
    const guarded = new TypeError("fetch failed", { cause: Object.assign(new Error("unknown acknowledgement"), { name: "NotionUnknownResultError", code: "UND_ERR_SOCKET" }) });
    get.mockRejectedValue(guarded);
    await expect(downloadArchivedFile(file, "unknown", { maxBytes: 3 })).rejects.toBe(guarded);
    expect(get).toHaveBeenCalledOnce();
  });

  it("complete observerが止めても取得やmutationを再送しない", async () => {
    const error = new TypeError("fetch failed");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(Uint8Array.from([1])));
    await expect(downloadArchivedFile(file, "observer", { maxBytes: 1, onAttempt: event => { if (event.phase === "complete") throw error; } })).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["start", "complete", "transport-error", "unknown"])("async observerの%s拒否をnative transport再試行へ変えない", async phase => {
    const error = phase === "unknown" ? new TypeError("fetch failed", { cause: Object.assign(new Error("unknown acknowledgement"), { name: "NotionUnknownResultError", code: "UND_ERR_SOCKET" }) }) : new TypeError("fetch failed");
    const get = vi.spyOn(globalThis, "fetch");
    if (phase === "transport-error") get.mockRejectedValue(new TypeError("terminated"));
    else get.mockResolvedValue(new Response(Uint8Array.from([1])));
    await expect(downloadArchivedFile(file, "async-observer", { maxBytes: 1, onAttempt: async event => {
      await Promise.resolve(); if (event.phase === (phase === "unknown" ? "complete" : phase)) throw error;
    } })).rejects.toBe(error);
    expect(get).toHaveBeenCalledTimes(phase === "start" ? 0 : 1);
  });
  it("async start待機中の親abortは最初のnative GETも開始しない", async () => {
    const controller = new AbortController(), reason = new Error("parent deadline");
    const get = vi.spyOn(globalThis, "fetch");
    await expect(downloadArchivedFile(file, "async-abort", { maxBytes: 1, signal: controller.signal, onAttempt: async event => {
      if (event.phase === "start") { await Promise.resolve(); controller.abort(reason); }
    } })).rejects.toBe(reason);
    expect(get).not.toHaveBeenCalled();
  });
  it("0byteは明示maxBytes=0で実空bodyを照合し、未知サイズの既存空bodyも保持する", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { headers: { "Content-Length": "0" } })).mockResolvedValueOnce(new Response(null));
    expect((await downloadArchivedFile(file, "zero", { maxBytes: 0 })).length).toBe(0);
    expect((await downloadArchivedFile(file, "legacy-unknown")).length).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("親の期限は開始前もbody待ちも優先し、45秒の再試行を始めない", async () => {
    const controller = new AbortController(); const reason = new Error("parent deadline"); controller.abort(reason);
    const get = vi.spyOn(globalThis, "fetch");
    await expect(downloadArchivedFile(file, "parent", { maxBytes: 3, signal: controller.signal })).rejects.toBe(reason);
    expect(get).not.toHaveBeenCalled();
    const active = new AbortController();
    get.mockImplementation(async (_input, init) => new Response(new ReadableStream({ start(stream) {
      init!.signal!.addEventListener("abort", () => stream.error(init!.signal!.reason));
    } })));
    const pending = downloadArchivedFile(file, "parent-body", { maxBytes: 3, signal: active.signal });
    const check = expect(pending).rejects.toBe(reason);
    await Promise.resolve(); active.abort(reason); await check;
    expect(get).toHaveBeenCalledOnce();
  });

  it("保存V6と同じ200/body0待ちは各45秒で中断し、全体90秒で2GETを終える", async () => {
    const realTimeout = AbortSignal.timeout;
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("bounded timeout", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => new Response(new ReadableStream({ start(stream) {
      init!.signal!.addEventListener("abort", () => stream.error(init!.signal!.reason));
    } })));
    const pending = downloadArchivedFile(file, "saved-V6", { maxBytes: 33775 });
    const check = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(45_000); expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(45_000); await check; expect(fetch).toHaveBeenCalledTimes(2);
    expect(realTimeout).toBeTypeOf("function");
  });
});
