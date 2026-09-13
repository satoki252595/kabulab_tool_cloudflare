/**
 * 日次 cron Phase 5 (業種騰落ランキング `swing_sector_daily`) の集約キーの検証。
 *
 * `swing_sector_daily.sector` は公開面 `GET /swing-trading/` がそのまま業種名
 * として出す**保存済みの派生コピー**。旧コードは JPX の 33 業種
 * (`core_stocks.sector`, personal-only) をキーにしていたので、公開面では表示ごと
 * 閉じていた (PR #24)。2026-09-13 に集約キーを `publicSectorColumn`
 * (フラグ false = `core_stocks.sector33`, EDINET 由来) へ移した。固定したい契約:
 *
 *   1. 発行 SQL が `core_stocks.sector33` を読み、`core_stocks.sector` を読まない。
 *   2. 保存される業種名が `sector33` の値で、JPX の `sector` の値が 1 件も入らない。
 *   3. `sector33` が NULL の銘柄 (REIT 等) は `未分類` にまとまり、
 *      **JPX の `sector` へフォールバックしない**。
 *   4. カバレッジ 90% 未満では書かず、前回値を残す (関数に切り出したときに
 *      制御の流れを変えたので、スキップ経路も見る)。
 *   5. 分母と分子は同じ母集団 (active かつ equity)。非普通株は分子にも `未分類`
 *      にも入らず、当日未更新でも分母に数えない (P4b 後に分母を is_active の
 *      ままにすると 3,700/4,434=83.4% で毎日スキップされる)。
 *
 * スキーマは drizzle/d1 のマイグレーションをそのまま流して作る。手書き DDL に
 * しなかったのは、この表 (`swing_sector_daily`) の一意索引 (date, sector) が
 * 「同じ日付に同じ業種を 2 行書かない」を保証していて、それを本番と同じ形で
 * 効かせたいから。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as coreSchema from "../shared/db/core-schema.js";
import * as rsiSchema from "../../services/rsi-screening/src/db/schema.js";
import * as swingSchema from "../../services/swing-trading/src/db/schema.js";
import * as projectionSchema from "../shared/db/projection-schema.js";
import { PUBLISH_JPX_DERIVED_COLUMNS } from "../shared/db/public-columns.js";
import { aggregateSectorDaily } from "./daily.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TODAY = "2026-09-14";

/** drizzle/d1 の全マイグレーションを番号順に流す (本番 D1 と同じ形)。 */
function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split("--> statement-breakpoint")) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

let sqlite: DatabaseSync;
let executed: string[];

/** createD1HttpDb と同じ sqlite-proxy 経路をローカル SQLite に向ける (ohlcv-prune.test.ts と同じ)。 */
function makeProxyDb(target: DatabaseSync, log: string[]) {
  return drizzle(
    async (sqlStr, params, method) => {
      log.push(sqlStr);
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
    { schema: { ...coreSchema, ...rsiSchema, ...swingSchema, ...projectionSchema } }
  );
}

type Db = Parameters<typeof aggregateSectorDaily>[0];
const db = (): Db => makeProxyDb(sqlite, executed) as unknown as Db;

/**
 * 銘柄を 1 件入れる。`sector` (JPX) には**公開面に出てはいけない番兵値**を入れ、
 * `sector33` (EDINET) と取り違えたら保存値で分かるようにする。
 * `pct1d` が undefined なら indicators 行を作らない (= 当日未更新)。
 */
function seedStock(opts: {
  id: number;
  jpxSector: string | null;
  sector33: string | null;
  pct1d?: number;
  active?: boolean;
  /** 既定は `equity` (日次の処理対象)。`null` は未分類。 */
  instrumentType?: string | null;
}): void {
  sqlite
    .prepare(
      "INSERT INTO core_stocks (id, code, name, market, sector, sector33, is_active, instrument_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      opts.id,
      String(1000 + opts.id),
      `銘柄${opts.id}`,
      "番兵JPX市場区分",
      opts.jpxSector,
      opts.sector33,
      opts.active === false ? 0 : 1,
      opts.instrumentType === undefined ? "equity" : opts.instrumentType
    );
  if (opts.pct1d !== undefined) {
    // computed_at は既定 unixepoch() = 「本日更新済み」
    sqlite
      .prepare("INSERT INTO swing_stock_indicators (stock_id, pct_change_1d) VALUES (?, ?)")
      .run(opts.id, opts.pct1d);
  }
}

function savedRows(date: string) {
  return sqlite
    .prepare(
      "SELECT sector, pct_1d AS pct1d, stock_count AS stockCount, rank_1d AS rank1d FROM swing_sector_daily WHERE date = ? ORDER BY rank_1d"
    )
    .all(date) as Array<{ sector: string; pct1d: number; stockCount: number; rank1d: number }>;
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
  executed = [];
});

afterEach(() => {
  sqlite.close();
});

describe("aggregateSectorDaily の集約キー (PUBLISH_JPX_DERIVED_COLUMNS = false)", () => {
  it("前提: フラグは既定の false", () => {
    // true に倒したら集約キーは JPX に戻るので、下の期待値は全部変わる。
    expect(PUBLISH_JPX_DERIVED_COLUMNS).toBe(false);
  });

  it("発行 SQL は core_stocks.sector33 を読み、core_stocks.sector を読まない", async () => {
    seedStock({ id: 1, jpxSector: "番兵JPX業種A", sector33: "情報・通信業", pct1d: 1 });

    await aggregateSectorDaily(db(), TODAY);

    const aggregateSelect = executed.find(
      (s) => s.includes('"swing_stock_indicators"') && s.startsWith("select")
    );
    expect(aggregateSelect).toBeDefined();
    expect(aggregateSelect).toContain('"core_stocks"."sector33"');
    expect(aggregateSelect).not.toMatch(/"core_stocks"\."sector"(?!33)/);
  });

  it("保存される業種名は sector33 の値で、JPX の sector は 1 件も入らない", async () => {
    seedStock({ id: 1, jpxSector: "番兵JPX業種A", sector33: "情報・通信業", pct1d: 2 });
    seedStock({ id: 2, jpxSector: "番兵JPX業種A", sector33: "情報・通信業", pct1d: 4 });
    seedStock({ id: 3, jpxSector: "番兵JPX業種B", sector33: "銀行業", pct1d: -1 });

    const written = await aggregateSectorDaily(db(), TODAY);

    expect(written).toBe(2);
    expect(savedRows(TODAY)).toEqual([
      { sector: "情報・通信業", pct1d: 3, stockCount: 2, rank1d: 1 },
      { sector: "銀行業", pct1d: -1, stockCount: 1, rank1d: 2 },
    ]);
    const all = JSON.stringify(sqlite.prepare("SELECT * FROM swing_sector_daily").all());
    expect(all).not.toContain("番兵JPX");
  });

  it("sector33 が NULL の銘柄は 未分類 にまとまり、JPX の sector へフォールバックしない", async () => {
    // REIT・インフラファンド等は EDINET の提出者業種を持たない (本番で 11 銘柄の見込み)。
    // JPX 側には業種が入っていることがあるので、番兵値を入れて落ちないことを見る。
    seedStock({ id: 1, jpxSector: "番兵JPX業種A", sector33: "情報・通信業", pct1d: 1 });
    seedStock({ id: 2, jpxSector: "番兵JPX業種REIT", sector33: null, pct1d: -2 });
    seedStock({ id: 3, jpxSector: null, sector33: null, pct1d: -4 });

    await aggregateSectorDaily(db(), TODAY);

    expect(savedRows(TODAY)).toEqual([
      { sector: "情報・通信業", pct1d: 1, stockCount: 1, rank1d: 1 },
      { sector: "未分類", pct1d: -3, stockCount: 2, rank1d: 2 },
    ]);
  });

  it("非アクティブ銘柄は集計しない", async () => {
    seedStock({ id: 1, jpxSector: "番兵JPX業種A", sector33: "情報・通信業", pct1d: 1 });
    seedStock({ id: 2, jpxSector: "番兵JPX業種B", sector33: "銀行業", pct1d: 9, active: false });

    await aggregateSectorDaily(db(), TODAY);

    expect(savedRows(TODAY).map((r) => r.sector)).toEqual(["情報・通信業"]);
  });

  it("当日分だけを書き直し、過去日の行 (切り替え前 = JPX キー) には触らない", async () => {
    // 切り替え前の日付の行は JPX キーのまま残る。公開面がそれを読まないのは
    // SECTOR_DAILY_PUBLIC_KEY_SINCE の役目で、ここは「cron が過去日を
    // 書き直さない」= 残ることの方を固定する。
    sqlite
      .prepare(
        "INSERT INTO swing_sector_daily (date, sector, pct_1d, stock_count, rank_1d) VALUES ('2026-09-11', '番兵JPX業種A', 0.5, 10, 1)"
      )
      .run();
    seedStock({ id: 1, jpxSector: "番兵JPX業種A", sector33: "情報・通信業", pct1d: 1 });

    await aggregateSectorDaily(db(), TODAY);

    expect(savedRows("2026-09-11").map((r) => r.sector)).toEqual(["番兵JPX業種A"]);
    expect(savedRows(TODAY).map((r) => r.sector)).toEqual(["情報・通信業"]);
  });

  it("カバレッジ 90% 未満なら書かず、同じ日付の前回値を残す", async () => {
    sqlite
      .prepare(
        "INSERT INTO swing_sector_daily (date, sector, pct_1d, stock_count, rank_1d) VALUES (?, '前回値', 0.5, 10, 1)"
      )
      .run(TODAY);
    seedStock({ id: 1, jpxSector: "番兵JPX業種A", sector33: "情報・通信業", pct1d: 1 });
    seedStock({ id: 2, jpxSector: "番兵JPX業種A", sector33: "情報・通信業" });

    const written = await aggregateSectorDaily(db(), TODAY);

    expect(written).toBeNull();
    expect(savedRows(TODAY).map((r) => r.sector)).toEqual(["前回値"]);
  });

  it("非普通株は分子にも未分類にも入らない", async () => {
    // REIT 等は EDINET の提出者業種を持たず sector33 が NULL。母集団で先に外さないと
    // `未分類` に混ざり、日次が更新しない銘柄の騰落がランキングに入る。
    seedStock({ id: 1, jpxSector: null, sector33: "情報・通信業", pct1d: 1 });
    seedStock({ id: 2, jpxSector: null, sector33: "銀行業", pct1d: 2 });
    seedStock({ id: 3, jpxSector: null, sector33: null, pct1d: -1 });
    seedStock({ id: 4, jpxSector: null, sector33: null, pct1d: -5, instrumentType: "reit_fund" });
    seedStock({ id: 5, jpxSector: null, sector33: null, pct1d: -7, instrumentType: null });

    await aggregateSectorDaily(db(), TODAY);

    const rows = savedRows(TODAY);
    expect(rows.find((r) => r.sector === "未分類")?.stockCount).toBe(1);
    expect(rows.reduce((acc, r) => acc + r.stockCount, 0)).toBe(3);
  });

  it("active の非普通株が当日未更新でも、equity が全件更新ならカバレッジで落ちない", async () => {
    // 日次は非普通株を更新しない。分母を is_active のままにすると 9/11=81.8% で
    // スキップされる (P4b 後の本番なら 3,700/4,434=83.4% で毎日スキップ)。
    for (let id = 1; id <= 9; id++) {
      seedStock({ id, jpxSector: null, sector33: "情報・通信業", pct1d: id });
    }
    seedStock({ id: 10, jpxSector: null, sector33: null, instrumentType: "reit_fund" });
    seedStock({ id: 11, jpxSector: null, sector33: null, instrumentType: "reit_fund" });

    const written = await aggregateSectorDaily(db(), TODAY);

    expect(written).toBe(1);
    expect(savedRows(TODAY).map((r) => [r.sector, r.stockCount])).toEqual([["情報・通信業", 9]]);
  });
});
