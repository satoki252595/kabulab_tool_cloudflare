import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { yuhoEnv } from "../env.js";
import { loadNewStockEligibility } from "./source.js";

// 公開済みの実 JPX イベント断片。未来/破損等の変更は資格拒否のための unit input。
const batch = JSON.parse(readFileSync(new URL("../../../../src/cron/__fixtures__/overlay-atomic/batch-excerpt.json", import.meta.url), "utf8"));
const FROM = "2026-09-25";
const TODAY = "2026-09-30";
let sqlite: DatabaseSync;
let queries: string[];

function db() {
  return drizzle(async (sql, params, method) => {
    queries.push(sql);
    if (method === "run" || !sql.toLowerCase().startsWith("select")) throw new Error("source test: SELECT 以外は禁止");
    const rows = sqlite.prepare(sql).all(...params as (string | number | null)[]).map((row) => Object.values(row));
    return { rows: method === "get" ? rows[0] : rows };
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("ネットワークは禁止"); }));
  queries = [];
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE universe_overlay_state (
      id INTEGER PRIMARY KEY, base_as_of TEXT, events_fetched_at TEXT, events_sha TEXT,
      eligibility_as_of TEXT, applied_at TEXT, held_listing_codes TEXT
    );
    CREATE TABLE universe_official_events (
      code TEXT, kind TEXT, effective_date TEXT, fetched_at TEXT, raw_sha TEXT,
      archive_key TEXT, last_seen_fetched_at TEXT
    );
  `);
  sqlite.prepare("INSERT INTO universe_overlay_state VALUES (1, ?, ?, ?, ?, ?, NULL)").run(
    batch.baseAsOf, batch.eventsFetchedAt, batch.eventsSha, batch.eligibilityAsOf, batch.eventsFetchedAt
  );
  for (const row of batch.sources.newListings.rows) {
    sqlite.prepare("INSERT INTO universe_official_events VALUES (?, 'listing', ?, ?, ?, ?, ?)").run(
      row.code, row.listingDate, batch.eventsFetchedAt, batch.sources.newListings.rawSha, batch.archiveKey, batch.eventsFetchedAt
    );
  }
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("新規上場の既存証拠だけを読む資格判定", () => {
  it("固定開始日以後の確認済み過去イベントだけ許可し、未来を HOLD にする (2 SELECT・外部通信0)", async () => {
    const result = await loadNewStockEligibility(db(), FROM, TODAY);
    expect([...result.eligibleCodes]).toEqual(["646A"]);
    expect([...result.heldCodes]).toEqual(["640A"]);
    expect(queries).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("開始日より前の過去の新上場を、未判定でも新規として許可しない", async () => {
    const result = await loadNewStockEligibility(db(), "2026-10-02", "2026-10-02");
    expect(result.eligibleCodes.size).toBe(0);
    expect(result.heldCodes.size).toBe(0);
  });

  it("現世代から消えた過去イベントは機械判定への既存扱いにせず HOLD", async () => {
    sqlite.exec("UPDATE universe_official_events SET last_seen_fetched_at = NULL WHERE code = '646A'");
    const result = await loadNewStockEligibility(db(), FROM, TODAY);
    expect(result.eligibleCodes.has("646A")).toBe(false);
    expect(result.heldCodes.has("646A")).toBe(true);
  });

  it("世代 state の per-code HOLD を優先する", async () => {
    sqlite.exec(`UPDATE universe_overlay_state SET held_listing_codes = '["646A"]'`);
    const result = await loadNewStockEligibility(db(), FROM, TODAY);
    expect(result.eligibleCodes.has("646A")).toBe(false);
    expect(result.heldCodes.has("646A")).toBe(true);
  });

  it("同一コードの複数上場日は選択せず HOLD", async () => {
    sqlite.exec("INSERT INTO universe_official_events SELECT code, kind, '2026-09-28', fetched_at, raw_sha, archive_key, last_seen_fetched_at FROM universe_official_events WHERE code = '646A'");
    const result = await loadNewStockEligibility(db(), FROM, TODAY);
    expect(result.eligibleCodes.has("646A")).toBe(false);
    expect(result.heldCodes.has("646A")).toBe(true);
  });

  it.each([
    ["raw_sha", "未確認"],
    ["archive_key", ""],
    ["archive_key", "universe-official-events-2026-08-31-2026-09-29-sha-000000000000"],
    ["fetched_at", "2026-09-29T00:00:00.000Z"],
  ])("イベント証拠 %s の欠落/別世代を HOLD", async (column, value) => {
    sqlite.prepare(`UPDATE universe_official_events SET ${column} = ? WHERE code = '646A'`).run(value);
    const result = await loadNewStockEligibility(db(), FROM, TODAY);
    expect(result.eligibleCodes.has("646A")).toBe(false);
    expect(result.heldCodes.has("646A")).toBe(true);
  });

  it.each(["base_as_of", "events_fetched_at", "events_sha", "eligibility_as_of", "applied_at"])("世代 %s が欠けたら明示停止し、イベントを追加照会しない", async (column) => {
    sqlite.exec(`UPDATE universe_overlay_state SET ${column} = NULL`);
    await expect(loadNewStockEligibility(db(), FROM, TODAY)).rejects.toThrow("世代証拠が不完全");
    expect(queries).toHaveLength(1);
  });

  it("state 不在は既存扱いへ縮退せず停止", async () => {
    sqlite.exec("DELETE FROM universe_overlay_state");
    await expect(loadNewStockEligibility(db(), FROM, TODAY)).rejects.toThrow("世代証拠が不完全");
  });

  it.each([
    ["eligibility_as_of", "2026-10-01"],
    ["eligibility_as_of", "2026-02-30"],
    ["applied_at", "2026-09-29T00:00:00.000Z"],
    ["held_listing_codes", "{}"],
  ])("世代の不正な %s は止める", async (column, value) => {
    sqlite.prepare(`UPDATE universe_overlay_state SET ${column} = ?`).run(value);
    await expect(loadNewStockEligibility(db(), FROM, TODAY)).rejects.toThrow();
  });

  it("上場日が存在しない日付なら不明を捨てず停止", async () => {
    sqlite.exec("UPDATE universe_official_events SET effective_date = '2026-09-31' WHERE code = '646A'");
    await expect(loadNewStockEligibility(db(), FROM, TODAY)).rejects.toThrow("実在する YYYY-MM-DD");
  });

  it("発効日が過去でも取得/適用の実時刻が未来なら停止する", async () => {
    sqlite.exec("UPDATE universe_overlay_state SET events_fetched_at = '2026-10-01T00:00:00.000Z', applied_at = '2026-10-01T00:00:00.000Z'");
    await expect(loadNewStockEligibility(db(), FROM, TODAY)).rejects.toThrow("世代日付が矛盾");
    expect(queries).toHaveLength(1);
  });
});

describe("固定開始日の型付き環境変数", () => {
  it("未設定は停止する", () => {
    vi.stubEnv("BIZTAG_NEW_LISTING_FROM", "");
    expect(() => yuhoEnv.BIZTAG_NEW_LISTING_FROM()).toThrow("設定されていません");
  });
  it.each(["2026-2-03", "2026-02-30", "2026-09-31", "today"])("不正な開始日 %s は停止する", async (value) => {
    vi.stubEnv("BIZTAG_NEW_LISTING_FROM", value);
    expect(() => yuhoEnv.BIZTAG_NEW_LISTING_FROM()).toThrow("実在する YYYY-MM-DD");
    await expect(loadNewStockEligibility(db(), value, TODAY)).rejects.toThrow();
    expect(queries).toHaveLength(0);
  });
  it("実在するうるう日を固定値として読む", () => {
    vi.stubEnv("BIZTAG_NEW_LISTING_FROM", "2024-02-29");
    expect(yuhoEnv.BIZTAG_NEW_LISTING_FROM()).toBe("2024-02-29");
  });
});
