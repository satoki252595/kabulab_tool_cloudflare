/**
 * VWAP 取込の母集団 loader (scripts/vwap/lib/codes.ts) の信頼境界。
 *
 * 固定したい契約:
 * - D1 正規の active かつ equity の code だけを返す。inactive / 非普通株 /
 *   instrument_type NULL は落ちる (凍結銘柄の混入を防ぐ)。
 * - `--codes` 明示指定は正規集合の所属を必須にし、対象外があれば STOP。
 * - 空集合・D1 失敗は R2 書込前に throw (static fallback なし)。
 *
 * 信頼経路は daily-targets.test.ts と同じ (drizzle/d1 全 migration +
 * sqlite-proxy のローカル SQLite)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as coreSchema from "../../../src/shared/db/core-schema.js";
import { INSTRUMENT_TYPES } from "../../../src/shared/jpx/instrument-type.js";
import {
  assertCodesInUniverse,
  loadCodes,
  loadCodesFromDb,
  rotateCodesForDate,
} from "./codes.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function applyD1Migrations(target: DatabaseSync): void {
  const dir = join(ROOT, "drizzle", "d1");
  for (const f of readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
    for (const stmt of readFileSync(join(dir, f), "utf-8").split("--> statement-breakpoint")) {
      if (stmt.trim()) target.exec(stmt);
    }
  }
}

let sqlite: DatabaseSync;

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
    { schema: { ...coreSchema } }
  );
}

type Db = Parameters<typeof loadCodesFromDb>[0];
const db = (): Db => makeProxyDb(sqlite) as unknown as Db;

function seedStock(opts: {
  id: number;
  code: string;
  active: boolean;
  instrumentType: string | null;
}): void {
  sqlite
    .prepare(
      "INSERT INTO core_stocks (id, code, name, market, sector, is_active, instrument_type) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      opts.id,
      opts.code,
      `銘柄${opts.code}`,
      "プライム",
      null,
      opts.active ? 1 : 0,
      opts.instrumentType
    );
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  applyD1Migrations(sqlite);
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllEnvs();
});

describe("loadCodesFromDb", () => {
  it("active かつ equity の code だけを code 昇順で返す", async () => {
    seedStock({ id: 1, code: "7203", active: true, instrumentType: INSTRUMENT_TYPES.equity });
    seedStock({ id: 2, code: "1301", active: true, instrumentType: INSTRUMENT_TYPES.equity });
    seedStock({ id: 3, code: "1001", active: false, instrumentType: INSTRUMENT_TYPES.equity });
    seedStock({ id: 4, code: "1302", active: true, instrumentType: "reit_fund" });
    seedStock({ id: 5, code: "1303", active: true, instrumentType: null });
    await expect(loadCodesFromDb(db())).resolves.toEqual(["1301", "7203"]);
  });

  it("空集合は R2 書込前に throw (static fallback なし)", async () => {
    seedStock({ id: 1, code: "1001", active: false, instrumentType: INSTRUMENT_TYPES.equity });
    await expect(loadCodesFromDb(db())).rejects.toThrow(/母集団が空/);
  });

  it("D1 失敗はそのまま throw (握り潰さない)", async () => {
    const failing = {
      select: () => {
        throw new Error("D1 HTTP 500: boom");
      },
    } as unknown as Db;
    await expect(loadCodesFromDb(failing)).rejects.toThrow(/D1 HTTP 500/);
  });
});

describe("assertCodesInUniverse", () => {
  it("正規集合内は通す", () => {
    expect(() =>
      assertCodesInUniverse(["7203"], ["1301", "7203"])
    ).not.toThrow();
  });

  it("対象外が1件でもあれば STOP (fetch/R2 に入らない)", () => {
    expect(() => assertCodesInUniverse(["7203", "9999"], ["7203"])).toThrow(
      /対象外コード/
    );
  });
});

describe("rotateCodesForDate", () => {
  const codes = Array.from({ length: 100 }, (_, i) => String(i).padStart(4, "0"));

  it("集合を変えない回転で、同日は決定的", () => {
    const rotated = rotateCodesForDate(codes, "2026-11-09");
    expect([...rotated].sort()).toEqual(codes);
    const offset = codes.indexOf(rotated[0]);
    expect(offset).toBeGreaterThan(0);
    expect(rotated).toEqual(codes.map((_, i) => codes[(i + offset) % codes.length]));
    expect(rotateCodesForDate(codes, "2026-11-09")).toEqual(rotated);
  });

  it("毎日先頭30件で fatal 停止しても、連続5日で全銘柄へ到達する", () => {
    const reached = new Set<string>();
    for (let d = 0; d < 5; d++) {
      const date = new Date(Date.parse("2026-11-09T00:00:00Z") + d * 86_400_000)
        .toISOString().slice(0, 10);
      for (const code of rotateCodesForDate(codes, date).slice(0, 30)) reached.add(code);
    }
    expect(reached.size).toBe(codes.length);
  });

  it.each(["", "2026-02-30", "2026/11/09", "2026-11-09T00:00:00Z"])("不正な日付 %s は throw", (date) => {
    expect(() => rotateCodesForDate(codes, date)).toThrow();
  });

  it("空・1件はそのまま返す", () => {
    expect(rotateCodesForDate([], "2026-11-09")).toEqual([]);
    expect(rotateCodesForDate(["7203"], "2026-11-09")).toEqual(["7203"]);
  });
});

describe("loadCodes", () => {
  it("D1 接続 env 欠落は即 throw (書込前に止まる)", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("D1_DATABASE_ID", "");
    await expect(loadCodes()).rejects.toThrow();
  });
});
