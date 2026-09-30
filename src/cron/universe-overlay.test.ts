import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import type { DelistedRow } from "../shared/jpx/delisted.js";
import type { NewListingRow } from "../shared/jpx/new-listings.js";
import type { TransferRow } from "../shared/jpx/transfers.js";
import {
  applyUniverseOverlay,
  assertNoHeldListings,
  ensureUniverseOverlay,
  OverlayBatchInput,
  OverlayExistingRow,
  OverlayHoldError,
  parseMarketSuffix,
  planOverlayDeltas,
} from "./universe-overlay.js";
import { loadAppliedOverlaySets } from "./universe.js";

// 値は全て実証拠の転記 (捏造なし):
//   delist行: pinned delisted.html sha4974be15 (136行中9月14+未来2)
//   transfer行: pinned transfers.html shac2aa24ca (3477/9212/6615)
//   listing行: pinned new-listings.html sha70c27b36 (IPO9+未来2)
//   core状態: /tmp/pop29-observed-remapped.json sha993c4d00 (elig 2026-09-29)
const DELIST_14: Array<[string, string, string, string]> = [
  ["3480", "2026-09-02", "（株）ジェイ・エス・ビー", "プライム"],
  ["1909", "2026-09-14", "日本ドライケミカル（株）", "スタンダード"],
  ["2180", "2026-09-16", "（株）サニーサイドアップグループ", "スタンダード"],
  ["9914", "2026-09-21", "（株）植松商会", "スタンダード"],
  ["1948", "2026-09-25", "（株）弘電社", "スタンダード"],
  ["3856", "2026-09-26", "Ａｂａｌａｎｃｅ（株）", "スタンダード"],
  ["4800", "2026-09-28", "オリコン（株）", "スタンダード"],
  ["5202", "2026-09-28", "日本板硝子（株）", "プライム"],
  ["7426", "2026-09-28", "（株）山大", "スタンダード"],
  ["6486", "2026-09-29", "イーグル工業（株）", "プライム"],
  ["7082", "2026-09-29", "（株）ジモティー", "グロース"],
  ["7240", "2026-09-29", "ＮＯＫ（株）", "プライム"],
  ["9223", "2026-09-29", "（株）ＡＳＮＯＶＡ", "グロース"],
  ["9508", "2026-09-29", "九州電力（株）", "プライム"],
];
const FUTURE_DELIST: Array<[string, string]> = [
  ["5484", "2026-10-19"],
  ["8254", "2027-03-01"],
];
const TRANSFERS: Array<[string, string, string, string, string]> = [
  ["6615", "2026-09-08", "ユー・エム・シー・エレクトロニクス（株）", "プライム", "スタンダード"],
  ["3477", "2026-09-24", "フォーライフ（株）", "グロース", "スタンダード"],
  ["9212", "2026-09-25", "Ｇｒｅｅｎ Ｅａｒｔｈ Ｉｎｓｔｉｔｕｔｅ（株）", "グロース", "スタンダード"],
];
const IPO9: Array<[string, string, string, string]> = [
  ["618A", "2026-09-11", "（株）KOMPEITO", "グロース"],
  ["619A", "2026-09-16", "（株）オリバー", "スタンダード"],
  ["621A", "2026-09-16", "（株）オーディオストック", "グロース"],
  ["625A", "2026-09-17", "（株）Skyfall", "グロース"],
  ["622A", "2026-09-18", "（株）テクノクラフト", "スタンダード"],
  ["623A", "2026-09-18", "（株）ベルテックス", "スタンダード"],
  ["627A", "2026-09-18", "akippa（株）", "スタンダード"],
  ["634A", "2026-09-25", "（株）レイヤード", "スタンダード"],
  ["646A", "2026-09-29", "クラサスケミカル（株）", "スタンダード"],
];
const FUTURE_IPO: Array<[string, string]> = [
  ["652A", "2026-10-30"],
  ["653A", "2026-11-02"],
];
// pop29 の実 core 市場 (全 `（内国株式）` 付き・is_active=1)。
const CORE_MARKET: Record<string, string> = {
  "1948": "スタンダード（内国株式）",
  "4800": "スタンダード（内国株式）",
  "5202": "プライム（内国株式）",
  "6486": "プライム（内国株式）",
  "7240": "プライム（内国株式）",
  "9223": "グロース（内国株式）",
  "9508": "プライム（内国株式）",
  "3480": "プライム（内国株式）",
  "1909": "スタンダード（内国株式）",
  "2180": "スタンダード（内国株式）",
  "9914": "スタンダード（内国株式）",
  "3856": "スタンダード（内国株式）",
  "7426": "スタンダード（内国株式）",
  "7082": "グロース（内国株式）",
  "3477": "グロース（内国株式）",
  "5484": "スタンダード（内国株式）",
  "9691": "スタンダード（内国株式）",
};

function delistedRow(code: string, date: string, name: string, market: string): DelistedRow {
  return { code, companyName: name, effectiveDate: date, market, reason: "r" };
}

function batch(eligibilityAsOf: string): OverlayBatchInput {
  return {
    baseAsOf: "2026-08-31",
    eligibilityAsOf,
    eventsFetchedAt: "2026-09-30T00:00:00.000Z",
    eventsSha: "e".repeat(64),
    archiveKey: "a".repeat(12),
    pageId: "p",
    coverage: { years: ["2026"], bootstrapPartial: false },
    sources: {
      delisted: {
        rows: [
          ...DELIST_14.map(([c, d, n, m]) => delistedRow(c, d, n, m)),
          ...FUTURE_DELIST.map(([c, d]) => delistedRow(c, d, "nf", "スタンダード")),
        ],
        coveredYears: ["2026"],
        rawSha: "d",
        sourceUrl: "https://www.jpx.co.jp/listing/stocks/delisted/index.html",
      },
      newListings: {
        rows: [
          ...IPO9.map(
            ([c, d, n, m]): NewListingRow => ({
              code: c,
              companyName: n,
              listingDate: d,
              market: m,
              note: "",
            })
          ),
          ...FUTURE_IPO.map(
            ([c, d]): NewListingRow => ({
              code: c,
              companyName: "nf",
              listingDate: d,
              market: "グロース",
              note: "",
            })
          ),
        ],
        coveredYears: ["2026"],
        rawSha: "n",
        sourceUrl: "https://www.jpx.co.jp/listing/stocks/new/index.html",
      },
      transfers: {
        rows: TRANSFERS.map(
          ([c, d, n, f, t]): TransferRow => ({
            code: c,
            companyName: n,
            effectiveDate: d,
            fromMarket: f,
            toMarket: t,
            note: "",
          })
        ),
        coveredYears: ["2026"],
        rawSha: "t",
        sourceUrl: "https://www.jpx.co.jp/listing/stocks/transfers/index.html",
      },
    },
  };
}

function coreRow(code: string, id: number, isActive = true): OverlayExistingRow {
  return {
    id,
    code,
    name: `nm-${code}`,
    market: CORE_MARKET[code] ?? "スタンダード（内国株式）",
    isActive,
  };
}

function coreAll(): OverlayExistingRow[] {
  return Object.keys(CORE_MARKET).map((c, i) => coreRow(c, 100 + i));
}

describe("parseMarketSuffix", () => {
  it("既知3市場の接尾辞を温存取得する", () => {
    expect(parseMarketSuffix("グロース（内国株式）")).toBe("（内国株式）");
    expect(parseMarketSuffix("プライム（外国株式）")).toBe("（外国株式）");
  });

  it("形式外は null (推測しない)", () => {
    expect(parseMarketSuffix("グロース")).toBeNull();
    expect(parseMarketSuffix("ETF・ETN")).toBeNull();
    expect(parseMarketSuffix("")).toBeNull();
  });
});

describe("planOverlayDeltas", () => {
  it("9/29 elig で delist14 を日付順に無効化し未来2を除外する", () => {
    const byCode = new Map(coreAll().map((r) => [r.code, r]));
    const plan = planOverlayDeltas(batch("2026-09-29"), byCode);
    expect(plan.deactivations.map((d) => d.code)).toEqual([
      "3480",
      "1909",
      "2180",
      "9914",
      "1948",
      "3856",
      "4800",
      "5202",
      "7426",
      "6486",
      "7082",
      "7240",
      "9223",
      "9508",
    ]);
    expect(plan.skipped.futureDelist).toBe(2);
    expect(plan.eventUpserts).toHaveLength(16 + 11 + 3);
  });

  it("境界: elig 9/28 では 9/29 発効5件を除外する", () => {
    const byCode = new Map(coreAll().map((r) => [r.code, r]));
    const plan = planOverlayDeltas(batch("2026-09-28"), byCode);
    expect(plan.deactivations.map((d) => d.code)).toHaveLength(9);
    expect(plan.deactivations.map((d) => d.code)).not.toContain("6486");
    expect(plan.skipped.futureDelist).toBe(7);
  });

  it("3477 G→S は接尾辞温存で更新する (P→S 降格も)", () => {
    const rows = coreAll();
    rows.push({ id: 1, code: "6615", name: "x", market: "プライム（内国株式）", isActive: true });
    rows.push({ id: 2, code: "9212", name: "x", market: "グロース（内国株式）", isActive: true });
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const plan = planOverlayDeltas(batch("2026-09-29"), byCode);
    expect(plan.marketUpdates).toEqual([
      { id: 1, code: "6615", from: "プライム（内国株式）", to: "スタンダード（内国株式）", effectiveDate: "2026-09-08" },
      { id: 103, code: "3477", from: "グロース（内国株式）", to: "スタンダード（内国株式）", effectiveDate: "2026-09-24" },
      { id: 2, code: "9212", from: "グロース（内国株式）", to: "スタンダード（内国株式）", effectiveDate: "2026-09-25" },
    ]);
  });

  // 以下の logic test の 3000/7000/7001 は合成コード (planner の順序・日付
  // 規則のみを検証し、実在性は主張しない。実データ駆動は上記の 14/9/3477。
  it("同 code 複数 transfer は日付昇順 reduce (newest-first 入力でも巻戻らない)", () => {
    const byCode = new Map([
      ["3000", { id: 1, code: "3000", name: "x", market: "スタンダード（内国株式）", isActive: true }],
    ]);
    const b = batch("2026-09-29");
    b.sources.delisted.rows = [];
    b.sources.newListings.rows = [];
    b.sources.transfers.rows = [
      { code: "3000", companyName: "x", effectiveDate: "2026-09-20", fromMarket: "スタンダード", toMarket: "プライム", note: "" },
      { code: "3000", companyName: "x", effectiveDate: "2026-09-10", fromMarket: "グロース", toMarket: "スタンダード", note: "" },
    ];
    const plan = planOverlayDeltas(b, byCode);
    expect(plan.marketUpdates).toEqual([
      { id: 1, code: "3000", from: "スタンダード（内国株式）", to: "プライム（内国株式）", effectiveDate: "2026-09-20" },
    ]);
    expect(plan.skipped.transferAlreadyReflected).toBe(1);
  });

  it("transfer from/to 双方不一致は説明不能 STOP (throw)", () => {
    const byCode = new Map([
      ["3000", { id: 1, code: "3000", name: "x", market: "スタンダード（内国株式）", isActive: true }],
    ]);
    const b = batch("2026-09-29");
    b.sources.delisted.rows = [];
    b.sources.newListings.rows = [];
    b.sources.transfers.rows = [
      { code: "3000", companyName: "x", effectiveDate: "2026-09-10", fromMarket: "グロース", toMarket: "プライム", note: "" },
    ];
    expect(() => planOverlayDeltas(b, byCode)).toThrow(/fromMarket 不一致/);
  });

  it("同 code 同日 transfer 矛盾は throw する", () => {
    const byCode = new Map([
      ["3000", { id: 1, code: "3000", name: "x", market: "スタンダード（内国株式）", isActive: true }],
    ]);
    const b = batch("2026-09-29");
    b.sources.delisted.rows = [];
    b.sources.newListings.rows = [];
    b.sources.transfers.rows = [
      { code: "3000", companyName: "x", effectiveDate: "2026-09-20", fromMarket: "スタンダード", toMarket: "プライム", note: "" },
      { code: "3000", companyName: "x", effectiveDate: "2026-09-20", fromMarket: "グロース", toMarket: "スタンダード", note: "" },
    ];
    expect(() => planOverlayDeltas(b, byCode)).toThrow(/同日矛盾/);
  });

  it("inactive 行への transfer は適用しない", () => {
    const byCode = new Map([
      ["3477", { id: 1, code: "3477", name: "x", market: "グロース（内国株式）", isActive: false }],
    ]);
    const b = batch("2026-09-29");
    b.sources.delisted.rows = [];
    b.sources.newListings.rows = [];
    b.sources.transfers.rows = b.sources.transfers.rows.filter((r) => r.code === "3477");
    const plan = planOverlayDeltas(b, byCode);
    expect(plan.marketUpdates).toHaveLength(0);
    expect(plan.skipped.transferInactive).toBe(1);
  });

  it("最終 eligible が廃止の code へは現役 insert しない (再上場は通過)", () => {
    const byCode = new Map<string, OverlayExistingRow>();
    const b = batch("2026-09-29");
    b.sources.transfers.rows = [];
    b.sources.delisted.rows = [
      delistedRow("7000", "2026-09-20", "x", "スタンダード"),
      delistedRow("7001", "2026-09-10", "x", "スタンダード"),
    ];
    b.sources.newListings.rows = [
      { code: "7000", companyName: "x", listingDate: "2026-09-15", market: "グロース", note: "" },
      { code: "7001", companyName: "x", listingDate: "2026-09-20", market: "グロース", note: "" },
    ];
    const plan = planOverlayDeltas(b, byCode);
    expect(plan.listingInserts.map((l) => l.code)).toEqual(["7001"]);
    expect(plan.skipped.listingDelisted).toBe(1);
  });

  it("現 market 形式外の transfer 行は throw する", () => {
    const rows = coreAll();
    const i = rows.findIndex((r) => r.code === "3477");
    rows[i] = { ...rows[i]!, market: "グロース" };
    const byCode = new Map(rows.map((r) => [r.code, r]));
    expect(() => planOverlayDeltas(batch("2026-09-29"), byCode)).toThrow(
      /transfer 3477/
    );
  });

  it("IPO9 は market=null の inserts・未来2除外 (held 判定は orchestrator)", () => {
    const byCode = new Map(coreAll().map((r) => [r.code, r]));
    const plan = planOverlayDeltas(batch("2026-09-29"), byCode);
    expect(plan.listingInserts.map((l) => l.code)).toEqual([
      "618A",
      "619A",
      "621A",
      "625A",
      "622A",
      "623A",
      "627A",
      "634A",
      "646A",
    ]);
    expect(plan.listingInserts.every((l) => l.market === null)).toBe(true);
    expect(plan.skipped.futureListing).toBe(2);
  });

  it("冪等: 非active delist・一致済 market・在core IPO は no-op", () => {
    const rows = coreAll().map((r) =>
      DELIST_14.some(([c]) => c === r.code) ? { ...r, isActive: false } : r
    );
    rows.push({ id: 2, code: "9212", name: "x", market: "スタンダード（内国株式）", isActive: true });
    rows.push({ id: 3, code: "618A", name: "x", market: "グロース（内国株式）", isActive: true });
    const i = rows.findIndex((r) => r.code === "3477");
    rows[i] = { ...rows[i]!, market: "スタンダード（内国株式）" };
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const plan = planOverlayDeltas(batch("2026-09-29"), byCode);
    expect(plan.deactivations).toHaveLength(0);
    expect(plan.skipped.delistAlreadyInactive).toBe(14);
    expect(plan.marketUpdates).toHaveLength(0);
    expect(plan.skipped.transferMarketCurrent).toBe(2);
    expect(plan.skipped.transferNotInCore).toBe(1);
    expect(plan.listingInserts).toHaveLength(8);
    expect(plan.skipped.listingAlreadyInCore).toBe(1);
  });
});

describe("loadAppliedOverlaySets / ensureUniverseOverlay (:memory:)", () => {
  // drizzle/d1/0025_useful_nightcrawler.sql の鏡像 (test 内 DDL)。
  const DDL = `
CREATE TABLE core_stocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  market TEXT NOT NULL,
  sector TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_yutai INTEGER NOT NULL DEFAULT 0,
  instrument_type TEXT,
  sector33 TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE universe_official_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  code TEXT NOT NULL,
  kind TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  name TEXT,
  market_from TEXT,
  market_to TEXT,
  source_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  raw_sha TEXT NOT NULL,
  archive_key TEXT NOT NULL,
  last_seen_fetched_at TEXT
);
CREATE UNIQUE INDEX uq_e ON universe_official_events (code, kind, effective_date);
CREATE TABLE universe_overlay_state (
  id INTEGER PRIMARY KEY NOT NULL,
  base_as_of TEXT,
  events_fetched_at TEXT,
  events_sha TEXT,
  eligibility_as_of TEXT,
  applied_at TEXT,
  applied_delist INTEGER DEFAULT 0 NOT NULL,
  applied_listing INTEGER DEFAULT 0 NOT NULL,
  applied_transfer INTEGER DEFAULT 0 NOT NULL,
  held_listing_codes TEXT
);`;
  let sqlite: DatabaseSync;

  function memDb() {
    return drizzle(async (sqlStr, params, method) => {
      const stmt = sqlite.prepare(sqlStr);
      const bind = params as (null | number | bigint | string | Uint8Array)[];
      if (method === "run") {
        stmt.run(...bind);
        return { rows: [] };
      }
      const rows = (stmt.all(...bind) as Record<string, unknown>[]).map((o) =>
        Object.values(o)
      );
      return { rows: method === "get" ? (rows[0] ?? []) : rows };
    });
  }

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec(DDL);
  });

  afterEach(() => {
    sqlite?.close();
  });

  it("state 不在なら全て空 (旧 MAX を使わない)", async () => {
    const sets = await loadAppliedOverlaySets(memDb() as never);
    expect(sets.baseAsOf).toBeNull();
    expect(sets.delisted.size).toBe(0);
    expect(sets.heldListingCodes).toEqual([]);
  });

  it("現世代一致・発効済みのみ集合に入り held JSON を読む", async () => {
    sqlite.exec(
      `INSERT INTO universe_overlay_state (id, base_as_of, events_fetched_at, eligibility_as_of, held_listing_codes)
       VALUES (1, '2026-08-31', 'GEN2', '2026-09-29', '["618A"]')`
    );
    const ins =
      "INSERT INTO universe_official_events (code, kind, effective_date, source_url, fetched_at, raw_sha, archive_key, last_seen_fetched_at) VALUES (?, ?, ?, 'u', 'f', 'r', 'a', ?)";
    const p = sqlite.prepare(ins);
    p.run("1948", "delist", "2026-09-25", "GEN2");
    p.run("4800", "delist", "2026-09-28", "GEN1");
    p.run("5484", "delist", "2026-10-19", "GEN2");
    p.run("3477", "transfer", "2026-09-24", "GEN2");
    const sets = await loadAppliedOverlaySets(memDb() as never);
    expect([...sets.delisted]).toEqual(["1948"]);
    expect([...sets.transferred]).toEqual(["3477"]);
    expect(sets.listed.size).toBe(0);
    expect(sets.heldListingCodes).toEqual(["618A"]);
  });

  it("既適用 elig + 完全世代 tuple なら collect せず no-op", async () => {
    sqlite.exec(
      `INSERT INTO universe_overlay_state (id, base_as_of, events_fetched_at, events_sha, eligibility_as_of, applied_at)
       VALUES (1, '2026-08-31', 'GEN2', 's', '2026-09-29', '2026-09-29T00:00:00.000Z')`
    );
    const collect = vi.fn();
    const out = await ensureUniverseOverlay(memDb() as never, {
      eligibilityAsOf: "2026-09-29",
      collect,
    });
    expect(out).toEqual({ applied: false, result: null });
    expect(collect).not.toHaveBeenCalled();
  });

  it("elig 一致でも世代 tuple 不完全なら HOLD (不完全失敗)", async () => {
    sqlite.exec(
      `INSERT INTO universe_overlay_state (id, eligibility_as_of) VALUES (1, '2026-09-29')`
    );
    const collect = vi.fn();
    const err = await ensureUniverseOverlay(memDb() as never, {
      eligibilityAsOf: "2026-09-29",
      collect,
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(OverlayHoldError);
    expect((err as Error).message).toContain("不完全な世代 tuple");
    expect(collect).not.toHaveBeenCalled();
  });

  it("partial 書込 (applied_at 欠落) の世代は reuse しない (retry で再適用)", async () => {
    sqlite.exec(
      `INSERT INTO universe_overlay_state (id, base_as_of, events_fetched_at, events_sha, eligibility_as_of)
       VALUES (1, '2026-08-31', 'GEN-PARTIAL', 's', '2026-09-29')`
    );
    const collect = vi.fn();
    const err = await ensureUniverseOverlay(memDb() as never, {
      eligibilityAsOf: "2026-09-29",
      collect,
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(OverlayHoldError);
    expect((err as Error).message).toContain("不完全な世代 tuple");
    expect(collect).not.toHaveBeenCalled();
  });

  it("complete empty batch は state 世代を進める (旧世代に留まらない)", async () => {
    const { emptyUniverseBatch } = await import("./tests/overlay-batch.js");
    const res = await applyUniverseOverlay(
      memDb() as never,
      emptyUniverseBatch("2026-08-31", "2026-09-29"),
      []
    );
    expect(res.stateCommitted).toBe(true);
    expect(res.eventsUpserted).toBe(0);
    const st = sqlite
      .prepare("SELECT events_fetched_at, events_sha, eligibility_as_of, applied_delist FROM universe_overlay_state WHERE id=1")
      .get() as { events_fetched_at: string; events_sha: string; eligibility_as_of: string; applied_delist: number };
    expect(st.events_fetched_at).toBe("1970-01-01T00:00:00.000Z");
    expect(st.events_sha).toBe("e".repeat(64));
    expect(st.eligibility_as_of).toBe("2026-09-29");
    expect(st.applied_delist).toBe(0);
    const sets = await loadAppliedOverlaySets(memDb() as never);
    expect(sets.eventsFetchedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(sets.delisted.size).toBe(0);
  });

  it("同日再入でも HOLD 残があれば no-op 正常にしない (BLOCKER 回帰)", async () => {
    sqlite.exec(
      `INSERT INTO universe_overlay_state (id, eligibility_as_of, events_fetched_at, held_listing_codes)
       VALUES (1, '2026-09-29', 'GEN-HOLD', '["618A","646A"]')`
    );
    const collect = vi.fn();
    const err = await ensureUniverseOverlay(memDb() as never, {
      eligibilityAsOf: "2026-09-29",
      collect,
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(OverlayHoldError);
    expect((err as Error).message).toContain("618A");
    expect(collect).not.toHaveBeenCalled();
  });

  it("chunk 上限文の実 bind 数は 100 以内 (toSQL 測定)", async () => {
    const db = memDb() as never as {
      insert: (t: unknown) => {
        values: (v: unknown[]) => { toSQL: () => { params: unknown[] } };
      };
    };
    const { stocks } = await import("../shared/db/core-schema.js");
    const { listingOfficialEvents } = await import("../shared/db/universe-events.js");
    const { OVERLAY_EVENT_CHUNK, OVERLAY_LISTING_CHUNK } = await import("./universe-overlay.js");
    const listingRows = Array.from({ length: OVERLAY_LISTING_CHUNK }, (_, i) => ({
      code: `9${String(i).padStart(3, "0")}`,
      name: "n",
      market: "グロース（内国株式）",
      sector: null,
      isActive: true,
    }));
    const lq = db.insert(stocks).values(listingRows).toSQL();
    expect(lq.params.length).toBeLessThanOrEqual(100);
    const eventRows = Array.from({ length: OVERLAY_EVENT_CHUNK }, (_, i) => ({
      code: `8${String(i).padStart(3, "0")}`,
      kind: "delist",
      effectiveDate: "2026-09-29",
      name: "n",
      marketFrom: null,
      marketTo: "x",
      sourceUrl: "u",
      fetchedAt: "f",
      rawSha: "r",
      archiveKey: "a",
      lastSeenFetchedAt: "g",
    }));
    const eq = db.insert(listingOfficialEvents).values(eventRows).toSQL();
    expect(eq.params.length).toBeLessThanOrEqual(100);
  });

  it("未適用なら collect→apply→assert (HOLD で不完全失敗・delist は適用済み)", async () => {
    sqlite
      .prepare("INSERT INTO core_stocks (code, name, market, is_active) VALUES (?, ?, ?, 1)")
      .run("1948", "弘電社", "スタンダード（内国株式）");
    const b = batch("2026-09-29");
    b.sources.newListings.rows = b.sources.newListings.rows.slice(0, 1);
    b.sources.transfers.rows = [];
    b.sources.delisted.rows = b.sources.delisted.rows.filter((r) => r.code === "1948");
    const collect = vi.fn().mockResolvedValue(b);
    const err = await ensureUniverseOverlay(memDb() as never, {
      eligibilityAsOf: "2026-09-29",
      collect,
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(collect).toHaveBeenCalledWith({ baseAsOf: null, eligibilityAsOf: "2026-09-29" });
    expect(err).toBeInstanceOf(OverlayHoldError);
    const row = sqlite
      .prepare("SELECT is_active FROM core_stocks WHERE code='1948'")
      .get() as { is_active: number };
    expect(row.is_active).toBe(0);
    const st = sqlite
      .prepare("SELECT eligibility_as_of, held_listing_codes FROM universe_overlay_state WHERE id=1")
      .get() as { eligibility_as_of: string; held_listing_codes: string };
    expect(st.eligibility_as_of).toBe("2026-09-29");
    expect(JSON.parse(st.held_listing_codes)).toEqual(["618A"]);
  });
});

describe("applyUniverseOverlay", () => {
  type Db = Parameters<typeof applyUniverseOverlay>[0];

  // 呼出順と文種だけ記録する最小 fake (drizzle 連鎖の同定はしない)。
  function recordingDb() {
    const calls: string[] = [];
    const db = {
      insert: (_t: unknown) => ({
        values: (_v: unknown) => ({
          onConflictDoUpdate: async (_c: unknown) => {
            calls.push("insert");
            return [];
          },
          onConflictDoNothing: async (_c?: unknown) => {
            calls.push("insert");
            return [];
          },
        }),
      }),
      update: (_t: unknown) => ({
        set: (_s: unknown) => ({
          where: async (_w: unknown) => {
            calls.push("update");
            return [];
          },
        }),
      }),
      select: () => {
        throw new Error("select 未使用");
      },
    };
    return { db: db as unknown as Db, calls };
  }

  it("IPO HOLD 時も state 確定し held を結果に載せる (throw しない)", async () => {
    const { db, calls } = recordingDb();
    const res = await applyUniverseOverlay(db, batch("2026-09-29"), coreAll());
    expect(res.stateCommitted).toBe(true);
    expect(res.listed).toBe(0);
    expect(res.heldListingCodes).toEqual([
      "618A",
      "619A",
      "621A",
      "625A",
      "622A",
      "623A",
      "627A",
      "634A",
      "646A",
    ]);
    expect(res.deactivated).toBe(14);
    expect(res.marketUpdated).toBe(1);
    // events 4文 (30行/9) + delist + transfer + state。
    expect(calls).toEqual([
      "insert",
      "insert",
      "insert",
      "insert",
      "update",
      "update",
      "insert",
    ]);
  });

  it("assertNoHeldListings は HOLD 残で不完全失敗を throw する", async () => {
    const { db } = recordingDb();
    const res = await applyUniverseOverlay(db, batch("2026-09-29"), coreAll());
    const err = (() => {
      try {
        assertNoHeldListings(res);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(OverlayHoldError);
    expect((err as Error).message).toContain("618A");
    expect((err as Error).message).toContain("646A");
  });

  it("IPO 無し batch は全適用して state 確定する", async () => {
    const { db, calls } = recordingDb();
    const b = batch("2026-09-29");
    b.sources.newListings.rows = b.sources.newListings.rows.filter((r) =>
      FUTURE_IPO.some(([c]) => c === r.code)
    );
    const res = await applyUniverseOverlay(db, b, coreAll());
    expect(res.stateCommitted).toBe(true);
    expect(res.deactivated).toBe(14);
    expect(res.marketUpdated).toBe(1);
    expect(res.listed).toBe(0);
    expect(res.skipped.futureListing).toBe(2);
    // events 3文 (21行/9: 16+2+3) + delist + transfer + state。
    expect(calls).toEqual([
      "insert",
      "insert",
      "insert",
      "update",
      "update",
      "insert",
    ]);
  });
});
