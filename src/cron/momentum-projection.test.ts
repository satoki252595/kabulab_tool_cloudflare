/**
 * L2 投影 (`p_momentum`) 生成の検証。
 *
 * 生成は 2 段 (L-47)。Phase 3 で銘柄ごとにメモリから upsert し、Phase 6 で
 * source_max_date の backfill + 掃除 DELETE だけを行う。固定したい契約:
 *
 *   1. **メモリ build が D1 読み直し相当と一致する** — 同じ終値列からは
 *      同じ行ができる。ここが崩れると「速くなったが数字が違う」になり、
 *      一番気付きにくい。
 *   2. 終値列が **date 昇順** で入る。順序が逆だと累積リターンの符号が反転し、
 *      エラーにならずにランキングが裏返る。
 *   3. 窓は末尾 90 本。有効な終値が 1 本も無ければ投影しない。
 *   4. 今 run に触られなかった行が残らない (孤児行が「現役の 0% 銘柄」として並ぶ)。
 *   5. 全滅・新冠・母集団異常では掃除しない (全消し防止)。
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
import { buildMomentumRow, rebuildMomentumProjection } from "./daily.js";

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
  instrument_type text, sector33 text, edinet_code text,
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

function insertStock(
  id: number,
  isActive = 1,
  instrumentType: string | null = "equity"
): void {
  sqlite
    .prepare(
      "INSERT INTO core_stocks (id, code, name, market, is_active, instrument_type) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(id, String(1000 + id), `銘柄${id}`, "プライム", isActive, instrumentType);
}

/** stockId に bars 本の終値を入れる。closes[i] は dateAt(i) の終値。 */
function insertBars(stockId: number, closes: (number | null)[]): void {
  const ins = sqlite.prepare(
    "INSERT INTO swing_daily_ohlcv (stock_id, date, close) VALUES (?, ?, ?)"
  );
  closes.forEach((c, i) => ins.run(stockId, dateAt(i), c));
}

/** 投影へ直接 1 行入れる (computedAt は unix 秒)。 */
function insertProjection(
  stockId: number,
  computedAtSec: number,
  sourceMaxDate = "2026-04-01"
): void {
  sqlite
    .prepare(
      "INSERT INTO p_momentum (stock_id, as_of, source_max_date, bars, closes, computed_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(stockId, "2026-04-01", sourceMaxDate, 1, "100", computedAtSec);
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

describe("buildMomentumRow", () => {
  it("末尾 90 本に切り、日付順に揃える", () => {
    const chronological = Array.from({ length: 130 }, (_, i) => ({
      date: dateAt(i),
      close: 100 + i,
    }));
    // 末尾 90 位置の順序が崩れていても、日付順に揃えてから畳む。
    const shuffled = [...chronological.slice(-90)].reverse();
    const row = buildMomentumRow([
      ...chronological.slice(0, 40),
      ...shuffled,
    ]);
    expect(row?.bars).toBe(90);
    expect(row?.asOf).toBe(dateAt(129));
    const closes = row?.closes.split(",").map(Number) ?? [];
    expect(closes).toHaveLength(90);
    expect(closes[0]).toBe(140);
    expect(closes[89]).toBe(229);
  });

  it("NULL・非正を落とし、as_of は残った末尾の日付", () => {
    const row = buildMomentumRow([
      { date: dateAt(0), close: 100 },
      { date: dateAt(1), close: null },
      { date: dateAt(2), close: -5 },
      { date: dateAt(3), close: 110 },
      { date: dateAt(4), close: null },
    ]);
    expect(row).toEqual({ asOf: dateAt(3), bars: 2, closes: "100,110" });
  });

  it("有効な終値が無ければ投影しない", () => {
    expect(buildMomentumRow([])).toBeNull();
    expect(
      buildMomentumRow([
        { date: dateAt(0), close: null },
        { date: dateAt(1), close: 0 },
      ])
    ).toBeNull();
  });

  it("投影を経由しても calcMomentum の数値が変わらない", () => {
    const closes = [100, 102, 101, 105, 110, 108, 112, 115, 113, 118];
    const row = buildMomentumRow(
      closes.map((close, i) => ({ date: dateAt(i), close }))
    );
    expect(row).not.toBeNull();
    const viaProjection = calcMomentum(decodeCloses(row?.closes ?? ""), 5);
    const direct = calcMomentum(closes, 5);
    expect(viaProjection).toEqual(direct);
  });
});

describe("rebuildMomentumProjection", () => {
  // run 開始の unix 秒。computed_at との比較だけが検証対象。
  const RUN_STARTED = 1_758_246_000;

  it("今 run の行へ全体 MAX を backfill し、古い行を掃除する", async () => {
    insertStock(1);
    insertStock(2);
    insertBars(1, [100, 101]);
    insertBars(2, [200]);
    insertProjection(1, RUN_STARTED, "2026-04-01");
    insertProjection(2, RUN_STARTED - 100_000, "2026-04-01");

    const result = await rebuildMomentumProjection(db, RUN_STARTED);
    expect(result.projectedStocks).toBe(1);
    expect(result.scannedBars).toBe(0);
    expect(result.sourceMaxDate).toBe(dateAt(1));
    expect(result.removedStocks).toBe(1);
    const rows = readProjection();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stock_id).toBe(1);
    expect(rows[0]?.source_max_date).toBe(dateAt(1));
  });

  it("触られた行が 0 なら掃除しない (全滅時の全消し防止)", async () => {
    insertStock(1);
    insertBars(1, [100]);
    insertProjection(1, RUN_STARTED - 100_000);

    const result = await rebuildMomentumProjection(db, RUN_STARTED);
    expect(result).toEqual({
      projectedStocks: 0,
      scannedBars: 0,
      sourceMaxDate: null,
      removedStocks: 0,
    });
    expect(readProjection()).toHaveLength(1);
  });

  it("OHLCV が空でも掃除しない (初回 backfill 前)", async () => {
    insertStock(1);
    insertProjection(1, RUN_STARTED);

    const result = await rebuildMomentumProjection(db, RUN_STARTED);
    expect(result.sourceMaxDate).toBeNull();
    expect(result.removedStocks).toBe(0);
    expect(readProjection()).toHaveLength(1);
  });

  it("母集団が空なら掃除せず run を失敗させる", async () => {
    insertProjection(1, RUN_STARTED - 100_000);
    await expect(rebuildMomentumProjection(db, RUN_STARTED)).rejects.toThrow(
      /母集団が空/
    );
    expect(readProjection()).toHaveLength(1);
  });
});
