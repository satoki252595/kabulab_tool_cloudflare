/**
 * /api/screening のページングと総件数の契約テスト。
 *
 * 元の実装は limit を 50 既定・100 上限にクランプするだけで offset が無く、
 * 優待銘柄 1,616 件 (権利月3月だけで 848 件) に対して **101 件目以降へ到達する
 * 手段が存在しなかった**。ここで固定したい契約は次の4つ:
 *
 *   1. limit を超える母集団でページ送りが機能し、ページ間で行が重複も欠落もしない
 *   2. 総件数が返る (かつ withTotal を付けないときは COUNT を打たない = null)
 *   3. 権利月フィルタ (1 銘柄に複数優待 = 1:N) で行が重複しない
 *   4. 公開面に出るのは short_summary 由来の文言だけ (description は漏れない)
 *
 * D1 バインディングは node:sqlite の DatabaseSync に被せた最小シムで再現する。
 * drizzle の d1 ドライバが使うのは prepare().bind().{all,raw,run} と batch だけ
 * なので、この範囲だけ実装すれば本物の SQL をそのまま実行できる。
 * miniflare (@cloudflare/vitest-pool-workers) を使う案は採らなかった:
 * node_modules が元リポジトリへの symlink で依存追加ができず、また
 * 検証したいのは SQL とページング境界であって Workers ランタイムではない。
 */
import { DatabaseSync } from "node:sqlite";
import { beforeAll, describe, expect, it } from "vitest";
import { otakaraYutaiApp } from "../../app.js";

// ===== DDL (src/db/schema.ts / src/shared/db/core-schema.ts と対応) =====
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
  updated_at integer NOT NULL DEFAULT (unixepoch())
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
-- stock_id の UNIQUE が「1 銘柄 1 行」を保証する。app.ts が JS 側の重複除去を
-- 捨てられる根拠はこれ (本番 D1 にも同名の unique index が実在する)。
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

/**
 * drizzle-orm/d1 が触る範囲だけの D1Database シム。
 * `log` を渡すと実行 SQL を記録する (COUNT を打つ / 打たないの検証に使う)。
 */
function createD1(sqlite: DatabaseSync, log?: string[]): unknown {
  const prepare = (query: string) => {
    log?.push(query);
    const make = (params: unknown[]) => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      all: async () => ({ results: sqlite.prepare(query).all(...(params as any[])), success: true, meta: {} }),
      raw: async () => {
        const stmt = sqlite.prepare(query);
        const names = stmt.columns().map((col) => col.name);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows = stmt.all(...(params as any[])) as Record<string, unknown>[];
        // drizzle は列の**位置**で値を戻すので、columns() の順序で並べ直す
        // (同名列があると Object.values では順序が崩れる)。
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

// ===== 固定データ =====
/** 総銘柄数。limit 上限 (100) を超えて3ページに割れる大きさにする。 */
const TOTAL_STOCKS = 120;
/** このうち先頭 N 件に 3 月の権利月を与える。 */
const MARCH_STOCKS = 60;
/** 3 月優待を **2 件** 持つ銘柄数 (1:N の JOIN で行が増えないことの検証用)。 */
const MARCH_DOUBLE = 10;

/** 出典サイトの掲載文 (公開面に出してはいけない文言)。 */
const FORBIDDEN_TEXT = "出典サイトの掲載文そのものなので公開面に出してはいけない説明";

let d1: unknown;

beforeAll(() => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(DDL);

  sqlite.exec("INSERT INTO yutai_genres (id, name, slug) VALUES (1, 'QUOカード', 'quo'), (2, '食品・飲料', 'food')");

  const insStock = sqlite.prepare(
    "INSERT INTO core_stocks (id, code, name, market, sector, is_active, is_yutai) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const insBenefit = sqlite.prepare(
    "INSERT INTO yutai_benefits (stock_id, genre_id, description, short_summary, min_shares, record_month) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insScore = sqlite.prepare(
    "INSERT INTO otakara_stock_scores (stock_id, fundamental_score, technical_score, total_score) VALUES (?, ?, ?, ?)",
  );
  const insFin = sqlite.prepare(
    "INSERT INTO otakara_stock_financials (stock_id, price, per, pbr, dividend_yield, rsi_14, yutai_yield, data_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );

  for (let i = 1; i <= TOTAL_STOCKS; i++) {
    const code = String(1000 + i);
    insStock.run(i, code, `テスト銘柄${i}`, "プライム", "小売業", 1, 1);
    insBenefit.run(i, 1, FORBIDDEN_TEXT, `${i * 100}円相当の優待券`, 100, i <= MARCH_STOCKS ? 3 : 9);
    // 同一銘柄に 3 月の優待をもう1件。inArray サブクエリが IN リストなので
    // 行は増えないはずで、増えたらここで露見する。
    if (i <= MARCH_DOUBLE) insBenefit.run(i, 2, FORBIDDEN_TEXT, `カタログギフト ${i}`, 1000, 3);

    // スコアは半数だけ与え、しかも全銘柄同値にする。NULLS LAST + 同値が
    // 大量にある状態でも OFFSET ページングが破綻しないことを確かめる
    // (第2ソートキーに id を足した理由がこれ)。
    if (i % 2 === 0) insScore.run(i, 50, 50, 50);
    insFin.run(i, 1000, 15, i <= 30 ? 0.8 : 2.5, 3.5, 40, 1.2, "2026-09-01");
  }

  // 優待非対象 / 上場廃止は母集団に入らない
  insStock.run(900, "9000", "優待なし銘柄", "プライム", "小売業", 1, 0);
  insStock.run(901, "9001", "上場廃止銘柄", "プライム", "小売業", 0, 1);

  d1 = createD1(sqlite);
});

type ScreeningResponse = {
  items: { code: string; benefitMonths: number[]; benefitSummary: string }[];
  total: number | null;
  offset: number;
  limit: number;
};

async function screening(query: string): Promise<ScreeningResponse> {
  const res = await otakaraYutaiApp.request(`/api/screening?${query}`, {}, { DB: d1 });
  expect(res.status).toBe(200);
  return (await res.json()) as ScreeningResponse;
}

describe("/api/screening のページング", () => {
  it("総件数を返し、1ページ目は limit 件で始まる", async () => {
    const page1 = await screening("withTotal=1&limit=50");
    expect(page1.total).toBe(TOTAL_STOCKS);
    expect(page1.offset).toBe(0);
    expect(page1.limit).toBe(50);
    expect(page1.items).toHaveLength(50);
  });

  it("withTotal を付けなければ総件数を返さない (COUNT を打たない)", async () => {
    const page = await screening("limit=50");
    expect(page.total).toBeNull();
    expect(page.items).toHaveLength(50);
  });

  it("offset で 101 件目以降に到達でき、ページ間で重複も欠落もしない", async () => {
    const pages = await Promise.all([
      screening("limit=50"),
      screening("limit=50&offset=50"),
      screening("limit=50&offset=100"),
    ]);
    expect(pages.map((p) => p.items.length)).toEqual([50, 50, 20]);
    expect(pages[2].offset).toBe(100);

    const codes = pages.flatMap((p) => p.items.map((s) => s.code));
    expect(codes).toHaveLength(TOTAL_STOCKS);
    // 重複が無い = 取りこぼしも無い (母集団と同数の一意コードが揃う)
    expect(new Set(codes).size).toBe(TOTAL_STOCKS);
  });

  it("母集団を越えた offset では空ページを返す (500 にしない)", async () => {
    const page = await screening("limit=50&offset=500&withTotal=1");
    expect(page.items).toEqual([]);
    expect(page.total).toBe(TOTAL_STOCKS);
  });

  it("limit は上限 100 にクランプされる", async () => {
    const page = await screening("limit=500");
    expect(page.limit).toBe(100);
    expect(page.items).toHaveLength(100);
  });

  it("負の offset / 壊れた offset は 0 として扱う", async () => {
    expect((await screening("limit=10&offset=-5")).offset).toBe(0);
    expect((await screening("limit=10&offset=abc")).offset).toBe(0);
  });
});

describe("/api/screening の絞り込みと総件数", () => {
  it("権利月フィルタで 1 銘柄が複数優待を持っても行が重複しない", async () => {
    const page = await screening("month=3&limit=100&withTotal=1");
    expect(page.total).toBe(MARCH_STOCKS);
    expect(page.items).toHaveLength(MARCH_STOCKS);
    expect(new Set(page.items.map((s) => s.code)).size).toBe(MARCH_STOCKS);

    // 3 月優待を2件持つ銘柄は、月が 1 つに畳まれて出る
    const doubled = page.items.find((s) => s.code === "1001");
    expect(doubled?.benefitMonths).toEqual([3]);
  });

  it("財務列フィルタ (LEFT JOIN を落とせない経路) でも総件数が合う", async () => {
    const page = await screening("pbrMax=1&limit=100&withTotal=1");
    expect(page.total).toBe(30);
    expect(page.items).toHaveLength(30);
  });

  it("ジャンル ∩ 権利月を重ねても件数が合う", async () => {
    const page = await screening("genre=food&month=3&limit=100&withTotal=1");
    expect(page.total).toBe(MARCH_DOUBLE);
    expect(page.items).toHaveLength(MARCH_DOUBLE);
  });

  it("存在しないジャンルは空ページ + 総件数 0", async () => {
    const page = await screening("genre=no-such-genre&withTotal=1");
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it("優待非対象・上場廃止は母集団に入らない", async () => {
    const page = await screening("withTotal=1&limit=100");
    expect(page.total).toBe(TOTAL_STOCKS);
    expect(page.items.map((s) => s.code)).not.toContain("9000");
    expect(page.items.map((s) => s.code)).not.toContain("9001");
  });
});

describe("ページングが公開文言の関門を迂回しない", () => {
  it("どのページの JSON にも出典掲載文 (description) が現れない", async () => {
    for (const q of ["limit=50", "limit=50&offset=50", "limit=50&offset=100", "month=3&limit=100"]) {
      const res = await otakaraYutaiApp.request(`/api/screening?${q}`, {}, { DB: d1 });
      const body = await res.text();
      expect(body, `${q} で掲載文が漏れています`).not.toContain(FORBIDDEN_TEXT);
      expect(body).toContain("円相当の優待券");
    }
  });

  it("生成されたクライアント JS が構文として成立する", async () => {
    // screeningJS はサーバ側 template literal で組み立てられるため、埋め込み値の
    // クォート事故は型でも lint でも検出されない (tips-literal-safety.test.ts と
    // 同じ動機)。ページング分岐を足したので、実際に描画された <script> を
    // パースして構文破壊を防ぐ。new Function は解析のみで実行しない。
    const res = await otakaraYutaiApp.request("/screening", {}, { DB: d1 });
    const html = await res.text();
    const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, body] of blocks) {
      expect(() => new Function(body)).not.toThrow();
    }
  });

  it("SSR の /screening も総件数とページ送りの器を埋め込み、掲載文は出さない", async () => {
    const res = await otakaraYutaiApp.request("/screening", {}, { DB: d1 });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="screening-pager"');
    // SSR が総件数を渡すので、ページを開いただけでは COUNT も API も走らない
    expect(html).toContain(`var total = ${TOTAL_STOCKS};`);
    expect(html).not.toContain(FORBIDDEN_TEXT);
  });
});

describe("COUNT の走査コスト設計", () => {
  /**
   * 同一 WHERE の COUNT はデータ取得と同額の走査を払う (実測 rows_read:
   * 無フィルタ 6,947 / 権利月フィルタ 13,725)。D1 は走査行課金なので
   * 「毎リクエスト COUNT」は課金を倍にする。ここではその設計を SQL レベルで固定する。
   */
  function recording(): { db: unknown; log: string[] } {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(DDL);
    sqlite.exec("INSERT INTO yutai_genres (id, name, slug) VALUES (1, 'QUOカード', 'quo')");
    sqlite.exec("INSERT INTO core_stocks (id, code, name, market, is_active, is_yutai) VALUES (1, '1001', 'A', 'プライム', 1, 1)");
    const log: string[] = [];
    return { db: createD1(sqlite, log), log };
  }

  const counts = (log: string[]) => log.filter((q) => /count\(/i.test(q));

  it("withTotal 無しのリクエストでは COUNT を1回も打たない", async () => {
    const { db, log } = recording();
    await otakaraYutaiApp.request("/api/screening?limit=10&offset=10", {}, { DB: db });
    expect(counts(log)).toHaveLength(0);
  });

  it("財務列フィルタが無い COUNT は LEFT JOIN を落とす (走査行を増やさない)", async () => {
    const { db, log } = recording();
    await otakaraYutaiApp.request("/api/screening?withTotal=1&month=3", {}, { DB: db });
    const [countSql, ...rest] = counts(log);
    expect(rest).toHaveLength(0);
    expect(countSql.toLowerCase()).not.toContain("left join");
  });

  it("財務列フィルタがあるときは COUNT も JOIN する (WHERE がその列を見るため落とせない)", async () => {
    const { db, log } = recording();
    await otakaraYutaiApp.request("/api/screening?withTotal=1&pbrMax=1", {}, { DB: db });
    const [countSql] = counts(log);
    expect(countSql.toLowerCase()).toContain("left join");
    expect(countSql.toLowerCase()).toContain("distinct");
  });
});
