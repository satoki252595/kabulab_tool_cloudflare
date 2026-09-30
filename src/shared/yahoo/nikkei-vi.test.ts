/**
 * fetchNikkeiVi のテスト (symbolic HTML double 使用。値は synthetic)。
 *
 * ZXD 形式・DPP:T の TZ 付き ISO8601・日付一致の strict 検証と、
 * onRaw (HTTP 判定前の原文 capture) を固定する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchNikkeiVi } from "./nikkei-vi.js";

function viHtml(ohlc: Record<string, unknown>): string {
  const state = JSON.stringify({
    symbolInfo: { quote_code: "N145/O", RESPONSE: { ohlc } },
  });
  return `<html><body><script>window.__INITIAL_STATE__=${state};</script></body></html>`;
}

const OK_OHLC = {
  DPP: "30.00",
  PRP: "29.00",
  DYWP: "1.00",
  DYRP: "3.45",
  ZXD: "2026-09-29",
  "DPP:T": "2026-09-29T15:00:00+09:00",
};

function stubFetch(status: number, body: string) {
  const bytes = new TextEncoder().encode(body);
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    clone: () => ({
      arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer,
    }),
    text: async () => body,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchNikkeiVi", () => {
  it("symbolic 正常形を parse する", async () => {
    vi.stubGlobal("fetch", stubFetch(200, viHtml(OK_OHLC)));
    const snap = await fetchNikkeiVi();
    expect(snap.date).toBe("2026-09-29");
    expect(snap.latestTimestamp).toBe("2026-09-29T15:00:00+09:00");
    expect(snap.price).toBe(30);
    expect(snap.previousClose).toBe(29);
  });

  it.each([
    ["ZXD 欠損", { ...OK_OHLC, ZXD: undefined }, /ZXD/],
    ["ZXD 形式不正", { ...OK_OHLC, ZXD: "2026/09/29" }, /ZXD/],
    ["ZXD 暦日不正 (Feb30)", { ...OK_OHLC, ZXD: "2026-02-30" }, /ZXD/],
    ["DPP:T 欠損", { ...OK_OHLC, "DPP:T": undefined }, /DPP:T/],
    ["DPP:T TZ 無し", { ...OK_OHLC, "DPP:T": "2026-09-29T15:00:00" }, /DPP:T/],
    ["DPP:T 時刻不正", { ...OK_OHLC, "DPP:T": "2026-09-29T25:00:00+09:00" }, /DPP:T/],
    ["DPP:T 日付繰り上げ (Feb30)", { ...OK_OHLC, ZXD: "2026-03-02", "DPP:T": "2026-02-30T15:00:00+09:00" }, /暦上有効/],
    ["DPP:T 日付≠ZXD", { ...OK_OHLC, "DPP:T": "2026-09-28T15:00:00+09:00" }, /一致しません/],
    ["DPP-PRP≠DYWP", { ...OK_OHLC, DYWP: "2.00" }, /一致しません/],
  ])("%s は STOP する", async (_name, ohlc, pattern) => {
    vi.stubGlobal("fetch", stubFetch(200, viHtml(ohlc as Record<string, unknown>)));
    await expect(fetchNikkeiVi()).rejects.toThrow(pattern);
  });

  it("onRaw は HTTP 判定前に status+bytes を渡す (200)", async () => {
    vi.stubGlobal("fetch", stubFetch(200, viHtml(OK_OHLC)));
    const seen: Array<{ status: number; bytes: Uint8Array }> = [];
    await fetchNikkeiVi({ onRaw: (cap) => void seen.push(cap) });
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe(200);
    expect(new TextDecoder().decode(seen[0].bytes)).toContain("__INITIAL_STATE__");
  });

  it("onRaw は非 200 でも発火してから throw する", async () => {
    vi.stubGlobal("fetch", stubFetch(503, "unavailable"));
    const seen: Array<{ status: number; bytes: Uint8Array }> = [];
    await expect(
      fetchNikkeiVi({ onRaw: (cap) => void seen.push(cap) })
    ).rejects.toThrow(/503/);
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe(503);
    expect(new TextDecoder().decode(seen[0].bytes)).toBe("unavailable");
  });
});
