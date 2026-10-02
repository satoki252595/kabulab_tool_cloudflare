/** Yahoo実原本は私有。CI不在は明示skip、金融値を失敗出力へ出さない。 */
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { parseDailyChart, type DailyResult } from "../../src/shared/yahoo/client.js";
import { assertCorporateEventsShape, corporateEventPins, currentEventRevisions, mergeCorporateEvents,
  parseCorporateEvents, priceSnapshotJson, type CorporateEvents } from "../../src/shared/yahoo/corporate-events.js";
import { yahooChartSourceUrl } from "../../src/shared/yahoo/corporate-events.js";
import { intraWindowOf, jstDateSec, zeroSplitCovered } from "../../src/shared/vwap/proof.js";
import { assertSavedDailyShape, shouldSkipPut } from "../../scripts/vwap/lib/ingest-guard.js";
import { buildRepairPost } from "../../scripts/vwap/lib/repair-daily.js";
import app from "./app.js";

const file = fileURLToPath(new URL("../../tmp/issue272-fixtures/chart-1333.T.json", import.meta.url));
const captureFile = fileURLToPath(new URL("../../tmp/issue272-fixtures/capture-1333.T.json", import.meta.url));
const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const d = existsSync(file) && existsSync(captureFile) ? describe : describe.skip;
type RawChart = { timestamp: number[]; meta: { currency?: string }; events: {
  dividends: Record<string, { date: number; amount: number }>;
  splits: Record<string, { date: number; numerator: number; denominator: number }>;
} };
async function actual(): Promise<{ fresh: DailyResult; raw: RawChart }> {
  const bytes = readFileSync(file);
  expect(sha(bytes) === "5d6109a75c8a7b8a14330914e198f8ad91303cf9b2e0eaf924da4319dc64305b").toBe(true);
  const capture = JSON.parse(readFileSync(captureFile, "utf8"));
  expect(capture.sha256 === sha(bytes) && capture.byteLength === bytes.length && capture.status === 200).toBe(true);
  const fresh = await parseDailyChart("1333.T", "10y", bytes, capture.receivedAt);
  return { fresh, raw: JSON.parse(bytes.toString()).chart.result[0] };
}
const post = (fresh: DailyResult, oldRaw = JSON.stringify({ code: "1333", bars: [], splits: [] })) => buildRepairPost({
  code: "1333", oldRaw, fresh, range: { from: fresh.bars[0].date, to: fresh.bars.at(-1)!.date },
  updatedAt: fresh.proof.observedAt,
});
const get = async (daily: unknown) => app.request("/api/daily?code=1333", {}, {
  BUCKET: { get: async () => ({ text: async () => JSON.stringify(daily) }) },
} as never);

d("Issue272 actual archived Yahoo bytes (sourceGET0)", () => {
  it("原配当/分子分母/実clock/対応priceSHAを保つ、支払日は補完しない", async () => {
    const { fresh, raw } = await actual();
    const events = fresh.corporateEvents!;
    expect(events.dividends.length === 14 && events.splits.length === 1).toBe(true);
    for (const { value } of events.dividends) {
      const original = Object.values(raw.events.dividends).find((r) => r.date === value.timestamp)!;
      expect(original !== undefined && value.amount === original.amount && value.date === jstDateSec(original.date)).toBe(true);
      expect(value.currency === raw.meta.currency && value.currencySource === "chart.result[0].meta.currency").toBe(true);
      expect(value.dateMeaning === "ex-dividend" && value.paymentDate === null && value.paymentDateStatus === "not-provided").toBe(true);
    }
    const value = events.splits[0].value, original = Object.values(raw.events.splits)[0];
    expect(value.timestamp === original.date && value.numerator === original.numerator && value.denominator === original.denominator && value.ratio === original.numerator / original.denominator).toBe(true);
    expect(events.source.bodySha256 === fresh.proof.rawSha && events.source.fetchedAt === fresh.proof.observedAt &&
      events.source.priceSnapshotSha256 === sha(priceSnapshotJson(fresh.bars))).toBe(true);
    const built = post(fresh);
    const response = await get(JSON.parse(built.postJson));
    const body = await response.json();
    expect(response.status === 200 && same(body.bars, fresh.bars) && same(body.corporateEvents, events)).toBe(true);
  });

  it("長期→イベントなし1mo→同値再入で過去履歴を失わない", async () => {
    const { fresh } = await actual();
    const initial = fresh.corporateEvents!;
    // 純粋な差分event観測の契約を検証。これは実1mo取得/価格差分適格を主張しない。
    const empty = await parseCorporateEvents({ events: undefined, currency: undefined, symbol: "1333.T", range: "1mo",
      rawSha: sha("explicit no-event boundary"), observedAt: fresh.proof.observedAt, bars: fresh.bars });
    const merged = mergeCorporateEvents(initial, empty, fresh.splits);
    expect(same(merged.dividends, initial.dividends) && same(merged.splits, initial.splits)).toBe(true);
    expect(merged.observation.dividends === "verified-none-in-response" && merged.observation.splits === "verified-none-in-response").toBe(true);
    expect(same(mergeCorporateEvents(merged, empty, fresh.splits), merged)).toBe(true);
  });

  it("訂正は同日version/hash原文根拠を追加し、旧原値と既存価格を変更しない", async () => {
    const { fresh, raw } = await actual();
    // 実原値を異なる同source内の実原値へ差し替え、訂正境界だけを検証する。
    const entries = Object.values(raw.events.dividends);
    const target = entries[0], replacement = entries.find((r) => r.amount !== target.amount)!;
    expect(replacement !== undefined).toBe(true);
    const corrected = await parseCorporateEvents({ events: { dividends: { [target.date]: { ...target, amount: replacement.amount } } },
      currency: raw.meta.currency, symbol: "1333.T", range: "1mo", rawSha: sha(JSON.stringify({ ...target, amount: replacement.amount })),
      observedAt: fresh.proof.observedAt, bars: fresh.bars });
    const merged = mergeCorporateEvents(fresh.corporateEvents!, corrected, fresh.splits);
    const revisions = merged.dividends.filter((r) => r.value.date === jstDateSec(target.date));
    expect(revisions.length === 2 && revisions[0].version === 1 && revisions[1].version === 2 &&
      revisions[0].value.amount === target.amount && revisions[1].value.amount === replacement.amount &&
      revisions[0].valueSha256 !== revisions[1].valueSha256 && revisions[1].source.bodySha256 === corrected.source.bodySha256).toBe(true);
    expect(mergeCorporateEvents(merged, corrected, fresh.splits).dividends.length === merged.dividends.length).toBe(true);
    expect(currentEventRevisions(merged.dividends).length === fresh.corporateEvents!.dividends.length).toBe(true);
    expect(corporateEventPins(merged).every((pin) => sha(pin.json) === pin.sha256)).toBe(true);
  });

  it("旧ratio-only保持/未知原値を明示し、再入でPUTを増やさない", async () => {
    const { fresh } = await actual();
    const first = post(fresh, JSON.stringify({ code: "1333", bars: fresh.bars, splits: fresh.splits }));
    const events = first.post.corporateEvents!;
    expect(same(events.legacySplits, fresh.splits)).toBe(true);
    const second = post(fresh, first.postJson);
    expect(shouldSkipPut(first.postJson, JSON.parse(second.postJson))).toBe(true);
    const nextClock = new Date(Date.parse(fresh.proof.observedAt) + 1000).toISOString();
    const later = post({ ...fresh, proof: { ...fresh.proof, observedAt: nextClock },
      corporateEvents: { ...fresh.corporateEvents!, source: { ...fresh.corporateEvents!.source, fetchedAt: nextClock } } }, first.postJson);
    expect(later.post.corporateEvents!.source.fetchedAt === nextClock &&
      same(later.post.corporateEvents!.dividends, events.dividends)).toBe(true);
    expect(() => post({ bars: fresh.bars, splits: fresh.splits, proof: fresh.proof }, first.postJson)).toThrow(/未取得/);
  });

  it("旧span前splitだけ比較除外、future/欠落/proof span外/保存窓split/rangeのHOLD維持", async () => {
    const { fresh, raw } = await actual();
    const dates = fresh.bars.map((b) => b.date);
    // 実sourceには末尾null barがある。null除去前spanの実proofを合格扱いしない。
    // 実有効日足sessionに合わせた純粋proof/window投影でsplit境界だけを検証する。
    const proof = { ...fresh.proof, firstTs: raw.timestamp.find((ts) => jstDateSec(ts) === dates[0])!,
      lastTs: [...raw.timestamp].reverse().find((ts) => jstDateSec(ts) === dates.at(-1))! };
    const lastWindow = intraWindowOf([proof.lastTs!]);
    expect(zeroSplitCovered(proof, lastWindow, dates, fresh.splits).ok).toBe(true);
    const past = { ...fresh.splits[0], date: jstDateSec(proof.firstTs! - 86400) };
    expect(zeroSplitCovered(proof, lastWindow, dates, [past, ...fresh.splits]).ok).toBe(true);
    const future = { ...fresh.splits[0], date: jstDateSec(proof.lastTs! + 86400) };
    expect(zeroSplitCovered(proof, lastWindow, dates, [...fresh.splits, future])).toEqual({ ok: false, reason: "splits-mismatch" });
    expect(zeroSplitCovered(proof, lastWindow, dates, [])).toEqual({ ok: false, reason: "splits-mismatch" });
    expect(zeroSplitCovered({ ...proof, splits: [past, ...proof.splits] }, lastWindow, dates, fresh.splits))
      .toEqual({ ok: false, reason: "splits-mismatch" });
    expect(zeroSplitCovered(proof, intraWindowOf([proof.firstTs!]), dates, fresh.splits))
      .toEqual({ ok: false, reason: "in-window-split" });
    expect(zeroSplitCovered({ ...proof, requestedRange: "1mo" }, lastWindow, dates, fresh.splits))
      .toEqual({ ok: false, reason: "range-not-10y" });
  });

  it("currency欠落≠JPY補完、不正amount/履歴/価格SHAは保存・API両境界でSTOP", async () => {
    const { fresh, raw } = await actual();
    const unknown = await parseCorporateEvents({ events: raw.events, currency: undefined, symbol: "1333.T", range: "10y",
      rawSha: fresh.proof.rawSha, observedAt: fresh.proof.observedAt, bars: fresh.bars });
    expect(unknown.dividends.every((r) => r.value.currency === null && r.value.currencySource === null)).toBe(true);
    await expect(parseCorporateEvents({ events: { dividends: { invalid: { date: null, amount: null } } }, currency: raw.meta.currency,
      symbol: "1333.T", range: "10y", rawSha: fresh.proof.rawSha, observedAt: fresh.proof.observedAt, bars: fresh.bars })).rejects.toThrow(/events/);
    const valid = JSON.parse(post(fresh).postJson);
    for (const tamper of [
      (e: CorporateEvents) => { e.dividends[0].valueSha256 = "0".repeat(64); },
      (e: CorporateEvents) => { e.source.priceSnapshotSha256 = "0".repeat(64); },
      (e: CorporateEvents) => { e.dividends[0].version = 2; },
      (e: CorporateEvents) => { e.source.fetchedAt = new Date(Date.parse(e.source.fetchedAt) + 1000).toISOString(); },
    ]) {
      const bad = structuredClone(valid); tamper(bad.corporateEvents);
      expect(() => assertSavedDailyShape(JSON.stringify(bad), "daily/1333.json", "1333")).toThrow();
      expect((await get(bad)).status).toBe(500);
    }
  });
});

describe("Issue272 未取得と不正形状 (金融値なし)", () => {
  it("実要求とsource URLは同じ組立式、query/interval注入をescapeする", () => {
    expect(yahooChartSourceUrl("^N225", "10y&unexpected=1", "1d&events=false", true))
      .toBe("https://query1.finance.yahoo.com/v8/finance/chart/%5EN225?range=10y%26unexpected%3D1&interval=1d%26events%3Dfalse&events=split,div");
  });
  it("legacy dailyは配当未取得null、未取得R2もverified-noneへ化けない", async () => {
    const legacy = await get({ code: "1333", bars: [], splits: [] });
    const body = await legacy.json();
    expect(body.corporateEventsStatus === "not-fetched" && body.dividends === null && body.corporateEvents === null).toBe(true);
    const missing = await app.request("/api/daily?code=1333", {}, { BUCKET: { get: async () => null } } as never);
    expect((await missing.json()).corporateEventsStatus).toBe("not-fetched");
  });
  it("null/未認識schemaは空の観測へfallbackせずSTOP", () => {
    for (const input of [null, [], {}, { schemaVersion: 2 }]) expect(() => assertCorporateEventsShape(input, "1333.T")).toThrow();
  });
});
