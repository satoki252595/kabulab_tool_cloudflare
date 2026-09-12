/**
 * `GET /stocks/:code` (銘柄詳細) のライセンス境界テスト。
 *
 * この経路は `db.query.stocks.findFirst` で `core_stocks` を引いている。drizzle の
 * 関係クエリは `columns` を省くと**全列返し**なので、移行 P4a が足した
 * `personal-only` 列 (sector33 / sector17 / instrument_type / license_tag /
 * src_source / quality) まで SSR プロセスへ載る。2026-09-12 時点は本番で全行 NULL
 * なので実害は無いが、P4b が値を入れた時点で経路が開く。
 *
 * `src/shared/db/core-stocks-license-boundary.test.ts` は
 * **`.select()` (列指定なし) + `from(stocks)`** の形しか見ておらず、関係クエリは
 * 検出しない。静的な形の禁止だけでは塞がらないので、ここは
 * **値を入れて出力に出ないことを実測**する。
 *
 * 併せて `columns` を絞ったことで表示が欠けていないことも見る。join に必要な
 * 列は drizzle が自前で足すので関係は `id` を落としても壊れないが (実測)、
 * **表示している列**を絞りすぎると市場区分や業種が黙って消える。型では
 * 気づけないので値で見る。
 *
 * D1 シムは screening-pagination.test.ts と同じ方式 (node:sqlite に被せた最小シム)。
 */
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { otakaraYutaiApp } from "../../app.js";

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
  instrument_type text, sector33 text, sector17 text, edinet_code text,
  listing_status text, listing_date text, delisting_date text,
  license_tag text, src_source text, src_data_date text,
  src_fetched_at integer, quality text
);
CREATE TABLE yutai_genres (
  id integer PRIMARY KEY AUTOINCREMENT,
  name text NOT NULL UNIQUE,
  slug text NOT NULL UNIQUE,
  description text,
  created_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE yutai_benefits (
  id integer PRIMARY KEY AUTOINCREMENT,
  stock_id integer NOT NULL REFERENCES core_stocks(id),
  genre_id integer NOT NULL REFERENCES yutai_genres(id),
  description text NOT NULL,
  short_summary text,
  min_shares integer NOT NULL,
  record_month integer NOT NULL,
  estimated_value integer,
  estimate_value_source text,
  estimate_source_url text,
  created_at integer NOT NULL DEFAULT (unixepoch()),
  updated_at integer NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE otakara_stock_financials (
  id integer PRIMARY KEY AUTOINCREMENT,
  stock_id integer NOT NULL UNIQUE REFERENCES core_stocks(id),
  price real, per real, pbr real, dividend_yield real, eps real, bps real,
  roe real, roa real, market_cap real,
  ma_5 real, ma_25 real, ma_75 real, rsi_14 real, macd real, macd_signal real,
  yutai_yield real,
  fetched_at integer NOT NULL DEFAULT (unixepoch()),
  data_date text NOT NULL
);
CREATE TABLE otakara_stock_scores (
  id integer PRIMARY KEY AUTOINCREMENT,
  stock_id integer NOT NULL UNIQUE REFERENCES core_stocks(id),
  fundamental_score real NOT NULL,
  technical_score real NOT NULL,
  total_score real NOT NULL,
  scored_at integer NOT NULL DEFAULT (unixepoch())
);
`;

function createD1(sqlite: DatabaseSync): unknown {
  const prepare = (query: string) => {
    const make = (params: unknown[]) => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      all: async () => ({ results: sqlite.prepare(query).all(...(params as any[])), success: true, meta: {} }),
      raw: async () => {
        const stmt = sqlite.prepare(query);
        const names = stmt.columns().map((col) => col.name);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = stmt.all(...(params as any[])) as Record<string, unknown>[];
        return rows.map((row) => names.map((n) => row[n]));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      run: async () => ({ results: [], success: true, meta: sqlite.prepare(query).run(...(params as any[])) }),
      first: async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = sqlite.prepare(query).get(...(params as any[]));
        return row ?? null;
      },
      bind: (...params2: unknown[]) => make(params2),
    });
    return make([]);
  };
  return {
    prepare,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    batch: async (list: any[]) => Promise.all(list.map((s) => s.all())),
  };
}

/**
 * `personal-only` 列に入れる番兵。本番に入りうる実際の値 (33業種名など) ではなく
 * 一意な文字列にしてある。実データだと `sector` (公開可の正本) と同じ文字列に
 * なりうるため、「どちらの列が出たのか」を判定できない。
 */
const SENTINELS = {
  instrument_type: "ZZ_INSTRUMENT_TYPE_SENTINEL",
  sector33: "ZZ_SECTOR33_SENTINEL",
  sector17: "ZZ_SECTOR17_SENTINEL",
  license_tag: "ZZ_LICENSE_TAG_SENTINEL",
  src_source: "ZZ_SRC_SOURCE_SENTINEL",
  quality: "ZZ_QUALITY_SENTINEL",
} as const;

const CODE = "7203";

let d1: unknown;

beforeAll(() => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(DDL);
  sqlite.exec("INSERT INTO yutai_genres (id, name, slug) VALUES (1, 'QUOカード', 'quo')");
  sqlite
    .prepare(
      `INSERT INTO core_stocks
         (id, code, name, market, sector, is_active, is_yutai,
          instrument_type, sector33, sector17, license_tag, src_source, quality)
       VALUES (1, ?, 'テスト銘柄', 'プライム', '輸送用機器', 1, 1, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      CODE,
      SENTINELS.instrument_type,
      SENTINELS.sector33,
      SENTINELS.sector17,
      SENTINELS.license_tag,
      SENTINELS.src_source,
      SENTINELS.quality,
    );
  sqlite
    .prepare(
      "INSERT INTO yutai_benefits (stock_id, genre_id, description, short_summary, min_shares, record_month) VALUES (1, 1, ?, ?, 100, 3)",
    )
    .run("出典サイトの掲載文", "1000円相当のQUOカード");
  sqlite
    .prepare(
      "INSERT INTO otakara_stock_financials (stock_id, price, per, pbr, dividend_yield, rsi_14, yutai_yield, data_date) VALUES (1, 1000, 15, 1.2, 3.5, 40, 1.2, '2026-09-01')",
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO otakara_stock_scores (stock_id, fundamental_score, technical_score, total_score) VALUES (1, 61, 62, 63)",
    )
    .run();

  d1 = createD1(sqlite);
});

async function detailHtml(): Promise<string> {
  const res = await otakaraYutaiApp.request(`/stocks/${CODE}`, {}, { DB: d1 });
  expect(res.status).toBe(200);
  return await res.text();
}

describe("GET /stocks/:code のライセンス境界", () => {
  it.each(Object.entries(SENTINELS))("%s の値が HTML に出ない", async (_column, sentinel) => {
    expect(await detailHtml()).not.toContain(sentinel);
  });

  it("列を絞っても関係 (優待 / 財務 / スコア) が出る", async () => {
    // 関係の join キーは drizzle が自前で足すため `columns` からは独立だが、
    // その前提が将来の drizzle で変わればここが空になる。
    const html = await detailHtml();
    expect(html).toContain("1000円相当のQUOカード"); // benefits (+ genre)
    expect(html).toContain("63.0"); // scores.totalScore
    expect(html).toContain("15.0"); // financials.per
  });

  it("公開してよい列は従来どおり出る (絞りすぎの検出)", async () => {
    const html = await detailHtml();
    expect(html).toContain("テスト銘柄");
    expect(html).toContain("プライム"); // market (既存公開)
    expect(html).toContain("輸送用機器"); // sector (公開可の正本)
  });
});
