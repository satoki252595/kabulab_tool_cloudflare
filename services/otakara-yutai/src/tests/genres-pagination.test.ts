/**
 * `/genres/:slug` (SSR) のページングの契約テスト。
 *
 * 直したのは 2 つで、実害の大きい方は後者:
 *
 *   1. `.limit(PAGE_SIZE * 3)` が残っていた。1 銘柄 1 行は JOIN 先の UNIQUE が
 *      保証しているので取りこぼしも重複も無く、単に 3 倍の行を転送していた。
 *      (rows_read は減らない。本番実測で limit 20/60/200 のいずれも 5,568 行。
 *       ORDER BY が一致集合を全部並べ替えるので LIMIT は返却行数だけを変える)
 *   2. `ORDER BY` に第2キーが無かった。総合スコアは半数近くが NULL で、値が
 *      あっても同値が大量にあるため、OFFSET ページングでは**ページ間で順序が
 *      揺れて重複と取りこぼしが同時に起きる**。JS 側の重複除去は同一レスポンス
 *      内しか見ないので、この事故はコードのどこにも現れない。
 *      #17 で `/api/screening` に入れた `asc(stocks.id)` と同じ形に揃えた。
 *
 * 検出方法は 1 と 2 で違う。1 は返却行数で見える。2 は**振る舞いでは証明できない**:
 * 同値行の並び順は SQL の意味論では未定義で、in-memory SQLite は同じクエリ・同じ
 * 計画に対して毎回同じ順序を返すため、第2キーを外しても「全ページで一意コードが
 * 揃う」テストは緑になる (実際に外して確認した)。なので 2 は ORDER BY の**形**で
 * 固定する。ここを「振る舞いで見た」と言うと、それ自体が偽の安全信号になる。
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
  stock_id integer PRIMARY KEY NOT NULL REFERENCES core_stocks(id),
  price real, per real, pbr real, dividend_yield real, eps real, bps real,
  roe real, roa real, market_cap real,
  ma_5 real, ma_25 real, ma_75 real, rsi_14 real, macd real, macd_signal real,
  yutai_yield real,
  fetched_at integer NOT NULL DEFAULT (unixepoch()),
  data_date text NOT NULL
);
CREATE TABLE otakara_stock_scores (
  stock_id integer PRIMARY KEY NOT NULL REFERENCES core_stocks(id),
  fundamental_score real NOT NULL,
  technical_score real NOT NULL,
  total_score real NOT NULL,
  yutai_months text,
  yutai_genre_ids text,
  scored_at integer NOT NULL DEFAULT (unixepoch())
);
`;

/** SELECT ごとの返却行数を記録する D1 シム (過剰取得の検出に使う) */
interface Executed {
  query: string;
  rows: number;
}

function createD1(sqlite: DatabaseSync, log: Executed[]): unknown {
  const prepare = (query: string) => {
    const make = (params: unknown[]) => ({
      all: async () => {
        const results = sqlite.prepare(query).all(...(params as never[]));
        log.push({ query, rows: results.length });
        return { results, success: true, meta: {} };
      },
      raw: async () => {
        const stmt = sqlite.prepare(query);
        const names = stmt.columns().map((col) => col.name);
        const rows = stmt.all(...(params as never[])) as Record<string, unknown>[];
        log.push({ query, rows: rows.length });
        return rows.map((row) => names.map((n) => row[n]));
      },
      run: async () => ({
        results: [],
        success: true,
        meta: sqlite.prepare(query).run(...(params as never[])),
      }),
      first: async () => sqlite.prepare(query).get(...(params as never[])) ?? null,
      bind: (...next: unknown[]) => make(next),
    });
    return make([]);
  };
  return {
    prepare,
    batch: async (list: { all: () => Promise<unknown> }[]) =>
      Promise.all(list.map((s) => s.all())),
  };
}

/** app.ts の PAGE_SIZE と一致させる */
const PAGE_SIZE = 20;
/** ページが 3 枚以上に割れる母集団 */
const TOTAL = 50;

let d1: unknown;

beforeAll(() => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(DDL);
  sqlite.exec("INSERT INTO yutai_genres (id, name, slug) VALUES (1, 'QUOカード', 'quo')");

  const insStock = sqlite.prepare(
    "INSERT INTO core_stocks (id, code, name, market, sector, is_active, is_yutai, instrument_type) VALUES (?, ?, ?, ?, ?, 1, 1, 'equity')"
  );
  const insBenefit = sqlite.prepare(
    "INSERT INTO yutai_benefits (stock_id, genre_id, description, short_summary, min_shares, record_month) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insScore = sqlite.prepare(
    "INSERT INTO otakara_stock_scores (stock_id, fundamental_score, technical_score, total_score, yutai_months, yutai_genre_ids) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const insFin = sqlite.prepare(
    "INSERT INTO otakara_stock_financials (stock_id, price, per, pbr, dividend_yield, rsi_14, yutai_yield, data_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );

  for (let i = 1; i <= TOTAL; i++) {
    insStock.run(i, String(1000 + i), `テスト銘柄${i}`, "プライム", "小売業");
    insBenefit.run(i, 1, "出典サイトの掲載文", `${i * 100}円相当の優待券`, 100, 3);
    // 同一銘柄に 2 件目の優待。ジャンル該当は集計列の EXISTS なので行は増えない
    // はずで、増えたらページの件数がここで崩れる (L-51)。
    if (i <= 5) insBenefit.run(i, 1, "出典サイトの掲載文", `カタログギフト ${i}`, 1000, 9);
    // スコアは全件・全員同値で与える。ジャンル該当は scores の集計列を引く
    // (L-51) ので、スコア行の無い銘柄はページに出ない。NULLS LAST の最悪
    // ケースは screening-pagination.test.ts の半数シードで見る (同じ 2 キー順序)。
    const months = i <= 5 ? "[3,9]" : "[3]";
    insScore.run(i, 50, 50, 50, months, "[1]");
    insFin.run(i, 1000, 15, 1.2, 3.5, 40, 1.2, "2026-09-01");
  }

  d1 = createD1(sqlite, []);
});

async function genresPage(query: string): Promise<string> {
  const res = await otakaraYutaiApp.request(`/genres/quo?${query}`, {}, { DB: d1 });
  expect(res.status).toBe(200);
  return await res.text();
}

/** レンダリングされた銘柄コードを出現順に取り出す */
function codesOf(html: string): string[] {
  return [...html.matchAll(/\/stocks\/(\d{4}|\d{3}[A-Z])"/g)].map((m) => m[1]);
}

describe("/genres/:slug のページング", () => {
  it("1 ページは PAGE_SIZE 件で、総件数を表示する", async () => {
    const html = await genresPage("page=1");
    expect(html).toContain(`(${TOTAL}銘柄)`);
    expect(codesOf(html)).toHaveLength(PAGE_SIZE);
  });

  it("全ページを通して重複も取りこぼしも無い (同値スコアだらけでも)", async () => {
    const pages = [];
    for (let p = 1; p <= 3; p++) {
      pages.push(codesOf(await genresPage(`page=${p}`)));
    }
    expect(pages.map((p) => p.length)).toEqual([PAGE_SIZE, PAGE_SIZE, TOTAL - PAGE_SIZE * 2]);

    const codes = pages.flat();
    expect(codes).toHaveLength(TOTAL);
    // 一意コードが母集団と同数 = 重複なし かつ 取りこぼしなし
    expect(new Set(codes).size).toBe(TOTAL);
  });

  it("ソートを変えても全ページで一意コードが揃う", async () => {
    for (const sort of ["total-desc", "total-asc", "dividend-desc", "pbr-asc"]) {
      const codes: string[] = [];
      for (let p = 1; p <= 3; p++) {
        codes.push(...codesOf(await genresPage(`page=${p}&sort=${sort}`)));
      }
      expect(new Set(codes).size, `sort=${sort} で重複/欠落がある`).toBe(TOTAL);
    }
  });

  it("ORDER BY に第2キー (core_stocks.id) が入っている", async () => {
    // **これは SQL の形で見るしかない。**
    // 同値行の並び順は SQL の意味論では未定義で、in-memory SQLite は同じ
    // クエリ・同じ計画に対して毎回同じ順序を返す。つまり「全ページで一意コードが
    // 揃う」テストは、第2キーが無くてもこの環境では緑になる (実際に第2キーを
    // 外して確認した)。ページ間の順序の揺れが出るのは計画や実行環境が変わった
    // ときなので、振る舞いでは証明できない。だから第2キーの存在を形で固定する。
    const log: Executed[] = [];
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(DDL);
    sqlite.exec("INSERT INTO yutai_genres (id, name, slug) VALUES (1, 'QUOカード', 'quo')");
    sqlite.exec(
      "INSERT INTO core_stocks (id, code, name, market, sector, is_active, is_yutai, instrument_type) VALUES (1, '1001', 'テスト', 'プライム', '小売業', 1, 1, 'equity')"
    );
    sqlite.exec(
      "INSERT INTO yutai_benefits (stock_id, genre_id, description, short_summary, min_shares, record_month) VALUES (1, 1, '掲載文', '100円相当', 100, 3)"
    );
    // ジャンル該当は集計列を引く (L-51)。スコア行が無いと 0 件になる。
    sqlite.exec(
      "INSERT INTO otakara_stock_scores (stock_id, fundamental_score, technical_score, total_score, yutai_months, yutai_genre_ids) VALUES (1, 50, 50, 50, '[3]', '[1]')"
    );
    const res = await otakaraYutaiApp.request(
      "/genres/quo?page=1",
      {},
      { DB: createD1(sqlite, log) }
    );
    expect(res.status).toBe(200);

    const listQueries = log.filter(
      (e) =>
        /from "core_stocks"/i.test(e.query) &&
        /"otakara_stock_scores"/i.test(e.query) &&
        // 総件数の COUNT も scores を join する (L-51) が ORDER BY を持たない
        !/count\(/i.test(e.query)
    );
    expect(listQueries.length).toBeGreaterThan(0);
    for (const q of listQueries) {
      expect(
        q.query,
        "ORDER BY の第2キーが無い (OFFSET ページングでページ間の順序が揺れる)"
      ).toMatch(/order by[\s\S]*"core_stocks"\."id"/i);
    }
    sqlite.close();
  });

  it("一覧クエリが PAGE_SIZE を超える行を取らない (3 倍の無駄走査が無い)", async () => {
    const log: Executed[] = [];
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(DDL);
    sqlite.exec("INSERT INTO yutai_genres (id, name, slug) VALUES (1, 'QUOカード', 'quo')");
    const insStock = sqlite.prepare(
      "INSERT INTO core_stocks (id, code, name, market, sector, is_active, is_yutai, instrument_type) VALUES (?, ?, ?, ?, ?, 1, 1, 'equity')"
    );
    const insBenefit = sqlite.prepare(
      "INSERT INTO yutai_benefits (stock_id, genre_id, description, short_summary, min_shares, record_month) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const insScore = sqlite.prepare(
      "INSERT INTO otakara_stock_scores (stock_id, fundamental_score, technical_score, total_score, yutai_months, yutai_genre_ids) VALUES (?, 50, 50, 50, '[3]', '[1]')"
    );
    for (let i = 1; i <= TOTAL; i++) {
      insStock.run(i, String(1000 + i), `テスト銘柄${i}`, "プライム", "小売業");
      insBenefit.run(i, 1, "出典サイトの掲載文", `${i * 100}円相当`, 100, 3);
      // ジャンル該当は集計列を引く (L-51)。無いと 0 件で LIMIT の検証が空振りする。
      insScore.run(i);
    }
    const res = await otakaraYutaiApp.request(
      "/genres/quo?page=1",
      {},
      { DB: createD1(sqlite, log) }
    );
    expect(res.status).toBe(200);

    // 一覧本体 (core_stocks から複数列を引く SELECT) が返した行数。
    // PAGE_SIZE * 3 = 60 行返していたのが元の実装。
    const listQueries = log.filter(
      (e) => /from "core_stocks"/i.test(e.query) && /"otakara_stock_scores"/i.test(e.query)
    );
    expect(listQueries.length).toBeGreaterThan(0);
    for (const q of listQueries) {
      expect(q.rows, "一覧クエリが PAGE_SIZE を超えて取っている").toBeLessThanOrEqual(
        PAGE_SIZE
      );
    }
    sqlite.close();
  });

  it("ジャンル・月フィルターは集計列を引き benefits の副問合せを打たない (L-51)", async () => {
    // 最小 DB で SQL の形を見る (共有 DB のシムにはログが無いため作り直す)。
    const log: Executed[] = [];
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(DDL);
    sqlite.exec("INSERT INTO yutai_genres (id, name, slug) VALUES (1, 'QUOカード', 'quo')");
    sqlite.exec(
      "INSERT INTO core_stocks (id, code, name, market, sector, is_active, is_yutai, instrument_type) VALUES (1, '1001', 'テスト', 'プライム', '小売業', 1, 1, 'equity')"
    );
    sqlite.exec(
      "INSERT INTO yutai_benefits (stock_id, genre_id, description, short_summary, min_shares, record_month) VALUES (1, 1, '掲載文', '100円相当', 100, 3)"
    );
    sqlite.exec(
      "INSERT INTO otakara_stock_scores (stock_id, fundamental_score, technical_score, total_score, yutai_months, yutai_genre_ids) VALUES (1, 50, 50, 50, '[3]', '[1]')"
    );
    const res = await otakaraYutaiApp.request(
      "/genres/quo?page=1&month=3",
      {},
      { DB: createD1(sqlite, log) }
    );
    expect(res.status).toBe(200);

    const listQueries = log.filter((e) => /from "core_stocks"/i.test(e.query));
    expect(listQueries.length).toBeGreaterThan(0);
    for (const q of listQueries) {
      expect(q.query, "benefits の IN 副問合せが復活している").not.toMatch(/yutai_benefits/i);
    }
    // ジャンルと月の両述語が集計列を引いている
    const filterSql = listQueries.map((q) => q.query).join("\n");
    expect(filterSql).toMatch(/json_each\("otakara_stock_scores"\."yutai_genre_ids"\)/i);
    expect(filterSql).toMatch(/json_each\("otakara_stock_scores"\."yutai_months"\)/i);
    sqlite.close();
  });
});
