import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import app from "./app";
import { parseDailyChart } from "../../src/shared/yahoo/client.js";
import type { DailyFetchProof } from "../../src/shared/yahoo/client.js";
import { intraWindowOf, zeroSplitCovered } from "../../src/shared/vwap/proof.js";
import type { IntraWindow } from "../../src/shared/vwap/proof.js";
import { jstDateSec } from "../../src/shared/vwap/proof.js";

const FIX = join(__dirname, "tests", "fixtures");
const RD = (n: string): string => readFileSync(join(FIX, n), "utf8");
const sha = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

const SPLIT_SOURCE = "/tmp/vwap-adj-repair/acq2-8303.bin";
it.skipIf(!existsSync(SPLIT_SOURCE))("actual split after the stored-window projection but before daily anchor stays HOLD", async () => {
  const bytes = readFileSync(SPLIT_SOURCE);
  expect(sha(bytes)).toBe("aa41f1e11a50f813821a2cd2737c8569f58900af723d2f7ae1b4c7e861b12621");
  const fresh = await parseDailyChart("8303.T", "10y", bytes, "2026-09-30T13:54:52.390Z");
  const dates = fresh.bars.map((b) => b.date);
  const split = fresh.splits.find((s) => s.date > dates[0] && s.date <= dates.at(-1)!);
  expect(split).toBeDefined();
  const before = dates.filter((date) => date < split!.date).at(-1)!;
  expect(before).toBeDefined();
  const timestamps = (JSON.parse(bytes.toString("utf8")) as { chart: { result: Array<{ timestamp: number[] }> } }).chart.result[0].timestamp;
  // Project actual daily session timestamps into the qualifier's window input.
  // This is a boundary regression, not a claim of actual 5m wire adjustment.
  const projected = (date: string) => intraWindowOf([timestamps.find((ts) => jstDateSec(ts) === date)!]);
  expect(zeroSplitCovered(fresh.proof, projected(before), dates, fresh.splits))
    .toEqual({ ok: false, reason: "in-window-split" });
  expect(zeroSplitCovered(fresh.proof, projected(dates.at(-1)!), dates, fresh.splits))
    .toEqual({ ok: true });
});

// fixtures は .gitignore 対象 (原文非公開)。不在の環境 (CI) では skip。
const WANT = [
  "r2-intra-7203.json",
  "r2-intra-3600.json",
  "yahoo-5y-7203.json",
  "r2-daily-7203.json",
  "yahoo-7944-10y.json",
];
const d = WANT.every((n) => existsSync(join(FIX, n))) ? describe : describe.skip;

// 実測ピン (このバイト列から直接再計算。取得: 監査取得 /tmp/audit-b 及び
// 取得器 /tmp/vwap-adj-repair/acq-7944.bin。原文非公開、摘要のみ報告)。
const PIN = {
  intra7203: "628dfb7fef7a0b8b0dabc09a35198e43d26b2cfa6d28ea2a6f92c939972ff6d1",
  intra3600: "c369a2081a116e817b9a44bdf842609168e52a1a70ffbd61b35acc4117814466",
  yahoo5y7203: "0db61a252127532d33ae2c486836fd7e5aad5adf17c223903c9e2c36d3a0f023",
  r2daily7203: "2a727f0665ba53e78da50944e58714271f20d26e6ad7e9b296dcd5a21e0c8efc",
  yahoo10y7944: "0b35e0df364f0b0c34ebc92ff9504104e22bdad02abe97beb7bce86be0431e5d",
};
// 証明済み応答事実: 5y/7203 = 1222 応答点/全行採用、splits 1 件
// (2021-09-29, 5:1)、meta.range "5y"。10y/7944 = 2462 応答点、
// splits なし (配当のみ)、meta.range "10y"。
// R2 摘要: intra-7203 は 7871 bars/121 sessions、daily-7203 は 2529 bars。

type Bar = { date: string; o: number; h: number; l: number; c: number; v: number };
type Basis = {
  source: string; wire: string; qualified: boolean; reason: string | null;
  window: { firstTs: number; lastTs: number; bars: number } | null; sessions: string[];
};

async function load5y(): Promise<{ proof: DailyFetchProof; bars: Bar[] }> {
  const bytes = readFileSync(join(FIX, "yahoo-5y-7203.json"));
  expect(sha(bytes)).toBe(PIN.yahoo5y7203);
  // 要求 range は応答の真値 "5y" (書換えなし。meta echo 照合が通ること)。
  const { proof, bars } = await parseDailyChart("7203.T", "5y", bytes, "2026-09-29T00:00:00.000Z");
  expect(bars.length).toBe(1222);
  expect(proof.requestedRange).toBe("5y");
  expect(proof.splits).toEqual([{ date: "2021-09-29", ratio: 5 }]);
  return { proof, bars: bars as Bar[] };
}

function loadWindow7203(): IntraWindow {
  const raw = RD("r2-intra-7203.json");
  expect(sha(raw)).toBe(PIN.intra7203);
  const obj = JSON.parse(raw) as { code: string; bars: Array<{ ts: number }> };
  expect(obj.code).toBe("7203");
  const w = intraWindowOf(obj.bars.map((b) => b.ts));
  expect(w.sessions.length).toBe(121);
  return w;
}

const store = (objs: Record<string, string>) => ({
  BUCKET: {
    get: async (key: string) =>
      objs[key] === undefined ? null : { text: async () => objs[key] },
  },
});

async function getIntra(env: unknown, code: string): Promise<Response> {
  return app.fetch(new Request(`https://test/api/intra?code=${code}`), env as never, {} as never);
}

async function getDaily(env: unknown, code: string): Promise<Response> {
  return app.fetch(new Request(`https://test/api/daily?code=${code}`), env as never, {} as never);
}

d("producer proof 真正 (実 bytes)", () => {
  it("5y bytes に 10y を要求すると meta echo 不一致で throw (proof 書換え防止)", async () => {
    const bytes = readFileSync(join(FIX, "yahoo-5y-7203.json"));
    expect(sha(bytes)).toBe(PIN.yahoo5y7203);
    await expect(
      parseDailyChart("7203.T", "10y", bytes, "2026-09-29T00:00:00.000Z")
    ).rejects.toThrow(/要求 range 10y と応答 range が不一致/);
  });

  it("7944 実 10y bytes → full-10y proof positive (書換えなし)", async () => {
    const bytes = readFileSync(join(FIX, "yahoo-7944-10y.json"));
    expect(sha(bytes)).toBe(PIN.yahoo10y7944);
    // clock は保存 meta 原本の bodyCompletedAt (requestStart ではない)。
    const { proof, bars, splits } = await parseDailyChart(
      "7944.T", "10y", bytes, "2026-09-30T11:01:08.585Z"
    );
    expect(proof.observedAt).toBe("2026-09-30T11:01:08.585Z");
    expect(proof.requestedRange).toBe("10y");
    expect(proof.symbol).toBe("7944.T");
    expect(bars.length).toBeGreaterThan(2400); // 2462 応答点 (欠落行のみ除外)
    expect(splits).toEqual([]);
    expect(proof.splits).toEqual([]);
    for (const b of bars) expect("adj" in (b as object)).toBe(false); // demotion
  });
});

d("zeroSplitCovered 構造 gate (実 7203 fixtures)", () => {
  it("clean 5y は構造全 pass・range で HOLD (range 判定が最後の証拠)", async () => {
    const { proof, bars } = await load5y();
    const window = loadWindow7203();
    // range-not-10y は最後の gate。ここに届く = span/sessions/splits/window 全 pass。
    const r = zeroSplitCovered(proof, window, bars.map((b) => b.date), proof.splits);
    expect(r).toEqual({ ok: false, reason: "range-not-10y" });
  });

  it("HOLD: daily 中抜け日 (窓内 session 欠落) → sessions-uncovered", async () => {
    const { proof, bars } = await load5y();
    const window = loadWindow7203();
    const drop = window.sessions[Math.floor(window.sessions.length / 2)];
    const gapped = bars.map((b) => b.date).filter((d) => d !== drop);
    expect(gapped.length).toBe(bars.length - 1); // 欠落日は実在した
    const r = zeroSplitCovered(proof, window, gapped, proof.splits);
    expect(r).toEqual({ ok: false, reason: "sessions-uncovered" });
  });

  it("HOLD: daily.splits が proof.splits と不一致 (実 R2 値 []) → splits-mismatch", async () => {
    const { proof, bars } = await load5y();
    const window = loadWindow7203();
    const r2dailyRaw = RD("r2-daily-7203.json");
    expect(sha(r2dailyRaw)).toBe(PIN.r2daily7203);
    const r2daily = JSON.parse(r2dailyRaw) as { splits: Array<{ date: string; ratio: number }> };
    expect(r2daily.splits).toEqual([]); // 実際の R2 記録値
    const r = zeroSplitCovered(proof, window, bars.map((b) => b.date), r2daily.splits);
    expect(r).toEqual({ ok: false, reason: "splits-mismatch" });
  });

  it("HOLD: proof 終端が daily 最終と不一致 → span-mismatch", async () => {
    const { proof, bars } = await load5y();
    const window = loadWindow7203();
    const cut = { ...proof, lastTs: proof.firstTs }; // 構造変異: 終端崩壊
    const r = zeroSplitCovered(cut, window, bars.map((b) => b.date), proof.splits);
    expect(r).toEqual({ ok: false, reason: "span-mismatch" });
  });

  it("HOLD: 窓内 split (構造変異; 日付は実 session 日) → in-window-split", async () => {
    const { proof, bars } = await load5y();
    const window = loadWindow7203();
    const inWin = window.sessions[Math.floor(window.sessions.length / 2)];
    const fake = [{ date: inWin, ratio: 2 }]; // 構造変異 (日は実在、ratio は仮)
    const bad = { ...proof, splits: fake };
    // splits 一致は通す (同一仮値) → 窓交差で HOLD。
    const r = zeroSplitCovered(bad, window, bars.map((b) => b.date), fake);
    expect(r).toEqual({ ok: false, reason: "in-window-split" });
  });
});

d("/api/intra full-10y gate (実 fixtures)", () => {
  it("HOLD: 真正 5y proof は range-not-10y (bars 配信・wire unknown)", async () => {
    const { proof, bars } = await load5y();
    const intraRaw = RD("r2-intra-7203.json");
    const intraObj = JSON.parse(intraRaw) as { bars: unknown[] };
    // full-replace 書込相当の daily オブジェクト (同一 fetch 由来・5y 真正)。
    const daily = JSON.stringify({ code: "7203", bars, splits: proof.splits, proof });
    const res = await getIntra(store({ "intra/7203.json": intraRaw, "daily/7203.json": daily }), "7203");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; bars: unknown[]; basis: Basis };
    expect(body.code).toBe("7203");
    expect(body.basis.source).toBe("yahoo-5m");
    expect(body.basis.wire).toBe("unknown");
    expect(body.basis.qualified).toBe(false);
    expect(body.basis.reason).toBe("range-not-10y");
    expect(sha(JSON.stringify(body.bars))).toBe(sha(JSON.stringify(intraObj.bars)));
  });

  it("throw: daily date 重複 (構造変異) → 500", async () => {
    const { proof, bars } = await load5y();
    const intraRaw = RD("r2-intra-7203.json");
    const duped = [...bars, { ...bars[0] }]; // 構造変異: 先頭日の重複追加
    const daily = JSON.stringify({ code: "7203", bars: duped, splits: proof.splits, proof });
    const res = await getIntra(store({ "intra/7203.json": intraRaw, "daily/7203.json": daily }), "7203");
    expect(res.status).toBe(500);
  });

  it("throw: splits 日付の暦不正 (構造変異) → 500", async () => {
    const { proof, bars } = await load5y();
    const intraRaw = RD("r2-intra-7203.json");
    const badSplits = [{ date: "2026-02-30", ratio: 2 }]; // 構造変異: 存在しない日付
    const daily = JSON.stringify({ code: "7203", bars, splits: badSplits, proof });
    const res = await getIntra(store({ "intra/7203.json": intraRaw, "daily/7203.json": daily }), "7203");
    expect(res.status).toBe(500);
  });

  it("throw: cross-code proof → 500", async () => {
    const { proof, bars } = await load5y();
    const intraRaw = RD("r2-intra-7203.json");
    const cross = { ...proof, symbol: "3600.T" }; // 構造変異: 他銘柄 proof
    const daily = JSON.stringify({ code: "7203", bars, splits: proof.splits, proof: cross });
    const res = await getIntra(store({ "intra/7203.json": intraRaw, "daily/7203.json": daily }), "7203");
    expect(res.status).toBe(500);
  });

  it("HOLD: legacy daily (実 R2 抜粋、そのまま) → proof-absent", async () => {
    const r2dailyRaw = RD("r2-daily-7203.json");
    expect(sha(r2dailyRaw)).toBe(PIN.r2daily7203);
    const intraRaw = RD("r2-intra-7203.json");
    const res = await getIntra(store({ "intra/7203.json": intraRaw, "daily/7203.json": r2dailyRaw }), "7203");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bars: unknown[]; basis: Basis };
    expect(body.basis.qualified).toBe(false);
    expect(body.basis.reason).toBe("proof-absent");
  });

  it("3600: 実 intra + daily 欠 → daily-unavailable (窓は実測)", async () => {
    const intraRaw = RD("r2-intra-3600.json");
    expect(sha(intraRaw)).toBe(PIN.intra3600);
    const res = await getIntra(store({ "intra/3600.json": intraRaw }), "3600");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; bars: unknown[]; basis: Basis };
    expect(body.code).toBe("3600");
    expect(body.basis.qualified).toBe(false);
    expect(body.basis.reason).toBe("daily-unavailable");
    expect(body.basis.window).not.toBeNull();
    expect(body.basis.sessions.length).toBeGreaterThan(0);
  });

  it("400: code 欠落/不正 → bad code", async () => {
    for (const url of ["https://test/api/intra", "https://test/api/intra?code=12"]) {
      const res = await app.fetch(new Request(url), store({}) as never, {} as never);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("bad code");
    }
  });

  it("500: intra バイト破損 → 例外", async () => {
    const res = await getIntra(store({ "intra/7203.json": "{broken" }), "7203");
    expect(res.status).toBe(500);
  });

  it("intra 空 bars → intra-empty (bars 空)", async () => {
    const res = await getIntra(store({ "intra/7203.json": JSON.stringify({ code: "7203", bars: [] }) }), "7203");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bars: unknown[]; basis: Basis };
    expect(body.bars).toEqual([]);
    expect(body.basis.qualified).toBe(false);
    expect(body.basis.reason).toBe("intra-empty");
  });

  it("存在注記: fixtures は .gitignore 対象 (不在時は本ファイル全体 skip)", () => {
    for (const n of WANT) {
      expect(existsSync(join(FIX, n))).toBe(true);
    }
  });
});

d("/api/daily 構造配信 (実 fixtures)", () => {
  it("真正 5y daily は 200 配信 (range 書換えなし・qualifier のみ HOLD)", async () => {
    const { proof, bars } = await load5y();
    const daily = JSON.stringify({ code: "7203", bars, splits: proof.splits, proof });
    const res = await getDaily(store({ "daily/7203.json": daily }), "7203");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      code: string; bars: unknown[]; splits: unknown; proof: DailyFetchProof;
    };
    expect(body.code).toBe("7203");
    expect(body.bars).toHaveLength(1222);
    expect(body.splits).toEqual([{ date: "2021-09-29", ratio: 5 }]);
    expect(body.proof.requestedRange).toBe("5y"); // honest label
    expect(body.proof.symbol).toBe("7203.T");
  });

  it("legacy daily (実 R2 抜粋) は 200 配信 (proof null)", async () => {
    const r2dailyRaw = RD("r2-daily-7203.json");
    expect(sha(r2dailyRaw)).toBe(PIN.r2daily7203);
    const res = await getDaily(store({ "daily/7203.json": r2dailyRaw }), "7203");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; bars: unknown[]; proof: null };
    expect(body.code).toBe("7203");
    expect(body.bars).toHaveLength(2529);
    expect(body.proof).toBeNull();
  });

  it("throw: cross-code proof → 500 (単一 guard)", async () => {
    const { proof, bars } = await load5y();
    const cross = { ...proof, symbol: "3600.T" }; // 構造変異: 他銘柄 proof
    const daily = JSON.stringify({ code: "7203", bars, splits: proof.splits, proof: cross });
    const res = await getDaily(store({ "daily/7203.json": daily }), "7203");
    expect(res.status).toBe(500);
  });
});
