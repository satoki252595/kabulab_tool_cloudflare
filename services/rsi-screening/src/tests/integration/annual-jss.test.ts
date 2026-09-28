/**
 * 銘柄詳細の年度売上が正本 `jss_financials` の本決算実績から読まれることの検証。
 *
 * 実 SQLite (node:sqlite) を D1 バインディング互換スタブに被せて
 * getStockDetail をそのまま走らせる。純関数テストだと「WHERE 句の
 * disclosure_type / license_tag 条件を入れ忘れて予想や非公開行を混ぜる」
 * 状態を通してしまうため、SQL ごと確認する
 * (screening-freshness.test.ts と同じ方式)。
 *
 * 期待値の出典 (いずれもリポジトリ内の既存 fixture・検証ログの再利用):
 * - 8154 / 2025-03-31 / 本決算 / 連結 / 547,779,000,000
 *   (`pipeline/tests/test_backfill_financials_from_notion.py`)
 * - 8154 / FY2026 連結売上 658,941,000,000 (3月決算 → 期末 2026-03-31)
 *   (`docs/test-logs/financials-stage-2026-09-28.md`)
 * - 8154 / 2025-03-31 / 本決算 / 単体 / 117,513,000,000 (同 backfill テスト)
 *
 * 訂正の最新版は writer が disclosed_at ガード付き完全置換 (#131。NULL を
 * 含めて Notion 正本をそのまま反映) で同一 PK 行へ反映済みなので、
 * reader 側に新旧選択は無い。'本決算' 行をそのまま読むことが
 * 訂正最新版を読むことになる。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as coreSchema from "../../../../../src/shared/db/core-schema.js";
import * as rsiSchema from "../../db/schema.js";
import { getStockDetail } from "../../services/stock-detail-service.js";
import { createSqliteD1 } from "../helpers/sqlite-d1.js";

/**
 * テスト用 DDL。getStockDetail が触る 4 表のうち読む列だけを持つ。
 * `core_stock_annual_financials` は作らない — 作らなければ、旧表を
 * 読むコードが残っていた時点で "no such table" で落ちる。
 */
const DDL = `
CREATE TABLE core_stocks (
  id integer PRIMARY KEY AUTOINCREMENT,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  market text NOT NULL,
  sector text,
  is_active integer NOT NULL DEFAULT 1,
  is_yutai integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL DEFAULT (unixepoch()),
  updated_at integer NOT NULL DEFAULT (unixepoch()),
  instrument_type text, sector33 text
);
CREATE TABLE core_stock_financials (
  stock_id integer PRIMARY KEY NOT NULL,
  price real, per real, pbr real, dividend_yield real,
  eps real, bps real, roe real, roa real, market_cap real,
  operating_margin real,
  data_date text NOT NULL,
  fetched_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE rsi_percentile (
  stock_id integer PRIMARY KEY NOT NULL,
  rsi_10 real, rsi_10_percentile real,
  rsi_40 real, rsi_40_percentile real,
  rsi_120 real, rsi_120_percentile real,
  rsi_min_percentile real,
  is_blue_chip integer NOT NULL DEFAULT 0,
  revenue_trend integer,
  percentile_sample_bars integer,
  computed_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE jss_financials (
  code text NOT NULL,
  fiscal_period_end text NOT NULL,
  disclosure_type text NOT NULL,
  consolidated text NOT NULL,
  net_sales real,
  license_tag text NOT NULL,
  PRIMARY KEY (code, fiscal_period_end, disclosure_type, consolidated)
);
`;

/** 基準日。未来期の除外境界として getStockDetail へ明示的に渡す */
const AS_OF = "2026-09-28";

type Harness = ReturnType<typeof createSqliteD1>;
let harness: Harness;
let db: ReturnType<typeof makeDb>;

function makeDb(d1: D1Database) {
  return drizzle(d1, { schema: { ...coreSchema, ...rsiSchema } });
}

async function seedStock(code: string): Promise<void> {
  await db.insert(coreSchema.stocks).values({
    code,
    name: `テスト ${code}`,
    market: "プライム",
  });
}

function seedJss(
  code: string,
  fiscalPeriodEnd: string,
  disclosureType: string,
  consolidated: string,
  netSales: number | null,
  licenseTag = "commercial-ok"
): void {
  harness.sqlite
    .prepare(
      "INSERT INTO jss_financials (code, fiscal_period_end, disclosure_type, consolidated, net_sales, license_tag) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(code, fiscalPeriodEnd, disclosureType, consolidated, netSales, licenseTag);
}

beforeEach(() => {
  harness = createSqliteD1(DDL);
  db = makeDb(harness.db);
});

afterEach(() => {
  harness.close();
});

describe("getStockDetail の年度売上 (jss_financials)", () => {
  it("8154: 本決算・連結の実績だけを期末順に返す (予想・四半期・単体・他銘柄を混ぜない)", async () => {
    await seedStock("8154");
    await seedStock("9999");
    // 投入は期末の逆順 — 返りが期末昇順であることを見る。
    seedJss("8154", "2026-03-31", "本決算", "連結", 658_941_000_000);
    seedJss("8154", "2025-03-31", "本決算", "連結", 547_779_000_000);
    // 同一期末の単体・予想・四半期・修正・他銘柄は年度実績に混ぜない。
    seedJss("8154", "2025-03-31", "本決算", "単体", 117_513_000_000);
    seedJss("8154", "2026-03-31", "予想", "連結", 999);
    seedJss("8154", "2025-09-30", "中間", "連結", 888);
    seedJss("8154", "2025-06-30", "1Q", "連結", 777);
    seedJss("8154", "2025-03-31", "修正", "連結", 666);
    seedJss("9999", "2025-03-31", "本決算", "連結", 555);

    const detail = await getStockDetail(db, "8154", AS_OF);
    expect(detail?.annualFinancials).toEqual([
      {
        fiscalYear: 2025,
        fiscalPeriodEnd: "2025-03-31",
        consolidated: "連結",
        revenue: 547_779_000_000,
      },
      {
        fiscalYear: 2026,
        fiscalPeriodEnd: "2026-03-31",
        consolidated: "連結",
        revenue: 658_941_000_000,
      },
    ]);
  });

  it("factual-cite (TDnet 短信由来) の行は公開面に出さない", async () => {
    await seedStock("1001");
    seedJss("1001", "2025-03-31", "本決算", "連結", 10_000_000_000);
    seedJss("1001", "2024-03-31", "本決算", "連結", 9_000_000_000, "factual-cite");

    const detail = await getStockDetail(db, "1001", AS_OF);
    expect(detail?.annualFinancials).toEqual([
      {
        fiscalYear: 2025,
        fiscalPeriodEnd: "2025-03-31",
        consolidated: "連結",
        revenue: 10_000_000_000,
      },
    ]);
  });

  it("最新期に単体化した企業は単体の系列を使う (古い連結で埋めない)", async () => {
    await seedStock("1002");
    seedJss("1002", "2024-03-31", "本決算", "連結", 30_000_000_000);
    seedJss("1002", "2025-03-31", "本決算", "連結", 31_000_000_000);
    seedJss("1002", "2026-03-31", "本決算", "単体", 5_000_000_000);

    const detail = await getStockDetail(db, "1002", AS_OF);
    expect(detail?.annualFinancials).toEqual([
      {
        fiscalYear: 2026,
        fiscalPeriodEnd: "2026-03-31",
        consolidated: "単体",
        revenue: 5_000_000_000,
      },
    ]);
  });

  it("最新期に不明しか無ければ不明と表示し古い既知区分で埋めない", async () => {
    await seedStock("1003");
    seedJss("1003", "2024-03-31", "本決算", "連結", 30_000_000_000);
    seedJss("1003", "2025-03-31", "本決算", "不明", 29_000_000_000);

    const detail = await getStockDetail(db, "1003", AS_OF);
    expect(detail?.annualFinancials).toEqual([
      {
        fiscalYear: 2025,
        fiscalPeriodEnd: "2025-03-31",
        consolidated: "不明",
        revenue: 29_000_000_000,
      },
    ]);
  });

  it("未来期は年次系列に入れないが決算期変更の端数期は原文のまま残す", async () => {
    await seedStock("1004");
    seedJss("1004", "2021-03-31", "本決算", "連結", 20_000_000_000);
    // 決算期変更の端数期。期末間隔からの期間推定はしないので落とさず、
    // 実績期末・区分・売上を原文のまま保持する。年次比較の可否は
    // `evaluateBlueChip` が判定不能に倒す (blue-chip-filter.test.ts)。
    seedJss("1004", "2021-12-31", "本決算", "連結", 15_000_000_000);
    seedJss("1004", "2022-12-31", "本決算", "連結", 22_000_000_000);
    // 未来の本決算は実績比較に入れない。
    seedJss("1004", "2027-03-31", "本決算", "連結", 99_000_000_000);

    const detail = await getStockDetail(db, "1004", AS_OF);
    expect(detail?.annualFinancials).toEqual([
      {
        fiscalYear: 2021,
        fiscalPeriodEnd: "2021-03-31",
        consolidated: "連結",
        revenue: 20_000_000_000,
      },
      {
        fiscalYear: 2021,
        fiscalPeriodEnd: "2021-12-31",
        consolidated: "連結",
        revenue: 15_000_000_000,
      },
      {
        fiscalYear: 2022,
        fiscalPeriodEnd: "2022-12-31",
        consolidated: "連結",
        revenue: 22_000_000_000,
      },
    ]);
  });

  it("未取得は欠損のまま返す (net_sales null → revenue null、行無し → 空系列)", async () => {
    await seedStock("1005");
    await seedStock("1006");
    seedJss("1005", "2025-03-31", "本決算", "連結", null);

    const withNull = await getStockDetail(db, "1005", AS_OF);
    expect(withNull?.annualFinancials).toEqual([
      {
        fiscalYear: 2025,
        fiscalPeriodEnd: "2025-03-31",
        consolidated: "連結",
        revenue: null,
      },
    ]);

    const missing = await getStockDetail(db, "1006", AS_OF);
    expect(missing?.annualFinancials).toEqual([]);
  });
});
