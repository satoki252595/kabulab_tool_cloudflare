/**
 * `GET /stocks/:code` (銘柄詳細) のライセンス境界テスト。**値**で見る。
 *
 * 静的な形の検査 (src/shared/db/core-stocks-license-boundary.test.ts) は
 * 「そう書いていない」ことしか言えない。実際にレスポンスへ出たかどうかは
 * ここで番兵値を DB に入れて実測する。
 *
 * ## 2026-09-13 に期待値を変えた理由
 *
 * それまでこのテストは「`market` (プライム) と `sector` (輸送用機器) は
 * 従来どおり出る」「`sector33` は出ない」を固定していた。両方**逆**にした。
 *
 * `core_stocks.market` / `core_stocks.sector` はどちらも JPX
 * 「東証上場銘柄一覧 (data_j.xls)」由来で personal-only である
 * (`sector` は src/cron/universe.ts が `sector: r.sector33` で JPX の
 * 33 業種を書いている)。一方 `core_stocks.sector33` を書いているのは
 * stockStock の `collectors/edinet_codelist.py` だけで、そこは EDINET
 * コードリストの「提出者業種」を `license_tag=commercial-ok` として取る。
 *
 * つまり**出してよい列と出していた列が入れ違っていた**。旧テストはその
 * 入れ違いを「仕様」として固定していたので、期待値ごと入れ替える。
 * 判断の根拠と戻し方 (フラグ 1 つ) は src/shared/db/public-columns.ts。
 *
 * 併せて `sector33` が NULL のときに **JPX の `sector` へフォールバック
 * しない**ことも見る。フォールバックを書くと、`sector33` が充填されるまで
 * ずっと JPX の値が公開面に出続け、直したことにならない。本番の `sector33`
 * は 2026-09-13 時点で全行 NULL なので、これは「当面の実際の挙動」の検査。
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
 * 公開面へ出てはいけない列に入れる番兵。本番に入りうる実際の値 (33 業種名など)
 * ではなく一意な文字列にしてある。実データだと出してよい列と同じ文字列に
 * なりうるため、「どちらの列が出たのか」を判定できない。
 *
 * `market` と `sector` も番兵にしてある。どちらも JPX 由来 = personal-only で、
 * 実際の値 (プライム / 輸送用機器) を入れると「公開面に出ていないこと」を
 * 他の文字列と区別して確かめられない。
 */
const SENTINELS = {
  market: "ZZ_MARKET_SENTINEL",
  sector: "ZZ_SECTOR_JPX_SENTINEL",
  instrument_type: "ZZ_INSTRUMENT_TYPE_SENTINEL",
  sector17: "ZZ_SECTOR17_SENTINEL",
  license_tag: "ZZ_LICENSE_TAG_SENTINEL",
  src_source: "ZZ_SRC_SOURCE_SENTINEL",
  quality: "ZZ_QUALITY_SENTINEL",
} as const;

/**
 * **出てよい**業種。EDINET 提出者業種 (`sector33`) は commercial-ok なので
 * 公開面に出る。出ていないことを検知したい (絞りすぎの検出) ので番兵にする。
 */
const PUBLISHED_SECTOR33 = "ZZ_SECTOR33_PUBLISHED";

const CODE = "7203";
/** `sector33` が NULL の銘柄。JPX の `sector` へ落ちないことを見る用。 */
const CODE_NO_SECTOR33 = "6758";
/**
 * `instrument_type = 'equity'` の銘柄。一覧 (/api/screening) の母集団は active かつ
 * equity (src/shared/db/active-equity.ts) なので、`instrument_type` が番兵値の 1・2 件目は
 * 一覧に出ない。一覧の JSON を値で検査するための 3 件目 (他の personal-only 列は番兵値)。
 */
const CODE_EQUITY = "8058";

let d1: unknown;

beforeAll(() => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(DDL);
  sqlite.exec("INSERT INTO yutai_genres (id, name, slug) VALUES (1, 'QUOカード', 'quo')");
  const insertStock = sqlite.prepare(
    `INSERT INTO core_stocks
       (id, code, name, market, sector, is_active, is_yutai,
        instrument_type, sector33, sector17, license_tag, src_source, quality)
     VALUES (?, ?, 'テスト銘柄', ?, ?, 1, 1, ?, ?, ?, ?, ?, ?)`,
  );
  insertStock.run(
    1,
    CODE,
    SENTINELS.market,
    SENTINELS.sector,
    SENTINELS.instrument_type,
    PUBLISHED_SECTOR33,
    SENTINELS.sector17,
    SENTINELS.license_tag,
    SENTINELS.src_source,
    SENTINELS.quality,
  );
  // sector33 が NULL でも JPX の sector へ落ちないことを見るための 2 件目。
  insertStock.run(
    2,
    CODE_NO_SECTOR33,
    SENTINELS.market,
    SENTINELS.sector,
    SENTINELS.instrument_type,
    null,
    SENTINELS.sector17,
    SENTINELS.license_tag,
    SENTINELS.src_source,
    SENTINELS.quality,
  );
  insertStock.run(
    3,
    CODE_EQUITY,
    SENTINELS.market,
    SENTINELS.sector,
    "equity",
    PUBLISHED_SECTOR33,
    SENTINELS.sector17,
    SENTINELS.license_tag,
    SENTINELS.src_source,
    SENTINELS.quality,
  );
  sqlite
    .prepare(
      "INSERT INTO yutai_benefits (stock_id, genre_id, description, short_summary, min_shares, record_month) VALUES (3, 1, ?, ?, 100, 3)",
    )
    .run("出典サイトの掲載文", "2000円相当のQUOカード");
  sqlite
    .prepare(
      "INSERT INTO otakara_stock_financials (stock_id, price, per, pbr, dividend_yield, rsi_14, yutai_yield, data_date) VALUES (3, 2000, 10, 1.0, 2.5, 50, 1.0, '2026-09-01')",
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO otakara_stock_scores (stock_id, fundamental_score, technical_score, total_score) VALUES (3, 51, 52, 53)",
    )
    .run();
  sqlite
    .prepare(
      "INSERT INTO yutai_benefits (stock_id, genre_id, description, short_summary, min_shares, record_month) VALUES (1, 1, ?, ?, 100, 3)",
    )
    .run("出典サイトの掲載文", "1000円相当のQUOカード");
  sqlite
    .prepare(
      "INSERT INTO yutai_benefits (stock_id, genre_id, description, short_summary, min_shares, record_month) VALUES (2, 1, ?, ?, 100, 3)",
    )
    .run("出典サイトの掲載文", "500円相当のQUOカード");
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

async function detailHtml(code: string = CODE): Promise<string> {
  const res = await otakaraYutaiApp.request(`/stocks/${code}`, {}, { DB: d1 });
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

  it("EDINET 由来の業種 (sector33) は出る (絞りすぎの検出)", async () => {
    // 出してよい列まで落としていないか。ここが緑でないと「全部消せば安全」
    // という直し方が通ってしまい、ページから業種が黙って消える。
    const html = await detailHtml();
    expect(html).toContain("テスト銘柄");
    expect(html).toContain(PUBLISHED_SECTOR33);
  });

  it("JSON API (/api/screening) にも personal-only が出ない", async () => {
    // HTML だけを見ていると、同じ列を返す JSON API が無検査で残る。
    // /api/screening は `.select()` 経路なので、関係クエリとは別の系統。
    // 一覧の母集団は active かつ equity なので並ぶのは 3 件目 (CODE_EQUITY) だけ。
    // instrument_type は WHERE で使うが、値もキーもレスポンスに出ない
    // (src/shared/db/active-equity.ts のライセンス判断)。
    const res = await otakaraYutaiApp.request("/api/screening?limit=50", {}, { DB: d1 });
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const sentinel of Object.values(SENTINELS)) {
      expect(body, `${sentinel} が JSON に出ています`).not.toContain(sentinel);
    }
    expect(body).not.toContain("instrument_type");
    expect(body).not.toContain("instrumentType");
    expect(body).not.toContain("equity");
    // 出してよい列は出る (絞りすぎの検出)。
    expect(body).toContain(PUBLISHED_SECTOR33);
    // キーは残す。消すと利用者が「その項目は存在しない」と解釈する
    // (src/shared/db/public-columns.ts の方針)。
    const parsed = JSON.parse(body) as { items: Array<{ code: string; market: unknown }> };
    expect(parsed.items.map((item) => item.code)).toEqual([CODE_EQUITY]);
    for (const item of parsed.items) {
      expect(item).toHaveProperty("market");
      expect(item.market).toBeNull();
    }
  });

  it("sector33 が NULL のとき JPX の sector へフォールバックしない", async () => {
    // 本番の sector33 は全行 NULL。ここでフォールバックを書くと、充填が
    // 終わるまでずっと JPX の値が公開面に出続ける (= 直っていない)。
    const html = await detailHtml(CODE_NO_SECTOR33);
    expect(html).not.toContain(SENTINELS.sector);
    expect(html).not.toContain(SENTINELS.market);
    // 項目が空であることは見えていてよい (空文字だと「壊れた」のか「値が無い」
    // のかを見た目で区別できない)。市場区分も業種も出せないので行全体が `—`。
    expect(html).toContain('<p style="color:#888">—</p>');
  });
});
