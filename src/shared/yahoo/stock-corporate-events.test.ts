import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { buildStockCorporateDiagnostics, extractStockCorporateEvents } from "./stock-corporate-events.js";
import { parseChartResponse } from "./client.js";
import { buildPriceSyncBatch } from "../../cron/daily.js";

const bytes = readFileSync(new URL("./fixtures/stock-corporate-events-20261014.json.gz", import.meta.url));
const fixture = JSON.parse(gunzipSync(bytes).toString()) as Record<string, { json: unknown; receivedAt: string }>;
const proof = JSON.parse(readFileSync(new URL("./fixtures/stock-corporate-events-20261014.provenance.json", import.meta.url), "utf8")) as {
  gzipSha256: string; members: { code: string; projectionSha256: string }[];
};
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const chart = (json: unknown) => (json as { chart: { result: { events?: unknown }[] } }).chart.result[0];
function diagnostic(code: string) {
  const { json, receivedAt } = fixture[code], bars = parseChartResponse(json, code).bars;
  return buildStockCorporateDiagnostics({ events: extractStockCorporateEvents(json, receivedAt),
    code, bodySha256: sha(JSON.stringify(json)), receivedAt, suppliedBars: bars, qualifiedBars: bars });
}

describe("株式報告権利と実使用窓 (保存実原本projection・価格補正なし)", () => {
  it("原SHAを検証し、実分割/併合のdictionary/epoch/ratioを取り出す", () => {
    expect(sha(bytes)).toBe(proof.gzipSha256);
    for (const member of proof.members) expect(sha(JSON.stringify(fixture[member.code].json))).toBe(member.projectionSha256);
    const split = extractStockCorporateEvents(fixture["4374"].json, fixture["4374"].receivedAt).reported
      .find(e => e.kind === "splits" && e.date === "2026-09-29");
    expect(split).toMatchObject({ kind: "splits", numerator: 2, denominator: 1, ratio: 2, splitRatio: "2:1" });
    expect(split!.dictionaryKey).toBe(String(split!.epoch));
    expect(extractStockCorporateEvents(fixture["9252"].json, fixture["9252"].receivedAt).reported)
      .toContainEqual(expect.objectContaining({ kind: "splits", date: "2025-08-07", numerator: 1, denominator: 1.2, ratio: 1 / 1.2 }));
  });

  it("ATR130/volume21/range20/last2/adj90は同一資格列へ結び、分割を二重適用しない", () => {
    const before = structuredClone(fixture), d = diagnostic("4374");
    expect(Object.fromEntries(Object.entries(d.windows).map(([k, v]) => [k, v.rows])))
      .toEqual({ atr130: 130, volume21: 21, range20: 20, close2: 2, adjustedMomentum90: 90 });
    for (const key of ["atr130", "volume21", "range20", "adjustedMomentum90"] as const) {
      expect(d.windows[key].reportedEventReferences.some(r => r.includes(".splits."))).toBe(true);
    }
    expect(d.windows.close2.reportedEventReferences.some(r => r.includes(".splits."))).toBe(false);
    expect(d.basis).toEqual({ ohlc: "unknown", volume: "unknown", dividendShareBasis: "unknown", localAdjustment: "none" });
    expect(fixture).toEqual(before);
  });

  it("実7203の配当とclose/adj差は診断だけを残し、HOLD/代用値へ変換しない", () => {
    const bars = parseChartResponse(fixture["7203"].json, "7203").bars;
    expect(bars.some(b => b.adj !== b.close)).toBe(true);
    const events = extractStockCorporateEvents(fixture["7203"].json, fixture["7203"].receivedAt);
    expect(events.reported).toContainEqual(expect.objectContaining({ kind: "dividends", date: "2026-09-29", amount: 50 }));
    expect(diagnostic("7203").unknownReasons).toContain("rights-issues-capital-increases-and-other-legal-actions-not-covered");
  });

  it("省略/null/空/観測とcapitalGains未要求を区別し、全権利なしとは言わない", () => {
    for (const [value, expected] of [[undefined, "absent"], [null, "null"], [{}, "empty"], [{ splits: {} }, "observed"]] as const) {
      const input = structuredClone(fixture["4374"].json);
      if (value === undefined) delete chart(input).events;
      else chart(input).events = value;
      const events = extractStockCorporateEvents(input, fixture["4374"].receivedAt);
      expect(events.observation.events).toBe(expected);
      expect(events.observation.splits).toBe(value === undefined ? "events-absent" : value === null ? "events-null" : "splits" in value ? "empty" : "absent");
    }
    expect(diagnostic("4374").unknownReasons).toContain("capitalGains-not-requested");
  });

  it("構造異常/未来/ratio不整合/未知kindをSTOPし、任意のイベントなしへ落とさない", () => {
    const source = fixture["4374"], extracted = extractStockCorporateEvents(source.json, source.receivedAt);
    const event = extracted.reported.find(e => e.kind === "splits")!;
    const raw = (chart(source.json).events as Record<string, Record<string, unknown>>).splits[event.dictionaryKey];
    for (const events of [[], { other: {} }, { splits: [] }, { splits: { wrongKey: raw } },
      { splits: { [event.dictionaryKey]: { ...(raw as object), denominator: 0 } } },
      { splits: { [event.dictionaryKey]: { ...(raw as object), splitRatio: "1:1" } } },
      { dividends: { [event.dictionaryKey]: { date: event.epoch, amount: -1 } } }]) {
      const json = structuredClone(source.json); chart(json).events = events;
      expect(() => extractStockCorporateEvents(json, source.receivedAt)).toThrow(/STOP/);
    }
    expect(() => extractStockCorporateEvents(source.json, "invalid")).toThrow(/STOP/);
    expect(() => extractStockCorporateEvents(source.json, "2000-01-01T00:00:00.000Z")).toThrow(/STOP/);
    for (const mutate of [
      (r: Record<string, unknown>) => { const ts = r.timestamp as number[]; ts[1] = ts[0]; },
      (r: Record<string, unknown>) => { const ts = r.timestamp as number[]; ts.reverse(); },
      (r: Record<string, unknown>) => { (r.meta as Record<string, unknown>).range = "1mo"; },
      (r: Record<string, unknown>) => { const q = (r.indicators as { quote: { close: number[] }[] }).quote[0]; q.close.pop(); },
    ]) {
      const input = structuredClone(source.json); mutate(chart(input) as Record<string, unknown>);
      expect(() => extractStockCorporateEvents(input, source.receivedAt)).toThrow(/STOP/);
    }
  });

  it("短い系列/欠測を窓情報に残し、同じ必須batch物理ファイルへ原本参照を記録する", () => {
    const source = fixture["4374"], bars = parseChartResponse(source.json, "4374").bars.slice(-2);
    bars[0] = { ...bars[0], volume: null, high: null, adj: null };
    const d = buildStockCorporateDiagnostics({ events: extractStockCorporateEvents(source.json, source.receivedAt),
      code: "4374", bodySha256: sha(JSON.stringify(source.json)), receivedAt: source.receivedAt, suppliedBars: bars, qualifiedBars: bars });
    expect(d.windows.atr130).toMatchObject({ rows: 1, completeRequestedWindow: false });
    expect(d.windows.volume21).toMatchObject({ rows: 2, missingValues: { volume: 1 }, completeRequestedWindow: false });
    expect(d.windows.adjustedMomentum90.missingValues.adj).toBe(1);
    const entries = [{ code: "4374", attempt: 0, expectedDate: "2026-10-14", diagnostic: d }];
    const batch = buildPriceSyncBatch({ mode: "stocks", runId: "38539360030.1", startedAt: source.receivedAt,
      finishedAt: source.receivedAt, tradingDate: "2026-10-14", totalStocks: 1, successStocks: 1, failedStocks: 0,
      failures: [], failureCollection: "complete", originalError: null, corporateDiagnostics: entries });
    expect(JSON.parse(new TextDecoder().decode(batch.file.bytes)).corporateDiagnostics).toEqual(entries);
    expect(JSON.stringify(d)).not.toContain('"numerator"'); // 原値の再コピーではなくraw内参照
  });

  it("正常な原本では計測行を出さない", () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((part) => String(part)).join(" "));
    });
    try {
      const source = fixture["4374"];
      const events = extractStockCorporateEvents(source.json, source.receivedAt);
      const bars = parseChartResponse(source.json, "4374").bars;
      buildStockCorporateDiagnostics({
        events, code: "4374", bodySha256: sha(JSON.stringify(source.json)), receivedAt: source.receivedAt,
        suppliedBars: bars, qualifiedBars: bars,
      });
    } finally {
      spy.mockRestore();
    }
    expect(lines.filter((line) => line.includes("INC-20261014"))).toEqual([]);
  });

  it("計測出力が失敗しても STOP の Error と文言は変わらない", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("log failed");
    });
    let caught: unknown;
    try {
      extractStockCorporateEvents(null, fixture["4374"].receivedAt);
    } catch (error) {
      caught = error;
    } finally {
      spy.mockRestore();
    }
    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) throw new Error("STOP 以外の結果です");
    expect(caught.constructor).toBe(Error);
    expect(caught.message).toBe("株式Chartの報告権利イベント/原本時計/窓構造が不正です。STOP");
  });

  it("STOP の検査名と件数だけを出し、時刻・価格・receivedAt・本文は出さない", () => {
    const INCIDENT = "[INC-20261014-kabulab_tool_cloudflare-stock-sync-null-bars]";
    const STOP_MESSAGE = "株式Chartの報告権利イベント/原本時計/窓構造が不正です。STOP";
    const source = fixture["4374"];
    const result0 = chart(source.json) as {
      meta: { regularMarketPrice: number };
      timestamp: number[];
      indicators: { quote: { close: number[] }[] };
    };
    const split = extractStockCorporateEvents(source.json, source.receivedAt).reported.find((event) => event.kind === "splits");
    if (split === undefined || split.kind !== "splits") throw new Error("fixture 4374 に分割がありません");
    const splitRaw = (chart(source.json).events as { splits: Record<string, Record<string, unknown>> }).splits[split.dictionaryKey];
    if (splitRaw === undefined) throw new Error("fixture 4374 の分割原本がありません");
    const tsLen = result0.timestamp.length;
    const badSha = "g".repeat(64);
    const leaks = [
      source.receivedAt, "2000-01-01", "not-a-date", "2000000000", "4000000000",
      String(result0.meta.regularMarketPrice), String(result0.timestamp[0]), String(result0.timestamp[tsLen - 1]),
      String(result0.indicators.quote[0].close[0]), String(split.epoch), String(Number.MAX_VALUE), String(Number.MIN_VALUE),
      "2:1", "1:1", "1.5", "1mo", "1wk", "wrongKey", "nope", "note", "true", "NaN", "-1", "YYYY", "gggg", "7203",
    ];
    const lineOf = (name: string, run: () => void): string => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        lines.push(args.map((part) => String(part)).join(" "));
      });
      let caught: unknown;
      try {
        run();
      } catch (error) {
        caught = error;
      } finally {
        spy.mockRestore();
      }
      expect(caught, name).toBeInstanceOf(Error);
      if (!(caught instanceof Error)) throw new Error(`${name}: STOP 以外`);
      expect(caught.constructor, name).toBe(Error);
      expect(caught.message, name).toBe(STOP_MESSAGE);
      const incident = lines.filter((line) => line.startsWith(INCIDENT));
      expect(incident, name).toHaveLength(1);
      const line = incident[0];
      if (line === undefined) throw new Error(`${name}: 計測行がありません`);
      expect(line, name).not.toMatch(/[\r\n]/);
      for (const token of line.slice(INCIDENT.length).trim().split(" ")) {
        expect(token, `${name}: ${line}`).toMatch(/^(reason=[a-z0-9_]+|symbol=[0-9A-Za-z.]{1,16}|[a-z0-9_]+=\d+)$/);
      }
      for (const leak of leaks) expect(line, `${name}: ${line}`).not.toContain(leak);
      return line;
    };
    const cloned = (): { json: unknown; result: Record<string, unknown> } => {
      const json = structuredClone(source.json);
      return { json, result: chart(json) as Record<string, unknown> };
    };
    const withEvents = (events: unknown): unknown => {
      const row = cloned();
      row.result.events = events;
      return row.json;
    };
    const at = (json: unknown, receivedAt = source.receivedAt) => extractStockCorporateEvents(json, receivedAt);
    const P = `${INCIDENT} `;
    const sym = "symbol=4374.T";
    const cases: { name: string; run: () => void; exact: string }[] = [
      { name: "received_at_not_iso", run: () => at(source.json, "invalid"), exact: `${P}reason=received_at_not_iso received_at_len=${"invalid".length}` },
      { name: "json_not_object null", run: () => at(null), exact: `${P}reason=json_not_object clause=1` },
      { name: "json_not_object number", run: () => at(1), exact: `${P}reason=json_not_object clause=2` },
      { name: "json_not_object array", run: () => at([]), exact: `${P}reason=json_not_object clause=3` },
      { name: "chart_not_object", run: () => at({ chart: null }), exact: `${P}reason=chart_not_object clause=1` },
      { name: "chart_result_len empty", run: () => { const row = cloned(); (row.json as { chart: { result: unknown } }).chart.result = []; at(row.json); }, exact: `${P}reason=chart_result_len is_array=1 result_len=0` },
      { name: "chart_result_len not array", run: () => { const row = cloned(); (row.json as { chart: { result: unknown } }).chart.result = null; at(row.json); }, exact: `${P}reason=chart_result_len is_array=0` },
      { name: "result_not_object", run: () => { const row = cloned(); (row.json as { chart: { result: unknown[] } }).chart.result = [null]; at(row.json); }, exact: `${P}reason=result_not_object clause=1` },
      { name: "meta_not_object", run: () => { const row = cloned(); row.result.meta = []; at(row.json); }, exact: `${P}reason=meta_not_object clause=3` },
      { name: "timestamp_empty", run: () => { const row = cloned(); row.result.timestamp = []; at(row.json); }, exact: `${P}reason=timestamp_empty ${sym} is_array=1 timestamps_len=0` },
      { name: "timestamp_not_array", run: () => { const row = cloned(); row.result.timestamp = null; at(row.json); }, exact: `${P}reason=timestamp_not_array ${sym} is_array=0` },
      { name: "timestamp_not_positive_int zero", run: () => { const row = cloned(); (row.result.timestamp as number[])[0] = 0; at(row.json); }, exact: `${P}reason=timestamp_not_positive_int ${sym} index=0 timestamps_len=${tsLen} clause=3` },
      { name: "timestamp_not_positive_int fractional", run: () => { const row = cloned(); (row.result.timestamp as number[])[0] = 1.5; at(row.json); }, exact: `${P}reason=timestamp_not_positive_int ${sym} index=0 timestamps_len=${tsLen} clause=2` },
      { name: "timestamp_not_positive_int string", run: () => { const row = cloned(); (row.result.timestamp as unknown[])[0] = "x"; at(row.json); }, exact: `${P}reason=timestamp_not_positive_int ${sym} index=0 timestamps_len=${tsLen} clause=1` },
      { name: "timestamp_future", run: () => at(source.json, "2000-01-01T00:00:00.000Z"), exact: `${P}reason=timestamp_future ${sym} index=0 timestamps_len=${tsLen}` },
      { name: "timestamp_dup", run: () => { const row = cloned(); const ts = row.result.timestamp as number[]; ts[1] = ts[0]; at(row.json); }, exact: `${P}reason=timestamp_dup_or_reverse ${sym} index=1 timestamps_len=${tsLen} duplicate=1` },
      { name: "timestamp_reverse", run: () => { const row = cloned(); (row.result.timestamp as number[]).reverse(); at(row.json); }, exact: `${P}reason=timestamp_dup_or_reverse ${sym} index=1 timestamps_len=${tsLen} duplicate=0` },
      { name: "meta_string_empty symbol", run: () => { const row = cloned(); (row.result.meta as Record<string, unknown>).symbol = " "; at(row.json); }, exact: `${P}reason=meta_string_empty field_index=0 clause=2 value_len=1` },
      { name: "meta_string_empty range", run: () => { const row = cloned(); (row.result.meta as Record<string, unknown>).range = ""; at(row.json); }, exact: `${P}reason=meta_string_empty ${sym} field_index=1 clause=2 value_len=0` },
      { name: "range_mismatch", run: () => { const row = cloned(); const meta = row.result.meta as Record<string, unknown>; meta.range = "1mo"; meta.dataGranularity = "1wk"; at(row.json); }, exact: `${P}reason=range_mismatch ${sym}` },
      { name: "granularity_mismatch", run: () => { const row = cloned(); (row.result.meta as Record<string, unknown>).dataGranularity = "1wk"; at(row.json); }, exact: `${P}reason=granularity_mismatch ${sym}` },
      { name: "meta_epoch_invalid string", run: () => { const row = cloned(); (row.result.meta as Record<string, unknown>).firstTradeDate = "x"; at(row.json); }, exact: `${P}reason=meta_epoch_invalid ${sym} field_index=0 clause=1` },
      { name: "meta_epoch_invalid fractional", run: () => { const row = cloned(); (row.result.meta as Record<string, unknown>).firstTradeDate = 1.5; at(row.json); }, exact: `${P}reason=meta_epoch_invalid ${sym} field_index=0 clause=2` },
      { name: "meta_epoch_invalid future", run: () => { const row = cloned(); (row.result.meta as Record<string, unknown>).regularMarketTime = 4_000_000_000; at(row.json); }, exact: `${P}reason=meta_epoch_invalid ${sym} field_index=1 clause=4` },
      { name: "indicators_not_object", run: () => { const row = cloned(); delete row.result.indicators; at(row.json); }, exact: `${P}reason=indicators_not_object ${sym} clause=2` },
      { name: "quote_len", run: () => { const row = cloned(); (row.result.indicators as { quote: unknown }).quote = []; at(row.json); }, exact: `${P}reason=quote_len ${sym} is_array=1 quote_len=0` },
      { name: "quote_not_object", run: () => { const row = cloned(); (row.result.indicators as { quote: unknown }).quote = [null]; at(row.json); }, exact: `${P}reason=quote_not_object ${sym} clause=1` },
      { name: "quote_field_len_mismatch length", run: () => { const row = cloned(); (row.result.indicators as { quote: { close: number[] }[] }).quote[0].close.pop(); at(row.json); }, exact: `${P}reason=quote_field_len_mismatch ${sym} is_array=1 field_len=${tsLen - 1} field_index=3 timestamps_len=${tsLen}` },
      { name: "quote_field_len_mismatch null", run: () => { const row = cloned(); (row.result.indicators as { quote: { close: unknown }[] }).quote[0].close = null; at(row.json); }, exact: `${P}reason=quote_field_len_mismatch ${sym} is_array=0 field_index=3 timestamps_len=${tsLen}` },
      { name: "adjclose_len", run: () => { const row = cloned(); (row.result.indicators as { adjclose: unknown }).adjclose = [{}, {}]; at(row.json); }, exact: `${P}reason=adjclose_len ${sym} is_array=1 adjclose_len=2` },
      { name: "adjclose_not_object", run: () => { const row = cloned(); (row.result.indicators as { adjclose: unknown }).adjclose = [null]; at(row.json); }, exact: `${P}reason=adjclose_not_object ${sym} clause=1` },
      { name: "adjclose_series_len", run: () => { const row = cloned(); (row.result.indicators as { adjclose: { adjclose: number[] }[] }).adjclose[0].adjclose.pop(); at(row.json); }, exact: `${P}reason=adjclose_series_len ${sym} is_array=1 series_len=${tsLen - 1} timestamps_len=${tsLen}` },
      { name: "currency_invalid long", run: () => { const row = cloned(); (row.result.meta as Record<string, unknown>).currency = "Y".repeat(17); at(row.json); }, exact: `${P}reason=currency_invalid ${sym} currency_len=17 clause=3` },
      { name: "currency_invalid blank", run: () => { const row = cloned(); (row.result.meta as Record<string, unknown>).currency = "   "; at(row.json); }, exact: `${P}reason=currency_invalid ${sym} currency_len=3 clause=2` },
      { name: "currency_invalid number", run: () => { const row = cloned(); (row.result.meta as Record<string, unknown>).currency = 1; at(row.json); }, exact: `${P}reason=currency_invalid ${sym} clause=1` },
      { name: "events_state_not_object", run: () => at(withEvents([])), exact: `${P}reason=events_state_not_object ${sym} clause=3` },
      { name: "events_extra_key", run: () => at(withEvents({ other: {} })), exact: `${P}reason=events_extra_key ${sym} key_count=1 extra_key_count=1` },
      { name: "split_state_not_object", run: () => at(withEvents({ splits: [] })), exact: `${P}reason=split_state_not_object ${sym} clause=3` },
      { name: "split_entry_not_object", run: () => at(withEvents({ splits: { "1": null } })), exact: `${P}reason=split_entry_not_object ${sym} entry_index=0 clause=1` },
      { name: "split_date_not_positive", run: () => at(withEvents({ splits: { "1": { date: 0, numerator: 2, denominator: 1 } } })), exact: `${P}reason=split_date_not_positive ${sym} entry_index=0 clause=3` },
      { name: "split_epoch_not_safe_integer", run: () => at(withEvents({ splits: { "1.5": { date: 1.5, numerator: 2, denominator: 1 } } })), exact: `${P}reason=split_epoch_not_safe_integer ${sym} entry_index=0` },
      { name: "split_dictionary_key_mismatch", run: () => at(withEvents({ splits: { wrongKey: { ...splitRaw } } })), exact: `${P}reason=split_dictionary_key_mismatch ${sym} entry_index=0 key_len=${"wrongKey".length}` },
      { name: "split_epoch_future", run: () => at(withEvents({ splits: { "2000000000": { date: 2_000_000_000, numerator: 2, denominator: 1 } } })), exact: `${P}reason=split_epoch_future ${sym} entry_index=0` },
      { name: "split_extra_key", run: () => at(withEvents({ splits: { [split.dictionaryKey]: { ...splitRaw, note: true } } })), exact: `${P}reason=split_extra_key ${sym} key_count=5 extra_key_count=1 entry_index=0` },
      { name: "split_numerator_not_positive", run: () => at(withEvents({ splits: { [split.dictionaryKey]: { ...splitRaw, numerator: "x" } } })), exact: `${P}reason=split_numerator_not_positive ${sym} entry_index=0 clause=1` },
      { name: "split_denominator_not_positive", run: () => at(withEvents({ splits: { [split.dictionaryKey]: { ...splitRaw, denominator: 0 } } })), exact: `${P}reason=split_denominator_not_positive ${sym} entry_index=0 clause=3` },
      { name: "split_ratio_not_positive", run: () => at(withEvents({ splits: { [split.dictionaryKey]: { ...splitRaw, numerator: Number.MAX_VALUE, denominator: Number.MIN_VALUE } } })), exact: `${P}reason=split_ratio_not_positive ${sym} entry_index=0 clause=2` },
      { name: "split_ratio_format", run: () => at(withEvents({ splits: { [split.dictionaryKey]: { ...splitRaw, splitRatio: "nope" } } })), exact: `${P}reason=split_ratio_format ${sym} entry_index=0 clause=2 split_ratio_len=${"nope".length}` },
      { name: "split_ratio_parts_mismatch", run: () => at(withEvents({ splits: { [split.dictionaryKey]: { ...splitRaw, splitRatio: "1:1" } } })), exact: `${P}reason=split_ratio_parts_mismatch ${sym} entry_index=0 parts_len=2 numerator_mismatch=1 denominator_mismatch=0` },
      { name: "dividend_extra_key", run: () => at(withEvents({ dividends: { [split.dictionaryKey]: { date: split.epoch, amount: 1, note: true } } })), exact: `${P}reason=dividend_extra_key ${sym} key_count=3 extra_key_count=1 entry_index=0` },
      { name: "dividend_amount_invalid", run: () => at(withEvents({ dividends: { [split.dictionaryKey]: { date: split.epoch, amount: -1 } } })), exact: `${P}reason=dividend_amount_invalid ${sym} entry_index=0 clause=3` },
      { name: "capital_gains_amount_invalid", run: () => at(withEvents({ capitalGains: { [split.dictionaryKey]: { date: split.epoch, amount: Number.NaN } } })), exact: `${P}reason=capital_gains_amount_invalid ${sym} entry_index=0 clause=2` },
      { name: "diag_body_sha_invalid", run: () => buildStockCorporateDiagnostics({ events: extractStockCorporateEvents(source.json, source.receivedAt), code: "4374", bodySha256: badSha, receivedAt: "not-a-date", suppliedBars: [], qualifiedBars: [] }), exact: `${P}reason=diag_body_sha_invalid symbol=4374 body_sha_len=${badSha.length}` },
      { name: "diag_body_sha_invalid unsafe code", run: () => buildStockCorporateDiagnostics({ events: extractStockCorporateEvents(source.json, source.receivedAt), code: "4374\n7203", bodySha256: badSha, receivedAt: source.receivedAt, suppliedBars: [], qualifiedBars: [] }), exact: `${P}reason=diag_body_sha_invalid body_sha_len=${badSha.length}` },
      { name: "diag_received_at_not_iso", run: () => buildStockCorporateDiagnostics({ events: extractStockCorporateEvents(source.json, source.receivedAt), code: "4374", bodySha256: sha(JSON.stringify(source.json)), receivedAt: "not-a-date", suppliedBars: [], qualifiedBars: [] }), exact: `${P}reason=diag_received_at_not_iso symbol=4374 received_at_len=${"not-a-date".length}` },
    ];
    for (const item of cases) expect(lineOf(item.name, item.run), item.name).toBe(item.exact);
  });
});
