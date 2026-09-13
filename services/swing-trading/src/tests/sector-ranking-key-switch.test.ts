/**
 * `GET /swing-trading/` の業種ランキングを**集約キーの切り替え日以降だけ**
 * 出すことの検証。**値**で見る (式の形は src/shared/db/derived-jpx-copies.test.ts)。
 *
 * `swing_sector_daily` は日次 cron が書く保存済みの派生コピーで、
 * 2026-09-13 に集約キーを JPX の `core_stocks.sector` (personal-only) から
 * `publicSectorColumn` (= `sector33`, EDINET 由来) へ移した
 * (src/cron/daily.ts `aggregateSectorDaily`)。ただし cron は当日分しか
 * 書き直さないので、**切り替え前の日付の行は JPX の業種名のまま残る**。
 * 固定したい契約:
 *
 *   1. 最新日付が `SECTOR_DAILY_PUBLIC_KEY_SINCE` より前なら、ランキングを出さず
 *      `swing_sector_daily` を読むクエリ自体も打たない。
 *   2. 最新日付がその日以降なら、その日付の行を rank 順に出す。
 *   3. `swing_market_context` だけが前日のまま (マクロ取得の一過性失敗) で、
 *      `swing_sector_daily` には切り替え後の行があっても、**読む日付**で判定する
 *      ので出さない (古い日付 = JPX キーの可能性がある行を読まない)。
 *
 * D1 シムは services/otakara-yutai/src/tests/screening-pagination.test.ts と
 * 同じ方式。スキーマは drizzle/d1 のマイグレーションをそのまま流して作る
 * (ダッシュボードは 5 表を読むので、手書き DDL だと本番との差が紛れ込みやすい)。
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { swingTradingApp } from "../../app.js";
import {
  PUBLISH_JPX_DERIVED_COLUMNS,
  SECTOR_DAILY_PUBLIC_KEY_SINCE,
} from "../../../../src/shared/db/public-columns.js";

const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split("--> statement-breakpoint")) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

/** drizzle-orm/d1 が触る範囲だけの D1Database シム。`log` に実行 SQL を記録する。 */
function createD1(sqlite: DatabaseSync, log: string[]): unknown {
  const prepare = (query: string) => {
    log.push(query);
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

/** `YYYY-MM-DD` を UTC で n 日ずらす。 */
function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

const BEFORE = shiftDate(SECTOR_DAILY_PUBLIC_KEY_SINCE, -3); // 例: 2026-09-11 (金)
const SINCE = SECTOR_DAILY_PUBLIC_KEY_SINCE;
const AFTER = shiftDate(SECTOR_DAILY_PUBLIC_KEY_SINCE, 1);

let sqlite: DatabaseSync;
let log: string[];

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
  log = [];
});

afterEach(() => {
  sqlite.close();
});

function seedMacro(date: string): void {
  sqlite
    .prepare(
      "INSERT INTO swing_market_context (date, judgment, judgment_reason) VALUES (?, 'A', '番兵マクロ理由')"
    )
    .run(date);
}

function seedSectors(date: string, sectors: string[]): void {
  const ins = sqlite.prepare(
    "INSERT INTO swing_sector_daily (date, sector, pct_1d, stock_count, rank_1d) VALUES (?, ?, ?, ?, ?)"
  );
  sectors.forEach((s, i) => ins.run(date, s, 3 - i, 10 + i, i + 1));
}

async function dashboard(): Promise<string> {
  const res = await swingTradingApp.request("/", {}, { DB: createD1(sqlite, log) });
  expect(res.status).toBe(200);
  return res.text();
}

const readsSectorDaily = () => log.some((q) => q.includes('"swing_sector_daily"'));

describe("GET / の業種ランキング (集約キー切り替え日による公開ガード)", () => {
  it("前提: フラグは既定の false", () => {
    // true なら集約キーも JPX に戻り、全日付を出してよくなる (下の 1 と 3 が変わる)。
    expect(PUBLISH_JPX_DERIVED_COLUMNS).toBe(false);
  });

  it("最新日付が切り替え日より前なら出さず、swing_sector_daily を読まない", async () => {
    // 本番の 2026-09-11 以前の行と同じ状態: JPX の 33 業種がキー。
    seedMacro(BEFORE);
    seedSectors(BEFORE, ["番兵JPX業種A", "番兵JPX業種B"]);

    const html = await dashboard();

    expect(html).toContain("番兵マクロ理由"); // ページ自体は組み立てている
    expect(html).not.toContain("番兵JPX業種");
    expect(readsSectorDaily()).toBe(false);
  });

  it("最新日付が切り替え日ちょうどなら、その日付の行を rank 順に出す", async () => {
    seedMacro(BEFORE);
    seedSectors(BEFORE, ["番兵JPX業種A"]);
    seedMacro(SINCE);
    seedSectors(SINCE, ["情報・通信業", "銀行業", "未分類"]);

    const html = await dashboard();

    expect(readsSectorDaily()).toBe(true);
    expect(html).not.toContain("番兵JPX業種");
    const pos = ["情報・通信業", "銀行業", "未分類"].map((s) => html.indexOf(`<td>${s}</td>`));
    expect(pos.every((p) => p > -1)).toBe(true);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });

  it("切り替え日より後の日付でも出す", async () => {
    seedMacro(AFTER);
    seedSectors(AFTER, ["電気機器"]);

    const html = await dashboard();

    expect(html).toContain("<td>電気機器</td>");
  });

  it("market_context だけ前日のまま (切り替え前の日付) なら、sector_daily に新しい行があっても出さない", async () => {
    seedMacro(BEFORE);
    seedSectors(BEFORE, ["番兵JPX業種A"]);
    seedSectors(SINCE, ["情報・通信業"]);

    const html = await dashboard();

    expect(html).not.toContain("番兵JPX業種");
    expect(html).not.toContain("<td>情報・通信業</td>");
    expect(readsSectorDaily()).toBe(false);
  });
});
