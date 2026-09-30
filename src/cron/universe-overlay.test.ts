import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  withBasicEvidence,
} from "./universe-overlay.js";
import { loadAppliedOverlaySets } from "./universe.js";
import { activeEquityCondition } from "../shared/db/active-equity.js";
import { stocks } from "../shared/db/core-schema.js";

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
    expect(() => planOverlayDeltas(b, byCode)).toThrow(/説明不能のため STOP/);
  });

  it("接続 chain の途中 (現=B) から resume して最終へ進む", () => {
    const byCode = new Map([
      ["3000", { id: 1, code: "3000", name: "x", market: "スタンダード（内国株式）", isActive: true }],
    ]);
    const b = batch("2026-09-29");
    b.sources.delisted.rows = [];
    b.sources.newListings.rows = [];
    b.sources.transfers.rows = [
      { code: "3000", companyName: "x", effectiveDate: "2026-09-10", fromMarket: "グロース", toMarket: "スタンダード", note: "" },
      { code: "3000", companyName: "x", effectiveDate: "2026-09-20", fromMarket: "スタンダード", toMarket: "プライム", note: "" },
    ];
    const plan = planOverlayDeltas(b, byCode);
    expect(plan.marketUpdates).toEqual([
      { id: 1, code: "3000", from: "スタンダード（内国株式）", to: "プライム（内国株式）", effectiveDate: "2026-09-20" },
    ]);
    expect(plan.skipped.transferAlreadyReflected).toBe(1);
  });

  it("非接続 chain (中間 event 欠落) は説明不能 STOP", () => {
    const byCode = new Map([
      ["3000", { id: 1, code: "3000", name: "x", market: "スタンダード（内国株式）", isActive: true }],
    ]);
    const b = batch("2026-09-29");
    b.sources.delisted.rows = [];
    b.sources.newListings.rows = [];
    b.sources.transfers.rows = [
      { code: "3000", companyName: "x", effectiveDate: "2026-09-10", fromMarket: "グロース", toMarket: "スタンダード", note: "" },
      { code: "3000", companyName: "x", effectiveDate: "2026-09-20", fromMarket: "プライム", toMarket: "グロース", note: "" },
    ];
    expect(() => planOverlayDeltas(b, byCode)).toThrow(/chain 非接続/);
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

  it("batch.basics の束縛証拠のみ full-form 解決する (欠落/stale/外国/不一致は HOLD)", async () => {
    const { DEFS_COUNTRY_GUIDE, DEFS_ORDINARY_CODE } = await import(
      "../shared/jpx/basic-profile.js"
    );
    type Ev = import("../shared/jpx/basic-profile.js").BasicProfileEvidence;
    const byCode = new Map<string, OverlayExistingRow>();
    const b = batch("2026-09-29");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    const ev = (code: string, partial: Partial<Ev>): Ev => ({
      code4: code,
      code5: `${code}0`,
      isin: "JP9999999999",
      marketBare: "グロース",
      countryCell: null,
      sector: "サービス業",
      basicFetchedAt: "2026-09-30T01:00:00.000Z",
      entryFetchedAt: "2026-09-30T01:00:00.000Z",
      searchFetchedAt: "2026-09-30T01:00:00.000Z",
      entrySha: "e".repeat(64),
      searchSha: "f".repeat(64),
      rawSha: "a".repeat(64),
      sourceUrl: "u",
      defsPins: {
        countryGuide: DEFS_COUNTRY_GUIDE.sha256,
        ordinaryCode: DEFS_ORDINARY_CODE.sha256,
      },
      custody: { pageId: "p" },
      boundEventsFetchedAt: "2026-09-30T00:00:00.000Z",
      qualificationDate: "2026-09-29",
      qualificationBasis: "current-owner-qualified",
      datedSourcePin: null,
      reviewedPins: {
        entrySha: "e".repeat(64),
        searchSha: "f".repeat(64),
        rawSha: "a".repeat(64),
        custodyPageIds: ["p"],
      },
      ...partial,
    });
    // batch 世代 = 2026-09-30T00:00:00.000Z。618A の event 市場 = グロース。
    b.basics = new Map([
      ["618A", ev("618A", {})],
      ["621A", ev("621A", { boundEventsFetchedAt: "2026-09-29T00:00:00.000Z" })],
      ["625A", ev("625A", { marketBare: null, countryCell: "グロース アメリカ" })],
      ["622A", ev("622A", {})],
      ["623A", ev("623A", { marketBare: "スタンダード", custody: null })],
    ]);
    const plan = planOverlayDeltas(b, byCode);
    const byCodeOut = new Map(plan.listingInserts.map((l) => [l.code, l.market]));
    expect(byCodeOut.get("618A")).toBe("グロース（内国株式）");
    expect(byCodeOut.get("621A")).toBeNull();
    expect(byCodeOut.get("625A")).toBeNull();
    expect(byCodeOut.get("622A")).toBeNull();
    expect(byCodeOut.get("623A")).toBeNull();
    expect(byCodeOut.get("619A")).toBeNull();
  });

  it("inactive 衝突・逆行時計・SHA 形式不正の証拠は HOLD", async () => {
    const { DEFS_COUNTRY_GUIDE, DEFS_ORDINARY_CODE } = await import(
      "../shared/jpx/basic-profile.js"
    );
    type Ev = import("../shared/jpx/basic-profile.js").BasicProfileEvidence;
    const mk = (partial: Partial<Ev>): Ev => ({
      code4: "618A",
      code5: "618A0",
      isin: "JP9999999999",
      marketBare: "グロース",
      countryCell: null,
      sector: "サービス業",
      basicFetchedAt: "2026-09-30T01:00:00.000Z",
      entryFetchedAt: "2026-09-30T01:00:00.000Z",
      searchFetchedAt: "2026-09-30T01:00:00.000Z",
      entrySha: "e".repeat(64),
      searchSha: "f".repeat(64),
      rawSha: "a".repeat(64),
      sourceUrl: "u",
      defsPins: {
        countryGuide: DEFS_COUNTRY_GUIDE.sha256,
        ordinaryCode: DEFS_ORDINARY_CODE.sha256,
      },
      custody: { pageId: "p" },
      boundEventsFetchedAt: "2026-09-30T00:00:00.000Z",
      qualificationDate: "2026-09-29",
      qualificationBasis: "current-owner-qualified",
      datedSourcePin: null,
      reviewedPins: {
        entrySha: "e".repeat(64),
        searchSha: "f".repeat(64),
        rawSha: "a".repeat(64),
        custodyPageIds: ["p"],
      },
      ...partial,
    });
    // inactive 衝突は証拠があっても HOLD。
    const byInactive = new Map<string, OverlayExistingRow>([
      ["618A", { id: 1, code: "618A", name: "x", market: "グロース（内国株式）", isActive: false }],
    ]);
    const b1 = batch("2026-09-29");
    b1.sources.delisted.rows = [];
    b1.sources.transfers.rows = [];
    b1.basics = new Map([["618A", mk({})]]);
    const p1 = planOverlayDeltas(b1, byInactive);
    expect(p1.listingInserts.find((l) => l.code === "618A")?.market).toBeNull();
    expect(p1.skipped.listingInactiveCollision).toBe(1);
    // 逆行時計 (basic < gen) は HOLD。
    const b2 = batch("2026-09-29");
    b2.sources.delisted.rows = [];
    b2.sources.transfers.rows = [];
    b2.basics = new Map([
      ["618A", mk({ basicFetchedAt: "2026-09-29T23:00:00.000Z" })],
    ]);
    const p2 = planOverlayDeltas(b2, new Map());
    expect(p2.listingInserts.find((l) => l.code === "618A")?.market).toBeNull();
    // SHA 形式不正は HOLD。
    const b3 = batch("2026-09-29");
    b3.sources.delisted.rows = [];
    b3.sources.transfers.rows = [];
    b3.basics = new Map([["618A", mk({ rawSha: "zzz" })]]);
    const p3 = planOverlayDeltas(b3, new Map());
    expect(p3.listingInserts.find((l) => l.code === "618A")?.market).toBeNull();
  });

  it("current 9/30 証拠は historic 9/29 母集団を qualify しない (HOLD)", async () => {
    const { DEFS_COUNTRY_GUIDE, DEFS_ORDINARY_CODE } = await import(
      "../shared/jpx/basic-profile.js"
    );
    // 9/29 eligibility の batch に、9/30 所有検証の証拠を提示する。
    // bound・時計・保管・定義 pins は全て正。日付だけが historic。
    const b = batch("2026-09-29");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    b.sources.newListings.rows = b.sources.newListings.rows.slice(0, 1);
    b.basics = new Map([
      [
        "618A",
        {
          code4: "618A",
          code5: "618A0",
          isin: "JP3306480009",
          marketBare: "グロース",
          countryCell: null,
          sector: "サービス業",
          basicFetchedAt: "2026-09-30T01:00:00.000Z",
          entryFetchedAt: "2026-09-30T01:00:00.000Z",
          searchFetchedAt: "2026-09-30T01:00:00.000Z",
          entrySha: "e".repeat(64),
          searchSha: "f".repeat(64),
          rawSha: "a".repeat(64),
          sourceUrl: "u",
          defsPins: {
            countryGuide: DEFS_COUNTRY_GUIDE.sha256,
            ordinaryCode: DEFS_ORDINARY_CODE.sha256,
          },
          custody: { pageId: "p" },
          boundEventsFetchedAt: "2026-09-30T00:00:00.000Z",
          qualificationDate: "2026-09-30",
          qualificationBasis: "current-owner-qualified",
          datedSourcePin: null,
          reviewedPins: {
            entrySha: "e".repeat(64),
            searchSha: "f".repeat(64),
            rawSha: "a".repeat(64),
            custodyPageIds: ["p"],
          },
        },
      ],
    ]);
    const plan = planOverlayDeltas(b, new Map());
    expect(
      plan.listingInserts.find((l) => l.code === "618A")?.market
    ).toBeNull();
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

  it("current-observation は実観測 JST 日の一致でのみ full-form 解決する", async () => {
    const { DEFS_COUNTRY_GUIDE, DEFS_ORDINARY_CODE } = await import(
      "../shared/jpx/basic-profile.js"
    );
    type Ev = import("../shared/jpx/basic-profile.js").BasicProfileEvidence;
    const byCode = new Map<string, OverlayExistingRow>();
    const b = batch("2026-09-30");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    const ev = (code: string, partial: Partial<Ev>): Ev => ({
      code4: code,
      code5: `${code}0`,
      isin: "JP9999999999",
      marketBare: "グロース",
      countryCell: null,
      sector: "サービス業",
      basicFetchedAt: "2026-09-30T06:31:00.000Z",
      entryFetchedAt: "2026-09-30T06:31:00.000Z",
      searchFetchedAt: "2026-09-30T06:31:00.000Z",
      entrySha: "e".repeat(64),
      searchSha: "f".repeat(64),
      rawSha: "a".repeat(64),
      sourceUrl: "u",
      defsPins: {
        countryGuide: DEFS_COUNTRY_GUIDE.sha256,
        ordinaryCode: DEFS_ORDINARY_CODE.sha256,
      },
      custody: { pageId: "p" },
      boundEventsFetchedAt: "2026-09-30T00:00:00.000Z",
      qualificationDate: "2026-09-30",
      qualificationBasis: "current-observation",
      datedSourcePin: null,
      reviewedPins: {
        entrySha: "e".repeat(64),
        searchSha: "f".repeat(64),
        rawSha: "a".repeat(64),
        custodyPageIds: ["p"],
      },
      ...partial,
    });
    b.basics = new Map([
      ["618A", ev("618A", {})],
      // JST 10/01 観測 (時刻証明は通過) → JST 再検証で HOLD。
      ["619A", ev("619A", {
        marketBare: "スタンダード",
        basicFetchedAt: "2026-09-30T16:00:00.000Z",
      })],
      // receipt pages が実 custody を含まない → 対応不一致で HOLD。
      ["622A", ev("622A", {
        marketBare: "スタンダード",
        reviewedPins: {
          entrySha: "e".repeat(64),
          searchSha: "f".repeat(64),
          rawSha: "a".repeat(64),
          custodyPageIds: ["other"],
        },
      })],
    ]);
    const plan = planOverlayDeltas(b, byCode);
    const byCodeOut = new Map(plan.listingInserts.map((l) => [l.code, l.market]));
    expect(byCodeOut.get("618A")).toBe("グロース（内国株式）");
    expect(byCodeOut.get("619A")).toBeNull();
    expect(byCodeOut.get("622A")).toBeNull();
  });

  it("存在しない暦日 (9/31) は両 basis で HOLD する (正規化受入禁止)", async () => {
    const { DEFS_COUNTRY_GUIDE, DEFS_ORDINARY_CODE } = await import(
      "../shared/jpx/basic-profile.js"
    );
    type Ev = import("../shared/jpx/basic-profile.js").BasicProfileEvidence;
    const byCode = new Map<string, OverlayExistingRow>();
    const b = batch("2026-09-30");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    const ev = (
      code: string,
      basis: "current-owner-qualified" | "current-observation",
      marketBare: string
    ): Ev => ({
      code4: code,
      code5: `${code}0`,
      isin: "JP9999999999",
      marketBare,
      countryCell: null,
      sector: "サービス業",
      entryFetchedAt: "2026-09-31T00:00:00.000Z",
      searchFetchedAt: "2026-09-31T00:00:00.000Z",
      basicFetchedAt: "2026-09-31T00:00:00.000Z",
      entrySha: "e".repeat(64),
      searchSha: "f".repeat(64),
      rawSha: "a".repeat(64),
      sourceUrl: "u",
      defsPins: {
        countryGuide: DEFS_COUNTRY_GUIDE.sha256,
        ordinaryCode: DEFS_ORDINARY_CODE.sha256,
      },
      custody: { pageId: "p" },
      boundEventsFetchedAt: "2026-09-30T00:00:00.000Z",
      qualificationDate: "2026-09-30",
      qualificationBasis: basis,
      datedSourcePin: null,
      reviewedPins: {
        entrySha: "e".repeat(64),
        searchSha: "f".repeat(64),
        rawSha: "a".repeat(64),
        custodyPageIds: ["p"],
      },
    });
    b.basics = new Map([
      ["618A", ev("618A", "current-owner-qualified", "グロース")],
      ["619A", ev("619A", "current-observation", "スタンダード")],
    ]);
    const plan = planOverlayDeltas(b, byCode);
    const byCodeOut = new Map(plan.listingInserts.map((l) => [l.code, l.market]));
    expect(byCodeOut.get("618A")).toBeNull();
    expect(byCodeOut.get("619A")).toBeNull();
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

  it("base 未確定 (null) なら reuse/collect 前に bootstrap HOLD (STOP)", async () => {
    // state 不在 (prod 初期相当): collect せず OverlayHoldError。
    const collect = vi.fn();
    const err = await ensureUniverseOverlay(memDb() as never, {
      eligibilityAsOf: "2026-09-29",
      collect,
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(OverlayHoldError);
    expect((err as OverlayHoldError).codes).toEqual([]);
    expect((err as Error).message).toContain("bootstrap HOLD");
    expect(collect).not.toHaveBeenCalled();
    // base NULL の state 行があっても同じ (不在と同値)。
    sqlite.exec("INSERT INTO universe_overlay_state (id) VALUES (1)");
    const collect2 = vi.fn();
    const err2 = await ensureUniverseOverlay(memDb() as never, {
      eligibilityAsOf: "2026-09-29",
      collect: collect2,
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err2).toBeInstanceOf(OverlayHoldError);
    expect((err2 as Error).message).toContain("bootstrap HOLD");
    expect(collect2).not.toHaveBeenCalled();
  });

  it("elig 一致でも世代 tuple 不完全なら HOLD (不完全失敗)", async () => {
    sqlite.exec(
      `INSERT INTO universe_overlay_state (id, base_as_of, eligibility_as_of) VALUES (1, '2026-08-31', '2026-09-29')`
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

  it("接続 2transfer + state 書込失敗 → retry は chain resume で成功する (BLOCKER 回帰)", async () => {
    const { universeOverlayState } = await import("../shared/db/universe-events.js");
    sqlite
      .prepare("INSERT INTO core_stocks (code, name, market, is_active) VALUES (?, ?, ?, 1)")
      .run("3000", "x", "グロース（内国株式）");
    // bootstrap base は確定済み (本 test は chain resume が対象。base なしは別 test)。
    sqlite.exec("INSERT INTO universe_overlay_state (id, base_as_of) VALUES (1, '2026-08-31')");
    const b = batch("2026-09-29");
    b.sources.delisted.rows = [];
    b.sources.newListings.rows = [];
    b.sources.transfers.rows = [
      { code: "3000", companyName: "x", effectiveDate: "2026-09-10", fromMarket: "グロース", toMarket: "スタンダード", note: "" },
      { code: "3000", companyName: "x", effectiveDate: "2026-09-20", fromMarket: "スタンダード", toMarket: "プライム", note: "" },
    ];
    // run1: state 書込だけ落とす fault 注入 db。
    const db1 = memDb() as unknown as { insert: (t: unknown) => unknown };
    const realInsert = (db1.insert as (t: unknown) => unknown).bind(db1);
    db1.insert = ((t: unknown) =>
      t === universeOverlayState
        ? {
            values: () => ({
              onConflictDoUpdate: async () => {
                throw new Error("state write boom");
              },
            }),
          }
        : realInsert(t)) as (t: unknown) => unknown;
    const boom = await ensureUniverseOverlay(db1 as never, {
      eligibilityAsOf: "2026-09-29",
      collect: vi.fn().mockResolvedValue(b),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect((boom as Error).message).toBe("state write boom");
    // partial: core は最終 C まで進むが世代 tuple は未確定 (base のみ)。
    const mid = sqlite.prepare("SELECT market FROM core_stocks WHERE code='3000'").get() as { market: string };
    expect(mid.market).toBe("プライム（内国株式）");
    const midState = sqlite.prepare("SELECT eligibility_as_of, events_fetched_at FROM universe_overlay_state WHERE id=1").get() as {
      eligibility_as_of: string | null;
      events_fetched_at: string | null;
    };
    expect(midState.eligibility_as_of).toBeNull();
    expect(midState.events_fetched_at).toBeNull();
    // run2 (retry): 未確定世代は reuse せず再適用し、chain resume で成功する。
    const out = await ensureUniverseOverlay(memDb() as never, {
      eligibilityAsOf: "2026-09-29",
      collect: vi.fn().mockResolvedValue(b),
    });
    expect(out.applied).toBe(true);
    expect(out.result?.stateCommitted).toBe(true);
    expect(out.result?.marketUpdated).toBe(0);
    expect(out.result?.skipped.transferAlreadyReflected).toBe(2);
    const st = sqlite.prepare("SELECT eligibility_as_of FROM universe_overlay_state WHERE id=1").get() as {
      eligibility_as_of: string;
    };
    expect(st.eligibility_as_of).toBe("2026-09-29");
  });

  it("HOLD IPO は INSERT しない / helper は equity で INSERT し同サイクル SELECT に載る", async () => {
    const { activeEquityCondition } = await import("../shared/db/active-equity.js");
    const { stocks } = await import("../shared/db/core-schema.js");
    const { insertCoreStocks } = await import("./universe.js");
    const hold = batch("2026-09-29");
    hold.sources.delisted.rows = [];
    hold.sources.transfers.rows = [];
    hold.sources.newListings.rows = hold.sources.newListings.rows.slice(0, 1);
    const resHold = await applyUniverseOverlay(memDb() as never, hold, []);
    expect(resHold.listed).toBe(0);
    expect(resHold.heldListingCodes).toEqual(["618A"]);
    const nHold = sqlite.prepare("SELECT COUNT(*) AS n FROM core_stocks").get() as { n: number };
    expect(nHold.n).toBe(0);
    // 正分類済み行 (full-form market) は helper が equity で INSERT する。
    // planner の market:null HOLD 政策は不変 (producer 接続は Root の source grant 待ち)。
    const src = hold.sources.newListings.rows[0];
    const classified = { code: src.code, name: src.companyName, market: "グロース（内国株式）" };
    await insertCoreStocks(memDb() as never, [classified]);
    await insertCoreStocks(memDb() as never, [classified]);
    const nReady = sqlite.prepare("SELECT COUNT(*) AS n FROM core_stocks").get() as { n: number };
    expect(nReady.n).toBe(1);
    const raw = sqlite.prepare("SELECT instrument_type, sector, is_yutai FROM core_stocks WHERE code='618A'").get() as {
      instrument_type: string;
      sector: null;
      is_yutai: number;
    };
    expect(raw.instrument_type).toBe("equity");
    expect(raw.sector).toBeNull();
    expect(raw.is_yutai).toBe(0);
    // 同サイクル: 共通述語で SELECT (値は select しない。code のみ)。
    const rows = await (memDb() as never as {
      select: (c: unknown) => { from: (t: unknown) => { where: (w: unknown) => Promise<{ code: string }[]> } };
    })
      .select({ code: stocks.code })
      .from(stocks)
      .where(activeEquityCondition());
    expect(rows.map((r) => r.code)).toEqual(["618A"]);
  });

  it("証拠あり IPO は full-form で INSERT される (sector は NULL のまま)", async () => {
    const { DEFS_COUNTRY_GUIDE, DEFS_ORDINARY_CODE } = await import(
      "../shared/jpx/basic-profile.js"
    );
    const b = batch("2026-09-29");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    b.sources.newListings.rows = b.sources.newListings.rows.slice(0, 1);
    b.basics = new Map([
      [
        "618A",
        {
          code4: "618A",
          code5: "618A0",
          isin: "JP3306480009",
          marketBare: "グロース",
          countryCell: null,
          sector: "サービス業",
          basicFetchedAt: "2026-09-30T01:00:00.000Z",
          entryFetchedAt: "2026-09-30T01:00:00.000Z",
          searchFetchedAt: "2026-09-30T01:00:00.000Z",
          entrySha: "e".repeat(64),
          searchSha: "f".repeat(64),
          rawSha: "a".repeat(64),
          sourceUrl: "u",
          defsPins: {
            countryGuide: DEFS_COUNTRY_GUIDE.sha256,
            ordinaryCode: DEFS_ORDINARY_CODE.sha256,
          },
          custody: { pageId: "p" },
          boundEventsFetchedAt: "2026-09-30T00:00:00.000Z",
          qualificationDate: "2026-09-29",
          qualificationBasis: "current-owner-qualified",
          datedSourcePin: null,
          reviewedPins: {
            entrySha: "e".repeat(64),
            searchSha: "f".repeat(64),
            rawSha: "a".repeat(64),
            custodyPageIds: ["p"],
          },
        },
      ],
    ]);
    const res = await applyUniverseOverlay(memDb() as never, b, []);
    expect(res.listed).toBe(1);
    expect(res.heldListingCodes).toEqual([]);
    const row = sqlite
      .prepare("SELECT market, sector, instrument_type FROM core_stocks WHERE code='618A'")
      .get() as { market: string; sector: null; instrument_type: string };
    expect(row.market).toBe("グロース（内国株式）");
    expect(row.sector).toBeNull();
    expect(row.instrument_type).toBe("equity");
  });

  it("同日再入でも HOLD 残があれば no-op 正常にしない (BLOCKER 回帰)", async () => {
    sqlite.exec(
      `INSERT INTO universe_overlay_state (id, base_as_of, eligibility_as_of, events_fetched_at, held_listing_codes)
       VALUES (1, '2026-08-31', '2026-09-29', 'GEN-HOLD', '["618A","646A"]')`
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
      instrumentType: "equity",
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
    // 既知 base: collect へ base 8/31 が渡り適用へ進む (known-base positive)。
    sqlite.exec("INSERT INTO universe_overlay_state (id, base_as_of) VALUES (1, '2026-08-31')");
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
    expect(collect).toHaveBeenCalledWith({
      baseAsOf: "2026-08-31",
      eligibilityAsOf: "2026-09-29",
      skipBasicsFor: new Set(["1948"]),
    });
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

  it("no-map current-observation は insert され active-equity 到達可能になる", async () => {
    const { DEFS_COUNTRY_GUIDE, DEFS_ORDINARY_CODE } = await import(
      "../shared/jpx/basic-profile.js"
    );
    const b = batch("2026-09-30");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    b.sources.newListings.rows = b.sources.newListings.rows.slice(0, 1);
    const fb = fakeBasic(
      "618A",
      "グロース",
      {
        countryGuide: DEFS_COUNTRY_GUIDE.sha256,
        ordinaryCode: DEFS_ORDINARY_CODE.sha256,
      },
      "2026-09-30T06:31:00.000Z"
    );
    const { record, listFiles, downloadBytes } = verifyMocks();
    const collect = withBasicEvidence(async () => b, {
      collectBasic: (async () => fb) as never,
      record: record as never,
      listFiles: listFiles as never,
      downloadBytes: downloadBytes as never,
    });
    const out = await collect({ baseAsOf: null, eligibilityAsOf: "2026-09-30" });
    const ev = out.basics?.get("618A");
    expect(ev?.qualificationDate).toBe("2026-09-30");
    expect(ev?.qualificationBasis).toBe("current-observation");
    // receipt 3SHA は got の 3 段 SHA と一致する (format-only ではない)。
    expect(ev?.reviewedPins?.entrySha).toBe(fb.entry.sha256);
    expect(ev?.reviewedPins?.searchSha).toBe(fb.search.sha256);
    expect(ev?.reviewedPins?.rawSha).toBe(fb.basic.sha256);
    expect(ev?.reviewedPins?.custodyPageIds).toEqual([ev?.custody?.pageId]);
    const result = await applyUniverseOverlay(memDb() as never, out, []);
    expect(result.listed).toBe(1);
    expect(result.heldListingCodes).toEqual([]);
    const rows = sqlite
      .prepare(
        "SELECT code, market, sector, sector33, is_active, instrument_type, is_yutai FROM core_stocks"
      )
      .all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      code: "618A",
      market: "グロース（内国株式）",
      sector: null,
      sector33: null,
      is_active: 1,
      instrument_type: "equity",
      is_yutai: 0,
    });
    // 共通 active-equity 述語で到達できる (同一 sqlite 上の再 wrapper)。
    const hit = await memDb()
      .select({ code: stocks.code })
      .from(stocks)
      .where(activeEquityCondition());
    expect(hit).toEqual([{ code: "618A" }]);
  });

  it("実 collectBasicProfile (ticking 時計・FULL 実 HTML) → no-map → insert される", async () => {
    const { collectBasicProfile } = await import(
      "../shared/jpx/basic-profile.js"
    );
    const fx = join(
      dirname(fileURLToPath(import.meta.url)),
      "../shared/jpx/__fixtures__"
    );
    // FULL 実 raw (sid のみ REDACTED)。抜粋では検出できない
    // 無関係レイアウト表の ragged (table#18) を含む。
    const pages = [
      readFileSync(join(fx, "basic-full-r1-entry.html"), "utf-8"),
      readFileSync(join(fx, "basic-full-r2-search.html"), "utf-8"),
      readFileSync(join(fx, "basic-full-r3-basic.html"), "utf-8"),
    ];
    // 実時計の ms 進行を模す ticking clock (JST 9/30 15:31 起点)。
    const t0 = Date.parse("2026-09-30T06:31:00.000Z");
    let tick = 0;
    const deps = {
      nowIso: () => new Date(t0 + tick++).toISOString(),
    };
    let n = 0;
    const roundTrip = async () => {
      const text = pages[n++];
      return {
        status: 200,
        location: null,
        // fixture の form action sid (REDACTED) と一致させる。
        setCookies: ["JSESSIONID=REDACTED; Path=/; HttpOnly"],
        bytes: enc.encode(text),
        text,
      };
    };
    const b = batch("2026-09-30");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    // fixture は 621A (9/16・グロース) の S2 実 raw 抜粋。
    b.sources.newListings.rows = b.sources.newListings.rows.slice(2, 3);
    expect(b.sources.newListings.rows[0]?.code).toBe("621A");
    const { record, listFiles, downloadBytes } = verifyMocks();
    const collect = withBasicEvidence(async () => b, {
      collectBasic: ((code: string) =>
        collectBasicProfile(code, {
          roundTrip: roundTrip as never,
          nowIso: deps.nowIso,
        })) as never,
      record: record as never,
      listFiles: listFiles as never,
      downloadBytes: downloadBytes as never,
    });
    const out = await collect({ baseAsOf: null, eligibilityAsOf: "2026-09-30" });
    const ev = out.basics?.get("621A");
    // ticking 下でも seam 一致し current-observation が載る。
    expect(ev?.qualificationDate).toBe("2026-09-30");
    expect(ev?.qualificationBasis).toBe("current-observation");
    expect(ev?.reviewedPins?.rawSha).toBe(ev?.rawSha);
    const result = await applyUniverseOverlay(memDb() as never, out, []);
    expect(result.listed).toBe(1);
    expect(result.heldListingCodes).toEqual([]);
    const row = sqlite
      .prepare(
        "SELECT market, sector, is_active, instrument_type FROM core_stocks WHERE code='621A'"
      )
      .get() as {
      market: string;
      sector: null;
      is_active: number;
      instrument_type: string;
    };
    expect(row.market).toBe("グロース（内国株式）");
    expect(row.sector).toBeNull();
    expect(row.is_active).toBe(1);
    expect(row.instrument_type).toBe("equity");
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

const enc = new TextEncoder();
function fakeBasic(
  code: string,
  marketBare: string,
  pins?: { countryGuide: string; ordinaryCode: string },
  fetchedAt?: string
) {
  const ts = fetchedAt ?? "2026-09-30T01:00:00.000Z";
  const evidence = {
    code4: code,
    code5: `${code}0`,
    isin: "JP9999999999",
    marketBare,
    countryCell: null,
    sector: "サービス業",
    entryFetchedAt: ts,
    searchFetchedAt: ts,
    basicFetchedAt: ts,
    entrySha: "e".repeat(64),
    searchSha: "f".repeat(64),
    rawSha: "a".repeat(64),
    sourceUrl: "u",
    defsPins: pins ?? { countryGuide: "cg", ordinaryCode: "oc" },
    custody: null,
    boundEventsFetchedAt: null,
    qualificationDate: null,
    qualificationBasis: null,
    datedSourcePin: null,
    reviewedPins: null,
  };
  const mk = (tag: string, sha256: string) => ({
    url: "u",
    fetchedAt: ts,
    status: 200,
    bytes: enc.encode(`${code}-${tag}`),
    sha256,
  });
  return {
    entry: mk("r1", "e".repeat(64)),
    search: mk("r2", "f".repeat(64)),
    basic: mk("r3", "a".repeat(64)),
    evidence,
  };
}
// record → listFiles → downloadBytes の一貫 mock (readback が通る形)。
function verifyMocks() {
  const stored = new Map<string, { filename: string; bytes: Uint8Array }[]>();
  const record = vi.fn(async (input: {
    key: string;
    files: { filename: string; bytes: Uint8Array }[];
  }) => {
    stored.set(input.key, input.files);
    return {
      pageId: `pg-${input.key}`,
      outcome: "recorded",
      fileTooLarge: false,
      manifestMatch: "written",
    };
  });
  const listFiles = vi.fn(async (pageId: string) => {
    const key = pageId.replace(/^pg-/, "");
    return (stored.get(key) ?? []).map((f) => ({
      name: f.filename,
      kind: "file",
      url: `u:${key}:${f.filename}`,
    }));
  });
  const downloadBytes = vi.fn(async (url: string) => {
    const [, key, ...rest] = url.split(":");
    const name = rest.join(":");
    const file = (stored.get(key) ?? []).find((f) => f.filename === name);
    if (file === undefined) throw new Error(`no such file ${url}`);
    return file.bytes;
  });
  return { record, listFiles, downloadBytes };
}

describe("withBasicEvidence", () => {
  it("eligible 行のみ取得・保管+readback して batch.basics に束縛する", async () => {
    const b = batch("2026-09-29");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    b.sources.newListings.rows = b.sources.newListings.rows.slice(0, 2);
    const collectBasic = vi.fn(async (code: string) => fakeBasic(code, "グロース"));
    const { record, listFiles, downloadBytes } = verifyMocks();
    const collect = withBasicEvidence(async () => b, {
      collectBasic: collectBasic as never,
      record: record as never,
      listFiles: listFiles as never,
      downloadBytes: downloadBytes as never,
    });
    const out = await collect({ baseAsOf: null, eligibilityAsOf: "2026-09-29" });
    // slice(0,2) = 618A (9/11) + 619A (9/16)。どちらも eligible。
    expect(collectBasic).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(2);
    // key は rawSHA+世代を束縛する。
    const key0 = (record.mock.calls[0][0] as { key: string }).key;
    expect(key0).toContain("20260930000000");
    expect(key0).toContain("a".repeat(12));
    const ev = out.basics?.get("618A");
    expect(ev?.custody?.pageId).toContain("pg-basic-618A");
    expect(ev?.boundEventsFetchedAt).toBe("2026-09-30T00:00:00.000Z");
    // reviewed input なし → qualification null (= HOLD)。
    expect(ev?.qualificationDate).toBeNull();
    expect(ev?.qualificationBasis).toBeNull();
    expect(ev?.datedSourcePin).toBeNull();
    expect(downloadBytes.mock.calls.length).toBe(6);
  });

  it("未来・収録済み・delist 阻止は取得しない", async () => {
    const b = batch("2026-09-29");
    b.sources.transfers.rows = [];
    b.sources.delisted.rows = [
      delistedRow("627A", "2026-09-20", "x", "スタンダード"),
    ];
    const collectBasic = vi.fn(async (code: string) => fakeBasic(code, "グロース"));
    const { record, listFiles, downloadBytes } = verifyMocks();
    const collect = withBasicEvidence(async () => b, {
      collectBasic: collectBasic as never,
      record: record as never,
      listFiles: listFiles as never,
      downloadBytes: downloadBytes as never,
    });
    const out = await collect({
      baseAsOf: null,
      eligibilityAsOf: "2026-09-29",
      skipBasicsFor: new Set(["618A"]),
    });
    const got = collectBasic.mock.calls.map((c) => c[0] as string);
    // 618A=収録済み skip、627A=delist 阻止 skip、652A/653A=未来 skip。
    expect(got.sort()).toEqual(
      ["619A", "621A", "622A", "623A", "625A", "634A", "646A"].sort()
    );
    expect(out.basics?.has("618A")).toBe(false);
    expect(out.basics?.has("627A")).toBe(false);
  });

  it("1 社の取得失敗は warn + 省略 (HOLD へ)", async () => {
    const b = batch("2026-09-29");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    b.sources.newListings.rows = b.sources.newListings.rows.slice(0, 1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const collect = withBasicEvidence(async () => b, {
        collectBasic: (async () => {
          throw new Error("boom");
        }) as never,
        record: (async () => {
          throw new Error("must not record");
        }) as never,
        listFiles: (async () => []) as never,
        downloadBytes: (async () => new Uint8Array()) as never,
      });
      const out = await collect({ baseAsOf: null, eligibilityAsOf: "2026-09-29" });
      expect(out.basics?.size).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("partial 得済み raw は保管してから省略する (黙殺禁止)", async () => {
    const b = batch("2026-09-29");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    b.sources.newListings.rows = b.sources.newListings.rows.slice(0, 1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fb = fakeBasic("618A", "グロース");
      const err = Object.assign(new Error("R3 down"), {
        partial: { entry: fb.entry, search: fb.search },
      });
      const { record, listFiles, downloadBytes } = verifyMocks();
      const collect = withBasicEvidence(async () => b, {
        collectBasic: (async () => {
          throw err;
        }) as never,
        record: record as never,
        listFiles: listFiles as never,
        downloadBytes: downloadBytes as never,
      });
      const out = await collect({ baseAsOf: null, eligibilityAsOf: "2026-09-29" });
      expect(out.basics?.size).toBe(0);
      expect(record).toHaveBeenCalledTimes(1);
      const key = (record.mock.calls[0][0] as { key: string }).key;
      expect(key).toContain("-partial");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("保管 readback 不一致は loud STOP", async () => {
    const b = batch("2026-09-29");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    b.sources.newListings.rows = b.sources.newListings.rows.slice(0, 1);
    const collect = withBasicEvidence(async () => b, {
      collectBasic: (async (code: string) => fakeBasic(code, "グロース")) as never,
      record: (async () => ({
        pageId: "pg",
        outcome: "recorded",
        fileTooLarge: false,
        manifestMatch: "written",
      })) as never,
      listFiles: (async () => []) as never,
      downloadBytes: (async () => new Uint8Array()) as never,
    });
    await expect(
      collect({ baseAsOf: null, eligibilityAsOf: "2026-09-29" })
    ).rejects.toThrow(/readback 照合に失敗/);
  });

  it("reviewed input がある code のみ qualification を stamp する", async () => {
    const b = batch("2026-09-29");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    b.sources.newListings.rows = b.sources.newListings.rows.slice(0, 2);
    const collectBasic = vi.fn(async (code: string) => fakeBasic(code, "グロース"));
    const { record, listFiles, downloadBytes } = verifyMocks();
    const pins = {
      entrySha: "e".repeat(64),
      searchSha: "f".repeat(64),
      rawSha: "a".repeat(64),
      custodyPageIds: ["pg-reviewed"],
    };
    const collect = withBasicEvidence(async () => b, {
      collectBasic: collectBasic as never,
      record: record as never,
      listFiles: listFiles as never,
      downloadBytes: downloadBytes as never,
      qualificationInput: new Map([
        [
          "618A",
          {
            date: "2026-09-30",
            basis: "current-owner-qualified" as const,
            marketBare: "グロース",
            receiptPins: pins,
          },
        ],
        // 619A: market 不一致 → stamp しない。
        [
          "619A",
          {
            date: "2026-09-30",
            basis: "current-owner-qualified" as const,
            marketBare: "スタンダード",
            receiptPins: pins,
          },
        ],
      ]),
    });
    const out = await collect({ baseAsOf: null, eligibilityAsOf: "2026-09-29" });
    // 日付は requested elig (9/29) ではなく reviewed 指定 (9/30) が載る。
    expect(out.basics?.get("618A")?.qualificationDate).toBe("2026-09-30");
    expect(out.basics?.get("618A")?.qualificationBasis).toBe(
      "current-owner-qualified"
    );
    expect(out.basics?.get("618A")?.reviewedPins?.rawSha).toBe("a".repeat(64));
    expect(out.basics?.get("619A")?.qualificationDate).toBeNull();
  });

  it("receipt pins 不一致は stamp しない (stale 印流用防止)", async () => {
    const b = batch("2026-09-29");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    b.sources.newListings.rows = b.sources.newListings.rows.slice(0, 1);
    const collectBasic = vi.fn(async (code: string) => fakeBasic(code, "グロース"));
    const { record, listFiles, downloadBytes } = verifyMocks();
    const collect = withBasicEvidence(async () => b, {
      collectBasic: collectBasic as never,
      record: record as never,
      listFiles: listFiles as never,
      downloadBytes: downloadBytes as never,
      qualificationInput: new Map([
        [
          "618A",
          {
            date: "2026-09-30",
            basis: "current-owner-qualified" as const,
            marketBare: "グロース",
            receiptPins: {
              entrySha: "e".repeat(64),
              searchSha: "f".repeat(64),
              rawSha: "b".repeat(64),
              custodyPageIds: ["pg-reviewed"],
            },
          },
        ],
      ]),
    });
    const out = await collect({ baseAsOf: null, eligibilityAsOf: "2026-09-29" });
    // market 一致でも R3 SHA 不一致 → null。
    expect(out.basics?.get("618A")?.qualificationDate).toBeNull();
    expect(out.basics?.get("618A")?.reviewedPins).toBeNull();
    // custody/bound は付く (HOLD 対象として保全済み)。
    expect(out.basics?.get("618A")?.custody).not.toBeNull();
  });

  it("normal fresh 取得 + historic 9/29 cycle は HOLD (current 9/30 入力の流用不可)", async () => {
    const { DEFS_COUNTRY_GUIDE, DEFS_ORDINARY_CODE } = await import(
      "../shared/jpx/basic-profile.js"
    );
    const b = batch("2026-09-29");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    b.sources.newListings.rows = b.sources.newListings.rows.slice(0, 1);
    // 定義 pins は正規品にし、日付だけを historic 不一致にする。
    const collectBasic = vi.fn(async (code: string) =>
      fakeBasic(code, "グロース", {
        countryGuide: DEFS_COUNTRY_GUIDE.sha256,
        ordinaryCode: DEFS_ORDINARY_CODE.sha256,
      })
    );
    const { record, listFiles, downloadBytes } = verifyMocks();
    const collect = withBasicEvidence(async () => b, {
      collectBasic: collectBasic as never,
      record: record as never,
      listFiles: listFiles as never,
      downloadBytes: downloadBytes as never,
      qualificationInput: new Map([
        [
          "618A",
          {
            date: "2026-09-30",
            basis: "current-owner-qualified" as const,
            marketBare: "グロース",
            receiptPins: {
              entrySha: "e".repeat(64),
              searchSha: "f".repeat(64),
              rawSha: "a".repeat(64),
              custodyPageIds: ["pg-reviewed"],
            },
          },
        ],
      ]),
    });
    // fresh 取得は成功するが、9/30 stamp は 9/29 batch を qualify しない。
    const out = await collect({ baseAsOf: null, eligibilityAsOf: "2026-09-29" });
    expect(out.basics?.get("618A")?.qualificationDate).toBe("2026-09-30");
    const plan = planOverlayDeltas(out, new Map());
    expect(
      plan.listingInserts.find((l) => l.code === "618A")?.market
    ).toBeNull();
  });

  it("no-map 同 JST 日の実証拠は current-observation を stamp する (15:31 JST)", async () => {
    const { DEFS_COUNTRY_GUIDE, DEFS_ORDINARY_CODE } = await import(
      "../shared/jpx/basic-profile.js"
    );
    const b = batch("2026-09-30");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    b.sources.newListings.rows = b.sources.newListings.rows.slice(0, 1);
    const collectBasic = vi.fn(async (code: string) =>
      fakeBasic(
        code,
        "グロース",
        {
          countryGuide: DEFS_COUNTRY_GUIDE.sha256,
          ordinaryCode: DEFS_ORDINARY_CODE.sha256,
        },
        "2026-09-30T06:31:00.000Z"
      )
    );
    const { record, listFiles, downloadBytes } = verifyMocks();
    const collect = withBasicEvidence(async () => b, {
      collectBasic: collectBasic as never,
      record: record as never,
      listFiles: listFiles as never,
      downloadBytes: downloadBytes as never,
    });
    const out = await collect({ baseAsOf: null, eligibilityAsOf: "2026-09-30" });
    const ev = out.basics?.get("618A");
    expect(ev?.qualificationDate).toBe("2026-09-30");
    expect(ev?.qualificationBasis).toBe("current-observation");
    expect(ev?.reviewedPins).toMatchObject({
      entrySha: "e".repeat(64),
      searchSha: "f".repeat(64),
      rawSha: "a".repeat(64),
    });
    expect(ev?.reviewedPins?.custodyPageIds).toEqual([ev?.custody?.pageId]);
  });

  it("UTC 前日/JST 当日は JST 暦で stamp する (UTC slice 禁止の証明)", async () => {
    const { DEFS_COUNTRY_GUIDE, DEFS_ORDINARY_CODE } = await import(
      "../shared/jpx/basic-profile.js"
    );
    const b = batch("2026-09-30");
    // 世代も JST 9/30 (UTC 9/29 15:00)。basic は UTC 前日・JST 当日。
    b.eventsFetchedAt = "2026-09-29T15:00:00.000Z";
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    b.sources.newListings.rows = b.sources.newListings.rows.slice(0, 1);
    const collectBasic = vi.fn(async (code: string) =>
      fakeBasic(
        code,
        "グロース",
        {
          countryGuide: DEFS_COUNTRY_GUIDE.sha256,
          ordinaryCode: DEFS_ORDINARY_CODE.sha256,
        },
        "2026-09-29T15:31:00.000Z"
      )
    );
    const { record, listFiles, downloadBytes } = verifyMocks();
    const collect = withBasicEvidence(async () => b, {
      collectBasic: collectBasic as never,
      record: record as never,
      listFiles: listFiles as never,
      downloadBytes: downloadBytes as never,
    });
    const out = await collect({ baseAsOf: null, eligibilityAsOf: "2026-09-30" });
    // UTC 日 (9/29) ではなく JST 日 (9/30) が載る。
    expect(out.basics?.get("618A")?.qualificationDate).toBe("2026-09-30");
    expect(out.basics?.get("618A")?.qualificationBasis).toBe(
      "current-observation"
    );
  });

  it("basicFetchedAt の ISO 不正は stamp しない (HOLD)", async () => {
    const { DEFS_COUNTRY_GUIDE, DEFS_ORDINARY_CODE } = await import(
      "../shared/jpx/basic-profile.js"
    );
    const b = batch("2026-09-30");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    b.sources.newListings.rows = b.sources.newListings.rows.slice(0, 1);
    const collectBasic = vi.fn(async (code: string) =>
      fakeBasic(
        code,
        "グロース",
        {
          countryGuide: DEFS_COUNTRY_GUIDE.sha256,
          ordinaryCode: DEFS_ORDINARY_CODE.sha256,
        },
        "2026-09-30 06:31 JST"
      )
    );
    const { record, listFiles, downloadBytes } = verifyMocks();
    const collect = withBasicEvidence(async () => b, {
      collectBasic: collectBasic as never,
      record: record as never,
      listFiles: listFiles as never,
      downloadBytes: downloadBytes as never,
    });
    const out = await collect({ baseAsOf: null, eligibilityAsOf: "2026-09-30" });
    expect(collectBasic).toHaveBeenCalledTimes(1);
    expect(out.basics?.get("618A")?.qualificationDate).toBeNull();
    expect(out.basics?.get("618A")?.qualificationBasis).toBeNull();
  });

  it("historic elig への現行観測は stamp しない (HOLD・過去流用不可)", async () => {
    const { DEFS_COUNTRY_GUIDE, DEFS_ORDINARY_CODE } = await import(
      "../shared/jpx/basic-profile.js"
    );
    const b = batch("2026-09-15");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    b.sources.newListings.rows = b.sources.newListings.rows.slice(0, 1);
    const collectBasic = vi.fn(async (code: string) =>
      fakeBasic(
        code,
        "グロース",
        {
          countryGuide: DEFS_COUNTRY_GUIDE.sha256,
          ordinaryCode: DEFS_ORDINARY_CODE.sha256,
        },
        "2026-09-30T06:31:00.000Z"
      )
    );
    const { record, listFiles, downloadBytes } = verifyMocks();
    const collect = withBasicEvidence(async () => b, {
      collectBasic: collectBasic as never,
      record: record as never,
      listFiles: listFiles as never,
      downloadBytes: downloadBytes as never,
    });
    // 618A (9/11) は 9/15 で eligible のため取得は走るが stamp しない。
    const out = await collect({ baseAsOf: null, eligibilityAsOf: "2026-09-15" });
    expect(collectBasic).toHaveBeenCalledTimes(1);
    expect(out.basics?.get("618A")?.qualificationDate).toBeNull();
    expect(out.basics?.get("618A")?.qualificationBasis).toBeNull();
  });

  it("R3 が JST 翌日に跨いだ elig 前日 cycle は stamp しない (HOLD)", async () => {
    const { DEFS_COUNTRY_GUIDE, DEFS_ORDINARY_CODE } = await import(
      "../shared/jpx/basic-profile.js"
    );
    const b = batch("2026-09-29");
    // 世代を遡らせ時刻証明は通過させ、JST 暦不一致のみで HOLD させる。
    b.eventsFetchedAt = "2026-09-29T00:00:00.000Z";
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    b.sources.newListings.rows = b.sources.newListings.rows.slice(0, 1);
    const collectBasic = vi.fn(async (code: string) =>
      fakeBasic(
        code,
        "グロース",
        {
          countryGuide: DEFS_COUNTRY_GUIDE.sha256,
          ordinaryCode: DEFS_ORDINARY_CODE.sha256,
        },
        "2026-09-29T15:05:00.000Z"
      )
    );
    const { record, listFiles, downloadBytes } = verifyMocks();
    const collect = withBasicEvidence(async () => b, {
      collectBasic: collectBasic as never,
      record: record as never,
      listFiles: listFiles as never,
      downloadBytes: downloadBytes as never,
    });
    // R3 = JST 9/30 00:05。elig 9/29 と異日のため HOLD。
    const out = await collect({ baseAsOf: null, eligibilityAsOf: "2026-09-29" });
    expect(collectBasic).toHaveBeenCalledTimes(1);
    expect(out.basics?.get("618A")?.qualificationDate).toBeNull();
    expect(out.basics?.get("618A")?.qualificationBasis).toBeNull();
  });

  it("seam 主張と got の不一致は両 basis とも stamp しない (上書きなし HOLD)", async () => {
    const { DEFS_COUNTRY_GUIDE, DEFS_ORDINARY_CODE } = await import(
      "../shared/jpx/basic-profile.js"
    );
    const b = batch("2026-09-30");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    b.sources.newListings.rows = b.sources.newListings.rows.slice(0, 1);
    const fb = fakeBasic(
      "618A",
      "グロース",
      {
        countryGuide: DEFS_COUNTRY_GUIDE.sha256,
        ordinaryCode: DEFS_ORDINARY_CODE.sha256,
      },
      "2026-09-30T06:31:00.000Z"
    );
    // seam 主張だけを歪める (got 実物は正規のまま)。
    fb.evidence.rawSha = "c".repeat(64);
    fb.evidence.basicFetchedAt = "2026-09-30T07:31:00.000Z";
    const { record, listFiles, downloadBytes } = verifyMocks();
    const collect = withBasicEvidence(async () => b, {
      collectBasic: (async () => fb) as never,
      record: record as never,
      listFiles: listFiles as never,
      downloadBytes: downloadBytes as never,
      // got に一致する reviewed 入力があっても seam 不一致で拒否する。
      qualificationInput: new Map([
        [
          "618A",
          {
            date: "2026-09-30",
            basis: "current-owner-qualified" as const,
            marketBare: "グロース",
            receiptPins: {
              entrySha: "e".repeat(64),
              searchSha: "f".repeat(64),
              rawSha: "a".repeat(64),
              custodyPageIds: ["pg-reviewed"],
            },
          },
        ],
      ]),
    });
    const out = await collect({ baseAsOf: null, eligibilityAsOf: "2026-09-30" });
    const ev = out.basics?.get("618A");
    expect(ev?.qualificationDate).toBeNull();
    expect(ev?.qualificationBasis).toBeNull();
    expect(ev?.reviewedPins).toBeNull();
    // custody/bound は付くが、主張値は書き換えない。
    expect(ev?.custody).not.toBeNull();
    expect(ev?.rawSha).toBe("c".repeat(64));
    expect(ev?.basicFetchedAt).toBe("2026-09-30T07:31:00.000Z");
  });

  it("custody record 失敗は loud STOP (握り潰さない)", async () => {
    const b = batch("2026-09-30");
    b.sources.delisted.rows = [];
    b.sources.transfers.rows = [];
    b.sources.newListings.rows = b.sources.newListings.rows.slice(0, 1);
    const collect = withBasicEvidence(async () => b, {
      collectBasic: (async (code: string) => fakeBasic(code, "グロース")) as never,
      record: (async () => {
        throw new Error("notion down");
      }) as never,
      listFiles: (async () => []) as never,
      downloadBytes: (async () => new Uint8Array()) as never,
    });
    await expect(
      collect({ baseAsOf: null, eligibilityAsOf: "2026-09-30" })
    ).rejects.toThrow(/notion down/);
  });
});
