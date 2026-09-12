/**
 * L2 投影 (`p_momentum`) 再生成の検証。
 *
 * 固定したい契約は 4 つ:
 *
 *   1. **投影を経由しても /emh の数値が変わらない** — 投影に入った終値列を
 *      `calcMomentum` に渡した結果が、`swing_daily_ohlcv` を直接読んだ結果と一致する。
 *      ここが崩れると「速くなったが数字が違う」になり、一番気付きにくい。
 *   2. 母集団が `/emh` と同じ (is_active + close IS NOT NULL)。
 *   3. 終値列が **date 昇順** で入る。順序が逆だと累積リターンの符号が反転し、
 *      エラーにならずにランキングが裏返る。
 *   4. 母集団から落ちた銘柄の投影行が残らない (孤児行が「現役の 0% 銘柄」として並ぶ)。
 *
 * rowid カーソルで読むので「id 昇順 ≠ date 昇順」になるデータを入れて、
 * 終値列が date 昇順に揃うことも見る (符号が黙って反転する経路)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as coreSchema from "../shared/db/core-schema.js";
import * as rsiSchema from "../../services/rsi-screening/src/db/schema.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import * as projectionSchema from "../shared/db/projection-schema.js";
import { decodeCloses } from "../shared/indicators/momentum-series.js";
import { calcMomentum } from "../../services/financial-math/src/services/emh.js";
import { rebuildMomentumProjection } from "./daily.js";

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
CREATE TABLE swing_daily_ohlcv (
  id integer PRIMARY KEY AUTOINCREMENT,
  stock_id integer NOT NULL,
  date text NOT NULL,
  open real, high real, low real, close real, volume real, adj real,
  UNIQUE (stock_id, date)
);
CREATE TABLE p_momentum (
  stock_id integer PRIMARY KEY NOT NULL,
  as_of text NOT NULL,
  source_max_date text NOT NULL,
  bars integer NOT NULL,
  closes text NOT NULL,
  computed_at integer NOT NULL DEFAULT (unixepoch())
);
`;

let sqlite: DatabaseSync;
let db: ReturnType<typeof makeProxyDb>;

function makeProxyDb(target: DatabaseSync) {
  return drizzle(
    async (sqlStr, params, method) => {
      const stmt = target.prepare(sqlStr);
      const bind = params as (null | number | bigint | string | Uint8Array)[];
      if (method === "run") {
        stmt.run(...bind);
        return { rows: [] };
      }
      const objs = stmt.all(...bind) as Record<string, unknown>[];
      const rows = objs.map((o) => Object.values(o));
      return { rows: method === "get" ? (rows[0] ?? []) : rows };
    },
    {
      schema: {
        ...coreSchema,
        ...rsiSchema,
        ...swingSchema,
        ...projectionSchema,
      },
    }
  );
}

/** 営業日っぽい連続日付 (土日は考えない。順序だけが検証対象) */
function dateAt(i: number): string {
  const start = Date.UTC(2026, 4, 1);
  return new Date(start + i * 86_400_000).toISOString().slice(0, 10);
}

function insertStock(id: number, isActive = 1): void {
  sqlite
    .prepare(
      "INSERT INTO core_stocks (id, code, name, market, is_active) VALUES (?, ?, ?, ?, ?)"
    )
    .run(id, String(1000 + id), `銘柄${id}`, "プライム", isActive);
}

/** stockId に bars 本の終値を入れる。closes[i] は dateAt(i) の終値。 */
function insertBars(stockId: number, closes: (number | null)[]): void {
  const ins = sqlite.prepare(
    "INSERT INTO swing_daily_ohlcv (stock_id, date, close) VALUES (?, ?, ?)"
  );
  closes.forEach((c, i) => ins.run(stockId, dateAt(i), c));
}

/** 投影表の中身 */
function readProjection(): {
  stock_id: number;
  as_of: string;
  source_max_date: string;
  bars: number;
  closes: string;
}[] {
  return sqlite
    .prepare("SELECT stock_id, as_of, source_max_date, bars, closes FROM p_momentum ORDER BY stock_id")
    .all() as never;
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(DDL);
  db = makeProxyDb(sqlite);
});

afterEach(() => {
  sqlite?.close();
});

describe("rebuildMomentumProjection", () => {
  it("active 銘柄を 1 行へ畳み、終値は date 昇順で入る", async () => {
    insertStock(1);
    const closes = [100, 110, 121, 133.1];
    insertBars(1, closes);

    const result = await rebuildMomentumProjection(db);
    expect(result.projectedStocks).toBe(1);
    expect(result.scannedBars).toBe(4);
    expect(result.sourceMaxDate).toBe(dateAt(3));

    const [row] = readProjection();
    expect(row.stock_id).toBe(1);
    expect(row.bars).toBe(4);
    expect(row.as_of).toBe(dateAt(3));
    expect(row.source_max_date).toBe(dateAt(3));
    // 昇順であること。逆順なら累積リターンの符号が反転する。
    expect(decodeCloses(row.closes)).toEqual(closes);
  });

  it("投影経由の momentum が OHLCV 直読みと一致する (数値が変わらない)", async () => {
    insertStock(1);
    // 上昇 20 本 + 下降 10 本。ボラが 0 にならないよう値をばらす。
    const closes: number[] = [];
    for (let i = 0; i < 30; i++) {
      closes.push(Math.round((1000 + i * 17 + (i % 3) * 9) * 100) / 100);
    }
    insertBars(1, closes);

    await rebuildMomentumProjection(db);
    const [row] = readProjection();

    const viaProjection = calcMomentum(decodeCloses(row.closes), 20);
    const viaRawOhlcv = calcMomentum(closes, 20);
    // 同じ関数へ同じ配列が入る = 完全一致 (近似ではない)
    expect(viaProjection).toEqual(viaRawOhlcv);
    expect(viaProjection?.cumulativeReturn).toBeGreaterThan(0);
  });

  it("is_active=0 と close IS NULL は母集団に入らない", async () => {
    insertStock(1);
    insertStock(2, 0); // 上場廃止
    insertBars(1, [100, null, 120, null, 140]);
    insertBars(2, [100, 200, 300]);

    const result = await rebuildMomentumProjection(db);
    expect(result.projectedStocks).toBe(1);
    // NULL 終値は走査対象から外れる (WHERE close IS NOT NULL)。
    // is_active は SQL で絞らず JS 側で落とすので、上場廃止銘柄の 3 本は
    // 走査行には数える (JOIN で絞ると 1 ページごとに OHLCV を全走査する
    // 計画を選ばれ、実測 12 倍になる — daily.ts の表を参照)。
    expect(result.scannedBars).toBe(6);

    const rows = readProjection();
    expect(rows).toHaveLength(1);
    expect(rows[0].stock_id).toBe(1);
    expect(decodeCloses(rows[0].closes)).toEqual([100, 120, 140]);
    // 落とした分は日付の穴として残らないので、何本で算出したかを bars が持つ
    expect(rows[0].bars).toBe(3);
  });

  it("rowid が疎でも / date 順と食い違っても終値列は date 昇順になる", async () => {
    // 本番の id は prune で穴が空き、336,169 行が id 8,916〜20,625,713 に散る。
    // さらに増分 upsert のせいで「id が大きい行の date が小さい」組み合わせが
    // 起きる。rowid カーソルで読んだ順をそのまま畳むと累積リターンの符号が
    // 黙って反転するので、**date で並べ直していること**をここで固定する。
    insertStock(1);
    const ins = sqlite.prepare(
      "INSERT INTO swing_daily_ohlcv (id, stock_id, date, close) VALUES (?, ?, ?, ?)"
    );
    // id 昇順 = date 降順 という最悪の並びを作る
    ins.run(9_000, 1, dateAt(3), 130);
    ins.run(5_000_000, 1, dateAt(2), 120);
    ins.run(9_000_000, 1, dateAt(1), 110);
    ins.run(20_000_000, 1, dateAt(0), 100);

    const result = await rebuildMomentumProjection(db);
    expect(result.projectedStocks).toBe(1);
    expect(result.scannedBars).toBe(4);

    const [row] = readProjection();
    expect(decodeCloses(row.closes)).toEqual([100, 110, 120, 130]);
    expect(row.as_of).toBe(dateAt(3));
  });

  it("複数銘柄が rowid 順に交互に現れても混ざらない", async () => {
    // ページ境界を跨いだときに起きうる形 (銘柄ごとの配列が分断される) を、
    // rowid 順で銘柄が交互に来るデータで代表させる。
    for (const id of [7, 42, 900]) insertStock(id);
    const ins = sqlite.prepare(
      "INSERT INTO swing_daily_ohlcv (id, stock_id, date, close) VALUES (?, ?, ?, ?)"
    );
    let id = 100;
    for (let i = 0; i < 3; i++) {
      for (const stockId of [7, 42, 900]) {
        ins.run(id++, stockId, dateAt(i), stockId * 10 + i);
      }
    }

    const result = await rebuildMomentumProjection(db);
    expect(result.projectedStocks).toBe(3);
    expect(result.scannedBars).toBe(9);

    const rows = readProjection();
    expect(rows.map((r) => r.stock_id)).toEqual([7, 42, 900]);
    expect(decodeCloses(rows[0].closes)).toEqual([70, 71, 72]);
    expect(decodeCloses(rows[1].closes)).toEqual([420, 421, 422]);
    expect(decodeCloses(rows[2].closes)).toEqual([9000, 9001, 9002]);
  });

  it("母集団から落ちた銘柄の投影行は掃除される", async () => {
    insertStock(1);
    insertStock(2);
    insertBars(1, [100, 110]);
    insertBars(2, [200, 220]);
    await rebuildMomentumProjection(db);
    expect(readProjection()).toHaveLength(2);

    // 2 番が上場廃止。投影行が残ると「現役銘柄」としてランキングに並び続ける。
    sqlite.exec("UPDATE core_stocks SET is_active = 0 WHERE id = 2");
    // computed_at の比較が秒単位なので、前回の run と同じ秒に入らないようずらす。
    sqlite.exec("UPDATE p_momentum SET computed_at = computed_at - 10");

    const result = await rebuildMomentumProjection(db);
    expect(result.projectedStocks).toBe(1);
    expect(result.removedStocks).toBe(1);
    expect(readProjection().map((r) => r.stock_id)).toEqual([1]);
  });

  it("OHLCV が 1 行も無いときは投影を消さない (初回 backfill 前)", async () => {
    insertStock(1);
    insertBars(1, [100, 110]);
    await rebuildMomentumProjection(db);
    sqlite.exec("DELETE FROM swing_daily_ohlcv");
    sqlite.exec("UPDATE p_momentum SET computed_at = computed_at - 10");

    const result = await rebuildMomentumProjection(db);
    expect(result.sourceMaxDate).toBeNull();
    expect(result.removedStocks).toBe(0);
    // 「まだ取れていない」と「母集団から落ちた」を取り違えて全消しにしない
    expect(readProjection()).toHaveLength(1);
  });
});
