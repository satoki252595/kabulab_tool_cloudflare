/**
 * 市場系 Source 修復 preflight の境界テスト (実 SQLite)。
 * 一致すれば通り、ガード対象の 1 列の書き換え・行の追加/削除では
 * SQL エラーになることを列ごとに固定する (優待の preflight ガードと同形)。
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  buildAnnualPreflightStatement,
  buildAtrPreflightStatement,
  type AnnualPreimage,
  type AtrPreimage,
} from "./repair-preflight.js";

function setupAtr(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE core_stocks (id INTEGER PRIMARY KEY, code TEXT NOT NULL, is_active INTEGER NOT NULL, instrument_type TEXT);
    CREATE TABLE swing_stock_indicators (
      stock_id INTEGER PRIMARY KEY,
      avg_turnover_20d REAL, volume_ratio REAL, atr_pct REAL,
      sma_5 REAL, sma_20 REAL, latest_close REAL, latest_date TEXT,
      volatility_ok INTEGER NOT NULL, all_passed_long INTEGER NOT NULL, all_passed_short INTEGER NOT NULL
    );
    INSERT INTO core_stocks VALUES (7, '9101', 1, 'equity');
    INSERT INTO swing_stock_indicators VALUES (7, 800000000, 1.2, 2.5, 101.0, 99.0, 102.0, '2026-09-25', 1, 0, 0);
  `);
  return db;
}

const ATR_SNAP: AtrPreimage = {
  stockId: 7,
  code: "9101",
  isActive: true,
  instrumentType: "equity",
  avgTurnover20d: 800000000,
  volumeRatio: 1.2,
  atrPct: 2.5,
  sma5: 101.0,
  sma20: 99.0,
  latestClose: 102.0,
  latestDate: "2026-09-25",
  volatilityOk: true,
  allPassedLong: false,
  allPassedShort: false,
};

function runPreflight(db: DatabaseSync, sql: string, params: readonly unknown[]): unknown {
  return db.prepare(sql).get(...(params as []));
}

describe("ATR preflight", () => {
  it("一致すれば通り (テキスト .null. を返し throw しない)", () => {
    const db = setupAtr();
    const s = buildAtrPreflightStatement(ATR_SNAP);
    const row = runPreflight(db, s.sql, s.params) as Record<string, unknown>;
    expect(Object.values(row)).toEqual(['null']);
  });

  const drifts: [string, string][] = [
    ["銘柄コードの付け替え", "UPDATE core_stocks SET code = '9102' WHERE id = 7"],
    ["active の書き換え", "UPDATE core_stocks SET is_active = 0 WHERE id = 7"],
    ["区分の書き換え", "UPDATE core_stocks SET instrument_type = 'etf' WHERE id = 7"],
    ["avgTurnover20d の書き換え", "UPDATE swing_stock_indicators SET avg_turnover_20d = 1 WHERE stock_id = 7"],
    ["volumeRatio の書き換え", "UPDATE swing_stock_indicators SET volume_ratio = 9.9 WHERE stock_id = 7"],
    ["atrPct の書き換え", "UPDATE swing_stock_indicators SET atr_pct = 0.1 WHERE stock_id = 7"],
    ["sma5 の書き換え", "UPDATE swing_stock_indicators SET sma_5 = 1 WHERE stock_id = 7"],
    ["sma20 の書き換え", "UPDATE swing_stock_indicators SET sma_20 = 1 WHERE stock_id = 7"],
    ["latestClose の書き換え", "UPDATE swing_stock_indicators SET latest_close = 1 WHERE stock_id = 7"],
    ["latestDate の書き換え", "UPDATE swing_stock_indicators SET latest_date = '2026-09-24' WHERE stock_id = 7"],
    ["volatilityOk の書き換え", "UPDATE swing_stock_indicators SET volatility_ok = 0 WHERE stock_id = 7"],
    ["allPassedLong の書き換え", "UPDATE swing_stock_indicators SET all_passed_long = 1 WHERE stock_id = 7"],
    ["allPassedShort の書き換え", "UPDATE swing_stock_indicators SET all_passed_short = 1 WHERE stock_id = 7"],
    ["入力の消失 (値→NULL)", "UPDATE swing_stock_indicators SET atr_pct = NULL WHERE stock_id = 7"],
    ["指標行の削除", "DELETE FROM swing_stock_indicators WHERE stock_id = 7"],
  ];

  it.each(drifts)("不一致 (%s) は SQL エラー", (_name, mutate) => {
    const db = setupAtr();
    db.exec(mutate);
    const s = buildAtrPreflightStatement(ATR_SNAP);
    expect(() => runPreflight(db, s.sql, s.params)).toThrow();
  });

  it("NULL 入力の銘柄は NULL のまま一致する", () => {
    const db = setupAtr();
    db.exec("UPDATE swing_stock_indicators SET atr_pct = NULL, volume_ratio = NULL WHERE stock_id = 7");
    const s = buildAtrPreflightStatement({ ...ATR_SNAP, atrPct: null, volumeRatio: null });
    const row = runPreflight(db, s.sql, s.params) as Record<string, unknown>;
    expect(Object.values(row)).toEqual(['null']);
  });
});

function setupAnnual(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE core_stocks (id INTEGER PRIMARY KEY, code TEXT NOT NULL, is_active INTEGER NOT NULL, instrument_type TEXT);
    CREATE TABLE core_stock_financials (stock_id INTEGER PRIMARY KEY, data_date TEXT NOT NULL, operating_margin REAL);
    CREATE TABLE rsi_percentile (stock_id INTEGER PRIMARY KEY, is_blue_chip INTEGER NOT NULL, revenue_trend INTEGER);
    CREATE TABLE jss_financials (code TEXT NOT NULL, fiscal_period_end TEXT NOT NULL, disclosure_type TEXT NOT NULL, consolidated TEXT NOT NULL, net_sales REAL, license_tag TEXT NOT NULL);
    INSERT INTO core_stocks VALUES (9, '9101', 1, 'equity');
    INSERT INTO core_stock_financials VALUES (9, '2026-09-25', 0.06);
    INSERT INTO rsi_percentile VALUES (9, 1, 1);
    INSERT INTO jss_financials VALUES
      ('9101', '2023-03-31', '本決算', '連結', 100.0, 'commercial-ok'),
      ('9101', '2024-03-31', '本決算', '連結', 110.0, 'commercial-ok'),
      ('9101', '2025-03-31', '本決算', '連結', 125.0, 'commercial-ok'),
      ('9101', '2025-03-31', '本決算', '単体', 90.0, 'commercial-ok'),
      ('9101', '2027-03-31', '本決算', '連結', NULL, 'commercial-ok');
  `);
  return db;
}

const ANNUAL_SNAP: AnnualPreimage = {
  stockId: 9,
  code: "9101",
  isActive: true,
  instrumentType: "equity",
  dataDate: "2026-09-25",
  operatingMargin: 0.06,
  asof: "2026-09-25",
  scope: "連結",
  series: [
    { fiscalPeriodEnd: "2023-03-31", consolidated: "連結", revenue: 100.0 },
    { fiscalPeriodEnd: "2024-03-31", consolidated: "連結", revenue: 110.0 },
    { fiscalPeriodEnd: "2025-03-31", consolidated: "連結", revenue: 125.0 },
  ],
  eligible: [
    { fiscalPeriodEnd: "2023-03-31", consolidated: "連結", revenue: 100.0 },
    { fiscalPeriodEnd: "2024-03-31", consolidated: "連結", revenue: 110.0 },
    { fiscalPeriodEnd: "2025-03-31", consolidated: "連結", revenue: 125.0 },
    { fiscalPeriodEnd: "2025-03-31", consolidated: "単体", revenue: 90.0 },
  ],
  isBlueChip: true,
  revenueTrend: 1,
};

describe("年次 preflight", () => {
  it("一致すれば通り (未来期・他 license は入力範囲外で一致)", () => {
    const db = setupAnnual();
    const s = buildAnnualPreflightStatement(ANNUAL_SNAP);
    const row = runPreflight(db, s.sql, s.params) as Record<string, unknown>;
    expect(Object.values(row)).toEqual(['null']);
  });

  const drifts: [string, string][] = [
    ["銘柄対応の付け替え", "UPDATE core_stocks SET code = '9102' WHERE id = 9"],
    ["active の書き換え (凍結破りの防止)", "UPDATE core_stocks SET is_active = 0 WHERE id = 9"],
    ["区分の書き換え", "UPDATE core_stocks SET instrument_type = 'etf' WHERE id = 9"],
    ["data_date の書き換え", "UPDATE core_stock_financials SET data_date = '2026-09-24' WHERE stock_id = 9"],
    ["operatingMargin の書き換え", "UPDATE core_stock_financials SET operating_margin = 0.01 WHERE stock_id = 9"],
    ["operatingMargin の消失", "UPDATE core_stock_financials SET operating_margin = NULL WHERE stock_id = 9"],
    ["isBlueChip の書き換え", "UPDATE rsi_percentile SET is_blue_chip = 0 WHERE stock_id = 9"],
    ["revenueTrend の書き換え", "UPDATE rsi_percentile SET revenue_trend = 0 WHERE stock_id = 9"],
    ["系列値の書き換え", "UPDATE jss_financials SET net_sales = 999 WHERE code = '9101' AND fiscal_period_end = '2024-03-31' AND consolidated = '連結'"],
    ["系列行の追加", "INSERT INTO jss_financials VALUES ('9101', '2022-03-31', '本決算', '連結', 95.0, 'commercial-ok')"],
    ["系列行の削除", "DELETE FROM jss_financials WHERE code = '9101' AND fiscal_period_end = '2023-03-31'"],
    ["系列区分の書き換え", "UPDATE jss_financials SET consolidated = '単体' WHERE code = '9101' AND fiscal_period_end = '2023-03-31' AND consolidated = '連結'"],
    ["財務行の削除", "DELETE FROM core_stock_financials WHERE stock_id = 9"],
    ["rsi 行の削除", "DELETE FROM rsi_percentile WHERE stock_id = 9"],
  ];

  it.each(drifts)("不一致 (%s) は SQL エラー", (_name, mutate) => {
    const db = setupAnnual();
    db.exec(mutate);
    const s = buildAnnualPreflightStatement(ANNUAL_SNAP);
    expect(() => runPreflight(db, s.sql, s.params)).toThrow();
  });

  it("入力範囲外 (未来期・他 license) の増減では落ちない", () => {
    const db = setupAnnual();
    db.exec(`
      INSERT INTO jss_financials VALUES ('9101', '2027-03-31', '本決算', '連結', 130.0, 'commercial-ok');
      INSERT INTO jss_financials VALUES ('9101', '2024-03-31', '本決算', '連結', 110.0, 'factual-cite');
      INSERT INTO jss_financials VALUES ('9101', '2024-03-31', '1Q', '連結', 50.0, 'commercial-ok');
    `);
    const s = buildAnnualPreflightStatement(ANNUAL_SNAP);
    const row = runPreflight(db, s.sql, s.params) as Record<string, unknown>;
    expect(Object.values(row)).toEqual(['null']);
  });

  it("非選定 scope への過去期追加でも落ちる (入力範囲の protected)", () => {
    const db = setupAnnual();
    db.exec("INSERT INTO jss_financials VALUES ('9101', '2022-03-31', '本決算', '単体', 80.0, 'commercial-ok')");
    const s = buildAnnualPreflightStatement(ANNUAL_SNAP);
    expect(() => runPreflight(db, s.sql, s.params)).toThrow();
  });

  it("非選定 scope への最新期追加で STOP する (scope 選定が動く)", () => {
    const db = setupAnnual();
    // 最新期末 (2025-03-31) より新しい単体の期が来ると最新期末が動き、
    // scope 選定自体が変わりうる。選定済み scope だけの照合では見逃す。
    db.exec("INSERT INTO jss_financials VALUES ('9101', '2026-03-31', '本決算', '単体', 140.0, 'commercial-ok')");
    const s = buildAnnualPreflightStatement(ANNUAL_SNAP);
    expect(() => runPreflight(db, s.sql, s.params)).toThrow();
  });

  it("凍結銘柄の preimage は凍結のまま一致する (active 固定の両方向)", () => {
    const db = setupAnnual();
    db.exec("UPDATE core_stocks SET is_active = 0, instrument_type = NULL WHERE id = 9");
    const frozen = buildAnnualPreflightStatement({ ...ANNUAL_SNAP, isActive: false, instrumentType: null });
    const row = runPreflight(db, frozen.sql, frozen.params) as Record<string, unknown>;
    expect(Object.values(row)).toEqual(["null"]);
    // 凍結 preimage に対して active 行は不一致 (逆方向も止める)
    db.exec("UPDATE core_stocks SET is_active = 1 WHERE id = 9");
    expect(() => runPreflight(db, frozen.sql, frozen.params)).toThrow();
  });
});
